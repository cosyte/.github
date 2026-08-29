// Tests for scripts/reference-publish.mjs, the path that publishes each default-branch state of the
// six reusable workflows at a reference that names one commit forever.
//
// WHAT THESE TESTS ARE FOR, said once so each case reads against it. There are two ways to get this
// wrong and only one of them is cheap.
//
//   THE CHEAP WRONG ANSWER is a red run on this repository. Nobody downstream notices, someone reads
//   the refusal, and the reference is published on the next push.
//   THE EXPENSIVE WRONG ANSWERS are both permanent. A name republished at a different commit turns
//   thirteen repositories' pinned references into moving ones while still LOOKING immutable, which
//   is worse than the `@main` they were pinned off. And a reference published with a note that says
//   a caller has nothing to act on, when a required input was added, is a caller who upgraded on
//   that note and broke.
//
// So the questions every case below is really asking are: when this path cannot tell, does it
// refuse, and when it can tell, does the note say so.
//
// ▶ THE NARROW YAML READER IS THE PART MOST LIKELY TO BE "FIXED" INTO A DEFECT. This repository has
//   no package.json and no install step, so there is no YAML library and there may not be one. The
//   reader therefore recognises the shapes these six files use and refuses everything else, and the
//   cases under "the reader refuses rather than guessing" are what stop a later edit from making it
//   permissive. A permissive reader does not fail; it publishes a reference whose note is silent
//   about the change it could not see, which is the one failure nobody downstream can detect.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  composeNote,
  decide,
  deniedPermission,
  DESTRUCTIVE_ARGUMENTS,
  diffInterfaces,
  digestOf,
  executePublish,
  gatherState,
  isStateFile,
  main,
  operationsAreNonDestructive,
  publishOperations,
  readValue,
  readWorkflowInterface,
  referenceName,
  REFERENCE_PATTERN,
  REUSABLE_WORKFLOWS,
  runCommand,
} from '../scripts/reference-publish.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// ---------------------------------------------------------------------------
// Fixtures: reusable workflows small enough to read, real enough to parse
// ---------------------------------------------------------------------------

/** The smallest thing this reader will call a reusable workflow. */
function minimal(name) {
  return [
    `name: ${name}`,
    '',
    `# Caller: uses: cosyte/.github/.github/workflows/${name}@workflows-2026-01-01-0123456789ab`,
    'on:',
    '  workflow_call:',
    '    inputs:',
    '      node-version:',
    '        description: "The Node version."',
    '        type: string',
    '        default: "22"',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  verify:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo ok',
    '',
  ].join('\n');
}

/** A fuller one, carrying every part of the interface a caller can be broken by. */
const FULL = [
  'name: CI',
  '',
  '# Reusable CI.',
  '# Caller (each repo):',
  '#   jobs:',
  '#     ci:',
  '#       uses: cosyte/.github/.github/workflows/ci.yml@workflows-2026-01-01-0123456789ab',
  '',
  'on:',
  '  workflow_call:',
  '    inputs:',
  '      # A comment between two inputs, at the same indentation as a key.',
  '      run-phi-scan:',
  '        description: "Run the PHI scanner."',
  '        type: boolean',
  '        default: false',
  '      package-name:',
  '        description: "npm package name, e.g. \\"@cosyte/hl7\\"."',
  '        type: string',
  '        required: true',
  '      node-versions:',
  "        description: 'JSON array of Node versions.'",
  '        type: string',
  "        default: '[\"22\", \"24\"]'",
  '    secrets:',
  '      NPM_TOKEN:',
  '        required: true',
  '      DOCS_REPO_DISPATCH_TOKEN:',
  '        required: false',
  '',
  'permissions:',
  '  contents: read # a trailing comment, which is not part of the value',
  '  id-token: write',
  '',
  'jobs:',
  '  verify:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: |',
  '          set -euo pipefail',
  '          # a hash inside a block scalar is shell, not YAML',
  '          echo "jobs:"',
  '          echo "  not-a-job:"',
  '  actionlint:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: read',
  '      security-events: write',
  '    steps:',
  '      - run: echo lint',
  '',
].join('\n');

/** Parse a fixture and insist it parsed, because a fixture that refuses proves nothing. */
function iface(text, name = 'ci.yml') {
  const read = readWorkflowInterface(text, name);
  assert.equal(read.ok, true, `the fixture should parse: ${read.ok ? '' : read.reason}`);
  return read.interface;
}

/** The six, with any of them overridden. Anything absent is genuinely absent, which AC7 refuses. */
function six(overrides = {}) {
  const map = {};
  for (const name of REUSABLE_WORKFLOWS) {
    if (name in overrides) {
      if (overrides[name] !== null) map[name] = overrides[name];
      continue;
    }
    map[name] = minimal(name);
  }
  return map;
}

/** A snapshot in the shape `decide` takes: the six readings plus the digests of the state. */
function snapshot(map, extraFiles = {}) {
  const workflows = REUSABLE_WORKFLOWS.map((name) => {
    const text = map[name];
    if (text === undefined) {
      return { name, read: { ok: false, absent: true, reason: `the file \`.github/workflows/${name}\` is absent` } };
    }
    return { name, read: readWorkflowInterface(text, name) };
  });
  const files = [
    ...Object.entries(map).map(([name, text]) => ({ path: `.github/workflows/${name}`, digest: digestOf(text) })),
    ...Object.entries(extraFiles).map(([path, text]) => ({ path, digest: digestOf(text) })),
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  return { workflows, files };
}

const COMMIT_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const COMMIT_B = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';
const DATE = '2026-08-29';

function facts({ current, previous = null, existingReferences = [], commit = COMMIT_B, date = DATE } = {}) {
  return {
    current: { commit, date, ...current },
    previous,
    existingReferences,
  };
}

function previousAt(map, { reference = 'workflows-2026-08-01-a1b2c3d4e5f6', commit = COMMIT_A, extraFiles = {} } = {}) {
  return { reference, commit, ...snapshot(map, extraFiles) };
}

// ===============================================================================================
// The narrow reader: what it reads, and what it refuses rather than guessing (AC7)
// ===============================================================================================

test('AC7: every one of the six reusable workflows in this repository is readable', () => {
  for (const name of REUSABLE_WORKFLOWS) {
    const text = execFileSync('cat', [join(REPO, '.github/workflows', name)], { encoding: 'utf8' });
    const read = readWorkflowInterface(text, name);
    assert.equal(read.ok, true, `${name} must be readable: ${read.ok ? '' : read.reason}`);
    assert.equal(read.interface.workflow, name);
    assert.ok(Object.keys(read.interface.jobs).length > 0, `${name} declares at least one job`);
  }
});

test('AC7: the reader extracts exactly the four things a caller can be broken by', () => {
  const read = iface(FULL);
  assert.deepEqual(Object.keys(read.inputs).sort(), ['node-versions', 'package-name', 'run-phi-scan']);
  assert.equal(read.inputs['package-name'].required, true);
  assert.equal(read.inputs['package-name'].default.present, false);
  assert.equal(read.inputs['run-phi-scan'].default.value, false, 'a plain `false` is a boolean, not the text');
  assert.equal(read.inputs['node-versions'].default.value, '["22", "24"]', 'a single-quoted scalar keeps its quotes out');
  assert.deepEqual(read.secrets, { NPM_TOKEN: { required: true }, DOCS_REPO_DISPATCH_TOKEN: { required: false } });
  assert.deepEqual(read.permissions.workflow, { contents: 'read', 'id-token': 'write' });
  assert.deepEqual(read.permissions.jobs.actionlint, { contents: 'read', 'security-events': 'write' });
  assert.equal(read.permissions.jobs.verify, null, 'a job with no permissions block declares none');
  assert.deepEqual(Object.keys(read.jobs), ['verify', 'actionlint']);
});

test('AC7: a `run:` block scalar cannot be mistaken for structure', () => {
  // The fixture's `run: |` body contains the literal lines `jobs:` and `  not-a-job:`. A reader that
  // strips comments and greps for keys reports a job that does not exist, which then shows up in a
  // note as a job a caller must act on.
  const read = iface(FULL);
  assert.deepEqual(Object.keys(read.jobs), ['verify', 'actionlint']);
  assert.equal('not-a-job' in read.jobs, false);
});

test('readValue strips a trailing comment from a plain scalar and never from inside quotes', () => {
  assert.deepEqual(readValue(' write # create tags'), { kind: 'scalar', value: 'write' });
  assert.deepEqual(readValue(' "a # b"'), { kind: 'scalar', value: 'a # b' });
  assert.deepEqual(readValue(" 'a # b'"), { kind: 'scalar', value: 'a # b' });
  assert.deepEqual(readValue(' true'), { kind: 'scalar', value: true });
  assert.deepEqual(readValue(''), { kind: 'empty' });
  assert.equal(readValue(' |').kind, 'block');
  assert.equal(readValue(' [a, b]').kind, 'flow');
  assert.equal(readValue(' "unterminated').kind, 'bad');
});

/**
 * FULL with its whole `inputs:` block swapped out, so a row below tests the refusal it names and
 * not, incidentally, the "nothing may be indented under a value that ends on its line" one.
 */
const inputsReplacedBy = (replacement) =>
  FULL.slice(0, FULL.indexOf('    inputs:')) + replacement + FULL.slice(FULL.indexOf('    secrets:'));

/** The same, for the last job in FULL, which is `actionlint`. */
const actionlintReplacedBy = (replacement) => FULL.slice(0, FULL.indexOf('  actionlint:')) + replacement;

const REFUSALS = [
  ['a tab in the indentation', FULL.replace('  workflow_call:', '\tworkflow_call:'), /tab/],
  ['no `on:` block at all', FULL.replace(/^on:$/m, 'off:'), /no `on:` block/],
  ['an `on:` with no `workflow_call:`', FULL.replace('  workflow_call:', '  push:'), /no `workflow_call:`/],
  [
    'a member of `workflow_call` this reader does not know',
    FULL.replace('    secrets:', '    outputs:\n      digest:\n        value: x\n    secrets:'),
    /declares `outputs:`/,
  ],
  [
    'a key inside an input this reader does not know',
    FULL.replace('        type: boolean', '        type: boolean\n        deprecationMessage: "go away"'),
    /`deprecationMessage:`/,
  ],
  ['a `required:` that is not true or false', FULL.replace('        required: true', '        required: yes'), /required:/],
  ['a duplicated input', FULL.replace('      package-name:', '      run-phi-scan:'), /twice/],
  [
    'an input that is not a mapping',
    inputsReplacedBy('    inputs:\n      run-phi-scan: false\n'),
    /not a block mapping/,
  ],
  ['an `inputs:` that is a flow collection', inputsReplacedBy('    inputs: { a: b }\n'), /not a block mapping/],
  ['no `jobs:` block', FULL.replace(/^jobs:$/m, 'tasks:'), /no `jobs:` block/],
  ['a job that is not a mapping', actionlintReplacedBy('  actionlint: nope\n'), /not a block mapping/],
  [
    'a permissions block whose value is not a scalar',
    FULL.replace('  contents: read # a trailing comment, which is not part of the value', '  contents:\n    - read'),
    /permissions/,
  ],
  ['an unterminated quote in a value this reader reads', FULL.replace('        type: string\n        required: true', '        type: "string\n        required: true'), /type:/],

  // ▶ NOTHING MAY BE INDENTED UNDER A VALUE THAT ALREADY ENDED ON ITS OWN LINE. Each row below is a
  //   shape the reader used to accept while DROPPING the indented line, which is the one way a
  //   caller-affecting change reaches a note that says a caller has nothing to act on. A wrapped
  //   plain scalar is the dangerous one, because it is legal YAML and truncates silently; the rest
  //   are junk that was equally silently swallowed. None of the six files uses any of them, and
  //   nobody is being asked to support one: the answer is to refuse, naming the workflow and the
  //   line.
  [
    'a plain scalar wrapped onto a second line, which would truncate an input default',
    FULL.replace('        default: false', '        default: hello\n          world'),
    /line \d+ is indented under `default:`.*whose value ends on that line/,
  ],
  [
    'a plain scalar wrapped onto a second line, which would truncate a job name',
    FULL.replace('  verify:\n    runs-on', '  verify:\n    name: Verify on Node\n      22 and 24\n    runs-on'),
    /line \d+ is indented under `name:`.*whose value ends on that line/,
  ],
  [
    'a wrapped scalar in the `permissions:` a caller must grant',
    FULL.replace('  id-token: write', '  id-token: write\n    and-more'),
    /line \d+ is indented under `id-token:`/,
  ],
  [
    'a wrapped scalar under a secret a caller must pass',
    FULL.replace('      NPM_TOKEN:\n        required: true', '      NPM_TOKEN:\n        required: true\n          and-more'),
    /line \d+ is indented under `required:`/,
  ],
  [
    'a block sequence under a scalar',
    FULL.replace('        default: false', '        default: false\n          - three'),
    /line \d+ is indented under `default:`/,
  ],
  [
    'stray junk under a scalar',
    FULL.replace('        default: false', '        default: false\n          ]]]'),
    /line \d+ is indented under `default:`/,
  ],
  [
    'an unterminated quote under a scalar',
    FULL.replace('        default: false', '        default: false\n          "no closing quote'),
    /line \d+ is indented under `default:`/,
  ],
  [
    'a second `key: value` line under a scalar',
    FULL.replace('        default: false', '        default: false\n          required: true'),
    /line \d+ is indented under `default:`/,
  ],
  [
    'a wrapped scalar inside the `on: workflow_call:` block itself',
    FULL.replace('on:\n  workflow_call:', 'on:\n  workflow_call: yes\n    and-more'),
    /line \d+ is indented under `workflow_call:`/,
  ],
];

for (const [label, text, pattern] of REFUSALS) {
  test(`AC7: the reader refuses rather than guessing, on ${label}`, () => {
    const read = readWorkflowInterface(text, 'ci.yml');
    assert.equal(read.ok, false, `${label} should refuse`);
    assert.match(read.reason, /^ci\.yml: /, 'every refusal names the workflow it read');
    assert.match(read.reason, pattern);
  });
}

// -----------------------------------------------------------------------------------------------
// The wrapped scalar, in full: it must never read as "nothing changed"
// -----------------------------------------------------------------------------------------------

/** One reusable whose only variable is the continuation line of a wrapped plain `default:`. */
const wrappedDefault = (continuation) =>
  FULL.replace('        default: false', `        default: hello\n          ${continuation}`);

test('AC7: two interfaces differing only in a wrapped scalar are never read as the same one', () => {
  // The expensive failure this rules out: `hello world` and `hello there` are different defaults, so
  // a reader that truncates both to `hello` reports no change and publishes a reference whose note
  // says a caller has nothing to act on. Refusing is the answer the spec asks for; reading the
  // continuation would be the other one. Silently agreeing they are the same interface is neither.
  const before = readWorkflowInterface(wrappedDefault('world'), 'ci.yml');
  const after = readWorkflowInterface(wrappedDefault('there'), 'ci.yml');

  if (before.ok || after.ok) {
    assert.notDeepEqual(after.interface, before.interface, 'a changed default must not be invisible');
    return;
  }
  for (const refusal of [before, after]) {
    assert.match(refusal.reason, /^ci\.yml: /, 'a refusal names the workflow');
    assert.match(refusal.reason, /whose value ends on that line/);
  }
});

test('AC2 and AC7: a change hidden in a wrapped scalar refuses instead of publishing "nothing changed"', () => {
  const verdict = decide(
    facts({
      current: snapshot(six({ 'ci.yml': wrappedDefault('there') })),
      previous: previousAt(six({ 'ci.yml': wrappedDefault('world') })),
    }),
  );
  assert.equal(verdict.action, 'refused', 'a state it cannot read is not a state it may publish');
  assert.equal(verdict.reference, null);
  assert.equal(verdict.note, null);
  assert.match(verdict.message, /ci\.yml/, 'the refusal names the workflow');
});

test('AC7: a wrapped job name refuses too, because a job name is a check-run context', () => {
  const wrapped = FULL.replace('  verify:\n    runs-on', '  verify:\n    name: Verify on Node\n      22 and 24\n    runs-on');
  const read = readWorkflowInterface(wrapped, 'ci.yml');
  assert.equal(read.ok, false);
  assert.match(read.reason, /^ci\.yml: the job `verify`: /, 'the refusal names the job it could not read');
});

test('comments and blank lines under a value are still not structure, or every file here would refuse', () => {
  // The other half of the rule above, and the reason it costs nothing: in all six real files the
  // ONLY lines indented under a value that ends on its own line are comments and blanks, because a
  // comment block documenting the NEXT input sits under the previous input's `default:`. A rule that
  // reddened the default branch would be worse than the hole it closed, so this pins the exemption.
  const commented = FULL.replace(
    '        default: false',
    ['        default: false', '          # A comment block explaining the input below.', '', '          #   with an indented line of its own'].join('\n'),
  );
  const read = readWorkflowInterface(commented, 'ci.yml');
  assert.equal(read.ok, true, read.ok ? '' : read.reason);
  assert.equal(read.interface.inputs['run-phi-scan'].default.value, false);

  for (const name of REUSABLE_WORKFLOWS) {
    const text = execFileSync('cat', [join(REPO, '.github/workflows', name)], { encoding: 'utf8' });
    assert.equal(readWorkflowInterface(text, name).ok, true, `${name} carries comment blocks under its values and must still read`);
  }
});

test('AC7: a refusal on any one of the six publishes nothing, and names it', () => {
  const broken = six({ 'codeql.yml': minimal('codeql.yml').replace('  workflow_call:', '  push:') });
  const verdict = decide(facts({ current: snapshot(broken), previous: previousAt(six()) }));
  assert.equal(verdict.action, 'refused');
  assert.equal(verdict.failing, true);
  assert.match(verdict.message, /codeql\.yml/);
  assert.equal(verdict.reference, null);
  assert.equal(verdict.note, null);
});

test('AC7: a workflow whose file is absent is the same refusal, and names the file', () => {
  const verdict = decide(facts({ current: snapshot(six({ 'scorecard.yml': null })), previous: previousAt(six()) }));
  assert.equal(verdict.action, 'refused');
  assert.match(verdict.message, /scorecard\.yml/);
  assert.match(verdict.message, /absent/);
});

test('AC7: an EARLIER reference this reader cannot read refuses too, rather than diffing against nothing', () => {
  const previous = previousAt(six());
  previous.workflows[0] = { name: previous.workflows[0].name, read: { ok: false, reason: 'ci.yml: the document does not begin at column 0' } };
  const verdict = decide(facts({ current: snapshot(six({ 'ci.yml': FULL })), previous }));
  assert.equal(verdict.action, 'refused');
  assert.match(verdict.message, /ci\.yml/);
  assert.match(verdict.message, new RegExp(previous.reference));
});

test('a workflow that is absent at the EARLIER reference is new, not a failure', () => {
  const previous = previousAt(six({ 'scorecard.yml': null }));
  const verdict = decide(facts({ current: snapshot(six()), previous }));
  assert.equal(verdict.action, 'publish');
  assert.ok(
    verdict.changes.some((change) => change.kind === 'workflow-added' && change.workflow === 'scorecard.yml'),
    'the new workflow is reported',
  );
  assert.match(verdict.note, /`scorecard\.yml` did not exist at the earlier reference/);
});

// ===============================================================================================
// The diff: what a caller must act on, and what it merely gets told (AC2)
// ===============================================================================================

const ACT_ON = [
  [
    'an input added with no default',
    FULL,
    FULL.replace('    secrets:', '      new-required:\n        type: string\n    secrets:'),
    'input-added-required',
    /`new-required` was added and has no default/,
  ],
  [
    'an input removed',
    FULL,
    FULL.replace('      run-phi-scan:\n        description: "Run the PHI scanner."\n        type: boolean\n        default: false\n', ''),
    'input-removed',
    /`run-phi-scan` was removed/,
  ],
  [
    'a default changed',
    FULL,
    FULL.replace('        default: false', '        default: true'),
    'input-default-changed',
    /default of `run-phi-scan` changed from false to true/,
  ],
  [
    'an input that became required',
    FULL,
    FULL.replace('        type: boolean\n        default: false', '        type: boolean\n        required: true'),
    'input-became-required',
    /the input `run-phi-scan` is now required/,
  ],
  [
    'a secret added',
    FULL,
    FULL.replace('      NPM_TOKEN:', '      RELEASE_PR_TOKEN:\n        required: true\n      NPM_TOKEN:'),
    'secret-added',
    /`RELEASE_PR_TOKEN` was added and is required/,
  ],
  [
    'a secret removed',
    FULL,
    FULL.replace('      NPM_TOKEN:\n        required: true\n', ''),
    'secret-removed',
    /`NPM_TOKEN` was removed/,
  ],
  [
    'a secret that stopped being optional',
    FULL,
    FULL.replace('      DOCS_REPO_DISPATCH_TOKEN:\n        required: false', '      DOCS_REPO_DISPATCH_TOKEN:\n        required: true'),
    'secret-required-changed',
    /`DOCS_REPO_DISPATCH_TOKEN` went from optional to required/,
  ],
  [
    'a workflow-level permission the caller must grant',
    FULL,
    FULL.replace('  id-token: write', '  id-token: write\n  actions: read'),
    'permissions-changed',
    /permissions the workflow asks the caller to grant changed/,
  ],
  [
    'a job-level permission the caller must grant',
    FULL,
    FULL.replace('      security-events: write', '      security-events: write\n      actions: read'),
    'permissions-changed',
    /permissions the job `actionlint` asks the caller to grant changed/,
  ],
  [
    'a job added',
    FULL,
    `${FULL}  prepublish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo new\n`,
    'job-added',
    /the job `prepublish` was added/,
  ],
  [
    'a job removed',
    FULL,
    FULL.replace('  actionlint:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      security-events: write\n    steps:\n      - run: echo lint\n', ''),
    'job-removed',
    /the job `actionlint` was removed/,
  ],
];

for (const [label, before, after, kind, sentence] of ACT_ON) {
  test(`AC2: ${label} is a change a caller must act on, and the note says so`, () => {
    const changes = diffInterfaces(iface(before), iface(after));
    const found = changes.find((change) => change.kind === kind);
    assert.ok(found, `expected a ${kind} among ${JSON.stringify(changes.map((c) => c.kind))}`);
    assert.equal(found.act, true, `${kind} must be a change a caller acts on`);

    const verdict = decide(
      facts({
        current: snapshot(six({ 'ci.yml': after })),
        previous: previousAt(six({ 'ci.yml': before })),
      }),
    );
    assert.equal(verdict.action, 'publish');
    assert.match(verdict.note, /## What a caller must act on/);
    assert.match(verdict.note, sentence);
  });
}

const FOR_INFORMATION = [
  [
    'an input added WITH a default',
    FULL,
    FULL.replace('    secrets:', '      check-docs-content:\n        type: boolean\n        default: false\n    secrets:'),
    'input-added',
  ],
  ['a type changed', FULL, FULL.replace('        type: boolean\n        default: false', '        type: string\n        default: false'), 'input-type-changed'],
];

for (const [label, before, after, kind] of FOR_INFORMATION) {
  test(`AC2: ${label} is reported without being demanded of a caller`, () => {
    const changes = diffInterfaces(iface(before), iface(after));
    const found = changes.find((change) => change.kind === kind);
    assert.ok(found, `expected a ${kind}`);
    assert.equal(found.act, false);
    const verdict = decide(
      facts({ current: snapshot(six({ 'ci.yml': after })), previous: previousAt(six({ 'ci.yml': before })) }),
    );
    assert.equal(verdict.action, 'publish');
    assert.match(verdict.note, /## Changes a caller does not have to act on/);
  });
}

test('AC2: a comment-only edit changes the state but demands nothing of a caller', () => {
  const before = FULL;
  const after = FULL.replace('# Reusable CI.', '# Reusable CI, rewritten prose that says the same thing.');
  assert.notEqual(before, after);
  assert.deepEqual(diffInterfaces(iface(before), iface(after)), []);

  const verdict = decide(
    facts({ current: snapshot(six({ 'ci.yml': after })), previous: previousAt(six({ 'ci.yml': before })) }),
  );
  assert.equal(verdict.action, 'publish', 'the state moved, so the reference is owed');
  assert.match(verdict.note, /Nothing\. No `workflow_call` input/);
});

test('AC2: a change in one workflow does not get attributed to another', () => {
  const after = FULL.replace('        default: false', '        default: true');
  const changes = diffInterfaces(iface(FULL), iface(after));
  for (const change of changes) assert.equal(change.workflow, 'ci.yml');
});

// ===============================================================================================
// The decision (AC1, AC5, AC6) and the refusal guard (AC3, AC4, AC8)
// ===============================================================================================

test('AC1: a changed reusable workflow is published at a reference that names one commit', () => {
  const verdict = decide(
    facts({
      current: snapshot(six({ 'ci.yml': FULL.replace('        default: false', '        default: true') })),
      previous: previousAt(six({ 'ci.yml': FULL })),
    }),
  );
  assert.equal(verdict.action, 'publish');
  assert.match(verdict.reference, REFERENCE_PATTERN);
  assert.equal(verdict.reference, `workflows-${DATE}-${COMMIT_B.slice(0, 12)}`);
  assert.equal(verdict.commit, COMMIT_B);
  assert.match(verdict.note, new RegExp(`uses: cosyte/\\.github/\\.github/workflows/ci\\.yml@${verdict.reference}`));
  assert.equal(verdict.failing, false);
});

test('AC1: the state a caller resolves includes scripts/, so a script-only change is published too', () => {
  const workflows = six();
  const verdict = decide(
    facts({
      current: snapshot(workflows, { 'scripts/install-check.mjs': 'export const version = 2;\n' }),
      previous: previousAt(workflows, { extraFiles: { 'scripts/install-check.mjs': 'export const version = 1;\n' } }),
    }),
  );
  assert.equal(verdict.action, 'publish', 'a caller pinned to a reference runs scripts/ as of that commit');
  assert.match(verdict.note, /scripts\/install-check\.mjs/);
  assert.match(verdict.note, /Nothing\. No `workflow_call` input/, 'and it demands nothing of a caller');
});

test('isStateFile counts the six workflows and scripts, and nothing a caller never runs', () => {
  for (const name of REUSABLE_WORKFLOWS) assert.equal(isStateFile(`.github/workflows/${name}`), true);
  assert.equal(isStateFile('scripts/reference-publish.mjs'), true);
  assert.equal(isStateFile('.github/workflows/self-check.yml'), false);
  assert.equal(isStateFile('.github/workflows/publish-reference.yml'), false);
  assert.equal(isStateFile('README.md'), false);
  assert.equal(isStateFile('test/reference-publish.test.mjs'), false);
});

test('AC5: the first publish says there is no earlier reference, and does not report nothing changed', () => {
  const verdict = decide(facts({ current: snapshot(six({ 'ci.yml': FULL })), previous: null }));
  assert.equal(verdict.action, 'publish');
  assert.match(verdict.note, /No reference has been published from this repository before/);
  assert.match(verdict.note, /no earlier reference to compare this one against/);
  assert.doesNotMatch(verdict.note, /Nothing\. No `workflow_call` input/);
  assert.match(verdict.message, /first reference this repository has ever published/);
});

test('AC5: the first-publish note sends a caller to the interface, not to a list that is not there', () => {
  // "Everything below" was a promise the note did not keep: the sections below that heading are
  // "what moved in the state" and "why this exists", neither of which is a list of changes to act
  // on. A first adopter who reads a heading and skips to the list finds one that is about files.
  const verdict = decide(facts({ current: snapshot(six({ 'ci.yml': FULL })), previous: null }));
  assert.equal(verdict.action, 'publish');
  const mustAct = verdict.note.split('## What a caller must act on')[1].split('\n## ')[0];
  assert.doesNotMatch(mustAct, /below/, 'it must not point at a must-act list that does not exist');
  assert.match(mustAct, /no earlier reference/);
  assert.match(mustAct, /workflow headers at this commit/, 'it says where the interface actually is');
});

test('AC6: an unchanged state publishes nothing and says a second reference was not needed', () => {
  const workflows = six({ 'ci.yml': FULL });
  const previous = previousAt(workflows, { extraFiles: { 'scripts/a.mjs': 'a\n' } });
  const verdict = decide(
    facts({ current: snapshot(workflows, { 'scripts/a.mjs': 'a\n' }), previous, existingReferences: [previous.reference] }),
  );
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.failing, false, 'nothing to do is not a failure');
  assert.equal(verdict.reference, null, 'no second name for the same state');
  assert.equal(verdict.note, null);
  assert.match(verdict.message, /No new reference was needed|byte identical/);
  assert.match(verdict.title, /No new reference was needed/);
});

test('AC6: a re-run on an already published commit reports no reference needed, not a collision', () => {
  // The same push, run twice. `previous` is the reference the first run created, at this very
  // commit. Checking the name collision before the state comparison would red an idempotent re-run.
  const workflows = six({ 'ci.yml': FULL });
  const reference = `workflows-${DATE}-${COMMIT_B.slice(0, 12)}`;
  const previous = previousAt(workflows, { reference, commit: COMMIT_B });
  const verdict = decide(facts({ current: snapshot(workflows), previous, existingReferences: [reference] }));
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.failing, false);
});

test('AC4: a reference name that already exists fails the run and names it', () => {
  const reference = `workflows-${DATE}-${COMMIT_B.slice(0, 12)}`;
  const verdict = decide(
    facts({
      current: snapshot(six({ 'ci.yml': FULL.replace('        default: false', '        default: true') })),
      previous: previousAt(six({ 'ci.yml': FULL })),
      existingReferences: [reference],
    }),
  );
  assert.equal(verdict.action, 'refused');
  assert.equal(verdict.failing, true);
  assert.match(verdict.message, new RegExp(reference));
  assert.match(verdict.message, /NOT deleted, NOT force updated and NOT pointed at another commit/);
  assert.equal(verdict.reference, null, 'a refusal hands nothing to the publisher');
});

test('AC4: the name check binds on a FIRST publish too, where there is nothing to compare against', () => {
  const reference = `workflows-${DATE}-${COMMIT_B.slice(0, 12)}`;
  const verdict = decide(facts({ current: snapshot(six({ 'ci.yml': FULL })), previous: null, existingReferences: [reference] }));
  assert.equal(verdict.action, 'refused');
  assert.match(verdict.message, new RegExp(reference));
});

test('AC3 and AC4: nothing this path can run deletes, forces or edits a published reference', () => {
  const operations = publishOperations({
    reference: 'workflows-2026-08-29-abcdefabcdef',
    commit: COMMIT_B,
    notePath: '/tmp/note.md',
    repository: 'cosyte/.github',
  });
  assert.equal(operationsAreNonDestructive(operations).ok, true);
  for (const operation of operations) {
    assert.equal(operation.command, 'gh', 'the publish never shells out to git');
    for (const argument of operation.args) {
      assert.equal(DESTRUCTIVE_ARGUMENTS.includes(argument), false, `${operation.id} must not pass ${argument}`);
    }
  }
  assert.equal(
    operationsAreNonDestructive([{ id: 'x', command: 'gh', args: ['release', 'delete', 'workflows-1'] }]).ok,
    false,
    'the guard has bite',
  );
  assert.equal(
    operationsAreNonDestructive([{ id: 'x', command: 'git', args: ['tag', '--force', 'workflows-1'] }]).ok,
    false,
  );
});

test('AC3: a later state gets a NEW name and never touches the earlier reference', () => {
  const previous = previousAt(six({ 'ci.yml': FULL }));
  const verdict = decide(
    facts({
      current: snapshot(six({ 'ci.yml': FULL.replace('        default: false', '        default: true') })),
      previous,
      existingReferences: [previous.reference],
    }),
  );
  assert.equal(verdict.action, 'publish');
  assert.notEqual(verdict.reference, previous.reference);
  const operations = publishOperations({
    reference: verdict.reference,
    commit: verdict.commit,
    notePath: '/tmp/note.md',
    repository: 'cosyte/.github',
  });
  for (const operation of operations) {
    assert.equal(
      operation.args.some((argument) => argument.includes(previous.reference)),
      false,
      `${operation.id} must not name the earlier reference at all`,
    );
  }
});

test('AC3: the reference name is a pure function of the commit, so a name is never reusable', () => {
  assert.equal(referenceName({ date: DATE, commit: COMMIT_A }), `workflows-${DATE}-${COMMIT_A.slice(0, 12)}`);
  assert.notEqual(referenceName({ date: DATE, commit: COMMIT_A }), referenceName({ date: DATE, commit: COMMIT_B }));
  assert.equal(referenceName({ date: DATE, commit: 'not-a-sha' }), null);
  assert.equal(referenceName({ date: '29-08-2026', commit: COMMIT_A }), null);
  assert.equal(referenceName({ date: DATE, commit: COMMIT_A.toUpperCase() }), null, 'a SHA is lower case hex');
  // A moving major alias is the shape this must never produce.
  assert.doesNotMatch(referenceName({ date: DATE, commit: COMMIT_A }), /^v\d+$/);
});

test('AC3: a commit or date that does not compose a name publishes nothing', () => {
  const verdict = decide(facts({ current: snapshot(six()), commit: 'HEAD', date: DATE }));
  assert.equal(verdict.action, 'refused');
  assert.match(verdict.message, /do not compose a name/);
});

test('AC8: a note that cannot be produced publishes neither the note nor the reference', () => {
  const verdict = decide(
    facts({
      current: snapshot(six({ 'ci.yml': FULL.replace('        default: false', '        default: true') })),
      previous: previousAt(six({ 'ci.yml': FULL })),
    }),
    { compose: () => ({ ok: false, reason: 'the disk is on fire' }) },
  );
  assert.equal(verdict.action, 'refused');
  assert.equal(verdict.failing, true);
  assert.equal(verdict.note, null);
  assert.equal(verdict.reference, null);
  assert.match(verdict.message, /the disk is on fire/);
  assert.match(verdict.message, /Neither the note nor the reference is published/);
});

test('AC8: composeNote refuses a malformed reference, a short commit and a change it cannot describe', () => {
  const good = { reference: `workflows-${DATE}-${COMMIT_B.slice(0, 12)}`, commit: COMMIT_B, previous: null, changes: [], files: {} };
  assert.equal(composeNote(good).ok, true);
  assert.equal(composeNote({ ...good, reference: 'v1' }).ok, false);
  assert.equal(composeNote({ ...good, reference: 'workflows-main' }).ok, false);
  assert.equal(composeNote({ ...good, commit: COMMIT_B.slice(0, 12) }).ok, false);
  const unknown = composeNote({ ...good, changes: [{ workflow: 'ci.yml', kind: 'sky-fell', act: true, subject: 'x' }] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /sky-fell/);
});

test('AC8: every change kind the diff can emit is one the note knows how to describe', () => {
  // The pair that would otherwise drift: a new kind added to `diffInterfaces` with no sentence in
  // `renderChange` turns into an AC8 refusal on a real push, which is safe but is a red run nobody
  // asked for. This asserts the pair rather than trusting it.
  const pairs = [
    [FULL, FULL.replace('    secrets:', '      x:\n        type: string\n    secrets:')],
    [FULL, FULL.replace('    secrets:', '      x:\n        type: string\n        default: "1"\n    secrets:')],
    [FULL.replace('    secrets:', '      x:\n        type: string\n    secrets:'), FULL],
    [FULL, FULL.replace('        default: false', '        default: true')],
    [FULL, FULL.replace('        type: boolean\n        default: false', '        type: string\n        default: false')],
    [FULL, FULL.replace('        type: boolean\n        default: false', '        type: boolean\n        required: true')],
    [FULL.replace('        type: boolean\n        default: false', '        type: boolean\n        required: true'), FULL],
    [FULL, FULL.replace('      NPM_TOKEN:', '      NEW_TOKEN:\n        required: true\n      NPM_TOKEN:')],
    [FULL.replace('      NPM_TOKEN:', '      NEW_TOKEN:\n        required: true\n      NPM_TOKEN:'), FULL],
    [FULL, FULL.replace('      DOCS_REPO_DISPATCH_TOKEN:\n        required: false', '      DOCS_REPO_DISPATCH_TOKEN:\n        required: true')],
    [FULL, FULL.replace('  id-token: write', '  id-token: write\n  actions: read')],
    [FULL, FULL.replace('      security-events: write', '      security-events: write\n      actions: read')],
    [FULL, `${FULL}  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n`],
    [`${FULL}  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n`, FULL],
    [FULL, FULL.replace('  actionlint:\n    runs-on:', '  actionlint:\n    name: Lint the workflows\n    runs-on:')],
  ];
  const kinds = new Set();
  for (const [before, after] of pairs) {
    for (const change of diffInterfaces(iface(before), iface(after))) {
      kinds.add(change.kind);
      const note = composeNote({
        reference: `workflows-${DATE}-${COMMIT_B.slice(0, 12)}`,
        commit: COMMIT_B,
        previous: { reference: 'workflows-2026-08-01-a1b2c3d4e5f6', commit: COMMIT_A },
        changes: [change],
        files: {},
      });
      assert.equal(note.ok, true, `${change.kind} must be describable: ${note.ok ? '' : note.reason}`);
    }
  }
  assert.ok(kinds.size >= 12, `expected the pairs to exercise the kinds, saw ${JSON.stringify([...kinds])}`);
  assert.ok(kinds.has('workflow-added') === false, 'workflow-added comes from decide, not from the diff');
});

test('the note carries the reference, the commit and what @main costs a caller', () => {
  const verdict = decide(facts({ current: snapshot(six({ 'ci.yml': FULL })), previous: null }));
  assert.match(verdict.note, new RegExp(verdict.reference));
  assert.match(verdict.note, new RegExp(COMMIT_B));
  assert.match(verdict.note, /A reference at `@main` delivers every later change to your pipeline on this repository's clock/);
});

// ===============================================================================================
// The publish, and every way it can fail without reporting a reference (AC9, AC10)
// ===============================================================================================

const READY = {
  action: 'publish',
  reference: `workflows-${DATE}-${COMMIT_B.slice(0, 12)}`,
  commit: COMMIT_B,
  note: 'a note with real bytes in it',
};

function harness(handler) {
  const calls = [];
  const written = [];
  return {
    calls,
    written,
    io: {
      repository: 'cosyte/.github',
      writeNote: async (note) => {
        written.push(note);
        return '/tmp/note.md';
      },
      run: async (command, args) => {
        calls.push([command, ...args].join(' '));
        return handler(command, args) ?? { ok: true, status: 0, stdout: '', stderr: '' };
      },
    },
  };
}

const OK_RELEASE = JSON.stringify({ tagName: READY.reference, body: 'a note with real bytes in it' });

test('the happy path creates the reference and its note in ONE call, then reads both back', async () => {
  const { io, calls, written } = harness((command, args) => {
    if (args[0] === 'release' && args[1] === 'view') return { ok: true, status: 0, stdout: OK_RELEASE, stderr: '' };
    if (args[0] === 'api') return { ok: true, status: 0, stdout: `${COMMIT_B}\n`, stderr: '' };
    return { ok: true, status: 0, stdout: '', stderr: '' };
  });
  const outcome = await executePublish(READY, io);
  assert.equal(outcome.published, true);
  assert.equal(outcome.failing, false);
  assert.deepEqual(written, [READY.note]);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /^gh release create workflows-2026-08-29-\w+ --target [0-9a-f]{40} --title workflows-\S+ --notes-file /);
  assert.equal(
    calls.filter((call) => call.includes(' delete') || call.includes('--force')).length,
    0,
    'nothing in a successful publish deletes or forces anything',
  );
});

test('AC8: a note that cannot be written never reaches the create call', async () => {
  const calls = [];
  const outcome = await executePublish(READY, {
    repository: 'cosyte/.github',
    writeNote: async () => {
      throw new Error('EROFS: read-only file system');
    },
    run: async (command, args) => {
      calls.push([command, ...args].join(' '));
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(outcome.published, false);
  assert.equal(outcome.failing, true);
  assert.match(outcome.message, /EROFS/);
  assert.match(outcome.message, /Neither the note nor the reference exists/);
  assert.deepEqual(calls, [], 'nothing was created, so there is no reference without a note');
});

test('AC9: a create that fails fails the run and reports nothing as published', async () => {
  const { io } = harness((command, args) => {
    if (args[1] === 'create') return { ok: false, status: 1, stdout: '', stderr: 'HTTP 422: tag already exists' };
    return { ok: true, status: 0, stdout: '', stderr: '' };
  });
  const outcome = await executePublish(READY, io);
  assert.equal(outcome.published, false);
  assert.equal(outcome.failing, true);
  assert.match(outcome.message, /HTTP 422/);
  assert.match(outcome.message, /nothing was deleted to make room for a retry/);
});

test('AC9: an outcome that cannot be read fails the run, even after a successful create', async () => {
  const { io } = harness((command, args) => {
    if (args[0] === 'release' && args[1] === 'view') return { ok: false, status: 1, stdout: '', stderr: 'connection reset' };
    return { ok: true, status: 0, stdout: '', stderr: '' };
  });
  const outcome = await executePublish(READY, io);
  assert.equal(outcome.published, false);
  assert.equal(outcome.failing, true);
  assert.match(outcome.title, /outcome of the publish could not be read/i);
  assert.match(outcome.message, /this run cannot say what exists/);
  assert.match(outcome.message, /Nothing is reported as published/);
});

test('AC9: an outcome that is not JSON is an unread outcome, not an empty one', async () => {
  const { io } = harness((command, args) => {
    if (args[0] === 'release' && args[1] === 'view') return { ok: true, status: 0, stdout: '<html>rate limited</html>', stderr: '' };
    return { ok: true, status: 0, stdout: '', stderr: '' };
  });
  const outcome = await executePublish(READY, io);
  assert.equal(outcome.published, false);
  assert.equal(outcome.failing, true);
  assert.match(outcome.message, /not JSON/);
});

test('AC8 and AC9: a release read back without its note is not reported as published', async () => {
  const { io } = harness((command, args) => {
    if (args[0] === 'release' && args[1] === 'view') {
      return { ok: true, status: 0, stdout: JSON.stringify({ tagName: READY.reference, body: '   ' }), stderr: '' };
    }
    return { ok: true, status: 0, stdout: '', stderr: '' };
  });
  const outcome = await executePublish(READY, io);
  assert.equal(outcome.published, false);
  assert.match(outcome.message, /without its note/);
});

test('AC9: a tag that does not name the commit this run published is left alone and fails', async () => {
  const { io, calls } = harness((command, args) => {
    if (args[0] === 'release' && args[1] === 'view') return { ok: true, status: 0, stdout: OK_RELEASE, stderr: '' };
    if (args[0] === 'api') return { ok: true, status: 0, stdout: `${COMMIT_A}\n`, stderr: '' };
    return { ok: true, status: 0, stdout: '', stderr: '' };
  });
  const outcome = await executePublish(READY, io);
  assert.equal(outcome.published, false);
  assert.equal(outcome.failing, true);
  assert.match(outcome.message, /never re-points a published reference/);
  assert.equal(calls.length, 3, 'and it does not go on to try to fix it');
});

test('AC9: a commit that cannot be read back fails rather than reporting success', async () => {
  const { io } = harness((command, args) => {
    if (args[0] === 'release' && args[1] === 'view') return { ok: true, status: 0, stdout: OK_RELEASE, stderr: '' };
    if (args[0] === 'api') return { ok: false, status: 1, stdout: '', stderr: 'HTTP 502' };
    return { ok: true, status: 0, stdout: '', stderr: '' };
  });
  const outcome = await executePublish(READY, io);
  assert.equal(outcome.published, false);
  assert.match(outcome.message, /HTTP 502/);
});

test('AC10: a denied permission is named, rather than reported as a generic failure', async () => {
  for (const stderr of [
    'HTTP 403: Resource not accessible by integration',
    'gh: 403 Forbidden',
    'error: permission_denied',
  ]) {
    const { io } = harness((command, args) => {
      if (args[1] === 'create') return { ok: false, status: 1, stdout: '', stderr };
      return { ok: true, status: 0, stdout: '', stderr: '' };
    });
    const outcome = await executePublish(READY, io);
    assert.equal(outcome.published, false);
    assert.equal(outcome.failing, true);
    assert.match(outcome.message, /contents: write/, `${stderr} should name the permission`);
    assert.match(outcome.title, /denied the permission/);
  }
});

test('AC10: an ordinary failure is not dressed up as a permission problem', () => {
  assert.equal(deniedPermission('HTTP 403: Resource not accessible by integration'), 'contents: write');
  assert.equal(deniedPermission('HTTP 422: validation failed'), null);
  assert.equal(deniedPermission('connection reset by peer'), null);
  assert.equal(deniedPermission(undefined), null);
});

test('AC9: a run that does not know its repository publishes nothing', async () => {
  const calls = [];
  const outcome = await executePublish(READY, {
    repository: '',
    writeNote: async () => '/tmp/note.md',
    run: async (command, args) => {
      calls.push(args.join(' '));
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(outcome.published, false);
  assert.deepEqual(calls, []);
});

// ===============================================================================================
// End to end over a real repository, with GitHub faked and git real
// ===============================================================================================

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'reference-publish-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  return { dir, run };
}

function writeFile(dir, relative, contents) {
  mkdirSync(dirname(join(dir, relative)), { recursive: true });
  writeFileSync(join(dir, relative), contents);
}

/**
 * Commit at a stated instant.
 *
 * Every commit in these fixtures gets its OWN date, because the script picks the most recently
 * published reference by creation date and two commits in the same second would otherwise leave the
 * fixture, not the code, deciding which one that is.
 */
function commitAt(dir, message, date) {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', message], {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

function makePipelineRepo(date = '2026-06-01T12:00:00+00:00') {
  const { dir, run } = makeRepo();
  for (const name of REUSABLE_WORKFLOWS) writeFile(dir, `.github/workflows/${name}`, minimal(name));
  writeFile(dir, 'scripts/tool.mjs', 'export const version = 1;\n');
  writeFile(dir, 'README.md', 'not part of the state a caller resolves\n');
  commitAt(dir, 'the pipeline', date);
  return { dir, run };
}

/** `main`, with `git` real and every `gh` call answered from the fixture. */
async function runMain(dir, { releases = [], onCreate, extraArgv = [] } = {}) {
  let out = '';
  let err = '';
  const calls = [];
  const notes = [];
  const env = { ...process.env };
  for (const key of ['GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_SHA', 'GITHUB_REPOSITORY']) delete env[key];
  const status = await main(['--repo', dir, '--repository', 'cosyte/.github', ...extraArgv], {
    env,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    writeNote: async (note) => {
      notes.push(note);
      return join(dir, 'note.md');
    },
    run: async (command, args, options) => {
      if (command !== 'gh') return runCommand(command, args, options);
      calls.push(args.join(' '));
      if (args[0] === 'release' && args[1] === 'list') {
        return { ok: true, status: 0, stdout: JSON.stringify(releases.map((tagName) => ({ tagName }))), stderr: '' };
      }
      if (args[0] === 'release' && args[1] === 'create') {
        return onCreate ? onCreate(args) : { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'release' && args[1] === 'view') {
        return { ok: true, status: 0, stdout: JSON.stringify({ tagName: args[2], body: notes[0] ?? '' }), stderr: '' };
      }
      if (args[0] === 'api') {
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        return { ok: true, status: 0, stdout: `${sha}\n`, stderr: '' };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  return { status, out, err, calls, notes };
}

const referenceFor = (dir, ref = 'HEAD') => {
  const sha = execFileSync('git', ['rev-parse', ref], { cwd: dir, encoding: 'utf8' }).trim();
  const date = execFileSync('git', ['show', '--no-patch', '--format=%cd', '--date=format:%Y-%m-%d', sha], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  return { sha, reference: `workflows-${date}-${sha.slice(0, 12)}` };
};

test('AC1 end to end: a fresh pipeline publishes its first reference, at this commit', async () => {
  const { dir } = makePipelineRepo();
  const { reference, sha } = referenceFor(dir);
  const result = await runMain(dir);
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, new RegExp(`action: publish`));
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /no earlier reference to compare this one against/);
  assert.ok(
    result.calls.some((call) => call === `release create ${reference} --target ${sha} --title ${reference} --notes-file ${join(dir, 'note.md')}`),
    `expected a create call for ${reference}, saw ${JSON.stringify(result.calls)}`,
  );
});

test('AC6 end to end: the same state on the next run publishes nothing', async () => {
  const { dir, run } = makePipelineRepo();
  const { reference } = referenceFor(dir);
  run('tag', reference);
  const result = await runMain(dir, { releases: [reference] });
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /action: none/);
  assert.equal(result.notes.length, 0);
  assert.equal(result.calls.some((call) => call.startsWith('release create')), false);
});

test('a hand-made tag under the same prefix is not a reference, and never becomes the baseline', async () => {
  // `refs/tags/workflows-*` is a glob; a REFERENCE is a name this path minted, and only names of the
  // form `workflows-YYYY-MM-DD-<12 hex>` are that. Somebody's `workflows-old`, sitting on a state
  // this path never published, would otherwise be the thing a caller is compared against, and when
  // the six do not parse there it would refuse on every later push until a human deleted a tag.
  const { dir, run } = makePipelineRepo();
  writeFile(dir, '.github/workflows/ci.yml', 'this is not a workflow at all\n');
  commitAt(dir, 'a state nobody published', '2026-06-02T12:00:00+00:00');
  run('tag', 'workflows-old');
  writeFile(dir, '.github/workflows/ci.yml', minimal('ci.yml'));
  commitAt(dir, 'a readable pipeline again', '2026-06-03T12:00:00+00:00');
  const { reference } = referenceFor(dir);

  const result = await runMain(dir);
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /action: publish/);
  assert.match(result.notes[0], /no earlier reference to compare this one against/, 'the hand-made tag is not a baseline');
  assert.ok(result.calls.some((call) => call.startsWith(`release create ${reference} `)));
  assert.equal(
    result.calls.some((call) => call.includes('workflows-old')),
    false,
    'it is left strictly alone: not compared against, not moved, not deleted',
  );
  assert.equal(run('tag', '--list', 'workflows-old').trim(), 'workflows-old', 'and it still exists afterwards');
});

test('AC1 end to end: a script-only change is a new state and gets a new reference', async () => {
  const { dir, run } = makePipelineRepo();
  const first = referenceFor(dir);
  run('tag', first.reference);
  writeFile(dir, 'scripts/tool.mjs', 'export const version = 2;\n');
  commitAt(dir, 'fix the tool', '2026-07-01T12:00:00+00:00');
  const second = referenceFor(dir);
  assert.notEqual(second.reference, first.reference);

  const result = await runMain(dir, { releases: [first.reference] });
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /action: publish/);
  assert.match(result.notes[0], /scripts\/tool\.mjs/);
  assert.ok(result.calls.some((call) => call.startsWith(`release create ${second.reference} `)));
  assert.equal(
    result.calls.some((call) => call.includes(first.reference)),
    false,
    'the earlier reference is never named by a later publish',
  );
});

test('AC6 end to end: a change to a file no caller resolves publishes nothing', async () => {
  const { dir, run } = makePipelineRepo();
  const first = referenceFor(dir);
  run('tag', first.reference);
  writeFile(dir, 'README.md', 'rewritten prose\n');
  commitAt(dir, 'docs', '2026-07-01T12:00:00+00:00');
  const result = await runMain(dir, { releases: [first.reference] });
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /action: none/);
});

test('AC7 end to end: an unreadable workflow reds the run and names it', async () => {
  const { dir } = makePipelineRepo();
  writeFile(dir, '.github/workflows/codeql.yml', minimal('codeql.yml').replace('    inputs:', '    outputs:'));
  commitAt(dir, 'break it', '2026-07-01T12:00:00+00:00');
  const result = await runMain(dir);
  assert.equal(result.status, 1);
  assert.match(result.err, /codeql\.yml/);
  assert.match(result.err, /outputs:/);
  assert.equal(result.calls.some((call) => call.startsWith('release create')), false);
});

test('AC9: a shallow checkout cannot see the tags it compares against, so it refuses', async () => {
  const { dir } = makePipelineRepo();
  const shallow = mkdtempSync(join(tmpdir(), 'reference-publish-shallow-'));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow], { stdio: 'pipe' });
  const result = await runMain(shallow);
  assert.equal(result.status, 1);
  assert.match(result.err, /shallow/);
  assert.equal(result.calls.some((call) => call.startsWith('release create')), false);
});

test('AC9: a published release this checkout cannot see refuses rather than minting a duplicate', async () => {
  const { dir } = makePipelineRepo();
  const result = await runMain(dir, { releases: ['workflows-2026-01-01-0123456789ab'] });
  assert.equal(result.status, 1);
  assert.match(result.err, /workflows-2026-01-01-0123456789ab/);
  assert.match(result.err, /absent from this checkout's tags/);
});

test('AC4 end to end: an existing name reds the run and no create is attempted', async () => {
  // The realistic collision, built rather than asserted: the name this commit would publish is
  // already taken by an OLDER tag someone made by hand, while the reference this run compares
  // against is a different, newer one. A path that answered this by deleting or re-pointing would
  // turn every pinned caller's reference into a moving one.
  const { dir, run } = makePipelineRepo('2026-05-01T12:00:00+00:00');
  const oldest = referenceFor(dir);

  writeFile(dir, 'scripts/tool.mjs', 'export const version = 2;\n');
  commitAt(dir, 'the reference this run compares against', '2026-06-01T12:00:00+00:00');
  const previous = referenceFor(dir);
  run('tag', previous.reference);

  writeFile(dir, 'scripts/tool.mjs', 'export const version = 3;\n');
  commitAt(dir, 'the commit this run would publish', '2026-07-01T12:00:00+00:00');
  const wanted = referenceFor(dir);
  // The name it wants, already taken, pointing at the OLDEST commit so it is never chosen as the
  // reference to compare against.
  run('tag', wanted.reference, oldest.sha);

  const result = await runMain(dir, { releases: [previous.reference, wanted.reference] });
  assert.equal(result.status, 1);
  assert.match(result.err, new RegExp(wanted.reference));
  assert.match(result.err, /NOT deleted, NOT force updated and NOT pointed at another commit/);
  assert.equal(result.calls.some((call) => call.startsWith('release create')), false);
});

test('AC9 end to end: a create that fails reds the run', async () => {
  const { dir } = makePipelineRepo();
  const result = await runMain(dir, {
    onCreate: () => ({ ok: false, status: 1, stdout: '', stderr: 'HTTP 500: internal error' }),
  });
  assert.equal(result.status, 1);
  assert.match(result.err, /HTTP 500/);
});

test('AC10 end to end: a denied create names the permission and reds the run', async () => {
  const { dir } = makePipelineRepo();
  const result = await runMain(dir, {
    onCreate: () => ({ ok: false, status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration' }),
  });
  assert.equal(result.status, 1);
  assert.match(result.err, /contents: write/);
});

test('--dry-run decides everything and publishes nothing', async () => {
  const { dir } = makePipelineRepo();
  const result = await runMain(dir, { extraArgv: ['--dry-run'] });
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /--dry-run: nothing was published/);
  assert.equal(result.calls.some((call) => call.startsWith('release create')), false);
});

test('gatherState reads the state out of the object database, not the working tree', async () => {
  const { dir, run } = makePipelineRepo();
  writeFile(dir, 'scripts/untracked.mjs', 'never committed\n');
  writeFile(dir, 'scripts/tool.mjs', 'edited but not committed\n');
  const git = (args) => runCommand('git', args, { cwd: dir });
  const gathered = await gatherState('HEAD', git);
  assert.equal(gathered.ok, true);
  const paths = gathered.state.files.map((file) => file.path);
  assert.equal(paths.includes('scripts/untracked.mjs'), false);
  assert.equal(paths.includes('README.md'), false, 'README is not state a caller resolves');
  assert.equal(
    gathered.state.files.find((file) => file.path === 'scripts/tool.mjs').digest,
    digestOf('export const version = 1;\n'),
    'the digest is the committed bytes',
  );
  run('status', '--short');
});

// ===============================================================================================
// The workflow that runs this, asserted against the file (AC1, Constraints 2 and 5)
// ===============================================================================================

const PUBLISH_WORKFLOW_PATH = resolve(REPO, '.github/workflows/publish-reference.yml');
const PUBLISH_WORKFLOW = execFileSync('cat', [PUBLISH_WORKFLOW_PATH], { encoding: 'utf8' });
const PUBLISH_LINES = PUBLISH_WORKFLOW.split('\n');
const operative = PUBLISH_LINES.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));

test('the publishing workflow runs on a push to the default branch and is NOT a reusable', () => {
  assert.ok(operative.some((line) => /^ {2}push:$/.test(line)));
  assert.ok(operative.some((line) => /^ {4}branches: \[main\]$/.test(line)));
  assert.equal(
    operative.some((line) => /workflow_call/.test(line)),
    false,
    'a workflow_call trigger here would offer contents: write to thirteen callers',
  );
});

test('the publishing workflow grants contents: write on the job and nothing wider', () => {
  assert.ok(operative.some((line) => /^permissions:$/.test(line)));
  assert.ok(operative.some((line) => /^ {2}contents: read$/.test(line)), 'the workflow default stays read');
  assert.ok(operative.some((line) => /^ {6}contents: write$/.test(line)), 'the job that publishes asks for write');
  assert.equal(operative.filter((line) => /contents: write/.test(line)).length, 1);
});

test('Constraint 5: no deciding step in the publishing workflow can degrade quietly', () => {
  for (const line of operative) {
    assert.doesNotMatch(line, /continue-on-error/);
    assert.doesNotMatch(line, /\|\| true/);
  }
  assert.ok(operative.some((line) => /set -euo pipefail/.test(line)));
});

test('Constraint 2: it adds no third-party action, and reuses the SHAs already pinned in this tree', () => {
  const uses = operative.filter((line) => line.includes('uses:')).map((line) => line.trim().replace(/^- /, ''));
  assert.deepEqual(uses, [
    'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
  ]);
  const selfCheck = execFileSync('cat', [resolve(REPO, '.github/workflows/self-check.yml')], { encoding: 'utf8' });
  for (const line of uses) assert.ok(selfCheck.includes(line.replace('uses: ', '')), `${line} is already pinned here`);
});

test('the checkout fetches the history and the tags this decision depends on', () => {
  assert.ok(operative.some((line) => /fetch-depth: 0/.test(line)));
  assert.ok(operative.some((line) => /fetch-tags: true/.test(line)));
});

test('it runs the script with the automatic token and never interpolates a context into the shell', () => {
  assert.ok(operative.some((line) => /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/.test(line)));
  assert.ok(operative.some((line) => /COMMIT_SHA: \$\{\{ github\.sha \}\}/.test(line)));
  const runLine = operative.find((line) => line.includes('reference-publish.mjs'));
  assert.ok(runLine);
  assert.doesNotMatch(runLine, /\$\{\{/, 'the commit reaches the shell through the environment, never inline');
});

test('a serialized publish, because two pushes must not decide against the same reference at once', () => {
  assert.ok(operative.some((line) => /^concurrency:$/.test(line)));
  assert.ok(operative.some((line) => /cancel-in-progress: false/.test(line)));
});
