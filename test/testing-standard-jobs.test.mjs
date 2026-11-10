// The shared jobs for the testing standard: the coverage ratchet and the mutation run over a pull
// request's changed files, as two opt-in jobs of `ci.yml`, and two new reusables, the nightly deep
// property run (`nightly-properties.yml`) and the weekly full mutation run (`weekly-mutation.yml`).
// The standard itself, its floor file and its tools (`cosyte-ratchet` in `@cosyte/script-utils`,
// `cosyte-mutate` in `@cosyte/vitest-config`, the property runners in `@cosyte/test-utils`) live in
// cosyte/config, documentation/decisions/0004-the-testing-standard.md.
//
// WHAT THIS FILE CAN PROVE AND WHAT IT CANNOT. It reads the workflow files and runs every shell
// script whose logic is ours against a stub `pnpm` that records what it was asked to run: the
// arguments each job hands the two tools, the base ref it names, the job summary it writes, and the
// exit status it ends with. `self-check.yml` then runs all four jobs on a real runner against
// `test/fixtures/ci-caller/`, whose `cosyte-mutate` and `cosyte-ratchet` are the stand-ins in
// `test/fixtures/quality-stubs/`. What neither can prove is that the real tools pass a real caller:
// they are not on npm yet, and no caller's floor file exists yet. A caller learns that the first time
// it turns an input on.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { REUSABLE_WORKFLOWS } from '../scripts/reference-publish.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(REPO, relative), 'utf8');
const CI = read('.github/workflows/ci.yml');
const SELF_CHECK = read('.github/workflows/self-check.yml');
const NIGHTLY_FILE = '.github/workflows/nightly-properties.yml';
const WEEKLY_FILE = '.github/workflows/weekly-mutation.yml';
const NIGHTLY = existsSync(join(REPO, NIGHTLY_FILE)) ? read(NIGHTLY_FILE) : '';
const WEEKLY = existsSync(join(REPO, WEEKLY_FILE)) ? read(WEEKLY_FILE) : '';

const indentOf = (line) => /^ */.exec(line)[0].length;

/** The lines of the block `header` opens in `text`, comment-only lines dropped. */
function block(text, header) {
  const lines = text.split('\n');
  const at = lines.indexOf(header);
  assert.notEqual(at, -1, `no line reads exactly ${JSON.stringify(header)}`);
  const base = indentOf(header);
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line) <= base) break;
    out.push(line);
  }
  return out;
}

/** The job ids directly under `jobs:`. */
function jobIds(text) {
  return block(text, 'jobs:')
    .filter((line) => /^ {2}[a-z][\w-]*:$/.test(line))
    .map((line) => line.trim().slice(0, -1));
}

/** The input names under `workflow_call.inputs`, in file order. */
function inputNames(text) {
  return block(text, '    inputs:')
    .filter((line) => /^ {6}[a-z][\w-]*:$/.test(line))
    .map((line) => line.trim().slice(0, -1));
}

/** One input's `description`, `type`, `default` and `required`, as written. */
function inputOf(text, name) {
  const body = block(text, `      ${name}:`);
  const value = (key) => body.find((line) => line.startsWith(`        ${key}: `))?.slice(10 + key.length);
  return { description: value('description'), type: value('type'), default: value('default'), required: value('required') };
}

/** A job's steps, one string each, with the step's own lines joined. */
function steps(text, job) {
  const body = block(text, `  ${job}:`);
  const at = body.indexOf('    steps:');
  assert.notEqual(at, -1, `${job} has no steps`);
  const out = [];
  for (const line of body.slice(at + 1)) {
    if (/^ {6}- /.test(line)) out.push(line);
    else out[out.length - 1] += `\n${line}`;
  }
  return out;
}

/** The job-level keys of a job, as their lines. */
function jobKeys(text, job) {
  return block(text, `  ${job}:`).filter((line) => indentOf(line) === 4);
}

/** The step named `name` in `job`. */
function stepNamed(text, job, name) {
  const step = steps(text, job).find((entry) => entry.startsWith(`      - name: ${name}\n`));
  assert.ok(step, `${job} has no step named ${JSON.stringify(name)}`);
  return step;
}

/** The `run: |` body of the step named `name` in `job`, dedented to what bash receives. */
function runScript(text, job, name) {
  const lines = stepNamed(text, job, name).split('\n');
  const at = lines.indexOf('        run: |');
  assert.notEqual(at, -1, `${name} has no run: | block`);
  return `${lines.slice(at + 1).map((line) => line.slice(10)).join('\n')}\n`;
}

const BASH = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();

/** An executable shell script at `path`. */
function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * Run one step's script with a stub `pnpm` first on PATH. The stub records each call's arguments,
 * prints a line a report would hold, and exits with `pnpmExit`. Returns the run, the calls, the job
 * summary it wrote and the directory it ran in.
 */
function runStep(text, job, name, { env = {}, pnpmExit = 0, cwd: given } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'testing-standard-'));
  const bin = join(root, 'bin');
  const temp = join(root, 'runner-temp');
  const cwd = given ?? join(root, 'work');
  for (const dir of [bin, temp, cwd]) mkdirSync(dir, { recursive: true });
  const calls = join(root, 'calls');
  executable(join(bin, 'pnpm'), [`echo "$*" >> '${calls}'`, 'echo "stub report for: $*"', `exit ${pnpmExit}`].join('\n'));
  const summary = join(root, 'summary.md');
  const result = spawnSync(BASH, ['-c', runScript(text, job, name)], {
    cwd,
    env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary, ...env },
    encoding: 'utf8',
  });
  return {
    ...result,
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
    summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
    root,
    temp,
    cwd,
  };
}

/** The pinned setup every new job starts with, in order: checkout, pnpm, Node. */
const PNPM_FROM_THE_PACKAGE =
  "      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9\n        with:\n          package_json_file: ${{ inputs.working-directory == '.' && 'package.json' || format('{0}/package.json', inputs.working-directory) }}";
const NODE_WITH_THE_CACHE = (version) =>
  `      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: ${version}\n          cache: pnpm\n          cache-dependency-path: \${{ inputs.working-directory != '.' && format('{0}/pnpm-lock.yaml', inputs.working-directory) || '' }}`;
const CHECKOUT_WITH_HISTORY =
  '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          fetch-depth: 0\n          persist-credentials: false';
const CHECKOUT =
  '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false';
const UPLOAD = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2';

// ---------------------------------------------------------------------------
// ci.yml: THE TWO OPT-IN JOBS A PULL REQUEST RUNS
// ---------------------------------------------------------------------------

test('ci.yml takes two new inputs, after every existing one, and both are off by default', () => {
  const names = inputNames(CI);
  assert.deepEqual(names.slice(-2), ['run-coverage-ratchet', 'run-mutation']);
  assert.deepEqual(inputOf(CI, 'run-coverage-ratchet'), {
    description: '"Hold coverage to quality-floor.json with cosyte-ratchet, in the coverage-ratchet job."',
    type: 'boolean',
    default: 'false',
    required: undefined,
  });
  assert.deepEqual(inputOf(CI, 'run-mutation'), {
    description: '"On a pull request, mutate the changed files and judge their mutants, in the mutation job."',
    type: 'boolean',
    default: 'false',
    required: undefined,
  });
});

test('ci.yml adds coverage-ratchet and mutation after the existing jobs, each behind its own input', () => {
  assert.deepEqual(jobIds(CI), ['verify', 'prepublish', 'actionlint', 'bun', 'deno', 'coverage-ratchet', 'mutation']);
  assert.deepEqual(jobKeys(CI, 'coverage-ratchet').slice(0, 3), [
    '    if: ${{ inputs.run-coverage-ratchet }}',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
  ]);
  // ONLY ON A PULL REQUEST: a changed-files run needs a base to diff against, and a push has none.
  assert.deepEqual(jobKeys(CI, 'mutation').slice(0, 3), [
    "    if: ${{ inputs.run-mutation && github.event_name == 'pull_request' }}",
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 60',
  ]);
  // Beside verify, never after it: a `needs:` would make the pull request wait for both in turn, and
  // a failed verify would skip them, which satisfies a required context (README.md, "What a skipped
  // required context does to a merge").
  assert.equal(CI.split('\n').some((line) => /^ {4}needs:/.test(line)), false);
});

test('each new ci.yml job checks out the history a merge base needs, then installs what verify installs', () => {
  for (const job of ['coverage-ratchet', 'mutation']) {
    const list = steps(CI, job);
    assert.deepEqual(list.slice(0, 4), [
      CHECKOUT_WITH_HISTORY,
      PNPM_FROM_THE_PACKAGE,
      NODE_WITH_THE_CACHE('${{ fromJSON(inputs.node-versions)[0] }}'),
      '      - run: pnpm install --frozen-lockfile',
    ], `${job}'s setup steps`);
    assert.ok(list.every((step) => !step.includes('continue-on-error')), `${job} swallows no failure`);
    assert.deepEqual(block(CI, `  ${job}:`).slice(3, 6), [
      '    defaults:',
      '      run:',
      '        working-directory: ${{ inputs.working-directory }}',
    ]);
  }
  // The coverage report the ratchet reads is written by the caller's own coverage run, first.
  assert.equal(steps(CI, 'coverage-ratchet')[4], '      - run: pnpm test:coverage');
});

test('the coverage ratchet on a pull request: check, skip mutation, against the base branch', () => {
  const run = runStep(CI, 'coverage-ratchet', 'The coverage ratchet', { env: { BASE_REF: 'main' } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls, ['exec cosyte-ratchet check --skip mutation --base origin/main']);
  assert.match(run.stdout, /^stub report for: exec cosyte-ratchet check --skip mutation --base origin\/main$/m);
  assert.match(run.summary, /^### Coverage against the floor$/m);
  assert.match(run.summary, /^```text\nstub report for: exec cosyte-ratchet check --skip mutation --base origin\/main\n```$/m);
});

test('the coverage ratchet on a push: no base, so it compares the measurements with the floor file alone', () => {
  const run = runStep(CI, 'coverage-ratchet', 'The coverage ratchet', { env: { BASE_REF: '' } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls, ['exec cosyte-ratchet check --skip mutation']);
});

test('the coverage ratchet ends with the ratchet\'s own exit status, after writing the summary', () => {
  for (const exit of [1, 2]) {
    const run = runStep(CI, 'coverage-ratchet', 'The coverage ratchet', { env: { BASE_REF: 'main' }, pnpmExit: exit });
    assert.equal(run.status, exit, `exit ${exit}`);
    assert.match(run.summary, /stub report for: exec cosyte-ratchet check/, 'a red run still says why on its page');
  }
});

test('the mutation job mutates the changed files against the base branch, then judges their mutants', () => {
  const names = steps(CI, 'mutation').map((step) => /^ {6}- name: (.*)$/m.exec(step)?.[1] ?? step.split('\n')[0].trim());
  assert.deepEqual(names.slice(4), ['Mutate the changed files', 'The mutation ratchet over the changed code', 'Keep the mutation report']);

  const mutate = runStep(CI, 'mutation', 'Mutate the changed files', { env: { BASE_REF: 'main' } });
  assert.equal(mutate.status, 0, mutate.stderr);
  assert.deepEqual(mutate.calls, ['exec cosyte-mutate changed --base origin/main']);

  const judge = runStep(CI, 'mutation', 'The mutation ratchet over the changed code', { env: { BASE_REF: 'main' } });
  assert.equal(judge.status, 0, judge.stderr);
  assert.deepEqual(judge.calls, ['exec cosyte-ratchet check --skip coverage --base origin/main']);
  assert.match(judge.summary, /^### Mutants in the changed code$/m);
  assert.match(judge.summary, /stub report for: exec cosyte-ratchet check --skip coverage --base origin\/main/);
});

test('the mutation job refuses to run with no base branch, rather than mutating nothing and passing', () => {
  for (const name of ['Mutate the changed files', 'The mutation ratchet over the changed code']) {
    const run = runStep(CI, 'mutation', name, { env: { BASE_REF: '' } });
    assert.equal(run.status, 1, name);
    assert.deepEqual(run.calls, [], `${name} must never start a tool`);
    assert.match(run.stdout, /^::error::the mutation job judges a pull request's changed files, and this run has no base branch$/m);
  }
});

test('the mutation job fails when either tool fails, and keeps its report either way', () => {
  for (const exit of [1, 2]) {
    assert.equal(runStep(CI, 'mutation', 'Mutate the changed files', { env: { BASE_REF: 'main' }, pnpmExit: exit }).status, exit);
    const judge = runStep(CI, 'mutation', 'The mutation ratchet over the changed code', { env: { BASE_REF: 'main' }, pnpmExit: exit });
    assert.equal(judge.status, exit);
    assert.match(judge.summary, /stub report for/);
  }
  const keep = stepNamed(CI, 'mutation', 'Keep the mutation report');
  assert.equal(
    keep,
    [
      '      - name: Keep the mutation report',
      '        if: ${{ !cancelled() }}',
      `        uses: ${UPLOAD}`,
      '        with:',
      '          name: mutation-changed',
      '          path: ${{ inputs.working-directory }}/reports/mutation/',
      '          if-no-files-found: warn',
      '          retention-days: 14',
    ].join('\n'),
  );
});

test('every multi-line script in the new jobs names bash and stops on an unset variable', () => {
  for (const [text, job] of [[CI, 'coverage-ratchet'], [CI, 'mutation'], [NIGHTLY, 'properties'], [WEEKLY, 'mutation']]) {
    for (const step of steps(text, job).filter((entry) => entry.includes('run: |'))) {
      assert.match(step, /^ {8}shell: bash$/m, `${job}: ${step.split('\n')[0].trim()}`);
      assert.match(step, /^ {10}set -euo pipefail$/m, `${job}: ${step.split('\n')[0].trim()}`);
    }
  }
});

// ---------------------------------------------------------------------------
// nightly-properties.yml: THE DEEP PROPERTY RUN, WITH ITS SEEDS KEPT
// ---------------------------------------------------------------------------

test('nightly-properties.yml is a published reusable with one job, properties, and inputs a caller can leave alone', () => {
  assert.ok(NIGHTLY !== '', `${NIGHTLY_FILE} is missing`);
  assert.ok(REUSABLE_WORKFLOWS.includes('nightly-properties.yml'), 'a reference must carry it');
  assert.deepEqual(jobIds(NIGHTLY), ['properties']);
  assert.deepEqual(inputNames(NIGHTLY), ['test-cmd', 'property-runs', 'node-version', 'working-directory']);
  assert.deepEqual(inputOf(NIGHTLY, 'test-cmd'), { description: '"The command that runs the test suite."', type: 'string', default: '"pnpm test"', required: undefined });
  assert.deepEqual(inputOf(NIGHTLY, 'property-runs'), {
    description: '"Cases a property, set as COSYTE_PROPERTY_RUNS for the whole run."',
    type: 'string',
    default: '"10000"',
    required: undefined,
  });
  assert.deepEqual(inputOf(NIGHTLY, 'node-version'), { description: '"The Node version the job runs on."', type: 'string', default: '"22"', required: undefined });
  assert.deepEqual(inputOf(NIGHTLY, 'working-directory'), {
    description: '"The directory holding package.json, relative to the repository root."',
    type: 'string',
    default: '"."',
    required: undefined,
  });
  assert.deepEqual(block(NIGHTLY, 'permissions:'), ['  contents: read']);
  assert.deepEqual(jobKeys(NIGHTLY, 'properties').slice(0, 3), ['    runs-on: ubuntu-latest', '    timeout-minutes: 60', '    defaults:']);
  assert.deepEqual(steps(NIGHTLY, 'properties').slice(0, 4), [
    CHECKOUT,
    PNPM_FROM_THE_PACKAGE,
    NODE_WITH_THE_CACHE('${{ inputs.node-version }}'),
    '      - run: pnpm install --frozen-lockfile',
  ]);
});

const SUITE = 'The test suite at the nightly property depth';
const RECORD = 'Record the replay seeds';

test('the nightly suite runs the caller\'s command with COSYTE_PROPERTY_RUNS set, and keeps its log', () => {
  const step = stepNamed(NIGHTLY, 'properties', SUITE);
  assert.match(step, /^ {8}id: suite$/m);
  assert.match(step, /^ {10}COSYTE_PROPERTY_RUNS: \$\{\{ inputs\.property-runs \}\}$/m);
  assert.match(step, /^ {10}TEST_CMD: \$\{\{ inputs\.test-cmd \}\}$/m);
  const run = runStep(NIGHTLY, 'properties', SUITE, {
    env: { COSYTE_PROPERTY_RUNS: '10000', TEST_CMD: 'echo "depth $COSYTE_PROPERTY_RUNS"; echo to-stderr >&2' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^properties: COSYTE_PROPERTY_RUNS=10000$/m);
  assert.equal(readFileSync(join(run.temp, 'property-run', 'test.log'), 'utf8'), 'depth 10000\nto-stderr\n');
});

test('the nightly suite fails when the suite fails, with the log still written', () => {
  const run = runStep(NIGHTLY, 'properties', SUITE, { env: { COSYTE_PROPERTY_RUNS: '10000', TEST_CMD: 'echo partial; exit 3' } });
  assert.equal(run.status, 3);
  assert.equal(readFileSync(join(run.temp, 'property-run', 'test.log'), 'utf8'), 'partial\n');
});

test('the nightly suite refuses a depth that is not a whole number of cases, and runs nothing', () => {
  for (const value of ['', 'abc', '0', '10e3', '-5', '10000 ']) {
    const run = runStep(NIGHTLY, 'properties', SUITE, { env: { COSYTE_PROPERTY_RUNS: value, TEST_CMD: 'echo ran' } });
    assert.equal(run.status, 2, JSON.stringify(value));
    assert.doesNotMatch(run.stdout, /^ran$/m, `${JSON.stringify(value)} must not start the suite`);
    assert.match(run.stdout, /^::error::property-runs must be a whole number of cases/m);
  }
});

/** What the property runners print on a failure, as vitest shows it with colour on. */
const ESC = '\u001b';
const FAILED_LOG = [
  ` ${ESC}[32m✓${ESC}[39m test/parse.test.ts (40 tests) 812ms`,
  ` ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m test/properties.test.ts > hl7 > round trip`,
  `${ESC}[31mError: round trip: property failed after 52 case(s), shrunk 4 time(s).${ESC}[39m`,
  `${ESC}[31mReplay exactly: COSYTE_PROPERTY_SEED=791784642 COSYTE_PROPERTY_PATH=51:1:0:0:6${ESC}[39m`,
  '(or pass { seed: 791784642, path: "51:1:0:0:6" } to the runner)',
  ` ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m test/properties.test.ts > hl7 > never throws in lenient mode`,
  'Error: never throws in lenient mode: property failed after 9001 case(s), shrunk 11 time(s).',
  'Replay exactly: COSYTE_PROPERTY_SEED=-1702 COSYTE_PROPERTY_PATH=9000:3',
  // The same failure printed a second time, as a reporter's summary does: recorded once.
  ` ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m test/properties.test.ts > hl7 > round trip`,
  'Error: round trip: property failed after 52 case(s), shrunk 4 time(s).',
  'Replay exactly: COSYTE_PROPERTY_SEED=791784642 COSYTE_PROPERTY_PATH=51:1:0:0:6',
  ' Test Files  1 failed | 1 passed (2)',
  '',
].join('\n');

/** Run the record step over `log` (or no log at all), as the suite step left it. */
function record(log, suite) {
  const root = mkdtempSync(join(tmpdir(), 'testing-standard-record-'));
  const temp = join(root, 'runner-temp');
  mkdirSync(join(temp, 'property-run'), { recursive: true });
  if (log !== null) writeFileSync(join(temp, 'property-run', 'test.log'), log);
  const summary = join(root, 'summary.md');
  const result = spawnSync(BASH, ['-c', runScript(NIGHTLY, 'properties', RECORD)], {
    cwd: root,
    env: { PATH: process.env.PATH, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary, PROPERTY_RUNS: '10000', SUITE: suite, TEST_CMD: 'pnpm test' },
    encoding: 'utf8',
  });
  const seeds = join(temp, 'property-run', 'seeds.txt');
  return {
    ...result,
    summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
    seeds: existsSync(seeds) ? readFileSync(seeds, 'utf8') : null,
  };
}

test('the record step keeps every printed seed once, with its test and its property, colour stripped', () => {
  const step = stepNamed(NIGHTLY, 'properties', RECORD);
  assert.match(step, /^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m, 'a failed suite is exactly when the seeds matter');
  assert.match(step, /^ {10}SUITE: \$\{\{ steps\.suite\.outcome \}\}$/m);
  const run = record(FAILED_LOG, 'failure');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    run.seeds,
    [
      'Nightly property run at COSYTE_PROPERTY_RUNS=10000: 2 replay seed(s).',
      '',
      'test/properties.test.ts > hl7 > round trip',
      '  round trip: property failed after 52 case(s), shrunk 4 time(s).',
      '  replay: COSYTE_PROPERTY_SEED=791784642 COSYTE_PROPERTY_PATH=51:1:0:0:6',
      '',
      'test/properties.test.ts > hl7 > never throws in lenient mode',
      '  never throws in lenient mode: property failed after 9001 case(s), shrunk 11 time(s).',
      '  replay: COSYTE_PROPERTY_SEED=-1702 COSYTE_PROPERTY_PATH=9000:3',
      '',
    ].join('\n'),
  );
  assert.match(run.summary, /^### Nightly property run$/m);
  assert.match(run.summary, /^Depth: `COSYTE_PROPERTY_RUNS=10000` cases a property\. The suite: failure\.$/m);
  assert.match(run.summary, /^2 property failure\(s\) printed a replay seed\./m);
  assert.match(run.summary, /^- test\/properties\.test\.ts > hl7 > round trip: round trip: property failed after 52 case\(s\), shrunk 4 time\(s\)\.\n {2}`COSYTE_PROPERTY_SEED=791784642 COSYTE_PROPERTY_PATH=51:1:0:0:6`$/m);
  assert.match(run.summary, /`COSYTE_PROPERTY_SEED=-1702 COSYTE_PROPERTY_PATH=9000:3`/);
  assert.match(run.summary, /The full log and `seeds\.txt` are in the `property-run` artifact\./);
  assert.doesNotMatch(run.summary + run.seeds, new RegExp(ESC), 'no escape code reaches the page or the file');
});

test('the record step says so when no property failed, and when the suite failed for another reason', () => {
  const passed = record(' Test Files  2 passed (2)\n', 'success');
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.seeds, 'Nightly property run at COSYTE_PROPERTY_RUNS=10000: 0 replay seed(s).\n');
  assert.match(passed.summary, /^No property failed, so no replay seed was printed\.$/m);

  const other = record(' Test Files  1 failed (1)\n', 'failure');
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.summary, /^No property printed a replay seed, so the suite failed for another reason: the log is in the `property-run` artifact\.$/m);
});

test('the record step names a replay line it cannot place, rather than dropping it', () => {
  const run = record('Replay exactly: COSYTE_PROPERTY_SEED=5 COSYTE_PROPERTY_PATH=1\n', 'failure');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.seeds, /^\(no test name in the log\)\n {2}\(no property line in the log\)\n {2}replay: COSYTE_PROPERTY_SEED=5 COSYTE_PROPERTY_PATH=1$/m);
});

test('the record step, when the suite never ran, says so and leaves the job to the step that failed', () => {
  const run = record(null, 'skipped');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.seeds, null);
  assert.match(run.summary, /^The suite did not run \(its step was skipped\), so no property printed a seed\.$/m);
});

test('the nightly run keeps the log and the seeds as an artifact, whatever the suite did', () => {
  assert.equal(
    stepNamed(NIGHTLY, 'properties', 'Keep the log and the seeds'),
    [
      '      - name: Keep the log and the seeds',
      '        if: ${{ !cancelled() }}',
      `        uses: ${UPLOAD}`,
      '        with:',
      '          name: property-run',
      '          path: ${{ runner.temp }}/property-run/',
      '          if-no-files-found: warn',
      '          retention-days: 30',
    ].join('\n'),
  );
  // The job's verdict is the suite's: nothing after it can turn a failed run green.
  assert.ok(steps(NIGHTLY, 'properties').every((step) => !step.includes('continue-on-error')));
});

// ---------------------------------------------------------------------------
// weekly-mutation.yml: THE FULL RUN, REPORTED AGAINST THE FLOOR, NEVER COMMITTED
// ---------------------------------------------------------------------------

test('weekly-mutation.yml is a published reusable with one job, mutation, that can only read', () => {
  assert.ok(WEEKLY !== '', `${WEEKLY_FILE} is missing`);
  assert.ok(REUSABLE_WORKFLOWS.includes('weekly-mutation.yml'), 'a reference must carry it');
  assert.deepEqual(jobIds(WEEKLY), ['mutation']);
  assert.deepEqual(inputNames(WEEKLY), ['mutate-cmd', 'node-version', 'working-directory']);
  assert.deepEqual(inputOf(WEEKLY, 'mutate-cmd'), {
    description: '"The command that runs the full mutation run."',
    type: 'string',
    default: '"pnpm exec cosyte-mutate full"',
    required: undefined,
  });
  assert.deepEqual(inputOf(WEEKLY, 'node-version'), { description: '"The Node version the job runs on."', type: 'string', default: '"22"', required: undefined });
  assert.deepEqual(inputOf(WEEKLY, 'working-directory'), {
    description: '"The directory holding package.json and quality-floor.json, relative to the repository root."',
    type: 'string',
    default: '"."',
    required: undefined,
  });
  // IT NEVER COMMITS: read-only contents, no credential kept by the checkout, and no command that
  // writes to the repository. Raising a floor is a pull request a person or an agent opens.
  assert.deepEqual(block(WEEKLY, 'permissions:'), ['  contents: read']);
  assert.ok(!/permissions:/.test(block(WEEKLY, '  mutation:').join('\n')), 'the job widens no permission');
  const code = WEEKLY.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  for (const forbidden of [/\bgit (?:commit|push)\b/, /^\s*(?:pnpm exec )?cosyte-ratchet raise/m, /contents: write/]) {
    assert.doesNotMatch(code, forbidden);
  }
  assert.deepEqual(jobKeys(WEEKLY, 'mutation').slice(0, 3), ['    runs-on: ubuntu-latest', '    timeout-minutes: 180', '    defaults:']);
  assert.deepEqual(steps(WEEKLY, 'mutation').slice(0, 4), [
    CHECKOUT,
    PNPM_FROM_THE_PACKAGE,
    NODE_WITH_THE_CACHE('${{ inputs.node-version }}'),
    '      - run: pnpm install --frozen-lockfile',
  ]);
});

const FULL_RUN = 'The full mutation run';
const AGAINST_THE_FLOOR = "Each package's mutation score against its floor";

test('the weekly job runs the caller\'s mutation command, and fails when it fails', () => {
  assert.match(stepNamed(WEEKLY, 'mutation', FULL_RUN), /^ {10}MUTATE_CMD: \$\{\{ inputs\.mutate-cmd \}\}$/m);
  const ok = runStep(WEEKLY, 'mutation', FULL_RUN, { env: { MUTATE_CMD: 'pnpm exec cosyte-mutate full' } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.calls, ['exec cosyte-mutate full']);
  const failed = runStep(WEEKLY, 'mutation', FULL_RUN, { env: { MUTATE_CMD: 'pnpm exec cosyte-mutate full' }, pnpmExit: 2 });
  assert.equal(failed.status, 2);
});

test('the weekly job reports each package against its floor in the summary, and keeps the report', () => {
  const run = runStep(WEEKLY, 'mutation', AGAINST_THE_FLOOR);
  assert.equal(run.status, 0, run.stderr);
  // No --base: the whole score is compared with the floor, and no change is judged.
  assert.deepEqual(run.calls, ['exec cosyte-ratchet check --skip coverage']);
  assert.equal(readFileSync(join(run.cwd, 'reports/mutation/ratchet.txt'), 'utf8'), 'stub report for: exec cosyte-ratchet check --skip coverage\n');
  assert.match(run.summary, /^### Mutation score against the floor$/m);
  assert.match(run.summary, /^```text\nstub report for: exec cosyte-ratchet check --skip coverage\n```$/m);
  assert.match(run.summary, /This run never commits\. To raise a floor to these scores, run `cosyte-ratchet raise --skip coverage` after a full run and open a pull request\./);
  assert.equal(
    stepNamed(WEEKLY, 'mutation', 'Keep the mutation report'),
    [
      '      - name: Keep the mutation report',
      '        if: ${{ !cancelled() }}',
      `        uses: ${UPLOAD}`,
      '        with:',
      '          name: mutation-report',
      '          path: ${{ inputs.working-directory }}/reports/mutation/',
      '          if-no-files-found: warn',
      '          retention-days: 30',
    ].join('\n'),
  );
});

test('a score below its floor turns the weekly run red, with the report on its page', () => {
  for (const exit of [1, 2]) {
    const run = runStep(WEEKLY, 'mutation', AGAINST_THE_FLOOR, { pnpmExit: exit });
    assert.equal(run.status, exit);
    assert.match(run.summary, /stub report for: exec cosyte-ratchet check --skip coverage/);
  }
});

// ---------------------------------------------------------------------------
// THE HEADERS A CALLER COPIES FROM
// ---------------------------------------------------------------------------

test('each new reusable\'s header shows the schedule a caller writes, since a reusable cannot carry one', () => {
  assert.match(NIGHTLY, /^#   on:\n#     schedule: \[\{ cron: "\d+ \d+ \* \* \*" \}\]\n#     workflow_dispatch: \{\}$/m);
  assert.match(NIGHTLY, /^#       uses: cosyte\/\.github\/\.github\/workflows\/nightly-properties\.yml@workflows-YYYY-MM-DD-COMMIT$/m);
  assert.match(WEEKLY, /^#   on:\n#     schedule: \[\{ cron: "\d+ \d+ \* \* \d" \}\]\n#     workflow_dispatch: \{\}$/m);
  assert.match(WEEKLY, /^#       uses: cosyte\/\.github\/\.github\/workflows\/weekly-mutation\.yml@workflows-YYYY-MM-DD-COMMIT$/m);
});

// ---------------------------------------------------------------------------
// THE PROOF: self-check.yml RUNS ALL FOUR AGAINST THE FIXTURE
// ---------------------------------------------------------------------------

test('self-check runs the two ci.yml jobs, the nightly run and the weekly run against the fixture', () => {
  const systems = block(SELF_CHECK, '  systems:');
  assert.ok(systems.includes('      run-coverage-ratchet: true'), 'systems turns the coverage ratchet on');
  assert.ok(systems.includes('      run-mutation: true'), 'systems turns the mutation job on');
  assert.deepEqual(block(SELF_CHECK, '  nightly-properties:'), [
    '    uses: ./.github/workflows/nightly-properties.yml',
    '    with:',
    '      working-directory: test/fixtures/ci-caller',
    '      test-cmd: pnpm run test:properties',
  ]);
  assert.deepEqual(block(SELF_CHECK, '  weekly-mutation:'), [
    '    uses: ./.github/workflows/weekly-mutation.yml',
    '    with:',
    '      working-directory: test/fixtures/ci-caller',
  ]);
  const proof = block(SELF_CHECK, '  quality-artifacts:').join('\n');
  assert.match(proof, /^ {4}needs: \[nightly-properties, weekly-mutation\]$/m);
  assert.match(proof, /actions\/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8\.0\.2/);
  // What the artifacts must hold: the planted seed, at the nightly depth, and the stand-in ratchet's
  // report beside the full run's report.
  assert.match(proof, /grep -F 'Nightly property run at COSYTE_PROPERTY_RUNS=10000: 1 replay seed\(s\)\.'/);
  assert.match(proof, /grep -F 'replay: COSYTE_PROPERTY_SEED=20261110 COSYTE_PROPERTY_PATH=0:1'/);
  assert.match(proof, /test -s "\$\{artifacts\}\/mutation-report\/mutation\.json"/);
  assert.match(proof, /grep -F 'cosyte-ratchet check \(a stand-in\)'/);
});

test('the fixture names the stand-in tools and a floor file, so every new job has something to run', () => {
  const fixture = join(REPO, 'test/fixtures/ci-caller');
  const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
  assert.equal(manifest.devDependencies['cosyte-quality-stubs'], 'link:../quality-stubs');
  assert.equal(manifest.scripts['test:coverage'], 'node tool.mjs coverage');
  assert.equal(manifest.scripts['test:properties'], 'node tool.mjs properties');
  assert.match(readFileSync(join(fixture, 'pnpm-lock.yaml'), 'utf8'), /cosyte-quality-stubs:\n {8}specifier: link:\.\.\/quality-stubs\n {8}version: link:\.\.\/quality-stubs/);
  const floor = JSON.parse(readFileSync(join(fixture, 'quality-floor.json'), 'utf8'));
  assert.deepEqual(Object.keys(floor.packages), ['.']);
  const stubs = JSON.parse(readFileSync(join(REPO, 'test/fixtures/quality-stubs/package.json'), 'utf8'));
  assert.deepEqual(stubs.bin, { 'cosyte-mutate': 'cosyte-mutate.mjs', 'cosyte-ratchet': 'cosyte-ratchet.mjs' });
});
