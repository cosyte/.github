#!/usr/bin/env node
// @ts-check
//
// THE DEFAULT ISSUE TEMPLATES PROMISE A LABEL, AND NOTHING HAS EVER CHECKED THAT THE LABEL IS THERE.
//
// `.github/ISSUE_TEMPLATE/bug_report.yml` sets `labels: ["bug"]` and `feature_request.yml` sets
// `labels: ["enhancement"]`. GitHub renders both into every repository this account owns that has no
// issue templates of its own, and says plainly what that costs: "If an issue template sets a label,
// that label must be created in your `.github` repository and any repositories where the template
// will be used." A repository that never created `bug` renders the form perfectly and files the
// issue UNLABELLED. Nobody is told. The maintainer's only statement about coverage was an
// assumption, and this check replaces it with a measurement.
//
// ---------------------------------------------------------------------------
// WHAT IT READS, WITH WHICH CREDENTIAL
// ---------------------------------------------------------------------------
//
//   the tracked files of `.github/ISSUE_TEMPLATE/`     the labels the defaults declare
//   GET /repos/{owner}/{repo}                          THE ACCOUNT, taken from the run's own
//                                                      repository rather than written down here
//   GET /orgs/{account} or /users/{account}            the account's own repository COUNT, which is
//                                                      what makes a complete listing provable
//   GET /orgs/{account}/repos?type=all      (or)       the owned population, paginated to exhaustion
//   GET /users/{account}/repos?type=owner
//   GET /repos/{o}/{n}/contents/{.github,,docs}        which supported community-health files each
//                                                      repository defines for itself
//   GET /repos/{o}/{n}/labels                          the labels it actually holds, exhaustively
//
// Every one of them is a GET. This check creates no label, opens no issue, writes to no repository
// and takes no credential this repository does not already have: in CI it runs with the workflow's
// automatic `GITHUB_TOKEN` and nothing else.
//
// THE CREDENTIAL'S VISIBILITY IS PART OF THE FINDING, NOT A FOOTNOTE. The automatic token's
// permissions are limited to the repository that contains the workflow, so what it can enumerate of
// another account's repositories is what any anonymous reader can: the PUBLIC ones. That is why the
// account record is read at all. `public_repos` is always there; `owned_private_repos` and
// `total_private_repos` are returned only to a credential the account shows them to. The report
// states which counts it got and therefore which population it proved, so "all thirteen are covered"
// is a sentence about a measured set rather than about every repository that exists.
//
// ---------------------------------------------------------------------------
// THE OVERRIDE IS PER FOLDER AND ALL OR NOTHING, WHICH IS WHY THE LABEL OBLIGATION HANGS OFF ONE READ
// ---------------------------------------------------------------------------
//
// "if a repository defines valid issue templates or issue template configuration in its own
// `.github/ISSUE_TEMPLATE` folder, none of the contents of the default `.github/ISSUE_TEMPLATE`
// folder will be used." So one file in that one folder switches off EVERY default issue template and
// the default `config.yml` together, and no default template renders there, and no label obligation
// can follow from one. Any other supported community-health file a repository defines suppresses the
// default OF ITS OWN TYPE, which the report says, and changes no label obligation.
//
// THE REPOSITORY THIS CHECK RUNS IN IS INSIDE THE POPULATION, NOT OUTSIDE IT. The clause above names
// it first: the label "must be created in your `.github` repository AND any repositories where the
// template will be used". Its `.github/ISSUE_TEMPLATE` folder is the DEFAULTS' OWN folder rather
// than an override of them, so it is classified `default-in-effect` like any other repository the
// templates reach, and the obligation is asserted against it.
//
// ---------------------------------------------------------------------------
// EVERY UNREADABLE INPUT ENDS IN A REFUSAL THAT NAMES THE READ
// ---------------------------------------------------------------------------
//
// A read that does not answer is not a label that is there. Permission denied, rate limited, any
// other non-success status, a transport fault, a body that does not parse, a page walk that cannot
// be finished, a listing shorter than the account's own count, an empty listing, a template that
// cannot be parsed: each fails the run naming what could not be read, and none of them is ever
// reported as coverage. Partial coverage reported as full is the exact defect this closes, so the
// one thing this check will not do is report a number it cannot stand behind.
//
// Exit codes: 0 every declared label is held everywhere it is owed, 1 it is not or something could
// not be read, 2 bad usage.

import { readFileSync, readdirSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** The list reads' page size. 100 is the documented maximum. */
const PER_PAGE = 100;

/**
 * A hard stop on every pagination walk, so a listing that never converges cannot spin forever.
 * Reaching it yields a refusal rather than a truncated answer, which is the fail-closed direction.
 */
const MAX_PAGES = 50;

/** Node's `fetch` has no default request timeout. An unbounded read here would hang the job. */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Where the default issue templates live, relative to this repository's root. */
export const TEMPLATE_DIR = '.github/ISSUE_TEMPLATE';

/**
 * The one file in that folder that is configuration rather than a template.
 *
 * It declares no labels and is not read for them. It is still covered by the folder-level override
 * above: a repository with its own `ISSUE_TEMPLATE` folder gets neither the default templates nor
 * this default configuration.
 */
const TEMPLATE_CONFIG_NAMES = new Set(['config.yml', 'config.yaml']);

/** The three locations GitHub looks in, in the order of precedence the documentation gives. */
export const LOCATIONS = Object.freeze([
  { key: 'github', path: '.github', label: '.github/' },
  { key: 'root', path: '', label: '' },
  { key: 'docs', path: 'docs', label: 'docs/' },
]);

/**
 * The locations of the three types the source says live in exactly one place.
 *
 * "Discussion category forms must be in a folder called `.github/DISCUSSION_TEMPLATE`. Issue
 * templates and their configuration file must be in a folder called `.github/ISSUE_TEMPLATE`. A
 * `FUNDING.yml` file must be in the `.github` folder. All other supported files may be in the root
 * of the repository, the `.github` folder, or the `docs` folder."
 *
 * So the order of precedence above applies to the types that CAN be stored in more than one place,
 * and only to those. A repository keeping an `ISSUE_TEMPLATE` folder at its root keeps a folder
 * GitHub does not read issue templates from: the default still renders there and the label is still
 * owed, and calling that an override would put one row saying `default-in-effect` beside another
 * saying the default is not in effect, in a report whose whole job is to be readable after the fact.
 */
const DOT_GITHUB_ONLY = Object.freeze(['github']);

/**
 * The supported community-health types, from the table in the committed copy of "Creating a default
 * community health file", each with the locations that source reads it from.
 *
 * `GOVERNANCE.md` is deliberately NOT here. A paraphrase of this table in the umbrella's research
 * notes lists it and the live page's table does not, and the committed source is what this check is
 * measured against.
 */
export const SUPPORTED_TYPES = Object.freeze([
  { type: 'code of conduct', names: ['CODE_OF_CONDUCT.md'] },
  { type: 'contributing guide', names: ['CONTRIBUTING.md'] },
  { type: 'discussion category forms', names: ['DISCUSSION_TEMPLATE'], locations: DOT_GITHUB_ONLY },
  { type: 'funding file', names: ['FUNDING.yml'], locations: DOT_GITHUB_ONLY },
  {
    type: 'issue templates and config.yml',
    names: ['ISSUE_TEMPLATE', 'ISSUE_TEMPLATE.md'],
    locations: DOT_GITHUB_ONLY,
  },
  { type: 'pull request template', names: ['PULL_REQUEST_TEMPLATE', 'PULL_REQUEST_TEMPLATE.md'] },
  { type: 'security policy', names: ['SECURITY.md'] },
  { type: 'support file', names: ['SUPPORT.md'] },
]);

/**
 * The one entry that switches off every default issue template, spelled exactly as the source
 * clause spells it. Matched case-sensitively and in `.github` only, because that is the path the
 * clause names; a folder spelled any other way leaves the obligation asserted, which is the
 * direction that cannot hide a missing label.
 */
const OVERRIDING_FOLDER = 'ISSUE_TEMPLATE';

// ---------------------------------------------------------------------------
// The labels the defaults declare
// ---------------------------------------------------------------------------

/** A default issue template this reader could not read. Its file is always named. */
export class TemplateError extends Error {
  /** @param {string} path @param {string} reason */
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.path = path;
    this.reason = reason;
  }
}

/**
 * A line belongs to the top level when nothing indents it.
 *
 * Deliberately a test on the first BYTE rather than on `trimStart()`. JavaScript counts U+FEFF as
 * whitespace, so a byte-order-marked line would trim to look indented by one and hide a key that
 * YAML puts squarely at the top level.
 */
const TOP_LEVEL = (/** @type {string} */ line) => line !== '' && !/^[ \t]/.test(line);

/**
 * The one spelling of the key this reader reads: `labels:` at column zero, then a space, a tab or
 * the end of the line.
 */
const LABELS_KEY = /^labels:( |\t|$)/;

/** The byte order mark, spelled by code point so no editor can lose it out of this file. */
const BOM = String.fromCharCode(0xfeff);

/** Every other spelling of that key folds to this. A stray BOM is stripped so it cannot hide one. */
const FOLD_KEY = (/** @type {string} */ name) => name.split(BOM).join('').trim().toLowerCase();

/**
 * The name a top-level line spells its key with, or `null` when the line begins no key.
 *
 * Only ever used to ask "is this line a `labels` key this reader cannot read?", so it recognises the
 * spellings YAML allows and stops there: an explicit key (`? labels`), a quoted key (`"labels":`),
 * and the plain form, whose name is everything before the first colon and therefore also catches
 * `labels :` and `LABELS:`.
 *
 * @param {string} line
 * @returns {string | null}
 */
function topLevelKey(line) {
  const explicit = /^\?(?:\s+(.*))?$/.exec(line.trimEnd());
  const text = explicit ? (explicit[1] ?? '').trim() : line;
  const quoted = /^(['"])(.*?)\1\s*:(\s|$)/.exec(text);
  if (quoted) return quoted[2];
  if (explicit) return text;
  const colon = text.indexOf(':');
  return colon === -1 ? null : text.slice(0, colon);
}

/**
 * Unquote one scalar out of a `labels:` value, or refuse.
 *
 * NARROW ON PURPOSE, in the style of `scripts/reference-publish.mjs`. This repository ships no YAML
 * parser and has no `package.json` to add one to, so the reader recognises the shapes an issue form
 * actually uses and REFUSES on anything else. A permissive reader is the one that can quietly read a
 * declared label as absent, and an absent label is an obligation this check would then never assert.
 *
 * @param {string} raw
 * @param {string} path
 * @returns {string}
 */
function scalarValue(raw, path) {
  const text = raw.trim();
  if (text === '') throw new TemplateError(path, 'an empty entry in `labels:` is not a label');
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    if (text.length < 2 || text[text.length - 1] !== quote) {
      throw new TemplateError(path, `the entry ${JSON.stringify(text)} in \`labels:\` is not closed`);
    }
    const inner = text.slice(1, -1);
    if (inner.includes(quote) || inner.includes('\\')) {
      throw new TemplateError(
        path,
        `the entry ${JSON.stringify(text)} in \`labels:\` uses a quoting form this reader does not read`,
      );
    }
    if (inner.trim() === '') throw new TemplateError(path, 'an empty entry in `labels:` is not a label');
    return inner;
  }
  if (/[:#[\]{},]/.test(text)) {
    throw new TemplateError(path, `the entry ${JSON.stringify(text)} in \`labels:\` is not a plain string`);
  }
  return text;
}

/**
 * The labels one default issue template declares, or a refusal naming the file.
 *
 * Reads a TOP LEVEL `labels:` key, which is where an issue form declares them, in either of the two
 * spellings a form uses: a flow sequence on one line (`labels: ["bug"]`) or a block sequence under
 * it. Column zero is what makes that safe to find without a parser: every other `labels`-shaped
 * string in one of these files sits inside `body:`, indented, and a block scalar's content is
 * indented too.
 *
 * A scalar (`labels: bug`), a mapping, an unreadable quoting form, a second top-level `labels:` key
 * and a tab in the indentation are each a refusal rather than a reading, because "this template
 * declares no labels" is the one wrong answer that turns into a green run over an unmeasured
 * obligation.
 *
 * THAT REFUSAL COVERS THE KEY AND NOT ONLY ITS VALUE. `[]` is returned for one reason: no top-level
 * `labels` key is there at all. A line that IS such a key in a spelling this reader does not read is
 * refused naming the file, never answered `[]`, because `[]` means "no obligation" and a wrong "no
 * obligation" is a green run over a promise nobody measured. Two spellings YAML's own grammar allows
 * are read rather than refused, because they say exactly what the plain spelling says: CRLF (and
 * lone-CR) line breaks, and a byte order mark opening the stream.
 *
 * @param {string} path the template's path, for the refusal
 * @param {string} text its contents
 * @returns {string[]}
 */
export function declaredLabels(path, text) {
  // YAML 1.2 breaks a line on CRLF, on a lone CR and on LF alike, and permits a BOM to open a
  // stream. Splitting on LF alone left `labels:\r` unmatched by the key test below, and a BOM left
  // the first key unmatched: both read as "declares no labels" while GitHub read a real label.
  const stream = String(text);
  const lines = (stream.startsWith(BOM) ? stream.slice(BOM.length) : stream).split(/\r\n|\r|\n/);
  const opens = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (LABELS_KEY.test(line)) {
      opens.push(i);
      continue;
    }
    if (!TOP_LEVEL(line)) continue;
    const key = topLevelKey(line);
    if (key !== null && FOLD_KEY(key) === 'labels') {
      throw new TemplateError(
        path,
        `spells its top-level labels key as ${JSON.stringify(line.trim())}, which this reader does not read`,
      );
    }
    if (/^[[{]/.test(line)) {
      throw new TemplateError(
        path,
        'opens a flow collection at the document root, so a `labels:` key inside it is one this reader does not read',
      );
    }
  }
  if (opens.length === 0) return [];
  if (opens.length > 1) {
    throw new TemplateError(path, 'declares `labels:` more than once at the top level');
  }

  const at = opens[0];
  const after = lines[at].slice('labels:'.length);
  if (after.includes('\t')) throw new TemplateError(path, 'uses a tab in `labels:`, which YAML does not allow');
  const inline = after.replace(/\s+#.*$/, '').trim();

  if (inline !== '') {
    if (inline.startsWith('{')) throw new TemplateError(path, '`labels:` is a mapping, not a list of strings');
    if (!inline.startsWith('[')) {
      throw new TemplateError(path, `\`labels:\` is the scalar ${JSON.stringify(inline)}, not a list of strings`);
    }
    if (!inline.endsWith(']')) {
      throw new TemplateError(path, '`labels:` opens a flow sequence this reader cannot see the end of');
    }
    const body = inline.slice(1, -1);
    if (/[[\]{}]/.test(body)) {
      throw new TemplateError(path, '`labels:` nests a collection, so it is not a list of strings');
    }
    if (body.trim() === '') return [];
    return body.split(',').map((entry) => scalarValue(entry, path));
  }

  // A block sequence. Everything indented under the key belongs to it, and every one of those lines
  // has to be a `- <scalar>` item: a nested mapping there is not a list of strings.
  /** @type {string[]} */
  const labels = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (TOP_LEVEL(line)) break;
    if (line.includes('\t')) throw new TemplateError(path, 'uses a tab in `labels:`, which YAML does not allow');
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item === null) {
      throw new TemplateError(path, `\`labels:\` carries ${JSON.stringify(line.trim())}, which is not a list item`);
    }
    labels.push(scalarValue(item[1].replace(/\s+#.*$/, ''), path));
  }
  if (labels.length === 0) {
    throw new TemplateError(path, '`labels:` is present with no value, which is neither a list nor absent');
  }
  return labels;
}

/**
 * Every default issue template, with the labels it declares, or a refusal naming the first file that
 * could not be read.
 *
 * `config.yml` is skipped for labels because it is the templates' configuration and declares none.
 * It is not skipped by the override rule above: the folder covers it too.
 *
 * @param {{name: string, text: string}[]} files
 * @returns {{templates: {path: string, labels: string[]}[], labels: {label: string, templates: string[]}[]}}
 */
export function readDefaultTemplates(files) {
  /** @type {{path: string, labels: string[]}[]} */
  const templates = [];
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${TEMPLATE_DIR}/${file.name}`;
    if (TEMPLATE_CONFIG_NAMES.has(file.name.toLowerCase())) {
      templates.push({ path, labels: [] });
      continue;
    }
    if (!/\.ya?ml$/i.test(file.name)) {
      // A markdown issue template declares its labels in front matter, in a different grammar this
      // reader does not read. Refusing names it; skipping it would leave its labels unmeasured while
      // the run went green, which is the failure this whole check exists to end.
      throw new TemplateError(path, 'is not a YAML issue form, and this reader reads no other template grammar');
    }
    templates.push({ path, labels: declaredLabels(path, file.text) });
  }

  /** @type {Map<string, string[]>} */
  const byLabel = new Map();
  for (const template of templates) {
    for (const label of template.labels) {
      if (!byLabel.has(label)) byLabel.set(label, []);
      const seen = byLabel.get(label);
      if (seen && !seen.includes(template.path)) seen.push(template.path);
    }
  }
  const labels = [...byLabel.entries()]
    .map(([label, paths]) => ({ label, templates: paths }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { templates, labels };
}

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

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

/** A read that did not answer, in the classes the contract distinguishes. */
export class ReadFailure extends Error {
  /**
   * @param {'permission'|'rate-limit'|'transport'|'unparseable'|'other'} kind
   * @param {string} read the URL path, so the refusal names the read
   * @param {string} detail
   * @param {string|null} repository
   */
  constructor(kind, read, detail, repository = null) {
    super(detail);
    this.kind = kind;
    this.read = read;
    this.detail = detail;
    this.repository = repository;
  }
}

/**
 * One GET, classified rather than thrown. A thrown fetch is a transport fault and not an answer, and
 * `0` is not a real HTTP status, which is what it is used for here.
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
        'user-agent': 'cosyte-org-defaults-coverage',
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
    const header = (/** @type {string} */ name) =>
      typeof res?.headers?.get === 'function' ? res.headers.get(name) : null;
    const rateLimited =
      header('x-ratelimit-remaining') === '0' ||
      header('retry-after') !== null ||
      /\brate limit\b/i.test(String(body?.message ?? ''));
    return { status: Number(res?.status ?? 0), body, parsed, rateLimited, error: null };
  } catch (error) {
    return {
      status: 0,
      body: null,
      parsed: false,
      rateLimited: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * @param {string} read
 * @param {{status: number, error: string|null, parsed: boolean, rateLimited: boolean}} answer
 * @param {string|null} repository
 */
function readFailure(read, answer, repository = null) {
  if (answer.status === 0) {
    return new ReadFailure('transport', read, `${read} could not be reached: ${answer.error}`, repository);
  }
  if (answer.status === 429 || ((answer.status === 403 || answer.status === 401) && answer.rateLimited)) {
    return new ReadFailure(
      'rate-limit',
      read,
      `${read} answered HTTP ${answer.status} with this credential's rate limit exhausted`,
      repository,
    );
  }
  if (answer.status === 401 || answer.status === 403) {
    return new ReadFailure('permission', read, `${read} answered HTTP ${answer.status}`, repository);
  }
  if (answer.status !== 200) {
    return new ReadFailure('other', read, `${read} answered HTTP ${answer.status}`, repository);
  }
  return new ReadFailure(
    'unparseable',
    read,
    `${read} answered HTTP 200 with a body that does not parse as JSON`,
    repository,
  );
}

/**
 * Walk a list endpoint that answers with a bare array, to EXHAUSTION.
 *
 * Termination is a short page, with `MAX_PAGES` as a backstop that yields a read failure rather than
 * a truncated answer. Truncation is not a smaller answer here, it is a WRONG one: a label sitting on
 * page two would be reported as missing from a repository that holds it, and a repository sitting on
 * page two of the listing would never be measured at all.
 *
 * @param {{base: string, path: string, query?: string, fetchImpl: any, token: string, repository?: string|null}} input
 * @returns {Promise<{items: any[], pages: number}>}
 */
async function listAll({ base, path, query = '', fetchImpl, token, repository = null }) {
  /** @type {any[]} */
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const read = `${path}?${query ? `${query}&` : ''}per_page=${PER_PAGE}&page=${page}`;
    const answer = await get(`${base}${read}`, fetchImpl, token);
    if (answer.status !== 200 || !answer.parsed) throw readFailure(read, answer, repository);
    if (!Array.isArray(answer.body)) {
      throw new ReadFailure(
        'unparseable',
        read,
        `${read} answered HTTP 200 with a body that is not the list of items this read expects`,
        repository,
      );
    }
    items.push(...answer.body);
    if (answer.body.length < PER_PAGE) return { items, pages: page };
  }
  throw new ReadFailure(
    'other',
    path,
    `${path} did not finish paginating within ${MAX_PAGES} pages of ${PER_PAGE}; refusing to treat a ` +
      'truncated list as a complete one',
    repository,
  );
}

/**
 * One directory listing from the contents API.
 *
 * A 404 is the ABSENCE of that folder and is an answer, not a failure: an empty repository and a
 * repository with no `.github/` both give one, and both mean the same thing here. A 200 whose body
 * is not an array means the path is not a folder at all, which this check cannot classify either
 * way, so it refuses rather than guessing in the direction that waives an obligation.
 *
 * @param {{base: string, repository: string, path: string, fetchImpl: any, token: string}} input
 * @returns {Promise<{name: string, type: string}[]|null>}
 */
async function readDirectory({ base, repository, path, fetchImpl, token }) {
  const read = `/repos/${repository}/contents/${path}`;
  const answer = await get(`${base}${read}`, fetchImpl, token);
  if (answer.status === 404) return null;
  if (answer.status !== 200 || !answer.parsed) throw readFailure(read, answer, repository);
  if (!Array.isArray(answer.body)) {
    throw new ReadFailure(
      'unparseable',
      read,
      `${read} answered HTTP 200 with a file rather than a folder listing, so what is at that path ` +
        'cannot be classified',
      repository,
    );
  }
  return answer.body.map((entry) => ({ name: String(entry?.name ?? ''), type: String(entry?.type ?? '') }));
}

// ---------------------------------------------------------------------------
// Classification, pure
// ---------------------------------------------------------------------------

/**
 * Every supported community-health file a repository defines for itself, with the path that defines
 * it, in the documented order of precedence.
 *
 * A type is looked for only where the source says GitHub reads it from. The order of precedence is
 * introduced as being "for supported files that can be stored in more than one location", and three
 * of these types cannot: a `FUNDING.yml` at the root, or an `ISSUE_TEMPLATE` folder there, overrides
 * nothing, so it is not reported as overriding anything.
 *
 * @param {Record<string, {name: string, type: string}[]|null>} entries by location key
 * @returns {{type: string, path: string}[]}
 */
export function overridesOf(entries) {
  /** @type {{type: string, path: string}[]} */
  const found = [];
  for (const supported of SUPPORTED_TYPES) {
    for (const location of LOCATIONS) {
      if (supported.locations && !supported.locations.includes(location.key)) continue;
      const listing = entries?.[location.key];
      if (!Array.isArray(listing)) continue;
      const hit = listing.find((entry) =>
        supported.names.some((name) => name.toLowerCase() === String(entry.name).toLowerCase()),
      );
      if (hit) {
        found.push({ type: supported.type, path: `${location.label}${hit.name}` });
        break; // The first location that has it is the one GitHub uses. Precedence, applied.
      }
    }
  }
  return found;
}

/**
 * Whether this repository's own `.github/ISSUE_TEMPLATE` folder switches the default issue templates
 * off there, and the path that does it.
 *
 * A directory entry is enough. Git cannot represent an empty directory, so a folder that is listed
 * holds at least one file, which is exactly the condition the source clause states.
 *
 * @param {Record<string, {name: string, type: string}[]|null>} entries
 * @returns {string|null} the overriding path, or null
 */
export function issueTemplateOverride(entries) {
  const listing = entries?.github;
  if (!Array.isArray(listing)) return null;
  const hit = listing.find((entry) => entry.name === OVERRIDING_FOLDER && entry.type === 'dir');
  return hit ? `.github/${OVERRIDING_FOLDER}` : null;
}

/** A label name compared the way a near miss is defined: case folded, surrounding space removed. */
export const foldLabel = (/** @type {string} */ name) => String(name).trim().toLowerCase();

/**
 * The whole decision, over what the reads saw. PURE: the same measurement always yields the same
 * report, and every branch below is reachable from a fixture.
 *
 * @param {any} measurement
 * @returns {{report: any, failing: boolean}}
 */
export function decide(measurement) {
  const declared = measurement.declaredLabels ?? [];

  /** @type {any} */
  const report = {
    account: measurement.account,
    defaultsRepository: measurement.repository,
    population: measurement.population ?? null,
    templates: measurement.templates ?? [],
    declaredLabels: declared,
    repositories: [],
    coverage: [],
    nearMisses: [],
    unreadable: (measurement.failures ?? []).map((failure) => ({
      repository: failure.repository,
      read: failure.read,
      kind: failure.kind,
      reason: failure.detail,
    })),
    outcome: 'covered',
    failing: false,
    summary: '',
  };

  // 1. A template this check could not read. Nothing downstream of it means anything: the set of
  //    obligations is exactly what those files declare.
  if (measurement.templateFailure) {
    report.outcome = 'unreadable-template';
    report.failing = true;
    report.templateFailure = measurement.templateFailure;
    report.summary =
      `Refusing to report coverage: the default issue template ${measurement.templateFailure.path} could not ` +
      `be read (${measurement.templateFailure.reason}). A template whose labels cannot be read is not a ` +
      'template that declares none.';
    return { report, failing: true };
  }

  // 2. A read the whole measurement stands on: the run's repository, the account record, or the
  //    listing itself. There is no subset to report over.
  const structural = report.unreadable.filter((entry) => entry.repository === null);
  if (structural.length > 0) {
    report.outcome = 'unreadable';
    report.failing = true;
    report.summary =
      'Refusing to report coverage: a read this measurement stands on did not answer. ' +
      structural.map((entry) => entry.reason).join('; ') + '.';
    return { report, failing: true };
  }

  // 3. The listing has to be provably the account's whole owned population before any statement
  //    about "every repository" can be made over it.
  const population = measurement.population;
  if (population && population.reported !== null && population.listed < population.reported) {
    report.outcome = 'incomplete-enumeration';
    report.failing = true;
    report.summary =
      `Refusing to report coverage: ${measurement.account.login} reports ${population.reported} owned ` +
      `repositories and the listing returned ${population.listed}, so ${population.reported - population.listed} ` +
      'were never measured. Coverage over the subset that was read is not coverage.';
    return { report, failing: true };
  }
  if (population && population.listed === 0) {
    report.outcome = 'empty-enumeration';
    report.failing = true;
    report.summary =
      `Refusing to report coverage: the listing of ${measurement.account.login}'s repositories returned none. ` +
      'Full coverage over an empty population is a statement about nothing.';
    return { report, failing: true };
  }

  // 4. Classify every enumerated repository, then measure the obligation against the ones the
  //    defaults actually reach.
  const unreadableRepositories = new Set(
    report.unreadable.filter((entry) => entry.repository !== null).map((entry) => entry.repository),
  );

  /** @type {Map<string, string[]>} */
  const holders = new Map();
  for (const observation of measurement.observations ?? []) {
    const isDefaults = observation.name.toLowerCase() === String(measurement.repository).toLowerCase();
    if (unreadableRepositories.has(observation.name)) {
      report.repositories.push({ name: observation.name, state: 'unreadable', overrides: [], defaults: isDefaults });
      continue;
    }
    const overrides = overridesOf(observation.entries ?? {});
    // The defaults repository's own community-health files ARE the defaults. Reading them as an
    // override of themselves would waive the one obligation the source clause names outright.
    const overriddenBy = isDefaults ? null : issueTemplateOverride(observation.entries ?? {});
    const entry = {
      name: observation.name,
      state: overriddenBy ? 'overridden' : 'default-in-effect',
      overriddenBy,
      overrides: isDefaults ? [] : overrides,
      defaults: isDefaults,
      labels: observation.labels ?? null,
    };
    report.repositories.push(entry);
    if (entry.state === 'default-in-effect' && Array.isArray(observation.labels)) {
      holders.set(observation.name, observation.labels);
    }
  }
  report.repositories.sort((a, b) => a.name.localeCompare(b.name));

  // 5. No declared label is not full coverage, it is no obligation. Said as itself.
  if (declared.length === 0) {
    report.outcome = 'no-label-obligation';
    report.failing = unreadableRepositories.size > 0;
    report.summary =
      `No default issue template declares a label, so there is no label obligation to measure across ` +
      `${report.repositories.length} enumerated repositor${report.repositories.length === 1 ? 'y' : 'ies'}. ` +
      'That is not the same statement as every repository being covered.';
    if (report.failing) {
      report.outcome = 'unreadable';
      report.summary +=
        ` ${unreadableRepositories.size} repositor${unreadableRepositories.size === 1 ? 'y' : 'ies'} could ` +
        'not be read, and an unread repository is classified as neither covered nor overridden.';
    }
    return { report, failing: report.failing };
  }

  // A repository the obligation applies to whose labels were never read. It is not covered and it is
  // not overridden: it is unread, and it is reported as one. Settled ONCE, before the first label is
  // measured, so every label in one report is measured over the same population: reclassifying
  // mid-loop would leave an earlier label counting a repository the later ones no longer count, and
  // two `required` totals over one population make a report nobody can reconstruct a finding from.
  for (const entry of report.repositories) {
    if (entry.state !== 'default-in-effect' || Array.isArray(holders.get(entry.name))) continue;
    report.unreadable.push({
      repository: entry.name,
      read: `/repos/${entry.name}/labels`,
      kind: 'other',
      reason: `the labels of ${entry.name} were never read, so its obligation cannot be measured`,
    });
    unreadableRepositories.add(entry.name);
    entry.state = 'unreadable';
  }

  const obligated = report.repositories.filter((entry) => entry.state === 'default-in-effect');
  for (const declaration of declared) {
    /** @type {string[]} */
    const missing = [];
    /** @type {string[]} */
    const held = [];
    for (const entry of obligated) {
      const labels = holders.get(entry.name);
      // Unreachable after the pass above, which moved every unread repository out of `obligated`.
      // Kept so a later edit cannot quietly count an unread repository as one holding the label.
      if (!Array.isArray(labels)) continue;
      const exact = labels.some((name) => name === declaration.label);
      if (exact) {
        held.push(entry.name);
        continue;
      }
      const near = labels.filter((name) => foldLabel(name) === foldLabel(declaration.label));
      for (const spelling of near) {
        report.nearMisses.push({ repository: entry.name, declared: declaration.label, found: spelling });
      }
      missing.push(entry.name);
    }
    report.coverage.push({
      label: declaration.label,
      declaredBy: declaration.templates,
      required: held.length + missing.length,
      holding: held.length,
      missing: missing.sort((a, b) => a.localeCompare(b)),
    });
  }

  const uncovered = report.coverage.filter((entry) => entry.missing.length > 0);
  const stillUnreadable = report.repositories.filter((entry) => entry.state === 'unreadable');
  report.failing = uncovered.length > 0 || stillUnreadable.length > 0;
  const measured = report.repositories.length;
  const inEffect = report.repositories.filter((entry) => entry.state === 'default-in-effect').length;
  const overridden = report.repositories.filter((entry) => entry.state === 'overridden').length;
  const scope = `${measured} enumerated, ${inEffect} rendering the defaults, ${overridden} overridden`;

  if (!report.failing) {
    report.outcome = 'covered';
    report.summary =
      `Every label the default issue templates declare (${declared.map((entry) => entry.label).join(', ')}) ` +
      `exists in every repository that renders them: ${scope}. Measured, not assumed.`;
    return { report, failing: false };
  }

  report.outcome = stillUnreadable.length > 0 && uncovered.length === 0 ? 'unreadable' : 'uncovered';
  const parts = [];
  for (const entry of uncovered) {
    parts.push(`\`${entry.label}\` is missing from ${entry.missing.join(', ')}`);
  }
  if (stillUnreadable.length > 0) {
    parts.push(`${stillUnreadable.map((entry) => entry.name).join(', ')} could not be read`);
  }
  report.summary =
    `The default issue templates promise labels this account does not everywhere hold (${scope}): ` +
    `${parts.join('; ')}. An issue filed from a default template in one of those repositories is ` +
    'filed unlabelled.';
  return { report, failing: true };
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

/**
 * Perform every read and return what was seen. Does no fs work and no deciding: the fetch is
 * injected, so a fixture drives every branch, and `decide` above turns the observations into the
 * finding.
 *
 * @param {{
 *   repository: string,
 *   templateFiles: {name: string, text: string}[],
 *   templateFailure?: {path: string, reason: string}|null,
 *   apiBase?: string,
 *   token?: string,
 *   fetchImpl?: any,
 *   fetchTimeoutMs?: number,
 * }} options
 */
export async function measure({
  repository,
  templateFiles,
  templateFailure = null,
  apiBase = 'https://api.github.com',
  token = '',
  fetchImpl = globalThis.fetch,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
}) {
  const base = String(apiBase).replace(/\/+$/, '');
  const fetcher = withFetchTimeout(fetchImpl, fetchTimeoutMs);

  /** @type {any} */
  const measurement = {
    repository,
    account: null,
    population: null,
    templates: [],
    declaredLabels: [],
    templateFailure,
    observations: [],
    failures: [],
  };

  if (!templateFailure) {
    try {
      const read = readDefaultTemplates(templateFiles);
      measurement.templates = read.templates;
      measurement.declaredLabels = read.labels;
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      measurement.templateFailure = { path: error.path, reason: error.reason };
      return measurement;
    }
  } else {
    return measurement;
  }

  /** @param {unknown} error */
  const record = (error) => {
    if (!(error instanceof ReadFailure)) throw error;
    measurement.failures.push({
      repository: error.repository,
      read: error.read,
      kind: error.kind,
      detail: error.detail,
    });
  };

  // THE ACCOUNT COMES FROM THE RUN'S OWN REPOSITORY, never from a name written down here, so the
  // same check under a different account measures that account.
  try {
    const read = `/repos/${repository}`;
    const answer = await get(`${base}${read}`, fetcher, token);
    if (answer.status !== 200 || !answer.parsed) throw readFailure(read, answer);
    const login = String(answer.body?.owner?.login ?? '');
    const type = String(answer.body?.owner?.type ?? '');
    if (!login) {
      throw new ReadFailure('unparseable', read, `${read} answered HTTP 200 with no \`owner.login\``);
    }
    measurement.account = { login, type: type || 'Organization' };
  } catch (error) {
    record(error);
    return measurement;
  }

  const isOrg = measurement.account.type !== 'User';
  const accountRead = isOrg ? `/orgs/${measurement.account.login}` : `/users/${measurement.account.login}`;

  /** @type {{reported: number|null, publicRepos: number|null, privateRepos: number|null, source: string}} */
  let counts = { reported: null, publicRepos: null, privateRepos: null, source: accountRead };
  try {
    const answer = await get(`${base}${accountRead}`, fetcher, token);
    if (answer.status !== 200 || !answer.parsed) throw readFailure(accountRead, answer);
    const publicRepos = Number.isInteger(answer.body?.public_repos) ? answer.body.public_repos : null;
    if (publicRepos === null) {
      throw new ReadFailure(
        'unparseable',
        accountRead,
        `${accountRead} answered HTTP 200 with no \`public_repos\`, so the listing cannot be shown to be complete`,
      );
    }
    const owned = Number.isInteger(answer.body?.owned_private_repos)
      ? answer.body.owned_private_repos
      : Number.isInteger(answer.body?.total_private_repos)
        ? answer.body.total_private_repos
        : null;
    counts = {
      reported: publicRepos + (owned ?? 0),
      publicRepos,
      privateRepos: owned,
      source: accountRead,
    };
  } catch (error) {
    record(error);
    return measurement;
  }

  /** @type {{name: string, full_name: string}[]} */
  let listed = [];
  let pages = 0;
  const listPath = isOrg ? `/orgs/${measurement.account.login}/repos` : `/users/${measurement.account.login}/repos`;
  const listQuery = isOrg ? 'type=all' : 'type=owner';
  try {
    const walked = await listAll({ base, path: listPath, query: listQuery, fetchImpl: fetcher, token });
    listed = walked.items;
    pages = walked.pages;
  } catch (error) {
    record(error);
    return measurement;
  }

  const names = listed
    .map((entry) => String(entry?.full_name ?? ''))
    .filter((name) => name.includes('/'))
    .sort((a, b) => a.localeCompare(b));

  measurement.population = {
    endpoint: `${listPath}?${listQuery}`,
    pages,
    listed: names.length,
    reported: counts.reported,
    publicRepos: counts.publicRepos,
    privateRepos: counts.privateRepos,
    countedFrom: counts.source,
  };

  if (counts.reported !== null && names.length < counts.reported) return measurement;
  if (names.length === 0) return measurement;

  const obligationExists = measurement.declaredLabels.length > 0;

  for (const name of names) {
    /** @type {Record<string, {name: string, type: string}[]|null>} */
    const entries = {};
    let readable = true;
    for (const location of LOCATIONS) {
      try {
        entries[location.key] = await readDirectory({
          base,
          repository: name,
          path: location.path,
          fetchImpl: fetcher,
          token,
        });
      } catch (error) {
        record(error);
        readable = false;
        break;
      }
    }
    if (!readable) {
      measurement.observations.push({ name, entries: null, labels: null });
      continue;
    }

    const isDefaults = name.toLowerCase() === String(repository).toLowerCase();
    const overridden = isDefaults ? null : issueTemplateOverride(entries);
    /** @type {string[]|null} */
    let labels = null;
    if (obligationExists && !overridden) {
      try {
        const walked = await listAll({
          base,
          path: `/repos/${name}/labels`,
          fetchImpl: fetcher,
          token,
          repository: name,
        });
        labels = walked.items.map((entry) => String(entry?.name ?? ''));
      } catch (error) {
        record(error);
        measurement.observations.push({ name, entries: null, labels: null });
        continue;
      }
    }
    measurement.observations.push({ name, entries, labels });
  }

  return measurement;
}

/** Measure, then decide. The whole check, with the fetch still injected. */
export async function checkCoverage(options) {
  return decide(await measure(options));
}

// ---------------------------------------------------------------------------
// The report, which is this check's product rather than a log line
// ---------------------------------------------------------------------------

/**
 * The measurement, written so the finding can be reconstructed from it without running the check
 * again: every repository with its state, every declared label, and per label every repository that
 * does not hold it.
 *
 * Markdown, because it is appended to the run's job summary, where a maintainer reads it after the
 * fact. It carries nothing but the public facts it measured.
 *
 * @param {any} report
 * @returns {string}
 */
export function renderReport(report) {
  const lines = [];
  lines.push('## Org default issue templates: measured coverage');
  lines.push('');
  lines.push(`- outcome: \`${report.outcome}\``);
  lines.push(`- account: \`${report.account?.login ?? 'unknown'}\` (${report.account?.type ?? 'unknown'})`);
  lines.push(`- defaults repository: \`${report.defaultsRepository}\``);
  lines.push('');
  lines.push(report.summary);
  lines.push('');

  if (report.templateFailure) {
    lines.push('### The template that could not be read');
    lines.push('');
    lines.push(`- \`${report.templateFailure.path}\`: ${report.templateFailure.reason}`);
    lines.push('');
  }

  lines.push('### The labels the defaults declare');
  lines.push('');
  if (report.declaredLabels.length === 0) {
    lines.push('None. No default issue template declares a label, so no label obligation follows from them.');
  } else {
    for (const entry of report.declaredLabels) {
      lines.push(`- \`${entry.label}\`, declared by ${entry.templates.map((path) => `\`${path}\``).join(', ')}`);
    }
  }
  lines.push('');

  if (report.population) {
    lines.push('### The population, and what proves it complete');
    lines.push('');
    lines.push(`- listing: \`${report.population.endpoint}\`, ${report.population.pages} page(s) walked to exhaustion`);
    lines.push(`- repositories listed: ${report.population.listed}`);
    lines.push(
      `- the account's own record (\`${report.population.countedFrom}\`) reports ` +
        `${report.population.publicRepos ?? 'no'} public` +
        (report.population.privateRepos === null
          ? ' and no private repository count at all, which is what this credential is shown'
          : ` and ${report.population.privateRepos} private`) +
        ' repositories',
    );
    if (report.population.privateRepos === null) {
      lines.push(
        '- so the population proved complete here is the account\'s PUBLIC repositories. A private ' +
          'repository this credential cannot see is outside this measurement, and that is stated ' +
          'rather than assumed.',
      );
    }
    lines.push('');
  }

  if (report.repositories.length > 0) {
    lines.push('### Every repository enumerated, with its state');
    lines.push('');
    lines.push('| repository | state | what decides it |');
    lines.push('|---|---|---|');
    for (const entry of report.repositories) {
      const why = entry.defaults
        ? 'holds the defaults; the label must exist here too'
        : entry.state === 'overridden'
          ? `overridden by \`${entry.overriddenBy}\``
          : entry.state === 'unreadable'
            ? 'a read did not answer; see below'
            : 'no issue templates of its own';
      lines.push(`| \`${entry.name}\` | ${entry.state} | ${why} |`);
    }
    lines.push('');

    const otherOverrides = report.repositories.filter((entry) => (entry.overrides ?? []).length > 0);
    if (otherOverrides.length > 0) {
      lines.push('### Defaults not in effect, by repository and type');
      lines.push('');
      for (const entry of otherOverrides) {
        const list = entry.overrides.map((item) => `${item.type} (\`${item.path}\`)`).join(', ');
        lines.push(`- \`${entry.name}\` defines its own ${list}, so the default of each is not in effect there`);
      }
      lines.push('');
    }
  }

  if (report.coverage.length > 0) {
    lines.push('### Coverage measured, per label');
    lines.push('');
    lines.push('| label | required in | holding it | missing from |');
    lines.push('|---|---|---|---|');
    for (const entry of report.coverage) {
      const missing = entry.missing.length === 0 ? 'none' : entry.missing.map((name) => `\`${name}\``).join(', ');
      lines.push(`| \`${entry.label}\` | ${entry.required} | ${entry.holding} | ${missing} |`);
    }
    lines.push('');
  }

  if (report.nearMisses.length > 0) {
    lines.push('### Near misses, which do not satisfy the obligation');
    lines.push('');
    for (const entry of report.nearMisses) {
      lines.push(
        `- \`${entry.repository}\` holds ${JSON.stringify(entry.found)} where the template declares ` +
          `${JSON.stringify(entry.declared)}. GitHub applies the label the template names, so this is a ` +
          'missing label with a lookalike beside it.',
      );
    }
    lines.push('');
  }

  if (report.unreadable.length > 0) {
    lines.push('### Reads that did not answer');
    lines.push('');
    for (const entry of report.unreadable) {
      lines.push(`- ${entry.repository ? `\`${entry.repository}\`: ` : ''}${entry.reason} (${entry.kind})`);
    }
    lines.push('');
    lines.push('None of the above is classified as covered or as overridden. A read that does not answer is not');
    lines.push('a label that is there.');
    lines.push('');
  }

  lines.push('### What this proves, and what it does not');
  lines.push('');
  lines.push('It proves each declared label EXISTS where a default template can apply it. It proves nothing');
  lines.push('about triage: not that the label is used, watched, or means anything to anyone.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  'usage:\n' +
  '  org-defaults-coverage.mjs [--repository <owner/name>] [--api <base>] [--templates <dir>]\n' +
  '                            [--report <path>]\n' +
  '  GITHUB_REPOSITORY, GITHUB_API_URL, GH_TOKEN (or GITHUB_TOKEN) and GITHUB_STEP_SUMMARY are read\n' +
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
 * The default issue templates off disk.
 *
 * An absent folder is an answer: this account publishes no default issue templates, so no label
 * obligation follows from any. Anything else that goes wrong reading it is a refusal naming the
 * path, including an entry in there that is not a regular file, which is not a template and which
 * this reader will not silently skip.
 *
 * @param {string} dir
 * @returns {{files: {name: string, text: string}[], failure: {path: string, reason: string}|null}}
 */
export function readTemplateDirectory(dir) {
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { files: [], failure: null };
    }
    return {
      files: [],
      failure: { path: TEMPLATE_DIR, reason: `could not be listed: ${error instanceof Error ? error.message : error}` },
    };
  }
  /** @type {{name: string, text: string}[]} */
  const files = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) {
        return {
          files: [],
          failure: { path: `${TEMPLATE_DIR}/${name}`, reason: 'is not a regular file, so it is not a template' },
        };
      }
      files.push({ name, text: readFileSync(path, 'utf8') });
    } catch (error) {
      return {
        files: [],
        failure: {
          path: `${TEMPLATE_DIR}/${name}`,
          reason: `could not be read: ${error instanceof Error ? error.message : error}`,
        },
      };
    }
  }
  return { files, failure: null };
}

/**
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   fetchImpl?: any,
 *   stdout?: (s: string) => void,
 *   stderr?: (s: string) => void,
 *   repoRoot?: string,
 * }} io
 */
export async function main(argv, { env = process.env, fetchImpl = globalThis.fetch, stdout, stderr, repoRoot } = {}) {
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

  const root = repoRoot ?? fileURLToPath(new URL('..', import.meta.url));
  const templateDir = options.templates || join(root, TEMPLATE_DIR);
  const templates = readTemplateDirectory(templateDir);

  const { report, failing } = await checkCoverage({
    repository,
    templateFiles: templates.files,
    templateFailure: templates.failure,
    apiBase: options.api || env.GITHUB_API_URL || 'https://api.github.com',
    // `GH_TOKEN` first, matching `scripts/environment-gate.mjs`: in a workflow this is the automatic
    // token and nothing else, and both spellings are accepted so the check is runnable by hand.
    token: env.GH_TOKEN || env.GITHUB_TOKEN || '',
    fetchImpl,
  });

  const rendered = renderReport(report);
  out(`${rendered}\n`);

  // THE REPORT IS WRITTEN BEFORE THE EXIT STATUS IS RETURNED, and that ordering is the whole of how
  // it survives a failing run. A step that runs after a failed one does not run, so a report
  // published by a later step would be published exactly when it is not there to be read.
  if (options.report) {
    try {
      writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      err(`the report could not be written to ${options.report}: ${error instanceof Error ? error.message : error}\n`);
      return 1;
    }
  }
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${rendered}\n`);
    } catch (error) {
      err(`the report could not be appended to the job summary: ${error instanceof Error ? error.message : error}\n`);
      return 1;
    }
  }

  if (failing) {
    out(`::error title=The org's default issue templates promise a label that is not everywhere::${report.summary}\n`);
  }
  return failing ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
