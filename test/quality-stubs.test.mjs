// The stand-ins for `cosyte-mutate` and `cosyte-ratchet` in `test/fixtures/quality-stubs/`, which
// the fixture under `test/fixtures/ci-caller/` installs so `self-check.yml` can run the testing
// standard's jobs on a real runner before the real tools are on npm.
//
// WHAT A STAND-IN PROVES, AND WHY EACH ONE REFUSES SO MUCH. A stand-in that accepted anything would
// make a green self-check run mean nothing. So each one accepts exactly the command lines the real
// tool accepts for the calls the shared jobs make, refuses the rest with exit 2 as the real one does,
// and checks what a job must have done before it ran: that the base ref has a merge base with HEAD
// (the checkout fetched enough history), that the reports the real tool would read are on disk (the
// steps ran in order, in the same directory), and that the floor file is there. It refuses `raise`
// outright, since no shared job may move a floor. It does not mutate, measure or judge anything.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const STUBS = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/quality-stubs');

/** A git repository with a floor file, a `main` with one commit and a branch with one more. */
function repo({ floor = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quality-stubs-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  if (floor) writeFileSync(join(root, 'quality-floor.json'), '{ "packages": { ".": { "mutation": 50 } } }\n');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'change');
  writeFileSync(join(root, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'change');
  return { root, base: git('rev-parse', 'main') };
}

/** Run a stand-in's bin in `cwd`. */
function stub(name, args, cwd) {
  return spawnSync(process.execPath, [join(STUBS, `${name}.mjs`), ...args], { cwd, encoding: 'utf8' });
}

/** Write the coverage reports a coverage run leaves. */
function coverage(root) {
  mkdirSync(join(root, 'coverage'), { recursive: true });
  writeFileSync(join(root, 'coverage/coverage-summary.json'), '{}\n');
}

test('the package names both bins, and each bin is a file', () => {
  const manifest = JSON.parse(readFileSync(join(STUBS, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  for (const file of Object.values(manifest.bin)) assert.ok(existsSync(join(STUBS, file)), file);
});

test('cosyte-mutate changed checks the merge base and writes an empty changed-files report', () => {
  const { root, base } = repo();
  const run = stub('cosyte-mutate', ['changed', '--base', 'main'], root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^cosyte-mutate changed \\(a stand-in\\): against main, merge base ${base.slice(0, 12)}; it mutates nothing$`, 'm'));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'reports/mutation/changed.json'), 'utf8')).files, {});
});

test('cosyte-mutate full writes the full report', () => {
  const { root } = repo();
  const run = stub('cosyte-mutate', ['full'], root);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(root, 'reports/mutation/mutation.json')));
});

test('cosyte-mutate refuses what the real one refuses, and a base with no merge base', () => {
  const { root } = repo();
  for (const args of [[], ['part'], ['changed'], ['full', '--base', 'main'], ['changed', '--base'], ['changed', '--base', 'main', '--other', 'x']]) {
    const run = stub('cosyte-mutate', args, root);
    assert.equal(run.status, 2, JSON.stringify(args));
  }
  const missing = stub('cosyte-mutate', ['changed', '--base', 'origin/nowhere'], root);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no merge base between origin\/nowhere and HEAD/);
  assert.equal(existsSync(join(root, 'reports/mutation/changed.json')), false, 'a refusal writes no report');
});

test('cosyte-ratchet check passes when every report the call needs is there', () => {
  const { root } = repo();
  coverage(root);
  assert.equal(stub('cosyte-ratchet', ['check', '--skip', 'mutation', '--base', 'main'], root).status, 0);
  assert.equal(stub('cosyte-ratchet', ['check', '--skip', 'mutation'], root).status, 0);
  stub('cosyte-mutate', ['changed', '--base', 'main'], root);
  const changed = stub('cosyte-ratchet', ['check', '--skip', 'coverage', '--base', 'main'], root);
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /^cosyte-ratchet check \(a stand-in\): quality-floor\.json, 1 package\(s\); it judges nothing$/m);
  assert.match(changed.stdout, /^ {2}read reports\/mutation\/changed\.json$/m);
  stub('cosyte-mutate', ['full'], root);
  const full = stub('cosyte-ratchet', ['check', '--skip', 'coverage'], root);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /^ {2}read reports\/mutation\/mutation\.json$/m);
});

test('cosyte-ratchet check refuses when a report the call needs is missing, so a step out of order is red', () => {
  const { root } = repo();
  const noCoverage = stub('cosyte-ratchet', ['check', '--skip', 'mutation'], root);
  assert.equal(noCoverage.status, 2);
  assert.match(noCoverage.stderr, /coverage\/coverage-summary\.json is missing/);
  assert.equal(stub('cosyte-ratchet', ['check', '--skip', 'coverage', '--base', 'main'], root).status, 2);
  assert.equal(stub('cosyte-ratchet', ['check', '--skip', 'coverage'], root).status, 2);
  const noFloor = repo({ floor: false }).root;
  coverage(noFloor);
  const floorless = stub('cosyte-ratchet', ['check', '--skip', 'mutation'], noFloor);
  assert.equal(floorless.status, 2);
  assert.match(floorless.stderr, /quality-floor\.json is missing/);
});

test('cosyte-ratchet refuses raise, any other command and any unknown flag', () => {
  const { root } = repo();
  coverage(root);
  const raise = stub('cosyte-ratchet', ['raise', '--skip', 'mutation'], root);
  assert.equal(raise.status, 2);
  assert.match(raise.stderr, /no shared job may raise a floor/);
  for (const args of [[], ['judge'], ['check', '--skip', 'speed'], ['check', '--base'], ['check', '--fast', 'x'], ['check', '--skip', 'mutation', '--base', 'origin/nowhere']]) {
    assert.equal(stub('cosyte-ratchet', args, root).status, 2, JSON.stringify(args));
  }
});
