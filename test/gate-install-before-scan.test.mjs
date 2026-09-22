// Tests over the two FORMS of each reusable gate: the one that installs the caller's dependencies
// before it scans, and the one that does not.
//
// WHAT THE DEFECT WAS. Both gate files check the caller's tree out, prepare pnpm and Node, and then
// run the caller's scan command against a tree with no `node_modules`. A caller whose scan command
// reaches an installed package therefore fails closed on the shared implementation it was
// consolidated onto: measured on hl7 pull request 137, run 35646788336, job 106489082374, where the
// job's five steps were checkout, pnpm, Node, scan, and the scan exited 1 naming
// `Cannot find package '@cosyte/script-utils'`. Failing closed is correct. The missing install is
// the defect, and the answer is a second file rather than an input, because an input is selected
// with a `with:` key in the caller and a caller's contract test refuses `with:`, `run:` and `steps:`
// in a job that calls a reusable workflow.
//
// ▶ THE SET THIS FILE QUANTIFIES OVER IS ENUMERATED, NEVER GLOBBED. A "gate reusable" is a
//   `workflow_call` file whose job runs a caller-supplied scan command and whose conclusion is that
//   command's exit status. `.github/workflows/` also holds six reusables that are not gates
//   (`ci.yml`, `codeql.yml`, `drift-check.yml`, `nightly-fuzz.yml`, `release.yml`, `scorecard.yml`)
//   and this repository's own `no-emdash.yml`, which no caller resolves. A sweep over
//   `.github/workflows/*.yml` would refuse `ci.yml` for declaring a job id outside the three
//   contexts below and go red on arrival, so the four files are named here and a fifth gate is
//   added to this table by hand or it is not covered at all.
//
// ▶ EVERY EXAMINATION IS A FUNCTION OVER TEXT, so the delivered file and a mutated copy go through
//   the same code and every rule below is proved able to fail. A check that cannot fail is not
//   evidence, and an examination that read nothing must never report compliance.
//
// ▶ WHAT THIS FILE CANNOT PROVE, said plainly rather than implied. No test here makes a real install
//   fail on a runner and watches the job: this repository has no manifest, no lockfile, no caller of
//   its own and no runner. AC-6 is graded as the ABSENCE of every construct that can run a later
//   step after a failed one, which is the whole of what an Actions job offers for that, and the
//   end-to-end proof belongs to the caller adopting the file.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readWorkflowInterface } from '../scripts/reference-publish.mjs';
import { conditionsOf, decomment, parseWorkflow, readWorkflow } from './workflow-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WORKFLOWS = '.github/workflows';

const read = (name) => readWorkflow(join(REPO, WORKFLOWS, name), readFileSync);

const indentOf = (line) => line.length - line.replace(/^ */, '').length;

// ---------------------------------------------------------------------------
// The four gate reusables, and what each one is
// ---------------------------------------------------------------------------

/** The check-run contexts a caller's ruleset can name. A gate declaring any other id detaches one. */
const PUBLISHED_CONTEXTS = ['public-surface', 'tracked-files', 'messages'];

/** The condition the em-dash gate's unrequirable half carries, in both forms, and the only one. */
const MESSAGES_CONDITION = "github.event_name == 'pull_request'";

const SURFACE_STEP = 'Scan the public surface';
const TRACKED_STEP = 'Scan the tracked files';
const MESSAGES_STEP = 'Check the pull request title, body and commit messages';
const INSTALL_STEP = "Install the caller's dependencies from its committed lockfile";

/**
 * Every gate reusable in this repository, with the job ids it publishes and, per job, the variable
 * its scan step receives the caller's command in.
 *
 * `installs` is the whole difference between the two forms of a gate, and it is a property of the
 * FILE: a caller opts in by naming the file, so nothing about a caller's job decides it.
 */
const GATES = [
  {
    file: 'gate-no-internal-refs.yml',
    installs: false,
    sibling: 'gate-no-internal-refs-install.yml',
    inputs: { command: 'pnpm check:no-internal-refs' },
    jobs: [{ id: 'public-surface', condition: null, variable: 'SURFACE_COMMAND', scan: SURFACE_STEP }],
  },
  {
    file: 'gate-no-internal-refs-install.yml',
    installs: true,
    sibling: 'gate-no-internal-refs.yml',
    inputs: { command: 'pnpm check:no-internal-refs' },
    jobs: [{ id: 'public-surface', condition: null, variable: 'SURFACE_COMMAND', scan: SURFACE_STEP }],
  },
  {
    file: 'gate-no-emdash.yml',
    installs: false,
    sibling: 'gate-no-emdash-install.yml',
    inputs: { 'files-command': 'pnpm check:no-emdash', 'messages-command': 'pnpm check:no-emdash --stdin' },
    jobs: [
      { id: 'tracked-files', condition: null, variable: 'FILES_COMMAND', scan: TRACKED_STEP },
      { id: 'messages', condition: MESSAGES_CONDITION, variable: 'MESSAGES_COMMAND', scan: MESSAGES_STEP },
    ],
  },
  {
    file: 'gate-no-emdash-install.yml',
    installs: true,
    sibling: 'gate-no-emdash.yml',
    inputs: { 'files-command': 'pnpm check:no-emdash', 'messages-command': 'pnpm check:no-emdash --stdin' },
    jobs: [
      { id: 'tracked-files', condition: null, variable: 'FILES_COMMAND', scan: TRACKED_STEP },
      { id: 'messages', condition: MESSAGES_CONDITION, variable: 'MESSAGES_COMMAND', scan: MESSAGES_STEP },
    ],
  },
];

const gate = (file) => GATES.find((entry) => entry.file === file);
const INSTALLING = GATES.filter((entry) => entry.installs);
const NON_INSTALLING = GATES.filter((entry) => !entry.installs);

/** The step sequence of each job, as it stands, by what each step IS rather than by its label. */
const STEP_SEQUENCES = {
  'gate-no-internal-refs.yml': {
    'public-surface': ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node', `run: ${SURFACE_STEP}`],
  },
  'gate-no-internal-refs-install.yml': {
    'public-surface': [
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      `run: ${INSTALL_STEP}`,
      `run: ${SURFACE_STEP}`,
    ],
  },
  'gate-no-emdash.yml': {
    'tracked-files': ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node', `run: ${TRACKED_STEP}`],
    messages: ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node', `run: ${MESSAGES_STEP}`],
  },
  'gate-no-emdash-install.yml': {
    'tracked-files': [
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      `run: ${INSTALL_STEP}`,
      `run: ${TRACKED_STEP}`,
    ],
    messages: [
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      `run: ${INSTALL_STEP}`,
      `run: ${MESSAGES_STEP}`,
    ],
  },
};

/** What a step is: the action it runs, or the label of the script it runs. The pin is neither SHA. */
const identify = (step) => (step.fields.uses ? step.fields.uses.split('@')[0] : `run: ${step.label}`);

// ---------------------------------------------------------------------------
// Reading a gate, and the shapes that mean "this installs" or "this scans"
// ---------------------------------------------------------------------------

/**
 * A dependency install, in any package manager this estate could reach for.
 *
 * `run_install` is in the set because `pnpm/action-setup` performs the install itself when a caller
 * hands it that input, which is an install nothing in a `run:` body would have shown.
 */
const INSTALL_COMMAND = /(?:pnpm|npm|yarn)\s+(?:install|ci|i)\b/;

/** The lockfile half of it. An install that resolves whatever the registry offers is a different act. */
const FROM_THE_LOCKFILE = /--frozen-lockfile\b/;

const installsDependencies = (step) =>
  INSTALL_COMMAND.test(step.fields.run ?? '') || Object.hasOwn(step.with ?? {}, 'run_install');

/** The scan step of a job: the one that RECEIVES the caller's command and RUNS it. Both halves. */
function scanStep(job, variable) {
  const invokes = new RegExp(String.raw`\$\{?${variable}\b`);
  return job.steps.find((step) => step.env[variable] !== undefined && invokes.test(step.fields.run ?? ''));
}

/** Parse, or fail naming the file. A suite that cannot read its subject must say so. */
function jobsOf(file, text) {
  try {
    return parseWorkflow(text).byId;
  } catch (error) {
    assert.fail(`${WORKFLOWS}/${file}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// AC-4: the job ids, which are the check-run contexts a caller's ruleset names
// ---------------------------------------------------------------------------

/** Every way this file's job ids differ from the ones a caller's ruleset was written against. */
function jobIdFindings(entry, text) {
  const byId = jobsOf(entry.file, text);
  const declared = Object.keys(byId);
  const findings = [];
  const expected = entry.jobs.map((job) => job.id);
  if (declared.join(',') !== expected.join(',')) {
    findings.push(
      `${WORKFLOWS}/${entry.file} declares the job ids ${JSON.stringify(declared)} where the pin names ` +
        `${JSON.stringify(expected)}. A ruleset entry requiring \`<caller job id> / <inner job id>\` is ` +
        'detached by that with no error and no re-run that undoes it.',
    );
  }
  for (const id of declared) {
    if (!PUBLISHED_CONTEXTS.includes(id)) {
      findings.push(`${WORKFLOWS}/${entry.file} declares the job \`${id}\`, which is a check-run context no gate publishes`);
    }
  }
  return findings;
}

test('AC-4: every gate reusable declares the job ids of the pin, and no gate declares another', () => {
  for (const entry of GATES) assert.deepEqual(jobIdFindings(entry, read(entry.file)), []);

  // The installing form of a gate publishes the SAME contexts as the form it copies, which is what
  // makes moving between them a `uses:` line and not a ruleset edit.
  for (const entry of INSTALLING) {
    assert.deepEqual(
      entry.jobs.map((job) => job.id),
      gate(entry.sibling).jobs.map((job) => job.id),
    );
  }
});

test('AC-4: a renamed or added job id is a finding, so the assertion above is not a tautology', () => {
  const original = read('gate-no-internal-refs-install.yml');
  const entry = gate('gate-no-internal-refs-install.yml');

  const renamed = original.replace('\n  public-surface:\n', () => '\n  public-surface-install:\n');
  assert.notEqual(renamed, original, 'the rename mutation is a no-op, so it measures nothing');
  const forRename = jobIdFindings(entry, renamed);
  assert.equal(forRename.length, 2, forRename.join('\n'));
  assert.match(forRename[0], /where the pin names/);
  assert.match(forRename[1], /is a check-run context no gate publishes/);

  const added = original.replace(
    '\njobs:\n',
    () => '\njobs:\n  summary:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
  );
  assert.notEqual(added, original, 'the added-job mutation is a no-op, so it measures nothing');
  const forAdd = jobIdFindings(entry, added);
  assert.equal(forAdd.length, 2, forAdd.join('\n'));
  assert.match(forAdd[1], /declares the job `summary`/);
});

// ---------------------------------------------------------------------------
// AC-2: the caller selects the installing form with its `uses:` line, and nothing else
// ---------------------------------------------------------------------------

/** The `workflow_call` interface, read by this repository's own narrow reader. */
function interfaceOf(file, text) {
  const readIt = readWorkflowInterface(text, file);
  assert.equal(readIt.ok, true, readIt.ok ? '' : readIt.reason);
  return readIt.interface;
}

/** Every input that would force a caller to write a `with:` key to use this file. */
function withKeyFindings(file, text) {
  const declared = interfaceOf(file, text).inputs;
  const findings = [];
  for (const [name, input] of Object.entries(declared)) {
    if (input.required) findings.push(`${WORKFLOWS}/${file}: the input \`${name}\` is required, so a caller must write a \`with:\` key`);
    if (!input.default.present) {
      findings.push(`${WORKFLOWS}/${file}: the input \`${name}\` has no default, so a caller passing nothing gets an empty command`);
    }
  }
  return findings;
}

test('AC-2: no gate reusable makes a caller write a `with:`, and the two forms take the same inputs', () => {
  for (const entry of GATES) {
    assert.deepEqual(withKeyFindings(entry.file, read(entry.file)), []);
    const declared = interfaceOf(entry.file, read(entry.file));
    assert.deepEqual(
      Object.fromEntries(Object.entries(declared.inputs).map(([name, input]) => [name, input.default.value])),
      entry.inputs,
      `${entry.file}: the input set or a default moved`,
    );
    assert.deepEqual(declared.secrets, {}, `${entry.file}: a gate that needs a secret is a gate that can leak one`);
    // The installing form is selected by its `uses:` line ALONE, so its interface has to be the one
    // the caller already passes nothing to.
    assert.deepEqual(Object.keys(declared.inputs).sort(), Object.keys(gate(entry.sibling).inputs).sort());
  }
});

test('AC-2: an input that a caller would have to pass is a finding', () => {
  const file = 'gate-no-emdash-install.yml';
  const original = read(file);
  for (const [what, from, to, expected] of [
    ['a required input', '        type: string\n        default: "pnpm check:no-emdash"\n', '        type: string\n        required: true\n        default: "pnpm check:no-emdash"\n', /is required/],
    ['an input with no default', '        default: "pnpm check:no-emdash"\n', '', /has no default/],
  ]) {
    const mutated = original.replace(from, () => to);
    assert.notEqual(mutated, original, `${what}: the mutation is a no-op, so it measures nothing`);
    const findings = withKeyFindings(file, mutated);
    assert.equal(findings.length, 1, findings.join('\n'));
    assert.match(findings[0], expected);
  }
});

// ---------------------------------------------------------------------------
// AC-1: the install runs before the scan, from the lockfile the caller committed
// ---------------------------------------------------------------------------

/**
 * Every way an installing form fails to hand its scan command a prepared tree.
 *
 * A job whose install or scan step this examination cannot find is a FINDING rather than zero
 * findings: an examination that located neither half has measured nothing.
 */
function installOrderFindings(entry, text) {
  const byId = jobsOf(entry.file, text);
  const findings = [];
  for (const { id, variable } of entry.jobs) {
    const at = `${WORKFLOWS}/${entry.file}: job \`${id}\``;
    const job = byId[id];
    if (job === undefined) {
      findings.push(`${at} is not declared at all`);
      continue;
    }
    const install = job.steps.find(installsDependencies);
    const scan = scanStep(job, variable);
    const checkout = job.steps.find((step) => (step.fields.uses ?? '').startsWith('actions/checkout@'));
    if (scan === undefined) {
      findings.push(`${at} has no step running \`$${variable}\`, so the command the caller named is never run`);
      continue;
    }
    if (install === undefined) {
      findings.push(`${at} runs \`$${variable}\` against a tree with no install, so a command reaching an installed package fails closed`);
      continue;
    }
    if (!FROM_THE_LOCKFILE.test(install.fields.run ?? '')) {
      findings.push(`${at} installs without \`--frozen-lockfile\`, so it resolves something the caller did not commit`);
    }
    if (checkout === undefined) {
      findings.push(`${at} installs into a tree it never checked out`);
    } else if (checkout.index > install.index) {
      findings.push(`${at} installs at step ${install.index} and checks the tree out at step ${checkout.index}`);
    }
    if (install.index > scan.index) {
      findings.push(
        `${at} runs its install at step ${install.index} and the scan at step ${scan.index}, so the command ` +
          'the caller named sees the tree as it was before the install',
      );
    }
  }
  return findings;
}

test('AC-1: each installing form installs from the committed lockfile before it runs the scan', () => {
  for (const entry of INSTALLING) assert.deepEqual(installOrderFindings(entry, read(entry.file)), []);
});

test('AC-1: dropping or loosening the install is a finding, in every job of every form', () => {
  for (const entry of INSTALLING) {
    const original = read(entry.file);

    // The install deleted outright, from every job of the file at once: a form that installs in one
    // job and not the other is exactly the drift two files of one gate can produce.
    const withoutInstall = original.replaceAll(
      `      - name: ${INSTALL_STEP}\n        run: |\n          set -euo pipefail\n          pnpm install --frozen-lockfile\n`,
      '',
    );
    assert.notEqual(withoutInstall, original, `${entry.file}: the delete mutation is a no-op`);
    const dropped = installOrderFindings(entry, withoutInstall);
    assert.equal(dropped.length, entry.jobs.length, dropped.join('\n'));
    for (const { id } of entry.jobs) {
      assert.ok(
        dropped.some((finding) => finding.includes(`job \`${id}\``) && /with no install/.test(finding)),
        `${entry.file}: job \`${id}\` lost its install and nothing said so:\n${dropped.join('\n')}`,
      );
    }

    // The lockfile dropped, which is an install of whatever the registry offers today.
    const loosened = original.replaceAll('pnpm install --frozen-lockfile', 'pnpm install');
    assert.notEqual(loosened, original, `${entry.file}: the loosen mutation is a no-op`);
    const findings = installOrderFindings(entry, loosened);
    assert.equal(findings.length, entry.jobs.length, findings.join('\n'));
    for (const finding of findings) assert.match(finding, /without `--frozen-lockfile`/);
  }
});

test('AC-1: an install that runs after the scan is reported, not passed over', () => {
  // Written as a synthetic gate rather than as an edit to a delivered file: moving a step by string
  // surgery in four files proves the surgery, and one file with the steps in the wrong order proves
  // the rule. The job id and the variable are the real ones, so the examination runs its real path.
  const backwards = [
    'name: backwards',
    'on:',
    '  workflow_call:',
    '    inputs:',
    '      command:',
    '        description: "The command."',
    '        type: string',
    '        default: "pnpm check:no-internal-refs"',
    'jobs:',
    '  public-surface:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    `      - name: ${SURFACE_STEP}`,
    '        env:',
    '          SURFACE_COMMAND: ${{ inputs.command }}',
    '        run: |',
    '          set -euo pipefail',
    '          $SURFACE_COMMAND',
    `      - name: ${INSTALL_STEP}`,
    '        run: |',
    '          set -euo pipefail',
    '          pnpm install --frozen-lockfile',
    '',
  ].join('\n');
  const findings = installOrderFindings(gate('gate-no-internal-refs-install.yml'), backwards);
  assert.equal(findings.length, 1, findings.join('\n'));
  assert.match(findings[0], /sees the tree as it was before the install/);
});

// ---------------------------------------------------------------------------
// AC-3: the non-installing form is what it was, and costs what it cost
// ---------------------------------------------------------------------------

/** Every step of `file` that installs dependencies, which a non-installing form must have none of. */
function unwantedInstallFindings(entry, text) {
  const byId = jobsOf(entry.file, text);
  const findings = [];
  for (const { id } of entry.jobs) {
    for (const step of byId[id]?.steps ?? []) {
      if (installsDependencies(step)) {
        findings.push(
          `${WORKFLOWS}/${entry.file}: job \`${id}\`, step ${step.index} ("${step.label}") installs dependencies, ` +
            'and a gate that is a dependency-free shell script must not be made to pay for one',
        );
      }
    }
  }
  return findings;
}

/** The step sequence of each job, by what each step is, compared against the pin. */
function sequenceFindings(entry, text) {
  const byId = jobsOf(entry.file, text);
  const findings = [];
  for (const { id } of entry.jobs) {
    const found = (byId[id]?.steps ?? []).map(identify);
    const expected = STEP_SEQUENCES[entry.file][id];
    if (found.join(' -> ') !== expected.join(' -> ')) {
      findings.push(
        `${WORKFLOWS}/${entry.file}: job \`${id}\` runs ${JSON.stringify(found)} where the pin runs ${JSON.stringify(expected)}`,
      );
    }
  }
  return findings;
}

test('AC-3: neither non-installing form installs anything, and both run the steps they ran at the pin', () => {
  for (const entry of NON_INSTALLING) {
    assert.deepEqual(unwantedInstallFindings(entry, read(entry.file)), []);
    assert.deepEqual(sequenceFindings(entry, read(entry.file)), []);
  }
  // And the installing forms are the same sequence with the install step inserted before the scan,
  // so the two forms cannot drift into two different pipelines.
  for (const entry of INSTALLING) assert.deepEqual(sequenceFindings(entry, read(entry.file)), []);
});

test('AC-3: an install added to a non-installing form is a finding, in a `run:` body or in a `with:`', () => {
  for (const entry of NON_INSTALLING) {
    const original = read(entry.file);
    const inRun = original.replaceAll(
      '      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9\n',
      '      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9\n\n      - run: pnpm install --frozen-lockfile\n',
    );
    assert.notEqual(inRun, original, `${entry.file}: the run mutation is a no-op, so it measures nothing`);
    const runFindings = unwantedInstallFindings(entry, inRun);
    assert.equal(runFindings.length, entry.jobs.length, runFindings.join('\n'));
    assert.match(runFindings[0], /installs dependencies/);
    assert.ok(sequenceFindings(entry, inRun).length > 0, 'a step added to a pinned sequence must be reported too');

    // The same install, spelled as an input to the setup action, which no `run:` body would show.
    const inWith = original.replaceAll(
      '      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9\n',
      '      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9\n        with:\n          run_install: true\n',
    );
    assert.notEqual(inWith, original, `${entry.file}: the with mutation is a no-op, so it measures nothing`);
    assert.equal(unwantedInstallFindings(entry, inWith).length, entry.jobs.length, 'run_install is an install');
  }
});

// ---------------------------------------------------------------------------
// AC-5: nothing conditional on the path from the caller's trigger to the command
// ---------------------------------------------------------------------------

/**
 * Every construct in this gate that keeps a required context while losing the work behind it.
 *
 * A job skipped by a conditional SATISFIES its required context, so a gate behind one reports
 * success having scanned nothing. `messages` is the one job allowed a condition, because it is the
 * one job that must never be required, and it is allowed EXACTLY the condition it carries today.
 */
function conditionFindings(entry, text) {
  const byId = jobsOf(entry.file, text);
  const findings = [];
  for (const { id, condition, variable } of entry.jobs) {
    const at = `${WORKFLOWS}/${entry.file}: job \`${id}\``;
    const job = byId[id];
    if (job === undefined) {
      findings.push(`${at} is not declared, so the context a caller requires is not emitted at all`);
      continue;
    }
    if ((job.keys.if ?? null) !== condition) {
      findings.push(
        condition === null
          ? `${at} carries a job-level \`if: ${job.keys.if}\`, and a job skipped by a conditional satisfies its required context`
          : `${at} carries \`if: ${job.keys.if ?? '(none)'}\` where the pin carries \`if: ${condition}\``,
      );
    }
    if (job.keys.needs !== undefined) {
      findings.push(`${at} carries \`needs: ${job.keys.needs}\`, and a job skipped because a dependency failed reports a pass`);
    }
    if (job.keys['continue-on-error'] !== undefined) {
      findings.push(`${at} carries \`continue-on-error\`, so a finding cannot red the run`);
    }
    for (const step of job.steps) {
      if (!installsDependencies(step) && step !== scanStep(job, variable)) continue;
      const spelled = conditionsOf(step).trim();
      if (spelled !== '') {
        findings.push(
          `${at}, step ${step.index} ("${step.label}") carries a step-level \`if: ${spelled}\`, and a skipped ` +
            'install or gate step leaves the context reporting success',
        );
      }
    }
  }
  return findings;
}

test('AC-5: no gate reusable conditions the path from the trigger to the command', () => {
  for (const entry of GATES) assert.deepEqual(conditionFindings(entry, read(entry.file)), []);

  // The one condition the set allows is the one the em-dash gate's unrequirable half carries, and it
  // is the same string in both forms rather than two conditions that happen to agree today.
  for (const file of ['gate-no-emdash.yml', 'gate-no-emdash-install.yml']) {
    assert.equal(jobsOf(file, read(file)).messages.keys.if, MESSAGES_CONDITION);
  }
});

/** Each way of keeping the context and losing the work, as an edit a later change could make. */
const SKIP_MUTATIONS = [
  {
    what: 'a job-level condition',
    apply: (text, id) => text.replace(`\n  ${id}:\n`, () => `\n  ${id}:\n    if: github.event_name == 'push'\n`),
    expect: /carries a job-level `if:|where the pin carries/,
  },
  {
    what: 'a dependency on another job',
    apply: (text, id) => text.replace(`\n  ${id}:\n`, () => `\n  ${id}:\n    needs: something-else\n`),
    expect: /carries `needs:/,
  },
  {
    what: 'continue-on-error on the job',
    apply: (text, id) => text.replace(`\n  ${id}:\n`, () => `\n  ${id}:\n    continue-on-error: true\n`),
    expect: /carries `continue-on-error`/,
  },
  {
    what: 'a condition on the install step',
    apply: (text) => text.replace(`      - name: ${INSTALL_STEP}\n`, () => `      - name: ${INSTALL_STEP}\n        if: github.event_name == 'push'\n`),
    expect: /carries a step-level `if:/,
  },
];

test('AC-5: each of those constructs is a finding naming the file and the job id', () => {
  for (const entry of GATES) {
    const original = read(entry.file);
    for (const { id, condition } of entry.jobs) {
      for (const mutation of SKIP_MUTATIONS) {
        // A file with no install step cannot grow a condition on one, and a job that already carries
        // the one allowed condition cannot be given a second `if:` without writing YAML that no
        // reader resolves. That job's condition is pinned by its own case below instead.
        if (mutation.what === 'a condition on the install step' && !entry.installs) continue;
        if (mutation.what === 'a job-level condition' && condition !== null) continue;
        const mutated = mutation.apply(original, id);
        assert.notEqual(mutated, original, `${entry.file}: the mutation for ${mutation.what} is a no-op`);
        const findings = conditionFindings(entry, mutated);
        assert.ok(findings.length > 0, `${entry.file}: ${mutation.what} produced no finding`);
        assert.ok(
          findings.some((finding) => mutation.expect.test(finding) && finding.includes(`${WORKFLOWS}/${entry.file}`)),
          `${entry.file}: ${mutation.what} produced ${findings.join(' | ')}`,
        );
      }
    }
  }
});

test('AC-5: the `messages` condition is pinned, so widening or dropping it is a finding too', () => {
  const entry = gate('gate-no-emdash-install.yml');
  const original = read(entry.file);
  for (const [what, to] of [
    ['a widened condition', "    if: github.event_name == 'pull_request' || github.event_name == 'push'\n"],
    ['no condition at all', ''],
  ]) {
    const mutated = original.replace(`    if: ${MESSAGES_CONDITION}\n`, () => to);
    assert.notEqual(mutated, original, `${what}: the mutation is a no-op, so it measures nothing`);
    const findings = conditionFindings(entry, mutated);
    assert.equal(findings.length, 1, findings.join('\n'));
    assert.match(findings[0], /where the pin carries/);
  }
});

// ---------------------------------------------------------------------------
// AC-6: a failed install is a red job that never scans
// ---------------------------------------------------------------------------
//
// THE SET BELOW IS THE WHOLE OF WHAT AN ACTIONS JOB OFFERS FOR RUNNING A LATER STEP AFTER AN EARLIER
// ONE FAILED, and that is why absence of all of it is the grading route. A step's implicit condition
// is `success()`: without one of these, a failed step ends the job and every step after it is
// skipped. `continue-on-error` reports the failed step as successful; the four status-check
// functions each remove the implicit `success()`; `|| true`, `|| :`, `|| exit 0` and `; true` hand
// the shell a zero exit for a command that failed; `set +e` disarms the `set -e` the bodies set; and
// a job-level `continue-on-error` reports the whole job green. `if: always()` is the shape the
// criterion names by hand and is covered by the status-check clause.

const RECOVERY_SHAPES = [
  { what: '`continue-on-error`', pattern: /(^|\s)continue-on-error\s*:/ },
  { what: 'a status-check function, which removes the implicit `success()`', pattern: /\b(?:always|failure|cancelled|success)\s*\(/ },
  { what: 'a shell swallow of a non-zero exit', pattern: /\|\|\s*(?:true\b|:\s|:$|exit\s+0\b)/ },
  { what: 'a `; true` after a command', pattern: /;\s*true\s*$/ },
  { what: '`set +e`, which disarms the `set -e` the body sets', pattern: /(?:^|;|\s)set\s+\+e/ },
  { what: 'a read of an earlier step\'s outcome', pattern: /steps\.[\w-]+\.(?:outcome|conclusion)/ },
];

/** Every construct in this gate's CODE that could run a step after a failed one. Comments are prose. */
function recoveryFindings(file, text) {
  const findings = [];
  for (const [index, line] of decomment(text).entries()) {
    for (const { what, pattern } of RECOVERY_SHAPES) {
      if (pattern.test(line)) findings.push(`${WORKFLOWS}/${file}:${index + 1}: ${what}: ${line.trim()}`);
    }
  }
  return findings;
}

test('AC-6: no gate reusable carries any construct that runs a step after a failed one', () => {
  for (const entry of GATES) assert.deepEqual(recoveryFindings(entry.file, read(entry.file)), []);

  // Every scan body sets `set -euo pipefail` itself rather than trusting the runner, so a failed
  // command inside one is a failed step rather than a body that runs on to the next line.
  for (const entry of GATES) {
    const byId = jobsOf(entry.file, read(entry.file));
    for (const { id, variable } of entry.jobs) {
      const step = scanStep(byId[id], variable);
      assert.match(step.fields.run, /^set -euo pipefail\b/, `${entry.file}: job \`${id}\` does not set the shell options`);
    }
  }
});

test('AC-6: each recovery shape is found where it is planted, so the absence above is measured', () => {
  const file = 'gate-no-emdash-install.yml';
  const original = read(file);
  const planted = [
    ['continue-on-error', `      - name: ${INSTALL_STEP}\n`, `      - name: ${INSTALL_STEP}\n        continue-on-error: true\n`, /`continue-on-error`/],
    ['if: always()', `      - name: ${TRACKED_STEP}\n`, `      - name: ${TRACKED_STEP}\n        if: \${{ always() }}\n`, /status-check function/],
    ['|| true', '          $FILES_COMMAND\n', '          $FILES_COMMAND || true\n', /shell swallow/],
    ['; true', '          $FILES_COMMAND\n', '          $FILES_COMMAND ; true\n', /`; true` after a command/],
    ['set +e', '          set -euo pipefail\n          pnpm install', '          set -euo pipefail\n          set +e\n          pnpm install', /`set \+e`/],
    [
      'a read of an earlier outcome',
      `      - name: ${TRACKED_STEP}\n`,
      `      - name: ${TRACKED_STEP}\n        if: steps.install.outcome == 'failure'\n`,
      /outcome/,
    ],
  ];
  for (const [what, from, to, expected] of planted) {
    const mutated = original.replace(from, () => to);
    assert.notEqual(mutated, original, `${what}: the mutation is a no-op, so it measures nothing`);
    const findings = recoveryFindings(file, mutated);
    assert.ok(findings.length > 0, `${what} was planted and nothing found it`);
    assert.ok(findings.some((finding) => expected.test(finding)), `${what} produced ${findings.join(' | ')}`);
  }
});

test('AC-6: a comment saying the shape is absent is not the shape, so the rule reads code alone', () => {
  // Both installing forms say in prose that they carry no `continue-on-error` and no `|| true`. A
  // sweep that could not tell prose from configuration would force those sentences to be deleted,
  // which is how the reason for a rule gets lost.
  for (const entry of INSTALLING) {
    assert.match(read(entry.file), /#.*`continue-on-error`/, `${entry.file} no longer states the rule it keeps`);
  }
});

// ---------------------------------------------------------------------------
// AC-7: no scanning rule of its own, and the command reaches the shell through `env:`
// ---------------------------------------------------------------------------

const EXPRESSION = /\$\{\{/;

/** Every expression in this file that is not on a child line of an `env:` block. */
function interpolationFindings(file, text) {
  const findings = [];
  let envIndent = null;
  for (const [index, line] of decomment(text).entries()) {
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    if (envIndent !== null && indent <= envIndent) envIndent = null;
    const opensEnv = /^\s*(?:-\s+)?env:\s*$/.test(line);
    const insideEnv = envIndent !== null && indent > envIndent;
    if (EXPRESSION.test(line) && !insideEnv) {
      findings.push(`${WORKFLOWS}/${file}:${index + 1}: ${line.trim()} is an expression outside an \`env:\` block`);
    }
    if (opensEnv) envIndent = indent;
  }
  return findings;
}

/** Every way this file carries a scanner, or a rule of its own, instead of calling the caller's. */
const DELIVERY = [
  { what: 'fetches a file over the network', pattern: /\bcurl\b|\bwget\b|raw\.githubusercontent\.com/ },
  { what: 'checks out a second repository', pattern: /^\s*repository:\s*\S/m },
  { what: 'resolves the commit of its own workflow file', pattern: /workflow_sha/ },
];

function deliveryFindings(file, text) {
  const code = decomment(text).join('\n');
  return DELIVERY.filter(({ pattern }) => pattern.test(code)).map(
    ({ what }) => `${WORKFLOWS}/${file} ${what}, so it carries a scanning rule of its own`,
  );
}

test('AC-7: the caller\'s command reaches the shell through `env:` and decides the job', () => {
  for (const entry of GATES) {
    assert.deepEqual(interpolationFindings(entry.file, read(entry.file)), []);
    assert.deepEqual(deliveryFindings(entry.file, read(entry.file)), []);
    const byId = jobsOf(entry.file, read(entry.file));
    for (const { id, variable } of entry.jobs) {
      const step = scanStep(byId[id], variable);
      const input = variable === 'SURFACE_COMMAND' ? 'command' : variable === 'FILES_COMMAND' ? 'files-command' : 'messages-command';
      assert.equal(step.env[variable], `\${{ inputs.${input} }}`, `${entry.file}: job \`${id}\``);
    }
  }
});

test('AC-7: the installing form runs the caller\'s command byte for byte as the other form runs it', () => {
  for (const entry of INSTALLING) {
    const mine = jobsOf(entry.file, read(entry.file));
    const theirs = jobsOf(entry.sibling, read(entry.sibling));
    for (const { id, variable } of entry.jobs) {
      assert.equal(
        scanStep(mine[id], variable).fields.run,
        scanStep(theirs[id], variable).fields.run,
        `${entry.file}: job \`${id}\` runs a different program than ${entry.sibling} does`,
      );
    }
    // And the requirable half's whole program IS the caller's command with the shell options, pinned
    // rather than pattern matched: a pattern would admit a body that had grown a file selection or a
    // verdict of its own beside the call.
    const requirable = entry.jobs[0];
    assert.equal(scanStep(mine[requirable.id], requirable.variable).fields.run, `set -euo pipefail $${requirable.variable}`);
  }
});

test('AC-7: an interpolated command and a delivered scanner are both findings', () => {
  const file = 'gate-no-internal-refs-install.yml';
  const original = read(file);

  const interpolated = original.replace('          $SURFACE_COMMAND\n', () => '          ${{ inputs.command }}\n');
  assert.notEqual(interpolated, original, 'the interpolation mutation is a no-op, so it measures nothing');
  const findings = interpolationFindings(file, interpolated);
  assert.equal(findings.length, 1, findings.join('\n'));
  assert.match(findings[0], /is an expression outside an `env:` block/);

  const delivered = original.replace(
    '          set -euo pipefail\n          $SURFACE_COMMAND\n',
    () => '          set -euo pipefail\n          curl -sSfL https://example.invalid/scan.mjs -o scan.mjs\n          node scan.mjs\n',
  );
  assert.notEqual(delivered, original, 'the delivery mutation is a no-op, so it measures nothing');
  assert.deepEqual(deliveryFindings(file, delivered), [
    `${WORKFLOWS}/${file} fetches a file over the network, so it carries a scanning rule of its own`,
  ]);
});
