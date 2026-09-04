// Tests over the governance answer and the licence: what this account actually serves into the
// repositories it owns, and what it only claims to.
//
// WHAT THIS IS FOR, said once so the cases read against it. A newcomer to any `@cosyte/*` repository
// can already find how to contribute, how to behave and how to report a vulnerability, because those
// are types GitHub renders account-wide from `cosyte/.github`. Two answers cannot travel that way,
// and the committed copy of "Creating a default community health file" is where that is settled:
// its table of supported types has no governance row, the string `governance` occurs nowhere on the
// page, and the page states in its own words "You cannot create a default license file."
//
// So a document here can be wrong in a way no reader can see: it can promise reach the platform does
// not give it. `GOVERNANCE.md` linked from a contributing guide reaches every reader who follows the
// link; `GOVERNANCE.md` ASSERTED to render account-wide is a promise that silently keeps itself in
// this repository and nowhere else. This file refuses the claim, in the tracked tree, by name.
//
// AND IT READS THE TRACKED FILES, in the style of `scripts/check-no-emdash.mjs` and
// `test/caller-reference-docs.test.mjs`, rather than trusting that a change was made everywhere it
// had to be. There is no YAML or markdown library here (this repository has no `package.json`), so
// the parse is line and sentence based and deliberately dumb; every assertion is about text a human
// reads, which is what that kind of reading is good at.
//
// FAIL-CLOSED IS THE HOUSE RULE. Every read goes through `readTracked`, which throws naming the path
// rather than returning an empty string, and the enumeration is held to a floor and to known
// members, because a filtered `git ls-files` reporting a clean tree is the one outcome that looks
// exactly like a passing run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_TYPES } from '../scripts/org-defaults-coverage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** The file GitHub reads a repository's licence from. Not `LICENCE`, not `LICENSE.md`, by choice. */
const LICENSE_PATH = 'LICENSE';

/** The long-form governance document. Reached by link from anywhere; served to nowhere. */
const GOVERNANCE_PATH = 'GOVERNANCE.md';

/** The address a defaulted file has to use for it, because a relative one resolves elsewhere. */
const GOVERNANCE_URL = 'https://github.com/cosyte/.github/blob/main/GOVERNANCE.md';

/** The org-wide contributing guide, which IS a supported type and does carry the answer everywhere. */
const CONTRIBUTING_PATH = 'CONTRIBUTING.md';

const README_PATH = 'README.md';

/**
 * The community-health files this repository publishes that GitHub renders inside OTHER
 * repositories. A pointer in one of these is read from a page belonging to the repository it renders
 * in, which is why the link rule below applies to exactly this list and not to `README.md` or
 * `GOVERNANCE.md`, neither of which is a supported type and neither of which travels.
 *
 * The issue templates and their `config.yml` are on the list because the source names them among the
 * supported types, and this repository publishes three. Their pointers are `url:` fields rather than
 * markdown links and every one of them is absolute today; the rule is what keeps the next one so.
 */
const DEFAULTED_FILES = Object.freeze([
  'CODE_OF_CONDUCT.md',
  CONTRIBUTING_PATH,
  'SECURITY.md',
  'SUPPORT.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
]);

/**
 * The supported types, verbatim from the table in the committed copy of "Creating a default
 * community health file" (fetched 2026-09-03). Pinned here as data so that a document claiming
 * account-wide reach for anything else is a comparison rather than a matter of opinion.
 */
const SUPPORTED_FROM_SOURCE = Object.freeze([
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'Discussion category forms',
  'FUNDING.yml',
  'Issue and pull request templates and config.yml',
  'SECURITY.md',
  'SUPPORT.md',
]);

/** The floor under the enumeration. The tree carried 51 tracked paths when this landed. */
const MIN_TRACKED = 30;

/** Known tracked members, so an enumeration that silently dropped files refuses instead. */
const KNOWN_TRACKED = Object.freeze([README_PATH, CONTRIBUTING_PATH, GOVERNANCE_PATH, LICENSE_PATH]);

/** Raised instead of returning something a caller could mistake for a clean read. */
class SurfaceError extends Error {
  constructor(path, reason) {
    super(`cannot read ${path}: ${reason}`);
    this.name = 'SurfaceError';
    this.path = path;
    this.reason = reason;
  }
}

/**
 * Read a tracked file, or refuse naming the path.
 *
 * `readFileSync` already throws, but it throws an `ENOENT` whose message a caller has to parse to
 * learn which of several reads failed. This names the path as a field, which is what the refusal
 * tests assert on.
 *
 * @param {string} relative path from the repository root
 * @returns {string}
 */
function readTracked(relative) {
  try {
    const text = readFileSync(join(REPO, relative), 'utf8');
    if (typeof text !== 'string') throw new Error('not text');
    return text;
  } catch (error) {
    throw new SurfaceError(relative, error?.code ?? error?.message ?? 'unknown');
  }
}

/** Every tracked path, NUL separated so a newline in a name cannot split one. */
function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new SurfaceError('git ls-files', result.error.message);
  if (result.status !== 0) throw new SurfaceError('git ls-files', `exited ${result.status}`);
  return result.stdout.split('\0').filter((path) => path.length > 0);
}

// ---------------------------------------------------------------------------
// Reading prose in units, because a claim is made in one and denied in one
// ---------------------------------------------------------------------------

/**
 * Split markdown into the units a claim is made in: sentences, table cells, list items, headings.
 *
 * A table cell has no full stop and a bullet often has none either, so splitting on `.` alone would
 * glue a row of denials onto the claim below it and read the denial as covering both. Splitting on
 * the markdown boundaries as well keeps each claim beside its own words.
 *
 * A link is reduced to the words a reader sees first: a claim is made in prose, and leaving the
 * target in would put a URL's punctuation in the middle of the sentence carrying it.
 *
 * @param {string} text
 * @returns {string[]}
 */
function units(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/(?<=[.!?])\s+|\n\s*\n|\n(?=\s*(?:[-*>#]|\d+\.)\s)|\|/g)
    .map((unit) => unit.replace(/\s+/g, ' ').trim())
    .filter((unit) => unit.length > 0);
}

/**
 * The clauses of a unit: what an assertion and the file it is about have to share to be one claim.
 *
 * One sentence routinely names a supported type in one clause and this repository's own governance
 * file in the next, and reading the two as a single statement invents a claim nobody made. A full
 * stop ends a clause only when whitespace follows it, so `GOVERNANCE.md` stays one token.
 *
 * @param {string} unit
 * @returns {string[]}
 */
function clauses(unit) {
  return unit
    .split(/[,;:!?()]|\.(?=\s|$)/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/** A mention of the governance FILE, not of the word "governance" in prose. */
const GOVERNANCE_MENTION = /GOVERNANCE\.md|governance (?:file|document)/i;

/** A mention of the licence FILE. Uppercase, or the words, never the bare word "licensed". */
const LICENSE_MENTION = /\bLICENSE(?:\.md|\.txt)?\b|licen[sc]e file|license files/;

/**
 * A mention of a file the source DOES list, by filename or by the name the page gives its type.
 * Used only to answer which file an assertion is about: a clause naming one of these has said.
 */
const SUPPORTED_MENTION = new RegExp([
  'CODE_OF_CONDUCT\\.md', 'CONTRIBUTING\\.md', 'SECURITY\\.md', 'SUPPORT\\.md', 'FUNDING\\.yml',
  'PULL_REQUEST_TEMPLATE\\.md', 'config\\.yml', 'issue templates?', 'pull request templates?',
  'contributing guide', 'code of conduct', 'security policy', 'support file',
  'discussion category forms?',
].join('|'), 'i');

/**
 * Words that deny.
 *
 * They are NOT a reason to skip a unit, and reading them as one is how this check first went wrong.
 * The default mechanism cannot be stated in English without one of them, because the mechanism IS
 * "a repository that has no file of its own gets this account's": the claim this file exists to
 * refuse carries `no` for that reason, and so does every idiomatic spelling of it. Skipping on the
 * word made the whole tree scan green by suppression, over units nothing ever weighed.
 *
 * So a denial counts where it ATTACHES. This vocabulary is spliced into every serving pattern below
 * as a lookbehind, so a negation reaching the assertion stops it being one, and a negation elsewhere
 * in the sentence leaves the assertion standing.
 */
const DENIAL = /\b(?:not|never|cannot|can't|no|none|nothing|neither|nor|absent|without|excluded?|refus\w+|zero)\b/i;

/**
 * How far back a denial reaches: 48 characters, about eight words, and stopped by any clause
 * boundary before that.
 *
 * Short on purpose, and the direction of the error decides the number. A denial read too narrowly
 * fails a run over prose that is correct, which a human fixes in one edit; a denial read too widely
 * swallows the assertion in the main clause because a subordinate clause said "no" somewhere, which
 * ships a promise the platform does not keep and says nothing. "a repository that has no GOVERNANCE
 * file of its own gets this account's" has to read as a claim, and it is the negation next to the
 * verb ("is not rendered", "cannot create a default license file") that reads as a denial.
 */
const DENIAL_REACH = 48;

/**
 * "no denial attached here", as a lookbehind: no word of `DENIAL` within `DENIAL_REACH` characters
 * before this point, and no clause boundary crossed to reach it.
 *
 * Because the reach stops at a boundary, a pattern carrying it answers the same whether it is asked
 * about one clause or about the whole sentence that clause sits in.
 */
const UNDENIED = `(?<!${DENIAL.source}(?:[^.,;:!?()]|\\.(?!\\s)){0,${DENIAL_REACH}})`;

/**
 * Phrases that ASSERT account-wide default rendering, rather than discussing it or denying it.
 *
 * The vocabulary is the platform's own. Each is compiled with the negation lookbehind in front of
 * it, which is what makes the list an assertion detector rather than a topic detector.
 */
const SERVED_ACCOUNT_WIDE = Object.freeze([
  'account[- ]wide default',
  'org(?:anization)?[- ]wide default',
  'default community[- ]health file',
  'default (?:license|licence) file',
  'supported[\\w\\s-]{0,24}\\btypes?\\b',
  '(?:rendered|renders|render|served|serves|serve|delivered|delivers) (?:it )?account[- ]wide',
  'as (?:an?|the) (?:GitHub )?default\\b',
  'inherit(?:s|ed)? from (?:this|the) (?:account|repository)',
].map((phrase) => new RegExp(UNDENIED + phrase, 'i')));

/** The two subjects a finding can have, in the order a finding names them. */
const SUBJECTS = Object.freeze(['a governance file', 'a license file']);

/** Whether a clause names any community-health file at all, and so answers what it is about. */
function namesAFile(clause) {
  return GOVERNANCE_MENTION.test(clause) || LICENSE_MENTION.test(clause) || SUPPORTED_MENTION.test(clause);
}

/**
 * Every unit of `text` that claims account-wide default rendering for a type the source does not
 * list, with the document named.
 *
 * A claim is an assertion with no denial attached to it, about the governance file or the licence.
 * The assertion's own clause answers which file it is about; where that clause names no file, the
 * rest of the sentence answers, so a subject held one relative clause away is still read.
 *
 * @param {string} path the document, named because the refusal has to say which one
 * @param {string} text
 * @returns {{path: string, subject: string, unit: string}[]}
 */
function overreachFindings(path, text) {
  const findings = [];
  for (const unit of units(text)) {
    const subjects = new Set();
    for (const clause of clauses(unit)) {
      if (!SERVED_ACCOUNT_WIDE.some((phrase) => phrase.test(clause))) continue;
      const about = namesAFile(clause) ? clause : unit;
      if (GOVERNANCE_MENTION.test(about)) subjects.add(SUBJECTS[0]);
      if (LICENSE_MENTION.test(about)) subjects.add(SUBJECTS[1]);
    }
    for (const subject of SUBJECTS) {
      if (subjects.has(subject)) findings.push({ path, subject, unit });
    }
  }
  return findings;
}

/** A finding, rendered the way a failing run should read it. */
const describe = (finding) => `${finding.path} claims ${finding.subject} is served account-wide: ${finding.unit}`;

// ---------------------------------------------------------------------------
// Links inside a file that renders somewhere else
// ---------------------------------------------------------------------------

/**
 * Every link target in a markdown document: inline links and reference definitions both.
 *
 * @param {string} text
 * @returns {string[]}
 */
function linkTargets(text) {
  const targets = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) targets.push(match[1]);
  for (const match of text.matchAll(/^\[[^\]]+\]:\s*<?(\S+?)>?\s*$/gm)) targets.push(match[1]);
  return targets;
}

/**
 * The `url:` values of an issue form's contact links, which point the same way a markdown link does.
 *
 * This repository ships no YAML parser, so the reader recognises the one shape these files use, the
 * way `scripts/org-defaults-coverage.mjs` reads their `labels:` key.
 *
 * @param {string} text
 * @returns {string[]}
 */
function yamlUrlTargets(text) {
  return [...text.matchAll(/^\s*(?:-\s+)?url:\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/gm)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
}

/**
 * Every pointer a defaulted file carries, read by what the file is: markdown links everywhere, and
 * `url:` fields as well in an issue form or its configuration.
 *
 * @param {string} path
 * @param {string} text
 * @returns {string[]}
 */
function pointerTargets(path, text) {
  return /\.ya?ml$/.test(path) ? [...linkTargets(text), ...yamlUrlTargets(text)] : linkTargets(text);
}

/**
 * Link targets in a defaulted file that would not resolve to this repository from wherever the
 * default is rendered.
 *
 * The committed source documents no resolution for a relative link in a rendered default, in either
 * direction, so the rule takes the direction that is correct under both: an absolute URL resolves
 * here from anywhere, and an in-document fragment resolves within the rendered page itself. A
 * repository-relative path is correct under at most one reading and silently wrong under the other.
 *
 * @param {string} path
 * @param {string} text
 * @returns {{path: string, target: string}[]}
 */
function unresolvableLinks(path, text) {
  return pointerTargets(path, text)
    .filter((target) => !/^(?:https?:\/\/|mailto:|#)/i.test(target))
    .map((target) => ({ path, target }));
}

// ---------------------------------------------------------------------------
// The licence, and the guide that sends a contributor to it
// ---------------------------------------------------------------------------

/**
 * The lines of one `## ` section of a markdown document, heading included.
 *
 * @param {string} path named so a missing section refuses by name
 * @param {string} text
 * @param {string} heading the exact heading line
 * @returns {string}
 */
function section(path, text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new SurfaceError(path, `no section ${JSON.stringify(heading)}`);
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

/** The licence families this check can recognise by their opening line. */
const LICENSE_FAMILIES = Object.freeze([
  { family: 'MIT', opening: /^MIT License$/m, body: /Permission is hereby granted, free of charge/ },
  { family: 'Apache-2.0', opening: /^\s*Apache License$/m, body: /Version 2\.0, January 2004/ },
  { family: 'BSD-3-Clause', opening: /^BSD 3-Clause License$/m, body: /Redistribution and use in source and binary/ },
]);

/**
 * Whether the stated terms and the file carrying them agree, naming BOTH files when they do not.
 *
 * Naming both is the point rather than a nicety: a contributor is told their work is licensed "under
 * the same terms as the repository you're contributing to", so the defect is always a disagreement
 * between two documents and never a property of one of them.
 *
 * @param {{licensePath: string, licenseText: string|null, contributingPath: string, licensing: string}} input
 * @returns {string[]} findings, empty when they agree
 */
function licensingFindings({ licensePath, licenseText, contributingPath, licensing }) {
  const both = `${licensePath} and ${contributingPath}`;
  if (licenseText === null) return [`${both}: ${licensePath} is absent, so the terms ${contributingPath} states are not stated anywhere`];
  if (licenseText.trim() === '') return [`${both}: ${licensePath} is empty, so this repository states no license terms`];

  const findings = [];
  const recognised = LICENSE_FAMILIES.filter((entry) => entry.opening.test(licenseText) && entry.body.test(licenseText));
  if (recognised.length !== 1) {
    findings.push(`${both}: ${licensePath} carries no license this check recognises, so it cannot be compared with the terms ${contributingPath} states`);
    return findings;
  }
  const [{ family }] = recognised;

  if (!new RegExp(`\\b${family}\\b`).test(licensing)) {
    findings.push(`${both}: ${licensePath} is ${family} and the Licensing section of ${contributingPath} does not name ${family}`);
  }
  if (!/\bLICENSE\b/.test(licensing)) {
    findings.push(`${both}: the Licensing section of ${contributingPath} does not send a contributor to ${licensePath}`);
  }
  if (!/Copyright \(c\) \d{4} \S/.test(licenseText)) {
    findings.push(`${both}: ${licensePath} carries no copyright line, so it names no holder and no year`);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The tree, read once
// ---------------------------------------------------------------------------

const TRACKED = trackedFiles();
const TRACKED_DOCS = TRACKED.filter((path) => path.endsWith('.md'));
const README = readTracked(README_PATH);
const CONTRIBUTING = readTracked(CONTRIBUTING_PATH);
const GOVERNANCE = readTracked(GOVERNANCE_PATH);
const LICENSE = readTracked(LICENSE_PATH);

const CONTRIBUTING_GOVERNANCE = section(CONTRIBUTING_PATH, CONTRIBUTING, '## Who decides, and how');
const CONTRIBUTING_LICENSING = section(CONTRIBUTING_PATH, CONTRIBUTING, '## Licensing');
const README_FINDING = section(README_PATH, README, '## What the account inherits, and the two things it cannot');

// ---------------------------------------------------------------------------
// AC 9: it refuses rather than reporting a pass over something it could not read
// ---------------------------------------------------------------------------

test('AC9: a file that cannot be read refuses naming the path, and returns nothing', () => {
  assert.throws(
    () => readTracked('GOVERNANCE-that-does-not-exist.md'),
    (error) => {
      assert.ok(error instanceof SurfaceError);
      assert.equal(error.path, 'GOVERNANCE-that-does-not-exist.md');
      assert.match(error.message, /cannot read GOVERNANCE-that-does-not-exist\.md/);
      return true;
    },
  );
});

test('AC9: a directory read as a document refuses naming the path rather than reading as empty', () => {
  assert.throws(() => readTracked('scripts'), (error) => {
    assert.ok(error instanceof SurfaceError);
    assert.equal(error.path, 'scripts');
    return true;
  });
});

test('AC9: a missing section refuses naming the document and the heading', () => {
  assert.throws(() => section(README_PATH, README, '## A section nobody wrote'), (error) => {
    assert.ok(error instanceof SurfaceError);
    assert.equal(error.path, README_PATH);
    assert.match(error.message, /no section "## A section nobody wrote"/);
    return true;
  });
});

test('AC9: the enumeration is held to a floor and to known members, so a filtered one refuses', () => {
  assert.ok(
    TRACKED.length >= MIN_TRACKED,
    `git ls-files returned only ${TRACKED.length} paths, which is below the floor of ${MIN_TRACKED}`,
  );
  for (const known of KNOWN_TRACKED) {
    assert.ok(TRACKED.includes(known), `${known} is not in the enumeration, so the enumeration is not the tree`);
  }
  assert.ok(TRACKED_DOCS.length >= 5, 'the tracked markdown set is too small to be this repository');
});

// ---------------------------------------------------------------------------
// AC 2: the governance document itself
// ---------------------------------------------------------------------------

test('AC2: the governance document names who decides', () => {
  assert.match(GOVERNANCE, /^## Who decides$/m);
  assert.match(GOVERNANCE, /One maintainer holds the final call: `noah`/);
  assert.match(GOVERNANCE, /account owner of record/);
  assert.match(GOVERNANCE, /no committee, no vote, and no tie to break/i, 'the absence of a committee is stated too');
});

test('AC2: the governance document says how a decision is reached', () => {
  assert.match(GOVERNANCE, /^## How a decision is reached$/m);
  assert.match(GOVERNANCE, /In the open, on the issue or pull request, and in writing/);
  assert.match(GOVERNANCE, /A declined proposal gets a reason/);
  assert.match(GOVERNANCE, /Silence is not consent/);
});

test('AC2: the governance document says how a contributor escalates a disagreement', () => {
  assert.match(GOVERNANCE, /^## How to escalate a disagreement$/m);
  assert.match(GOVERNANCE, /Escalate on the thread first/);
  assert.match(GOVERNANCE, /open an issue naming the stall/);
  assert.match(GOVERNANCE, /ask for the reason in\s+writing/);
  assert.match(GOVERNANCE, /security\/policy/, 'and the two routes that are not this one are named');
  assert.match(GOVERNANCE, /CODE_OF_CONDUCT\.md/);
});

test('AC2: the governance document says how its own terms change', () => {
  assert.match(GOVERNANCE, /^## How this document changes$/m);
  assert.match(GOVERNANCE, /a pull request against this file, in this repository/);
  assert.match(GOVERNANCE, /no\s+separate amendment procedure/);
});

test('AC2: the governance escalation route is the one CONTRIBUTING.md already sends a reader down', () => {
  // Building a second, parallel route is the failure mode: the guide says "open an issue to discuss
  // it before you build", and a governance document inventing a different first step beside that
  // leaves a contributor choosing between two.
  assert.match(CONTRIBUTING, /open an issue to discuss it before you\s+build/);
  assert.match(GOVERNANCE, /builds on the one\s+`CONTRIBUTING\.md` already sends you down/);
});

// ---------------------------------------------------------------------------
// AC 1: the answer is in the text that renders account-wide, not behind a link
// ---------------------------------------------------------------------------

/** The section with every unit that mentions the long-form document removed. */
const CONTRIBUTING_GOVERNANCE_WITHOUT_LINK = units(CONTRIBUTING_GOVERNANCE)
  .filter((unit) => !GOVERNANCE_MENTION.test(unit))
  .join(' ');

test('AC1: the contributing guide answers who decides, inline', () => {
  assert.match(CONTRIBUTING_GOVERNANCE_WITHOUT_LINK, /One maintainer holds the final call: `noah`/);
  assert.match(CONTRIBUTING_GOVERNANCE_WITHOUT_LINK, /account owner\s+of record/);
});

test('AC1: the contributing guide answers how a decision is reached, inline', () => {
  assert.match(CONTRIBUTING_GOVERNANCE_WITHOUT_LINK, /In the open, on the issue or pull request, in\s+writing/);
  assert.match(CONTRIBUTING_GOVERNANCE_WITHOUT_LINK, /A declined proposal gets a reason/);
  assert.match(CONTRIBUTING_GOVERNANCE_WITHOUT_LINK, /Silence is not\s+consent/);
});

test('AC1: the contributing guide answers how a contributor escalates, inline', () => {
  assert.match(CONTRIBUTING_GOVERNANCE_WITHOUT_LINK, /On the thread first, and in public/);
  assert.match(CONTRIBUTING_GOVERNANCE_WITHOUT_LINK, /open an issue naming the\s+stall/);
  assert.match(CONTRIBUTING_GOVERNANCE_WITHOUT_LINK, /entitled to a reason/);
});

test('AC1: the three answers survive deleting every mention of the long-form document', () => {
  // The whole point of the inline copy. A reader in another repository sees this file and no other,
  // so an answer that only exists on the other side of the link is not an answer for them.
  assert.ok(
    !GOVERNANCE_MENTION.test(CONTRIBUTING_GOVERNANCE_WITHOUT_LINK),
    'the stripped section still mentions the long-form document, so the stripping proved nothing',
  );
  assert.ok(
    CONTRIBUTING_GOVERNANCE_WITHOUT_LINK.length > 600,
    'the answer left after the link is removed is too short to be one',
  );
});

test('AC1: the contributing guide says why the answer is inline rather than behind the link', () => {
  assert.match(CONTRIBUTING_GOVERNANCE, /The answer is here rather than behind a link/);
});

// ---------------------------------------------------------------------------
// AC 3: a pointer in a defaulted file resolves to THIS repository from anywhere
// ---------------------------------------------------------------------------

for (const path of DEFAULTED_FILES) {
  test(`AC3: every pointer in ${path} resolves to this repository from wherever the default renders`, () => {
    const findings = unresolvableLinks(path, readTracked(path));
    assert.deepEqual(
      findings,
      [],
      findings.map((finding) => `${finding.path} links to ${finding.target}, which is relative to the rendering repository`).join('\n'),
    );
  });
}

test('AC3: the defaulted set is the supported one, so a type that travels is not left unchecked', () => {
  // The gap this closes: the issue templates and their config.yml are supported types and this
  // repository publishes three of them, so a relative pointer in one renders inside another
  // repository and resolves there. Absent from the list, the rule above would never read them.
  for (const path of ['.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml']) {
    assert.ok(DEFAULTED_FILES.includes(path), `${path} is published as a default and is not held to the link rule`);
    assert.ok(TRACKED.includes(path), `${path} is not tracked, so the rule above is graded over nothing`);
  }
});

test('AC3: a url: field in an issue form is read, and a relative one is a finding', () => {
  const config = 'blank_issues_enabled: false\ncontact_links:\n'
    + '  - name: Documentation\n    url: https://docs.cosyte.com\n    about: Guides.\n'
    + '  - name: Governance\n    url: GOVERNANCE.md\n    about: Who decides.\n'
    + '  - name: Quoted\n    url: "../CONTRIBUTING.md"\n';
  assert.deepEqual(unresolvableLinks('.github/ISSUE_TEMPLATE/config.yml', config), [
    { path: '.github/ISSUE_TEMPLATE/config.yml', target: 'GOVERNANCE.md' },
    { path: '.github/ISSUE_TEMPLATE/config.yml', target: '../CONTRIBUTING.md' },
  ]);
  // The same field in a markdown document is prose, not a pointer, so the reader stays with the file
  // type it belongs to rather than matching the key wherever it appears.
  assert.deepEqual(unresolvableLinks(README_PATH, 'url: GOVERNANCE.md\n'), []);
});

test('AC3: the pointer from the contributing guide to the long-form document is a full URL', () => {
  // A plain substring, not a pattern. An unanchored regular expression carrying a host is a
  // `js/regex/missing-regexp-anchor` finding, and the assertion wants an exact string anyway.
  assert.ok(
    CONTRIBUTING_GOVERNANCE.includes(GOVERNANCE_URL),
    `the guide renders in repositories that do not contain GOVERNANCE.md, so it must link ${GOVERNANCE_URL}`,
  );
  assert.match(CONTRIBUTING_GOVERNANCE, /written as a full URL because this guide is served into repositories that\s+do not contain it/);
});

test('AC3: the link rule bites, which a tree that already complies cannot show on its own', () => {
  const relative = '# Guide\n\nSee [the governance document](GOVERNANCE.md) and [the licence](./LICENSE).\n';
  assert.deepEqual(unresolvableLinks(CONTRIBUTING_PATH, relative), [
    { path: CONTRIBUTING_PATH, target: 'GOVERNANCE.md' },
    { path: CONTRIBUTING_PATH, target: './LICENSE' },
  ]);
  const absolute = 'See [it](https://github.com/cosyte/.github/blob/main/GOVERNANCE.md) and [this page](#who-decides).\n';
  assert.deepEqual(unresolvableLinks(CONTRIBUTING_PATH, absolute), []);
});

test('AC3: a reference-style definition is read too, not only an inline link', () => {
  const text = 'See [the document][doc].\n\n[doc]: GOVERNANCE.md\n';
  assert.deepEqual(unresolvableLinks(CONTRIBUTING_PATH, text), [{ path: CONTRIBUTING_PATH, target: 'GOVERNANCE.md' }]);
});

// ---------------------------------------------------------------------------
// AC 4 and AC 5: no document claims reach the platform does not give
// ---------------------------------------------------------------------------

test('AC4: the supported set this repository measures against is the one the source lists', () => {
  // Confirming the exclusion rather than reversing it. A paraphrase in the umbrella's research notes
  // lists a governance file among the supported types and the page's table does not, and the page is
  // what these checks are measured against.
  const names = SUPPORTED_TYPES.flatMap((entry) => entry.names);
  for (const name of names) {
    assert.ok(!GOVERNANCE_MENTION.test(name), `${name} is in SUPPORTED_TYPES, and the source table has no governance row`);
    assert.ok(!LICENSE_MENTION.test(name), `${name} is in SUPPORTED_TYPES, and the source rules a default licence out in its own words`);
  }
  assert.deepEqual(SUPPORTED_TYPES.map((entry) => entry.type), [
    'code of conduct',
    'contributing guide',
    'discussion category forms',
    'funding file',
    'issue templates and config.yml',
    'pull request template',
    'security policy',
    'support file',
  ]);
});

test('AC4: the README records the supported set verbatim, and both types that are not in it', () => {
  for (const supported of SUPPORTED_FROM_SOURCE) {
    const shown = supported === 'Discussion category forms' ? 'discussion category forms'
      : supported === 'Issue and pull request templates and config.yml' ? 'issue and pull\nrequest templates with their *config.yml*'
      : `*${supported}*`;
    assert.ok(
      README_FINDING.replace(/\s+/g, ' ').includes(shown.replace(/\s+/g, ' ')),
      `the README's supported set does not carry ${supported}`,
    );
  }
  assert.match(README_FINDING, /The string `governance` occurs zero times on the page/);
  assert.match(README_FINDING, /You cannot create a default license file/);
  assert.match(README_FINDING, /fetched 2026-09-03/);
});

test('AC5: no tracked document claims a governance file or a licence is served account-wide', () => {
  const findings = TRACKED_DOCS.flatMap((path) => overreachFindings(path, readTracked(path)));
  assert.deepEqual(findings.map(describe), [], findings.map(describe).join('\n'));
});

/** The roadmap phase's own assertion, which is the claim AC 5 names. Verbatim, negative included. */
const PHASE_CLAIM = 'WHEN a repository owned by the organization has no GOVERNANCE file of its own THE SYSTEM SHALL '
  + 'render this repository GOVERNANCE.md as an account-wide default, stating who decides and how.';

test('AC5: the claim the roadmap phase carried is caught, and the finding names the document', () => {
  // The phase's own sentence, unedited. It carries "no ... of its own" because the mechanism it
  // borrows cannot be stated without a negative, and that is exactly the sentence to ask about: a
  // positive control rewritten to drop the negative proves the detector on prose nobody writes.
  const findings = overreachFindings(GOVERNANCE_PATH, PHASE_CLAIM);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, GOVERNANCE_PATH);
  assert.equal(findings[0].subject, 'a governance file');
  assert.match(describe(findings[0]), /^GOVERNANCE\.md claims a governance file is served account-wide/);
  assert.match(describe(findings[0]), /has no GOVERNANCE file of its own/, 'the finding quotes the sentence back');
});

for (const claim of [
  'GOVERNANCE.md is rendered as an account-wide default in every repository this account owns that has no governance file of its own.',
  'When a repository owned by the organization has no GOVERNANCE file of its own, GitHub renders this repository GOVERNANCE.md as an account-wide default.',
  'Our GOVERNANCE.md is rendered account-wide as a GitHub default, and no repository has to copy it.',
  'GOVERNANCE.md is one of the supported types, so it renders in every repository with none of its own.',
  'GOVERNANCE.md, which nobody has to copy, is rendered as an account-wide default.',
  'CODE_OF_CONDUCT.md, CONTRIBUTING.md and GOVERNANCE.md are all rendered account-wide.',
  'GOVERNANCE.md is rendered as an account-wide default for every repository this account owns.',
]) {
  test(`AC5: the claim is caught spelled as: ${claim.slice(0, 56)}`, () => {
    // Four of these carry a negative in the same sentence, in the place the mechanism puts it: a
    // check that skipped a unit on the word would miss all four and report a clean tree. The last
    // three vary the shape instead, holding the subject behind a relative clause, hiding it in a
    // list of types that really are supported, and stating it flat.
    const findings = overreachFindings(README_PATH, claim);
    assert.equal(findings.length, 1, `no finding for ${JSON.stringify(claim)}`);
    assert.equal(findings[0].subject, 'a governance file');
    assert.equal(findings[0].path, README_PATH);
  });
}

test('AC5: the same claim about a licence is caught, because the source rules that one out by name', () => {
  const findings = overreachFindings(README_PATH, 'The LICENSE here is rendered as a default in every repository we own.');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject, 'a license file');
  assert.match(describe(findings[0]), /^README\.md claims a license file is served account-wide/);
});

test('AC5: the licence claim is caught with the negative the mechanism needs, too', () => {
  const findings = overreachFindings(README_PATH, 'The LICENSE here is rendered as an account-wide default for every repository that has none of its own.');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject, 'a license file');
});

for (const denial of [
  'A governance file is not one of the types served account-wide.',
  'You cannot create a default license file.',
  'GOVERNANCE.md is not rendered as an account-wide default.',
  'GOVERNANCE.md is never rendered account-wide, in any repository.',
  'No governance file is served account-wide.',
  'A governance file is not one of the community-health types GitHub serves account-wide, so this file is not rendered into any repository but its own.',
  'It is not a supported type, so GOVERNANCE.md appears in no repository but this one.',
]) {
  test(`AC5: a denial attached to the assertion is read as a denial: ${denial.slice(0, 46)}`, () => {
    assert.deepEqual(overreachFindings(GOVERNANCE_PATH, denial), [], `${JSON.stringify(denial)} reads as a claim`);
  });
}

test('AC5: the denial has to reach the assertion, and one that does not leaves it standing', () => {
  // The pair that decides the whole design. Both sentences carry `no`; only one of them denies the
  // assertion, and the difference is where the word sits rather than whether it is there.
  assert.deepEqual(overreachFindings(README_PATH, 'GOVERNANCE.md is not served account-wide to a repository that has none of its own.'), []);
  const findings = overreachFindings(README_PATH, 'GOVERNANCE.md is served account-wide to a repository that has none of its own.');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject, 'a governance file');
});

test('AC5: a denial one unit away does not cover a claim in the next', () => {
  // The failure this splitting exists to prevent: a table row of denials sitting above a claim, or a
  // paragraph that ends in "not" followed by a sentence that asserts.
  const text = 'A licence cannot be defaulted. GOVERNANCE.md is served account-wide by this account.';
  const findings = overreachFindings(README_PATH, text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject, 'a governance file');
});

test('AC5: an assertion about a supported type is not an assertion about the file named after it', () => {
  // The other half of the same rule. The clause carrying the assertion says what it is about, and a
  // sentence that goes on to name the long-form document is not claiming reach for that document.
  assert.deepEqual(
    overreachFindings(README_PATH, 'CONTRIBUTING.md is served account-wide, and GOVERNANCE.md holds the long version for whoever follows the link.'),
    [],
  );
});

test('AC5: prose using the word governance without naming the file is not a claim about a file', () => {
  assert.deepEqual(overreachFindings(README_PATH, 'The governance answer travels as a supported type, inside the guide.'), []);
});

test('AC5: the tree scan is reaching units rather than skipping them, and this proves it reaches one', () => {
  // A green scan over a set nothing weighed looks exactly like a green scan over a clean tree. This
  // asserts the difference: at least one tracked unit really is an assertion of account-wide
  // rendering that names one of these two files elsewhere in the sentence, and it passes on the
  // rule rather than on a skip.
  const weighed = TRACKED_DOCS.flatMap((path) => units(readTracked(path)))
    .filter((unit) => SERVED_ACCOUNT_WIDE.some((phrase) => phrase.test(unit)))
    .filter((unit) => GOVERNANCE_MENTION.test(unit) || LICENSE_MENTION.test(unit));
  assert.ok(weighed.length > 0, 'no tracked unit asserts account-wide rendering near either file, so the scan proved nothing');
});

// ---------------------------------------------------------------------------
// AC 6 and AC 7: the terms exist, and the two documents agree on them
// ---------------------------------------------------------------------------

test('AC6: the licence is in the file GitHub reads a repository licence from', () => {
  assert.ok(TRACKED.includes(LICENSE_PATH), 'LICENSE is not tracked, so GitHub reads no licence here');
  assert.match(LICENSE, /^MIT License$/m);
  assert.match(LICENSE, /^Copyright \(c\) 2026 Cosyte$/m);
  assert.match(LICENSE, /Permission is hereby granted, free of charge/);
  assert.match(LICENSE, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test('AC7: the licence and the guide agree, and no finding is produced over the tree as it stands', () => {
  const findings = licensingFindings({
    licensePath: LICENSE_PATH,
    licenseText: LICENSE,
    contributingPath: CONTRIBUTING_PATH,
    licensing: CONTRIBUTING_LICENSING,
  });
  assert.deepEqual(findings, [], findings.join('\n'));
});

test('AC7: an absent licence fails naming both files', () => {
  const findings = licensingFindings({
    licensePath: LICENSE_PATH,
    licenseText: null,
    contributingPath: CONTRIBUTING_PATH,
    licensing: CONTRIBUTING_LICENSING,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /LICENSE and CONTRIBUTING\.md/);
  assert.match(findings[0], /is absent/);
});

test('AC7: an empty licence is a repository stating no terms, and fails naming both files', () => {
  const findings = licensingFindings({
    licensePath: LICENSE_PATH,
    licenseText: '\n\n',
    contributingPath: CONTRIBUTING_PATH,
    licensing: CONTRIBUTING_LICENSING,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /LICENSE and CONTRIBUTING\.md: LICENSE is empty/);
});

test('AC7: terms the licence file does not carry fail naming both files', () => {
  const findings = licensingFindings({
    licensePath: LICENSE_PATH,
    licenseText: LICENSE,
    contributingPath: CONTRIBUTING_PATH,
    licensing: '## Licensing\n\nThe parsers are Apache-2.0 licensed. See LICENSE.\n',
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /LICENSE and CONTRIBUTING\.md: LICENSE is MIT and the Licensing section of CONTRIBUTING\.md does not name MIT/);
});

test('AC7: a Licensing section that never sends a contributor to the file fails naming both', () => {
  const findings = licensingFindings({
    licensePath: LICENSE_PATH,
    licenseText: LICENSE,
    contributingPath: CONTRIBUTING_PATH,
    licensing: '## Licensing\n\nThe parsers are MIT-licensed. Terms are somewhere.\n',
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /does not send a contributor to LICENSE/);
});

test('AC7: a licence this check cannot recognise is refused rather than compared', () => {
  const findings = licensingFindings({
    licensePath: LICENSE_PATH,
    licenseText: 'All rights reserved.\n',
    contributingPath: CONTRIBUTING_PATH,
    licensing: CONTRIBUTING_LICENSING,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /carries no license this check recognises/);
});

test('AC7: a licence with no copyright line names no holder, and fails naming both', () => {
  const stripped = LICENSE.replace(/^Copyright \(c\).*$/m, '');
  const findings = licensingFindings({
    licensePath: LICENSE_PATH,
    licenseText: stripped,
    contributingPath: CONTRIBUTING_PATH,
    licensing: CONTRIBUTING_LICENSING,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /carries no copyright line/);
});

test('AC7: the guide states the terms are per repository, and that this one cannot supply them', () => {
  assert.match(CONTRIBUTING_LICENSING, /Read the\s+`LICENSE` file in the repo you are contributing to/);
  assert.match(CONTRIBUTING_LICENSING, /You cannot\s+create a default license file/);
  assert.match(CONTRIBUTING_LICENSING, /a repo with no `LICENSE` file has stated no terms/);
});

// ---------------------------------------------------------------------------
// AC 8: a repository with its own guide gets none of this, and the docs say so
// ---------------------------------------------------------------------------

test('AC8: the contributing guide states the override limit in the governance section itself', () => {
  assert.match(CONTRIBUTING_GOVERNANCE, /a repo with its own `CONTRIBUTING\.md` gets\s+none of the above/);
  assert.match(CONTRIBUTING_GOVERNANCE, /its governance answer\s+is that repo's to state/);
});

test('AC8: the governance document states the same limit rather than claiming coverage', () => {
  assert.match(GOVERNANCE, /A repository that has its own `CONTRIBUTING\.md`\*\* gets none of this/);
  assert.match(GOVERNANCE, /This document does not claim it/);
});

test('AC8: the README states the limit beside the finding', () => {
  assert.match(README_FINDING, /a repository with its own `CONTRIBUTING\.md` gets none\s*\nof this/);
  assert.match(README_FINDING, /The override is per type/);
  assert.match(README_FINDING, /Thirteen callers is not thirteen repositories covered/);
});

// ---------------------------------------------------------------------------
// The house rule, over the files this work added or edited
// ---------------------------------------------------------------------------

test('neither dash appears in the documents this work added or edited', () => {
  // `scripts/check-no-emdash.mjs` is the gate for U+2014 across the whole tree and it is the one that
  // reds a run. U+2013 is banned by the same directive and is not in that gate's patterns, so it is
  // asserted here, over the files this work owns. Both codepoints are ASSEMBLED rather than escaped:
  // the gate bans the JavaScript escape spelling of U+2014 as a literal, including in this file.
  const dashes = [String.fromCodePoint(0x2014), String.fromCodePoint(0x2013)];
  const owned = [GOVERNANCE_PATH, LICENSE_PATH, CONTRIBUTING_PATH, README_PATH, 'test/governance-surface.test.mjs'];
  for (const path of owned) {
    const text = readTracked(path);
    for (const dash of dashes) {
      assert.ok(!text.includes(dash), `${path} carries U+${dash.codePointAt(0).toString(16)}`);
    }
  }
});
