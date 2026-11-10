// THE PRE-PUBLISH GATES IN `release.yml`, and the SBOM the release carries.
//
// Four gates run in the `version` job, after its `Verify` ladder and before anything can publish:
// the `release` job `needs:` that job, so a gate that fails stops the publish, and the version job
// holds no publish credential, so nothing a gate runs can reach the registry. README.md, "What a
// skipped required context does to a merge", owns why `release` must not survive that failure. Each
// runs only on the run that owes a publish. Each says by name why it skipped when a caller has not turned it on, and
// none of them re-runs a mutation pass: the mutation gate reads the latest weekly result.
//
// The fifth piece is in the jobs that create a GitHub release: a CycloneDX SBOM, written before the
// publish in `release` and before the release in `finalize`, attached by `github-release.mjs` in the
// same call that creates the release. npm provenance is unchanged: the publish step still asks for
// it on a public caller.
//
// The scripts each gate runs are tested in their own files (`mutation-gate`, `tarball-samples`,
// `sbom`, `prepublish-check`); this file holds the wiring.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { decomment, parseWorkflow } from './workflow-reader.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_FILE = '.github/workflows/release.yml';
const TEXT = readFileSync(join(REPO, RELEASE_FILE), 'utf8');
const WORKFLOW = parseWorkflow(TEXT);
const VERSION = WORKFLOW.byId.version;
const RELEASE = WORKFLOW.byId.release;
const FINALIZE = WORKFLOW.byId.finalize;

const OWES_A_PUBLISH = "${{ steps.notes.outputs.is-release == 'true' && steps.promoted.outputs.live != 'true' }}";
const GATES = [
  'Release gate, the latest weekly mutation result',
  'Release gate, the benchmarks and the scaling gate',
  'Release gate, the package checks on the packed tarball',
  'Release gate, the docs samples against the packed tarball',
];

const stepIndex = (job, label) => {
  const at = job.steps.findIndex((step) => step.label === label);
  assert.notEqual(at, -1, `${job.id} has no step ${JSON.stringify(label)}`);
  return at;
};
const stepOf = (job, label) => job.steps[stepIndex(job, label)];

/** The `on.workflow_call.inputs` block, as the lines of each input. */
function input(name) {
  const lines = TEXT.split('\n');
  const at = lines.indexOf(`      ${name}:`);
  assert.notEqual(at, -1, `release.yml has no input ${name}`);
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^ {8}\S/.test(line)) break;
    body.push(line.trim());
  }
  return body;
}

test('each gate has its input, and the three that need adopting are off unless a caller turns them on', () => {
  assert.deepEqual(input('mutation-workflow'), [
    'description: "The caller\'s weekly mutation workflow file, whose latest result on the default branch the release reads. A caller without the file skips the gate."',
    'type: string',
    'default: "weekly-mutation.yml"',
  ]);
  assert.deepEqual(input('mutation-max-age-days'), [
    'description: "The oldest a successful weekly mutation run may be, in days, for a release to go ahead."',
    'type: number',
    'default: 8',
  ]);
  for (const [name, what] of [
    ['run-benchmarks', 'Before publishing, run the test:perf scaling gate and time each bench suite against the build with cosyte-bench.'],
    ['run-package-checks', 'Before publishing, pack the package and check the tarball: every declared file and exports entry is in it, it installs into a clean directory, and each entry point loads.'],
    ['run-tarball-samples', 'Before publishing, install the packed tarball into a clean directory and run every docs sample against it.'],
  ]) {
    assert.deepEqual(input(name), [`description: "${what}"`, 'type: boolean', 'default: false'], name);
  }
  assert.deepEqual(input('docs-dir'), ['description: "The directory of documentation pages whose samples run-tarball-samples runs, relative to the repository root."', 'type: string', 'default: "docs-content"']);
  assert.deepEqual(input('bench-suites').slice(1), ['type: string', 'default: ""']);
  assert.deepEqual(input('bench-target').slice(1), ['type: string', 'default: "dist/index.mjs"']);
});

test('the gates run in the version job, after Verify and the changelog gate, before the Version PR step, in order', () => {
  const at = GATES.map((label) => stepIndex(VERSION, label));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in the order written');
  assert.ok(at[0] > stepIndex(VERSION, 'Verify'));
  assert.ok(at[0] > stepIndex(VERSION, 'The changelog must carry a section for the version being released'));
  assert.ok(at.at(-1) < stepIndex(VERSION, 'Create or refresh the "Version Packages" pull request'));
  for (const label of GATES) {
    const step = stepOf(VERSION, label);
    assert.equal(step.fields.if, OWES_A_PUBLISH, `${label} runs exactly when this run owes a publish`);
    assert.equal('continue-on-error' in step.fields, false, `${label} must fail the job`);
  }
});

test('a failed gate stops the publish: release needs version and never opts back in after a failure', () => {
  assert.equal(RELEASE.keys.needs, 'version');
  assert.equal(RELEASE.keys.if, "${{ needs.version.outputs.is-release == 'true' }}");
  // And the version job holds no publish credential, so a gate cannot publish either.
  assert.equal(VERSION.blocks.permissions['id-token'], undefined);
});

test('the mutation gate reads the weekly result with the automatic token and the two inputs, and runs no mutation', () => {
  const step = stepOf(VERSION, GATES[0]);
  assert.deepEqual(step.env, {
    GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    DEFAULT_BRANCH_HINT: '${{ github.event.repository.default_branch }}',
    MUTATION_WORKFLOW: '${{ inputs.mutation-workflow }}',
    MUTATION_MAX_AGE_DAYS: '${{ inputs.mutation-max-age-days }}',
  });
  assert.match(step.body, /node \.cosyte-release-tooling\/scripts\/mutation-gate\.mjs --repo \. \\\n\s+--workflow "\$MUTATION_WORKFLOW" --max-age-days "\$MUTATION_MAX_AGE_DAYS"/);
  // The job already asks for `actions: read`, which is all the read needs.
  assert.equal(VERSION.blocks.permissions.actions, 'read');
});

test('release.yml runs no mutation pass anywhere', () => {
  const code = decomment(TEXT).join('\n');
  for (const forbidden of [/cosyte-mutate/, /stryker/i, /mutation\.json/]) assert.doesNotMatch(code, forbidden);
});

const BASH = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();

/** The step's `run: |` body, dedented. */
function script(step) {
  const lines = step.body.split('\n');
  const at = lines.findIndex((line) => /^ {8}run: \|$/.test(line));
  assert.notEqual(at, -1, `${step.label} has no run: | block`);
  return `${lines.slice(at + 1).map((line) => line.slice(10)).join('\n')}\n`;
}

/** Run a gate's script in a package directory with a stub `pnpm` (and `node`, when given) on PATH. */
function runGate(label, { env = {}, manifest = { name: 'x', scripts: { 'test:perf': 'node perf.mjs' } }, files = {}, pnpmExit = 0, nodeStub } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-gates-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'work');
  const temp = join(root, 'temp');
  for (const dir of [bin, cwd, temp]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, 'package.json'), `${JSON.stringify(manifest)}\n`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  const calls = join(root, 'calls');
  const stub = (name, exit) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\nexit ${exit}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('pnpm', pnpmExit);
  if (nodeStub !== undefined) stub('node', nodeStub);
  const summary = join(root, 'summary.md');
  const result = spawnSync(BASH, ['-c', script(stepOf(VERSION, label))], {
    cwd,
    env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary, ...env },
    encoding: 'utf8',
  });
  return {
    ...result,
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
    summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
  };
}

const BENCH = GATES[1];
const BENCH_ON = { RUN_BENCHMARKS: 'true', BENCH_SUITES: '', BENCH_TARGET: 'dist/index.mjs' };

test('the benchmarks gate, left off, skips by name and runs nothing', () => {
  const run = runGate(BENCH, { env: { ...BENCH_ON, RUN_BENCHMARKS: 'false' } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^benchmarks gate skipped: run-benchmarks is off, so no benchmark or scaling gate runs before this release$/m);
  assert.deepEqual(run.calls, []);
});

test('the benchmarks gate runs the scaling gate, then each bench suite, and checks each results file', () => {
  const run = runGate(BENCH, { env: BENCH_ON, files: { 'bench/parse.bench.mjs': '', 'bench/emit.bench.ts': '' } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    run.calls.map((call) => call.replace(/\S*\/temp\/release-benchmarks/g, '<out>')),
    [
      'pnpm run test:perf',
      'pnpm exec cosyte-bench run --suite bench/parse.bench.mjs --target dist/index.mjs --out <out>/parse.bench.json',
      'pnpm exec cosyte-bench check <out>/parse.bench.json',
      'pnpm exec cosyte-bench run --suite bench/emit.bench.ts --target dist/index.mjs --out <out>/emit.bench.json',
      'pnpm exec cosyte-bench check <out>/emit.bench.json',
    ],
  );
  assert.match(run.summary, /^### Release gate: benchmarks and the scaling gate$/m);
});

test('the benchmarks gate names suites when given, and with no suite runs the scaling gate alone, saying so', () => {
  const named = runGate(BENCH, { env: { ...BENCH_ON, BENCH_SUITES: 'bench/a.bench.mjs\nbench/b.bench.mjs' } });
  assert.equal(named.status, 0, named.stderr);
  assert.equal(named.calls.filter((call) => call.includes('cosyte-bench run')).length, 2);
  const none = runGate(BENCH, { env: BENCH_ON });
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(none.calls, ['pnpm run test:perf']);
  assert.match(none.stdout, /^no bench suite: name one in bench-suites, or add bench\/<name>\.bench\.mjs; only the scaling gate ran$/m);
});

test('the benchmarks gate, turned on, refuses a package with no test:perf script, and fails when a tool fails', () => {
  const missing = runGate(BENCH, { env: BENCH_ON, manifest: { name: 'x', scripts: {} } });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^::error::run-benchmarks is on, and package\.json has no test:perf script/m);
  assert.deepEqual(missing.calls, []);
  const failed = runGate(BENCH, { env: BENCH_ON, pnpmExit: 1 });
  assert.equal(failed.status, 1);
});

test('the package checks gate, left off, skips by name; turned on, it runs both pre-publish layers', () => {
  const off = runGate(GATES[2], { env: { RUN_PACKAGE_CHECKS: 'false', EXPECT_UNPUBLISHED_DEPS: '' }, nodeStub: 0 });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /^package checks gate skipped: run-package-checks is off/m);
  assert.deepEqual(off.calls, []);
  const on = runGate(GATES[2], { env: { RUN_PACKAGE_CHECKS: 'true', EXPECT_UNPUBLISHED_DEPS: '@x/y=blocked' }, nodeStub: 0 });
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(on.calls, [
    'node .cosyte-release-tooling/scripts/prepublish-check.mjs manifest --repo . --expect-unpublished-deps @x/y=blocked',
    'node .cosyte-release-tooling/scripts/prepublish-check.mjs pack --repo . --expect-unpublished-deps @x/y=blocked',
  ]);
  assert.equal(runGate(GATES[2], { env: { RUN_PACKAGE_CHECKS: 'true', EXPECT_UNPUBLISHED_DEPS: '' }, nodeStub: 1 }).status, 1);
});

test('the samples gate, left off, skips by name; turned on, it runs the samples against the tarball', () => {
  const off = runGate(GATES[3], { env: { RUN_TARBALL_SAMPLES: 'false', DOCS_DIR: 'docs-content' }, nodeStub: 0 });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /^samples gate skipped: run-tarball-samples is off/m);
  assert.deepEqual(off.calls, []);
  const on = runGate(GATES[3], { env: { RUN_TARBALL_SAMPLES: 'true', DOCS_DIR: 'site/docs' }, nodeStub: 0 });
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(on.calls, ['node .cosyte-release-tooling/scripts/tarball-samples.mjs --repo . --docs-dir site/docs']);
  assert.equal(runGate(GATES[3], { env: { RUN_TARBALL_SAMPLES: 'true', DOCS_DIR: 'docs-content' }, nodeStub: 1 }).status, 1);
});

test('the benchmarks are kept as an artifact when they ran, and nothing runs past a failed gate to keep them', () => {
  const keep = stepOf(VERSION, 'Keep the release benchmarks');
  // No status function: a step that ran after a failed gate is the shape `install-check`'s AC9 refuses.
  assert.equal(keep.fields.if, "${{ inputs.run-benchmarks && steps.notes.outputs.is-release == 'true' && steps.promoted.outputs.live != 'true' }}");
  assert.equal(keep.fields.uses, 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9');
  assert.equal(keep.with.path, '${{ runner.temp }}/release-benchmarks/');
});

// -- The SBOM ---------------------------------------------------------------------------------------

const SBOM_PATH = '"$RUNNER_TEMP/sbom/sbom.cdx.json"';

test('release writes the SBOM before the publish, and both of its release steps attach it', () => {
  const write = stepIndex(RELEASE, 'Write the SBOM the GitHub release carries');
  assert.ok(write > stepIndex(RELEASE, 'Verify'));
  assert.ok(write < stepIndex(RELEASE, 'Publish to npm'), 'an SBOM that cannot be written stops the publish');
  assert.ok(RELEASE.steps[write].body.includes(`node .cosyte-release-tooling/scripts/sbom.mjs --repo . --out ${SBOM_PATH}`), RELEASE.steps[write].body);
  for (const label of ['Publish the GitHub release + dispatch docs rebuild', 'Publish the GitHub release + dispatch docs rebuild, once the staged version is live']) {
    assert.match(stepOf(RELEASE, label).body, /--sbom "\$RUNNER_TEMP\/sbom\/sbom\.cdx\.json"/, label);
  }
});

test('finalize writes the SBOM from the release commit and attaches it too', () => {
  const write = stepIndex(FINALIZE, 'Write the SBOM the GitHub release carries');
  assert.ok(write > FINALIZE.steps.findIndex((step) => step.fields.run === 'pnpm build'), 'after the build');
  const release = 'Publish the GitHub release + dispatch docs rebuild, for a version promoted after its run';
  assert.ok(write < stepIndex(FINALIZE, release));
  assert.match(stepOf(FINALIZE, release).body, /--sbom "\$RUNNER_TEMP\/sbom\/sbom\.cdx\.json"/);
});

test('npm provenance is still asked for on the publish of a public caller', () => {
  assert.equal(stepOf(RELEASE, 'Publish to npm').env.NPM_CONFIG_PROVENANCE, "${{ github.event.repository.visibility == 'public' }}");
  assert.equal(RELEASE.blocks.permissions['id-token'], 'write');
});

// -- The proof on a runner -------------------------------------------------------------------------

test('self-check runs each pre-publish script for real, where nothing can publish', () => {
  const selfCheck = readFileSync(join(REPO, '.github/workflows/self-check.yml'), 'utf8');
  const lines = selfCheck.split('\n');
  const at = lines.indexOf('  release-gates:');
  assert.notEqual(at, -1, 'self-check.yml has no release-gates job');
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (/^ {2}\S/.test(line)) break;
    body.push(line);
  }
  const job = body.join('\n');
  // `actions: read` for the API read, and no write and no id-token, so nothing here can publish.
  assert.match(job, /^ {4}permissions:\n {6}contents: read\n {6}actions: read$/m);
  assert.doesNotMatch(job, /write|id-token|npm publish|gh release/);
  assert.match(job, /node scripts\/mutation-gate\.mjs --repo \. --workflow self-check\.yml --max-age-days 8/);
  assert.match(job, /grep -F 'mutation gate skipped: '/);
  assert.match(job, /tarball-samples\.mjs" --repo \. --docs-dir release-samples/);
  assert.match(job, /grep -F 'ran release-samples\/greeting\.md:7'/);
  assert.match(job, /sbom\.mjs" --repo \. --out "\$\{RUNNER_TEMP\}\/sbom\/sbom\.cdx\.json"/);
  const page = readFileSync(join(REPO, 'test/fixtures/ci-caller/release-samples/greeting.md'), 'utf8');
  assert.equal(page.split('\n')[6], 'import { greeting } from "ci-caller-fixture";', 'line 7 is the sample the job greps for');
  const manifest = JSON.parse(readFileSync(join(REPO, 'test/fixtures/ci-caller/package.json'), 'utf8'));
  assert.deepEqual(manifest.files, ['dist'], 'the tarball must carry the dist/ that .gitignore leaves out');
});
