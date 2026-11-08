// Tests for scripts/release-tag.mjs, and the reproduction of what stranded `@cosyte/transform@0.1.4`
// twice on 2026-11-08: a pull request that changed workflow files merged to `main` while the release
// of the version commit before it was in flight.
//
// WHAT WENT WRONG, MEASURED. GitHub refuses a GITHUB_TOKEN any ref at a commit whose
// `.github/workflows/` differ from the default branch's (403 "Resource not accessible by
// integration"), and that token can never hold the `workflows` permission the write needs. The
// release job made `v0.1.4` through `gh release create --target <version commit>` minutes after the
// merge and after npm had the version; the workflow change had landed in between, so it was refused.
// The next run's `finalize` made the same call and was refused the same way, and so would every run
// after it. `scripts/release-tag.mjs` has the full table measured that day.
//
// WHAT THESE TESTS HOLD THE FIX TO. A fake GitHub below enforces exactly that measured rule, reading
// the workflow tree of each commit out of a real git repository, and the real scripts and the real
// `release.yml` expressions are driven through it:
//
//   the old calls are refused by it, so it is the rule that stranded transform 0.1.4, not a friendlier
//   one;
//   main moving between the version job and the release job, or between the release and a later
//   run's finalize, still ends with the tag on the version commit and the release at that tag;
//   main moving before the tag can be made publishes nothing, and says exactly what to run;
//   a run on a later commit never publishes the version, and never tags any commit but the version
//   commit.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main as githubRelease } from '../scripts/github-release.mjs';
import { main as promotion } from '../scripts/promotion.mjs';
import {
  createTagRef,
  describeTag,
  ensureTag,
  main as releaseTag,
  oneLine,
  resolveTag,
  tagCommand,
  workflowFilesSince,
} from '../scripts/release-tag.mjs';
import { parseWorkflow, readWorkflow } from './workflow-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(HERE, '../.github/workflows/release.yml');
const NOTES_SCRIPT = resolve(HERE, '../scripts/release-notes.mjs');
const API = 'https://api.example.invalid';
const PKG = '@cosyte/transform';
const REPOSITORY = 'cosyte/transform';
const SHA = 'c8267c1102af900f8c0f5d590833fe063a21827f';
const OTHER = '602d82be125c0294a73f710579d756b69059a07f';

const respond = (status, body) => ({ status, json: async () => body });

/** A `fetch` answering from a list, in order, recording every request. */
function scripted(answers) {
  const requests = [];
  let at = 0;
  const impl = async (url, options = {}) => {
    requests.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body });
    const answer = answers[Math.min(at, answers.length - 1)];
    at += 1;
    if (answer instanceof Error) throw answer;
    return respond(answer.status, answer.body);
  };
  return { impl, requests };
}

const ARGS = { apiUrl: API, repository: REPOSITORY, token: 'ghs_test_token_not_a_credential' };
const FORBIDDEN = { status: 403, body: { message: 'Resource not accessible by integration' } };

// -- resolveTag: where a tag points, read through the API --------------------------------------------

test('resolveTag reads the exact ref, follows an annotated tag, and calls everything else unknown', async () => {
  const lightweight = scripted([{ status: 200, body: { object: { type: 'commit', sha: SHA } } }]);
  assert.deepEqual(await resolveTag({ ...ARGS, tag: 'v0.1.4', fetchImpl: lightweight.impl }), { status: 'present', commit: SHA });
  assert.equal(lightweight.requests[0].url, `${API}/repos/${REPOSITORY}/git/ref/tags/v0.1.4`, 'the exact-ref endpoint, never a prefix match');
  assert.equal(lightweight.requests[0].headers.authorization, `Bearer ${ARGS.token}`);

  const annotated = scripted([
    { status: 200, body: { object: { type: 'tag', sha: 'a'.repeat(40) } } },
    { status: 200, body: { object: { type: 'commit', sha: SHA } } },
  ]);
  assert.deepEqual(await resolveTag({ ...ARGS, tag: 'v0.1.4', fetchImpl: annotated.impl }), { status: 'present', commit: SHA });
  assert.equal(annotated.requests[1].url, `${API}/repos/${REPOSITORY}/git/tags/${'a'.repeat(40)}`);

  assert.deepEqual(await resolveTag({ ...ARGS, tag: 'v0.1.4', fetchImpl: scripted([{ status: 404, body: {} }]).impl }), { status: 'absent' });
  for (const [label, answer] of [
    ['a 5xx', { status: 502, body: {} }],
    ['a 403', FORBIDDEN],
    ['a transport fault', new Error('reset')],
    ['a ref that is not a commit', { status: 200, body: { object: { type: 'tree', sha: SHA } } }],
  ]) {
    assert.equal((await resolveTag({ ...ARGS, tag: 'v0.1.4', fetchImpl: scripted([answer]).impl })).status, 'unknown', label);
  }
  const tokenless = scripted([{ status: 200, body: {} }]);
  assert.equal((await resolveTag({ ...ARGS, token: '', tag: 'v0.1.4', fetchImpl: tokenless.impl })).status, 'unknown');
  assert.equal(tokenless.requests.length, 0, 'with no token nothing is asked');
});

// -- createTagRef: the one write -----------------------------------------------------------------------

test('createTagRef posts a lightweight tag and tells a refusal from a race from a failure', async () => {
  const made = scripted([{ status: 201, body: {} }]);
  assert.equal((await createTagRef({ ...ARGS, tag: 'v0.1.4', sha: SHA, fetchImpl: made.impl })).status, 'created');
  assert.equal(made.requests[0].method, 'POST');
  assert.equal(made.requests[0].url, `${API}/repos/${REPOSITORY}/git/refs`);
  assert.deepEqual(JSON.parse(made.requests[0].body), { ref: 'refs/tags/v0.1.4', sha: SHA });

  const raced = await createTagRef({ ...ARGS, tag: 'v0.1.4', sha: SHA, fetchImpl: scripted([{ status: 422, body: { message: 'Reference already exists' } }]).impl });
  assert.equal(raced.status, 'exists');
  const refused = await createTagRef({ ...ARGS, tag: 'v0.1.4', sha: SHA, fetchImpl: scripted([FORBIDDEN]).impl });
  assert.deepEqual(refused, { status: 'refused', httpStatus: 403, detail: 'Resource not accessible by integration' });
  const bad = await createTagRef({ ...ARGS, tag: 'v0.1.4', sha: SHA, fetchImpl: scripted([{ status: 422, body: { message: 'Object does not exist' } }]).impl });
  assert.equal(bad.status, 'failed', 'a 422 that is not "already exists" is a failure, not a race');
  assert.equal((await createTagRef({ ...ARGS, tag: 'v0.1.4', sha: SHA, fetchImpl: scripted([new Error('reset')]).impl })).status, 'failed');
});

// -- ensureTag: find it there, make it there, or say why not --------------------------------------------

const tagAt = (sha) => ({ status: 200, body: { object: { type: 'commit', sha } } });
const NONE = { status: 404, body: {} };

test('ensureTag writes only when the tag is missing, and never moves a tag that points elsewhere', async () => {
  const there = scripted([tagAt(SHA)]);
  assert.deepEqual(await ensureTag({ ...ARGS, version: '0.1.4', sha: SHA, fetchImpl: there.impl }), {
    ready: true,
    outcome: 'exists',
    tag: 'v0.1.4',
    commit: SHA,
  });
  assert.equal(there.requests.length, 1, 'a tag already there is read, not written');

  const elsewhere = scripted([tagAt(OTHER)]);
  const moved = await ensureTag({ ...ARGS, version: '0.1.4', sha: SHA, fetchImpl: elsewhere.impl });
  assert.deepEqual([moved.ready, moved.outcome, moved.commit], [false, 'elsewhere', OTHER]);
  assert.ok(elsewhere.requests.every((request) => request.method === 'GET'), 'a tag on another commit is left exactly as it is');

  const unread = await ensureTag({ ...ARGS, version: '0.1.4', sha: SHA, fetchImpl: scripted([{ status: 500, body: {} }]).impl });
  assert.deepEqual([unread.ready, unread.outcome], [false, 'unreadable'], 'nothing is written on a guess');

  const created = scripted([NONE, { status: 201, body: {} }]);
  assert.deepEqual(await ensureTag({ ...ARGS, version: '0.1.4', sha: SHA, fetchImpl: created.impl }), {
    ready: true,
    outcome: 'created',
    tag: 'v0.1.4',
    commit: SHA,
  });

  const racedOurs = await ensureTag({
    ...ARGS,
    version: '0.1.4',
    sha: SHA,
    fetchImpl: scripted([NONE, { status: 422, body: { message: 'Reference already exists' } }, tagAt(SHA)]).impl,
  });
  assert.deepEqual([racedOurs.ready, racedOurs.outcome], [true, 'raced'], 'another run made the same tag: ready');
  const racedOther = await ensureTag({
    ...ARGS,
    version: '0.1.4',
    sha: SHA,
    fetchImpl: scripted([NONE, { status: 422, body: { message: 'Reference already exists' } }, tagAt(OTHER)]).impl,
  });
  assert.deepEqual([racedOther.ready, racedOther.outcome], [false, 'elsewhere']);
});

test('a refused tag says which workflow files moved, and the command that makes it by hand', async () => {
  const refused = scripted([
    NONE,
    FORBIDDEN,
    { status: 200, body: { default_branch: 'main' } },
    {
      status: 200,
      body: {
        files: [
          { filename: '.github/workflows/ci.yml' },
          { filename: 'AGENTS.md' },
          { filename: '.github/workflows/no-internal-refs.yml' },
        ],
      },
    },
  ]);
  const result = await ensureTag({ ...ARGS, version: '0.1.4', sha: SHA, fetchImpl: refused.impl });
  assert.deepEqual(
    [result.ready, result.outcome, result.httpStatus, result.files],
    [false, 'refused', 403, ['.github/workflows/ci.yml', '.github/workflows/no-internal-refs.yml']],
  );
  assert.equal(refused.requests[3].url, `${API}/repos/${REPOSITORY}/compare/${SHA}...main`);

  const said = describeTag(result, { packageName: PKG, version: '0.1.4', sha: SHA, repository: REPOSITORY });
  assert.equal(said.level, 'error');
  assert.equal(said.command, `gh api repos/cosyte/transform/git/refs -f ref=refs/tags/v0.1.4 -f sha=${SHA}`);
  assert.equal(said.command, tagCommand({ repository: REPOSITORY, tag: 'v0.1.4', sha: SHA }));
  assert.match(said.reason, /^GitHub refused to create v0\.1\.4 at the version commit c8267c1: the default branch's workflow files have changed since c8267c1 \(\.github\/workflows\/ci\.yml, \.github\/workflows\/no-internal-refs\.yml\)/);
  assert.match(said.reason, /Nothing has been published\.$/);
  assert.match(said.message, /then re-run this run's failed jobs/);
  assert.ok(!said.reason.includes('\n'), 'the reason is one line: it becomes a step output');

  // A 403 with no workflow file moved is reported as what GitHub said, not as the workflow rule.
  const other = describeTag(
    { ready: false, outcome: 'refused', tag: 'v0.1.4', httpStatus: 403, detail: 'API rate limit exceeded', files: [] },
    { packageName: PKG, version: '0.1.4', sha: SHA, repository: REPOSITORY },
  );
  assert.match(other.reason, /GitHub answered 403 \(API rate limit exceeded\), and no workflow file differs between c8267c1 and the default branch/);
});

test('text from GitHub or a file name cannot break a step output or start a workflow command', () => {
  assert.equal(oneLine('a\nb\r\n::error::x'), 'a b ::error::x');
  assert.equal(oneLine('x'.repeat(400)).length, 300);
  const said = describeTag(
    { ready: false, outcome: 'refused', tag: 'v0.1.4', httpStatus: 403, detail: '', files: ['.github/workflows/a\n::warning::b.yml'] },
    { packageName: PKG, version: '0.1.4', sha: SHA, repository: REPOSITORY },
  );
  assert.ok(!said.reason.includes('\n') && !said.message.includes('\n'));
});

test('workflowFilesSince is best effort: anything it cannot read is null, never a throw', async () => {
  assert.equal(await workflowFilesSince({ ...ARGS, sha: SHA, fetchImpl: scripted([{ status: 404, body: {} }]).impl }), null);
  assert.equal(await workflowFilesSince({ ...ARGS, sha: SHA, fetchImpl: scripted([new Error('reset')]).impl }), null);
  assert.equal(
    await workflowFilesSince({ ...ARGS, sha: SHA, fetchImpl: scripted([{ status: 200, body: { default_branch: 'main' } }, { status: 500, body: {} }]).impl }),
    null,
  );
});

// -- The entry point -------------------------------------------------------------------------------------

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Read a GITHUB_OUTPUT file into an object. */
function outputsOf(file) {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

/** Run one of the scripts' `main` with captured output and a fresh GITHUB_OUTPUT and summary. */
async function runScript(entry, argv, { env = {}, ...io } = {}) {
  const dir = tempDir('release-tag-io-');
  const outputFile = join(dir, 'output');
  const summaryFile = join(dir, 'summary');
  writeFileSync(outputFile, '');
  writeFileSync(summaryFile, '');
  let stdout = '';
  let stderr = '';
  const code = await entry(argv, {
    env: { GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile, ...env },
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    sleepImpl: async () => {},
    ...io,
  });
  const result = { code, stdout, stderr, outputs: outputsOf(outputFile), summary: readFileSync(summaryFile, 'utf8') };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test('ensure: bad usage is exit 2, and a version this pipeline does not tag is refused, not guessed', async () => {
  assert.equal((await runScript(releaseTag, [])).code, 2);
  assert.equal((await runScript(releaseTag, ['make', '--package', PKG], { env: { GITHUB_REPOSITORY: REPOSITORY } })).code, 2);
  assert.equal((await runScript(releaseTag, ['ensure', '--package', PKG], { env: { GITHUB_REPOSITORY: '' } })).code, 2);
  assert.equal((await runScript(releaseTag, ['ensure'], { env: { GITHUB_REPOSITORY: REPOSITORY, PACKAGE_NAME: '' } })).code, 2);

  const odd = await runScript(releaseTag, ['ensure', '--package', PKG], {
    env: { GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: 'x' },
    inspect: () => ({ isRelease: true, version: '0.1.4\n::set-output name=ready::true', sha: SHA }),
    fetchImpl: async () => {
      throw new Error('nothing may be asked for a version that is not one');
    },
  });
  assert.equal(odd.code, 0);
  assert.equal(odd.outputs.ready, 'false');
  assert.match(odd.stdout, /::error title=Release not tagged::package\.json declares/);
  assert.ok(!Object.keys(odd.outputs).includes('set-output name'), 'a version string cannot write an output of its own');

  const orphan = await runScript(releaseTag, ['ensure', '--package', PKG], {
    env: { GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: 'x' },
    inspect: () => ({ isRelease: false, code: 'already-released', version: '0.1.4' }),
    findVersion: () => null,
  });
  assert.deepEqual([orphan.outputs.ready, orphan.outputs.version], ['false', '0.1.4']);
  assert.match(orphan.outputs.reason, /no version commit to tag/);
});

// ===========================================================================================================
// THE REPRODUCTION. A caller repository, a fake GitHub that enforces the measured rule, and the real
// scripts and `release.yml` expressions between them.
// ===========================================================================================================

/**
 * A caller repository shaped like transform on 2026-11-08: `0.1.3` released and tagged, a changeset,
 * and the version commit for `0.1.4` that consumed it, with `main` at the version commit.
 */
function makeCaller() {
  const dir = tempDir('release-tag-caller-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('package.json', `${JSON.stringify({ name: PKG, version: '0.1.3' }, null, 2)}\n`);
  write('.github/workflows/ci.yml', 'name: CI\non: push\njobs: {}\n');
  write('.github/workflows/no-internal-refs.yml', 'name: refs\non: push\njobs: {}\n');
  write('.changeset/README.md', 'changesets live here\n');
  git('add', '-A');
  git('commit', '-qm', 'feat: 0.1.3');
  git('tag', 'v0.1.3');
  write('.changeset/tidy-rxo.md', `---\n"${PKG}": patch\n---\n\nMap the RXO dosage onto every MedicationRequest the order mapping emits.\n`);
  git('add', '-A');
  git('commit', '-qm', 'fix: map the RXO dosage');
  write('package.json', `${JSON.stringify({ name: PKG, version: '0.1.4' }, null, 2)}\n`);
  rmSync(join(dir, '.changeset/tidy-rxo.md'));
  git('add', '-A');
  git('commit', '-qm', 'chore(release): version packages (#84)');
  const version = git('rev-parse', 'HEAD');

  /** A pull request that changes two workflow files merges: `main` moves on, the way transform#83 did. */
  const moveMainWithAWorkflowChange = () => {
    git('checkout', '-q', 'main');
    write('.github/workflows/ci.yml', 'name: CI\non: push\njobs: { lint: {} }\n');
    write('.github/workflows/no-internal-refs.yml', 'name: refs\non: [push, pull_request]\njobs: {}\n');
    write('AGENTS.md', 'what still binds\n');
    git('add', '-A');
    git('commit', '-qm', 'docs: remove the agent notes and keep what still binds (#83)');
    return git('rev-parse', 'HEAD');
  };
  /** A run's checkout: HEAD at the commit the run was triggered by. */
  const checkout = (sha) => git('checkout', '-q', '--detach', sha);
  return { dir, git, version, moveMainWithAWorkflowChange, checkout };
}

/**
 * GitHub, as far as a release needs it, with the rule measured on 2026-11-08 and nothing friendlier:
 * a GITHUB_TOKEN gets a 403 for any ref, and for any release that sends `target_commitish`, at a commit
 * whose `.github/workflows/` tree differs from the default branch tip's. A release at an existing tag
 * with no target is allowed whatever the default branch has become. Workflow trees are read out of the
 * caller's real git repository, so "differs" is exactly what git says.
 */
class FakeGitHub {
  constructor(caller) {
    this.caller = caller;
    this.tags = new Map(caller.git('tag', '--list').split('\n').filter(Boolean).map((tag) => [tag, caller.git('rev-parse', `${tag}^{commit}`)]));
    /** @type {Map<string, {assets: string[]}>} */
    this.releases = new Map([['v0.1.3', { assets: [] }]]);
    this.npm = new Set(['0.1.3']);
    this.refused = [];
    this.dispatched = [];
  }
  tip() {
    return this.caller.git('rev-parse', 'refs/heads/main');
  }
  workflows(sha) {
    return this.caller.git('rev-parse', `${sha}:.github/workflows`);
  }
  /** The measured rule. */
  tokenMayPointAt(sha) {
    return this.workflows(sha) === this.workflows(this.tip());
  }
  /** What a maintainer does with their own credentials, which can carry the workflow scope. */
  tagByHand(tag, sha) {
    this.tags.set(tag, sha);
  }
  publish(version) {
    this.npm.add(version);
  }

  /** `fetch`, for the API, the registry and the docs dispatch. */
  fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const api = `${API}/repos/${REPOSITORY}`;
    if (url === `https://registry.npmjs.org/${PKG.replaceAll('/', '%2f')}`) {
      return respond(200, { versions: Object.fromEntries([...this.npm].map((v) => [v, {}])) });
    }
    if (url === api) return respond(200, { default_branch: 'main' });
    let match = /^.*\/git\/ref\/tags\/(.+)$/.exec(url);
    if (match && url.startsWith(api) && method === 'GET') {
      const sha = this.tags.get(decodeURIComponent(match[1]));
      return sha ? respond(200, { object: { type: 'commit', sha } }) : respond(404, { message: 'Not Found' });
    }
    if (url === `${api}/git/refs` && method === 'POST') {
      const { ref, sha } = JSON.parse(options.body);
      const tag = ref.replace(/^refs\/tags\//, '');
      if (this.tags.has(tag)) return respond(422, { message: 'Reference already exists' });
      if (!this.tokenMayPointAt(sha)) {
        this.refused.push(`POST git/refs ${tag} at ${sha.slice(0, 7)}`);
        return respond(403, { message: 'Resource not accessible by integration' });
      }
      this.tags.set(tag, sha);
      return respond(201, {});
    }
    match = /\/compare\/([0-9a-f]{40})\.\.\.(.+)$/.exec(url);
    if (match && url.startsWith(api)) {
      const files = this.caller.git('diff', '--name-only', match[1], this.tip()).split('\n').filter(Boolean);
      return respond(200, { files: files.map((filename) => ({ filename })) });
    }
    match = /\/releases\/tags\/(.+)$/.exec(url);
    if (match && url.startsWith(api)) return this.releases.has(decodeURIComponent(match[1])) ? respond(200, {}) : respond(404, {});
    throw new Error(`the fake GitHub does not answer ${method} ${url}`);
  };

  /** `run`, for `github-release.mjs`: gh, plus the real notes assert. */
  run = (cmd, args, options = {}) => {
    if (cmd === process.execPath) {
      return { code: spawnSync(cmd, args, { encoding: 'utf8', env: options.env }).status ?? 1 };
    }
    assert.equal(cmd, 'gh');
    if (args[0] === 'api' && args[1] === 'repos/cosyte/docs/dispatches') {
      this.dispatched.push(args.join(' '));
      return { code: 0 };
    }
    const [, verb, tag] = args;
    if (verb === 'view') return { code: this.releases.has(tag) ? 0 : 1 };
    if (verb === 'edit') return { code: this.releases.has(tag) ? 0 : 1 };
    if (verb === 'create') {
      const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : null;
      if (args.includes('--verify-tag') && !this.tags.has(tag)) return { code: 1 };
      // `target_commitish` is refused, existing tag or not, at a commit whose workflows moved on.
      const at = target ?? this.tags.get(tag);
      if (target !== null && !this.tokenMayPointAt(at)) {
        this.refused.push(`release create ${tag} --target ${at.slice(0, 7)}`);
        return { code: 1 };
      }
      if (!this.tags.has(tag)) this.tags.set(tag, at);
      const assets = args.slice(3).filter((arg, i, all) => !arg.startsWith('--') && !all[i - 1]?.startsWith('--'));
      this.releases.set(tag, { assets: assets.map((asset) => asset.split('/').pop()) });
      return { code: 0 };
    }
    throw new Error(`the fake gh does not answer ${args.join(' ')}`);
  };

  capture = (cmd, args) => {
    const tag = args[2];
    return { code: 0, stdout: (this.releases.get(tag)?.assets ?? []).join('\n') };
  };
}

/**
 * A tiny evaluator for the `${{ }}` expressions these jobs gate on, over the step and job outputs the
 * scripts actually wrote. It knows `==`, `!=`, `&&`, `||`, `!`, parentheses, string literals,
 * `cancelled()`, `steps.<id>.outputs.<name>`, `steps.<id>.outcome` and `needs.version.outputs.<name>`,
 * and refuses anything else rather than answer for it.
 */
function evaluate(expression, context) {
  const body = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(expression.trim());
  assert.ok(body, `not an expression: ${expression}`);
  const tokens = body[1].match(/'[^']*'|==|!=|&&|\|\||!|\(|\)|cancelled\(\)|[A-Za-z_][\w-]*(?:\.[\w-]+)+/g);
  assert.equal(tokens.join('').replace(/\s/g, ''), body[1].replace(/\s/g, ''), `the evaluator cannot model ${expression}`);
  let at = 0;
  const peek = () => tokens[at];
  const value = () => {
    const token = tokens[at++];
    if (token === '(') {
      const inner = or();
      assert.equal(tokens[at++], ')');
      return inner;
    }
    if (token === '!') return !truthy(value());
    if (token === 'cancelled()') return false;
    if (token.startsWith("'")) return token.slice(1, -1);
    assert.ok(Object.hasOwn(context, token) || /^(steps|needs)\./.test(token), `unknown operand ${token}`);
    return context[token] ?? '';
  };
  const truthy = (v) => (typeof v === 'boolean' ? v : v !== '');
  const comparison = () => {
    const left = value();
    if (peek() === '==' || peek() === '!=') {
      const op = tokens[at++];
      const right = value();
      return op === '==' ? String(left) === String(right) : String(left) !== String(right);
    }
    return left;
  };
  const and = () => {
    let left = comparison();
    while (peek() === '&&') {
      at += 1;
      const right = comparison();
      left = truthy(left) && truthy(right);
    }
    return left;
  };
  const or = () => {
    let left = and();
    while (peek() === '||') {
      at += 1;
      const right = and();
      left = truthy(left) || truthy(right);
    }
    return left;
  };
  const result = or();
  assert.equal(at, tokens.length, `trailing tokens in ${expression}`);
  return String(result);
}

/**
 * A run's checkout, the way `actions/checkout` with `fetch-depth: 0` makes it: HEAD at the run's
 * commit, and exactly the tags the remote has at that moment, so a tag the version job made on
 * GitHub is in every later job's checkout, and one deleted there is gone.
 */
function checkoutAt(caller, github, sha) {
  for (const tag of caller.git('tag', '--list').split('\n').filter(Boolean)) {
    if (!github.tags.has(tag)) caller.git('tag', '-d', tag);
  }
  for (const [tag, at] of github.tags) caller.git('tag', '-f', tag, at);
  caller.checkout(sha);
}

const WORKFLOW_TEXT = readWorkflow(WORKFLOW, readFileSync);
const JOBS = parseWorkflow(WORKFLOW_TEXT).byId;
const versionStep = (id) => JOBS.version.steps.find((step) => step.fields.id === id);
const finalCheck = () => JOBS.version.steps.find((step) => /steps\.tag\.outputs\.ready != 'true'/.test(step.fields.if ?? ''));

/**
 * One run of the version job against the caller checkout at `sha`, through the real scripts and the
 * real expressions: the notes gate, the `promoted` step, the tag step when its `if:` says so, the job
 * outputs, and whether the run's last step fails it.
 */
async function versionJob(caller, github, sha) {
  checkoutAt(caller, github, sha);
  const env = { GH_TOKEN: 'ghs_test_token_not_a_credential', GITHUB_REPOSITORY: REPOSITORY, GITHUB_API_URL: API, GITHUB_SHA: sha };
  const notesDir = tempDir('release-tag-notes-');
  const outputs = join(notesDir, 'outputs');
  writeFileSync(outputs, '');
  const prepared = spawnSync(
    process.execPath,
    [NOTES_SCRIPT, 'prepare', '--repo', caller.dir, '--package', PKG, '--out', join(notesDir, 'release-notes.md')],
    { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputs, GITHUB_REPOSITORY: REPOSITORY } },
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  const notes = outputsOf(outputs);
  const promoted = await runScript(promotion, ['pending', '--repo', caller.dir, '--package', PKG], { env, fetchImpl: github.fetch });
  const context = {};
  for (const [key, value] of Object.entries(notes)) context[`steps.notes.outputs.${key}`] = value;
  for (const [key, value] of Object.entries(promoted.outputs)) context[`steps.promoted.outputs.${key}`] = value;
  let tag = null;
  if (evaluate(versionStep('tag').fields.if, context) === 'true') {
    tag = await runScript(releaseTag, ['ensure', '--repo', caller.dir, '--package', PKG], { env, fetchImpl: github.fetch });
    assert.equal(tag.code, 0, 'a refusal is reported, and the step itself exits 0');
    context['steps.tag.outcome'] = 'success';
    for (const [key, value] of Object.entries(tag.outputs)) context[`steps.tag.outputs.${key}`] = value;
  } else {
    context['steps.tag.outcome'] = 'skipped';
  }
  const job = {};
  for (const [key, expression] of Object.entries(JOBS.version.blocks.outputs)) {
    if (/steps\.notes-transfer/.test(expression)) continue;
    job[key] = /^\$\{\{ steps\.[\w-]+\.outputs\.[\w-]+ \}\}$/.test(expression)
      ? context[expression.slice(4, -3)] ?? ''
      : evaluate(expression, context);
  }
  const red = evaluate(finalCheck().fields.if, context) === 'true';
  const needs = Object.fromEntries(Object.entries(job).map(([key, value]) => [`needs.version.outputs.${key}`, value]));
  // The bytes the version job carries to the release job (`release-notes-b64`), when it wrote any.
  let carried = null;
  try {
    carried = readFileSync(join(notesDir, 'release-notes.md'), 'utf8');
  } catch {
    carried = null;
  }
  rmSync(notesDir, { recursive: true, force: true });
  return {
    notes,
    carried,
    promoted,
    tag,
    job,
    red,
    release: evaluate(JOBS.release.keys.if, needs) === 'true',
    finalize: evaluate(JOBS.finalize.keys.if, needs) === 'true',
  };
}

/**
 * The release-creating step of `release` or `finalize`: the real script, against the fake GitHub. The
 * `release` job is handed the notes the version job carried (`carried`); `finalize` derives them at
 * the release commit it checked out, with the same gate, as its own step does.
 */
async function cutRelease(caller, github, { version, target, requireLive = false, carried = null }) {
  checkoutAt(caller, github, target);
  const notesDir = tempDir('release-tag-cut-');
  const notes = join(notesDir, 'release-notes.md');
  if (carried !== null) {
    writeFileSync(notes, carried);
  } else {
    const outputs = join(notesDir, 'outputs');
    writeFileSync(outputs, '');
    const prepared = spawnSync(process.execPath, [NOTES_SCRIPT, 'prepare', '--repo', caller.dir, '--package', PKG, '--out', notes], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputs, GITHUB_REPOSITORY: REPOSITORY },
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(outputsOf(outputs)['is-release'], 'true', 'finalize\'s notes gate must find the version pending at its release commit');
  }
  const result = await runScript(
    githubRelease,
    [...(requireLive ? ['--require-live'] : []), '--package', PKG, '--version', version, '--target', target, '--notes', notes, '--dispatch-docs', 'true'],
    {
      env: { GH_TOKEN: 'ghs_test_token_not_a_credential', DISPATCH_TOKEN: 'ghp_test_dispatch', GITHUB_REPOSITORY: REPOSITORY, GITHUB_API_URL: API },
      run: github.run,
      capture: github.capture,
      exists: () => false,
      fetchImpl: github.fetch,
    },
  );
  rmSync(notesDir, { recursive: true, force: true });
  return result;
}

test('THE FAKE GITHUB IS THE ONE THAT STRANDED TRANSFORM 0.1.4: the old calls are refused once main moves', async () => {
  const caller = makeCaller();
  const github = new FakeGitHub(caller);
  try {
    // While main is the version commit, the old call works: it is why every release before this one did.
    assert.equal(github.tokenMayPointAt(caller.version), true);
    caller.moveMainWithAWorkflowChange();
    assert.equal(github.tokenMayPointAt(caller.version), false);

    // The release job's call, minutes after the merge: a new tag through `--target`.
    github.publish('0.1.4');
    const releaseStep = github.run('gh', ['release', 'create', 'v0.1.4', '--target', caller.version, '--title', 'v0.1.4', '--notes-file', 'n']);
    assert.equal(releaseStep.code, 1, 'run 42446003506: "gh could not create v0.1.4 at c8267c1"');
    // The next run's finalize made the same call, and so would every run after it.
    assert.equal(github.run('gh', ['release', 'create', 'v0.1.4', '--target', caller.version, '--title', 'v0.1.4', '--notes-file', 'n']).code, 1);
    // Even a tag made by hand first does not rescue a create that still sends `--target`.
    github.tagByHand('v0.1.4', caller.version);
    assert.equal(github.run('gh', ['release', 'create', 'v0.1.4', '--target', caller.version, '--title', 'v0.1.4', '--notes-file', 'n']).code, 1);
    assert.equal(github.refused.length, 3);
    // Without the target, at the existing tag, it is allowed: what `github-release.mjs` now sends.
    assert.equal(github.run('gh', ['release', 'create', 'v0.1.4', '--verify-tag', '--title', 'v0.1.4', '--notes-file', 'n']).code, 0);
  } finally {
    rmSync(caller.dir, { recursive: true, force: true });
  }
});

test('MAIN MOVES BETWEEN THE VERSION JOB AND THE RELEASE: the tag was made first, so the release is cut at it', async () => {
  const caller = makeCaller();
  const github = new FakeGitHub(caller);
  try {
    // The version commit's own run, seconds after the merge, while main is still that commit.
    const run = await versionJob(caller, github, caller.version);
    assert.equal(run.tag?.outputs.outcome, 'created');
    assert.equal(github.tags.get('v0.1.4'), caller.version, 'v0.1.4 is on the version commit before anything is published');
    assert.deepEqual([run.job['is-release'], run.release, run.finalize, run.red], ['true', true, false, false]);

    // transform#83 merges while the release job waits for its approval and verifies.
    const moved = caller.moveMainWithAWorkflowChange();
    assert.equal(github.tokenMayPointAt(caller.version), false, 'from here no GITHUB_TOKEN can tag the version commit');

    // The release job publishes, then cuts the GitHub release at the existing tag, with the notes the
    // version job derived before anyone approved anything.
    github.publish('0.1.4');
    assert.ok(run.carried?.includes('npm install @cosyte/transform@0.1.4'), 'the version job carried a body');
    const cut = await cutRelease(caller, github, { version: '0.1.4', target: caller.version, carried: run.carried });
    assert.equal(cut.code, 0, cut.stderr);
    assert.ok(github.releases.has('v0.1.4'), 'the release exists, at the tag on the version commit');
    assert.equal(github.tags.get('v0.1.4'), caller.version);
    assert.deepEqual(github.refused, [], 'nothing was refused: no ref was asked for after main moved');
    assert.equal(github.dispatched.length, 1);

    // The next run, on the commit that moved main, finds nothing owed and publishes nothing.
    const next = await versionJob(caller, github, moved);
    assert.equal(next.notes['is-release'], 'false');
    assert.deepEqual([next.release, next.finalize, next.red, next.tag], [false, false, false, null]);
  } finally {
    rmSync(caller.dir, { recursive: true, force: true });
  }
});

test('MAIN MOVES BETWEEN THE RELEASE AND FINALIZE: a later run finishes a release whose last step never ran', async () => {
  const caller = makeCaller();
  const github = new FakeGitHub(caller);
  try {
    const run = await versionJob(caller, github, caller.version);
    assert.equal(run.release, true);
    github.publish('0.1.4');
    // The release step never finished (a timeout, a cancelled run), and then main moved on.
    const moved = caller.moveMainWithAWorkflowChange();

    const later = await versionJob(caller, github, moved);
    assert.deepEqual([later.job['is-release'], later.job.finalize, later.job['finalize-sha']], ['false', 'true', caller.version]);
    assert.equal(later.tag?.outputs.outcome, 'exists', 'the tag is already on the version commit: nothing to make');
    assert.deepEqual([later.release, later.finalize, later.red], [false, true, false]);

    const cut = await cutRelease(caller, github, { version: '0.1.4', target: later.job['finalize-sha'], requireLive: true });
    assert.equal(cut.code, 0, cut.stderr);
    assert.ok(github.releases.has('v0.1.4'));
    assert.deepEqual(github.refused, []);
  } finally {
    rmSync(caller.dir, { recursive: true, force: true });
  }
});

test('A RELEASE ALREADY STRANDED, UNTAGGED, IS REPORTED WITH THE ONE COMMAND THAT FINISHES IT, AND THEN FINISHED', async () => {
  // Transform 0.1.4 as the old pipeline left it: on npm, no tag, no release, and main moved on.
  const caller = makeCaller();
  const github = new FakeGitHub(caller);
  try {
    github.publish('0.1.4');
    const moved = caller.moveMainWithAWorkflowChange();

    const later = await versionJob(caller, github, moved);
    assert.equal(later.promoted.outputs.finalize, 'true', 'live, no release: owed its release');
    assert.equal(later.tag?.outputs.outcome, 'refused', 'and its tag can no longer be made with a GITHUB_TOKEN');
    assert.deepEqual([later.job.finalize, later.finalize, later.release], ['false', false, false], 'so nothing runs that would fail on it');
    assert.equal(later.red, true, 'the run is red, after the Version PR step, rather than green and silent');
    assert.equal(later.tag.outputs.command, `gh api repos/cosyte/transform/git/refs -f ref=refs/tags/v0.1.4 -f sha=${caller.version}`);
    assert.match(later.tag.outputs.reason, /\.github\/workflows\/ci\.yml, \.github\/workflows\/no-internal-refs\.yml/);
    assert.match(later.tag.summary, /v0\.1\.4 is not on the version commit/);
    assert.equal(github.tags.has('v0.1.4'), false, 'and nothing was tagged anywhere else instead');

    // A maintainer runs the command, then re-runs the failed jobs.
    github.tagByHand('v0.1.4', caller.version);
    const rerun = await versionJob(caller, github, moved);
    assert.deepEqual([rerun.tag?.outputs.outcome, rerun.finalize, rerun.red], ['exists', true, false]);
    const cut = await cutRelease(caller, github, { version: '0.1.4', target: rerun.job['finalize-sha'], requireLive: true });
    assert.equal(cut.code, 0, cut.stderr);
    assert.ok(github.releases.has('v0.1.4'), 'finished by the pipeline: the release at the tag, with its notes and dispatch');
  } finally {
    rmSync(caller.dir, { recursive: true, force: true });
  }
});

test('MAIN MOVES BEFORE THE TAG CAN BE MADE: nothing is published, and the run says what to run', async () => {
  const caller = makeCaller();
  const github = new FakeGitHub(caller);
  try {
    caller.moveMainWithAWorkflowChange();
    const run = await versionJob(caller, github, caller.version);
    assert.equal(run.notes['is-release'], 'true', 'the notes gate would have published it');
    assert.equal(run.tag?.outputs.outcome, 'refused');
    assert.deepEqual([run.job['is-release'], run.release, run.finalize, run.red], ['false', false, false, true]);
    assert.equal(github.npm.has('0.1.4'), false, 'npm untouched: nothing is stranded');

    github.tagByHand('v0.1.4', caller.version);
    const rerun = await versionJob(caller, github, caller.version);
    assert.deepEqual([rerun.tag?.outputs.outcome, rerun.job['is-release'], rerun.release, rerun.red], ['exists', 'true', true, false]);
    github.publish('0.1.4');
    const cut = await cutRelease(caller, github, { version: '0.1.4', target: caller.version, carried: rerun.carried });
    assert.equal(cut.code, 0, cut.stderr);
    assert.ok(github.releases.has('v0.1.4'));
  } finally {
    rmSync(caller.dir, { recursive: true, force: true });
  }
});

test('A LATER COMMIT NEVER PUBLISHES THE VERSION, AND NEVER TAGS ANY COMMIT BUT ITS VERSION COMMIT', async () => {
  const caller = makeCaller();
  const github = new FakeGitHub(caller);
  try {
    // The version commit's run stopped before its tag step (a refused gate, a failed checkout), and
    // main moved on with a change that leaves the workflow files alone.
    caller.git('checkout', '-q', 'main');
    writeFileSync(join(caller.dir, 'README.md'), 'a later change\n');
    caller.git('add', '-A');
    caller.git('commit', '-qm', 'docs: a later change');
    const later = caller.git('rev-parse', 'HEAD');

    const run = await versionJob(caller, github, later);
    assert.equal(run.notes['is-release'], 'false', 'only the version commit\'s own run is given the publish');
    assert.deepEqual([run.release, run.finalize, run.red, run.tag], [false, false, false, null], 'no publish, no tag, no red');
    assert.match(run.promoted.stdout, /::notice title=A version is owed its publish::/);
    assert.match(run.promoted.stdout, new RegExp(`--commit ${caller.version}`), 'it names the run that can publish it');
    assert.equal(github.tags.has('v0.1.4'), false);

    // Published later by the version commit's own run, its release step unfinished: the later commit
    // tags the VERSION commit, never itself, and finalizes there.
    const own = await versionJob(caller, github, caller.version);
    assert.equal(own.release, true);
    github.publish('0.1.4');
    github.tags.delete('v0.1.4');
    const catchUp = await versionJob(caller, github, later);
    assert.equal(catchUp.tag?.outputs.outcome, 'created');
    assert.equal(github.tags.get('v0.1.4'), caller.version);
    assert.equal(catchUp.finalize, true);
  } finally {
    rmSync(caller.dir, { recursive: true, force: true });
  }
});

/** The `run: |` script of a step, out of the raw text the shared reader keeps for it, dedented. */
function runScriptOf(step) {
  const lines = step.body.split('\n');
  const at = lines.findIndex((line) => /^\s*run: \|\s*$/.test(line));
  assert.ok(at >= 0, `"${step.label}" has no \`run: |\` block`);
  const indent = lines[at].search(/\S/);
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  const margin = Math.min(...body.filter((line) => line.trim() !== '').map((line) => line.search(/\S/)));
  return body.map((line) => line.slice(margin)).join('\n');
}

/** Run a step's script the way the runner does for `shell: bash`. */
function bashStep(step, cwd, env) {
  const done = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', runScriptOf(step)], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return { code: done.status, stdout: done.stdout, stderr: done.stderr };
}

test('THE TWO SHELL STEPS, RUN AS WRITTEN: the release job publishes only a tagged commit, and a refused tag ends the version job red', async () => {
  const caller = makeCaller();
  const github = new FakeGitHub(caller);
  try {
    const release = JOBS.release.steps;
    const check = release.find((step) => step.label === 'The version commit must carry its tag before anything is published');
    const publish = release.find((step) => step.fields.id === 'changesets');
    const verify = release.find((step) => step.label === 'Verify');
    assert.ok(check && publish && verify);
    assert.ok(verify.index < check.index && check.index < publish.index, 'after Verify, before the publish');
    assert.equal(check.env.NOTES_VERSION, '${{ needs.version.outputs.version }}');

    const env = { NOTES_VERSION: '0.1.4', GITHUB_SHA: caller.version };
    checkoutAt(caller, github, caller.version);
    const untagged = bashStep(check, caller.dir, env);
    assert.equal(untagged.code, 1, 'no tag on the commit about to be published: the job stops before npm');
    assert.match(untagged.stdout, /::error title=Release not tagged::v0\.1\.4 points at '', not at /);

    github.tagByHand('v0.1.4', caller.git('rev-parse', 'HEAD~1'));
    checkoutAt(caller, github, caller.version);
    assert.equal(bashStep(check, caller.dir, env).code, 1, 'a tag on another commit stops it too');

    github.tags.set('v0.1.4', caller.version);
    checkoutAt(caller, github, caller.version);
    const tagged = bashStep(check, caller.dir, env);
    assert.equal(tagged.code, 0, tagged.stdout + tagged.stderr);
    assert.match(tagged.stdout, /v0\.1\.4 points at [0-9a-f]{40}, the commit this job publishes/);

    // The version job's last step, with what a refused tag step leaves in its outputs.
    const refuse = finalCheck();
    const red = bashStep(refuse, caller.dir, {
      TAG_REASON: 'GitHub refused to create v0.1.4 at the version commit c8267c1. Nothing has been published.',
      TAG_COMMAND: `gh api repos/cosyte/transform/git/refs -f ref=refs/tags/v0.1.4 -f sha=${SHA}`,
      GITHUB_RUN_ID: '42446281353',
      GITHUB_REPOSITORY: REPOSITORY,
    });
    assert.equal(red.code, 1);
    assert.match(red.stdout, /^::error title=Release not tagged::GitHub refused to create v0\.1\.4/m);
    assert.match(red.stdout, new RegExp(`^  gh api repos/cosyte/transform/git/refs -f ref=refs/tags/v0\\.1\\.4 -f sha=${SHA}$`, 'm'));
    assert.match(red.stdout, /^  gh run rerun 42446281353 --failed --repo cosyte\/transform$/m);
    const silent = bashStep(refuse, caller.dir, { TAG_REASON: '', TAG_COMMAND: '', GITHUB_RUN_ID: '1', GITHUB_REPOSITORY: REPOSITORY });
    assert.equal(silent.code, 1, 'a tag step that left no reason still fails the run, and says where to look');
    assert.match(silent.stdout, /did not find or make the tag on the version commit; read its log/);
  } finally {
    rmSync(caller.dir, { recursive: true, force: true });
  }
});
