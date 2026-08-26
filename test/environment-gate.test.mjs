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

/** A step's own keys sit here, one level under the `- ` that opens the list entry. */
const STEP_KEY_INDENT = 8;

/**
 * A key-line value that is not the value: the key's real value is on the lines below it.
 *
 * Empty, or a block-scalar indicator (`|`, `>`, either with a chomping or an indentation modifier).
 * YAML says all of those mean "read on", and a line-oriented reader that stops at the colon comes
 * back holding `""` or `">-"` and believes it. That is the failure this constant exists to name:
 * not a line the reader could not read, which it refuses, but a line it read and got WRONG, which
 * it used to hand on to an assertion as if it were a condition.
 */
const VALUE_LIVES_BELOW = /^(?:[|>][+-]?\d*)?$/;

/**
 * The value that lives on the lines below `lines[at]`, folded onto one line.
 *
 * Everything more indented than the key, blanks skipped, joined with single spaces - which is what
 * a folded scalar (`>-`) means and is close enough for a literal one (`|`) too, because every
 * caller here matches patterns against the result rather than executing it. Stops at the first line
 * that is not deeper than the key, which is where the key's value ends.
 */
function valueBelow(lines, at) {
  if (at < 0) return '';
  const indentOf = (line) => line.length - line.replace(/^[ \t]*/, '').length;
  const keyIndent = indentOf(lines[at]);
  const folded = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') continue;
    if (indentOf(line) <= keyIndent) break;
    folded.push(line.trim());
  }
  return folded.join(' ');
}

/**
 * Parse ONE step from the raw lines of a `- ` list entry under a job's `steps:`.
 *
 * `fields` are the step's own keys; `with` and `env` are their nested maps, read only while the
 * parser is positioned inside those two blocks, so a `run: |` script line can never be mistaken for
 * an input or a variable.
 *
 * IT REFUSES A LINE IT CANNOT READ, WHICH IS THE WHOLE POINT AND WAS NOT TRUE OF THE FIRST VERSION.
 * That version dropped a line at step-key level that its key pattern did not match, and the pattern
 * requires the colon to touch the key: `        if : ${{ ... }}` - one space before the colon - is
 * valid YAML, a real condition GitHub acts on and actionlint typechecks, and it went straight onto
 * the floor. `fields.if` then came back `undefined` for a step that carries a condition, and every
 * step-condition assertion in this file (AC1's version arm, AC3's gate, AC9's opt-back-in set) read
 * such a step as unconditional and stayed green. That is the asymmetry this now removes: the JOB
 * reader below has always thrown on the same class of input, and AC12 states the principle in as
 * many words - a parser that cannot read its subject must fail explicitly rather than assert over
 * what it managed to salvage. A dropped line is exactly that, one line at a time.
 *
 * SO EVERY LINE HANDED TO THIS FUNCTION IS ACCOUNTED FOR, at one of three levels:
 *
 *   - at `STEP_KEY_INDENT`, it is a step key or it is a parse failure naming the job and the step;
 *   - inside an open `with:`/`env:` block, at whatever indent that block's FIRST child established
 *     (ten spaces here, but discovered rather than hardcoded, so a block written at nine is read
 *     rather than skipped), it is a child key, or a `- ` item continuing the child key above it, or
 *     it is a parse failure;
 *   - deeper than either, it is the body of a block scalar (`run: |` and friends) or the wrapped
 *     continuation of a plain one, and it carries no key this file asserts on.
 *
 * THE SEQUENCE ITEM IS READ RATHER THAN REFUSED, and that is the one direction this reader was
 * wrong in the other way. YAML lets a sequence sit at its parent key's own indent, so
 * `path:` followed by `- dist-artifacts/a` at the SAME column is legal, common in
 * `actions/upload-artifact` inputs, and was refused here as illegible. Refusing legal YAML fails
 * closed, so it never let a criterion go unenforced - but it spends the next maintainer's afternoon
 * on a parse failure that is not a real finding, and this parser's contract is to refuse what it
 * cannot READ, not what it has not SEEN. The item is appended to the key it belongs to, so nothing
 * is dropped: an input written as a sequence still has a value, and every absence assertion over
 * `with`/`env` still sees it. An item under no key at all, or under a key that already carries a
 * scalar, is not legal YAML and still refuses.
 *
 * Shallower than a step key means the step list has ended and something this parser does not model
 * has begun, so that refuses too. `run:` bodies in release.yml sit at ten spaces or more, verified
 * rather than assumed by `probe_0161_eight_space_indent.mjs` beside the spec, so the eight-space
 * rule cannot fire on a script line.
 *
 * A `with:` or `env:` carrying a value instead of opening a block (a flow mapping, `env: {A: b}`)
 * refuses for the same reason: this parser cannot read one, and returning an empty map for it would
 * report "no such input" about inputs that are there.
 */
function parseStep(index, jobId, rawLines) {
  const lines = [`        ${rawLines[0]}`, ...rawLines.slice(1)];
  /** @type {Record<string, string>} */
  const fields = {};
  const blocks = { with: {}, env: {} };
  const unreadable = (line, where) =>
    new Error(
      `parse failure: unreadable line in step ${index} of job \`${jobId}\`${where}: ${JSON.stringify(line)}`,
    );

  /** `null` at step-key level; otherwise the open block and the indent its children were found at. */
  let open = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = line.length - line.replace(/^ */, '').length;

    if (open && open.indent === null && indent > STEP_KEY_INDENT) open.indent = indent;
    if (open && open.indent !== null && indent >= open.indent) {
      if (indent > open.indent) continue; // the body of a child's own scalar
      const item = new RegExp(`^ {${open.indent}}- (.*)$`).exec(line);
      if (item) {
        const under = open.last === null ? null : blocks[open.key][open.last];
        if (under === null || !(under === '' || under.startsWith('\n- '))) {
          throw unreadable(line, `, a sequence item inside \`${open.key}:\` under no key it can belong to`);
        }
        blocks[open.key][open.last] = `${under}\n- ${stripTrailingComment(item[1])}`;
        continue;
      }
      const child = new RegExp(`^ {${open.indent}}([\\w-]+):\\s?(.*)$`).exec(line);
      if (!child) throw unreadable(line, `, inside \`${open.key}:\``);
      blocks[open.key][child[1]] = stripTrailingComment(child[2]);
      open.last = child[1];
      continue;
    }
    open = null; // anything shallower than the children closes the block

    if (indent > STEP_KEY_INDENT) continue; // a block scalar's body, or a wrapped plain scalar
    if (indent < STEP_KEY_INDENT) throw unreadable(line, ', shallower than this step');
    const key = /^ {8}([\w-]+):\s?(.*)$/.exec(line);
    if (!key) throw unreadable(line, '');
    fields[key[1]] = stripTrailingComment(key[2]);
    if (key[1] === 'with' || key[1] === 'env') {
      if (fields[key[1]] !== '') throw unreadable(line, `, a \`${key[1]}:\` this parser cannot read`);
      open = { key: key[1], indent: null, last: null };
    } else {
      open = null;
    }
  }
  // AND A CONDITION WHOSE VALUE IS NOT ON ITS OWN LINE IS STILL THIS STEP'S CONDITION. `if: >-` with
  // the expression on the next line, and a bare `if:` with the same, are the identical condition to
  // Actions and used to leave `fields.if` holding the block-scalar indicator `">-"`. That is legible
  // to the reader and WRONG, which is worse than illegible: `undefined` is refused, `">-"` is
  // believed. AC9 classifies opt-back-in steps by what the condition SAYS, so a step whose
  // `always()` lived one line down never joined the set it had to be accounted for in.
  if (fields.if !== undefined && VALUE_LIVES_BELOW.test(fields.if.trim())) {
    const at = lines.findIndex((line) => /^ {8}if:/.test(line));
    fields.if = `${fields.if} ${valueBelow(lines, at)}`.trim();
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
 * A step-level condition spelled as TEXT, in every spelling of the key, restored from `origin/main`.
 *
 * `["']?` optional and `\s*` before the colon: that sees `if:`, `if :` and `"if":`, which are the
 * three spellings a refuter has already got past a version of these suites. It lived in
 * `test/release-notes.test.mjs` before the split, with a comment recording why it had to, and this
 * branch replaced it with a parser read plus a pattern requiring the quotes. The parser could not
 * answer for the middle spelling, so the coverage the comment claimed was gone.
 *
 * IT IS BACK BESIDE THE PARSER FIX RATHER THAN INSTEAD OF IT, and the redundancy is the point. The
 * parser refusing an unreadable line is the guarantee; this is the backstop that keeps biting if a
 * later edit loosens the parser again, which is exactly the edit that already happened once. A guard
 * this repository's own history says it needed is not removed on the strength of the mechanism it
 * exists to check. Constraints 7 of the spec asks for MORE assertion here, not the minimum that
 * closes today's finding.
 *
 * It does NOT match `if-no-files-found:` or a shell `if [ ... ]; then` in a `run:` body: the colon
 * has to follow the key, with only quotes and blanks between.
 */
const STEP_CONDITION_LINE = /^\s*["']?if["']?\s*:/m;

/**
 * The same, as a scan: every condition a step spells, however it spells the key AND WHEREVER IT PUTS
 * THE VALUE.
 *
 * The second half is what this used to get wrong. Taking the text after the colon is right for
 * `if: ${{ always() }}` and wrong for `if: >-` with the expression on the next line: that returns
 * the block-scalar indicator `">-"`, which is not `undefined`, so every check that only needs a
 * condition to EXIST still fires (AC1's version arm, AC3's gate) while the one that needs the
 * condition's CONTENT quietly reads a step's `always()` as no `always()` at all. AC9 is that check:
 * it pins the set of steps that opt back in after a failure, by name, per job, so a step invisible
 * to the classification never joins the set and the pinned list still matches exactly.
 *
 * So a key line whose value lives below it is folded with the lines below it, in the same helper the
 * parser uses for `fields.if`. This scan is kept BESIDE that parser read rather than replaced by it,
 * for the reason `STEP_CONDITION_LINE` above is: the parser is the guarantee and the text scan is
 * what keeps biting if the parser is loosened again.
 */
function conditionsOf(step) {
  const lines = step.body.split('\n');
  const spelled = [];
  for (const [at, line] of lines.entries()) {
    const key = /^[ \t]*["']?if["']?[ \t]*:(.*)$/.exec(line);
    if (!key) continue;
    const value = key[1];
    spelled.push(VALUE_LIVES_BELOW.test(value.trim()) ? `${value} ${valueBelow(lines, at)}` : value);
  }
  return [step.fields.if ?? '', ...spelled].join(' ');
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
      job = { id: jobStart[1], keys: {}, blocks: {}, raw: {}, preamble: [], steps: [] };
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
      job.preamble.push(line);
      const key = /^ {4}([\w-]+):\s?(.*)$/.exec(line);
      if (key) {
        job.keys[key[1]] = stripTrailingComment(key[2]);
        job.raw[key[1]] = key[2];
        if (job.keys[key[1]] === '') {
          job.blocks[key[1]] = {};
          openBlock = key[1];
          continue;
        }
        openBlock = null;
        // A JOB-LEVEL `env:` THAT DOES NOT OPEN A BLOCK IS STILL EVERY STEP'S ENVIRONMENT. The
        // one-line flow mapping `env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" }` is the same
        // thing Actions does with the block spelling, and this reader used to store it as an
        // ordinary key value and create no block at all, so a read of `job.blocks.env` came back
        // EMPTY about a job that hands the npm write credential to every step it has. That is the
        // shape of AC6's whole family of findings, one scope in: the spelling someone thought to
        // write is closed and the one they did not is open. It is read here the way `workflowEnv`
        // reads it one scope up, and a value that is neither a block nor a flow mapping this reader
        // can close refuses outright, which is what `parseStep` already does one scope down.
        if (key[1] === 'env') {
          if (!/^\{.*\}$/.test(job.keys.env)) {
            throw new Error(
              `parse failure: unreadable line in job \`${job.id}\`, a \`env:\` this parser cannot read: ` +
                JSON.stringify(line),
            );
          }
          job.blocks.env = flowMappingPairs(job.keys.env);
        }
        continue;
      }
      const child = /^ {6}([\w-]+):\s?(.*)$/.exec(line);
      if (child && openBlock) {
        job.blocks[openBlock][child[1]] = stripTrailingComment(child[2]);
        job.raw[openBlock] = `${job.raw[openBlock]}\n${line}`;
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
 * The npm write credential, in EVERY form a workflow expression can name it.
 *
 * WHY THIS IS A CONSTANT AND NOT A LITERAL AT EACH SITE. Every absence check for this credential is
 * ultimately a TEXT match, and a text match is only as complete as the spelling it was written
 * against. Four of them were written against `secrets.NPM_TOKEN`, which is one of the two forms
 * GitHub's expression language has: property dereference, and the INDEX form
 * `secrets['NPM_TOKEN']`, which the docs give as an exact equivalent ("you can use the index syntax
 * to access properties"). `secrets["NPM_TOKEN"]` is the same thing again with the other quote. All
 * of them evaluate to the same secret and reach the same steps, and none of the index ones contains
 * the substring `secrets.NPM_TOKEN`, so a guard written against that substring alone is closed for
 * the spelling its author had in mind and open for the other. That is the shape of the finding this
 * whole family of checks exists to answer, one turn further out.
 *
 * WHY THIS ENDS IT RATHER THAN ADDING ONE MORE SPELLING TO THE LIST. The key that carries the
 * credential has unboundedly many spellings, which is why the sweeps below read text instead of
 * parsing it. The credential REFERENCE does not: an expression names a context member by `.` or by
 * `[...]`, those are the two the language has, and both are enumerated here. There is no third form
 * left to be surprised by, so this is a closure and not a patch.
 *
 * DELIBERATELY BROADER THAN THE FOUR LITERALS IT REPLACES, never narrower: everything the old
 * `/secrets\.NPM_TOKEN/` matched still matches (no word boundary is added, so `NPM_TOKEN_OLD` is
 * still caught the way it was), and the index forms are added on top. Whitespace is tolerated
 * around the dot and inside the brackets because the expression lexer tolerates it there. What it
 * must NOT match is the `workflow_call` declaration's own `NPM_TOKEN:` key, which names the secret
 * without reading it and which the preamble sweep runs straight over; that is asserted below rather
 * than assumed.
 */
const NPM_SECRET_REF = /secrets\s*(?:\.\s*NPM_TOKEN|\[\s*['"]NPM_TOKEN)/;

/**
 * Refuse a `secrets[...]` index whose key is not a literal this check can read.
 *
 * THE LAST WAY OUT OF `NPM_SECRET_REF`, AND IT IS CLOSED BY FAILING RATHER THAN BY MATCHING. The two
 * forms above are the two ways an expression NAMES a secret, and enumerating them is a closure only
 * for keys written as literals. `secrets[format('NPM{0}', '_TOKEN')]` and `secrets[env.WHICH]` name
 * a secret too, and which one they name is not decidable from this file, so no pattern over the text
 * can ever answer it. Adding a cleverer pattern is the move that has already been made twice here.
 *
 * So an unresolvable index is REFUSED instead of read, which is this repository's existing answer to
 * exactly this shape: the gate itself refuses protection it cannot read rather than treating
 * unreadable protection as protection (AC5), and the workflow parser fails explicitly rather than
 * asserting over a list it could not build (AC12). An absence claim that cannot resolve its subject
 * has to fail CLOSED, because the alternative is reporting "no credential here" about an expression
 * nobody read.
 *
 * It costs nothing today and it is not a ban on dynamic secrets in general: the delivered workflow
 * indexes `secrets` nowhere at all, and this runs only where the npm credential must not be, which is
 * the preamble and the un-approved job. A future step that genuinely needs a computed secret in
 * `version` writes the literal, or states its case here.
 */
function assertNoUnresolvableSecretIndex(text, where) {
  for (const match of String(text).matchAll(/secrets\s*\[[^\]]*\]?/g)) {
    assert.match(
      match[0],
      /^secrets\s*\[\s*['"][^'"]*['"]\s*\]$/,
      `${where} reads \`secrets\` through an index nothing here can resolve (\`${match[0].trim()}\`), so it cannot be shown not to name the npm write credential`,
    );
  }
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
 *
 * THREE SPELLINGS OF THE KEY, because YAML has three and Actions accepts all three: the bare block
 * `env:`, the quoted `"env":` (the same dodge M12 of the gate probe writes against `if:`), and the
 * one-line flow mapping `env: { A: b }`. Reading only the first is how a guard ends up closed for
 * the spelling someone thought to write and open for the one they did not, which is the defect this
 * function was added for in the first place. The flow-mapping read is deliberately best-effort - it
 * exists so the failure message can NAME the variable - and the guarantee sits in the raw sweeps in
 * `assertNoAmbientNpmCredential`, which read text rather than parsing it and so cannot be
 * out-spelled BY THE KEY. Being out-spelled by the CREDENTIAL REFERENCE is a separate axis and a
 * separate closure: see `NPM_SECRET_REF` above, which is what every one of those sweeps matches
 * with. An earlier version of this sentence claimed the text sweeps "cannot be out-spelled" full
 * stop, and they could, in the index form.
 */
/**
 * The pairs of a one-line YAML flow mapping, `{ A: b, C: "d" }`.
 *
 * ONE READER, USED AT BOTH SCOPES THAT CAN CARRY ONE, which is the point of extracting it. The
 * workflow-level `env:` has read this spelling since F4; the job-level `env:` did not, and a
 * job-level flow mapping hands the npm write credential to every step of the un-approved job while
 * `job.blocks.env` reports an empty map. Two scopes reading the same syntax with two different
 * pieces of code is how one of them ends up a spelling behind the other, so there is now one.
 *
 * Best-effort, deliberately, and it is not the guarantee: it exists so a failure message can NAME
 * the variable. The guarantees are the raw text sweeps in `assertNoAmbientNpmCredential`, which
 * cannot be out-spelled by the key at all.
 */
function flowMappingPairs(text) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const [, name, value] of String(text).matchAll(/([\w-]+)\s*:\s*("[^"]*"|'[^']*'|[^,}]*)/g)) {
    vars[name] = value.trim().replace(/^["']|["']$/g, '');
  }
  return vars;
}

function workflowEnv(text) {
  const lines = decomment(text);
  const at = lines.findIndex((line) => /^(?:env|"env"|'env'):/.test(line));
  if (at < 0) return { vars: {}, raw: '' };
  /** @type {Record<string, string>} */
  const vars = {};
  const raw = [];

  // FLOW MAPPING FIRST: everything after the colon on the key's own line. `env: { A: b, C: d }` is
  // the whole block, so there is no indented body below it to walk.
  const inline = /^(?:env|"env"|'env'):\s*(\S.*)$/.exec(lines[at]);
  if (inline) {
    raw.push(inline[1]);
    return { vars: flowMappingPairs(inline[1]), raw: raw.join('\n') };
  }

  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break; // a new top-level key closes the block
    raw.push(line);
    const match = /^ {2}([\w-]+):\s?(.*)$/.exec(line);
    if (match) vars[match[1]] = stripTrailingComment(match[2]);
  }
  return { vars, raw: raw.join('\n') };
}

/**
 * Everything above `jobs:`, comments removed - the workflow preamble as text.
 *
 * The backstop under every parsed read of the workflow-level environment. A parser can always be
 * out-spelled: a multi-line flow mapping, an anchor, a key this line-oriented reader does not
 * recognise. Text cannot. The npm write credential is `secrets.NPM_TOKEN` and there is no legitimate
 * reason for that expression to appear above `jobs:`, where the only key that evaluates it into
 * every job at once is `env:`, so its ABSENCE from the preamble is asserted directly and no spelling
 * of the key has to be anticipated to get there.
 */
function workflowPreamble(text) {
  const lines = decomment(text);
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt < 0) throw new Error('parse failure: release.yml has no top-level `jobs:` key');
  return lines.slice(0, jobsAt).join('\n');
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

  // AND IT REFUSES INSIDE A STEP, which is where it used to fail OPEN one line at a time. A step-key
  // line the reader cannot parse was silently discarded, so `        if : ${{ ... }}` - valid YAML, a
  // real condition, typechecked by actionlint - left `fields.if` undefined and every assertion above
  // that a step "runs unconditionally" passed over a conditional step. Vacuity does not only arrive
  // as an empty list; a field that answers `undefined` about a key that is there is the same failure
  // at field granularity, and AC12's subject is both.
  const step = (body) => `jobs:\n  release:\n    steps:\n      - name: x\n${body}`;
  assert.throws(() => parseWorkflow(step("        if : ${{ always() }}\n")), /unreadable line in step 0 of job `release`/);
  assert.throws(() => parseWorkflow(step('        "if": ${{ always() }}\n')), /unreadable line in step 0 of job `release`/);
  assert.throws(
    () => parseWorkflow(step('        with:\n          publish : pnpm run release\n')),
    /unreadable line in step 0 of job `release`, inside `with:`/,
  );
  assert.throws(
    () => parseWorkflow(step('        env: { NODE_AUTH_TOKEN: x }\n')),
    /unreadable line in step 0 of job `release`, a `env:` this parser cannot read/,
  );
  assert.throws(() => parseWorkflow(step('    outputs:\n')), /unreadable line in step 0 of job `release`, shallower/);
  assert.throws(
    () => parseWorkflow(step('        with:\n          - dist-artifacts/a\n')),
    /a sequence item inside `with:` under no key it can belong to/,
  );
  assert.throws(
    () => parseWorkflow(step('        with:\n          path: dist\n          - dist-artifacts/a\n')),
    /a sequence item inside `with:` under no key it can belong to/,
  );

  // AND AT JOB LEVEL, where the same silent-skip lived one scope up and is the wider hole of the
  // two: a job key reaches every step of the job at once. A `env:` written as a one-line flow
  // mapping used to be stored as an ordinary key value with no block created at all, so a read of
  // `job.blocks.env` answered "no variables here" about a job holding the npm write credential.
  assert.throws(
    () => parseWorkflow('jobs:\n  version:\n    env: {\n    steps:\n      - run: x\n'),
    /unreadable line in job `version`, a `env:` this parser cannot read/,
  );
  assert.throws(
    () => parseWorkflow('jobs:\n  version:\n    env: *defaults\n    steps:\n      - run: x\n'),
    /unreadable line in job `version`, a `env:` this parser cannot read/,
  );

  // AND IT READS WHAT IT CAN READ, which is the other half of a fail-closed contract and the half
  // that is easy to lose. A reader that refuses everything it has not seen before is not strict, it
  // is broken: the next maintainer meets a parse failure that names no real defect and the cheapest
  // way out of it is to loosen the refusal that matters. These four are legal YAML with a real
  // meaning, and each is READ rather than refused.
  const seq = parseWorkflow(
    'jobs:\n  release:\n    steps:\n      - name: x\n        with:\n          path:\n          - a\n          - b\n',
  );
  assert.equal(seq.byId.release.steps[0].with.path, '\n- a\n- b', 'a sequence at its parent key indent is a value');
  const nested = parseWorkflow(
    'jobs:\n  release:\n    steps:\n      - name: x\n        with:\n          path:\n            - a\n',
  );
  assert.equal(nested.byId.release.steps[0].with.path, '', 'the indented sequence spelling is read too');
  const flow = parseWorkflow('jobs:\n  version:\n    env: { A: b, C: "d" }\n    steps:\n      - run: x\n');
  assert.deepEqual(flow.byId.version.blocks.env, { A: 'b', C: 'd' }, 'a job-level flow mapping is a job-level env');
  const folded = parseWorkflow(
    'jobs:\n  release:\n    steps:\n      - name: x\n        if: >-\n          ${{ always() }}\n        run: y\n',
  );
  assert.equal(
    folded.byId.release.steps[0].fields.if,
    '>- ${{ always() }}',
    'a condition whose value is on the next line is that step\'s condition, not the string ">-"',
  );
  assert.match(conditionsOf(folded.byId.release.steps[0]), /always\(/, 'and AC9 can see it');
  const bare = parseWorkflow(
    'jobs:\n  release:\n    steps:\n      - name: x\n        if:\n          ${{ failure() }}\n        run: y\n',
  );
  assert.equal(bare.byId.release.steps[0].fields.if, '${{ failure() }}', 'a bare `if:` reads its value below too');
  assert.match(conditionsOf(bare.byId.release.steps[0]), /failure\(/);

  // AND THE TEXT BACKSTOP RECOGNISES WHAT IT CLAIMS TO. `assert.doesNotMatch` over a step that never
  // carried a condition passes whether or not its pattern is any good, which is how the spaced
  // spelling survived in the first place: the pattern that replaced `origin/main`'s guard REQUIRED
  // the quotes, and nothing ever asked it what it matched. It is asked here, in both directions.
  for (const spelling of [
    '        if: ${{ always() }}',
    '        if : ${{ always() }}',
    '        "if": ${{ always() }}',
    "        'if' : ${{ always() }}",
  ]) {
    assert.match(spelling, STEP_CONDITION_LINE, `${JSON.stringify(spelling)} is a real condition`);
  }
  for (const near of [
    '        if-no-files-found: ignore',
    '          if [ -z "$NOTES" ]; then',
    '        name: publish if: ready',
  ]) {
    assert.doesNotMatch(near, STEP_CONDITION_LINE, `${JSON.stringify(near)} is not a step condition`);
  }
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
  assert.doesNotMatch(
    action[0].body,
    STEP_CONDITION_LINE,
    'the version-PR step must run unconditionally in every spelling of the key: `if:`, `if :`, `"if":`',
  );
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
  assert.doesNotMatch(
    gate.body,
    STEP_CONDITION_LINE,
    'a gate behind a step condition is a gate that can be skipped, in every spelling of the key',
  );
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
 *
 * FOUR LAYERS, AND THE JOB SCOPE NOW HAS THE SAME FOUR THE WORKFLOW SCOPE HAS. The parsed maps name
 * the variable in the failure message; the raw `env:` text catches a value the line reader cannot
 * resolve; and the PREAMBLE sweep - every line of the scope above the thing it contains, `jobs:` for
 * the workflow and `steps:` for a job - catches a key nobody here anticipated. The job scope used to
 * stop at the first of those and read one spelling of `env:` at that, so a one-line flow mapping
 * reached every step of the un-approved job with all three suites green. Symmetry between the two
 * scopes is not tidiness here: it is the property that stops one of them being a spelling behind.
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
        NPM_SECRET_REF,
        `job \`${job.id}\`'s \`${name}\`, set in ${where}, reads the npm secret in the un-approved job`,
      );
      assertNoUnresolvableSecretIndex(value, `job \`${job.id}\`'s \`${name}\`, set in ${where},`);
    }
  }
  // AND THE BLOCK AS TEXT, so a value the line parser above cannot read is swept rather than
  // skipped: `FOO: >-` on one line and `${{ secrets.NPM_TOKEN }}` on the next parses to `>-` and
  // passes both checks above while reaching every step of both jobs.
  assert.doesNotMatch(
    workflow.raw,
    NPM_SECRET_REF,
    'the workflow-level env: block reads the npm secret, so every step of every job can read it',
  );
  // ... and the JOB's own env: as text, for the same reason at the scope below it.
  assert.doesNotMatch(
    job.raw.env ?? '',
    NPM_SECRET_REF,
    `job \`${job.id}\`'s own env: reads the npm secret, so every step it has can read it`,
  );
  assertNoUnresolvableSecretIndex(job.raw.env ?? '', `job \`${job.id}\`'s own env:`);
  // AND THE JOB'S WHOLE PREAMBLE AS TEXT - every line of it above `steps:` - which is to this scope
  // exactly what the workflow-preamble sweep below is to the one above it, and it is here for the
  // same reason. Every check up to this line has to RECOGNISE a key before it can read a value, so
  // each is closed only for the keys someone thought of: `env:` is the one that hands a credential
  // to every step at once, but it is not the only one that can (`container:` and `services:` carry
  // `credentials:`, and a key that postdates this file carries whatever it carries). This asserts
  // the npm write credential is not named in this job's own keys AT ALL, under any key, in any
  // syntax. Safe to assert flatly because it runs only for the job the credential must never reach:
  // the delivered `version` job names it nowhere, and `release`, which legitimately holds it, is
  // never passed to this function.
  assert.doesNotMatch(
    job.preamble.join('\n'),
    NPM_SECRET_REF,
    `job \`${job.id}\` names the npm secret in its own keys, above \`steps:\`, where a key that carries it hands it to every step`,
  );
  assertNoUnresolvableSecretIndex(job.preamble.join('\n'), `job \`${job.id}\`'s own keys`);
  // AND THE WHOLE PREAMBLE AS TEXT, which is the backstop that closes the spelling game rather than
  // adding one more spelling to it. Every check above this line has to RECOGNISE the key before it
  // can read the value, so each of them is only ever closed for the spellings someone thought of.
  // This one asserts that the npm write credential is not named above `jobs:` at all, in any syntax,
  // under any key: a multi-line flow mapping, an anchor, a form of `env:` that postdates this file.
  // Safe to assert flatly because the delivered preamble names it nowhere - the `workflow_call`
  // declaration spells it `NPM_TOKEN:`, without the `secrets` context an expression needs to READ
  // it in either of the two forms `NPM_SECRET_REF` knows.
  assert.doesNotMatch(
    workflowPreamble(text),
    NPM_SECRET_REF,
    'the npm secret is read above `jobs:`, where the only thing that can consume it hands it to every job',
  );
  // ... and the preamble may not reach `secrets` through an index that cannot be resolved to a name,
  // which is the one remaining way to name the credential without spelling it.
  assertNoUnresolvableSecretIndex(workflowPreamble(text), 'the workflow preamble');
}

/**
 * The npm write credential must not be reachable from any STEP of a job: not as a variable it sets,
 * not as a registry credential file it asks `setup-node` to write, and not as an expression its own
 * body reads.
 *
 * Extracted from the test below so it can be shown to BITE, the way the ambient check above is.
 * `assert.doesNotMatch` over a delivered file that has never carried the credential passes whether
 * or not the pattern it matches with is any good, and "the pattern was not good enough" is exactly
 * how the index spelling stayed reachable through five earlier proofs.
 */
function assertNoStepNpmCredential(job) {
  for (const step of job.steps) {
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
    // The step's RAW text, so a value under a name nothing here knows is still refused, in either
    // form an expression can name the secret.
    assert.doesNotMatch(step.body, NPM_SECRET_REF, `"${step.label}" reads the npm secret in the un-approved job`);
    assertNoUnresolvableSecretIndex(step.body, `"${step.label}"`);
  }
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
  // ... and the SAME SCOPE IN THE OTHER TWO SPELLINGS, which is where this check was a spelling
  // behind the workflow-level one. A one-line flow mapping is what Actions does with the block
  // above, written differently; it created no block at all here, so the read came back empty about
  // a job that hands the npm write credential to every step it has.
  const flowInJob =
    'jobs:\n' +
    '  version:\n' +
    '    env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" }\n' +
    '    steps:\n' +
    '      - run: echo "one line, no block, and every step of this job holds the token"\n';
  assert.throws(
    () => assertNoAmbientNpmCredential(flowInJob, parseWorkflow(flowInJob).byId.version),
    /hands NODE_AUTH_TOKEN to every step it has, through its own job-level env:/,
  );
  // ... under a name none of the name checks know, so it is the VALUE that has to be read:
  const flowInJobInnocentName =
    'jobs:\n' +
    '  version:\n' +
    '    env: { RELEASE_HELPER: "${{ secrets.NPM_TOKEN }}" }\n' +
    '    steps:\n' +
    '      - run: echo "the name says nothing and the value says everything"\n';
  assert.throws(
    () => assertNoAmbientNpmCredential(flowInJobInnocentName, parseWorkflow(flowInJobInnocentName).byId.version),
    /`RELEASE_HELPER`, set in its own job-level env:.*reads the npm secret/,
  );
  // ... and in a flow mapping whose PAIRS this reader cannot split, which is what the raw sweep of
  // the job's own `env:` text exists for, exactly as at workflow level. A quoted key inside the
  // braces defeats the pair reader completely - it comes back with no variables at all - and the
  // text it came back empty about still hands the credential to every step of the job.
  const unsplittableInJob =
    'jobs:\n' +
    '  version:\n' +
    '    env: { "NODE_AUTH_TOKEN": "${{ secrets.NPM_TOKEN }}" }\n' +
    '    steps:\n' +
    '      - run: echo "no pair reader here splits this, and Actions does"\n';
  assert.deepEqual(
    parseWorkflow(unsplittableInJob).byId.version.blocks.env,
    {},
    'the quoted key inside the braces is meant to defeat the PARSED read - if it stops doing so, re-derive this proof',
  );
  assert.throws(
    () => assertNoAmbientNpmCredential(unsplittableInJob, parseWorkflow(unsplittableInJob).byId.version),
    /job `version`'s own env: reads the npm secret/,
  );
  // ... and finally UNDER A KEY THAT IS NOT `env:` AT ALL, which is what the job-preamble sweep is
  // for and why the job scope needed one. `container:` carries `credentials:`, and a job key that
  // postdates this file carries whatever it carries; no enumeration of keys closes that, and a text
  // sweep of the job's own lines does.
  const underAnotherJobKey =
    'jobs:\n' +
    '  version:\n' +
    '    container:\n' +
    '      image: node:22\n' +
    '    steps:\n' +
    '      - run: echo "not an env: anywhere, and the credential is on this runner"\n';
  assertNoAmbientNpmCredential(underAnotherJobKey, parseWorkflow(underAnotherJobKey).byId.version);
  const credentialUnderAnotherJobKey = underAnotherJobKey.replace(
    '      image: node:22\n',
    '      image: node:22\n      password: ${{ secrets.NPM_TOKEN }}\n',
  );
  assert.throws(
    () =>
      assertNoAmbientNpmCredential(
        credentialUnderAnotherJobKey,
        parseWorkflow(credentialUnderAnotherJobKey).byId.version,
      ),
    /job `version` names the npm secret in its own keys, above `steps:`/,
  );
  // ... including through an index nothing here can resolve, refused rather than read, the way the
  // workflow preamble's is.
  const computedIndexInJob =
    'jobs:\n' +
    '  version:\n' +
    "    env: { RELEASE_HELPER: \"${{ secrets[format('NPM{0}', '_TOKEN')] }}\" }\n" +
    '    steps:\n' +
    '      - run: echo "assembled at run time, unreadable here"\n';
  assert.throws(
    () => assertNoAmbientNpmCredential(computedIndexInJob, parseWorkflow(computedIndexInJob).byId.version),
    /reads `secrets` through an index nothing here can resolve/,
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
  // ... and under each of the OTHER TWO SPELLINGS OF THE KEY that Actions accepts. Neither changes
  // what the file does; both change what a reader looking for `^env:$` can see, which is the whole
  // point of writing it that way. The one-line flow mapping:
  const flowInWorkflow =
    'env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" }\n' +
    'jobs:\n' +
    '  version:\n' +
    '    steps:\n' +
    '      - run: echo "one line, and every step of both jobs can read it"\n';
  assert.throws(
    () => assertNoAmbientNpmCredential(flowInWorkflow, parseWorkflow(flowInWorkflow).byId.version),
    /hands NODE_AUTH_TOKEN to every step it has, through the workflow-level env:/,
  );
  // ... and the quoted key, which is the dodge the gate probe's M12 writes against `if:`:
  const quotedInWorkflow =
    '"env":\n' +
    "  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n" +
    'jobs:\n' +
    '  version:\n' +
    '    steps:\n' +
    '      - run: echo "two quote marks, and the reader looking for ^env:$ goes blind"\n';
  assert.throws(
    () => assertNoAmbientNpmCredential(quotedInWorkflow, parseWorkflow(quotedInWorkflow).byId.version),
    /hands NODE_AUTH_TOKEN to every step it has, through the workflow-level env:/,
  );
  // ... and finally a spelling NONE of the readers above understands, to prove the preamble backstop
  // is what stops this being an endless list. A flow mapping broken over three lines parses to no
  // pairs and has no indented body, so every name-based and value-based check comes back clean.
  const unparseableInWorkflow =
    'env: {\n' +
    "  NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}'\n" +
    '}\n' +
    'jobs:\n' +
    '  version:\n' +
    '    steps:\n' +
    '      - run: echo "no reader here understands this, and Actions does"\n';
  assert.deepEqual(
    workflowEnv(unparseableInWorkflow).vars,
    {},
    'the multi-line flow mapping is meant to defeat the PARSED reads - if it stops doing so, re-derive this proof',
  );
  assert.throws(
    () => assertNoAmbientNpmCredential(unparseableInWorkflow, parseWorkflow(unparseableInWorkflow).byId.version),
    /the npm secret is read above `jobs:`/,
  );

  // ▶ AND THE OTHER AXIS ENTIRELY: not how the KEY that carries the credential is spelled, which is
  //   what every proof above varies, but how the CREDENTIAL ITSELF is named. Each of those sweeps
  //   ends in a text match, and a text match written against one spelling of the reference is closed
  //   for that one and open for the rest. GitHub expressions name a context member two ways, `.` and
  //   `[...]`, so `secrets['NPM_TOKEN']` is `secrets.NPM_TOKEN` under another name, reaches the same
  //   steps, and shares no substring with it. `NPM_SECRET_REF` is where both live; here is the proof
  //   that it knows each one, and the proof that it does NOT fire on the `workflow_call` declaration
  //   further down this file, which NAMES the secret without reading it and which the preamble sweep
  //   passes straight over.
  for (const spelling of [
    '${{ secrets.NPM_TOKEN }}',
    '${{secrets.NPM_TOKEN}}',
    "${{ secrets['NPM_TOKEN'] }}",
    '${{ secrets["NPM_TOKEN"] }}',
    "${{ secrets[ 'NPM_TOKEN' ] }}",
  ]) {
    assert.match(spelling, NPM_SECRET_REF, `${spelling} names the npm write credential and must be recognised`);
  }
  for (const innocent of [
    '  NPM_TOKEN:\n    required: true',
    '${{ secrets.GITHUB_TOKEN }}',
    "${{ secrets.RELEASE_PR_TOKEN || secrets.GITHUB_TOKEN }}",
    '${{ secrets.DOCS_REPO_DISPATCH_TOKEN }}',
  ]) {
    assert.doesNotMatch(innocent, NPM_SECRET_REF, `${innocent} does not read the npm write credential`);
  }
  // ... and it is WIRED, not merely correct in isolation. A constant proved by a table and used
  // nowhere would pass this test and guard nothing, so both ambient scopes are re-planted with the
  // index spelling, under an innocent variable name so the name checks cannot be what refuses them.
  // The name check already covers `NPM_TOKEN`/`NODE_AUTH_TOKEN` whatever the value says; an innocent
  // name is the case where the VALUE has to be read, which is where the spelling matters at all.
  const indexInWorkflow =
    'env:\n' +
    "  RELEASE_HELPER: ${{ secrets['NPM_TOKEN'] }}\n" +
    'jobs:\n' +
    '  version:\n' +
    '    steps:\n' +
    '      - run: echo "no dot anywhere, and every step of both jobs holds the npm token"\n';
  assert.throws(
    () => assertNoAmbientNpmCredential(indexInWorkflow, parseWorkflow(indexInWorkflow).byId.version),
    /`RELEASE_HELPER`, set in the workflow-level env:.*reads the npm secret/,
  );
  const indexInJob =
    'jobs:\n' +
    '  version:\n' +
    '    env:\n' +
    '      RELEASE_HELPER: ${{ secrets["NPM_TOKEN"] }}\n' +
    '    steps:\n' +
    '      - run: echo "the other quote, the other scope, the same credential"\n';
  assert.throws(
    () => assertNoAmbientNpmCredential(indexInJob, parseWorkflow(indexInJob).byId.version),
    /`RELEASE_HELPER`, set in its own job-level env:.*reads the npm secret/,
  );
  // ... including in a spelling of the KEY that defeats the parsed reads AND a spelling of the
  // REFERENCE that defeated the sweeps, together, which is the case both closures have to hold at
  // once for either to be worth anything.
  const bothAxesAtOnce =
    'env: {\n' +
    "  RELEASE_HELPER: ${{ secrets['NPM_TOKEN'] }}\n" +
    '}\n' +
    'jobs:\n' +
    '  version:\n' +
    '    steps:\n' +
    '      - run: echo "unreadable key, unswept reference, and Actions resolves it fine"\n';
  assert.deepEqual(
    workflowEnv(bothAxesAtOnce).vars,
    {},
    'the multi-line flow mapping is meant to defeat the PARSED reads - if it stops doing so, re-derive this proof',
  );
  assert.throws(
    () => assertNoAmbientNpmCredential(bothAxesAtOnce, parseWorkflow(bothAxesAtOnce).byId.version),
    /the npm secret is read above `jobs:`/,
  );
  // ... and the key that is not a literal at all, which no enumeration of spellings can ever reach
  // and which is therefore refused rather than read. `format('NPM{0}', '_TOKEN')` evaluates to
  // `NPM_TOKEN` at run time and to nothing at all here.
  const computedIndex =
    'env:\n' +
    "  RELEASE_HELPER: ${{ secrets[format('NPM{0}', '_TOKEN')] }}\n" +
    'jobs:\n' +
    '  version:\n' +
    '    steps:\n' +
    '      - run: echo "the name is assembled at run time, so no pattern here can read it"\n';
  assert.throws(
    () => assertNoAmbientNpmCredential(computedIndex, parseWorkflow(computedIndex).byId.version),
    /reads `secrets` through an index nothing here can resolve/,
  );
  // ... while a RESOLVABLE index of some other secret is left alone, because the refusal is about
  // what cannot be read, not about the bracket.
  const innocentIndex =
    'env:\n' +
    "  GH: ${{ secrets['GITHUB_TOKEN'] }}\n" +
    'jobs:\n' +
    '  version:\n' +
    '    steps:\n' +
    '      - run: echo "an index this check can resolve, naming a secret AC6 is not about"\n';
  assertNoAmbientNpmCredential(innocentIndex, parseWorkflow(innocentIndex).byId.version);

  assertNoStepNpmCredential(version);
  // ... and that sweep is not vacuous either, in EITHER of the two forms an expression can name the
  // secret. The dot form is the one the delivered file uses in `release` and the one every earlier
  // proof was written against; the index form is the one that reaches the same secret while
  // containing no `secrets.NPM_TOKEN` substring at all. Both are planted BELOW the gate on purpose,
  // where AC3's step-order rule cannot be what refuses them, so it is this sweep that has to.
  for (const spelling of ["${{ secrets.NPM_TOKEN }}", "${{ secrets['NPM_TOKEN'] }}"]) {
    const plantedInStep =
      'jobs:\n' +
      '  version:\n' +
      '    steps:\n' +
      '      - run: echo "no env: anywhere, and the token still lands in a file on this runner"\n' +
      '      - name: Warm the registry\n' +
      `        run: echo "//registry.npmjs.org/:_authToken=${spelling}" > ~/.npmrc\n`;
    assert.throws(
      () => assertNoStepNpmCredential(parseWorkflow(plantedInStep).byId.version),
      /"Warm the registry" reads the npm secret in the un-approved job/,
      `the per-step sweep must refuse ${spelling}`,
    );
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
  // The set is derived from the condition a step SPELLS, not only from the one the parser read, so a
  // step opting back in through `if :` or `"if":` joins the set and has to be accounted for here
  // like any other. The parser refuses those spellings outright now; `conditionsOf` is what keeps
  // this list honest if that ever stops being true.
  for (const job of workflow.jobs) {
    const optsBackIn = job.steps.filter((step) => /always\(|failure\(|cancelled\(/.test(conditionsOf(step)));
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
