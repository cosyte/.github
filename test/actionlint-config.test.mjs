// THE SUPPRESSION FILE, AND THE WAY A SUPPRESSION GOES DEAD WITHOUT ANYTHING SAYING SO.
//
// `.github/actionlint.yaml` is the only thing in this repository that can switch an actionlint
// finding off. `Self-check`'s `actionlint` job is the only linter of `ci.yml`, `release.yml` and
// `workflow-sha-probe.yml`, which declare `workflow_call` and therefore never run on a push here, so
// what that file silences is silenced for thirteen public callers at once.
//
// WHAT WENT WRONG, WHICH IS WHAT THIS FILE IS FOR. The ignores named the message actionlint emits
// for `github.job_workflow_sha`. The workflows then migrated to `job.workflow_sha`, which is a
// different message, and a third file carrying the expression arrived with no entry at all. The
// patterns matched nothing from that moment on. Nothing was red because nothing compares the
// suppressions against the workflows they are scoped to, and a suppression that matches nothing
// looks exactly like a suppression that is doing its job.
//
// SO THE TWO QUESTIONS ARE SEPARATE, AND BOTH ARE ASKED HERE.
//
//   AC-4  Is every suppression still NARROW? One named property, one named workflow file, and the
//         `actionlint` job still failing the build on anything else.
//   AC-5  Is every suppression still LIVE? An entry whose property no workflow at its own path
//         interpolates is dead weight that reads as cover.
//
// THE PATH KEY IS A GLOB AND THE IGNORE PATTERN IS A REGEXP, measured against actionlint 1.7.12
// rather than assumed: `.github/workflows/*.yml` silenced all eleven findings in this repository,
// `.github/workflows/.*\.yml` silenced none, and an ignore of `^property` matched where a literal
// substring could not. Both halves of that are load bearing below. A glob in a path key is how one
// entry covers a directory, and a regexp in a message is how one entry covers a whole rule.
//
// AND THE OBJECT TYPE IS PART OF THE MESSAGE ON PURPOSE. `property "workflow_sha" is not defined`
// is emitted for `needs.a.outputs.workflow_sha` too, where the object type reads `{real: string}`
// and the finding is a REAL defect. An ignore that stopped at the property name would take that
// finding out of three files along with the false positive it was written for, so the entries are
// anchored to the `job` context's own object type and `MUST_STILL_BE_REPORTED` holds the message
// that proves it.
//
// Every message in `MUST_STILL_BE_REPORTED` was produced by running actionlint 1.7.12 over a probe
// workflow and copying what it printed. A control message invented by the author of the pattern it
// is meant to constrain is not a control.
//
// Reads `.github/actionlint.yaml` with a reader that DECLARES ITS SUBSET AND REFUSES EVERYTHING
// OUTSIDE IT, the same posture and the same reason as `test/workflow-reader.mjs`: this repository
// has no `package.json`, no lockfile and no install step, `node:test` and `node:assert` are the
// whole toolbox, and a reader that quietly skips a construct reports "no suppression there" about a
// suppression it could not read. Comment stripping is `decomment` from that shared reader rather
// than a second copy of the same subtlety.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { decomment } from './workflow-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const CONFIG = '.github/actionlint.yaml';
const WORKFLOWS = '.github/workflows';
const WORKFLOWS_DIR = join(REPO, WORKFLOWS);
const SELF_CHECK = `${WORKFLOWS}/self-check.yml`;

const readRepoFile = (path) => readFileSync(join(REPO, path), 'utf8');

/** Every workflow in the directory, so an entry pointing at a file that is gone is a finding. */
const ALL_WORKFLOWS = readdirSync(WORKFLOWS_DIR)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

// ---------------------------------------------------------------------------
// THE READER, AND WHAT IT REFUSES
// ---------------------------------------------------------------------------

/**
 * THE SUBSET, stated so a refusal can be checked against it rather than argued about:
 *
 *   top level   exactly one key, `paths:`, at column 0. ANY other top-level key is REFUSED rather
 *               than skipped. actionlint also reads `self-hosted-runner:` and `config-variables:`,
 *               and a future version may read a key that suppresses something; a reader that
 *               stepped over what it did not recognise would answer "that is every suppression in
 *               the file" about a file it had only partly read, which is the exact answer AC-4
 *               cannot be allowed to get wrong.
 *   path scope  `  <glob>:` at two spaces, each one once. `    ignore:` at four, once, required and
 *               non-empty: a path key carrying no ignores, or a key under a path that is not
 *               `ignore`, is refused.
 *   patterns    `      - ` at six spaces holding a single-line SINGLE or DOUBLE quoted scalar. A
 *               plain scalar is refused, because an unquoted regexp and a YAML comment are told
 *               apart by a space, and a block scalar is refused because its folding would change
 *               the pattern.
 *   everywhere  no tabs, no anchor, no alias, no merge key, no flow collection, no duplicate key.
 */
function parseActionlintConfig(text) {
  const refuse = (line, why) => {
    throw new Error(`parse failure: ${CONFIG}:${line}: ${why}`);
  };

  if (text.includes('\t')) {
    refuse(text.split('\n').findIndex((l) => l.includes('\t')) + 1, 'a tab cannot be indentation in YAML');
  }

  const lines = decomment(text);
  const paths = new Map();
  let sawPaths = false;
  let currentPath = null;
  let currentList = null;

  const numbered = numberKeptLines(text, lines);

  for (const { number, text: line } of numbered) {
    if (line.trim() === '') continue;
    const indent = line.length - line.replace(/^ */, '').length;
    const body = line.slice(indent);

    if (/^[&*]|^<<\s*:/.test(body)) refuse(number, 'an anchor, an alias or a merge key is not in the subset');

    if (indent === 0) {
      if (body !== 'paths:') {
        refuse(
          number,
          `the only top-level key this reader knows is \`paths:\`, and it found \`${body}\`. ` +
            'Extend the declared subset deliberately rather than letting an unread key hide a suppression',
        );
      }
      if (sawPaths) refuse(number, '`paths:` appears twice, so the file cannot be resolved to one mapping');
      sawPaths = true;
      currentPath = null;
      currentList = null;
      continue;
    }

    if (!sawPaths) refuse(number, 'an indented line before any `paths:` key');

    if (indent === 2) {
      const key = body.match(/^(.*?):$/);
      if (!key) refuse(number, 'a path entry must be `  <path>:` with its value on the lines below');
      const name = unquoteKey(key[1], number, refuse);
      if (paths.has(name)) refuse(number, `the path \`${name}\` appears twice, so its ignores cannot be resolved`);
      currentPath = name;
      currentList = null;
      paths.set(name, { path: name, line: number, ignores: [] });
      continue;
    }

    if (indent === 4) {
      if (!currentPath) refuse(number, 'a key at four spaces with no path entry open above it');
      if (body !== 'ignore:') refuse(number, `the only key a path may carry in this subset is \`ignore:\`, found \`${body}\``);
      if (currentList) refuse(number, `\`ignore:\` appears twice under \`${currentPath}\``);
      currentList = paths.get(currentPath).ignores;
      continue;
    }

    if (indent === 6) {
      if (!currentList) refuse(number, 'a list entry with no `ignore:` open above it');
      const item = body.match(/^-\s+(.*)$/);
      if (!item) refuse(number, 'an `ignore:` child must be a `- ` list entry');
      currentList.push({ pattern: unquoteScalar(item[1], number, refuse), line: number });
      continue;
    }

    refuse(number, `an indent of ${indent} is not in the subset`);
  }

  if (!sawPaths) refuse(1, 'the file carries no `paths:` key, so this reader read no suppression at all');
  for (const entry of paths.values()) {
    if (entry.ignores.length === 0) {
      refuse(entry.line, `the path \`${entry.path}\` opens no non-empty \`ignore:\` list`);
    }
  }
  return [...paths.values()];
}

/** The kept lines with their 1-based numbers, by walking the file and the kept lines together. */
function numberKeptLines(text, kept) {
  const original = text.split('\n');
  const out = [];
  let at = 0;
  for (const line of kept) {
    while (at < original.length && original[at] !== line) {
      assert.match(original[at], /^\s*#/, `the comment stripper dropped a line that is not a comment: ${original[at]}`);
      at += 1;
    }
    assert.ok(at < original.length, 'the kept lines are not a subsequence of the file, so the numbering has slipped');
    out.push({ number: at + 1, text: line });
    at += 1;
  }
  return out;
}

function unquoteKey(raw, number, refuse) {
  const value = raw.trim();
  if (value === '') refuse(number, 'an empty path key');
  return unquoteScalar(value, number, refuse);
}

function unquoteScalar(raw, number, refuse) {
  const value = raw.trim();
  if (value === '') refuse(number, 'an empty value');
  if (/^[&*]|^<<\s*:/.test(value)) refuse(number, 'an anchor, an alias or a merge key is not in the subset');
  if (/^[|>]/.test(value)) refuse(number, 'a block scalar would fold the value, so it is not in the subset');
  if (/^[[{]/.test(value)) refuse(number, 'a flow collection is not in the subset');
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) refuse(number, 'an unterminated single-quoted scalar');
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) refuse(number, 'an unterminated double-quoted scalar');
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  if (/\s#/.test(value)) refuse(number, 'a plain scalar carrying ` #` is ambiguous with a trailing comment');
  return value;
}

// ---------------------------------------------------------------------------
// WHAT THE WORKFLOWS ACTUALLY INTERPOLATE
// ---------------------------------------------------------------------------

/**
 * Every `${{ }}` body on a line the runner acts on.
 *
 * COMMENTS ARE THE WHOLE DIFFICULTY, and getting this wrong is what would make AC-5 vacuous.
 * `ci.yml` and `release.yml` both explain the defect at length and quote `${{ github.job_workflow_sha }}`
 * in prose while doing it, so a reader that could not tell prose from configuration would find the
 * dead spelling in a comment and report the dead entry as live. `decomment` knows that a `#` line
 * inside a `run: |` body is content the shell receives rather than a comment.
 */
function interpolations(text) {
  const executable = decomment(text).join('\n');
  const opens = (executable.match(/\$\{\{/g) ?? []).length;
  const closes = (executable.match(/\}\}/g) ?? []).length;
  assert.equal(opens, closes, 'an unbalanced `${{`, so an expression would be read past its own end');
  return [...executable.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
}

/** Does any expression in this workflow read `<something>.<property>`? */
function interpolatesProperty(text, property) {
  const wanted = new RegExp(String.raw`\.\s*${property}\b`);
  return interpolations(text).some((expression) => wanted.test(expression));
}

/** The one property an ignore entry is allowed to name, or `null` where it names no property. */
function propertyNamedBy(pattern) {
  const named = pattern.match(/property "([A-Za-z_][A-Za-z0-9_]*)"/);
  return named ? named[1] : null;
}

/**
 * Every ignore entry whose property no workflow at its own path interpolates.
 *
 * A FUNCTION OVER THE CONFIG AND THE TREE rather than an assertion about the delivered file, so the
 * same code can be run over a config known to be stale. A guard that has never been shown to fire
 * is not a guard.
 */
function staleEntries(entries, readWorkflowText = (path) => readRepoFile(path)) {
  const stale = [];
  for (const entry of entries) {
    for (const { pattern } of entry.ignores) {
      const property = propertyNamedBy(pattern);
      if (property === null) continue;
      let text;
      try {
        text = readWorkflowText(entry.path);
      } catch {
        stale.push(`${entry.path}: the ignore of "${property}" is scoped to a path that does not exist`);
        continue;
      }
      if (!interpolatesProperty(text, property)) {
        stale.push(`${entry.path}: no expression there reads a "${property}" property, so the ignore covers nothing`);
      }
    }
  }
  return stale;
}

const CONFIG_TEXT = readRepoFile(CONFIG);
const ENTRIES = parseActionlintConfig(CONFIG_TEXT);

// ---------------------------------------------------------------------------
// AC-4: THE SUPPRESSION IS NARROW
// ---------------------------------------------------------------------------

test('AC-4: the config suppresses something at all, so the assertions below are not vacuous', () => {
  assert.ok(ENTRIES.length > 0, 'the config declares no path entry, so nothing below measures a suppression');
  const total = ENTRIES.reduce((n, entry) => n + entry.ignores.length, 0);
  assert.ok(total > 0, 'the config declares no ignore pattern, so nothing below measures a suppression');
});

test('AC-4: every ignore is scoped to ONE named workflow file, never a glob over the directory', () => {
  // The path key is a GLOB: `.github/workflows/*.yml` silences every finding in this repository.
  // So the test is not "does it look specific" but "can this key name a second file".
  const GLOB_METACHARACTERS = /[*?[\]{}]/;
  for (const entry of ENTRIES) {
    assert.ok(
      !GLOB_METACHARACTERS.test(entry.path),
      `${CONFIG}:${entry.line}: \`${entry.path}\` carries a glob metacharacter, so one entry can cover files nobody listed`,
    );
    assert.ok(
      entry.path.startsWith(`${WORKFLOWS}/`),
      `${CONFIG}:${entry.line}: \`${entry.path}\` is scoped outside ${WORKFLOWS}/`,
    );
    const name = entry.path.slice(`${WORKFLOWS}/`.length);
    assert.ok(
      !name.includes('/'),
      `${CONFIG}:${entry.line}: \`${entry.path}\` names a subdirectory rather than one workflow file`,
    );
    assert.ok(
      ALL_WORKFLOWS.includes(name),
      `${CONFIG}:${entry.line}: \`${entry.path}\` names no workflow that exists`,
    );
    assert.ok(existsSync(join(REPO, entry.path)), `${CONFIG}:${entry.line}: \`${entry.path}\` is not a readable file`);
  }
});

test('AC-4: every ignore names exactly ONE undefined context property, and nothing wider', () => {
  for (const entry of ENTRIES) {
    for (const { pattern, line } of entry.ignores) {
      const quoted = [...pattern.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1]);
      assert.equal(
        quoted.length,
        1,
        `${CONFIG}:${line}: an ignore must name exactly one property in quotes, found ${quoted.length}`,
      );
      assert.equal(
        propertyNamedBy(pattern),
        quoted[0],
        `${CONFIG}:${line}: the pattern does not have the shape \`property "<name>" is not defined\``,
      );
      assert.match(
        pattern,
        /^property "[A-Za-z_][A-Za-z0-9_]*" is not defined in object type/,
        `${CONFIG}:${line}: an ignore may only suppress an undefined-property message`,
      );
      // AND IT MUST SAY WHICH CONTEXT. The same property name is undefined on other contexts for
      // real reasons, so a pattern that stops at the property takes those findings out too.
      assert.match(
        pattern,
        /is not defined in object type \S/,
        `${CONFIG}:${line}: the pattern stops at the property name, so it silences that property on ` +
          'every context rather than on the one actionlint is behind on',
      );
    }
  }
});

/**
 * Real actionlint 1.7.12 output, each line copied from a run rather than written from memory.
 *
 * The first is AC-6's mutation read statically: the same `job` context, a property that does not
 * exist. The second is the SAME property name on a different context, which is a real defect and
 * the reason the entries are anchored to the `job` context's object type. The rest are other rules,
 * which an ignore ending in `\[expression\]` or similar would take out wholesale.
 */
const JOB_CONTEXT = [
  '{check_run_id: number; container: {id: string; network: string}; ',
  'services: {string => {id: string; network: string; ports: {string => string}}}; status: string}',
].join('');

const MUST_STILL_BE_REPORTED = [
  `property "not_a_real_property" is not defined in object type ${JOB_CONTEXT} [expression]`,
  'property "workflow_sha" is not defined in object type {real: string} [expression]',
  'the runner of "actions/checkout@v3" action is too old to run on GitHub Actions. update the action\'s version to fix this issue [action]',
  "shellcheck reported issue in this script: SC2016:info:36:12: Expressions don't expand in single quotes, use double quotes for that [shellcheck]",
];

test('AC-4: no ignore pattern matches a finding that must still fail the build', () => {
  for (const entry of ENTRIES) {
    for (const { pattern, line } of entry.ignores) {
      const regexp = new RegExp(pattern);
      for (const message of MUST_STILL_BE_REPORTED) {
        assert.ok(
          !regexp.test(message),
          `${CONFIG}:${line}: the ignore for \`${entry.path}\` also silences a finding that is real:\n  ${message}`,
        );
      }
    }
  }
});

test('AC-4: and the ignores are not vacuous: each one matches the message it exists for', () => {
  // The other half of the control above. A pattern that matches nothing would pass every "must
  // still be reported" assertion while suppressing nothing, which is the defect this file is about.
  for (const entry of ENTRIES) {
    for (const { pattern, line } of entry.ignores) {
      const property = propertyNamedBy(pattern);
      const real = `property "${property}" is not defined in object type ${JOB_CONTEXT} [expression]`;
      assert.match(
        real,
        new RegExp(pattern),
        `${CONFIG}:${line}: the pattern matches no message actionlint emits for \`job.${property}\``,
      );
    }
  }
});

test('AC-4: `self-check.yml` still fails the build on a finding, on both jobs', () => {
  const selfCheck = readRepoFile(SELF_CHECK);
  const executable = decomment(selfCheck).join('\n');

  assert.match(
    executable,
    /^\s*fail_on_error:\s*true\s*$/m,
    `${SELF_CHECK}: the actionlint step must keep \`fail_on_error: true\``,
  );
  assert.ok(
    !/fail_on_error:\s*false/.test(executable),
    `${SELF_CHECK}: \`fail_on_error: false\` turns the linter into a reporter`,
  );
  // A text sweep rather than a parse: a reader that does not model a key reports it absent, and
  // absent is the answer this assertion must never be handed by accident.
  assert.ok(
    !/continue-on-error/.test(executable),
    `${SELF_CHECK}: \`continue-on-error\` lets a red job conclude success`,
  );
});

// ---------------------------------------------------------------------------
// AC-5: THE SUPPRESSION IS STILL LIVE
// ---------------------------------------------------------------------------

test('AC-5: no ignore entry is stale: every suppressed property is one its own workflow interpolates', () => {
  assert.deepEqual(
    staleEntries(ENTRIES),
    [],
    'an ignore naming a property no expression at that path reads is dead weight that reads as cover: ' +
      'the workflow moved and the suppression did not, which is how this repository shipped eleven ' +
      'unsuppressed findings with a config that looked like it covered them',
  );
});

test('AC-5: THE GUARD FIRES, and names the entry and the path, against the config that caused the outage', () => {
  // The pre-fix file, verbatim: the spelling the workflows used before `job.workflow_sha`, still
  // quoted in the prose of both files it names, which is what made it look alive.
  const preFix = [
    'paths:',
    '  .github/workflows/release.yml:',
    '    ignore:',
    "      - 'property \"job_workflow_sha\" is not defined in object type'",
    '  .github/workflows/ci.yml:',
    '    ignore:',
    "      - 'property \"job_workflow_sha\" is not defined in object type'",
    '',
  ].join('\n');

  const stale = staleEntries(parseActionlintConfig(preFix));
  assert.deepEqual(stale, [
    `${WORKFLOWS}/release.yml: no expression there reads a "job_workflow_sha" property, so the ignore covers nothing`,
    `${WORKFLOWS}/ci.yml: no expression there reads a "job_workflow_sha" property, so the ignore covers nothing`,
  ]);
});

test('AC-5: and the guard is READING those files: the dead spelling is still explained in prose there', () => {
  // The control that keeps the assertion above from being vacuous. Both files quote the dead
  // spelling in comments; a guard that could not tell prose from configuration would find it there
  // and report the dead entry as live, which is a guard that can never fire.
  for (const name of ['ci.yml', 'release.yml']) {
    const text = readRepoFile(`${WORKFLOWS}/${name}`);
    assert.ok(text.includes('job_workflow_sha'), `${name} no longer explains the defect, so this control measures nothing`);
    assert.ok(
      !interpolatesProperty(text, 'job_workflow_sha'),
      `${name}: prose was read as configuration, so a dead ignore would look live`,
    );
  }
});

test('AC-5: an entry pointing at a workflow that no longer exists is stale, not invisible', () => {
  const gone = [
    'paths:',
    '  .github/workflows/deleted.yml:',
    '    ignore:',
    "      - 'property \"workflow_sha\" is not defined in object type'",
    '',
  ].join('\n');
  assert.deepEqual(staleEntries(parseActionlintConfig(gone)), [
    `${WORKFLOWS}/deleted.yml: the ignore of "workflow_sha" is scoped to a path that does not exist`,
  ]);
});

// ---------------------------------------------------------------------------
// THE READER REFUSES WHAT IT CANNOT READ
// ---------------------------------------------------------------------------

test('AC-4: the reader REFUSES a construct that could hide a suppression, rather than skipping it', () => {
  const cases = [
    ['a second top-level key', 'paths:\n  a.yml:\n    ignore:\n      - \'x\'\nself-hosted-runner:\n  labels: []\n', /only top-level key/],
    ['a duplicate path', "paths:\n  a.yml:\n    ignore:\n      - 'x'\n  a.yml:\n    ignore:\n      - 'y'\n", /appears twice/],
    ['a key other than ignore', "paths:\n  a.yml:\n    allow:\n      - 'x'\n", /only key a path may carry/],
    ['a path with no ignores', 'paths:\n  a.yml:\n', /opens no non-empty/],
    ['a block scalar pattern', 'paths:\n  a.yml:\n    ignore:\n      - |\n        x\n', /block scalar/],
    ['a flow collection', "paths:\n  a.yml:\n    ignore: ['x']\n", /only key a path may carry|flow collection/],
    ['an alias', "paths:\n  a.yml:\n    ignore:\n      - *dead\n", /anchor, an alias or a merge key/],
    ['a tab', "paths:\n\ta.yml:\n    ignore:\n      - 'x'\n", /tab cannot be indentation/],
  ];
  for (const [what, text, expected] of cases) {
    assert.throws(() => parseActionlintConfig(text), expected, `${what} was not refused`);
  }
});
