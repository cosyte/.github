// The CI caller fixture's own scripts (`test/fixtures/ci-caller/tool.mjs`), each shown failing on the
// hazard it stands for and passing without it. `self-check.yml`'s `systems` job runs `ci.yml` against
// the fixture on Linux, Windows and macOS and under Bun and Deno; a green run there means something
// only if each of these scripts goes red when its hazard is present, which is what this file proves.
// The two checkers the fixture runs (`cosyte-no-emdash` and `cosyte-phi-scan`) are replaced here by
// stubs, since this repository installs nothing; the `systems` run uses the real ones.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PLANTED,
  REFUSES,
  RUNS,
  carriageReturns,
  dashExpectation,
  filesUnder,
  judge,
  missingTargets,
  platformProblem,
  run,
  runtimeOf,
} from './fixtures/ci-caller/tool.mjs';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/ci-caller');
const GREETING = 'export const greeting = "hello from the CI caller fixture";\n';
const EXPORTS = { exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs', require: './dist/index.cjs' } } };

/** A throwaway package root holding `files`, a map of relative path to content. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'ci-caller-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** Run a verb with a log that is kept, on a system the runner agrees with. */
async function verb(name, root, overrides = {}) {
  const lines = [];
  const code = await run(name, {
    root,
    env: {},
    platform: 'linux',
    versions: { node: '24.0.0' },
    log: (line) => lines.push(line),
    ...overrides,
  });
  return { code, lines };
}

/**
 * A directory of stub checkers. The dash stub fails on an em dash in its stdin; the PHI stub fails on a
 * dashed SSN shape in any file it is named. `brokenDash` and `brokenPhi` make each one pass everything,
 * and `refusingDash` makes the dash stub fail everything, as the real one does on macOS.
 */
function stubs({ brokenDash = false, refusingDash = false, brokenPhi = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-caller-bin-'));
  writeFileSync(
    join(dir, 'cosyte-no-emdash.js'),
    brokenDash || refusingDash
      ? `process.exit(${refusingDash ? 1 : 0});\n`
      : 'let t = "";\nprocess.stdin.on("data", (c) => (t += c)).on("end", () => process.exit(t.includes(String.fromCodePoint(0x2014)) ? 1 : 0));\n',
  );
  writeFileSync(
    join(dir, 'cosyte-phi-scan.js'),
    brokenPhi
      ? 'process.exit(0);\n'
      : [
          'const fs = require("node:fs");',
          // Read relative to the working directory, as the real scanner does, and exit 2 (never 1) when
          // a named file cannot be read, so a missing plant can never pass for a found one.
          'try {',
          '  const hit = process.argv.slice(2).some((f) => /\\d{3}-\\d{2}-\\d{4}/.test(fs.readFileSync(f, "utf8")));',
          '  process.exit(hit ? 1 : 0);',
          '} catch {',
          '  process.exit(2);',
          '}',
          '',
        ].join('\n'),
  );
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}\n');
  return dir;
}

test('filesUnder lists every file with forward slashes, and skips what an install, a build or a plant writes', () => {
  const root = tree({
    'a.txt': 'a',
    'src/b.mjs': 'b',
    'node_modules/x/index.js': 'x',
    'dist/index.mjs': 'd',
    [`${PLANTED}/phi.txt`]: 'p',
  });
  assert.deepEqual(filesUnder(root), ['a.txt', 'src/b.mjs']);
});

test('format-check fails on a carriage return, naming the file, and passes LF only', async () => {
  const crlf = tree({ 'src/index.mjs': 'line one\r\nline two\r\n', 'README.md': 'ok\n' });
  assert.deepEqual(carriageReturns(crlf), ['src/index.mjs']);
  assert.deepEqual(await verb('format-check', crlf), { code: 1, lines: ['format-check: src/index.mjs holds a carriage return'] });

  const lf = tree({ 'src/index.mjs': 'line one\nline two\n', 'README.md': 'ok\n' });
  assert.deepEqual(await verb('format-check', lf), { code: 0, lines: ['format-check: 2 files, LF line endings only'] });
});

test('the fixture\'s line endings are decided by the checkout, not by this repository\'s eol=lf', () => {
  // This repository's root `.gitattributes` is `* text=auto eol=lf`, and an `eol` attribute
  // overrides `core.autocrlf` and `core.eol`, so under it every checkout on every system writes LF
  // and `format-check` could never see a CRLF checkout. The fixture's own `.gitattributes` leaves
  // `eol` unspecified, so its files are `text=auto` and the checkout's git settings decide: on a
  // Windows leg, `format-check` then measures what `verify` set before it checked out.
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: FIXTURE, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split('\0').filter(Boolean);
  assert.ok(files.includes('tool.mjs') && files.includes('pnpm-lock.yaml'), files.join(', '));
  const attrs = spawnSync('git', ['check-attr', '-z', 'text', 'eol', '--', ...files], { cwd: FIXTURE, encoding: 'utf8' });
  assert.equal(attrs.status, 0, attrs.stderr);
  const fields = attrs.stdout.split('\0');
  const seen = {};
  for (let i = 0; i + 2 < fields.length; i += 3) seen[`${fields[i]} ${fields[i + 1]}`] = fields[i + 2];
  for (const file of files) {
    assert.equal(seen[`${file} text`], 'auto', `${file} is not text=auto`);
    assert.equal(seen[`${file} eol`], 'unspecified', `${file} has its eol fixed, so no checkout can make it CRLF`);
  }
});

test('runtimeOf names Bun, then Deno, then Node', () => {
  assert.equal(runtimeOf({ bun: '1.4.4', node: '24.3.0' }), 'bun 1.4.4');
  assert.equal(runtimeOf({ deno: '2.9.8', node: '24.2.0' }), 'deno 2.9.8');
  assert.equal(runtimeOf({ node: '24.0.0' }), 'node 24.0.0');
});

test('platformProblem holds each runner to its system, and says nothing off a runner', () => {
  assert.equal(platformProblem(undefined, 'win32'), null);
  assert.equal(platformProblem('Linux', 'linux'), null);
  assert.equal(platformProblem('Windows', 'win32'), null);
  assert.equal(platformProblem('macOS', 'darwin'), null);
  assert.equal(platformProblem('Windows', 'linux'), 'RUNNER_OS is Windows but process.platform is linux');
  assert.equal(platformProblem('Plan9', 'linux'), 'RUNNER_OS is Plan9, which this fixture does not know');
});

test('test passes on the system the runner names, and fails on another one or on a broken module', async () => {
  const good = tree({ 'src/index.mjs': GREETING });
  assert.deepEqual(await verb('test', good, { env: { RUNNER_OS: 'Linux' } }), {
    code: 0,
    lines: ['test: running under node 24.0.0 on linux', 'test: passed'],
  });
  assert.deepEqual(await verb('test', good, { env: { RUNNER_OS: 'macOS' } }), {
    code: 1,
    lines: ['test: running under node 24.0.0 on linux', 'test: RUNNER_OS is macOS but process.platform is linux'],
  });
  const broken = tree({ 'src/index.mjs': 'export const greeting = "something else";\n' });
  assert.deepEqual(await verb('test', broken, { versions: { deno: '2.9.8', node: '24.2.0' } }), {
    code: 1,
    lines: ['test: running under deno 2.9.8 on linux', 'test: src/index.mjs did not export the greeting'],
  });
});

test('build writes the three files the shared smoke step loads, and the CJS one carries the exports', async () => {
  const root = tree({ 'src/index.mjs': GREETING, 'src/index.d.ts': 'export declare const greeting: string;\n' });
  assert.deepEqual(await verb('build', root), { code: 0, lines: ['build: wrote dist/index.mjs, dist/index.cjs and dist/index.d.ts'] });
  // A second build over an existing dist/ succeeds too.
  assert.deepEqual(await verb('build', root), { code: 0, lines: ['build: wrote dist/index.mjs, dist/index.cjs and dist/index.d.ts'] });
  assert.equal(readFileSync(join(root, 'dist/index.mjs'), 'utf8'), GREETING);
  assert.equal(readFileSync(join(root, 'dist/index.d.ts'), 'utf8'), 'export declare const greeting: string;\n');
  assert.equal(
    readFileSync(join(root, 'dist/index.cjs'), 'utf8'),
    '"use strict";\nmodule.exports = {"greeting":"hello from the CI caller fixture"};\n',
  );
});

test('attw fails on each export target with no file, and passes when every one is on disk', async () => {
  const root = tree({ 'package.json': JSON.stringify(EXPORTS), 'dist/index.mjs': '', 'dist/index.d.ts': '' });
  assert.deepEqual(missingTargets(root, EXPORTS), ['./dist/index.cjs']);
  assert.deepEqual(await verb('attw', root), { code: 1, lines: ['attw: ./dist/index.cjs is in the exports map but not on disk'] });
  writeFileSync(join(root, 'dist/index.cjs'), '');
  assert.deepEqual(await verb('attw', root), { code: 0, lines: ['attw: every export target is on disk'] });
});

test('judge wants 0 on the clean input and 1 on the planted one by default, and nothing else', () => {
  assert.deepEqual(judge('x', 0, 1), []);
  assert.deepEqual(judge('x', 1, 1), ['x exited 1 on the clean input, not 0']);
  assert.deepEqual(judge('x', 0, 0), ['x exited 0 on the planted input, not 1, so its clean verdict proves nothing']);
  assert.deepEqual(judge('x', 2, null), [
    'x exited 2 on the clean input, not 0',
    'x exited null on the planted input, not 1, so its clean verdict proves nothing',
  ]);
});

test('judge holds a checker that cannot run to refusing every input', () => {
  assert.deepEqual(judge('x', 1, 1, REFUSES), []);
  assert.deepEqual(judge('x', 0, 1, REFUSES), ['x exited 0 on the clean input, not 1']);
  assert.deepEqual(judge('x', 1, 0, REFUSES), ['x exited 0 on the planted input, not 1, so its clean verdict proves nothing']);
});

test('the dash checker must refuse on macOS and run everywhere else', () => {
  assert.equal(dashExpectation('darwin'), REFUSES);
  assert.equal(dashExpectation('linux'), RUNS);
  assert.equal(dashExpectation('win32'), RUNS);
});

test('lint passes clean text and finds the planted dash, and fails if either answer is wrong', async () => {
  const clean = tree({ 'README.md': 'a plain - hyphen\n' });
  const ok = await verb('lint', clean, { binDir: stubs() });
  assert.deepEqual(ok, {
    code: 0,
    lines: [
      'lint: the next run is fed a planted em dash, and must find it',
      'lint: the dash checker passed clean text and found a planted dash',
    ],
  });

  const dashed = tree({ 'README.md': `a ${String.fromCodePoint(0x2014)} dash\n` });
  const red = await verb('lint', dashed, { binDir: stubs() });
  assert.equal(red.code, 1);
  assert.equal(red.lines.at(-1), 'lint: cosyte-no-emdash exited 1 on the clean input, not 0');

  // On macOS a checker that refuses everything is the expected answer, and one that runs is not.
  const refusing = stubs({ refusingDash: true });
  assert.deepEqual(await verb('lint', clean, { binDir: refusing, platform: 'darwin' }), {
    code: 0,
    lines: [
      'lint: the next run is fed a planted em dash, and must find it',
      'lint: on macOS the dash checker needs GNU grep (-P), which the runner lacks, so it must refuse every input',
      'lint: if it passes the clean input here, it now runs on macOS and this expectation is out of date',
      'lint: the dash checker refused on macOS rather than passing',
    ],
  });
  const runsOnMac = await verb('lint', clean, { binDir: stubs(), platform: 'darwin' });
  assert.equal(runsOnMac.code, 1);
  assert.equal(runsOnMac.lines.at(-1), 'lint: cosyte-no-emdash exited 0 on the clean input, not 1');
  const refusesOnLinux = await verb('lint', clean, { binDir: refusing });
  assert.equal(refusesOnLinux.code, 1);
  assert.equal(refusesOnLinux.lines.at(-1), 'lint: cosyte-no-emdash exited 1 on the clean input, not 0');

  const blind = await verb('lint', clean, { binDir: stubs({ brokenDash: true }) });
  assert.equal(blind.code, 1);
  assert.equal(blind.lines.at(-1), 'lint: cosyte-no-emdash exited 0 on the planted input, not 1, so its clean verdict proves nothing');
});

test('phi-scan passes the tree and finds the planted SSN shape, removes the plant, and fails if either answer is wrong', async () => {
  // A plant directory left behind by an interrupted run is reused, not refused.
  const root = tree({ 'README.md': 'nothing here\n', [`${PLANTED}/stale.txt`]: 'left behind\n' });
  const ok = await verb('phi-scan', root, { binDir: stubs() });
  assert.deepEqual(ok, {
    code: 0,
    lines: [
      'phi-scan: the next run reads a planted, synthetic SSN shape, and must find it',
      'phi-scan: the PHI scanner passed the fixture and found a planted SSN shape',
    ],
  });
  assert.equal(existsSync(join(root, PLANTED)), false, 'the planted input is removed');

  const blind = await verb('phi-scan', root, { binDir: stubs({ brokenPhi: true }) });
  assert.equal(blind.code, 1);
  assert.equal(blind.lines.at(-1), 'phi-scan: cosyte-phi-scan exited 0 on the planted input, not 1, so its clean verdict proves nothing');
  assert.equal(existsSync(join(root, PLANTED)), false, 'the planted input is removed after a failure too');
});

test('an unknown verb is refused with the usage line', async () => {
  assert.deepEqual(await verb('nope', FIXTURE), { code: 2, lines: ['usage: node tool.mjs <format-check|lint|phi-scan|test|build|attw>, not nope'] });
});

test('run from the command line, the fixture passes its own test and its own format check', () => {
  const env = { ...process.env };
  delete env.RUNNER_OS;
  for (const name of ['test', 'format-check']) {
    const result = spawnSync(process.execPath, ['tool.mjs', name], { cwd: FIXTURE, encoding: 'utf8', env });
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
  }
  const refused = spawnSync(process.execPath, ['tool.mjs', 'nope'], { cwd: FIXTURE, encoding: 'utf8' });
  assert.equal(refused.status, 2);
});

test('a checker\'s own report reaches the job log, so a red can be read', () => {
  // The installed layout, with a stub that speaks, and the fixture's tool copied beside it.
  const root = tree({
    'tool.mjs': readFileSync(join(FIXTURE, 'tool.mjs'), 'utf8'),
    'README.md': 'clean\n',
    'node_modules/@cosyte/script-utils/bin/cosyte-no-emdash.js': [
      'let t = "";',
      'process.stdin.on("data", (c) => (t += c)).on("end", () => {',
      '  console.log(`stub dash checker: ${t.length} characters`);',
      '  process.exit(t.includes(String.fromCodePoint(0x2014)) ? 1 : 0);',
      '});',
      '',
    ].join('\n'),
    'node_modules/@cosyte/script-utils/bin/package.json': '{"type":"commonjs"}\n',
  });
  const result = spawnSync(process.execPath, ['tool.mjs', 'lint'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^stub dash checker: \d+ characters$/m);
  assert.match(result.stdout, /^stub dash checker: 6 characters$/m, 'the planted line is "a <dash> b" and a newline');
});
