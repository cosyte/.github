// The shared jobs for the performance standard: the scaling gate from `@cosyte/test-utils/perf` and
// the base against head timing comparison from `@cosyte/bench`, as two opt-in jobs of `ci.yml`. The
// standard itself and both tools live in cosyte/config,
// documentation/decisions/0005-the-performance-standard.md.
//
// WHAT THIS FILE CAN PROVE AND WHAT IT CANNOT. It reads the workflow files and runs the comparison's
// shell script, the one script here whose logic is ours, against a real git repository and a stub
// `pnpm` that records what it was asked to run: the base it checks out, the builds it makes, the
// arguments it hands `cosyte-bench`, the job summary it writes, and the exit status it ends with,
// which must be 0 whatever the tool says. `self-check.yml` then runs both jobs on a real runner
// against `test/fixtures/ci-caller/`, with the real `@cosyte/bench` and `@cosyte/test-utils`. What
// neither can prove is how noisy a caller's own suite is on a hosted runner: that is the A/A
// calibration the standard asks of each caller before the comparison may become a required check.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(REPO, relative), 'utf8');
const CI = read('.github/workflows/ci.yml');
const SELF_CHECK = read('.github/workflows/self-check.yml');

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

const PNPM_FROM_THE_PACKAGE =
  "      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9\n        with:\n          package_json_file: ${{ inputs.working-directory == '.' && 'package.json' || format('{0}/package.json', inputs.working-directory) }}";
const NODE_WITH_THE_CACHE =
  "      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: ${{ fromJSON(inputs.node-versions)[0] }}\n          cache: pnpm\n          cache-dependency-path: ${{ inputs.working-directory != '.' && format('{0}/pnpm-lock.yaml', inputs.working-directory) || '' }}";
const CHECKOUT_WITH_HISTORY =
  '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          fetch-depth: 0\n          persist-credentials: false';
const CHECKOUT =
  '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false';
const UPLOAD = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2';

const COMPARE = 'Compare the base build with the head build';

// ---------------------------------------------------------------------------
// THE CALLER-VISIBLE SURFACE
// ---------------------------------------------------------------------------

test('ci.yml takes four new inputs, after every existing one, and the two switches are off by default', () => {
  assert.deepEqual(inputNames(CI).slice(-6), ['run-coverage-ratchet', 'run-mutation', 'run-scaling-gate', 'run-bench-compare', 'bench-suites', 'bench-target']);
  assert.deepEqual(inputOf(CI, 'run-scaling-gate'), {
    description: '"Run the test:perf script, the scaling gate from @cosyte/test-utils/perf, in the scaling-gate job."',
    type: 'boolean',
    default: 'false',
    required: undefined,
  });
  assert.deepEqual(inputOf(CI, 'run-bench-compare'), {
    description: '"On a pull request, time the base build against the head build with @cosyte/bench, in the bench-compare job. Advisory: it never fails."',
    type: 'boolean',
    default: 'false',
    required: undefined,
  });
  assert.deepEqual(inputOf(CI, 'bench-suites'), {
    description: '"The suites bench-compare runs, separated by spaces or new lines, relative to working-directory. Empty runs every bench/*.bench.mjs and bench/*.bench.ts."',
    type: 'string',
    default: '""',
    required: undefined,
  });
  assert.deepEqual(inputOf(CI, 'bench-target'), {
    description: '"The built entry bench-compare times on each side, relative to working-directory."',
    type: 'string',
    default: '"dist/index.mjs"',
    required: undefined,
  });
});

test('ci.yml adds scaling-gate and bench-compare after the existing jobs, each behind its own input, beside verify', () => {
  assert.deepEqual(jobIds(CI), ['verify', 'prepublish', 'actionlint', 'bun', 'deno', 'coverage-ratchet', 'mutation', 'scaling-gate', 'bench-compare']);
  assert.deepEqual(jobKeys(CI, 'scaling-gate').slice(0, 3), [
    '    if: ${{ inputs.run-scaling-gate }}',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 15',
  ]);
  // ONLY ON A PULL REQUEST: a push has no base to time against.
  assert.deepEqual(jobKeys(CI, 'bench-compare').slice(0, 3), [
    "    if: ${{ inputs.run-bench-compare && github.event_name == 'pull_request' }}",
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 20',
  ]);
  // Beside verify, never after it, so a pull request waits for the slowest job, not their sum.
  assert.equal(CI.split('\n').some((line) => /^ {4}needs:/.test(line)), false);
  for (const job of ['scaling-gate', 'bench-compare']) {
    assert.deepEqual(block(CI, `  ${job}:`).slice(3, 6), [
      '    defaults:',
      '      run:',
      '        working-directory: ${{ inputs.working-directory }}',
    ]);
  }
});

test('scaling-gate installs what verify installs, then runs the caller\'s test:perf and fails when it fails', () => {
  assert.deepEqual(steps(CI, 'scaling-gate'), [
    CHECKOUT,
    PNPM_FROM_THE_PACKAGE,
    NODE_WITH_THE_CACHE,
    '      - run: pnpm install --frozen-lockfile',
    '      - run: pnpm test:perf',
  ]);
});

test('bench-compare checks out the history the base needs, compares, and keeps the results whatever happened', () => {
  const list = steps(CI, 'bench-compare');
  assert.deepEqual(list.slice(0, 3), [CHECKOUT_WITH_HISTORY, PNPM_FROM_THE_PACKAGE, NODE_WITH_THE_CACHE]);
  assert.equal(list.length, 5);
  const compare = stepNamed(CI, 'bench-compare', COMPARE);
  assert.match(compare, /^ {8}shell: bash$/m);
  assert.match(compare, /^ {10}set -euo pipefail$/m);
  assert.match(compare, /^ {10}BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/m);
  assert.match(compare, /^ {10}BENCH_SUITES: \$\{\{ inputs\.bench-suites \}\}$/m);
  assert.match(compare, /^ {10}BENCH_TARGET: \$\{\{ inputs\.bench-target \}\}$/m);
  assert.match(compare, /^ {10}BENCH_BUDGET_SECONDS: "600"$/m);
  assert.ok(list.every((step) => !step.includes('continue-on-error')), 'the script itself ends 0, so no step needs to swallow a failure');
  assert.equal(
    stepNamed(CI, 'bench-compare', 'Keep the comparison'),
    [
      '      - name: Keep the comparison',
      '        if: ${{ !cancelled() }}',
      `        uses: ${UPLOAD}`,
      '        with:',
      '          name: bench-comparison',
      '          path: ${{ runner.temp }}/bench-comparison/',
      '          if-no-files-found: warn',
      '          retention-days: 30',
    ].join('\n'),
  );
});

// ---------------------------------------------------------------------------
// THE COMPARISON'S SCRIPT, AGAINST A REAL REPOSITORY AND A STUB pnpm
// ---------------------------------------------------------------------------

/** An executable file at `path`. */
function executable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** Run git in `cwd`, failing the test on a non-zero exit. */
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * The stub `pnpm`. It records `<directory>|<arguments>` for every call. `compare` writes the two
 * files it was asked for and exits STUB_COMPARE_EXIT; `build` in the base worktree exits
 * STUB_BASE_BUILD_EXIT; everything else exits 0.
 */
const STUB_PNPM = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_CALLS, process.cwd() + '|' + args.join(' ') + '\\n');
const flag = (name) => args[args.indexOf(name) + 1];
if (args[0] === 'exec' && args[1] === 'cosyte-bench' && args[2] === 'compare') {
  writeFileSync(flag('--out'), JSON.stringify({ schemaVersion: 1, kind: 'comparison' }) + '\\n');
  writeFileSync(flag('--summary'), '#### stub comparison of ' + flag('--suite') + '\\n');
  process.exit(Number(process.env.STUB_COMPARE_EXIT ?? 0));
}
if (args[0] === 'build' && process.cwd().includes('bench-base')) process.exit(Number(process.env.STUB_BASE_BUILD_EXIT ?? 0));
process.exit(0);
`;

/**
 * A repository with two commits, the package in `pkg/`, and the head checked out. Runs the compare
 * script in `pkg/` and returns the run, the calls, the summary and the paths.
 */
function runCompare({ env = {}, suites = ['bench/a.bench.mjs'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bench-compare-'));
  const repo = join(root, 'repo');
  const pkg = join(repo, 'pkg');
  const bin = join(root, 'bin');
  const temp = join(root, 'runner-temp');
  for (const dir of [pkg, bin, temp]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"name":"fixture","private":true}\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  mkdirSync(join(pkg, 'bench'), { recursive: true });
  for (const suite of suites) writeFileSync(join(pkg, suite), 'export default {};\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'head');
  const head = git(repo, 'rev-parse', 'HEAD');
  const calls = join(root, 'calls');
  writeFileSync(calls, '');
  executable(join(bin, 'pnpm'), STUB_PNPM);
  const summary = join(root, 'summary.md');
  const result = spawnSync(BASH, ['-c', runScript(CI, 'bench-compare', COMPARE)], {
    cwd: pkg,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: temp,
      GITHUB_STEP_SUMMARY: summary,
      STUB_CALLS: calls,
      BASE_SHA: base,
      BENCH_SUITES: '',
      BENCH_TARGET: 'dist/index.mjs',
      BENCH_BUDGET_SECONDS: '600',
      ...env,
    },
    encoding: 'utf8',
  });
  const out = join(temp, 'bench-comparison');
  return {
    ...result,
    calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
    summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
    kept: existsSync(out) ? readdirSync(out).sort() : [],
    base,
    head,
    pkg,
    out,
    basePkg: join(temp, 'bench-base', 'pkg'),
  };
}

test('the comparison builds the head and the base, then times every suite on both in one run', () => {
  const run = runCompare({ suites: ['bench/a.bench.mjs', 'bench/b.bench.ts'] });
  assert.equal(run.status, 0, run.stderr);
  const compare = (suite, name) =>
    `${run.pkg}|exec cosyte-bench compare --suite ${suite} --base ${run.basePkg}/dist/index.mjs --head dist/index.mjs` +
    ` --base-commit ${run.base} --head-commit ${run.head} --out ${run.out}/${name}.json --summary ${run.out}/${name}.md`;
  assert.deepEqual(run.calls, [
    `${run.pkg}|install --frozen-lockfile`,
    `${run.pkg}|build`,
    `${run.basePkg}|install --frozen-lockfile`,
    `${run.basePkg}|build`,
    compare('bench/a.bench.mjs', 'bench-a'),
    `${run.pkg}|exec cosyte-bench check ${run.out}/bench-a.json`,
    compare('bench/b.bench.ts', 'bench-b'),
    `${run.pkg}|exec cosyte-bench check ${run.out}/bench-b.json`,
  ]);
  assert.ok(existsSync(join(run.basePkg, 'package.json')), 'the base is checked out in its own worktree');
  assert.deepEqual(run.kept, ['bench-a.json', 'bench-a.md', 'bench-b.json', 'bench-b.md']);
  assert.match(run.summary, /^### Base against head timing \(advisory\)$/m);
  assert.match(run.summary, /does not fail the pull request/);
  assert.match(run.summary, /^#### stub comparison of bench\/a\.bench\.mjs$/m);
  assert.match(run.summary, /^#### stub comparison of bench\/b\.bench\.ts$/m);
});

test('the comparison runs the suites a caller names, in its order, and refuses none of them silently', () => {
  const run = runCompare({ suites: ['bench/a.bench.mjs', 'bench/b.bench.ts'], env: { BENCH_SUITES: 'bench/b.bench.ts\nbench/a.bench.mjs' } });
  assert.equal(run.status, 0, run.stderr);
  const suites = run.calls.filter((line) => line.includes('cosyte-bench compare')).map((line) => /--suite (\S+)/.exec(line)[1]);
  assert.deepEqual(suites, ['bench/b.bench.ts', 'bench/a.bench.mjs']);

  const missing = runCompare({ env: { BENCH_SUITES: 'bench/a.bench.mjs bench/gone.bench.mjs' } });
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /^::warning::bench-compare: bench\/gone\.bench\.mjs is not a file/m);
  assert.equal(missing.calls.filter((line) => line.includes('cosyte-bench compare')).length, 1);
});

test('a regression, a skip or a crash is reported and never fails the pull request', () => {
  const expected = {
    1: /^::warning::bench-compare: bench\/a\.bench\.mjs: the head is slower than the base beyond the threshold in at least one case/m,
    2: /^::notice::bench-compare: bench\/a\.bench\.mjs: could not measure every case/m,
    7: /^::warning::bench-compare: bench\/a\.bench\.mjs: cosyte-bench exited 7/m,
  };
  for (const [exit, line] of Object.entries(expected)) {
    const run = runCompare({ env: { STUB_COMPARE_EXIT: exit } });
    assert.equal(run.status, 0, `exit ${exit}: ${run.stderr}`);
    assert.match(run.stdout, line);
    assert.match(run.summary, /^#### stub comparison of bench\/a\.bench\.mjs$/m, 'the numbers reach the page either way');
    assert.deepEqual(run.kept, ['bench-a.json', 'bench-a.md']);
  }
});

test('a base that does not build, or no suite at all, ends the comparison with a note and exit 0', () => {
  const unbuilt = runCompare({ env: { STUB_BASE_BUILD_EXIT: '1' } });
  assert.equal(unbuilt.status, 0, unbuilt.stderr);
  assert.match(unbuilt.stdout, /^::warning::bench-compare: the base did not install or build/m);
  assert.match(unbuilt.summary, /^Not run: the base did not install or build/m);
  assert.equal(unbuilt.calls.some((line) => line.includes('cosyte-bench compare')), false);

  const none = runCompare({ suites: [] });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /^::warning::bench-compare: no suite to run/m);
  assert.deepEqual(none.calls, []);

  const noBase = runCompare({ env: { BASE_SHA: '' } });
  assert.equal(noBase.status, 0, noBase.stderr);
  assert.match(noBase.stdout, /^::warning::bench-compare: this run names no base commit/m);
  assert.deepEqual(noBase.calls, []);
});

test('a comparison past its time budget is stopped and reported, not left to the job timeout', () => {
  const run = runCompare({ env: { BENCH_BUDGET_SECONDS: '0' } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^::warning::bench-compare: bench\/a\.bench\.mjs: not compared, the 0 second budget was spent/m);
  assert.equal(run.calls.some((line) => line.includes('cosyte-bench compare')), false);
});

// ---------------------------------------------------------------------------
// THE PROOF: self-check.yml RUNS BOTH AGAINST THE FIXTURE, WITH THE REAL TOOLS
// ---------------------------------------------------------------------------

test('self-check turns both jobs on against the fixture, and checks the kept results on a pull request', () => {
  const systems = block(SELF_CHECK, '  systems:');
  assert.ok(systems.includes('      run-scaling-gate: true'), 'systems turns the scaling gate on');
  assert.ok(systems.includes('      run-bench-compare: true'), 'systems turns the comparison on');
  const proof = block(SELF_CHECK, '  performance-artifacts:').join('\n');
  assert.match(proof, /^ {4}needs: \[systems\]$/m);
  assert.match(proof, /^ {4}if: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
  assert.match(proof, /^ {4}timeout-minutes: 5$/m);
  assert.match(proof, /name: bench-comparison/);
  assert.match(proof, /bench-greeting\.json/);
});

test('the fixture carries a scaling gate and a bench suite on the real tools', () => {
  const fixture = join(REPO, 'test/fixtures/ci-caller');
  const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['test:perf'], 'node tool.mjs perf');
  assert.equal(manifest.devDependencies['@cosyte/bench'], '0.1.1');
  assert.equal(manifest.devDependencies['@cosyte/test-utils'], '0.1.4');
  assert.ok(existsSync(join(fixture, 'bench/greeting.bench.mjs')), 'bench-compare finds bench/*.bench.mjs');
  const lock = readFileSync(join(fixture, 'pnpm-lock.yaml'), 'utf8');
  assert.match(lock, /'@cosyte\/bench':\n {8}specifier: 0\.1\.1/);
  assert.match(lock, /'@cosyte\/test-utils':\n {8}specifier: 0\.1\.4/);
});
