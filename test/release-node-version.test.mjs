// release.yml's `node-version` input: the Node line every job that sets up Node runs on.
//
// Empty, the default, keeps each job on the line it ran on before the input existed (`version` on
// 22, `release` and `finalize` on 24), so a caller passing nothing runs exactly as it did. A value
// applies to all three jobs, and it must be 24 or later because the `release` job publishes on it
// and Node 22's npm is below the publish floor. The `version` job refuses anything else before it
// installs, tags or publishes. These tests pin all of that to the file, and run the refusal itself.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readWorkflowInterface } from '../scripts/reference-publish.mjs';
import { conditionsOf, parseWorkflow, readWorkflow } from './workflow-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = 'release.yml';
const WORKFLOW = resolve(HERE, '../.github/workflows', FILE);
const CHECK = 'The node-version input must be 24 or later';

/** The line each job ran on before the input existed, which an empty input must keep. */
const TODAY = { version: '22', release: '24', finalize: '24' };

const text = () => readWorkflow(WORKFLOW, readFileSync);
const isSetupNode = (step) => (step.fields.uses ?? '').startsWith('actions/setup-node@');

test('the input is optional and empty by default, so no caller has to pass it', () => {
  const read = readWorkflowInterface(text(), FILE);
  assert.equal(read.ok, true, read.ok ? '' : read.reason);
  const declared = read.interface.inputs['node-version'];
  assert.ok(declared, '`node-version` must be declared');
  assert.equal(declared.type, 'string');
  assert.equal(declared.required, false);
  assert.equal(declared.default.present, true);
  assert.equal(declared.default.value, '');
});

test('every job that sets up Node reads the input, falling back to the line it ran on before', () => {
  const { jobs } = parseWorkflow(text());
  const setups = Object.fromEntries(jobs.map((job) => [job.id, job.steps.filter(isSetupNode)]));
  for (const [id, steps] of Object.entries(setups)) {
    if (steps.length === 0) continue;
    assert.ok(id in TODAY, `job \`${id}\` sets Node up and has no line recorded here`);
  }
  for (const [id, line] of Object.entries(TODAY)) {
    assert.equal(setups[id]?.length, 1, `job \`${id}\` sets Node up once`);
    assert.equal(setups[id][0].with['node-version'], `\${{ inputs.node-version || '${line}' }}`, `job \`${id}\``);
  }
});

test('the version job refuses the input before it sets Node up, installs or tags', () => {
  const { byId } = parseWorkflow(text());
  const steps = byId.version.steps;
  const check = steps.findIndex((step) => step.fields.name === CHECK);
  assert.ok(check >= 0, `the version job must carry "${CHECK}"`);
  assert.equal(steps[check].env.NODE_VERSION_INPUT, '${{ inputs.node-version }}');
  assert.equal(conditionsOf(steps[check]).trim(), '', 'the check must run on every path');
  const later = (match) => {
    const at = steps.findIndex(match);
    assert.ok(at >= 0);
    assert.ok(check < at, `the check must precede step ${at}`);
  };
  later(isSetupNode);
  later((step) => /pnpm install/.test(step.fields.run ?? ''));
  later((step) => /release-tag\.mjs/.test(step.fields.run ?? ''));
  // `release` and `finalize` both need `version`, so a refusal there stops every job on the value.
  for (const id of ['release', 'finalize']) assert.equal(byId[id].keys.needs, 'version', `job \`${id}\``);
});

test('the input is never shell text: it reaches setup-node and one env entry only', () => {
  const readers = text()
    .split('\n')
    .filter((line) => /inputs\.node-version/.test(line) && !/^\s*#/.test(line))
    .map((line) => line.trim());
  assert.deepEqual(readers.sort(), [
    'NODE_VERSION_INPUT: ${{ inputs.node-version }}',
    "node-version: ${{ inputs.node-version || '22' }}",
    "node-version: ${{ inputs.node-version || '24' }}",
    "node-version: ${{ inputs.node-version || '24' }}",
  ].sort());
});

/** The check's own script, as GitHub runs it: the step's `run: |` block, dedented. */
function checkScript() {
  const step = parseWorkflow(text()).byId.version.steps.find((candidate) => candidate.fields.name === CHECK);
  assert.ok(step, `the version job must carry "${CHECK}"`);
  const lines = step.body.split('\n');
  const runAt = lines.findIndex((line) => line === '        run: |');
  assert.ok(runAt >= 0, 'the check must be a `run: |` block');
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

function verdict(value) {
  try {
    execFileSync('bash', ['-e', '-c', checkScript()], {
      env: { PATH: process.env.PATH, NODE_VERSION_INPUT: value },
      stdio: 'pipe',
    });
    return 'pass';
  } catch (error) {
    assert.equal(error.status, 1, `${JSON.stringify(value)}: ${error.stderr}`);
    assert.match(String(error.stdout), /::error title=node-version refused::/);
    return 'refused';
  }
}

test('the check passes empty and every version of 24 or later, and refuses the rest', () => {
  for (const value of ['', '24', '24.18.0', '24.x', 'v24', 'v26.1', '26', '30.0.0']) {
    assert.equal(verdict(value), 'pass', JSON.stringify(value));
  }
  // Below the publish floor, an alias that could resolve to anything, and text that is not a version.
  for (const value of ['22', '22.14.0', 'v22', '23.11.1', '8', 'lts/*', 'node', 'latest', '>=24', ' 24', '24; true', '24.1.2.3']) {
    assert.equal(verdict(value), 'refused', JSON.stringify(value));
  }
});
