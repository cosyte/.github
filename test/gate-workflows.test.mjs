// The two reusable gate workflows, and the properties a caller's merge button depends on.
//
// WHAT THESE TWO FILES ARE. `gate-no-emdash.yml` and `gate-no-internal-refs.yml` publish a gate
// ONCE, so a calling repository keeps only its triggers and a `uses:` line. Neither carries a
// pattern, an allow-list, a file selection or a verdict of its own: each prepares the tree, runs the
// command the caller names, and lets that command's exit status decide the job. That boundary is the
// first thing asserted here, because a scanner delivered from this repository would put the
// canonical rule in the wrong place and make two changes own one file.
//
// EVERY EXAMINATION BELOW IS A FUNCTION OVER TEXT, AND EVERY ONE OF THEM IS RUN TWICE: once over the
// tree as this change leaves it, and once over a mutated copy that breaks the property. A check that
// has never been shown to fail is not evidence. Each mutation is also asserted to have CHANGED the
// text, because a mutation that is a no-op proves the examination nothing at all.
//
// AND THE TWO `run:` BODIES ARE EXTRACTED AND EXECUTED, not merely read. What AC-10 and AC-12 are
// about is which program runs and what reaches its stdin, and neither is a property of a string: a
// body that names the right variable and feeds it the wrong file would satisfy every comparison a
// reader can make and would still be a gate over nothing.
//
// A NOTE ON THE JOB SPLIT, because this file asserts conditions in one job and refuses them in
// another. `tracked-files` and `public-surface` are the requirable halves, so nothing may skip them:
// a job skipped by a conditional SATISFIES its required context. `messages` carries a job-level
// condition on purpose and must never be required. README.md, "What a skipped required context does
// to a merge", owns that measurement and the three routes into it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readWorkflowInterface } from '../scripts/reference-publish.mjs';
import { decomment, parseWorkflow, readWorkflow } from './workflow-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WORKFLOWS = '.github/workflows';

const EMDASH_GATE = 'gate-no-emdash.yml';
const REFS_GATE = 'gate-no-internal-refs.yml';

/** This repository's OWN em-dash gate. AC-16 is about it, and nothing here may move it. */
const LOCAL_GATE = 'no-emdash.yml';

const read = (name) => readWorkflow(join(REPO, WORKFLOWS, name), readFileSync);

/**
 * The two requirable halves: the file, the job id and the variable its gate step runs.
 *
 * Named by variable rather than by step label so the examinations below locate the gate step by what
 * it DOES. A rule keyed on a label is satisfied by a step that kept the label and stopped running
 * the command.
 */
const GATES = [
  { file: EMDASH_GATE, job: 'tracked-files', variable: 'FILES_COMMAND', input: 'files-command' },
  { file: REFS_GATE, job: 'public-surface', variable: 'SURFACE_COMMAND', input: 'command' },
];

const indentOf = (line) => line.length - line.replace(/^ */, '').length;

// ---------------------------------------------------------------------------
// Extracting a `run:` body, so it can be run rather than read
// ---------------------------------------------------------------------------

/**
 * The `run: |` block of the step labelled `stepName`, dedented to what the runner hands to bash.
 *
 * `parseStep` in the shared reader folds a body onto one line with single spaces, which is right for
 * matching and wrong for executing: `set -euo pipefail` and the command after it would become one
 * command line. This reads the block as the runner does.
 */
function runScript(text, stepName) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line === `      - name: ${stepName}`);
  assert.notEqual(at, -1, `no step is labelled ${JSON.stringify(stepName)}`);
  const body = [];
  let seenRun = false;
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (indentOf(line) <= 6) break;
    if (/^ {8}run: \|$/.test(line)) {
      seenRun = true;
      continue;
    }
    if (!seenRun) continue;
    if (indentOf(line) < 10) break;
    body.push(line.slice(10));
  }
  assert.ok(seenRun && body.length > 0, `the step ${JSON.stringify(stepName)} has no \`run: |\` block this reader can see`);
  return `${body.join('\n')}\n`;
}

const TRACKED_STEP = 'Scan the tracked files';
const MESSAGES_STEP = 'Check the pull request title, body and commit messages';
const SURFACE_STEP = 'Scan the public surface';

// ---------------------------------------------------------------------------
// Running one, with the caller's scanner stubbed and everything else real
// ---------------------------------------------------------------------------

/**
 * A directory holding stub executables, first on `PATH`.
 *
 * The SCANNER is the boundary here: it belongs to the calling repository and this workflow's whole
 * contract is that it does not know what it does. `git` is NOT stubbed, because the commit range is
 * the thing AC-12 is about and a stub would be asserting this test's own arithmetic.
 */
function stubs(names) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-stub-'));
  for (const name of names) {
    const path = join(dir, name);
    writeFileSync(
      path,
      ['#!/bin/sh', `printf '%s\\n' "${name}" "$@" > "$GATE_ARGV"`, 'cat > "$GATE_STDIN"', 'exit "${GATE_EXIT:-0}"', ''].join('\n'),
    );
    chmodSync(path, 0o755);
  }
  return dir;
}

/** Run an extracted script the way a runner would, and report what the stubbed scanner saw. */
function runGate(script, { env = {}, cwd = REPO, programs = ['pnpm'] } = {}) {
  const stubDir = stubs(programs);
  const temp = mkdtempSync(join(tmpdir(), 'gate-run-'));
  const argvFile = join(temp, 'argv');
  const stdinFile = join(temp, 'stdin');
  writeFileSync(argvFile, '');
  writeFileSync(stdinFile, '');
  const result = spawnSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    input: '',
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      RUNNER_TEMP: temp,
      GATE_ARGV: argvFile,
      GATE_STDIN: stdinFile,
      ...env,
    },
  });
  const argv = readFileSync(argvFile, 'utf8').split('\n').filter((part) => part !== '');
  return {
    code: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    argv,
    stdin: readFileSync(stdinFile, 'utf8'),
  };
}

/** A real two-commit repository, so `git log base..head` answers about real commits. */
function pullRequestRepo({ baseMessage, headMessage }) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-repo-'));
  const git = (...args) => {
    const done = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'gate',
        GIT_AUTHOR_EMAIL: 'gate@example.invalid',
        GIT_COMMITTER_NAME: 'gate',
        GIT_COMMITTER_EMAIL: 'gate@example.invalid',
      },
    });
    assert.equal(done.status, 0, `git ${args.join(' ')} failed: ${done.stdout}${done.stderr}`);
    return done.stdout.trim();
  };
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '--quiet', '--no-gpg-sign', '-m', baseMessage);
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git('add', 'b.txt');
  git('commit', '--quiet', '--no-gpg-sign', '-m', headMessage);
  return { dir, base, head: git('rev-parse', 'HEAD') };
}

// ---------------------------------------------------------------------------
// AC-7: the workflow runs the caller's command and owns no rule of its own
// ---------------------------------------------------------------------------

/** What a workflow would have to carry to be DELIVERING a scanner rather than calling one. */
const DELIVERY = [
  { what: 'fetches a file over the network', pattern: /\bcurl\b|\bwget\b|raw\.githubusercontent\.com/ },
  { what: 'checks out a second repository', pattern: /^\s*repository:\s*\S/m },
  { what: 'resolves the commit of its own workflow file', pattern: /workflow_sha/ },
];

/** Every way this text carries a scanner instead of calling one. A function over text. */
function deliveryFindings(name, text) {
  const findings = [];
  const code = decomment(text).join('\n');
  for (const { what, pattern } of DELIVERY) {
    if (pattern.test(code)) findings.push(`${WORKFLOWS}/${name} ${what}, so it delivers a scanner rather than calling one`);
  }
  return findings;
}

test('AC-7: neither gate delivers a scanner, and each is only the command the caller named', () => {
  for (const { file, job, variable } of GATES) {
    assert.deepEqual(deliveryFindings(file, read(file)), []);
    // The gate step's whole program, with the shell options it sets, IS the caller's command and
    // nothing else. Pinned rather than pattern matched: a pattern would admit a body that had grown
    // a file selection or a second verdict beside the call.
    const step = file === EMDASH_GATE ? TRACKED_STEP : SURFACE_STEP;
    assert.equal(runScript(read(file), step), `set -euo pipefail\n$${variable}\n`, `${file}: job \`${job}\``);
  }
});

test('AC-7: the delivery examination can fail, so the tree passing it is evidence', () => {
  const original = read(REFS_GATE);
  const mutated = original.replace(
    '          set -euo pipefail\n          $SURFACE_COMMAND\n',
    () => '          set -euo pipefail\n          curl -sSfL https://example.invalid/scan.mjs -o scan.mjs\n          node scan.mjs\n',
  );
  assert.notEqual(mutated, original, 'the mutation is a no-op, so it measures nothing');
  assert.deepEqual(deliveryFindings(REFS_GATE, mutated), [
    `${WORKFLOWS}/${REFS_GATE} fetches a file over the network, so it delivers a scanner rather than calling one`,
  ]);
});

test('AC-7: the command decides the job, so a scanner that finds something reds it', () => {
  const run = runGate(runScript(read(REFS_GATE), SURFACE_STEP), {
    env: { SURFACE_COMMAND: 'pnpm check:no-internal-refs', GATE_EXIT: '3' },
  });
  assert.equal(run.code, 3, `a failing scanner must fail the step:\n${run.output}`);
});

// ---------------------------------------------------------------------------
// AC-10: the defaults, and a caller that names its own commands
// ---------------------------------------------------------------------------

/** The `workflow_call` interface of a workflow, read by this repository's own narrow reader. */
function interfaceOf(name) {
  const readIt = readWorkflowInterface(read(name), name);
  assert.equal(readIt.ok, true, readIt.ok ? '' : readIt.reason);
  return readIt.interface;
}

/** The `env:` mapping of the step labelled `stepName`, through the shared reader. */
function stepEnv(name, stepName) {
  const step = parseWorkflow(read(name))
    .jobs.flatMap((job) => job.steps)
    .find((candidate) => candidate.fields.name === stepName);
  assert.notEqual(step, undefined, `${name} has no step labelled ${JSON.stringify(stepName)}`);
  return step.env;
}

test('AC-10: with no inputs, the em-dash gate runs the two default commands', () => {
  const inputs = interfaceOf(EMDASH_GATE).inputs;
  assert.equal(inputs['files-command'].default.value, 'pnpm check:no-emdash');
  assert.equal(inputs['messages-command'].default.value, 'pnpm check:no-emdash --stdin');
  assert.equal(inputs['files-command'].required, false, 'a required input is a caller that cannot stay thin');
  assert.equal(inputs['messages-command'].required, false);

  // The link from the DEFAULT to the shell: the step's environment is the input itself, so a caller
  // that passes nothing runs the default above. Asserted here and executed below.
  assert.equal(stepEnv(EMDASH_GATE, TRACKED_STEP).FILES_COMMAND, '${{ inputs.files-command }}');
  assert.equal(stepEnv(EMDASH_GATE, MESSAGES_STEP).MESSAGES_COMMAND, '${{ inputs.messages-command }}');

  const tracked = runGate(runScript(read(EMDASH_GATE), TRACKED_STEP), {
    env: { FILES_COMMAND: inputs['files-command'].default.value },
  });
  assert.equal(tracked.code, 0, tracked.output);
  assert.deepEqual(tracked.argv, ['pnpm', 'check:no-emdash']);
});

test('AC-10: with no inputs, the messages half runs the default command AND a label', () => {
  const inputs = interfaceOf(EMDASH_GATE).inputs;
  const repo = pullRequestRepo({ baseMessage: 'base commit message', headMessage: 'head commit message' });
  const run = runGate(runScript(read(EMDASH_GATE), MESSAGES_STEP), {
    cwd: repo.dir,
    env: {
      MESSAGES_COMMAND: inputs['messages-command'].default.value,
      MESSAGES_LABEL: 'the pull request title, body, or commit messages',
      PR_TITLE: 'a title',
      PR_BODY: 'a body',
      BASE_SHA: repo.base,
      HEAD_SHA: repo.head,
    },
  });
  assert.equal(run.code, 0, run.output);
  assert.deepEqual(run.argv, ['pnpm', 'check:no-emdash', '--stdin', 'the pull request title, body, or commit messages']);
  // The label is not decoration: the scanner reports WHERE it found something, and "the tracked
  // files" and the message text are two different answers to that.
  assert.equal(run.argv.length, 4, 'the label must reach the command as one argument, not as several');
});

test('AC-10: a caller that passes its own commands runs those instead', () => {
  const tracked = runGate(runScript(read(EMDASH_GATE), TRACKED_STEP), {
    env: { FILES_COMMAND: 'my-scanner --tracked' },
    programs: ['pnpm', 'my-scanner'],
  });
  assert.equal(tracked.code, 0, tracked.output);
  assert.deepEqual(tracked.argv, ['my-scanner', '--tracked'], 'the caller-supplied command did not run');

  const repo = pullRequestRepo({ baseMessage: 'base', headMessage: 'head' });
  const messages = runGate(runScript(read(EMDASH_GATE), MESSAGES_STEP), {
    cwd: repo.dir,
    programs: ['pnpm', 'my-scanner'],
    env: {
      MESSAGES_COMMAND: 'my-scanner --messages',
      MESSAGES_LABEL: 'a label',
      PR_TITLE: 't',
      PR_BODY: 'b',
      BASE_SHA: repo.base,
      HEAD_SHA: repo.head,
    },
  });
  assert.equal(messages.code, 0, messages.output);
  assert.deepEqual(messages.argv, ['my-scanner', '--messages', 'a label']);
});

// ---------------------------------------------------------------------------
// AC-11: nothing on the path from the trigger to the command can skip it
// ---------------------------------------------------------------------------
//
// Coverage facts E2, E6, I2 and I4. A required context that does not do its work on every event the
// caller triggers on cannot gate every pull request, and every construct refused below is a way of
// keeping the context while losing the work.

/**
 * The gate step of a job: the one that both receives the caller's command and RUNS it.
 *
 * Both halves, because either alone is satisfied by a step that has stopped gating. A step that
 * declares the variable and never runs it is a context reporting a pass over nothing, and a step
 * that runs a variable nothing set would die on `set -u` rather than scan.
 */
function gateStep(job, variable) {
  const invokes = new RegExp(String.raw`\$\{?${variable}\b`);
  return job.steps.find((step) => step.env[variable] !== undefined && invokes.test(step.fields.run ?? ''));
}

/**
 * Every way the requirable half of `text` can report a pass without having run.
 *
 * A FUNCTION OVER TEXT, so the delivered file and a mutated copy go through the same code. A job
 * this examination cannot find, or a job with no gate step in it, is a finding rather than zero
 * findings: an examination that read nothing must not report compliance.
 */
function skippableFindings(name, jobId, variable, text) {
  const at = `${WORKFLOWS}/${name}: job \`${jobId}\``;
  const workflow = parseWorkflow(text);
  const job = workflow.byId[jobId];
  if (job === undefined) return [`${at} is not declared, so the context a caller requires is not emitted at all`];
  const findings = [];
  if (job.keys.if !== undefined) {
    findings.push(`${at} carries a job-level \`if: ${job.keys.if}\`, and a job skipped by a conditional satisfies its required context`);
  }
  if (job.keys.needs !== undefined) {
    findings.push(`${at} carries \`needs: ${job.keys.needs}\`, and a job skipped because a dependency failed reports a pass`);
  }
  if (job.keys['continue-on-error'] !== undefined) {
    findings.push(`${at} carries \`continue-on-error\`, so a finding cannot red the run`);
  }
  const step = gateStep(job, variable);
  if (step === undefined) {
    return [...findings, `${at} has no step running \`$${variable}\`, so the command the caller named is never run`];
  }
  const where = `${at}, step ${step.index} ("${step.label}")`;
  if (step.fields.if !== undefined) {
    findings.push(`${where} carries a step-level \`if: ${step.fields.if}\`, and a skipped gate step leaves the context reporting success`);
  }
  if (step.fields['continue-on-error'] !== undefined) {
    findings.push(`${where} carries \`continue-on-error\`, so a finding cannot red the run`);
  }
  for (const step2 of job.steps) {
    if (/\|\|\s*true/.test(step2.fields.run ?? '')) {
      findings.push(`${at}, step ${step2.index} ("${step2.label}") carries \`|| true\`, which turns every finding into a pass`);
    }
  }
  return findings;
}

test('AC-11: the requirable half of each gate carries nothing that can skip it or excuse it', () => {
  for (const { file, job, variable } of GATES) {
    assert.deepEqual(skippableFindings(file, job, variable, read(file)), []);
  }
});

/** The mutations AC-11 names, each one a construct a later edit could add. */
const SKIP_MUTATIONS = [
  {
    what: 'a job-level condition',
    apply: (text, jobId) => text.replace(`  ${jobId}:\n`, () => `  ${jobId}:\n    if: github.event_name == 'pull_request'\n`),
    expect: /carries a job-level `if:/,
  },
  {
    what: 'a dependency on another job',
    apply: (text, jobId) => text.replace(`  ${jobId}:\n`, () => `  ${jobId}:\n    needs: something-else\n`),
    expect: /carries `needs:/,
  },
  {
    what: 'continue-on-error on the job',
    apply: (text, jobId) => text.replace(`  ${jobId}:\n`, () => `  ${jobId}:\n    continue-on-error: true\n`),
    expect: /carries `continue-on-error`/,
  },
  {
    what: 'a step-level condition on the gate step',
    apply: (text, _jobId, variable) =>
      text.replace(`        env:\n          ${variable}:`, () => `        if: github.event_name == 'push'\n        env:\n          ${variable}:`),
    expect: /carries a step-level `if:/,
  },
  {
    what: 'a swallowed exit status',
    apply: (text, _jobId, variable) => text.replace(`\n          $${variable}\n`, () => `\n          $${variable} || true\n`),
    expect: /carries `\|\| true`/,
  },
];

test('AC-11: a later edit adding any of them fails, naming the file and the job id', () => {
  for (const { file, job, variable } of GATES) {
    const original = read(file);
    for (const mutation of SKIP_MUTATIONS) {
      const mutated = mutation.apply(original, job, variable);
      assert.notEqual(mutated, original, `${file}: the mutation for ${mutation.what} is a no-op, so it measures nothing`);
      const findings = skippableFindings(file, job, variable, mutated);
      assert.equal(findings.length, 1, `${file}: ${mutation.what} produced ${findings.length} findings:\n${findings.join('\n')}`);
      assert.match(findings[0], mutation.expect, `${file}: ${mutation.what}`);
      // The criterion asks for both, because a file name alone does not locate a job in a workflow
      // with two of them.
      assert.ok(findings[0].includes(`${WORKFLOWS}/${file}`), `${file}: the finding does not name the file`);
      assert.ok(findings[0].includes(`\`${job}\``), `${file}: the finding does not name the job id`);
    }
  }
});

test('AC-11: a gate job that stopped running the command is a finding, not zero findings', () => {
  for (const { file, job, variable } of GATES) {
    const original = read(file);
    const mutated = original.replace(`\n          $${variable}\n`, () => '\n          echo ok\n');
    assert.notEqual(mutated, original, 'the mutation is a no-op, so it measures nothing');
    const findings = skippableFindings(file, job, variable, mutated);
    assert.equal(findings.length, 1, findings.join('\n'));
    assert.match(findings[0], /is never run/);
  }
});

// ---------------------------------------------------------------------------
// AC-12: what the messages half collects, and what it feeds the scanner
// ---------------------------------------------------------------------------
//
// Coverage facts E3, E4 and E6.

/** Every way the messages half stops collecting what it is credited with collecting. */
function messagesFindings(text) {
  const at = `${WORKFLOWS}/${EMDASH_GATE}: job \`messages\``;
  const workflow = parseWorkflow(text);
  const job = workflow.byId.messages;
  if (job === undefined) return [`${at} is not declared`];
  const findings = [];
  // Pull requests only. On a push the message is already written, and this job exists to stop one
  // landing. It is the one job here that is allowed a condition, because it is never requirable.
  if (job.keys.if !== "github.event_name == 'pull_request'") {
    findings.push(`${at} runs under \`if: ${job.keys.if}\` rather than on pull request events only`);
  }
  const checkout = job.steps.find((step) => /actions\/checkout@/.test(step.fields.uses ?? ''));
  if (checkout === undefined) {
    findings.push(`${at} checks nothing out, so there is no commit range to read`);
  } else if (checkout.with['fetch-depth'] !== '0') {
    findings.push(`${at} checks out at \`fetch-depth: ${checkout.with['fetch-depth']}\`, and a shallow clone does not contain the base commit`);
  }
  const step = job.steps.find((candidate) => candidate.env.MESSAGES_COMMAND !== undefined);
  if (step === undefined) return [...findings, `${at} has no step running the messages command`];
  const script = step.fields.run ?? '';
  if (!script.startsWith('set -euo pipefail')) {
    findings.push(`${at} collects without \`set -euo pipefail\`, so a failed collection reads as a clean one`);
  }
  for (const [what, pattern] of [
    ['the pull request title', /\$PR_TITLE|\$\{PR_TITLE\}/],
    ['the pull request body', /\$PR_BODY|\$\{PR_BODY\}/],
    ['every commit message in the range', /git log[^|]*\$BASE_SHA\.\.\$HEAD_SHA|git log[^|]*\$\{BASE_SHA\}\.\.\$\{HEAD_SHA\}/],
  ]) {
    if (!pattern.test(script)) findings.push(`${at} does not collect ${what}`);
  }
  if (!/>\s*"?\$\{?RUNNER_TEMP\}?\/[\w.-]+"?/.test(script)) {
    findings.push(`${at} does not collect into one file, so what the scanner reads cannot be said`);
  }
  if (!/<\s*"?\$\{?RUNNER_TEMP\}?\/[\w.-]+"?/.test(script)) {
    findings.push(`${at} does not feed the collected file to the messages command on stdin`);
  }
  return findings;
}

test('AC-12: the messages half collects the title, the body and the range, and feeds them on stdin', () => {
  assert.deepEqual(messagesFindings(read(EMDASH_GATE)), []);
});

test('AC-12: the examination fails on each way of losing what it collects', () => {
  const original = read(EMDASH_GATE);
  for (const [what, from, to, expected] of [
    ['a shallow clone', '          fetch-depth: 0\n', '          fetch-depth: 1\n', /shallow clone does not contain the base commit/],
    ['a push-triggered run', "    if: github.event_name == 'pull_request'\n", '', /rather than on pull request events only/],
    ['an unset shell option', '          set -euo pipefail\n          {\n', '          {\n', /`set -euo pipefail`/],
    ["the pull request's own body", `            printf '%s\\n' "$PR_BODY"\n`, '', /does not collect the pull request body/],
    ['the commit range', '            git log --format=%B "$BASE_SHA..$HEAD_SHA"\n', '', /does not collect every commit message in the range/],
    ['the pipe into the scanner', '$MESSAGES_COMMAND "$MESSAGES_LABEL" < "$RUNNER_TEMP/pr-messages.txt"', '$MESSAGES_COMMAND "$MESSAGES_LABEL"', /on stdin/],
  ]) {
    const mutated = original.replace(from, () => to);
    assert.notEqual(mutated, original, `${what}: the mutation is a no-op, so it measures nothing`);
    const findings = messagesFindings(mutated);
    assert.equal(findings.length, 1, `${what} produced ${findings.length} findings:\n${findings.join('\n')}`);
    assert.match(findings[0], expected, what);
  }
});

test('AC-12: run for real, the collection IS the title, the body and the range, and nothing before it', () => {
  const repo = pullRequestRepo({
    baseMessage: 'BASE-ONLY-MESSAGE, already on the target branch',
    headMessage: 'HEAD-MESSAGE, the one this pull request adds',
  });
  const run = runGate(runScript(read(EMDASH_GATE), MESSAGES_STEP), {
    cwd: repo.dir,
    env: {
      MESSAGES_COMMAND: 'pnpm check:no-emdash --stdin',
      MESSAGES_LABEL: 'the pull request title, body, or commit messages',
      PR_TITLE: 'TITLE-TEXT',
      PR_BODY: 'BODY-TEXT',
      BASE_SHA: repo.base,
      HEAD_SHA: repo.head,
    },
  });
  assert.equal(run.code, 0, run.output);
  for (const expected of ['TITLE-TEXT', 'BODY-TEXT', 'HEAD-MESSAGE, the one this pull request adds']) {
    assert.ok(run.stdin.includes(expected), `the scanner never saw ${expected}:\n${run.stdin}`);
  }
  // `base..head` and not `--all`: a commit already on the target branch is somebody else's to fix,
  // and reding a pull request for it is the shape that teaches people to ignore a gate.
  assert.equal(run.stdin.includes('BASE-ONLY-MESSAGE'), false, `the base commit's message must not be scanned:\n${run.stdin}`);
});

test('AC-12: a failed collection reds the step rather than scanning a shorter file', () => {
  const repo = pullRequestRepo({ baseMessage: 'base', headMessage: 'head' });
  const run = runGate(runScript(read(EMDASH_GATE), MESSAGES_STEP), {
    cwd: repo.dir,
    env: {
      MESSAGES_COMMAND: 'pnpm check:no-emdash --stdin',
      MESSAGES_LABEL: 'a label',
      PR_TITLE: 't',
      PR_BODY: 'b',
      // A base commit that is not in the clone, which is exactly what a shallow checkout produces.
      BASE_SHA: '0000000000000000000000000000000000000000',
      HEAD_SHA: repo.head,
    },
  });
  assert.notEqual(run.code, 0, `a failed \`git log\` must fail the step:\n${run.output}`);
  assert.deepEqual(run.argv, [], 'the scanner must not run over a collection that failed');
});

test('AC-12: an unset variable fails, because `set -u` is load-bearing rather than decorative', () => {
  const repo = pullRequestRepo({ baseMessage: 'base', headMessage: 'head' });
  const run = runGate(runScript(read(EMDASH_GATE), MESSAGES_STEP), {
    cwd: repo.dir,
    env: { MESSAGES_COMMAND: 'pnpm check:no-emdash --stdin', MESSAGES_LABEL: 'a label', PR_BODY: 'b', BASE_SHA: repo.base, HEAD_SHA: repo.head },
  });
  assert.notEqual(run.code, 0, 'an unset PR_TITLE must not be read as an empty one');
  assert.match(run.output, /PR_TITLE/, run.output);
});

// ---------------------------------------------------------------------------
// AC-13: every expression reaches the shell through `env:`
// ---------------------------------------------------------------------------
//
// Coverage fact E5. Actions interpolates `${{ }}` into a `run:` body BEFORE the shell sees it, so a
// pull request title interpolated there is arbitrary shell written by whoever opened the pull
// request. Through `env:` it is a variable holding text.

const EXPRESSION = /\$\{\{/;

/**
 * Every expression in this workflow that is not on a child line of an `env:` block.
 *
 * A RAW TEXT SWEEP OVER THE EXECUTABLE LINES, not a read of the parsed steps. A reader can always be
 * out-spelled by a shape it does not model; text cannot. `decomment` is what keeps the header's
 * caller example, which contains expressions a caller writes, from being read as configuration, and
 * what keeps a `#` line inside a `run:` body from being passed over as prose.
 */
function interpolationFindings(name, text) {
  const findings = [];
  let envIndent = null;
  for (const [index, line] of decomment(text).entries()) {
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    if (envIndent !== null && indent <= envIndent) envIndent = null;
    const opensEnv = /^\s*(?:-\s+)?env:\s*$/.test(line);
    const insideEnv = envIndent !== null && indent > envIndent;
    if (EXPRESSION.test(line) && !insideEnv) {
      findings.push(`${WORKFLOWS}/${name}:${index + 1}: ${line.trim()} is an expression outside an \`env:\` block`);
    }
    if (opensEnv) envIndent = indent;
  }
  return findings;
}

test('AC-13: every expression in both gates sits on an `env:` child line, and none in a `run:` body', () => {
  for (const { file } of GATES) assert.deepEqual(interpolationFindings(file, read(file)), []);

  // Non-vacuity: the sweep has expressions to find, and it found them where they belong.
  const env = stepEnv(EMDASH_GATE, MESSAGES_STEP);
  assert.deepEqual(Object.keys(env).sort(), ['BASE_SHA', 'HEAD_SHA', 'MESSAGES_COMMAND', 'MESSAGES_LABEL', 'PR_BODY', 'PR_TITLE']);
  assert.equal(env.PR_TITLE, '${{ github.event.pull_request.title }}');
  assert.equal(env.PR_BODY, '${{ github.event.pull_request.body }}');
  assert.equal(env.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.equal(env.HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
});

test('AC-13: an inline interpolation is reported, and the mutation refuses to be a no-op', () => {
  for (const [file, from, to] of [
    [EMDASH_GATE, '          $FILES_COMMAND\n', '          ${{ inputs.files-command }}\n'],
    [EMDASH_GATE, `            printf '%s\\n' "$PR_TITLE"\n`, "            printf '%s\\n' '${{ github.event.pull_request.title }}'\n"],
    [REFS_GATE, '          $SURFACE_COMMAND\n', '          ${{ inputs.command }}\n'],
  ]) {
    const original = read(file);
    const mutated = original.replace(from, () => to);
    assert.notEqual(mutated, original, `${file}: the mutation is a no-op, so it measures nothing`);
    const findings = interpolationFindings(file, mutated);
    assert.equal(findings.length, 1, `${file}: ${findings.length} findings:\n${findings.join('\n')}`);
    assert.match(findings[0], /is an expression outside an `env:` block/);
    assert.ok(findings[0].startsWith(`${WORKFLOWS}/${file}:`), 'the finding names the file and the line');
  }
});

test('AC-13: a comment is still a comment, so the header\'s caller example is not a finding', () => {
  // Both headers show a caller's `concurrency:` block, which contains two expressions. A sweep that
  // could not tell prose from configuration would either fail on its own instructions or force them
  // to be deleted, which is how the reason for a rule gets lost.
  for (const { file } of GATES) {
    assert.match(read(file), /#\s+group: \$\{\{ github\.workflow \}\}/, `${file} no longer shows a caller example with an expression in it`);
  }
});

// ---------------------------------------------------------------------------
// AC-14: the public-surface gate is one job, and it reads no pull request text
// ---------------------------------------------------------------------------
//
// Coverage fact I3. An internal identifier BELONGS in a title, a body and a commit message: that is
// where a contributor says what the change was. Scanning them would red correct work.

/** Every construct that reads the text a contributor writes around a change. */
const READS_TEXT = [
  { what: 'the pull request event payload', pattern: /github\.event\.pull_request/ },
  { what: 'the pushed commits in the event payload', pattern: /github\.event\.(?:commits|head_commit)/ },
  { what: 'commit messages out of git', pattern: /\bgit\s+(?:log|show)\b/ },
  { what: 'a commit message format', pattern: /--format=%[Bbs]/ },
];

/** A whole-file sweep: "anywhere in the file" is the criterion's own scope, so comments count too. */
function readsTextFindings(name, text) {
  return READS_TEXT.filter(({ pattern }) => pattern.test(text)).map(
    ({ what }) => `${WORKFLOWS}/${name} reads ${what}, and an identifier belongs in the text a contributor writes`,
  );
}

test('AC-14: the public-surface gate exposes exactly one job, running the caller\'s command', () => {
  const read14 = interfaceOf(REFS_GATE);
  assert.deepEqual(Object.keys(read14.jobs), ['public-surface']);
  assert.deepEqual(Object.keys(read14.inputs), ['command']);
  assert.equal(read14.inputs.command.default.value, 'pnpm check:no-internal-refs');
  assert.deepEqual(read14.secrets, {}, 'a gate that needs a secret is a gate that can leak one');
  assert.equal(stepEnv(REFS_GATE, SURFACE_STEP).SURFACE_COMMAND, '${{ inputs.command }}');

  const run = runGate(runScript(read(REFS_GATE), SURFACE_STEP), {
    env: { SURFACE_COMMAND: read14.inputs.command.default.value },
  });
  assert.equal(run.code, 0, run.output);
  assert.deepEqual(run.argv, ['pnpm', 'check:no-internal-refs']);
});

test('AC-14: nothing anywhere in the public-surface gate reads a title, a body or a commit message', () => {
  assert.deepEqual(readsTextFindings(REFS_GATE, read(REFS_GATE)), []);
});

test('AC-14: the sweep is READING the file, because the other gate trips the clauses it carries', () => {
  // The control that keeps the assertion above from being vacuous. The em-dash gate reads that text
  // by design, so a sweep that found nothing there is a sweep that found nothing at all. The set is
  // pinned rather than counted, so a clause that has gone dead is named rather than absorbed.
  assert.deepEqual(
    readsTextFindings(EMDASH_GATE, read(EMDASH_GATE)),
    [
      `${WORKFLOWS}/${EMDASH_GATE} reads the pull request event payload, and an identifier belongs in the text a contributor writes`,
      `${WORKFLOWS}/${EMDASH_GATE} reads commit messages out of git, and an identifier belongs in the text a contributor writes`,
      `${WORKFLOWS}/${EMDASH_GATE} reads a commit message format, and an identifier belongs in the text a contributor writes`,
    ],
  );
  // ... and the one clause no tracked file trips today is proved to be alive rather than listed.
  // A clause nothing can fire is cover, not coverage.
  assert.deepEqual(
    readsTextFindings('synthetic.yml', 'name: x\non:\n  push:\njobs:\n  j:\n    steps:\n      - run: echo "${{ github.event.head_commit.message }}"\n'),
    [`${WORKFLOWS}/synthetic.yml reads the pushed commits in the event payload, and an identifier belongs in the text a contributor writes`],
  );
});

test('AC-14: the sweep fails when the public-surface gate grows a read of that text', () => {
  const original = read(REFS_GATE);
  const mutated = original.replace(
    '          SURFACE_COMMAND: ${{ inputs.command }}\n',
    () => '          SURFACE_COMMAND: ${{ inputs.command }}\n          PR_TITLE: ${{ github.event.pull_request.title }}\n',
  );
  assert.notEqual(mutated, original, 'the mutation is a no-op, so it measures nothing');
  const findings = readsTextFindings(REFS_GATE, mutated);
  assert.equal(findings.length, 1, findings.join('\n'));
  assert.match(findings[0], /reads the pull request event payload/);
});

// ---------------------------------------------------------------------------
// AC-16: this repository's own em-dash gate keeps its job ids
// ---------------------------------------------------------------------------

/** The job ids of a workflow, read line by line, so the answer is the file's and not a reader's. */
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

test('AC-16: this repository\'s own em-dash gate still declares `no-emdash` and `no-emdash-messages`', () => {
  // Each is a check-run context this repository's ruleset may already require, and renaming one
  // detaches that entry with no error anywhere. The `gate-` prefix on the two new files exists
  // precisely so that nothing here had to move.
  assert.deepEqual(jobIds(LOCAL_GATE, read(LOCAL_GATE)), ['no-emdash', 'no-emdash-messages']);
});

test('AC-16: the job id reader can fail, so the assertion above is not a tautology', () => {
  const original = read(LOCAL_GATE);
  const renamed = original.replace('\n  no-emdash:\n', () => '\n  tracked-files:\n');
  assert.notEqual(renamed, original, 'the mutation is a no-op, so it measures nothing');
  assert.deepEqual(jobIds(LOCAL_GATE, renamed), ['tracked-files', 'no-emdash-messages'], 'a renamed job must be seen as renamed');
});

// ---------------------------------------------------------------------------
// AC-17: every action is pinned to a commit, with the version beside it
// ---------------------------------------------------------------------------

/** A full-length commit SHA, which is the only reference that cannot be moved under a caller. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Every `uses:` in this workflow that names an action by something other than a pinned commit. */
function pinFindings(name, text) {
  const findings = [];
  let seen = 0;
  for (const line of decomment(text)) {
    const uses = /^\s*(?:-\s+)?uses:\s*([^\s#]+)\s*(#.*)?$/.exec(line);
    if (!uses) continue;
    const [, reference, comment] = uses;
    if (reference.startsWith('./')) continue; // a path in this repository, which names no action
    seen += 1;
    const at = reference.lastIndexOf('@');
    const ref = at === -1 ? '' : reference.slice(at + 1);
    if (!COMMIT_SHA.test(ref)) {
      findings.push(`${WORKFLOWS}/${name} names \`${reference}\`, which is a tag or a branch and can be moved under every caller`);
      continue;
    }
    if (comment === undefined || !/^#\s*\S/.test(comment)) {
      findings.push(`${WORKFLOWS}/${name} pins \`${reference}\` with no version beside it, so nobody can read which release it is`);
    }
  }
  if (seen === 0) findings.push(`${WORKFLOWS}/${name} names no action at all, so this examination measured nothing`);
  return findings;
}

test('AC-17: every action in both gates is pinned to a commit, with its version as a trailing comment', () => {
  for (const { file } of GATES) assert.deepEqual(pinFindings(file, read(file)), []);
});

test('AC-17: the examination fails on a tag, on a branch and on a pin with no version beside it', () => {
  const original = read(EMDASH_GATE);
  for (const [what, from, to, expected] of [
    ['a tag', 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', 'actions/checkout@v7.0.1', /is a tag or a branch/],
    ['a branch', 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', 'actions/checkout@main', /is a tag or a branch/],
    ['an unreadable pin', 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', /with no version beside it/],
  ]) {
    const mutated = original.split(from).join(to);
    assert.notEqual(mutated, original, `${what}: the mutation is a no-op, so it measures nothing`);
    const findings = pinFindings(EMDASH_GATE, mutated);
    assert.equal(findings.length, 2, `${what} produced ${findings.length} findings:\n${findings.join('\n')}`);
    for (const finding of findings) assert.match(finding, expected, what);
  }
});

test('AC-17: an examination that found no action refuses rather than reporting a clean file', () => {
  const findings = pinFindings('synthetic.yml', 'name: x\non:\n  workflow_call:\njobs:\n  j:\n    steps:\n      - run: echo ok\n');
  assert.deepEqual(findings, [`${WORKFLOWS}/synthetic.yml names no action at all, so this examination measured nothing`]);
});
