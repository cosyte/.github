#!/usr/bin/env node
// @ts-check
//
// THE HUMAN GATE ON `npm publish` WAS ASSERTED IN A COMMENT AND PROVED BY NOTHING.
//
// `release.yml` puts its one job in `environment: release` and a comment above that key claimed
// every caller had configured that environment with a required reviewer and a main-only deployment
// branch policy. Nothing read a caller's actual configuration. A `release` environment carrying NO
// protection rules produces a run that looks IDENTICAL to a genuinely gated one: same environment
// badge on the job, same green steps, no approval prompt and no way to tell from the run that there
// was never anything to approve. Thirteen repositories publish healthcare parsers to a public
// registry through that one workflow, and a published version is permanent (ADR 0001).
//
// This gate reads the CALLING repository's `release` environment before anything is packed and
// refuses the run, naming the repository and the specific rule, when the gate is not really there.
//
// ---------------------------------------------------------------------------
// WHAT IT READS, WITH WHICH CREDENTIAL, AND WHY THAT IS NOT A CROSS-REPO READ
// ---------------------------------------------------------------------------
//
// A reusable workflow's `github` context "is always associated with the caller workflow" and the
// called workflow "is automatically granted access to `github.token` and `secrets.GITHUB_TOKEN`",
// whose "permissions are limited to the repository that contains your workflow". So
// `GITHUB_REPOSITORY` inside `release.yml` IS the calling repository and this is a repository
// reading its OWN environments with the automatic token. No second credential exists and none is
// needed.
//
//   GET /repos/{owner}/{repo}                                                    Metadata: read
//   GET /repos/{owner}/{repo}/environments                                       Actions: read
//   GET /repos/{owner}/{repo}/environments/{name}                                Actions: read
//   GET /repos/{owner}/{repo}/environments/{name}/deployment-branch-policies     Actions: read
//
// `Metadata: read` is not a `permissions:` key at all and is always present; `actions: read` is one,
// and `release.yml` declares it ALONGSIDE the permissions that job already held rather than in place
// of them, because declaring any permission sets every undeclared one to `none`. See the header of
// `.github/workflows/release.yml` for the caller-side grant that goes with it.
//
// ---------------------------------------------------------------------------
// EVERY BRANCH ENDS IN A REFUSAL, SO A MISCLASSIFICATION CHANGES THE WORDING AND NEVER THE OUTCOME
// ---------------------------------------------------------------------------
//
//   the environment read returns `release`            evaluate the two rules against it
//   the environment LIST read succeeds and carries    NO protection at all: the SAME case as a
//     no environment named `release`                  `release` returned with an empty protection
//                                                     set, and the same refusal text
//   a read is refused for want of permission          unreadable, permission (names the grant)
//   any other non-success: transport, rate limit,     unreadable, other
//     5xx, or a body that does not parse
//
// THE LIST READ IS THE DISAMBIGUATOR, and it is why a bare 404 on the single environment is not
// decided on its own: a 404 is ambiguous between "absent" and "not permitted", and a SUCCESSFUL list
// read proves the token could see this repository's environments and that the named one is genuinely
// not among them.
//
// ROWS ONE AND TWO ARE ONE CASE. An environment created automatically on first reference and one a
// maintainer created and left unprotected produce an IDENTICAL payload, so no run can separate them
// and this gate never tries. The absent-from-the-list case is evaluated through the SAME code path,
// against `{protection_rules: [], deployment_branch_policy: null}`, which is what makes the two
// refusals byte-identical rather than merely similar. `test/environment-gate.test.mjs` asserts that
// equality directly, because "the same wording" is the sort of claim that decays into two wordings
// one edit at a time.
//
// ---------------------------------------------------------------------------
// THE LIST READS ARE EXHAUSTED, NOT SAMPLED
// ---------------------------------------------------------------------------
//
// Both list endpoints paginate at `per_page` default 30, `page` default 1, and both report
// `total_count`. "No `release` in the list" is only TRUE of an exhaustive read: a caller holding more
// than thirty environments would otherwise be refused for a `release` sitting on page two, which is
// a false refusal of a fully compliant repository. The same argument decides the branch-policy read,
// where a first page carrying one pattern out of two would otherwise PASS a caller whose policy is
// not limited to the default branch, which is the false-green direction and worse. So both reads
// walk pages until `total_count` is satisfied, and a walk that cannot be completed is `unreadable`
// rather than an answer.
//
// ---------------------------------------------------------------------------
// WHERE `default_branch` COMES FROM, SINCE IT IS IN NEITHER ENVIRONMENT PAYLOAD
// ---------------------------------------------------------------------------
//
// Four of the branch-policy verdicts name the default branch and the passing one compares against
// it, and neither the environment payload nor the branch-policy payload carries it. It is read from
// `GET /repos/{owner}/{repo}`, which sits under `Metadata: read`: not a `permissions:` key, always
// granted, and therefore nothing a caller can accidentally withhold. The `github` context value
// (`github.event.repository.default_branch`, passed in as `DEFAULT_BRANCH_HINT`) is the FALLBACK
// rather than the primary, so that the live branch policy is compared against a default branch read
// on the same clock; the hint covers the events whose payload carries no `repository` object.
//
// AN EMPTY DEFAULT BRANCH IS NEVER COMPARED. If both sources come up empty the run fails as
// `unreadable`, naming the repository and the reason, and NOT as a branch-policy finding: an empty
// comparand would refuse a fully compliant caller and blame its configuration for it.
//
// Exit codes: 0 the caller's `release` environment is protected, 1 it is not or could not be read,
// 2 bad usage.

import { resolve } from 'node:path';
import process from 'node:process';

/** The two reads' page size. 100 is the documented maximum; the default of 30 is what F12 is about. */
const PER_PAGE = 100;

/**
 * A hard stop on the pagination walk, so a `total_count` that never converges cannot spin forever.
 * 50 pages of 100 is 5000 environments; a caller anywhere near it is not a state this org has, and
 * reaching it yields `unreadable` rather than a verdict, which is the fail-closed direction.
 */
const MAX_PAGES = 50;

/** Node's `fetch` has no default request timeout. An unbounded read here would hang the release job. */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export const ENVIRONMENT_DEFAULT = 'release';

/**
 * The payload a repository with no `release` environment is evaluated against.
 *
 * It is a CONSTANT rather than a special case in the evaluator, because AC4's whole content is that
 * the two inputs which can present "no protection at all" produce one refusal text. Routing them
 * both through `evaluateEnvironment` makes that true by construction instead of by two message
 * builders staying in step.
 */
export const NO_PROTECTION_AT_ALL = Object.freeze({
  protection_rules: [],
  deployment_branch_policy: null,
});

/**
 * Wrap a fetch so every request carries a deadline, preserving a caller's own signal if it set one.
 *
 * @param {(url: string, options?: any) => Promise<any>} fetchImpl
 * @param {number} timeoutMs
 */
export function withFetchTimeout(fetchImpl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  if (!timeoutMs || typeof AbortSignal?.timeout !== 'function') return fetchImpl;
  return (/** @type {string} */ url, /** @type {any} */ options = {}) =>
    fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMs) });
}

// ── The two rules ───────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a protection rule's `type` so `required_reviewers`, `requiredReviewers` and
 * `required-reviewers` are one thing.
 *
 * The committed corpus documents `protection_rules` only as "array of object" and does not fix the
 * discriminator's spelling, so the shape read here is the running API's. Normalizing costs nothing
 * and removes a spelling from the list of things that could turn a real reviewer rule into a
 * refusal.
 *
 * @param {unknown} value
 */
export function ruleKind(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Whether the environment requires at least one reviewer.
 *
 * The rule being absent, and the rule being present with an empty reviewer list, are the same
 * answer: no human is required. Anything this cannot positively read as "at least one reviewer is
 * required" is a refusal, because the whole point of the phase is to stop accepting an unproven
 * claim about a human gate.
 *
 * @param {any} environment the `Get an environment` payload
 */
export function hasRequiredReviewer(environment) {
  const rules = Array.isArray(environment?.protection_rules) ? environment.protection_rules : [];
  return rules.some(
    (rule) => ruleKind(rule?.type) === 'requiredreviewers' && Array.isArray(rule?.reviewers) && rule.reviewers.length > 0,
  );
}

/** A branch PATTERN, as opposed to a literal branch name. `fnmatch` metacharacters, per [P3]. */
const WILDCARD = /[*?[\]]/;

/**
 * Evaluate "a deployment branch policy limited to the default branch" and name the failure the way
 * the contract names it.
 *
 * The reading, in full: the policy is a CUSTOM branch policy carrying exactly one branch pattern,
 * and that pattern is the literal value of the repository's `default_branch` with no wildcard
 * character in it. Anything else refuses.
 *
 * PROTECTED-BRANCHES-ONLY IS REFUSED DELIBERATELY rather than accepted as a near miss. The set of
 * protected branches is caller state this workflow cannot enumerate or bound from the environment
 * payload, so accepting it would be accepting an unproven claim, which is the exact failure this
 * gate closes. The platform says the same thing outright: "If no branch protection rules are defined
 * for any branch in the repository, then all branches can deploy."
 *
 * @param {any} environment the `Get an environment` payload
 * @param {{name?: string, type?: string}[]} branchPolicies the `List deployment branch policies` items
 * @param {string} defaultBranch
 * @returns {string|null} the refusal wording, or null when the rule holds
 */
export function branchPolicyFailure(environment, branchPolicies, defaultBranch) {
  const policy = environment?.deployment_branch_policy;

  // `null` is the platform's own spelling of "all branches deploy". An object with neither flag set
  // is not a state the API documents (exactly one of the two must be true) and restricts nothing
  // this gate can prove, so it is read the same way rather than given a wording of its own.
  if (!policy || (policy.protected_branches !== true && policy.custom_branch_policies !== true)) {
    return 'deployment branch policy: all branches';
  }

  if (policy.protected_branches === true) {
    return `deployment branch policy: protected branches, not the default branch \`${defaultBranch}\``;
  }

  const patterns = Array.isArray(branchPolicies) ? branchPolicies : [];

  // A TAG pattern anywhere refuses, whatever else is present. `type` is an enum of `branch` or
  // `tag`, and a tag policy is not a statement about branches at all.
  const tag = patterns.find((entry) => String(entry?.type ?? '') === 'tag');
  if (tag) return `deployment branch policy: tag pattern \`${tag?.name ?? ''}\` present`;

  const branches = patterns.filter((entry) => String(entry?.type ?? 'branch') === 'branch');

  if (branches.length === 0) {
    // Custom policies are switched on and no pattern is configured. Not one of the tabulated rows,
    // and it is not the multi-pattern row either: naming a pattern list that is empty would read as
    // a bug. It is still not "limited to the default branch", so it refuses.
    return `deployment branch policy: no branch pattern configured, not the literal default branch \`${defaultBranch}\``;
  }

  if (branches.length > 1) {
    const list = branches.map((entry) => String(entry?.name ?? '')).join(', ');
    return `deployment branch policy: patterns \`${list}\` exceed the default branch \`${defaultBranch}\``;
  }

  const only = String(branches[0]?.name ?? '');
  if (only === defaultBranch && !WILDCARD.test(only)) return null;
  return `deployment branch policy: pattern \`${only}\` is not the literal default branch \`${defaultBranch}\``;
}

/**
 * The two rules together. Returns the missing ones IN ORDER, and only the missing ones: AC5's point
 * is that a caller with a reviewer and no branch policy is told about the branch policy and not
 * about the reviewer it already has.
 *
 * @param {{environment: any, branchPolicies: {name?: string, type?: string}[], defaultBranch: string, environmentName?: string}} input
 * @returns {string[]}
 */
export function evaluateEnvironment({ environment, branchPolicies, defaultBranch, environmentName = ENVIRONMENT_DEFAULT }) {
  /** @type {string[]} */
  const missing = [];
  if (!hasRequiredReviewer(environment)) {
    missing.push(`required reviewer: none configured on environment \`${environmentName}\``);
  }
  const branch = branchPolicyFailure(environment, branchPolicies, defaultBranch);
  if (branch) missing.push(branch);
  return missing;
}

// ── The reads ───────────────────────────────────────────────────────────────────────────────────

/**
 * One GET, classified rather than thrown.
 *
 * A thrown fetch is a transport fault and not an answer; `0` is not a real HTTP status and is used
 * here for exactly that, the way the sibling registry gate does it.
 *
 * @param {string} url
 * @param {(url: string, options?: any) => Promise<any>} fetchImpl
 * @param {string} token
 */
async function get(url, fetchImpl, token) {
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'cosyte-release-environment-gate',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    let body = null;
    let parsed = true;
    try {
      body = await res.json();
    } catch {
      parsed = false;
    }
    return { status: Number(res?.status ?? 0), body, parsed, error: null };
  } catch (error) {
    return { status: 0, body: null, parsed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A read that did not answer, in the two classes the contract distinguishes. */
class ReadFailure extends Error {
  /** @param {'permission'|'other'} kind @param {string} detail */
  constructor(kind, detail) {
    super(detail);
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * @param {string} url
 * @param {{status: number, error: string|null, parsed: boolean}} answer
 */
function readFailure(url, answer) {
  if (answer.status === 401 || answer.status === 403) {
    return new ReadFailure('permission', `${url} answered HTTP ${answer.status}`);
  }
  if (answer.status === 0) return new ReadFailure('other', `${url} could not be reached: ${answer.error}`);
  if (answer.status !== 200) return new ReadFailure('other', `${url} answered HTTP ${answer.status}`);
  return new ReadFailure('other', `${url} answered HTTP 200 with a body that does not parse as JSON`);
}

/**
 * Walk a paginated list endpoint to EXHAUSTION and return every item.
 *
 * Termination is on `total_count` first and on a short page second, with `MAX_PAGES` as a backstop
 * that yields a read failure rather than a truncated answer. A truncated answer is the defect this
 * exists to prevent: on the environment list it invents an absent `release`, and on the branch
 * policies it hides a second pattern.
 *
 * @param {string} base
 * @param {string} path
 * @param {string} key the array property (`environments` or `branch_policies`)
 * @param {(url: string, options?: any) => Promise<any>} fetchImpl
 * @param {string} token
 * @returns {Promise<any[]>}
 */
async function listAll(base, path, key, fetchImpl, token) {
  /** @type {any[]} */
  const items = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${base}${path}?per_page=${PER_PAGE}&page=${page}`;
    const answer = await get(url, fetchImpl, token);
    if (answer.status !== 200 || !answer.parsed) throw readFailure(url, answer);
    const chunk = Array.isArray(answer.body?.[key]) ? answer.body[key] : null;
    if (chunk === null) {
      throw new ReadFailure('other', `${url} answered HTTP 200 with no \`${key}\` array in the body`);
    }
    items.push(...chunk);
    if (total === null && Number.isInteger(answer.body?.total_count)) total = answer.body.total_count;

    if (total !== null) {
      // `total_count` IS THE TERMINATION CONDITION WHEN IT IS THERE, and a short page is NOT. A
      // server is entitled to return fewer items than `per_page` asked for, and reading that as the
      // end of the list is exactly the truncation this walk exists to avoid: it would report a
      // `release` on the next page as absent, or hide a second branch pattern.
      if (items.length >= total) return items;
      if (chunk.length === 0) {
        throw new ReadFailure(
          'other',
          `${url} reported total_count ${total} but stopped returning items after ${items.length}; refusing to ` +
            `treat a truncated list as a complete one`,
        );
      }
    } else if (chunk.length < PER_PAGE) {
      return items;
    }
  }
  throw new ReadFailure(
    'other',
    `${base}${path} did not finish paginating within ${MAX_PAGES} pages of ${PER_PAGE}; refusing to treat a ` +
      `truncated list as a complete one`,
  );
}

/**
 * The repository's default branch, from the endpoint that actually carries it, with the `github`
 * context value as the fallback. See the header for why this order and not the other one.
 *
 * @param {{base: string, repository: string, hint: string, fetchImpl: any, token: string}} input
 * @returns {Promise<string>}
 */
export async function readDefaultBranch({ base, repository, hint, fetchImpl, token }) {
  const url = `${base}/repos/${repository}`;
  const answer = await get(url, fetchImpl, token);
  const fromApi = answer.status === 200 && answer.parsed ? String(answer.body?.default_branch ?? '') : '';
  if (fromApi) return fromApi;
  const fromHint = String(hint ?? '').trim();
  if (fromHint) return fromHint;
  // NEVER an empty comparand. An empty default branch would refuse a fully compliant caller and
  // blame its branch policy for it, so this is reported as what it is: a read that did not answer.
  throw new ReadFailure(
    'other',
    `the default branch of ${repository} could not be determined: ${url} ` +
      (answer.status === 200 && answer.parsed
        ? 'answered HTTP 200 with no `default_branch`'
        : readFailure(url, answer).detail.replace(`${url} `, '')) +
      ', and no `github.event.repository.default_branch` was passed in',
  );
}

/**
 * Read the caller's `release` environment and decide.
 *
 * @param {{
 *   repository: string,
 *   environmentName?: string,
 *   apiBase?: string,
 *   token?: string,
 *   defaultBranchHint?: string,
 *   fetchImpl?: any,
 *   fetchTimeoutMs?: number,
 * }} options
 * @returns {Promise<{verdict: string, failing: boolean, message: string, missing: string[], trace: string[]}>}
 */
export async function checkEnvironment({
  repository,
  environmentName = ENVIRONMENT_DEFAULT,
  apiBase = 'https://api.github.com',
  token = '',
  defaultBranchHint = '',
  fetchImpl = globalThis.fetch,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
}) {
  const base = String(apiBase).replace(/\/+$/, '');
  const fetcher = withFetchTimeout(fetchImpl, fetchTimeoutMs);
  const encoded = encodeURIComponent(environmentName);
  /** @type {string[]} */
  const trace = [];

  try {
    const defaultBranch = await readDefaultBranch({ base, repository, hint: defaultBranchHint, fetchImpl: fetcher, token });
    trace.push(`default branch of ${repository}: ${defaultBranch}`);

    const envUrl = `${base}/repos/${repository}/environments/${encoded}`;
    const envAnswer = await get(envUrl, fetcher, token);

    /** @type {any} */
    let environment;
    if (envAnswer.status === 200 && envAnswer.parsed) {
      environment = envAnswer.body;
      trace.push(`read ${envUrl}`);
    } else if (envAnswer.status === 404) {
      // AMBIGUOUS ON ITS OWN. A 404 here is "absent" or "not permitted" and the status cannot say
      // which. The list read decides it: a SUCCESSFUL list proves the token can see this
      // repository's environments, so a `release` that is not in it is genuinely not there.
      trace.push(`${envUrl} answered HTTP 404; disambiguating with the environment list`);
      const environments = await listAll(base, `/repos/${repository}/environments`, 'environments', fetcher, token);
      trace.push(`read ${environments.length} environment(s) from ${repository}, exhaustively`);
      const listed = environments.find((entry) => String(entry?.name ?? '') === environmentName);
      // The list read is authoritative for "is it there". If it IS there the single read's 404 was
      // a transient or a name-encoding difference, and the list carries the same Environment object,
      // so the rules are evaluated against real configuration rather than against the empty payload.
      environment = listed ?? NO_PROTECTION_AT_ALL;
    } else {
      throw readFailure(envUrl, envAnswer);
    }

    // The PATTERNS live behind a second call and only exist when custom policies are switched on.
    /** @type {any[]} */
    let branchPolicies = [];
    if (environment?.deployment_branch_policy?.custom_branch_policies === true) {
      branchPolicies = await listAll(
        base,
        `/repos/${repository}/environments/${encoded}/deployment-branch-policies`,
        'branch_policies',
        fetcher,
        token,
      );
      trace.push(`read ${branchPolicies.length} branch policy/policies, exhaustively`);
    }

    const missing = evaluateEnvironment({ environment, branchPolicies, defaultBranch, environmentName });
    if (missing.length === 0) {
      return {
        verdict: 'protected',
        failing: false,
        missing,
        trace,
        message:
          `${repository} requires at least one reviewer on environment \`${environmentName}\` and limits its ` +
          `deployment branch policy to the default branch \`${defaultBranch}\`. The human gate on this publish is ` +
          `real, not asserted.`,
      };
    }

    return {
      verdict: 'unprotected',
      failing: true,
      missing,
      trace,
      message: refusalText(repository, environmentName, missing),
    };
  } catch (error) {
    if (!(error instanceof ReadFailure)) throw error;
    return {
      verdict: error.kind === 'permission' ? 'unreadable-permission' : 'unreadable',
      failing: true,
      missing: [],
      trace,
      message:
        error.kind === 'permission'
          ? permissionText(repository, environmentName, error.detail)
          : unreadableText(repository, environmentName, error.detail),
    };
  }
}

// ── The three refusals ──────────────────────────────────────────────────────────────────────────

/**
 * The refusal for a `release` environment that does not carry the protection this workflow requires.
 *
 * IT CONTAINS NOTHING THAT VARIES WITH THE INPUT THAT PRODUCED IT. That is the whole of AC4: a
 * `release` environment returned with an empty protection set, and a repository whose environment
 * list carries no `release`, must be one case with one wording, because no run can tell them apart
 * and a second wording would invite a reader to believe it could. It varies with the repository and
 * with the rules actually missing, and with nothing else, so it also carries no clause about the
 * caller's visibility or the org's plan.
 *
 * @param {string} repository
 * @param {string} environmentName
 * @param {string[]} missing
 */
export function refusalText(repository, environmentName, missing) {
  return (
    `Refusing to release from ${repository}: its \`${environmentName}\` environment does not carry the protection ` +
    `this workflow requires, so an unreviewed change could reach npm from it, permanently.\n` +
    `Not satisfied:\n` +
    missing.map((rule) => `  - ${rule}`).join('\n') +
    `\n` +
    `Configure it under Settings > Environments > ${environmentName} in ${repository}: add at least one required ` +
    `reviewer, and set the deployment branch policy to a custom rule naming the default branch and nothing else. ` +
    `NOTHING HAS BEEN PACKED AND NOTHING HAS BEEN PUBLISHED by this run.`
  );
}

/**
 * The refusal for a read the run's token was not permitted to make.
 *
 * IT SAYS NOTHING ABOUT THE ENVIRONMENT'S STATE, and that is a requirement rather than tact: this
 * run established nothing about the environment, and a message that reached for the vocabulary of
 * the refusal above would report a permission problem as a configuration finding. A maintainer would
 * then go and inspect an environment that may well be perfectly configured.
 *
 * @param {string} repository
 * @param {string} environmentName
 * @param {string} detail
 */
export function permissionText(repository, environmentName, detail) {
  return (
    `Refusing to release from ${repository}: this run's token is not permitted to read that repository's ` +
    `\`${environmentName}\` environment configuration, so the human gate on this publish cannot be proved. ` +
    `The read that was refused: ${detail}.\n` +
    `The permission this read requires is \`actions: read\`, and the place to grant it is ${repository}'s OWN ` +
    `calling job, because a called workflow's token can only be equal to or more restrictive than its caller's:\n` +
    `    jobs:\n` +
    `      release:\n` +
    `        permissions:\n` +
    `          actions: read\n` +
    `          contents: write\n` +
    `          id-token: write\n` +
    `          pull-requests: write\n` +
    `        uses: cosyte/.github/.github/workflows/release.yml@main\n` +
    `This run read nothing about that environment and reports no finding about how it is configured. ` +
    `NOTHING HAS BEEN PACKED AND NOTHING HAS BEEN PUBLISHED by this run.`
  );
}

/**
 * The refusal for a read that did not answer for any other reason.
 *
 * UNREADABLE PROTECTION IS NOT PROOF OF PROTECTION. Continuing here, or warning and carrying on,
 * would make a rate limit or a five-second API blip into a publish nobody approved.
 *
 * @param {string} repository
 * @param {string} environmentName
 * @param {string} detail
 */
export function unreadableText(repository, environmentName, detail) {
  return (
    `Refusing to release from ${repository}: its \`${environmentName}\` environment configuration could not be ` +
    `read, so the human gate on this publish cannot be proved. The reason: ${detail}.\n` +
    `A read that does not answer is not a protection rule that is there. Re-run this workflow once the API answers ` +
    `again. NOTHING HAS BEEN PACKED AND NOTHING HAS BEEN PUBLISHED by this run.`
  );
}

/**
 * Drop the repository identifier out of a refusal, so two runs of ONE caller can be compared.
 *
 * AC2 and AC3 oblige every refusal to name its own repository, so a byte comparison of two refusals
 * is only meaningful modulo that name. This exists for the test that flips one caller between public
 * and private and asserts nothing else moved; it is exported rather than kept in the test file so
 * that the normalization is part of the contract rather than part of the assertion.
 *
 * @param {string} text
 * @param {string} repository
 */
export function normalizeRepository(text, repository) {
  return String(text).split(repository).join('<repository>');
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

const USAGE =
  'usage:\n' +
  '  environment-gate.mjs [--repository <owner/name>] [--environment <name>] [--api <base>]\n' +
  '                       [--default-branch <name>]\n' +
  '  GITHUB_REPOSITORY, GITHUB_API_URL, GH_TOKEN (or GITHUB_TOKEN) and DEFAULT_BRANCH_HINT are read\n' +
  '  from the environment when the matching flag is absent.\n';

/** @param {string[]} argv */
export function parseArgv(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    options[token.slice(2)] = value;
    i += 1;
  }
  return options;
}

/**
 * @param {string[]} argv
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: any, stdout?: (s: string) => void, stderr?: (s: string) => void}} io
 */
export async function main(argv, { env = process.env, fetchImpl = globalThis.fetch, stdout, stderr } = {}) {
  const out = stdout ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const err = stderr ?? ((/** @type {string} */ s) => process.stderr.write(s));

  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }

  const repository = options.repository || env.GITHUB_REPOSITORY || '';
  if (!repository.includes('/')) {
    err(`a repository is required, as owner/name (got ${JSON.stringify(repository)})\n${USAGE}`);
    return 2;
  }

  const result = await checkEnvironment({
    repository,
    environmentName: options.environment || ENVIRONMENT_DEFAULT,
    apiBase: options.api || env.GITHUB_API_URL || 'https://api.github.com',
    // `GH_TOKEN` FIRST, and the order is not arbitrary. In `release.yml` the name `GITHUB_TOKEN` has
    // one specific meaning, guarded by a test: the credential `changesets/action` opens the Version
    // PR with, which is `RELEASE_PR_TOKEN` when a caller has one. This gate must use the AUTOMATIC
    // token instead, and `GH_TOKEN` is already that file's name for it. Both are accepted so the
    // script is still runnable by hand the obvious way.
    token: env.GH_TOKEN || env.GITHUB_TOKEN || '',
    defaultBranchHint: options['default-branch'] || env.DEFAULT_BRANCH_HINT || '',
    fetchImpl,
  });

  // THE TRACE GOES TO STDERR AND THE VERDICT TO STDOUT, deliberately. AC4 obliges two different
  // inputs to produce ONE refusal text, and a trace on stdout that says which of them happened would
  // be exactly the distinguishing wording that criterion forbids. The trace is still in the run log,
  // where a maintainer wants it, and it is not part of the refusal.
  for (const line of result.trace) err(`${line}\n`);

  out(`verdict: ${result.verdict}\n${result.message}\n`);
  if (result.failing) {
    out(
      `::error title=The caller's release environment is not a proven human gate::` +
        `${result.message.split('\n')[0]}\n`,
    );
  }
  return result.failing ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main(process.argv.slice(2));
}
