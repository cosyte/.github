#!/usr/bin/env node
//
// Diff a PUBLISHED release body against the changesets the release consumed, and say, for each
// bullet, whether the sentence a reader sees is the sentence its author wrote.
//
// WHY THIS EXISTS. `release-notes.mjs` used to shorten an over-long opening sentence at the nearest
// word boundary and say nothing about it. That is fixed at the source: it refuses now. But the
// releases published before the fix are permanent, and nobody could agree how many of their bullets
// were cut. Three methods gave three answers on the same 18 releases:
//
//   - a count kept by hand while the fix was written:       14 across 7
//   - a mid-word-stub scan (`ORPHAN_STUMP` over the bodies):  6 across 5
//   - a prefix comparison against the source sentences:      25 across 9
//
// The stub scan is the only one whose every hit was checked by eye, and it is also the narrowest: it
// only sees a cut that landed INSIDE a word and left a single letter. A cut that landed on a clean
// word boundary produces well-formed prose, and well-formed prose is indistinguishable from a
// deliberately short sentence WITHOUT the author's original next to it. The prefix comparison did
// put the original next to it and over-fired, because the renderer legitimately removes an internal
// identifier from the end of a sentence, and a bullet with its trailing `(HL7-P3)` removed is a
// proper prefix of its source while being a complete sentence.
//
// SO THE WHOLE JOB OF THIS FILE IS TELLING THOSE TWO APART: content missing from the end of a bullet
// because a translation rule removed it (not a truncation) versus content missing because a length
// cut ate it (a truncation). It answers that by asking what the removed text IS, using the very
// rules the translator applies, rather than by measuring how much text is gone.
//
// IT IS A CLASSIFIER, NOT A REGENERATOR, and that is a deliberate limit rather than an unfinished
// feature. Re-deriving these bodies mechanically is impossible and known to be impossible: running
// `release-notes.mjs prepare` against the historical version commits REFUSES on six of them,
// because the source changesets' opening sentences are themselves over the 200-character cap, which
// is exactly why they were cut in the first place. A tool that emitted a replacement body would have
// to shorten those sentences, which is the original defect wearing a repair's clothes. Each one
// needs a human to write a shorter sentence that keeps the meaning. This file's output is the list
// of which ones, and the evidence for each.
//
// WHAT IT WILL NOT DECIDE FOR YOU. A `rewritten` bullet is one whose published text contains prose
// the changeset does not, so it was edited by hand on the release page and there is nothing left to
// derive it from; this file reports it and declines to grade it, rather than guessing. A `truncated`
// finding always ships with the missing tail quoted, because the point is for a person to read the
// author's sentence and write a shorter one, not to trust a count.
//
// Usage:
//
//   release-diff.mjs classify --repo <dir> --package <name> --tag <tag> [--body-file <f>] [--json]
//   release-diff.mjs sweep --repo <dir> --package <name> [--json]
//
// `classify` does one release; `sweep` does every release the repo has tags for. The published body
// comes from `--body-file` when given, and otherwise from `gh release view`. The changesets come
// from the tagged commit's own diff: a release tag points at the version commit, and that commit
// DELETED the changesets it consumed, so they are read from its parent.
//
// Exit codes: 0 nothing genuinely truncated, 1 at least one bullet is, 2 bad usage or unreadable
// input. Exit 1 is a report, not a gate: nothing in this repo's workflows runs this file. The gate
// that stops a new truncation is `release-notes.mjs`, upstream, at authoring time.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { TRANSLATION_RULES, extractChangeEntries, parseChangeset } from './release-notes.mjs';

class DiffError extends Error {}

/** Below this many characters of prose, a complete bullet is still worth showing a human. */
const SHORT_BULLET_CHARS = 60;
/** How much of a bullet must align with a changeset before the two are called a pair. */
const MATCH_THRESHOLD = 0.5;

// A full stop that does not end a sentence. Only the token the bullet ENDS on is ever tested
// against this, so the list needs to cover what a sentence can plausibly stop on, not every
// abbreviation in English.
const ABBREVIATIONS = new Set([
  'e.g.',
  'i.e.',
  'etc.',
  'vs.',
  'al.',
  'cf.',
  'ca.',
  'approx.',
  'no.',
  'fig.',
  'ver.',
  'inc.',
  'ltd.',
  'st.',
]);

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

/** Markdown that decorates a word without being part of it. Code-span CONTENT is kept: it is prose. */
const DECORATION = /[*_`"'“”‘’]/g;

// The dashes, as escapes: this repo's own files must not carry the character its release notes ban,
// and a character class is the one place it would otherwise sneak back in unread.
const DASHES = '\\u2014\\u2013';
const LEADING_PUNCTUATION = new RegExp(`^[([{<,;:.!?${DASHES}-]+`);
const TRAILING_PUNCTUATION = new RegExp(`[)\\]}>,;:.!?${DASHES}]+$`);

/**
 * Split text into comparable words.
 *
 * `key` is what alignment compares and `raw` is what a human reads back, and they are deliberately
 * different: emphasis, code fences and surrounding punctuation are noise for the comparison and
 * evidence for the report. Hyphens and slashes stay INSIDE a key, because `005010X222A2`,
 * `read-edit-write` and `ICD-9/ICD-10` are single words and splitting them would let a bullet align
 * against half of one.
 *
 * @returns {Array<{ raw: string, key: string, index: number }>}
 */
export function tokenize(text) {
  const out = [];
  const words = String(text).replace(/\r\n/g, '\n').split(/\s+/);
  for (const raw of words) {
    if (raw === '') continue;
    let key = raw
      .replace(DECORATION, '')
      // An empty argument list is decoration on a name, and the two spellings are used
      // interchangeably: a changeset writes `splitBatch()` where its release bullet writes
      // `splitBatch`. Left in, the two never align and the bullet reads as hand-written.
      .replace(/\(\)(?=[),;:.!?]*$)/, '')
      .replace(LEADING_PUNCTUATION, '')
      .replace(TRAILING_PUNCTUATION, '')
      .toLowerCase();
    // A token with nothing but punctuation in it is not a word, and letting it align is noise: a
    // stray `/` in `parse999` / `build999` would otherwise pair with any other stray `/`.
    if (!/[a-z0-9]/.test(key)) key = '';
    // `dejargon` rewrites our word for a unit of work to the reader's, so the published bullet says
    // `change` where its changeset said `slice`. Canonicalising both sides here is what stops that
    // one rewrite reading as a word the author never wrote at one end and a lost word at the other:
    // it is how "the misfiling-prevention slice." was reported as cut short by "slice".
    key = key.replace(/^slices$/, 'changes').replace(/^slice$/, 'change');
    out.push({ raw, key, index: out.length });
  }
  return out;
}

/**
 * True when this token closes a sentence rather than merely carrying a full stop.
 *
 * Only ever asked of the token a bullet STOPS on, which is why the abbreviation list can be short:
 * it has to cover what a sentence plausibly ends on, not every full stop in English. Getting this
 * wrong in the permissive direction hides a truncation; getting it wrong in the strict direction
 * invents one, and inventing one is what the prefix method already did, so the list is deliberately
 * generous about what counts as a sentence end and the report quotes the evidence either way.
 */
export function endsSentence(token) {
  const bare = String(token.raw).replace(DECORATION, '').replace(/[)\]}>]+$/, '');
  if (!/[.!?]$/.test(bare)) return false;
  // A single letter and a full stop is NOT excluded as an initial, and that is measured rather than
  // assumed. On this suite a sentence ends on one all the time: `...recorded as A, B, AB, or O.` is
  // a blood type and `...the `H`/`P`/`O`/`R`/`Q` records.` is the ASTM record grammar, both of them
  // sentences the item names as landmines. Excluding them reported a correct sentence as cut, which
  // is the mistake the prefix method already made 25 times, and the initial it would buy back
  // (`J. Smith`) does not end a release bullet.
  return !ABBREVIATIONS.has(bare.toLowerCase());
}

/**
 * A bullet whose last word is the front half of the changeset's next word.
 *
 * This is the only shape of truncation that is visible without the source, and it is what the
 * mid-word-stub scan caught: `...survives on \`X12Tra.` against `X12Transaction`. It is recognised
 * here so the half-word is read as a cut rather than as a word the author never wrote, which would
 * otherwise class the bullet as hand-edited and hide the very defect being counted.
 */
function isMidWordCut(bulletKey, sourceKey) {
  return (
    bulletKey.length >= 2 &&
    sourceKey.length > bulletKey.length &&
    sourceKey.startsWith(bulletKey)
  );
}

// ---------------------------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------------------------

/**
 * Longest common subsequence of two token key lists, as index pairs.
 *
 * A subsequence and not a prefix: the published bullet has words REMOVED from the middle of it as
 * well as from the end, and a prefix comparison cannot see the difference. That is the measured
 * over-fire this file exists to correct.
 *
 * @returns {Array<[number, number]>} pairs of [index in a, index in b]
 */
export function alignTokens(a, b) {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] && a[i] !== ''
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j] && a[i] !== '') {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

// ---------------------------------------------------------------------------------------------
// What a translation rule explains
// ---------------------------------------------------------------------------------------------

/**
 * True when every word in `text` is something the translator removes on purpose.
 *
 * THIS IS THE DISCRIMINATOR. Text missing from the end of a bullet is not a truncation when it is
 * an internal identifier, phase language, or an ADR reference, because the renderer is supposed to
 * remove those and the sentence it leaves behind is complete. It IS a truncation when real prose is
 * missing. So the question is never "how much is gone" but "what was it".
 *
 * The rules come from `release-notes.mjs` rather than being restated here, so a prefix added to the
 * translator's list is understood by this file on the same commit. A parenthetical is treated as
 * removed whole when it carries a banned span, which is what `sanitizeInternalDetailed` does.
 */
export function isExplainedRemoval(text, atHead = false) {
  let t = String(text);
  t = t.replace(/\(([^()]*)\)/g, (whole, inner) =>
    TRANSLATION_RULES.some((rule) => new RegExp(rule.pattern.source, rule.pattern.flags).test(inner)) ? ' ' : whole,
  );
  for (const rule of TRANSLATION_RULES) {
    const flags = rule.pattern.flags.includes('i') ? 'gi' : 'g';
    t = t.replace(new RegExp(rule.pattern.source, flags), ' ');
  }
  // At the head of a sentence the translator does one more thing, and it is not one of the rules
  // above: `tidy` drops a parenthetical left stranded at the front, because
  // `(P1) coding-system provenance` reads worse than the sentence without it. Measured on
  // `Phase F (P1)`, where the rules account for the phase language and the `(P1)` behind it is the
  // decapitation repair, not prose the reader lost.
  if (atHead) t = t.replace(/^[\s,;:.-]*\([^()]*\)/, ' ');
  // What may remain is punctuation and the seams a removal leaves. Anything with a letter or a
  // digit in it is prose the reader lost.
  return !/[A-Za-z0-9]/.test(t.replace(DECORATION, ''));
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

/** The first paragraph of a changeset summary: the sentence a bullet is derived from lives here. */
export function openingParagraph(summary) {
  const text = String(summary).replace(/\r\n/g, '\n').trim();
  const [first] = text.split(/\n\s*\n/);
  return (first ?? '').trim();
}

/**
 * The bold lead-in `headlineOf` promotes to the whole headline.
 *
 * `**Streaming parse:** the rest of it` publishes as `Streaming parse.` on purpose. Without this,
 * every such bullet reads as a sentence cut off after four words, which is the false positive that
 * a length-based scan cannot avoid and this one can.
 */
function leadIn(summary) {
  const match = /^\*\*(.+?)\*\*[.:]?\s/.exec(String(summary).replace(/\s+/g, ' ').trim());
  return match ? match[1].trim() : null;
}

/**
 * Classify one published bullet against the changeset it came from.
 *
 * @returns {{ verdict: string, why: string, missingTail: string, removed: string[], added: string[] }}
 *
 * verdict is one of:
 *   untouched           the bullet is the author's sentence, word for word
 *   deliberately-short  the same, but short enough that a length scan would suspect it
 *   identifier-removed  it differs only by spans the translator removes on purpose. NOT a truncation
 *   truncated           the author's sentence carries on past the bullet, in prose no rule explains
 *   rewritten           the bullet says something the changeset does not, so it was edited by hand
 */
export function classifyEntry(bullet, summary) {
  const window = openingParagraph(summary);
  const bulletTokens = tokenize(bullet);
  const sourceTokens = tokenize(window);
  const pairs = alignTokens(
    bulletTokens.map((t) => t.key),
    sourceTokens.map((t) => t.key),
  );

  const matchedBullet = new Set(pairs.map(([i]) => i));
  const matchedSource = new Set(pairs.map(([, j]) => j));

  let lastSource = pairs.length > 0 ? pairs[pairs.length - 1][1] : -1;
  let midWordCut = false;
  const lastBullet = bulletTokens[bulletTokens.length - 1];
  // The next SOURCE WORD, skipping the punctuation-only tokens that carry no key: a cut landed
  // inside `process.emitWarning` with a bare `+` in front of it, and looking only at the token
  // immediately next found the `+` and read the half-word as prose the author never wrote.
  let nextWord = lastSource + 1;
  while (nextWord < sourceTokens.length && sourceTokens[nextWord].key === '') nextWord += 1;
  if (
    lastBullet !== undefined &&
    nextWord < sourceTokens.length &&
    !matchedBullet.has(lastBullet.index) &&
    isMidWordCut(lastBullet.key, sourceTokens[nextWord].key)
  ) {
    midWordCut = true;
    matchedBullet.add(lastBullet.index);
    lastSource = nextWord;
  }

  const added = bulletTokens.filter((t, i) => !matchedBullet.has(i) && t.key !== '').map((t) => t.raw);

  // The tail that matters is the rest of the SENTENCE the bullet stopped inside, not the rest of the
  // paragraph. A changeset's opening paragraph routinely runs to several sentences, and only the
  // first is ever a bullet; measuring against the paragraph reports every ordinary bullet as cut.
  let sentenceEnd = lastSource;
  while (sentenceEnd + 1 < sourceTokens.length && !endsSentence(sourceTokens[sentenceEnd + 1])) sentenceEnd += 1;
  const tailTokens = sourceTokens.slice(lastSource + 1, Math.min(sentenceEnd + 2, sourceTokens.length));
  const missingTail = tailTokens.map((t) => t.raw).join(' ');

  // Runs of source words the bullet does not carry, each remembering whether it sat at the head of
  // the sentence: the translator repairs the head differently from the middle, so the two cannot be
  // judged by the same rule.
  const runs = [];
  let run = null;
  for (let j = 0; j <= lastSource; j += 1) {
    if (matchedSource.has(j)) {
      if (run !== null) runs.push(run);
      run = null;
    } else if (run === null) run = { start: j, words: [sourceTokens[j].raw] };
    else run.words.push(sourceTokens[j].raw);
  }
  if (run !== null) runs.push(run);
  const removed = runs.map((r) => r.words.join(' '));

  // `explainedTail` is the other half of the evidence, and it is recorded rather than discarded
  // because "this was removed on purpose" is the claim a reader is most entitled to check: it is
  // the exact judgement the prefix method got wrong 25 times.
  const result = {
    verdict: 'untouched',
    why: '',
    missingTail: '',
    explainedTail: '',
    removed,
    unexplainedRemoved: [],
    added,
  };

  // Hand-edited text first: there is no derivation left to grade, and calling it truncated would
  // report a body somebody already fixed as still broken.
  if (added.length > 0) {
    result.verdict = 'rewritten';
    result.why = `the published bullet carries prose the changeset does not (${JSON.stringify(added.join(' ').slice(0, 80))}), so it was written or edited by hand`;
    result.missingTail = missingTail;
    return result;
  }

  const lead = leadIn(summary);
  const bulletProse = bulletTokens.map((t) => t.raw).join(' ').replace(/[.!?]+\**$/, '');
  const coveredWholeWindow = lastSource >= sourceTokens.length - 1;
  const tailExplained = coveredWholeWindow || isExplainedRemoval(missingTail);
  const stoppedAtSentenceEnd = !midWordCut && lastSource >= 0 && endsSentence(sourceTokens[lastSource]);
  const isLeadIn = lead !== null && tokenize(lead).map((t) => t.key).join(' ') === bulletTokens.map((t) => t.key).join(' ');

  if (midWordCut || (!coveredWholeWindow && !tailExplained && !stoppedAtSentenceEnd && !isLeadIn)) {
    result.verdict = 'truncated';
    result.why = midWordCut
      ? `the bullet stops inside the word ${JSON.stringify(sourceTokens[lastSource].raw)}`
      : 'the changeset sentence carries on past where the bullet stops, in prose no translation rule removes';
    result.missingTail = midWordCut
      ? [sourceTokens[lastSource].raw, missingTail].filter(Boolean).join(' ')
      : missingTail;
    return result;
  }

  // Every verdict below is a COMPLETE bullet, so nothing is missing from it: what follows in the
  // changeset is the next sentence, which was never destined for a release bullet. Reporting that as
  // "missing" is how a reader is talked into believing a correct bullet was cut.
  result.missingTail = '';
  result.explainedTail = !coveredWholeWindow && !stoppedAtSentenceEnd ? missingTail : '';
  // Interior spans are tested the same way the tail is, and reported when they are NOT accounted
  // for. They cannot make the bullet a truncation (nothing was cut off the END of it), but a
  // verdict that says "every difference is a deliberate removal" while only ever having checked the
  // tail is claiming more than it looked at, and this file's whole argument is that the claim and
  // the check have to be the same thing.
  result.unexplainedRemoved = runs
    .filter((r) => !isExplainedRemoval(r.words.join(' '), r.start === 0))
    .map((r) => r.words.join(' '));
  if (removed.length > 0 || result.explainedTail !== '') {
    result.verdict = 'identifier-removed';
    result.why =
      result.unexplainedRemoved.length > 0
        ? `what is missing from the END of the bullet is a span the translator removes on purpose, but ${result.unexplainedRemoved.length} span(s) inside it are not accounted for`
        : 'every difference from the changeset is a span the translator removes on purpose';
    return result;
  }
  if (isLeadIn && !coveredWholeWindow) {
    result.verdict = 'identifier-removed';
    result.why = 'the bullet is the bold lead-in the renderer promotes to the whole headline';
    return result;
  }
  if (bulletProse.replace(DECORATION, '').length < SHORT_BULLET_CHARS) {
    result.verdict = 'deliberately-short';
    result.why = 'the author wrote a short sentence, and the bullet is all of it';
    return result;
  }
  result.why = 'the bullet is the author sentence, word for word';
  return result;
}

/**
 * Pair every bullet in a body with the changeset it came from, and classify each.
 *
 * Pairing is by alignment score rather than by position, because a release drops the changes a
 * consumer cannot observe and the two lists therefore do not line up. Best score wins, once, and a
 * bullet that matches nothing well enough is reported as `unmatched` rather than forced onto the
 * least bad candidate.
 */
export function classifyRelease({ body, changesets, packageName }) {
  const entries = extractChangeEntries(body);
  const sources = [];
  for (const file of changesets) {
    const parsed = parseChangeset(file.text, file.id);
    if (packageName && !parsed.releases.some((r) => r.name === packageName)) continue;
    if (parsed.summary === '') continue;
    sources.push({ id: file.id, summary: parsed.summary, window: openingParagraph(parsed.summary) });
  }

  const scored = [];
  entries.forEach((entry, ei) => {
    const bulletKeys = tokenize(entry).map((t) => t.key);
    sources.forEach((source, si) => {
      const pairs = alignTokens(bulletKeys, tokenize(source.window).map((t) => t.key));
      const denominator = bulletKeys.filter((k) => k !== '').length || 1;
      scored.push({ ei, si, score: pairs.length / denominator });
    });
  });
  scored.sort((a, b) => b.score - a.score);

  const bulletTaken = new Set();
  const sourceTaken = new Set();
  const pairing = new Map();
  for (const { ei, si, score } of scored) {
    if (score < MATCH_THRESHOLD) break;
    if (bulletTaken.has(ei) || sourceTaken.has(si)) continue;
    bulletTaken.add(ei);
    sourceTaken.add(si);
    pairing.set(ei, { source: sources[si], score });
  }

  return entries.map((entry, ei) => {
    const paired = pairing.get(ei);
    if (!paired) {
      return {
        entry,
        changeset: null,
        verdict: 'unmatched',
        why: 'no consumed changeset aligns with this bullet, so it cannot be diffed against a source',
        missingTail: '',
        explainedTail: '',
        removed: [],
        unexplainedRemoved: [],
        added: [],
      };
    }
    return { entry, changeset: paired.source.id, ...classifyEntry(entry, paired.source.summary) };
  });
}

// ---------------------------------------------------------------------------------------------
// git and gh
// ---------------------------------------------------------------------------------------------

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function runOrNull(cmd, args, cwd) {
  try {
    return run(cmd, args, cwd);
  } catch {
    return null;
  }
}

/**
 * The changesets the release tagged `tag` consumed.
 *
 * The TAG is the authority on which commit produced a release, not a walk over package.json
 * history. Measured: `cosyte/hl7` reverted a version commit and re-applied it, so the newest commit
 * whose package.json reads `0.0.2` is the revert, which consumed no changesets at all. The tag
 * points at the real one.
 */
export function changesetsForTag(repo, tag) {
  const sha = runOrNull('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], repo);
  if (sha === null) throw new DiffError(`${repo}: no tag ${tag}. Fetch tags, or pass a tag that exists.`);
  const commit = sha.trim();
  if (runOrNull('git', ['rev-parse', '--verify', '--quiet', `${commit}^`], repo) === null) {
    throw new DiffError(`${tag} is the first commit, so it consumed no changesets.`);
  }
  const paths = run('git', ['diff', '--diff-filter=D', '--name-only', `${commit}^`, commit, '--', '.changeset'], repo)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\.changeset\/.+\.md$/.test(line) && !/\/README\.md$/i.test(line));
  return {
    sha: commit,
    files: paths.map((path) => ({
      id: path.replace(/^\.changeset\//, ''),
      text: run('git', ['show', `${commit}^:${path}`], repo),
    })),
  };
}

function repoSlug(repo) {
  const url = runOrNull('git', ['remote', 'get-url', 'origin'], repo);
  const match = url && /github\.com[/:]([^/]+\/[^/.]+)/.exec(url.trim());
  if (!match) throw new DiffError(`${repo}: cannot read a github slug from its origin remote`);
  return match[1];
}

function publishedBody(repo, tag, bodyFile) {
  if (bodyFile) return readFileSync(resolve(bodyFile), 'utf8');
  const raw = runOrNull('gh', ['release', 'view', tag, '--repo', repoSlug(repo), '--json', 'body'], repo);
  if (raw === null) throw new DiffError(`cannot read the published body of ${tag}. Is \`gh\` authenticated?`);
  return JSON.parse(raw).body ?? '';
}

/**
 * The tags that actually have a published GitHub release.
 *
 * Not `git tag`, which is a superset and includes tags that are not releases at all: `cosyte/hl7`
 * carries a `v2.1` tag naming the HL7 standard version its fixtures target, and sweeping git tags
 * stops the whole run on it.
 */
function releaseTags(repo) {
  const raw = runOrNull('gh', ['release', 'list', '--repo', repoSlug(repo), '--limit', '100', '--json', 'tagName'], repo);
  if (raw === null) throw new DiffError(`cannot list releases for ${repoSlug(repo)}. Is \`gh\` authenticated?`);
  return JSON.parse(raw).map((r) => r.tagName);
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const HEADING = {
  truncated: 'GENUINELY TRUNCATED (a human must write a shorter sentence)',
  rewritten: 'REWRITTEN BY HAND (no derivation left to grade)',
  unmatched: 'UNMATCHED (no source changeset aligns)',
  'identifier-removed': 'identifier removed (not a truncation)',
  'deliberately-short': 'deliberately short (complete, and short because the author wrote it short)',
  untouched: 'untouched',
};
const ORDER = ['truncated', 'rewritten', 'unmatched', 'identifier-removed', 'deliberately-short', 'untouched'];

function classifyOne(repo, packageName, tag, bodyFile) {
  const body = publishedBody(repo, tag, bodyFile);
  const { sha, files } = changesetsForTag(repo, tag);
  return { tag, sha, consumed: files.length, results: classifyRelease({ body, changesets: files, packageName }) };
}

function report(releases, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(releases, null, 2)}\n`);
  } else {
    for (const release of releases) {
      const counts = new Map();
      for (const r of release.results) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
      const summary = ORDER.filter((v) => counts.has(v)).map((v) => `${counts.get(v)} ${v}`).join(', ');
      process.stdout.write(
        `\n${release.tag}  ${release.sha.slice(0, 7)}  ${release.consumed} changeset(s) consumed, ` +
          `${release.results.length} bullet(s): ${summary || 'no bullets'}\n`,
      );
      // An `identifier-removed` bullet with an interior span nothing accounts for is printed even
      // though the verdict is not a truncation: the evidence for "this was removed on purpose" is
      // the part a reader is entitled to check, and burying it behind `--json` is how a summary line
      // starts being trusted instead of read.
      const unaccounted = release.results.filter(
        (r) => r.verdict === 'identifier-removed' && r.unexplainedRemoved.length > 0,
      );
      for (const hit of unaccounted) {
        process.stdout.write(`  interior spans not accounted for (still not a truncation)\n`);
        process.stdout.write(`    bullet:  ${hit.entry}\n`);
        process.stdout.write(`    source:  ${hit.changeset}\n`);
        process.stdout.write(`    spans:   ${JSON.stringify(hit.unexplainedRemoved.join(' | '))}\n\n`);
      }
      for (const verdict of ORDER) {
        const hits = release.results.filter((r) => r.verdict === verdict);
        if (hits.length === 0 || verdict === 'untouched' || verdict === 'identifier-removed') continue;
        process.stdout.write(`  ${HEADING[verdict]}\n`);
        for (const hit of hits) {
          process.stdout.write(`    bullet:  ${hit.entry}\n`);
          process.stdout.write(`    source:  ${hit.changeset ?? '(none)'}\n`);
          process.stdout.write(`    why:     ${hit.why}\n`);
          if (hit.missingTail) process.stdout.write(`    missing: ${JSON.stringify(hit.missingTail)}\n`);
          if (hit.verdict === 'rewritten') {
            process.stdout.write(`    added:   ${JSON.stringify(hit.added.join(' ').slice(0, 200))}\n`);
          }
          process.stdout.write('\n');
        }
      }
    }
  }
  const truncated = releases.flatMap((r) => r.results.filter((x) => x.verdict === 'truncated'));
  return truncated.length > 0 ? 1 : 0;
}

function parseArgv(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new DiffError(`unexpected argument ${JSON.stringify(arg)}`);
    const key = arg.slice(2);
    if (key === 'json') {
      options.json = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new DiffError(`--${key} needs a value`);
    i += 1;
    options[key] = value;
  }
  return options;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(
      'usage:\n' +
        '  release-diff.mjs classify --repo <dir> --package <name> --tag <tag> [--body-file <f>] [--json]\n' +
        '  release-diff.mjs sweep --repo <dir> --package <name> [--json]\n',
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
    const repo = resolve(options.repo ?? '.');
    const packageName = options.package;
    if (!packageName) throw new DiffError(`${command}: --package is required`);
    if (command === 'classify') {
      if (!options.tag) throw new DiffError('classify: --tag is required');
      process.exit(report([classifyOne(repo, packageName, options.tag, options['body-file'])], options.json));
    } else if (command === 'sweep') {
      const releases = releaseTags(repo).map((tag) => classifyOne(repo, packageName, tag, null));
      process.exit(report(releases, options.json));
    } else {
      process.stderr.write(`unknown command ${JSON.stringify(command)}\n`);
      process.exit(2);
    }
  } catch (error) {
    if (error instanceof DiffError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2));
}
