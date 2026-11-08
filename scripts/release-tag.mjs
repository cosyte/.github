#!/usr/bin/env node
// @ts-check
//
// TAG THE VERSION COMMIT WHILE A GITHUB TOKEN STILL CAN, WHICH IS BEFORE THE DEFAULT BRANCH MOVES ON.
//
// GitHub refuses a `GITHUB_TOKEN` any write that would make a ref point at a commit whose
// `.github/workflows/` differ from the default branch's: such a write needs the `workflows`
// permission, and no `permissions:` key can grant that token it. Measured on 2026-11-08 with a
// `GITHUB_TOKEN` holding `contents: write`, in a repository with release immutability on, after one
// commit that changed a workflow file:
//
//   POST git/refs, a new tag at the commit before that change        403 "Resource not accessible
//                                                                       by integration"
//   POST git/refs, a new tag at an older commit whose workflow files  201: the age of the commit is
//     equal the default branch's                                        not what is refused
//   POST releases, a new tag created through `target_commitish`       403, as above
//   POST releases, an EXISTING tag at that commit, `target_commitish` 403, as above
//     sent too
//   POST releases, that existing tag, no `target_commitish`           201, published, immutable,
//     (`gh release create --verify-tag`), with an asset                 the asset attached
//   PATCH releases, the title and body of that release                200
//   a draft created before the change, published after it            200, and published as an
//                                                                       immutable release named
//                                                                       `untagged-...` with NO tag
//
// That is what stranded `@cosyte/transform@0.1.4` twice on 2026-11-08. Its version commit published to
// npm, and the release step then made `v0.1.4` through `gh release create --target <version commit>`,
// minutes after the merge; a change to two workflow files had landed on `main` in between, so GitHub
// refused with the 403 above. The next run's `finalize` job made the same call and got the same
// answer, and so would every later run: nothing that holds a `GITHUB_TOKEN` could ever tag it.
//
// SO THE TAG COMES FIRST. The `version` job runs this within seconds of the merge, right after the
// notes gate, and nothing is published unless it has made `v<version>` on the version commit or found
// it there. Every GitHub release is then created at that existing tag with no `target_commitish`
// (`github-release.mjs`), which GitHub allows whatever the default branch's workflow files have
// become since. If GitHub refuses the tag here too, because the default branch has already moved on,
// nothing has been published, and the run says exactly why and which command makes the tag with a
// maintainer's own credentials, which can carry the `workflow` scope.
//
// WHAT THE TAG MEANS NOW. It marks the version commit of a release in progress, and it can exist
// before npm serves the version. What proves a publish is npm itself and the GitHub release, which is
// only ever created for a version the registry serves. `release-notes.mjs` looks past the tag on the
// tagged version commit itself, and `promotion.mjs pending` asks the GitHub release and the registry
// what a tagged version is still owed.
//
// IT NEVER PUBLISHES, AND IT WRITES ONE THING: a lightweight tag ref, created and never moved or
// deleted. A tag that already exists on another commit is reported and left exactly as it is.
//
// One verb, run from a caller checkout with full history:
//
//   GH_TOKEN=... GITHUB_REPOSITORY=cosyte/x12 node scripts/release-tag.mjs ensure --repo . --package @cosyte/x12
//
// Outputs (`GITHUB_OUTPUT`): `ready` is `true` only when `v<version>` points at the version commit
// when this exits. `tag`, `version`, `sha`, `outcome`, and on anything but `ready`, a one-line
// `reason` and the `command` that makes the tag by hand. A refusal is reported and exits 0: the
// step after the Version PR step fails the job on it, so the Version PR flow still runs first.
// Exit 2 is bad usage.

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { withFetchTimeout } from './install-check.mjs';
import { findVersionCommit, inspectRelease } from './release-notes.mjs';

export const DEFAULT_API_URL = 'https://api.github.com';
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** An annotated tag can point at another tag; past this many hops it is not a release tag. */
const MAX_PEEL = 4;
/** What a version may look like before it is put into a ref name and a printed command. */
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA_SHAPE = /^[0-9a-f]{40}$/;
const REPOSITORY_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * THE TAG IS `v<version>`, AND IT MUST STAY PARSEABLE BY cosyte/docs. Every caller of this workflow is
 * a single-package repository, for which Changesets tags `v<version>`; it uses `<pkg>@<version>` only
 * in a multi-package one. docs' `parseTag()` strips a leading `v` and reads `/^(\d+)\.(\d+)\.(\d+)/`,
 * so `@cosyte/x12@0.0.1` parses to null and derives a version slot carrying a `/`, which is not a
 * directory name. docs keeps only releases carrying `docs-content.tar.gz`, so a release at that
 * spelling would be the one it selected. Defined here, where the tag is made; `github-release.mjs`,
 * which releases it, re-exports it.
 *
 * @param {string} version
 */
export function releaseTag(version) {
  return `v${version}`;
}

/**
 * Text from GitHub or from a file name, made safe for a single-line step output: no control
 * characters, so no newline can end the value or start another one, and bounded.
 *
 * @param {unknown} text
 */
export function oneLine(text, max = 300) {
  const flat = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** One line, escaped the way the runner unescapes an annotation's message. */
export function annotationText(text, max = 2000) {
  return oneLine(text, max).replace(/%/g, '%25');
}

function requestHeaders(token, extra = {}) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    ...extra,
  };
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Which commit `tag` points at in `repository`, read through the API rather than a local checkout,
 * because a tag made after the checkout fetched is invisible to it.
 *
 * The exact-ref endpoint (`git/ref/tags/<tag>`) answers 404 when the tag is absent; it never answers
 * with a neighbour's prefix match the way the plural one can. An annotated tag is followed to its
 * commit. Everything that is not a 200 or a 404 is `unknown`.
 *
 * @returns {Promise<{status: 'present', commit: string} | {status: 'absent'} | {status: 'unknown', detail: string}>}
 */
export async function resolveTag({ apiUrl = DEFAULT_API_URL, repository, tag, token, fetchImpl }) {
  if (!repository || !token) return { status: 'unknown', detail: 'no repository or no token to ask with' };
  let res;
  try {
    res = await fetchImpl(`${apiUrl}/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, {
      headers: requestHeaders(token),
    });
  } catch (error) {
    return { status: 'unknown', detail: `the request failed (${error instanceof Error ? error.message : String(error)})` };
  }
  if (res.status === 404) return { status: 'absent' };
  if (res.status !== 200) return { status: 'unknown', detail: `GitHub answered ${res.status}` };
  let object = (await readJson(res))?.object;
  for (let hop = 0; hop < MAX_PEEL && object?.type === 'tag'; hop += 1) {
    let peeled;
    try {
      peeled = await fetchImpl(`${apiUrl}/repos/${repository}/git/tags/${object.sha}`, { headers: requestHeaders(token) });
    } catch (error) {
      return { status: 'unknown', detail: `the annotated tag could not be read (${error instanceof Error ? error.message : String(error)})` };
    }
    if (peeled.status !== 200) return { status: 'unknown', detail: `GitHub answered ${peeled.status} for the annotated tag` };
    object = (await readJson(peeled))?.object;
  }
  if (object?.type !== 'commit' || typeof object.sha !== 'string') {
    return { status: 'unknown', detail: 'the tag does not resolve to a commit' };
  }
  return { status: 'present', commit: object.sha };
}

/**
 * Make `refs/tags/<tag>` point at `sha`. A lightweight tag, the kind `gh release create` makes.
 *
 * @returns {Promise<{status: 'created' | 'exists' | 'refused' | 'failed', httpStatus: number, detail: string}>}
 */
export async function createTagRef({ apiUrl = DEFAULT_API_URL, repository, tag, sha, token, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${apiUrl}/repos/${repository}/git/refs`, {
      method: 'POST',
      headers: requestHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
    });
  } catch (error) {
    return { status: 'failed', httpStatus: 0, detail: `the request failed (${error instanceof Error ? error.message : String(error)})` };
  }
  const message = oneLine((await readJson(res))?.message ?? '');
  if (res.status === 201) return { status: 'created', httpStatus: 201, detail: '' };
  if (res.status === 422 && /already exists/i.test(message)) return { status: 'exists', httpStatus: 422, detail: message };
  if (res.status === 403) return { status: 'refused', httpStatus: 403, detail: message };
  return { status: 'failed', httpStatus: res.status, detail: message };
}

/**
 * Which files under `.github/workflows/` differ between `sha` and the default branch, which is the
 * difference GitHub refuses a `GITHUB_TOKEN` a tag for. Only asked after a refusal, to say why.
 * Null when it cannot be read; the refusal is reported either way.
 *
 * @returns {Promise<{defaultBranch: string, files: string[]} | null>}
 */
export async function workflowFilesSince({ apiUrl = DEFAULT_API_URL, repository, sha, token, fetchImpl }) {
  try {
    const repo = await fetchImpl(`${apiUrl}/repos/${repository}`, { headers: requestHeaders(token) });
    if (repo.status !== 200) return null;
    const defaultBranch = (await readJson(repo))?.default_branch;
    if (typeof defaultBranch !== 'string' || defaultBranch === '') return null;
    const compare = await fetchImpl(`${apiUrl}/repos/${repository}/compare/${sha}...${encodeURIComponent(defaultBranch)}`, {
      headers: requestHeaders(token),
    });
    if (compare.status !== 200) return null;
    const files = (await readJson(compare))?.files;
    if (!Array.isArray(files)) return null;
    return {
      defaultBranch,
      files: files
        .map((file) => (typeof file?.filename === 'string' ? file.filename : ''))
        .filter((name) => name.startsWith('.github/workflows/')),
    };
  } catch {
    return null;
  }
}

/** The one command that makes the tag with a maintainer's own credentials. */
export function tagCommand({ repository, tag, sha }) {
  return `gh api repos/${repository}/git/refs -f ref=refs/tags/${tag} -f sha=${sha}`;
}

/**
 * Make sure `v<version>` points at `sha`: find it there, make it there, or say why not. Writes only
 * when the tag is absent, and never moves or deletes a tag.
 *
 * @returns {Promise<{ready: boolean, outcome: 'exists' | 'created' | 'raced' | 'elsewhere' | 'refused' | 'unreadable' | 'failed', tag: string, commit?: string, files?: string[] | null, defaultBranch?: string, detail?: string, httpStatus?: number}>}
 */
export async function ensureTag({ apiUrl = DEFAULT_API_URL, repository, version, sha, token, fetchImpl }) {
  const tag = releaseTag(version);
  const ask = () => resolveTag({ apiUrl, repository, tag, token, fetchImpl });
  const judge = (found, outcome) => {
    if (found.status === 'present' && found.commit === sha) return { ready: true, outcome, tag, commit: found.commit };
    if (found.status === 'present') return { ready: false, outcome: 'elsewhere', tag, commit: found.commit };
    if (found.status === 'unknown') return { ready: false, outcome: 'unreadable', tag, detail: found.detail };
    return null;
  };
  const before = await ask();
  const settled = judge(before, 'exists');
  if (settled) return settled;
  const made = await createTagRef({ apiUrl, repository, tag, sha, token, fetchImpl });
  if (made.status === 'created') return { ready: true, outcome: 'created', tag, commit: sha };
  if (made.status === 'exists') {
    // Another run made it between the read and the write. Whether that is ours is the tag's answer.
    const raced = judge(await ask(), 'raced');
    if (raced) return raced;
    return { ready: false, outcome: 'failed', tag, httpStatus: made.httpStatus, detail: made.detail };
  }
  if (made.status === 'refused') {
    const drift = await workflowFilesSince({ apiUrl, repository, sha, token, fetchImpl });
    return {
      ready: false,
      outcome: 'refused',
      tag,
      httpStatus: made.httpStatus,
      detail: made.detail,
      files: drift ? drift.files : null,
      ...(drift ? { defaultBranch: drift.defaultBranch } : {}),
    };
  }
  return { ready: false, outcome: 'failed', tag, httpStatus: made.httpStatus, detail: made.detail };
}

/**
 * What the run says about an `ensureTag` result: the log line, the annotation level, a one-line
 * reason for the step output, and the command, when one is needed.
 *
 * @param {Awaited<ReturnType<typeof ensureTag>>} result
 * @param {{packageName: string, version: string, sha: string, repository: string}} context
 */
export function describeTag(result, { packageName, version, sha, repository }) {
  const { tag } = result;
  const short = sha.slice(0, 7);
  const command = tagCommand({ repository, tag, sha });
  if (result.outcome === 'exists') {
    return { level: 'info', reason: '', command: '', message: `${tag} already points at the version commit ${short}.` };
  }
  if (result.outcome === 'created' || result.outcome === 'raced') {
    return {
      level: 'info',
      reason: '',
      command: '',
      message:
        `${result.outcome === 'created' ? 'Tagged' : 'Another run tagged'} the version commit ${short} as ${tag}, before anything ` +
        `is published, so ${packageName}@${version}'s GitHub release can be created at that tag whatever the default ` +
        'branch has become by then.',
    };
  }
  if (result.outcome === 'elsewhere') {
    const at = String(result.commit).slice(0, 7);
    return {
      level: 'error',
      command: '',
      reason:
        `${tag} already points at ${at}, not at the version commit ${short}, so nothing is published or released for ` +
        `${packageName}@${version}: a release at that tag would describe a commit it was not built from.`,
      message:
        `${tag} already points at ${at}, not at the version commit ${short}. Nothing is published and no release is ` +
        `created. If ${at} is wrong, delete the tag with a maintainer's own credentials ` +
        `(gh api -X DELETE repos/${repository}/git/refs/tags/${tag}) and re-run; the tag is left exactly as it is here.`,
    };
  }
  if (result.outcome === 'refused') {
    const files = result.files ?? null;
    const why =
      files && files.length > 0
        ? `the default branch's workflow files have changed since ${short} (${files.map((file) => oneLine(file, 120)).join(', ')}), ` +
          'and GitHub lets a GITHUB_TOKEN make a ref at such a commit only with the workflows permission, which no ' +
          'permissions key can grant it'
        : `GitHub answered ${result.httpStatus}${result.detail ? ` (${oneLine(result.detail)})` : ''}` +
          (files ? `, and no workflow file differs between ${short} and the default branch` : '');
    return {
      level: 'error',
      command,
      reason: `GitHub refused to create ${tag} at the version commit ${short}: ${why}. Nothing has been published.`,
      message:
        `GitHub refused to create ${tag} at the version commit ${short}: ${why}. Nothing has been published, and ` +
        `nothing is published without that tag. Make it with a maintainer's own credentials, which can carry the ` +
        `workflow scope: ${command}, then re-run this run's failed jobs.`,
    };
  }
  const detail = result.detail ? ` (${oneLine(result.detail)})` : '';
  return {
    level: 'error',
    command,
    reason:
      result.outcome === 'unreadable'
        ? `Whether ${tag} exists could not be read${detail}, so nothing is published for ${packageName}@${version}.`
        : `${tag} could not be created at the version commit ${short}${result.httpStatus ? `: GitHub answered ${result.httpStatus}` : ''}${detail}. Nothing has been published.`,
    message:
      result.outcome === 'unreadable'
        ? `Whether ${tag} exists could not be read${detail}. Nothing is published on a guess; re-run this run's failed jobs.`
        : `${tag} could not be created at the version commit ${short}${result.httpStatus ? `: GitHub answered ${result.httpStatus}` : ''}${detail}. ` +
          `Nothing has been published. Re-run this run's failed jobs, or make the tag by hand: ${command}.`,
  };
}

const USAGE =
  'usage:\n' +
  '  release-tag.mjs ensure --repo <dir> --package <name>\n' +
  '  GH_TOKEN and GITHUB_REPOSITORY are read from the environment; PACKAGE_NAME when --package is absent.\n';

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
    appendFile = appendFileSync,
    inspect = inspectRelease,
    findVersion = findVersionCommit,
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
  if (parsed.verb !== 'ensure') {
    err(`the verb is \`ensure\` (got ${JSON.stringify(parsed.verb)})\n${USAGE}`);
    return 2;
  }
  const packageName = parsed.options.package || env.PACKAGE_NAME || '';
  const repository = env.GITHUB_REPOSITORY || '';
  if (!packageName || !REPOSITORY_SHAPE.test(repository)) {
    err(`a package name and GITHUB_REPOSITORY (owner/name) are required\n${USAGE}`);
    return 2;
  }
  const repo = path.resolve(parsed.options.repo || '.');

  /** @param {Record<string, string>} values */
  const writeOutputs = (values) => {
    if (!env.GITHUB_OUTPUT) return;
    appendFile(env.GITHUB_OUTPUT, `${Object.entries(values).map(([key, value]) => `${key}=${oneLine(value, 1000)}`).join('\n')}\n`);
  };
  /** @param {string} reason @param {string} [version] @param {string} [sha] @param {string} [command] */
  const notReady = (reason, version = '', sha = '', command = '') => {
    out(`::error title=Release not tagged::${annotationText(reason)}\n`);
    writeOutputs({ ready: 'false', tag: version ? releaseTag(version) : '', version, sha, outcome: 'unclassified', reason, command });
    return 0;
  };

  // WHICH VERSION AND WHICH COMMIT, read from git the way the notes gate reads them, rather than
  // from another step's outputs: a step that faulted leaves no outputs, and this one must still tag
  // the version commit the notes gate gave permission to publish.
  const release = inspect(repo, packageName);
  const version = typeof release?.version === 'string' ? release.version : '';
  let sha = '';
  if (release?.isRelease) sha = release.sha;
  else if (release?.code === 'already-released' && version) sha = findVersion(repo, version)?.sha ?? '';
  if (!VERSION_SHAPE.test(version)) {
    return notReady(`package.json declares ${JSON.stringify(oneLine(version, 80))}, which is not a version this pipeline tags.`);
  }
  if (!SHA_SHAPE.test(sha)) {
    return notReady(`No commit in this history introduces ${packageName}@${version}, so there is no version commit to tag.`, version);
  }

  const result = await ensureTag({
    apiUrl: env.GITHUB_API_URL || DEFAULT_API_URL,
    repository,
    version,
    sha,
    token: env.GH_TOKEN || '',
    fetchImpl: withFetchTimeout(fetchImpl, DEFAULT_FETCH_TIMEOUT_MS),
  });
  const said = describeTag(result, { packageName, version, sha, repository });
  out(`${said.message}\n`);
  if (said.level === 'error') out(`::error title=Release not tagged::${annotationText(said.message)}\n`);
  writeOutputs({
    ready: String(result.ready),
    tag: result.tag,
    version,
    sha,
    outcome: result.outcome,
    reason: said.reason,
    command: said.command,
  });
  if (!result.ready && env.GITHUB_STEP_SUMMARY) {
    appendFile(env.GITHUB_STEP_SUMMARY, `### ${result.tag} is not on the version commit\n\n${said.message}\n\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
