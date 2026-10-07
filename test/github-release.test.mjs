// Tests for scripts/github-release.mjs, the one implementation behind every GitHub release the
// release workflow cuts: on the direct arm after a publish, on the staged arm once a promotion is
// seen, and in the `finalize` job for a promotion seen by a later run.
//
// WHAT THESE TESTS ARE FOR. The script writes to a public surface, so its ORDER is its guarantee:
// every check that can refuse (the registry serving the version, the notes assert) runs before the
// first `gh` write, and the docs dispatch, which runs last, can never turn a release that happened
// into a red run. And it starts no shell: the caller's pack-docs command runs in the workflow step
// before it, so every process it starts is a fixed binary with an argument vector it built.
//
// Each case drives `main` with a recording `run`, so the assertions are about the sequence of
// commands the script actually issues, not about its source.
// One case runs the real entry point as a child process, with a fake `gh` on PATH and the real
// `release-notes.mjs assert`, so the spawn site and the assert's argv are measured too.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createArgs, dispatchArgs, main, releaseTag, uploadArgs } from '../scripts/github-release.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/github-release.mjs');
const BODY = join(HERE, 'fixtures/hl7-v0.0.2/expected-release-body.md');
const PKG = '@cosyte/hl7';
const VERSION = '0.0.2';
const SHA = 'cd8f29625f6ce4de739ca9e43fac66a46efe118c';
const NOTES = '/tmp/runner/release-notes.md';
const ASSETS = ['dist-artifacts/docs-content.tar.gz', 'dist-artifacts/source.tar.gz'];

/**
 * A recording `run`. `answers` maps a command key to an exit code, or to a list of exit codes
 * consumed one per call; anything unlisted exits 0.
 */
function recorder(answers = {}) {
  const calls = [];
  const queues = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  const keyOf = (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'release') return `release ${args[1]}`;
    if (cmd === 'gh' && args[0] === 'api') return 'dispatch';
    if (args.some((a) => /release-notes\.mjs$/.test(a))) return 'assert';
    return cmd;
  };
  const run = (cmd, args, options = {}) => {
    const key = keyOf(cmd, args);
    calls.push({ key, cmd, args, token: options.env?.GH_TOKEN, quiet: Boolean(options.quiet) });
    const answer = queues[key];
    if (Array.isArray(answer)) return { code: answer.length ? answer.shift() : 0 };
    return { code: answer ?? 0 };
  };
  return { run, calls, keys: () => calls.map((c) => c.key) };
}

/** Drive `main` with captured output and every effect injected. */
async function drive(argv, { answers, env = {}, exists = () => true, fetchImpl } = {}) {
  const rec = recorder(answers);
  let stdout = '';
  let stderr = '';
  const summary = [];
  const code = await main(argv, {
    env: { GH_TOKEN: 'ghs_test_release_token', DISPATCH_TOKEN: 'ghp_test_dispatch_token', GITHUB_STEP_SUMMARY: 'summary', ...env },
    run: rec.run,
    exists,
    readFile: () => 'body',
    appendFile: (_file, text) => summary.push(text),
    fetchImpl,
    sleepImpl: async () => {},
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    toolingDir: '/tooling/scripts',
  });
  return { code, stdout, stderr, summary: summary.join(''), ...rec };
}

const ARGV = ['--package', PKG, '--version', VERSION, '--target', SHA, '--notes', NOTES, '--dispatch-docs', 'true'];

const listing = (...versions) => async () => ({
  status: 200,
  json: async () => ({ versions: Object.fromEntries(versions.map((v) => [v, {}])) }),
});

// -- The argument vectors ------------------------------------------------------------------------------

test('the tag is v<version>, the create carries --target and its assets, and the dispatch uses -f', () => {
  assert.equal(releaseTag('0.1.1'), 'v0.1.1');
  assert.deepEqual(createArgs({ tag: 'v0.1.1', assets: ASSETS, target: SHA, notes: NOTES }), [
    'release', 'create', 'v0.1.1', ...ASSETS, '--target', SHA, '--title', 'v0.1.1', '--notes-file', NOTES,
  ]);
  assert.deepEqual(uploadArgs({ tag: 'v0.1.1', assets: ASSETS }), ['release', 'upload', 'v0.1.1', ...ASSETS, '--clobber']);
  const dispatch = dispatchArgs({ packageName: '@cosyte/synth', version: '0.0.2' });
  assert.deepEqual(dispatch, [
    'api', 'repos/cosyte/docs/dispatches',
    '-f', 'event_type=package-released',
    '-f', 'client_payload[package]=@cosyte/synth',
    '-f', 'client_payload[version]=0.0.2',
  ]);
  assert.ok(!dispatch.includes('-F'), '`-F` reads a value starting with `@` as a file name');
});

// -- The order, which is the guarantee ---------------------------------------------------------------

test('a new release: assert, look, create at the target with the assets, then dispatch', async () => {
  const run = await drive(ARGV, { answers: { 'release view': 1 } });
  assert.equal(run.code, 0);
  assert.deepEqual(run.keys(), ['assert', 'release view', 'release create', 'dispatch']);
  const [asserted, view, create, dispatch] = run.calls;
  assert.deepEqual(asserted.args, [
    '/tooling/scripts/release-notes.mjs', 'assert', '--file', NOTES, '--expect-version', VERSION, '--expect-package', PKG,
  ]);
  assert.equal(asserted.cmd, process.execPath);
  assert.equal(view.quiet, true);
  assert.deepEqual(create.args, createArgs({ tag: 'v0.0.2', assets: ASSETS, target: SHA, notes: NOTES }));
  assert.equal(create.token, 'ghs_test_release_token', 'the release is cut with the automatic token');
  assert.equal(dispatch.token, 'ghp_test_dispatch_token', 'the dispatch authenticates with its own token');
  assert.match(run.stdout, /Dispatched package-released to cosyte\/docs for @cosyte\/hl7@0\.0\.2/);
  // NO SHELL, EVER: only `gh` and this Node, each with a vector the script built.
  for (const call of run.calls) assert.ok(call.cmd === 'gh' || call.cmd === process.execPath, `spawned ${call.cmd}`);
});

test('an existing release is brought up to date, never duplicated, and assets are only uploaded if built', async () => {
  const withAssets = await drive(ARGV);
  assert.deepEqual(withAssets.keys(), ['assert', 'release view', 'release edit', 'release upload', 'dispatch']);
  const none = await drive(ARGV, { exists: () => false });
  assert.deepEqual(none.keys(), ['assert', 'release view', 'release edit', 'dispatch']);
});

test('a create that loses a race to another run updates the release that run made', async () => {
  const run = await drive(ARGV, { answers: { 'release view': [1, 0], 'release create': 1 } });
  assert.equal(run.code, 0);
  assert.deepEqual(run.keys(), ['assert', 'release view', 'release create', 'release view', 'release edit', 'release upload', 'dispatch']);
  assert.match(run.stdout, /created by another run/);
});

test('a create that fails for any other reason fails the run, and nothing is dispatched', async () => {
  const run = await drive(ARGV, { answers: { 'release view': 1, 'release create': 1 } });
  assert.equal(run.code, 1);
  assert.deepEqual(run.keys(), ['assert', 'release view', 'release create', 'release view']);
  assert.match(run.stderr, /GitHub release not created/);
});

test('notes that fail the assert stop everything before the first gh call', async () => {
  const run = await drive(ARGV, { answers: { assert: 1 } });
  assert.equal(run.code, 1);
  assert.deepEqual(run.keys(), ['assert']);
});

// -- The dispatch, which reports and never fails the run -----------------------------------------------

test('a failed dispatch is annotated with the command to finish by hand, and the run stays green', async () => {
  const run = await drive(ARGV, { answers: { 'release view': 1, dispatch: 1 } });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /::error title=Docs rebuild dispatch failed::The release itself SUCCEEDED/);
  assert.match(run.summary, /gh api repos\/cosyte\/docs\/dispatches -f event_type=package-released/);
  assert.match(run.summary, /'client_payload\[package\]=@cosyte\/hl7' -f 'client_payload\[version\]=0\.0\.2'/);
});

test('no dispatch token warns loudly instead of skipping quietly, and dispatch-docs=false skips by request', async () => {
  const tokenless = await drive(ARGV, { env: { DISPATCH_TOKEN: '' } });
  assert.equal(tokenless.code, 0);
  assert.ok(!tokenless.keys().includes('dispatch'));
  assert.match(tokenless.stdout, /::warning title=Docs rebuild not triggered::/);
  assert.match(tokenless.summary, /Docs rebuild NOT triggered/);

  const off = await drive([...ARGV.slice(0, -1), 'false']);
  assert.equal(off.code, 0);
  assert.ok(!off.keys().includes('dispatch'));
  assert.match(off.stdout, /Docs dispatch not requested \(dispatch-docs=false\); skipping\./);
});

// -- --require-live: never a release for a version the registry does not serve -------------------------

test('--require-live creates nothing at all unless the registry lists the version', async () => {
  for (const [label, fetchImpl] of [
    ['not listed', listing('0.0.1')],
    ['registry down', async () => ({ status: 503, json: async () => ({}) })],
    ['transport fault', async () => {
      throw new Error('reset');
    }],
  ]) {
    const run = await drive(['--require-live', ...ARGV], { fetchImpl });
    assert.equal(run.code, 0, `${label}: a version that is not live yet is not a failed run`);
    assert.deepEqual(run.keys(), [], `${label}: nothing may be asserted or written`);
    assert.match(run.stdout, /::warning title=GitHub release not created::/);
    assert.match(run.summary, /v0\.0\.2 NOT created/);
  }
  const live = await drive(['--require-live', ...ARGV], { fetchImpl: listing('0.0.1', '0.0.2'), answers: { 'release view': 1 } });
  assert.equal(live.code, 0);
  assert.deepEqual(live.keys(), ['assert', 'release view', 'release create', 'dispatch']);
});

test('without --require-live the registry is not asked, because the direct arm runs seconds after its publish', async () => {
  let asked = 0;
  const run = await drive(ARGV, {
    fetchImpl: async () => {
      asked += 1;
      return { status: 404, json: async () => ({}) };
    },
  });
  assert.equal(run.code, 0);
  assert.equal(asked, 0);
});

test('bad usage is exit 2 and runs nothing', async () => {
  for (const missing of ['--package', '--version', '--target', '--notes']) {
    const at = ARGV.indexOf(missing);
    const argv = [...ARGV.slice(0, at), ...ARGV.slice(at + 2)];
    const run = await drive(argv, { env: { PACKAGE_NAME: '' } });
    assert.equal(run.code, 2, `${missing} is required`);
    assert.deepEqual(run.keys(), []);
  }
  assert.equal((await drive(['stray'])).code, 2);
});

// -- End to end: the real spawn site, the real assert, a fake gh -----------------------------------------

test('end to end: the real assert passes a real body, and gh is handed exactly the create and the dispatch', async () => {
  const work = mkdtempSync(join(tmpdir(), 'github-release-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  const log = join(work, 'gh.log');
  // The shim records every argv it is handed, one line per call with GH_TOKEN first, and answers
  // `release view` with "not found" so the create path is taken.
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash\nprintf '%s|%s\\n' "$GH_TOKEN" "$*" >> '${log}'\nif [ "$1 $2" = "release view" ]; then exit 1; fi\nexit 0\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const notes = join(work, 'release-notes.md');
  writeFileSync(notes, readFileSync(BODY, 'utf8'));
  // What the caller's pack-docs command leaves behind, in the step before the script.
  mkdirSync(join(work, 'dist-artifacts'));
  for (const asset of ASSETS) writeFileSync(join(work, asset), 'tarball');
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [SCRIPT, '--package', PKG, '--version', VERSION, '--target', SHA, '--notes', notes, '--dispatch-docs', 'true'],
      {
        cwd: work,
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          GH_TOKEN: 'ghs_test_release_token',
          DISPATCH_TOKEN: 'ghp_test_dispatch_token',
          GITHUB_STEP_SUMMARY: join(work, 'summary.md'),
        },
      },
    );
    assert.match(stdout, /carries 10 described change\(s\) and no banned content/, 'the real assert ran');
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(calls, [
      'ghs_test_release_token|release view v0.0.2',
      `ghs_test_release_token|release create v0.0.2 ${ASSETS.join(' ')} --target ${SHA} --title v0.0.2 --notes-file ${notes}`,
      'ghp_test_dispatch_token|api repos/cosyte/docs/dispatches -f event_type=package-released -f client_payload[package]=@cosyte/hl7 -f client_payload[version]=0.0.2',
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('end to end: a body that names another version is refused, and gh is never called', async () => {
  const work = mkdtempSync(join(tmpdir(), 'github-release-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  const log = join(work, 'gh.log');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> '${log}'\nexit 0\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const notes = join(work, 'release-notes.md');
  writeFileSync(notes, readFileSync(BODY, 'utf8'));
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [SCRIPT, '--package', PKG, '--version', '0.0.3', '--target', SHA, '--notes', notes, '--dispatch-docs', 'false'],
        { cwd: work, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'x' } },
      ),
      (error) => error.code === 1,
    );
    assert.equal(existsSync(log), false, 'no gh call may follow a refused body');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the script is reachable where every caller runs it from', () => {
  // Every release-creating step invokes it from the pinned tooling checkout, and it finds the
  // notes assert beside itself rather than in the caller's tree.
  assert.ok(existsSync(SCRIPT));
  assert.ok(existsSync(join(dirname(SCRIPT), 'release-notes.mjs')));
});
