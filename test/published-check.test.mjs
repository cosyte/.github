// Tests for `ci.yml`'s `published` job and `scripts/published-check.mjs`, the scheduled check of the
// package a caller has published.
//
// THREE KINDS OF ASSERTION, AND THE THIRD IS THE ONE THAT MATTERS.
//
//   1. The job's SHAPE in `ci.yml`, read line by line like `test/ci-docs-content.test.mjs` does:
//      it runs only on the caller's `schedule` and `workflow_dispatch` events, installs nothing in
//      the workspace, and hands the step the caller's input.
//   2. The pure helpers, one behaviour per test.
//   3. FIXTURE CALLERS RUN END TO END. The step's own shell command is EXTRACTED from `ci.yml` and
//      run in a copy of a fixture caller, against a fake registry on localhost that serves packages
//      `npm pack`ed from `test/fixtures/published-check/`. So the real npm installs a real tarball
//      into the real clean room and Node really imports it both ways; the only thing the test adds
//      to the step's command is the registry it is pointed at. A good caller passes, a caller with a
//      deliberately wrong name fails, and each other way a published package can be broken for its
//      users is paired with the run that shows it.
//
// No network: the registry is in this process. The fake answers with plain registry JSON and a
// tarball, which is all npm asks of a registry for an install.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCommand } from '../scripts/install-check.mjs';
import {
  PROBE_MARK,
  SAMPLE_EXTENSIONS,
  entrySpecifiers,
  locateSample,
  npmReason,
  probeEntries,
  publishedName,
  readProbe,
  renderAnnotation,
  renderSummary,
  runPublishedCheck,
} from '../scripts/published-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const FIXTURES = join(HERE, 'fixtures/published-check');
const SCRIPT = join(REPO, 'scripts/published-check.mjs');
const WORKFLOW = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const LINES = WORKFLOW.split('\n');

/** The step that runs the check, by the name `ci.yml` gives it. */
const STEP_NAME = 'The published package must install, import and run in a clean directory';

/** The job-level condition, exactly. Anything wider runs a network install on every pull request. */
const CONDITION = "if: ${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}";

// ---------------------------------------------------------------------------
// The line reader
// ---------------------------------------------------------------------------

const indentOf = (line) => /^ */.exec(line)[0].length;

/** Every line of the block the line at `index` opens, comment-only lines dropped. */
function block(index) {
  const base = indentOf(LINES[index]);
  const out = [];
  for (const line of LINES.slice(index + 1)) {
    if (line.trim() === '') continue;
    if (indentOf(line) <= base) break;
    if (line.trim().startsWith('#')) continue;
    out.push(line);
  }
  return out;
}

function lineIndex(pattern) {
  const at = LINES.findIndex((line) => pattern.test(line));
  assert.notEqual(at, -1, `ci.yml has no line matching ${pattern}`);
  return at;
}

const JOB = block(lineIndex(/^  published:$/));

/**
 * The `run: |` body of the step named `name`, dedented, exactly as the runner's bash receives it
 * (before `${{ }}` interpolation, which this step does not use in its body).
 */
function stepRunBody(name) {
  const start = LINES.findIndex((line) => line === `      - name: ${name}`);
  assert.notEqual(start, -1, `ci.yml has no step named "${name}"`);
  const runAt = LINES.findIndex((line, i) => i > start && /^ {8}run: \|$/.test(line));
  assert.notEqual(runAt, -1, `the step "${name}" has no \`run: |\` block`);
  const body = [];
  for (const line of LINES.slice(runAt + 1)) {
    if (line.trim() !== '' && indentOf(line) < 10) break;
    body.push(line.slice(10));
  }
  assert.ok(body.join('').trim() !== '', `the step "${name}" runs nothing`);
  return body.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// 1. THE JOB'S SHAPE
// ---------------------------------------------------------------------------

test('the published job runs only on the caller\'s schedule and workflow_dispatch events', () => {
  const conditions = JOB.filter((line) => /^    if:/.test(line)).map((line) => line.trim());
  assert.deepEqual(conditions, [CONDITION]);
  // In a called workflow `github` is the CALLER's context, so this is the event the caller's
  // workflow ran on. `inputs` and `job` are the called workflow's own; neither names an event.
  for (const event of ['push', 'pull_request', 'pull_request_target', 'merge_group', 'release']) {
    assert.equal(CONDITION.includes(`'${event}'`), false, `the job must not run on ${event}`);
  }
});

test('the published job cannot be skipped by a dependency or swallow its own failure', () => {
  assert.equal(JOB.some((line) => /^    needs:/.test(line)), false, 'the job must depend on no job');
  assert.equal(JOB.some((line) => /continue-on-error/.test(line)), false, 'no continue-on-error anywhere in it');
  assert.equal(JOB.some((line) => /\|\|\s*true/.test(line)), false, 'no `|| true` anywhere in it');
});

test('the published job installs nothing in the workspace: the install is the script\'s, in a clean room', () => {
  const runs = JOB.filter((line) => /\b(?:pnpm|npm|yarn)\s+(?:install|ci|add|i)\b/.test(line));
  assert.deepEqual(runs, [], 'a workspace install would put the monorepo\'s own modules in reach');
  assert.equal(JOB.some((line) => /pnpm\/action-setup/.test(line)), false, 'no pnpm in this job');
});

test('the tooling is checked out at job.workflow_sha, and neither checkout keeps a credential', () => {
  const text = JOB.join('\n');
  assert.match(text, /^ {10}repository: cosyte\/\.github$/m);
  assert.match(text, /^ {10}ref: \$\{\{ job\.workflow_sha \}\}$/m);
  assert.match(text, /^ {10}path: \.cosyte-ci-tooling$/m);
  const checkouts = JOB.filter((line) => /uses: actions\/checkout@/.test(line)).length;
  const dropped = JOB.filter((line) => /^ {10}persist-credentials: false$/.test(line)).length;
  assert.equal(checkouts, 2);
  assert.equal(dropped, checkouts, 'every checkout in this job drops its credential');
});

test('the job runs on the caller\'s Node matrix, so a Node release that breaks the install is caught', () => {
  const text = JOB.join('\n');
  assert.match(text, /^ {8}node: \$\{\{ fromJSON\(inputs\.node-versions\) \}\}$/m);
  assert.match(text, /^ {10}node-version: \$\{\{ matrix\.node \}\}$/m);
});

test('`published-smoke-sample` is an optional string defaulting to empty, and the step receives it', () => {
  const definition = block(lineIndex(/^ {6}published-smoke-sample:$/)).map((line) => line.trim());
  assert.ok(definition.includes('type: string'), definition.join(' | '));
  assert.ok(definition.includes('default: ""'), definition.join(' | '));
  assert.equal(definition.includes('required: true'), false, 'a required input breaks every caller that omits it');
  assert.match(JOB.join('\n'), /^ {10}PUBLISHED_SMOKE_SAMPLE: \$\{\{ inputs\.published-smoke-sample \}\}$/m);
  assert.match(stepRunBody(STEP_NAME), /--sample "\$PUBLISHED_SMOKE_SAMPLE"/);
});

test('the script imports node builtins and its one sibling only, so the tooling checkout is enough', () => {
  const imports = [...readFileSync(SCRIPT, 'utf8').matchAll(/^import [^;]*? from "([^"]+)";$/gms)].map((m) => m[1]);
  assert.ok(imports.length > 0, 'the import reader found nothing, so it is not reading the file');
  for (const specifier of imports) {
    assert.ok(specifier.startsWith('node:') || specifier === './install-check.mjs', `unexpected import ${specifier}`);
  }
});

// ---------------------------------------------------------------------------
// 2. THE HELPERS
// ---------------------------------------------------------------------------

test('publishedName takes the caller\'s name, and refuses a private or nameless manifest', () => {
  assert.deepEqual(publishedName({ name: '@cosyte/hl7', version: '0.1.0' }), { name: '@cosyte/hl7' });
  assert.match(publishedName({ name: 'x', private: true }).error, /private/);
  assert.match(publishedName({ version: '1.0.0' }).error, /names no package/);
  assert.match(publishedName({ name: '  ' }).error, /names no package/);
  assert.match(publishedName([]).error, /not a JSON object/);
  assert.match(publishedName(null).error, /not a JSON object/);
});

test('entrySpecifiers: the bare name when `.` is exported, else every exported subpath', () => {
  const dual = { name: '@cosyte/hl7', exports: { '.': { import: './a.mjs', require: './a.cjs' }, './package.json': './package.json' } };
  assert.deepEqual(entrySpecifiers(dual), ['@cosyte/hl7']);
  // `@cosyte/prettier-config`: a `.` that is JSON is still the bare name; the probe decides to resolve it.
  assert.deepEqual(entrySpecifiers({ name: '@cosyte/prettier-config', exports: { '.': './index.json' } }), ['@cosyte/prettier-config']);
  // `@cosyte/tsconfig`: no `.`, so each subpath, which is how it is consumed.
  assert.deepEqual(
    entrySpecifiers({ name: '@cosyte/tsconfig', exports: { './base.json': './base.json', './library.json': './library.json' } }),
    ['@cosyte/tsconfig/base.json', '@cosyte/tsconfig/library.json'],
  );
  assert.deepEqual(entrySpecifiers({ name: 'plain', main: './index.js' }), ['plain']);
  assert.deepEqual(entrySpecifiers({ name: 'str', exports: './index.js' }), ['str']);
  assert.deepEqual(entrySpecifiers({ name: 'cond', exports: { import: './a.mjs', require: './a.cjs' } }), ['cond']);
});

test('entrySpecifiers skips patterns, package.json and blocked entries, and never returns nothing', () => {
  const manifest = {
    name: 'p',
    exports: { './a': './a.js', './internal/*': './i/*.js', './package.json': './package.json', './blocked': null },
  };
  assert.deepEqual(entrySpecifiers(manifest), ['p/a']);
  // Nothing loadable left: the bare name, so Node's own ERR_PACKAGE_PATH_NOT_EXPORTED is the finding.
  assert.deepEqual(entrySpecifiers({ name: 'p', exports: { './package.json': './package.json' } }), ['p']);
  assert.deepEqual(entrySpecifiers({ name: 'p', exports: { '.': null, './x': './x.js' } }), ['p/x']);
});

test('locateSample: empty means none; a missing file or a non-JavaScript one is refused', async () => {
  const repo = join(FIXTURES, 'caller');
  assert.deepEqual(await locateSample(repo, ''), { file: null });
  assert.deepEqual(await locateSample(repo, undefined), { file: null });
  assert.deepEqual(await locateSample(repo, 'smoke/sample.mjs'), { file: join(repo, 'smoke/sample.mjs') });
  assert.match((await locateSample(repo, 'smoke/nope.mjs')).error, /does not exist/);
  assert.match((await locateSample(repo, 'package.json')).error, /is not a \.mjs, \.cjs, \.js file/);
  assert.match((await locateSample(repo, 'smoke')).error, /is not a \.mjs/);
  assert.deepEqual(SAMPLE_EXTENSIONS, ['.mjs', '.cjs', '.js']);
});

test('readProbe reads only marked lines, and a specifier with no report is a failure', () => {
  const out = [
    'module init printed this',
    `${PROBE_MARK}${JSON.stringify({ arm: 'esm', spec: 'a', outcome: 'loaded', detail: '/x/a.mjs' })}`,
    `${PROBE_MARK}${JSON.stringify({ arm: 'esm', spec: 'b/base.json', outcome: 'resolved', detail: '/x/base.json' })}`,
    `${PROBE_MARK}${JSON.stringify({ arm: 'cjs', spec: 'c', outcome: 'loaded', detail: 'wrong arm' })}`,
    `${PROBE_MARK}{torn`,
  ].join('\n');
  const checks = readProbe('esm', ['a', 'b/base.json', 'c'], { code: 0, out, err: '' });
  assert.deepEqual(checks, [
    { label: 'import a', ok: true, detail: 'loaded' },
    { label: 'import b/base.json', ok: true, detail: 'resolved to base.json, not parsed' },
    { label: 'import c', ok: false, detail: 'the esm probe exited 0 without reporting on it: (no output)' },
  ]);
  const failed = readProbe('cjs', ['a'], {
    code: 0,
    out: `${PROBE_MARK}${JSON.stringify({ arm: 'cjs', spec: 'a', outcome: 'failed', detail: 'MODULE_NOT_FOUND: gone' })}`,
    err: '',
  });
  assert.deepEqual(failed, [{ label: 'require a', ok: false, detail: 'MODULE_NOT_FOUND: gone' }]);
  const crashed = readProbe('cjs', ['a'], { code: 7, out: '', err: '\nboom\nmore' });
  assert.equal(crashed[0].ok, false);
  assert.match(crashed[0].detail, /exited 7 without reporting on it: boom/);
});

/** A hand-built clean room: `node_modules/<name>` with the given manifest and files, no npm. */
function handBuiltRoom(manifest, files) {
  const room = mkdtempSync(join(tmpdir(), 'published-check-room-'));
  writeFileSync(join(room, 'package.json'), '{"name":"room","private":true}\n');
  const at = join(room, 'node_modules', ...manifest.name.split('/'));
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'package.json'), JSON.stringify(manifest));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(at, file), text);
  return room;
}

test('a JSON entry the tarball dropped fails on BOTH arms, because the ESM arm stats what it resolved', async () => {
  // `import.meta.resolve` answers a URL for this without complaint (it does not check the file
  // exists), so without the stat the ESM arm would report the missing file as resolved.
  const manifest = { name: '@x/tsconfig', exports: { './base.json': './base.json', './library.json': './library.json' } };
  const room = handBuiltRoom(manifest, { 'base.json': '{}' });
  const checks = await probeEntries({ room, specs: entrySpecifiers(manifest), env: { PATH: process.env.PATH ?? '' } });
  assert.deepEqual(
    checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.label}`),
    [
      'ok import @x/tsconfig/base.json',
      'FAIL import @x/tsconfig/library.json',
      'ok require @x/tsconfig/base.json',
      'FAIL require @x/tsconfig/library.json',
    ],
  );
  assert.match(checks[1].detail, /ENOENT/);
});

test('a module whose init throws fails its arm, and a failure on one entry does not hide the next', async () => {
  const manifest = {
    name: 'two-entries',
    exports: { './good': './good.cjs', './bad': './bad.cjs' },
  };
  const room = handBuiltRoom(manifest, { 'good.cjs': 'module.exports = 1;\n', 'bad.cjs': 'throw new Error("init failed");\n' });
  const checks = await probeEntries({ room, specs: entrySpecifiers(manifest), env: { PATH: process.env.PATH ?? '' } });
  assert.deepEqual(
    checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.label}`),
    ['ok import two-entries/good', 'FAIL import two-entries/bad', 'ok require two-entries/good', 'FAIL require two-entries/bad'],
  );
  assert.match(checks[1].detail, /init failed/);
});

test('npmReason says E404 or ETIMEDOUT, not "exit 1"', () => {
  const e404 = [
    'npm error code E404',
    'npm error 404 Not Found - GET https://registry.npmjs.org/@cosyte%2fnope - Not found',
    'npm error 404',
  ].join('\n');
  assert.equal(npmReason(e404), 'E404 404 Not Found - GET https://registry.npmjs.org/@cosyte%2fnope - Not found');
  const timeout = ['npm error code ETIMEDOUT', 'npm error network request to https://r/x failed, reason: timeout'].join('\n');
  assert.equal(npmReason(timeout), 'ETIMEDOUT network request to https://r/x failed, reason: timeout');
  assert.equal(npmReason('something else entirely'), 'something else entirely');
});

test('the annotation is one line naming the first failure; a pass has none; no em dash anywhere', () => {
  const failing = {
    ok: false,
    name: '@cosyte/x',
    version: '1.0.0',
    sample: 'smoke/s.mjs',
    checks: [
      { label: 'npm install @cosyte/x@latest', ok: true, detail: 'installed 1.0.0' },
      { label: 'import @cosyte/x', ok: false, detail: 'ERR_MODULE_NOT_FOUND: gone\nstack' },
      { label: 'require @cosyte/x', ok: false, detail: 'MODULE_NOT_FOUND' },
    ],
  };
  const annotation = renderAnnotation(failing);
  assert.equal(annotation.split('\n').length, 1);
  assert.match(annotation, /^::error title=Published package check failed::@cosyte\/x@1\.0\.0 as users install it: import @cosyte\/x: ERR_MODULE_NOT_FOUND: gone \(and 1 more\)$/);
  assert.equal(renderAnnotation({ ...failing, ok: true }), null);
  const summary = renderSummary(failing);
  assert.match(summary, /Published package check: FAIL/);
  assert.match(summary, /\| import @cosyte\/x \| \*\*FAIL\*\* \| ERR_MODULE_NOT_FOUND: gone \|/);
  // A backslash before a pipe is escaped too, or `\|` in the text would end the cell early.
  const piped = renderSummary({ ...failing, checks: [{ label: 'a\\|b', ok: false, detail: 'c|d' }] });
  assert.match(piped, /^\| a\\\\\\\|b \| \*\*FAIL\*\* \| c\\\|d \|$/m);
  // Assembled from codepoints rather than written, so this file itself stays free of the characters
  // in every spelling the em-dash gate bans, the JavaScript escape included.
  const DASHES = [String.fromCodePoint(0x2013), String.fromCodePoint(0x2014)];
  for (const text of [annotation, summary, readFileSync(SCRIPT, 'utf8')]) {
    for (const dash of DASHES) assert.equal(text.includes(dash), false, 'the brand rule bans em and en dashes');
  }
});

// ---------------------------------------------------------------------------
// 3. FIXTURE CALLERS, END TO END
// ---------------------------------------------------------------------------

/** `npm pack` a fixture into `into`, and return the tarball and the manifest it carries. */
function pack(dir, into) {
  const result = spawnSync('npm', ['pack', dir, '--pack-destination', into, '--json', '--ignore-scripts'], {
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false', npm_config_cache: join(into, '.npm-cache') },
  });
  assert.equal(result.status, 0, `npm pack ${dir} failed:\n${result.stderr}`);
  const [{ filename }] = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
  return {
    manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
    file: filename,
    bytes: readFileSync(join(into, filename)),
  };
}

/**
 * A registry that knows exactly the packages it is given and 404s everything else, the way npm's
 * does for a name nobody published. It records every path it is asked for.
 */
async function startRegistry(dirs) {
  const work = mkdtempSync(join(tmpdir(), 'published-check-registry-'));
  const byName = new Map();
  const byFile = new Map();
  for (const dir of dirs) {
    const packed = pack(dir, work);
    byName.set(packed.manifest.name, packed);
    byFile.set(packed.file, packed);
  }
  const requests = [];
  let base = '';
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://registry.invalid').pathname);
    requests.push(path);
    const tarball = path.startsWith('/tarballs/') ? byFile.get(path.slice('/tarballs/'.length)) : null;
    if (tarball) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tarball.bytes);
      return;
    }
    const entry = byName.get(path.slice(1));
    if (entry) {
      const { manifest, file, bytes } = entry;
      const version = {
        ...manifest,
        _id: `${manifest.name}@${manifest.version}`,
        dist: {
          tarball: `${base}/tarballs/${file}`,
          shasum: createHash('sha1').update(bytes).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: version } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"Not found"}');
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  base = `http://127.0.0.1:${server.address().port}`;
  return { url: base, requests, close: () => new Promise((done) => server.close(done)) };
}

/**
 * Run `ci.yml`'s own step in a copy of a fixture caller, the way the runner would: the caller's
 * checkout as the working directory, this repository at `.cosyte-ci-tooling`, a `RUNNER_TEMP`
 * outside the checkout, and the input in `PUBLISHED_SMOKE_SAMPLE`. The registry is the one thing
 * added to the command. Async, because the registry answers from this same process.
 */
async function runStep(fixture, { sample = '', registry }) {
  const root = mkdtempSync(join(tmpdir(), 'published-check-step-'));
  const workspace = join(root, 'workspace');
  cpSync(join(FIXTURES, fixture), workspace, { recursive: true });
  cpSync(join(REPO, 'scripts'), join(workspace, '.cosyte-ci-tooling/scripts'), { recursive: true });
  const runnerTemp = join(root, 'runner-temp');
  mkdirSync(runnerTemp);
  const summary = join(root, 'summary.md');
  const script = `set -euo pipefail\n${stepRunBody(STEP_NAME)} --registry "$TEST_REGISTRY"\n`;
  const run = await runCommand('bash', ['-c', script], {
    cwd: workspace,
    env: {
      ...process.env,
      PUBLISHED_SMOKE_SAMPLE: sample,
      RUNNER_TEMP: runnerTemp,
      GITHUB_STEP_SUMMARY: summary,
      TEST_REGISTRY: registry,
    },
    timeoutMs: 240_000,
  });
  let summaryText = '';
  try {
    summaryText = readFileSync(summary, 'utf8');
  } catch {
    // No summary is itself something the assertions below will notice.
  }
  return { ...run, output: `${run.out}\n${run.err}`, summary: summaryText, runnerTemp };
}

const registry = await startRegistry([
  join(FIXTURES, 'caller'),
  join(FIXTURES, 'config-package'),
  join(FIXTURES, 'missing-esm'),
]);
test.after(() => registry.close());

test('THE FIXTURE CALLER PASSES: installed from the registry, imported both ways, sample run', async () => {
  const run = await runStep('caller', { sample: 'smoke/sample.mjs', registry: registry.url });
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /ok {4}npm install @cosyte-fixture\/published-check@latest: installed 1\.2\.3/);
  assert.match(run.output, /ok {4}import @cosyte-fixture\/published-check: loaded/);
  assert.match(run.output, /ok {4}require @cosyte-fixture\/published-check: loaded/);
  assert.match(run.output, /ok {4}smoke sample smoke\/sample\.mjs: exited 0/);
  assert.match(run.output, /^verdict: pass$/m);
  assert.doesNotMatch(run.output, /::error/);
  assert.match(run.summary, /Published package check: pass/);
  assert.match(run.summary, /`@cosyte-fixture\/published-check@1\.2\.3`/);
  assert.ok(registry.requests.includes('/@cosyte-fixture/published-check'), 'the install went to the registry');
  // The clean room is cleaned up, so a second scheduled run on a reused runner starts from nothing.
  assert.deepEqual(readdirSync(run.runnerTemp), []);
});

test('with no sample named, the default is the import only', async () => {
  const run = await runStep('caller', { sample: '', registry: registry.url });
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /import @cosyte-fixture\/published-check: loaded/);
  assert.doesNotMatch(run.output, /smoke sample/);
  assert.match(run.summary, /No smoke sample named, so the check is the install and the imports\./);
});

test('THE DELIBERATELY WRONG NAME FAILS, with npm\'s E404 in the annotation', async () => {
  const run = await runStep('wrong-name', { registry: registry.url });
  assert.equal(run.code, 1, run.output);
  assert.match(run.output, /FAIL {2}npm install @cosyte-fixture\/published-check-no-such-package@latest: E404/);
  assert.match(
    run.output,
    /^::error title=Published package check failed::@cosyte-fixture\/published-check-no-such-package@latest as users install it: .*E404/m,
  );
  assert.match(run.output, /^verdict: fail$/m);
  assert.match(run.summary, /Published package check: FAIL/);
  assert.ok(registry.requests.includes('/@cosyte-fixture/published-check-no-such-package'));
  assert.doesNotMatch(run.output, /import @cosyte-fixture/, 'nothing is imported after a failed install');
});

test('a sample that gets the wrong answer fails the run', async () => {
  const run = await runStep('caller', { sample: 'smoke/failing-sample.mjs', registry: registry.url });
  assert.equal(run.code, 1, run.output);
  assert.match(run.output, /ok {4}import @cosyte-fixture\/published-check: loaded/);
  assert.match(run.output, /FAIL {2}smoke sample smoke\/failing-sample\.mjs: exited 1/);
  assert.match(run.output, /SYNTH-9999/, 'the sample\'s own assertion message reaches the log');
});

test('a misnamed sample fails before the registry is asked anything', async () => {
  const before = registry.requests.length;
  const run = await runStep('caller', { sample: 'smoke/missing.mjs', registry: registry.url });
  assert.equal(run.code, 1, run.output);
  assert.match(run.output, /FAIL {2}smoke sample: the smoke sample "smoke\/missing\.mjs" does not exist/);
  assert.equal(registry.requests.length, before);
});

test('a CONFIG PACKAGE is resolved, not parsed: each JSON subpath resolves on both arms', async () => {
  const result = await runPublishedCheck({
    repo: join(FIXTURES, 'config-package'),
    registry: registry.url,
    tempParent: mkdtempSync(join(tmpdir(), 'published-check-config-')),
  });
  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
  assert.deepEqual(
    result.checks.map((c) => `${c.label}: ${c.detail}`),
    [
      'npm install @cosyte-fixture/tsconfig@latest: installed 0.4.0',
      'import @cosyte-fixture/tsconfig/base.json: resolved to base.json, not parsed',
      'import @cosyte-fixture/tsconfig/library.json: resolved to library.json, not parsed',
      'require @cosyte-fixture/tsconfig/base.json: resolved to base.json, not parsed',
      'require @cosyte-fixture/tsconfig/library.json: resolved to library.json, not parsed',
    ],
  );
});

test('an export map pointing at a file the tarball dropped fails on the arm that needs it', async () => {
  const result = await runPublishedCheck({
    repo: join(FIXTURES, 'missing-esm'),
    registry: registry.url,
    tempParent: mkdtempSync(join(tmpdir(), 'published-check-missing-esm-')),
  });
  assert.equal(result.ok, false);
  const byLabel = Object.fromEntries(result.checks.map((c) => [c.label, c]));
  assert.equal(byLabel['require @cosyte-fixture/missing-esm'].ok, true);
  assert.equal(byLabel['import @cosyte-fixture/missing-esm'].ok, false);
  // `import.meta.resolve` alone would have called this fine: it does not check the file exists.
  assert.match(byLabel['import @cosyte-fixture/missing-esm'].detail, /ENOENT|ERR_MODULE_NOT_FOUND/);
});

test('a clean room inside the caller\'s checkout is refused before anything is installed', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'published-check-inside-'));
  cpSync(join(FIXTURES, 'caller'), repo, { recursive: true });
  const before = registry.requests.length;
  const result = await runPublishedCheck({ repo, registry: registry.url, tempParent: repo });
  assert.equal(result.ok, false);
  assert.equal(result.checks.length, 1);
  assert.match(result.checks[0].detail, /inside the caller's checkout/);
  assert.equal(registry.requests.length, before);
});

test('a private caller has no published package, and says so rather than installing something', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'published-check-private-'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'cosyte-private-root', private: true }));
  const result = await runPublishedCheck({ repo, registry: registry.url, tempParent: tmpdir() });
  assert.equal(result.ok, false);
  assert.match(result.checks[0].detail, /"private": true/);
});
