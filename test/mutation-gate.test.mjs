// `scripts/mutation-gate.mjs`: the release's mutation gate. It runs no mutation: it reads the
// latest completed run of the caller's weekly mutation workflow on the default branch through the
// GitHub API and refuses the release when that run did not succeed or finished too long ago. A
// caller with no such workflow file skips, saying so by name; a caller that has one and whose
// result cannot be read is refused, never passed.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_MAX_AGE_DAYS, checkMutation, judgeRun, main } from '../scripts/mutation-gate.mjs';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** A completed run that finished `daysAgo` days before NOW. */
const runOf = (conclusion, daysAgo, extra = {}) => ({
  id: 42,
  html_url: 'https://github.com/example/lib/actions/runs/42',
  status: 'completed',
  conclusion,
  updated_at: iso(NOW - daysAgo * DAY),
  head_sha: 'a'.repeat(40),
  event: 'schedule',
  ...extra,
});

/** A fetch that answers each URL from `routes` (a prefix match), and records what it was asked. */
function fakeFetch(routes) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url: String(url), auth: init?.headers?.Authorization ?? init?.headers?.authorization });
    for (const [prefix, answer] of routes) {
      if (String(url).startsWith(prefix)) {
        if (answer instanceof Error) throw answer;
        return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, asked };
}

const API = 'https://api.example.test';
const REPO_URL = `${API}/repos/example/lib`;
const RUNS_URL = `${API}/repos/example/lib/actions/workflows/weekly-mutation.yml/runs`;

const base = (fetchImpl, extra = {}) => ({
  repository: 'example/lib',
  workflow: 'weekly-mutation.yml',
  maxAgeDays: DEFAULT_MAX_AGE_DAYS,
  apiBase: API,
  token: 'test-token',
  defaultBranchHint: '',
  fetchImpl,
  now: NOW,
  workflowOnDisk: true,
  ...extra,
});

test('the default age limit is 8 days', () => {
  assert.equal(DEFAULT_MAX_AGE_DAYS, 8);
});

test('a successful run inside the limit passes; any other conclusion, or an older run, refuses', () => {
  assert.equal(judgeRun(runOf('success', 2), { now: NOW, maxAgeDays: 8 }).verdict, 'pass');
  assert.equal(judgeRun(runOf('success', 7.9), { now: NOW, maxAgeDays: 8 }).verdict, 'pass');
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', 'stale', null]) {
    const judged = judgeRun(runOf(conclusion, 1), { now: NOW, maxAgeDays: 8 });
    assert.equal(judged.verdict, 'refuse', String(conclusion));
    assert.match(judged.message, /did not succeed/);
  }
  const old = judgeRun(runOf('success', 8.5), { now: NOW, maxAgeDays: 8 });
  assert.equal(old.verdict, 'refuse');
  assert.match(old.message, /finished 8\.5 day\(s\) ago, more than the 8 day\(s\) mutation-max-age-days allows/);
  assert.equal(judgeRun(runOf('success', 8.5), { now: NOW, maxAgeDays: 9 }).verdict, 'pass');
  assert.equal(judgeRun(runOf('success', 1, { updated_at: 'not a date' }), { now: NOW, maxAgeDays: 8 }).verdict, 'refuse');
});

test('it asks for the latest completed run on the default branch, and passes a fresh green one', async () => {
  const { fetchImpl, asked } = fakeFetch([
    [RUNS_URL, { body: { total_count: 3, workflow_runs: [runOf('success', 3)] } }],
    [REPO_URL, { body: { default_branch: 'trunk' } }],
  ]);
  const result = await checkMutation(base(fetchImpl));
  assert.equal(result.verdict, 'pass', result.message);
  assert.match(result.message, /https:\/\/github\.com\/example\/lib\/actions\/runs\/42/);
  const runs = new URL(asked.find((a) => a.url.startsWith(RUNS_URL)).url);
  assert.equal(runs.searchParams.get('branch'), 'trunk');
  assert.equal(runs.searchParams.get('status'), 'completed');
  assert.equal(runs.searchParams.get('per_page'), '1');
  assert.ok(asked.every((a) => a.auth === 'Bearer test-token'));
});

test('it refuses a failed latest run and a stale one', async () => {
  for (const [run, pattern] of [[runOf('failure', 1), /did not succeed/], [runOf('success', 12), /12 day\(s\) ago/]]) {
    const { fetchImpl } = fakeFetch([[RUNS_URL, { body: { total_count: 1, workflow_runs: [run] } }], [REPO_URL, { body: { default_branch: 'main' } }]]);
    const result = await checkMutation(base(fetchImpl));
    assert.equal(result.verdict, 'refuse');
    assert.match(result.message, pattern);
  }
});

test('no workflow file in the checkout skips, by name, and asks the API nothing', async () => {
  const { fetchImpl, asked } = fakeFetch([]);
  const result = await checkMutation(base(fetchImpl, { workflowOnDisk: false }));
  assert.equal(result.verdict, 'skip');
  assert.match(result.message, /has no \.github\/workflows\/weekly-mutation\.yml/);
  assert.deepEqual(asked, []);
});

test('a workflow with no completed run on the default branch refuses', async () => {
  const { fetchImpl } = fakeFetch([[RUNS_URL, { body: { total_count: 0, workflow_runs: [] } }], [REPO_URL, { body: { default_branch: 'main' } }]]);
  const result = await checkMutation(base(fetchImpl));
  assert.equal(result.verdict, 'refuse');
  assert.match(result.message, /no completed run on main/);
});

test('an unreadable result fails closed: a refused token, a 404, a 500, a network fault, a body with no runs', async () => {
  const cases = [
    [{ status: 403, body: { message: 'Resource not accessible by integration' } }, /actions: read/],
    [{ status: 404, body: { message: 'Not Found' } }, /HTTP 404/],
    [{ status: 500, body: {} }, /HTTP 500/],
    [new Error('socket hang up'), /socket hang up/],
    [{ status: 200, body: { total_count: 1 } }, /no workflow_runs list/],
  ];
  for (const [answer, pattern] of cases) {
    const { fetchImpl } = fakeFetch([[RUNS_URL, answer], [REPO_URL, { body: { default_branch: 'main' } }]]);
    const result = await checkMutation(base(fetchImpl));
    assert.equal(result.verdict, 'unreadable', String(pattern));
    assert.match(result.message, pattern);
  }
});

test('with no default branch from the API, the hint is used; with neither, it is unreadable', async () => {
  const hinted = fakeFetch([[RUNS_URL, { body: { total_count: 1, workflow_runs: [runOf('success', 1)] } }], [REPO_URL, { status: 500 }]]);
  assert.equal((await checkMutation(base(hinted.fetchImpl, { defaultBranchHint: 'main' }))).verdict, 'pass');
  const none = fakeFetch([[REPO_URL, { status: 500 }]]);
  assert.equal((await checkMutation(base(none.fetchImpl))).verdict, 'unreadable');
});

/** Run the CLI in a checkout that has (or lacks) the workflow file. */
async function cli(argv, { hasWorkflow = true, fetchImpl, env = {} } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'mutation-gate-'));
  if (hasWorkflow) {
    mkdirSync(join(repo, '.github/workflows'), { recursive: true });
    writeFileSync(join(repo, '.github/workflows/weekly-mutation.yml'), 'name: Weekly mutation\n');
  }
  const summary = join(repo, 'summary.md');
  const out = [];
  const code = await main(['--repo', repo, ...argv], {
    env: { GITHUB_REPOSITORY: 'example/lib', GITHUB_API_URL: API, GH_TOKEN: 'test-token', GITHUB_STEP_SUMMARY: summary, ...env },
    fetchImpl,
    now: NOW,
    out: (s) => out.push(s),
  });
  let written = '';
  try {
    written = readFileSync(summary, 'utf8');
  } catch {
    // no summary
  }
  return { code, out: out.join(''), summary: written };
}

test('the CLI exits 0 on a pass and on a skip, 1 on a refusal, 2 on an unreadable result', async () => {
  const fresh = fakeFetch([[RUNS_URL, { body: { total_count: 1, workflow_runs: [runOf('success', 1)] } }], [REPO_URL, { body: { default_branch: 'main' } }]]);
  const pass = await cli(['--workflow', 'weekly-mutation.yml', '--max-age-days', '8'], { fetchImpl: fresh.fetchImpl });
  assert.equal(pass.code, 0, pass.out);
  assert.match(pass.summary, /^### Mutation gate: pass$/m);

  const skip = await cli(['--workflow', 'weekly-mutation.yml', '--max-age-days', '8'], { hasWorkflow: false, fetchImpl: fresh.fetchImpl });
  assert.equal(skip.code, 0);
  assert.match(skip.out, /^mutation gate skipped: example\/lib has no \.github\/workflows\/weekly-mutation\.yml/m);

  const failed = fakeFetch([[RUNS_URL, { body: { total_count: 1, workflow_runs: [runOf('failure', 1)] } }], [REPO_URL, { body: { default_branch: 'main' } }]]);
  const refused = await cli(['--workflow', 'weekly-mutation.yml', '--max-age-days', '8'], { fetchImpl: failed.fetchImpl });
  assert.equal(refused.code, 1);
  assert.match(refused.out, /^::error title=Mutation gate refused::/m);

  const broken = fakeFetch([[RUNS_URL, { status: 403 }], [REPO_URL, { body: { default_branch: 'main' } }]]);
  const unreadable = await cli(['--workflow', 'weekly-mutation.yml', '--max-age-days', '8'], { fetchImpl: broken.fetchImpl });
  assert.equal(unreadable.code, 2);
  assert.match(unreadable.out, /^::error title=Mutation gate could not read the weekly result::/m);
});

test('the CLI refuses an input it cannot use, before it asks anything', async () => {
  const { fetchImpl, asked } = fakeFetch([]);
  for (const argv of [
    ['--workflow', '', '--max-age-days', '8'],
    ['--workflow', '../weekly.yml', '--max-age-days', '8'],
    ['--workflow', 'weekly-mutation', '--max-age-days', '8'],
    ['--workflow', 'weekly-mutation.yml', '--max-age-days', '0'],
    ['--workflow', 'weekly-mutation.yml', '--max-age-days', 'soon'],
    ['--workflow', 'weekly-mutation.yml', '--max-age-days', '400'],
  ]) {
    const result = await cli(argv, { fetchImpl });
    assert.equal(result.code, 2, JSON.stringify(argv));
  }
  const noRepo = await cli(['--workflow', 'weekly-mutation.yml', '--max-age-days', '8'], { fetchImpl, env: { GITHUB_REPOSITORY: '' } });
  assert.equal(noRepo.code, 2);
  assert.deepEqual(asked, []);
});
