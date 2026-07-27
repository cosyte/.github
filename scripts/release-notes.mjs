#!/usr/bin/env node
//
// Derive a GitHub release body from what a release actually shipped, and refuse to publish a
// release body that says nothing or that leaks internal project bookkeeping onto a public surface.
//
// SOURCE. The changeset files the "Version Packages" PR consumed. Each is a human-written summary
// of one change, they are what drove the version bump, and the version commit deletes them, so they
// are recovered from that commit's diff. That is why the release workflow checks out with
// `fetch-depth: 0`.
//
// WHY BOTH TRANSLATE AND REFUSE. `documentation/conventions.md` puts it as "a translation at the
// boundary, not a deletion": phase and item identifiers belong in the changeset, CHANGELOG.md, the
// commit, and the roadmap, and must never reach a release body. So the renderer translates, and the
// gate then proves the translation worked and FAILS the run if anything banned survived. The gate is
// not decorative: the translator keys on a fixed list of project prefixes, so a prefix nobody has
// added yet gets through it, and the gate is what stops that reaching the public. Stripping is
// never silent: every rewrite and every dropped change is printed.
//
// Two entry points, deliberately separate:
//
//   prepare  derive the body from git and write it to a file (fails if it cannot be derived)
//   assert   read a file back and prove its BYTES are fit to publish
//
// `assert` knows nothing about how the file was produced. Run it on the exact file about to be
// handed to `gh release create`. A check that confirms "we called the renderer" passes when the
// renderer returns nothing, which is the defect this whole script exists to remove.
//
// Exit codes: 0 ok, 1 the release notes are not fit to publish, 2 bad usage.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

// Written as an escape on purpose: this file must not itself contain the character it bans.
const EM_DASH = '\u2014';

/** GitHub rejects a release body longer than this. */
const MAX_BODY_CHARS = 125000;
/** A change entry shorter than this is not a description of anything. */
const MIN_ENTRY_CHARS = 12;
/** All change entries together must carry at least this much text. */
const MIN_TOTAL_CHARS = 20;

/** The body used when a version shipped nothing a consumer of the package can observe. */
const INTERNAL_ONLY_BODY = 'Internal tooling and CI only. No change to the published package surface.';

class NotesError extends Error {}

// ---------------------------------------------------------------------------------------------
// The banned set: internal project bookkeeping that must never reach a public release body
// ---------------------------------------------------------------------------------------------

// Known project and programme prefixes. THE KEYING IS ON THESE PREFIXES, NEVER ON THE `WORD-N`
// SHAPE, and that distinction is the whole game: `MLLP-10` is one of ours, but `SCH-11`, `PID-3`,
// `MSH-2`, `NM1-03`, `OBX-5` are HL7 and X12 segment-field references and are exactly the reference
// material a consumer needs. A shape-based rule destroys them. Add to this list when a new
// programme starts; the gate below is what catches the window before you do.
const PROJECT_PREFIXES = [
  'DOCS-CONTENT',
  'KNOWLEDGEBASE',
  'TERMINOLOGY',
  'PATHWAYS',
  'TRANSFORM',
  'WEBSITE',
  'STAGING',
  'SUPPLY',
  'NCPDP',
  'ASSETS',
  'EMDASH',
  'README',
  'CONFIG',
  'DICOM',
  'SYNTH',
  'DEID',
  'CCDA',
  'ASTM',
  'MLLP',
  'FHIR',
  'CREW',
  'DOCS',
  'PERF',
  'SYNC',
  'VERSION',
  'PUBLIC',
  'HL7',
  'X12',
  'IAC',
  'CLI',
  'KB',
  'PW',
  'PUB',
  'CI',
  'REAL',
];

// CASE SENSITIVE, and the segment after the hyphen must start uppercase. That is what lets
// `FHIR-bridge` and `docs-content/` through: they are legitimate content, and a case-insensitive
// rule flags them as violations.
// The second alternative is our internal priority label ("P0 safety", "P1 documentation"). It is
// narrowed by a lookahead on purpose: ASTM `P` records and bare `P1`-style field references must
// survive, so only the label's own trailing context counts as a match.
const INTERNAL_ID = new RegExp(
  String.raw`\b(?:${PROJECT_PREFIXES.join('|')})(?:-[A-Z0-9][A-Z0-9.]*)+\b` +
    String.raw`|\bP\d+\b(?= safety| documentation|$|[,)])`,
);

const ORDINAL =
  String.raw`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|` +
  String.raw`thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|` +
  String.raw`twenty-first|twenty-second|twenty-third|twenty-fourth|\d+(?:st|nd|rd|th))`;

// Phase and slice language. Note `Phase 5b` and `Phase W`: a digits-only pattern misses both, and
// the ordinal forms ("thirteenth slice", "second wave") are ours too. The negative lookahead keeps
// ordinary English off the list, so "in phase with the source system" survives.
const PHASE_TALK = new RegExp(
  String.raw`\b(?:roadmap phase\b[ ]?[A-Za-z0-9]*|` +
    String.raw`phase (?!of\b|with\b|in\b|out\b|the\b|and\b|is\b|for\b|to\b)[A-Za-z0-9]+[a-z]?\b|` +
    String.raw`wave \d+\b|the \w+ and final phase\b|documentation residual\b|` +
    String.raw`${ORDINAL} (?:slice|wave)\b)`,
  'i',
);

const ADR_REFERENCE = /\bADR[ -]?\d{3,4}\b/i;

// `slice` is our internal word for a unit of work, and a reader does not have it. But it is ALSO
// real clinical vocabulary: a DICOM study has slices, with a slice thickness, a slice location, and
// slice spacing. Rewriting those to "change" would corrupt the meaning of a @cosyte/dicom release
// note, so this keys on the determiner forms that are unambiguously ours ("this slice", "the final
// slice") and excludes the imaging nouns. Ordinal forms are handled by PHASE_TALK above. A bare
// `slice` is deliberately NOT flagged: on this suite that word is more often the reader's than ours.
// Grounded in @cosyte/dicom's own generated tag dictionary: SliceThickness, SliceLocation,
// SpacingBetweenSlices, SliceVector, NumberOfSlices, TimeSliceVector, SliceProgressionDirection,
// SliceSensitivityFactor.
const IMAGING_NOUNS =
  'thickness|location|spacing|position|interval|order|number|index|gap|count|data|pixel|' +
  'orientation|plane|direction|width|vector|sensitivity|progression|factor';
// A modifier may sit between the determiner and the noun ("the misfiling-prevention slice"), but a
// preposition may not: "the Number of Slices" is a DICOM attribute, not one of our units of work.
const OUR_JARGON = new RegExp(
  String.raw`\b(?:this|that|the|each|another|previous|next|final|current)\s+` +
    String.raw`(?:(?!(?:of|in|on|between|per|for|to|with|at)\s)[\w-]+\s+){0,2}` +
    String.raw`slices?\b(?!\s+(?:${IMAGING_NOUNS}))`,
  'i',
);

/** Every banned-content rule, applied to a finished body. Order is the order they are reported. */
const CONTENT_RULES = [
  { name: 'internal project identifier', pattern: INTERNAL_ID },
  { name: 'phase or slice language', pattern: PHASE_TALK },
  { name: 'ADR reference', pattern: ADR_REFERENCE },
  { name: 'internal jargon ("slice")', pattern: OUR_JARGON },
  { name: 'em dash (U+2014)', pattern: new RegExp(EM_DASH) },
];

// Changes a consumer of the published package cannot observe. A release note lists what changed FOR
// THE READER, so these are dropped from the note entirely rather than reworded. Founder, on seeing
// the em-dash gate in hl7's notes: "The em dash gate does not need to be shown to the consumers
// either. That should be internal and not something brought to the users attention."
const INTERNAL_ONLY_CHANGE = new RegExp(
  [
    String.raw`\bem[- ]dash\b`,
    String.raw`check-no-emdash`,
    String.raw`\bbrand gate\b`,
    String.raw`\bcommit[- ]scanner\b`,
    String.raw`\bphi-scan\b`,
    String.raw`\bcommit gate\b`,
    String.raw`\bsync-version\b`,
    String.raw`sync-version\.mjs`,
    String.raw`\bCodeQL\b`,
    String.raw`\bScorecard\b`,
    String.raw`\bactionlint\b`,
    String.raw`\bcaller workflows?\b`,
    String.raw`\bDependabot\b`,
    String.raw`\bdev-dependency\b`,
    String.raw`\bno runtime impact\b`,
    String.raw`\btrademark notice\b`,
    String.raw`\bpublish[- ]status\b`,
    String.raw`\bstatus line\b`,
    String.raw`\bstatus banner\b`,
    String.raw`\bREADME status\b`,
    String.raw`\brelocat(?:e|ed|ing) .*tests?\b`,
    String.raw`\bcoverage[- ]relaxation\b`,
    String.raw`\bDictionary Regen\b`,
    String.raw`\bworkflow\b.*\bred since\b`,
    String.raw`\bphase log\b`,
  ].join('|'),
  'i',
);

/** False when the change cannot be observed by someone installing the package. */
export function isConsumerFacing(headline) {
  return !INTERNAL_ONLY_CHANGE.test(headline);
}

// ---------------------------------------------------------------------------------------------
// Translation at the boundary
// ---------------------------------------------------------------------------------------------

/**
 * First sentence of a changeset, flattened to one line.
 *
 * When a changeset opens with a sentence longer than the cap, the headline is cut at the last word
 * boundary rather than mid-word: "Allergy-Intolera" on a public release page is exactly the kind of
 * unprofessional detail this whole change exists to remove.
 */
export function headlineOf(text) {
  let t = String(text).trim().split(/\s+/).join(' ');
  t = t.replace(/^\*\*(.+?)\*\*[.:]?\s*/, '$1. '); // a leading bold lead-in is the headline
  // The `\*{0,2}` matters: changesets here routinely end a sentence inside emphasis, as in
  // "**the record-content layer is now feature-complete.**". Requiring whitespace straight after the
  // full stop misses that, runs past a perfectly good sentence, and truncates at the character cap.
  const sentence = /^(.{0,200}?[.!?]\*{0,2})(\s|$)/.exec(t);
  if (sentence) return sentence[1].trim().replace(/\.+$/, '');
  if (t.length <= 200) return t.trim().replace(/\.+$/, '');
  const cut = t.slice(0, 200);
  const lastSpace = cut.lastIndexOf(' ');
  let head = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim().replace(/[\s,;:.-]+$/, '');
  // A cut that lands on a dangling function word reads as a mistake ("and `reescape` emits a."),
  // so walk back to the last word that carries meaning.
  const DANGLING =
    /(^|\s)(a|an|the|and|or|of|to|in|on|for|with|that|which|into|from|as|at|by|is|are|was|were|be|been|its|it|this|these|those|but|so|then|than|per|via|no|not)$/i;
  for (let i = 0; i < 6 && DANGLING.test(head); i += 1) {
    head = head.slice(0, head.lastIndexOf(' ')).replace(/[\s,;:.-]+$/, '');
  }
  return head;
}

function stripInternal(segment) {
  return segment
    .replace(new RegExp(INTERNAL_ID.source, 'g'), '')
    .replace(new RegExp(PHASE_TALK.source, 'gi'), '')
    .replace(new RegExp(ADR_REFERENCE.source, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .replace(new RegExp(`^[\\s,;:.\\-${EM_DASH}]+|[\\s,;:.\\-${EM_DASH}]+$`, 'g'), '');
}

/**
 * Remove internal identifiers, phase language, and ADR references.
 *
 * Parentheticals are handled whole. A parenthetical that carried an identifier usually carried
 * nothing else of value, and a cleaned fragment that lost its head reads worse than no parenthetical
 * at all: "(of the v2.4 capability arc)" is worse than nothing.
 */
export function sanitizeInternal(text) {
  let t = String(text).replace(/\s*\(([^()]*)\)/g, (whole, inner) => {
    if (!INTERNAL_ID.test(inner) && !PHASE_TALK.test(inner) && !ADR_REFERENCE.test(inner)) {
      return whole; // no internal reference: leave it exactly as the author wrote it
    }
    const kept = inner
      .split(',')
      .map(stripInternal)
      .filter((c) => c.length >= 8 && !/^(?:of|the|and|a|an|in|on|for|to|with|its|which|that)\b/i.test(c));
    return kept.length > 0 ? ` (${kept.join(', ')})` : '';
  });

  t = t.replace(new RegExp(INTERNAL_ID.source, 'g'), ''); // bare inline references
  t = t.replace(new RegExp(PHASE_TALK.source, 'gi'), '');
  t = t.replace(new RegExp(ADR_REFERENCE.source, 'gi'), '');
  t = t.replace(/\s+([,.;:])/g, '$1').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ');
  return t.replace(new RegExp(`^[\\s,;:.\\-${EM_DASH}]+|[\\s,;:.\\-${EM_DASH}]+$`, 'g'), '');
}

/**
 * The em-dash ban applies to release notes and is easy to miss, because this text is inherited from
 * changesets written before that gate existed. Rewrite, never delete: a leading "Label - clause"
 * takes a colon, an interior aside takes a comma.
 */
export function rewriteEmDashes(text) {
  const t = String(text);
  if (!t.includes(EM_DASH)) return t;
  const parts = t.split(EM_DASH).map((p) => p.trim());
  let out = parts[0];
  parts.slice(1).forEach((segment, i) => {
    const separator = i === 0 && out.length < 40 ? ': ' : ', ';
    out = out.replace(/[\s,;:]+$/, '') + separator + segment;
  });
  return out;
}

/**
 * Replace our internal word for a unit of work with one the reader has, in the determiner forms
 * that are unambiguously ours. See OUR_JARGON for why a blanket slice-to-change rewrite is wrong on
 * this suite.
 */
export function dejargon(text) {
  return String(text).replace(new RegExp(OUR_JARGON.source, 'gi'), (match) =>
    match.replace(/slices\b/i, 'changes').replace(/slice\b/i, 'change'),
  );
}

/**
 * Repair a headline whose head was removed along with an identifier.
 *
 * Decapitation is the trap: stripping from the FRONT leaves the fragment behind, and
 * "(thirteenth slice): builder emits X" is worse than the original. Drop a leading orphan
 * parenthetical, strip leading punctuation, and recapitalise. Leading digits are left alone:
 * `835`, `271`, and `837` open X12 headlines legitimately as transaction-set numbers.
 */
export function tidy(text) {
  let t = String(text);
  for (let i = 0; i < 4; i += 1) {
    t = t.trim();
    const before = t;
    t = t.replace(/^\(\s*\)\s*/, '').replace(new RegExp(`^[\\s,;:.\\-${EM_DASH}]+`), '');
    const orphan = /^\(([^()]*)\)\s*[:,-]?\s*(.+)$/s.exec(t);
    if (orphan && orphan[2].length > 12) {
      t = orphan[2];
      continue;
    }
    if (t === before) break;
  }
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '');
  if (t && /[a-z]/.test(t[0]) && !t.startsWith('`')) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

/**
 * Changeset text to a publishable one-line headline.
 *
 * @returns {{ headline: string, changed: boolean }} `changed` is true when translation altered it,
 *   which the caller prints so that stripping is never silent.
 */
export function toHeadline(text) {
  const raw = headlineOf(text);
  const headline = tidy(dejargon(rewriteEmDashes(sanitizeInternal(raw))));
  return { headline, raw, changed: headline !== raw };
}

// ---------------------------------------------------------------------------------------------
// Changesets
// ---------------------------------------------------------------------------------------------

/**
 * Parse one changeset file.
 *
 * @returns {{ id: string, releases: Array<{ name: string, type: string }>, summary: string }}
 */
export function parseChangeset(text, id) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) throw new NotesError(`${id}: not a changeset (no --- frontmatter block)`);

  const releases = [];
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const entry = /^["']?(@?[^"':]+)["']?\s*:\s*["']?([A-Za-z]+)["']?$/.exec(line);
    if (!entry) throw new NotesError(`${id}: unparseable frontmatter line: ${JSON.stringify(rawLine)}`);
    const type = entry[2].toLowerCase();
    if (!['major', 'minor', 'patch'].includes(type)) {
      throw new NotesError(`${id}: unknown bump type ${JSON.stringify(entry[2])}`);
    }
    releases.push({ name: entry[1].trim(), type });
  }
  return { id, releases, summary: normalized.slice(match[0].length).trim() };
}

/**
 * Turn the consumed changeset files into the headlines a reader should see.
 *
 * A consumed changeset with an empty summary throws: it is a change that shipped with no
 * description, and a release body that silently omits it would misrepresent what shipped.
 *
 * @returns {{ kept: string[], dropped: Array<{id, headline}>, rewritten: Array<{id, from, to}> }}
 */
export function collectHeadlines(files, packageName) {
  const kept = [];
  const dropped = [];
  const rewritten = [];

  for (const file of files) {
    const changeset = parseChangeset(file.text, file.id);
    if (!changeset.releases.some((r) => r.name === packageName)) continue;
    if (changeset.summary === '') {
      throw new NotesError(
        `${file.id}: consumed by this release but its summary is empty. Every changeset must ` +
          `describe its change; an empty one cannot be reported to users.`,
      );
    }

    const { headline, raw, changed } = toHeadline(changeset.summary);
    if (headline === '') {
      throw new NotesError(
        `${file.id}: nothing is left of ${JSON.stringify(raw)} after removing internal project ` +
          `bookkeeping. Rewrite the changeset so its first sentence says what changed for a reader.`,
      );
    }
    if (changed) rewritten.push({ id: file.id, from: raw, to: headline });
    if (isConsumerFacing(headline)) kept.push(headline);
    else dropped.push({ id: file.id, headline });
  }

  return { kept, dropped, rewritten };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/**
 * Render the release body.
 *
 * The reader is already in the repo looking at the tag, so there is no preamble and no count: the
 * list is right there. Attached artifacts are not explained in terms of our own docs pipeline.
 */
export function renderNotes({ packageName, version, headlines, dropped = [], repoSlug, serverUrl = 'https://github.com' }) {
  if (!packageName) throw new NotesError('renderNotes: packageName is required');
  if (!version) throw new NotesError('renderNotes: version is required');
  if (headlines.length === 0 && dropped.length === 0) {
    throw new NotesError(
      `renderNotes: no changes to report for ${packageName}@${version}. A release body must ` +
        `describe what shipped; there is nothing to describe.`,
    );
  }

  const out = ['### What changed', ''];
  if (headlines.length === 0) {
    // Every change in this version was internal. Say exactly that rather than padding.
    out.push(INTERNAL_ONLY_BODY);
  } else {
    // Only add the full stop when the headline does not already end in one, which happens when the
    // author's sentence closed inside emphasis ("**...feature-complete.**").
    for (const headline of headlines) out.push(`- ${headline}${/[.!?]\**$/.test(headline) ? '' : '.'}`);
    if (repoSlug) {
      out.push('');
      out.push(
        `Full detail for each change is in [\`CHANGELOG.md\`](${serverUrl}/${repoSlug}/blob/main/CHANGELOG.md).`,
      );
    }
  }

  out.push('', '### Install', '', '```bash', `npm install ${packageName}@${version}`, '```', '');
  out.push(`**npm:** https://www.npmjs.com/package/${packageName}/v/${version}`);
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

/**
 * Extract the change entries from a rendered body, working only from the text.
 *
 * This deliberately re-parses the markdown instead of trusting anything the renderer recorded. If
 * the body carries no per-change prose, there is nothing here to find, whatever produced it.
 */
export function extractChangeEntries(body) {
  const lines = String(body).replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  let inSection = false;
  let current = null;

  const flush = () => {
    if (current !== null) {
      const joined = current.join('\n').trim();
      if (joined !== '') entries.push(joined);
      current = null;
    }
  };

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      flush();
      inSection = /^###\s+what changed\s*$/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const item = /^-\s+(.*)$/.exec(line);
    if (item) {
      flush();
      current = [item[1]];
    } else if (current !== null) {
      if (line.trim() === '') current.push('');
      else if (/^\s{2,}/.test(line)) current.push(line.trim());
      else flush();
    }
  }
  flush();
  return entries;
}

/** True when the body is the honest "nothing a consumer can see shipped" statement. */
function isInternalOnlyDeclaration(body) {
  const section = /###\s+what changed\s*\n+([\s\S]*?)(?=\n###\s|\n*$)/i.exec(String(body));
  return section !== null && section[1].trim() === INTERNAL_ONLY_BODY;
}

/** Text stripped of markdown noise. Code-span CONTENT is kept: an API name is substance. */
function prose(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`/g, '')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/[*_#>[\]()|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Phrases that have been used as a stand-in for real release notes. */
const STUB_PATTERNS = [
  /^automated release of\b/i,
  /^release v?\d+(?:\.\d+)*\.?$/i,
  /^v?\d+\.\d+\.\d+\.?$/,
  /^(?:no|minor|misc\.?|various)\s+(?:changes?|updates?|fixes)\.?$/i,
  /^(?:tbd|todo|n\/?a|wip|placeholder|changelog)\.?$/i,
  /^bump(?:ed)? versions?(?: to [\d.]+)?\.?$/i,
  /^update dependencies\.?$/i,
];

function looksLikeStub(text) {
  const candidate = prose(text);
  return STUB_PATTERNS.some((pattern) => pattern.test(candidate));
}

/**
 * Find banned content in a finished body, with the offending line named.
 *
 * @returns {Array<{ rule: string, line: number, text: string, match: string }>}
 */
export function findViolations(body) {
  const violations = [];
  const lines = String(body).replace(/\r\n/g, '\n').split('\n');
  const entries = new Set(extractChangeEntries(body));

  lines.forEach((line, i) => {
    for (const rule of CONTENT_RULES) {
      const found = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '')).exec(line);
      if (found) violations.push({ rule: rule.name, line: i + 1, text: line.trim(), match: found[0] });
    }
    // A change a consumer cannot observe should have been dropped, not reworded.
    const item = /^-\s+(.*)$/.exec(line);
    if (item && entries.has(item[1].trim()) && !isConsumerFacing(item[1])) {
      const found = INTERNAL_ONLY_CHANGE.exec(item[1]);
      violations.push({
        rule: 'change a consumer of the package cannot observe',
        line: i + 1,
        text: line.trim(),
        match: found ? found[0] : item[1],
      });
    }
  });
  return violations;
}

/**
 * Prove a release body is fit to publish. Content only: no knowledge of the renderer.
 *
 * @returns {string[]} problems; empty means publishable
 */
export function assertPublishableNotes(body, { expectVersion, expectPackage } = {}) {
  const problems = [];
  const text = String(body ?? '');

  if (text.trim() === '') {
    problems.push('the release body is empty');
    return problems;
  }

  if (text.length > MAX_BODY_CHARS) {
    problems.push(
      `the release body is ${text.length} characters; GitHub rejects anything over ${MAX_BODY_CHARS}`,
    );
  }

  if (looksLikeStub(text)) {
    problems.push(
      `the release body as a whole is a stub, not release notes: ${JSON.stringify(text.trim().slice(0, 120))}`,
    );
  }

  const internalOnly = isInternalOnlyDeclaration(text);
  const entries = extractChangeEntries(text);

  if (entries.length === 0 && !internalOnly) {
    problems.push(
      'the release body describes no changes: it has no "### What changed" section with list items, ' +
        'and it does not declare that this version shipped nothing a consumer can observe',
    );
  }

  let total = 0;
  entries.forEach((entry, i) => {
    const said = prose(entry);
    total += said.length;
    if (said.length < MIN_ENTRY_CHARS) {
      problems.push(
        `change entry ${i + 1} says nothing (${said.length} characters, minimum ${MIN_ENTRY_CHARS}): ` +
          JSON.stringify(entry.slice(0, 80)),
      );
    } else if (looksLikeStub(entry)) {
      problems.push(`change entry ${i + 1} is a stub: ${JSON.stringify(entry.slice(0, 80))}`);
    }
  });

  if (entries.length > 0 && total < MIN_TOTAL_CHARS) {
    problems.push(
      `the release body carries only ${total} characters describing changes (minimum ${MIN_TOTAL_CHARS})`,
    );
  }

  for (const violation of findViolations(text)) {
    problems.push(
      `line ${violation.line} carries ${violation.rule} (${JSON.stringify(violation.match)}): ` +
        JSON.stringify(violation.text.slice(0, 100)),
    );
  }

  // The notes are derived from git; the version that reached npm is reported by Changesets. If the
  // two disagree, the body describes a different release than the one being tagged.
  if (expectVersion && expectPackage) {
    const stamp = `npm install ${expectPackage}@${expectVersion}`;
    if (!text.includes(stamp)) {
      problems.push(`the release body is not about ${expectPackage}@${expectVersion} (no "${stamp}" in it)`);
    }
  } else if (expectVersion && !text.includes(expectVersion)) {
    problems.push(`the release body never mentions version ${expectVersion}`);
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------
// git recovery
// ---------------------------------------------------------------------------------------------

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function gitOrNull(repo, args) {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

function packageVersionAt(repo, rev) {
  const raw = gitOrNull(repo, ['show', `${rev}:package.json`]);
  if (raw === null) return null;
  try {
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the commit that introduced `version` into package.json.
 *
 * Anchoring on the VERSION rather than on HEAD matters. The publish does not always happen on the
 * version commit itself: if a version-commit run fails anywhere before `changeset publish` (a test
 * flake, an approval timeout), the next push to main is what publishes, and by then HEAD is an
 * ordinary commit. Deriving from HEAD would find nothing there and the release would be skipped or
 * fail after npm already had the package.
 */
export function findVersionCommit(repo, version) {
  const shas = git(repo, ['log', '--format=%H', '--', 'package.json']).split('\n').filter(Boolean);
  for (const sha of shas) {
    if (packageVersionAt(repo, sha) !== version) continue;
    const parent = gitOrNull(repo, ['rev-parse', '--verify', '--quiet', `${sha}^`]);
    if (parent === null) return { sha, previousVersion: null, hasParent: false };
    if (packageVersionAt(repo, `${sha}^`) !== version) {
      return { sha, previousVersion: packageVersionAt(repo, `${sha}^`), hasParent: true };
    }
  }
  return null;
}

/**
 * Work out whether there is a pending release and, if so, what it consumed.
 *
 * A release is pending when the version in package.json has no `v<version>` tag yet. That is
 * exactly when `changeset publish` will publish, so the gate and the publish agree on what is
 * happening without either guessing.
 */
export function inspectRelease(repo, packageName) {
  const version = packageVersionAt(repo, 'HEAD');
  if (version === null) return { isRelease: false, reason: 'no readable package.json at HEAD' };

  if (gitOrNull(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`]) !== null) {
    return { isRelease: false, reason: `v${version} is already tagged, so no release is pending` };
  }

  const commit = findVersionCommit(repo, version);
  if (commit === null) {
    return { isRelease: false, reason: `no commit introduces version ${version}` };
  }
  if (!commit.hasParent) {
    throw new NotesError(
      `version ${version} was introduced by the repository's first commit, so no changesets were ` +
        `consumed and there is no record of what shipped.`,
    );
  }

  const consumed = git(repo, [
    'diff',
    '--diff-filter=D',
    '--name-only',
    `${commit.sha}^`,
    commit.sha,
    '--',
    '.changeset',
  ])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\.changeset\/.+\.md$/.test(line) && !/\/README\.md$/i.test(line));

  if (consumed.length === 0) {
    throw new NotesError(
      `${packageName} moved from ${commit.previousVersion ?? '(none)'} to ${version} in ` +
        `${commit.sha.slice(0, 7)} but that commit consumed no changesets. Release notes are derived ` +
        `from the changesets a release consumes, so there is no record of what shipped. Refusing to ` +
        `publish a release that cannot say what changed.`,
    );
  }

  const files = consumed.map((path) => ({
    id: path.replace(/^\.changeset\//, ''),
    text: git(repo, ['show', `${commit.sha}^:${path}`]),
  }));
  const collected = collectHeadlines(files, packageName);
  if (collected.kept.length === 0 && collected.dropped.length === 0) {
    throw new NotesError(
      `${commit.sha.slice(0, 7)} consumed ${consumed.length} changeset(s) but none name ${packageName}, ` +
        `so nothing can be attributed to ${packageName}@${version}.`,
    );
  }

  return { isRelease: true, version, sha: commit.sha, consumed, ...collected };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgv(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new NotesError(`unexpected argument ${JSON.stringify(arg)}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new NotesError(`--${key} needs a value`);
    i += 1;
    options[key] = value;
  }
  return options;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function fail(message) {
  for (const line of String(message).split('\n')) process.stderr.write(`::error::${line}\n`);
  process.exit(1);
}

function cmdPrepare(options) {
  const repo = resolve(options.repo ?? '.');
  const packageName = options.package;
  if (!packageName) throw new NotesError('prepare: --package is required');
  if (!options.out) throw new NotesError('prepare: --out is required');

  const release = inspectRelease(repo, packageName);
  if (!release.isRelease) {
    process.stdout.write(`No release pending: ${release.reason}.\n`);
    setOutput('is-release', 'false');
    return;
  }

  // Stripping is never silent: everything translation removed or dropped is on the record.
  for (const { id, from, to } of release.rewritten) {
    process.stdout.write(`translated ${id}\n  from: ${from}\n    to: ${to}\n`);
  }
  for (const { id, headline } of release.dropped) {
    process.stdout.write(`dropped ${id} as not observable by a consumer: ${headline}\n`);
  }

  const body = renderNotes({
    packageName,
    version: release.version,
    headlines: release.kept,
    dropped: release.dropped,
    repoSlug: options['repo-slug'] || process.env.GITHUB_REPOSITORY || undefined,
    serverUrl: options['server-url'] || process.env.GITHUB_SERVER_URL || 'https://github.com',
  });

  const problems = assertPublishableNotes(body, { expectVersion: release.version, expectPackage: packageName });
  if (problems.length > 0) {
    fail(
      [
        `Derived release notes for ${packageName}@${release.version} are not fit to publish:`,
        ...problems.map((p) => `  - ${p}`),
      ].join('\n'),
    );
  }

  const out = resolve(options.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  process.stdout.write(
    `Derived release notes for ${packageName}@${release.version} from ${release.consumed.length} ` +
      `consumed changeset(s) at ${release.sha.slice(0, 7)}: ${release.kept.length} reported, ` +
      `${release.dropped.length} internal-only.\nWritten to ${out} (${body.length} bytes).\n`,
  );
  setOutput('is-release', 'true');
  setOutput('version', release.version);
}

function cmdAssert(options) {
  if (!options.file) throw new NotesError('assert: --file is required');
  const file = resolve(options.file);
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    fail(`No release-notes file at ${file}. Refusing to create a release without derived notes.`);
    return;
  }
  const problems = assertPublishableNotes(body, {
    expectVersion: options['expect-version'],
    expectPackage: options['expect-package'],
  });
  if (problems.length > 0) {
    fail(
      [
        `${file} is not fit to be a GitHub release body:`,
        ...problems.map((p) => `  - ${p}`),
        'Refusing to create a release that does not say what changed, or that carries internal',
        'project bookkeeping onto a public surface.',
      ].join('\n'),
    );
  }
  const n = extractChangeEntries(body).length;
  process.stdout.write(
    n > 0
      ? `${file} carries ${n} described change(s) and no banned content. OK to publish.\n`
      : `${file} declares this version shipped nothing a consumer can observe. OK to publish.\n`,
  );
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(
      'usage:\n' +
        '  release-notes.mjs prepare --repo <dir> --package <name> --out <file> [--repo-slug <slug>]\n' +
        '  release-notes.mjs assert --file <file> [--expect-version <v>] [--expect-package <name>]\n',
    );
    process.exit(command ? 0 : 2);
  }
  let options;
  try {
    options = parseArgv(rest);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  try {
    if (command === 'prepare') cmdPrepare(options);
    else if (command === 'assert') cmdAssert(options);
    else {
      process.stderr.write(`unknown command ${JSON.stringify(command)}\n`);
      process.exit(2);
    }
  } catch (error) {
    if (error instanceof NotesError) fail(error.message);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2));
}
