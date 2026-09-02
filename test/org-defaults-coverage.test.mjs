// Tests for scripts/org-defaults-coverage.mjs, the check that measures whether this account's
// default issue templates actually land, and for the workflow that runs it.
//
// WHAT THESE TESTS ARE FOR, said once so the individual cases read against it. The defect is not "a
// label is missing". It is that NOTHING EVER LOOKED. A default issue template promising `bug` files
// an unlabelled issue in a repository that never created `bug`, the form renders perfectly, the run
// is green, and the only statement anyone can make about coverage is an assumption. So every arm
// below asks one question: does this check still refuse to report coverage it did not measure?
//
// THE API IS A REAL SOCKET, NOT AN INJECTED FUNCTION. Each case stands up a `node:http` server, in
// the style of `test/environment-gate.test.mjs`, so the pagination, the classification and (where
// the CLI is driven as a child process) THE PROCESS EXIT STATUS are all in the measurement. The exit
// status is the whole mechanism by which a refusal reaches a maintainer as a red run.
//
// AND THE STUB RECORDS EVERY REQUEST IT IS SENT, because "this check only reads" is a claim about
// what it does rather than about what its source says, and the request log is the only place that
// claim can be checked.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  TemplateError,
  decide,
  declaredLabels,
  foldLabel,
  issueTemplateOverride,
  measure,
  overridesOf,
  readDefaultTemplates,
  readTemplateDirectory,
  renderReport,
} from '../scripts/org-defaults-coverage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SCRIPT = resolve(REPO, 'scripts/org-defaults-coverage.mjs');
const WORKFLOWS = '.github/workflows';
const CHECK_WORKFLOW = 'org-defaults-coverage.yml';
const run = promisify(execFile);

const ACCOUNT = 'cosyte';
const DEFAULTS_REPO = 'cosyte/.github';

const read = (relative) => readFileSync(join(REPO, relative), 'utf8');

// ---------------------------------------------------------------------------
// The labels the defaults declare, read without a YAML parser
// ---------------------------------------------------------------------------

const form = (labelsBlock) =>
  `name: Bug report\ndescription: something broke\n${labelsBlock}body:\n  - type: input\n    id: version\n    attributes:\n      label: Package version\n`;

test('a flow sequence of double-quoted strings is the shape this repository ships', () => {
  assert.deepEqual(declaredLabels('t.yml', form('labels: ["bug"]\n')), ['bug']);
});

test('a flow sequence of several entries, quoted either way or plain, reads as all of them', () => {
  assert.deepEqual(declaredLabels('t.yml', form(`labels: ["bug", 'triage', needs-repro]\n`)), [
    'bug',
    'triage',
    'needs-repro',
  ]);
});

test('a block sequence reads as the same list', () => {
  assert.deepEqual(declaredLabels('t.yml', form('labels:\n  - bug\n  - "needs triage"\n')), ['bug', 'needs triage']);
});

test('an empty flow sequence declares no labels, which is not a refusal', () => {
  assert.deepEqual(declaredLabels('t.yml', form('labels: []\n')), []);
});

test('a template with no `labels:` key at all declares no labels', () => {
  assert.deepEqual(declaredLabels('t.yml', form('')), []);
});

test('a `labels:` nested inside `body:` is not mistaken for the top-level declaration', () => {
  // Every issue form in this repository has an indented `label:` under `body:`, and one could just
  // as easily have `labels:`. Column zero is what separates the declaration from the prose.
  const text = 'name: Bug\nbody:\n  - type: dropdown\n    attributes:\n      labels: ["not-a-declaration"]\n';
  assert.deepEqual(declaredLabels('t.yml', text), []);
});

test('a scalar `labels:` is refused naming the file, not read as no labels', () => {
  // The markdown-front-matter spelling. Reading it as "declares nothing" would leave a real
  // obligation unmeasured while the run went green, which is the defect this check exists to end.
  assert.throws(() => declaredLabels('bug.yml', form('labels: bug\n')), (error) => {
    assert.ok(error instanceof TemplateError);
    assert.equal(error.path, 'bug.yml');
    assert.match(error.reason, /not a list of strings/);
    return true;
  });
});

test('a mapping `labels:` is refused naming the file', () => {
  assert.throws(() => declaredLabels('bug.yml', form('labels: {bug: true}\n')), /not a list of strings/);
});

test('a second top-level `labels:` key is refused rather than resolved', () => {
  assert.throws(() => declaredLabels('bug.yml', form('labels: ["bug"]\nlabels: ["other"]\n')), /more than once/);
});

test('an unterminated flow sequence is refused', () => {
  assert.throws(() => declaredLabels('bug.yml', form('labels: ["bug"\n')), /cannot see the end of/);
});

test('a nested collection inside the flow sequence is refused', () => {
  assert.throws(() => declaredLabels('bug.yml', form('labels: ["bug", ["nested"]]\n')), /nests a collection/);
});

test('a tab in the declaration is refused rather than guessed at', () => {
  assert.throws(() => declaredLabels('bug.yml', form('labels:\t["bug"]\n')), /tab/);
});

test('`labels:` present with nothing under it is refused, being neither a list nor absent', () => {
  assert.throws(() => declaredLabels('bug.yml', 'name: Bug\nlabels:\n'), /neither a list nor absent/);
});

test('a mapping item inside the block sequence is refused', () => {
  assert.throws(() => declaredLabels('bug.yml', 'name: Bug\nlabels:\n  bug: true\n'), /not a list item/);
});

test('an empty entry is refused, because an empty string is not a label', () => {
  assert.throws(() => declaredLabels('bug.yml', form('labels: ["bug", ""]\n')), /not a label/);
});

test('a quoting form this reader does not read is refused rather than mis-unquoted', () => {
  assert.throws(() => declaredLabels('bug.yml', form('labels: ["a\\"b"]\n')), /quoting form/);
});

test('config.yml contributes no labels and is still listed as a default file', () => {
  const outcome = readDefaultTemplates([
    { name: 'bug_report.yml', text: form('labels: ["bug"]\n') },
    { name: 'config.yml', text: 'blank_issues_enabled: false\ncontact_links:\n  - name: Docs\n' },
  ]);
  assert.deepEqual(
    outcome.templates.map((entry) => entry.path),
    ['.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/config.yml'],
  );
  assert.deepEqual(outcome.labels, [{ label: 'bug', templates: ['.github/ISSUE_TEMPLATE/bug_report.yml'] }]);
});

test('a markdown issue template is refused naming the file, not skipped', () => {
  assert.throws(
    () => readDefaultTemplates([{ name: 'legacy.md', text: '---\nlabels: bug\n---\n' }]),
    (error) => {
      assert.ok(error instanceof TemplateError);
      assert.equal(error.path, '.github/ISSUE_TEMPLATE/legacy.md');
      return true;
    },
  );
});

test('one label declared by two templates is reported once, naming both', () => {
  const outcome = readDefaultTemplates([
    { name: 'a.yml', text: form('labels: ["bug"]\n') },
    { name: 'b.yml', text: form('labels: ["bug", "enhancement"]\n') },
  ]);
  assert.deepEqual(outcome.labels, [
    { label: 'bug', templates: ['.github/ISSUE_TEMPLATE/a.yml', '.github/ISSUE_TEMPLATE/b.yml'] },
    { label: 'enhancement', templates: ['.github/ISSUE_TEMPLATE/b.yml'] },
  ]);
});

test("this repository's own default templates parse, and declare bug and enhancement", () => {
  // The live obligation, read off the tracked files rather than restated. A template edit that this
  // reader cannot read fails here rather than in a scheduled run a week later.
  const found = readTemplateDirectory(join(REPO, '.github/ISSUE_TEMPLATE'));
  assert.equal(found.failure, null, 'the default issue templates could not be read off disk');
  const outcome = readDefaultTemplates(found.files);
  assert.deepEqual(
    outcome.labels.map((entry) => entry.label),
    ['bug', 'enhancement'],
  );
});

test('an absent template folder is an answer, not a refusal: this account publishes no defaults', () => {
  const found = readTemplateDirectory(join(REPO, '.github/NOT_A_TEMPLATE_FOLDER'));
  assert.equal(found.failure, null);
  assert.deepEqual(found.files, []);
});

test('an entry in the template folder that is not a regular file is refused naming it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'org-defaults-'));
  mkdirSync(join(dir, 'nested'));
  const found = readTemplateDirectory(dir);
  assert.notEqual(found.failure, null);
  assert.match(found.failure.reason, /not a regular file/);
  assert.match(found.failure.path, /nested$/);
});

// ---------------------------------------------------------------------------
// The stub API
// ---------------------------------------------------------------------------

const entry = (name, type = 'file') => ({ name, type });
const TEMPLATE_FOLDER = entry('ISSUE_TEMPLATE', 'dir');

/** The default templates, as the fixtures declare them. */
const TEMPLATE_FILES = [
  { name: 'bug_report.yml', text: form('labels: ["bug"]\n') },
  { name: 'config.yml', text: 'blank_issues_enabled: false\n' },
  { name: 'feature_request.yml', text: form('labels: ["enhancement"]\n') },
];

const BOTH_LABELS = ['bug', 'enhancement'];

/**
 * A stand-in for the REST API over a real socket.
 *
 * `repos` is the whole fixture account: each entry names a repository, the three folder listings the
 * check reads, and the labels it holds. `null` for a listing is a 404, which is how a repository
 * says it has no such folder.
 */
async function startApi({
  account = ACCOUNT,
  accountType = 'Organization',
  repos = [],
  publicRepos = null,
  privateRepos = null,
  omitPublicCount = false,
  neverConverge = false,
  status = {},
  headers = {},
  rawBody = {},
} = {}) {
  /** @type {{method: string, path: string, search: string}[]} */
  const requests = [];
  const byName = new Map(repos.map((repository) => [repository.name, repository]));

  const paged = (items, search) => {
    const perPage = Number(search.get('per_page') || 30);
    const page = Number(search.get('page') || 1);
    return { status: 200, body: items.slice((page - 1) * perPage, page * perPage) };
  };

  const accountPath = accountType === 'User' ? `/users/${account}` : `/orgs/${account}`;

  const routes = (pathname, search) => {
    if (pathname === `${accountPath}/repos`) {
      if (status.list) return { status: status.list, body: { message: 'nope' } };
      if (rawBody.list !== undefined) return { status: 200, raw: rawBody.list };
      if (neverConverge) {
        // A full page for every page asked for, which is what a list endpoint whose paging is broken
        // looks like from the outside. No walk terminates on a short page against it.
        const perPage = Number(search.get('per_page') || 30);
        return {
          status: 200,
          body: Array.from({ length: perPage }, (_, index) => ({ full_name: `cosyte/r${index}` })),
        };
      }
      return paged(
        repos.map((repository) => ({ name: repository.name.split('/')[1], full_name: repository.name })),
        search,
      );
    }
    if (pathname === accountPath) {
      if (status.account) return { status: status.account, body: { message: 'nope' } };
      if (rawBody.account !== undefined) return { status: 200, raw: rawBody.account };
      return {
        status: 200,
        body: {
          login: account,
          ...(omitPublicCount ? {} : { public_repos: publicRepos ?? repos.length }),
          ...(privateRepos === null ? {} : { owned_private_repos: privateRepos }),
        },
      };
    }

    const contents = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.*)$/.exec(pathname);
    if (contents) {
      const [, name, path] = contents;
      if (status.contents?.[name]) return { status: status.contents[name], body: { message: 'nope' } };
      if (rawBody.contents?.[name] !== undefined) return { status: 200, raw: rawBody.contents[name] };
      const repository = byName.get(name);
      if (!repository) return { status: 404, body: { message: 'Not Found' } };
      const key = path === '' ? 'root' : path === '.github' ? 'github' : path === 'docs' ? 'docs' : null;
      if (key === null) return { status: 404, body: { message: 'Not Found' } };
      const listing = repository[key];
      if (listing === undefined || listing === null) return { status: 404, body: { message: 'Not Found' } };
      if (listing === 'a-file') return { status: 200, body: { name: path, type: 'file', size: 12 } };
      return { status: 200, body: listing };
    }

    const labels = /^\/repos\/([^/]+\/[^/]+)\/labels$/.exec(pathname);
    if (labels) {
      const name = labels[1];
      if (status.labels?.[name]) {
        return {
          status: status.labels[name],
          body: { message: headers.labels?.[name] ? 'API rate limit exceeded' : 'nope' },
          headers: headers.labels?.[name],
        };
      }
      if (rawBody.labels?.[name] !== undefined) return { status: 200, raw: rawBody.labels[name] };
      const repository = byName.get(name);
      if (!repository) return { status: 404, body: { message: 'Not Found' } };
      return paged((repository.labels ?? []).map((label) => ({ name: label })), search);
    }

    const repo = /^\/repos\/([^/]+\/[^/]+)$/.exec(pathname);
    if (repo) {
      if (status.repo) return { status: status.repo, body: { message: 'nope' } };
      if (rawBody.repo !== undefined) return { status: 200, raw: rawBody.repo };
      return { status: 200, body: { full_name: repo[1], owner: { login: account, type: accountType } } };
    }
    return undefined;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: req.method ?? '', path: url.pathname, search: url.search });
    const answer = routes(url.pathname, url.searchParams) ?? { status: 404, body: { message: 'Not Found' } };
    res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
    res.end(answer.raw !== undefined ? answer.raw : JSON.stringify(answer.body ?? null));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { base, requests, close: () => new Promise((done) => server.close(() => done(undefined))) };
}

/** Stand the stub up, run the real measurement against it, tear the stub down. */
async function measureAgainst(stubOptions, options = {}) {
  const api = await startApi(stubOptions);
  try {
    const measurement = await measure({
      repository: options.repository ?? DEFAULTS_REPO,
      templateFiles: options.templateFiles ?? TEMPLATE_FILES,
      apiBase: api.base,
      token: 'ghs_test_token_not_a_credential',
      ...options.measure,
    });
    return { ...decide(measurement), measurement, requests: api.requests };
  } finally {
    await api.close();
  }
}

/** Run the CLI exactly as the workflow does, and return { code, stdout, stderr } separately. */
async function runCheck({ repository = DEFAULTS_REPO, api, args = [], env = {} } = {}) {
  const argv = [SCRIPT, '--repository', repository, ...args];
  if (api) argv.push('--api', api);
  const childEnv = {
    ...process.env,
    // Never inherit the surrounding run's own GitHub identity: these tests depend on nothing but
    // what they pass in, and a real token must never be sent to a socket a test opened.
    GH_TOKEN: 'ghs_test_token_not_a_credential',
    GITHUB_TOKEN: '',
    GITHUB_REPOSITORY: '',
    GITHUB_API_URL: '',
    GITHUB_STEP_SUMMARY: '',
    ...env,
  };
  try {
    const { stdout, stderr } = await run(process.execPath, argv, { encoding: 'utf8', env: childEnv });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** The fixture account that everything is covered in. */
const COVERED = [
  { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER, entry('workflows', 'dir')], root: [entry('README.md')], docs: null, labels: BOTH_LABELS },
  { name: 'cosyte/hl7', github: [entry('workflows', 'dir')], root: [entry('README.md')], docs: null, labels: BOTH_LABELS },
  { name: 'cosyte/x12', github: null, root: [entry('README.md')], docs: null, labels: [...BOTH_LABELS, 'chore'] },
];

// ---------------------------------------------------------------------------
// The passing arm, and what it is allowed to claim
// ---------------------------------------------------------------------------

test('every repository holding every declared label passes, and the outcome says covered', async () => {
  const outcome = await measureAgainst({ repos: COVERED });
  assert.equal(outcome.failing, false);
  assert.equal(outcome.report.outcome, 'covered');
});

test('the passing report states the population it measured rather than asserting completeness', async () => {
  const outcome = await measureAgainst({ repos: COVERED });
  assert.equal(outcome.report.population.listed, 3);
  assert.equal(outcome.report.population.reported, 3);
  assert.match(renderReport(outcome.report), /Measured, not assumed/);
});

test('the check only ever issues GETs: it verifies, it never writes', async () => {
  const outcome = await measureAgainst({ repos: COVERED });
  assert.ok(outcome.requests.length > 0);
  for (const request of outcome.requests) assert.equal(request.method, 'GET');
});

test('the account is derived from the run\'s repository, so a different owner measures that owner', async () => {
  const repos = [
    { name: 'acme/.github', github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'acme/widget', github: [], root: [], docs: null, labels: BOTH_LABELS },
  ];
  const outcome = await measureAgainst({ account: 'acme', repos }, { repository: 'acme/.github' });
  assert.equal(outcome.report.account.login, 'acme');
  assert.deepEqual(
    outcome.report.repositories.map((item) => item.name),
    ['acme/.github', 'acme/widget'],
  );
  // Nothing in the source names an account, so the same check under `acme` measures `acme`.
  assert.ok(!readFileSync(SCRIPT, 'utf8').includes(`'${ACCOUNT}'`));
});

test('a user account is enumerated through the user endpoints rather than the org ones', async () => {
  const repos = [{ name: 'noah/.github', github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS }];
  const outcome = await measureAgainst(
    { account: 'noah', accountType: 'User', repos },
    { repository: 'noah/.github' },
  );
  assert.equal(outcome.failing, false);
  assert.equal(outcome.report.population.endpoint, '/users/noah/repos?type=owner');
});

// ---------------------------------------------------------------------------
// The obligation, and who it falls on
// ---------------------------------------------------------------------------

test('a missing label in one repository of several fails, naming that repository', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/x12', github: [], root: [], docs: null, labels: ['bug'] },
  ];
  const outcome = await measureAgainst({ repos });
  assert.equal(outcome.failing, true);
  assert.equal(outcome.report.outcome, 'uncovered');
  const enhancement = outcome.report.coverage.find((item) => item.label === 'enhancement');
  assert.deepEqual(enhancement.missing, ['cosyte/x12']);
  assert.match(outcome.report.summary, /cosyte\/x12/);
});

test('the repository the check runs in is inside the population it measures', async () => {
  // The source clause names it first: the label "must be created in your `.github` repository and
  // any repositories where the template will be used". Its own ISSUE_TEMPLATE folder is the
  // defaults' folder, not an override of them.
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: ['bug'] },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: BOTH_LABELS },
  ];
  const outcome = await measureAgainst({ repos });
  const self = outcome.report.repositories.find((item) => item.name === DEFAULTS_REPO);
  assert.equal(self.state, 'default-in-effect');
  assert.equal(self.defaults, true);
  const enhancement = outcome.report.coverage.find((item) => item.label === 'enhancement');
  assert.deepEqual(enhancement.missing, [DEFAULTS_REPO]);
  assert.equal(outcome.failing, true);
});

test('a repository with its own ISSUE_TEMPLATE folder is overridden, and owes no label', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/x12', github: [TEMPLATE_FOLDER], root: [], docs: null, labels: [] },
  ];
  const outcome = await measureAgainst({ repos });
  const overridden = outcome.report.repositories.find((item) => item.name === 'cosyte/x12');
  assert.equal(overridden.state, 'overridden');
  assert.equal(outcome.failing, false);
  for (const item of outcome.report.coverage) assert.deepEqual(item.missing, []);
});

test('an overridden repository names the folder that overrides it, so it reads as an override', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/x12', github: [TEMPLATE_FOLDER], root: [], docs: null, labels: [] },
  ];
  const outcome = await measureAgainst({ repos });
  const overridden = outcome.report.repositories.find((item) => item.name === 'cosyte/x12');
  assert.equal(overridden.overriddenBy, '.github/ISSUE_TEMPLATE');
  assert.match(renderReport(outcome.report), /overridden by `\.github\/ISSUE_TEMPLATE`/);
});

test('the override is per folder and all or nothing: no label is asked of an overridden repository', async () => {
  // One file in that folder switches off every default template AND the default config.yml
  // together, so there is no per-file arithmetic to get wrong.
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/x12', github: [TEMPLATE_FOLDER], root: [], docs: null, labels: [] },
  ];
  const outcome = await measureAgainst({ repos });
  for (const item of outcome.report.coverage) {
    assert.equal(item.required, 1, 'only the defaults repository is obligated here');
    assert.ok(!item.missing.includes('cosyte/x12'));
  }
  assert.ok(!outcome.requests.some((request) => request.path === '/repos/cosyte/x12/labels'));
});

test('a repository defining another supported type reports that default as not in effect', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [entry('CONTRIBUTING.md'), entry('SECURITY.md')], docs: null, labels: BOTH_LABELS },
  ];
  const outcome = await measureAgainst({ repos });
  const item = outcome.report.repositories.find((entryOf) => entryOf.name === 'cosyte/hl7');
  assert.deepEqual(item.overrides, [
    { type: 'contributing guide', path: 'CONTRIBUTING.md' },
    { type: 'security policy', path: 'SECURITY.md' },
  ]);
  // It still renders the default ISSUE TEMPLATES, so it still owes the labels.
  assert.equal(item.state, 'default-in-effect');
  assert.match(renderReport(outcome.report), /so the default of each is not in effect there/);
});

test('the documented order of precedence decides which file is named as the override', () => {
  const found = overridesOf({
    github: [entry('CONTRIBUTING.md')],
    root: [entry('CONTRIBUTING.md')],
    docs: [entry('CONTRIBUTING.md')],
  });
  assert.deepEqual(found, [{ type: 'contributing guide', path: '.github/CONTRIBUTING.md' }]);
});

test('a file at the ISSUE_TEMPLATE path is not the folder the clause names', () => {
  // `.github/ISSUE_TEMPLATE.md` is the legacy single-template spelling. The clause that switches off
  // every default names the FOLDER, so this repository still renders the defaults and still owes the
  // labels; the report says the legacy file is there.
  const entries = { github: [entry('ISSUE_TEMPLATE.md')], root: [], docs: null };
  assert.equal(issueTemplateOverride(entries), null);
  assert.deepEqual(overridesOf(entries), [
    { type: 'issue templates and config.yml', path: '.github/ISSUE_TEMPLATE.md' },
  ]);
});

// ---------------------------------------------------------------------------
// Near misses
// ---------------------------------------------------------------------------

test('a label differing only by letter case is a near miss, not a satisfied obligation', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: ['Bug', 'enhancement'] },
  ];
  const outcome = await measureAgainst({ repos });
  assert.equal(outcome.failing, true);
  assert.deepEqual(outcome.report.nearMisses, [{ repository: 'cosyte/hl7', declared: 'bug', found: 'Bug' }]);
  const bug = outcome.report.coverage.find((item) => item.label === 'bug');
  assert.deepEqual(bug.missing, ['cosyte/hl7']);
});

test('a label differing only by surrounding whitespace is a near miss naming both spellings', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: [' bug ', 'enhancement'] },
  ];
  const outcome = await measureAgainst({ repos });
  assert.equal(outcome.failing, true);
  assert.deepEqual(outcome.report.nearMisses, [{ repository: 'cosyte/hl7', declared: 'bug', found: ' bug ' }]);
  const rendered = renderReport(outcome.report);
  assert.match(rendered, /" bug "/);
  assert.match(rendered, /"bug"/);
});

test('the near-miss fold is case and surrounding whitespace, and nothing wider', () => {
  assert.equal(foldLabel(' Bug '), foldLabel('bug'));
  assert.notEqual(foldLabel('bugs'), foldLabel('bug'));
  assert.notEqual(foldLabel('b ug'), foldLabel('bug'));
});

// ---------------------------------------------------------------------------
// Pagination, exhausted rather than sampled
// ---------------------------------------------------------------------------

test('a label on the second page of results is never reported as absent', async () => {
  const filler = Array.from({ length: 100 }, (_, index) => `filler-${index}`);
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: [...filler, 'bug', 'enhancement'] },
  ];
  const outcome = await measureAgainst({ repos });
  assert.equal(outcome.failing, false, 'a label on page two was reported as missing');
  const pages = outcome.requests.filter((request) => request.path === '/repos/cosyte/hl7/labels');
  assert.ok(pages.length >= 2, `the label list was sampled, not exhausted: ${pages.length} page(s) read`);
});

test('a repository on the second page of the listing is measured like any other', async () => {
  const filler = Array.from({ length: 100 }, (_, index) => ({
    name: `cosyte/filler-${index}`,
    github: [TEMPLATE_FOLDER],
    root: [],
    docs: null,
    labels: [],
  }));
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    ...filler,
    { name: 'cosyte/zulu', github: [], root: [], docs: null, labels: ['bug'] },
  ];
  const outcome = await measureAgainst({ repos });
  assert.equal(outcome.report.population.pages, 2);
  assert.equal(outcome.report.population.listed, 102);
  assert.ok(outcome.report.repositories.some((item) => item.name === 'cosyte/zulu'));
  const enhancement = outcome.report.coverage.find((item) => item.label === 'enhancement');
  assert.deepEqual(enhancement.missing, ['cosyte/zulu']);
});

// ---------------------------------------------------------------------------
// An enumeration that cannot be shown to be the whole population
// ---------------------------------------------------------------------------

test('a listing shorter than the account\'s own count fails, naming the shortfall', async () => {
  const outcome = await measureAgainst({ repos: COVERED, publicRepos: 7 });
  assert.equal(outcome.failing, true);
  assert.equal(outcome.report.outcome, 'incomplete-enumeration');
  assert.match(outcome.report.summary, /reports 7 owned repositories/);
  assert.match(outcome.report.summary, /listing returned 3/);
});

test('an incomplete listing reports NO coverage over the subset it did read', async () => {
  const outcome = await measureAgainst({ repos: COVERED, publicRepos: 7 });
  assert.deepEqual(outcome.report.coverage, []);
  assert.deepEqual(outcome.report.repositories, []);
  assert.ok(!/Measured, not assumed/.test(renderReport(outcome.report)));
});

test('private repositories the account reports are part of the count the listing must reach', async () => {
  const outcome = await measureAgainst({ repos: COVERED, publicRepos: 3, privateRepos: 2 });
  assert.equal(outcome.report.outcome, 'incomplete-enumeration');
  assert.match(outcome.report.summary, /reports 5 owned repositories/);
});

test('an account record with no private count states the population it proved, rather than assuming', async () => {
  const outcome = await measureAgainst({ repos: COVERED });
  assert.equal(outcome.report.population.privateRepos, null);
  assert.match(renderReport(outcome.report), /PUBLIC repositories/);
  assert.match(renderReport(outcome.report), /outside this measurement/);
});

test('an account record with no repository count at all is an unreadable read, not a free pass', async () => {
  const outcome = await measureAgainst({ repos: COVERED, omitPublicCount: true });
  assert.equal(outcome.failing, true);
  assert.equal(outcome.report.outcome, 'unreadable');
  assert.match(outcome.report.summary, /public_repos/);
});

test('an empty listing fails rather than reporting full coverage over nothing', async () => {
  const outcome = await measureAgainst({ repos: [], publicRepos: 0 });
  assert.equal(outcome.failing, true);
  assert.equal(outcome.report.outcome, 'empty-enumeration');
  assert.deepEqual(outcome.report.coverage, []);
});

// ---------------------------------------------------------------------------
// Reads that do not answer
// ---------------------------------------------------------------------------

test('a permission denial on a label read fails, naming the repository and the read', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: BOTH_LABELS },
  ];
  const outcome = await measureAgainst({ repos, status: { labels: { 'cosyte/hl7': 403 } } });
  assert.equal(outcome.failing, true);
  const failure = outcome.report.unreadable.find((item) => item.repository === 'cosyte/hl7');
  assert.equal(failure.kind, 'permission');
  assert.match(failure.read, /\/repos\/cosyte\/hl7\/labels/);
});

test('a repository whose read failed is classified as neither covered nor overridden', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: BOTH_LABELS },
  ];
  const outcome = await measureAgainst({ repos, status: { labels: { 'cosyte/hl7': 403 } } });
  const item = outcome.report.repositories.find((entryOf) => entryOf.name === 'cosyte/hl7');
  assert.equal(item.state, 'unreadable');
  for (const coverage of outcome.report.coverage) assert.ok(!coverage.missing.includes('cosyte/hl7'));
  assert.equal(outcome.report.outcome, 'unreadable');
});

test('a rate-limited read is named as one rather than as a missing label', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: BOTH_LABELS },
  ];
  const outcome = await measureAgainst({
    repos,
    status: { labels: { 'cosyte/hl7': 403 } },
    headers: { labels: { 'cosyte/hl7': { 'x-ratelimit-remaining': '0' } } },
  });
  const failure = outcome.report.unreadable.find((item) => item.repository === 'cosyte/hl7');
  assert.equal(failure.kind, 'rate-limit');
  assert.match(failure.reason, /rate limit exhausted/);
});

test('a body that does not parse is a failed read, not an empty answer', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: BOTH_LABELS },
  ];
  const outcome = await measureAgainst({ repos, rawBody: { labels: { 'cosyte/hl7': '{ not json' } } });
  const failure = outcome.report.unreadable.find((item) => item.repository === 'cosyte/hl7');
  assert.equal(failure.kind, 'unparseable');
  assert.equal(outcome.failing, true);
});

test('a folder read answering with a file is refused rather than classified either way', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: 'a-file', root: [], docs: null, labels: BOTH_LABELS },
  ];
  const outcome = await measureAgainst({ repos });
  const failure = outcome.report.unreadable.find((item) => item.repository === 'cosyte/hl7');
  assert.match(failure.reason, /file rather than a folder listing/);
  assert.equal(outcome.report.repositories.find((item) => item.name === 'cosyte/hl7').state, 'unreadable');
});

test('a transport fault fails the run naming the read that could not be reached', async () => {
  const api = await startApi({ repos: COVERED });
  const base = api.base;
  await api.close(); // Nothing is listening now: the very next read is a transport fault.
  const outcome = decide(
    await measure({ repository: DEFAULTS_REPO, templateFiles: TEMPLATE_FILES, apiBase: base, token: 'x' }),
  );
  assert.equal(outcome.failing, true);
  assert.equal(outcome.report.outcome, 'unreadable');
  assert.equal(outcome.report.unreadable[0].kind, 'transport');
  assert.match(outcome.report.unreadable[0].read, /\/repos\/cosyte\/\.github/);
});

test('the listing itself failing to read leaves no coverage reported at all', async () => {
  const outcome = await measureAgainst({ repos: COVERED, status: { list: 500 } });
  assert.equal(outcome.report.outcome, 'unreadable');
  assert.deepEqual(outcome.report.repositories, []);
  assert.deepEqual(outcome.report.coverage, []);
});

test('a walk that never converges is refused rather than truncated', async () => {
  // A list endpoint answering every page with a full page is the shape a broken paging implementation
  // takes from the outside: no walk terminates on a short page against it. Refusing at the backstop
  // is the fail-closed direction; treating the pages read so far as the whole account is not.
  const outcome = await measureAgainst({ repos: COVERED, neverConverge: true });
  assert.equal(outcome.failing, true);
  assert.equal(outcome.report.outcome, 'unreadable');
  assert.match(outcome.report.unreadable[0].reason, /did not finish paginating/);
  assert.deepEqual(outcome.report.coverage, []);
});

test('a repository the obligation applies to whose labels were never read is reported unread', () => {
  // Reached by construction rather than by a stub, because it is the state no read produces and the
  // one a later edit could produce by accident: an obligated repository with no label list.
  const outcome = decide({
    repository: DEFAULTS_REPO,
    account: { login: ACCOUNT, type: 'Organization' },
    population: { listed: 1, reported: 1, pages: 1, endpoint: '/orgs/cosyte/repos?type=all', publicRepos: 1, privateRepos: null, countedFrom: '/orgs/cosyte' },
    templates: [],
    declaredLabels: [{ label: 'bug', templates: ['.github/ISSUE_TEMPLATE/bug_report.yml'] }],
    observations: [{ name: 'cosyte/hl7', entries: { github: [], root: [], docs: null }, labels: null }],
    failures: [],
  });
  assert.equal(outcome.failing, true);
  assert.equal(outcome.report.repositories[0].state, 'unreadable');
  assert.match(outcome.report.unreadable[0].reason, /were never read/);
});

// ---------------------------------------------------------------------------
// Templates that cannot be read, and templates that ask for nothing
// ---------------------------------------------------------------------------

test('an unparseable default template fails naming the file, before anything is enumerated', async () => {
  const outcome = await measureAgainst(
    { repos: COVERED },
    { templateFiles: [{ name: 'bug_report.yml', text: form('labels: bug\n') }] },
  );
  assert.equal(outcome.failing, true);
  assert.equal(outcome.report.outcome, 'unreadable-template');
  assert.equal(outcome.report.templateFailure.path, '.github/ISSUE_TEMPLATE/bug_report.yml');
  assert.deepEqual(outcome.report.coverage, []);
  // Nothing was enumerated: the set of obligations was never established.
  assert.equal(outcome.requests.length, 0);
});

test('no declared label reports no obligation to measure, and does not report full coverage', async () => {
  const outcome = await measureAgainst(
    { repos: COVERED },
    { templateFiles: [{ name: 'bug_report.yml', text: form('labels: []\n') }] },
  );
  assert.equal(outcome.failing, false);
  assert.equal(outcome.report.outcome, 'no-label-obligation');
  assert.deepEqual(outcome.report.coverage, []);
  const rendered = renderReport(outcome.report);
  assert.match(rendered, /no label obligation to measure/);
  assert.match(rendered, /not the same statement as every repository being covered/);
});

test('no declared label still enumerates, so an empty population is still a refusal', async () => {
  const outcome = await measureAgainst(
    { repos: [], publicRepos: 0 },
    { templateFiles: [{ name: 'bug_report.yml', text: form('labels: []\n') }] },
  );
  assert.equal(outcome.failing, true);
  assert.equal(outcome.report.outcome, 'empty-enumeration');
});

// ---------------------------------------------------------------------------
// The report is the product: the finding is reconstructable from it alone
// ---------------------------------------------------------------------------

test('the report names every repository enumerated, with its state', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: ['bug'] },
    { name: 'cosyte/x12', github: [TEMPLATE_FOLDER], root: [], docs: null, labels: [] },
    { name: 'cosyte/ccda', github: [], root: [], docs: null, labels: BOTH_LABELS },
  ];
  const outcome = await measureAgainst({ repos, status: { labels: { 'cosyte/ccda': 500 } } });
  assert.deepEqual(
    outcome.report.repositories.map((item) => [item.name, item.state]),
    [
      ['cosyte/.github', 'default-in-effect'],
      ['cosyte/ccda', 'unreadable'],
      ['cosyte/hl7', 'default-in-effect'],
      ['cosyte/x12', 'overridden'],
    ],
  );
  const rendered = renderReport(outcome.report);
  for (const repository of repos) assert.ok(rendered.includes(repository.name), `${repository.name} is not in the report`);
});

test('the report carries every declared label and, per label, every repository missing it', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: [] },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: ['bug'] },
  ];
  const outcome = await measureAgainst({ repos });
  assert.deepEqual(outcome.report.coverage, [
    {
      label: 'bug',
      declaredBy: ['.github/ISSUE_TEMPLATE/bug_report.yml'],
      required: 2,
      holding: 1,
      missing: [DEFAULTS_REPO],
    },
    {
      label: 'enhancement',
      declaredBy: ['.github/ISSUE_TEMPLATE/feature_request.yml'],
      required: 2,
      holding: 0,
      missing: [DEFAULTS_REPO, 'cosyte/hl7'],
    },
  ]);
});

test('the finding survives a round trip through the written report, without re-running the check', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: ['bug'] },
  ];
  const api = await startApi({ repos });
  const dir = mkdtempSync(join(tmpdir(), 'org-defaults-report-'));
  const reportPath = join(dir, 'report.json');
  const summaryPath = join(dir, 'summary.md');
  writeFileSync(summaryPath, '');
  try {
    const result = await runCheck({
      api: api.base,
      args: ['--report', reportPath],
      env: { GITHUB_STEP_SUMMARY: summaryPath },
    });
    assert.equal(result.code, 1);
    const written = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(written.outcome, 'uncovered');
    assert.deepEqual(written.coverage.find((item) => item.label === 'enhancement').missing, ['cosyte/hl7']);
    assert.deepEqual(
      written.repositories.map((item) => item.name),
      [DEFAULTS_REPO, 'cosyte/hl7'],
    );
    // And the same finding is on the completed run's own page, written by the check itself before it
    // exited, which is why a failing run still carries it.
    const summary = readFileSync(summaryPath, 'utf8');
    assert.match(summary, /Org default issue templates: measured coverage/);
    assert.match(summary, /cosyte\/hl7/);
  } finally {
    await api.close();
  }
});

test('the report states what it proves and what it does not, triage included', async () => {
  const outcome = await measureAgainst({ repos: COVERED });
  const rendered = renderReport(outcome.report);
  assert.match(rendered, /proves nothing[\s\S]*about triage/);
});

// ---------------------------------------------------------------------------
// The CLI, whose exit status is how a refusal reaches the run
// ---------------------------------------------------------------------------

test('the CLI exits 0 when every declared label is held everywhere it is owed', async () => {
  const api = await startApi({ repos: COVERED });
  try {
    const result = await runCheck({ api: api.base });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /outcome: `covered`/);
  } finally {
    await api.close();
  }
});

test('the CLI exits 1 on a missing label, with the annotation naming the finding', async () => {
  const repos = [
    { name: DEFAULTS_REPO, github: [TEMPLATE_FOLDER], root: [], docs: null, labels: BOTH_LABELS },
    { name: 'cosyte/hl7', github: [], root: [], docs: null, labels: [] },
  ];
  const api = await startApi({ repos });
  try {
    const result = await runCheck({ api: api.base });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /::error title=/);
    assert.match(result.stdout, /cosyte\/hl7/);
  } finally {
    await api.close();
  }
});

test('the CLI exits 2 on bad usage, and reads the repository out of the environment', async () => {
  const bad = await runCheck({ repository: 'not-an-owner-slash-name' });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /owner\/name/);

  const api = await startApi({ repos: COVERED });
  try {
    const fromEnv = await run(process.execPath, [SCRIPT, '--api', api.base], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: DEFAULTS_REPO,
        GH_TOKEN: 'ghs_test_token_not_a_credential',
        GITHUB_TOKEN: '',
        GITHUB_STEP_SUMMARY: '',
      },
    });
    assert.match(fromEnv.stdout, /outcome: `covered`/);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// The workflow that runs it
// ---------------------------------------------------------------------------
//
// The parse is line based and deliberately dumb, in the style of `test/self-scan.test.mjs`: this
// repository has no package.json and therefore no YAML library, on purpose, so that it needs no
// install step to stay verifiable. `actionlint` in `self-check.yml` is what proves these files are
// valid YAML.

const indentOf = (line) => line.length - line.trimStart().length;

function code(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, '').trimEnd());
}

function isKey(line, key, indent) {
  return indentOf(line) === indent && new RegExp(`^${key}:( |$)`).test(line.trim());
}

const levelOf = (lines) => (lines.length === 0 ? 0 : indentOf(lines[0]));

function under(lines, key) {
  const level = levelOf(lines);
  const start = lines.findIndex((line) => isKey(line, key, level));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && indentOf(line) <= level);
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

function scalar(lines, key) {
  const level = levelOf(lines);
  const line = lines.find((candidate) => isKey(candidate, key, level));
  if (line === undefined) return null;
  const after = line.trim().slice(key.length + 1).trim();
  if (after === '') return null;
  const quote = after[0];
  return quote === "'" || quote === '"' ? after.slice(1, -1) : after;
}

function keysOf(lines) {
  if (lines === null) return [];
  const level = levelOf(lines);
  return lines
    .filter((line) => indentOf(line) === level && /^[A-Za-z_][\w-]*:/.test(line.trim()))
    .map((line) => line.trim().split(':')[0]);
}

function workflow(name) {
  const lines = code(read(join(WORKFLOWS, name)));
  const triggers = under(lines, 'on');
  assert.notEqual(triggers, null, `${name} declares no \`on:\` block`);
  return { name, lines, triggers, jobs: under(lines, 'jobs') };
}

/** Triggers that need a commit, a person, or another system to act. None fires unattended. */
const ATTENDED = new Set([
  'push',
  'pull_request',
  'pull_request_target',
  'workflow_dispatch',
  'repository_dispatch',
  'workflow_call',
  'workflow_run',
  'issue_comment',
  'release',
]);

test('the check has a workflow of its own in this repository', () => {
  assert.ok(existsSync(join(REPO, WORKFLOWS, CHECK_WORKFLOW)), `${CHECK_WORKFLOW} is not tracked`);
});

test('the check runs on a schedule, so coverage that decays with no commit is still measured', () => {
  const flow = workflow(CHECK_WORKFLOW);
  const triggers = keysOf(flow.triggers);
  assert.ok(triggers.includes('schedule'), `${CHECK_WORKFLOW} runs on ${triggers.join(', ')}, with no schedule`);
  // Not merely "a schedule is listed": the question is whether anything fires with no commit and
  // nobody acting, since the state being measured lives in other repositories.
  assert.deepEqual(triggers.filter((name) => !ATTENDED.has(name)), ['schedule']);
});

test('that schedule fires at least weekly', () => {
  const schedule = under(workflow(CHECK_WORKFLOW).triggers, 'schedule');
  assert.notEqual(schedule, null, `${CHECK_WORKFLOW} has no \`schedule:\` body`);
  const crons = schedule
    .map((line) => /^-\s*cron:\s*(.+)$/.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => match[1].replace(/^['"]|['"]$/g, ''));
  assert.ok(crons.length >= 1, `${CHECK_WORKFLOW}'s schedule lists no cron expression`);
  for (const cron of crons) {
    const fields = cron.trim().split(/\s+/);
    assert.equal(fields.length, 5, `${cron} is not a five field cron expression`);
    const [, , dayOfMonth, month, dayOfWeek] = fields;
    assert.equal(month, '*', `${cron} restricts the month, so it can fire less often than weekly`);
    assert.equal(dayOfMonth, '*', `${cron} restricts the day of month, so it can fire less often than weekly`);
    assert.ok(dayOfWeek.length > 0, `${cron} has an empty day of week field`);
  }
});

test('the check runs on pull requests, and on every one of them', () => {
  const flow = workflow(CHECK_WORKFLOW);
  assert.ok(keysOf(flow.triggers).includes('pull_request'), `${CHECK_WORKFLOW} does not run on a pull request`);
  const body = under(flow.triggers, 'pull_request');
  assert.equal(scalar(body, 'branches'), '[main]');
  // A `paths:` filter would leave the check PENDING rather than skipped for anyone who requires the
  // context, and the measurement is about the account's state rather than about this diff.
  for (const filter of ['paths', 'paths-ignore']) {
    assert.ok(!keysOf(body).includes(filter), `${CHECK_WORKFLOW} filters its pull-request trigger on ${filter}`);
  }
});

test('the check workflow is never a reusable workflow, so no caller can name it', () => {
  const triggers = keysOf(workflow(CHECK_WORKFLOW).triggers);
  assert.ok(
    !triggers.includes('workflow_call'),
    `${CHECK_WORKFLOW} declares \`workflow_call\`, which offers this repository's token to a caller`,
  );
});

test('no reusable workflow published here runs this check, so no caller pipeline changes', () => {
  // The `@main` fan-out is thirteen repositories deep. This change reaches none of them, and that is
  // asserted here rather than left to a reading of the diff.
  for (const name of readdirSync(join(REPO, WORKFLOWS)).filter((file) => file.endsWith('.yml'))) {
    if (name === CHECK_WORKFLOW) continue;
    const flow = workflow(name);
    if (!keysOf(flow.triggers).includes('workflow_call')) continue;
    assert.ok(
      !flow.lines.some((line) => line.includes('org-defaults-coverage')),
      `${name} is a reusable workflow and it runs the org-defaults check`,
    );
  }
});

/** The constructs that turn "this check did not complete" into a green run. */
const SUPPRESSORS = [
  { what: '`continue-on-error`', pattern: /(^|\s)continue-on-error\s*:/ },
  { what: 'a `|| true` style shell swallow', pattern: /\|\|\s*(true\b|:\s|:$|exit\s+0\b)/ },
  { what: '`set +e`', pattern: /(^|;|\s)set\s+\+e/ },
  { what: 'a condition that survives a failed dependency', pattern: /\b(always|failure)\s*\(\s*\)/ },
  { what: 'a condition that survives a cancellation', pattern: /!\s*cancelled\s*\(\s*\)/ },
];

test('nothing on the check\'s path suppresses a failure', () => {
  for (const line of code(read(join(WORKFLOWS, CHECK_WORKFLOW)))) {
    for (const { what, pattern } of SUPPRESSORS) {
      assert.ok(
        !pattern.test(line),
        `${CHECK_WORKFLOW} carries ${what} on the check's path: ${line.trim()}. A check that cannot ` +
          'fail is documentation.',
      );
    }
  }
});

test('the job grants the least the reads need, and no write anywhere', () => {
  const flow = workflow(CHECK_WORKFLOW);
  const jobs = keysOf(flow.jobs);
  assert.deepEqual(jobs, ['org-defaults-coverage']);
  const block = under(flow.jobs, jobs[0]);
  const permissions = under(block, 'permissions');
  assert.notEqual(permissions, null, `${CHECK_WORKFLOW}'s job declares no \`permissions:\``);
  const granted = new Map(keysOf(permissions).map((scope) => [scope, scalar(permissions, scope)]));
  assert.deepEqual([...granted.entries()].sort(), [
    ['contents', 'read'],
    ['issues', 'read'],
  ]);
  // Naming any permission sets every unnamed one to `none`, so this job cannot write anywhere.
  for (const [scope, level] of granted) assert.equal(level, 'read', `${scope} is granted ${level}`);
});

test('the check authenticates with the automatic token and asks for no other credential', () => {
  const text = read(join(WORKFLOWS, CHECK_WORKFLOW));
  const secrets = [...text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  assert.deepEqual(
    secrets.filter((name) => name !== 'GITHUB_TOKEN'),
    [],
    'the check names a secret other than the automatic token',
  );
  assert.ok(!text.includes('secrets: inherit'), 'the check inherits the caller secrets');
  assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test('the check needs no install step and no third-party package', () => {
  const flow = workflow(CHECK_WORKFLOW);
  const uses = flow.lines.filter((line) => /^\s*-?\s*uses:/.test(line)).map((line) => line.trim().split('uses:')[1].trim());
  assert.deepEqual(uses.map((value) => value.split('@')[0]).sort(), ['actions/checkout', 'actions/setup-node']);
  for (const value of uses) {
    assert.match(value, /@[0-9a-f]{40}$/, `${value} is not pinned to a full-length commit SHA`);
  }
  for (const line of flow.lines) {
    assert.ok(!/\b(npm|pnpm|yarn)\s+(install|add|ci)\b/.test(line), `the check installs a package: ${line.trim()}`);
  }
  assert.ok(!existsSync(join(REPO, 'package.json')), 'a package.json appeared at the repository root');
});

test('the check step runs the script, with no swallow between it and the run', () => {
  const flow = workflow(CHECK_WORKFLOW);
  const steps = under(under(flow.jobs, 'org-defaults-coverage'), 'steps');
  const runs = steps.filter((line) => /run:/.test(line)).map((line) => line.trim());
  assert.deepEqual(runs, ['run: node scripts/org-defaults-coverage.mjs']);
});

test('nothing after the check is relied on to publish the report', () => {
  // The check writes its own measurement to the job summary before it exits, which is the only way a
  // FAILING run still carries one: a step after a failed step does not run, and reaching for
  // `if: always()` to fix that would put a failure-suppressing condition on the check's own path.
  const flow = workflow(CHECK_WORKFLOW);
  const steps = under(under(flow.jobs, 'org-defaults-coverage'), 'steps');
  const level = levelOf(steps);
  const last = steps.filter((line) => indentOf(line) === level).at(-1);
  const runIndex = steps.findIndex((line) => /run:\s*node scripts\/org-defaults-coverage\.mjs/.test(line));
  const lastIndex = steps.indexOf(last);
  assert.ok(runIndex > lastIndex, `${CHECK_WORKFLOW} has a step after the check, which a failing run never reaches`);
  assert.match(readFileSync(SCRIPT, 'utf8'), /GITHUB_STEP_SUMMARY/);
});

test('the check is zero-dependency Node: it imports builtins and nothing else', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const imports = [...source.matchAll(/^import[^']*'([^']+)'/gm)].map((match) => match[1]);
  assert.ok(imports.length > 0);
  for (const specifier of imports) {
    assert.ok(specifier.startsWith('node:'), `${specifier} is not a Node builtin`);
  }
});
