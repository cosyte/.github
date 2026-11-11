// The pull request title check, `pr-title.yml`, and the titles this repository's own automation
// writes.
//
// WHAT IS ASSERTED, AND WHY BY RUNNING IT. The rule is one bash step, and which titles it lets
// through is a property of what bash does with the pattern, not of the pattern's text. So the step's
// `run:` body is extracted the way the runner reads it and executed with the shell options the runner
// uses, once per title, and every refused title is one a looser pattern would let through: a dropped
// anchor, a case-insensitive type, an unbounded scope, or a missing space.
//
// AND THE TITLES WE WRITE OURSELVES MUST PASS IT. `release.yml` opens the "Version Packages" pull
// request in every caller and Dependabot opens pull requests here, so a check that refused either
// would block a release or an action bump the day a caller required it. Both titles are read out of
// the files that set them and run through the same step.

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

const WORKFLOW = 'pr-title.yml';
const SELF_CALLER = 'self-pr-title.yml';
const JOB = 'conventional-commits';
const STEP = 'Check the pull request title';

const read = (relative) => readFileSync(join(REPO, relative), 'utf8');
const indentOf = (line) => line.length - line.replace(/^ */, '').length;

/**
 * The `run: |` block of the step labelled `stepName`, dedented to what the runner hands to bash.
 * The same reading `test/gate-workflows.test.mjs` makes, and for the same reason: the shared reader
 * folds a body onto one line, which is right for matching and wrong for executing.
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

const SCRIPT = runScript(read(join(WORKFLOWS, WORKFLOW)), STEP);

/** Run the step the way a `shell: bash` step runs on a hosted runner, for one title and one event. */
function check(title, event = 'pull_request', script = SCRIPT) {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, PR_TITLE: title, EVENT_NAME: event },
  });
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------
// The rule, by running it
// ---------------------------------------------------------------------------

const ACCEPTED = [
  'feat(title-check): add a pull request title check',
  'fix(parser): keep the escape sequence in OBX-5',
  'docs(security): cover every library and Pathways',
  'feat(runtime)!: require Node 22 or later',
  'refactor(reader)!: one fail-closed reader',
  'chore(deps): bump actions/checkout from 7.0.1 to 7.1.0',
  'chore(deps-dev): bump vite from 7.3.6 to 7.3.7',
  // Dependabot's capitalised spelling: the description is free text.
  'chore(deps): Bump actions/setup-node from 7.0.0 to 7.1.0',
  'chore(release): version packages',
  'ci(self-check): run Self-check nightly',
  'build(pnpm): pin pnpm 10.34.5',
  'test(release): cover the dependency-skip route',
  'perf(parser): read each segment once',
  'revert(title-check): feat: add a pull request title check',
  'style(readme): wrap the README at 100 columns',
  'fix(release-notes): cut a phase phrase whole',
  'fix(ci.yml): fetch the checker at job.workflow_sha',
  'fix(hl7/v2): keep the repetition separator',
  'fix(phi_scan): name the rule, never the value',
];

const REFUSED = [
  ['no scope', 'fix: keep the escape sequence in OBX-5'],
  ['no scope, with the breaking mark', 'feat!: require Node 22 or later'],
  ['no scope, a Dependabot-shaped title with the scope dropped', 'chore: bump actions/checkout from 7.0.1 to 7.1.0'],
  ['no type at all', 'Add a pull request title check'],
  ["the changesets default, which `release.yml` no longer sends", 'Version Packages'],
  ["GitHub's revert button", 'Revert "feat(title-check): add a pull request title check"'],
  ['a capitalised type', 'Feat: add a pull request title check'],
  ['an upper-case type', 'FIX: keep the escape sequence'],
  ['a type that is not on the list', 'feature: add a pull request title check'],
  ['another type that is not on the list', 'wip: still going'],
  ['no space after the colon', 'feat(title-check):add a pull request title check'],
  ['a description that starts with a space', 'feat(title-check):  two spaces'],
  ['an empty description', 'feat(title-check): '],
  ['nothing after the colon', 'feat(title-check):'],
  ['an empty scope', 'feat(): add a check'],
  ['an upper-case scope', 'feat(Parser): add a check'],
  ['a scope outside ASCII', 'fix(pärser): keep the escape'],
  ['a scope that starts with a hyphen', 'fix(-parser): keep the escape'],
  ['a leading scope-like word is not a scope', 'fix parser: keep the escape'],
  ['a space before the colon', 'feat(parser) : add a check'],
  ['a space before the scope', 'feat (parser): add a check'],
  ['the breaking mark before the scope', 'feat!(parser): add a check'],
  ['a leading space', ' feat: add a check'],
  ['an empty title', ''],
];

for (const title of ACCEPTED) {
  test(`accepted: ${JSON.stringify(title)}`, () => {
    const run = check(title);
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /follows Conventional Commits/);
  });
}

for (const [why, title] of REFUSED) {
  test(`refused, ${why}: ${JSON.stringify(title)}`, () => {
    const run = check(title);
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /^::error title=Pull request title::The title does not follow Conventional Commits/m);
    assert.match(run.output, /feat, fix, docs, chore, ci, build, refactor, test, perf, revert, or style/);
  });
}

test('every type the rule names is accepted, and the list is exactly the one it prints', () => {
  const types = ['feat', 'fix', 'docs', 'chore', 'ci', 'build', 'refactor', 'test', 'perf', 'revert', 'style'];
  for (const type of types) {
    assert.equal(check(`${type}(scope): a description`).code, 0, `${type} with a scope`);
    assert.equal(check(`${type}: a description`).code, 1, `${type} without a scope`);
  }
  const pattern = /pattern='\^\(([^)]*)\)/.exec(SCRIPT);
  assert.notEqual(pattern, null, 'the pattern is not where this test expects it');
  assert.deepEqual(pattern[1].split('|'), types);
});

test('an event with no pull request fails and says why, rather than passing over nothing', () => {
  for (const event of ['push', 'merge_group', 'workflow_dispatch', 'schedule']) {
    const run = check('feat(title-check): a title that would pass', event);
    assert.equal(run.code, 1, `${event}: ${run.output}`);
    assert.match(run.output, /^::error title=No pull request title::/m);
    assert.match(run.output, new RegExp(`a ${event} event has none`));
  }
  assert.equal(check('feat(title-check): a title that would pass', 'pull_request_target').code, 0);
});

test('a title is printed after a fixed prefix, so it can never start a workflow command', () => {
  const run = check('::add-mask::something');
  assert.equal(run.code, 1);
  for (const line of run.output.split('\n').filter((entry) => entry.startsWith('::'))) {
    assert.match(line, /^::error title=Pull request title::/, `the title reached the start of a line: ${line}`);
  }
  assert.match(run.output, /^The title is: ::add-mask::something$/m);
});

test('a mutated rule is caught: without its anchor, a revert button title would pass', () => {
  const loosened = SCRIPT.replace("pattern='^(", () => "pattern='(");
  assert.notEqual(loosened, SCRIPT, 'the mutation changed nothing, so it proves nothing');
  assert.equal(check('Revert "feat(title-check): add a pull request title check"', 'pull_request', loosened).code, 0);
  assert.equal(check('Revert "feat(title-check): add a pull request title check"').code, 1);
});

// ---------------------------------------------------------------------------
// The shape: one requirable job, no action, nothing interpolated into the shell
// ---------------------------------------------------------------------------

test('one job, with no condition, no dependency and no swallow, so it is safe to require', () => {
  const flow = parseWorkflow(read(join(WORKFLOWS, WORKFLOW)));
  assert.deepEqual(flow.jobs.map((job) => job.id), [JOB]);
  const [job] = flow.jobs;
  for (const key of ['if', 'needs', 'continue-on-error', 'strategy']) {
    assert.equal(job.keys[key], undefined, `the job carries \`${key}:\``);
  }
  assert.equal(job.keys['timeout-minutes'], '5');
  assert.equal(job.steps.length, 1, 'one step');
  const [step] = job.steps;
  assert.equal(step.fields.uses, undefined, 'the step runs no action');
  assert.equal(step.fields.if, undefined, 'the step carries no condition');
  assert.equal(step.fields['continue-on-error'], undefined);
  assert.equal(step.fields.shell, 'bash');
  assert.equal(step.env.PR_TITLE, '${{ github.event.pull_request.title }}');
  assert.equal(step.env.EVENT_NAME, '${{ github.event_name }}');
});

test('the title reaches the shell through `env:` only, never interpolated into the script', () => {
  assert.doesNotMatch(SCRIPT, /\$\{\{/, 'an expression inside `run:` is interpolated before the shell sees it');
  assert.doesNotMatch(SCRIPT, /\|\|\s*true/);
  assert.match(SCRIPT, /^set -euo pipefail$/m);
  assert.match(SCRIPT, /^export LC_ALL=C$/m, 'a range in a bracket expression is a locale question without it');
});

test('the workflow uses no action at all, so there is no pin to keep', () => {
  const text = read(join(WORKFLOWS, WORKFLOW));
  const uses = text.split('\n').filter((line) => /^\s*-?\s*uses:/.test(line));
  assert.deepEqual(uses, []);
});

test('this repository runs the check on its own pull requests, title edits included', () => {
  const text = read(join(WORKFLOWS, SELF_CALLER));
  assert.match(text, /^ {4}uses: \.\/\.github\/workflows\/pr-title\.yml$/m);
  assert.match(text, /^ {4}types: \[opened, synchronize, reopened, edited\]$/m);
  assert.doesNotMatch(text, /^\s*if:/m);
});

// ---------------------------------------------------------------------------
// The titles this repository's own automation writes
// ---------------------------------------------------------------------------

const unquote = (value) => value.replace(/^"(.*)"$/, '$1');

test('both changesets steps in `release.yml` title the Version Packages pull request so it passes', () => {
  const flow = parseWorkflow(read(join(WORKFLOWS, 'release.yml')));
  const steps = flow.jobs.flatMap((job) => job.steps.filter((step) => /^changesets\/action@/.test(step.fields.uses ?? '')));
  assert.equal(steps.length, 2, 'the version arm and the publish arm');
  for (const step of steps) {
    const title = unquote(step.with.title ?? '');
    const commit = unquote(step.with.commit ?? '');
    assert.equal(title, 'chore(release): version packages', `${step.job}: the pull request title`);
    assert.equal(commit, title, `${step.job}: the version commit matches the title that squash-merges over it`);
    assert.equal(check(title).code, 0, `${step.job}: the check refuses the title release.yml writes`);
  }
});

test('Dependabot titles its pull requests here in a form the check accepts', () => {
  const text = read('.github/dependabot.yml');
  assert.match(text, /^ {6}prefix: chore$/m);
  assert.match(text, /^ {6}include: scope$/m);
  // What Dependabot composes from that prefix and `include: scope` for a GitHub Actions bump.
  assert.equal(check('chore(deps): bump actions/checkout from 7.0.1 to 7.1.0').code, 0);
});
