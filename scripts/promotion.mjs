#!/usr/bin/env node
// @ts-check
//
// HAS A STAGED VERSION BEEN PROMOTED, AND IF IT HAS, WHAT IS IT STILL OWED.
//
// A staged release ends its publish step with the version in npm's staging area, where no consumer
// can resolve it, and with its `v<version>` tag (the version job makes that before anything is
// published) but no GitHub release and no docs dispatch. Both are right while the version is
// unpromoted: announcing a version the registry will not serve is a lie on a public surface. They
// stop being right the moment a maintainer promotes it, and nothing a maintainer does on npmjs.com
// reaches back into this pipeline. This script is how the pipeline finds out, from the one place
// that can say: the public registry, read anonymously.
//
// Two verbs, one per half of the answer:
//
//   await    In the `release` job, straight after a stage. Polls the registry until the staged
//            version is resolvable or a bounded window lapses. A lapse is not a failure: the version
//            is simply not live yet, the run says so, and `pending` picks it up on a later run.
//   pending  In the `version` job, on every run. Asks what the version `package.json` declares is
//            still owed. A pending version that is ALREADY live, which is what a promotion after the
//            window or a direct publish whose release step never finished looks like from the next
//            push, has nothing left to publish, so the `release` job must not start for it (it would
//            ask a human to approve a stage of a version npm already serves, and the stage would
//            fail). What it is owed is its GitHub release and its docs dispatch, at the tag on its
//            version commit, and the `finalize` job does those without the release environment and
//            without any npm credential. A TAGGED version is asked too, because the tag now comes
//            before the publish and so no longer proves one: its GitHub release answers that, in one
//            request on an ordinary push. And a version this run cannot publish, because this run
//            is not on its version commit, is reported with what to re-run.
//
// IT NEVER PROMOTES, APPROVES, DISCARDS OR PUBLISHES ANYTHING, AND IT HOLDS NOTHING THAT COULD. It
// sends no npm credential with any request and spawns no package manager. Promotion needs a second
// factor, and deciding is what a maintainer is for.
//
// "LIVE" MEANS THE PACKUMENT LISTS THE VERSION. `npm install pkg@version` resolves the version out of
// the packument (`GET /<name>`), not out of the version document, and the two propagate
// independently: `install-check.mjs` measured a window where the version document was served and the
// packument did not list it yet. So the packument is the object asked here, with the same headers.
//
// EVERY ANSWER IT CANNOT GET READS AS "NOT LIVE", AND THE DIRECTION IS THE POINT. "Not live" is the
// state the pipeline was already in before this script existed: the run publishes (or stages) as it
// always did, and no GitHub release is created. "Live" is the only answer that creates anything, so
// it takes a positive observation: HTTP 200 and the version present in the packument's `versions`.
//
// Run it by hand against any caller checkout:
//
//   node scripts/promotion.mjs pending --repo . --package @cosyte/x12
//   node scripts/promotion.mjs await   --package @cosyte/x12 --report staged-publish.json --window-minutes 0

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { withFetchTimeout } from './install-check.mjs';
import { findVersionCommit, inspectRelease } from './release-notes.mjs';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const DEFAULT_API_URL = 'https://api.github.com';

// THE WINDOW, AND WHY IT IS A RANGE RATHER THAN ONE NUMBER. The `release` job holds the caller's
// protected environment while it waits, so the wait is bounded twice: by this clamp, and by the
// `timeout-minutes` on the step that runs `await`, which is set above the clamp so the step can
// never be killed by its own timeout while the script is still inside the window it was given.
// `test/promotion.test.mjs` pins that ordering against the workflow.
//
// 120 minutes by default: long enough for a maintainer who is told by the run's own annotation that
// a version is staged to review the bytes and promote it in the same sitting, short enough that a
// release nobody is looking at does not hold a runner and a deployment for the rest of the day. A
// promotion later than that loses nothing, because `pending` finishes the job on the next push.
export const DEFAULT_WINDOW_MINUTES = 120;
export const MAX_WINDOW_MINUTES = 240;
export const DEFAULT_INTERVAL_SECONDS = 30;

// The same per-request bound the other registry readers here use. `globalThis.fetch` has no default
// timeout, and one unbounded request was measured stalling for 300.8s by `install-check.mjs`.
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 3_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encodeName = (name) => name.replaceAll('/', '%2f');

// -- The registry ------------------------------------------------------------------------------------

/**
 * Does the public registry list `name@version` in the packument an install resolves against?
 *
 * THREE-VALUED, and the third value is the one that matters. `yes` is the only answer that lets
 * anything be created. A 404 is the registry ANSWERING that the package does not exist, which is a
 * definite `no`: a package that has never published certainly does not serve this version, and
 * every first release of a package asks this question. Anything else (a 5xx, a transport fault, a
 * body without a `versions` map) is the registry not answering, and is `unknown`.
 *
 * @param {string} registry
 * @param {string} name
 * @param {string} version
 * @param {(url: string, options?: any) => Promise<any>} fetchImpl
 * @returns {Promise<'yes' | 'no' | 'unknown'>}
 */
export async function registryListsVersion(registry, name, version, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${registry}/${encodeName(name)}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
  } catch {
    return 'unknown';
  }
  if (res.status === 404) return 'no';
  if (res.status !== 200) return 'unknown';
  let body;
  try {
    body = await res.json();
  } catch {
    return 'unknown';
  }
  const versions = body?.versions;
  if (!versions || typeof versions !== 'object') return 'unknown';
  return Object.hasOwn(versions, version) ? 'yes' : 'no';
}

/**
 * The same question, retried while the registry does not answer. `yes` and `no` are both the
 * registry speaking and are returned at once.
 */
export async function registryListsVersionWithRetry(
  registry,
  name,
  version,
  fetchImpl,
  { attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_RETRY_DELAY_MS, sleepImpl = sleep } = {},
) {
  let last = /** @type {'yes' | 'no' | 'unknown'} */ ('unknown');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await registryListsVersion(registry, name, version, fetchImpl);
    if (last !== 'unknown') return last;
    if (attempt < attempts) await sleepImpl(delayMs);
  }
  return last;
}

// -- GitHub -----------------------------------------------------------------------------------------

/**
 * Does `tag` already have a GitHub release in `repository`?
 *
 * Read with the automatic token, through the REST endpoint that resolves a release by its tag. 200
 * is a release, 404 is none, and everything else (no token, no repository, a 5xx, a 403) is
 * `unknown`, which creates nothing.
 *
 * @returns {Promise<'present' | 'absent' | 'unknown'>}
 */
export async function githubReleaseStatus({ apiUrl = DEFAULT_API_URL, repository, tag, token, fetchImpl }) {
  if (!repository || !token) return 'unknown';
  let res;
  try {
    res = await fetchImpl(`${apiUrl}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
  } catch {
    return 'unknown';
  }
  if (res.status === 200) return 'present';
  if (res.status === 404) return 'absent';
  return 'unknown';
}

// -- pending: the decision ---------------------------------------------------------------------------

/**
 * @typedef {object} PendingDecision
 * @property {boolean} live      the pending version is already served by the registry
 * @property {boolean} finalize  the `finalize` job should release and dispatch it, at its tag
 * @property {string} version
 * @property {string} sha        the version commit, where package.json became `version`
 * @property {'info' | 'notice' | 'warning'} level
 * @property {string} title      the annotation's title, when there is one
 * @property {string} message
 */

/**
 * How a later run says which run can still publish a version: the version commit's own run, found
 * by its commit. `workflowRef` is `GITHUB_WORKFLOW_REF`, which in a reusable workflow names the
 * CALLER's workflow file, so the command names the file a maintainer would look for.
 *
 * @param {{repository?: string, workflowRef?: string, sha: string}} where
 */
export function rerunCommand({ repository = '', workflowRef = '', sha }) {
  const repo = repository || '<owner>/<repo>';
  const file = /^[^/]+\/[^/]+\/(.+?)@/.exec(workflowRef)?.[1]?.split('/').pop() ?? '';
  const workflow = file ? ` --workflow ${file}` : '';
  return `gh run list --repo ${repo}${workflow} --commit ${sha}, then gh run rerun <run id> --failed --repo ${repo}`;
}

/**
 * What the version `package.json` declares is still owed, and at which commit. PURE, so every arm is
 * testable without a registry, a repository or a token.
 *
 * WHICH VERSION, AND WHY ONLY THIS ONE. The candidate is the version the default branch's
 * `package.json` declares. That is the one version this pipeline would publish from its version
 * commit, so it is exactly the version whose `release` job must be withheld once npm already serves
 * it. npm's `latest` dist-tag was the alternative and is not used: it can name a version this
 * repository's history never released (a hand publish, a moved dist-tag), it says nothing about
 * which commit to tag, and a release cut from it would not be one the notes gate ever derived.
 *
 * THREE SHAPES OF `release`, and each asks only what it needs:
 *
 *   pending, on its version commit   the run that may publish it. The registry first: `no` is a
 *                                    release to publish, `yes` with no GitHub release is a release
 *                                    to finalize. Unchanged from before the tag moved ahead of the
 *                                    publish, a re-run after that tag included.
 *   pending, on a later commit       a run that may not publish it (`release-notes.mjs prepare`
 *                                    withholds that), so `no` is reported with the command that
 *                                    re-runs the version commit's own run, and `yes` with no
 *                                    GitHub release is still finalized from here.
 *   already-released                 tagged, and this run is not on the tagged version commit. The
 *                                    tag no longer proves a publish, so the GitHub release is asked
 *                                    first: present is the ordinary push between releases and the
 *                                    whole cost is that one request. Absent, the tag has to sit on
 *                                    the version commit (`versionCommit`) before anything else is
 *                                    asked, and then the registry says whether the release is owed
 *                                    (finalize) or the publish is (reported, as above).
 *
 * What this costs, stated: a version promoted late AND overtaken by a newer version commit before
 * any run caught up is no longer the version `package.json` declares, so it is not finalized here.
 * That needs two releases in flight at once and is left to a human rather than guessed at.
 *
 * @param {object} facts
 * @param {string} facts.packageName
 * @param {any} facts.release                    `inspectRelease`'s answer for HEAD
 * @param {'yes' | 'no' | 'unknown' | null} facts.registry
 * @param {'present' | 'absent' | 'unknown' | null} facts.githubRelease
 * @param {string | null} [facts.versionCommit]  for an already-released version: the commit that
 *                                               introduced it, or null when none does
 * @param {string} [facts.repository]
 * @param {string} [facts.workflowRef]
 * @returns {PendingDecision}
 */
export function decidePending({ packageName, release, registry, githubRelease, versionCommit = null, repository = '', workflowRef = '' }) {
  const none = { live: false, finalize: false, version: '', sha: '', title: 'Promotion check' };
  if (release?.code === 'already-released' && !release?.isRelease) {
    return decideTagged({ packageName, release, registry, githubRelease, versionCommit, repository, workflowRef });
  }
  if (!release?.isRelease) {
    return {
      ...none,
      level: 'info',
      message: `No release is pending${release?.code ? ` (${release.code})` : ''}, so nothing can be owed a GitHub release.`,
    };
  }
  const { version, sha } = release;
  const coordinate = `${packageName}@${version}`;
  const tag = `v${version}`;
  const ours = !release.head || release.head === sha;
  const owed = { ...none, version, sha };
  if (registry === 'no') {
    if (ours) {
      return { ...owed, level: 'info', message: `${coordinate} is not on the registry yet, so this run has a release to publish.` };
    }
    return {
      ...owed,
      level: 'notice',
      title: 'A version is owed its publish',
      message:
        `${coordinate} is not on the registry, and only the run on its version commit ${sha.slice(0, 7)} ` +
        `publishes it, so this run on ${release.head.slice(0, 7)} does not. If that run did not publish it, ` +
        `re-run it: ${rerunCommand({ repository, workflowRef, sha })}.`,
    };
  }
  if (registry !== 'yes') {
    return {
      ...owed,
      level: 'warning',
      message: ours
        ? `The registry did not say whether ${coordinate} is already live. It is treated as not live, ` +
          'which leaves this run on the publish path it would have taken anyway, and creates nothing.'
        : `The registry did not say whether ${coordinate} is already live. This run is not on its ` +
          `version commit ${sha.slice(0, 7)}, so it publishes nothing either way, and creates nothing.`,
    };
  }
  if (githubRelease === 'absent') {
    return {
      ...owed,
      live: true,
      finalize: true,
      level: 'notice',
      title: 'A published version is owed its GitHub release',
      message:
        `${coordinate} is live on npm and has no ${tag} GitHub release: it was published without its ` +
        'release being cut, which is what a staged version promoted after the run that staged it, or a ' +
        `direct publish whose release step never finished, looks like. Nothing is left to publish, so ` +
        `the release job is withheld, and the finalize job releases ${tag} on ${sha.slice(0, 7)} ` +
        '(tagging that commit first if the tag is missing) and dispatches the docs rebuild.',
    };
  }
  if (githubRelease === 'present') {
    return {
      ...owed,
      live: true,
      level: 'info',
      message:
        `${coordinate} is live on npm and ${tag} already has a GitHub release, so there is nothing ` +
        'to publish and nothing to finalize.',
    };
  }
  return {
    ...owed,
    live: true,
    level: 'warning',
    message:
      `${coordinate} is live on npm, so nothing is left to publish, but whether ${tag} already has a ` +
      'GitHub release could not be read. Nothing is created on a guess; the next run asks again.',
  };
}

/** The already-released shape of `decidePending`: a tagged version this run is not the version commit of. */
function decideTagged({ packageName, release, registry, githubRelease, versionCommit, repository, workflowRef }) {
  const none = { live: false, finalize: false, version: '', sha: '', title: 'Promotion check' };
  const { version, tagSha } = release;
  const coordinate = `${packageName}@${version}`;
  const tag = `v${version}`;
  if (githubRelease === 'present') {
    return { ...none, level: 'info', message: `${tag} has its GitHub release, so ${coordinate} shipped and nothing is owed.` };
  }
  if (githubRelease !== 'absent') {
    return {
      ...none,
      level: 'warning',
      message: `Whether ${tag} has a GitHub release could not be read. Nothing is created on a guess; the next run asks again.`,
    };
  }
  const repo = repository || '<owner>/<repo>';
  if (!versionCommit) {
    return {
      ...none,
      level: 'warning',
      message: `${tag} is tagged and has no GitHub release, but no commit in this history introduces ${version}, so nothing is created.`,
    };
  }
  if (tagSha !== versionCommit) {
    return {
      ...none,
      level: 'warning',
      message:
        `${tag} points at ${String(tagSha).slice(0, 7)}, not at ${versionCommit.slice(0, 7)}, the commit that introduced ` +
        `${version}, and it has no GitHub release. No release is created at a tag on a commit the version did not ` +
        `come from. Delete the tag with a maintainer's own credentials (gh api -X DELETE repos/${repo}/git/refs/tags/${tag}) ` +
        `so the pipeline can make it on ${versionCommit.slice(0, 7)}, or move it there.`,
    };
  }
  const owed = { ...none, version, sha: versionCommit };
  if (registry === 'yes') {
    return {
      ...owed,
      live: true,
      finalize: true,
      level: 'notice',
      title: 'A published version is owed its GitHub release',
      message:
        `${coordinate} is live on npm and ${tag}, on its version commit ${versionCommit.slice(0, 7)}, has no GitHub ` +
        'release. Nothing is left to publish; the finalize job creates the release at that tag and dispatches the docs rebuild.',
    };
  }
  if (registry === 'no') {
    return {
      ...owed,
      level: 'notice',
      title: 'A version is owed its publish',
      message:
        `${tag} is on its version commit ${versionCommit.slice(0, 7)}, but npm does not serve ${coordinate} and there is ` +
        'no GitHub release: it is staged and waiting for a maintainer to promote it, or its publish never happened. ' +
        `Only the run on ${versionCommit.slice(0, 7)} can publish it. If it did not, re-run it: ` +
        `${rerunCommand({ repository, workflowRef, sha: versionCommit })}. If ${version} will never ship, delete the tag ` +
        `with a maintainer's own credentials (gh api -X DELETE repos/${repo}/git/refs/tags/${tag}).`,
    };
  }
  return {
    ...owed,
    level: 'warning',
    message: `${tag} has no GitHub release, and the registry did not say whether ${coordinate} is live. Nothing is created on a guess; the next run asks again.`,
  };
}

// -- await: the decision ----------------------------------------------------------------------------

/**
 * A window in minutes, from whatever the caller passed. A value that is not a number falls back to
 * the default rather than to zero, so a typo never silently turns the wait off; a value above the
 * ceiling is clamped to it, so it can never outrun the step timeout that bounds it.
 *
 * @returns {{minutes: number, note: string | null}}
 */
export function resolveWindow(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { minutes: DEFAULT_WINDOW_MINUTES, note: null };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return {
      minutes: DEFAULT_WINDOW_MINUTES,
      note:
        `promotion-window-minutes ${JSON.stringify(String(raw))} is not a number of minutes, ` +
        `so the default of ${DEFAULT_WINDOW_MINUTES} applies`,
    };
  }
  if (value > MAX_WINDOW_MINUTES) {
    return {
      minutes: MAX_WINDOW_MINUTES,
      note:
        `promotion-window-minutes ${value} is above the ${MAX_WINDOW_MINUTES} minute ceiling, ` +
        `so the wait is ${MAX_WINDOW_MINUTES} minutes`,
    };
  }
  return { minutes: value, note: null };
}

/**
 * Poll until the registry lists the version or the window lapses.
 *
 * The first look is immediate, the last one is at the deadline, and no sleep runs past the deadline,
 * so the whole wait costs at most the window plus one request.
 *
 * @returns {Promise<{live: boolean, polls: number, lastStatus: string, elapsedMs: number}>}
 */
export async function waitForPromotion({
  registry,
  packageName,
  version,
  windowMs,
  intervalMs,
  fetchImpl,
  now = () => Date.now(),
  sleepImpl = sleep,
  onPoll = () => {},
}) {
  const started = now();
  const deadline = started + windowMs;
  let polls = 0;
  let lastStatus;
  for (;;) {
    lastStatus = await registryListsVersion(registry, packageName, version, fetchImpl);
    polls += 1;
    onPoll(lastStatus, polls);
    if (lastStatus === 'yes') return { live: true, polls, lastStatus, elapsedMs: now() - started };
    const remaining = deadline - now();
    if (remaining <= 0) return { live: false, polls, lastStatus, elapsedMs: now() - started };
    await sleepImpl(Math.min(intervalMs, remaining));
  }
}

/** What a run whose window lapsed says, in the summary and in the log. */
export function renderLapse({ packageName, version, minutes }) {
  const tag = `v${version}`;
  return [
    `### ${packageName}@${version} is STAGED, not live`,
    '',
    `Nobody promoted it within the ${minutes} minute window this run waited, so the registry does not serve it`,
    `and this run created no GitHub release and no docs rebuild dispatch. Its \`${tag}\` tag only marks the`,
    'version commit: the version job made it before the stage.',
    '',
    'Nothing is lost by that. Once a maintainer promotes it, the next run of this workflow on the default',
    `branch sees ${packageName}@${version} live with no ${tag} release, skips the publish, and creates the`,
    'release at that tag and dispatches the docs rebuild itself. Until then it stays a version that never',
    'happened.',
  ].join('\n');
}

/** What a run that saw the promotion says. */
export function renderPromoted({ packageName, version }) {
  return [
    `### ${packageName}@${version} was promoted and is live`,
    '',
    `The registry now lists it, so this run goes on to create the GitHub release at \`v${version}\` and`,
    'dispatch the docs rebuild, exactly as a direct publish does.',
  ].join('\n');
}

// -- Entry point ------------------------------------------------------------------------------------

const USAGE =
  'usage:\n' +
  '  promotion.mjs pending --repo <dir> --package <name> [--registry <url>]\n' +
  '  promotion.mjs await   --package <name> [--report <file>] [--window-minutes <n>]\n' +
  '                        [--interval-seconds <n>] [--registry <url>]\n' +
  '  PACKAGE_NAME, STAGED_PUBLISH_REPORT and PROMOTION_WINDOW_MINUTES are read from the environment\n' +
  '  when the flag is absent.\n';

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

function writeOutputs(env, appendFile, outputs) {
  if (!env.GITHUB_OUTPUT) return;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function annotate(out, level, title, message) {
  if (level === 'info') return;
  out(`::${level} title=${title}::${message}\n`);
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
    readFile = readFileSync,
    inspect = inspectRelease,
    findVersion = findVersionCommit,
    now = () => Date.now(),
    sleepImpl = sleep,
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
  if (verb !== 'pending' && verb !== 'await') {
    err(`a verb is required, either \`pending\` or \`await\` (got ${JSON.stringify(verb)})\n${USAGE}`);
    return 2;
  }
  const packageName = options.package || env.PACKAGE_NAME || '';
  if (!packageName) {
    err(`a package name is required\n${USAGE}`);
    return 2;
  }
  const registry = options.registry || env.NPM_REGISTRY || DEFAULT_REGISTRY;
  const timedFetch = withFetchTimeout(fetchImpl, DEFAULT_FETCH_TIMEOUT_MS);

  if (verb === 'pending') {
    return runPending({ options, env, packageName, registry, timedFetch, out, appendFile, inspect, findVersion, sleepImpl });
  }
  return runAwait({ options, env, packageName, registry, timedFetch, out, appendFile, readFile, now, sleepImpl });
}

async function runPending({ options, env, packageName, registry, timedFetch, out, appendFile, inspect, findVersion, sleepImpl }) {
  const repo = path.resolve(options.repo || '.');
  // NOTHING HERE MAY FAIL THE VERSION JOB. That job opens the Version PR and carries the protection
  // gate on every path; a red there for a question about a release that is already permanent would
  // block the ordinary work of the repository. Every fault lands on "not live", which is the
  // pipeline's behaviour before this step existed, and on a tagged version every fault lands on
  // "nothing owed", which is what this step answered for one before the tag moved ahead of the
  // publish.
  let release;
  try {
    release = inspect(repo, packageName);
  } catch (error) {
    release = { isRelease: false, code: 'unclassifiable', reason: error instanceof Error ? error.message : String(error) };
  }
  const askRelease = () =>
    githubReleaseStatus({
      apiUrl: env.GITHUB_API_URL || DEFAULT_API_URL,
      repository: env.GITHUB_REPOSITORY,
      tag: `v${release.version}`,
      token: env.GH_TOKEN,
      fetchImpl: timedFetch,
    });
  const askRegistry = () => registryListsVersionWithRetry(registry, packageName, release.version, timedFetch, { sleepImpl });
  let registryStatus = null;
  let githubRelease = null;
  let versionCommit = null;
  if (release?.isRelease) {
    registryStatus = await askRegistry();
    if (registryStatus === 'yes') githubRelease = await askRelease();
  } else if (release?.code === 'already-released' && release.version) {
    // The ordinary push between releases ends here, after one request: the release exists.
    githubRelease = await askRelease();
    if (githubRelease === 'absent') {
      try {
        versionCommit = findVersion(repo, release.version)?.sha ?? null;
      } catch {
        versionCommit = null;
      }
      if (versionCommit && versionCommit === release.tagSha) registryStatus = await askRegistry();
    }
  }
  const decision = decidePending({
    packageName,
    release,
    registry: registryStatus,
    githubRelease,
    versionCommit,
    repository: env.GITHUB_REPOSITORY,
    workflowRef: env.GITHUB_WORKFLOW_REF,
  });
  out(`${decision.message}\n`);
  annotate(out, decision.level, decision.title, decision.message);
  writeOutputs(env, appendFile, {
    live: String(decision.live),
    finalize: String(decision.finalize),
    version: decision.version,
    sha: decision.sha,
  });
  if (decision.level !== 'info' && decision.title !== 'Promotion check' && env.GITHUB_STEP_SUMMARY) {
    appendFile(env.GITHUB_STEP_SUMMARY, `### ${decision.title}\n\n${decision.message}\n\n`);
  }
  return 0;
}

async function runAwait({ options, env, packageName, registry, timedFetch, out, appendFile, readFile, now, sleepImpl }) {
  const reportPath =
    options.report ||
    env.STAGED_PUBLISH_REPORT ||
    path.join(env.RUNNER_TEMP || env.TMPDIR || '/tmp', 'staged-publish.json');

  // THE VERSION COMES FROM WHAT WAS ACTUALLY STAGED, NOT FROM WHAT THE RUN EXPECTED TO STAGE. The
  // report is written last by `staged-publish.mjs stage`, so its presence means a stage happened in
  // this run, and its absence means the action took its version arm and staged nothing. Waiting for
  // a version nothing staged would hold the environment for the whole window for no reason.
  let record;
  try {
    record = JSON.parse(readFile(reportPath, 'utf8'));
  } catch {
    out(`No staging report at ${reportPath}, so this run staged nothing and there is nothing to wait for.\n`);
    writeOutputs(env, appendFile, { live: 'false', version: '' });
    return 0;
  }
  const version = typeof record?.version === 'string' ? record.version : '';
  if (!version || (record.package && record.package !== packageName)) {
    out(
      `::warning title=Staging report unreadable::${reportPath} does not name a version of ${packageName}, ` +
        'so this run will not wait for a promotion. A later run finalizes it once it is live.\n',
    );
    writeOutputs(env, appendFile, { live: 'false', version: '' });
    return 0;
  }

  const window = resolveWindow(options['window-minutes'] ?? env.PROMOTION_WINDOW_MINUTES);
  if (window.note) out(`::warning title=Promotion window adjusted::${window.note}\n`);
  const intervalSeconds = Number(options['interval-seconds'] ?? DEFAULT_INTERVAL_SECONDS);
  const usableInterval = Number.isFinite(intervalSeconds) && intervalSeconds > 0;
  const intervalMs = (usableInterval ? intervalSeconds : DEFAULT_INTERVAL_SECONDS) * 1000;

  out(
    `Waiting up to ${window.minutes} minute(s) for a maintainer to promote ${packageName}@${version}, ` +
      `asking ${registry} every ${intervalMs / 1000}s. This step reads the public registry with no ` +
      'credential and cannot promote, approve or discard anything.\n',
  );
  const result = await waitForPromotion({
    registry,
    packageName,
    version,
    windowMs: window.minutes * 60_000,
    intervalMs,
    fetchImpl: timedFetch,
    now,
    sleepImpl,
    onPoll: (status, polls) => {
      if (status === 'unknown') out(`poll ${polls}: the registry did not answer; asking again.\n`);
    },
  });

  if (result.live) {
    const rendered = renderPromoted({ packageName, version });
    out(`${rendered}\n`);
    out(`::notice title=Staged version promoted::${packageName}@${version} is live; creating its GitHub release.\n`);
    if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, `${rendered}\n\n`);
    writeOutputs(env, appendFile, { live: 'true', version });
    return 0;
  }
  const rendered = renderLapse({ packageName, version, minutes: window.minutes });
  out(`${rendered}\n`);
  out(
    `::warning title=Staged, not live::${packageName}@${version} was not promoted within ${window.minutes} minute(s). ` +
      'It is staged and NOT live, and has no GitHub release or docs dispatch yet. ' +
      'A later run on the default branch creates both once it is promoted.\n',
  );
  if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, `${rendered}\n\n`);
  writeOutputs(env, appendFile, { live: 'false', version });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  // A crash here must not red a release whose stage already happened, nor a version job that opens
  // Version PRs; it must say plainly that the check did not run. Bad usage still exits 2.
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(
      `::warning title=Promotion check did not complete::${error instanceof Error ? error.message : String(error)}. ` +
        'Nothing was created; a later run asks again.\n',
    );
    process.exitCode = 0;
  }
}
