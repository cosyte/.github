// Tests for scripts/environment-gate.mjs, the gate that refuses a release when the calling
// repository's `release` environment is not a proven human gate, and for the `release.yml` wiring
// that makes it one.
//
// WHAT THESE TESTS ARE FOR, said once so the individual cases read against it. The defect is not
// "an environment is misconfigured". It is that a `release` environment carrying NO protection rules
// produces a run INDISTINGUISHABLE from a genuinely gated one: same environment badge on the job,
// same green steps, no approval prompt, and nothing anywhere saying there was never anything to
// approve. Every arm below is really asking one question: does this pipeline still refuse when the
// only thing standing between an unreviewed change and a permanent npm publish is a comment?
//
// THE API IS A REAL SOCKET, NOT AN INJECTED FUNCTION. Each case stands up a `node:http` server and
// runs the REAL entry point as a REAL child process against it, so the argument parsing, the
// `fetch`, the classification and THE PROCESS EXIT STATUS are all in the measurement. A unit test of
// the predicate alone proves none of them, and the exit status is the whole mechanism by which a
// refusal reaches a caller as a failure.
//
// AND THE STUB RECORDS EVERY REQUEST IT IS SENT. Two properties are asserted from that log rather
// than from reading the source: the gate only ever issues GETs (it verifies and refuses, it never
// configures a caller's environment and never cancels a run), and the list reads are walked to
// exhaustion rather than sampled.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  branchPolicyFailure,
  evaluateEnvironment,
  hasRequiredReviewer,
  NO_PROTECTION_AT_ALL,
  normalizeRepository,
  ruleKind,
} from '../scripts/environment-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/environment-gate.mjs');
const WORKFLOW = resolve(HERE, '../.github/workflows/release.yml');
const run = promisify(execFile);

const CALLER = 'cosyte/hl7';

// ── Payload fixtures, shaped after the two documented responses ─────────────────────────────────

const REVIEWER_RULE = {
  id: 1,
  node_id: 'MDQ6R2F0ZTE=',
  type: 'required_reviewers',
  reviewers: [{ type: 'User', reviewer: { login: 'noah', id: 1 } }],
};
/** The rule GitHub adds alongside a branch policy. It is not a reviewer and must not read as one. */
const BRANCH_POLICY_RULE = { id: 3, node_id: 'MDQ6R2F0ZTM=', type: 'branch_policy' };
const WAIT_TIMER_RULE = { id: 2, node_id: 'MDQ6R2F0ZTI=', type: 'wait_timer', wait_timer: 5 };

const CUSTOM_POLICY = { protected_branches: false, custom_branch_policies: true };
const PROTECTED_BRANCHES_POLICY = { protected_branches: true, custom_branch_policies: false };

/** The `Get an environment` payload, with only the fields this gate reads varying. */
function environmentPayload({ rules = [], policy = null, name = 'release' } = {}) {
  return {
    id: 161088068,
    node_id: 'MDExOkVudmlyb25tZW50MQ==',
    name,
    url: `https://api.github.com/repos/${CALLER}/environments/${name}`,
    html_url: `https://github.com/${CALLER}/settings/environments/1/edit`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    protection_rules: rules,
    deployment_branch_policy: policy,
  };
}

const COMPLIANT = environmentPayload({ rules: [REVIEWER_RULE, BRANCH_POLICY_RULE], policy: CUSTOM_POLICY });
const MAIN_ONLY = [{ id: 361471, node_id: 'MDE2OkdhdGVCcmFuY2hQb2xpY3kzNjE0NzE=', name: 'main', type: 'branch' }];

/** A `release` environment that exists and protects nothing. AC4's first input. */
const NO_PROTECTION = environmentPayload({ rules: [], policy: null });

const REVIEWER_WORDING = 'required reviewer: none configured on environment `release`';
const ALL_BRANCHES_WORDING = 'deployment branch policy: all branches';

// ── The stub API ────────────────────────────────────────────────────────────────────────────────

/**
 * A stand-in for the REST API over a real socket.
 *
 * `pageCap` exists because pagination is the point of two of the cases below: a server that answers
 * with fewer items than `per_page` asked for, while reporting the true `total_count`, is the shape
 * that catches a walk which stops after one page.
 */
async function startApi({
  repository = CALLER,
  environmentName = 'release',
  defaultBranch = 'main',
  visibility = 'public',
  environment = null,
  environments = null,
  branchPolicies = [],
  pageCap = 100,
  neverConverge = false,
  status = {},
  rawBody = {},
} = {}) {
  /** @type {{method: string, path: string, search: string}[]} */
  const requests = [];

  const paged = (items, key, search) => {
    const perPage = Math.min(Number(search.get('per_page') || 30), pageCap);
    const page = Number(search.get('page') || 1);
    const slice = neverConverge ? items.slice(0, perPage) : items.slice((page - 1) * perPage, page * perPage);
    return { status: 200, body: { total_count: neverConverge ? items.length + 10_000 : items.length, [key]: slice } };
  };

  const routes = (pathname, search) => {
    if (pathname === `/repos/${repository}`) {
      if (status.repo) return { status: status.repo, body: { message: 'nope' } };
      if (rawBody.repo !== undefined) return { status: 200, raw: rawBody.repo };
      return {
        status: 200,
        body: {
          full_name: repository,
          private: visibility === 'private',
          visibility,
          ...(defaultBranch === null ? {} : { default_branch: defaultBranch }),
        },
      };
    }
    if (pathname === `/repos/${repository}/environments`) {
      if (status.environments) return { status: status.environments, body: { message: 'nope' } };
      if (environments === null) return { status: 500, body: { message: 'the list read was not expected here' } };
      return paged(environments, 'environments', search);
    }
    if (pathname === `/repos/${repository}/environments/${environmentName}`) {
      if (status.environment) return { status: status.environment, body: { message: 'nope' } };
      if (rawBody.environment !== undefined) return { status: 200, raw: rawBody.environment };
      if (environment === null) return { status: 404, body: { message: 'Not Found' } };
      return { status: 200, body: environment };
    }
    if (pathname === `/repos/${repository}/environments/${environmentName}/deployment-branch-policies`) {
      if (status.branchPolicies) return { status: status.branchPolicies, body: { message: 'nope' } };
      return paged(branchPolicies, 'branch_policies', search);
    }
    return undefined;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: req.method ?? '', path: url.pathname, search: url.search });
    const answer = routes(url.pathname, url.searchParams) ?? { status: 404, body: { message: 'Not Found' } };
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(answer.raw !== undefined ? answer.raw : JSON.stringify(answer.body ?? null));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { base, requests, close: () => new Promise((done) => server.close(() => done(undefined))) };
}

/** Run the CLI exactly as release.yml does, and return { code, stdout, stderr } separately. */
async function runGate({ repository = CALLER, api, environment = 'release', env = {} } = {}) {
  const args = [SCRIPT, '--repository', repository, '--environment', environment];
  if (api) args.push('--api', api);
  const childEnv = {
    ...process.env,
    // Never inherit the surrounding run's own GitHub identity: these tests must depend on nothing
    // but what they pass in, and a real token must never be sent to a socket a test opened.
    GH_TOKEN: 'ghs_test_token_not_a_credential',
    GITHUB_TOKEN: '',
    GITHUB_REPOSITORY: '',
    GITHUB_API_URL: '',
    DEFAULT_BRANCH_HINT: '',
    ...env,
  };
  try {
    const { stdout, stderr } = await run(process.execPath, args, { encoding: 'utf8', env: childEnv });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** Stand up the stub, drive the real CLI against it, tear the stub down. */
async function gateAgainst(stubOptions, gateOptions = {}) {
  const api = await startApi(stubOptions);
  try {
    const result = await runGate({ api: api.base, ...gateOptions });
    return { ...result, requests: api.requests };
  } finally {
    await api.close();
  }
}

// ── The passing arm ─────────────────────────────────────────────────────────────────────────────

test('a required reviewer plus a default-branch-only policy passes, and the run continues', async () => {
  const { code, stdout, requests } = await gateAgainst({ environment: COMPLIANT, branchPolicies: MAIN_ONLY });
  assert.equal(code, 0, 'a compliant caller must not be refused');
  assert.match(stdout, /verdict: protected/);
  assert.match(stdout, /requires at least one reviewer/);
  assert.doesNotMatch(stdout, /::error/);

  // IT VERIFIES AND REFUSES. IT NEVER CONFIGURES. Bringing a non-compliant caller into compliance is
  // a change in that caller's own repository, and a gate that could write the rule it checks is not
  // a gate. Asserted from the request log rather than from reading the source.
  assert.deepEqual([...new Set(requests.map((r) => r.method))], ['GET']);
});

test('the passing rule is the LITERAL default branch, whatever that repository calls it', async () => {
  // The default branch is in neither environment payload, so a gate that hardcoded `main` would
  // refuse every caller that does not use it. This one reads it, so `develop` passes on its own terms.
  const { code, stdout } = await gateAgainst({
    defaultBranch: 'develop',
    environment: COMPLIANT,
    branchPolicies: [{ id: 1, name: 'develop', type: 'branch' }],
  });
  assert.equal(code, 0);
  assert.match(stdout, /default branch `develop`/);
});

// ── AC4: no protection at all is ONE case with ONE wording ──────────────────────────────────────

test('a `release` environment returned with an EMPTY protection set refuses, naming both rules', async () => {
  const { code, stdout } = await gateAgainst({ environment: NO_PROTECTION });
  assert.equal(code, 1, 'an environment that protects nothing must not publish');
  assert.match(stdout, /verdict: unprotected/);
  assert.ok(stdout.includes(REVIEWER_WORDING), stdout);
  assert.ok(stdout.includes(ALL_BRANCHES_WORDING), stdout);
  assert.ok(stdout.includes(CALLER), 'the refusal must name the calling repository');
  assert.match(stdout, /NOTHING HAS BEEN PACKED AND NOTHING HAS BEEN PUBLISHED/);
  assert.match(stdout, /::error title=The caller's release environment is not a proven human gate::/);
});

// THE POINT OF AC4, AND THE ONE ASSERTION THAT CANNOT BE MADE BY READING EITHER CASE ALONE. An
// environment created automatically on first reference and one a maintainer created and left
// unprotected produce an IDENTICAL payload, so no run can separate them. The two INPUTS that can
// present "no protection at all" therefore have to produce one refusal, byte for byte: a second
// wording would invite a reader to believe the run could tell which case it was in.
test('a successfully-read environment list with no `release` refuses with the SAME text, byte for byte', async () => {
  const empty = await gateAgainst({ environment: NO_PROTECTION });
  const absent = await gateAgainst({
    environment: null, // the single read 404s
    environments: [
      environmentPayload({ name: 'staging', rules: [REVIEWER_RULE] }),
      environmentPayload({ name: 'preview' }),
      environmentPayload({ name: 'docs' }),
    ],
  });

  assert.equal(absent.code, 1);
  assert.equal(absent.code, empty.code);
  assert.equal(absent.stdout, empty.stdout, 'AC4: one case, one wording, and no way to tell them apart');

  // And the list read really did happen, so the 404 was disambiguated rather than assumed.
  assert.ok(absent.requests.some((r) => r.path === `/repos/${CALLER}/environments`));
  // No wording anywhere distinguishes them, including the words a careless message would reach for.
  assert.doesNotMatch(absent.stdout, /auto-?creat/i);
  assert.doesNotMatch(absent.stdout, /not configured yet|does not exist/i);
});

test('an environment carrying only a wait timer is an environment carrying no reviewer', async () => {
  const { code, stdout } = await gateAgainst({
    environment: environmentPayload({ rules: [WAIT_TIMER_RULE], policy: CUSTOM_POLICY }),
    branchPolicies: MAIN_ONLY,
  });
  assert.equal(code, 1, 'a delay is not a human');
  assert.ok(stdout.includes(REVIEWER_WORDING));
});

test('a required-reviewers rule with an EMPTY reviewer list is no reviewer at all', async () => {
  const { code, stdout } = await gateAgainst({
    environment: environmentPayload({ rules: [{ ...REVIEWER_RULE, reviewers: [] }], policy: CUSTOM_POLICY }),
    branchPolicies: MAIN_ONLY,
  });
  assert.equal(code, 1);
  assert.ok(stdout.includes(REVIEWER_WORDING));
});

// ── AC5: only the rule actually missing is named ────────────────────────────────────────────────

test('AC5: a reviewer with no branch policy names the branch policy and NOT the reviewer', async () => {
  const { code, stdout } = await gateAgainst({
    environment: environmentPayload({ rules: [REVIEWER_RULE], policy: null }),
  });
  assert.equal(code, 1);
  assert.ok(stdout.includes(ALL_BRANCHES_WORDING), stdout);
  assert.ok(!stdout.includes(REVIEWER_WORDING), 'a rule that IS satisfied must not be reported as missing');
});

test('AC5: a default-branch-only policy with no reviewer names the reviewer and NOT the policy', async () => {
  const { code, stdout } = await gateAgainst({
    environment: environmentPayload({ rules: [BRANCH_POLICY_RULE], policy: CUSTOM_POLICY }),
    branchPolicies: MAIN_ONLY,
  });
  assert.equal(code, 1);
  assert.ok(stdout.includes(REVIEWER_WORDING), stdout);
  assert.ok(!stdout.includes('deployment branch policy:'), 'the branch policy is satisfied and must not be named');
});

// ── One fixture per refusing row of the branch-policy table ─────────────────────────────────────

const BRANCH_POLICY_ROWS = [
  {
    row: 'no policy object at all (all branches deploy)',
    policy: null,
    policies: [],
    wording: 'deployment branch policy: all branches',
  },
  {
    row: 'protected-branches-only',
    policy: PROTECTED_BRANCHES_POLICY,
    policies: [],
    wording: 'deployment branch policy: protected branches, not the default branch `main`',
  },
  {
    row: 'custom, one pattern, a wildcard that merely matches',
    policy: CUSTOM_POLICY,
    policies: [{ id: 1, name: 'main*', type: 'branch' }],
    wording: 'deployment branch policy: pattern `main*` is not the literal default branch `main`',
  },
  {
    row: 'custom, more than one branch pattern',
    policy: CUSTOM_POLICY,
    policies: [
      { id: 1, name: 'main', type: 'branch' },
      { id: 2, name: 'release/*', type: 'branch' },
    ],
    wording: 'deployment branch policy: patterns `main, release/*` exceed the default branch `main`',
  },
  {
    row: 'custom, contains a tag pattern',
    policy: CUSTOM_POLICY,
    policies: [
      { id: 1, name: 'main', type: 'branch' },
      { id: 2, name: 'v1', type: 'tag' },
    ],
    wording: 'deployment branch policy: tag pattern `v1` present',
  },
];

for (const { row, policy, policies, wording } of BRANCH_POLICY_ROWS) {
  test(`branch policy row refuses and is named exactly: ${row}`, async () => {
    const { code, stdout } = await gateAgainst({
      environment: environmentPayload({ rules: [REVIEWER_RULE], policy }),
      branchPolicies: policies,
    });
    assert.equal(code, 1, `${row} must refuse`);
    assert.ok(stdout.includes(wording), `${row}\nexpected: ${wording}\ngot:\n${stdout}`);
    // The reviewer is present in every one of these, so naming it would be the AC5 defect.
    assert.ok(!stdout.includes(REVIEWER_WORDING), row);
    // And exactly one branch-policy wording, never two.
    assert.equal(stdout.split('deployment branch policy:').length - 1, 1, row);
  });
}

// PROTECTED-BRANCHES-ONLY IS REFUSED DELIBERATELY, not accepted as a near miss. The set of protected
// branches is caller state this workflow cannot enumerate or bound from the environment payload, and
// "If no branch protection rules are defined for any branch in the repository, then all branches can
// deploy" -- so accepting it would be accepting an unproven claim, which is the exact failure this
// phase closes.
test('protected-branches-only is a refusal and says which branch it wanted instead', async () => {
  const { code, stdout } = await gateAgainst({
    defaultBranch: 'trunk',
    environment: environmentPayload({ rules: [REVIEWER_RULE], policy: PROTECTED_BRANCHES_POLICY }),
  });
  assert.equal(code, 1);
  assert.ok(stdout.includes('deployment branch policy: protected branches, not the default branch `trunk`'), stdout);
});

// ── AC2 and AC9: the unreadable paths ───────────────────────────────────────────────────────────

for (const refusedStatus of [401, 403]) {
  test(`a ${refusedStatus} on the environment read is a PERMISSION refusal that names the grant`, async () => {
    const { code, stdout } = await gateAgainst({ status: { environment: refusedStatus } });
    assert.equal(code, 1, 'unreadable protection is not proof of protection');
    assert.match(stdout, /verdict: unreadable-permission/);
    assert.ok(stdout.includes(CALLER), 'AC2: the refusal must name the repository');
    assert.ok(stdout.includes(`HTTP ${refusedStatus}`), 'AC2: and why it could not read them');

    // AC9's first half: the permission AND the place it is granted.
    assert.ok(stdout.includes('`actions: read`'), stdout);
    assert.ok(stdout.includes('calling job'), stdout);
    assert.match(stdout, /jobs:\n {6}release:\n {8}permissions:\n {10}actions: read/);

    // AC9's second half, and it is the half a helpful-sounding message gets wrong: this run
    // established NOTHING about that environment, so it must not report it as unprotected, as
    // absent, or as short of a protection rule. A maintainer sent to inspect a correctly configured
    // environment by a permission error loses the actual diagnosis.
    for (const forbidden of [/unprotected/i, /absent/i, /missing a protection rule/i, /none configured/i]) {
      assert.doesNotMatch(stdout, forbidden, `a permission refusal must not say ${forbidden}`);
    }
    assert.ok(!stdout.includes('deployment branch policy:'), 'nor may it report a branch-policy finding');
  });
}

test('a permission refusal on the LIST read is classified the same way, not as an absent environment', async () => {
  // The single read 404s and the list read is then refused. That combination must NOT be read as
  // "there is no `release`": a 404 is ambiguous between absent and not-permitted, and the list is
  // exactly the read that would have disambiguated it.
  const { code, stdout } = await gateAgainst({ environment: null, status: { environments: 403 } });
  assert.equal(code, 1);
  assert.match(stdout, /verdict: unreadable-permission/);
  assert.ok(!stdout.includes(REVIEWER_WORDING), 'an unreadable list is not an unprotected environment');
});

const OTHER_UNREADABLE = [
  { label: 'a 500', options: { status: { environment: 500 } }, reason: 'HTTP 500' },
  { label: 'a rate limit', options: { status: { environment: 429 } }, reason: 'HTTP 429' },
  { label: 'a 502', options: { status: { environment: 502 } }, reason: 'HTTP 502' },
  {
    label: 'a body that does not parse',
    options: { rawBody: { environment: '<html>upstream error</html>' } },
    reason: 'does not parse as JSON',
  },
];

for (const { label, options, reason } of OTHER_UNREADABLE) {
  test(`${label} fails the run as unreadable, naming the repository and the reason`, async () => {
    const { code, stdout } = await gateAgainst(options);
    assert.equal(code, 1);
    assert.match(stdout, /verdict: unreadable\n/);
    assert.ok(stdout.includes(CALLER), 'AC2: the repository');
    assert.ok(stdout.includes(reason), `AC2: and why. got:\n${stdout}`);
    // It is NOT the "no protection configured" case and must not borrow its wording.
    assert.ok(!stdout.includes(REVIEWER_WORDING), label);
    assert.ok(!stdout.includes(ALL_BRANCHES_WORDING), label);
    // Nor is it the permission case: nothing here is fixed by granting `actions: read`.
    assert.doesNotMatch(stdout, /verdict: unreadable-permission/);
  });
}

test('a transport failure is unreadable too, and it refuses rather than warning', async () => {
  const api = await startApi({ environment: COMPLIANT, branchPolicies: MAIN_ONLY });
  const base = api.base;
  await api.close(); // nothing is listening now
  const { code, stdout } = await runGate({ api: base });
  assert.equal(code, 1, 'a gate that cannot read anything must not pass the run');
  assert.match(stdout, /verdict: unreadable\n/);
  assert.match(stdout, /could not be reached/);
  assert.ok(stdout.includes(CALLER));
});

// ── AC8: one caller, both visibilities, one rule and one wording ────────────────────────────────
//
// AC8 is counterfactual and about ONE repository hypothetically flipped, never two real callers:
// AC2 and AC3 oblige every refusal to name its own repository, so a byte comparison across two
// DIFFERENT callers could only be greened by dropping that name, which violates both. The comparison
// is therefore modulo the repository identifier, and both halves of that are asserted here.

test('AC8: one caller flipped between private and public refuses identically, byte for byte', async () => {
  const config = { environment: environmentPayload({ rules: [REVIEWER_RULE], policy: null }) };
  const asPublic = await gateAgainst({ ...config, visibility: 'public' });
  const asPrivate = await gateAgainst({ ...config, visibility: 'private' });

  assert.equal(asPrivate.code, asPublic.code, 'the same rule reaches the same outcome');
  assert.equal(asPrivate.code, 1);
  assert.equal(asPrivate.stdout, asPublic.stdout, 'and emits the same refusal text');
  // No plan-availability clause and no private-caller clause anywhere in it.
  assert.doesNotMatch(asPrivate.stdout, /private|public|Enterprise|plan/i);
});

test('AC8: and the same caller flipped between visibilities PASSES identically when compliant', async () => {
  const config = { environment: COMPLIANT, branchPolicies: MAIN_ONLY };
  const asPublic = await gateAgainst({ ...config, visibility: 'public' });
  const asPrivate = await gateAgainst({ ...config, visibility: 'private' });
  assert.equal(asPublic.code, 0);
  assert.equal(asPrivate.code, 0);
  assert.equal(asPrivate.stdout, asPublic.stdout);
});

test('the comparison is modulo the repository identifier, and that identifier is really in there', async () => {
  // If the two texts were equal WITHOUT normalizing, the refusal would not be naming its repository,
  // which AC2 and AC3 both require. So this asserts the normalization is doing work.
  const config = { environment: environmentPayload({ rules: [REVIEWER_RULE], policy: null }) };
  const hl7 = await gateAgainst({ ...config, repository: 'cosyte/hl7' }, { repository: 'cosyte/hl7' });
  const dicom = await gateAgainst({ ...config, repository: 'cosyte/dicom' }, { repository: 'cosyte/dicom' });

  assert.notEqual(dicom.stdout, hl7.stdout, 'two different callers must not produce identical text');
  assert.equal(
    normalizeRepository(dicom.stdout, 'cosyte/dicom'),
    normalizeRepository(hl7.stdout, 'cosyte/hl7'),
    'and the only difference must be the identifier each one is obliged to name',
  );
});

// ── Pagination: "not in the list" is only true of an EXHAUSTIVE read ────────────────────────────

test('a caller with more than thirty environments is not refused for a `release` on a later page', async () => {
  // The list endpoint defaults to `per_page` 30. A walk that reads one page and stops would report
  // this caller as having no `release` at all and refuse a fully compliant repository.
  const many = [];
  for (let i = 0; i < 240; i += 1) many.push(environmentPayload({ name: `preview-${i}` }));
  many.push(COMPLIANT);
  for (let i = 0; i < 9; i += 1) many.push(environmentPayload({ name: `late-${i}` }));

  const { code, stdout, requests } = await gateAgainst({
    environment: null, // force the disambiguating list read
    environments: many,
    branchPolicies: MAIN_ONLY,
  });
  assert.equal(code, 0, `a compliant caller with ${many.length} environments must pass:\n${stdout}`);
  const pages = requests.filter((r) => r.path === `/repos/${CALLER}/environments`);
  assert.ok(pages.length > 1, 'the list must actually have been walked, not sampled');
  assert.ok(
    pages.every((r) => r.search.includes('per_page=100')),
    'and walked at the documented maximum page size',
  );
});

test('the walk honours total_count even when the server hands back a shorter page than asked for', async () => {
  const many = [];
  for (let i = 0; i < 40; i += 1) many.push(environmentPayload({ name: `preview-${i}` }));
  many.push(COMPLIANT);
  const { code } = await gateAgainst({
    environment: null,
    environments: many,
    branchPolicies: MAIN_ONLY,
    pageCap: 30,
  });
  assert.equal(code, 0);
});

// THE FALSE-GREEN DIRECTION, AND IT IS THE WORSE ONE. The branch-policy list paginates too. A walk
// that read one page of it would see `main` alone, conclude "exactly one pattern, and it is the
// default branch", and PASS a caller whose policy also admits `release/*`.
test('the branch-policy walk is exhaustive too, so a second pattern on page two still refuses', async () => {
  const { code, stdout } = await gateAgainst({
    environment: COMPLIANT,
    branchPolicies: [
      { id: 1, name: 'main', type: 'branch' },
      { id: 2, name: 'release/*', type: 'branch' },
    ],
    pageCap: 1,
  });
  assert.equal(code, 1, 'a second admitted pattern must not be invisible');
  assert.ok(stdout.includes('deployment branch policy: patterns `main, release/*` exceed the default branch `main`'), stdout);
});

test('a list walk that cannot be completed is UNREADABLE, never an absent environment', async () => {
  const { code, stdout } = await gateAgainst({
    environment: null,
    environments: [environmentPayload({ name: 'staging' })],
    neverConverge: true,
  });
  assert.equal(code, 1);
  assert.match(stdout, /verdict: unreadable\n/);
  assert.match(stdout, /refusing to treat a truncated list as a complete one/);
  assert.ok(!stdout.includes(REVIEWER_WORDING), 'a truncated read must not be reported as no protection');
});

// ── Where `default_branch` comes from, and what happens when it cannot be had ───────────────────

test('the default branch is read from the repository endpoint, on the same clock as the policy', async () => {
  const { code, requests } = await gateAgainst({
    defaultBranch: 'trunk',
    environment: COMPLIANT,
    branchPolicies: [{ id: 1, name: 'trunk', type: 'branch' }],
    // A STALE hint, of exactly the kind a renamed default branch leaves in an event payload. The
    // API value wins, so a compliant caller is not refused on the strength of it.
    env: {},
  }, { env: { DEFAULT_BRANCH_HINT: 'main' } });
  assert.equal(code, 0, 'the live value must win over the event payload');
  assert.ok(requests.some((r) => r.path === `/repos/${CALLER}`));
});

test('the `github` context value is the fallback when the repository read does not answer', async () => {
  const { code, stdout } = await gateAgainst(
    { status: { repo: 500 }, environment: COMPLIANT, branchPolicies: MAIN_ONLY },
    { env: { DEFAULT_BRANCH_HINT: 'main' } },
  );
  assert.equal(code, 0, `the fallback must keep a compliant caller passing:\n${stdout}`);
});

test('with NO default branch from either source the run fails as unreadable, never on the branch policy', async () => {
  // The failure this arm exists to prevent is a comparison against an empty string, which would
  // refuse a fully compliant caller and blame its branch policy for it.
  const { code, stdout } = await gateAgainst({ defaultBranch: null, environment: COMPLIANT, branchPolicies: MAIN_ONLY });
  assert.equal(code, 1);
  assert.match(stdout, /verdict: unreadable\n/);
  assert.match(stdout, /default branch of cosyte\/hl7 could not be determined/);
  assert.ok(!stdout.includes('deployment branch policy:'), 'this is not a finding about the branch policy');
  assert.ok(!stdout.includes('``'), 'and nothing may be compared against an empty branch name');
});

// ── The terminal outcome is a FAILED step, and nothing more inventive ───────────────────────────

test('every refusal is an ordinary non-zero exit: nothing is cancelled and nothing is written', async () => {
  // AC6's "terminal outcome" is the job failing and the run concluding in failure. Cancelling the
  // run from here would make the packing and publishing jobs conclude `cancelled`, which is not the
  // FAILED conclusion AC7 requires, and `skipped`, `neutral` and `success` are all read as passing.
  // So the whole mechanism is the exit status, and these are the only exit statuses there are.
  const refusals = [
    await gateAgainst({ environment: NO_PROTECTION }),
    await gateAgainst({ status: { environment: 403 } }),
    await gateAgainst({ status: { environment: 500 } }),
  ];
  for (const refusal of refusals) {
    assert.equal(refusal.code, 1);
    assert.deepEqual([...new Set(refusal.requests.map((r) => r.method))], ['GET']);
  }

  const source = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /\/actions\/runs\/[^\s]*\/cancel|gh run cancel|process\.kill/, 'the gate must not cancel a run');
  assert.doesNotMatch(source, /method:\s*'(POST|PUT|PATCH|DELETE)'/, 'and must not write to any caller');
});

test('bad usage is exit 2, distinct from a check that failed', async () => {
  const missing = await runGate({ repository: 'not-a-repository-slug' });
  assert.equal(missing.code, 2);
  const bad = await runGate({ repository: CALLER, api: undefined, env: {} });
  assert.notEqual(bad.code, 2, 'a real read failure is a refusal, not a usage error');
});

// ── The predicates, read directly ───────────────────────────────────────────────────────────────

test('the reviewer predicate reads the rule, its list, and nothing else', () => {
  assert.equal(hasRequiredReviewer(environmentPayload({ rules: [REVIEWER_RULE] })), true);
  assert.equal(hasRequiredReviewer(environmentPayload({ rules: [] })), false);
  assert.equal(hasRequiredReviewer(environmentPayload({ rules: [WAIT_TIMER_RULE, BRANCH_POLICY_RULE] })), false);
  assert.equal(hasRequiredReviewer(environmentPayload({ rules: [{ ...REVIEWER_RULE, reviewers: [] }] })), false);
  assert.equal(hasRequiredReviewer(environmentPayload({ rules: [{ type: 'required_reviewers' }] })), false);
  assert.equal(hasRequiredReviewer(NO_PROTECTION_AT_ALL), false);
  assert.equal(hasRequiredReviewer({}), false, 'a payload with no rules array is not a reviewer');
});

test('the rule discriminator is spelling-tolerant in the positive direction only', () => {
  assert.equal(ruleKind('required_reviewers'), 'requiredreviewers');
  assert.equal(ruleKind('requiredReviewers'), 'requiredreviewers');
  assert.equal(ruleKind('required-reviewers'), 'requiredreviewers');
  assert.equal(ruleKind('wait_timer'), 'waittimer');
  assert.equal(ruleKind(undefined), '');
});

test('the branch-policy predicate decides every tabulated row from the two payloads', () => {
  const withPolicy = (policy) => environmentPayload({ policy });
  assert.equal(branchPolicyFailure(withPolicy(CUSTOM_POLICY), [{ name: 'main', type: 'branch' }], 'main'), null);
  assert.equal(branchPolicyFailure(withPolicy(null), [], 'main'), ALL_BRANCHES_WORDING);
  assert.equal(
    branchPolicyFailure(withPolicy({ protected_branches: false, custom_branch_policies: false }), [], 'main'),
    ALL_BRANCHES_WORDING,
    'an object restricting nothing restricts nothing',
  );
  assert.equal(
    branchPolicyFailure(withPolicy(PROTECTED_BRANCHES_POLICY), [], 'main'),
    'deployment branch policy: protected branches, not the default branch `main`',
  );
  assert.equal(
    branchPolicyFailure(withPolicy(CUSTOM_POLICY), [{ name: 'main*', type: 'branch' }], 'main'),
    'deployment branch policy: pattern `main*` is not the literal default branch `main`',
  );
  assert.equal(
    branchPolicyFailure(withPolicy(CUSTOM_POLICY), [], 'main'),
    'deployment branch policy: no branch pattern configured, not the literal default branch `main`',
    'custom policies switched on with nothing in them is not "limited to the default branch" either',
  );
  // A pattern that MERELY MATCHES the default branch is not the default branch. `main*` also admits
  // `main-hotfix`, and admitting a branch nobody named is the whole failure this rule closes.
  for (const pattern of ['main*', 'ma?n', 'main[0-9]', '*', 'release/*']) {
    assert.notEqual(branchPolicyFailure(withPolicy(CUSTOM_POLICY), [{ name: pattern, type: 'branch' }], 'main'), null, pattern);
  }
});

test('the two rules are reported independently, so a satisfied one is never named', () => {
  const both = evaluateEnvironment({ environment: NO_PROTECTION_AT_ALL, branchPolicies: [], defaultBranch: 'main' });
  assert.deepEqual(both, [REVIEWER_WORDING, ALL_BRANCHES_WORDING]);

  const reviewerOnly = evaluateEnvironment({
    environment: environmentPayload({ rules: [REVIEWER_RULE], policy: null }),
    branchPolicies: [],
    defaultBranch: 'main',
  });
  assert.deepEqual(reviewerOnly, [ALL_BRANCHES_WORDING]);

  const compliant = evaluateEnvironment({
    environment: COMPLIANT,
    branchPolicies: [{ name: 'main', type: 'branch' }],
    defaultBranch: 'main',
  });
  assert.deepEqual(compliant, []);
});

// ── THE WIRING: asserted by parsing release.yml into JOBS, and then into each job's steps ───────
//
// This needs no release, no caller and no network, so it runs on every push to main. A gate that
// exists and is reached too late is not a gate, and nothing else in this repository would say so.
//
// WHY THIS PARSES INTO JOBS RATHER THAN SCANNING THE FILE. `release.yml` used to be one job, and
// these assertions used to work by byte offset in the whole file: slice from the literal
// `\n  release:`, count occurrences, compare `String.indexOf` positions. That reads a two-job
// workflow as one long file, and every ordering claim it makes is then an accident of which job the
// author happened to write first. The properties below are per-job facts (which job holds the
// environment, which job is handed the npm credential, what precedes the gate INSIDE its own job)
// plus one cross-job fact (`needs:`), and they are asserted as such.

/** Drop whole-line comments. A `#` inside a shell heredoc goes too, which no assertion here reads. */
function decomment(text) {
  return text.split('\n').filter((line) => !/^\s*#/.test(line));
}

/** `write # create tags` -> `write`. Only ` # ` counts, so a `${{ }}` expression is never cut. */
function stripTrailingComment(value) {
  return value.replace(/\s+#\s.*$/, '').trim();
}

/**
 * Parse ONE step from the raw lines of a `- ` list entry under a job's `steps:`.
 *
 * `fields` are the step's own keys; `with` and `env` are their nested maps, read only while the
 * parser is positioned inside those two blocks, so a `run: |` script line can never be mistaken for
 * an input or a variable.
 */
function parseStep(index, jobId, rawLines) {
  const lines = [`        ${rawLines[0]}`, ...rawLines.slice(1)];
  /** @type {Record<string, string>} */
  const fields = {};
  const blocks = { with: {}, env: {} };
  let open = null;
  for (const line of lines) {
    const key = /^ {8}([\w-]+):\s?(.*)$/.exec(line);
    if (key) {
      fields[key[1]] = stripTrailingComment(key[2]);
      open = fields[key[1]] === '' && (key[1] === 'with' || key[1] === 'env') ? key[1] : null;
      continue;
    }
    if (!open) continue;
    const child = /^ {10}([\w-]+):\s?(.*)$/.exec(line);
    if (child) blocks[open][child[1]] = stripTrailingComment(child[2]);
    else open = null;
  }
  const label = fields.name ?? fields.uses ?? `${jobId} step ${index}`;
  if (fields.name === undefined && fields.uses === undefined && fields.run === undefined) {
    throw new Error(
      `parse failure: step ${index} of job \`${jobId}\` has neither a name, a uses nor a run: ` +
        JSON.stringify(lines.join('\n').slice(0, 120)),
    );
  }
  return { index, job: jobId, fields, with: blocks.with, env: blocks.env, label, body: lines.join('\n') };
}

/**
 * Parse release.yml into its jobs, each with its own keys, its nested blocks and its ordered steps.
 *
 * NOT a general YAML parser, deliberately: this repository has no dependencies and no install step
 * on purpose, so `node:test` and `node:assert` are the whole toolbox. What it IS, is a parser that
 * THROWS, naming what it could not read, rather than returning an empty list. An empty job list or
 * an empty step list makes every assertion in this section pass while asserting nothing, and a suite
 * whose subject is workflow composition has to fail loudly the moment the composition stops being
 * legible to it.
 */
function parseWorkflow(text) {
  const lines = decomment(text);
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt < 0) throw new Error('parse failure: release.yml has no top-level `jobs:` key');

  const jobs = [];
  let job = null;
  let openBlock = null;
  let inSteps = false;
  /** @type {string[][]} */
  let rawSteps = [];

  const closeJob = () => {
    if (!job) return;
    job.steps = rawSteps.map((raw, index) => parseStep(index, job.id, raw));
    if (job.steps.length === 0) throw new Error(`parse failure: job \`${job.id}\` parsed to zero steps`);
  };

  for (const line of lines.slice(jobsAt + 1)) {
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break; // a new top-level key closes the jobs block

    const jobStart = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobStart) {
      closeJob();
      job = { id: jobStart[1], keys: {}, blocks: {}, steps: [] };
      jobs.push(job);
      openBlock = null;
      inSteps = false;
      rawSteps = [];
      continue;
    }
    if (!job) throw new Error(`parse failure: ${JSON.stringify(line)} sits under \`jobs:\` but inside no job`);

    if (!inSteps) {
      if (/^ {4}steps:\s*$/.test(line)) {
        inSteps = true;
        openBlock = null;
        continue;
      }
      const key = /^ {4}([\w-]+):\s?(.*)$/.exec(line);
      if (key) {
        job.keys[key[1]] = stripTrailingComment(key[2]);
        if (job.keys[key[1]] === '') {
          job.blocks[key[1]] = {};
          openBlock = key[1];
        } else {
          openBlock = null;
        }
        continue;
      }
      const child = /^ {6}([\w-]+):\s?(.*)$/.exec(line);
      if (child && openBlock) {
        job.blocks[openBlock][child[1]] = stripTrailingComment(child[2]);
        continue;
      }
      throw new Error(`parse failure: unreadable line in job \`${job.id}\`: ${JSON.stringify(line)}`);
    }

    const stepStart = /^ {6}- (.*)$/.exec(line);
    if (stepStart) {
      rawSteps.push([stepStart[1]]);
      continue;
    }
    if (rawSteps.length === 0) {
      throw new Error(`parse failure: ${JSON.stringify(line)} sits under \`${job.id}.steps:\` but inside no step`);
    }
    rawSteps[rawSteps.length - 1].push(line);
  }
  closeJob();

  if (jobs.length === 0) throw new Error('parse failure: release.yml declares `jobs:` but no job under it');
  return { jobs, byId: Object.fromEntries(jobs.map((j) => [j.id, j])) };
}

/** Every step of every job, in file order, so a whole-workflow property is asserted over all of it. */
function allSteps(workflow) {
  return workflow.jobs.flatMap((job) => job.steps);
}

/** The permissions in force on a job: its own block if it has one, else the workflow's. */
function effectivePermissions(text, job) {
  if (job.blocks.permissions) return job.blocks.permissions;
  const lines = decomment(text);
  const at = lines.findIndex((line) => /^permissions:\s*$/.test(line));
  if (at < 0) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of lines.slice(at + 1)) {
    const match = /^ {2}([\w-]+):\s?(.*)$/.exec(line);
    if (!match) break;
    out[match[1]] = stripTrailingComment(match[2]);
  }
  return out;
}

/**
 * The WORKFLOW-level `env:` block, above `jobs:`, with the raw text it was read out of.
 *
 * Read the way `effectivePermissions` reads the workflow-level `permissions:` block, and here for
 * the same reason: a key written once at the top of the file is in force inside every job without
 * appearing in any of them. It is the one spelling that neither a per-step sweep nor a read of
 * `job.blocks.env` can see, and after the split it is the spelling that would hand the npm write
 * credential to a job no human approved.
 *
 * TWO DIFFERENCES FROM THE PERMISSIONS READ, both because this one is used for an ABSENCE claim and
 * that one for a presence claim, so the failure directions are opposite. A blank line inside the
 * block does not end it (ending there would silently stop reading and report "no credential"), and
 * the raw text comes back alongside the parsed map so a value this line-oriented parser cannot read
 * -- a folded scalar, say -- is still swept for the secret rather than passing as unreadable.
 */
function workflowEnv(text) {
  const lines = decomment(text);
  const at = lines.findIndex((line) => /^env:\s*$/.test(line));
  if (at < 0) return { vars: {}, raw: '' };
  /** @type {Record<string, string>} */
  const vars = {};
  const raw = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break; // a new top-level key closes the block
    raw.push(line);
    const match = /^ {2}([\w-]+):\s?(.*)$/.exec(line);
    if (match) vars[match[1]] = stripTrailingComment(match[2]);
  }
  return { vars, raw: raw.join('\n') };
}

/** Does `jobId` transitively depend on `targetId` through `needs:`? */
function dependsOn(workflow, jobId, targetId, seen = new Set()) {
  if (jobId === targetId) return true;
  if (seen.has(jobId)) return false;
  seen.add(jobId);
  const raw = workflow.byId[jobId]?.keys.needs ?? '';
  const parents = raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((name) => name.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return parents.some((parent) => dependsOn(workflow, parent, targetId, seen));
}

const isCheckout = (step) => /uses: actions\/checkout@/.test(step.body);
const isToolingCheckout = (step) => isCheckout(step) && step.with.repository === 'cosyte/.github';
const isGate = (step) => /environment-gate\.mjs/.test(step.body);

/**
 * The four things that must never precede the gate, kept as an over-approximation on purpose: a step
 * that merely COULD publish counts as publishing. `changesets/action` is the whole publish mechanism
 * whether or not the invocation in front of us supplies a publish command, so every appearance of it
 * is treated as one.
 */
const CATEGORIES = {
  'checks out a caller tree': (step) => isCheckout(step) && !isToolingCheckout(step),
  'authenticates to the registry': (step) =>
    step.with['registry-url'] !== undefined ||
    step.env.NODE_AUTH_TOKEN !== undefined ||
    step.env.NPM_TOKEN !== undefined,
  packs: (step) => /PACK_DOCS_CMD|pack:docs|npm pack|pnpm pack/.test(step.body),
  publishes: (step) => /uses: changesets\/action@/.test(step.body) || /pnpm run release/.test(step.body),
};

/** Can this step actually reach the registry, as opposed to merely being able to in another wiring? */
const reachesRegistry = (step) =>
  step.with.publish !== undefined ||
  step.with['registry-url'] !== undefined ||
  step.env.NPM_TOKEN !== undefined ||
  step.env.NODE_AUTH_TOKEN !== undefined ||
  /pnpm run release|changeset publish|npm publish|pnpm publish/.test(step.body);

test('AC12: the parser still understands release.yml, or every assertion below is vacuous', () => {
  const workflow = parseWorkflow(readFileSync(WORKFLOW, 'utf8'));

  // THE TOPOLOGY ITSELF IS THE CANARY NOW. One job is the shape this file had before the split and
  // three is a shape nobody has reasoned about, so either is a change that has to come here first.
  assert.deepEqual(
    workflow.jobs.map((job) => job.id),
    ['version', 'release'],
    'release.yml is two jobs: the un-gated version-PR job, and the environment-held publish job',
  );
  for (const job of workflow.jobs) {
    assert.ok(job.steps.length >= 6, `job \`${job.id}\` parsed to ${job.steps.length} steps`);
    for (const step of job.steps) {
      assert.ok(
        step.fields.name !== undefined || step.fields.uses !== undefined || step.fields.run !== undefined,
        `${step.label} parsed as neither a name, a uses nor a run`,
      );
    }
  }
  assert.ok(allSteps(workflow).length >= 24, 'the two jobs together should carry the full step list');

  // AND THE PARSER REFUSES RATHER THAN RETURNING NOTHING. A parser that answers "no jobs" or "no
  // steps" turns every assertion above into a tautology, so the failure mode is proved here rather
  // than assumed: each of these is a real way release.yml could be edited into illegibility.
  assert.throws(() => parseWorkflow('name: Release\non:\n  workflow_call:\n'), /no top-level `jobs:` key/);
  assert.throws(() => parseWorkflow('jobs:\n'), /declares `jobs:` but no job under it/);
  assert.throws(() => parseWorkflow('jobs:\n  release:\n    steps:\n'), /parsed to zero steps/);
  assert.throws(
    () => parseWorkflow('jobs:\n  release:\n    steps:\n      - with:\n          foo: bar\n'),
    /has neither a name, a uses nor a run/,
  );
  assert.throws(() => parseWorkflow('jobs:\n    release:\n'), /sits under `jobs:` but inside no job/);
});

test('AC1: the "Version Packages" job references no deployment environment and cannot publish', () => {
  const workflow = parseWorkflow(readFileSync(WORKFLOW, 'utf8'));
  const version = workflow.byId.version;
  assert.ok(version, 'release.yml must keep a job that opens the Version PR without an approval');

  // NO ENVIRONMENT AND NO CONDITION. An environment here would put the Version PR itself behind an
  // approval, which is the defect this split exists to remove: a run that opens no Version PR
  // publishes nothing, and asking a human to approve it bought nothing and expired in 30 days.
  assert.equal(version.keys.environment, undefined, 'the version job must reference no environment');
  assert.equal(version.keys.if, undefined, 'the version job runs on every path, so it carries no condition');
  assert.equal(version.keys.needs, undefined, 'nothing may run ahead of the job that holds the gate');

  // It is the job that runs changesets/action's version arm, and the step is unconditional: a repo
  // that has never released lands on `is-release=false` and STILL needs this step to run, or the
  // version never moves off its scaffold value and the deadlock is permanent.
  const action = version.steps.filter((step) => /uses: changesets\/action@/.test(step.body));
  assert.equal(action.length, 1, 'exactly one changesets/action step in the version job');
  assert.equal(action[0].fields.if, undefined, 'the version-PR step must run unconditionally');
  assert.equal(action[0].with.version, 'pnpm run version');

  // AND IT IS HANDED NO PUBLISH COMMAND AT ALL. Not an expression that evaluates to the empty
  // string: no `publish:` key. `changesets/action` runs the publish command itself, so the absence
  // of the input is the absence of the capability, and there is no condition left to get wrong.
  assert.equal(
    action[0].with.publish,
    undefined,
    'the version job must not declare a publish input in any form, not even a withheld one',
  );
});

test('AC2 and AC10: every step that can reach the registry is in the job named `release`, which holds the environment', () => {
  const workflow = parseWorkflow(readFileSync(WORKFLOW, 'utf8'));
  const release = workflow.byId.release;

  // THE JOB ID IS THE CHECK CONTEXT. A caller's context for a reusable workflow is
  // `<caller job id> / <called job id>`, so every caller's required-check configuration names
  // `release`. Renaming this job leaves those contexts reporting nothing at all, and a required
  // context that never reports leaves a pull request pending and unmergeable by anyone.
  assert.ok(release, 'the environment-held publishing job must keep the identifier `release`');
  assert.equal(release.keys.environment, 'release', 'the publish job must sit in the caller\'s release environment');
  assert.equal(release.keys.needs, 'version');

  // THE WHOLE EXPRESSION, NOT A SUBSTRING OF IT. After the split this one line is the only thing
  // keeping the caller's `release` environment off the every-merge path, so it is pinned the way its
  // predecessor was. Merely requiring the condition to APPEAR somewhere passes on
  // `... == 'true' || true`, which contains every character a substring match looks for and starts
  // the environment-held job on every push to a caller's default branch: that is the
  // approval-per-merge defect this split exists to remove, restored under thirteen callers at once,
  // with the suites green. The pre-split suite pinned the `publish:` input whole for exactly this
  // reason and said so; the decision moved to this line, so the whole-expression pin moves with it.
  // There is no edit to this line that should be anything other than deliberate.
  assert.equal(
    release.keys.if,
    "${{ needs.version.outputs.is-release == 'true' }}",
    'the publish job\'s condition is pinned whole: no extra disjunct, no negation, no second term',
  );

  const reaching = allSteps(workflow).filter(reachesRegistry);
  assert.ok(reaching.length >= 2, 'no step reaches the registry, so this assertion proves nothing');
  for (const step of reaching) {
    assert.equal(
      workflow.byId[step.job].keys.environment,
      'release',
      `"${step.label}" can reach the registry and must run in the environment-held job, not \`${step.job}\``,
    );
  }
  // And the environment is on exactly one job: an environment on the version job would restore the
  // approval-per-merge this change removes.
  assert.deepEqual(
    workflow.jobs.filter((job) => job.keys.environment !== undefined).map((job) => job.id),
    ['release'],
  );
});

test('AC3: the protection gate runs unconditionally, on every path, ahead of everything', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const workflow = parseWorkflow(text);

  const gates = allSteps(workflow).filter(isGate);
  assert.equal(gates.length, 1, 'exactly one step runs the environment gate');
  const gate = gates[0];
  assert.match(gate.body, /node \.cosyte-release-tooling\/scripts\/environment-gate\.mjs --environment release/);

  // NOTHING ABOVE IT, AT EITHER LEVEL. A step-level `if:` skips the gate; a job-level `if:` skips
  // the job that holds it, and a skipped job concludes `skipped`, which a required context counts as
  // SUCCESS. Both are the same failure and it is silent, which is why both are pinned.
  const gateJob = workflow.byId[gate.job];
  assert.equal(gate.fields.if, undefined, 'a gate behind a step condition is a gate that can be skipped');
  assert.equal(gateJob.keys.if, undefined, 'a gate in a conditional job is a gate that can be skipped');
  assert.equal(gateJob.keys.environment, undefined, 'the gate runs on every path, so its job waits on no approval');

  // What is allowed to precede it INSIDE ITS OWN JOB is exactly one thing: this repo's own script
  // arriving. A caller tree, a package manager or a registry credential ahead of the gate would each
  // be a step taken on the strength of a human gate nobody had checked.
  for (const step of gateJob.steps.slice(0, gate.index)) {
    assert.ok(isToolingCheckout(step), `"${step.label}" runs before the gate and is not the tooling checkout`);
  }

  // And ACROSS JOBS: every step in any job that checks out a caller tree, authenticates to a
  // registry, packs or publishes is either below the gate in the gate's own job, or in a job that
  // cannot start until the gate's job has succeeded. A third job added without a `needs:` would fail
  // here rather than quietly running unguarded.
  for (const [label, matches] of Object.entries(CATEGORIES)) {
    const found = allSteps(workflow).filter(matches);
    assert.ok(found.length > 0, `no step ${label}, so this assertion proves nothing`);
    for (const step of found) {
      if (step.job === gate.job) {
        assert.ok(step.index > gate.index, `"${step.label}" ${label} and must run AFTER the protection gate`);
      } else {
        assert.ok(
          dependsOn(workflow, step.job, gate.job),
          `"${step.label}" ${label} in job \`${step.job}\`, which does not need the job holding the gate`,
        );
      }
    }
  }
});

/**
 * The npm write credential must not be reachable from the AMBIENT environment of a job: neither the
 * job's own `env:` block nor the workflow-level `env:` block above `jobs:`.
 *
 * Both reach every step of the job without appearing in any of them, so both are exactly AC6's "in
 * that job's environment", and both are spellings a step-by-step sweep cannot see. The workflow-level
 * one is the wider hole of the two, because it is written once, outside either job, and lands in the
 * un-approved one for free; before the split it sat inside the single job the environment held, and
 * the split is what turned it into a window on a write credential nobody approved.
 *
 * GITHUB MERGES THESE TWO, which is why both are read rather than "the job's if it has one, else the
 * workflow's" the way `effectivePermissions` reads `permissions:`. Split out of the test below so
 * each scope can be shown to bite: the delivered file has neither block, and an absence assertion
 * over two empty maps proves nothing on its own.
 */
function assertNoAmbientNpmCredential(text, job) {
  const workflow = workflowEnv(text);
  const scopes = [
    ['the workflow-level env:, above `jobs:`', workflow.vars],
    ['its own job-level env:', job.blocks.env ?? {}],
  ];
  for (const [where, vars] of scopes) {
    for (const [name, value] of Object.entries(vars)) {
      assert.ok(
        name !== 'NPM_TOKEN' && name !== 'NODE_AUTH_TOKEN',
        `job \`${job.id}\` hands ${name} to every step it has, through ${where}`,
      );
      assert.doesNotMatch(
        value,
        /secrets\.NPM_TOKEN/,
        `job \`${job.id}\`'s \`${name}\`, set in ${where}, reads the npm secret in the un-approved job`,
      );
    }
  }
  // AND THE BLOCK AS TEXT, so a value the line parser above cannot read is swept rather than
  // skipped: `FOO: >-` on one line and `${{ secrets.NPM_TOKEN }}` on the next parses to `>-` and
  // passes both checks above while reaching every step of both jobs.
  assert.doesNotMatch(
    workflow.raw,
    /secrets\.NPM_TOKEN/,
    'the workflow-level env: block reads the npm secret, so every step of every job can read it',
  );
}

test('AC6: the npm publish credential never reaches the un-gated job', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const workflow = parseWorkflow(text);
  const version = workflow.byId.version;

  // THE AMBIENT `env:` BLOCKS FIRST, both of them, because they are the spellings that reach every
  // step at once while appearing in none of them.
  assertNoAmbientNpmCredential(text, version);
  // ... and neither check is vacuous. The delivered file declares no `env:` at either level, so each
  // scope is proved to bite against a synthetic workflow with the credential planted in it, in the
  // spirit of AC12's `assert.throws` battery. JOB level first:
  const plantedInJob =
    'jobs:\n' +
    '  version:\n' +
    '    env:\n' +
    "      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n" +
    '    steps:\n' +
    '      - run: echo "no step of mine names it, and all of them can read it"\n';
  assert.throws(
    () => assertNoAmbientNpmCredential(plantedInJob, parseWorkflow(plantedInJob).byId.version),
    /hands NODE_AUTH_TOKEN to every step it has, through its own job-level env:/,
  );
  // ... and WORKFLOW level, one line above `jobs:`, which is the spelling that lands in a job
  // without being written in it. Nothing inside either job changes, which is exactly the problem.
  const plantedInWorkflow =
    'env:\n' +
    "  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n" +
    '\n' +
    'jobs:\n' +
    '  version:\n' +
    '    steps:\n' +
    '      - run: echo "neither job names it, and every step of both can read it"\n';
  assert.throws(
    () => assertNoAmbientNpmCredential(plantedInWorkflow, parseWorkflow(plantedInWorkflow).byId.version),
    /hands NODE_AUTH_TOKEN to every step it has, through the workflow-level env:/,
  );
  // ... including under a name AC6 does not know, carried by a value this parser reads as `>-`.
  const foldedInWorkflow =
    'env:\n' +
    '  RELEASE_HELPER: >-\n' +
    "    ${{ secrets.NPM_TOKEN }}\n" +
    'jobs:\n' +
    '  version:\n' +
    '    steps:\n' +
    '      - run: echo "the name is innocent and the value is not"\n';
  assert.throws(
    () => assertNoAmbientNpmCredential(foldedInWorkflow, parseWorkflow(foldedInWorkflow).byId.version),
    /the workflow-level env: block reads the npm secret/,
  );

  for (const step of version.steps) {
    assert.equal(step.env.NPM_TOKEN, undefined, `"${step.label}" hands NPM_TOKEN to the un-approved job`);
    assert.equal(step.env.NODE_AUTH_TOKEN, undefined, `"${step.label}" hands NODE_AUTH_TOKEN to the un-approved job`);
    // `registry-url` is what makes setup-node write `_authToken=${NODE_AUTH_TOKEN}` into an npmrc
    // and point NPM_CONFIG_USERCONFIG at it. A registry credential FILE in a job no human approved
    // is the same defect as the variable, one indirection out.
    assert.equal(
      step.with['registry-url'],
      undefined,
      `"${step.label}" writes a registry credential file in the un-approved job`,
    );
    assert.doesNotMatch(step.body, /secrets\.NPM_TOKEN/, `"${step.label}" reads the npm secret in the un-approved job`);
  }

  // NOT VACUOUS: the credential still exists, and it is in the job the environment holds.
  const publisher = workflow.byId.release.steps.filter((step) => step.env.NODE_AUTH_TOKEN !== undefined);
  assert.equal(publisher.length, 1, 'exactly one step is handed the npm credential');
  assert.equal(publisher[0].env.NPM_TOKEN, '${{ secrets.NPM_TOKEN }}');
  assert.equal(publisher[0].env.NODE_AUTH_TOKEN, '${{ secrets.NPM_TOKEN }}');
  // The publish command itself, pinned WHOLE rather than matched, because this is the string the
  // credential above is spent on. Two arms, both non-empty: the staged one when `publish-floor`
  // reported that the package already exists on the registry, and the direct one otherwise. There
  // is no third arm and no empty arm; withholding is the job-level `if:`, pinned in AC2/AC10.
  assert.equal(
    publisher[0].with.publish,
    "${{ steps.publish-floor.outputs.mode == 'staged' && format('node .cosyte-release-tooling/scripts/" +
      "staged-publish.mjs stage --package {0}', inputs.package-name) || 'pnpm run release' }}",
  );
});

test('AC9: no packing, registry authentication or publishing is reachable past a failed gate', () => {
  const workflow = parseWorkflow(readFileSync(WORKFLOW, 'utf8'));

  // A failed step fails its job and skips every step below it, UNLESS that step opts back in with
  // `always()`, `failure()` or `!cancelled()`. Those three are the only way a step can run after the
  // gate has refused, so the set of steps carrying them is pinned by name, PER JOB, and none of them
  // may pack, authenticate or publish.
  const expected = {
    version: ['Drop the release credentials from disk'],
    release: [
      'Drop the release credentials from disk',
      'Report the staged version for a maintainer',
      'The published package must be installable from the registry',
      'Collect the npm debug log',
      'Upload the npm debug log',
    ],
  };
  for (const job of workflow.jobs) {
    const optsBackIn = job.steps.filter((step) => /always\(|failure\(|cancelled\(/.test(step.fields.if ?? ''));
    assert.deepEqual(
      optsBackIn.map((step) => step.label),
      expected[job.id],
      `a new step in \`${job.id}\` that runs after a failure has to be considered against AC9 rather than added quietly`,
    );
    for (const step of optsBackIn) {
      for (const [label, matches] of Object.entries(CATEGORIES)) {
        if (label === 'checks out a caller tree') continue;
        assert.equal(matches(step), false, `"${step.label}" ${label} and runs after a failure`);
      }
    }
  }

  // And each one that runs on `!cancelled()` is additionally conditioned on a step output that
  // CANNOT hold in a run this gate refused, because the step that would have set it never ran. Both
  // live in the environment-held job, which `needs:` the job the gate is in, so a refused gate
  // means that job never starts at all and neither output is ever written.
  //
  //   the install gate   `changesets/action` never ran, so `published` is empty, not `true`.
  //   the stage report   `publish-floor` runs in the same job, below the gate by job order, so
  //                      `mode` is empty, not `staged`. It also runs no tool: `staged-publish.mjs
  //                      report` reads a file and prints.
  const publishing = workflow.byId.release.steps;
  const installGate = publishing.find(
    (step) => step.label === 'The published package must be installable from the registry',
  );
  assert.match(installGate.fields.if, /steps\.changesets\.outputs\.published == 'true'/);
  const stageReport = publishing.find((step) => step.label === 'Report the staged version for a maintainer');
  assert.match(stageReport.fields.if, /steps\.publish-floor\.outputs\.mode == 'staged'/);

  // THE FLOOR GATE IS BELOW THE PROTECTION GATE ACROSS THE JOB BOUNDARY, which is what the split
  // turned this assertion into: a step index cannot compare two jobs. It is IN the environment-held
  // job (its `mode` is a STEP output, and a step output does not cross a job boundary, so the three
  // conditions that read it have to be its job-mates) and it is in NO other job, and that job
  // `needs:` the one carrying the protection gate. AC3's own test owns the `needs:` half; this
  // pins the placement the reasoning rests on.
  assert.equal(
    publishing.filter((step) => /publish-floor\.mjs/.test(step.body)).length,
    1,
    'the floor gate belongs to the job that publishes, whose runner is the one it measures',
  );
  assert.equal(
    workflow.byId.version.steps.filter((step) => /publish-floor\.mjs/.test(step.body)).length,
    0,
    'a floor gate in the un-gated job would leave `steps.publish-floor.outputs.mode` empty in the job that reads it',
  );
  assert.equal(workflow.byId.release.keys.needs, 'version');
  assert.match(stageReport.body, /staged-publish\.mjs report/, 'it reports; it does not stage or publish');
});

test('AC3 and AC10: both jobs name `contents` alongside `actions: read`', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const workflow = parseWorkflow(text);

  // THE LITERAL ONE-KEY READING, KILLED BY A MANDATED TEST RATHER THAN BY A CALLER'S FIRST RELEASE.
  // "If you specify the access for any of these permissions, all of those that are not specified are
  // set to `none`", so a block whose only key is `actions: read` does not ADD a permission: it strips
  // `contents` off that job, and `actions/checkout` 403s on the very next step, on a FULLY COMPLIANT
  // caller, with none of the fail-closed refusal this gate exists to produce. The split doubled the
  // number of ways to get this wrong, so both jobs are checked, not just the one with the gate in it.
  for (const job of workflow.jobs) {
    const permissions = effectivePermissions(text, job);
    assert.ok(permissions, `job \`${job.id}\` must have permissions in force`);
    assert.equal(permissions.actions, 'read', `job \`${job.id}\` needs \`actions: read\``);
    assert.ok(
      permissions.contents === 'read' || permissions.contents === 'write',
      `\`contents\` must be named in \`${job.id}\` and must grant read, got ${JSON.stringify(permissions.contents)}`,
    );
  }

  // Pinned whole, in both directions. `contents` stays at `write` in both: the version job pushes
  // the changeset-release branch, the release job creates tags and a GitHub release. `id-token` is
  // npm provenance and is deliberately ABSENT from the version job, which cannot publish: a
  // publish-signing token on a runner no human approved is a permission nobody asked for.
  assert.deepEqual(effectivePermissions(text, workflow.byId.version), {
    contents: 'write',
    'pull-requests': 'write',
    actions: 'read',
  });
  assert.deepEqual(effectivePermissions(text, workflow.byId.release), {
    contents: 'write',
    'id-token': 'write',
    'pull-requests': 'write',
    actions: 'read',
  });
});

test('the gate is handed the credential and the default-branch fallback the script expects', () => {
  const workflow = parseWorkflow(readFileSync(WORKFLOW, 'utf8'));
  const gate = allSteps(workflow).find(isGate);
  // The AUTOMATIC token, handed over under the name this file already uses for it. `GITHUB_TOKEN` in
  // release.yml means the credential `changesets/action` opens the Version PR with, which is
  // `RELEASE_PR_TOKEN` where a caller has one: an org-scoped PAT, which is not what should be reading
  // a caller's environments and is not scoped to the calling repository the way this read needs.
  assert.equal(gate.env.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
  assert.equal(gate.env.GITHUB_TOKEN, undefined, 'the gate must not claim the version-PR credential');
  assert.equal(gate.env.DEFAULT_BRANCH_HINT, '${{ github.event.repository.default_branch }}');
});

// ── AC11: the contract with thirteen repositories that pin `@main` ──────────────────────────────
//
// `workflow_call` inputs and secrets are the only thing a caller writes down about this workflow. A
// new REQUIRED input or secret breaks all thirteen on merge, with no adoption step and no rollback
// window, so the whole contract is pinned rather than sampled: anything added has to be optional and
// carry a default, and this assertion is where that is enforced.

/** The `on.workflow_call` inputs and secrets, each as its own map of declared keys. */
function parseCallContract(text) {
  const lines = decomment(text);
  const at = lines.findIndex((line) => /^ {2}workflow_call:\s*$/.test(line));
  if (at < 0) throw new Error('parse failure: release.yml no longer declares `on.workflow_call`');
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') continue;
    if (/^ {0,2}\S/.test(line)) break;
    body.push(line);
  }
  const section = (name) => {
    const start = body.findIndex((line) => new RegExp(`^ {4}${name}:\\s*$`).test(line));
    if (start < 0) throw new Error(`parse failure: \`on.workflow_call.${name}\` is no longer declared`);
    /** @type {Record<string, Record<string, string>>} */
    const out = {};
    let current = null;
    for (const line of body.slice(start + 1)) {
      const entry = /^ {6}([\w-]+):\s*$/.exec(line);
      if (entry) {
        current = {};
        out[entry[1]] = current;
        continue;
      }
      const kv = /^ {8}([\w-]+):\s?(.*)$/.exec(line);
      if (kv && current) {
        current[kv[1]] = kv[2].trim();
        continue;
      }
      if (/^ {0,4}\S/.test(line)) break;
    }
    if (Object.keys(out).length === 0) throw new Error(`parse failure: \`${name}\` parsed to zero entries`);
    return out;
  };
  return { inputs: section('inputs'), secrets: section('secrets') };
}

test('AC11: no caller has to change anything, so every input and secret is the one it already had', () => {
  const { inputs, secrets } = parseCallContract(readFileSync(WORKFLOW, 'utf8'));

  assert.deepEqual(Object.keys(inputs), ['package-name', 'dispatch-docs', 'pack-docs-cmd', 'expect-unpublished-deps']);
  assert.deepEqual(Object.keys(secrets), ['NPM_TOKEN', 'DOCS_REPO_DISPATCH_TOKEN', 'RELEASE_PR_TOKEN']);

  // Exactly one required input and exactly one required secret, and they are the two every caller
  // already passes. The rule for anything new is in the loop below rather than in this list.
  assert.equal(inputs['package-name'].required, 'true');
  assert.equal(secrets.NPM_TOKEN.required, 'true');
  assert.equal(secrets.DOCS_REPO_DISPATCH_TOKEN.required, 'false');
  assert.equal(secrets.RELEASE_PR_TOKEN.required, 'false');

  for (const [name, declared] of Object.entries(inputs)) {
    if (name === 'package-name') continue;
    assert.equal(declared.required, undefined, `input \`${name}\` must not be required: thirteen callers pin @main`);
    assert.ok(declared.default !== undefined, `input \`${name}\` must carry a default`);
  }
  for (const [name, declared] of Object.entries(secrets)) {
    if (name === 'NPM_TOKEN') continue;
    assert.equal(declared.required, 'false', `secret \`${name}\` must be optional: thirteen callers pin @main`);
  }
});

// The caller-side precondition is the one thing about this change that cannot be enforced from this
// repository, so the least it can do is be written down where a maintainer adopting this file reads
// it. A file that requests a permission its callers have not granted, and does not say so, spends
// its first release explaining itself in a startup error instead.
test('release.yml documents the caller-side `actions: read` grant it now depends on', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /THE CALLER-SIDE PRECONDITION/);
  assert.match(workflow, /#\s+permissions:.*\n#\s+actions: read/);
  assert.match(workflow, /only be downgraded \(not elevated\)|ELEVATION/);
});
