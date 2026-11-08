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
//
// AND A RE-RUN IS SAFE AGAINST AN IMMUTABLE RELEASE. GitHub refuses to modify an asset of a published
// immutable release, so a release that already exists has its assets compared with the ones this run
// built rather than replaced: the same content is left alone, different content fails the run, and
// only an asset it does not carry yet is uploaded. The comparison reads real `tar -czf` output here,
// packed twice at different times, because that is what makes the bytes differ on a real re-run.
// One case runs the real entry point as a child process, with a fake `gh` on PATH and the real
// `release-notes.mjs assert`, so the spawn site and the assert's argv are measured too.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assetNamesArgs,
  compareAssets,
  createArgs,
  dispatchArgs,
  downloadArgs,
  main,
  releaseTag,
  tarEntries,
  uploadArgs,
} from '../scripts/github-release.mjs';

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
  // The listing of the assets a release already carries is the one call whose output is read. Its
  // answer is the text gh prints, or `{ code, stdout }`; by default the release carries none.
  const capture = (cmd, args, options = {}) => {
    calls.push({ key: 'release assets', cmd, args, token: options.env?.GH_TOKEN, quiet: false });
    const answer = queues['release assets'];
    if (typeof answer === 'string') return { code: 0, stdout: answer };
    return { code: answer?.code ?? 0, stdout: answer?.stdout ?? '' };
  };
  return { run, capture, calls, keys: () => calls.map((c) => c.key) };
}

const CARRIES_BOTH = 'docs-content.tar.gz\nsource.tar.gz\n';

const API = 'https://api.example.invalid';
const TAG_AT_SHA = { status: 200, body: { ref: `refs/tags/v${VERSION}`, object: { type: 'commit', sha: SHA } } };

/**
 * One `fetch` for both readers the script has: the GitHub API, which answers where `v<version>`
 * points (`tag`, by default at SHA, or a function of the URL), and the registry, which `registry`
 * answers when `--require-live` asks it. A request to anything else fails the test.
 */
function routed({ registry, tag = TAG_AT_SHA } = {}) {
  const requests = [];
  const impl = async (url, options = {}) => {
    requests.push({ url, headers: options.headers ?? {} });
    if (url.startsWith(`${API}/repos/`)) {
      const answer = typeof tag === 'function' ? tag(url) : tag;
      if (answer instanceof Error) throw answer;
      return { status: answer.status, json: async () => answer.body };
    }
    if (registry) return registry(url, options);
    throw new Error(`the script asked ${url}, which nothing here answers`);
  };
  return { impl, requests };
}

/**
 * Drive `main` with captured output and every effect injected. `bytes` answers a read of an asset,
 * the one this run built (`dist-artifacts/<name>`) or the one downloaded from the release
 * (`<temp dir>/<name>`); by default both read the same, so an attached asset is the same content.
 * `fetchImpl` answers the registry; `tag` answers the tag lookup (see `routed`).
 */
async function drive(argv, { answers, env = {}, exists = () => true, fetchImpl, tag, bytes = () => Buffer.from('tarball') } = {}) {
  const rec = recorder(answers);
  const fetched = routed({ registry: fetchImpl, ...(tag === undefined ? {} : { tag }) });
  let stdout = '';
  let stderr = '';
  const summary = [];
  const made = [];
  const removed = [];
  const code = await main(argv, {
    env: {
      GH_TOKEN: 'ghs_test_release_token',
      DISPATCH_TOKEN: 'ghp_test_dispatch_token',
      GITHUB_STEP_SUMMARY: 'summary',
      GITHUB_REPOSITORY: 'cosyte/hl7',
      GITHUB_API_URL: API,
      ...env,
    },
    run: rec.run,
    capture: rec.capture,
    exists,
    readBytes: bytes,
    makeTempDir: () => {
      const dir = `/tmp/asset-${made.length}`;
      made.push(dir);
      return dir;
    },
    removeDir: (dir) => removed.push(dir),
    readFile: () => 'body',
    appendFile: (_file, text) => summary.push(text),
    fetchImpl: fetched.impl,
    sleepImpl: async () => {},
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    toolingDir: '/tooling/scripts',
  });
  return { code, stdout, stderr, summary: summary.join(''), made, removed, requests: fetched.requests, ...rec };
}

const ARGV = ['--package', PKG, '--version', VERSION, '--target', SHA, '--notes', NOTES, '--dispatch-docs', 'true'];

const listing = (...versions) => async () => ({
  status: 200,
  json: async () => ({ versions: Object.fromEntries(versions.map((v) => [v, {}])) }),
});

// -- The argument vectors ------------------------------------------------------------------------------

test('the tag is v<version>, the create carries --verify-tag and its assets and NO --target, and the dispatch uses -f', () => {
  assert.equal(releaseTag('0.1.1'), 'v0.1.1');
  // `--target` sends `target_commitish`, which GitHub refuses a GITHUB_TOKEN even for a tag that
  // already exists once the default branch's workflow files have moved on (measured 2026-11-08).
  // `--verify-tag` releases the tag the version job made, and refuses rather than make one.
  assert.deepEqual(createArgs({ tag: 'v0.1.1', assets: ASSETS, notes: NOTES }), [
    'release', 'create', 'v0.1.1', ...ASSETS, '--verify-tag', '--title', 'v0.1.1', '--notes-file', NOTES,
  ]);
  assert.ok(!createArgs({ tag: 'v0.1.1', assets: ASSETS, target: SHA, notes: NOTES }).includes('--target'), 'a target handed in is not sent');
  // No `--clobber`: an immutable release refuses to replace an asset, so an attached one is compared
  // instead, and only an asset the release does not carry yet is ever handed to the upload.
  assert.deepEqual(uploadArgs({ tag: 'v0.1.1', assets: ASSETS }), ['release', 'upload', 'v0.1.1', ...ASSETS]);
  assert.deepEqual(assetNamesArgs({ tag: 'v0.1.1' }), ['release', 'view', 'v0.1.1', '--json', 'assets', '--jq', '.assets[].name']);
  assert.deepEqual(downloadArgs({ tag: 'v0.1.1', name: 'source.tar.gz', dir: '/tmp/d' }), [
    'release', 'download', 'v0.1.1', '--pattern', 'source.tar.gz', '--dir', '/tmp/d',
  ]);
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

test('a new release: assert, read the tag, look, create at the tag with the assets, then dispatch', async () => {
  const run = await drive(ARGV, { answers: { 'release view': 1 } });
  assert.equal(run.code, 0);
  assert.deepEqual(run.keys(), ['assert', 'release view', 'release create', 'dispatch']);
  const [asserted, view, create, dispatch] = run.calls;
  assert.deepEqual(asserted.args, [
    '/tooling/scripts/release-notes.mjs', 'assert', '--file', NOTES, '--expect-version', VERSION, '--expect-package', PKG,
  ]);
  assert.equal(asserted.cmd, process.execPath);
  assert.equal(view.quiet, true);
  assert.deepEqual(create.args, createArgs({ tag: 'v0.0.2', assets: ASSETS, notes: NOTES }));
  assert.deepEqual(
    run.requests.map((request) => request.url),
    [`${API}/repos/cosyte/hl7/git/ref/tags/v0.0.2`],
    'where the tag points is read once, through the API, before the first write',
  );
  assert.equal(run.requests[0].headers.authorization, 'Bearer ghs_test_release_token');
  assert.match(run.stdout, new RegExp(`v0\\.0\\.2 points at ${SHA}, the commit this run released`));
  assert.equal(create.token, 'ghs_test_release_token', 'the release is cut with the automatic token');
  assert.equal(dispatch.token, 'ghp_test_dispatch_token', 'the dispatch authenticates with its own token');
  assert.match(run.stdout, /Dispatched package-released to cosyte\/docs for @cosyte\/hl7@0\.0\.2/);
  // NO SHELL, EVER: only `gh` and this Node, each with a vector the script built.
  for (const call of run.calls) assert.ok(call.cmd === 'gh' || call.cmd === process.execPath, `spawned ${call.cmd}`);
});

test('an existing release is brought up to date, never duplicated, and assets are only uploaded if built', async () => {
  const withAssets = await drive(ARGV);
  assert.deepEqual(withAssets.keys(), ['assert', 'release view', 'release edit', 'release assets', 'release upload', 'dispatch']);
  const none = await drive(ARGV, { exists: () => false });
  assert.deepEqual(none.keys(), ['assert', 'release view', 'release edit', 'dispatch']);
});

// -- A re-run against a release that already carries its assets --------------------------------------

test('a re-run against a release carrying the same assets compares them, uploads nothing, and passes', async () => {
  const run = await drive(ARGV, { answers: { 'release assets': CARRIES_BOTH } });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.keys(), ['assert', 'release view', 'release edit', 'release assets', 'release download', 'release download', 'dispatch']);
  const downloads = run.calls.filter((call) => call.key === 'release download');
  assert.deepEqual(downloads.map((call) => call.args), [
    downloadArgs({ tag: 'v0.0.2', name: 'docs-content.tar.gz', dir: '/tmp/asset-0' }),
    downloadArgs({ tag: 'v0.0.2', name: 'source.tar.gz', dir: '/tmp/asset-1' }),
  ]);
  assert.match(run.stdout, /v0\.0\.2 already carries docs-content\.tar\.gz with the same content \(byte for byte\); leaving it as it is/);
  assert.deepEqual(run.removed, run.made, 'every directory an asset was downloaded into is removed');
  for (const call of run.calls) assert.ok(!call.args.includes('--clobber'), `${call.key} asks gh to replace an asset`);
});

test('an attached asset with different content fails the run with what differs, and nothing follows', async () => {
  const run = await drive(ARGV, {
    answers: { 'release assets': CARRIES_BOTH },
    bytes: (file) => Buffer.from(file.startsWith('/tmp/asset-') ? 'what the release carries' : 'what this run built'),
  });
  assert.equal(run.code, 1);
  assert.deepEqual(run.keys(), ['assert', 'release view', 'release edit', 'release assets', 'release download']);
  assert.match(
    run.stderr,
    /^::error title=Release asset differs::v0\.0\.2 already carries docs-content\.tar\.gz, and the docs-content\.tar\.gz this run built for @cosyte\/hl7@0\.0\.2 has different content: the bytes differ, and the two cannot both be read as gzipped tars/m,
  );
  assert.match(run.stderr, /A published release's assets cannot be replaced, so the attached one is left as it is/);
  assert.deepEqual(run.removed, run.made, 'the download directory is removed on the failing path too');
});

test('only an asset the release does not carry yet is uploaded', async () => {
  const run = await drive(ARGV, { answers: { 'release assets': 'docs-content.tar.gz\n' } });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.keys(), ['assert', 'release view', 'release edit', 'release assets', 'release download', 'release upload', 'dispatch']);
  const upload = run.calls.find((call) => call.key === 'release upload');
  assert.deepEqual(upload.args, uploadArgs({ tag: 'v0.0.2', assets: ['dist-artifacts/source.tar.gz'] }));
});

test('an upload the release refuses fails the run and says an immutable release takes no new asset', async () => {
  const run = await drive(ARGV, { answers: { 'release upload': 1 } });
  assert.equal(run.code, 1);
  assert.ok(!run.keys().includes('dispatch'), 'nothing is dispatched after a failed release');
  assert.match(run.stderr, /::error title=GitHub release asset not attached::gh could not attach docs-content\.tar\.gz and source\.tar\.gz/);
  assert.match(run.stderr, /An immutable release takes no new asset once it is published/);
});

test('a listing, a download or an edit gh cannot do fails the run, naming which', async () => {
  const listing = await drive(ARGV, { answers: { 'release assets': { code: 1 } } });
  assert.equal(listing.code, 1);
  assert.match(listing.stderr, /::error title=GitHub release assets not read::/);
  assert.ok(!listing.keys().includes('release upload'), 'nothing is uploaded over assets it could not list');

  const download = await drive(ARGV, { answers: { 'release assets': CARRIES_BOTH, 'release download': 1 } });
  assert.equal(download.code, 1);
  assert.match(download.stderr, /::error title=GitHub release asset not read::gh could not download docs-content\.tar\.gz/);
  assert.deepEqual(download.removed, download.made);

  const edit = await drive(ARGV, { answers: { 'release edit': 1 } });
  assert.equal(edit.code, 1);
  assert.deepEqual(edit.keys(), ['assert', 'release view', 'release edit']);
  assert.match(edit.stderr, /::error title=GitHub release not updated::gh could not update the body/);
});

// -- The comparison, over what `tar -czf` really writes ------------------------------------------------

/** A docs tree with a nested file, a path too long for a tar header's name field, and a link. */
function docsTree() {
  const root = mkdtempSync(join(tmpdir(), 'github-release-tree-'));
  const docs = join(root, 'docs-content');
  const deep = join(docs, 'guides', 'a-directory-name-long-enough-that-the-whole-path-overflows-the-hundred-byte-name-field');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(docs, 'intro.md'), '# Intro\n');
  writeFileSync(join(docs, 'sidebars.json'), '{"docs":["intro"]}\n');
  writeFileSync(join(deep, 'an-equally-long-file-name-for-the-gnu-long-name-record.md'), 'Deep.\n');
  symlinkSync('intro.md', join(docs, 'start.md'));
  return { root, docs };
}

/** `tar -czf` the tree, as a caller's pack-docs command does, with whatever extra flags are given. */
function pack(docs, out, ...flags) {
  const done = spawnSync('tar', [...flags, '-czf', out, '-C', docs, '.'], { encoding: 'utf8' });
  assert.equal(done.status, 0, `tar failed: ${done.stderr}`);
  return readFileSync(out);
}

test('tarEntries reads what tar -czf writes, GNU and POSIX, long names and links included', () => {
  const { root, docs } = docsTree();
  try {
    for (const format of ['gnu', 'posix']) {
      const entries = tarEntries(pack(docs, join(root, `${format}.tar.gz`), `--format=${format}`));
      const long = [...entries.keys()].find((key) => key.endsWith('gnu-long-name-record.md'));
      assert.ok(long && long.length > 100, `${format}: the long path is read whole`);
      assert.equal(entries.get(long).data.toString(), 'Deep.\n');
      assert.equal(entries.get('intro.md').data.toString(), '# Intro\n');
      assert.deepEqual(entries.get('start.md'), { kind: 'symbolic link', target: 'intro.md' });
      assert.ok(![...entries.keys()].some((key) => key.startsWith('./') || key === ''), `${format}: paths are normalized`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same files packed at another time are the same content, though every byte may differ', () => {
  const { root, docs } = docsTree();
  try {
    const first = pack(docs, join(root, 'first.tar.gz'));
    const later = pack(docs, join(root, 'later.tar.gz'), '--mtime=2001-02-03 04:05:06', '--owner=0', '--group=0');
    assert.ok(!first.equals(later), 'the two archives must differ in their bytes, or this proves nothing');
    const verdict = compareAssets(first, later);
    assert.equal(verdict.same, true, verdict.how);
    // Four: `intro.md`, `sidebars.json`, the deep file and the link. Directories are implied by them.
    assert.match(verdict.how, /^the same 4 file\(s\) with the same bytes, packed at another time$/);
    assert.deepEqual(compareAssets(first, first), { same: true, how: 'byte for byte' });
    assert.equal(compareAssets(first, pack(docs, join(root, 'pax.tar.gz'), '--format=posix')).same, true, 'a format change is not a content change');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a changed, added or removed file is different content, and the verdict names it', () => {
  const { root, docs } = docsTree();
  try {
    const before = pack(docs, join(root, 'before.tar.gz'));
    writeFileSync(join(docs, 'intro.md'), '# Intro, rewritten\n');
    const changed = compareAssets(before, pack(docs, join(root, 'changed.tar.gz')));
    assert.deepEqual(changed, { same: false, how: '`intro.md` has different content' });

    writeFileSync(join(docs, 'intro.md'), '# Intro\n');
    writeFileSync(join(docs, 'extra.md'), 'Extra.\n');
    const added = compareAssets(pack(docs, join(root, 'added.tar.gz')), before);
    assert.deepEqual(added, { same: false, how: "`extra.md` is in this run's and not in the attached one" });
    const removed = compareAssets(before, pack(docs, join(root, 'removed-from-attached.tar.gz')));
    assert.deepEqual(removed, { same: false, how: "`extra.md` is in the attached one and not in this run's" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bytes that are not a gzipped tar are never called the same unless they are identical', () => {
  const verdict = compareAssets(Buffer.from('one'), Buffer.from('two'));
  assert.equal(verdict.same, false);
  assert.match(verdict.how, /^the bytes differ, and the two cannot both be read as gzipped tars/);
  assert.deepEqual(compareAssets(Buffer.from('one'), Buffer.from('one')), { same: true, how: 'byte for byte' });
  // A gzip whose tar is cut short is refused rather than read as the entries before the cut.
  const { root, docs } = docsTree();
  try {
    const whole = pack(docs, join(root, 'whole.tar.gz'));
    const tar = spawnSync('gzip', ['-dc'], { input: whole }).stdout;
    const cut = spawnSync('gzip', ['-c'], { input: tar.subarray(0, 1024) }).stdout;
    assert.throws(() => tarEntries(cut), /runs past the end of the archive|ends without its end-of-archive marker/);
    assert.equal(compareAssets(whole, cut).same, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a create that loses a race to another run updates the release that run made', async () => {
  const run = await drive(ARGV, { answers: { 'release view': [1, 0], 'release create': 1 } });
  assert.equal(run.code, 0);
  assert.deepEqual(run.keys(), [
    'assert', 'release view', 'release create', 'release view', 'release edit', 'release assets', 'release upload', 'dispatch',
  ]);
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

// -- The tag: already made, on the commit this run released, or nothing is written ---------------------

test('a missing, misplaced or unreadable tag creates nothing, and gh is never asked to write', async () => {
  const cases = [
    ['missing', { status: 404, body: { message: 'Not Found' } }, /v0\.0\.2 does not exist\. The version job makes it on the version commit before anything is published/],
    [
      'on another commit',
      { status: 200, body: { object: { type: 'commit', sha: 'f'.repeat(40) } } },
      new RegExp(`v0\\.0\\.2 points at ${'f'.repeat(40)}, not at ${SHA}, the commit this run released`),
    ],
    ['unreadable', { status: 502, body: {} }, /whether v0\.0\.2 exists could not be read \(GitHub answered 502\)/],
    ['a transport fault', new Error('socket hang up'), /could not be read \(the request failed \(socket hang up\)\)/],
  ];
  for (const [label, tag, why] of cases) {
    const run = await drive(ARGV, { tag, answers: { 'release view': 1 } });
    assert.equal(run.code, 1, `${label}: a release at no tag, or at a tag elsewhere, is a failed run`);
    assert.deepEqual(run.keys(), ['assert'], `${label}: nothing after the notes assert, and no gh call at all`);
    assert.match(run.stderr, /::error title=GitHub release not created::No release was created for @cosyte\/hl7@0\.0\.2: /);
    assert.match(run.stderr, why, label);
  }
  const missing = await drive(ARGV, { tag: { status: 404, body: {} } });
  assert.match(
    missing.stderr,
    new RegExp(`gh api repos/cosyte/hl7/git/refs -f ref=refs/tags/v0\\.0\\.2 -f sha=${SHA}`),
    'a missing tag names the command that makes it on the right commit',
  );
});

test('an annotated tag is followed to its commit', async () => {
  const run = await drive(ARGV, {
    answers: { 'release view': 1 },
    tag: (url) =>
      url.endsWith('/git/ref/tags/v0.0.2')
        ? { status: 200, body: { object: { type: 'tag', sha: 'a'.repeat(40) } } }
        : { status: 200, body: { object: { type: 'commit', sha: SHA } } },
  });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.requests.map((request) => request.url), [
    `${API}/repos/cosyte/hl7/git/ref/tags/v0.0.2`,
    `${API}/repos/cosyte/hl7/git/tags/${'a'.repeat(40)}`,
  ]);
});

test('the repository is required, because the tag is read from it', async () => {
  const run = await drive(ARGV, { env: { GITHUB_REPOSITORY: '' } });
  assert.equal(run.code, 2);
  assert.deepEqual(run.keys(), []);
  const named = await drive([...ARGV, '--repository', 'cosyte/hl7'], { env: { GITHUB_REPOSITORY: '' }, answers: { 'release view': 1 } });
  assert.equal(named.code, 0, named.stderr);
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

/**
 * A local stand-in for the GitHub API, so the child process reads where the tag points through its
 * real `fetch`: it answers the one lookup the script makes with `v0.0.2` at SHA, and 404s the rest.
 * Hands `fn` the environment the child needs and the list of paths it was asked for.
 */
async function withTagApi(fn) {
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.url);
    const found = req.url === `/repos/cosyte/hl7/git/ref/tags/v${VERSION}`;
    res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(found ? TAG_AT_SHA.body : { message: 'Not Found' }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    return await fn({ GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_REPOSITORY: 'cosyte/hl7' }, asked);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

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
    await withTagApi(async (api, asked) => {
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
            ...api,
          },
        },
      );
      assert.match(stdout, /carries 10 described change\(s\) and no banned content/, 'the real assert ran');
      assert.deepEqual(asked, ['/repos/cosyte/hl7/git/ref/tags/v0.0.2'], 'the tag is read through the real fetch');
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      assert.deepEqual(calls, [
        'ghs_test_release_token|release view v0.0.2',
        `ghs_test_release_token|release create v0.0.2 ${ASSETS.join(' ')} --verify-tag --title v0.0.2 --notes-file ${notes}`,
        'ghp_test_dispatch_token|api repos/cosyte/docs/dispatches -f event_type=package-released -f client_payload[package]=@cosyte/hl7 -f client_payload[version]=0.0.2',
      ]);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('end to end: a re-run against a release carrying its assets compares them through the real spawn sites', async () => {
  for (const scenario of ['same files, packed earlier', 'a file changed since']) {
    const work = mkdtempSync(join(tmpdir(), 'github-release-'));
    const { root, docs } = docsTree();
    const bin = join(work, 'bin');
    const carried = join(work, 'carried');
    mkdirSync(bin);
    mkdirSync(carried);
    mkdirSync(join(work, 'dist-artifacts'));
    const log = join(work, 'gh.log');
    // What the first run attached: the same tree, packed at another time.
    for (const name of ['docs-content.tar.gz', 'source.tar.gz']) pack(docs, join(carried, name), '--mtime=2001-02-03 04:05:06');
    if (scenario === 'a file changed since') writeFileSync(join(docs, 'intro.md'), '# Intro, rewritten\n');
    // What this run's pack-docs command leaves behind.
    for (const name of ['docs-content.tar.gz', 'source.tar.gz']) pack(docs, join(work, 'dist-artifacts', name));
    // The release exists and carries both assets; a download copies the attached one into --dir.
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" >> '${log}'`,
        `if [ "$1 $2" = "release view" ] && [ "$4" = "--json" ]; then printf 'docs-content.tar.gz\\nsource.tar.gz\\n'; exit 0; fi`,
        `if [ "$1 $2" = "release download" ]; then cp '${carried}'/"$5" "$7/$5"; exit $?; fi`,
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const notes = join(work, 'release-notes.md');
    writeFileSync(notes, readFileSync(BODY, 'utf8'));
    try {
      const child = await withTagApi((api) =>
        execFileAsync(
          process.execPath,
          [SCRIPT, '--package', PKG, '--version', VERSION, '--target', SHA, '--notes', notes, '--dispatch-docs', 'false'],
          { cwd: work, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'x', ...api } },
        ).then(
          (result) => ({ code: 0, ...result }),
          (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
        ),
      );
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      assert.ok(!calls.some((call) => call.startsWith('release upload')), `${scenario}: nothing may be uploaded over a carried asset`);
      if (scenario === 'same files, packed earlier') {
        assert.equal(child.code, 0, child.stderr);
        assert.deepEqual(calls, [
          'release view v0.0.2',
          `release edit v0.0.2 --title v0.0.2 --notes-file ${notes}`,
          'release view v0.0.2 --json assets --jq .assets[].name',
          `release download v0.0.2 --pattern docs-content.tar.gz --dir ${calls[3]?.split(' --dir ')[1]}`,
          `release download v0.0.2 --pattern source.tar.gz --dir ${calls[4]?.split(' --dir ')[1]}`,
        ]);
        assert.match(child.stdout, /already carries docs-content\.tar\.gz with the same content \(the same 4 file\(s\) with the same bytes, packed at another time\)/);
        for (const call of calls.slice(3)) assert.equal(existsSync(call.split(' --dir ')[1]), false, 'the download directory is removed');
      } else {
        assert.equal(child.code, 1);
        assert.match(child.stderr, /::error title=Release asset differs::v0\.0\.2 already carries docs-content\.tar\.gz/);
        assert.match(child.stderr, /`intro\.md` has different content/);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
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
    await withTagApi(async (api, asked) => {
      await assert.rejects(
        execFileAsync(
          process.execPath,
          [SCRIPT, '--package', PKG, '--version', '0.0.3', '--target', SHA, '--notes', notes, '--dispatch-docs', 'false'],
          { cwd: work, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'x', ...api } },
        ),
        (error) => error.code === 1,
      );
      assert.equal(existsSync(log), false, 'no gh call may follow a refused body');
      assert.deepEqual(asked, [], 'and the tag is not even read');
    });
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
