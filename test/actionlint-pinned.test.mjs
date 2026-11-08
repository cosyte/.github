// The two `actionlint` jobs: the one every caller's CI runs (in `ci.yml`) and this repository's
// own required check (in `self-check.yml`).
//
// WHAT IS ASSERTED, AND WHY. Both install rhysd/actionlint's own release binary at one version,
// check the download against one SHA-256 before unpacking it, and fail on actionlint's own exit
// status over every tracked workflow file. Neither uses reviewdog/action-actionlint, which from
// v1.75.0 installs actionlint by piping a download script from a fork into bash.
//
// THE RELEASE IS CACHED, AND THE CACHE IS TRUSTED NO FURTHER THAN A DOWNLOAD. GitHub's release
// downloads answered 504 for hours on 2026-11-08 and failed this job everywhere, so each job restores
// the tarball with actions/cache, keyed on the version and the SHA-256, downloads only when the cache
// has no copy that matches, saves on a miss, and checks the SHA-256 of whatever it unpacks.
//
// THE STEPS ARE RUN, NOT ONLY READ. A checksum line that reads right and is wired wrong (a `|| true`,
// a check after the unpack, a hash compared with nothing) would pass every textual assertion, so the
// install step is executed against a fake `curl` serving a tarball built here: the right hash
// installs it, a wrong one fails before anything is unpacked, and a runner without shellcheck fails
// rather than linting without the shell checks. The lint step is executed against a fake actionlint
// in a real git repository, so which files it is handed and whose exit status decides are measured.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseWorkflow } from './workflow-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WORKFLOWS = '.github/workflows';
const FILES = ['ci.yml', 'self-check.yml'];
const RESTORE = 'Restore the actionlint release from the cache';
const INSTALL = 'Install actionlint at the pinned version and checksum';
const SAVE = 'Save the actionlint release to the cache';
const CACHE_PATH = '${{ runner.temp }}/actionlint-cache';
const LINT = 'actionlint over .github/workflows/';
const RELEASES = 'https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${tarball}';

const read = (relative) => readFileSync(join(REPO, relative), 'utf8');
const indentOf = (line) => line.length - line.replace(/^ */, '').length;
const unquote = (value) => value.replace(/^"(.*)"$/, '$1');

/**
 * The `actionlint` job alone, read through the shared reader. `ci.yml` as a whole is outside the
 * reader's subset (its matrix nests a level deeper), so the job's own block is handed to it under a
 * `jobs:` key, which is exactly the subset the reader declares.
 */
function actionlintJob(name) {
  const lines = read(join(WORKFLOWS, name)).split('\n');
  const start = lines.indexOf('  actionlint:');
  assert.notEqual(start, -1, `${name} has no \`actionlint\` job`);
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}\S/.test(lines[end])) end += 1;
  const block = lines.slice(start, end);
  const [job] = parseWorkflow(['jobs:', ...block].join('\n')).jobs;
  return { job, text: block.join('\n') };
}

/** The `run: |` body of the step labelled `stepName`, dedented to what the runner hands to bash. */
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
  assert.ok(seenRun && body.length > 0, `the step ${JSON.stringify(stepName)} has no \`run: |\` block`);
  return `${body.join('\n')}\n`;
}

/** The absolute path of a tool this test hands the step, so PATH can hold nothing else. */
function which(tool) {
  const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  assert.equal(found.status, 0, `${tool} is not installed, and this test needs it`);
  return found.stdout.trim();
}
const BASH = which('bash');

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

test('no workflow here uses reviewdog/action-actionlint, which installs actionlint from a fork', () => {
  for (const name of readdirSync(join(REPO, WORKFLOWS)).filter((file) => /\.ya?ml$/.test(file))) {
    for (const line of read(join(WORKFLOWS, name)).split('\n')) {
      assert.ok(!/^\s*-?\s*uses:\s*reviewdog\/action-actionlint/.test(line), `${name}: ${line.trim()}`);
    }
  }
});

test('Dependabot here is told never to propose reviewdog/action-actionlint again', () => {
  assert.match(read('.github/dependabot.yml'), /^ {6}- dependency-name: "reviewdog\/action-actionlint"$/m);
});

test('both jobs pin the same version and the same SHA-256, and the gate in CLAUDE.md names that version', () => {
  const pins = FILES.map((name) => {
    const { job } = actionlintJob(name);
    return { version: unquote(job.blocks.env?.ACTIONLINT_VERSION ?? ''), sha: unquote(job.blocks.env?.ACTIONLINT_SHA256 ?? '') };
  });
  for (const pin of pins) {
    assert.match(pin.version, /^\d+\.\d+\.\d+$/, 'an exact version, never a range or `latest`');
    assert.match(pin.sha, /^[0-9a-f]{64}$/, 'a full SHA-256');
  }
  assert.deepEqual(pins[1], pins[0], 'ci.yml and self-check.yml run one actionlint');
  assert.ok(read('CLAUDE.md').includes(`actionlint@${pins[0].version}`), 'CLAUDE.md names another version for the local gate');
});

test('each job installs from the official release, checks the hash before unpacking, and requires shellcheck', () => {
  for (const name of FILES) {
    const { job, text } = actionlintJob(name);
    assert.deepEqual(job.steps.map((step) => step.label).slice(1), [RESTORE, INSTALL, SAVE, LINT], `${name}: the steps after the checkout`);
    assert.equal(job.keys['continue-on-error'], undefined, `${name}: the job may not swallow a failure`);
    assert.equal(job.keys['timeout-minutes'], '5');
    const install = runScript(text, INSTALL);
    assert.ok(install.includes(RELEASES), `${name}: the download is not rhysd/actionlint's release`);
    // The last check stands unconditionally on the line before the unpack, so whichever branch put
    // the tarball there, cached or downloaded, the bytes unpacked are the bytes just checked.
    const lines = install.split('\n');
    const unpack = lines.findIndex((line) => line.startsWith('tar -xzf '));
    assert.notEqual(unpack, -1, `${name}: nothing is unpacked`);
    assert.equal(lines[unpack - 1], 'echo "${ACTIONLINT_SHA256}  ${cache_dir}/${tarball}" | sha256sum -c -', `${name}: the hash is checked before the unpack`);
    assert.equal(lines[unpack], 'tar -xzf "${cache_dir}/${tarball}" -C "${RUNNER_TEMP}" actionlint', `${name}: the unpack reads the checked file`);
    assert.match(install, /^cache_dir="\$\{RUNNER_TEMP\}\/actionlint-cache"$/m, `${name}: the install reads where the cache restores`);
    assert.match(install, /^shellcheck --version$/m, `${name}: shellcheck must be present, or the shell checks are skipped`);
    for (const script of [install, runScript(text, LINT)]) {
      assert.match(script, /^set -euo pipefail$/m);
      assert.doesNotMatch(script, /\|\|\s*true|\$\{\{/, `${name}: a swallowed failure or an interpolated expression`);
    }
  }
  // The caller-facing half keeps its id and its one condition, so `<caller job> / actionlint` and
  // `run-actionlint: false` both mean what they meant.
  assert.equal(actionlintJob('ci.yml').job.keys.if, '${{ inputs.run-actionlint }}');
});

test('each job restores the release from the cache, keyed on the version and the SHA-256, and saves it only on a miss', () => {
  const pins = new Set();
  for (const name of FILES) {
    const { job, text } = actionlintJob(name);
    const [, restore, , save] = job.steps;
    const restoreUses = /^actions\/cache\/restore@([0-9a-f]{40})$/.exec(restore.fields.uses ?? '');
    const saveUses = /^actions\/cache\/save@([0-9a-f]{40})$/.exec(save.fields.uses ?? '');
    assert.ok(restoreUses && saveUses, `${name}: actions/cache restore and save, each pinned to a full commit SHA`);
    for (const uses of [restore.fields.uses, save.fields.uses]) {
      const line = text.split('\n').find((candidate) => candidate.trim().startsWith(`uses: ${uses} `)) ?? '';
      assert.match(line, / # v\d+\.\d+\.\d+$/, `${name}: ${uses} has no version beside it`);
    }
    assert.equal(restoreUses[1], saveUses[1], `${name}: restore and save are one actions/cache commit`);
    pins.add(restoreUses[1]);
    assert.equal(restore.fields.id, 'actionlint-cache');
    assert.equal(restore.with.path, CACHE_PATH);
    assert.equal(restore.with.key, 'actionlint-${{ env.ACTIONLINT_VERSION }}-linux-amd64-${{ env.ACTIONLINT_SHA256 }}');
    assert.equal(restore.with['restore-keys'], undefined, `${name}: a partial match would restore another version`);
    assert.equal(restore.fields['continue-on-error'], undefined);
    // Saved under the key the restore missed on, from the path it restores to, and only on a miss.
    assert.equal(save.fields.if, "${{ steps.actionlint-cache.outputs.cache-hit != 'true' }}");
    assert.equal(save.with.path, CACHE_PATH);
    assert.equal(save.with.key, '${{ steps.actionlint-cache.outputs.cache-primary-key }}');
  }
  assert.equal(pins.size, 1, 'ci.yml and self-check.yml pin one actions/cache');
});

// ---------------------------------------------------------------------------
// The install step, run
// ---------------------------------------------------------------------------

/** A release tarball holding a fake `actionlint`, and its SHA-256. */
function fakeRelease(dir) {
  const stage = join(dir, 'stage');
  mkdirSync(stage);
  writeFileSync(join(stage, 'actionlint'), '#!/bin/sh\necho "fake actionlint $*"\n');
  chmodSync(join(stage, 'actionlint'), 0o755);
  const tarball = join(dir, 'release.tar.gz');
  const packed = spawnSync('tar', ['-czf', tarball, '-C', stage, 'actionlint']);
  assert.equal(packed.status, 0);
  return { tarball, sha: createHash('sha256').update(readFileSync(tarball)).digest('hex') };
}

/**
 * A PATH holding only the tools the install step calls, a fake `curl`, and a fake `shellcheck` if
 * asked. The fake `curl` records the URL and serves the tarball built above, or exits 22, curl's
 * code for an HTTP error such as a 504, when `curlFails` is set.
 */
function toolbox(dir, { tarball, shellcheck, curlFails = false }) {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const tool of ['tar', 'gzip', 'sha256sum', 'cp', 'mkdir']) symlinkSync(which(tool), join(bin, tool));
  // `curl ... -o <file> <url>`: the URL is the last bare word. The numbers after `--retry` and the
  // like are bare words too, and are overwritten by the URL that follows them.
  writeFileSync(
    join(bin, 'curl'),
    `#!${BASH}\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -*) ;; *) url="$1" ;; esac; shift; done\n` +
      `printf '%s\\n' "$url" > '${join(dir, 'curl-url')}'\n` +
      (curlFails ? 'echo "curl: (22) The requested URL returned error: 504" >&2\nexit 22\n' : `cp '${tarball}' "$out"\n`),
  );
  chmodSync(join(bin, 'curl'), 0o755);
  if (shellcheck) {
    writeFileSync(join(bin, 'shellcheck'), `#!${BASH}\necho "ShellCheck fake"\n`);
    chmodSync(join(bin, 'shellcheck'), 0o755);
  }
  return bin;
}

/**
 * Run the install step. `cached` puts a file where the cache restores to first: `'release'` the
 * release tarball itself, `'tampered'` other bytes under its name. `curlFails` makes every download
 * fail as GitHub's release downloads did on 2026-11-08.
 */
function install(name, { sha, shellcheck = true, cached, curlFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'actionlint-pinned-'));
  const release = fakeRelease(dir);
  const temp = join(dir, 'runner-temp');
  mkdirSync(temp);
  if (cached !== undefined) {
    const cacheDir = join(temp, 'actionlint-cache');
    mkdirSync(cacheDir);
    const target = join(cacheDir, 'actionlint_1.7.12_linux_amd64.tar.gz');
    if (cached === 'release') writeFileSync(target, readFileSync(release.tarball));
    else writeFileSync(target, 'not the release\n');
  }
  const bin = toolbox(dir, { tarball: release.tarball, shellcheck, curlFails });
  const result = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', runScript(actionlintJob(name).text, INSTALL)], {
    encoding: 'utf8',
    env: { PATH: bin, RUNNER_TEMP: temp, ACTIONLINT_VERSION: '1.7.12', ACTIONLINT_SHA256: sha ?? release.sha },
  });
  const url = existsSync(join(dir, 'curl-url')) ? readFileSync(join(dir, 'curl-url'), 'utf8').trim() : '';
  const installed = existsSync(join(temp, 'actionlint'));
  const downloaded = url !== '';
  rmSync(dir, { recursive: true, force: true });
  return { code: result.status, output: `${result.stdout}${result.stderr}`, url, installed, downloaded };
}

for (const name of FILES) {
  test(`${name}: the matching hash installs actionlint from the release URL for that version`, () => {
    const run = install(name);
    assert.equal(run.code, 0, run.output);
    assert.equal(run.url, 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz');
    assert.equal(run.installed, true);
    assert.match(run.output, /fake actionlint --version/);
  });

  test(`${name}: a hash that does not match fails the step before anything is unpacked`, () => {
    const run = install(name, { sha: '0'.repeat(64) });
    assert.notEqual(run.code, 0, run.output);
    assert.match(run.output, /FAILED/);
    assert.equal(run.installed, false, 'an unverified binary was unpacked');
  });

  test(`${name}: a runner without shellcheck fails the step rather than linting without the shell checks`, () => {
    const run = install(name, { shellcheck: false });
    assert.notEqual(run.code, 0, run.output);
  });

  test(`${name}: a cached release whose hash matches installs with no download, so a release outage cannot fail it`, () => {
    const run = install(name, { cached: 'release', curlFails: true });
    assert.equal(run.code, 0, run.output);
    assert.equal(run.downloaded, false, 'the release was downloaded although the cache held it');
    assert.equal(run.installed, true);
    assert.match(run.output, /the cached release matches the pinned SHA-256/);
  });

  test(`${name}: a cached file whose hash does not match is downloaded again, and the download is checked`, () => {
    const run = install(name, { cached: 'tampered' });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /::warning::the cached actionlint release does not match the pinned SHA-256/);
    assert.equal(run.url, 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz');
    assert.equal(run.installed, true);
  });

  test(`${name}: a cached release is checked against the pinned hash too, and a mismatch installs nothing`, () => {
    const run = install(name, { cached: 'release', sha: '0'.repeat(64) });
    assert.notEqual(run.code, 0, run.output);
    assert.equal(run.installed, false, 'an unverified binary was unpacked');
  });

  test(`${name}: with nothing cached, a failed download fails the step and installs nothing`, () => {
    const run = install(name, { curlFails: true });
    assert.notEqual(run.code, 0, run.output);
    assert.equal(run.downloaded, true);
    assert.equal(run.installed, false);
  });
}

// ---------------------------------------------------------------------------
// The lint step, run
// ---------------------------------------------------------------------------

function lint(name, { workflows, exit = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'actionlint-lint-'));
  const repo = join(dir, 'repo');
  const temp = join(dir, 'runner-temp');
  mkdirSync(join(repo, WORKFLOWS), { recursive: true });
  mkdirSync(temp);
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet');
  for (const file of workflows) writeFileSync(join(repo, WORKFLOWS, file), 'on: push\n');
  writeFileSync(join(repo, WORKFLOWS, 'untracked.yml'), 'on: push\n');
  if (workflows.length > 0) git('add', ...workflows.map((file) => `${WORKFLOWS}/${file}`));
  writeFileSync(join(temp, 'actionlint'), `#!${BASH}\nprintf '%s\\n' "$@" > '${join(dir, 'argv')}'\nexit ${exit}\n`);
  chmodSync(join(temp, 'actionlint'), 0o755);
  const result = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', runScript(actionlintJob(name).text, LINT)], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: temp },
  });
  const argv = existsSync(join(dir, 'argv')) ? readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n') : null;
  rmSync(dir, { recursive: true, force: true });
  return { code: result.status, output: `${result.stdout}${result.stderr}`, argv };
}

for (const name of FILES) {
  test(`${name}: actionlint is handed every tracked workflow file, and nothing untracked`, () => {
    const run = lint(name, { workflows: ['a.yml', 'b.yaml'] });
    assert.equal(run.code, 0, run.output);
    assert.deepEqual(run.argv, ['-color', `${WORKFLOWS}/a.yml`, `${WORKFLOWS}/b.yaml`]);
    assert.match(run.output, /actionlint clean over 2 workflow file\(s\)\./);
  });

  test(`${name}: actionlint's own exit status decides the job`, () => {
    const run = lint(name, { workflows: ['a.yml'], exit: 1 });
    assert.equal(run.code, 1, run.output);
    assert.doesNotMatch(run.output, /actionlint clean/);
  });

  test(`${name}: a tree with no tracked workflow file fails rather than reporting clean over nothing`, () => {
    const run = lint(name, { workflows: [] });
    assert.equal(run.code, 1, run.output);
    assert.equal(run.argv, null, 'actionlint was run over nothing');
    assert.match(run.output, /::error::no workflow file found under \.github\/workflows\//);
  });
}
