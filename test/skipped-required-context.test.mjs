// The three routes into a skipped-but-required check run, and the one of them this repository can
// build by accident.
//
// WHAT THIS IS ABOUT, said once so the cases read against it. GitHub treats `skipped` as a
// SUCCESSFUL check status. So a required context whose job did not run satisfies the ruleset that
// names it: the merge button goes green and the gate proved nothing, with no error anywhere. The
// primary source lists three causes. Two of them, a job-level condition and a step-level condition,
// were settled here in `#46` against a live run and are written down in README.md, "What a skipped
// required context does to a merge". The third, a job skipped because a job it depends on failed,
// was written down nowhere until this file arrived beside the section that now covers it.
//
// WHY A TEST AND NOT A COMMENT. Thirteen repositories call this repository's reusable workflows at
// `@main`, and a check-run context is named `<caller job id> / <inner job id>`. So the shape this
// file refuses is one nobody would notice landing: add `needs:` to a published job, and every
// caller requiring that context keeps a green button while the job behind it stops running on every
// pull request where something else failed. Prose does not stop that. `.github/workflows/self-check.yml`
// runs `node --test "test/*.test.mjs"` on every push and pull request to `main`, so an assertion
// here is a real gate and a paragraph is not.
//
// THE UNHAPPY PATHS ARE THE POINT, because the compliant tree proves almost nothing on its own. No
// job in any workflow here declares `needs:` today, so a guard that only walked the real tree would
// pass over an empty set and report compliance it never measured. Every rule below is therefore a
// pure function driven by synthetic workflows as well as by the tracked ones, and the examination
// refuses three vacuous answers of its own: no reusable workflow found at all, a workflow file that
// cannot be read, and a workflow that declares no `on:` block.
//
// THE PARSE IS LINE BASED AND DELIBERATELY DUMB, in the style of `test/self-scan.test.mjs` and
// `test/org-defaults-coverage.test.mjs`, whose readers this one follows key for key: this repository
// has no `package.json` and therefore no YAML library, on purpose, so that it needs no install step
// to stay verifiable. It is not a YAML parser and must not grow into one; `actionlint` in
// `self-check.yml` is what proves these files are valid YAML.
//
// WHERE THE ALLOWANCE STOPS. A condition that survives a failed dependency is the documented remedy
// ON A JOB THAT DECLARES ONE. On a check's own failure path it is the opposite, and
// `test/self-scan.test.mjs` and `test/org-defaults-coverage.test.mjs` refuse `always()`, `failure()`
// and `!cancelled()` there. Nothing in this file relaxes either of them, and the last section
// asserts that in both directions.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WORKFLOWS = '.github/workflows';

const read = (relative) => readFileSync(join(REPO, relative), 'utf8');

/** The one document that owns the skipped-required-context rule. There is deliberately no second. */
const OWNER = 'README.md';

/** Its section, by heading. Everything AC-1 through AC-3 is about lives under this line. */
const OWNING_HEADING = '## What a skipped required context does to a merge';

/** This file: it grades the owner, so it quotes the owner. Pinned by name below rather than exempt. */
const GRADER = 'test/skipped-required-context.test.mjs';

/** The primary source page, which the owning section already cites for the first two routes. */
const PRIMARY_SOURCE =
  'https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks';

// ---------------------------------------------------------------------------
// The narrow reader
// ---------------------------------------------------------------------------

const indentOf = (line) => line.length - line.trimStart().length;

/** The lines of a workflow with blank and comment-only lines dropped and trailing comments stripped. */
function code(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, '').trimEnd());
}

/** Does this line open the mapping key `key` at this indent? */
function isKey(line, key, indent) {
  return indentOf(line) === indent && new RegExp(`^${key}:( |$)`).test(line.trim());
}

/** The indent of the level `lines` sits at. `lines` is always a whole block, so its first line is it. */
const levelOf = (lines) => (lines.length === 0 ? 0 : indentOf(lines[0]));

/**
 * The lines nested under `key:` in this block, or null when the key is absent.
 *
 * "Absent" is a distinct answer from "empty" on purpose: `needs:` written as a flow sequence has no
 * nested lines at all, and reading that as "declares no dependency" is the false green this file is
 * about.
 */
function under(lines, key) {
  if (lines === null) return null;
  const level = levelOf(lines);
  const start = lines.findIndex((line) => isKey(line, key, level));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && indentOf(line) <= level);
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

/** The scalar written after `key:` on one line in this block, unquoted, or null. */
function scalar(lines, key) {
  if (lines === null) return null;
  const level = levelOf(lines);
  const line = lines.find((candidate) => isKey(candidate, key, level));
  if (line === undefined) return null;
  const after = line.trim().slice(key.length + 1).trim();
  if (after === '') return null;
  const quote = after[0];
  return quote === "'" || quote === '"' ? after.slice(1, -1) : after;
}

/** The mapping keys at the top level of this block, in file order. */
function keysOf(lines) {
  if (lines === null) return [];
  const level = levelOf(lines);
  return lines
    .filter((line) => indentOf(line) === level && /^[A-Za-z_][\w-]*:/.test(line.trim()))
    .map((line) => line.trim().split(':')[0]);
}

/**
 * A workflow read as configuration, or a NAMED failure.
 *
 * A file with no `on:` block is a failure and never a partial answer: nothing can say what starts
 * it, so nothing can say whether it is published to a caller, and reporting the rest of the tree as
 * clean around it is the vacuous pass AC-8 refuses.
 */
function parseWorkflow(name, text) {
  const lines = code(text);
  const triggers = under(lines, 'on');
  if (triggers === null) {
    return { name, failure: `${name} declares no \`on:\` block, so nothing here can say what starts it` };
  }
  return { name, lines, triggers, jobs: under(lines, 'jobs'), failure: null };
}

// ---------------------------------------------------------------------------
// The rule: a published job that depends on another job survives its failure
// ---------------------------------------------------------------------------

/**
 * A condition that runs the job REGARDLESS OF THE DEPENDENCY'S OUTCOME.
 *
 * `always()` is the source's own remedy, verbatim: "Use `always()` with `needs` for required checks
 * that depend on other jobs". `!cancelled()` runs on a failed dependency too, and is accepted for
 * that reason: the criterion asks for a condition that runs regardless of the dependency's outcome,
 * and this is one. `success()` and `failure()` are NOT accepted, and the asymmetry is the whole
 * point: each of them runs on exactly one outcome, so each leaves the other outcome reporting a skip
 * that reads as a pass.
 */
const SURVIVES_A_FAILED_DEPENDENCY = [/\balways\s*\(\s*\)/, /!\s*cancelled\s*\(\s*\)/];

const survives = (condition) => SURVIVES_A_FAILED_DEPENDENCY.some((pattern) => pattern.test(condition));

/** Does this job block declare a dependency on another job, in any of `needs:`'s three spellings? */
const declaresDependency = (block) => under(block, 'needs') !== null;

/**
 * Every job in this workflow that depends on another job without surviving its failure.
 *
 * A reusable with no `jobs:` block at all is a finding rather than zero findings: it publishes a
 * `workflow_call` trigger over nothing this reader could measure.
 */
function dependencyFindings(flow) {
  if (flow.jobs === null) {
    return [{ file: flow.name, job: null, reason: 'carries a `workflow_call` trigger and no `jobs:` block' }];
  }
  const findings = [];
  for (const job of keysOf(flow.jobs)) {
    const block = under(flow.jobs, job);
    if (!declaresDependency(block)) continue;
    const condition = scalar(block, 'if');
    if (condition === null) {
      findings.push({
        file: flow.name,
        job,
        reason: 'declares `needs:` and carries no single-line job-level `if:` this reader can see',
      });
      continue;
    }
    if (!survives(condition)) {
      findings.push({
        file: flow.name,
        job,
        reason: `declares \`needs:\` under \`if: ${condition}\`, which does not run when the dependency fails`,
      });
    }
  }
  return findings;
}

/** A finding as a maintainer reads it: the workflow file and the job id, always both. */
const describe = (finding) =>
  `${WORKFLOWS}/${finding.file}: job \`${finding.job ?? '(none)'}\` ${finding.reason}. A dependent ` +
  'job is skipped when its dependency fails, `skipped` is a successful check status, and the ' +
  'required context then reports a pass over a job that never ran. Use `always()` with `needs`.';

// ---------------------------------------------------------------------------
// The examination, which refuses to measure nothing
// ---------------------------------------------------------------------------

/**
 * Read every workflow in `dir` and sort them into reusables and named problems.
 *
 * Three answers are refusals rather than results, and each one is a file this examination did not
 * read: a file it could not open, a file with no `on:` block, and a directory holding no reusable at
 * all. An examination that read no published reusable has measured nothing.
 */
function examine(dir) {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  const problems = [];
  const flows = [];
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch (error) {
      problems.push(`${name} could not be read: ${error.code ?? error.message}`);
      continue;
    }
    const flow = parseWorkflow(name, text);
    if (flow.failure !== null) {
      problems.push(flow.failure);
      continue;
    }
    flows.push(flow);
  }
  const reusables = flows.filter((flow) => keysOf(flow.triggers).includes('workflow_call'));
  return { names, flows, reusables, problems };
}

/** The whole rule, as one assertion, over whatever tree it is pointed at. */
function assertExamination(result, label) {
  assert.deepEqual(
    result.problems,
    [],
    `${label}: ${result.problems.join(' | ')}. A file this examination could not read is not a ` +
      'file it read and found clean.',
  );
  assert.ok(
    result.reusables.length > 0,
    `${label}: no workflow carries a \`workflow_call\` trigger, so this examination read no ` +
      'published reusable and measured nothing. Reporting compliance from here would be the false ' +
      'green this rule exists to end.',
  );
  assert.deepEqual(
    result.reusables.flatMap(dependencyFindings).map(describe),
    [],
    `${label}: a published job depends on another job without surviving its failure`,
  );
}

/** A throwaway `.github/workflows` holding exactly the files a case needs. */
function workflowDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'skipped-required-'));
  for (const [name, body] of Object.entries(files)) {
    if (body === null) mkdirSync(join(dir, name));
    else writeFileSync(join(dir, name), body);
  }
  return dir;
}

/** A minimal published reusable, with the jobs a case wants pasted in. */
const reusable = (jobs) => `name: probe\non:\n  workflow_call:\njobs:\n${jobs}`;

const JOB = (id, extra = '') =>
  `  ${id}:\n${extra}    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${id}\n`;

// ---------------------------------------------------------------------------
// AC-1 through AC-4: the stated rules, and the single place they are stated
// ---------------------------------------------------------------------------

const README = read(OWNER);

/** The lines of one `## ` section of the owning document, heading included. */
function section(heading) {
  const lines = README.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `${OWNER} has no section ${JSON.stringify(heading)}`);
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

/** The section with its wrapping removed, so a sentence is matched as it reads and not as it wraps. */
const flat = (text) => text.replace(/\s+/g, ' ');

/**
 * The three routes, each with the words that state it and the words that state its consequence.
 *
 * Stated as a table so that a route quietly dropped from the document fails here naming itself,
 * rather than leaving two of three assertions passing.
 */
const ROUTES = [
  {
    route: 'a job-level condition',
    states: /a job skipped by a conditional SATISFIES its required context/,
    consequence: /silently un-requires the gate/,
  },
  {
    route: 'a step-level condition',
    states: /Moving a gate into a step behind an `if:` un-requires it exactly as completely/,
    consequence: /the context then reports `success` rather than `skipped`/,
  },
  {
    route: 'a job it depends on failed',
    states: /a job skipped because a job it depends on failed/,
    consequence: /the dependent job is skipped and may not block merging/i,
  },
];

test('AC-1: the stated rules record all three routes into a skipped required context, with consequences', () => {
  const body = flat(section(OWNING_HEADING));
  assert.match(body, /Three routes reach that false green/, 'the section says how many routes there are');
  for (const { route, states, consequence } of ROUTES) {
    assert.match(body, states, `${OWNER} does not state the route where ${route} skips a required context`);
    assert.match(body, consequence, `${OWNER} states the ${route} route without its consequence`);
  }
});

test('AC-2: the dependency route carries the primary source\'s own consequence and its remedy', () => {
  const body = flat(section(OWNING_HEADING));
  // The consequence, in the source's own words rather than paraphrased into something weaker.
  assert.match(
    body,
    /the dependent job is skipped and may not block merging/i,
    'the consequence is not stated in the primary source\'s terms',
  );
  // The remedy, in the criterion's terms and in the source's.
  assert.match(
    body,
    /a condition that runs it regardless of (?:that|the) dependency's outcome/i,
    'the remedy is not stated as a condition that runs regardless of the dependency outcome',
  );
  assert.match(
    body,
    /Use `always\(\)` with `needs` for required checks that depend on other jobs/,
    'the source\'s own remedy is not quoted',
  );
});

/**
 * Every URL cited in a stretch of markdown, whole, with the autolink brackets and the sentence
 * punctuation after them trimmed off.
 *
 * The citation is matched as a WHOLE URL and never as a substring of the section. A substring test
 * would be satisfied by a link to a different host that merely carries this path inside it, which is
 * the ordinary shape of a phishing link and, here, a citation that sends a reader somewhere else.
 */
const urlsIn = (text) =>
  [...text.matchAll(/https?:\/\/[^\s<>)\]]+/g)].map((match) => match[0].replace(/[).,;]+$/, ''));

test('AC-3: the section cites the primary source page by URL, for all three routes at once', () => {
  const body = section(OWNING_HEADING);
  const cited = urlsIn(body);
  assert.ok(
    cited.includes(PRIMARY_SOURCE),
    `${OWNER}'s "${OWNING_HEADING}" cites ${cited.join(', ') || 'no URL at all'} and not ` +
      `${PRIMARY_SOURCE}, so a reader cannot reach the evidence from the rule`,
  );
  // One page for all three routes: the third route must not arrive citing something else.
  const third = body.slice(body.indexOf('### The third route'));
  assert.ok(third.length > 0, 'the third route has no subsection of its own');
  assert.deepEqual(
    urlsIn(third).filter((url) => url !== PRIMARY_SOURCE),
    [],
    'the third route cites a page the rest of the section does not',
  );
});

/** Every tracked path, NUL separated so a newline in a name cannot split one. */
function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'buffer' });
  assert.equal(result.error, undefined, `could not run git ls-files: ${result.error?.message}`);
  assert.equal(result.status, 0, `git ls-files exited ${result.status}`);
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0);
}

/** A file's text as prose: comment markers stripped, wrapping removed, whitespace collapsed. */
const prose = (text) =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/^\s*(?:#+|\/{2,}|\*)\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');

/** Spellings that name a dependency between jobs. The backticked key is how this repository writes it. */
const DEPENDENCY = [
  /`needs:?`/,
  /\bdepends? on (?:a failed|another|the other|other) job/i,
  /\bdependent job\b/i,
  /\bthrough a dependency\b/i,
  /\bjob it depends on\b/i,
];

/** Spellings that name the consequence side: a context that did not do its work. */
const SKIPPED = [/\bskip(?:s|ped|ping)?\b/i, /\bun-?requires?\b/i, /required context/i, /block(?:s|ing) merging/i];

/** How close the two halves have to sit before a file is talking about the dependency-skip route. */
const PROXIMITY = 400;

/** Does this text refer to the route where a job is skipped because a job it depends on failed? */
function refersToDependencyRoute(text) {
  const body = prose(text);
  for (const pattern of DEPENDENCY) {
    for (const match of body.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))) {
      const from = Math.max(0, match.index - PROXIMITY);
      const window = body.slice(from, match.index + match[0].length + PROXIMITY);
      if (SKIPPED.some((skip) => skip.test(window))) return true;
    }
  }
  return false;
}

/** A file points at the owner by naming its section, or by sending a reader to the README outright. */
const POINTER = /What a skipped required context does to a merge|see the README/i;

/** The source's own consequence sentence, which is the thing that must not be restated loose. */
const CONSEQUENCE = /dependent job is skipped and may not block merging/i;

test('AC-4: every tracked file that refers to the dependency route points at the document that owns it', () => {
  const mentions = trackedFiles()
    .filter((path) => path !== OWNER)
    .filter((path) => refersToDependencyRoute(read(path)));

  // Non-vacuity first. An empty set here would pass this test while proving nothing, and the two
  // files below really do discuss the route today.
  assert.ok(
    mentions.includes('.github/workflows/ci.yml') && mentions.includes('test/ci-docs-content.test.mjs'),
    `the scan found ${mentions.length} file(s) referring to the dependency route (${mentions.join(', ')}); ` +
      'it is meant to find at least ci.yml and ci-docs-content.test.mjs, so the detector is broken',
  );

  for (const path of mentions) {
    assert.match(
      prose(read(path)),
      POINTER,
      `${path} refers to the route where a job is skipped because a job it depends on failed, and ` +
        `does not point at ${OWNER}'s "${OWNING_HEADING}". Three routes with three statements drift ` +
        'into three different answers, which is how this repository got the first one wrong twice.',
    );
  }
});

test('AC-4: the source\'s consequence sentence is written in one place, and the set is pinned whole', () => {
  const carriers = trackedFiles().filter((path) => CONSEQUENCE.test(read(path)));
  // The grader is in the set rather than exempt from it: it asserts the owner states the sentence,
  // so it quotes the sentence, and pinning the set whole is stronger than writing an exemption a
  // later file could be routed through.
  assert.deepEqual(carriers.sort(), [OWNER, GRADER].sort());
});

// ---------------------------------------------------------------------------
// AC-5 through AC-9: the guard over what is published here
// ---------------------------------------------------------------------------

test('AC-5: every job in a published reusable that depends on another job survives its failure', () => {
  const result = examine(join(REPO, WORKFLOWS));
  assertExamination(result, WORKFLOWS);
  // Named, so this criterion cannot be satisfied by an examination that quietly read fewer files.
  assert.deepEqual(
    result.reusables.map((flow) => flow.name),
    ['ci.yml', 'codeql.yml', 'drift-check.yml', 'nightly-fuzz.yml', 'release.yml', 'scorecard.yml'],
  );
});

test('AC-5: the rule accepts exactly the conditions that run when the dependency fails', () => {
  const accepted = ['${{ always() }}', '${{ !cancelled() }}', '${{ always() && inputs.run-it }}'];
  const refused = ['${{ success() }}', '${{ failure() }}', '${{ inputs.run-it }}', "${{ github.ref == 'refs/heads/main' }}"];
  for (const condition of accepted) {
    const flow = parseWorkflow('probe.yml', reusable(`${JOB('first')}${JOB('second', `    needs: first\n    if: ${condition}\n`)}`));
    assert.deepEqual(dependencyFindings(flow), [], `${condition} was refused and it runs on a failed dependency`);
  }
  for (const condition of refused) {
    const flow = parseWorkflow('probe.yml', reusable(`${JOB('first')}${JOB('second', `    needs: first\n    if: ${condition}\n`)}`));
    assert.equal(dependencyFindings(flow).length, 1, `${condition} was accepted and it skips on a failed dependency`);
  }
});

test('AC-5: `needs:` is found in every spelling, so a flow or block sequence is not read as no dependency', () => {
  const spellings = ['    needs: first\n', '    needs: [first]\n', '    needs:\n      - first\n'];
  for (const needs of spellings) {
    const flow = parseWorkflow('probe.yml', reusable(`${JOB('first')}${JOB('second', needs)}`));
    assert.equal(
      dependencyFindings(flow).length,
      1,
      `${JSON.stringify(needs)} was read as declaring no dependency, so the guard passed over it`,
    );
  }
});

test('AC-6: a dependent job with no surviving condition fails the checks, naming the file and the job', () => {
  const dir = workflowDir({
    'probe.yml': reusable(`${JOB('first')}${JOB('second', '    needs: first\n')}`),
  });
  const result = examine(dir);
  const findings = result.reusables.flatMap(dependencyFindings);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'probe.yml');
  assert.equal(findings[0].job, 'second');
  // The message a maintainer actually reads carries both, since a file alone does not locate a job
  // in a workflow with three of them.
  const message = describe(findings[0]);
  assert.match(message, /probe\.yml/);
  assert.match(message, /`second`/);
  assert.throws(() => assertExamination(result, 'probe'), /probe\.yml/);
});

test('AC-6: the refusal reaches every reusable, not only the first one with a finding', () => {
  const dir = workflowDir({
    'one.yml': reusable(`${JOB('a')}${JOB('b', '    needs: a\n')}`),
    'two.yml': reusable(`${JOB('c')}${JOB('d', '    needs: c\n    if: ${{ success() }}\n')}`),
    'three.yml': reusable(`${JOB('e')}${JOB('f', '    needs: e\n    if: ${{ always() }}\n')}`),
  });
  const findings = examine(dir).reusables.flatMap(dependencyFindings);
  assert.deepEqual(
    findings.map((finding) => `${finding.file}:${finding.job}`),
    ['one.yml:b', 'two.yml:d'],
  );
});

test('AC-6: a job that depends on another job in a workflow with NO `workflow_call` is not this rule\'s business', () => {
  // The criterion is about what is PUBLISHED. A caller-side workflow here emits a context in this
  // repository only, where a skip is visible to the person who wrote it, and widening the rule would
  // be a change to files this spec does not own.
  const dir = workflowDir({
    'local.yml': `name: local\non:\n  push:\n    branches: [main]\njobs:\n${JOB('a')}${JOB('b', '    needs: a\n')}`,
    'published.yml': reusable(JOB('only')),
  });
  const result = examine(dir);
  assert.deepEqual(result.reusables.map((flow) => flow.name), ['published.yml']);
  assertExamination(result, 'published only');
});

test('AC-7: an examination that finds no reusable workflow fails rather than reporting compliance', () => {
  const dir = workflowDir({
    'local.yml': `name: local\non:\n  push:\n    branches: [main]\njobs:\n${JOB('a')}`,
  });
  const result = examine(dir);
  assert.deepEqual(result.problems, [], 'the file itself was readable, so the refusal must be about the empty set');
  assert.deepEqual(result.reusables, []);
  assert.throws(
    () => assertExamination(result, 'no reusable'),
    /read no published reusable and measured nothing/,
  );
});

test('AC-7: an empty workflow directory is the same refusal, not a clean tree', () => {
  assert.throws(() => assertExamination(examine(workflowDir({})), 'empty'), /measured nothing/);
});

test('AC-8: a workflow file that cannot be read fails naming it, and the rest is not reported clean', () => {
  // A directory at a workflow path: `readFileSync` refuses it, which is the shape of every read this
  // examination can lose. The compliant reusable beside it is what makes the case bite.
  const dir = workflowDir({ 'good.yml': reusable(JOB('only')), 'broken.yml': null });
  const result = examine(dir);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /^broken\.yml could not be read/);
  assert.deepEqual(result.reusables.map((flow) => flow.name), ['good.yml']);
  assert.throws(() => assertExamination(result, 'unreadable'), /broken\.yml could not be read/);
});

test('AC-8: a workflow with no `on:` block fails naming it, and is not passed over', () => {
  const dir = workflowDir({
    'good.yml': reusable(JOB('only')),
    'headless.yml': `name: headless\njobs:\n${JOB('a')}`,
  });
  const result = examine(dir);
  assert.deepEqual(result.problems, ['headless.yml declares no `on:` block, so nothing here can say what starts it']);
  assert.throws(() => assertExamination(result, 'headless'), /headless\.yml declares no `on:` block/);
});

test('AC-8: a reusable with no `jobs:` block is a finding, not zero findings', () => {
  const flow = parseWorkflow('empty.yml', 'name: empty\non:\n  workflow_call:\n');
  assert.deepEqual(dependencyFindings(flow).map((finding) => finding.reason), [
    'carries a `workflow_call` trigger and no `jobs:` block',
  ]);
});

test('AC-9: the tree as this change leaves it passes, and no job here declares a dependency at all', () => {
  const result = examine(join(REPO, WORKFLOWS));
  assertExamination(result, WORKFLOWS);
  // The guard introduces no red on a compliant tree, and the reason it is compliant is stated rather
  // than assumed: nothing here carries `needs:`, so the rule above is an invariant held going
  // forward and not a repair.
  const withDependencies = [];
  for (const flow of result.flows) {
    for (const job of keysOf(flow.jobs)) {
      if (declaresDependency(under(flow.jobs, job))) withDependencies.push(`${flow.name}:${job}`);
    }
  }
  assert.deepEqual(withDependencies, []);
});

// ---------------------------------------------------------------------------
// AC-10 and AC-11: the caller-visible surface, pinned
// ---------------------------------------------------------------------------
//
// A check-run context in a calling repository is named `<caller job id> / <inner job id>`. So
// renaming, removing or restructuring a job id in a published reusable silently detaches every
// caller ruleset entry that names it: no error anywhere, and no re-run that undoes it. Thirteen
// repositories call these at `@main`. The two assertions below are pinned WHOLE, at
// 56ce4c7504ab6bf2f7ec8ce5397afd828bda2daa, so a later rename has to be made on purpose.

/** Every job id of every published reusable, at the pin. */
const PUBLISHED_JOB_IDS = {
  'ci.yml': ['verify', 'prepublish', 'actionlint'],
  'codeql.yml': ['analyze'],
  'drift-check.yml': ['drift'],
  'nightly-fuzz.yml': ['fuzz'],
  'release.yml': ['release'],
  'scorecard.yml': ['analysis'],
};

/** Every workflow file and its job ids, at the pin: the whole context surface this repository emits. */
const EVERY_JOB_ID = {
  ...PUBLISHED_JOB_IDS,
  'no-emdash.yml': ['no-emdash', 'no-emdash-messages'],
  'org-defaults-coverage.yml': ['org-defaults-coverage'],
  'publish-reference.yml': ['publish-reference'],
  'self-check.yml': ['actionlint', 'scripts'],
  'self-codeql.yml': ['codeql'],
  'self-scorecard.yml': ['scorecard'],
};

test('AC-10: every job id in every published reusable is unchanged from the pin', () => {
  const result = examine(join(REPO, WORKFLOWS));
  assert.deepEqual(result.problems, []);
  const found = {};
  for (const flow of result.reusables) found[flow.name] = keysOf(flow.jobs);
  assert.deepEqual(
    found,
    PUBLISHED_JOB_IDS,
    'a job id in a published reusable moved. A caller ruleset naming `<caller job>/<inner job>` is ' +
      'detached by that with no error, on thirteen repositories, and no re-run undoes it.',
  );
});

test('AC-11: the set of workflows offering `workflow_call` is unchanged from the pin', () => {
  const result = examine(join(REPO, WORKFLOWS));
  assert.deepEqual(
    result.reusables.map((flow) => flow.name),
    Object.keys(PUBLISHED_JOB_IDS).sort(),
    'a workflow gained or lost `workflow_call`, which changes what a caller can name',
  );
});

test('AC-11: no new check-run context is introduced anywhere in this repository', () => {
  const result = examine(join(REPO, WORKFLOWS));
  assert.deepEqual(result.problems, []);
  const found = {};
  for (const flow of result.flows) found[flow.name] = keysOf(flow.jobs);
  assert.deepEqual(
    found,
    EVERY_JOB_ID,
    'a job was added, removed or renamed. Every job is a check-run context, and a context is what a ' +
      'ruleset names.',
  );
});

// ---------------------------------------------------------------------------
// AC-12: the allowance is scoped, and it relaxes nothing that already stood
// ---------------------------------------------------------------------------
//
// THE BOUNDARY, stated once. `always()` on a job that declares `needs:` keeps a dependent job
// running, which is the documented remedy for the third route. The same call on a CHECK'S OWN
// FAILURE PATH turns a real failure into a green run, which is the defect two other test files
// already refuse. Different subjects, opposite effects, one spelling. This file permits the first
// and asserts, below, that the second is still refused.

/** The constructs those two files ban, re-derived here rather than imported from a test module. */
const SUPPRESSING = [
  { what: 'a condition that survives a failed dependency', pattern: /\b(always|failure)\s*\(\s*\)/ },
  { what: 'a condition that survives a cancellation', pattern: /!\s*cancelled\s*\(\s*\)/ },
];

/** Every suppressing condition in this workflow's CODE lines, so prose saying why it is absent is safe. */
function suppressorFindings(name, text) {
  const findings = [];
  for (const line of code(text)) {
    for (const { what, pattern } of SUPPRESSING) {
      if (pattern.test(line)) findings.push(`${name} carries ${what}: ${line.trim()}`);
    }
  }
  return findings;
}

const SAME_REPO_CALL = /^\.\/\.github\/workflows\/([\w.-]+)$/;

/**
 * The paths where this repository already forbids those conditions, DERIVED rather than listed: the
 * two self-analysis callers plus whatever reusable each one's `uses:` line actually names, which is
 * how `test/self-scan.test.mjs` derives it, plus the org-defaults check's own workflow.
 */
function protectedPaths() {
  const names = new Set(['org-defaults-coverage.yml']);
  for (const caller of ['self-codeql.yml', 'self-scorecard.yml']) {
    names.add(caller);
    const flow = parseWorkflow(caller, read(join(WORKFLOWS, caller)));
    assert.equal(flow.failure, null, `${caller}: ${flow.failure}`);
    const ids = keysOf(flow.jobs);
    assert.equal(ids.length, 1, `${caller} is a thin caller and should declare exactly one job`);
    const uses = scalar(under(flow.jobs, ids[0]), 'uses');
    const match = SAME_REPO_CALL.exec(uses ?? '');
    assert.notEqual(match, null, `${caller} calls ${uses}, so the protected path cannot be derived`);
    names.add(match[1]);
  }
  return [...names].sort();
}

test('AC-12: the paths where a suppressing condition is already forbidden still carry none', () => {
  const paths = protectedPaths();
  assert.deepEqual(paths, [
    'codeql.yml',
    'org-defaults-coverage.yml',
    'scorecard.yml',
    'self-codeql.yml',
    'self-scorecard.yml',
  ]);
  for (const name of paths) {
    assert.deepEqual(
      suppressorFindings(name, read(join(WORKFLOWS, name))),
      [],
      `${name} is on a path where a check's own failure must red the run`,
    );
  }
});

test('AC-12: the allowance cannot fire on a protected path, and would not excuse the condition if it did', () => {
  const both = reusable(`${JOB('first')}${JOB('second', '    needs: first\n    if: ${{ always() }}\n')}`);
  // The dependency rule is satisfied by this shape. That is the whole of what this change permits.
  assert.deepEqual(dependencyFindings(parseWorkflow('probe.yml', both)), []);
  // The protected-path prohibition is not, and it takes no exemption for a job that declares
  // `needs:`. So the same file on a protected path is still refused, which is the boundary.
  assert.deepEqual(suppressorFindings('probe.yml', both), [
    'probe.yml carries a condition that survives a failed dependency: if: ${{ always() }}',
  ]);
  // And it cannot arise there today anyway: no job on a protected path declares a dependency.
  for (const name of protectedPaths()) {
    const flow = parseWorkflow(name, read(join(WORKFLOWS, name)));
    for (const job of keysOf(flow.jobs)) {
      assert.equal(
        declaresDependency(under(flow.jobs, job)),
        false,
        `${name}'s ${job} job declares a dependency on a path where the remedy for one is forbidden`,
      );
    }
  }
});

test('AC-12: neither existing prohibition was deleted or narrowed to make room for this one', () => {
  for (const file of ['test/self-scan.test.mjs', 'test/org-defaults-coverage.test.mjs']) {
    const text = read(file);
    const start = text.indexOf('const SUPPRESSORS = [');
    assert.notEqual(start, -1, `${file} no longer declares a SUPPRESSORS list`);
    const list = text.slice(start, text.indexOf('];', start));
    for (const spelling of [/always\|failure/, /cancelled/, /continue-on-error/]) {
      assert.match(list, spelling, `${file}'s SUPPRESSORS list no longer bans ${spelling}`);
    }
  }
});

test('AC-12: `ci.yml` still carries no dependency at all, so its host job stays unconditionally reachable', () => {
  // Held by `test/ci-docs-content.test.mjs` already. Asserted again here because this change is the
  // one that makes a `needs:` legal to write anywhere, and the docs-content gate lives inside the one
  // job in `ci.yml` that nothing can skip.
  const flow = parseWorkflow('ci.yml', read(join(WORKFLOWS, 'ci.yml')));
  for (const job of keysOf(flow.jobs)) {
    assert.equal(declaresDependency(under(flow.jobs, job)), false, `ci.yml's ${job} job declares a dependency`);
  }
});
