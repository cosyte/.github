// `scripts/mutation-shards.mjs`: the merge at the end of the sharded weekly mutation run. Each shard
// of `weekly-mutation.yml` leaves `<package>/reports/mutation/shard-<k>-of-<n>.json` for every
// package its command ran in; the merge joins each package's shards into the one
// `reports/mutation/mutation.json` that `cosyte-ratchet` reads, and refuses a package missing a
// shard, a file reported by two shards, and a run that left no shard report at all.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { groupShardReports, main, mergeReports, shardReportName } from '../scripts/mutation-shards.mjs';

/** A shard report holding `files`, each with mutants of the given statuses. */
const report = (files) => ({
  schemaVersion: '2',
  thresholds: { high: 100, low: 90 },
  projectRoot: '/work',
  files: Object.fromEntries(
    Object.entries(files).map(([name, statuses]) => [
      name,
      { language: 'typescript', source: 'export {};\n', mutants: statuses.map((status, i) => ({ id: `${name}-${i}`, mutatorName: 'BooleanLiteral', status, location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } })) },
    ]),
  ),
});

/** Write `tree` (relative path to JSON value or text) under a new directory. */
function lay(tree) {
  const root = mkdtempSync(join(tmpdir(), 'mutation-shards-'));
  for (const [path, value] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  }
  return root;
}

/** Run the CLI and capture what it printed. */
function run(argv, env = {}) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), env });
  return { code, out: out.join(''), err: err.join('') };
}

test('a shard report is named by its shard and the count', () => {
  assert.equal(shardReportName(3, 8), 'shard-3-of-8.json');
});

test('shard reports are grouped by the package directory they were written in', () => {
  const groups = groupShardReports(
    ['reports/mutation/shard-1-of-2.json', 'reports/mutation/shard-2-of-2.json', 'packages/a/reports/mutation/shard-2-of-2.json', 'shard-1-of-2.txt', 'reports/mutation/shard-1-of-3.json'],
    2,
  );
  assert.deepEqual([...groups.keys()].sort(), ['.', 'packages/a']);
  assert.deepEqual([...groups.get('.').keys()].sort(), [1, 2]);
  assert.deepEqual([...groups.get('packages/a').keys()], [2]);
});

test('the merge joins every shard\'s files and keeps the first report\'s header', () => {
  const merged = mergeReports([report({ 'src/a.ts': ['Killed', 'Survived'] }), report({ 'src/b.ts': ['Killed'] }), report({})]);
  assert.deepEqual(Object.keys(merged.files).sort(), ['src/a.ts', 'src/b.ts']);
  assert.equal(merged.schemaVersion, '2');
  assert.equal(merged.files['src/a.ts'].mutants.length, 2);
});

test('the merge refuses one file reported by two shards, and a report with no files', () => {
  assert.throws(() => mergeReports([report({ 'src/a.ts': ['Killed'] }), report({ 'src/a.ts': ['Killed'] })]), /src\/a\.ts is in more than one shard/);
  assert.throws(() => mergeReports([{ schemaVersion: '2' }]), /has no files/);
});

test('the CLI writes each package\'s mutation.json beside its shard reports, and the shard notes', () => {
  const shards = lay({
    'reports/mutation/shard-1-of-2.json': report({ 'src/a.ts': ['Killed'] }),
    'reports/mutation/shard-2-of-2.json': report({ 'src/b.ts': ['Survived'] }),
    'packages/x/reports/mutation/shard-1-of-2.json': report({}),
    'packages/x/reports/mutation/shard-2-of-2.json': report({ 'src/c.ts': ['Killed'] }),
    'shard-1-of-2.txt': 'shard-1-of-2: incremental, 2 result file(s) restored from key-1\n',
    'shard-2-of-2.txt': 'shard-2-of-2: full, no earlier results for this shard\n',
  });
  const into = mkdtempSync(join(tmpdir(), 'mutation-into-'));
  const summary = join(into, 'summary.md');
  const result = run(['merge', '--shards', shards, '--count', '2', '--into', into], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(result.code, 0, result.err);
  const root = JSON.parse(readFileSync(join(into, 'reports/mutation/mutation.json'), 'utf8'));
  assert.deepEqual(Object.keys(root.files).sort(), ['src/a.ts', 'src/b.ts']);
  const x = JSON.parse(readFileSync(join(into, 'packages/x/reports/mutation/mutation.json'), 'utf8'));
  assert.deepEqual(Object.keys(x.files), ['src/c.ts']);
  assert.equal(
    readFileSync(join(into, 'reports/mutation/shards.txt'), 'utf8'),
    'shard-1-of-2: incremental, 2 result file(s) restored from key-1\nshard-2-of-2: full, no earlier results for this shard\n',
  );
  assert.match(result.out, /^\.: 2 shard\(s\), 2 file\(s\), 2 mutant\(s\)$/m);
  assert.match(readFileSync(summary, 'utf8'), /^### Mutation shards merged$/m);
});

test('the CLI refuses a package missing a shard, naming it, and writes nothing for it', () => {
  const shards = lay({ 'reports/mutation/shard-1-of-3.json': report({ 'src/a.ts': ['Killed'] }), 'reports/mutation/shard-3-of-3.json': report({}) });
  const into = mkdtempSync(join(tmpdir(), 'mutation-into-'));
  const result = run(['merge', '--shards', shards, '--count', '3', '--into', into]);
  assert.equal(result.code, 1);
  assert.match(result.err, /^::error::\. has no report from shard 2 of 3/m);
  assert.equal(existsSync(join(into, 'reports/mutation/mutation.json')), false);
});

test('the CLI refuses a run that left no shard report at all, and says what that means', () => {
  const shards = lay({ 'reports/mutation/mutation.json': report({ 'src/a.ts': ['Killed'] }) });
  const result = run(['merge', '--shards', shards, '--count', '2', '--into', mkdtempSync(join(tmpdir(), 'mutation-into-'))]);
  assert.equal(result.code, 1);
  assert.match(result.err, /no shard report of 2 shard\(s\) was found/);
});

test('the CLI refuses arguments it cannot read and a report that is not JSON, with exit 2', () => {
  assert.equal(run(['merge', '--count', '2']).code, 2);
  assert.equal(run(['split', '--shards', '.', '--count', '2', '--into', '.']).code, 2);
  for (const count of ['0', '17', 'two', '']) {
    assert.equal(run(['merge', '--shards', '.', '--count', count, '--into', '.']).code, 2, count);
  }
  const shards = lay({ 'reports/mutation/shard-1-of-1.json': '{not json' });
  const result = run(['merge', '--shards', shards, '--count', '1', '--into', mkdtempSync(join(tmpdir(), 'mutation-into-'))]);
  assert.equal(result.code, 2);
  assert.match(result.err, /shard-1-of-1\.json could not be read/);
});
