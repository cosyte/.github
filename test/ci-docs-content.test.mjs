// Tests over `.github/workflows/ci.yml` itself: the surface the docs-content gate promises to the
// thirteen repositories that call this workflow at `@main`.
//
// WHY THESE ARE STATIC ASSERTIONS RATHER THAN A RUN. This repository cannot run its own reusable
// `ci.yml` end to end: `verify` expects a pnpm package and this repository is not one. So the
// properties a caller depends on are asserted against the FILE, in the same suite that proves the
// checker, and the first end-to-end observation belongs to the first adopting repo. Every assertion
// here is one that, violated, hands a caller a green context over a gate that never ran or a red one
// it never opted into.
//
// The parse is deliberately line-based and dumb rather than a YAML library: this repository has no
// package.json, no lockfile and no install step (see `self-check.yml`), which is what keeps it
// verifiable with `node --test` alone.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(HERE, '../.github/workflows/ci.yml');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');
const LINES = WORKFLOW.split('\n');

/** The input this change adds, and the ONLY one it may add. */
const INPUT = 'check-docs-content';

/** The inputs that existed before this change, in file order. */
const EXISTING_INPUTS = [
  'node-versions',
  'os',
  'run-phi-scan',
  'run-actionlint',
  'run-prepublish-manifest-lint',
  'run-prepublish-install',
  'expect-unpublished-deps',
];

const indentOf = (line) => /^ */.exec(line)[0].length;

/** The index of the first line matching `pattern`. */
function lineIndex(pattern) {
  const index = LINES.findIndex((line) => pattern.test(line));
  assert.notEqual(index, -1, `ci.yml has no line matching ${pattern}`);
  return index;
}

/** Every line belonging to the block the line at `index` introduces. */
function block(index) {
  const base = indentOf(LINES[index]);
  const out = [];
  for (let i = index + 1; i < LINES.length; i += 1) {
    const line = LINES[i];
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    if (indentOf(line) <= base) break;
    out.push(line);
  }
  return out;
}

/**
 * The `verify` job's steps, one string each.
 *
 * COMMENT-ONLY LINES ARE DROPPED, and that is not tidiness: every assertion below is about what the
 * runner executes, and a comment saying the words `continue-on-error` or `|| true` (this file's
 * comments explain exactly why neither is there) is not a step doing it.
 */
function verifySteps() {
  const job = block(lineIndex(/^  verify:$/));
  const stepsAt = job.findIndex((line) => /^    steps:$/.test(line));
  assert.notEqual(stepsAt, -1, 'the verify job has no steps');
  const steps = [];
  for (const line of job.slice(stepsAt + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line) < 6) break;
    if (/^      - /.test(line)) steps.push(line);
    else if (steps.length > 0) steps[steps.length - 1] += `\n${line}`;
  }
  return steps;
}

// THE STEPS THIS CHANGE ADDS, identified by the only thing they have in common with each other and
// with nothing else in the file. Identifying them by name would let a later edit rename one out of
// every assertion below.
const addedSteps = verifySteps().filter((step) => step.includes('docs-content'));

// ---------------------------------------------------------------------------
// THE JOB SET, AND WHAT SKIPS
// ---------------------------------------------------------------------------

test('the job set is unchanged, so this change adds no status check context', () => {
  const jobs = block(lineIndex(/^jobs:$/))
    .filter((line) => /^  [a-z][\w-]*:$/.test(line))
    .map((line) => line.trim().replace(':', ''));
  assert.deepEqual(jobs, ['verify', 'prepublish', 'actionlint']);
});

test('every job-level condition is unchanged, and no job gains `continue-on-error`', () => {
  const conditions = {};
  for (const job of ['verify', 'prepublish', 'actionlint']) {
    const body = block(lineIndex(new RegExp(`^  ${job}:$`)));
    const jobLevel = body.filter((line) => indentOf(line) === 4 && line.trim() !== '');
    const ifLine = jobLevel.find((line) => /^    if:/.test(line));
    conditions[job] = ifLine ? ifLine.trim() : null;
    assert.equal(
      jobLevel.some((line) => /^    continue-on-error:/.test(line)),
      false,
      // A JOB-LEVEL `continue-on-error` is not a condition, so it satisfies every step-scoped
      // assertion below while swallowing the gate's failure and leaving the context green.
      `job ${job} must not carry a job-level continue-on-error`,
    );
  }
  assert.deepEqual(conditions, {
    verify: null,
    prepublish: 'if: ${{ inputs.run-prepublish-manifest-lint || inputs.run-prepublish-install }}',
    actionlint: 'if: ${{ inputs.run-actionlint }}',
  });
});

// A job skipped by a conditional SATISFIES its required context (measured live in `#46`, see the
// README). So a `needs:` on the input-guarded `prepublish` or `actionlint` would skip the host
// transitively and report success having never run.
test('the HOST JOB is unconditionally reachable: no job-level `if:`, and no job carries `needs:`', () => {
  const verify = block(lineIndex(/^  verify:$/));
  assert.equal(verify.some((line) => /^    if:/.test(line)), false, 'verify must have no job-level if:');
  assert.equal(verify.some((line) => /^    needs:/.test(line)), false, 'verify must depend on no job');
  assert.equal(
    LINES.some((line) => /^    needs:/.test(line)),
    false,
    'no job in ci.yml may carry needs:, or the host can be skipped through a dependency',
  );
});

// ---------------------------------------------------------------------------
// THE INPUT SURFACE
// ---------------------------------------------------------------------------

test('EXACTLY ONE input is added, and its default is false', () => {
  const inputs = block(lineIndex(/^    inputs:$/))
    .filter((line) => /^      [a-z][\w-]*:$/.test(line))
    .map((line) => line.trim().replace(':', ''));
  assert.deepEqual(inputs, [...EXISTING_INPUTS, INPUT], 'no input removed, renamed, or added beyond one');

  const definition = block(lineIndex(new RegExp(`^      ${INPUT}:$`))).join('\n');
  assert.match(definition, /^\s+type: boolean$/m);
  // THE DEFAULT IS THE WHOLE OF WHAT KEEPS THIS FROM CHANGING THIRTEEN REPOSITORIES ON MERGE.
  assert.match(definition, /^\s+default: false$/m);
});

test('no existing input is re-defaulted by this change', () => {
  const defaults = {};
  for (const name of EXISTING_INPUTS) {
    const definition = block(lineIndex(new RegExp(`^      ${name}:$`)));
    const line = definition.find((entry) => /^\s+default:/.test(entry));
    defaults[name] = line ? line.trim() : null;
  }
  assert.deepEqual(defaults, {
    'node-versions': 'default: \'["22", "24"]\'',
    os: 'default: \'["ubuntu-latest"]\'',
    'run-phi-scan': 'default: false',
    'run-actionlint': 'default: true',
    'run-prepublish-manifest-lint': 'default: true',
    'run-prepublish-install': 'default: true',
    'expect-unpublished-deps': 'default: "@cosyte/fhir=blocked"',
  });
});

// ---------------------------------------------------------------------------
// EVERY ADDED STEP, NOT ONLY THE ONE THAT RUNS THE CHECKER
// ---------------------------------------------------------------------------

test('this change adds exactly two steps, both inside the host job', () => {
  assert.equal(addedSteps.length, 2, 'the delivery step and the invocation step');
  assert.ok(addedSteps.some((step) => step.includes('curl')), 'one delivers the checker');
  assert.ok(addedSteps.some((step) => /node "\$\{RUNNER_TEMP\}\/docs-content-check\.mjs"/.test(step)), 'one runs it');
});

// EVERY is literal. An unguarded DELIVERY step would give a caller that never opted in a new way to
// fail: a `raw.githubusercontent.com` 503 reddening someone else's `verify`.
test('EVERY added step is guarded on `check-docs-content` and on no other input', () => {
  for (const step of addedSteps) {
    const conditions = [...step.matchAll(/^\s*if:\s*(.+)$/gm)].map((match) => match[1].trim());
    assert.equal(conditions.length, 1, `each added step carries exactly one condition:\n${step}`);
    assert.equal(conditions[0], `\${{ inputs.${INPUT} }}`, `unexpected condition:\n${step}`);
    const referenced = [...step.matchAll(/inputs\.([a-z][\w-]*)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(referenced)], [INPUT], `an added step reads another input:\n${step}`);
    // No condition on the caller's diff either: a `paths` filter here would skip the gate on
    // exactly the pull requests that change something else and break docs-content by removal.
    assert.doesNotMatch(step, /github\.event/, `an added step must not read the event payload:\n${step}`);
  }
});

test('NEITHER added step swallows a failure, and neither carries `continue-on-error`', () => {
  for (const step of addedSteps) {
    assert.doesNotMatch(step, /continue-on-error/, `continue-on-error would leave the context green:\n${step}`);
    assert.doesNotMatch(step, /\|\|/, `a || fallback would swallow the exit code:\n${step}`);
    assert.doesNotMatch(step, /\btee\b/, `tee-and-exit-zero prints findings into a green job:\n${step}`);
    assert.doesNotMatch(step, /exit 0/, `an explicit exit 0 defeats the gate:\n${step}`);
    assert.match(step, /^\s+shell: bash$/m, 'the shell is pinned: pwsh on a Windows cell reaches a different verdict');
    assert.match(step, /set -euo pipefail/, 'so an unset variable or a failed command is a failure');
  }
});

// THE CALLER'S WORKSPACE IS THE INPUT OF EVERY OTHER GATE IN THE SAME JOB, so no step added here
// may write into it. The checker's side of this is a before/after snapshot of a fixture workspace
// in `test/docs-content-check.test.mjs`; this is the workflow's side.
test('NO added step writes anywhere under the workspace', () => {
  for (const step of addedSteps) {
    const writes = [...step.matchAll(/(?:--output|(?<![\w"])-o|>>?)\s+"?([^"\s]+)"?/g)].map((match) => match[1]);
    for (const path of writes) {
      assert.match(path, /^\$\{RUNNER_TEMP\}\//, `an added step writes ${path}, which is not under RUNNER_TEMP`);
    }
    assert.doesNotMatch(step, /GITHUB_STEP_SUMMARY/, 'nothing here writes a summary in place of failing');
  }
});

// ---------------------------------------------------------------------------
// DELIVERY
// ---------------------------------------------------------------------------

test('delivery lands OUTSIDE the workspace, at the workflow SHA, and a failed fetch reds the job', () => {
  const [delivery] = addedSteps.filter((step) => step.includes('curl'));
  assert.ok(delivery);

  // OUTSIDE `$GITHUB_WORKSPACE`. `actions/checkout` refuses a path outside it, and a second tree
  // inside it is visible to `pnpm lint`, `pnpm format:check` and `pnpm phi-scan`.
  assert.match(delivery, /--output "\$\{RUNNER_TEMP\}\/docs-content-check\.mjs"/);
  assert.doesNotMatch(delivery, /actions\/checkout/);
  assert.doesNotMatch(delivery, /GITHUB_WORKSPACE/);

  // THE VERSION THAT RUNS IS THE ONE THE CALLER RESOLVED, not whatever `main` holds mid-run.
  assert.match(delivery, /TOOLING_SHA: \$\{\{ github\.job_workflow_sha \}\}/);
  assert.match(delivery, /raw\.githubusercontent\.com\/cosyte\/\.github\/\$\{TOOLING_SHA\}\/scripts\/docs-content-check\.mjs/);
  assert.doesNotMatch(delivery, /githubusercontent\.com\/cosyte\/\.github\/main\//);

  // A MISSING CHECKER MUST NOT READ AS ZERO FINDINGS.
  assert.match(delivery, /curl --fail/);
  assert.match(delivery, /test -s "\$\{RUNNER_TEMP\}\/docs-content-check\.mjs"/);
});

// DELIVERY FETCHES ONE FILE, so the checker must BE one file. This is the same assertion
// `test/docs-content-check.test.mjs` makes from the other side, and it is repeated here because it
// is a property of DELIVERY: what is fetched has to be everything that runs.
test('what delivery fetches is the whole program: the checker imports `node:*` only', () => {
  const source = readFileSync(resolve(HERE, '../scripts/docs-content-check.mjs'), 'utf8');
  const specifiers = [...source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map(
    (match) => match[1],
  );
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^node:/);

  const fetched = [...WORKFLOW.matchAll(/scripts\/([a-z-]+\.mjs)/g)]
    .map((match) => match[1])
    .filter((name) => name.includes('docs-content'));
  assert.deepEqual([...new Set(fetched)], ['docs-content-check.mjs'], 'one file fetched, one file imported');
});

// ---------------------------------------------------------------------------
// THE PROMISE TO A CALLER THAT NEVER OPTS IN
// ---------------------------------------------------------------------------

test('with the input false, no docs-content work is reachable in that run', () => {
  // Everything this change added is inside a step guarded on the input, and the input defaults to
  // false. There is no job-level, `env`-level or `defaults`-level trace of it anywhere else.
  const outsideSteps = LINES.filter(
    (line) => line.includes('docs-content') && !line.trim().startsWith('#'),
  ).filter((line) => !addedSteps.some((step) => step.includes(line)));
  assert.deepEqual(
    outsideSteps.map((line) => line.trim()),
    [
      `${INPUT}:`,
      'description: "Resolve docs-content/ links, images and sidebar ids (needs docs-content/sidebars.json)."',
    ],
    'docs-content appears only in the added steps and in the input definition',
  );
});
