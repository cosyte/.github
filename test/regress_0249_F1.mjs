// Regression artifact for S0249-github-profile-ghp-11, impl gate loop 1, finding F1.
//
// Run it with:  node --test test/regress_0249_F1.mjs   (from github-profile/)
// It is deliberately NOT named `*.test.mjs`: the refuter write guard admits one extension only, and
// this file documents a bug rather than joining the repository's own suite.
//
// THE `labels:` KEY DETECTOR HAS NO REFUSAL BRANCH, so a template spelling the key in a form this
// reader does not recognise is read as "declares no labels" rather than being read or refused.
//
// `declaredLabels` guards the VALUE grammar carefully: a scalar, a mapping, a nested collection, a
// tab, an unclosed quote and an empty entry are each a TemplateError naming the file. The KEY is
// found by `/^labels:( |$|\t)/` alone, and a line that does not match falls through to `return []`.
// There is no third answer. Two spellings GitHub's own parser accepts do not match that regex:
//
//   1. CRLF line endings on a block sequence. `labels:\r\n  - bug\r\n` leaves `\r` immediately
//      after the colon, so the key is missed. YAML 1.2 makes CRLF a line break, so that file
//      declares `bug`. (A CRLF FLOW sequence, `labels: ["bug"]\r\n`, survives by accident: the
//      space after the colon carries the match. The block spelling is the one that is lost, and it
//      is the spelling GitHub's own issue-form documentation uses.)
//   2. A leading byte order mark on a document whose first key is `labels:`. YAML 1.2 permits a BOM
//      at the start of a stream, so `<BOM>labels: ["bug"]` declares `bug`; `^labels:` misses it.
//
// Either then takes the `no-label-obligation` branch: the check reports "there is no label
// obligation to measure", exits 0, and the obligation the templates really carry is never measured.
// A green run over an unmeasured obligation is the exact defect this phase exists to close.
//
// Spec clauses violated (work/specs/S0249-github-profile-ghp-11/spec.md):
//
//   "WHEN a default issue template declares a label THE SYSTEM SHALL verify that the label exists in
//    every repository owned by the organization that would render that template, and SHALL fail
//    naming each repository missing it."
//
//   "IF a default issue template cannot be parsed, or declares its labels in a form that is not a
//    list of strings, THEN THE SYSTEM SHALL fail naming the file, and SHALL NOT proceed as though
//    that template declared no labels."
//
//   "WHEN no default issue template declares any label THE SYSTEM SHALL report that there is no
//    label obligation to measure and succeed, rather than reporting that every repository is
//    covered."  Its trigger is FALSE here, and the branch is taken anyway.
//
// The assertions admit EITHER remedy the spec allows: read the labels, or refuse naming the file.
// Only the silent "declares no labels" answer fails them. This file documents the bug; fixing it is
// upstream's job.

import assert from 'node:assert/strict';
import test from 'node:test';

import { TemplateError, checkCoverage, declaredLabels } from '../scripts/org-defaults-coverage.mjs';

const BOM = String.fromCharCode(0xfeff);
const PATH = '.github/ISSUE_TEMPLATE/bug_report.yml';

/** Read the labels, or refuse naming the file. Returning `[]` is the one answer the spec forbids. */
function readOrRefuse(path, text) {
  try {
    return { labels: declaredLabels(path, text), refused: null };
  } catch (error) {
    assert.ok(error instanceof TemplateError, `refused with ${error} rather than a TemplateError`);
    return { labels: null, refused: error };
  }
}

test('F1a: a CRLF block sequence declares `bug`, and is read as declaring nothing', () => {
  const text = 'name: Bug report\r\nlabels:\r\n  - bug\r\nbody:\r\n  - type: input\r\n';
  const answer = readOrRefuse(PATH, text);
  assert.notDeepEqual(
    answer.labels,
    [],
    'a CRLF template declaring `bug` was read as declaring no labels: neither measured nor refused',
  );
  if (answer.refused === null) assert.deepEqual(answer.labels, ['bug']);
});

test('F1b: a byte order mark in front of `labels:` hides the declaration', () => {
  const text = `${BOM}labels: ["bug"]\nname: Bug report\n`;
  const answer = readOrRefuse(PATH, text);
  assert.notDeepEqual(
    answer.labels,
    [],
    'a BOM prefixed template declaring `bug` was read as declaring no labels: neither measured nor refused',
  );
  if (answer.refused === null) assert.deepEqual(answer.labels, ['bug']);
});

// ---------------------------------------------------------------------------
// End to end: the whole check goes green over an obligation nothing measured
// ---------------------------------------------------------------------------

const ACCOUNT = 'cosyte';
const DEFAULTS_REPO = 'cosyte/.github';
const LISTED = [DEFAULTS_REPO, 'cosyte/hl7'];

/**
 * The REST reads this check makes, over a fixture account where NO repository holds `bug` or
 * `enhancement`. A check that reads the templates must fail here, naming both repositories.
 */
function fakeFetch(url) {
  const path = new URL(url).pathname;
  const answer = (status, body) => ({ status, json: async () => body, headers: { get: () => null } });
  if (path === `/repos/${DEFAULTS_REPO}`) {
    return answer(200, { full_name: DEFAULTS_REPO, owner: { login: ACCOUNT, type: 'Organization' } });
  }
  if (path === `/orgs/${ACCOUNT}`) return answer(200, { login: ACCOUNT, public_repos: LISTED.length });
  if (path === `/orgs/${ACCOUNT}/repos`) {
    return answer(200, LISTED.map((name) => ({ name: name.split('/')[1], full_name: name })));
  }
  if (/^\/repos\/[^/]+\/[^/]+\/contents\//.test(path)) return answer(404, { message: 'Not Found' });
  if (/^\/repos\/[^/]+\/[^/]+\/labels$/.test(path)) return answer(200, []);
  return answer(404, { message: 'Not Found' });
}

test('F1c: CRLF templates take the no-obligation branch and the run exits green', async () => {
  const templateFiles = [
    { name: 'bug_report.yml', text: 'name: Bug report\r\nlabels:\r\n  - bug\r\n' },
    { name: 'feature_request.yml', text: 'name: Feature\r\nlabels:\r\n  - enhancement\r\n' },
  ];
  const { report, failing } = await checkCoverage({
    repository: DEFAULTS_REPO,
    templateFiles,
    apiBase: 'http://127.0.0.1:1',
    token: 'not-a-credential',
    fetchImpl: fakeFetch,
  });
  assert.notEqual(
    report.outcome,
    'no-label-obligation',
    'the templates declare `bug` and `enhancement`, so "no label obligation to measure" is a false statement',
  );
  assert.equal(
    failing,
    true,
    'no repository in the fixture holds `bug` or `enhancement`, yet the check reported success',
  );
});
