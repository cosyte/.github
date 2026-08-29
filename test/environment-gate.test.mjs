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

// ── THE WIRING (task 7): asserted by parsing release.yml, with no release pending ───────────────
//
// This is AC1's "before any package is packed" half and AC6, proven by something other than an exit
// status: it needs no release, no caller and no network, so it runs on every push to main. A gate
// that exists and is reached too late is not a gate, and nothing else in this repository would say
// so.

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

/** The permissions in force on the `release` job: its own block if it has one, else the workflow's. */
function effectivePermissions(workflow) {
  const readBlock = (text, indent) => {
    const start = text.indexOf(`\n${' '.repeat(indent)}permissions:\n`);
    if (start < 0) return null;
    /** @type {Record<string, string>} */
    const out = {};
    for (const line of text.slice(start + 1).split('\n').slice(1)) {
      const match = new RegExp(`^ {${indent + 2}}([\\w-]+): *([a-z]+)`).exec(line);
      if (!match) break;
      out[match[1]] = match[2];
    }
    return out;
  };
  const code = workflow
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const job = code.slice(code.indexOf('\n  release:'));
  return readBlock(job.slice(0, job.indexOf('\n    steps:')), 4) ?? readBlock(code.slice(0, code.indexOf('\njobs:')), 0);
}

test('the parser still understands release.yml, or every assertion below is vacuous', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));
  assert.ok(steps.length >= 15, `expected the release job's full step list, parsed ${steps.length}`);
  for (const step of steps) {
    assert.ok(
      step.fields.name !== undefined || step.fields.uses !== undefined || step.fields.run !== undefined,
      `step ${step.index} parsed as neither a name, a uses nor a run: ${JSON.stringify(step.body.slice(0, 80))}`,
    );
  }
});

test('the protection gate runs inside the job that holds `environment: release`, and it is the gate', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const job = workflow.slice(workflow.indexOf('\n  release:'), workflow.indexOf('\n    steps:'));
  assert.match(job, /^ {4}environment: release$/m, 'the gate has to be in the job the environment holds');

  const steps = releaseSteps(workflow);
  const gate = steps.filter((s) => /environment-gate\.mjs/.test(s.body));
  assert.equal(gate.length, 1, 'exactly one step runs the environment gate');
  assert.match(gate[0].body, /node \.cosyte-release-tooling\/scripts\/environment-gate\.mjs/);
  assert.equal(gate[0].fields.if, undefined, 'a gate behind a condition is a gate that can be skipped');
});

test('AC1 and AC6: the gate precedes every checkout, pack, registry auth and publish step', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));
  const gate = steps.findIndex((s) => /environment-gate\.mjs/.test(s.body));
  assert.ok(gate >= 0);

  const isCheckout = (s) => /uses: actions\/checkout@/.test(s.body);
  const isToolingCheckout = (s) => isCheckout(s) && / {10}repository: cosyte\/\.github$/m.test(s.body);
  const categories = {
    'checks out a caller tree': (s) => isCheckout(s) && !isToolingCheckout(s),
    'authenticates to the registry': (s) =>
      (/uses: actions\/setup-node@/.test(s.body) && / {10}registry-url:/.test(s.body)) || /NODE_AUTH_TOKEN:/.test(s.body),
    'packs': (s) => /PACK_DOCS_CMD|pack:docs|npm pack|pnpm pack/.test(s.body),
    'publishes': (s) => /uses: changesets\/action@/.test(s.body) || /pnpm run release/.test(s.body),
  };

  for (const [label, matches] of Object.entries(categories)) {
    const found = steps.filter(matches);
    assert.ok(found.length > 0, `no step ${label}, so this assertion proves nothing`);
    for (const step of found) {
      assert.ok(step.index > gate, `"${step.label}" ${label} and must run AFTER the protection gate`);
    }
  }

  // What is allowed to precede the gate is exactly one thing: this repo's own script arriving. A
  // caller tree, a package manager or a registry credential ahead of the gate would each be a step
  // taken on the strength of a human gate nobody had checked.
  for (const step of steps.slice(0, gate)) {
    assert.ok(isToolingCheckout(step), `"${step.label}" runs before the gate and is not the tooling checkout`);
  }
});

test('AC7: no packing or publishing step is reachable past a failed gate', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));
  const gate = steps.findIndex((s) => /environment-gate\.mjs/.test(s.body));

  // A failed step fails the job and skips every step below it, UNLESS that step opts back in with
  // `always()`, `failure()` or `!cancelled()`. Those three are the only way a step can run after the
  // gate has refused, so the set of steps carrying them is pinned by name, and none of them may
  // pack, authenticate or publish.
  const optsBackIn = steps.filter((s) => /always\(|failure\(|cancelled\(/.test(s.fields.if ?? ''));
  assert.deepEqual(
    optsBackIn.map((s) => s.label),
    [
      'Drop the release credentials from disk',
      'Report the staged version for a maintainer',
      'The published package must be installable from the registry',
      'Collect the npm debug log',
      'Upload the npm debug log',
    ],
    'a new step that runs after a failure has to be considered against AC7 rather than added quietly',
  );
  for (const step of optsBackIn) {
    assert.ok(step.index > gate);
    assert.doesNotMatch(step.body, /uses: changesets\/action@|PACK_DOCS_CMD|pnpm run release|NODE_AUTH_TOKEN:/, step.label);
  }
  // And each one that runs on `!cancelled()` is additionally conditioned on a step output that
  // CANNOT hold in a run this gate refused, because the step that would have set it never ran.
  //
  //   the install gate   `changesets/action` never ran, so `published` is empty, not `true`.
  //   the stage report   `publish-floor` sits below this gate, so `mode` is empty, not `staged`. It
  //                      also runs no tool: `staged-publish.mjs report` reads a file and prints.
  const installGate = optsBackIn.find((s) => s.label === 'The published package must be installable from the registry');
  assert.match(installGate.fields.if, /steps\.changesets\.outputs\.published == 'true'/);
  const stageReport = optsBackIn.find((s) => s.label === 'Report the staged version for a maintainer');
  assert.match(stageReport.fields.if, /steps\.publish-floor\.outputs\.mode == 'staged'/);
  const floorGate = steps.findIndex((s) => /publish-floor\.mjs/.test(s.body));
  assert.ok(floorGate > gate, 'the floor gate is itself below the protection gate, so it cannot speak first');
  assert.match(stageReport.body, /staged-publish\.mjs report/, 'it reports; it does not stage or publish');
});

test('AC10: the permissions in force on that job name `contents` as well as `actions: read`', () => {
  const permissions = effectivePermissions(readFileSync(WORKFLOW, 'utf8'));
  assert.ok(permissions, 'the release job must carry a permissions declaration');

  // THE LITERAL ONE-KEY READING, KILLED BY A MANDATED TEST RATHER THAN BY A CALLER'S FIRST RELEASE.
  // "If you specify the access for any of these permissions, all of those that are not specified are
  // set to `none`", so a block whose only key is `actions: read` does not ADD a permission: it strips
  // `contents` off this job, and `actions/checkout` 403s on the very next step, on a FULLY COMPLIANT
  // caller, with none of the fail-closed refusal this gate exists to produce.
  assert.equal(permissions.actions, 'read', 'the gate needs `actions: read`');
  assert.ok(
    permissions.contents === 'read' || permissions.contents === 'write',
    `\`contents\` must be named and must grant read, got ${JSON.stringify(permissions.contents)}`,
  );

  // ADDITIVE, in both directions. The three the job already held are all still here at the level
  // they were at, and `actions` is the only key that joined them. `contents` in particular stays at
  // `write`: this job creates tags and a GitHub release, so downgrading it to `read` to match the
  // letter of the criterion would displace a permission the run needs and fail the publish it is
  // supposed to protect.
  assert.deepEqual(permissions, {
    contents: 'write',
    'id-token': 'write',
    'pull-requests': 'write',
    actions: 'read',
  });
});

test('the gate is handed the credential and the default-branch fallback the script expects', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));
  const gate = steps.find((s) => /environment-gate\.mjs/.test(s.body));
  // The AUTOMATIC token, handed over under the name this file already uses for it. `GITHUB_TOKEN` in
  // release.yml means the credential `changesets/action` opens the Version PR with, which is
  // `RELEASE_PR_TOKEN` where a caller has one: an org-scoped PAT, which is not what should be reading
  // a caller's environments and is not scoped to the calling repository the way this read needs.
  assert.match(gate.body, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.ok(!/GITHUB_TOKEN:/.test(gate.body), 'the gate must not claim the version-PR credential');
  assert.match(gate.body, /DEFAULT_BRANCH_HINT: \$\{\{ github\.event\.repository\.default_branch \}\}/);
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
