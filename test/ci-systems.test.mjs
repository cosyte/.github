// `ci.yml` on every system and runtime: the opt-in `bun` and `deno` jobs, the shells `verify` names
// so a Windows leg runs the same scripts, the `working-directory` input that lets this repository
// run the workflow against its own fixture, and the `systems` job in `self-check.yml` that does it.
//
// WHAT THIS FILE CAN PROVE AND WHAT IT CANNOT. It reads the two workflow files and runs the one shell
// script whose logic is ours (the deno step's PATH rewrite) against stubs. It cannot prove that a step
// works on a Windows or a macOS runner: only a runner can, and `self-check.yml`'s `systems` job is
// that proof, on every pull request. What this file holds is the surface a caller depends on (job
// ids, inputs, defaults) and the wiring that makes the `systems` run mean something.
//
// The parse is line based, for the reason `test/ci-docs-content.test.mjs` gives: `ci.yml`'s matrix
// nests deeper than the shared reader models, and this repository has no YAML library to install.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const SELF_CHECK = readFileSync(join(REPO, '.github/workflows/self-check.yml'), 'utf8');

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
function inputNames() {
  return block(CI, '    inputs:')
    .filter((line) => /^ {6}[a-z][\w-]*:$/.test(line))
    .map((line) => line.trim().slice(0, -1));
}

/** One input's `description`, `type`, `default` and `required`, as written. */
function inputOf(name) {
  const body = block(CI, `      ${name}:`);
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

/** The `run: |` body of the step named `name` in `job`, dedented to what bash receives. */
function runScript(job, name) {
  const step = steps(CI, job).find((entry) => entry.startsWith(`      - name: ${name}\n`));
  assert.ok(step, `${job} has no step named ${JSON.stringify(name)}`);
  const lines = step.split('\n');
  const at = lines.indexOf('        run: |');
  assert.notEqual(at, -1, `${name} has no run: | block`);
  return `${lines.slice(at + 1).map((line) => line.slice(10)).join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// THE CALLER-VISIBLE SURFACE
// ---------------------------------------------------------------------------

test('the new inputs come after every existing one, and each is off or inert by default', () => {
  assert.deepEqual(inputNames(), [
    'node-versions',
    'os',
    'run-phi-scan',
    'run-actionlint',
    'run-prepublish-manifest-lint',
    'run-prepublish-install',
    'expect-unpublished-deps',
    'check-docs-content',
    'working-directory',
    'run-bun',
    'bun-version',
    'run-deno',
    'deno-version',
    'run-coverage-ratchet',
    'run-mutation',
    'run-scaling-gate',
    'run-bench-compare',
    'bench-suites',
    'bench-target',
  ]);
  // THE DEFAULTS ARE WHAT KEEP A MERGE FROM CHANGING ANY CALLER: both runtimes off, and the
  // directory at the repository root, where every step reads what it read before.
  // The description is what a caller reads on the reference's page, so each one says what it does.
  assert.deepEqual(inputOf('working-directory'), {
    description: '"The directory holding package.json, relative to the repository root. Not read by prepublish or actionlint."',
    type: 'string',
    default: '"."',
    required: undefined,
  });
  assert.deepEqual(inputOf('run-bun'), { description: '"Run the test script under Bun, in the bun job."', type: 'boolean', default: 'false', required: undefined });
  assert.deepEqual(inputOf('run-deno'), { description: '"Run the test script under Deno, in the deno job."', type: 'boolean', default: 'false', required: undefined });
  assert.deepEqual(inputOf('bun-version'), { description: '"The Bun version the bun job installs."', type: 'string', default: '"1.4.4"', required: undefined });
  assert.deepEqual(inputOf('deno-version'), { description: '"The Deno version the deno job installs."', type: 'string', default: '"2.9.8"', required: undefined });
});

test('bun and deno are added after the existing jobs, each behind its own input, and nothing depends on them', () => {
  assert.deepEqual(jobIds(CI), ['verify', 'prepublish', 'actionlint', 'bun', 'deno', 'coverage-ratchet', 'mutation', 'scaling-gate', 'bench-compare']);
  assert.deepEqual(jobKeys(CI, 'bun').slice(0, 3), [
    '    if: ${{ inputs.run-bun }}',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
  ]);
  assert.deepEqual(jobKeys(CI, 'deno').slice(0, 3), [
    '    if: ${{ inputs.run-deno }}',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
  ]);
  // A `needs:` would let a skipped or failed runtime job skip something a caller requires: README.md,
  // "What a skipped required context does to a merge".
  assert.equal(CI.split('\n').some((line) => /^ {4}needs:/.test(line)), false);
});

test('each runtime job installs what verify installs, then runs the caller\'s own test script under that runtime', () => {
  const bun = steps(CI, 'bun');
  const deno = steps(CI, 'deno');
  for (const [name, list] of [['bun', bun], ['deno', deno]]) {
    assert.ok(list.some((step) => step.includes('run: pnpm install --frozen-lockfile')), `${name} installs from the lockfile`);
    assert.ok(list.some((step) => step.includes('node-version: ${{ fromJSON(inputs.node-versions)[0] }}')), `${name} installs on the lowest Node line`);
    assert.ok(list.every((step) => !step.includes('continue-on-error')), `${name} swallows no failure`);
  }
  // The first three steps of each runtime job, exactly: a checkout that keeps no credential for the
  // caller's suite to find, pnpm from the package's own manifest, and Node with verify's cache.
  for (const [name, list] of [['bun', bun], ['deno', deno]]) {
    assert.deepEqual(list.slice(0, 3), [
      '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false',
      "      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9\n        with:\n          package_json_file: ${{ inputs.working-directory == '.' && 'package.json' || format('{0}/package.json', inputs.working-directory) }}",
      "      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: ${{ fromJSON(inputs.node-versions)[0] }}\n          cache: pnpm\n          cache-dependency-path: ${{ inputs.working-directory != '.' && format('{0}/pnpm-lock.yaml', inputs.working-directory) || '' }}",
    ], `${name}'s setup steps`);
  }
  assert.ok(bun.some((step) => /oven-sh\/setup-bun@[0-9a-f]{40} # v2\.2\.0\n {8}with:\n {10}bun-version: \$\{\{ inputs\.bun-version \}\}/.test(step)));
  assert.ok(deno.some((step) => /denoland\/setup-deno@[0-9a-f]{40} # v2\.0\.5\n {8}with:\n {10}deno-version: \$\{\{ inputs\.deno-version \}\}/.test(step)));
  // Both scripts stop at the first failure and on an unset variable, beyond the `-e -o pipefail`
  // the runner's own bash already has.
  assert.match(runScript('bun', 'The test suite under Bun'), /^set -euo pipefail\n/);
  assert.match(runScript('deno', 'The test suite under Deno'), /^set -euo pipefail\n/);
  // `--bun` is the flag that moves a script's `node` onto Bun; `bun run test` alone runs it on Node.
  assert.match(runScript('bun', 'The test suite under Bun'), /^bun --bun run test$/m);
  assert.match(runScript('deno', 'The test suite under Deno'), /^deno task test$/m);
});

// ---------------------------------------------------------------------------
// VERIFY ON EVERY SYSTEM
// ---------------------------------------------------------------------------

test('every multi-line script in verify, bun and deno names bash, so Windows does not run it in PowerShell', () => {
  for (const job of ['verify', 'bun', 'deno']) {
    for (const step of steps(CI, job).filter((entry) => entry.includes('run: |'))) {
      assert.match(step, /^ {8}shell: bash$/m, `${job}: ${step.split('\n')[0].trim()}`);
    }
  }
});

const LINE_ENDINGS = 'Check out text files with LF line endings';

test('verify sets LF line endings before it checks out, on every system, from the workspace', () => {
  const [first, second] = steps(CI, 'verify');
  // FIRST, so the checkout reads it; with no `if:`, so every system gets the same bytes; and in the
  // workspace, because the fixture directory `working-directory` names does not exist before checkout.
  assert.equal(first, [
    `      - name: ${LINE_ENDINGS}`,
    '        shell: bash',
    '        working-directory: .',
    '        run: |',
    '          git config --global core.autocrlf false',
    '          git config --global core.eol lf',
  ].join('\n'));
  assert.match(second, /^ {6}- uses: actions\/checkout@/);
});

test('the line-ending step turns a CRLF checkout into LF, and leaves a file whose eol is set alone', () => {
  // A Windows image's git: `core.autocrlf true` in its system config, as the Git for Windows
  // installer writes by default, and a native line ending of CRLF, stood in for by `core.eol crlf`.
  const root = mkdtempSync(join(tmpdir(), 'ci-systems-eol-'));
  const home = join(root, 'home');
  const source = join(root, 'source');
  mkdirSync(home);
  mkdirSync(join(source, 'docs'), { recursive: true });
  writeFileSync(join(root, 'system.gitconfig'), '[core]\n\tautocrlf = true\n\teol = crlf\n');
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_SYSTEM: join(root, 'system.gitconfig') };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  // Three kinds of file: no attribute, `text=auto` with no eol, and an eol the repository fixed.
  writeFileSync(join(source, '.gitattributes'), 'docs/*.md text=auto\n*.bat text eol=crlf\n');
  writeFileSync(join(source, 'plain.txt'), 'one\ntwo\n');
  writeFileSync(join(source, 'docs/page.md'), 'one\ntwo\n');
  writeFileSync(join(source, 'run.bat'), 'one\ntwo\n');
  git(source, 'init', '-q');
  git(source, '-c', 'core.autocrlf=false', 'add', '.');
  git(source, '-c', 'user.name=t', '-c', 'user.email=t', 'commit', '-q', '-m', 'fixture');
  const checkout = (name) => {
    git(root, 'clone', '-q', source, name);
    return Object.fromEntries(['plain.txt', 'docs/page.md', 'run.bat'].map((file) => [file, readFileSync(join(root, name, file), 'utf8')]));
  };
  const CRLF = 'one\r\ntwo\r\n';
  const LF = 'one\ntwo\n';

  // The control: without the step, this git writes every text file with CRLF.
  assert.deepEqual(checkout('before'), { 'plain.txt': CRLF, 'docs/page.md': CRLF, 'run.bat': CRLF });

  const bash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  const step = spawnSync(bash, ['-c', runScript('verify', LINE_ENDINGS)], { cwd: root, env, encoding: 'utf8' });
  assert.equal(step.status, 0, step.stderr);
  // After it: LF, except where the repository's own attributes ask for CRLF.
  assert.deepEqual(checkout('after'), { 'plain.txt': LF, 'docs/page.md': LF, 'run.bat': CRLF });
});

test('at the default directory, every job reads the package where it read it before the input existed', () => {
  for (const job of ['verify', 'bun', 'deno']) {
    const body = block(CI, `  ${job}:`);
    assert.deepEqual(body.slice(0, body.indexOf('    steps:')).filter((line) => /^ {4}defaults:|^ {6}run:$|^ {8}working-directory:/.test(line)), [
      '    defaults:',
      '      run:',
      '        working-directory: ${{ inputs.working-directory }}',
    ]);
    const all = steps(CI, job).join('\n');
    // `package.json` is pnpm/action-setup's own default, and an empty `cache-dependency-path` is unset.
    assert.match(all, /package_json_file: \$\{\{ inputs\.working-directory == '\.' && 'package\.json' \|\| format\('\{0\}\/package\.json', inputs\.working-directory\) \}\}/);
    assert.match(all, /cache-dependency-path: \$\{\{ inputs\.working-directory != '\.' && format\('\{0\}\/pnpm-lock\.yaml', inputs\.working-directory\) \|\| '' \}\}/);
  }
  // `prepublish` and `actionlint` read the repository root and nothing else, as before.
  assert.equal(block(CI, '  prepublish:').some((line) => line.includes('working-directory')), false);
  assert.equal(block(CI, '  actionlint:').some((line) => line.includes('working-directory')), false);
});

// ---------------------------------------------------------------------------
// THE DENO STEP'S PATH REWRITE, RUN AGAINST STUBS
// ---------------------------------------------------------------------------

/** An executable shell script at `path`. */
function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * Run the deno step's script with PATH = `extra` dirs + a dir of real tools + a dir with a stub deno.
 * The stub records what `node` and `helper` resolve to when it runs, and its arguments.
 */
function runDenoStep({ withNodeDir = true, emptyEntry = false, denoExit = 0, root: reuse, temp: reuseTemp, env = {} } = {}) {
  const root = reuse ?? mkdtempSync(join(tmpdir(), 'ci-systems-'));
  const tools = join(root, 'tools');
  const withNode = join(root, 'with-node');
  const denoDir = join(root, 'deno-bin');
  const cwd = join(root, 'cwd');
  const temp = reuseTemp ?? join(root, 'runner-temp');
  for (const dir of [tools, withNode, denoDir, cwd, temp]) mkdirSync(dir, { recursive: true });
  for (const tool of ['rm', 'mkdir', 'ln', 'head', 'cat', 'sh']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (!existsSync(join(tools, tool))) symlinkSync(found, join(tools, tool));
  }
  executable(join(withNode, 'node'), 'echo real-node');
  executable(join(withNode, 'helper'), 'echo helper');
  executable(join(cwd, 'node'), 'echo cwd-node');
  const record = join(root, 'record');
  executable(
    join(denoDir, 'deno'),
    [
      `echo "args=$*" >> '${record}'`,
      `echo "node=$(command -v node || echo none)" >> '${record}'`,
      `echo "helper=$(command -v helper || echo none)" >> '${record}'`,
      `echo "$PATH" > '${record}.path'`,
      'if [ "$1" = "--version" ]; then echo "deno 0.0.0-stub"; exit 0; fi',
      `exit ${denoExit}`,
    ].join('\n'),
  );
  const entries = [...(emptyEntry ? [''] : []), ...(withNodeDir ? [withNode] : []), tools, denoDir];
  const bash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(bash, ['-c', runScript('deno', 'The test suite under Deno')], {
    cwd,
    env: { ...env, PATH: entries.join(':'), RUNNER_TEMP: temp },
    encoding: 'utf8',
  });
  const recorded = existsSync(record) ? readFileSync(record, 'utf8') : '';
  const path = existsSync(`${record}.path`) ? readFileSync(`${record}.path`, 'utf8').trim() : '';
  return { ...result, recorded, path, root, temp, tools, denoDir, withNode };
}

test('the deno step takes node off PATH, keeps everything beside it, and runs the suite with deno task', () => {
  const run = runDenoStep();
  assert.equal(run.status, 0, run.stderr);
  const mirror = join(run.temp, 'path-without-node', '1');
  assert.equal(
    run.recorded,
    [
      'args=--version',
      'node=none',
      `helper=${mirror}/helper`,
      'args=task test',
      'node=none',
      `helper=${mirror}/helper`,
      '',
    ].join('\n'),
  );
  assert.match(run.stdout, new RegExp(`deno: ${run.withNode} holds a node, so PATH names ${mirror} in its place`));
  assert.match(run.stdout, /^deno: deno 0\.0\.0-stub$/m);
});

test('the deno step leaves a PATH with no node alone', () => {
  const run = runDenoStep({ withNodeDir: false });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.recorded, /^args=task test$/m);
  assert.doesNotMatch(run.stdout, /holds a node/);
  assert.equal(existsSync(join(run.temp, 'path-without-node')), false);
});

test('the deno step refuses to run the suite while a node is still reachable', () => {
  // An empty PATH entry is the working directory, which holds a `node` here and cannot be mirrored.
  const run = runDenoStep({ emptyEntry: true });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^::error::a node is still on PATH at \.\/node, so the suite would run under Node rather than Deno$/m);
  assert.equal(run.recorded, '', 'deno must never be started');
});

test('the deno step fails when the suite fails', () => {
  const run = runDenoStep({ denoExit: 3 });
  assert.equal(run.status, 3);
  assert.match(run.recorded, /^args=task test$/m);
});

test('the deno step can run twice in one RUNNER_TEMP, replacing what the first run left', () => {
  const first = runDenoStep();
  assert.equal(first.status, 0, first.stderr);
  const second = runDenoStep({ temp: first.temp, root: first.root });
  assert.equal(second.status, 0, second.stderr);
});

test('the deno step builds PATH from PATH alone, never from a variable it inherits', () => {
  const run = runDenoStep({ env: { kept: '/inherited/bin' } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.path, [join(run.temp, 'path-without-node', '1'), run.tools, run.denoDir].join(':'));
});

test('the bun step prints the Bun it runs, runs the test script with --bun, and fails when it fails', () => {
  for (const exit of [0, 4]) {
    const root = mkdtempSync(join(tmpdir(), 'ci-systems-bun-'));
    const record = join(root, 'record');
    executable(
      join(root, 'bun'),
      [`echo "args=$*" >> '${record}'`, 'if [ "$1" = "--version" ]; then echo 0.0.0-stub; exit 0; fi', `exit ${exit}`].join('\n'),
    );
    const bash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
    const result = spawnSync(bash, ['-c', runScript('bun', 'The test suite under Bun')], {
      env: { PATH: `${root}:${dirname(bash)}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, exit, result.stderr);
    assert.match(result.stdout, /^bun: 0\.0\.0-stub$/m);
    assert.equal(readFileSync(record, 'utf8'), 'args=--version\nargs=--bun run test\n');
  }
});

// ---------------------------------------------------------------------------
// THE PROOF: self-check.yml RUNS ci.yml ON EVERY SYSTEM AND RUNTIME
// ---------------------------------------------------------------------------

test('self-check runs ci.yml itself on all three systems and both runtimes, against the fixture', () => {
  assert.deepEqual(jobIds(SELF_CHECK), ['actionlint', 'scripts', 'package-lists', 'systems', 'nightly-properties', 'weekly-mutation', 'weekly-mutation-incremental', 'quality-artifacts', 'release-gates', 'performance-artifacts']);
  assert.deepEqual(block(SELF_CHECK, '  systems:'), [
    '    uses: ./.github/workflows/ci.yml',
    '    with:',
    '      working-directory: test/fixtures/ci-caller',
    '      os: \'["ubuntu-latest", "windows-latest", "macos-latest"]\'',
    '      run-phi-scan: true',
    '      check-docs-content: true',
    '      run-bun: true',
    '      run-deno: true',
    '      run-coverage-ratchet: true',
    '      run-mutation: true',
    '      run-scaling-gate: true',
    '      run-bench-compare: true',
    '      run-actionlint: false',
    '      run-prepublish-manifest-lint: false',
    '      run-prepublish-install: false',
  ]);
  // The run proves something only if the fixture is a package `verify` can install and every one of
  // its steps calls a script the fixture defines.
  const fixture = join(REPO, 'test/fixtures/ci-caller');
  const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
  for (const script of ['typecheck', 'lint', 'format:check', 'phi-scan', 'test', 'test:coverage', 'test:properties', 'build', 'attw']) {
    assert.equal(typeof manifest.scripts[script], 'string', `the fixture defines no ${script} script`);
  }
  assert.ok(existsSync(join(fixture, 'pnpm-lock.yaml')), 'verify installs with --frozen-lockfile');
  assert.ok(existsSync(join(fixture, 'docs-content/sidebars.json')), 'check-docs-content needs docs-content/sidebars.json');
});
