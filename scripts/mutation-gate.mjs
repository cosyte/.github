#!/usr/bin/env node
// @ts-check
//
// THE RELEASE'S MUTATION GATE, AND IT RUNS NO MUTATION. A full mutation run of a large library takes
// hours, so it never sits in front of a release: `weekly-mutation.yml` runs it on a schedule, sharded
// and incremental, and holds each package's score to its floor. What a release asks is whether that
// run's latest result on the default branch is green and recent, and this reads exactly that through
// the GitHub API with the automatic token, at `actions: read`, which `release.yml`'s `version` job
// already holds for its environment gate.
//
//   node mutation-gate.mjs --repo . --workflow weekly-mutation.yml --max-age-days 8
//
// THE VERDICTS, AND WHICH WAY EACH FAILS.
//   pass        the latest completed run on the default branch concluded `success` and finished no
//               more than `--max-age-days` ago. Exit 0.
//   skip        the caller has no `.github/workflows/<workflow>` in the checkout being released: it
//               has not adopted the weekly run, and the gate says so by name. Exit 0. Read from the
//               checkout, NOT from the API, on purpose: a token without `actions: read` gets a 404
//               from the workflows endpoint on a private repository, and reading that 404 as "no
//               workflow" would turn a missing grant into a pass.
//   refuse      the latest completed run did not succeed (any conclusion but `success`, a cancelled or
//               timed-out run included), finished too long ago, or there is no completed run on the
//               default branch at all. Exit 1.
//   unreadable  the API did not answer, refused the token, or answered with something this cannot
//               read. Exit 2. Fails closed: a result nobody could read is not a result.
//
// The age is read from the run's `updated_at`, the time GitHub last changed it, which for a
// completed run is when it finished (or was last re-run). Node built-ins only.

import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** How old, in days, the latest green weekly run may be. Eight: a weekly schedule plus a day. */
export const DEFAULT_MAX_AGE_DAYS = 8;

/** The longest age a caller may allow: three months of a schedule that stopped is not a result. */
export const MAX_ALLOWED_AGE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

/** A workflow file name, and nothing that could leave `.github/workflows/`. */
const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/;

/** A day count, to one decimal place, for a message. */
const days = (ms) => `${Math.round((ms / DAY_MS) * 10) / 10}`;

/**
 * Judge one completed run.
 *
 * @param {any} run A workflow run, as the API returns it.
 * @param {{ now: number, maxAgeDays: number }} limits
 * @returns {{ verdict: 'pass' | 'refuse', message: string }}
 */
export function judgeRun(run, { now, maxAgeDays }) {
  const where = run?.html_url ? ` (${run.html_url})` : '';
  if (run?.conclusion !== 'success') {
    return { verdict: 'refuse', message: `the latest weekly mutation run${where} did not succeed: it concluded ${JSON.stringify(run?.conclusion ?? null)}` };
  }
  const finished = Date.parse(String(run?.updated_at ?? ''));
  if (!Number.isFinite(finished)) {
    return { verdict: 'refuse', message: `the latest weekly mutation run${where} has no finish time this can read (${JSON.stringify(run?.updated_at ?? null)})` };
  }
  const age = now - finished;
  if (age > maxAgeDays * DAY_MS) {
    return {
      verdict: 'refuse',
      message: `the latest weekly mutation run${where} succeeded but finished ${days(age)} day(s) ago, more than the ${maxAgeDays} day(s) mutation-max-age-days allows`,
    };
  }
  return { verdict: 'pass', message: `the latest weekly mutation run${where} succeeded ${days(Math.max(0, age))} day(s) ago, inside the ${maxAgeDays} day(s) allowed` };
}

/** GET a URL from the API. Never rejects. */
async function get(url, fetchImpl, token) {
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'cosyte-release-mutation-gate',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(signal ? { signal } : {}),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: Number(res?.status ?? 0), body, error: '' };
  } catch (error) {
    return { status: 0, body: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Why a read did not answer, in words a maintainer can act on. */
function whyUnreadable(url, answer) {
  if (answer.status === 0) return `${url} could not be reached: ${answer.error}`;
  if (answer.status === 401 || answer.status === 403) {
    return `${url} answered HTTP ${answer.status}: the token cannot read workflow runs. The calling job must grant \`actions: read\`, which release.yml already asks of every caller`;
  }
  return `${url} answered HTTP ${answer.status}`;
}

/**
 * Read the latest completed run of `workflow` on the default branch, and judge it.
 *
 * @param {{
 *   repository: string, workflow: string, maxAgeDays: number, apiBase: string, token: string,
 *   defaultBranchHint: string, fetchImpl: any, now: number, workflowOnDisk: boolean,
 * }} input
 * @returns {Promise<{ verdict: 'pass' | 'skip' | 'refuse' | 'unreadable', message: string }>}
 */
export async function checkMutation({ repository, workflow, maxAgeDays, apiBase, token, defaultBranchHint, fetchImpl, now, workflowOnDisk }) {
  if (!workflowOnDisk) {
    return {
      verdict: 'skip',
      message: `${repository} has no .github/workflows/${workflow}, so it has not adopted the weekly mutation run and no mutation result gates this release`,
    };
  }
  const repoUrl = `${apiBase}/repos/${repository}`;
  const repo = await get(repoUrl, fetchImpl, token);
  let branch = repo.status === 200 && typeof repo.body?.default_branch === 'string' ? repo.body.default_branch : '';
  if (!branch) branch = String(defaultBranchHint ?? '').trim();
  if (!branch) {
    return { verdict: 'unreadable', message: `the default branch of ${repository} could not be read (${whyUnreadable(repoUrl, repo)}), and no hint was passed in` };
  }
  const query = new URLSearchParams({ branch, status: 'completed', per_page: '1', exclude_pull_requests: 'true' });
  const runsUrl = `${apiBase}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`;
  const runs = await get(runsUrl, fetchImpl, token);
  if (runs.status !== 200) {
    const extra = runs.status === 404 ? `, though .github/workflows/${workflow} is in the checkout` : '';
    return { verdict: 'unreadable', message: `${whyUnreadable(runsUrl, runs)}${extra}` };
  }
  if (!Array.isArray(runs.body?.workflow_runs)) {
    return { verdict: 'unreadable', message: `${runsUrl} answered with no workflow_runs list` };
  }
  const [run] = runs.body.workflow_runs;
  if (run === undefined) {
    return {
      verdict: 'refuse',
      message: `${workflow} has no completed run on ${branch}, so there is no mutation result for this release to read. Run it (workflow_dispatch) and release once it is green`,
    };
  }
  return judgeRun(run, { now, maxAgeDays });
}

/** `--flag value` pairs, each flag at most once. */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!['--repo', '--workflow', '--max-age-days'].includes(flag)) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  return flags;
}

/**
 * Run the gate.
 *
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: any, now?: number, out?: (s: string) => void }} [io]
 * @returns {Promise<number>} The exit code.
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.out ?? ((s) => process.stdout.write(s));
  const summary = (title, message) => {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Mutation gate: ${title}\n\n${message}\n\n`);
  };
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    out(`::error title=Mutation gate refused its input::${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const workflow = flags.workflow ?? '';
  const ageText = flags['max-age-days'] ?? String(DEFAULT_MAX_AGE_DAYS);
  const maxAgeDays = /^\d+(\.\d+)?$/.test(ageText) ? Number(ageText) : Number.NaN;
  const repository = String(env.GITHUB_REPOSITORY ?? '');
  const problems = [];
  if (!WORKFLOW_FILE.test(workflow)) problems.push(`mutation-workflow must be a workflow file name such as weekly-mutation.yml, not ${JSON.stringify(workflow)}`);
  if (!(maxAgeDays > 0 && maxAgeDays <= MAX_ALLOWED_AGE_DAYS)) {
    problems.push(`mutation-max-age-days must be a number of days above 0 and at most ${MAX_ALLOWED_AGE_DAYS}, not ${JSON.stringify(ageText)}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) problems.push(`GITHUB_REPOSITORY must name the repository, not ${JSON.stringify(repository)}`);
  if (problems.length > 0) {
    for (const problem of problems) out(`::error title=Mutation gate refused its input::${problem}\n`);
    return 2;
  }
  const repo = path.resolve(flags.repo ?? '.');
  const result = await checkMutation({
    repository,
    workflow,
    maxAgeDays,
    apiBase: env.GITHUB_API_URL || 'https://api.github.com',
    token: env.GH_TOKEN || '',
    defaultBranchHint: env.DEFAULT_BRANCH_HINT || '',
    fetchImpl: io.fetchImpl ?? globalThis.fetch,
    now: io.now ?? Date.now(),
    workflowOnDisk: existsSync(path.join(repo, '.github', 'workflows', workflow)),
  });
  switch (result.verdict) {
    case 'pass':
      out(`mutation gate passed: ${result.message}\n`);
      summary('pass', `${result.message[0].toUpperCase()}${result.message.slice(1)}. No mutation run was started for this release.`);
      return 0;
    case 'skip':
      out(`mutation gate skipped: ${result.message}\n`);
      summary('skipped', `${result.message[0].toUpperCase()}${result.message.slice(1)}.`);
      return 0;
    case 'refuse':
      out(`::error title=Mutation gate refused::Nothing was published: ${result.message}.\n`);
      summary('refused', `Nothing was published: ${result.message}. Re-run this job once the weekly run is green and recent.`);
      return 1;
    default:
      out(`::error title=Mutation gate could not read the weekly result::Nothing was published: ${result.message}.\n`);
      summary('could not read the weekly result', `Nothing was published: ${result.message}.`);
      return 2;
  }
}

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stdout.write(`::error title=Mutation gate did not complete::Nothing was published: ${error?.message ?? error}\n`);
      process.exitCode = 2;
    },
  );
}
