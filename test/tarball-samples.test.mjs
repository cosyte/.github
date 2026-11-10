// `scripts/tarball-samples.mjs`: the release's samples gate. It packs the caller's tree with
// `npm pack`, installs THAT tarball into a clean directory that resolves nothing else, and runs
// every TypeScript and JavaScript sample on the package's documentation pages there, importing the
// package by its published name. A sample's `// => value` lines are assertions. A caller with no
// documentation directory, or no sample in it, skips, saying so by name.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { extractSamples, main, rewriteAssertions, samplePages } from '../scripts/tarball-samples.mjs';

/** Write `tree` (relative path to text) under a new directory. */
function lay(tree) {
  const root = mkdtempSync(join(tmpdir(), 'tarball-samples-'));
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const FENCE = '```';

test('every TypeScript and JavaScript block is a sample, and no-run and throws are read from its fence', () => {
  const samples = extractSamples(
    [
      '# Page',
      `${FENCE}ts`,
      'const a = 1;',
      FENCE,
      `${FENCE}js runnable throws`,
      'throw new Error("x");',
      FENCE,
      `${FENCE}ts no-run starts a server that never stops`,
      'listen();',
      FENCE,
      `${FENCE}sh`,
      'pnpm add x',
      FENCE,
      `${FENCE}tsx`,
      'const e = <b />;',
      FENCE,
      `${FENCE}mjs no-run`,
      'x();',
      FENCE,
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    samples.map(({ lang, line, throws, skip, extension }) => ({ lang, line, throws, skip, extension })),
    [
      { lang: 'ts', line: 3, throws: false, skip: null, extension: '.mts' },
      { lang: 'js', line: 6, throws: true, skip: null, extension: '.mjs' },
      { lang: 'ts', line: 9, throws: false, skip: 'starts a server that never stops', extension: '.mts' },
      { lang: 'tsx', line: 15, throws: false, skip: null, extension: '.tsx' },
      { lang: 'mjs', line: 18, throws: false, skip: '', extension: '.mjs' },
    ],
  );
  assert.equal(samples[0].code, 'const a = 1;');
});

test('a `// =>` line becomes a deep strict equality assertion, and other lines are left alone', () => {
  const { code, assertions } = rewriteAssertions('const n = add(1, 2);\n  n; // => 3\nlog(n);');
  assert.equal(assertions, 1);
  assert.equal(code, 'const n = add(1, 2);\n  __cosyteSampleAssert(n, 3);\nlog(n);');
});

test('the pages are every markdown file under the docs directory, the generated api/ folder left out', () => {
  const docs = lay({ 'intro.md': '', 'guides/use.mdx': '', 'api/index.md': '', 'api/x/y.md': '', 'notes.txt': '' });
  assert.deepEqual(samplePages(docs).map((file) => file.slice(docs.length + 1)), ['guides/use.mdx', 'intro.md']);
});

/** A tiny synthetic package with documentation pages, packed and installed for real by the CLI. */
function packageWith(page) {
  return lay({
    'package.json': `${JSON.stringify({ name: 'tarball-samples-fixture', version: '1.0.0', type: 'module', exports: { '.': './index.mjs' }, files: ['index.mjs'] }, null, 2)}\n`,
    'index.mjs': 'export const add = (a, b) => a + b;\nexport const fail = () => { throw new Error("refused"); };\n',
    'docs-content/guide.md': page,
    'docs-content/api/generated.md': `${FENCE}ts\nimport { missing } from "tarball-samples-fixture";\nmissing(); // => 1\n${FENCE}\n`,
  });
}

/** Run the CLI against `repo`. No registry is reachable: the fixture has no dependency to fetch. */
async function cli(repo, argv = []) {
  const out = [];
  const summary = join(repo, 'summary.md');
  const code = await main(['--repo', repo, '--registry', 'http://127.0.0.1:9', ...argv], {
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: mkdtempSync(join(tmpdir(), 'tarball-samples-temp-')) },
    out: (s) => out.push(s),
  });
  let written = '';
  try {
    written = readFileSync(summary, 'utf8');
  } catch {
    // none
  }
  return { code, out: out.join(''), summary: written };
}

test('the samples run against the installed tarball, by the package name, and pass', { timeout: 120_000 }, async () => {
  const repo = packageWith(
    [
      '# Guide',
      `${FENCE}js`,
      'import { add } from "tarball-samples-fixture";',
      'add(1, 2); // => 3',
      FENCE,
      `${FENCE}ts`,
      'import { add } from "tarball-samples-fixture";',
      'const total: number = add(2, 2);',
      'total; // => 4',
      `({ total }); // => { total: 4 }`,
      FENCE,
      `${FENCE}ts throws`,
      'import { fail } from "tarball-samples-fixture";',
      'fail();',
      FENCE,
      `${FENCE}ts no-run needs a network listener`,
      'listen();',
      FENCE,
      '',
    ].join('\n'),
  );
  const result = await cli(repo);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /^packed tarball-samples-fixture-1\.0\.0\.tgz$/m);
  assert.match(result.out, /^ran docs-content\/guide\.md:3$/m);
  assert.match(result.out, /^not run docs-content\/guide\.md:17: needs a network listener$/m);
  assert.match(result.out, /^samples gate: 3 sample\(s\) ran against the tarball, 1 not run, 0 failed$/m);
  assert.match(result.summary, /^### Samples against the packed tarball: pass$/m);
});

test('a sample whose value is wrong fails the gate, naming its page and line', { timeout: 120_000 }, async () => {
  const repo = packageWith(`# Guide\n\n${FENCE}js\nimport { add } from "tarball-samples-fixture";\nadd(1, 1); // => 3\n${FENCE}\n`);
  const result = await cli(repo);
  assert.equal(result.code, 1);
  assert.match(result.out, /^::error title=Sample failed against the tarball::docs-content\/guide\.md:4/m);
});

test('a sample that imports what the tarball does not ship fails, and a throws sample that runs clean fails', { timeout: 120_000 }, async () => {
  const missing = await cli(packageWith(`${FENCE}js\nimport { nothing } from "tarball-samples-fixture/deep";\n${FENCE}\n`));
  assert.equal(missing.code, 1);
  const clean = await cli(packageWith(`${FENCE}js throws\nimport { add } from "tarball-samples-fixture";\nadd(1, 1);\n${FENCE}\n`));
  assert.equal(clean.code, 1);
  assert.match(clean.out, /tagged throws and ran clean/);
});

test('a no-run sample with no reason fails, as the docs standard requires', { timeout: 120_000 }, async () => {
  const result = await cli(packageWith(`${FENCE}ts no-run\nlisten();\n${FENCE}\n`));
  assert.equal(result.code, 1);
  assert.match(result.out, /no-run with no reason/);
});

test('no docs directory, or no sample in it, skips by name and packs nothing', async () => {
  const bare = lay({ 'package.json': '{"name":"bare","version":"1.0.0"}\n' });
  const none = await cli(bare);
  assert.equal(none.code, 0);
  assert.match(none.out, /^samples gate skipped: bare has no docs-content\/ directory, so no sample runs against its tarball$/m);
  const prose = lay({ 'package.json': '{"name":"prose","version":"1.0.0"}\n', 'docs-content/intro.md': '# Only prose\n\n```sh\nls\n```\n' });
  const empty = await cli(prose);
  assert.equal(empty.code, 0);
  assert.match(empty.out, /^samples gate skipped: prose has no TypeScript or JavaScript sample under docs-content\/$/m);
  assert.doesNotMatch(empty.out, /^packed /m);
});

test('a docs directory can be named, and a name that leaves the repository is refused', async () => {
  const repo = lay({ 'package.json': '{"name":"named","version":"1.0.0"}\n', 'site/docs/a.md': '# none\n' });
  const named = await cli(repo, ['--docs-dir', 'site/docs']);
  assert.equal(named.code, 0);
  assert.match(named.out, /no TypeScript or JavaScript sample under site\/docs\//);
  assert.equal((await cli(repo, ['--docs-dir', '../elsewhere'])).code, 2);
  assert.equal((await cli(repo, ['--docs-dir', '/etc'])).code, 2);
});
