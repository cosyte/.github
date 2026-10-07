// Tests for scripts/promotion.mjs, which finds out whether a staged version has been promoted, and
// for the `release.yml` wiring that turns its answer into a GitHub release: in the staging run when
// the promotion comes inside the window, and in the `finalize` job of a later run when it does not.
//
// WHAT THESE TESTS ARE FOR. Two outcomes are wrong, and they are wrong in opposite directions:
//
//   A RELEASE FOR A VERSION THE REGISTRY DOES NOT SERVE. A GitHub release and a docs rebuild for a
//   staged, unpromoted version announce a version no consumer can install. So the only answer that
//   creates anything is a POSITIVE observation, and every fault reads as "not live".
//   A PROMOTED VERSION THAT NEVER GETS ITS RELEASE. The defect this script exists for: a maintainer
//   promotes after the run stopped watching, and nothing ever tags it, releases it or tells
//   cosyte/docs. So a version that is pending by git and live by npm must reach `finalize`, without
//   the release environment and without any npm credential.
//
// Every decision is a pure function driven by fixtures, the entry point is driven end to end with a
// fake `fetch` and a real git repository, and the workflow is read through the shared reader, so a
// wiring that would start `release` and `finalize` in the same run, or point `finalize` at a version
// nobody saw live, fails here.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_WINDOW_MINUTES,
  decidePending,
  githubReleaseStatus,
  main,
  MAX_WINDOW_MINUTES,
  DEFAULT_INTERVAL_SECONDS,
  registryListsVersion,
  registryListsVersionWithRetry,
  renderLapse,
  resolveWindow,
  waitForPromotion,
} from '../scripts/promotion.mjs';
import { decomment, effectivePermissions, parseWorkflow, readWorkflow } from './workflow-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(HERE, '../.github/workflows/release.yml');
const PKG = '@cosyte/x12';
const REGISTRY = 'https://registry.example.invalid';

// -- A fake registry and a fake GitHub, recording every request -------------------------------------

/** A response shaped like the parts of `fetch`'s that the script reads. */
const respond = (status, body) => ({
  status,
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});

/**
 * `answers` is consumed one per request; the last one repeats. Each is a status plus a body, or an
 * Error to throw as a transport fault.
 */
function fakeFetch(answers) {
  const requests = [];
  let at = 0;
  const impl = async (url, options = {}) => {
    requests.push({ url, headers: options.headers ?? {} });
    const answer = answers[Math.min(at, answers.length - 1)];
    at += 1;
    if (answer instanceof Error) throw answer;
    return respond(answer.status, answer.body);
  };
  return { impl, requests };
}

const listing = (...versions) => ({ status: 200, body: { versions: Object.fromEntries(versions.map((v) => [v, {}])) } });

// -- The registry oracle ------------------------------------------------------------------------------

test('live means the packument lists the version, and nothing else does', async () => {
  const ask = async (answer) => registryListsVersion(REGISTRY, PKG, '0.1.1', fakeFetch([answer]).impl);
  assert.equal(await ask(listing('0.1.0', '0.1.1')), 'yes');
  assert.equal(await ask(listing('0.1.0')), 'no', 'a staged version is not in the packument');
  // A 404 is the registry ANSWERING that the package does not exist, which every first release asks.
  assert.equal(await ask({ status: 404, body: { error: 'Not found' } }), 'no');
  for (const silent of [
    { status: 500, body: {} },
    { status: 401, body: {} },
    { status: 200, body: new Error('not json') },
    { status: 200, body: { name: PKG } },
    new Error('socket hang up'),
  ]) {
    assert.equal(await ask(silent), 'unknown', `${JSON.stringify(silent)} is the registry not answering`);
  }
});

test('the registry is asked anonymously, for the packument an install resolves against', async () => {
  const { impl, requests } = fakeFetch([listing('0.1.1')]);
  await registryListsVersion(REGISTRY, PKG, '0.1.1', impl);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${REGISTRY}/@cosyte%2fx12`, 'the packument, not the version document');
  assert.match(requests[0].headers.accept, /application\/vnd\.npm\.install-v1\+json/);
  for (const name of Object.keys(requests[0].headers)) {
    assert.notEqual(name.toLowerCase(), 'authorization', 'no credential is ever sent to the registry');
  }
});

test('only silence is retried; a yes or a no is the registry speaking', async () => {
  const slept = [];
  const sleepImpl = async (ms) => slept.push(ms);
  const flaky = fakeFetch([{ status: 503, body: {} }, { status: 503, body: {} }, listing('0.1.1')]);
  assert.equal(await registryListsVersionWithRetry(REGISTRY, PKG, '0.1.1', flaky.impl, { sleepImpl }), 'yes');
  assert.equal(flaky.requests.length, 3);
  const no = fakeFetch([listing('0.1.0')]);
  assert.equal(await registryListsVersionWithRetry(REGISTRY, PKG, '0.1.1', no.impl, { sleepImpl }), 'no');
  assert.equal(no.requests.length, 1, 'a definite no is not asked again');
  const down = fakeFetch([{ status: 503, body: {} }]);
  assert.equal(await registryListsVersionWithRetry(REGISTRY, PKG, '0.1.1', down.impl, { sleepImpl, attempts: 3 }), 'unknown');
  assert.equal(down.requests.length, 3);
});

test('a GitHub release is present, absent, or not known, and unknown creates nothing', async () => {
  const ask = async (answer, extra = {}) => {
    const fake = fakeFetch([answer]);
    const status = await githubReleaseStatus({
      apiUrl: 'https://api.example.invalid',
      repository: 'cosyte/x12',
      tag: 'v0.1.1',
      token: 'ghs_test_token_not_a_credential',
      fetchImpl: fake.impl,
      ...extra,
    });
    return { status, requests: fake.requests };
  };
  const present = await ask({ status: 200, body: {} });
  assert.equal(present.status, 'present');
  assert.equal(present.requests[0].url, 'https://api.example.invalid/repos/cosyte/x12/releases/tags/v0.1.1');
  assert.equal(present.requests[0].headers.authorization, 'Bearer ghs_test_token_not_a_credential');
  assert.equal((await ask({ status: 404, body: {} })).status, 'absent');
  assert.equal((await ask({ status: 500, body: {} })).status, 'unknown');
  assert.equal((await ask(new Error('reset'))).status, 'unknown');
  const tokenless = await ask({ status: 404, body: {} }, { token: '' });
  assert.equal(tokenless.status, 'unknown', 'with no token the question is not asked, and not answered');
  assert.equal(tokenless.requests.length, 0);
});

// -- pending: the decision table ---------------------------------------------------------------------

const PENDING = { isRelease: true, version: '0.1.1', sha: 'cd8f29625f6ce4de739ca9e43fac66a46efe118c' };

test('a version live on npm with no GitHub release is the one thing that is finalized', () => {
  const decision = decidePending({ packageName: PKG, release: PENDING, registry: 'yes', githubRelease: 'absent' });
  assert.equal(decision.live, true, 'it is live, so the release job must not start for it');
  assert.equal(decision.finalize, true);
  assert.equal(decision.version, '0.1.1');
  assert.equal(decision.sha, PENDING.sha, 'at the commit where package.json became that version');
  assert.equal(decision.level, 'notice');
  assert.match(decision.message, /promoted after the run that staged it/);
  assert.match(decision.message, /release job is withheld/);
});

test('every other answer finalizes nothing, and only "live" withholds the release job', () => {
  const rows = [
    // [release, registry, githubRelease, live, finalize, level]
    [{ isRelease: false, code: 'already-released' }, null, null, false, false, 'info'],
    [{ isRelease: false, code: 'never-versioned' }, null, null, false, false, 'info'],
    [PENDING, 'no', null, false, false, 'info'],
    [PENDING, 'unknown', null, false, false, 'warning'],
    [PENDING, 'yes', 'present', true, false, 'info'],
    [PENDING, 'yes', 'unknown', true, false, 'warning'],
  ];
  for (const [release, registry, githubRelease, live, finalize, level] of rows) {
    const decision = decidePending({ packageName: PKG, release, registry, githubRelease });
    const label = JSON.stringify({ release: release.code ?? 'pending', registry, githubRelease });
    assert.equal(decision.live, live, `${label}: live`);
    assert.equal(decision.finalize, finalize, `${label}: finalize`);
    assert.equal(decision.level, level, `${label}: level`);
  }
  // A registry that did not answer is NOT live: the run stays on the path it would have taken anyway.
  assert.match(
    decidePending({ packageName: PKG, release: PENDING, registry: 'unknown', githubRelease: null }).message,
    /treated as not live/,
  );
});

// -- await: the window and the poll ------------------------------------------------------------------

test('the window defaults, clamps to its ceiling, and never reads a typo as zero', () => {
  assert.deepEqual(resolveWindow(undefined), { minutes: DEFAULT_WINDOW_MINUTES, note: null });
  assert.deepEqual(resolveWindow(''), { minutes: DEFAULT_WINDOW_MINUTES, note: null });
  assert.deepEqual(resolveWindow('45'), { minutes: 45, note: null });
  assert.deepEqual(resolveWindow('0'), { minutes: 0, note: null }, '0 looks once and does not wait');
  assert.equal(resolveWindow('9999').minutes, MAX_WINDOW_MINUTES);
  assert.match(resolveWindow('9999').note, /ceiling/);
  for (const bad of ['two hours', '-5', 'NaN']) {
    assert.equal(resolveWindow(bad).minutes, DEFAULT_WINDOW_MINUTES, `${bad} is not a window`);
    assert.ok(resolveWindow(bad).note);
  }
  assert.equal(DEFAULT_WINDOW_MINUTES, 120);
  assert.equal(MAX_WINDOW_MINUTES, 240);
});

/** A clock that only moves when the script sleeps, so a 120 minute window runs in microseconds. */
function fakeClock() {
  let now = 1_000_000;
  const sleeps = [];
  return {
    now: () => now,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

test('the wait ends the moment the registry lists the version', async () => {
  const clock = fakeClock();
  const fake = fakeFetch([listing('0.1.0'), listing('0.1.0'), listing('0.1.0', '0.1.1')]);
  const result = await waitForPromotion({
    registry: REGISTRY,
    packageName: PKG,
    version: '0.1.1',
    windowMs: 120 * 60_000,
    intervalMs: 30_000,
    fetchImpl: fake.impl,
    ...clock,
  });
  assert.equal(result.live, true);
  assert.equal(result.polls, 3);
  assert.deepEqual(clock.sleeps, [30_000, 30_000]);
});

test('a lapsed window stops at the deadline, never sleeps past it, and reports not live', async () => {
  const clock = fakeClock();
  const fake = fakeFetch([listing('0.1.0')]);
  const windowMs = 95_000;
  const result = await waitForPromotion({
    registry: REGISTRY,
    packageName: PKG,
    version: '0.1.1',
    windowMs,
    intervalMs: 30_000,
    fetchImpl: fake.impl,
    ...clock,
  });
  assert.equal(result.live, false);
  assert.deepEqual(clock.sleeps, [30_000, 30_000, 30_000, 5_000], 'the last sleep is cut to the deadline');
  assert.equal(result.polls, 5, 'one look at the start, one at the deadline, and one per interval between');
  assert.equal(clock.sleeps.reduce((a, b) => a + b, 0), windowMs);

  const once = fakeClock();
  const zero = await waitForPromotion({
    registry: REGISTRY,
    packageName: PKG,
    version: '0.1.1',
    windowMs: 0,
    intervalMs: 30_000,
    fetchImpl: fakeFetch([listing('0.1.0')]).impl,
    ...once,
  });
  assert.equal(zero.polls, 1, 'a zero window looks once');
  assert.deepEqual(once.sleeps, []);
});

test('a lapse says plainly that the version is staged, not live, and what finishes it', () => {
  const text = renderLapse({ packageName: PKG, version: '0.1.1', minutes: 120 });
  assert.match(text, /STAGED, not live/);
  assert.match(text, /no `v0\.1\.1` tag, no GitHub release and no docs rebuild dispatch/);
  assert.match(text, /next run of this workflow on the default\s+branch/);
});

// -- The entry point, end to end ---------------------------------------------------------------------

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Run `main` with captured output, a GITHUB_OUTPUT file and a summary file, and read them back. */
async function runMain(argv, { env = {}, fetchImpl, ...io } = {}) {
  const dir = tempDir('promotion-io-');
  const outputFile = join(dir, 'output');
  const summaryFile = join(dir, 'summary');
  writeFileSync(outputFile, '');
  writeFileSync(summaryFile, '');
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    env: { GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile, ...env },
    fetchImpl,
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    sleepImpl: async () => {},
    ...io,
  });
  const outputs = Object.fromEntries(
    readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const summary = readFileSync(summaryFile, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { code, stdout, stderr, outputs, summary };
}

/** A repository whose history is a released version, then a version commit consuming a changeset. */
function makeReleasedRepo({ tagged = false } = {}) {
  const dir = tempDir('promotion-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write('package.json', `${JSON.stringify({ name: PKG, version: '0.1.0' }, null, 2)}\n`);
  write('.changeset/brave-fox.md', `---\n"${PKG}": patch\n---\n\nAccept a trailing segment terminator on a 999 acknowledgment.\n`);
  git('add', '-A');
  git('commit', '-qm', 'feat: the work');
  git('tag', 'v0.1.0');
  write('package.json', `${JSON.stringify({ name: PKG, version: '0.1.1' }, null, 2)}\n`);
  rmSync(join(dir, '.changeset/brave-fox.md'));
  git('add', '-A');
  git('commit', '-qm', 'Version Packages');
  const sha = git('rev-parse', 'HEAD').trim();
  // A later commit with no version change: the push that catches up is usually not the version commit.
  write('README.md', 'later work\n');
  git('add', '-A');
  git('commit', '-qm', 'docs: later work');
  if (tagged) git('tag', 'v0.1.1');
  return { dir, sha };
}

const GITHUB = { GH_TOKEN: 'ghs_test_token_not_a_credential', GITHUB_REPOSITORY: 'cosyte/x12', GITHUB_API_URL: 'https://api.example.invalid' };

test('pending: a promoted version with no release finalizes at its version commit, from a later HEAD', async () => {
  const { dir, sha } = makeReleasedRepo();
  const fake = fakeFetch([listing('0.1.0', '0.1.1'), { status: 404, body: {} }]);
  const run = await runMain(['pending', '--repo', dir, '--package', PKG, '--registry', REGISTRY], {
    env: GITHUB,
    fetchImpl: fake.impl,
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.outputs, { live: 'true', finalize: 'true', version: '0.1.1', sha });
  assert.match(run.stdout, /::notice title=A promoted version is owed its GitHub release::/);
  assert.match(run.summary, /promoted after the run that staged it/);
  assert.deepEqual(
    fake.requests.map((r) => r.url),
    [`${REGISTRY}/@cosyte%2fx12`, 'https://api.example.invalid/repos/cosyte/x12/releases/tags/v0.1.1'],
  );
  assert.equal(fake.requests[0].headers.authorization, undefined, 'the registry is read anonymously');
  rmSync(dir, { recursive: true, force: true });
});

test('pending: an unpromoted version is a release to publish, and nothing is finalized', async () => {
  const { dir, sha } = makeReleasedRepo();
  const fake = fakeFetch([listing('0.1.0')]);
  const run = await runMain(['pending', '--repo', dir, '--package', PKG, '--registry', REGISTRY], {
    env: GITHUB,
    fetchImpl: fake.impl,
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.outputs, { live: 'false', finalize: 'false', version: '0.1.1', sha });
  assert.equal(fake.requests.length, 1, 'GitHub is not asked about a version that is not live');
  assert.equal(run.summary, '');
  rmSync(dir, { recursive: true, force: true });
});

test('pending: a tagged version asks nobody anything, and a fault anywhere is "not live"', async () => {
  const tagged = makeReleasedRepo({ tagged: true });
  const quiet = fakeFetch([listing('0.1.1')]);
  const run = await runMain(['pending', '--repo', tagged.dir, '--package', PKG, '--registry', REGISTRY], {
    env: GITHUB,
    fetchImpl: quiet.impl,
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.outputs, { live: 'false', finalize: 'false', version: '', sha: '' });
  assert.equal(quiet.requests.length, 0, 'nothing pending means no network at all');
  rmSync(tagged.dir, { recursive: true, force: true });

  const { dir } = makeReleasedRepo();
  const down = await runMain(['pending', '--repo', dir, '--package', PKG, '--registry', REGISTRY], {
    env: GITHUB,
    fetchImpl: fakeFetch([{ status: 503, body: {} }]).impl,
  });
  assert.equal(down.code, 0, 'the version job must not go red over this question');
  assert.equal(down.outputs.live, 'false');
  assert.equal(down.outputs.finalize, 'false');
  assert.match(down.stdout, /::warning/);

  const thrown = await runMain(['pending', '--repo', dir, '--package', PKG], {
    env: GITHUB,
    fetchImpl: fakeFetch([listing('0.1.1')]).impl,
    inspect: () => {
      throw new Error('unclassifiable commit');
    },
  });
  assert.equal(thrown.code, 0);
  assert.equal(thrown.outputs.live, 'false');
  rmSync(dir, { recursive: true, force: true });
});

test('await: no staging report means nothing was staged, and nothing is waited for', async () => {
  const fake = fakeFetch([listing('0.1.1')]);
  const run = await runMain(['await', '--package', PKG, '--report', '/nonexistent/staged-publish.json'], {
    fetchImpl: fake.impl,
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.outputs, { live: 'false', version: '' });
  assert.equal(fake.requests.length, 0);
});

function stagedReport(version = '0.1.1', packageName = PKG) {
  const dir = tempDir('promotion-report-');
  const file = join(dir, 'staged-publish.json');
  writeFileSync(file, `${JSON.stringify({ package: packageName, version, tool: 'npm', stageId: null })}\n`);
  return { dir, file };
}

test('await: a promotion inside the window hands the release step the version that was staged', async () => {
  const report = stagedReport();
  const clock = fakeClock();
  const fake = fakeFetch([listing('0.1.0'), listing('0.1.0', '0.1.1')]);
  const run = await runMain(['await', '--package', PKG, '--report', report.file, '--registry', REGISTRY], {
    env: { PROMOTION_WINDOW_MINUTES: '120' },
    fetchImpl: fake.impl,
    ...clock,
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.outputs, { live: 'true', version: '0.1.1' });
  assert.match(run.summary, /was promoted and is live/);
  for (const request of fake.requests) assert.equal(request.headers.authorization, undefined);
  rmSync(report.dir, { recursive: true, force: true });
});

test('await: a lapsed window is green, says STAGED not live, and leaves the release to a later run', async () => {
  const report = stagedReport();
  const clock = fakeClock();
  const run = await runMain(['await', '--package', PKG, '--report', report.file, '--registry', REGISTRY], {
    env: { PROMOTION_WINDOW_MINUTES: '2' },
    fetchImpl: fakeFetch([listing('0.1.0')]).impl,
    ...clock,
  });
  assert.equal(run.code, 0, 'an unpromoted version is not a failed run');
  assert.deepEqual(run.outputs, { live: 'false', version: '0.1.1' });
  assert.match(run.stdout, /::warning title=Staged, not live::/);
  assert.match(run.stdout, /A later run on the default branch creates all three once it is promoted/);
  assert.match(run.summary, /is STAGED, not live/);
  assert.equal(clock.sleeps.reduce((a, b) => a + b, 0), 2 * 60_000, 'the window is the one the caller passed');
  rmSync(report.dir, { recursive: true, force: true });
});

test('await: a report for another package is not waited on', async () => {
  const report = stagedReport('0.1.1', '@cosyte/hl7');
  const fake = fakeFetch([listing('0.1.1')]);
  const run = await runMain(['await', '--package', PKG, '--report', report.file], { fetchImpl: fake.impl });
  assert.equal(run.code, 0);
  assert.deepEqual(run.outputs, { live: 'false', version: '' });
  assert.equal(fake.requests.length, 0);
  rmSync(report.dir, { recursive: true, force: true });
});

test('bad usage is exit 2, distinct from every answer', async () => {
  assert.equal((await runMain([])).code, 2);
  assert.equal((await runMain(['promote', '--package', PKG])).code, 2, 'there is no verb that promotes');
  assert.equal((await runMain(['pending'], { env: { PACKAGE_NAME: '' } })).code, 2);
  assert.equal((await runMain(['await', '--package'])).code, 2);
});

// -- The wiring, read through the shared reader -------------------------------------------------------

test('the staging run waits, bounded three times over, in the right order', () => {
  const workflow = parseWorkflow(readWorkflow(WORKFLOW, readFileSync));
  const release = workflow.byId.release;
  const wait = release.steps.find((step) => step.fields.id === 'promotion');
  assert.ok(wait, 'the release job must keep the waiting step');
  assert.equal(wait.fields.if, "${{ steps.publish-floor.outputs.mode == 'staged' }}");
  assert.match(wait.body, /node \.cosyte-release-tooling\/scripts\/promotion\.mjs await/);
  assert.equal(wait.env.PROMOTION_WINDOW_MINUTES, '${{ inputs.promotion-window-minutes }}');
  assert.equal(wait.env.STAGED_PUBLISH_REPORT, '${{ runner.temp }}/staged-publish.json');

  // WINDOW < STEP < JOB. The script's deadline must fire before the step is killed, so the outputs
  // are written and a lapse is green; the step must end before the job does. The margin covers the
  // one poll that can start at the deadline (a 30 second request bound) and the poll interval.
  const stepMinutes = Number(wait.fields['timeout-minutes']);
  const jobMinutes = Number(release.keys['timeout-minutes']);
  assert.ok(stepMinutes >= MAX_WINDOW_MINUTES + 1 + DEFAULT_INTERVAL_SECONDS / 60, `step timeout ${stepMinutes} must clear the ${MAX_WINDOW_MINUTES} minute ceiling`);
  assert.ok(jobMinutes > stepMinutes + 60, `job timeout ${jobMinutes} must clear the wait and the rest of the job`);

  // NO CREDENTIAL ON THE WAIT. It reads a public registry and writes outputs.
  assert.doesNotMatch(wait.body, /secrets\s*[.[]/i, 'the waiting step must be handed no secret at all');

  // The input's default is the script's default, so the two cannot describe different windows.
  const preamble = decomment(readFileSync(WORKFLOW, 'utf8')).join('\n');
  const declared = /promotion-window-minutes:\s*\n\s*description: [^\n]*\n\s*type: number\n\s*default: (\d+)/.exec(preamble);
  assert.ok(declared, 'the input must be declared as a number with a default');
  assert.equal(Number(declared[1]), DEFAULT_WINDOW_MINUTES);
});

test('the version job asks "already live?" only when a release is pending, and only narrows is-release', () => {
  const workflow = parseWorkflow(readWorkflow(WORKFLOW, readFileSync));
  const version = workflow.byId.version;
  const notes = version.steps.find((step) => step.fields.id === 'notes');
  const promoted = version.steps.find((step) => step.fields.id === 'promoted');
  assert.ok(notes && promoted);
  assert.ok(promoted.index > notes.index, 'it reads the notes gate\'s answer, so it runs after it');
  assert.equal(promoted.fields.if, "${{ steps.notes.outputs.is-release == 'true' }}");
  assert.match(promoted.body, /promotion\.mjs pending --repo \. --package "\$PACKAGE_NAME"/);
  assert.equal(promoted.env.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
  assert.deepEqual(Object.keys(promoted.env).sort(), ['GH_TOKEN', 'PACKAGE_NAME']);

  assert.deepEqual(
    {
      'is-release': version.blocks.outputs['is-release'],
      finalize: version.blocks.outputs.finalize,
      'finalize-version': version.blocks.outputs['finalize-version'],
      'finalize-sha': version.blocks.outputs['finalize-sha'],
    },
    {
      'is-release': "${{ steps.notes.outputs.is-release == 'true' && steps.promoted.outputs.live != 'true' }}",
      finalize: '${{ steps.promoted.outputs.finalize }}',
      'finalize-version': '${{ steps.promoted.outputs.version }}',
      'finalize-sha': '${{ steps.promoted.outputs.sha }}',
    },
  );
});

test('finalize and release never start in the same run, and finalize cannot publish', () => {
  const text = readWorkflow(WORKFLOW, readFileSync);
  const workflow = parseWorkflow(text);
  const { release, finalize } = workflow.byId;
  assert.equal(release.keys.if, "${{ needs.version.outputs.is-release == 'true' }}");
  assert.equal(
    finalize.keys.if,
    "${{ !cancelled() && needs.version.outputs.is-release != 'true' && needs.version.outputs.finalize == 'true' }}",
    'finalize is pinned whole: the negation of release\'s own condition, and an output only a live version sets',
  );
  assert.equal(finalize.keys.needs, 'version');
  assert.equal(finalize.keys.environment, undefined, 'no environment: the irreversible act already happened');
  assert.deepEqual(effectivePermissions(text, finalize), { contents: 'write' });

  for (const step of finalize.steps) {
    assert.doesNotMatch(step.body, /changesets\/action|pnpm run release|changeset publish|npm publish|pnpm publish|stage approve|stage publish/);
    assert.doesNotMatch(step.body, /NPM_TOKEN|NODE_AUTH_TOKEN/);
    assert.equal(step.with['registry-url'], undefined, 'no registry credential file in finalize');
  }

  // At the release commit, with the body derived there and the release cut there.
  const checkout = finalize.steps.find((step) => /uses: actions\/checkout@/.test(step.body) && step.with.repository === undefined);
  assert.equal(checkout.with.ref, '${{ needs.version.outputs.finalize-sha }}');
  assert.equal(checkout.with['fetch-depth'], '0', 'the notes gate refuses a shallow clone');
  assert.equal(checkout.with['persist-credentials'], 'false');
  const cut = finalize.steps.find((step) => /github-release\.mjs/.test(step.body));
  assert.match(cut.body, /github-release\.mjs --require-live/, 'a release is only cut for a version seen live');
  assert.match(cut.body, /--target "\$FINALIZE_SHA"/);
  assert.match(cut.body, /--version "\$FINALIZE_VERSION"/);
  assert.match(cut.body, /"\$head" != "\$FINALIZE_SHA"/, 'the tag cannot point at one commit while the assets came from another');
  assert.equal(cut.env.FINALIZE_SHA, '${{ needs.version.outputs.finalize-sha }}');
  assert.equal(cut.env.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
  assert.equal(cut.env.DISPATCH_TOKEN, '${{ secrets.DOCS_REPO_DISPATCH_TOKEN }}');
  assert.ok(Number(finalize.keys['timeout-minutes']) > 0, 'finalize must be bounded');
});

test('all three release-creating sites run the one script from the pinned tooling checkout', () => {
  const workflow = parseWorkflow(readWorkflow(WORKFLOW, readFileSync));
  const sites = workflow.jobs.flatMap((job) => job.steps).filter((step) => /github-release\.mjs/.test(step.body));
  assert.equal(sites.length, 3);
  for (const step of sites) {
    assert.match(step.body, /node \.cosyte-release-tooling\/scripts\/github-release\.mjs/);
    assert.match(step.body, /--pack-docs-cmd "\$PACK_DOCS_CMD" --dispatch-docs "\$DISPATCH_DOCS"/);
    assert.equal(step.env.PACK_DOCS_CMD, '${{ inputs.pack-docs-cmd }}');
    assert.equal(step.env.DISPATCH_DOCS, '${{ inputs.dispatch-docs }}');
  }
  // Exactly one site skips the registry check, and it is the direct arm, seconds after its own publish.
  const unchecked = sites.filter((step) => !/github-release\.mjs --require-live/.test(step.body));
  assert.deepEqual(unchecked.map((step) => `${step.job}: ${step.label}`), ['release: Publish the GitHub release + dispatch docs rebuild']);
});
