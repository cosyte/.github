#!/usr/bin/env node
// @ts-check
//
// SUBMIT THE VERSION TO THE STAGING AREA, AND NEVER, EVER PUBLISH IT INSTEAD.
//
// This is the command `release.yml` hands to `changesets/action` in place of `pnpm run release` when
// `publish-floor.mjs` has decided the staged arm. It stages the caller's package and stops. It has
// exactly one irreversible failure mode and the whole file is shaped around avoiding it: an
// implementation that publishes directly while reporting that it staged burns the version number
// forever, which is strictly worse than the pipeline it replaces.
//
// So there is no fallback. When staging fails, for any reason, the run fails with the registry
// untouched. That is A7, and it is the reason this script never spawns a bare `publish`: the only
// argument vector it can build is `stage publish`, `stagePublishArgs` is the only place one is built,
// and `test/staged-publish.test.mjs` proves it by running the real entry point against a fake tool
// that records the argv it was handed.
//
// ---------------------------------------------------------------------------
// WHY IT MUST NOT PRINT `New tag:`, WHICH IS THE SECOND IRREVERSIBLE HAZARD
// ---------------------------------------------------------------------------
//
// `changesets/action` decides whether anything was published by SCANNING THE PUBLISH COMMAND'S
// STDOUT. For a single-package repository, which every caller of this workflow is, the test is the
// bare `/New tag:/` and nothing more. Whatever it finds becomes `steps.changesets.outputs.published`,
// and three steps downstream key off that output: the GitHub release, the docs rebuild dispatch, and
// the post-publish registry install gate.
//
// A staged version is NOT resolvable from the registry until a human approves it. If our stdout ever
// carried that marker, this pipeline would cut a GitHub release for a version nobody can install,
// tell cosyte/docs to rebuild against it, and then spend the install gate's entire deadline budget
// asking the registry for a version it will never serve. So every byte this script forwards from the
// tool goes through `suppressPublishMarkers` first. The suppression is not cosmetic and it is not
// belt-and-braces: it is the mechanism by which A8 holds.
//
// ---------------------------------------------------------------------------
// APPROVAL IS A HUMAN ACTION AND THIS FILE CANNOT PERFORM IT
// ---------------------------------------------------------------------------
//
// npm: "You will be prompted for 2FA verification whether you approve the package in the CLI or on
// npmjs.com." Staging itself does not require 2FA, which is exactly why CI can stage and cannot
// finish the job. This script therefore reports what a maintainer needs in order to look at the
// bytes and decide, and takes no decision itself. `report` re-states it in the job summary after the
// action step, so the run's own surface carries it and not only the log.
//
// Run it by hand against a checkout (it really does stage; there is no dry run here):
//
//   node scripts/staged-publish.mjs stage  --package @cosyte/hl7 --repo .
//   node scripts/staged-publish.mjs report --package @cosyte/hl7

import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  lockfilesIn,
  meetsFloor,
  readToolVersion,
  resolvePublishTool,
  stagingRequirement,
} from './publish-floor.mjs';

/** `pnpm stage publish` inherits `pnpm publish`'s git checks, and a built tree is a dirty tree. */
export const PNPM_STAGE_FLAGS = Object.freeze(['--no-git-checks']);

// A bounded stage. This runs inside a job holding a protected `release` environment, so an upload
// that hangs must not inherit the six-hour job default.
export const DEFAULT_STAGE_TIMEOUT_MS = 600_000;

/**
 * THE ONLY ARGUMENT VECTOR THIS SCRIPT CAN BUILD.
 *
 * There is deliberately no parameter that could turn this into a publish, an approval or a
 * rejection. A staged version is promoted to the live registry by a maintainer, with 2FA, and CI is
 * structurally incapable of doing it here rather than merely declining to.
 *
 * @param {'pnpm' | 'npm'} tool
 * @returns {readonly string[]}
 */
export function stagePublishArgs(tool) {
  return tool === 'pnpm'
    ? Object.freeze(['stage', 'publish', ...PNPM_STAGE_FLAGS])
    : Object.freeze(['stage', 'publish']);
}

/**
 * Neutralise the marker `changesets/action` reads as "a version was published".
 *
 * The replacement keeps the words a human is reading and breaks the token a machine is matching:
 * the action's own patterns are `/New tag:\s+(@[^/]+\/[^@]+|[^/@]+)@([^\s]+)/` for a workspace and
 * the bare `/New tag:/` for a single-package repository, and neither survives the colon moving.
 *
 * @param {string} text
 */
export function suppressPublishMarkers(text) {
  return String(text ?? '').replace(/new tag:/gi, 'new tag [SUPPRESSED: staged, not published]');
}

/** The action's own predicates, restated here so the tests assert against the real thing. */
export const CHANGESETS_NEW_TAG_PATTERNS = Object.freeze([
  /New tag:\s+(@[^/]+\/[^@]+|[^/@]+)@([^\s]+)/,
  /New tag:/,
]);

/**
 * Best effort, and labelled as such wherever it is used. pnpm documents that "the resulting stage id
 * is printed" but not in what shape, and npm documents the verbs without an output format. So a
 * miss is not a failure: A9 is satisfied by the identifier OR the location, and the location is a
 * command that needs no identifier at all.
 * @param {string} text
 * @returns {string | null}
 */
export function extractStageId(text) {
  const patterns = [
    /\bstage[\s_-]*id\b\s*[:=]?\s*["']?([A-Za-z0-9][A-Za-z0-9._~-]{5,})["']?/i,
    /\bstaged\s+as\s+["']?([A-Za-z0-9][A-Za-z0-9._~-]{5,})["']?/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(String(text ?? ''));
    if (match) return match[1];
  }
  return null;
}

/**
 * What a maintainer runs to look at the bytes before deciding. A9's "identifier or location": with
 * an id these are exact, and without one `stage list` is the location that finds it.
 * @param {{tool: 'pnpm' | 'npm', packageName: string, stageId: string | null}} facts
 */
export function reviewCommands({ tool, packageName, stageId }) {
  const target = stageId ?? '<stage-id>';
  return [
    `${tool} stage list ${packageName}`,
    `${tool} stage view ${target}`,
    `${tool} stage download ${target}`,
  ];
}

/**
 * @param {{packageName: string, version: string, tool: 'pnpm' | 'npm', stageId: string | null}} facts
 */
export function renderStageReport({ packageName, version, tool, stageId }) {
  const commands = reviewCommands({ tool, packageName, stageId });
  const idLine = stageId
    ? `- stage id: \`${stageId}\``
    : '- stage id: not printed in a shape this run could parse; the first command below finds it';
  return [
    `### ${packageName}@${version} is STAGED, not published`,
    '',
    `It was submitted to the npm staging area with \`${tool} stage publish\`. No consumer can resolve`,
    `it, and \`npm view ${packageName} versions\` is unchanged, until a maintainer promotes it by hand.`,
    'Walk away and nothing happens: the live registry keeps exactly the versions it already had.',
    '',
    `- package: \`${packageName}\``,
    `- version: \`${version}\``,
    idLine,
    '',
    'Review the exact bytes before deciding:',
    '',
    '```bash',
    ...commands,
    '```',
    '',
    'Then promote it, or do not. Promotion happens on npmjs.com under the Staged Packages tab, or',
    `from the CLI with \`${tool} stage approve\`. Both prompt for 2FA, which is why this pipeline`,
    'stages and stops: it has no second factor and is not meant to have one.',
  ].join('\n');
}

// -- Running the tool -------------------------------------------------------------------------------

/**
 * The single spawn site in this file.
 * @returns {Promise<{code: number, stdout: string, stderr: string, argv: readonly string[]}>}
 */
export function runStagePublish(tool, { cwd = process.cwd(), timeoutMs = DEFAULT_STAGE_TIMEOUT_MS } = {}) {
  const argv = stagePublishArgs(tool);
  return new Promise((resolve) => {
    execFile(
      tool,
      [...argv],
      { cwd, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // A missing binary, a kill on timeout and a non-zero exit all arrive as an `error`, and only
        // the last carries a numeric `code`. They are one outcome here: the stage did not happen.
        const raw = /** @type {any} */ (error)?.code;
        const code = error ? (typeof raw === 'number' && raw !== 0 ? raw : 1) : 0;
        const trace = String(stderr || '');
        resolve({
          code,
          stdout: String(stdout || ''),
          stderr: error && !trace.trim() ? String(error.message || '') : trace,
          argv,
        });
      },
    );
  });
}

// -- Entry point ------------------------------------------------------------------------------------

const USAGE =
  'usage:\n' +
  '  staged-publish.mjs stage  --package <name> [--repo <dir>] [--report <file>]\n' +
  '  staged-publish.mjs report --package <name> [--report <file>]\n' +
  '  PACKAGE_NAME and STAGED_PUBLISH_REPORT are read from the environment when the flag is absent.\n';

/** @param {string[]} argv */
export function parseArgv(argv) {
  /** @type {{verb: string, options: Record<string, string>}} */
  const parsed = { verb: '', options: {} };
  let i = 0;
  if (argv[0] && !argv[0].startsWith('--')) {
    parsed.verb = argv[0];
    i = 1;
  }
  for (; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    parsed.options[token.slice(2)] = value;
    i += 1;
  }
  return parsed;
}

function reportPathFrom(options, env) {
  return (
    options.report ||
    env.STAGED_PUBLISH_REPORT ||
    path.join(env.RUNNER_TEMP || env.TMPDIR || '/tmp', 'staged-publish.json')
  );
}

/**
 * @param {string[]} argv
 * @param {object} io
 */
export async function main(argv, io = {}) {
  const {
    env = process.env,
    stdout,
    stderr,
    readVersion = readToolVersion,
    runStage = runStagePublish,
    appendFile = appendFileSync,
    writeFile = writeFileSync,
    readFile = readFileSync,
  } = io;
  const out = stdout ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const err = stderr ?? ((/** @type {string} */ s) => process.stderr.write(s));

  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const { verb, options } = parsed;
  if (verb !== 'stage' && verb !== 'report') {
    err(`a verb is required, either \`stage\` or \`report\` (got ${JSON.stringify(verb)})\n${USAGE}`);
    return 2;
  }
  const packageName = options.package || env.PACKAGE_NAME || '';
  if (!packageName) {
    err(`a package name is required\n${USAGE}`);
    return 2;
  }
  const reportPath = reportPathFrom(options, env);

  if (verb === 'report') {
    return emitReport({ packageName, reportPath, out, err, env, appendFile, readFile });
  }

  const repo = options.repo || '.';

  // RESOLVED AGAIN HERE RATHER THAN PASSED IN. `publish-floor.mjs` already decided this arm, and its
  // answer arrives through a step output that a future edit could widen, narrow or forget. Importing
  // the same functions means the two cannot disagree about which tool stages or what floor it owes,
  // and it costs one `--version` and no network.
  const publisher = resolvePublishTool({
    packageManager: readManifest(repo, readFile)?.packageManager,
    lockfiles: lockfilesIn(repo),
  });
  if (!publisher.tool) {
    return refuse(err, out, env, appendFile, 'The publish path cannot be identified', [
      `Refusing to stage ${packageName}: ${publisher.detail}.`,
      'Nothing was published and nothing was staged.',
    ]);
  }
  const publisherVersion = await readVersion(publisher.tool, { cwd: repo });
  if (!publisherVersion.version) {
    return refuse(err, out, env, appendFile, 'The publish tool version cannot be read', [
      `Refusing to stage ${packageName}: ${publisherVersion.detail}.`,
      'Nothing was published and nothing was staged.',
    ]);
  }
  const requirement = stagingRequirement({ tool: publisher.tool, version: publisherVersion.version });
  if (!requirement.stageTool) {
    return refuse(err, out, env, appendFile, 'The publish tool version cannot be read', [
      `Refusing to stage ${packageName}: ${requirement.detail}.`,
      'Nothing was published and nothing was staged.',
    ]);
  }
  const stageToolVersion =
    requirement.floorTool === publisher.tool
      ? publisherVersion
      : await readVersion(requirement.floorTool, { cwd: repo });
  if (!stageToolVersion.version || !meetsFloor(stageToolVersion.version, requirement.floor)) {
    return refuse(err, out, env, appendFile, 'The publish path is below its staged-publishing floor', [
      `Refusing to stage ${packageName}: ${requirement.floorTool} ${stageToolVersion.version || '(unreadable)'} does not clear the ${requirement.floorTool} ${requirement.floor} floor.`,
      'Nothing was published and nothing was staged.',
    ]);
  }

  const manifest = readManifest(repo, readFile);
  const version = typeof manifest?.version === 'string' ? manifest.version : '';
  if (!version) {
    return refuse(err, out, env, appendFile, 'The version being released cannot be read', [
      `Refusing to stage ${packageName}: no \`version\` in ${path.join(repo, 'package.json')}.`,
      'Nothing was published and nothing was staged.',
    ]);
  }

  out(`Staging ${packageName}@${version} with ${requirement.stageTool} ${stageToolVersion.version}.\n`);
  const result = await runStage(requirement.stageTool, { cwd: repo });

  // EVERY BYTE THE TOOL PRODUCED, WITH THE PUBLISH MARKER BROKEN. The log is where a maintainer
  // finds the stage id when this script's own extraction misses its shape, so the output is
  // forwarded whole rather than summarised.
  if (result.stdout.trim()) out(`${suppressPublishMarkers(result.stdout)}\n`);
  if (result.stderr.trim()) err(`${suppressPublishMarkers(result.stderr)}\n`);

  if (result.code !== 0) {
    // A7. There is no second attempt and no other verb; the version is simply not on the registry.
    return refuse(err, out, env, appendFile, 'Staging failed, so nothing was published', [
      `\`${requirement.stageTool} ${result.argv.join(' ')}\` exited ${result.code} for ${packageName}@${version}.`,
      'This run does NOT fall back to a direct publish. A direct publish is permanent and a failed staging is not evidence that publishing is what was wanted.',
      `The live registry is unchanged: \`npm view ${packageName} versions\` still lists exactly what it listed before this run.`,
    ]);
  }

  const stageId = extractStageId(`${result.stdout}\n${result.stderr}`);
  const record = {
    package: packageName,
    version,
    tool: requirement.stageTool,
    toolVersion: stageToolVersion.version,
    stageId,
    reviewCommands: reviewCommands({ tool: requirement.stageTool, packageName, stageId }),
    stagedAt: new Date().toISOString(),
  };
  // WRITTEN LAST, AND THAT ORDERING IS LOAD-BEARING. The `report` step reads a missing file as "the
  // action never took its publish arm", which is a real and harmless state. It can only read it that
  // way because a run that DID stage always leaves the file behind: a failed write is a failed step.
  try {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch (error) {
    err(
      `${packageName}@${version} WAS staged, but the report could not be written to ${reportPath}: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  out(`${renderStageReport(record)}\n`);
  out(
    `::notice title=A version is staged and awaiting a maintainer::` +
      `${packageName}@${version} was submitted to the npm staging area and is NOT resolvable to consumers. ` +
      `Review it with \`${requirement.stageTool} stage list ${packageName}\`.\n`,
  );
  return 0;
}

/** @returns {any} */
function readManifest(repo, readFile) {
  try {
    return JSON.parse(readFile(path.join(repo, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function refuse(err, out, env, appendFile, title, lines) {
  const message = lines.filter(Boolean).join('\n');
  err(`${message}\n`);
  out(`::error title=${title}::${lines[0]}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFile(env.GITHUB_STEP_SUMMARY, `### ${title}\n\n${message}\n\n`);
  }
  return 1;
}

/**
 * The post-action report step. A missing file is not an error: `is-release` is not the action's own
 * arm predicate, so a run can reach this step on the staged arm having published nothing at all.
 * Reporting a stage that did not happen is the failure mode worth avoiding here, not the reverse.
 */
function emitReport({ packageName, reportPath, out, err, env, appendFile, readFile }) {
  let record;
  try {
    record = JSON.parse(readFile(reportPath, 'utf8'));
  } catch {
    out(
      `No staging report at ${reportPath}, so this run staged nothing for ${packageName}. ` +
        'That is what an already-open version PR looks like from here; nothing reached the registry.\n',
    );
    return 0;
  }
  const rendered = renderStageReport({
    packageName: record.package || packageName,
    version: record.version || '(unknown)',
    tool: record.tool || 'npm',
    stageId: record.stageId ?? null,
  });
  out(`${rendered}\n`);
  out(
    `::warning title=A version is staged and awaiting a maintainer::` +
      `${record.package || packageName}@${record.version || '(unknown)'} is in the npm staging area and is NOT ` +
      `resolvable to consumers. It stays that way until a maintainer reviews and promotes it with 2FA.\n`,
  );
  if (env.GITHUB_STEP_SUMMARY) {
    appendFile(env.GITHUB_STEP_SUMMARY, `${rendered}\n\n`);
  }
  void err;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main(process.argv.slice(2));
}
