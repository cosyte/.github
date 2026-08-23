// Tests for scripts/docs-content-check.mjs, the opt-in gate that refuses a `docs-content/` tree
// whose package-internal links, images or sidebar document ids resolve to nothing.
//
// WHAT THESE TESTS ARE FOR, said once so the individual cases read against it. Zero findings over a
// clean tree proves nothing: a gate that never runs also reports zero. So every "passes" case here
// is paired with a "fails" one over the same shape, and the pair is what establishes that the check
// is doing anything at all. The red control is `THE ORIGIN INCIDENT` below.
//
// Like `test/changelog-check.test.mjs`, `run()` drives the REAL entry point over REAL files in a
// temp directory rather than calling an exported predicate: the argument parsing, the paths and the
// EXIT CODE are what `.github/workflows/ci.yml` depends on, and a unit test of the predicate alone
// proves none of them.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyTarget,
  collectSidebar,
  declaredId,
  extractTargets,
  linkCandidates,
  resolveWithin,
  toPosix,
} from '../scripts/docs-content-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/docs-content-check.mjs');

/** A marker for `makeTree`: create a DIRECTORY at this path rather than a file. */
const DIRECTORY = Symbol('directory');

/** A marker for `makeTree`: create a symbolic link at this path. */
const link = (target) => ({ symlink: target });

/**
 * A throwaway caller workspace. Keys are paths relative to the WORKSPACE ROOT, which stands in for
 * `$GITHUB_WORKSPACE`, so a fixture can put files beside `docs-content/` as a real caller does.
 */
function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-content-check-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    if (content === DIRECTORY) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (content && typeof content === 'object' && 'symlink' in content) {
      symlinkSync(content.symlink, target);
      continue;
    }
    writeFileSync(target, content);
  }
  return dir;
}

/** Run the CLI exactly as ci.yml does, and return { code, output }. */
function run(dir) {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, '--repo', dir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/** The one-line sidebar most fixtures need. */
const sidebar = (value) => `${JSON.stringify(value, null, 2)}\n`;

const POSIX = process.platform !== 'win32';

// ---------------------------------------------------------------------------
// HAPPY PATH
// ---------------------------------------------------------------------------

test('a tree where everything resolves exits zero and prints what it checked', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro', 'guides/quickstart'] }),
    'docs-content/intro.md': '# Intro\n\n[Quickstart](./guides/quickstart)\n\n![Logo](./img/logo.svg)\n',
    'docs-content/guides/quickstart.md': '# Quickstart\n\n[Back](../intro)\n',
    'docs-content/img/logo.svg': '<svg/>\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  assert.match(output, /Checked 2 file\(s\), 2 link\(s\), 1 image\(s\) and 2 document id\(s\)/);
  assert.match(output, /No blocking findings/);
  rmSync(dir, { recursive: true, force: true });
});

test('a tree with a sidebar and NO links at all reports zero links rather than treating it as an error', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\nNo links here at all.\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  assert.match(output, /Checked 1 file\(s\), 0 link\(s\), 0 image\(s\) and 1 document id\(s\)/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// THE RED CONTROL, AND THE SAME TREE REPAIRED
// ---------------------------------------------------------------------------

// THE ORIGIN INCIDENT, reproduced as a fixture. `x12` merged and released `docs-content/` carrying
// a link like this one; every check it had was green and `cosyte/docs` was red for eight days.
test('THE DEFECT: a package-internal link that resolves to nothing exits non-zero, naming everything', () => {
  const files = {
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\nSee [Troubleshooting](./missing) for more.\n',
  };
  const dir = makeTree(files);
  const { code, output } = run(dir);
  assert.equal(code, 1, 'a broken package-internal link must red the pull request that introduces it');
  assert.match(output, /B1 docs-content\/intro\.md:3/, 'the file and the 1-based line');
  assert.match(output, /\.\/missing/, 'the raw target as written');
  for (const candidate of ['missing', 'missing.md', 'missing.mdx', 'missing/index.md', 'missing/index.mdx']) {
    assert.ok(output.includes(`docs-content/${candidate}`), `it must say it looked for ${candidate}`);
  }
  rmSync(dir, { recursive: true, force: true });

  // THE GREEN CONTROL. The same tree with the target added, and nothing else changed.
  const repaired = makeTree({ ...files, 'docs-content/missing.md': '# Troubleshooting\n' });
  const second = run(repaired);
  assert.equal(second.code, 0, second.output);
  rmSync(repaired, { recursive: true, force: true });
});

test('two blocking findings in one tree are BOTH printed, never stopping at the first', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\n[One](./gone-a)\n\n[Two](./gone-b)\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 1);
  assert.match(output, /BLOCKING findings \(2\)/);
  assert.match(output, /\.\/gone-a/);
  assert.match(output, /\.\/gone-b/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// RULE 6: CASE, SEPARATORS, AND WHAT KIND OF OBJECT RESOLVES A LINK
// ---------------------------------------------------------------------------

// The site builds on a case-SENSITIVE filesystem, and the host job's `os` axis is caller-supplied.
// An `existsSync` lookup would resolve this on a macOS or Windows cell and refuse it on Linux: two
// verdicts for one tree. The comparison is the checker's own, against the listing, so every cell
// agrees.
test('a target matching a file only in letter case is UNRESOLVED, on every matrix cell', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\n[Troubleshooting](./Troubleshooting)\n',
    'docs-content/troubleshooting.md': '# Troubleshooting\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, output);
  assert.match(output, /B1 docs-content\/intro\.md:3/);
  rmSync(dir, { recursive: true, force: true });
});

// SEPARATORS, and this is the half the spec's own wording gets backwards, recorded in notes.md.
// Normalizing the LISTING side would be a false GREEN on POSIX: a file whose NAME literally
// contains a backslash is one path segment, the site 404s on `guides/intro`, and normalizing the
// name to `guides/intro.md` would resolve the link against a file that cannot serve it. Only paths
// the CHECKER constructs are normalized, and a Windows filename cannot contain a separator, so
// nothing is lost.
test('a NAME containing a backslash is never separator-normalized, so the link that misses it reds', {
  skip: POSIX ? false : 'a Windows filename cannot contain a separator',
}, () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\n[Intro](./guides/intro)\n',
    'docs-content/guides\\intro.md': '# Extracted from a Windows-authored zip\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, 'the site cannot serve guides/intro here, so this must not be green');
  assert.match(output, /B1 docs-content\/intro\.md:3/);
  rmSync(dir, { recursive: true, force: true });
});

// The other half of the same claim, as a CONSTRUCTED-PATH assertion, which is the only form it can
// take: a candidate the checker builds is `/`-separated on every platform, so no cell reds
// `guides/intro` because `node:path` would have joined it with a backslash.
test('every path the checker CONSTRUCTS is `/`-separated, on every platform', () => {
  assert.equal(toPosix(join('guides', 'intro.md')), 'guides/intro.md');
  assert.equal(toPosix('guides\\intro.md'), 'guides/intro.md');
  assert.deepEqual(linkCandidates('guides/intro'), [
    'guides/intro',
    'guides/intro.md',
    'guides/intro.mdx',
    'guides/intro/index.md',
    'guides/intro/index.mdx',
  ]);
});

test('THE DIRECTORY TRIO: a bare directory resolves nothing, its index.md does, and an image needs the exact file', () => {
  const base = {
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\n[Reference](./reference)\n',
    'docs-content/reference/codes.md': '# Codes\n',
  };

  // 1. The only match is a DIRECTORY of that name. A directory is not a document.
  const red = makeTree(base);
  const first = run(red);
  assert.equal(first.code, 1, first.output);
  assert.match(first.output, /B1 docs-content\/intro\.md:3/);
  for (const candidate of ['reference', 'reference.md', 'reference.mdx', 'reference/index.md', 'reference/index.mdx']) {
    assert.ok(first.output.includes(`docs-content/${candidate}`));
  }
  rmSync(red, { recursive: true, force: true });

  // 2. The same directory carrying index.md. It resolves through the `<t>/index.md` SPELLING, which
  // the five-way list already contains, and never because a directory exists.
  const green = makeTree({ ...base, 'docs-content/reference/index.md': '# Reference\n' });
  const second = run(green);
  assert.equal(second.code, 0, second.output);
  rmSync(green, { recursive: true, force: true });

  // 3. An IMAGE destination standing on a directory. No build step invents an extension for an
  // asset, so the exact path must be a regular file.
  const image = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\n![Segment layout](./diagrams/envelope.svg)\n',
    'docs-content/diagrams/envelope.svg': DIRECTORY,
  });
  const third = run(image);
  assert.equal(third.code, 1, third.output);
  assert.match(third.output, /B5 docs-content\/intro\.md:3/);
  rmSync(image, { recursive: true, force: true });
});

test('a missing image is B5, and neither an invented extension nor a directory resolves it', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\n![Segment layout](./diagrams/envelope.svg)\n',
    'docs-content/diagrams/envelope.svg.md': '# not an asset\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, output);
  assert.match(output, /B5 docs-content\/intro\.md:3/);
  assert.match(output, /envelope\.svg/);
  rmSync(dir, { recursive: true, force: true });
});

// A trailing slash on a package-internal target. The candidates are built from the resolved path
// with empty segments dropped, so `./reference/` reaches `reference/index.md` rather than
// `reference//index.md`, which matches no listing entry and would red a link the site serves.
test('a trailing slash on a package-internal target does not red a link the site serves', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\n[Reference](./reference/)\n',
    'docs-content/reference/index.md': '# Reference\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// RULES 1 TO 5: WHAT MUST NOT FAIL
// ---------------------------------------------------------------------------

test('a fragment, a query and a bare name all resolve to the part that names a file', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md':
      '# Intro\n\n[A](./troubleshooting#phi)\n\n[B](./quickstart?x=1)\n\n[C](intro)\n',
    'docs-content/troubleshooting.md': '# T\n',
    'docs-content/quickstart.md': '# Q\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(classifyTarget('./troubleshooting#phi', 'intro.md'), { class: 'internal', path: 'troubleshooting' });
  assert.deepEqual(classifyTarget('./quickstart?x=1', 'intro.md'), { class: 'internal', path: 'quickstart' });
  assert.deepEqual(classifyTarget('intro', 'guides/a.md'), { class: 'internal', path: 'guides/intro' });
});

test('THE THREE FALSE-RED PARSE ROUTES: a malformed escape, a title, and an angle-bracket destination', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md':
      '# Intro\n\n[Promo](./promos/50%off)\n\n[Guide](./quickstart "How to")\n\n[Pointy](<./my guide.md>)\n',
    'docs-content/promos/50%off.md': '# Promo\n',
    'docs-content/quickstart.md': '# Q\n',
    'docs-content/my guide.md': '# My guide\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  rmSync(dir, { recursive: true, force: true });

  // The decode falls back to the RAW text rather than throwing, and a decode failure is never a
  // finding of its own.
  assert.deepEqual(classifyTarget('./promos/50%off', 'intro.md'), { class: 'internal', path: 'promos/50%off' });
  assert.deepEqual(extractTargets('[Guide](./quickstart "How to")\n'), [
    { line: 1, raw: './quickstart', kind: 'link' },
  ]);
  assert.deepEqual(extractTargets('[Guide](<./my guide.md>)\n'), [
    { line: 1, raw: './my guide.md', kind: 'link' },
  ]);
  // A balanced pair of parentheses inside a bare destination is part of the destination. Cutting at
  // the first `)` would yield `./codes/(837` and red a link the site serves.
  assert.deepEqual(extractTargets('[Codes](./codes/(837).md)\n'), [
    { line: 1, raw: './codes/(837).md', kind: 'link' },
  ]);
});

test('the four NOT-BLOCKING classes are reported and fail nothing, while `837:institutional` reaches rule 6', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['x12/intro'] }),
    'docs-content/x12/intro.md':
      '# Intro\n\n[Anchor](#segments-outside-a-transaction)\n\n[External](https://example.com/x)\n\n' +
      '[Mail](mailto:x@y)\n\n[Absolute](/x12/quickstart)\n\n[Cross](../../hl7/intro)\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  assert.match(output, /anchor: docs-content\/x12\/intro\.md:3/);
  assert.match(output, /external: docs-content\/x12\/intro\.md:5/);
  assert.match(output, /site-absolute: docs-content\/x12\/intro\.md:9/);
  assert.match(output, /cross-package: docs-content\/x12\/intro\.md:11/);
  rmSync(dir, { recursive: true, force: true });

  // A scheme must BEGIN WITH A LETTER per RFC 3986 section 3.1, so this is not one. In an X12
  // corpus that is the right answer: `837:institutional` is a document, not a protocol.
  assert.deepEqual(classifyTarget('837:institutional', 'intro.md'), {
    class: 'internal',
    path: '837:institutional',
  });
  const blocked = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\n[Institutional](837:institutional)\n',
  });
  const second = run(blocked);
  assert.equal(second.code, 1, second.output);
  assert.match(second.output, /B1 docs-content\/intro\.md:3/);
  rmSync(blocked, { recursive: true, force: true });
});

test('a link reference DEFINITION is checked once and its USE is not a second target', () => {
  assert.deepEqual(extractTargets('[label]: ./quickstart\n\n[see this][label] and [again][label]\n'), [
    { line: 1, raw: './quickstart', kind: 'definition' },
  ]);
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\n[see this][label]\n\n[label]: ./gone\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, 'the definition is the thing that carries a target');
  assert.match(output, /BLOCKING findings \(1\)/, 'and it is checked ONCE');
  assert.match(output, /B1 docs-content\/intro\.md:5/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CODE IS NOT A LINK, IN EVERY SHAPE A DOCUMENT CAN SPELL IT
// ---------------------------------------------------------------------------

const SAMPLE = 'const out = handlers[0](event);';

test('a code span, a fenced block under any info string, and an indented block yield NO target', () => {
  const document = [
    '# Intro',
    '',
    `Inline: \`${SAMPLE}\``,
    '',
    '```ts runnable',
    SAMPLE,
    '```',
    '',
    '~~~js',
    SAMPLE,
    '~~~',
    '',
    `    ${SAMPLE}`,
    '',
  ].join('\n');
  assert.deepEqual(extractTargets(document), [], 'a false red on a working sample is a defect of this gate');

  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': `${document}\n`,
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  assert.doesNotMatch(output, /event/);
  rmSync(dir, { recursive: true, force: true });
});

// A FENCE CLOSES ONLY ON A RUN AT LEAST AS LONG AS THE ONE THAT OPENED IT. A page fencing a
// markdown sample with FOUR backticks so the sample can hold a three-backtick fence is all code.
// Reading the inner three as the closer turns the next line into prose and reds a working sample.
test('a four-backtick fence is not closed by the three-backtick fence inside it', () => {
  const document = [
    '# How to write a fence',
    '',
    '````markdown',
    '```',
    SAMPLE,
    '```',
    '````',
    '',
  ].join('\n');
  assert.deepEqual(extractTargets(document), []);
});

// AND THE SAME RULE CUTS THE OTHER WAY. Indentation is measured from the CONTAINER'S content
// column, not from column zero, so this is a nested list and the link is a link. Reading it as an
// indented code block is how the Origin incident ships green through a compliant pull request.
test('a nested list item is NOT an indented code block, so its link is checked', () => {
  const document = ['- Parent topic', '    - Child topic, see [the guide](./missing)', ''].join('\n');
  assert.deepEqual(extractTargets(document), [{ line: 2, raw: './missing', kind: 'link' }]);

  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': `# Intro\n\n${document}\n`,
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, 'a link inside a nested list is a link');
  assert.match(output, /B1 docs-content\/intro\.md:4/);
  rmSync(dir, { recursive: true, force: true });
});

test('an indented line CONTINUING a paragraph is prose, not code', () => {
  assert.deepEqual(extractTargets('Some prose\n    continued with [a link](./gone)\n'), [
    { line: 2, raw: './gone', kind: 'link' },
  ]);
});

// ---------------------------------------------------------------------------
// DOCUMENT IDS
// ---------------------------------------------------------------------------

test('a sidebar id that equals no declared id is B2, a directory of that name included', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro', 'guides'] }),
    'docs-content/intro.md': '# Intro\n',
    'docs-content/guides/codes.md': '# Codes\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, output);
  assert.match(output, /B2 docs-content\/sidebars\.json/);
  assert.match(output, /guides/);
  assert.match(output, /declares the id/);
  rmSync(dir, { recursive: true, force: true });
});

test('A DECLARED id replaces the LAST path segment, quoted or not, trailing space or not', () => {
  for (const declaration of ['id: eight-thirty-seven', 'id: "eight-thirty-seven"', "id: 'eight-thirty-seven'", 'id: eight-thirty-seven ']) {
    const files = {
      'docs-content/guides/837.md': `---\n${declaration}\n---\n\n# 837\n`,
    };
    const green = makeTree({
      ...files,
      'docs-content/sidebars.json': sidebar({ docs: ['guides/eight-thirty-seven'] }),
    });
    const first = run(green);
    assert.equal(first.code, 0, `${declaration}: ${first.output}`);
    rmSync(green, { recursive: true, force: true });

    // The path-derived id is REPLACED, so the old spelling now resolves to nothing.
    const red = makeTree({ ...files, 'docs-content/sidebars.json': sidebar({ docs: ['guides/837'] }) });
    const second = run(red);
    assert.equal(second.code, 1, `${declaration}: guides/837 must not resolve once the id is declared`);
    assert.match(second.output, /B2 docs-content\/sidebars\.json/);
    rmSync(red, { recursive: true, force: true });
  }
});

test('an UNQUOTED NUMERIC id is a value, not a type error', () => {
  const files = { 'docs-content/guides/institutional.md': '---\nid: 837\n---\n\n# 837\n' };
  const green = makeTree({ ...files, 'docs-content/sidebars.json': sidebar({ docs: ['guides/837'] }) });
  const first = run(green);
  assert.equal(first.code, 0, first.output);
  rmSync(green, { recursive: true, force: true });

  const red = makeTree({ ...files, 'docs-content/sidebars.json': sidebar({ docs: ['guides/institutional'] }) });
  const second = run(red);
  assert.equal(second.code, 1, second.output);
  rmSync(red, { recursive: true, force: true });
});

test('a BARE `id:` declares nothing, the path derivation stands, and nothing reds', () => {
  assert.deepEqual(declaredId('---\nid:\n---\n'), { id: null, malformed: null });
  assert.deepEqual(declaredId('---\nid:   \n---\n'), { id: null, malformed: null });
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['guides/institutional'] }),
    'docs-content/guides/institutional.md': '---\nid:\ntitle: Institutional\n---\n\n# Institutional\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  rmSync(dir, { recursive: true, force: true });
});

// THE `<id>/index.md` FALLBACK RESOLVES ONLY WHERE THE INDEX FILE DECLARES NO ID OF ITS OWN, which
// is the case it exists for. Where it DOES declare one, the tree declares THAT id and not this
// path, and resolving anyway would green a dangling entry against paths alone, which is the whole
// class B2 exists to catch.
test('the `<id>/index.md` fallback does not green an id the tree does not declare', () => {
  const red = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['guides'] }),
    'docs-content/guides/index.md': '---\nid: overview\n---\n\n# Overview\n',
  });
  const first = run(red);
  assert.equal(first.code, 1, 'no document has the id `guides` once index.md declares `overview`');
  assert.match(first.output, /B2 docs-content\/sidebars\.json/);
  assert.match(first.output, /declares its own id/);
  rmSync(red, { recursive: true, force: true });

  const green = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['guides'] }),
    'docs-content/guides/index.md': '# Overview\n',
  });
  const second = run(green);
  assert.equal(second.code, 0, second.output);
  rmSync(green, { recursive: true, force: true });
});

test('an `autogenerated` dirName is checked as a DIRECTORY, and a regular file of that name does not satisfy it', () => {
  const entry = { docs: [{ type: 'autogenerated', dirName: 'reference' }] };

  const missing = makeTree({
    'docs-content/sidebars.json': sidebar(entry),
    'docs-content/intro.md': '# Intro\n',
  });
  const first = run(missing);
  assert.equal(first.code, 1, first.output);
  assert.match(first.output, /B2 docs-content\/sidebars\.json/);
  assert.match(first.output, /dirName/);
  rmSync(missing, { recursive: true, force: true });

  const asFile = makeTree({
    'docs-content/sidebars.json': sidebar(entry),
    'docs-content/intro.md': '# Intro\n',
    'docs-content/reference': '# not a directory\n',
  });
  const second = run(asFile);
  assert.equal(second.code, 1, 'a regular file is not a directory');
  assert.match(second.output, /B2 docs-content\/sidebars\.json/);
  rmSync(asFile, { recursive: true, force: true });

  const present = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro', { type: 'autogenerated', dirName: 'reference' }] }),
    'docs-content/intro.md': '# Intro\n',
    'docs-content/reference/codes.md': '# Codes\n',
  });
  const third = run(present);
  assert.equal(third.code, 0, third.output);
  assert.match(third.output, /autogenerated coverage: dirName "reference" covers 1 file\(s\)/);
  rmSync(present, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SIDEBAR SHAPES
// ---------------------------------------------------------------------------

test('only ARRAY POSITIONS carry ids: `category`, `Guides` and `doc` are never collected', () => {
  const collected = collectSidebar({
    docs: [{ type: 'category', label: 'Guides', items: ['intro', { type: 'doc', id: 'quickstart' }] }],
  });
  assert.deepEqual(collected.ids.map((entry) => entry.id), ['intro', 'quickstart']);
  assert.deepEqual(collected.malformed, []);
});

test('a `link` item and an unenumerated `type` collect no id and fail nothing', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({
      docs: ['intro', { type: 'link', href: 'https://example.com' }, { type: 'html', value: '<hr>' }],
    }),
    'docs-content/intro.md': '# Intro\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  assert.match(output, /unrecognized sidebar type/);
  assert.match(output, /"html"/);
  assert.match(output, /sidebar link: docs-content\/sidebars\.json {2}https:\/\/example\.com/);
  rmSync(dir, { recursive: true, force: true });
});

test('the LEGACY object shape is walked, its keys are labels, and a dangling id in it still reds', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: { Guides: ['intro', 'missing-doc'] } }),
    'docs-content/intro.md': '# Intro\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, 'without the legacy arm this file yields zero ids and missing-doc passes unnoticed');
  assert.match(output, /B2 docs-content\/sidebars\.json/);
  assert.match(output, /missing-doc/);
  assert.doesNotMatch(output, /declares the id `Guides`/);
  rmSync(dir, { recursive: true, force: true });

  const collected = collectSidebar({ docs: { Guides: ['intro', 'missing-doc'] } });
  assert.deepEqual(collected.ids.map((entry) => entry.id), ['intro', 'missing-doc']);
});

test('a sidebar VALUE that is a scalar, null, or a single ITEM object is B3 naming that sidebar key', () => {
  const shapes = [
    ['a string', { docs: 'intro' }],
    ['a number', { docs: 7 }],
    ['a boolean', { docs: true }],
    ['null', { docs: null }],
    ['a single item object', { docs: { type: 'category', label: 'All', items: ['intro', 'missing-doc'] } }],
  ];
  for (const [name, value] of shapes) {
    const dir = makeTree({
      'docs-content/sidebars.json': sidebar(value),
      'docs-content/intro.md': '# Intro\n',
    });
    const { code, output } = run(dir);
    assert.equal(code, 1, `${name} must be B3 rather than collecting zero ids: ${output}`);
    assert.match(output, /B3 docs-content\/sidebars\.json/);
    assert.match(output, /sidebar "docs"/);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every enumerated ITEM malformation is B3, named and never skipped, with its position', () => {
  const shapes = [
    ['doc with no id', { type: 'doc' }, /"doc"\} carries no string "id"|doc.*no string "id"/],
    ['category with no items', { type: 'category' }, /category.*no array "items"/],
    ['autogenerated with no dirName', { type: 'autogenerated' }, /autogenerated.*no string "dirName"/],
    ['link with no href', { type: 'link' }, /link.*no string "href"/],
    ['an object with no type', { label: 'Guides' }, /carries no "type"/],
    ['a non-string type', { type: 7 }, /"type" is number/],
  ];
  for (const [name, item, expected] of shapes) {
    const dir = makeTree({
      'docs-content/sidebars.json': sidebar({ docs: ['intro', item] }),
      'docs-content/intro.md': '# Intro\n',
    });
    const { code, output } = run(dir);
    assert.equal(code, 1, `${name}: ${output}`);
    assert.match(output, /B3 docs-content\/sidebars\.json {2}\/docs\/1/, 'the JSON pointer names the position');
    assert.match(output, expected);
    rmSync(dir, { recursive: true, force: true });
  }

  const nulled = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro', null] }),
    'docs-content/intro.md': '# Intro\n',
  });
  const { code, output } = run(nulled);
  assert.equal(code, 1, output);
  assert.match(output, /B3 docs-content\/sidebars\.json {2}\/docs\/1/);
  assert.match(output, /is null/);
  rmSync(nulled, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ORPHANS AND AUTOGENERATED COVERAGE
// ---------------------------------------------------------------------------

test('an unreferenced file is reported as an orphan and fails nothing', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n',
    'docs-content/stranded.md': '# Stranded\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  assert.match(output, /orphan: docs-content\/stranded\.md/);
  rmSync(dir, { recursive: true, force: true });
});

// COLLECTING ZERO IDS IS NOT B3 WHERE AN AUTOGENERATED ENTRY COVERS THE TREE. `{}` and a deleted
// file say the same thing about what the site shows; an autogenerated-only sidebar says the
// OPPOSITE, so it exits zero and reports no orphan at all.
test('an autogenerated-only SIDEBAR over a two-file tree collects ZERO ids and exits GREEN', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: [{ type: 'autogenerated', dirName: '.' }] }),
    'docs-content/intro.md': '# Intro\n\n[Quickstart](./quickstart)\n',
    'docs-content/quickstart.md': '# Quickstart\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  assert.match(output, /Checked 2 file\(s\), 1 link\(s\), 0 image\(s\) and 0 document id\(s\)/);
  assert.doesNotMatch(output, /orphan:/);
  assert.match(output, /autogenerated coverage: dirName "\." covers 2 file\(s\)/);
  rmSync(dir, { recursive: true, force: true });
});

// AND THE SAME NOTATION AS A FILE IS A DIFFERENT INPUT. A sidebar is a VALUE; the FILE's top level
// must be an object whose keys are sidebar names, so a literal top-level array is B3. The two
// assertions cannot collide because the fixtures are not the same file.
test('a literal top-level ARRAY file is B3, which is not the autogenerated-only sidebar above', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': `${JSON.stringify([{ type: 'autogenerated', dirName: '.' }], null, 2)}\n`,
    'docs-content/intro.md': '# Intro\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, output);
  assert.match(output, /B3 docs-content\/sidebars\.json/);
  assert.match(output, /top level is an array/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// UNHAPPY PATHS
// ---------------------------------------------------------------------------

test('an ABSENT sidebars.json is B3 naming it, while an absent intro.md is no finding at all', () => {
  const dir = makeTree({ 'docs-content/index.md': '# Index\n' });
  const { code, output } = run(dir);
  assert.equal(code, 1, output);
  assert.match(output, /B3 docs-content\/sidebars\.json/);
  assert.match(output, /sidebars\.js.*sidebars\.ts|sidebars\.ts/);
  rmSync(dir, { recursive: true, force: true });

  // `index.md` and no `intro.md`. The release workflow asserts nothing about filenames, and
  // Docusaurus's own convention is `index.md`, so blocking here would red a tree the site builds.
  const green = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['index'] }),
    'docs-content/index.md': '# Index\n',
  });
  const second = run(green);
  assert.equal(second.code, 0, second.output);
  rmSync(green, { recursive: true, force: true });
});

test('an UNPARSEABLE sidebars.json is B3 and emits no B2 derived from a partial parse', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': '{ "docs": ["intro",\n',
    'docs-content/intro.md': '# Intro\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, output);
  assert.match(output, /B3 docs-content\/sidebars\.json/);
  assert.match(output, /unparseable JSON/);
  assert.doesNotMatch(output, /B2/);
  rmSync(dir, { recursive: true, force: true });
});

test('`{}` collects zero ids over an uncovered tree and reaches the same verdict as a deleted file', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': '{}\n',
    'docs-content/intro.md': '# Intro\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, output);
  assert.match(output, /B3 docs-content\/sidebars\.json/);
  assert.match(output, /zero document ids/);
  rmSync(dir, { recursive: true, force: true });
});

test('a frontmatter block opened and never closed is B3 naming the file', () => {
  assert.match(declaredId('---\nid: intro\n\n# Intro\n').malformed ?? '', /never closed/);
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '---\nid: intro\n\n# Intro\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, output);
  assert.match(output, /B3 docs-content\/intro\.md/);
  assert.match(output, /never closed/);
  rmSync(dir, { recursive: true, force: true });
});

test('an `id` opening a block scalar or a flow collection is B3, which is a TEST rather than a type judgement', () => {
  for (const value of ['|', '|-', '>', '[a, b]', '{a: b}']) {
    const dir = makeTree({
      'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
      'docs-content/intro.md': `---\nid: ${value}\n---\n\n# Intro\n`,
    });
    const { code, output } = run(dir);
    assert.equal(code, 1, `${value}: ${output}`);
    assert.match(output, /B3 docs-content\/intro\.md/);
    rmSync(dir, { recursive: true, force: true });
  }
  // The test runs on the RAW value, before the quote strip, so a quoted string is an ordinary id.
  assert.deepEqual(declaredId('---\nid: "[a]"\n---\n'), { id: '[a]', malformed: null });
});

test('B4: the input is on and there is no docs-content/ at all', () => {
  const dir = makeTree({ 'README.md': '# A caller with no docs-content\n' });
  const { code, output } = run(dir);
  assert.equal(code, 1, output);
  assert.match(output, /B4 docs-content\//);
  assert.match(output, /check-docs-content/);
  rmSync(dir, { recursive: true, force: true });
});

test('B6: an unreadable FILE is printed BESIDE a B1 from the same tree, and neither throws', {
  skip: POSIX && process.getuid && process.getuid() !== 0 ? false : 'needs a non-root POSIX user',
}, () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro', 'locked'] }),
    'docs-content/intro.md': '# Intro\n\n[Gone](./gone)\n',
    'docs-content/locked.md': '# Locked\n',
  });
  execFileSync('chmod', ['000', join(dir, 'docs-content/locked.md')]);
  const { code, output } = run(dir);
  assert.equal(code, 1, output);
  assert.match(output, /B6 docs-content\/locked\.md/);
  assert.match(output, /EACCES/);
  assert.match(output, /B1 docs-content\/intro\.md:3/, 'the walk continues over everything it can read');
  execFileSync('chmod', ['644', join(dir, 'docs-content/locked.md')]);
  rmSync(dir, { recursive: true, force: true });
});

test('B6: a dangling symlink is unreadable wherever it sits, a DIRECTORY one included', {
  skip: POSIX ? false : 'symlinks need privileges on Windows',
}, () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n',
    'docs-content/guides': link('../gone'),
  });
  const { code, output } = run(dir);
  assert.equal(code, 1, output);
  assert.match(output, /B6 docs-content\/guides/);
  assert.match(output, /ENOENT/);
  rmSync(dir, { recursive: true, force: true });

  // AND ONE NOTHING REFERENCES. "ANY entry that cannot be read" governs: a path that cannot be
  // resolved cannot be counted as a document either, so leaving it silent would be a hole.
  const unreferenced = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n',
    'docs-content/legacy.md': link('./archived/legacy.md'),
  });
  const second = run(unreferenced);
  assert.equal(second.code, 1, second.output);
  assert.match(second.output, /B6 docs-content\/legacy\.md/);
  rmSync(unreferenced, { recursive: true, force: true });
});

test('a symlink CYCLE is reported once, fails nothing, and the walk terminates', {
  skip: POSIX ? false : 'symlinks need privileges on Windows',
}, () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n',
    'docs-content/self': link('.'),
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  assert.equal(output.match(/cycle: docs-content\/self/g)?.length, 1, 'reported exactly once');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// THE WORKSPACE IS THE INPUT OF EVERY OTHER GATE IN THE SAME JOB
// ---------------------------------------------------------------------------

/** Every path under `root`, with its CONTENT by size and hash. Dotfiles included. */
function snapshot(root) {
  const out = new Map();
  const walk = (relative) => {
    const absolute = relative === '' ? root : join(root, relative);
    for (const name of readdirSync(absolute).sort()) {
      const childRelative = relative === '' ? name : `${relative}/${name}`;
      const stats = lstatSync(join(root, childRelative));
      if (stats.isSymbolicLink()) {
        out.set(childRelative, `symlink -> ${readlinkSync(join(root, childRelative))}`);
        continue;
      }
      if (stats.isDirectory()) {
        out.set(childRelative, 'dir');
        walk(childRelative);
        continue;
      }
      const bytes = readFileSync(join(root, childRelative));
      out.set(childRelative, `file ${stats.size} ${createHash('sha256').update(bytes).digest('hex')}`);
    }
  };
  walk('');
  return out;
}

// A REPORT WRITTEN BESIDE THE TREE WOULD FAIL THIS, and so would an in-place rewrite of a file the
// checker read, which a listing of names alone would not catch. `pnpm lint`, `pnpm format:check`
// and `pnpm phi-scan` all read the caller's workspace in the same job; a file this gate leaves
// behind is a file those gates then read.
test('a REAL invocation creates, modifies and deletes NO path anywhere under the workspace root', () => {
  const dir = makeTree({
    '.hidden-caller-dotfile': 'untouched\n',
    'package.json': '{ "name": "a-caller" }\n',
    'docs-content/.nojekyll': '',
    'docs-content/sidebars.json': sidebar({ docs: ['intro'] }),
    'docs-content/intro.md': '# Intro\n\n[Gone](./gone)\n\n![Logo](./img/logo.svg)\n',
    'docs-content/img/logo.svg': '<svg/>\n',
  });

  const before = snapshot(dir);
  const { code } = run(dir);
  const after = snapshot(dir);

  assert.equal(code, 1, 'the invocation must be a REAL one that found something');
  assert.deepEqual([...after.keys()], [...before.keys()], 'no path created or deleted');
  assert.deepEqual([...after.entries()], [...before.entries()], 'and no content modified');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// THE DELIVERED FILE IS THE WHOLE PROGRAM
// ---------------------------------------------------------------------------

// Delivery fetches ONE file into `$RUNNER_TEMP`. An entry point importing a sibling under
// `scripts/` passes every test above and dies `ERR_MODULE_NOT_FOUND` in the first adopting caller's
// run, so what it imports is asserted here rather than discovered there.
test('the checker imports `node:*` and NOTHING ELSE, this repository included', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const specifiers = [...source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map(
    (match) => match[1],
  );
  assert.ok(specifiers.length > 0, 'the regex must actually be finding the imports');
  for (const specifier of specifiers) {
    assert.match(specifier, /^node:/, `${specifier} would not exist beside the delivered file`);
  }
  assert.doesNotMatch(source, /require\(/, 'and no CommonJS route around the same rule');
});

test('the checker opens nothing for writing', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  for (const forbidden of [
    'writeFileSync',
    'appendFileSync',
    'mkdirSync',
    'mkdtempSync',
    'rmSync',
    'unlinkSync',
    'renameSync',
    'copyFileSync',
    'createWriteStream',
    'writeSync',
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${forbidden}\\b`), `${forbidden} would write into the caller's workspace`);
  }
});

// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------

test('bad usage is exit 2, distinct from a failing check', () => {
  const bad = (args) => {
    try {
      execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(bad(['--repo']), 2);
  assert.equal(bad(['nonsense']), 2);
  assert.equal(bad(['--unknown', 'x']), 2);
});

// ---------------------------------------------------------------------------
// UNIT ASSERTIONS ON THE RESOLUTION ARITHMETIC
// ---------------------------------------------------------------------------

test('resolution normalizes `.`, `..` and empty segments, and refuses to escape the root', () => {
  assert.equal(resolveWithin(['guides'], './intro'), 'guides/intro');
  assert.equal(resolveWithin(['guides'], '../intro'), 'intro');
  assert.equal(resolveWithin(['guides'], 'reference/'), 'guides/reference');
  assert.equal(resolveWithin(['guides'], 'a//b'), 'guides/a/b');
  assert.equal(resolveWithin([], '../hl7/intro'), null, 'escaping the root is cross-package');
  assert.equal(resolveWithin(['x12'], '../../hl7/intro'), null);
});

test('an empty target after the cut is a same-page anchor and never a finding', () => {
  assert.deepEqual(classifyTarget('#segments', 'intro.md'), { class: 'anchor' });
  assert.deepEqual(classifyTarget('', 'intro.md'), { class: 'anchor' });
  assert.deepEqual(classifyTarget('?x=1', 'intro.md'), { class: 'anchor' });
});
