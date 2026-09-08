// THE PROBE THAT ASKS A RUNNER, AND THE WIRING THAT KEEPS IT FROM BEING SKIPPED INTO A GREEN CHECK.
//
// WHAT NO TEST IN THIS REPOSITORY CAN DECIDE. `${{ job.workflow_sha }}` is a string until GitHub
// evaluates it, and an unknown context property is not an expression error, it is `''`. So every
// offline assertion about it compares text, and a full green suite is exactly what this org had
// while `github.job_workflow_sha` was shipping the empty string to a caller: the delivery 404ed
// four times before anyone read the value. `.github/workflows/workflow-sha-probe.yml` reads the
// property on a GitHub-hosted runner, prints it, and fails the run unless it is a 40 character
// lowercase hexadecimal commit SHA. That measurement is the evidence; this file is not.
//
// WHAT THIS FILE IS FOR, THEN. A probe that never runs reports the same green as one that ran and
// passed. A job skipped by a condition concludes `skipped`, and a required context counts a skip as
// SUCCESS; a matrix built from an empty value produces zero jobs, and zero jobs report as satisfied
// too. Both are a green check over nothing measured, which is the failure this repository has
// already met twice and documents under "What a skipped required context does to a merge". So the
// probe's own wiring is asserted here, offline, against the tracked files: it runs on every pull
// request and every push to the default branch, from a job with no condition, no dependency, no
// matrix and no `continue-on-error`, called through the same-repository `uses:` form so that a pull
// request is probed with the definition that pull request itself proposes.
//
// AND THE PROBE'S OWN SCRIPT IS EXTRACTED AND RUN, once per answer a runner can give it: a real
// SHA, the empty string, the literal `main`, an uppercase SHA, a short one, and an unset variable.
// A grader that has never been shown to fail is not a grader, and "it would have caught the empty
// string" is exactly the claim that was believed here before.
//
// The parse is line based and deliberately dumb, in the style of `test/self-scan.test.mjs`: this
// repository has no package.json and therefore no YAML library, on purpose, so that it needs no
// install step to stay verifiable. `actionlint` in `self-check.yml` is what proves these files are
// valid YAML.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseWorkflow } from './workflow-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WORKFLOWS = '.github/workflows';

/** The reusable that takes the measurement. It is called from inside this repository and nowhere else. */
const PROBE = 'workflow-sha-probe.yml';

/** The thin caller that starts it, in the shape `self-codeql.yml` set. */
const CALLER = 'self-workflow-sha-probe.yml';

/** The one expression that names the commit of the workflow file defining a CALLED job. */
const REF_EXPRESSION = '${{ job.workflow_sha }}';

const read = (name) => readFileSync(join(REPO, WORKFLOWS, name), 'utf8');

// ---------------------------------------------------------------------------
// The narrow reader
// ---------------------------------------------------------------------------

const indentOf = (line) => line.length - line.trimStart().length;

/** Code lines only: comment-only and blank lines dropped, trailing comments stripped. */
function code(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, '').trimEnd());
}

const isKey = (line, key, indent) => indentOf(line) === indent && new RegExp(`^${key}:( |$)`).test(line.trim());

const levelOf = (lines) => (lines.length === 0 ? 0 : indentOf(lines[0]));

/** The lines nested under `key:` in this block, or null when the key is absent. */
function under(lines, key) {
  if (lines === null) return null;
  const level = levelOf(lines);
  const start = lines.findIndex((line) => isKey(line, key, level));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && indentOf(line) <= level);
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

/** The one-line scalar written after `key:` in this block, unquoted, or null. */
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

/** A workflow read as configuration: its code lines, its `on:` block and its `jobs:` block. */
function workflow(name) {
  const lines = code(read(name));
  const triggers = under(lines, 'on');
  assert.notEqual(triggers, null, `${name} declares no \`on:\` block`);
  const jobs = under(lines, 'jobs');
  assert.notEqual(jobs, null, `${name} declares no \`jobs:\` block`);
  return { name, lines, triggers, jobs };
}

/** The one job of a workflow: its id and its block. Both files here have exactly one. */
function onlyJob(flow) {
  const ids = keysOf(flow.jobs);
  assert.equal(ids.length, 1, `${flow.name} should declare exactly one job, and declares ${ids.length}`);
  return { id: ids[0], block: under(flow.jobs, ids[0]) };
}

/** A job's `permissions:` block as a map of scope to level. */
function permissionsOf(block, label) {
  const declared = under(block, 'permissions');
  assert.notEqual(declared, null, `${label} declares no job-level \`permissions:\``);
  const granted = new Map();
  for (const scope of keysOf(declared)) granted.set(scope, scalar(declared, scope));
  assert.ok(granted.size > 0, `${label}'s \`permissions:\` block is empty`);
  return granted;
}

/** `none` < `read` < `write`. A caller may grant more than the reusable asks, never less. */
const LEVEL = { none: 0, read: 1, write: 2 };

/** A `uses:` value naming a workflow in THIS repository, resolved from the commit under test. */
const SAME_REPO_CALL = /^\.\/\.github\/workflows\/([\w.-]+)$/;

/** A `uses:` value reaching this repository from outside it, whatever ref it names. */
const CROSS_REPO_CALL = /[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+@\S+/;

// ---------------------------------------------------------------------------
// The wiring: the probe cannot be skipped into a green check
// ---------------------------------------------------------------------------

test('the probe is reached through the same-repository `uses:` form, with no ref', () => {
  const flow = workflow(CALLER);
  const job = onlyJob(flow);
  const uses = scalar(job.block, 'uses');
  assert.notEqual(uses, null, `${CALLER}'s ${job.id} job declares no \`uses:\``);
  assert.match(
    uses,
    SAME_REPO_CALL,
    `${CALLER} calls ${uses}. GitHub documents \`./.github/workflows/{filename}\` as the form for a ` +
      'reusable workflow in the same repository, and only that form is resolved from the same commit ' +
      'as the caller, which is the whole of what makes the measured value mean anything.',
  );
  assert.equal(SAME_REPO_CALL.exec(uses)[1], PROBE, 'the caller must name the probe and not something else');
  assert.ok(!uses.includes('@'), `${CALLER} names a ref (${uses}); a ref is a thing that can move`);
});

test('nothing anywhere in either file reaches this repository from outside it', () => {
  // The whole file, comments included: an example in a header is copied at least as readily as the
  // line under it, and this is the repository whose entire point is that a reference at a branch is
  // the defect.
  for (const name of [CALLER, PROBE]) {
    for (const line of read(name).split('\n')) {
      assert.ok(!CROSS_REPO_CALL.test(line), `${name} spells a cross-repository self reference: ${line.trim()}`);
    }
  }
});

test('the probe runs on every pull request and every push to the default branch, unfiltered', () => {
  const flow = workflow(CALLER);
  const triggers = keysOf(flow.triggers);
  for (const trigger of ['pull_request', 'push']) {
    assert.ok(triggers.includes(trigger), `${CALLER} does not run on ${trigger}`);
    const body = under(flow.triggers, trigger);
    assert.equal(scalar(body, 'branches'), '[main]', `${CALLER}'s ${trigger} trigger does not name the default branch`);
    // A `paths:` filter would skip the probe on exactly the pull requests that change something
    // else and break the resolution by removal, and a skipped required context reports as a pass.
    for (const filter of ['paths', 'paths-ignore']) {
      assert.ok(!keysOf(body).includes(filter), `${CALLER} filters its ${trigger} trigger on ${filter}`);
    }
  }
});

test('neither job can be skipped: no condition, no dependency, no matrix, on either side', () => {
  for (const name of [CALLER, PROBE]) {
    const flow = workflow(name);
    const job = onlyJob(flow);
    for (const key of ['if', 'needs', 'strategy', 'continue-on-error']) {
      assert.ok(
        !keysOf(job.block).includes(key),
        `${name}'s ${job.id} job declares \`${key}:\`. A job skipped by a condition or a failed ` +
          'dependency concludes `skipped`, a required context counts that as success, and a matrix ' +
          'built from a value that can be empty produces zero jobs, which report as satisfied too.',
      );
    }
  }
});

test('the probe job runs on a real GitHub-hosted runner, named literally rather than computed', () => {
  const job = onlyJob(workflow(PROBE));
  // Not an expression and not an input: a `runs-on` resolved from something that can be empty is a
  // job that never starts, and a job that never starts reports as a satisfied context.
  assert.equal(scalar(job.block, 'runs-on'), 'ubuntu-latest');
});

test('the caller grants every permission the probe declares', () => {
  const caller = onlyJob(workflow(CALLER));
  const probe = onlyJob(workflow(PROBE));
  const needed = permissionsOf(probe.block, `${PROBE}'s ${probe.id} job`);
  const granted = permissionsOf(caller.block, `${CALLER}'s ${caller.id} job`);
  for (const [scope, level] of needed) {
    assert.ok(
      granted.has(scope),
      `${CALLER} does not grant ${scope}, which ${PROBE} declares. A called workflow can only ` +
        'downgrade the caller token, never escalate it, so the run startup-fails instead.',
    );
    assert.ok(LEVEL[granted.get(scope)] >= LEVEL[level], `${CALLER} grants ${scope}: ${granted.get(scope)}`);
  }
});

test('the probe reusable is legible to the STRICTEST reader in this repository, not only to this one', () => {
  // The readers in this file and in `test/self-scan.test.mjs` are deliberately dumb, and a dumb
  // reader passes over what it does not recognise. `test/workflow-reader.mjs` refuses any line it
  // cannot resolve to a single value and names it, so putting the added file through it is a check
  // on the shape of what was written rather than on what a permissive reader chose to see. It is
  // not a YAML validity proof: `actionlint` in `self-check.yml` is that, and it runs on every push.
  const parsed = parseWorkflow(read(PROBE));
  assert.deepEqual(parsed.jobs.map((job) => job.id), ['probe']);
  const job = parsed.byId.probe;
  assert.equal(job.steps.length, 1, 'the probe is one step, and nothing runs beside it');
  assert.equal(job.keys['runs-on'], 'ubuntu-latest');
  assert.deepEqual(job.blocks.permissions, { contents: 'read' });
  assert.equal(job.steps[0].env.TOOLING_SHA, REF_EXPRESSION);
  assert.equal(job.steps[0].fields.shell, 'bash');
  assert.equal(job.steps[0].fields.if, undefined);
  assert.equal(job.steps[0].fields.uses, undefined, 'the probe runs no action, so it fetches nothing');
});

test('the caller is not itself a reusable workflow, so no outside repository can name it', () => {
  assert.ok(
    !keysOf(workflow(CALLER).triggers).includes('workflow_call'),
    `${CALLER} declares \`workflow_call\`, which offers this repository's token to a caller`,
  );
});

/** The constructs that turn "this probe did not complete" into a green run. */
const SUPPRESSORS = [
  { what: '`continue-on-error`', pattern: /(^|\s)continue-on-error\s*:/ },
  { what: 'a `|| true` style shell swallow', pattern: /\|\|\s*(true\b|:\s|:$|exit\s+0\b)/ },
  { what: '`set +e`', pattern: /(^|;|\s)set\s+\+e/ },
  { what: 'a trailing `exit 0`', pattern: /(^|;|&&|\s)exit\s+0\b/ },
  { what: 'a condition that survives a failed dependency', pattern: /\b(always|failure)\s*\(\s*\)/ },
  { what: 'a condition that survives a cancellation', pattern: /!\s*cancelled\s*\(\s*\)/ },
];

test('nothing on the probe path suppresses a failure', () => {
  for (const name of [CALLER, PROBE]) {
    for (const line of code(read(name))) {
      for (const { what, pattern } of SUPPRESSORS) {
        assert.ok(
          !pattern.test(line),
          `${name} carries ${what} on the probe path: ${line.trim()}. A probe that cannot red the ` +
            'run records an absent measurement as a passing one.',
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The probe's own script, extracted and RUN
// ---------------------------------------------------------------------------

/** Every line of the step introduced by `- name: <name>` at step indent 6, in the raw file. */
function stepBody(name, label) {
  const lines = read(name).split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${label}`);
  assert.notEqual(start, -1, `${name} has no step named "${label}"`);
  const out = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    if (indentOf(line) <= 6) break;
    out.push(line);
  }
  return out;
}

/** The step's `env:` mapping, values verbatim so an expression can be compared as written. */
function stepEnv(body) {
  const at = body.findIndex((line) => /^ {8}env:$/.test(line));
  assert.notEqual(at, -1, 'the probe step declares no `env:`');
  const out = {};
  for (let index = at + 1; index < body.length; index += 1) {
    const line = body[index];
    if (line.trim() === '') continue;
    if (indentOf(line) < 10) break;
    const match = /^ {10}([A-Za-z_][\w]*): (.+)$/.exec(line);
    assert.ok(match, `unreadable env entry in ${PROBE}: ${line}`);
    out[match[1]] = match[2].trim();
  }
  return out;
}

/** The step's `run: |` block, dedented to what the runner hands to bash. */
function stepRun(body) {
  const at = body.findIndex((line) => /^ {8}run: \|$/.test(line));
  assert.notEqual(at, -1, 'the probe step has no `run: |` block');
  const out = [];
  for (let index = at + 1; index < body.length; index += 1) {
    const line = body[index];
    if (line.trim() !== '' && indentOf(line) < 10) break;
    out.push(line.slice(10));
  }
  return `${out.join('\n')}\n`;
}

const PROBE_STEP = stepBody(PROBE, 'The ref property every tooling checkout reads must be a real commit SHA');
const PROBE_ENV = stepEnv(PROBE_STEP);
const PROBE_SCRIPT = stepRun(PROBE_STEP);

test('the probe reads the SAME property the tooling checkouts and the docs-content delivery read', () => {
  assert.equal(
    PROBE_ENV.TOOLING_SHA,
    REF_EXPRESSION,
    'a probe that reads a different property measures a different thing and proves nothing about this one',
  );
  assert.deepEqual(Object.keys(PROBE_ENV), ['TOOLING_SHA'], 'the probe reads one property and nothing else');
  assert.match(PROBE_SCRIPT, /^set -euo pipefail$/m, 'an unset variable must fail rather than read as empty');
  assert.equal(
    PROBE_STEP.some((line) => /^ {8}shell: bash$/.test(line)),
    true,
    'the shell is pinned, so the script is the same program wherever the job runs',
  );
  assert.equal(PROBE_STEP.some((line) => /^ {8}if:/.test(line)), false, 'a probe behind a condition can be skipped');
});

/** Run the probe's own script, exactly as extracted, with the value a runner would have supplied. */
function runProbe(sha) {
  const environment = { ...process.env };
  if (sha === undefined) delete environment.TOOLING_SHA;
  else environment.TOOLING_SHA = sha;
  const result = spawnSync('bash', ['-c', PROBE_SCRIPT], { encoding: 'utf8', env: environment });
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const SHA = '213c8547929e163359fc641da76d791fcf9495a2';

test('A RESOLVED COMMIT SHA PASSES, and the value is in the log where an operator can read it', () => {
  const run = runProbe(SHA);
  assert.equal(run.code, 0, run.output);
  assert.ok(run.output.includes(SHA), `the resolved value must be in the log:\n${run.output}`);
  assert.match(run.output, /job\.workflow_sha/, 'and the property it came from is named beside it');
});

test('THE EMPTY STRING FAILS THE RUN, which is the whole reason this probe exists', () => {
  const run = runProbe('');
  assert.notEqual(run.code, 0, 'an empty property must red the run rather than be reported as measured');
  assert.match(run.output, /empty string/, run.output);
  assert.match(run.output, /workflow sha probe FAILED/, run.output);
});

test('THE LITERAL `main` FAILS THE RUN, because a branch is not the commit that was resolved', () => {
  const run = runProbe('main');
  assert.notEqual(run.code, 0);
  assert.match(run.output, /not a 40 character lowercase hexadecimal commit SHA/);
  assert.ok(run.output.includes('main'), 'the value it got is named');
});

test('ANYTHING THAT IS NOT A 40 CHARACTER LOWERCASE HEX SHA FAILS, one case per way to be close', () => {
  for (const [label, value] of [
    ['a short SHA', SHA.slice(0, 12)],
    ['an uppercase SHA', SHA.toUpperCase()],
    ['a SHA with a trailing newline', `${SHA}\n`],
    ['41 hex characters', `${SHA}a`],
    ['a ref name', 'refs/heads/main'],
    ['a tag', 'workflows-2026-09-08-213c8547929e'],
  ]) {
    const run = runProbe(value);
    assert.notEqual(run.code, 0, `${label} was accepted:\n${run.output}`);
    assert.match(run.output, /workflow sha probe FAILED/, label);
  }
});

test('AN UNSET VARIABLE FAILS, because `set -u` is load-bearing rather than decorative', () => {
  const run = runProbe(undefined);
  assert.notEqual(run.code, 0, 'an unset TOOLING_SHA must not be read as an empty one and passed over');
  assert.match(run.output, /TOOLING_SHA/, run.output);
});
