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
const PROBE_STEP = 'Check that cosyte-mutate can shard';
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
  // The performance standard's four inputs follow them: `test/performance-jobs.test.mjs` owns those.
  assert.deepEqual(names.slice(-6, -4), ['run-coverage-ratchet', 'run-mutation']);
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
  assert.deepEqual(jobIds(CI), ['verify', 'prepublish', 'actionlint', 'bun', 'deno', 'coverage-ratchet', 'mutation', 'scaling-gate', 'bench-compare']);
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
  for (const [text, job] of [[CI, 'coverage-ratchet'], [CI, 'mutation'], [NIGHTLY, 'properties'], [WEEKLY, 'shard'], [WEEKLY, 'mutation']]) {
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
// weekly-mutation.yml: THE FULL RUN, SHARDED AND INCREMENTAL, REPORTED AGAINST THE FLOOR, NEVER COMMITTED
// ---------------------------------------------------------------------------

test('weekly-mutation.yml is a published reusable with two jobs, shard and mutation, that can only read', () => {
  assert.ok(WEEKLY !== '', `${WEEKLY_FILE} is missing`);
  assert.ok(REUSABLE_WORKFLOWS.includes('weekly-mutation.yml'), 'a reference must carry it');
  // `mutation` keeps its id, so a caller's check context does not move.
  assert.deepEqual(jobIds(WEEKLY), ['shard', 'mutation']);
  assert.deepEqual(inputNames(WEEKLY), ['mutate-cmd', 'shard-count', 'node-version', 'working-directory', 'report-name']);
  assert.deepEqual(inputOf(WEEKLY, 'mutate-cmd'), {
    description: '"The command that runs the full mutation run."',
    type: 'string',
    default: '"pnpm exec cosyte-mutate full"',
    required: undefined,
  });
  assert.deepEqual(inputOf(WEEKLY, 'shard-count'), { description: '"How many parallel jobs share the mutants, 1 to 16."', type: 'number', default: '8', required: undefined });
  assert.deepEqual(inputOf(WEEKLY, 'node-version'), { description: '"The Node version the job runs on."', type: 'string', default: '"22"', required: undefined });
  assert.deepEqual(inputOf(WEEKLY, 'working-directory'), {
    description: '"The directory holding package.json and quality-floor.json, relative to the repository root."',
    type: 'string',
    default: '"."',
    required: undefined,
  });
  assert.deepEqual(inputOf(WEEKLY, 'report-name'), { description: '"The artifact name of the merged mutation report."', type: 'string', default: '"mutation-report"', required: undefined });
  // IT NEVER COMMITS: read-only contents, no credential kept by the checkout, and no command that
  // writes to the repository. Raising a floor is a pull request a person or an agent opens.
  assert.deepEqual(block(WEEKLY, 'permissions:'), ['  contents: read']);
  for (const job of ['shard', 'mutation']) assert.ok(!/permissions:/.test(block(WEEKLY, `  ${job}:`).join('\n')), `${job} widens no permission`);
  const code = WEEKLY.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  for (const forbidden of [/\bgit (?:commit|push)\b/, /^\s*(?:pnpm exec )?cosyte-ratchet raise/m, /contents: write/]) {
    assert.doesNotMatch(code, forbidden);
  }
  assert.deepEqual(steps(WEEKLY, 'shard').slice(0, 4), [
    CHECKOUT,
    PNPM_FROM_THE_PACKAGE,
    NODE_WITH_THE_CACHE('${{ inputs.node-version }}'),
    '      - run: pnpm install --frozen-lockfile',
  ]);
  // The probe comes straight after the install, before the cache and the run.
  assert.match(steps(WEEKLY, 'shard')[4], new RegExp(`^ {6}- name: ${PROBE_STEP}\n`));
});

test('the shards are a matrix of 1 to shard-count, every shard runs to its end, and each fits a hosted job', () => {
  const keys = jobKeys(WEEKLY, 'shard');
  assert.deepEqual(keys.slice(0, 2), ['    strategy:', '    runs-on: ubuntu-latest']);
  const strategy = block(WEEKLY, '    strategy:');
  assert.equal(strategy[0], '      fail-fast: false');
  const table = /^ {8}shard: \$\{\{ fromJSON\('(.*)'\)\[format\('\{0\}', inputs\.shard-count\)\] \}\}$/.exec(strategy[2]);
  assert.ok(table, strategy[2]);
  const lists = JSON.parse(table[1]);
  assert.deepEqual(Object.keys(lists), Array.from({ length: 16 }, (_v, i) => String(i + 1)));
  for (const [count, list] of Object.entries(lists)) assert.deepEqual(list, Array.from({ length: Number(count) }, (_v, i) => i + 1), count);
  // GitHub ends a job on a hosted runner at 6 hours; the bound is the workflow's own, below it.
  const timeout = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(block(WEEKLY, '  shard:').join('\n'))[1]);
  assert.ok(timeout < 360 && timeout >= 300, `${timeout}`);
});

const AGAINST_THE_FLOOR = "Each package's mutation score against its floor";
const SHARD_STEP = 'Mutate this shard';
const SHARD_ENV = { SHARD: '2', SHARD_COUNT: '3', INCREMENTAL_FILE: 'reports/mutation/incremental.json', RESTORED_FROM: '' };
/** A mutate command that records what it was handed and writes what a sharding cosyte-mutate writes. */
const WRITES_A_SHARD =
  'pnpm exec cosyte-mutate full; printf "%s|%s|%s\\n" "$COSYTE_MUTATE_SHARD" "$COSYTE_MUTATE_INCREMENTAL_FILE" "$(cat reports/mutation/incremental.json 2>/dev/null || echo none)" > seen.txt; ' +
  'mkdir -p reports/mutation packages/a/reports/mutation; echo "{}" > reports/mutation/shard-2-of-3.json; echo "{}" > packages/a/reports/mutation/shard-2-of-3.json; ' +
  'echo new > reports/mutation/incremental.json; echo "{}" > reports/mutation/mutation.json';

test('a shard hands the tool its share and its incremental file, and gathers what the tool wrote', () => {
  const step = stepNamed(WEEKLY, 'shard', SHARD_STEP);
  assert.match(step, /^ {10}MUTATE_CMD: \$\{\{ inputs\.mutate-cmd \}\}$/m);
  assert.match(block(WEEKLY, '  shard:').join('\n'), /^ {6}SHARD: \$\{\{ matrix\.shard \}\}\n {6}SHARD_COUNT: \$\{\{ inputs\.shard-count \}\}\n {6}INCREMENTAL_FILE: reports\/mutation\/incremental\.json$/m);
  const run = runStep(WEEKLY, 'shard', SHARD_STEP, { env: { ...SHARD_ENV, MUTATE_CMD: WRITES_A_SHARD } });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.deepEqual(run.calls, ['exec cosyte-mutate full']);
  assert.equal(readFileSync(join(run.cwd, 'seen.txt'), 'utf8'), '2/3|reports/mutation/incremental.json|none\n');
  const stage = join(run.temp, 'mutation-shard');
  assert.ok(existsSync(join(stage, 'reports/mutation/shard-2-of-3.json')));
  assert.ok(existsSync(join(stage, 'packages/a/reports/mutation/shard-2-of-3.json')));
  assert.equal(existsSync(join(stage, 'reports/mutation/mutation.json')), false, 'a full report is never merged');
  assert.equal(readFileSync(join(stage, 'shard-2-of-3.txt'), 'utf8'), 'shard-2-of-3: full, no earlier results for this shard\n');
  assert.equal(readFileSync(join(run.temp, 'mutation-incremental/reports/mutation/incremental.json'), 'utf8'), 'new\n');
  assert.match(run.summary, /^shard-2-of-3: full, no earlier results for this shard\. 2 shard report\(s\) written\.$/m);
});

test('a shard puts the restored incremental results back where the tool reads them, and says it did', () => {
  const root = mkdtempSync(join(tmpdir(), 'weekly-restored-'));
  const temp = join(root, 'runner-temp');
  mkdirSync(join(temp, 'mutation-incremental/reports/mutation'), { recursive: true });
  writeFileSync(join(temp, 'mutation-incremental/reports/mutation/incremental.json'), 'earlier\n');
  const run = runStep(WEEKLY, 'shard', SHARD_STEP, {
    env: { ...SHARD_ENV, RUNNER_TEMP: temp, RESTORED_FROM: 'cosyte-mutation-v1-.-3-2-100-1', MUTATE_CMD: WRITES_A_SHARD },
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(readFileSync(join(run.cwd, 'seen.txt'), 'utf8'), '2/3|reports/mutation/incremental.json|earlier\n');
  assert.equal(
    readFileSync(join(temp, 'mutation-shard/shard-2-of-3.txt'), 'utf8'),
    'shard-2-of-3: incremental, 1 result file(s) restored from cosyte-mutation-v1-.-3-2-100-1\n',
  );
});

test('a shard whose tool wrote no shard report fails and says the tool does not shard; the tool\'s failure is the shard\'s', () => {
  const unsharded = runStep(WEEKLY, 'shard', SHARD_STEP, { env: { ...SHARD_ENV, MUTATE_CMD: 'pnpm exec cosyte-mutate full; mkdir -p reports/mutation; echo "{}" > reports/mutation/mutation.json' } });
  assert.equal(unsharded.status, 1);
  assert.match(unsharded.stdout, /^::error::the mutation command wrote no reports\/mutation\/shard-2-of-3\.json\. Sharding needs a cosyte-mutate that reads COSYTE_MUTATE_SHARD/m);
  assert.match(unsharded.stdout, /@cosyte\/vitest-config 0\.1\.5 or later/);
  const failed = runStep(WEEKLY, 'shard', SHARD_STEP, { env: { ...SHARD_ENV, MUTATE_CMD: 'pnpm exec cosyte-mutate full' }, pnpmExit: 2 });
  assert.equal(failed.status, 2);
});

// ONE SHARD NEEDS NO SHARDING TOOL. With shard-count 1 the tool's own `mutation.json` is the report
// of shard 1 of 1, so a small library adopts with a `cosyte-mutate` that does not shard. A
// `mutation.json` older than the run (one left in the tree) is never read as this run's.
const WRITES_THE_FULL_REPORT = 'pnpm exec cosyte-mutate full; mkdir -p reports/mutation packages/a/reports/mutation; echo "{\\"run\\":1}" > reports/mutation/mutation.json; echo "{}" > packages/a/reports/mutation/mutation.json';
const ONE_SHARD = { ...SHARD_ENV, SHARD: '1', SHARD_COUNT: '1' };

test('with one shard, the mutation.json a tool that does not shard writes is the report of shard 1 of 1', () => {
  const run = runStep(WEEKLY, 'shard', SHARD_STEP, { env: { ...ONE_SHARD, MUTATE_CMD: WRITES_THE_FULL_REPORT } });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const stage = join(run.temp, 'mutation-shard');
  assert.equal(readFileSync(join(stage, 'reports/mutation/shard-1-of-1.json'), 'utf8'), '{"run":1}\n');
  assert.ok(existsSync(join(stage, 'packages/a/reports/mutation/shard-1-of-1.json')));
  assert.equal(existsSync(join(stage, 'reports/mutation/mutation.json')), false);
  assert.equal(
    readFileSync(join(stage, 'shard-1-of-1.txt'), 'utf8'),
    'shard-1-of-1: full, no earlier results for this shard; the tool wrote mutation.json, read as the report of shard 1 of 1\n',
  );
  assert.match(run.summary, /2 shard report\(s\) written\.$/m);
});

test('with one shard, a mutation.json the run did not write is not read, and the shard fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'weekly-stale-'));
  const cwd = join(root, 'work');
  mkdirSync(join(cwd, 'reports/mutation'), { recursive: true });
  writeFileSync(join(cwd, 'reports/mutation/mutation.json'), '{"stale":true}\n');
  const run = runStep(WEEKLY, 'shard', SHARD_STEP, { cwd, env: { ...ONE_SHARD, MUTATE_CMD: 'pnpm exec cosyte-mutate full' } });
  assert.equal(run.status, 1, run.stderr + run.stdout);
  assert.match(run.stdout, /^::error::the mutation command wrote no reports\/mutation\/shard-1-of-1\.json and no new mutation\.json/m);
});

test('with several shards, a mutation.json is never read as a shard report', () => {
  const run = runStep(WEEKLY, 'shard', SHARD_STEP, { env: { ...SHARD_ENV, MUTATE_CMD: WRITES_THE_FULL_REPORT } });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /@cosyte\/vitest-config 0\.1\.5 or later/);
});

// THE PROBE: A RUN OF SEVERAL SHARDS CHECKS, IN SECONDS, THAT ITS TOOL SHARDS. Without it a tool that
// does not shard runs the whole suite on every shard, hours each, and only then fails. The probe runs
// the caller's command as written, once, on a shard no file can be in, so a tool that reads the
// variable writes an empty shard report and stops, and any other is caught before the full run.
const STUB_MUTATE = join(REPO, 'test/fixtures/quality-stubs/cosyte-mutate.mjs');
const EMPTY_SHARD = '8589934592';
const PROBE_REPORT = `reports/mutation/shard-${EMPTY_SHARD}-of-${EMPTY_SHARD}.json`;
// The bound the step sets in its own env, which the first test below reads.
const PROBE_ENV = { SHARD: '2', SHARD_COUNT: '2', CI: 'true', PROBE_SECONDS: '180' };

/** A tool whose help names the shard variable, and which runs everything whatever the variable says. */
function namesButIgnores(dir) {
  const path = join(dir, 'names-but-ignores.mjs');
  writeFileSync(
    path,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "if (process.argv.includes('--help')) {",
      "  process.stdout.write('cosyte-mutate: run StrykerJS with the shared config, over everything or over a change.\\nCOSYTE_MUTATE_SHARD=<k>/<n>\\n');",
      '} else {',
      "  mkdirSync('reports/mutation', { recursive: true });",
      "  writeFileSync('reports/mutation/mutation.json', '{}\\n');",
      '}',
      '',
    ].join('\n'),
  );
  return path;
}

test('the probe runs the mutate command once, on a shard no file can be in, and passes the stand-in that shards', () => {
  const step = stepNamed(WEEKLY, 'shard', PROBE_STEP);
  assert.match(step, /^ {10}MUTATE_CMD: \$\{\{ inputs\.mutate-cmd \}\}$/m);
  assert.match(step, /^ {10}PROBE_SECONDS: 180$/m);
  const seen =runStep(WEEKLY, 'shard', PROBE_STEP, {
    env: {
      ...PROBE_ENV,
      COSYTE_MUTATE_INCREMENTAL_FILE: 'reports/mutation/incremental.json',
      MUTATE_CMD: `pnpm exec cosyte-mutate full; printf '%s|%s\\n' "$COSYTE_MUTATE_SHARD" "\${COSYTE_MUTATE_INCREMENTAL_FILE-unset}" > seen.txt; mkdir -p reports/mutation; echo '{}' > ${PROBE_REPORT}`,
    },
  });
  assert.equal(seen.status, 0, seen.stderr + seen.stdout);
  // One call, the command as written: no `--help`, and the incremental file is not the probe's.
  assert.deepEqual(seen.calls, ['exec cosyte-mutate full']);
  assert.equal(readFileSync(join(seen.cwd, 'seen.txt'), 'utf8'), `${EMPTY_SHARD}/${EMPTY_SHARD}|unset\n`);
  assert.equal(existsSync(join(seen.cwd, PROBE_REPORT)), false, 'the probe leaves no report behind');
  const shards = runStep(WEEKLY, 'shard', PROBE_STEP, { env: { ...PROBE_ENV, MUTATE_CMD: `node '${STUB_MUTATE}' full` } });
  assert.equal(shards.status, 0, shards.stderr + shards.stdout);
  assert.match(shards.stdout, /^cosyte-mutate can shard: /m);
  assert.equal(existsSync(join(shards.cwd, 'reports/mutation/mutation.json')), false);
});

test('the probe never runs a full mutation for a compound mutate command', () => {
  // Before, `--help` went at the end of the line, so only the last command saw it and the first
  // ran everything inside the probe.
  const run = runStep(WEEKLY, 'shard', PROBE_STEP, { env: { ...PROBE_ENV, MUTATE_CMD: `node '${STUB_MUTATE}' full && node '${STUB_MUTATE}' full` } });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(existsSync(join(run.cwd, 'reports/mutation/mutation.json')), false, 'a full run happened inside the probe');
});

test('the probe fails a tool whose help names the shard variable but which ignores it, before the full run', () => {
  const root = mkdtempSync(join(tmpdir(), 'weekly-probe-'));
  const tool = namesButIgnores(root);
  const run = runStep(WEEKLY, 'shard', PROBE_STEP, { env: { ...PROBE_ENV, MUTATE_CMD: `node '${tool}' full` } });
  assert.equal(run.status, 1, run.stderr + run.stdout);
  assert.match(run.stdout, /^::error::the cosyte-mutate this run installed cannot shard: .*wrote reports\/mutation\/mutation\.json/m);
  assert.match(run.stdout, /needs @cosyte\/vitest-config 0\.1\.5 or later; update it, or set shard-count: 1/);
});

test('the probe refuses the stand-in of 0.1.4, alone or as one package of several', () => {
  const old = runStep(WEEKLY, 'shard', PROBE_STEP, { env: { ...PROBE_ENV, MUTATE_CMD: `COSYTE_MUTATE_STUB_AS=0.1.4 node '${STUB_MUTATE}' full` } });
  assert.equal(old.status, 1, old.stderr + old.stdout);
  assert.match(old.stdout, /needs @cosyte\/vitest-config 0\.1\.5 or later/);
  const mixed = runStep(WEEKLY, 'shard', PROBE_STEP, {
    env: { ...PROBE_ENV, MUTATE_CMD: `mkdir -p a b; (cd a && node '${STUB_MUTATE}' full); (cd b && COSYTE_MUTATE_STUB_AS=0.1.4 node '${STUB_MUTATE}' full)` },
  });
  assert.equal(mixed.status, 1, mixed.stderr + mixed.stdout);
  assert.match(mixed.stdout, /b\/reports\/mutation\/mutation\.json/);
});

test('the probe stops a command that does not finish an empty shard in its time, and fails it', () => {
  const started = Date.now();
  const run = runStep(WEEKLY, 'shard', PROBE_STEP, { env: { ...PROBE_ENV, PROBE_SECONDS: '1', MUTATE_CMD: 'sleep 30' } });
  assert.equal(run.status, 1, run.stderr + run.stdout);
  assert.ok(Date.now() - started < 15000, 'the probe waited for the command');
  assert.match(run.stdout, /^::error::the cosyte-mutate this run installed cannot shard: `sleep 30` did not finish a shard that holds no file in 1 seconds/m);
});

test('the probe fails a command that fails, or that writes no shard report', () => {
  const failed = runStep(WEEKLY, 'shard', PROBE_STEP, { env: { ...PROBE_ENV, MUTATE_CMD: 'pnpm exec cosyte-mutate full' }, pnpmExit: 2 });
  assert.equal(failed.status, 1, failed.stderr + failed.stdout);
  assert.match(failed.stdout, /^::error::`pnpm exec cosyte-mutate full` exited 2 on a shard that holds no file/m);
  const silent = runStep(WEEKLY, 'shard', PROBE_STEP, { env: { ...PROBE_ENV, MUTATE_CMD: 'pnpm exec cosyte-mutate full' } });
  assert.equal(silent.status, 1, silent.stderr + silent.stdout);
  assert.match(silent.stdout, /^::error::the cosyte-mutate this run installed cannot shard: `pnpm exec cosyte-mutate full` wrote no reports\/mutation\/shard-8589934592-of-8589934592\.json/m);
});

test('with one shard the probe asks nothing, since any cosyte-mutate will do', () => {
  const run = runStep(WEEKLY, 'shard', PROBE_STEP, { env: { SHARD: '1', SHARD_COUNT: '1', MUTATE_CMD: 'pnpm exec cosyte-mutate full' } });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.deepEqual(run.calls, []);
});

test('the save step says what it does not save: a shard cancelled at its time limit runs no later step', () => {
  const lines = WEEKLY.split('\n');
  const at = lines.indexOf("      - name: Save this shard's incremental results");
  const comment = [];
  for (let i = at - 1; lines[i].trim().startsWith('#'); i -= 1) comment.unshift(lines[i].trim().slice(2));
  const text = comment.join(' ');
  assert.doesNotMatch(text, /ran out of time/);
  assert.match(text, /cancelled/);
  assert.match(text, /saves nothing/);
});

test('a shard refuses a shard or a count it cannot be, before it runs anything', () => {
  for (const [shard, count] of [['1', '0'], ['1', '17'], ['4', '3'], ['0', '3'], ['x', '3'], ['1', '2.5']]) {
    const run = runStep(WEEKLY, 'shard', SHARD_STEP, { env: { ...SHARD_ENV, SHARD: shard, SHARD_COUNT: count, MUTATE_CMD: 'pnpm exec cosyte-mutate full' } });
    assert.equal(run.status, 2, `${shard} of ${count}`);
    assert.deepEqual(run.calls, []);
  }
});

test('each shard restores its own newest results and saves its own, keyed to the run, whatever the run did', () => {
  const key = 'cosyte-mutation-v1-${{ inputs.working-directory }}-${{ inputs.shard-count }}-${{ matrix.shard }}-${{ github.run_id }}-${{ github.run_attempt }}';
  assert.equal(
    stepNamed(WEEKLY, 'shard', "Restore this shard's incremental results"),
    [
      "      - name: Restore this shard's incremental results",
      '        id: incremental',
      '        uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
      '        with:',
      '          path: ${{ runner.temp }}/mutation-incremental',
      `          key: ${key}`,
      '          restore-keys: |',
      '            cosyte-mutation-v1-${{ inputs.working-directory }}-${{ inputs.shard-count }}-${{ matrix.shard }}-',
    ].join('\n'),
  );
  assert.equal(
    stepNamed(WEEKLY, 'shard', "Save this shard's incremental results"),
    [
      "      - name: Save this shard's incremental results",
      '        if: ${{ !cancelled() }}',
      '        uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
      '        with:',
      '          path: ${{ runner.temp }}/mutation-incremental',
      `          key: ${key}`,
    ].join('\n'),
  );
  assert.equal(
    stepNamed(WEEKLY, 'shard', "Keep this shard's report"),
    [
      "      - name: Keep this shard's report",
      '        if: ${{ !cancelled() }}',
      `        uses: ${UPLOAD}`,
      '        with:',
      '          name: ${{ inputs.report-name }}-shard-${{ matrix.shard }}-of-${{ inputs.shard-count }}',
      '          path: ${{ runner.temp }}/mutation-shard/',
      '          if-no-files-found: error',
      '          retention-days: 7',
    ].join('\n'),
  );
});

test('the mutation job runs after every shard, even a failed one, and fails when any shard did not succeed', () => {
  assert.deepEqual(jobKeys(WEEKLY, 'mutation').slice(0, 4), ['    needs: shard', '    if: ${{ !cancelled() }}', '    runs-on: ubuntu-latest', '    timeout-minutes: 30']);
  const gate = 'Every shard must have finished';
  assert.match(stepNamed(WEEKLY, 'mutation', gate), /^ {10}SHARDS: \$\{\{ needs\.shard\.result \}\}$/m);
  assert.equal(runStep(WEEKLY, 'mutation', gate, { env: { SHARDS: 'success' } }).status, 0);
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    const run = runStep(WEEKLY, 'mutation', gate, { env: { SHARDS: result } });
    assert.equal(run.status, 1, result);
    assert.match(run.stdout, /^::error::the shards ended/m);
  }
});

test('the mutation job merges the shards with the tooling at this workflow\'s own commit', () => {
  const list = steps(WEEKLY, 'mutation');
  const names = list.map((step) => /^ {6}- name: (.*)$/m.exec(step)?.[1] ?? step.split('\n')[0].trim());
  assert.deepEqual(names, [
    'Every shard must have finished',
    '- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    'Say which commit the mutation tooling comes from',
    'Check out the shared mutation tooling',
    '- uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9',
    '- uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
    '- run: pnpm install --frozen-lockfile',
    'Collect the shard reports',
    'Merge the shard reports into one report per package',
    AGAINST_THE_FLOOR,
    'Keep the mutation report',
  ]);
  assert.match(stepNamed(WEEKLY, 'mutation', 'Check out the shared mutation tooling'), /^ {10}repository: cosyte\/\.github\n {10}ref: \$\{\{ job\.workflow_sha \}\}\n {10}path: \.cosyte-mutation-tooling\n {10}persist-credentials: false$/m);
  assert.match(stepNamed(WEEKLY, 'mutation', 'Collect the shard reports'), /^ {10}pattern: \$\{\{ inputs\.report-name \}\}-shard-\*-of-\$\{\{ inputs\.shard-count \}\}\n {10}path: \$\{\{ runner\.temp \}\}\/mutation-shards\n {10}merge-multiple: true$/m);
  const merge = runScript(WEEKLY, 'mutation', 'Merge the shard reports into one report per package');
  assert.match(merge, /node "\$\{GITHUB_WORKSPACE\}\/\.cosyte-mutation-tooling\/scripts\/mutation-shards\.mjs" merge \\\n {2}--shards "\$\{RUNNER_TEMP\}\/mutation-shards" --count "\$\{SHARD_COUNT\}" --into \./);
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
      '          name: ${{ inputs.report-name }}',
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
  // Twice a week: a cache entry nobody reads for 7 days is evicted, and a weekly run could miss it.
  assert.match(WEEKLY, /^#   on:\n#     schedule: \[\{ cron: "\d+ \d+ \* \* \d" \}, \{ cron: "\d+ \d+ \* \* \d" \}\]\n#     workflow_dispatch: \{\}$/m);
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
  // A SHARDED RUN, then an INCREMENTAL one: the second call restores the incremental files the
  // first saved, so each of its shards says it started from earlier results.
  assert.deepEqual(block(SELF_CHECK, '  weekly-mutation:'), [
    '    uses: ./.github/workflows/weekly-mutation.yml',
    '    with:',
    '      working-directory: test/fixtures/ci-caller',
    '      shard-count: 2',
  ]);
  assert.deepEqual(block(SELF_CHECK, '  weekly-mutation-incremental:'), [
    '    needs: weekly-mutation',
    '    uses: ./.github/workflows/weekly-mutation.yml',
    '    with:',
    '      working-directory: test/fixtures/ci-caller',
    '      shard-count: 2',
    '      report-name: mutation-report-incremental',
  ]);
  // ONE SHARD, WITH THE STAND-IN OF A RELEASE THAT DOES NOT SHARD: its mutation.json is shard 1 of 1.
  assert.deepEqual(block(SELF_CHECK, '  weekly-mutation-one-shard:'), [
    '    uses: ./.github/workflows/weekly-mutation.yml',
    '    with:',
    '      working-directory: test/fixtures/ci-caller',
    '      shard-count: 1',
    '      mutate-cmd: COSYTE_MUTATE_STUB_AS=0.1.4 pnpm exec cosyte-mutate full',
    '      report-name: mutation-report-one-shard',
  ]);
  const proof = block(SELF_CHECK, '  quality-artifacts:').join('\n');
  assert.match(proof, /^ {4}needs: \[nightly-properties, weekly-mutation, weekly-mutation-incremental, weekly-mutation-one-shard\]$/m);
  assert.match(proof, /test -s "\$\{artifacts\}\/mutation-report-one-shard\/mutation\.json"/);
  assert.match(proof, /grep -F 'read as the report of shard 1 of 1' "\$\{artifacts\}\/mutation-report-one-shard\/shards\.txt"/);
  assert.match(proof, /actions\/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8\.0\.2/);
  // What the artifacts must hold: the planted seed, at the nightly depth, and the stand-in ratchet's
  // report beside the merged report; and, from the second run, an incremental start on every shard.
  assert.match(proof, /grep -F 'Nightly property run at COSYTE_PROPERTY_RUNS=10000: 1 replay seed\(s\)\.'/);
  assert.match(proof, /grep -F 'replay: COSYTE_PROPERTY_SEED=20261110 COSYTE_PROPERTY_PATH=0:1'/);
  assert.match(proof, /test -s "\$\{artifacts\}\/mutation-report\/mutation\.json"/);
  assert.match(proof, /test "\$\(grep -c ': incremental, ' "\$\{artifacts\}\/mutation-report-incremental\/shards\.txt"\)" -eq 2/);
  assert.match(proof, /test "\$\(wc -l < "\$\{artifacts\}\/mutation-report\/shards\.txt"\)" -eq 2/);
  assert.match(proof, /grep -F 'cosyte-ratchet check \(a stand-in\)'/);
});

// ACROSS TWO RUNS, NOT ONLY WITHIN ONE. The second weekly call restores what the first saved in the
// same run; the first call's shards must each have restored an entry an earlier run saved, which the
// run id in the restored key tells apart.
const ACROSS_RUNS = "The first weekly run started from an earlier run's results";

function acrossRuns(notes, { runId = '500', attempt = '1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'across-runs-'));
  const temp = join(root, 'runner-temp');
  mkdirSync(join(temp, 'artifacts/mutation-report'), { recursive: true });
  writeFileSync(join(temp, 'artifacts/mutation-report/shards.txt'), notes);
  return spawnSync(BASH, ['-c', runScript(SELF_CHECK, 'quality-artifacts', ACROSS_RUNS)], {
    cwd: root,
    env: { PATH: process.env.PATH, RUNNER_TEMP: temp, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt },
    encoding: 'utf8',
  });
}

const restoredFrom = (shard, run, attempt) => `shard-${shard}-of-2: incremental, 1 result file(s) restored from cosyte-mutation-v1-test/fixtures/ci-caller-2-${shard}-${run}-${attempt}\n`;

test('self-check proves each shard of its first weekly run restored an earlier run\'s results', () => {
  const ok = acrossRuns(restoredFrom(1, 499, 1) + restoredFrom(2, 400, 2));
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /^shard-1-of-2: restored the results of run 499, attempt 1$/m);
  const sameRun = acrossRuns(restoredFrom(1, 499, 1) + restoredFrom(2, 500, 1));
  assert.equal(sameRun.status, 1);
  assert.match(sameRun.stdout, /^::error::shard-2-of-2 restored results this run saved/m);
  // A re-run's attempt reads what an earlier attempt saved: a separate execution, so it counts.
  assert.equal(acrossRuns(restoredFrom(1, 500, 1) + restoredFrom(2, 500, 1), { attempt: '2' }).status, 0);
  const full = acrossRuns(`${restoredFrom(1, 499, 1)}shard-2-of-2: full, no earlier results for this shard\n`);
  assert.equal(full.status, 1);
  assert.match(full.stdout, /^::error::shard-2-of-2 started from no earlier run's results/m);
  assert.equal(acrossRuns(restoredFrom(1, 499, 1)).status, 1, 'both shards must say so');
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
