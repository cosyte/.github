#!/usr/bin/env node
// @ts-check
//
// THE REFERENCE A CALLER CAN NAME, AND THE REFUSALS THAT KEEP IT MEANING ONE COMMIT FOREVER.
//
// Thirteen repositories call the six reusable workflows in this repository at `@main`, so every push
// to this repository's default branch changes thirteen pipelines that nobody in those repositories
// reviewed. This script is this repository's half of the fix. On a push to `main` it publishes the
// current state of the reusable workflows at a named reference that never moves, with a note saying
// what a caller adopting it must act on. A caller then upgrades when it edits its own `uses:` line.
//
// It does not move any caller. That is thirteen other repositories' work and is deliberately not
// done from here.
//
// ---------------------------------------------------------------------------
// A MOVED REFERENCE IS WORSE THAN A BRANCH, SO NOTHING HERE CAN MOVE ONE
// ---------------------------------------------------------------------------
//
// `@main` is at least honest: a caller reading it knows it tracks a branch. A `v1` re-pointed on each
// release LOOKS immutable and is not, which is the failure this whole path exists to avoid. So:
//
//   Every published reference names exactly one commit, forever. The name embeds the commit
//   (`workflows-YYYY-MM-DD-<12 hex>`), so it is a pure function of what it points at and there is no
//   such thing as "the same name at a different commit".
//   A name that already exists is a HARD FAILURE. Not a delete, not a force-update, not a re-point.
//   `publishOperations` below is the complete list of commands this script will ever run against the
//   published state, and `operationsAreNonDestructive` asserts, in the test suite, that not one of
//   them can delete or overwrite anything.
//
// The platform's half of that guarantee is the repository's `Enable release immutability` setting
// (Settings, "Releases"), which locks a published release's tag to its commit. That setting is a
// human's click and this script cannot make it, so this script does not depend on it: the refusal
// above holds whether or not it is on.
//
// ---------------------------------------------------------------------------
// A NARROW YAML READER, BECAUSE THE ALTERNATIVE IS A PERMISSIVE ONE
// ---------------------------------------------------------------------------
//
// This repository has no `package.json`, no lockfile and no install step, on purpose, and Node ships
// no YAML parser. So the caller-facing interface of each reusable is read by the reader below, which
// recognises only the shapes these six files actually use and REFUSES, naming the workflow and the
// line, on anything else. That asymmetry is the whole design: a reader that refuses on an unfamiliar
// shape cannot silently miss a caller-affecting change, and a permissive one can. A refusal costs a
// red run on this repository alone; a miss publishes a reference whose note says a caller has nothing
// to act on when it does.
//
// The interface it extracts is exactly what a caller can be broken by:
//
//   the `workflow_call` inputs, with their types, defaults and required flags
//   the `workflow_call` secrets a caller must pass
//   the permissions the caller must grant, at the workflow level and per job
//   the job ids, which are the check-run contexts a caller's ruleset may require
//
// Everything else in these files (steps, `run:` bodies, `uses:` pins, comments) is opaque to the
// reader. It still moves the reference, because it changes what a caller runs; it just does not
// appear in the note's "must act on" list.
//
// ---------------------------------------------------------------------------
// WHAT COUNTS AS A CHANGE, AND WHY THE TWO LISTS ARE NOT THE SAME LIST
// ---------------------------------------------------------------------------
//
// WHETHER TO PUBLISH is decided on the STATE a caller resolves: the six workflow files plus
// everything under `scripts/`. That second half is not decoration. `ci.yml` fetches
// `scripts/docs-content-check.mjs` and `scripts/prepublish-check.mjs` at `github.job_workflow_sha`,
// and `release.yml` runs five more, so a caller pinned to a reference runs the scripts AS OF THAT
// COMMIT. Publishing on workflow-file changes alone would leave a script fix with no reference to
// adopt it from, which is the same stranding this work exists to end, pointed the other way.
//
// WHAT THE NOTE SAYS A CALLER MUST ACT ON is decided on the INTERFACE, and only the four things
// listed above. A comment sweep, a pinned SHA bump or a new step changes the state, mints a
// reference, and truthfully reports that there is nothing a caller has to do about it.
//
// Run it by hand against this checkout, without publishing anything:
//
//   node scripts/reference-publish.mjs --dry-run

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The six `workflow_call` reusables. A caller can only be broken by one of these. */
export const REUSABLE_WORKFLOWS = Object.freeze([
  'ci.yml',
  'codeql.yml',
  'drift-check.yml',
  'nightly-fuzz.yml',
  'release.yml',
  'scorecard.yml',
]);

/** Every published reference starts with this, so `git tag --list` can find them all. */
export const REFERENCE_PREFIX = 'workflows-';

/** `workflows-YYYY-MM-DD-<12 hex>`. The commit is IN the name, so a name is never reusable. */
export const REFERENCE_PATTERN = /^workflows-\d{4}-\d{2}-\d{2}-[0-9a-f]{12}$/;

/** The reader accepts these keys inside an input's mapping and refuses any other. */
const INPUT_KEYS = Object.freeze(['description', 'type', 'default', 'required']);
/** The same, for a secret. */
const SECRET_KEYS = Object.freeze(['description', 'required']);
/** The only members of `on: workflow_call:` this reader knows how to read. */
const WORKFLOW_CALL_KEYS = Object.freeze(['inputs', 'secrets']);

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** How many changed paths the note lists before it summarises the rest. */
export const NOTE_FILE_LIST_CAP = 40;

/**
 * Is this path part of the state a caller resolves when it names a reference?
 *
 * The six workflow files, plus `scripts/`, which those workflows fetch and run at
 * `github.job_workflow_sha`. `test/`, `README.md` and the community-health files are NOT: nothing a
 * caller runs reads them, and minting a reference for a README edit would make the reference stream
 * noise rather than signal.
 * @param {string} file
 */
export function isStateFile(file) {
  if (file.startsWith('scripts/')) return true;
  return REUSABLE_WORKFLOWS.some((name) => file === `.github/workflows/${name}`);
}

/** @param {string|Buffer} bytes */
export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// The narrow YAML reader
// ---------------------------------------------------------------------------

/**
 * A mapping key and, optionally, a value on the same line. Anything else is `other` and, inside a
 * region this reader parses strictly, `other` is a refusal.
 */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.\-]*):( .*)?$/;

/** The escapes a double-quoted YAML scalar can carry in these files. */
const DOUBLE_ESCAPES = Object.freeze({ n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\', '0': '\0' });

/**
 * The value written after `key:` on one line.
 *
 * `empty` means the value is a nested node on the following lines. `block` is a `|` or `>` scalar,
 * whose body is those following lines. `flow` is a `[...]` or `{...}` collection, which this reader
 * does not read. `bad` is an unterminated quote. Trailing comments are stripped by YAML's own rule:
 * after a closing quote, or at the first ` #` of a plain scalar, which a plain scalar cannot contain.
 * @param {string} after
 */
export function readValue(after) {
  const text = after.trim();
  if (text === '' || text.startsWith('#')) return { kind: 'empty' };
  if (/^[|>][+-]?[0-9]*(\s.*)?$/.test(text)) return { kind: 'block' };
  if (text.startsWith("'")) {
    const value = readSingleQuoted(text);
    return value === null ? { kind: 'bad' } : { kind: 'scalar', value };
  }
  if (text.startsWith('"')) {
    const value = readDoubleQuoted(text);
    return value === null ? { kind: 'bad' } : { kind: 'scalar', value };
  }
  if (/^[[{&*!]/.test(text)) return { kind: 'flow' };
  const commentAt = text.search(/\s#/);
  const plain = (commentAt === -1 ? text : text.slice(0, commentAt)).trim();
  if (plain === '') return { kind: 'empty' };
  if (plain === 'true') return { kind: 'scalar', value: true };
  if (plain === 'false') return { kind: 'scalar', value: false };
  if (plain === 'null' || plain === '~') return { kind: 'scalar', value: null };
  return { kind: 'scalar', value: plain };
}

/** @param {string} text */
function readSingleQuoted(text) {
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] !== "'") {
      out += text[i];
      continue;
    }
    if (text[i + 1] === "'") {
      out += "'";
      i += 1;
      continue;
    }
    const rest = text.slice(i + 1).trim();
    return rest === '' || rest.startsWith('#') ? out : null;
  }
  return null;
}

/** @param {string} text */
function readDoubleQuoted(text) {
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') {
      const next = text[i + 1];
      if (next === undefined) return null;
      out += DOUBLE_ESCAPES[next] ?? next;
      i += 1;
      continue;
    }
    if (char === '"') {
      const rest = text.slice(i + 1).trim();
      return rest === '' || rest.startsWith('#') ? out : null;
    }
    out += char;
  }
  return null;
}

/**
 * One pass over the document, classifying every line. Nothing here decides meaning; the mapping
 * reader below does, and only inside the regions it was asked about.
 * @param {string} text
 */
export function lex(text) {
  /** @type {any[]} */
  const lines = [];
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i].replace(/\r$/, '');
    const number = i + 1;
    if (line.trim() === '') {
      lines.push({ number, kind: 'blank', indent: 0 });
      continue;
    }
    const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (lead.includes('\t')) {
      return { ok: false, reason: `line ${number} indents with a tab, which YAML does not allow` };
    }
    const indent = lead.length;
    const rest = line.slice(indent);
    if (rest.startsWith('#')) {
      lines.push({ number, kind: 'comment', indent });
      continue;
    }
    const match = KEY_LINE.exec(rest);
    if (!match) {
      lines.push({ number, kind: 'other', indent, text: rest });
      continue;
    }
    lines.push({ number, kind: 'key', indent, key: match[1], value: readValue(match[2] ?? '') });
  }
  return { ok: true, lines };
}

/**
 * Is a key line's value complete on that line, so that nothing indented under it is part of it?
 *
 * `empty` means the value is the nested node below, and `block` means the value is the block scalar
 * below. For every other kind the value was written after the colon and is finished there.
 * @param {{kind: string}} value
 */
function valueEndsOnItsLine(value) {
  return value.kind !== 'empty' && value.kind !== 'block';
}

/**
 * Read the block mapping occupying `lines[from..to)`, at the indentation of its first key.
 *
 * Every entry carries the half-open range of the lines BELOW it, which is its value when the value
 * is a nested node. That range is computed by indentation alone, which is why an opaque region (a
 * step list, a `run:` body) can be skipped without being understood: YAML requires a nested node,
 * block scalar included, to be indented deeper than the key that introduces it.
 *
 * Blank and comment lines are skipped wherever they appear, at any indentation, because YAML gives
 * neither of them structural meaning.
 *
 * WHERE THE VALUE ENDS ON ITS OWN LINE, THE RANGE BELOW IT MUST BE EMPTY OF EVERYTHING ELSE, and
 * this reader refuses when it is not. Those bytes are not part of any shape it recognises, so
 * accepting the entry anyway means DROPPING them: a plain scalar wrapped onto a second line reads
 * as its first line alone, and two interfaces that genuinely differ (a changed input `default:`, a
 * changed job `name:`, both of them things Constraint 4 calls a change a caller must act on) read
 * as one. The note then says a caller has nothing to act on while it does, which is the single
 * failure this reader's narrowness exists to make impossible. Nobody has to SUPPORT a wrapped
 * scalar; the rule is to refuse what is not recognised, and this is the shape the range-based skip
 * used to swallow. Blanks and comments stay exempt: every one of these six files carries a comment
 * block under its `name:` and between its inputs, and YAML gives neither structural meaning.
 * @param {any[]} lines
 * @param {number} from
 * @param {number} to
 */
export function readMapping(lines, from, to) {
  let i = from;
  const skippable = (line) => line.kind === 'blank' || line.kind === 'comment';
  while (i < to && skippable(lines[i])) i += 1;
  if (i >= to) return { ok: true, indent: null, entries: [] };
  if (lines[i].kind !== 'key') {
    return { ok: false, reason: `line ${lines[i].number} is not a \`key:\` line where a mapping was expected` };
  }
  const indent = lines[i].indent;
  /** @type {any[]} */
  const entries = [];
  while (i < to) {
    const line = lines[i];
    if (skippable(line)) {
      i += 1;
      continue;
    }
    if (line.indent !== indent) {
      return { ok: false, reason: `line ${line.number} is indented by ${line.indent} where ${indent} was expected` };
    }
    if (line.kind !== 'key') {
      return { ok: false, reason: `line ${line.number} is not a \`key:\` line` };
    }
    let j = i + 1;
    while (j < to) {
      const next = lines[j];
      if (skippable(next) || next.indent > indent) {
        j += 1;
        continue;
      }
      break;
    }
    if (valueEndsOnItsLine(line.value)) {
      for (let k = i + 1; k < j; k += 1) {
        const below = lines[k];
        if (skippable(below)) continue;
        return {
          ok: false,
          reason:
            `line ${below.number} is indented under \`${line.key}:\` (line ${line.number}), whose value ends on that line, ` +
            'so this reader neither reads it nor recognises it',
        };
      }
    }
    entries.push({ key: line.key, value: line.value, line: line.number, from: i + 1, to: j });
    i = j;
  }
  return { ok: true, indent, entries };
}

/** @param {any[]} entries @param {string} where */
function keyed(entries, where) {
  const map = new Map();
  for (const entry of entries) {
    if (map.has(entry.key)) {
      return { ok: false, reason: `${where} declares \`${entry.key}:\` twice (line ${entry.line})` };
    }
    map.set(entry.key, entry);
  }
  return { ok: true, map };
}

/** A `scope: level` block mapping, and nothing else counts as one. */
function readPermissions(lines, entry, where) {
  if (entry.value.kind !== 'empty') {
    return { ok: false, reason: `${where} is not a \`scope: level\` block (line ${entry.line})` };
  }
  const mapping = readMapping(lines, entry.from, entry.to);
  if (!mapping.ok) return { ok: false, reason: `${where}: ${mapping.reason}` };
  /** @type {Record<string, string>} */
  const grants = {};
  for (const grant of mapping.entries) {
    if (grant.value.kind !== 'scalar' || typeof grant.value.value !== 'string') {
      return { ok: false, reason: `${where} gives \`${grant.key}\` a value this reader does not read (line ${grant.line})` };
    }
    grants[grant.key] = grant.value.value;
  }
  return { ok: true, grants };
}

/**
 * The caller-facing interface of one reusable workflow, or a refusal naming what stopped it.
 *
 * @param {string} text the file's bytes
 * @param {string} workflow its name, so every refusal says which one
 * @returns {{ok: true, interface: any} | {ok: false, reason: string}}
 */
export function readWorkflowInterface(text, workflow) {
  const fail = (reason) => ({ ok: false, reason: `${workflow}: ${reason}` });

  const lexed = lex(text);
  if (!lexed.ok) return fail(lexed.reason);
  const lines = lexed.lines;

  const top = readMapping(lines, 0, lines.length);
  if (!top.ok) return fail(top.reason);
  if (top.indent !== null && top.indent !== 0) return fail('the document does not begin at column 0');
  const topKeys = keyed(top.entries, 'the document');
  if (!topKeys.ok) return fail(topKeys.reason);

  // -- `on: workflow_call:` -----------------------------------------------------------------------
  const on = topKeys.map.get('on');
  if (!on) return fail('it declares no `on:` block, so it has no caller-facing interface to read');

  /** @type {{from:number,to:number}|null} */
  let workflowCall = null;
  if (on.value.kind === 'scalar') {
    if (on.value.value !== 'workflow_call') {
      return fail(`\`on: ${String(on.value.value)}\` is not a \`workflow_call\` reusable`);
    }
    workflowCall = { from: 0, to: 0 };
  } else if (on.value.kind === 'empty') {
    const triggers = readMapping(lines, on.from, on.to);
    if (!triggers.ok) return fail(`\`on:\`: ${triggers.reason}`);
    const called = triggers.entries.find((entry) => entry.key === 'workflow_call');
    if (!called) return fail('`on:` declares no `workflow_call:`, so it is not a reusable workflow');
    if (called.value.kind !== 'empty') {
      return fail(`\`on: workflow_call:\` has a shape this reader does not recognise (line ${called.line})`);
    }
    workflowCall = { from: called.from, to: called.to };
  } else {
    return fail('`on:` has a shape this reader does not recognise');
  }

  const call = readMapping(lines, workflowCall.from, workflowCall.to);
  if (!call.ok) return fail(`\`on: workflow_call:\`: ${call.reason}`);
  const callKeys = keyed(call.entries, '`on: workflow_call:`');
  if (!callKeys.ok) return fail(callKeys.reason);
  for (const entry of call.entries) {
    if (!WORKFLOW_CALL_KEYS.includes(entry.key)) {
      // The fail-closed heart of this reader. `outputs:` would land here, and so would anything else
      // GitHub adds to `workflow_call`. Refusing names the key; guessing would publish a note that
      // says a caller has nothing to act on while a new part of the contract moved underneath it.
      return fail(`\`on: workflow_call:\` declares \`${entry.key}:\` (line ${entry.line}), which this reader does not know how to read`);
    }
  }

  /** @type {Record<string, any>} */
  const inputs = {};
  const inputsEntry = callKeys.map.get('inputs');
  if (inputsEntry) {
    if (inputsEntry.value.kind !== 'empty') {
      return fail(`\`inputs:\` is not a block mapping (line ${inputsEntry.line})`);
    }
    const mapping = readMapping(lines, inputsEntry.from, inputsEntry.to);
    if (!mapping.ok) return fail(`\`inputs:\`: ${mapping.reason}`);
    const names = keyed(mapping.entries, '`inputs:`');
    if (!names.ok) return fail(names.reason);
    for (const input of mapping.entries) {
      const read = readInput(lines, input);
      if (!read.ok) return fail(read.reason);
      inputs[input.key] = read.input;
    }
  }

  /** @type {Record<string, any>} */
  const secrets = {};
  const secretsEntry = callKeys.map.get('secrets');
  if (secretsEntry) {
    if (secretsEntry.value.kind !== 'empty') {
      return fail(`\`secrets:\` is not a block mapping (line ${secretsEntry.line})`);
    }
    const mapping = readMapping(lines, secretsEntry.from, secretsEntry.to);
    if (!mapping.ok) return fail(`\`secrets:\`: ${mapping.reason}`);
    const names = keyed(mapping.entries, '`secrets:`');
    if (!names.ok) return fail(names.reason);
    for (const secret of mapping.entries) {
      const read = readSecret(lines, secret);
      if (!read.ok) return fail(read.reason);
      secrets[secret.key] = read.secret;
    }
  }

  // -- the permissions a caller must grant ---------------------------------------------------------
  /** @type {Record<string, string>|null} */
  let workflowPermissions = null;
  const permissionsEntry = topKeys.map.get('permissions');
  if (permissionsEntry) {
    const read = readPermissions(lines, permissionsEntry, 'the workflow-level `permissions:`');
    if (!read.ok) return fail(read.reason);
    workflowPermissions = read.grants;
  }

  // -- the job ids, which are the contexts a caller's ruleset may require --------------------------
  const jobsEntry = topKeys.map.get('jobs');
  if (!jobsEntry) return fail('it declares no `jobs:` block');
  if (jobsEntry.value.kind !== 'empty') return fail('`jobs:` is not a block mapping');
  const jobsMapping = readMapping(lines, jobsEntry.from, jobsEntry.to);
  if (!jobsMapping.ok) return fail(`\`jobs:\`: ${jobsMapping.reason}`);
  const jobNames = keyed(jobsMapping.entries, '`jobs:`');
  if (!jobNames.ok) return fail(jobNames.reason);

  /** @type {Record<string, any>} */
  const jobs = {};
  /** @type {Record<string, Record<string, string>|null>} */
  const jobPermissions = {};
  for (const job of jobsMapping.entries) {
    if (job.value.kind !== 'empty') {
      return fail(`the job \`${job.key}\` is not a block mapping (line ${job.line})`);
    }
    const body = readMapping(lines, job.from, job.to);
    if (!body.ok) return fail(`the job \`${job.key}\`: ${body.reason}`);
    const bodyKeys = keyed(body.entries, `the job \`${job.key}\``);
    if (!bodyKeys.ok) return fail(bodyKeys.reason);

    let displayName = null;
    const nameEntry = bodyKeys.map.get('name');
    if (nameEntry) {
      if (nameEntry.value.kind !== 'scalar') {
        return fail(`the job \`${job.key}\` has a \`name:\` this reader does not read (line ${nameEntry.line})`);
      }
      displayName = String(nameEntry.value.value);
    }
    jobs[job.key] = { name: displayName };

    const jobPermissionsEntry = bodyKeys.map.get('permissions');
    if (jobPermissionsEntry) {
      const read = readPermissions(lines, jobPermissionsEntry, `the job \`${job.key}\`'s \`permissions:\``);
      if (!read.ok) return fail(read.reason);
      jobPermissions[job.key] = read.grants;
    } else {
      jobPermissions[job.key] = null;
    }
  }

  return {
    ok: true,
    interface: {
      workflow,
      inputs,
      secrets,
      permissions: { workflow: workflowPermissions, jobs: jobPermissions },
      jobs,
    },
  };
}

/** One `workflow_call` input. `description:` is read past, never read: a caller cannot act on prose. */
function readInput(lines, entry) {
  const where = `the input \`${entry.key}\``;
  if (entry.value.kind !== 'empty') {
    return { ok: false, reason: `${where} is not a block mapping (line ${entry.line})` };
  }
  const mapping = readMapping(lines, entry.from, entry.to);
  if (!mapping.ok) return { ok: false, reason: `${where}: ${mapping.reason}` };
  const fields = keyed(mapping.entries, where);
  if (!fields.ok) return { ok: false, reason: fields.reason };

  for (const field of mapping.entries) {
    if (!INPUT_KEYS.includes(field.key)) {
      return { ok: false, reason: `${where} declares \`${field.key}:\` (line ${field.line}), which this reader does not know how to read` };
    }
    if (field.key === 'description') continue;
    if (field.value.kind !== 'scalar') {
      return { ok: false, reason: `${where} gives \`${field.key}:\` a value this reader does not read (line ${field.line})` };
    }
  }

  const typeField = fields.map.get('type');
  const requiredField = fields.map.get('required');
  const defaultField = fields.map.get('default');
  if (requiredField && typeof requiredField.value.value !== 'boolean') {
    return { ok: false, reason: `${where} sets \`required:\` to something that is not true or false (line ${requiredField.line})` };
  }
  return {
    ok: true,
    input: {
      type: typeField ? String(typeField.value.value) : null,
      required: requiredField ? Boolean(requiredField.value.value) : false,
      default: defaultField ? { present: true, value: defaultField.value.value } : { present: false, value: null },
    },
  };
}

/** One `workflow_call` secret. Only `required:` changes what a caller has to hand over. */
function readSecret(lines, entry) {
  const where = `the secret \`${entry.key}\``;
  if (entry.value.kind === 'empty' && entry.from === entry.to) {
    return { ok: true, secret: { required: false } };
  }
  if (entry.value.kind !== 'empty') {
    return { ok: false, reason: `${where} is not a block mapping (line ${entry.line})` };
  }
  const mapping = readMapping(lines, entry.from, entry.to);
  if (!mapping.ok) return { ok: false, reason: `${where}: ${mapping.reason}` };
  const fields = keyed(mapping.entries, where);
  if (!fields.ok) return { ok: false, reason: fields.reason };
  for (const field of mapping.entries) {
    if (!SECRET_KEYS.includes(field.key)) {
      return { ok: false, reason: `${where} declares \`${field.key}:\` (line ${field.line}), which this reader does not know how to read` };
    }
    if (field.key === 'description') continue;
    if (field.value.kind !== 'scalar' || typeof field.value.value !== 'boolean') {
      return { ok: false, reason: `${where} sets \`required:\` to something that is not true or false (line ${field.line})` };
    }
  }
  const requiredField = fields.map.get('required');
  return { ok: true, secret: { required: requiredField ? Boolean(requiredField.value.value) : false } };
}

// ---------------------------------------------------------------------------
// The diff, and the line between "act on this" and "for your information"
// ---------------------------------------------------------------------------

/** Stable text for a default, so two of them can be compared and printed the same way. */
export function formatDefault(value) {
  if (!value || value.present !== true) return 'no default';
  return JSON.stringify(value.value);
}

const sameDefault = (a, b) => formatDefault(a) === formatDefault(b);
const samePermissions = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What changed between two readings of one workflow's interface.
 *
 * `act: true` is this spec's definition of a change a caller must act on, and it is deliberately
 * narrow: an input added WITH a default breaks nobody (it is how `check-docs-content` shipped to
 * thirteen repositories without touching one of them), so it is reported without being demanded.
 * @param {any} before
 * @param {any} after
 */
export function diffInterfaces(before, after) {
  const workflow = after.workflow;
  /** @type {any[]} */
  const changes = [];
  const push = (kind, act, subject, extra = {}) => changes.push({ workflow, kind, act, subject, ...extra });

  for (const name of Object.keys(after.inputs)) {
    const now = after.inputs[name];
    const then = before.inputs[name];
    if (!then) {
      if (now.required || !now.default.present) push('input-added-required', true, name);
      else push('input-added', false, name, { to: formatDefault(now.default) });
      continue;
    }
    if (!then.required && now.required) push('input-became-required', true, name);
    if (then.required && !now.required) push('input-became-optional', false, name);
    if (!sameDefault(then.default, now.default)) {
      push('input-default-changed', true, name, { from: formatDefault(then.default), to: formatDefault(now.default) });
    }
    if (then.type !== now.type) push('input-type-changed', false, name, { from: then.type, to: now.type });
  }
  for (const name of Object.keys(before.inputs)) {
    if (!after.inputs[name]) push('input-removed', true, name);
  }

  for (const name of Object.keys(after.secrets)) {
    const now = after.secrets[name];
    const then = before.secrets[name];
    if (!then) {
      push('secret-added', true, name, { to: now.required ? 'required' : 'optional' });
      continue;
    }
    if (then.required !== now.required) {
      push('secret-required-changed', true, name, {
        from: then.required ? 'required' : 'optional',
        to: now.required ? 'required' : 'optional',
      });
    }
  }
  for (const name of Object.keys(before.secrets)) {
    if (!after.secrets[name]) push('secret-removed', true, name);
  }

  if (!samePermissions(before.permissions.workflow, after.permissions.workflow)) {
    push('permissions-changed', true, 'the workflow', {
      from: renderGrants(before.permissions.workflow),
      to: renderGrants(after.permissions.workflow),
    });
  }
  const jobIds = new Set([...Object.keys(before.permissions.jobs), ...Object.keys(after.permissions.jobs)]);
  for (const id of [...jobIds].sort()) {
    if (!(id in before.permissions.jobs) || !(id in after.permissions.jobs)) continue;
    if (samePermissions(before.permissions.jobs[id], after.permissions.jobs[id])) continue;
    push('permissions-changed', true, `the job \`${id}\``, {
      from: renderGrants(before.permissions.jobs[id]),
      to: renderGrants(after.permissions.jobs[id]),
    });
  }

  for (const id of Object.keys(after.jobs)) {
    if (!(id in before.jobs)) {
      push('job-added', true, id);
      continue;
    }
    if (before.jobs[id].name !== after.jobs[id].name) {
      push('job-name-changed', true, id, { from: before.jobs[id].name ?? id, to: after.jobs[id].name ?? id });
    }
  }
  for (const id of Object.keys(before.jobs)) {
    if (!(id in after.jobs)) push('job-removed', true, id);
  }

  return changes;
}

/** @param {Record<string,string>|null} grants */
function renderGrants(grants) {
  if (!grants) return 'none declared';
  const keys = Object.keys(grants).sort();
  if (keys.length === 0) return 'none declared';
  return keys.map((scope) => `${scope}: ${grants[scope]}`).join(', ');
}

// ---------------------------------------------------------------------------
// The note
// ---------------------------------------------------------------------------

/**
 * One sentence per change, or null for a kind nobody taught this function to render.
 *
 * A null is not cosmetic: `composeNote` refuses on it, and `decide` publishes nothing when the note
 * refuses, so an unrenderable change can never end up as a reference whose note quietly omits it.
 */
export function renderChange(change) {
  const { workflow, subject } = change;
  switch (change.kind) {
    case 'workflow-added':
      return `\`${workflow}\` did not exist at the earlier reference. Everything it declares is new to you.`;
    case 'input-added-required':
      return `\`${workflow}\`: the input \`${subject}\` was added and has no default. A caller that does not pass it fails.`;
    case 'input-added':
      return `\`${workflow}\`: the input \`${subject}\` was added, defaulting to ${change.to}. A caller that passes nothing is unaffected.`;
    case 'input-removed':
      return `\`${workflow}\`: the input \`${subject}\` was removed. A caller still passing it fails.`;
    case 'input-became-required':
      return `\`${workflow}\`: the input \`${subject}\` is now required. A caller that does not pass it fails.`;
    case 'input-became-optional':
      return `\`${workflow}\`: the input \`${subject}\` is no longer required.`;
    case 'input-default-changed':
      return `\`${workflow}\`: the default of \`${subject}\` changed from ${change.from} to ${change.to}. A caller that does not pass it gets the new value.`;
    case 'input-type-changed':
      return `\`${workflow}\`: the type of \`${subject}\` changed from ${change.from} to ${change.to}.`;
    case 'secret-added':
      return `\`${workflow}\`: the secret \`${subject}\` was added and is ${change.to}.`;
    case 'secret-removed':
      return `\`${workflow}\`: the secret \`${subject}\` was removed. A caller passing it by name fails.`;
    case 'secret-required-changed':
      return `\`${workflow}\`: the secret \`${subject}\` went from ${change.from} to ${change.to}.`;
    case 'permissions-changed':
      return `\`${workflow}\`: the permissions ${subject} asks the caller to grant changed from (${change.from}) to (${change.to}). A called workflow can only downgrade its caller's token, so a caller that does not grant these fails at startup.`;
    case 'job-added':
      return `\`${workflow}\`: the job \`${subject}\` was added. It emits a new check-run context.`;
    case 'job-removed':
      return `\`${workflow}\`: the job \`${subject}\` was removed. A ruleset requiring that context strands every pull request.`;
    case 'job-name-changed':
      return `\`${workflow}\`: the job \`${subject}\` renamed its display name from ${change.from} to ${change.to}.`;
    default:
      return null;
  }
}

const USES_EXAMPLE = 'uses: cosyte/.github/.github/workflows/ci.yml@';

/**
 * The note that travels with the reference, and the only thing a caller reads before adopting it.
 *
 * It refuses rather than degrading. AC8 of the spec behind this file says a note that cannot be
 * produced publishes NOTHING, because a reference with no note is a reference nobody can safely
 * adopt, and one silently missing a change is worse than that.
 *
 * @param {object} facts
 * @returns {{ok: true, note: string} | {ok: false, reason: string}}
 */
export function composeNote(facts) {
  const { reference, commit, previous, changes = [], files = {} } = facts;

  if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) {
    return { ok: false, reason: `the reference name ${JSON.stringify(reference)} is not of the form ${REFERENCE_PREFIX}YYYY-MM-DD-<12 hex>` };
  }
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    return { ok: false, reason: `the commit ${JSON.stringify(commit)} is not a full 40 character SHA` };
  }

  const rendered = [];
  for (const change of changes) {
    const sentence = renderChange(change);
    if (sentence === null) {
      return { ok: false, reason: `there is no way to describe a change of kind ${JSON.stringify(change.kind)} in \`${change.workflow}\`` };
    }
    rendered.push({ change, sentence });
  }

  const mustAct = rendered.filter((entry) => entry.change.act === true);
  const forInformation = rendered.filter((entry) => entry.change.act !== true);

  const body = [];
  body.push(`The reusable workflows of this repository, as they stand at commit \`${commit}\`.`);
  body.push('');
  body.push('This reference names that one commit and will never name another. Call it by name:');
  body.push('');
  body.push('```yaml');
  body.push('jobs:');
  body.push('  ci:');
  body.push(`    ${USES_EXAMPLE}${reference}`);
  body.push('```');
  body.push('');
  if (!previous) {
    body.push(
      'No reference has been published from this repository before, so there is no earlier reference to compare this one against. This is not a report that nothing changed: every input, every secret, every permission and every job name in these workflows is new to a caller adopting a reference for the first time. Read the workflow headers at this commit before you pin it.',
    );
  } else {
    body.push(`Compared against \`${previous.reference}\` (commit \`${previous.commit}\`).`);
  }
  body.push('');

  body.push('## What a caller must act on');
  body.push('');
  if (mustAct.length === 0) {
    body.push(
      previous
        ? `Nothing. No \`workflow_call\` input, no secret, no permission and no job name changed between \`${previous.reference}\` and this reference. Moving to it is safe without editing anything else in your repository.`
        : // Not "everything below": nothing below this heading is a must-act list, and pointing a
          // caller at one that is not there is how a first adopter skips the reading it actually
          // owes. There is no earlier reference, so there is no change to list; what a caller must
          // act on is the whole interface, which lives in the workflow itself.
          'This is the first reference, so there is no list here: with no earlier reference to have adopted, nothing can be reported as having changed. What a caller must act on is the whole interface, which is every `workflow_call` input, every secret it must pass, every permission it must grant and every job name it may have made required. Read it from the workflow headers at this commit rather than from this note.',
    );
  } else {
    for (const entry of mustAct) body.push(`- ${entry.sentence}`);
  }
  body.push('');

  if (forInformation.length > 0) {
    body.push('## Changes a caller does not have to act on');
    body.push('');
    for (const entry of forInformation) body.push(`- ${entry.sentence}`);
    body.push('');
  }

  const changed = Array.isArray(files.changed) ? files.changed : [];
  const added = Array.isArray(files.added) ? files.added : [];
  const removed = Array.isArray(files.removed) ? files.removed : [];
  const touched = [
    ...added.map((file) => ({ file, suffix: ' (added)' })),
    ...removed.map((file) => ({ file, suffix: ' (removed)' })),
    ...changed.map((file) => ({ file, suffix: '' })),
  ].sort((a, b) => (a.file < b.file ? -1 : 1));
  if (touched.length > 0) {
    body.push('## What moved in the state a caller resolves');
    body.push('');
    body.push(
      'That state is the six reusable workflows plus everything under `scripts/`, which those workflows fetch and run at the commit a caller resolved.',
    );
    body.push('');
    if (!previous) {
      // On a first publish every file is "added", which is a list nobody reads and a sentence
      // everybody does.
      body.push(`All ${touched.length} of those files, because this is the first reference.`);
    } else {
      for (const entry of touched.slice(0, NOTE_FILE_LIST_CAP)) body.push(`- \`${entry.file}\`${entry.suffix}`);
      if (touched.length > NOTE_FILE_LIST_CAP) {
        body.push(`- and ${touched.length - NOTE_FILE_LIST_CAP} more`);
      }
    }
    body.push('');
  }

  body.push('## Why this exists');
  body.push('');
  body.push(
    'A reference at `@main` delivers every later change to your pipeline on this repository\'s clock rather than yours, reviewed by nobody in your repository. A reference like this one delivers nothing until you edit your own `uses:` line.',
  );
  body.push('');

  const note = body.join('\n');

  // A cheap self-check, because the expensive failure is a note that reads fine and omits the one
  // sentence a caller needed. Every element the criteria demand is asserted on the bytes about to be
  // published rather than on the intent that produced them.
  const missing = [];
  if (!note.includes(reference)) missing.push('the reference name');
  if (!note.includes(commit)) missing.push('the commit');
  if (!note.includes(USES_EXAMPLE)) missing.push('a `uses:` example');
  if (!previous && !note.includes('no earlier reference')) missing.push('the first-publish statement');
  for (const entry of mustAct) {
    if (!note.includes(entry.sentence)) missing.push(`the change to ${entry.change.workflow}`);
  }
  if (missing.length > 0) {
    return { ok: false, reason: `the note was composed without ${missing.join(', ')}` };
  }
  return { ok: true, note };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** `workflows-YYYY-MM-DD-<12 hex>`, or null when either half is not what it claims to be. */
export function referenceName({ date, commit }) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return null;
  return `${REFERENCE_PREFIX}${date}-${commit.slice(0, 12)}`;
}

/** @param {{path:string,digest:string}[]} files */
function digestMap(files) {
  const map = new Map();
  for (const file of files) map.set(file.path, file.digest);
  return map;
}

/**
 * Pure, so every arm below is graded without a network, a token or a real release.
 *
 * The order of the checks is part of the contract:
 *
 *   1. Every current interface must be readable, or nothing is published (AC7).
 *   2. An earlier reference whose interface cannot be read is the same refusal: the comparison the
 *      note owes a caller cannot be made. An ABSENT file there is different, and means the workflow
 *      is new since that reference.
 *   3. Nothing changed publishes nothing (AC6). This runs BEFORE the name collision check on
 *      purpose: a re-run on an already published commit is owed "no new reference was needed", not a
 *      failure, because no reference is about to be published.
 *   4. A name that already exists fails the run and is never deleted, moved or overwritten (AC4).
 *   5. A note that cannot be produced publishes neither note nor reference (AC8).
 *
 * @param {object} facts
 * @param {object} [options]
 */
export function decide(facts, options = {}) {
  const { compose = composeNote } = options;
  const { current, previous = null, existingReferences = [] } = facts;

  for (const entry of current.workflows) {
    if (!entry.read.ok) {
      return refusal('A reusable workflow could not be read', [
        `Refusing to publish a reference: ${entry.read.reason}`,
        'A reference whose interface nobody could read carries a note that cannot say what a caller must act on, so no reference is published at all.',
        'Fix the workflow, or widen the reader in `scripts/reference-publish.mjs` and prove the new shape in `test/reference-publish.test.mjs`.',
      ]);
    }
  }

  if (previous) {
    for (const entry of previous.workflows) {
      if (!entry.read.ok && entry.read.absent !== true) {
        return refusal('An earlier reference could not be read', [
          `Refusing to publish a reference: at \`${previous.reference}\`, ${entry.read.reason}`,
          'The note owes a caller a comparison against the reference it is most likely to be on, and that comparison cannot be made against a workflow this reader cannot read.',
          'Fix the reader in `scripts/reference-publish.mjs`; nothing that is already published may be edited to clear this.',
        ]);
      }
    }
  }

  const reference = referenceName({ date: current.date, commit: current.commit });
  if (!reference) {
    return refusal('The reference name cannot be composed', [
      `Refusing to publish a reference: commit ${JSON.stringify(current.commit)} and date ${JSON.stringify(current.date)} do not compose a name of the form ${REFERENCE_PREFIX}YYYY-MM-DD-<12 hex>.`,
    ]);
  }

  // -- has anything a caller resolves actually moved? ----------------------------------------------
  const nowFiles = digestMap(current.files);
  const thenFiles = previous ? digestMap(previous.files) : new Map();
  const changedFiles = [];
  const addedFiles = [];
  const removedFiles = [];
  for (const [file, digest] of nowFiles) {
    if (!thenFiles.has(file)) addedFiles.push(file);
    else if (thenFiles.get(file) !== digest) changedFiles.push(file);
  }
  for (const file of thenFiles.keys()) {
    if (!nowFiles.has(file)) removedFiles.push(file);
  }
  const moved = changedFiles.length + addedFiles.length + removedFiles.length;

  if (previous && moved === 0) {
    return {
      action: 'none',
      failing: false,
      reference: null,
      commit: current.commit,
      note: null,
      changes: [],
      title: 'No new reference was needed',
      message: [
        `Nothing a caller resolves has changed since \`${previous.reference}\` (commit \`${previous.commit}\`).`,
        'The six reusable workflows and every file under `scripts/` are byte identical at this commit, so a second reference would name the same state under a different name.',
        `Callers stay on \`${previous.reference}\`.`,
      ].join('\n'),
      outputs: { action: 'none', reference: '', commit: current.commit },
    };
  }

  if (existingReferences.includes(reference)) {
    return refusal('That reference already exists', [
      `Refusing to publish \`${reference}\`: a reference of that name has already been published.`,
      'It is NOT deleted, NOT force updated and NOT pointed at another commit. A published reference names one commit forever, and a name that looks immutable while moving is worse than a branch, which is the whole property this path exists to buy.',
      'Someone has to decide what that existing reference is, by hand. Nothing here will decide it for them.',
    ]);
  }

  // -- what a caller adopting this reference must act on -------------------------------------------
  /** @type {any[]} */
  const changes = [];
  if (previous) {
    const before = new Map(previous.workflows.map((entry) => [entry.name, entry]));
    for (const entry of current.workflows) {
      const earlier = before.get(entry.name);
      if (!earlier || earlier.read.ok !== true) {
        changes.push({ workflow: entry.name, kind: 'workflow-added', act: false, subject: entry.name });
        continue;
      }
      changes.push(...diffInterfaces(earlier.read.interface, entry.read.interface));
    }
  }

  const note = compose({
    reference,
    commit: current.commit,
    previous: previous ? { reference: previous.reference, commit: previous.commit } : null,
    changes,
    files: { changed: changedFiles, added: addedFiles, removed: removedFiles },
  });
  if (!note.ok) {
    return refusal('The note for this reference could not be produced', [
      `Refusing to publish \`${reference}\`: ${note.reason}.`,
      'Neither the note nor the reference is published. A reference without its note is one a caller cannot adopt safely, and this path never leaves one behind.',
    ]);
  }

  const mustAct = changes.filter((change) => change.act === true);
  return {
    action: 'publish',
    failing: false,
    reference,
    commit: current.commit,
    note: note.note,
    changes,
    title: `Publishing ${reference}`,
    message: [
      `Publishing \`${reference}\` at commit \`${current.commit}\`.`,
      previous
        ? `${moved} of the files a caller resolves changed since \`${previous.reference}\`, and ${mustAct.length} of those changes is something a caller must act on.`
        : 'This is the first reference this repository has ever published.',
    ].join('\n'),
    outputs: { action: 'publish', reference, commit: current.commit },
  };
}

/** Every refusal is `action: refused`, which is neither `publish` nor `none`. */
function refusal(title, lines) {
  return {
    action: 'refused',
    failing: true,
    reference: null,
    commit: null,
    note: null,
    changes: [],
    title,
    message: lines.filter(Boolean).join('\n'),
    outputs: { action: 'refused', reference: '', commit: '' },
  };
}

// ---------------------------------------------------------------------------
// The publish, and the fact that it is one call rather than two
// ---------------------------------------------------------------------------

/**
 * The COMPLETE list of commands this script runs against the published state.
 *
 * The tag and its note are created by ONE call. Creating the tag first and attaching the note second
 * has a window in which a reference exists with no note, and this path never has one: if the note
 * cannot be written, `gh release create` is never reached, and if `gh release create` fails, nothing
 * was created to clean up.
 *
 * Nothing here deletes, forces or edits. `operationsAreNonDestructive` asserts that in the suite,
 * against this list, so a later edit that adds a `--force` fails a test rather than a caller.
 */
export function publishOperations({ reference, commit, notePath, repository }) {
  return [
    {
      id: 'create',
      description: 'create the reference and its note in one call',
      command: 'gh',
      args: ['release', 'create', reference, '--target', commit, '--title', reference, '--notes-file', notePath],
    },
    {
      id: 'read-back-release',
      description: 'read the release back, because an unread outcome is not a published reference',
      command: 'gh',
      args: ['release', 'view', reference, '--json', 'tagName,body'],
    },
    {
      id: 'read-back-tag',
      description: 'read the tag back and prove it names the commit this run published',
      command: 'gh',
      args: ['api', `repos/${repository}/git/ref/tags/${reference}`, '--jq', '.object.sha'],
    },
  ];
}

/** Any of these in an argument would let this script move or destroy something already published. */
export const DESTRUCTIVE_ARGUMENTS = Object.freeze([
  'delete',
  'edit',
  '--force',
  '-f',
  'update-ref',
  '--notes-start-tag',
  'push',
  'tag',
]);

/** @param {{command:string,args:string[]}[]} operations */
export function operationsAreNonDestructive(operations) {
  for (const operation of operations) {
    for (const argument of operation.args) {
      if (DESTRUCTIVE_ARGUMENTS.includes(argument)) {
        return { ok: false, reason: `operation ${operation.id} passes ${argument}` };
      }
    }
  }
  return { ok: true };
}

/**
 * Which permission a failure says was denied, or null when the failure is something else.
 *
 * Naming it matters: a run that says "gh exited 1" sends a maintainer to the wrong place, and the
 * one thing this workflow needs that a default token does not have is `contents: write`.
 * @param {string} text
 */
export function deniedPermission(text) {
  if (typeof text !== 'string') return null;
  if (/HTTP 403|Resource not accessible by integration|403 Forbidden|must have admin rights|permission_denied/i.test(text)) {
    return 'contents: write';
  }
  return null;
}

/**
 * Run the plan. Every failure arm reports NOT published, and none of them tries to tidy up: a
 * half-created release is a thing a human looks at, not a thing this script deletes.
 *
 * @param {any} verdict a `publish` verdict from `decide`
 * @param {object} io
 */
export async function executePublish(verdict, io) {
  const { run, writeNote, repository } = io;

  if (!repository) {
    return failedPublish('The repository is not known', [
      `Refusing to publish \`${verdict.reference}\`: nothing told this run which repository it is publishing to, so the reference could not be read back afterwards.`,
    ]);
  }

  let notePath;
  try {
    notePath = await writeNote(verdict.note);
  } catch (error) {
    return failedPublish('The note could not be written', [
      `Refusing to publish \`${verdict.reference}\`: the note could not be written to disk.`,
      error instanceof Error ? error.message : String(error),
      'Neither the note nor the reference exists. Nothing was published.',
    ]);
  }

  const operations = publishOperations({
    reference: verdict.reference,
    commit: verdict.commit,
    notePath,
    repository,
  });
  const safe = operationsAreNonDestructive(operations);
  if (!safe.ok) {
    return failedPublish('The publish plan was refused', [
      `Refusing to publish \`${verdict.reference}\`: ${safe.reason}, and nothing in this path may delete or move a published reference.`,
    ]);
  }

  const [create, readRelease, readTag] = operations;

  const created = await run(create.command, create.args);
  if (!created.ok) {
    const denied = deniedPermission(`${created.stderr ?? ''}\n${created.stdout ?? ''}`);
    if (denied) {
      return failedPublish('The run was denied the permission it needed', [
        `Refusing to report \`${verdict.reference}\` as published: creating it was denied, and the permission it needs is \`${denied}\`.`,
        'This workflow declares that permission on its job. A run that lost it is a run whose token was narrowed, or a repository whose default workflow permissions are read only.',
        (created.stderr ?? '').trim(),
      ]);
    }
    return failedPublish('The reference could not be created', [
      `Refusing to report \`${verdict.reference}\` as published: \`gh ${create.args.join(' ')}\` failed.`,
      (created.stderr ?? '').trim() || `exit status ${String(created.status)}`,
      'No reference is reported as published, and nothing was deleted to make room for a retry.',
    ]);
  }

  const viewed = await run(readRelease.command, readRelease.args);
  if (!viewed.ok) {
    const denied = deniedPermission(`${viewed.stderr ?? ''}\n${viewed.stdout ?? ''}`);
    return failedPublish('The outcome of the publish could not be read', [
      `\`gh ${create.args.slice(0, 3).join(' ')}\` reported success, but reading \`${verdict.reference}\` back failed, so this run cannot say what exists.`,
      denied ? `The read was denied the permission \`${denied}\`.` : (viewed.stderr ?? '').trim(),
      `Nothing is reported as published. Look at \`${verdict.reference}\` by hand before re-running.`,
    ]);
  }
  let release;
  try {
    release = JSON.parse(viewed.stdout ?? '');
  } catch {
    return failedPublish('The outcome of the publish could not be read', [
      `Reading \`${verdict.reference}\` back returned something that is not JSON, so this run cannot say what exists.`,
      `Nothing is reported as published. Look at \`${verdict.reference}\` by hand before re-running.`,
    ]);
  }
  if (release?.tagName !== verdict.reference || typeof release?.body !== 'string' || release.body.trim() === '') {
    return failedPublish('The reference was published without its note', [
      `Reading \`${verdict.reference}\` back found tag ${JSON.stringify(release?.tagName ?? null)} and a note of ${String(release?.body ?? '').trim().length} characters.`,
      'A reference without its note is one a caller cannot adopt safely. This run reports nothing as published; the release needs a human.',
    ]);
  }

  const tagged = await run(readTag.command, readTag.args);
  if (!tagged.ok) {
    return failedPublish('The outcome of the publish could not be read', [
      `\`${verdict.reference}\` exists, but the commit it names could not be read, so this run cannot prove it names the commit it published.`,
      (tagged.stderr ?? '').trim(),
      `Nothing is reported as published. Look at \`${verdict.reference}\` by hand before re-running.`,
    ]);
  }
  const sha = (tagged.stdout ?? '').trim();
  if (sha !== verdict.commit) {
    return failedPublish('The reference does not name the commit this run published', [
      `\`${verdict.reference}\` names \`${sha || '(nothing readable)'}\` where this run published \`${verdict.commit}\`.`,
      'It is left exactly as it is: this path never re-points a published reference. A human decides what happened.',
    ]);
  }

  return {
    published: true,
    failing: false,
    title: `Published ${verdict.reference}`,
    message: [
      `\`${verdict.reference}\` names commit \`${verdict.commit}\` and carries its note.`,
      `Callers adopt it by editing their own \`uses:\` line to \`@${verdict.reference}\`.`,
    ].join('\n'),
  };
}

function failedPublish(title, lines) {
  return { published: false, failing: true, title, message: lines.filter(Boolean).join('\n') };
}

// ---------------------------------------------------------------------------
// Gathering the facts: git, and nothing but git
// ---------------------------------------------------------------------------

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, env?: any}} [options]
 */
export function runCommand(command, args, options = {}) {
  const { cwd = process.cwd(), timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, env = process.env } = options;
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, env, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, status: error.code ?? 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? error.message) });
        return;
      }
      resolve({ ok: true, status: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * The six interfaces and every state file, read out of one commit or tag.
 *
 * Read from the OBJECT DATABASE rather than from the working tree, on both sides, so the two
 * snapshots are compared on the same terms and an untracked file on the runner can never enter a
 * digest.
 * @param {string} ref
 * @param {(args: string[]) => Promise<any>} git
 */
export async function gatherState(ref, git) {
  const listed = await git(['ls-tree', '-r', '--name-only', ref, '--', '.github/workflows', 'scripts']);
  if (!listed.ok) {
    return { ok: false, reason: `the tree at ${ref} could not be listed: ${(listed.stderr ?? '').trim()}` };
  }
  const paths = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && isStateFile(line))
    .sort();

  /** @type {{path:string,digest:string}[]} */
  const files = [];
  /** @type {Map<string,string>} */
  const contents = new Map();
  for (const file of paths) {
    const shown = await git(['show', `${ref}:${file}`]);
    if (!shown.ok) {
      return { ok: false, reason: `${file} could not be read at ${ref}: ${(shown.stderr ?? '').trim()}` };
    }
    files.push({ path: file, digest: digestOf(shown.stdout) });
    contents.set(file, shown.stdout);
  }

  const workflows = REUSABLE_WORKFLOWS.map((name) => {
    const file = `.github/workflows/${name}`;
    const text = contents.get(file);
    if (text === undefined) {
      return { name, read: { ok: false, absent: true, reason: `the file \`${file}\` is absent` } };
    }
    return { name, read: readWorkflowInterface(text, name) };
  });

  return { ok: true, state: { files, workflows } };
}

/** Every published reference name, from the tags in the checkout and from the releases on GitHub. */
export async function gatherReferences({ git, gh }) {
  const shallow = await git(['rev-parse', '--is-shallow-repository']);
  if (!shallow.ok) {
    return { ok: false, reason: `git could not say whether this checkout is shallow: ${(shallow.stderr ?? '').trim()}` };
  }
  if (shallow.stdout.trim() !== 'false') {
    return {
      ok: false,
      reason:
        'this checkout is shallow, so the tags this decision compares against may simply be missing. Fetch them (`fetch-depth: 0`) rather than publishing a second reference for a state that already has one',
    };
  }

  // Newest first, and DETERMINISTIC when two references share a creation date: for-each-ref makes
  // the LAST `--sort` the primary key, so this is "by creation date, then by name". These are the
  // lightweight tags `gh release create` mints, so `creatordate` is the tagged commit's committer
  // date rather than anything the tag itself records; two commits landing in the same second is not
  // exotic on a busy default branch, and the name tie-break is there so that "whichever git happened
  // to list first" is never what decides who a caller is compared against.
  const tagged = await git([
    'for-each-ref',
    '--sort=-refname',
    '--sort=-creatordate',
    '--format=%(refname:strip=2)',
    `refs/tags/${REFERENCE_PREFIX}*`,
  ]);
  if (!tagged.ok) {
    return { ok: false, reason: `the tags in this checkout could not be listed: ${(tagged.stderr ?? '').trim()}` };
  }
  // The glob is a prefix, and a reference is a NAME THIS PATH MINTED: `workflows-YYYY-MM-DD-<12
  // hex>`. Anything else under the prefix is somebody's hand-made tag (`workflows-old`), and taking
  // one as the baseline would compare a caller against a state this path never published, or refuse
  // on every later push because the six do not parse there. It is left strictly alone: not listed,
  // not moved, not deleted.
  const local = tagged.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => REFERENCE_PATTERN.test(line));

  const listed = await gh(['release', 'list', '--limit', '200', '--json', 'tagName']);
  if (!listed.ok) {
    return { ok: false, reason: `the releases already published could not be listed: ${(listed.stderr ?? '').trim()}` };
  }
  let releases;
  try {
    releases = JSON.parse(listed.stdout || '[]');
  } catch {
    return { ok: false, reason: 'the list of releases already published was not JSON, so this run cannot tell which names are taken' };
  }
  if (!Array.isArray(releases)) {
    return { ok: false, reason: 'the list of releases already published was not a list' };
  }
  // Same filter as the tags, and for the same reason: a release named anything else was not
  // published by this path, so it is neither a baseline nor a name this path could ever collide
  // with. Every name this path mints matches the pattern, so nothing that could collide is dropped.
  const remote = releases.map((release) => String(release?.tagName ?? '')).filter((name) => REFERENCE_PATTERN.test(name));

  // A release whose tag is not in this checkout means the checkout cannot see what is published, and
  // publishing from it risks minting a second name for a state that already has one.
  const missing = remote.filter((name) => !local.includes(name));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} published on GitHub but absent from this checkout's tags, so this run cannot see what it is comparing against`,
    };
  }

  return { ok: true, local, published: [...new Set([...local, ...remote])] };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE =
  'usage:\n' +
  '  reference-publish.mjs [--repo <dir>] [--commit <sha>] [--repository <owner/name>] [--dry-run]\n' +
  '  GITHUB_SHA and GITHUB_REPOSITORY are read when the flags are absent.\n';

/** @param {string[]} argv */
export function parseArgv(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    if (token === '--dry-run') {
      options['dry-run'] = 'true';
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    options[token.slice(2)] = value;
    i += 1;
  }
  return options;
}

/** @param {any} verdict */
export function renderAnnotation(verdict) {
  const level = verdict.failing ? 'error' : 'notice';
  const first = String(verdict.message).split('\n')[0];
  return `::${level} title=${verdict.title}::${first}`;
}

/** @param {{title:string,message:string}} verdict */
export function renderSummary(verdict) {
  return [`### ${verdict.title}`, '', ...String(verdict.message).split('\n'), ''].join('\n');
}

/**
 * @param {string[]} argv
 * @param {object} io
 */
export async function main(argv, io = {}) {
  const {
    env = process.env,
    stdout,
    stderr,
    appendFile = appendFileSync,
    run = runCommand,
    writeNote,
  } = io;
  const out = stdout ?? ((/** @type {string} */ text) => process.stdout.write(text));
  const err = stderr ?? ((/** @type {string} */ text) => process.stderr.write(text));

  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }

  const repo = options.repo || '.';
  const dryRun = options['dry-run'] === 'true';
  const repository = options.repository || env.GITHUB_REPOSITORY || '';
  const git = (/** @type {string[]} */ args) => run('git', args, { cwd: repo, env });
  const gh = (/** @type {string[]} */ args) => run('gh', args, { cwd: repo, env });

  const requested = options.commit || env.GITHUB_SHA || 'HEAD';
  const resolved = await git(['rev-parse', '--verify', `${requested}^{commit}`]);
  if (!resolved.ok) {
    return report(
      refusal('The commit to publish could not be resolved', [
        `Refusing to publish a reference: \`${requested}\` does not resolve to a commit in this checkout.`,
        (resolved.stderr ?? '').trim(),
      ]),
      { out, err, env, appendFile },
    );
  }
  const commit = resolved.stdout.trim();

  const dated = await git(['show', '--no-patch', '--format=%cd', '--date=format:%Y-%m-%d', commit]);
  if (!dated.ok) {
    return report(
      refusal('The commit date could not be read', [
        `Refusing to publish a reference: the date of \`${commit}\` could not be read, and it is half of the reference name.`,
        (dated.stderr ?? '').trim(),
      ]),
      { out, err, env, appendFile },
    );
  }
  const date = dated.stdout.trim();

  const references = await gatherReferences({ git, gh });
  if (!references.ok) {
    return report(
      refusal('What has already been published could not be read', [
        `Refusing to publish a reference: ${references.reason}.`,
        'Guessing that nothing is published mints a second name for a state that already has one, which is the defect this whole path exists to avoid.',
      ]),
      { out, err, env, appendFile },
    );
  }

  const currentState = await gatherState(commit, git);
  if (!currentState.ok) {
    return report(
      refusal('The state at this commit could not be read', [
        `Refusing to publish a reference: ${currentState.reason}.`,
      ]),
      { out, err, env, appendFile },
    );
  }

  /** @type {any} */
  let previous = null;
  const previousReference = references.local[0];
  if (previousReference) {
    const previousCommit = await git(['rev-parse', '--verify', `${previousReference}^{commit}`]);
    if (!previousCommit.ok) {
      return report(
        refusal('The earlier reference could not be read', [
          `Refusing to publish a reference: \`${previousReference}\` does not resolve to a commit in this checkout.`,
          (previousCommit.stderr ?? '').trim(),
        ]),
        { out, err, env, appendFile },
      );
    }
    const previousState = await gatherState(previousReference, git);
    if (!previousState.ok) {
      return report(
        refusal('The state at the earlier reference could not be read', [
          `Refusing to publish a reference: ${previousState.reason}.`,
        ]),
        { out, err, env, appendFile },
      );
    }
    previous = {
      reference: previousReference,
      commit: previousCommit.stdout.trim(),
      files: previousState.state.files,
      workflows: previousState.state.workflows,
    };
  }

  const verdict = decide({
    current: { commit, date, files: currentState.state.files, workflows: currentState.state.workflows },
    previous,
    existingReferences: references.published,
  });

  if (verdict.action !== 'publish' || dryRun) {
    if (dryRun && verdict.action === 'publish') {
      out(`--dry-run: nothing was published.\n\nThe note would have been:\n\n${verdict.note}\n`);
    }
    return report(verdict, { out, err, env, appendFile });
  }

  const outcome = await executePublish(verdict, {
    run: (/** @type {string} */ command, /** @type {string[]} */ args) => run(command, args, { cwd: repo, env }),
    writeNote:
      writeNote ??
      ((/** @type {string} */ note) => {
        const dir = mkdtempSync(path.join(tmpdir(), 'reference-note-'));
        const file = path.join(dir, 'note.md');
        writeFileSync(file, note, 'utf8');
        return file;
      }),
    repository,
  });

  return report(
    {
      action: outcome.published ? 'publish' : 'refused',
      failing: outcome.failing,
      title: outcome.title,
      message: outcome.message,
      outputs: {
        action: outcome.published ? 'publish' : 'refused',
        reference: outcome.published ? verdict.reference : '',
        commit: outcome.published ? verdict.commit : '',
      },
    },
    { out, err, env, appendFile },
  );
}

function report(verdict, { out, err, env, appendFile }) {
  out(`action: ${verdict.action}\n${verdict.message}\n`);
  out(`${renderAnnotation(verdict)}\n`);
  if (env.GITHUB_OUTPUT) {
    const lines = Object.entries(verdict.outputs ?? {}).map(([key, value]) => `${key}=${value}`);
    appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFile(env.GITHUB_STEP_SUMMARY, `${renderSummary(verdict)}\n`);
  }
  if (verdict.failing) err(`${verdict.message}\n`);
  return verdict.failing ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main(process.argv.slice(2));
}
