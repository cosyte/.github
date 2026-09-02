// Tests over the two workflows by which this repository analyses ITSELF.
//
// WHY THESE ARE TESTS AND NOT A LIVE RUN. A live run proves that an analysis completed once. It
// cannot prove the properties that only show up when something goes wrong or when nothing happens
// at all: that seven quiet days still produce a supply-chain analysis, that a failed analysis reds
// the run instead of recording an absent result as a clean one, that the language set is not empty
// (an empty matrix produces zero jobs, and zero jobs report as a SATISFIED context, which is a
// green check over nothing analysed), that the caller grants every permission the reusable it calls
// needs, and that the self-call resolves the analysis definition from the commit under analysis
// rather than through a reference that can move independently of it. Each of those is a false
// green: the run is green, and it means nothing. A green run is exactly the evidence that cannot
// distinguish them, so they are asserted here, offline, against the tracked files.
//
// The parse is line based and deliberately dumb, in the style of `test/caller-reference-docs.test.mjs`
// and `scripts/check-no-emdash.mjs`: this repository has no package.json and therefore no YAML
// library, on purpose, so that it needs no install step to stay verifiable. The reader below
// handles the shapes these four files actually have (nested mappings, one sequence of `- cron:`
// entries, trailing `#` comments) and nothing else. It is not a YAML parser and must not grow into
// one; `actionlint` in `self-check.yml` is what proves these files are valid YAML.
//
// ▶ SCOPE OF THE FAILURE-SUPPRESSION RULE IS THE ANALYSIS PATH, NOT THE REPOSITORY. `release.yml`
//   carries a load-bearing `|| true` and two `always()` conditions, each with a written reason, and
//   a repository-wide ban would either delete them or teach the next reader to exempt things. The
//   path scanned below is DERIVED rather than listed: the two callers, plus whatever reusable each
//   one's `uses:` line actually names. Point a caller somewhere else and the scan follows it.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WORKFLOWS = '.github/workflows';

/** The caller this repository runs its own static analysis from. */
const STATIC_CALLER = 'self-codeql.yml';

/** The caller this repository runs its own supply-chain analysis from. */
const SUPPLY_CALLER = 'self-scorecard.yml';

const read = (relative) => readFileSync(join(REPO, relative), 'utf8');

/** Every tracked workflow file, so a later addition is covered rather than merely not listed. */
const ALL_WORKFLOWS = readdirSync(join(REPO, WORKFLOWS))
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

// ---------------------------------------------------------------------------
// The narrow reader
// ---------------------------------------------------------------------------

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The lines of a workflow with comment-only lines and blank lines dropped and trailing comments
 * stripped, so that nesting is exactly indentation and prose cannot be mistaken for configuration.
 *
 * The trailing-comment rule is YAML's: ` #` outside a quoted scalar starts a comment. None of the
 * values in these four files contains a `#`, and this reader would be wrong about one that did,
 * which is why it is confined to these files.
 * @param {string} text
 */
function code(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, '').trimEnd());
}

/** Does this line open the mapping key `key` at this indent? */
function isKey(line, key, indent) {
  return indentOf(line) === indent && new RegExp(`^${key}:( |$)`).test(line.trim());
}

/** The indent of the level `lines` sits at. `lines` is always a whole block, so its first line is it. */
const levelOf = (lines) => (lines.length === 0 ? 0 : indentOf(lines[0]));

/**
 * The lines nested under `key:` in this block, or null when the key is absent.
 *
 * "Absent" is a distinct answer from "empty" on purpose: several assertions below want to say that
 * a permission or a trigger is missing rather than that it is present and blank.
 * @param {string[]} lines
 * @param {string} key
 */
function under(lines, key) {
  const level = levelOf(lines);
  const start = lines.findIndex((line) => isKey(line, key, level));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && indentOf(line) <= level);
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

/**
 * The scalar written after `key:` on one line in this block, unquoted, or null when the key is
 * absent or its value is a nested block rather than a scalar.
 * @param {string[]} lines
 * @param {string} key
 */
function scalar(lines, key) {
  const level = levelOf(lines);
  const line = lines.find((candidate) => isKey(candidate, key, level));
  if (line === undefined) return null;
  const after = line.trim().slice(key.length + 1).trim();
  if (after === '') return null;
  const quote = after[0];
  return quote === "'" || quote === '"' ? after.slice(1, -1) : after;
}

/** The mapping keys at the top level of this block, in file order. */
function keysOf(lines) {
  if (lines === null) return [];
  const level = levelOf(lines);
  return lines
    .filter((line) => indentOf(line) === level && /^[A-Za-z_][\w-]*:/.test(line.trim()))
    .map((line) => line.trim().split(':')[0]);
}

/** A workflow read as configuration: its code lines, its `on:` block and its `jobs:` block. */
function workflow(name) {
  const lines = code(read(join(WORKFLOWS, name)));
  const triggers = under(lines, 'on');
  assert.notEqual(triggers, null, `${name} declares no \`on:\` block`);
  return { name, lines, triggers, jobs: under(lines, 'jobs') };
}

/** The one job of a caller: its id and its block. These callers have exactly one job each. */
function onlyJob(flow) {
  assert.notEqual(flow.jobs, null, `${flow.name} declares no \`jobs:\` block`);
  const ids = keysOf(flow.jobs);
  assert.equal(ids.length, 1, `${flow.name} is a thin caller and should declare exactly one job`);
  return { id: ids[0], block: under(flow.jobs, ids[0]) };
}

/** A job's `permissions:` block read as a map of scope to level. */
function permissionsOf(block, label) {
  const declared = under(block, 'permissions');
  assert.notEqual(declared, null, `${label} declares no job-level \`permissions:\``);
  /** @type {Map<string, string>} */
  const granted = new Map();
  for (const scope of keysOf(declared)) granted.set(scope, scalar(declared, scope));
  assert.ok(granted.size > 0, `${label}'s \`permissions:\` block is empty`);
  return granted;
}

/** `none` < `read` < `write`. A caller may grant more than the reusable asks, never less. */
const LEVEL = { none: 0, read: 1, write: 2 };

// ---------------------------------------------------------------------------
// The analysis path, derived from what the callers actually call
// ---------------------------------------------------------------------------

/** A `uses:` value naming a workflow in THIS repository, resolved from the commit under analysis. */
const SAME_REPO_CALL = /^\.\/\.github\/workflows\/([\w.-]+)$/;

/** A `uses:` value reaching this repository from outside it, whatever ref it names. */
const CROSS_REPO_CALL = /[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+@\S+/;

/** The two files this repository analyses itself from. Names only: nothing is read at module scope. */
const CALLER_NAMES = [STATIC_CALLER, SUPPLY_CALLER];

/**
 * One caller, read: the workflow, its single job, and the `uses:` value that job names.
 *
 * Every assertion in this file lives inside a `test()`, this one included, deliberately. An assert
 * thrown while the module loads aborts the whole file and reports ONE failure, so a broken `uses:`
 * line would hide whether the schedule, the permissions and the language set were still right. The
 * cost is that each test re-reads its files, which is four small files off a warm page cache.
 * @param {string} name
 */
function caller(name) {
  const flow = workflow(name);
  const job = onlyJob(flow);
  const uses = scalar(job.block, 'uses');
  assert.notEqual(uses, null, `${name}'s ${job.id} job declares no \`uses:\``);
  return { flow, job, uses };
}

/** The two callers plus the reusable each one names: every file a failed analysis passes through. */
function analysisPath() {
  const callers = CALLER_NAMES.map((name) => caller(name));
  return [
    ...callers.map((entry) => entry.flow.name),
    ...callers.map((entry) => {
      const match = SAME_REPO_CALL.exec(entry.uses);
      assert.notEqual(match, null, `${entry.flow.name} calls ${entry.uses}, which AC7 refuses`);
      return match[1];
    }),
  ];
}

// ---------------------------------------------------------------------------
// AC3: seven quiet days still start the supply-chain analysis
// ---------------------------------------------------------------------------

/** Triggers that need a commit, a person, or another system to act. None of them fires unattended. */
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

test('AC3: the supply-chain analysis is driven by a schedule, not only by a push or a person', () => {
  const flow = workflow(SUPPLY_CALLER);
  const triggers = keysOf(flow.triggers);
  // Not "a schedule is among the triggers", which a later edit satisfies while breaking this: the
  // question is whether ANYTHING here fires with no commit and nobody acting. Strike every trigger
  // that needs one, and a schedule has to be what is left.
  assert.deepEqual(
    triggers.filter((name) => !ATTENDED.has(name)),
    ['schedule'],
    `${SUPPLY_CALLER} runs on ${triggers.join(', ')}: nothing there fires on its own, so seven days ` +
      'with no push and no human action produce no analysis at all',
  );
});

test('AC3: that schedule fires at least weekly', () => {
  const flow = workflow(SUPPLY_CALLER);
  const schedule = under(flow.triggers, 'schedule');
  assert.notEqual(schedule, null, `${SUPPLY_CALLER} has no \`schedule:\` body`);
  const crons = schedule
    .map((line) => /^-\s*cron:\s*(.+)$/.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => match[1].replace(/^['"]|['"]$/g, ''));
  assert.ok(crons.length >= 1, `${SUPPLY_CALLER}'s schedule lists no cron expression`);

  for (const cron of crons) {
    const fields = cron.trim().split(/\s+/);
    assert.equal(fields.length, 5, `${cron} is not a five field cron expression`);
    const [, , dayOfMonth, month, dayOfWeek] = fields;
    // At most weekly, read conservatively. A restricted MONTH field fires at most yearly and a
    // restricted DAY OF MONTH field at most monthly; both leave a gap longer than the seven days
    // this criterion is about. A restricted DAY OF WEEK is exactly weekly, and `*` everywhere is
    // daily, so both of those are fine. `21 4 * * 1` is a weekly Monday run.
    assert.equal(month, '*', `${cron} restricts the month, so it can fire less often than weekly`);
    assert.equal(
      dayOfMonth,
      '*',
      `${cron} restricts the day of month, so it can fire less often than weekly`,
    );
    assert.ok(dayOfWeek.length > 0, `${cron} has an empty day of week field`);
  }
});

// ---------------------------------------------------------------------------
// AC4: an analysis that cannot complete reds the run
// ---------------------------------------------------------------------------

/**
 * The constructs that turn "this analysis did not complete" into a green check.
 *
 * Matched against CODE lines only. Every one of these strings also appears in the prose of the
 * files below, saying why it is not there, and a scan that could not tell the difference would
 * either fail on its own documentation or force the documentation to be deleted.
 */
const SUPPRESSORS = [
  { what: '`continue-on-error`', pattern: /(^|\s)continue-on-error\s*:/ },
  { what: 'a `|| true` style shell swallow', pattern: /\|\|\s*(true\b|:\s|:$|exit\s+0\b)/ },
  { what: '`set +e`', pattern: /(^|;|\s)set\s+\+e/ },
  { what: 'a condition that survives a failed dependency', pattern: /\b(always|failure)\s*\(\s*\)/ },
  { what: 'a condition that survives a cancellation', pattern: /!\s*cancelled\s*\(\s*\)/ },
];

test('AC4: nothing on the analysis path suppresses a failure', () => {
  for (const name of analysisPath()) {
    for (const line of code(read(join(WORKFLOWS, name)))) {
      for (const { what, pattern } of SUPPRESSORS) {
        assert.ok(
          !pattern.test(line),
          `${name} carries ${what} on the analysis path: ${line.trim()}. An analysis that cannot ` +
            'complete has to red the run, or an absent result is recorded as a clean one.',
        );
      }
    }
  }
});

test('AC4: the analysis path is the four files a failed analysis passes through', () => {
  // Asserted so that a caller repointed at something else, or a second job quietly added to one of
  // these callers, cannot shrink the scan above without this test saying so.
  assert.deepEqual(
    analysisPath().slice().sort(),
    ['codeql.yml', 'scorecard.yml', SUPPLY_CALLER, STATIC_CALLER].sort(),
  );
});

// ---------------------------------------------------------------------------
// AC5: the static analysis never runs over an empty language set
// ---------------------------------------------------------------------------

test('AC5: the language set this repository analyses itself with is non-empty', () => {
  const entry = caller(STATIC_CALLER);
  const passed = under(entry.job.block, 'with');
  const fromCaller = passed === null ? null : scalar(passed, 'languages');

  // Defaulted or passed: whichever the caller does, the value that reaches `fromJSON` is what this
  // criterion is about. An input the caller omits is the reusable's declared default.
  let raw = fromCaller;
  if (raw === null) {
    const reusable = code(read(join(WORKFLOWS, 'codeql.yml')));
    const inputs = under(under(under(reusable, 'on'), 'workflow_call'), 'inputs');
    assert.notEqual(inputs, null, 'codeql.yml declares no `workflow_call` inputs');
    raw = scalar(under(inputs, 'languages'), 'default');
  }
  assert.notEqual(raw, null, 'no language set reaches the analysis, defaulted or passed');

  let languages;
  try {
    languages = JSON.parse(raw);
  } catch {
    assert.fail(`the language set ${JSON.stringify(raw)} is not JSON, so \`fromJSON\` cannot read it`);
  }
  assert.ok(Array.isArray(languages), `the language set ${JSON.stringify(raw)} is not a JSON array`);
  assert.ok(
    languages.length > 0,
    'the language set is empty, so the matrix produces zero analyze jobs, and zero jobs report as ' +
      'a satisfied context: a green check over nothing analysed',
  );
  for (const language of languages) {
    assert.equal(typeof language, 'string', `${JSON.stringify(language)} is not a language name`);
    assert.ok(language.trim() !== '', 'a blank language name analyses nothing');
  }
});

// ---------------------------------------------------------------------------
// AC6: a calling job grants every permission the reusable it calls declares
// ---------------------------------------------------------------------------

for (const name of CALLER_NAMES) {
  test(`AC6: ${name} grants every permission the reusable it calls declares`, () => {
    const entry = caller(name);
    const target = SAME_REPO_CALL.exec(entry.uses);
    assert.notEqual(target, null, `${name} calls ${entry.uses}, which AC7 refuses`);
    const called = workflow(target[1]);
    const calledJobs = keysOf(called.jobs);
    assert.equal(calledJobs.length, 1, `${called.name} declares ${calledJobs.length} jobs, expected one`);
    const needed = permissionsOf(under(called.jobs, calledJobs[0]), `${called.name}'s ${calledJobs[0]} job`);
    const granted = permissionsOf(entry.job.block, `${name}'s ${entry.job.id} job`);

    for (const [scope, level] of needed) {
      assert.ok(
        granted.has(scope),
        `${name} does not grant ${scope}, which ${called.name} declares. A called ` +
          'workflow can only downgrade the caller token, never escalate it, so the run either ' +
          'startup-fails or completes having uploaded nothing.',
      );
      assert.ok(
        LEVEL[granted.get(scope)] >= LEVEL[level],
        `${name} grants ${scope}: ${granted.get(scope)} where ${called.name} needs ${level}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// AC7: the analysis definition comes from the commit under analysis
// ---------------------------------------------------------------------------

for (const name of CALLER_NAMES) {
  test(`AC7: ${name} resolves its analysis from the commit under analysis`, () => {
    const entry = caller(name);
    assert.match(
      entry.uses,
      SAME_REPO_CALL,
      `${name} calls ${entry.uses}. GitHub documents \`./.github/workflows/{filename}\` ` +
        'as the form for a reusable workflow in the same repository, and only that form is resolved ' +
        'from the same commit as the caller.',
    );
    assert.ok(
      !entry.uses.includes('@'),
      `${name} names a ref (${entry.uses}); the same-repository form takes none, and a ` +
        'ref is a thing that can move independently of the commit being analysed',
    );
  });

  test(`AC7: nothing anywhere in ${name} reaches this repository from outside it`, () => {
    // The whole file, comments included, in the same spirit as `caller-reference-docs.test.mjs`:
    // an example in a header is copied at least as readily as the line under it, and this is the
    // repository whose entire point is that a reference at a branch is the defect.
    for (const line of read(join(WORKFLOWS, name)).split('\n')) {
      assert.ok(
        !CROSS_REPO_CALL.test(line),
        `${name} spells a cross-repository self reference: ${line.trim()}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// AC8: no pull request starts the supply-chain analysis
// ---------------------------------------------------------------------------

test(`AC8: ${SUPPLY_CALLER} is not triggered by a pull request`, () => {
  const triggers = keysOf(workflow(SUPPLY_CALLER).triggers);
  for (const forbidden of ['pull_request', 'pull_request_target']) {
    assert.ok(
      !triggers.includes(forbidden),
      `${SUPPLY_CALLER} runs on ${forbidden}. Publishing the result needs the default branch, so a ` +
        'pull-request run would publish a statement about the wrong thing.',
    );
  }
});

test('AC8: no tracked workflow reaches the supply-chain analysis from a pull request', () => {
  // Every workflow file, not only the one added here: the criterion is about what can start that
  // analysis, and a second caller added later would be exactly as wrong.
  for (const name of ALL_WORKFLOWS) {
    const flow = workflow(name);
    const callsScorecard = flow.lines.some((line) => /uses:.*scorecard\.yml/.test(line));
    if (!callsScorecard) continue;
    const triggers = keysOf(flow.triggers);
    for (const forbidden of ['pull_request', 'pull_request_target']) {
      assert.ok(
        !triggers.includes(forbidden),
        `${name} calls the supply-chain analysis and runs on ${forbidden}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The shape the rest of this file assumes, asserted rather than assumed
// ---------------------------------------------------------------------------

test('the static analysis runs on a pull request and on a push to the default branch', () => {
  const flow = workflow(STATIC_CALLER);
  const triggers = keysOf(flow.triggers);
  assert.ok(triggers.includes('pull_request'), `${STATIC_CALLER} does not run on a pull request`);
  assert.ok(triggers.includes('push'), `${STATIC_CALLER} does not run on a push`);
  for (const trigger of ['push', 'pull_request']) {
    const branches = scalar(under(flow.triggers, trigger), 'branches');
    assert.equal(branches, '[main]', `${STATIC_CALLER}'s ${trigger} trigger names ${branches}, not the default branch`);
  }
});

test('the supply-chain analysis also runs on a push to the default branch', () => {
  const flow = workflow(SUPPLY_CALLER);
  assert.ok(keysOf(flow.triggers).includes('push'), `${SUPPLY_CALLER} does not run on a push`);
  const branches = scalar(under(flow.triggers, 'push'), 'branches');
  assert.equal(branches, '[main]', `${SUPPLY_CALLER}'s push trigger names ${branches}, not the default branch`);
});

test('the supply-chain result is published, which is the public and one-way part of this change', () => {
  // Asserted because it is the only irreversible effect either of these files has: a score already
  // sent to the public OpenSSF API is not retracted by a later run. If someone turns it off, that
  // is a decision this test makes them make on purpose rather than by deleting a line.
  const entry = caller(SUPPLY_CALLER);
  const passed = under(entry.job.block, 'with');
  const publish = passed === null ? null : scalar(passed, 'publish-results');
  assert.equal(publish, 'true', `${SUPPLY_CALLER} passes publish-results: ${publish}`);
});

test('neither caller is a reusable workflow itself', () => {
  // These two carry `security-events: write` and `id-token: write` on this repository. A
  // `workflow_call` trigger would offer those jobs to any repository that named the file.
  for (const name of CALLER_NAMES) {
    assert.ok(
      !keysOf(workflow(name).triggers).includes('workflow_call'),
      `${name} declares \`workflow_call\`, which offers this repository's token to a caller`,
    );
  }
});
