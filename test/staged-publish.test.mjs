// Tests for scripts/staged-publish.mjs, the command `release.yml` hands to `changesets/action` in
// place of the caller's `pnpm run release` when the package already exists on the registry, and for
// the `release.yml` wiring that keeps a staged version out of the three steps that assume a publish.
//
// WHAT THESE TESTS ARE FOR. Staging is strictly safer than what it replaces: a staged version nobody
// approves leaves the live registry exactly as it was, so the worst ORDINARY outcome here is a
// release that did not happen. There are exactly two ways to make it worse than the pipeline it
// replaces, and both are permanent:
//
//   FALLING BACK TO A DIRECT PUBLISH when staging fails. The version number is burned forever, and
//   the run reports it as the staging path working. Nothing can withdraw it.
//   PRINTING `New tag:`. `changesets/action` decides `published` by scanning the publish command's
//   stdout, and for a single-package repository, which every caller of this workflow is, the test is
//   the bare `/New tag:/`. One such line in our output and this pipeline cuts a GitHub release for a
//   version no consumer can resolve, tells cosyte/docs to rebuild against it, and points the
//   post-publish install gate at a version the registry will not serve.
//
// So the cases below are not really about staging. They are about those two, plus the reporting that
// makes a staged version something a maintainer knows to act on rather than a release that silently
// never happened.
//
// THE TOOL IS A REAL BINARY ON A REAL PATH, NOT AN INJECTED FUNCTION. Each end-to-end case writes an
// executable shim named `pnpm` or `npm`, puts its directory first on PATH, and runs the REAL entry
// point as a REAL child process. The shim APPENDS EVERY ARGV IT IS HANDED to a log, and the strongest
// assertions in this file are made against that log rather than against the source: what this script
// can be made to run is a question about behaviour, and `grep` does not answer it.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  CHANGESETS_NEW_TAG_PATTERNS,
  extractStageId,
  PNPM_STAGE_FLAGS,
  renderStageReport,
  reviewCommands,
  stagePublishArgs,
  suppressPublishMarkers,
} from '../scripts/staged-publish.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/staged-publish.mjs');
const WORKFLOW = resolve(HERE, '../.github/workflows/release.yml');

// ---------------------------------------------------------------------------
// A7 and A10, as a property of the only argument vector this script can build
// ---------------------------------------------------------------------------

test('A7/A10: the only verb this script can build is `stage publish`', () => {
  assert.deepEqual([...stagePublishArgs('pnpm')], ['stage', 'publish', ...PNPM_STAGE_FLAGS]);
  assert.deepEqual([...stagePublishArgs('npm')], ['stage', 'publish']);
  for (const tool of ['pnpm', 'npm']) {
    const args = stagePublishArgs(tool);
    assert.equal(args[0], 'stage', 'never a bare publish, which would be permanent');
    assert.equal(args[1], 'publish');
    for (const forbidden of ['approve', 'reject', 'unpublish', 'deprecate', 'dist-tag']) {
      assert.ok(!args.includes(forbidden), `${tool} args must never carry ${forbidden}`);
    }
    assert.throws(() => args.push('approve'), 'the vector is frozen, so nothing can append to it');
  }
});

test('`--no-git-checks` is on the pnpm arm only, because a built tree is a dirty tree', () => {
  assert.deepEqual([...PNPM_STAGE_FLAGS], ['--no-git-checks']);
  assert.ok(stagePublishArgs('pnpm').includes('--no-git-checks'));
  assert.ok(!stagePublishArgs('npm').includes('--no-git-checks'), 'npm has no such flag');
});

// ---------------------------------------------------------------------------
// A8: the `New tag:` marker, which is the mechanism the three downstream steps hang off
// ---------------------------------------------------------------------------

test('A8: the marker changesets reads is broken, and both of its patterns stop matching', () => {
  const real = [
    'ðŸ¦‹  info npm info @cosyte/hl7',
    'ðŸ¦‹  success packages published successfully:',
    'ðŸ¦‹  New tag:  @cosyte/hl7@0.0.8',
  ].join('\n');
  // The premise: unsuppressed, this text really would be read as a publish.
  for (const pattern of CHANGESETS_NEW_TAG_PATTERNS) {
    assert.match(real, pattern, 'if this stops matching, the suppression below proves nothing');
  }
  const safe = suppressPublishMarkers(real);
  for (const pattern of CHANGESETS_NEW_TAG_PATTERNS) {
    assert.doesNotMatch(safe, pattern);
  }
  // And the human can still read it.
  assert.match(safe, /@cosyte\/hl7@0\.0\.8/);
  assert.match(safe, /SUPPRESSED/);
});

test('A8: suppression is case insensitive and global, and survives odd input', () => {
  assert.doesNotMatch(suppressPublishMarkers('new tag: a@1\nNEW TAG: b@2'), /new tag:/i);
  assert.equal(suppressPublishMarkers(''), '');
  assert.equal(suppressPublishMarkers(undefined), '');
  assert.equal(suppressPublishMarkers('nothing to do'), 'nothing to do');
});

// ---------------------------------------------------------------------------
// A9: what a maintainer is told
// ---------------------------------------------------------------------------

test('extractStageId finds an id when the tool prints one, and admits it when it does not', () => {
  assert.equal(extractStageId('stage id: stg_9f2a41c0'), 'stg_9f2a41c0');
  assert.equal(extractStageId('Stage ID   4c1b8e77-0a2f'), '4c1b8e77-0a2f');
  assert.equal(extractStageId('staged as "stg-abcdef12"'), 'stg-abcdef12');
  assert.equal(extractStageId('uploaded, awaiting review'), null);
  assert.equal(extractStageId(''), null);
});

test('A9: the review commands name the package, and work with or without an id', () => {
  const withId = reviewCommands({ tool: 'pnpm', packageName: '@cosyte/hl7', stageId: 'stg_1' });
  assert.deepEqual(withId, [
    'pnpm stage list @cosyte/hl7',
    'pnpm stage view stg_1',
    'pnpm stage download stg_1',
  ]);
  const without = reviewCommands({ tool: 'npm', packageName: '@cosyte/hl7', stageId: null });
  assert.equal(without[0], 'npm stage list @cosyte/hl7', 'the location works with no identifier at all');
});

test('A9: the report carries the package, the version and how to look at the bytes', () => {
  const rendered = renderStageReport({
    packageName: '@cosyte/hl7',
    version: '0.0.8',
    tool: 'pnpm',
    stageId: 'stg_9f2a41c0',
  });
  assert.match(rendered, /@cosyte\/hl7/);
  assert.match(rendered, /0\.0\.8/);
  assert.match(rendered, /stg_9f2a41c0/);
  assert.match(rendered, /pnpm stage download stg_9f2a41c0/);
  assert.match(rendered, /STAGED, not published/);
  assert.match(rendered, /2FA/, 'and that promoting it is a human action');
  for (const pattern of CHANGESETS_NEW_TAG_PATTERNS) assert.doesNotMatch(rendered, pattern);
});

test('A9: with no parseable id the report still says where to look rather than going quiet', () => {
  const rendered = renderStageReport({
    packageName: '@cosyte/hl7',
    version: '0.0.8',
    tool: 'npm',
    stageId: null,
  });
  assert.match(rendered, /the first command below finds it/);
  assert.match(rendered, /npm stage list @cosyte\/hl7/);
});

// ---------------------------------------------------------------------------
// The real entry point, with a real binary on PATH that records what it was asked to do
// ---------------------------------------------------------------------------

const SHIM = (tool) => `#!/usr/bin/env node
const fs = require('node:fs');
const tool = ${JSON.stringify(tool)};
const args = process.argv.slice(2);
if (process.env.ARGV_LOG) fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify([tool, ...args]) + '\\n');
const key = (s) => process.env['FAKE_' + tool.toUpperCase() + '_' + s];
if (args[0] === '--version') {
  if (key('VERSION') === 'MISSING') process.exit(127);
  process.stdout.write((key('VERSION') || '1.0.0') + '\\n');
  process.exit(0);
}
process.stdout.write(key('STDOUT') || '');
process.stderr.write(key('STDERR') || '');
process.exit(Number(key('EXIT') || 0));
`;

function makeCaller({ packageManager = 'pnpm@11.17.0', version = '0.0.8', tools = ['pnpm', 'npm'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'staged-caller-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const tool of tools) {
    const file = join(bin, tool);
    writeFileSync(file, SHIM(tool));
    chmodSync(file, 0o755);
  }
  const repo = join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: '@cosyte/hl7', version, packageManager }, null, 2)}\n`,
  );
  writeFileSync(join(repo, 'pnpm-lock.yaml'), packageManager.startsWith('pnpm') ? 'lockfileVersion: 9\n' : '');
  if (!packageManager.startsWith('pnpm')) writeFileSync(join(repo, 'package-lock.json'), '{}');
  return {
    root,
    bin,
    repo,
    argvLog: join(root, 'argv.log'),
    report: join(root, 'staged-publish.json'),
    summary: join(root, 'summary.md'),
  };
}

/** Run the real entry point the way changesets/action does: a bare argv and a captured stdout. */
async function runScript(caller, argv, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...argv], {
      cwd: caller.repo,
      env: {
        PATH: `${caller.bin}:${process.env.PATH}`,
        ARGV_LOG: caller.argvLog,
        STAGED_PUBLISH_REPORT: caller.report,
        GITHUB_STEP_SUMMARY: caller.summary,
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const argvLog = (caller) => {
  if (!existsSync(caller.argvLog)) return [];
  return readFileSync(caller.argvLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

/** Every invocation that was NOT a version probe: what this script actually made the tool do. */
const actions = (caller) => argvLog(caller).filter((call) => call[1] !== '--version');

const STAGE_ARGS = ['--package', '@cosyte/hl7', '--repo', '.'];

test('A1: the happy path stages through pnpm and exits 0', async () => {
  const caller = makeCaller();
  const run = await runScript(caller, ['stage', ...STAGE_ARGS], {
    FAKE_PNPM_VERSION: '11.17.0',
    FAKE_PNPM_STDOUT: 'Uploaded to staging.\nstage id: stg_9f2a41c0\n',
  });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(actions(caller), [['pnpm', 'stage', 'publish', '--no-git-checks']]);

  const record = JSON.parse(readFileSync(caller.report, 'utf8'));
  assert.equal(record.package, '@cosyte/hl7');
  assert.equal(record.version, '0.0.8');
  assert.equal(record.tool, 'pnpm');
  assert.equal(record.stageId, 'stg_9f2a41c0');

  // A9 on the run's own output.
  assert.match(run.stdout, /@cosyte\/hl7@0\.0\.8/);
  assert.match(run.stdout, /stg_9f2a41c0/);
  assert.match(run.stdout, /pnpm stage list @cosyte\/hl7/);
  assert.match(run.stdout, /::notice title=A version is staged and awaiting a maintainer::/);
});

test('A8: even when the TOOL prints `New tag:`, this script own stdout does not', async () => {
  // The inverse defect, made to happen on purpose. A tool that borrowed changesets' phrasing, or a
  // caller lifecycle script that echoed it, would otherwise set `published=true` for a version no
  // consumer can resolve.
  const caller = makeCaller();
  const run = await runScript(caller, ['stage', ...STAGE_ARGS], {
    FAKE_PNPM_VERSION: '11.17.0',
    FAKE_PNPM_STDOUT: 'New tag:  @cosyte/hl7@0.0.8\nstage id: stg_1\n',
    FAKE_PNPM_STDERR: 'also New tag: @cosyte/hl7@0.0.8\n',
  });
  assert.equal(run.code, 0, run.stderr);
  for (const pattern of CHANGESETS_NEW_TAG_PATTERNS) {
    assert.doesNotMatch(run.stdout, pattern, 'changesets must not read this run as a publish');
    assert.doesNotMatch(run.stderr, pattern);
  }
  assert.match(run.stdout, /SUPPRESSED/, 'and the line is still there for a human to read');
});

test('A7: a failed staging FAILS THE RUN and does not publish as a fallback', async () => {
  const caller = makeCaller();
  const run = await runScript(caller, ['stage', ...STAGE_ARGS], {
    FAKE_PNPM_VERSION: '11.17.0',
    FAKE_PNPM_EXIT: '1',
    FAKE_PNPM_STDERR: 'ERR_PNPM_STAGE_FAILED  registry refused the upload\n',
  });
  assert.equal(run.code, 1, 'a failed stage has to reach changesets/action as a failed command');

  // THE ASSERTION THAT MATTERS: exactly one attempt, and it was a stage.
  assert.deepEqual(actions(caller), [['pnpm', 'stage', 'publish', '--no-git-checks']]);
  for (const call of actions(caller)) {
    assert.ok(!call.includes('publish') || call.includes('stage'), 'no bare publish, ever');
  }
  assert.equal(existsSync(caller.report), false, 'nothing is reported as staged that was not staged');
  assert.match(run.stderr, /does NOT fall back to a direct publish/i);
  assert.match(run.stderr, /registry refused the upload/, 'the tool own diagnosis survives');
  assert.match(run.stdout, /::error title=Staging failed, so nothing was published::/);
});

test('A7: a tool that is not installed at all fails the run and stages nothing', async () => {
  const caller = makeCaller({ tools: [] });
  const run = await runScript(caller, ['stage', ...STAGE_ARGS], { FAKE_PNPM_VERSION: '11.17.0' });
  assert.equal(run.code, 1);
  assert.deepEqual(actions(caller), []);
  assert.equal(existsSync(caller.report), false);
});

test('A6/A7: a tool below its floor is refused HERE too, so the two scripts cannot disagree', async () => {
  // `publish-floor.mjs` already decided this arm; its answer travels through a step output that a
  // future edit could widen or forget. This script re-derives it and refuses on its own account.
  const caller = makeCaller({ packageManager: 'pnpm@10.34.5' });
  const run = await runScript(caller, ['stage', ...STAGE_ARGS], {
    FAKE_PNPM_VERSION: '10.34.5',
    FAKE_NPM_VERSION: '10.9.8',
  });
  assert.equal(run.code, 1);
  assert.deepEqual(actions(caller), [], 'nothing was staged and nothing was published');
  assert.match(run.stderr, /does not clear the npm 11\.15\.0 floor/);
  assert.match(run.stderr, /Nothing was published and nothing was staged/);
});

test('a pnpm 10 caller whose npm clears the floor stages THROUGH npm, with no pnpm flags', async () => {
  const caller = makeCaller({ packageManager: 'pnpm@10.34.5' });
  const run = await runScript(caller, ['stage', ...STAGE_ARGS], {
    FAKE_PNPM_VERSION: '10.34.5',
    FAKE_NPM_VERSION: '11.17.0',
    FAKE_NPM_STDOUT: 'stage id: stg_npm_1\n',
  });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(actions(caller), [['npm', 'stage', 'publish']]);
  assert.equal(JSON.parse(readFileSync(caller.report, 'utf8')).tool, 'npm');
});

test('A6: a caller whose publish tool cannot be identified is refused, and nothing runs', async () => {
  const caller = makeCaller({ packageManager: 'yarn@4.9.1' });
  const run = await runScript(caller, ['stage', ...STAGE_ARGS]);
  assert.equal(run.code, 1);
  assert.deepEqual(actions(caller), []);
  assert.match(run.stderr, /Refusing to stage @cosyte\/hl7/);
});

test('a manifest with no version is refused rather than staged as `undefined`', async () => {
  const caller = makeCaller();
  writeFileSync(
    join(caller.repo, 'package.json'),
    `${JSON.stringify({ name: '@cosyte/hl7', packageManager: 'pnpm@11.17.0' }, null, 2)}\n`,
  );
  const run = await runScript(caller, ['stage', ...STAGE_ARGS], { FAKE_PNPM_VERSION: '11.17.0' });
  assert.equal(run.code, 1);
  assert.deepEqual(actions(caller), []);
  assert.match(run.stderr, /no `version` in/);
});

test('the CLI refuses a missing or unknown verb rather than defaulting to one that stages', async () => {
  const caller = makeCaller();
  for (const argv of [[], ['--package', '@cosyte/hl7'], ['promote', '--package', '@cosyte/hl7']]) {
    const run = await runScript(caller, argv, { FAKE_PNPM_VERSION: '11.17.0' });
    assert.equal(run.code, 2, `argv ${JSON.stringify(argv)} must not be taken as a stage`);
    assert.deepEqual(actions(caller), []);
  }
});

// ---------------------------------------------------------------------------
// A9 and A10 on the reporting step
// ---------------------------------------------------------------------------

test('A9: `report` puts the package, the version and the review route in the job summary', async () => {
  const caller = makeCaller();
  await runScript(caller, ['stage', ...STAGE_ARGS], {
    FAKE_PNPM_VERSION: '11.17.0',
    FAKE_PNPM_STDOUT: 'stage id: stg_9f2a41c0\n',
  });
  const run = await runScript(caller, ['report', '--package', '@cosyte/hl7']);
  assert.equal(run.code, 0, run.stderr);
  const summary = readFileSync(caller.summary, 'utf8');
  assert.match(summary, /@cosyte\/hl7/);
  assert.match(summary, /0\.0\.8/);
  assert.match(summary, /stg_9f2a41c0/);
  assert.match(summary, /pnpm stage download stg_9f2a41c0/);
  assert.match(run.stdout, /::warning title=A version is staged and awaiting a maintainer::/);
  assert.match(run.stdout, /NOT\s+resolvable to consumers/);
});

test('A9: `report` with no report file says nothing was staged, and does not invent one', async () => {
  const caller = makeCaller();
  const run = await runScript(caller, ['report', '--package', '@cosyte/hl7']);
  assert.equal(run.code, 0, 'a run that opened a version PR staged nothing, and that is not an error');
  assert.match(run.stdout, /staged nothing/);
  assert.doesNotMatch(run.stdout, /::warning title=A version is staged/);
});

test('A10/A3: across every arm, the tool is never asked to promote or discard anything', async () => {
  const callers = [];
  const make = async (env, packageManager) => {
    const caller = makeCaller(packageManager ? { packageManager } : {});
    await runScript(caller, ['stage', ...STAGE_ARGS], env);
    await runScript(caller, ['report', '--package', '@cosyte/hl7']);
    callers.push(caller);
  };
  await make({ FAKE_PNPM_VERSION: '11.17.0', FAKE_PNPM_STDOUT: 'stage id: stg_1\n' });
  await make({ FAKE_PNPM_VERSION: '11.17.0', FAKE_PNPM_EXIT: '1' });
  await make({ FAKE_PNPM_VERSION: '10.34.5', FAKE_NPM_VERSION: '11.17.0' }, 'pnpm@10.34.5');
  await make({ FAKE_PNPM_VERSION: '10.0.0', FAKE_NPM_VERSION: '10.9.8' }, 'pnpm@10.0.0');

  for (const caller of callers) {
    for (const call of argvLog(caller)) {
      const verb = call.slice(1).filter((a) => !a.startsWith('--'));
      assert.ok(
        verb.length === 0 || (verb[0] === 'stage' && verb[1] === 'publish'),
        `the only thing this script may run is \`stage publish\`, got ${JSON.stringify(call)}`,
      );
      for (const forbidden of ['approve', 'reject', 'unpublish', 'deprecate']) {
        assert.ok(!call.includes(forbidden), `${forbidden} must never be spawned: ${JSON.stringify(call)}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// THE WIRING: A8 and A10 asserted by parsing release.yml, with no release pending
// ---------------------------------------------------------------------------
//
// The step parser is a local copy rather than an import, and deliberately: importing another test
// file would register that file's whole suite a second time inside this one. `environment-gate`
// keeps its own copy for the same reason. `the parser still understands release.yml` below is what
// stops a drifted copy making every assertion here vacuous.

/** Every step of the `release` job, in order, with its comment lines stripped. */
function releaseSteps(workflow) {
  const job = workflow.slice(workflow.indexOf('\n  release:'));
  const chunks = job.slice(job.indexOf('\n    steps:')).split(/\n {6}- (?=\S)/).slice(1);
  return chunks.map((chunk, index) => {
    const body = chunk
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    /** @type {Record<string, string>} */
    const fields = {};
    const lines = body.split('\n');
    const first = /^([\w-]+):\s?(.*)$/.exec(lines[0]);
    if (first) fields[first[1]] = first[2];
    for (const line of lines.slice(1)) {
      const match = /^ {8}([\w-]+):\s?(.*)$/.exec(line);
      if (match) fields[match[1]] = match[2];
    }
    return { index, body, fields, label: fields.name || fields.uses || `step ${index}` };
  });
}

test('the parser still understands release.yml, or every assertion below is vacuous', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));
  // The floor moved with the file: `release.yml` was one job of ~24 steps when this number was
  // written, and the environment split left the PUBLISHING job at 18. The count is joined by the
  // start-of-job check below, which a drifted slice cannot satisfy by accident.
  assert.ok(steps.length >= 15, `expected the release job's full step list, parsed ${steps.length}`);
  assert.match(steps[0].body, /actions\/checkout@/, 'the slice must start at the publishing job, not mid-job');
  assert.equal(steps.filter((s) => /changesets\/action@/.test(s.body)).length, 1);
  // Two sites, and they are different things: the publish input that SELECTS the staged command,
  // and the step that reports what it staged.
  assert.equal(steps.filter((s) => /staged-publish\.mjs stage/.test(s.body)).length, 1);
  assert.equal(steps.filter((s) => /staged-publish\.mjs report/.test(s.body)).length, 1);
});

test('A8: the three steps that assume a publish are all closed to a staged version', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));

  const release = steps.find((s) => /Publish the GitHub release \+ dispatch docs rebuild/.test(s.label));
  const install = steps.find((s) => /must be installable from the registry/.test(s.label));
  assert.ok(release && install, 'both downstream steps must still be findable');

  for (const step of [release, install]) {
    assert.match(step.fields.if, /steps\.changesets\.outputs\.published == 'true'/, step.label);
    assert.match(
      step.fields.if,
      /steps\.publish-floor\.outputs\.mode != 'staged'/,
      `${step.label} must be closed to a staged version explicitly, not only by inference`,
    );
  }

  // The GitHub release and the docs dispatch are one step, so closing it closes both behaviours.
  assert.match(release.body, /gh release create|gh release edit/);
  assert.match(release.body, /repos\/cosyte\/docs\/dispatches/);
});

test('A9: a staged run has a step whose whole job is telling a maintainer', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));
  const report = steps.filter((s) => /staged-publish\.mjs report/.test(s.body));
  assert.equal(report.length, 1);
  assert.match(report[0].fields.if, /steps\.publish-floor\.outputs\.mode == 'staged'/);
  assert.match(report[0].fields.if, /!cancelled\(\)/, 'a failure earlier must not hide a real stage');

  // It has to follow the publish step, or there is nothing to report yet.
  const action = steps.findIndex((s) => /changesets\/action@/.test(s.body));
  assert.ok(report[0].index > action);
});

test('A10: no step in the release workflow promotes or discards a staged version', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));
  for (const step of steps) {
    for (const forbidden of [/stage\s+approve/, /stage\s+reject/, /npm\s+unpublish/, /pnpm\s+unpublish/]) {
      assert.doesNotMatch(
        step.body,
        forbidden,
        `${step.label} must not run ${forbidden}; approval needs 2FA and belongs to a human`,
      );
    }
  }
});

test('A11: both new scripts are reachable from the tooling checkout the job actually makes', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  for (const script of ['publish-floor.mjs', 'staged-publish.mjs']) {
    assert.match(
      workflow,
      new RegExp(`\\.cosyte-release-tooling/scripts/${script.replace('.', '\\.')}`),
      `${script} has to be invoked from the pinned tooling checkout, not the caller's tree`,
    );
  }
});
