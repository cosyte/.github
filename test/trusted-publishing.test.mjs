// Tests that `release.yml` publishes through npm trusted publishing (OIDC) and holds no npm token.
//
// WHAT TRUSTED PUBLISHING NEEDS, read 2026-10-19 at https://docs.npmjs.com/trusted-publishers: "npm
// CLI version 11.5.1 or later and Node version 22.14.0 or higher", "only cloud-hosted runners", and
// "the `id-token: write` permission, which allows GitHub Actions to generate OIDC tokens". With a
// reusable workflow, npm validates the CALLING workflow and "The `id-token: write` permission must
// also be given to both parent and child workflows". The tool versions are `publish-floor.mjs`'s to
// check at run time and `test/publish-floor.test.mjs`'s to pin; this file pins the workflow half:
//
//   - no npm token is declared, read or handed to any step, in any job, in any spelling;
//   - every job that publishes or stages grants `id-token: write` and runs on a GitHub-hosted runner;
//   - in each of those jobs the floor gate, which prints the tool and its version, runs first;
//   - the README tells a caller how publishing authenticates and what its npm entry must name.
//
// Each property is a function that THROWS, and each is shown to throw on a copy of the real file
// with one thing broken, so a green run here is not a reader that stopped reading.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { allSteps, effectivePermissions, NPM_SECRET_REF, parseWorkflow, readWorkflow, workflowPermissions } from './workflow-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(HERE, '../.github/workflows/release.yml');
const README = resolve(HERE, '../README.md');

/** Does this step publish or stage? Over-approximated on purpose: a step that COULD counts. */
const publishesOrStages = (step) =>
  step.with.publish !== undefined ||
  /staged-publish\.mjs stage|changeset publish|pnpm run release|npm publish|pnpm publish|npm stage publish|pnpm stage publish/.test(
    step.body,
  );

/** The jobs holding at least one step that publishes or stages. */
export function publishingJobs(workflow) {
  return workflow.jobs.filter((job) => job.steps.some(publishesOrStages));
}

/**
 * A runner label GitHub hosts. Trusted publishing "currently supports only cloud-hosted runners", so
 * a `self-hosted` label, a runner group or an expression is not something this can vouch for.
 */
const HOSTED_RUNNER = /^(?:ubuntu|windows|macos)-[\w.-]+$/;

/** No npm token anywhere in the file: not declared, not read, not handed to a step. */
export function assertNoNpmToken(text) {
  // The finish line's own check, `rg -n NPM_TOKEN`, made case-insensitive, because Actions reads
  // `secrets.npm_token` as the same secret.
  const hits = text.split('\n').flatMap((line, at) => (/npm_token/i.test(line) ? [`${at + 1}: ${line.trim()}`] : []));
  assert.deepEqual(hits, [], 'release.yml names an npm token');
  const workflow = parseWorkflow(text);
  for (const step of allSteps(workflow)) {
    assert.equal(step.env.NODE_AUTH_TOKEN, undefined, `"${step.label}" in \`${step.job}\` sets NODE_AUTH_TOKEN`);
    assert.equal(step.with['registry-url'], undefined, `"${step.label}" in \`${step.job}\` asks setup-node for a token file`);
    assert.doesNotMatch(step.body, NPM_SECRET_REF, `"${step.label}" in \`${step.job}\` reads an npm secret`);
  }
  for (const job of workflow.jobs) {
    assert.equal(job.blocks.env?.NODE_AUTH_TOKEN, undefined, `job \`${job.id}\` sets NODE_AUTH_TOKEN for every step`);
  }
}

/** Every publishing job grants `id-token: write`, runs on a hosted runner, and gates on the floor first. */
export function assertTrustedPublishingJobs(text) {
  const workflow = parseWorkflow(text);
  const jobs = publishingJobs(workflow);
  assert.ok(jobs.length > 0, 'no job publishes, so nothing below is checked');
  // The ceiling a caller grants, which the job's own block can only narrow.
  assert.equal(workflowPermissions(text)?.['id-token'], 'write', 'release.yml must request id-token: write of its caller');
  for (const job of jobs) {
    assert.equal(
      effectivePermissions(text, job)['id-token'],
      'write',
      `job \`${job.id}\` publishes or stages without id-token: write, so it has nothing to authenticate with`,
    );
    assert.match(
      job.keys['runs-on'] ?? '',
      HOSTED_RUNNER,
      `job \`${job.id}\` publishes on \`${job.keys['runs-on']}\`, and trusted publishing needs a GitHub-hosted runner`,
    );
    const gate = job.steps.findIndex((step) => /publish-floor\.mjs/.test(step.body));
    assert.ok(gate >= 0, `job \`${job.id}\` publishes without the floor gate that checks and prints the tool`);
    for (const step of job.steps.filter(publishesOrStages)) {
      assert.ok(step.index > gate, `"${step.label}" publishes before the floor gate has checked the tool`);
    }
  }
}

test('release.yml names no npm token, reads none and writes no token file', () => {
  assertNoNpmToken(readWorkflow(WORKFLOW, readFileSync));
});

test('every job that publishes or stages grants id-token: write, runs hosted, and gates on the floor first', () => {
  const text = readWorkflow(WORKFLOW, readFileSync);
  assertTrustedPublishingJobs(text);
  // Exactly the environment-held job, so nothing a human did not approve can make the exchange.
  const workflow = parseWorkflow(text);
  assert.deepEqual(publishingJobs(workflow).map((job) => job.id), ['release']);
  const holders = workflow.jobs.filter((job) => effectivePermissions(text, job)['id-token'] === 'write');
  assert.deepEqual(holders.map((job) => job.id), ['release'], 'only the publishing job may hold the OIDC credential');
});

test('the publish step takes no token and still asks for provenance from a public caller', () => {
  const workflow = parseWorkflow(readWorkflow(WORKFLOW, readFileSync));
  const publish = workflow.byId.release.steps.find((step) => step.with.publish !== undefined);
  assert.ok(publish, 'the publish step must be findable, or this proves nothing');
  assert.deepEqual(Object.keys(publish.env).sort(), ['GITHUB_TOKEN', 'NPM_CONFIG_PROVENANCE', 'STAGED_PUBLISH_REPORT']);
  assert.equal(publish.env.NPM_CONFIG_PROVENANCE, "${{ github.event.repository.visibility == 'public' }}");
});

test('each check above refuses a copy of release.yml with that one thing broken', () => {
  const text = readWorkflow(WORKFLOW, readFileSync);
  const once = (from, to) => {
    assert.equal(text.split(from).length, 2, `the mutation anchor ${JSON.stringify(from)} must occur exactly once`);
    return text.replace(from, to);
  };
  const releaseHeader = '  release:\n    needs: version\n';

  // A token handed back to the publish step, in either spelling.
  const provenance = "          NPM_CONFIG_PROVENANCE: ${{ github.event.repository.visibility == 'public' }}\n";
  for (const spelling of ['${{ secrets.NPM_TOKEN }}', "${{ secrets['npm_token'] }}"]) {
    assert.throws(() => assertNoNpmToken(once(provenance, `${provenance}          NODE_AUTH_TOKEN: ${spelling}\n`)));
  }
  // A token file asked of setup-node in the publishing job, which names no token at all.
  const node24 = 'would fail closed, not publish.\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n';
  assert.throws(
    () => assertNoNpmToken(once(node24, `${node24}          registry-url: "https://registry.npmjs.org"\n`)),
    /asks setup-node for a token file/,
  );
  // The publishing job without the permission, on a self-hosted runner, or with the gate after it.
  assert.throws(
    () => assertTrustedPublishingJobs(once('      id-token: write # npm trusted publishing (OIDC) and provenance\n', '')),
    /publishes or stages without id-token: write/,
  );
  const releaseRunsOn = text.slice(text.indexOf(releaseHeader)).match(/\n {4}runs-on: ubuntu-latest\n/);
  assert.ok(releaseRunsOn, 'the release job must run on ubuntu-latest for the next mutation to mean anything');
  const at = text.indexOf(releaseHeader) + releaseRunsOn.index;
  const selfHosted = `${text.slice(0, at)}\n    runs-on: [self-hosted, linux]\n${text.slice(at + releaseRunsOn[0].length)}`;
  assert.throws(() => assertTrustedPublishingJobs(selfHosted), /needs a GitHub-hosted runner/);
  assert.throws(
    () => assertTrustedPublishingJobs(once('node .cosyte-release-tooling/scripts/publish-floor.mjs', 'echo skipped')),
    /without the floor gate/,
  );
});

test('the README says how publishing authenticates and what each npm entry must name', () => {
  const readme = readFileSync(README, 'utf8');
  const row = readme.split('\n').find((line) => line.startsWith('| [`release.yml`]'));
  assert.ok(row, 'the README must keep its release.yml row');
  assert.match(row, /trusted publishing \(OIDC\)/, 'the release.yml row says how the publish authenticates');
  assert.match(row, /never `cosyte\/\.github`/, "the release.yml row says the entry names the caller's repository");
  assert.doesNotMatch(readme, /NPM_TOKEN \+/, 'the caller example still tells a caller to pass an npm token');

  const example = readme.slice(readme.indexOf('# <parser>/.github/workflows/release.yml'));
  const block = example.slice(0, example.indexOf('```'));
  assert.match(block, /secrets: inherit/);
  assert.doesNotMatch(block, /npm_token/i, 'the caller example names no npm token');
  assert.match(block, /\n {6}id-token: write/, 'the caller example grants id-token: write');
  assert.match(block, /trusted-publisher entry/, 'the caller example says what the npm entry must name');
  assert.match(block, /never cosyte\/\.github/);
});
