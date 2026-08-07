// Tests for scripts/check-no-emdash.mjs, the em-dash gate.
//
// WHAT THESE TESTS ARE FOR, said once so the individual cases read against it. The defect this gate
// exists to stop is not "a document is untidy". It is a scanner that reports a clean tree having
// examined nothing, which is what a punctuation gate degrades into the moment anyone trusts it. So
// roughly half of the cases below drive a REFUSAL rather than a finding.
//
// ▶ THE LOAD-BEARING CASE IS `the banner's byte total is the tree's byte total`, AND IT HAS TO LIVE
//   HERE RATHER THAN IN THE SCRIPT. A sibling gate was defeated twice by a one-line path exclusion:
//   once by accounting the skipped paths into its declared-binary bucket so the arithmetic balanced,
//   and then, after that was closed, by routing the identical exclusion through its scanned bucket,
//   leaving every asserted field byte-identical to an honest run. Every in-script invariant it had
//   was satisfied by the same edit that broke it, because both sides of each invariant were derived
//   from the list the edit had already filtered. The only assertion that notices is one that
//   recomputes the total INDEPENDENTLY, from `git ls-files` plus `statSync`, outside the file being
//   mutated. That is the case below, and `a mutant that excludes a path by name is caught` proves it
//   has bite rather than asserting that it does.
//
// ▶ AND THE BOUND, NAMED RATHER THAN CHASED. This file is itself a file a mutator is editing, so a
//   mutation that ACCOUNTS for a file without reading it still passes with the suite green: the
//   cheapest one takes each path's `statSync` size, adds it to both totals, and skips the read, so
//   every number below reconciles. No assertion inside a repository can close that class, only
//   raise its cost. It is now a block that measures a file in order to avoid opening it, which is
//   visibly incoherent in review. That is the right stopping point, and the reason not to add a
//   fourth rung chasing it.
//
// Every banned spelling is ASSEMBLED from the codepoint here, exactly as the script assembles it, so
// this file contains none of them as text and needs no exclusion from the scan it is testing.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SCRIPT = resolve(REPO, 'scripts/check-no-emdash.mjs');

// The spellings under test, built rather than written. `BS` is one backslash.
const EM = String.fromCodePoint(0x2014);
const HEX = (0x2014).toString(16);
const DEC = String(0x2014);
const BS = '\\';
const AMP = '&';
const PCT = [...Buffer.from(EM, 'utf8')].map((b) => `%${b.toString(16).toUpperCase()}`).join('');

/** Every spelling the gate bans, paired with the label it reports. Index aligned with the script. */
const BANNED = [
  [EM, 'the literal character'],
  [PCT, 'the percent-encoding'],
  [`${AMP}mdash;`, 'the named HTML entity'],
  [`${AMP}#${DEC};`, 'the decimal character reference'],
  [`${AMP}#x${HEX};`, 'the hex character reference'],
  [`${BS}u${HEX}`, 'the JavaScript escape'],
  [`${BS}u{${HEX}}`, 'the braced JavaScript escape'],
];

/** The one spelling the gate deliberately does NOT ban: the PCRE source form. Known limit (ii). */
const PCRE = `${BS}x{${HEX}}`;

/** Run a command and return `{ code, output }` rather than throwing, so a failure is assertable. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const gate = (cwd, args = [], opts = {}) => run(process.execPath, [join(cwd, 'scripts/check-no-emdash.mjs'), ...args], { cwd, ...opts });

/**
 * A throwaway git repository carrying a REAL copy of the gate, so every case below drives the real
 * entry point over real files rather than a unit-testable fragment of it. The gate roots itself at
 * `import.meta.dirname/..`, so copying the script into `<dir>/scripts/` is what makes `<dir>` the
 * tree under test.
 *
 * The four files named in the gate's `KNOWN_TEXT` list are created by default, and the filler
 * clears its `MIN_TRACKED` floor: both are claims about the real repository, so a synthetic tree has
 * to satisfy them to exercise anything past them. `skipKnown` and `fillers` exist so the two cases
 * that drive those refusals can withhold exactly one thing.
 */
function makeRepo({ files = {}, fillers = 32, skipKnown = [], script = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'no-emdash-'));
  const write = (rel, body) => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  if (script === null) copyFileSync(SCRIPT, join(dir, 'scripts/check-no-emdash.mjs'));
  else writeFileSync(join(dir, 'scripts/check-no-emdash.mjs'), script);
  for (const rel of ['README.md', 'CONTRIBUTING.md', '.github/workflows/ci.yml']) {
    if (!skipKnown.includes(rel)) write(rel, `# ${rel}\n\nclean prose, no banned punctuation.\n`);
  }
  for (let i = 0; i < fillers; i++) write(`filler/f${i}.md`, `filler ${i}\n`);
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

function withRepo(opts, fn) {
  const dir = makeRepo(opts);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── The real repository ─────────────────────────────────────────────────────────────────────────

test('the gate passes on this repository, and says what it scanned', () => {
  const r = gate(REPO);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /\[no-emdash\] OK: \d+ tracked file\(s\) scanned/);
  assert.match(r.output, /0 exempt/);
});

// ▶ THE LOAD-BEARING ASSERTION. See the banner at the top of this file. The total is recomputed
//   here from `git ls-files` and `statSync`, which are outside the script, so a path the script
//   silently declines to open is a number that does not add up rather than a bucket that balances.
test("the banner's byte total is the tree's byte total, recomputed independently", () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 27 })
    .split('\0')
    .filter(Boolean);
  assert.ok(tracked.length > 30, 'git ls-files returned an implausibly small tree');

  const expectedBytes = tracked.reduce((sum, rel) => sum + statSync(join(REPO, rel)).size, 0);

  const r = gate(REPO);
  assert.equal(r.code, 0, r.output);
  const m = /OK: (\d+) tracked file\(s\) scanned \((\d+) bytes\), (\d+) filename\(s\) checked/.exec(r.output);
  assert.ok(m, `banner did not parse: ${r.output}`);
  assert.equal(Number(m[1]), tracked.length, 'the gate scanned a different number of files than git tracks');
  assert.equal(Number(m[2]), expectedBytes, 'the gate read a different number of bytes than the tree holds');
  assert.equal(Number(m[3]), tracked.length);
});

test('nothing in this repository is declared binary, so nothing can be argued out of the scan', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 27 })
    .split('\0')
    .filter(Boolean);
  const out = execFileSync('git', ['check-attr', '--stdin', '-z', 'binary'], {
    cwd: REPO,
    input: `${tracked.join('\0')}\0`,
    encoding: 'utf8',
    maxBuffer: 1 << 27,
  }).split('\0');
  const declared = [];
  for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === 'set') declared.push(out[i]);
  assert.deepEqual(declared, []);
});

test('the gate spells none of the forms it bans, so it needs no exclusion from its own scan', () => {
  const body = execFileSync('cat', [SCRIPT], { encoding: 'utf8' });
  for (const [spelling, label] of BANNED) {
    assert.equal(body.includes(spelling), false, `the gate contains ${label} as text`);
  }
});

// ── Findings, one case per banned spelling ──────────────────────────────────────────────────────

for (const [spelling, label] of BANNED) {
  test(`a tracked file carrying ${label} reds, naming the file and the spelling`, () => {
    withRepo({ files: { 'docs/note.md': `a line with ${spelling} in it\n` } }, (dir) => {
      const r = gate(dir);
      assert.equal(r.code, 1);
      assert.match(r.output, /FAIL {2}docs\/note\.md:1:/);
      assert.ok(r.output.includes(`(${label})`), r.output);
      assert.match(r.output, /1 occurrence\(s\)/);
    });
  });
}

test('the PCRE source spelling is deliberately NOT banned, which is known limit (ii)', () => {
  withRepo({ files: { 'docs/scanner.md': `it matches ${PCRE} in the fixture\n` } }, (dir) => {
    const r = gate(dir);
    assert.equal(r.code, 0, r.output);
  });
});

test('a clean tree passes', () => {
  withRepo({ files: { 'docs/note.md': 'clean prose, rewritten with a colon: like this.\n' } }, (dir) => {
    assert.equal(gate(dir).code, 0);
  });
});

test('a tracked FILENAME carrying the character reds, which scanning contents never sees', () => {
  withRepo({ files: { [`docs/a${EM}b.md`]: 'clean contents\n' } }, (dir) => {
    const r = gate(dir);
    assert.equal(r.code, 1);
    assert.match(r.output, /tracked filename/);
    assert.match(r.output, /a tracked FILENAME \(not its contents\)/);
  });
});

// ── Refusals: the half that stops a blind scan reading as a clean one ────────────────────────────

test('a filtered or tiny enumeration is REFUSED, never read as a clean repository', () => {
  withRepo({ fillers: 2 }, (dir) => {
    const r = gate(dir);
    assert.equal(r.code, 1);
    assert.match(r.output, /REFUSED: git ls-files returned only \d+ path\(s\)/);
  });
});

test("a 'binary' declaration is REFUSED rather than honoured: this gate has no skip path", () => {
  withRepo({ files: { '.gitattributes': 'docs/blob.md binary\n', 'docs/blob.md': 'anything\n' } }, (dir) => {
    const r = gate(dir);
    assert.equal(r.code, 1);
    assert.match(r.output, /declared 'binary' in \.gitattributes/);
    assert.match(r.output, /docs\/blob\.md/);
  });
});

test('a known text file missing from the scan is REFUSED, because the enumeration is dropping files', () => {
  withRepo({ skipKnown: ['CONTRIBUTING.md'] }, (dir) => {
    const r = gate(dir);
    assert.equal(r.code, 1);
    assert.match(r.output, /REFUSED: CONTRIBUTING\.md is not in the scanned set/);
  });
});

test('a tracked file this gate cannot open is a FAILURE, never a skip', () => {
  withRepo({ files: { 'docs/gone.md': 'x\n' } }, (dir) => {
    rmSync(join(dir, 'docs/gone.md'));
    const r = gate(dir);
    assert.equal(r.code, 1);
    assert.match(r.output, /docs\/gone\.md: could not read/);
    assert.match(r.output, /never a skip/);
  });
});

// ▶ MUTATION, NOT ASSERTION. The two cases above claim the gate has no skip path; these two prove
//   that adding one back is caught, and caught by the equality rather than by luck. The first is the
//   34-character edit that defeated the sibling gate twice.
test('a mutant that excludes a path by name is caught by the file-count equality', () => {
  const mutant = execFileSync('cat', [SCRIPT], { encoding: 'utf8' }).replace(
    '    const abs = path.join(ROOT, rel);',
    '    if (rel.startsWith("filler/")) continue;\n    const abs = path.join(ROOT, rel);',
  );
  assert.ok(mutant.includes('filler/'), 'the mutation did not apply; the anchor moved');
  withRepo({ script: mutant }, (dir) => {
    const r = gate(dir);
    assert.equal(r.code, 1);
    assert.match(r.output, /tracked path\(s\) were not read/);
    assert.match(r.output, /this gate has no skip path/);
  });
});

test('a mutant that reads a file short is caught by the byte total', () => {
  const mutant = execFileSync('cat', [SCRIPT], { encoding: 'utf8' }).replace(
    '      buf = readFileSync(abs);',
    '      buf = readFileSync(abs).subarray(0, 4);',
  );
  assert.ok(mutant.includes('subarray(0, 4)'), 'the mutation did not apply; the anchor moved');
  withRepo({ script: mutant }, (dir) => {
    const r = gate(dir);
    assert.equal(r.code, 1);
    assert.match(r.output, /bytes from files totalling/);
  });
});

// ── The `--stdin` half, which is the only route to a PR title, body or commit message ────────────

test('--stdin passes clean text and names what it read', () => {
  const r = run(process.execPath, [SCRIPT, '--stdin', 'the PR title'], { input: 'a clean title\n' });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /no em dashes in the PR title/);
});

for (const [spelling, label] of BANNED) {
  test(`--stdin reds on ${label}, which no local pre-commit scan can see`, () => {
    const r = run(process.execPath, [SCRIPT, '--stdin', 'the PR body'], { input: `a body with ${spelling}\n` });
    assert.equal(r.code, 1);
    assert.ok(r.output.includes(`(${label})`), r.output);
    assert.match(r.output, /the PR body:1:/);
  });
}

test('an unknown argument reds rather than being ignored as a clean run', () => {
  const r = run(process.execPath, [SCRIPT, '--everything-is-fine']);
  assert.equal(r.code, 1);
  assert.match(r.output, /unknown argument/);
  assert.match(r.output, /usage:/);
});
