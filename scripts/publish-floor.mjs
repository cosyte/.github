#!/usr/bin/env node
// @ts-check
//
// WHICH TOOL PUBLISHES, WHICH FLOOR THAT TOOL OWES, AND WHETHER THIS PACKAGE CAN BE STAGED AT ALL.
//
// A `@cosyte/*` version becomes permanent the instant it is published: npm's registry data is
// immutable and `package@version`, once used, can never be used again, an unpublish included. The
// last reversible moment this pipeline had was BEFORE `changesets/action` ran. Staged publishing
// inserts one after the tarball exists and before a consumer can resolve it, and this script decides,
// before anything is packed, whether this run gets that moment and whether the tool it would need is
// actually here.
//
// ---------------------------------------------------------------------------
// THERE IS NO SINGLE FLOOR, AND ASSUMING ONE IS THE DEFECT THIS SCRIPT EXISTS TO AVOID
// ---------------------------------------------------------------------------
//
// The obvious implementation asserts `npm --version >= 11.15.0` and stops. It is WRONG, and the
// roadmap phase that asked for this work carried the wrong reasoning in its own evidence prose: it
// argued from the call chain `changeset publish` -> `pnpm publish` -> `npm publish`, concluded that
// the npm bundled with Node decides which capabilities are reachable, and therefore that staging was
// unreachable on this path. That chain does not exist any more.
//
//   "Since v11, `pnpm publish` is implemented natively and no longer delegates to the `npm` CLI."
//   (https://pnpm.io/cli/publish)
//
// So for a caller pinned to pnpm 11 the bundled npm governs NOTHING about the publish, and pnpm's own
// capabilities govern everything. pnpm has staging natively: `pnpm stage` is "Added in: v11.3.0", and
// `pnpm stage publish` "uploads the tarball to staging instead of promoting it to the live registry"
// (https://pnpm.io/cli/stage). For a caller still on pnpm 10 the delegation IS real, and there the
// npm CLI floor is the one that binds:
//
//   "Staged publishing requires npm CLI version 11.15.0 or later and Node version 22.14.0 or higher."
//   (npm docs, Staged publishing for npm packages)
//
// Hence the table this script implements. The left column is read at RUNTIME from the caller's own
// tree and the caller's own binaries; not one number below is copied from a workflow file.
//
//   publish tool      who performs the publish     floor that binds
//   pnpm >= 11        pnpm, natively               pnpm >= 11.3.0
//   pnpm <= 10        the npm CLI, by delegation   npm >= 11.15.0 and Node >= 22.14.0
//   npm               the npm CLI                  npm >= 11.15.0 and Node >= 22.14.0
//
// The npm floor is stated as one conjunctive sentence in npm's own document, so both halves of it are
// asserted. pnpm's document states no Node floor for `pnpm stage`, so none is invented for that arm:
// a floor nobody documents is not a floor this pipeline gets to enforce.
//
// ---------------------------------------------------------------------------
// EVERY UNKNOWN IS A REFUSAL, AND THE ASYMMETRY IS THE WHOLE DESIGN
// ---------------------------------------------------------------------------
//
// Three questions can come back unanswered: which tool publishes, what version that tool is, and
// whether this package already exists on the registry. Guessing any of them has a permanent cost and
// refusing has a cheap one.
//
//   The tool, or its version, unreadable   Assuming the floor is met stages nothing and publishes
//                                          normally, which is today's behaviour dressed up as a new
//                                          guarantee. Refuse instead, naming what could not be read.
//   The registry did not answer            Reading silence as "never published" takes the DIRECT arm
//                                          and burns the version number forever. Reading it as
//                                          "already published" costs a red run. Refuse.
//
// This is the opposite of the post-publish install gate in `install-check.mjs`, which fails OPEN on
// every ambiguity, and the difference is the clock: that gate runs after a permanent publish, where a
// red misreports a release nobody can withdraw. This one runs before anything is packed, where the
// cost of being wrong is a re-run. `install-check.mjs` supplies the three-valued registry taxonomy
// used below for exactly the reason it wrote it down: the honest third answer is that the registry
// did not say, and a question this cannot ANSWER must not be one it GUESSES.
//
// ---------------------------------------------------------------------------
// THE FLOOR IS ASSERTED FOR THE MODE IN USE, WHICH IS NOT ALWAYS THE STAGED ONE
// ---------------------------------------------------------------------------
//
// npm is explicit that the package "already exists on the npm registry - you cannot stage a brand-new
// package". A first publish is therefore a one-way door whatever the tool version is, and demanding a
// staging floor of a run that cannot stage would red a correct first release for a capability it will
// not use. So the staging floor binds on the STAGED arm only. The tool and its version are still read
// on both arms, because "we could not tell what publishes here" is not a fact the direct arm gets to
// ignore either.
//
// Run it by hand against any caller checkout:
//
//   node scripts/publish-floor.mjs --package @cosyte/hl7 --repo .

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// The floors, each one traceable to the document that states it. Exported so the tests assert
// against these constants rather than restating numbers a future reader would have to reconcile.
/** npm docs, "Staged publishing for npm packages": npm CLI 11.15.0 or later. */
export const NPM_STAGING_FLOOR = '11.15.0';
/** The same sentence's other half: Node 22.14.0 or higher. */
export const NPM_STAGING_NODE_FLOOR = '22.14.0';
/** pnpm docs, `pnpm stage`: "Added in: v11.3.0". */
export const PNPM_STAGING_FLOOR = '11.3.0';
/** pnpm publishes natively from this major on, so the npm CLI stops being on the publish path. */
export const PNPM_NATIVE_PUBLISH_MAJOR = 11;

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
// `globalThis.fetch` has NO default request timeout, and one unbounded fetch against a socket that
// accepts and never answers was measured stalling 300.8 seconds by `install-check.mjs`. This gate
// holds a protected `release` environment while it runs, so every request it makes is bounded.
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_REGISTRY_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 3_000;
// `pnpm --version` on a cold pnpm/action-setup cache is the slow case here, not the fast one.
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

const LOCKFILE_TOOLS = Object.freeze({
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
});

/** The only two publish tools this pipeline knows how to reason about. */
export const SUPPORTED_TOOLS = Object.freeze(['pnpm', 'npm']);

// -- semver, the three fields of it this script actually compares ---------------------------------

/**
 * Parse the leading `major.minor.patch` of a version string, ignoring any prerelease or build
 * suffix and a leading `v`. Returns null for anything that is not a version, which every caller
 * treats as unreadable rather than as zero.
 * @param {unknown} text
 * @returns {{major: number, minor: number, patch: number, raw: string} | null}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const match = /^[\s]*v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: text.trim(),
  };
}

/**
 * -1 when a is lower than b, 0 when equal, 1 when higher. Both arguments must already be parsed.
 * @param {{major: number, minor: number, patch: number}} a
 * @param {{major: number, minor: number, patch: number}} b
 */
export function compareVersions(a, b) {
  for (const field of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return 0;
}

/** Does `found` clear `floor`? Both are strings; an unparseable `found` never clears anything. */
export function meetsFloor(found, floor) {
  const a = parseVersion(found);
  const b = parseVersion(floor);
  if (!a || !b) return false;
  return compareVersions(a, b) >= 0;
}

// -- Which tool performs the publish ---------------------------------------------------------------

/**
 * Split a `packageManager` field into its name and version. Corepack's format is `name@version`
 * with an optional `+sha224-...` integrity suffix.
 * @param {unknown} value
 * @returns {{name: string, version: string} | null}
 */
export function parsePackageManagerField(value) {
  if (typeof value !== 'string') return null;
  const match = /^([@a-z0-9/.-]+)@([^+\s]+)/i.exec(value.trim());
  if (!match) return null;
  return { name: match[1], version: match[2] };
}

/**
 * THE TWO SIGNALS ARE READ INDEPENDENTLY AND MUST NOT DISAGREE.
 *
 * `changeset publish` picks its publish tool through `preferred-pm`, which weighs the
 * `packageManager` field and the lockfiles on disk. Rather than re-implement that library's
 * precedence from memory, this reads both signals and refuses whenever they do not point at the same
 * tool, or point at one this pipeline has no staging story for. A resolution rule that quietly
 * prefers one signal is exactly the kind of "reasoning about a call chain from memory" that produced
 * the roadmap's wrong evidence in the first place.
 *
 * @param {{packageManager?: unknown, lockfiles?: string[]}} facts
 * @returns {{tool: 'pnpm' | 'npm', pinned: string | null, from: string} | {tool: null, detail: string}}
 */
export function resolvePublishTool({ packageManager, lockfiles = [] }) {
  const declared = parsePackageManagerField(packageManager);
  const fromField = declared ? declared.name.replace(/^@[^/]+\//, '') : null;
  const fromLocks = [...new Set(lockfiles.map((f) => LOCKFILE_TOOLS[f]).filter(Boolean))];

  const seen = new Set([...(fromField ? [fromField] : []), ...fromLocks]);
  const described =
    `packageManager=${declared ? `${declared.name}@${declared.version}` : '(absent or unparseable)'}` +
    `, lockfiles=${lockfiles.length ? lockfiles.join(', ') : '(none)'}`;

  if (seen.size === 0) {
    return {
      tool: null,
      detail: `no packageManager field and no recognised lockfile, so nothing in the caller's tree says which tool would publish (${described})`,
    };
  }
  if (seen.size > 1) {
    return {
      tool: null,
      detail: `the caller's tree names more than one package manager (${[...seen].sort().join(' and ')}), so which one publishes is not decidable here (${described})`,
    };
  }
  const [only] = [...seen];
  if (!SUPPORTED_TOOLS.includes(only)) {
    return {
      tool: null,
      detail: `the caller publishes with ${only}, which this pipeline has no staged-publishing floor for (${described})`,
    };
  }
  return {
    tool: /** @type {'pnpm' | 'npm'} */ (only),
    pinned: declared && fromField === only ? declared.version : null,
    from: described,
  };
}

/**
 * Which tool must clear which floor, given the tool that performs the publish and its version.
 *
 * This is A5's whole content: the question is answered from the tool ON THE RESOLVED PUBLISH PATH,
 * and the bundled npm version decides nothing when the publish does not delegate to npm.
 *
 * @param {{tool: 'pnpm' | 'npm', version: string}} publisher
 * @returns {{stageTool: 'pnpm' | 'npm', floorTool: 'pnpm' | 'npm', floor: string, nodeFloor: string | null, delegates: boolean, source: string} | {stageTool: null, detail: string}}
 */
export function stagingRequirement({ tool, version }) {
  const parsed = parseVersion(version);
  if (!parsed) {
    return {
      stageTool: null,
      detail: `${tool} reported a version this gate cannot parse (${JSON.stringify(version)})`,
    };
  }
  if (tool === 'pnpm' && parsed.major >= PNPM_NATIVE_PUBLISH_MAJOR) {
    return {
      stageTool: 'pnpm',
      floorTool: 'pnpm',
      floor: PNPM_STAGING_FLOOR,
      nodeFloor: null,
      delegates: false,
      source: 'pnpm publishes natively from v11 on, so pnpm owns the floor (https://pnpm.io/cli/publish, https://pnpm.io/cli/stage)',
    };
  }
  if (tool === 'pnpm') {
    return {
      stageTool: 'npm',
      floorTool: 'npm',
      floor: NPM_STAGING_FLOOR,
      nodeFloor: NPM_STAGING_NODE_FLOOR,
      delegates: true,
      source: `pnpm ${parsed.raw} still delegates publishing to the npm CLI, so the npm floor is the one that binds (npm docs, Staged publishing for npm packages)`,
    };
  }
  return {
    stageTool: 'npm',
    floorTool: 'npm',
    floor: NPM_STAGING_FLOOR,
    nodeFloor: NPM_STAGING_NODE_FLOOR,
    delegates: false,
    source: 'the npm CLI performs the publish, so the npm floor binds (npm docs, Staged publishing for npm packages)',
  };
}

// -- Does this package already exist on the registry -----------------------------------------------

const encodeName = (name) => name.replace('/', '%2f');

/** @param {(url: string, options?: any) => Promise<any>} fetchImpl */
function withFetchTimeout(fetchImpl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  if (!timeoutMs || typeof AbortSignal?.timeout !== 'function') return fetchImpl;
  return (url, options = {}) =>
    fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMs) });
}

/**
 * THREE-VALUED, AND THE THIRD VALUE IS THE ONE A12 IS ABOUT.
 *
 * 200 with at least one version is the only evidence that this package can be staged; 404 is the
 * registry ANSWERING that it has never been published; everything else, a 5xx, a 401, a transport
 * fault, a body that is not the packument shape, or a 200 whose `versions` map is empty, is the
 * registry NOT ANSWERING. An empty `versions` map is deliberately in the third bucket rather than
 * folded into "never published": a name that exists but serves nothing is a state npm's document
 * does not describe, and the direct arm it would select is the irreversible one.
 *
 * @returns {Promise<{status: 'published', versions: number} | {status: 'never-published'} | {status: 'unknown', detail: string}>}
 */
export async function registryExistence(registry, name, fetchImpl) {
  const url = `${registry}/${encodeName(name)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
  } catch (error) {
    return {
      status: 'unknown',
      detail: `GET ${url} did not complete (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (res.status === 404) return { status: 'never-published' };
  if (res.status !== 200) {
    return { status: 'unknown', detail: `GET ${url} answered HTTP ${res.status}` };
  }
  let body;
  try {
    body = await res.json();
  } catch (error) {
    return {
      status: 'unknown',
      detail: `GET ${url} answered 200 with a body that is not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const versions = body?.versions;
  if (!versions || typeof versions !== 'object') {
    return { status: 'unknown', detail: `GET ${url} answered 200 with no \`versions\` map` };
  }
  const count = Object.keys(versions).length;
  if (count === 0) {
    return {
      status: 'unknown',
      detail: `GET ${url} answered 200 but serves no versions at all, which is neither "already published" nor npm's "brand-new package"`,
    };
  }
  return { status: 'published', versions: count };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The same question, retried, because this org publishes in waves and a registry blip is not an
 * answer. Only the third value is retried: a 200 and a 404 are both the registry speaking.
 */
export async function registryExistenceWithRetry(
  registry,
  name,
  fetchImpl,
  { attempts = DEFAULT_REGISTRY_ATTEMPTS, delayMs = DEFAULT_RETRY_DELAY_MS, sleepImpl = sleep } = {},
) {
  let last = { status: 'unknown', detail: 'no attempt was made' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await registryExistence(registry, name, fetchImpl);
    if (last.status !== 'unknown') return last;
    if (attempt < attempts) await sleepImpl(delayMs);
  }
  return { ...last, detail: `${last.detail} (after ${attempts} attempts)` };
}

// -- Reading a tool's version off the runner --------------------------------------------------------

/**
 * Bounded `<tool> --version`. A tool that is not installed, exits non-zero, hangs, or prints
 * something that is not a version all land in the same place: unreadable, which is a refusal.
 * @param {string} tool
 * @returns {Promise<{version: string} | {version: null, detail: string}>}
 */
export function readToolVersion(tool, { cwd = process.cwd(), timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(tool, ['--version'], { cwd, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const why = /** @type {any} */ (error).killed
          ? `timed out after ${timeoutMs}ms`
          : `${error.message.split('\n')[0]}`;
        resolve({ version: null, detail: `\`${tool} --version\` failed: ${why}` });
        return;
      }
      const line = String(stdout || '').trim().split('\n').map((l) => l.trim()).find(Boolean) || '';
      if (!parseVersion(line)) {
        resolve({
          version: null,
          detail:
            `\`${tool} --version\` printed no parseable version ` +
            `(stdout ${JSON.stringify(line)}, stderr ${JSON.stringify(String(stderr || '').trim().slice(0, 120))})`,
        });
        return;
      }
      resolve({ version: line });
    });
  });
}

// -- The verdict ------------------------------------------------------------------------------------

/**
 * @typedef {object} Verdict
 * @property {'staged' | 'direct' | 'refused'} mode
 * @property {boolean} failing
 * @property {string} title
 * @property {string} message
 * @property {Record<string, string>} outputs
 */

/**
 * Pure, so every arm below is testable without a registry, a runner or a child process.
 *
 * @param {object} facts
 * @param {string} facts.packageName
 * @param {{tool: 'pnpm' | 'npm', from: string} | {tool: null, detail: string}} facts.publisher
 * @param {{version: string} | {version: null, detail: string}} facts.publisherVersion
 * @param {any} facts.requirement
 * @param {{version: string} | {version: null, detail: string} | null} facts.floorVersion
 * @param {string} facts.nodeVersion
 * @param {{status: string, detail?: string, versions?: number}} facts.existence
 * @returns {Verdict}
 */
export function decide(facts) {
  const { packageName, publisher, publisherVersion, requirement, floorVersion, nodeVersion, existence } = facts;

  // A6, first half: which tool performs the publish.
  if (!publisher.tool) {
    return refusal('The publish path cannot be identified', [
      `Refusing to release ${packageName}: this gate could not identify the tool that would perform the publish.`,
      publisher.detail,
      'A floor cannot be asserted against a tool nobody can name, and assuming it is met is how a pipeline reports a guarantee it does not have.',
    ]);
  }
  // A6, second half: that tool's version.
  if (!publisherVersion.version) {
    return refusal('The publish tool version cannot be read', [
      `Refusing to release ${packageName}: this gate could not read the version of ${publisher.tool}, the tool on the resolved publish path.`,
      publisherVersion.detail,
      'Read it here: ' + publisher.from,
    ]);
  }
  if (!requirement.stageTool) {
    return refusal('The publish tool version cannot be read', [
      `Refusing to release ${packageName}: ${requirement.detail}.`,
    ]);
  }
  // The floor is owed by a tool that may not be the publisher (a pnpm 10 caller delegates to npm).
  if (floorVersion && !floorVersion.version) {
    return refusal('The floor tool version cannot be read', [
      `Refusing to release ${packageName}: ${publisher.tool} ${publisherVersion.version} publishes through ${requirement.floorTool}, and this gate could not read that tool's version.`,
      floorVersion.detail,
    ]);
  }
  const foundFloorVersion = floorVersion ? floorVersion.version : publisherVersion.version;

  // A12: whether the package already exists decides which arm runs, and silence is not an answer.
  if (existence.status === 'unknown') {
    return refusal('The registry did not say whether this package exists', [
      `Refusing to release ${packageName}: this gate could not determine whether the package already exists on the registry.`,
      existence.detail || '',
      'Guessing "never published" here takes the direct-publish arm and burns the version number permanently; guessing costs nothing when the answer is simply asked for again.',
    ]);
  }

  // A4: a brand-new package cannot be staged, so it publishes directly and this run says so.
  if (existence.status === 'never-published') {
    return {
      mode: 'direct',
      failing: false,
      title: 'Staged publishing is not available for this release',
      message: [
        `${packageName} has never been published, and npm is explicit that a package "already exists on the npm registry - you cannot stage a brand-new package".`,
        `This release therefore publishes DIRECTLY through ${publisher.tool} ${publisherVersion.version} and is permanent the moment it lands. There is no approval step and no reversible moment after this one.`,
        `Every later release of ${packageName} takes the staged path.`,
      ].join('\n'),
      outputs: {
        mode: 'direct',
        'publish-tool': publisher.tool,
        'publish-tool-version': publisherVersion.version,
        'stage-tool': '',
        'stage-tool-version': '',
        floor: '',
        'registry-status': 'never-published',
      },
    };
  }

  // A2 and A5: the staged arm, and the only arm on which a staging floor binds.
  const below = [];
  if (!meetsFloor(foundFloorVersion, requirement.floor)) {
    below.push(`${requirement.floorTool} ${foundFloorVersion} is below the ${requirement.floorTool} ${requirement.floor} that staged publishing needs`);
  }
  if (requirement.nodeFloor && !meetsFloor(nodeVersion, requirement.nodeFloor)) {
    below.push(`Node ${nodeVersion} is below the Node ${requirement.nodeFloor} that staged publishing needs`);
  }
  if (below.length) {
    return refusal('The publish path is below its staged-publishing floor', [
      `Refusing to release ${packageName} before anything is packed: ${below.join('; and ')}.`,
      `The publish is performed by ${publisher.tool} ${publisherVersion.version}. ${requirement.source}.`,
      `Fix it in the CALLING repository, not here: raise its \`packageManager\` pin (pnpm >= ${PNPM_STAGING_FLOOR} stages natively) or move that repository onto a Node whose bundled npm is >= ${NPM_STAGING_FLOOR}.`,
    ]);
  }

  return {
    mode: 'staged',
    failing: false,
    title: 'This release will be staged for review',
    message: [
      `${packageName} already exists on the registry, so this version is submitted to the npm staging area instead of being promoted to it.`,
      `Staging tool: ${requirement.stageTool} ${foundFloorVersion} (floor ${requirement.floor}). ${requirement.source}.`,
      'It does not become resolvable to a consumer until a maintainer approves it, with 2FA, by hand.',
    ].join('\n'),
    outputs: {
      mode: 'staged',
      'publish-tool': publisher.tool,
      'publish-tool-version': publisherVersion.version,
      'stage-tool': requirement.stageTool,
      'stage-tool-version': foundFloorVersion,
      floor: requirement.floor,
      'registry-status': 'published',
    },
  };
}

/**
 * Every refusal reports `mode: refused`, which is neither `staged` nor `direct`, so the two step
 * conditions downstream in `release.yml` are false on a refusal whatever else went wrong.
 * @returns {Verdict}
 */
function refusal(title, lines) {
  return {
    mode: 'refused',
    failing: true,
    title,
    message: lines.filter(Boolean).join('\n'),
    outputs: { mode: 'refused' },
  };
}

// -- Entry point ------------------------------------------------------------------------------------

const USAGE =
  'usage:\n' +
  '  publish-floor.mjs --package <name> [--repo <dir>] [--registry <url>]\n' +
  '                    [--attempts <n>] [--retry-delay-ms <n>]\n' +
  '  PACKAGE_NAME is read from the environment when --package is absent.\n';

/** A positive integer option, or the fallback. A bad value is never a smaller ladder by accident. */
export function numericOption(raw, fallback, { min = 1 } = {}) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/** @param {string[]} argv */
export function parseArgv(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    options[token.slice(2)] = value;
    i += 1;
  }
  return options;
}

/** Which of the lockfiles this gate recognises are actually on disk. */
export function lockfilesIn(dir, exists = existsSync) {
  return Object.keys(LOCKFILE_TOOLS).filter((name) => exists(path.join(dir, name)));
}

/**
 * Render the verdict the way `release.yml` reports everything else: an annotation so it lands on the
 * run, a step summary so it survives the log, and the plain text so a hand run reads the same.
 * @param {Verdict} verdict
 */
export function renderAnnotation(verdict) {
  const level = verdict.failing ? 'error' : verdict.mode === 'direct' ? 'warning' : 'notice';
  const first = verdict.message.split('\n')[0];
  return `::${level} title=${verdict.title}::${first}`;
}

/** @param {Verdict} verdict */
export function renderSummary(verdict) {
  return [`### ${verdict.title}`, '', ...verdict.message.split('\n'), ''].join('\n');
}

/**
 * @param {string[]} argv
 * @param {object} io
 */
export async function main(argv, io = {}) {
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
    stdout,
    stderr,
    readVersion = readToolVersion,
    appendFile = appendFileSync,
  } = io;
  const out = stdout ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const err = stderr ?? ((/** @type {string} */ s) => process.stderr.write(s));

  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }

  const packageName = options.package || env.PACKAGE_NAME || '';
  if (!packageName) {
    err(`a package name is required\n${USAGE}`);
    return 2;
  }
  const repo = options.repo || '.';
  const registry = options.registry || env.NPM_REGISTRY || DEFAULT_REGISTRY;

  // The caller's own manifest is the only place the publish tool is declared.
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  } catch (error) {
    const verdict = refusal('The publish path cannot be identified', [
      `Refusing to release ${packageName}: the caller's package.json could not be read at ${path.join(repo, 'package.json')}.`,
      error instanceof Error ? error.message : String(error),
    ]);
    return report(verdict, { out, err, env, appendFile });
  }

  const publisher = resolvePublishTool({
    packageManager: manifest.packageManager,
    lockfiles: lockfilesIn(repo),
  });

  /** @type {{version: string} | {version: null, detail: string}} */
  let publisherVersion = { version: null, detail: 'the publish tool was never identified' };
  /** @type {any} */
  let requirement = { stageTool: null, detail: 'the publish tool was never identified' };
  /** @type {{version: string} | {version: null, detail: string} | null} */
  let floorVersion = null;

  if (publisher.tool) {
    publisherVersion = await readVersion(publisher.tool, { cwd: repo });
    if (publisherVersion.version) {
      requirement = stagingRequirement({ tool: publisher.tool, version: publisherVersion.version });
      if (requirement.stageTool && requirement.floorTool !== publisher.tool) {
        floorVersion = await readVersion(requirement.floorTool, { cwd: repo });
      }
    }
  }

  // The registry is only asked once the tool questions have answers, so a run that is going to refuse
  // on the tool does not spend a retry ladder first.
  /** @type {any} */
  let existence = { status: 'unknown', detail: 'the registry was never asked' };
  const toolsReadable =
    publisher.tool && publisherVersion.version && requirement.stageTool && (!floorVersion || floorVersion.version);
  if (toolsReadable) {
    existence = await registryExistenceWithRetry(registry, packageName, withFetchTimeout(fetchImpl), {
      attempts: numericOption(options.attempts, DEFAULT_REGISTRY_ATTEMPTS),
      delayMs: numericOption(options['retry-delay-ms'], DEFAULT_RETRY_DELAY_MS, { min: 0 }),
    });
  }

  const verdict = decide({
    packageName,
    publisher,
    publisherVersion,
    requirement,
    floorVersion,
    nodeVersion: process.versions.node,
    existence,
  });

  return report(verdict, { out, err, env, appendFile });
}

/**
 * THE OUTPUTS ARE WRITTEN ON EVERY ARM, REFUSALS INCLUDED, and that is not tidiness. `release.yml`
 * reads `steps.publish-floor.outputs.mode` in three step conditions; an arm that wrote no output
 * would leave `mode` empty, and an empty string is not `staged`, which is the safe direction only
 * because it is also not `direct`. Writing `refused` explicitly makes that readable rather than
 * incidental.
 * @param {Verdict} verdict
 */
function report(verdict, { out, err, env, appendFile }) {
  out(`mode: ${verdict.mode}\n${verdict.message}\n`);
  out(`${renderAnnotation(verdict)}\n`);

  if (env.GITHUB_OUTPUT) {
    const lines = Object.entries(verdict.outputs).map(([k, v]) => `${k}=${v}`);
    appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFile(env.GITHUB_STEP_SUMMARY, `${renderSummary(verdict)}\n`);
  }
  if (verdict.failing) err(`${verdict.message}\n`);
  return verdict.failing ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main(process.argv.slice(2));
}
