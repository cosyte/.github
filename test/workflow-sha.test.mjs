// THE REF EVERY PIECE OF SHARED TOOLING IN THIS REPOSITORY IS FETCHED AT, AND THE EXPRESSION THAT
// SPELLED IT AS NOTHING.
//
// `github.job_workflow_sha` is not a property of the `github` context. The contexts reference gives
// that context `github.workflow_sha` and `github.workflow_ref`, both of which describe the CALLER's
// workflow file, and puts the identity of the file that defines a CALLED job on the `job` context
// instead: `job.workflow_sha`, `job.workflow_repository`, `job.workflow_ref`,
// `job.workflow_file_path`, with `job.workflow_sha` defined as "the commit SHA of the workflow file
// that defines the current job". An unknown property is not an expression error, it is `''`.
//
// THAT EMPTY STRING WAS FATAL IN ONE PLACE AND SILENT IN THE OTHER, WHICH IS WHY ONLY ONE HALF WAS
// EVER FOUND. In `ci.yml`'s docs-content delivery it degenerated a raw URL to
// `.../cosyte/.github//scripts/docs-content-check.mjs` and the first opted-in caller's `verify` died
// on a 404 four times. In `release.yml` the same value sat in four `actions/checkout` `ref:` inputs,
// and an empty `ref:` is not an error for `actions/checkout`: it resolves the provider's DEFAULT
// BRANCH. So the release environment gate, the release-notes gate, the changelog gate and the
// publish floor all ran from whatever `main` held mid-run, on thirteen repositories, on a path that
// runs every day, while the prose directly above each checkout said they came from the commit of
// this workflow file. Nothing was ever red and nothing said so.
//
// WHAT THIS FILE LOCKS, AND WHERE THE BOUNDARY WITH ITS NEIGHBOURS IS.
//
//   - The expression is refused across the WHOLE `.github/workflows/` directory, not in one file.
//     `test/ci-docs-content-delivery.test.mjs` refuses it in `ci.yml`, which is where it was found;
//     a paste into any other workflow was invisible to every test in this repository until here.
//   - Every `cosyte/.github` tooling checkout in `release.yml` resolves its ref from the property
//     the docs-content delivery reads, and every one of them is ANNOUNCED first. There are four,
//     and the count is asserted: a fifth added without an announcement, or one moved away from the
//     step that announces it, is a finding rather than a silent gap.
//   - The caller-visible job ids of both published workflows, because a job id is the check-run
//     context a caller's branch protection names and renaming one detaches that ruleset entry with
//     no error anywhere.
//
// It reads `release.yml` through `test/workflow-reader.mjs`, this repository's one reader for that
// file, and is recorded in `CONVERGED_ON_THE_SHARED_READER` in `test/environment-gate.test.mjs`.
// The question here IS composition: which step checks out what, at which ref, with what before it.
//
// Every examination below is a FUNCTION OVER TEXT rather than an assertion over the delivered file,
// and each one is run twice: once over the tree as this change leaves it, and once over a mutated
// copy of a real workflow that breaks the property. A check that has never been shown to fail is
// not evidence, and three of the four things asserted here were true of a file that was wrong.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { decomment, parseWorkflow, readWorkflow } from './workflow-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WORKFLOWS = '.github/workflows';
const WORKFLOWS_DIR = join(REPO, WORKFLOWS);

const RELEASE = 'release.yml';
const CI = 'ci.yml';

const read = (name) => readWorkflow(join(WORKFLOWS_DIR, name), readFileSync);

/** Every tracked workflow, so a later addition is covered rather than merely not listed. */
const ALL_WORKFLOWS = readdirSync(WORKFLOWS_DIR)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

/** The one expression that names the commit of the workflow file defining a CALLED job. */
const REF_EXPRESSION = '${{ job.workflow_sha }}';

/** The expression this repository shipped, which is `''` wherever it is read. */
const EMPTY_EXPRESSION = 'github.job_workflow_sha';

/** The tooling checkouts in `release.yml` at the pin. A fifth is fine; an unannounced one is not. */
const TOOLING_CHECKOUTS = 4;

/** The label of the step that says which commit the checkout beside it is about to resolve. */
const ANNOUNCEMENT = 'Say which commit the release tooling comes from';

/**
 * The whole program the announcement runs, pinned as one string.
 *
 * `parseStep` folds a `run: |` body onto one line with single spaces, so equality with this IS the
 * step's whole program. Pinned rather than pattern matched for the reason
 * `test/environment-gate.test.mjs` pins the same string: this step is allowed to run before the
 * release environment gate, and an allowance keyed on a label or a substring would let it grow a
 * fetch or a credential later while still satisfying the assertion that admitted it.
 */
const ANNOUNCEMENT_SCRIPT = [
  'set -euo pipefail',
  'ref="${TOOLING_SHA}"',
  'if [ -z "${ref}" ]; then',
  'echo "release tooling: job.workflow_sha was empty, falling back to the cosyte/.github default branch" >&2',
  'ref="(the cosyte/.github default branch)"',
  'fi',
  'echo "release tooling: ref ${ref}, from cosyte/.github"',
].join(' ');

// ---------------------------------------------------------------------------
// THE EXPRESSION, REFUSED ACROSS THE WHOLE DIRECTORY
// ---------------------------------------------------------------------------

/**
 * Every line of a workflow the runner acts on, with its 1-based number in the file.
 *
 * COMMENTS ARE NOT EXECUTABLE AND THIS DIRECTORY IS FULL OF THEM: `ci.yml` and `release.yml` both
 * explain the defect at length and quote the expression while doing it, so a sweep that could not
 * tell prose from configuration would either fail on its own documentation or force the
 * documentation to be deleted, which is how the reason for a rule gets lost.
 *
 * A `#` line inside a `run: |` body is CONTENT the runner's shell receives rather than a comment,
 * and `decomment` from the shared reader is what knows the difference. It returns lines and not
 * numbers, so the numbers are recovered by walking the file and the kept lines together. Every line
 * the walk steps over is asserted to be comment shaped, so a mapping that has slipped is a failing
 * test rather than a line number quietly naming the wrong line.
 */
function executableLines(text) {
  const original = text.split('\n');
  const kept = decomment(text);
  const out = [];
  let at = 0;
  for (const line of kept) {
    while (at < original.length && original[at] !== line) {
      assert.match(original[at], /^\s*#/, `the comment stripper dropped a line that is not a comment: ${original[at]}`);
      at += 1;
    }
    assert.ok(at < original.length, 'the kept lines are not a subsequence of the file, so the numbering has slipped');
    out.push({ number: at + 1, text: line });
    at += 1;
  }
  return out;
}

/** Every executable line of this workflow that names the expression, as a maintainer reads it. */
function bannedExpressionFindings(name, text) {
  return executableLines(text)
    .filter((line) => line.text.includes(EMPTY_EXPRESSION))
    .map((line) => `${WORKFLOWS}/${name}:${line.number}: ${line.text.trim()}`);
}

test('NO WORKFLOW IN THIS REPOSITORY INTERPOLATES `github.job_workflow_sha`, in any file', () => {
  assert.ok(ALL_WORKFLOWS.length > 0, 'the sweep found no workflow files at all, so it measured nothing');
  const findings = ALL_WORKFLOWS.flatMap((name) => bannedExpressionFindings(name, read(name)));
  assert.deepEqual(
    findings,
    [],
    `${EMPTY_EXPRESSION} is not a property of the github context. It evaluates to '' , an empty ` +
      '`ref:` resolves the provider default branch and an empty URL segment 404s, so a run that ' +
      'reads it either fetches nothing or fetches from a commit nobody named.',
  );
});

test('and the sweep is READING those files: the expression is still explained in prose, and passed over', () => {
  // The control that keeps the assertion above from being vacuous. Two workflows document the
  // defect and quote the expression while doing it; if that prose is ever deleted, this fails and
  // the next reader is told that the sweep now proves less than it looks like it proves.
  const explaining = ALL_WORKFLOWS.filter((name) => read(name).includes(EMPTY_EXPRESSION));
  assert.deepEqual(
    explaining,
    [CI, RELEASE, 'workflow-sha-probe.yml'].sort(),
    'the files that explain the defect are the two it was in, and the probe that measures the fix',
  );
  for (const name of explaining) {
    assert.equal(bannedExpressionFindings(name, read(name)).length, 0, `${name}: prose was read as configuration`);
  }
});

test('THE SWEEP NAMES THE FILE AND THE LINE when the expression is reintroduced into a real workflow', () => {
  for (const [name, from, to] of [
    [CI, 'TOOLING_SHA: ${{ job.workflow_sha }}', 'TOOLING_SHA: ${{ github.job_workflow_sha }}'],
    [RELEASE, 'ref: ${{ job.workflow_sha }}', 'ref: ${{ github.job_workflow_sha }}'],
  ]) {
    const original = read(name);
    assert.ok(original.includes(from), `${name} no longer contains ${from}, so this control measures nothing`);
    // The expected line is derived from WHERE the replacement happened rather than by searching the
    // mutated text for it: both files quote the bad spelling in prose, and a search finds the
    // comment first, which would have this control agreeing with a sweep that had read the comment.
    const expected = original.slice(0, original.indexOf(from)).split('\n').length;
    const mutated = original.replace(from, () => to);
    const findings = bannedExpressionFindings(name, mutated);
    assert.equal(findings.length, 1, `the sweep found ${findings.length} offenders in the mutated ${name}`);
    assert.equal(findings[0], `${WORKFLOWS}/${name}:${expected}: ${to}`);
  }
});

test('a comment is still a comment, and a `#` line inside a `run:` body is still content', () => {
  const commented = `name: x\non:\n  push:\njobs:\n  j:\n    steps:\n      # ${EMPTY_EXPRESSION} is what this used to read\n      - run: echo ok\n`;
  assert.deepEqual(bannedExpressionFindings('synthetic.yml', commented), [], 'prose must not be a finding');

  const inABody = `name: x\non:\n  push:\njobs:\n  j:\n    steps:\n      - run: |\n          # ${EMPTY_EXPRESSION}\n          echo ok\n`;
  assert.equal(
    bannedExpressionFindings('synthetic.yml', inABody).length,
    1,
    'a `#` line inside a block scalar is a line the shell receives, not a comment',
  );
});

// ---------------------------------------------------------------------------
// EVERY `cosyte/.github` TOOLING CHECKOUT IN `release.yml`
// ---------------------------------------------------------------------------

const isToolingCheckout = (step) =>
  /uses: actions\/checkout@/.test(step.body) && step.with.repository === 'cosyte/.github';

/**
 * The announcement, closed to exactly what it is: no action, no input, one variable, one program.
 *
 * The same predicate, with the same clauses, guards the release environment gate in
 * `test/environment-gate.test.mjs`. Both are here because the step is allowed somewhere a step
 * usually is not, and an allowance nothing can fail is how this file's subject survived in the
 * first place.
 */
const isAnnouncement = (step) =>
  step.fields.uses === undefined &&
  Object.keys(step.with).length === 0 &&
  Object.keys(step.env).length === 1 &&
  step.env.TOOLING_SHA === REF_EXPRESSION &&
  step.fields.run === ANNOUNCEMENT_SCRIPT;

/**
 * Every way a tooling checkout in this text resolves its ref from something other than the one
 * property, or resolves it without saying so first.
 *
 * A FUNCTION OVER TEXT, so the delivered file and a mutated copy of it go through the same code.
 * Finding nothing in a file with no checkouts in it is itself a finding: an examination that read
 * nothing must not report compliance.
 */
function toolingRefFindings(text) {
  const workflow = parseWorkflow(text);
  const findings = [];
  let seen = 0;
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      if (!isToolingCheckout(step)) continue;
      seen += 1;
      const at = `job \`${job.id}\` step ${step.index} ("${step.label}")`;
      if (step.with.ref !== REF_EXPRESSION) {
        findings.push(
          `${at} checks out cosyte/.github at \`${step.with.ref}\` rather than \`${REF_EXPRESSION}\`, ` +
            'so the scripts it runs come from the provider default branch rather than from the ' +
            'commit of the workflow file that defines this job',
        );
      }
      const previous = job.steps[step.index - 1];
      if (previous === undefined || !isAnnouncement(previous)) {
        findings.push(
          `${at} checks out cosyte/.github with nothing announcing the ref before it, so a run ` +
            'cannot say which commit its gate scripts came from, and an empty ref falls back to ' +
            'the provider default branch in silence',
        );
      }
    }
  }
  if (seen === 0) {
    findings.push('no cosyte/.github tooling checkout was found at all, so this examination measured nothing');
  }
  return findings;
}

test('EVERY `cosyte/.github` TOOLING CHECKOUT resolves the ref from `job.workflow_sha`, and says so first', () => {
  const text = read(RELEASE);
  assert.deepEqual(toolingRefFindings(text), []);

  // The count is pinned so that a checkout deleted, or one added somewhere the examination cannot
  // see, is a decision rather than a quieter tree. Four is what the split left: two per job,
  // because the caller checkout between them deletes the first one.
  const checkouts = parseWorkflow(text).jobs.flatMap((job) => job.steps.filter(isToolingCheckout));
  assert.equal(checkouts.length, TOOLING_CHECKOUTS, 'the number of tooling checkouts moved');
  for (const step of checkouts) assert.equal(step.with.ref, REF_EXPRESSION);
});

test('the release resolution IS the docs-content delivery resolution, one property and not two', () => {
  // The two halves of one defect, and the whole point of fixing the second was that it is the same
  // property as the first. Compared across the two files rather than asserted twice.
  // Read off an EXECUTABLE line: `ci.yml` quotes the spelling it shipped with in the prose above
  // the step, and a scan of the raw text finds that sentence before it finds the step.
  const delivered = executableLines(read(CI))
    .map((line) => /TOOLING_SHA: (\$\{\{ [^}]*\}\})/.exec(line.text))
    .filter((match) => match !== null);
  assert.equal(delivered.length, 1, 'ci.yml carries exactly one docs-content delivery ref, or this is vacuous');
  const delivery = delivered[0];
  assert.equal(delivery[1], REF_EXPRESSION);
  for (const step of parseWorkflow(read(RELEASE)).jobs.flatMap((job) => job.steps.filter(isToolingCheckout))) {
    assert.equal(step.with.ref, delivery[1], 'the release checkouts must read what the delivery reads');
  }
});

test('THE EXAMINATION FAILS on a ref that is not the property, naming the job and the step', () => {
  const mutated = read(RELEASE).replace('ref: ${{ job.workflow_sha }}', () => 'ref: ${{ github.job_workflow_sha }}');
  const findings = toolingRefFindings(mutated);
  assert.equal(findings.length, 1, `expected exactly one finding, got:\n${findings.join('\n')}`);
  assert.match(findings[0], /job `version` step \d+/, 'the finding names the job and the step');
  assert.match(findings[0], /github\.job_workflow_sha/, 'and the ref it found');
});

test('THE EXAMINATION FAILS on a ref pinned to a branch, which is what an empty one silently became', () => {
  const mutated = read(RELEASE).replace('ref: ${{ job.workflow_sha }}', () => 'ref: main');
  const findings = toolingRefFindings(mutated);
  assert.equal(findings.length, 1, `expected exactly one finding, got:\n${findings.join('\n')}`);
  assert.match(findings[0], /rather than/, 'the finding says what it should have been');
});

/** The same workflow with the first announcement step deleted, to prove the pairing is checked. */
function withoutFirstAnnouncement(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${ANNOUNCEMENT}`);
  assert.notEqual(start, -1, 'the announcement step is not where this mutation expects it');
  let end = start + 1;
  while (end < lines.length && !/^ {6}- /.test(lines[end])) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

test('THE EXAMINATION FAILS when a checkout is left with nothing announcing its ref', () => {
  const findings = toolingRefFindings(withoutFirstAnnouncement(read(RELEASE)));
  assert.equal(findings.length, 1, `expected exactly one finding, got:\n${findings.join('\n')}`);
  assert.match(findings[0], /nothing announcing the ref before it/);
});

test('THE EXAMINATION FAILS when the announcement stops being the announcement', () => {
  // Not "a step called that is there": a step whose program has changed is a step that no longer
  // says what it is credited with saying, and the fallback line is the whole of what makes an
  // empty ref legible rather than silent.
  const withoutFallback = read(RELEASE).replace(
    'echo "release tooling: job.workflow_sha was empty, falling back to the cosyte/.github default branch" >&2',
    () => 'true',
  );
  const findings = toolingRefFindings(withoutFallback);
  assert.ok(findings.length >= 1, 'an announcement that no longer announces the fallback must be a finding');
  assert.match(findings[0], /nothing announcing the ref before it/);

  const grown = read(RELEASE).replace(
    'echo "release tooling: ref ${ref}, from cosyte/.github"',
    () => 'echo "release tooling: ref ${ref}, from cosyte/.github"\n            curl -sSfL https://example.invalid/x',
  );
  assert.ok(toolingRefFindings(grown).length >= 1, 'a step that has grown a fetch is no longer the announcement');
});

test('the announcement RUNS BEFORE the checkout it announces, and it swallows nothing', () => {
  const workflow = parseWorkflow(read(RELEASE));
  const announcements = workflow.jobs.flatMap((job) => job.steps.filter(isAnnouncement));
  assert.equal(announcements.length, TOOLING_CHECKOUTS, 'one announcement per tooling checkout');
  for (const step of announcements) {
    assert.equal(step.fields.shell, 'bash', 'the shell is pinned, so the script is the script everywhere');
    assert.equal(step.fields.if, undefined, 'a step behind a condition can be skipped, and a skip reads as a pass');
    assert.equal(step.fields['continue-on-error'], undefined);
    assert.match(step.fields.run, /^set -euo pipefail /, 'an unset variable must fail rather than read as empty');
    assert.doesNotMatch(step.fields.run, /\|\| true|\btee\b|\bexit 0\b/);
    // The fallback is a SUBSTITUTION, not a refusal: the run proceeds on the provider default
    // branch, which is what an empty `ref:` has been resolving here all along.
    assert.match(step.fields.run, /falling back to the cosyte\/\.github default branch/);
    assert.doesNotMatch(step.fields.run, /exit 1/, 'an empty ref must not fail the release, only be said out loud');
  }
});

// ---------------------------------------------------------------------------
// THE ANNOUNCEMENT, EXTRACTED AND RUN
// ---------------------------------------------------------------------------
//
// The assertions above compare the announcement's text. This runs it. What the criterion is about
// is a LOG LINE and a run that PROCEEDS, and neither is a property of a string: an announcement
// that names the wrong thing, or one whose empty branch exits non-zero, would satisfy every
// comparison above and would still be a release refused by its own logging.

/** Every `- name: <ANNOUNCEMENT>` step's `run: |` block, dedented to what the runner hands to bash. */
function announcementScripts(text) {
  const lines = text.split('\n');
  const scripts = [];
  for (const [at, line] of lines.entries()) {
    if (line !== `      - name: ${ANNOUNCEMENT}`) continue;
    const body = [];
    let seenRun = false;
    for (let index = at + 1; index < lines.length; index += 1) {
      const next = lines[index];
      if (next.trim() === '') continue;
      if (indentOf(next) <= 6) break;
      if (/^ {8}run: \|$/.test(next)) {
        seenRun = true;
        continue;
      }
      if (seenRun) {
        if (indentOf(next) < 10) break;
        body.push(next.slice(10));
      }
    }
    assert.ok(seenRun && body.length > 0, 'an announcement step has no `run: |` block this reader can see');
    scripts.push(`${body.join('\n')}\n`);
  }
  return scripts;
}

const indentOf = (line) => line.length - line.replace(/^ */, '').length;

/** Run one announcement script exactly as extracted, with the value a runner would have supplied. */
function runAnnouncement(script, sha) {
  const environment = { ...process.env };
  if (sha === undefined) delete environment.TOOLING_SHA;
  else environment.TOOLING_SHA = sha;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: environment });
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const SHA = '213c8547929e163359fc641da76d791fcf9495a2';

test('ALL FOUR ANNOUNCEMENTS ARE THE SAME PROGRAM, so one reading of it covers every site', () => {
  const scripts = announcementScripts(read(RELEASE));
  assert.equal(scripts.length, TOOLING_CHECKOUTS, 'one announcement per tooling checkout');
  for (const script of scripts) assert.equal(script, scripts[0], 'four sites, four copies, one program');
});

test('A RESOLVED REF IS NAMED IN THE LOG, before the checkout that uses it', () => {
  const [script] = announcementScripts(read(RELEASE));
  const run = runAnnouncement(script, SHA);
  assert.equal(run.code, 0, run.output);
  assert.equal(run.output.trim(), `release tooling: ref ${SHA}, from cosyte/.github`);
});

test('AN EMPTY REF IS ANNOUNCED AND THE RUN PROCEEDS, which is what silence cost here', () => {
  const [script] = announcementScripts(read(RELEASE));
  const run = runAnnouncement(script, '');
  // PROCEEDS. An empty `ref:` resolves the provider default branch, which is what this path has
  // been doing all along; refusing it here would turn a fixed log line into thirteen red releases.
  assert.equal(run.code, 0, `an empty ref must be said out loud, not refused:\n${run.output}`);
  // The two facts the criterion asks for: which property was read, and what the run is doing now.
  assert.match(run.output, /job\.workflow_sha was empty/, run.output);
  assert.match(run.output, /falling back to the cosyte\/\.github default branch/, run.output);
  // ... and the substituted ref is what the following line reports, so the log never claims a
  // commit it did not resolve.
  assert.match(run.output, /release tooling: ref \(the cosyte\/\.github default branch\), from cosyte\/\.github/);
  assert.equal(run.output.includes(SHA), false);
});

test('AN UNSET REF FAILS, because `set -u` is load-bearing rather than decorative', () => {
  const [script] = announcementScripts(read(RELEASE));
  const run = runAnnouncement(script, undefined);
  assert.notEqual(run.code, 0, 'an unset TOOLING_SHA must not be read as an empty one');
  assert.match(run.output, /TOOLING_SHA/, run.output);
});

test('the extraction can fail, so the four runs above are not run over something invented', () => {
  const withoutRun = read(RELEASE).replace('        run: |\n          set -euo pipefail\n          ref="${TOOLING_SHA}"', () => '        run: echo hi');
  assert.throws(() => announcementScripts(withoutRun), /no `run: \|` block this reader can see/);
});

// ---------------------------------------------------------------------------
// THE CALLER-VISIBLE JOB IDS OF BOTH PUBLISHED WORKFLOWS
// ---------------------------------------------------------------------------

/**
 * The job ids of a workflow, read line by line.
 *
 * `ci.yml` is not readable by the shared reader (its `strategy:`/`matrix:` block nests deeper than
 * that reader models, and it refuses what it cannot read rather than guessing), and the question
 * here is only which keys sit directly under `jobs:`.
 */
function jobIds(name, text) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.notEqual(at, -1, `${name} has no top-level \`jobs:\` key`);
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break;
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) out.push(job[1]);
  }
  assert.ok(out.length > 0, `${name} declares \`jobs:\` and nothing under it`);
  return out;
}

test('THE JOB IDS OF BOTH PUBLISHED WORKFLOWS ARE UNCHANGED, in the file and through the shared reader', () => {
  // A job id is the check-run context a caller's branch protection names: a caller's ruleset entry
  // reads `<caller job id> / <inner job id>`, so renaming one here detaches that entry on thirteen
  // repositories with no error anywhere and no re-run that undoes it. Nothing in this change may
  // move one, and both files are read because both are required contexts somewhere.
  assert.deepEqual(jobIds(CI, read(CI)), ['verify', 'prepublish', 'actionlint']);
  assert.deepEqual(jobIds(RELEASE, read(RELEASE)), ['version', 'release']);
  assert.deepEqual(
    parseWorkflow(read(RELEASE)).jobs.map((job) => job.id),
    ['version', 'release'],
    'the shared reader and the line reader must agree, or one of them is reading a different file',
  );
});

test('the job id reader can fail, so the assertion above is not a tautology', () => {
  const renamed = read(RELEASE).replace('\n  version:\n', () => '\n  version-pr:\n');
  assert.deepEqual(jobIds(RELEASE, renamed), ['version-pr', 'release'], 'a renamed job must be seen as renamed');
  assert.throws(() => jobIds('synthetic.yml', 'name: x\non:\n  push:\n'), /no top-level `jobs:` key/);
  assert.throws(() => jobIds('synthetic.yml', 'jobs:\n'), /declares `jobs:` and nothing under it/);
});

test('`check-docs-content` is still an optional boolean defaulting to false, so no caller changes', () => {
  // The opt-in shape S0077-x12-docs-checker-adoption adopts by setting to true. An input made
  // required, renamed, or defaulted differently is thirteen pipelines changing behaviour on their
  // next run, which is the one thing this change is not allowed to do.
  const lines = read(CI).split('\n');
  const at = lines.findIndex((line) => /^ {6}check-docs-content:$/.test(line));
  assert.notEqual(at, -1, 'ci.yml no longer declares the docs-content input');
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && /^ {0,6}\S/.test(line)) break;
    body.push(line.trim());
  }
  assert.ok(body.includes('type: boolean'), `the input is not a boolean: ${body.join(' | ')}`);
  assert.ok(body.includes('default: false'), `the input does not default to false: ${body.join(' | ')}`);
  assert.equal(body.includes('required: true'), false, 'an input made required breaks every caller that omits it');
});
