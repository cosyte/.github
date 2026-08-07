// Tests for .github/workflows/self-check.yml, this repository's OWN gate.
//
// WHAT THESE TESTS ARE FOR. Every other suite here proves a script in `scripts/` behaves. This one
// proves the workflow that RUNS those scripts still covers them, because `scripts` is meant to be a
// required status check and a required context is only worth what it actually executes. Whether it
// IS one right now is not knowable from in here (see the closing note), so nothing below asserts it.
//
// ▶ TWO WAYS A REQUIRED CONTEXT STOPS GATING WITHOUT ANYONE EDITING A RULESET, and neither is
//   reported by anything. Two that are GUARDED, not two that exist; see the closing note for the
//   ones that are not:
//
//   (1) RENAME THE JOB ID. The ruleset entry names a string. Rename `scripts` and the entry detaches
//       silently: the old context is required and emitted by nothing, so every pull request sits
//       PENDING and unmergeable, which is worse than red because nothing says why. Nothing inside a
//       repository can read its own ruleset to notice. What this file can do is pin the job ids, so
//       the rename reds HERE, in the same pull request that made it, next to a comment that says to
//       change the ruleset entry too.
//   (2) NARROW WHAT SELECTS THE WORK. A required job gates its STEPS, not the selection those steps
//       operate on. `node --test "test/*.test.mjs"` exits 0 just as happily over one file as over all
//       of them, and the context is green either way. So the glob is read out of the workflow and
//       compared against the test files actually on disk. It is a real comparison, not a spelling
//       check: `test/release-*.test.mjs` parses fine, runs a subset, and reds below.
//
// ▶ AND THE THIRD, WHICH IS THE ONE THIS REPOSITORY ALREADY PAID FOR. `scripts` sat un-required for
//   a stretch because it appeared on some open pull requests and not others, and the standing record
//   read that as a path-conditional job. It was not: the job POSTDATED those branches. The
//   distinction matters going forward rather than backwards, because a `paths:` filter or a
//   job-level `if:` added later would make the context genuinely conditional. Both are refused here:
//   a context that does not run on every pull request cannot gate every pull request.
//
// ▶ THE BOUND, NAMED RATHER THAN CHASED. This file is not a YAML parser and must not become one:
//   the repository has no `package.json` by design, so there is no dependency to parse YAML with,
//   and hand-rolling one to test a 60-line workflow is the machinery this ecosystem deletes. It
//   reads the file as text, anchored on indentation. That is enough to catch a rename, a narrowing
//   and a new JOB-LEVEL conditional, and it is NOT enough to catch every way a step can be
//   neutralised from inside the job, nor an author who restructures the file into a shape these
//   anchors no longer locate. The `the anchors located something` assertions exist so the
//   restructuring case reds rather than passing vacuously, which is the failure mode of every
//   text-anchored assertion ever written. The rest is an open hole, stated rather than closed:
//   closing it is one rule per step attribute, and a guard that grows one rule per spelling is a
//   deny-list, which this repository has already paid for twice. Know the shape instead.
//
//   And nothing here asserts that any context IS required. A repository cannot observe its own
//   ruleset, so such an assertion would be a claim this file could never re-check. Derive it:
//     gh api repos/cosyte/.github/rulesets/19990161 --jq '.rules[]
//       | select(.type=="required_status_checks")
//       | .parameters.required_status_checks'

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const HERE = import.meta.dirname;
const WORKFLOW = resolve(HERE, '../.github/workflows/self-check.yml');
const yml = readFileSync(WORKFLOW, 'utf8');

/** The `jobs:` mapping, sliced off the rest of the document. */
function jobsBlock() {
  const start = yml.indexOf('\njobs:\n');
  assert.ok(start >= 0, 'the `jobs:` block was not located');
  return yml.slice(start + '\njobs:\n'.length);
}

/** Job ids declared at exactly two spaces of indent, in file order. */
function jobIds() {
  return [...jobsBlock().matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]);
}

/** The body of one job, from its id line to the next job id or end of file. */
function jobBody(id) {
  const block = jobsBlock();
  const open = block.indexOf(`\n  ${id}:\n`);
  assert.ok(open >= 0, `the \`${id}\` job was not located`);
  const rest = block.slice(open + 1);
  const next = rest.slice(1).search(/^ {2}[A-Za-z0-9_-]+:$/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** Every `*.test.mjs` under `test/`, recursively, as paths relative to the repo root. */
function testFilesOnDisk(dir = resolve(HERE), prefix = 'test') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...testFilesOnDisk(resolve(dir, entry.name), rel));
    else if (entry.name.endsWith('.test.mjs')) out.push(rel);
  }
  return out.sort();
}

/**
 * A glob of the shape the workflow uses, as a RegExp. A single `*` matches within one path segment
 * only, which is exactly why a file added under `test/unit/` is NOT selected by `test/*.test.mjs`.
 *
 * `**` is handled because the comments here tell a future author to widen the glob when a directory
 * of tests is added, and a translator that could not read the widened form would red on the very
 * change it asks for. A guard that refuses its own documented remedy gets deleted, not obeyed.
 */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // One pass, longest alternative first, so no sentinel character is ever substituted into the
  // string and then substituted back out. A two-pass version has to pick a sentinel that cannot
  // occur in a path, and "cannot occur" is exactly the class of assumption this repository keeps
  // being wrong about.
  // `**/` spans whole directories and a bare `**` does not, matching what `node --test` was measured
  // to do over the same tree: `test/**/*.test.mjs` selected 347 tests, `test/**.test.mjs` selected
  // 346. Mapping a bare `**` to `.*` fails in the dangerous direction, because the comparison below
  // would then report a selection wider than the one CI runs. A `**` that is neither of those two
  // shapes is not translated faithfully and is not refused either; do not write one.
  const body = escaped.replace(/\*\*\/|\*\*|\*/g, (m) =>
    m === '**/' ? '(?:[^/]+/)*' : '[^/]*',
  );
  return new RegExp(`^${body}$`);
}

// ── The context names ───────────────────────────────────────────────────────────────────────────

test('the job ids are the context names a ruleset requires, so they are pinned', () => {
  // Anchored on the two-space indent rather than on a substring search: `scripts` also appears in
  // this file as a directory name and inside `run:` bodies, and a bare `includes` would be satisfied
  // by any of them, which is an assertion that cannot fail.
  assert.deepEqual(jobIds().sort(), ['actionlint', 'scripts']);
});

test('neither required job is conditional, at the workflow or at the job level', () => {
  // A `paths:` filter on the trigger, or an `if:` on the job, makes the context appear on some pull
  // requests and not others. A context that does not run on every pull request cannot gate every
  // pull request.
  const triggers = yml.slice(yml.indexOf('\non:\n'), yml.indexOf('\npermissions:'));
  assert.ok(triggers.includes('pull_request:'), 'the `on:` block was not located');
  assert.doesNotMatch(triggers, /^ +paths(-ignore)?:/m);

  for (const id of ['actionlint', 'scripts']) {
    const body = jobBody(id);
    assert.match(body, /^ {4}runs-on:/m, `the \`${id}\` job body was not located`);
    assert.doesNotMatch(body, /^ {4}if:/m, `\`${id}\` must not be conditional while it is required`);
  }
});

test('it runs on pull requests AND on main, which is the precondition for requiring it', () => {
  // A context may not be required before its workflow has COMPLETED ON `main`. The `push` trigger is
  // what makes that reachable at all; the `pull_request` trigger is what makes the context appear on
  // the pull request the ruleset is gating. Requiring a context that only one of these emits strands
  // every pull request.
  const triggers = yml.slice(yml.indexOf('\non:\n'), yml.indexOf('\npermissions:'));
  assert.match(triggers, /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.match(triggers, /^ {2}pull_request:\n {4}branches: \[main\]$/m);
});

// ── What the required job actually executes ─────────────────────────────────────────────────────

test('the `scripts` job runs node:test over a glob, quoted so node does the expansion', () => {
  // THE SHAPE, NOT THE VALUE. This case owns the invocation: `node --test`, one QUOTED argument (so
  // node expands the glob rather than the shell, which is what keeps it matching what the case below
  // reads), no `--test-name-pattern` or other selector smuggled in beside it. WHETHER THE GLOB IS
  // WIDE ENOUGH IS THE NEXT CASE'S JOB, and pinning the literal string here would do that job badly:
  // it would red on a WIDENING as loudly as on a narrowing, and the comments in this file tell a
  // future author to widen it when a directory of tests appears. A guard that reds on its own
  // documented remedy gets deleted rather than obeyed.
  const step = jobBody('scripts').match(/^ {8}run: (node --test .*)$/m);
  assert.ok(step, 'the `node --test` step was not located in the `scripts` job');
  const run = step[1].match(/^node --test "([^"]+)"$/);
  assert.ok(run, `the test command must be \`node --test\` and one quoted glob, got: ${step[1]}`);
  assert.match(run[1], /^test\/[^"]*\.test\.mjs$/);
});

test('THE LOAD-BEARING CASE: the glob in the workflow selects every test file on disk', () => {
  // Read the selection out of the workflow and compare it against the tree, rather than asserting a
  // string twice. Narrowing the glob keeps the required context green over strictly less work, and
  // this is the assertion that notices.
  const glob = jobBody('scripts').match(/^ {8}run: node --test "([^"]+)"$/m)?.[1];
  assert.ok(glob, 'the `node --test` step was not located in the `scripts` job');

  const onDisk = testFilesOnDisk();
  assert.ok(onDisk.length > 1, 'the tree walk found no test files, so this comparison proves nothing');
  assert.ok(onDisk.includes('test/self-check.test.mjs'), 'the tree walk did not find this file');

  const selected = onDisk.filter((p) => globToRegExp(glob).test(p));
  assert.deepEqual(
    selected,
    onDisk,
    'the workflow glob does not select every test file: the required `scripts` context is green over less than the suite',
  );
});

test('a test file added in a SUBDIRECTORY would not be selected, and that is what is being pinned', () => {
  // Non-vacuity for the case above. The comparison is only meaningful if the glob can actually miss
  // something, so the miss is exhibited rather than asserted to be possible. A single-segment `*`
  // does not cross `/`, so `test/unit/foo.test.mjs` is invisible to the gate. Nothing on disk sits
  // there today; if a directory of tests is ever added, the glob has to grow with it.
  assert.equal(globToRegExp('test/*.test.mjs').test('test/unit/foo.test.mjs'), false);
  assert.equal(globToRegExp('test/*.test.mjs').test('test/release-notes.test.mjs'), true);
  // The widening this file's comments prescribe has to READ, or the guard refuses its own remedy and
  // gets deleted rather than obeyed. `test/**/*.test.mjs` must select both depths.
  assert.equal(globToRegExp('test/**/*.test.mjs').test('test/unit/foo.test.mjs'), true);
  assert.equal(globToRegExp('test/**/*.test.mjs').test('test/release-notes.test.mjs'), true);
  // And the near miss, measured against a real `node --test` run rather than assumed: a bare `**`
  // that is not a whole segment does NOT cross a separator. Reading it as if it did would let the
  // comparison below believe CI selects a subdirectory it never opens.
  assert.equal(globToRegExp('test/**.test.mjs').test('test/unit/foo.test.mjs'), false);
  assert.equal(globToRegExp('test/**.test.mjs').test('test/release-notes.test.mjs'), true);
  // And a plausible narrowing really does fail the comparison, rather than being caught only by the
  // spelling assertion above.
  const onDisk = testFilesOnDisk();
  const narrowed = onDisk.filter((p) => globToRegExp('test/release-*.test.mjs').test(p));
  assert.notDeepEqual(narrowed, onDisk);
});

test('the job checks the repository out before it tries to run the tests', () => {
  // Without this the glob selects nothing. `node --test` over an empty selection is not obviously a
  // failure, and a gate that runs zero tests and exits 0 is the defect class this repository keeps
  // paying for.
  const body = jobBody('scripts');
  const checkout = body.indexOf('uses: actions/checkout@');
  const unitTests = body.indexOf('run: node --test');
  assert.ok(checkout >= 0, 'the `scripts` job does not check the repository out');
  assert.ok(unitTests >= 0, 'the `node --test` step was not located');
  assert.ok(checkout < unitTests, 'the checkout must precede the test run');
});
