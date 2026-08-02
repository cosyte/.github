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
// gate then proves the translation worked and FAILS the run if anything banned survived. Stripping
// is never silent: every rewrite and every dropped change is printed.
//
// THE TRANSLATOR ONLY EVER CUTS WHERE THE CUT IS SAFE, and refuses otherwise. Removing a phrase
// from the middle of a clause leaves prose that does not parse: "no longer carries phase language,
// item identifiers or ADR numbers" became "no longer carries, item identifiers or ADR numbers", and
// nothing downstream could see it, because a mangled sentence carries no banned bytes to find. A
// gate cannot observe grammar. So the fix is upstream of the gate: a cut is taken only at a
// boundary where the sentence survives it (the head, the tail, a whole clause, or a modifier inside
// one clause), and any other cut is REFUSED with the changeset named. Inside a parenthetical the
// same test DROPS the segment instead, because a parenthetical is by construction removable and a
// clause in a sentence is not. Refusing costs a re-version before anything is published; mangling
// costs a permanent public release page. See isSafeCut.
//
// AND EVERY CLEANUP AFTER A CUT REACHES NO FURTHER THAN THE CUT. This was learned inside this very
// change: a revision of it collapsed adjacent clause punctuation over the whole finished string, to
// tidy the "X, , and Y" a whole-clause cut leaves. It rewrote `HI*BE:01:::500:1` to `HI*BE:01:500:1`
// in a code span an author had typed correctly, moving an amount into the wrong X12 composite
// position, on prose that had no internal reference in it at all. A tidy-up with a wider reach than
// the cut it is tidying is the same defect wearing different clothes.
//
// AND THE TRANSLATOR NEVER SHORTENS A SENTENCE. An over-long opening sentence used to be cut at the
// nearest word boundary, silently, which published "...a medication naming two different drugs with
// o." to @cosyte/ccda v0.0.2 and dropped a whole third clause from another entry in the same body.
// 14 entries across 7 of the 15 live releases carry that cut, re-derived from what each consumed.
// A headline is now the author's first sentence entire, or the release stops and asks for a shorter
// one. Same reasoning: a truncation that produces well-formed prose is invisible to any gate.
//
// WHAT THE GATE DOES AND DOES NOT COVER, stated plainly because the distinction matters. The gate
// enforces the KNOWN banned set. It shares PROJECT_PREFIXES with the translator, so it cannot catch
// an identifier from a programme prefix nobody has added to that list yet, and no rule could: the
// only way to spot one from its shape alone is a `WORD-N` pattern, which is exactly what destroys
// `SCH-11`, `PID-3`, `MSH-2`, `NM1-03`, and `ICD-10`. What the gate DOES buy is that a rule can
// never be quietly bypassed downstream: it re-reads the finished bytes, so a change to the renderer,
// the workflow, or the source of the text cannot ship banned content without tripping it.
//
// The gate reads the residue of a bad cut, not the grammar: doubled or orphaned clause punctuation,
// a parenthetical emptied of its contents, a one-letter stump at the end of an entry, an entry
// longer than a headline. Those are the shapes a cut leaves BEHIND in the bytes, and they are
// deliberately narrow, because every wider version refuses complete sentences: "...through as is.",
// "...the more broken the document was.", "...recorded as A, B, AB, or O." are all correct English
// and one of them is from a changeset a real release consumed. Refusing a correct sentence blocks a
// publish on a lie. The shapes the gate cannot see are why the translator refuses rather than
// repairs: the guarantee is kept where it can be kept, at the cut.
//
// STARTING A NEW PROGRAMME MEANS ADDING ITS PREFIX BELOW. That is the maintenance cost of keying on
// prefixes instead of shapes, and it is the cheaper of the two mistakes.
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
// `prepare` IS THE PERMISSION TO PUBLISH, not a report on it. Its `is-release` output is what
// release.yml passes to `changesets/action` as the publish command, so a run where prepare declined
// to derive notes never reaches npm at all. That is why an unclassifiable commit is a hard failure
// here rather than a quiet "nothing pending": the two look identical from the workflow's side, and
// one of them is a release about to go out with no record of what it contains.
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
// The longest a single change entry may be. Exceeding it is a REFUSAL, never a silent cut at the
// nearest word boundary.
//
// RAISED FROM 200 TO 400 ON 2026-08-02. This is a founder call about how much a release bullet is
// allowed to say, not a workaround for one failing run. What it was decided on: `@cosyte/dicom`
// `0.0.7` was refused by the 200 cap that day AFTER its "Version Packages" PR had already merged,
// which wedges the repo (the changeset is consumed by then, so recovery is the revert dance in
// RECOVERY below). Two of that release's changesets were over the cap, at 229 and 218 characters,
// though the run only ever named the first. The 229 said, in one sentence, that an element whose
// on-wire VR is not one of the 34 PS3.5 defines was kept verbatim by `deidentify()`, carrying a
// source `(0010,0020)` Patient ID into de-identified output sitting next to
// `(0012,0062) PatientIdentityRemoved = YES`. That is a PHI leak, and the juxtaposition is what
// makes it sharp: the output asserts the identity was removed while carrying it. Cutting that to 200
// forced real facts out of the opening sentence, and the opening sentence is the only part that
// becomes a bullet. A cap that costs a reader the fact that matters is the wrong cap; 400 is where
// it now sits. (That is a paraphrase, not a quotation: this file is ASCII only, and the sentence is
// not. The README quotes it byte-exact, which is where to go to count the 229.)
//
// `@cosyte/astm` `0.0.9` wedged the same day and is NOT evidence for this raise, said here because
// the two get told as one story. Its opening sentence was 220 raw characters, but the cap is
// measured on the TRANSLATED headline (see the refusal site below for why), and that was 185,
// comfortably under even the old cap. What refused astm was the internal-identifier rule.
//
// WHAT THIS DID NOT CHANGE. Over-cap is still a refusal: nothing is shortened on the author's
// behalf, for the reasons at the refusal site below. And the rule that an internal identifier may
// not be load-bearing in the opening sentence is untouched by this call. That rule is what actually
// refused astm, it is a question about meaning rather than length, and the two do not move together.
const MAX_HEADLINE_CHARS = 400;
// A change entry shorter than this is not a description of anything. There is deliberately NO
// whole-body minimum on top of it: "Add `profiles.epic`." is a complete and legitimate release.
const MIN_ENTRY_CHARS = 12;

/** The body used when a version shipped nothing a consumer of the package can observe. */
const INTERNAL_ONLY_BODY = 'Internal tooling and CI only. No change to the published package surface.';

class NotesError extends Error {}

// What it costs to act on a refusal, said plainly because it is not free. `prepare` runs on the
// version commit, by which point the "Version Packages" PR has merged and the changeset exists only
// at `<version commit>^`. So the fix is: revert the version commit, edit the changeset on main, and
// let Changesets open a fresh Version PR. Nothing has been published at this point, which is the
// whole reason this refusal sits before the publish step rather than after it.
const RECOVERY =
  'Nothing has been published. The changeset was consumed by the version commit, so recover it ' +
  'with `git show <version-commit>^:<path>`, revert the version commit, correct the changeset on ' +
  'main, and let Changesets open a fresh Version PR.';

// ---------------------------------------------------------------------------------------------
// The banned set: internal project bookkeeping that must never reach a public release body
// ---------------------------------------------------------------------------------------------

// Known project and programme prefixes. THE KEYING IS ON THESE PREFIXES, NEVER ON THE `WORD-N`
// SHAPE, and that distinction is the whole game: `MLLP-10` is one of ours, but `SCH-11`, `PID-3`,
// `MSH-2`, `NM1-03`, `OBX-5` are HL7 and X12 segment-field references and are exactly the reference
// material a consumer needs. A shape-based rule destroys them. Add to this list when a new
// programme starts: nothing else will catch it, for the reason set out at the top of this file.
const PROJECT_PREFIXES = [
  'PARSERS-PUBLIC',
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
  // Measured against operations/roadmaps/*.md and BACKLOG.md, which are where these are minted.
  // `TERM-N` is live in terminology's roadmap and terminology calls this workflow.
  'TERM',
  'PKG',
  'WF',
  'VERIFY',
];

// CASE SENSITIVE, and the segment after the hyphen must start uppercase. That is what lets
// `FHIR-bridge` and `docs-content/` through: they are legitimate content, and a case-insensitive
// rule flags them as violations.
// The second alternative is our internal priority label, and it MATCHES ITS OWN TRAILING WORD
// rather than looking ahead for one. An earlier version keyed on `P\d+` followed by end-of-string
// or a comma, which is the shape rule this file exists to avoid: it deleted the ICD-10-CM code in
// "Map ICD-10 P07, P22 and P29 to SNOMED CT" and truncated the code range "P00-P96". Corrupting a
// diagnosis code to remove an internal label is not a trade worth making.
const INTERNAL_ID = new RegExp(
  String.raw`\b(?:${PROJECT_PREFIXES.join('|')})(?:-[A-Z0-9][A-Z0-9.]*)+\b` +
    String.raw`|\bP\d+ (?:safety|documentation)\b`,
);

const ORDINAL =
  String.raw`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|` +
  String.raw`thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|` +
  String.raw`twenty-first|twenty-second|twenty-third|twenty-fourth|\d+(?:st|nd|rd|th))`;

// Sequence adjectives: words that order our own work and can never be the object of a verb. This is
// the modifier slot of the phase-phrase alternative below -- see the comment there for why it is a
// list rather than `\w+`.
const SEQUENCE_MODIFIER = '(?:final|last|next|first|current|remaining|penultimate)';

// Phase and slice language. Note `Phase 5b` and `Phase W`: a digits-only pattern misses both, and
// the ordinal forms ("thirteenth slice", "second wave") are ours too. The negative lookahead keeps
// ordinary English off the list, so "in phase with the source system" survives.
//
// TWO ALTERNATIVES MATCH A WHOLE NOUN PHRASE RATHER THAN ITS HEAD NOUN, and they are the reason a
// list of shapes beats a general rule here. `roadmap phase` is the HEAD of "the final roadmap
// phase", so matching it alone strands the determiner run that governed it: `@cosyte/synth` v0.0.1
// published "Release hardening: the final." and `@cosyte/deid` wrote the same shape. isSafeCut
// cannot see it, because a cut at the end of a sentence has nothing on its right to break, and
// DANGLING_TAIL cannot either -- `final` is a CONTENT word, and that list may only ever hold words
// that cannot change a sentence's meaning. So the phrase is named here, where the blast radius is
// exactly the shape written down. `the \w+ and final phase` was already here for the same reason;
// this one is its sibling and was measured the same way.
//
// THE MODIFIER SLOT IS A WORD LIST, NOT `\w+`, and that is the difference between naming a shape and
// wildcarding one. A wildcard takes any single word, INCLUDING A CONTENT NOUN: `the \w+ roadmap
// phase` turns "Regenerate and re-publish the dictionary roadmap phase" into "Regenerate and
// re-publish", deleting the object the author gave the verb, silently and in well-formed prose.
// Every word below is a sequence adjective that cannot BE the object of a verb, so the rule can only
// ever remove text that is ordering our own work. Across the corpus the slot is filled by `final` 5
// times across the 464 changeset bodies (3 of the 406 opening sentences, 2 of them tail-anchored),
// and by nothing else. Six of the seven words below are reasoned in rather than measured in: no
// instance exists, and none can be a verb's object, which is the property the list is chosen for. (The older sibling still wildcards its slot, and is not tail-anchored
// either; that is pre-existing and its own piece of work.)
//
// AND IT IS ANCHORED TO THE END OF THE SENTENCE, because that is where the whole measured defect
// lives: a determiner run is only stranded when there is no following noun for it to govern. Left
// unanchored it also fires mid-sentence, where "Complete the final roadmap phase and ship the
// parser" becomes "Complete and ship the parser" -- well-formed, and missing the object the author
// gave the verb. Mid-sentence the plain `roadmap phase` alternative below still matches, so phase
// language is detected in exactly the places it was before; only the WIDER cut is confined to the
// tail. Detection over a finished body is unaffected, since that alternative is what fires there.
//
// A GENERAL VERSION OF THIS WAS BUILT AND WITHDRAWN, and the withdrawal is the finding. Widening any
// tail cut leftwards over "a determiner plus up to two lowercase modifiers" fixes both live bullets
// and nothing else in the corpus -- but the cases it CAN reach are not bounded by the corpus. It
// deletes the object of "re-publish the DICOM dictionary roadmap phase", reads the relative pronoun
// in "the check that catches phase 5b" as a determiner and publishes "Add the check", and shortens a
// headline enough to flip the length refusal into a publish (the cap was 200 when this was measured
// and is 400 now; the failure mode is the same at any cap). Each turns a visible break into
// well-formed prose that is not what the author wrote, which is this file's worst failure mode. A
// named shape cannot do any of that: it matches the words it names.
const PHASE_TALK = new RegExp(
  String.raw`\b(?:the ${SEQUENCE_MODIFIER} roadmap phase\b(?=[\s.]*$)|roadmap phase\b[ ]?[A-Za-z0-9]*|` +
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

// What a bad cut leaves BEHIND. A gate reads bytes, not grammar, so it cannot be asked whether a
// sentence still parses; it can only be asked whether the wreckage of a cut is visible. These are
// the visible shapes: a clause separator with nothing left on one side of it, two separators run
// together, and a parenthetical emptied of its contents. Everything the translator itself produces
// is cleaned up before it reaches here, so a hit means some OTHER path wrote this body, which is
// exactly the case `assert` exists to cover.
// `[,;]` and not `[,;:]`, and `\(\s*\)` only when it stands alone: a colon run is real content
// (`HI*BE:01:::500:1` is a valid X12 composite, `10:30` is a time) and `parse()` is an API name.
const MANGLED_PROSE = [
  { name: 'mangled prose (doubled clause punctuation)', pattern: /[,;]\s*[,;]/ },
  { name: 'mangled prose (a gap before punctuation)', pattern: /\S\s+[,;](?:\s|$)/ },
  { name: 'mangled prose (an empty parenthetical)', pattern: /(?:^|\s)\(\s*\)/ },
];

/** Every banned-content rule, applied to a finished body. Order is the order they are reported. */
const CONTENT_RULES = [
  { name: 'internal project identifier', pattern: INTERNAL_ID },
  { name: 'phase or slice language', pattern: PHASE_TALK },
  { name: 'ADR reference', pattern: ADR_REFERENCE },
  { name: 'internal jargon ("slice")', pattern: OUR_JARGON },
  { name: 'em dash (U+2014)', pattern: new RegExp(EM_DASH) },
  ...MANGLED_PROSE,
];

// A single LOWERCASE letter at the end of an entry is the fingerprint of a length cut: "...with one
// silently dropped" cut at a boundary that was not a word boundary leaves "...with o". Nothing
// wider than that is safe on this suite, and every wider version was tried and withdrawn: two
// letters catches `mL`, `et al.` and `is`; the pure-function-word list catches `...the way the
// sender wrote it.` and `...the more broken the document was.`, and the second of those is a real
// sentence from a changeset a real @cosyte/ccda release consumed. Refusing a complete sentence
// blocks a publish on a lie, which is worse than the miss. So this catches three of the fourteen live
// truncations and is honest about the other eleven: what actually guarantees no cut sentence is
// that the renderer no longer cuts one. Tested with code spans intact, so `Model the \`Q\`` is not
// a stump, the backtick sits between the letter and the end.
const ORPHAN_STUMP = /(?:^|\s)[a-z][.!?]?$/;

// Changes a consumer of the published package cannot observe. A release note lists what changed FOR
// THE READER, so these are dropped from the note entirely rather than reworded. Founder, on seeing
// the em-dash gate in hl7's notes: "The em dash gate does not need to be shown to the consumers
// either. That should be internal and not something brought to the users attention."
/**
 * Exported so the monotonicity guarantee in isConsumerFacing can be tested as the SUBSET argument it
 * is, against the rule this replaced, rather than restated as a property of the implementation.
 */
export const INTERNAL_ONLY_CHANGE = new RegExp(
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

// Spans whose insides are one token rather than a phrase: a code span and a parenthetical. Masked to
// the SAME LENGTH so an index found in the masked text indexes the original, because the boundary is
// located in the masked text and the clause is then sliced out of the ORIGINAL. Masking the text the
// classifier reads would hide `sync-version.mjs` inside its own backticks and keep an internal-only
// entry.
function maskSpans(text) {
  return String(text)
    .replace(/`[^`]*`/g, (m) => 'x'.repeat(m.length))
    .replace(/\([^()]*\)/g, (m) => 'x'.repeat(m.length));
}

// What separates one INDEPENDENT clause from the next. `;` and `:` only when whitespace follows, for
// the reason separatorBefore gives: the colons in `HI*BE:01:::500:1` and `10:30` bind their elements
// together and are structural. Plus the coordinating conjunction, which is how the measured headline
// joins its two clauses with no comma at all.
//
// A BARE COMMA IS DELIBERATELY NOT A BOUNDARY, and this is measured rather than assumed. Three live
// `@cosyte/deid` changesets open "Repository CI configuration only, with no runtime impact: ...", and
// that comma introduces a prepositional phrase, not a clause, so reading it as a boundary makes the
// leading clause "Repository CI configuration only", which no rule matches, and republishes three
// entries that say of themselves that nothing changed for a reader.
const CLAUSE_BOUNDARIES = [/[;:](?=\s)/, /\sand\s/];

/**
 * Everything up to the first boundary between independent clauses.
 *
 * Exported so a test can pin the boundary set rather than infer it from a verdict.
 */
export function leadingClause(text) {
  const whole = String(text);
  const masked = maskSpans(whole);
  let cut = whole.length;
  for (const pattern of CLAUSE_BOUNDARIES) {
    const found = new RegExp(pattern.source).exec(masked);
    if (found && found.index < cut) cut = found.index;
  }
  return whole.slice(0, cut);
}

/**
 * False when the change cannot be observed by someone installing the package.
 *
 * READ ON THE LEADING CLAUSE, NOT THE WHOLE HEADLINE, and that is the whole of this rule.
 *
 * WHAT WAS WRONG. This tested the whole sentence, so ONE internal clause condemned the entry it sat
 * in however consumer-facing the rest of it was. Measured on `@cosyte/dicom` 2026-07-29: "Correct 174
 * SOP Class UID names and close two holes in the dictionary regen gate" was dropped WHOLE on
 * `\bDictionary Regen\b` matching its second clause, so a version that genuinely corrected 174 SOP
 * Class UID names (`UIDS["1.2.840.10008.5.1.4.1.1.2"].name` really did read `"CT Image Storage
 * Storage"` at 0.0.3) would have published three bullets for five changesets and never mentioned the
 * correction. A consumer-visible correction vanishing from a release body is the same class of harm
 * as a mangled sentence: the page is well-formed and wrong.
 *
 * THE PRINCIPLE, so this is not curve-fitting. A release bullet is ABOUT ITS LEADING CLAUSE. The
 * subject of a sentence sits in its head, and later clauses coordinate with or elaborate on it. So
 * internal-tooling language in the HEAD means the change IS internal tooling and the bullet goes;
 * the same language in a later clause means a consumer-observable change carrying internal detail,
 * and dropping THAT bullet loses the observable fact. Every one of the six live drops in the org
 * separates on exactly that reading, in both directions.
 *
 * WITH ONE STATED EXCEPTION: the two rules that span a gap, `\brelocat(?:e|ed|ing) .*tests?\b` and
 * `\bworkflow\b.*\bred since\b`, are in effect read as WHOLE-HEADLINE rules, because a match starting
 * in the head can end anywhere. So "Add a `workflow` option to the runner and fix the suite red since
 * Tuesday" is dropped even though the phrase that condemns it straddles the boundary. That is the
 * conservative direction (it drops), it is what closes the hole those two rules would otherwise have,
 * and no pending changeset in the org sits in it.
 *
 * THE DIRECTION OF ERROR, stated because it is the unfavourable one. This can only ever turn a DROP
 * into a KEEP, and that is a SUBSET argument rather than a claim about regexes: the old rule dropped
 * on any match anywhere, this one drops on any match STARTING before the boundary, and the second set
 * of matches is contained in the first. So it holds for any pattern the word list ever grows, with no
 * dependency on that list staying free of anchors or lookarounds. The cost of being wrong is
 * therefore an internal-only bullet on a public page, never a lost consumer-facing one. That is why
 * this shipped with a before/after count over every pending changeset in the org rather than on the
 * argument alone, and why the boundary set above is as narrow as the measurement allows.
 *
 * `findViolations` READS THE SAME RULE, and has to: the two halves must agree or a body the renderer
 * keeps is one `assert` refuses, which is a release nobody can cut. The cost is that `assert`'s
 * independent re-read of finished bytes is relaxed in the same step, so a body written by some OTHER
 * path can now carry an internal clause after its leading one. That is inherent to moving them
 * together, and `release.yml` only ever asserts the file `prepare` itself wrote.
 *
 * NOT DONE: CUTTING THE INTERNAL CLAUSE OUT and publishing the rest. That is the mid-sentence cut
 * this file exists to refuse, and the measured headline joins its clauses with a bare "and", which
 * isSafeCut correctly declines. The remedy for a mixed changeset is still the standing one in
 * `documentation/conventions.md`: reword the changeset, do not grow the gate.
 */
export function isConsumerFacing(headline) {
  const whole = String(headline);
  // A match that STARTS in the leading clause condemns the entry even when it runs past the boundary.
  // Testing the leading clause as a standalone string instead would systematically defeat the two
  // rules whose match SPANS a conjunction, `\brelocat(?:e|ed|ing) .*tests?\b` and
  // `\bworkflow\b.*\bred since\b`: "Relocate the fixtures and the tests into one place" has a neutral
  // head half, so neither half matches alone and a wholly internal entry would be published. No
  // pending changeset in the org hits that today, which is exactly why it is closed here rather than
  // left to be discovered by the release that publishes it.
  //
  // ONE `exec` IS ENOUGH, and a loop over further matches would be dead code: the regex is not global,
  // so `exec` returns the LEFTMOST match, whose index is minimal. If that one does not start before
  // the boundary then none does. Not global also means `lastIndex` is neither read nor written, so
  // exporting this regex cannot leak state into a classification.
  const found = INTERNAL_ONLY_CHANGE.exec(whole);
  return !(found !== null && found.index < leadingClause(whole).length);
}

// ---------------------------------------------------------------------------------------------
// Translation at the boundary
// ---------------------------------------------------------------------------------------------

/**
 * First sentence of a changeset, flattened to one line. NEVER shortened.
 *
 * This used to cut an over-long opening sentence at the nearest word boundary and say nothing. It
 * published "...a medication naming two different drugs with o." to @cosyte/ccda v0.0.2, and in the
 * same body it cut a three-part finding down to two parts and appended a full stop, so the note
 * read as a complete claim the author never made. Both survive every gate, because a cut sentence
 * carries no banned bytes: shortening prose is not something a rule over bytes can observe.
 *
 * So there is no cut. The headline is the author's first sentence entire, however long, and
 * collectHeadlines refuses one that will not fit a release bullet rather than trimming it to size.
 */
export function headlineOf(text) {
  let t = String(text).trim().split(/\s+/).join(' ');
  t = t.replace(/^\*\*(.+?)\*\*[.:]?\s*/, '$1. '); // a leading bold lead-in is the headline
  // The `\*{0,2}` matters: changesets here routinely end a sentence inside emphasis, as in
  // "**the record-content layer is now feature-complete.**". Requiring whitespace straight after the
  // full stop misses that and runs past a perfectly good sentence.
  const sentence = /^(.+?[.!?]\*{0,2})(\s|$)/.exec(t);
  return (sentence ? sentence[1] : t).trim().replace(/\.+$/, '');
}

/**
 * A trailing word that carries no meaning on its own: the fingerprint of a cut that ate the rest of
 * the clause.
 *
 * Every word here is a pure function word. NEGATIONS AND QUANTIFIERS ARE DELIBERATELY ABSENT:
 * `not`, `no`, `never`, `only`, `both`, `more`, `each`. An earlier version of this file walked back
 * off these words to tidy a truncation, and with negations in the list that turned "The parser
 * tolerates a truncated trailer, the emitter does not" into "...the emitter does", which tells a
 * reader the opposite of the truth on a public page, and no gate can catch it because the result is
 * well-formed prose. This list may only ever grow by words that cannot change a sentence's meaning.
 *
 * Nothing walks back off them any more: a tail left dangling is a REFUSAL, never a repair. The list
 * is now purely a detector, used by collectHeadlines on a translated headline and by findViolations
 * on a finished body.
 */
export const DANGLING_TAIL =
  /(?:^|\s)(?:a|an|the|and|or|of|to|in|on|for|with|that|which|into|from|as|at|by|is|are|was|were|be|been|its|it|this|these|those|but|so|then|than|per|via)$/i;

// What ends a clause. The em dash is NOT in this list, and that is measured rather than assumed: it
// is a clause separator in English, but including it refuses three real changesets of the form
// "Conformance Phase A <em dash> stop rejecting spec-clean messages", where cutting the tail off
// "Conformance Phase A" leaves "Conformance", a complete noun phrase, and the note reads correctly.
// Across the 242 changesets in the eight publishing repos' history it refused three correct
// sentences and prevented no mangle, so it is out.
const CLAUSE_SEPARATOR = /[,;:.!?]/;
// Characters that JOIN a span to its neighbour, so the span is part of one token rather than a
// phrase between two. `The MLLP-1-driven reconnect` is a single compound word and cutting the
// identifier out of it leaves `The -driven reconnect`.
const TOKEN_JOINER = /[-/\\`]/;

/**
 * Whether the span [start, end) can be lifted out of `text` without breaking the sentence.
 *
 * This is the whole of the mid-sentence-mangling fix, and it is a boundary rule, not a grammar
 * check. A phrase may be removed when the text on BOTH sides of it is the same kind of thing:
 *
 *   - nothing on one side              the head or the tail of the sentence goes with it
 *   - a clause separator on both sides a whole clause goes, and the remaining clauses still join
 *   - a plain word on both sides       a modifier inside one clause goes, and the clause survives
 *     ("Reorder the P1 documentation pass" gives "Reorder the pass")
 *
 * A separator on exactly one side means the span was PART of a clause and the rest of that clause
 * stays behind: "...no longer carries [phase language], item identifiers..." leaves "...no longer
 * carries, item identifiers...". That is the measured defect, and it is refused rather than cut.
 *
 * WHAT IT STILL CANNOT TELL, said plainly: a boundary rule cannot distinguish a modifier from a
 * grammatical argument, and both have plain words on either side. "Accept an NCPDP-SCRIPT NewRx
 * transaction" cuts to "Accept an NewRx transaction", which is not what the author wrote. That is
 * unchanged from before this rule existed, and it is the residue a shape rule leaves: only 4
 * word-to-word cuts are taken across the whole corpus and all 4 read correctly, so this is a stated
 * limit rather than a fixed one. The rule buys the separator cases, which are the ones that mangle.
 *
 * `edgeIsSeparator` is for a comma-delimited segment of a parenthetical, which is handed over
 * without the commas that bound it. Its edges ARE separators, and saying so is what stops the
 * segment view from calling a cut safe that the whole string would call unsafe.
 */
export function isSafeCut(text, start, end, edgeIsSeparator = false) {
  const whole = String(text);
  if (TOKEN_JOINER.test(whole[start - 1] ?? '') || TOKEN_JOINER.test(whole[end] ?? '')) return false;
  const left = whole.slice(0, start).replace(/\s+$/, '');
  const right = whole.slice(end).replace(/^\s+/, '');
  if (!edgeIsSeparator && (left === '' || right === '')) return true;
  return separatorBefore(whole, start, edgeIsSeparator) === separatorAfter(whole, end, edgeIsSeparator);
}

// A separator only ends a CLAUSE when whitespace sits on the far side of it. `HI*BE:CI-1:500:1` is
// an X12 composite: the colons bind their elements together and are structural, not punctuation, so
// they must not read as clause boundaries and must never be collapsed away. Same for `10:30`.
function separatorBefore(whole, start, edgeIsSeparator) {
  const before = whole.slice(0, start);
  const trimmed = before.replace(/\s+$/, '');
  if (trimmed === '') return edgeIsSeparator;
  if (!/\s$/.test(before)) return false;
  return CLAUSE_SEPARATOR.test(trimmed[trimmed.length - 1]);
}

function separatorAfter(whole, end, edgeIsSeparator) {
  const after = whole.slice(end).replace(/^\s+/, '');
  if (after === '') return edgeIsSeparator;
  return CLAUSE_SEPARATOR.test(after[0]) && /^.(\s|$)/.test(after);
}

/**
 * The rules the translator removes, in the order it removes them.
 *
 * Exported so that a tool asking "was this text removed on purpose?" asks the translator rather
 * than restating its rules, which would drift the moment a new programme prefix is added above.
 */
export const TRANSLATION_RULES = [
  { name: 'internal project identifier', pattern: INTERNAL_ID },
  { name: 'phase or slice language', pattern: PHASE_TALK },
  { name: 'ADR reference', pattern: ADR_REFERENCE },
];

/**
 * Remove every span the translation rules match that can be removed safely, and report the rest.
 *
 * A span that cannot be cut safely is LEFT WHERE IT IS. That is deliberate: leaving it means the
 * banned text survives into the finished bytes, where findViolations sees it and the run goes red
 * with the offending line named. Cutting it means well-formed-looking wreckage that nothing
 * downstream can detect. Of the two failure modes, only one is recoverable.
 *
 * @returns {{ text: string, refused: Array<{ rule: string, match: string }> }}
 */
function stripSpans(text, rules, edgeIsSeparator = false) {
  let out = String(text);
  const refused = [];
  for (const rule of rules) {
    const flags = rule.pattern.flags.includes('i') ? 'gi' : 'g';
    const re = new RegExp(rule.pattern.source, flags);
    let from = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      re.lastIndex = from;
      const found = re.exec(out);
      if (!found) break;
      const start = found.index;
      let end = start + found[0].length;
      if (!isSafeCut(out, start, end, edgeIsSeparator)) {
        refused.push({ rule: rule.name, match: found[0] });
        from = end;
        continue;
      }
      // A whole clause lifted from between two separators leaves them adjacent: "Emit X, , and Y".
      // Close that AT THE SEAM. An earlier revision of this fix collapsed adjacent separators over
      // the finished string instead, which silently rewrote `HI*BE:01:::500:1` to `HI*BE:01:500:1`
      // in a code span an author had typed correctly, moving an amount into the wrong composite
      // position on a public page. A cleanup with a wider reach than the cut it is cleaning up
      // after is the same defect this file exists to remove.
      const after = out.slice(end);
      const trimmed = after.replace(/^\s+/, '');
      // `[,;]` on BOTH sides, narrower than what isSafeCut accepts: a full stop joins two sentences
      // rather than two clauses, so "Fix A. [span], and C" must keep its comma. `headlineOf` cannot
      // hand a stop-plus-space to this code, but sanitizeInternal is exported and callable, and a
      // cleanup that reaches further than the cut it is cleaning up after is this file's own defect.
      const beforeText = out.slice(0, start).replace(/\s+$/, '');
      if (
        separatorBefore(out, start, false) &&
        separatorAfter(out, end, false) &&
        /[,;]/.test(beforeText[beforeText.length - 1] ?? '') &&
        /[,;]/.test(trimmed[0] ?? '')
      ) {
        end += after.length - trimmed.length + 1;
      }
      out = out.slice(0, start) + out.slice(end);
      from = start;
    }
  }
  return { text: out, refused };
}

/**
 * Clean one comma-delimited segment of a parenthetical, or null when it cannot be cleaned safely.
 *
 * Null drops the segment. Inside a parenthetical that is always the right answer, and it is the
 * behaviour this file already had for a segment that cleaned down to nothing: the segments are
 * comma-delimited, so losing one whole leaves the others reading correctly, while a fragment cut
 * out of the middle of one reads worse than not having the segment at all. So a parenthetical
 * DROPS where running prose REFUSES, and the difference is that a parenthetical is by construction
 * removable and a clause in a sentence is not.
 *
 * The segment arrives without the commas that bounded it, so its edges are told to read as the
 * separators they are: otherwise a cut at the segment's end looks like a tail cut and is taken,
 * which is how "(it no longer carries phase language, item identifiers)" became "(it no longer
 * carries, item identifiers)" while the whole-string rule would have caught it.
 */
function stripInternal(segment) {
  const { text, refused } = stripSpans(segment, TRANSLATION_RULES, true);
  if (refused.length > 0) return null;
  return text
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
export function sanitizeInternalDetailed(text) {
  let t = String(text).replace(/\s*\(([^()]*)\)/g, (whole, inner) => {
    if (!INTERNAL_ID.test(inner) && !PHASE_TALK.test(inner) && !ADR_REFERENCE.test(inner)) {
      return whole; // no internal reference: leave it exactly as the author wrote it
    }
    const kept = inner
      .split(',')
      .map(stripInternal)
      .filter(
        (c) => c !== null && c.length >= 8 && !/^(?:of|the|and|a|an|in|on|for|to|with|its|which|that)\b/i.test(c),
      );
    return kept.length > 0 ? ` (${kept.join(', ')})` : '';
  });

  // Bare inline references. Only the cuts that leave a readable sentence are taken; the rest stay
  // put and are reported, so the caller can stop instead of publishing wreckage.
  const stripped = stripSpans(t, TRANSLATION_RULES);
  t = stripped.text
    .replace(/\s+([,.;:])/g, '$1')
    // Only a parenthetical standing on its own: `parse()` and `String()` are API names, and this
    // used to eat their argument list.
    .replace(/(^|\s)\(\s*\)/g, '$1')
    .replace(/\s{2,}/g, ' ');
  return {
    text: t.replace(new RegExp(`^[\\s,;:.\\-${EM_DASH}]+|[\\s,;:.\\-${EM_DASH}]+$`, 'g'), ''),
    refused: stripped.refused,
  };
}

/** The translated text alone. See sanitizeInternalDetailed for what it refused to touch. */
export function sanitizeInternal(text) {
  return sanitizeInternalDetailed(text).text;
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
 * @returns {{ headline: string, raw: string, changed: boolean, refused: Array<{rule, match}> }}
 *   `changed` is true when translation altered it, which the caller prints so that stripping is
 *   never silent. `refused` lists the banned spans that could not be cut without breaking the
 *   sentence; they are still present in `headline`, and collectHeadlines stops on them.
 */
export function toHeadline(text) {
  const raw = headlineOf(text);
  const { text: sanitized, refused } = sanitizeInternalDetailed(raw);
  const headline = tidy(dejargon(rewriteEmDashes(sanitized)));
  return { headline, raw, changed: headline !== raw, refused };
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

    const { headline, raw, changed, refused } = toHeadline(changeset.summary);
    // A sentence too long for a release bullet is REFUSED, never shortened. Cutting it at a word
    // boundary is what put "...two different drugs with o." on a public page, and what silently
    // dropped a whole clause from the entry above it in the same body.
    // Measured on the TRANSLATED headline, because that is the text that gets published. Measuring
    // the author's raw sentence instead refuses two real changesets whose bullet, once the internal
    // references come out, fits comfortably; and it misses the other direction, since `dejargon`
    // ("slice" -> "change") and `rewriteEmDashes` can each add a character to a sentence that was
    // exactly at the cap. A gate that refuses what its own renderer produces is one nobody can
    // satisfy, and a gate that measures something other than what ships is measuring the wrong thing.
    // NO REPLACEMENT SENTENCE IS OFFERED, and that is deliberate. This message used to end "open the
    // changeset with a sentence that fits ...: <sentence>", where <sentence> was the author's raw
    // opening sentence, i.e. CHARACTER FOR CHARACTER THE ONE IT HAD JUST REFUSED. Measured on
    // `@cosyte/dicom`, `@cosyte/ccda` and `@cosyte/fhir` on 2026-07-29: all three refusals offered
    // back the over-cap sentence as the fix, so a reader who adopted it verbatim failed the next
    // attempt identically. A wrong suggestion in an error message is worse than no suggestion,
    // because it is confidently misleading at exactly the moment someone is trusting the tool.
    //
    // And a CORRECT suggestion cannot be derived here: choosing what to leave out of a sentence is a
    // judgement about which facts matter, which is precisely the judgement this gate refuses to make
    // on the author's behalf (see headlineOf: a mechanical cut published "...two different drugs with
    // o." to a real release). So the message states the constraint, quotes the refused text AS
    // refused, and stops.
    if (headline.length > MAX_HEADLINE_CHARS) {
      const over = headline.length - MAX_HEADLINE_CHARS;
      const measured =
        headline === raw
          ? `The refused sentence is: ${JSON.stringify(raw)}`
          : `The refused sentence is: ${JSON.stringify(raw)}, which this gate would publish as ` +
            `${JSON.stringify(headline)} once internal project bookkeeping is removed, and it is that ` +
            `published form that is measured`;
      throw new NotesError(
        `${file.id}: its opening sentence becomes a release bullet of ${headline.length} characters, ` +
          `and a bullet is capped at ${MAX_HEADLINE_CHARS}, so it is ${over} over. ${measured}. ` +
          `No shortened version of it is suggested here, on purpose: deciding which facts to leave ` +
          `out is a judgement about meaning, and a mechanical cut publishes a fragment that reads as ` +
          `a complete sentence. Rewrite the changeset yourself so it OPENS with a sentence of at most ` +
          `${MAX_HEADLINE_CHARS} characters saying what changed for a reader, and move the rest of ` +
          `the detail into the paragraphs after it, where it is not measured.\n${RECOVERY}`,
      );
    }
    // A cut that would break the sentence is REFUSED, never taken. This is the mid-sentence half of
    // the same rule: see isSafeCut for which cuts are safe and why the rest cannot be repaired.
    if (refused.length > 0) {
      const named = refused.map((r) => `${r.rule} ${JSON.stringify(r.match)}`).join(', ');
      throw new NotesError(
        `${file.id}: ${named} sits in the middle of a clause in ${JSON.stringify(raw)}, and removing ` +
          `it would leave a sentence that does not parse. Rewrite the changeset's first sentence so ` +
          `it says what changed for a reader without depending on the internal reference.\n${RECOVERY}`,
      );
    }
    if (headline === '') {
      throw new NotesError(
        `${file.id}: nothing is left of ${JSON.stringify(raw)} after removing internal project ` +
          `bookkeeping. Rewrite the changeset so its first sentence says what changed for a reader.`,
      );
    }
    // A tail left dangling by translation is a REFUSAL, not a repair. Removing "phase log" from
    // "...as a capability doc, not a phase log" leaves "...not a", and the temptation is to walk
    // back off the loose words. That is how a translator starts editing meaning: the same walk-back
    // turns "the emitter does not" into "the emitter does", which is well-formed prose no gate can
    // catch and the opposite of the truth. So the pipeline stops and asks a human to write a
    // sentence that survives, which costs one changeset edit before anything is published.
    if (changed && DANGLING_TAIL.test(headline)) {
      throw new NotesError(
        `${file.id}: removing internal project bookkeeping from ${JSON.stringify(raw)} leaves ` +
          `${JSON.stringify(headline)}, which trails off. Rewrite the changeset's first sentence so ` +
          `it reads correctly without the internal reference, rather than depending on it.`,
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
    if (!item || !entries.has(item[1].trim())) return;
    const entry = item[1].trim();
    if (!isConsumerFacing(entry)) {
      const found = INTERNAL_ONLY_CHANGE.exec(entry);
      violations.push({
        rule: 'change a consumer of the package cannot observe',
        line: i + 1,
        text: line.trim(),
        match: found ? found[0] : entry,
      });
    }
    // An entry that was cut short. Both shapes are the residue of a LENGTH cut, which the renderer
    // no longer performs; a hit means some other path produced this body, and `assert` runs on
    // exactly that case. The cap is measured with the sentence-ending stop removed, because the
    // renderer appends one to a headline that was already exactly at the cap, and a gate that
    // refuses what its own renderer produces is a gate nobody can satisfy.
    const withoutStop = entry.replace(/[.!?]+\**$/, '');
    if (prose(withoutStop).length > MAX_HEADLINE_CHARS) {
      violations.push({
        rule: 'a change entry longer than a release bullet',
        line: i + 1,
        text: line.trim(),
        match: `${prose(withoutStop).length} characters`,
      });
    } else if (ORPHAN_STUMP.test(withoutStop)) {
      violations.push({
        rule: 'a change entry cut short mid-sentence',
        line: i + 1,
        text: line.trim(),
        match: withoutStop.slice(-24),
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

  entries.forEach((entry, i) => {
    const said = prose(entry);
    if (said.length < MIN_ENTRY_CHARS) {
      problems.push(
        `change entry ${i + 1} says nothing (${said.length} characters, minimum ${MIN_ENTRY_CHARS}): ` +
          JSON.stringify(entry.slice(0, 80)),
      );
    } else if (looksLikeStub(entry)) {
      problems.push(`change entry ${i + 1} is a stub: ${JSON.stringify(entry.slice(0, 80))}`);
    }
  });

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

/** A plain dotted numeric version and nothing else: no prerelease, no build metadata, no `v`. */
const NUMERIC_VERSION = /^\d+(?:\.\d+)*$/;

/**
 * Compare two versions, or `null` when they cannot be compared with certainty.
 *
 * Deliberately NARROW. Anything that is not a plain dotted numeric version -- a prerelease tag, build
 * metadata, a range, an empty string -- returns `null` rather than a guess. `null` is the
 * conservative answer here: the one caller treats it as "not a downward move", which leaves the
 * existing hard failure in place rather than reclassifying a commit nobody can order.
 *
 * @returns {-1|0|1|null} -1 when `a` is strictly lower than `b`.
 */
export function compareNumericVersions(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (!NUMERIC_VERSION.test(left) || !NUMERIC_VERSION.test(right)) return null;
  const la = left.split('.').map(Number);
  const lb = right.split('.').map(Number);
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
    const x = la[i] ?? 0;
    const y = lb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** True when the checkout is shallow, so its history cannot be reasoned about to its beginning. */
function isShallowClone(repo) {
  return (gitOrNull(repo, ['rev-parse', '--is-shallow-repository']) ?? '').trim() === 'true';
}

/**
 * Has this repository's package.json ever carried a version other than `version`?
 *
 * WHAT THIS IS FOR. A repo that has never released has nothing for this gate to derive from: there
 * is no previous version it moved away from, and no changeset was consumed to move it. Four repos
 * sat DEADLOCKED on exactly that, and the deadlock closed on itself: the gate refused in `prepare`,
 * so `changesets/action` never ran, so no "Version Packages" PR was opened, so the version stayed at
 * its scaffold value, so the gate refused again. The version cannot advance past the check that is
 * waiting for it to advance.
 *
 * MEASURED AGAINST `origin/main`, 2026-07-29, and note the date on it: `cli`, `deid` and `synth` are
 * at `0.0.0` with no tags, and they are what this unblocks. `transform` was the fourth and is now at
 * `0.0.1`: it escaped a few hours before this was written, by merging a "Version Packages" PR that
 * had been opened on 2026-07-22, BEFORE the notes gate was made fail-closed. That escape was only
 * ever available to a repo that already had such a PR, which is why it is not a fix: `cli` and
 * `synth` have no Version PR at all, and no run of theirs could open one.
 *
 * WHY THIS TEST AND NOT ONE OF THE OTHER THREE. Each alternative can be wrong, and each is wrong in
 * a way this one is not:
 *
 *   the version is `0.0.0`         a magic value, and neither necessary nor sufficient. A scaffold
 *                                  may start at `0.0.1`, and `0.0.0` is a publishable version, so
 *                                  reading it as "never released" is an assumption about a number.
 *   no `v*` tag exists             a tag is deletable, and a deleted tag would make a repo that HAS
 *                                  released look like one that has not. This is the dangerous
 *                                  direction, and it is one `git push --delete` away.
 *   the registry 404s              needs a network call this gate does not otherwise make, so an npm
 *                                  outage, a rate limit, or a rename would report a published
 *                                  package as unpublished. Same dangerous direction, reached by
 *                                  something outside the repo entirely.
 *   findVersionCommit hit the      what the current error already reports, and too narrow: it is
 *   first commit                   false whenever package.json arrived in the SECOND commit rather
 *                                  than the root, where the same repo instead refuses with "consumed
 *                                  no changesets". One deadlock wearing two error messages.
 *
 * This test is a property of the whole history and of nothing else: no tag, no network, no magic
 * number. A version bump is a commit that changes package.json's version, it is what consumes
 * changesets, and it is the only thing this pipeline ever publishes. So "no commit reachable from
 * HEAD has ever carried a different version" IS "this package has never been versioned", read from
 * the one record that cannot be edited from outside the repo.
 *
 * AND IT CANNOT BE WRONG IN THE DANGEROUS DIRECTION, which is the part that does not rest on the
 * detector being accurate at all. A `true` here does not grant anything: `inspectRelease` reports
 * NOTHING PENDING, `prepare` writes no notes and sets `is-release=false`, and `is-release=false` is
 * what WITHHOLDS the publish command from `changesets/action`. So the worst a false "never
 * versioned" can do is decline to publish. There is no path from this answer to npm, and the gate is
 * never skipped in the sense of being passed; it stops asking a question that has no answer yet.
 *
 * `--full-history` on purpose: it sees strictly more commits than the default simplification, so it
 * can only ever turn a `false` into a `true`, which is the conservative direction. HEAD's history
 * and NOT `--all`: the `changeset-release/main` branch carries the bumped version, and counting it
 * would report every deadlocked repo as already versioned and keep the deadlock exactly as it is.
 *
 * @returns {boolean|null} null when the checkout is shallow, i.e. the question cannot be answered.
 */
export function hasPriorVersion(repo, version) {
  // A shallow checkout's oldest commit LOOKS like a root commit and its history simply stops, so
  // "no other version anywhere" is unknowable rather than false. Answering `false` here would turn a
  // misconfigured `fetch-depth` into a green run that publishes nothing, which is the silent-skip
  // failure this whole script exists to remove. Say "cannot tell" and let the caller fail loudly.
  if (isShallowClone(repo)) return null;
  const shas = git(repo, ['log', '--full-history', '--format=%H', '--', 'package.json'])
    .split('\n')
    .filter(Boolean);
  for (const sha of shas) {
    const at = packageVersionAt(repo, sha);
    if (at !== null && at !== version) return true;
  }
  return false;
}

/**
 * Work out whether there is a pending release and, if so, what it consumed.
 *
 * A release is pending when the version in package.json has no `v<version>` tag yet. That is
 * exactly when `changeset publish` will publish, so the gate and the publish agree on what is
 * happening without either guessing.
 *
 * `code` says WHY there is nothing pending, and the caller acts on it rather than on the prose,
 * because only two of the four are benign:
 *
 *   already-released   the version is tagged, so `changeset publish` has nothing to do. This is the
 *                      state of every ordinary push to main between releases. Quiet, exit 0.
 *   never-versioned    package.json's version has never changed in this repo's history, so nothing
 *                      has been released and no changeset has been consumed. There is no release
 *                      here to describe, and the next thing that should happen is the "Version
 *                      Packages" PR. Quiet, exit 0. See hasPriorVersion.
 *   version-reverted   the commit that introduced HEAD's version moved the version DOWN, so this is
 *                      a recovery from a stranded version commit rather than a release. The release
 *                      is the FRESH Version PR that bumps back up. Quiet, exit 0.
 *   no-package-json    there is no version to reason about at all.
 *   no-version-commit  the version at HEAD appears in no commit, so what this push would publish
 *                      cannot be established from git.
 *
 * The last two mean the pipeline cannot classify the commit. `cmdPrepare` stops the run there, while
 * npm is still untouched, rather than letting the publish step decide on its own.
 */
export function inspectRelease(repo, packageName) {
  const version = packageVersionAt(repo, 'HEAD');
  if (version === null) {
    return { isRelease: false, code: 'no-package-json', reason: 'no readable package.json at HEAD' };
  }

  if (gitOrNull(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`]) !== null) {
    return {
      isRelease: false,
      code: 'already-released',
      version,
      reason: `v${version} is already tagged, so no release is pending`,
    };
  }

  // A repo that has never been versioned is not a release that cannot describe itself; it is a repo
  // with no release in it yet. Classifying it as a pending release and then refusing is what
  // deadlocked four repos, and the refusal was correct about the facts and wrong about the question.
  //
  // NOTE WHERE THIS SITS. After the tag check, so a released repo is still short-circuited by its
  // tag, and BEFORE `findVersionCommit`, so it covers both shapes the deadlock takes: package.json
  // in the root commit (the first-commit refusal below) and package.json in a later commit with no
  // changesets deleted alongside it (the "consumed no changesets" refusal further down).
  //
  // AND NOTHING IS RELAXED FOR A REPO THAT HAS RELEASED. Once any other version exists in the
  // history this branch is unreachable for that repo: a bump that consumed no changesets, a
  // consumed changeset with an empty summary, a body carrying internal bookkeeping all still stop
  // the run exactly as before.
  //
  // Said exactly, because the obvious stronger sentence ("a published package can never re-enter
  // this state, history only grows") is FALSE and was written here before a refuter built the
  // counter-example: orphan-rewriting main and deleting the tag reproduces `never-versioned` on a
  // published package, and so do a workspace layout whose root package.json is not the published one
  // and a detached HEAD before the version commit. None is reachable from this org's callers today
  // (13 single-package repos, `push: [main]` only, no `workflow_dispatch`), and none of them matters
  // even if it were, for the reason above: every one of those states lands on `is-release=false`,
  // which withholds the publish command. The failure mode of being wrong here is declining to
  // publish, and there is no version of being wrong here that publishes.
  if (hasPriorVersion(repo, version) === false) {
    return {
      isRelease: false,
      code: 'never-versioned',
      version,
      reason:
        `${packageName} has never been versioned: ${version} is the only version this repository's ` +
        `history has ever carried, so nothing has been released and no changeset has been consumed`,
    };
  }

  const commit = findVersionCommit(repo, version);
  if (commit === null) {
    return {
      isRelease: false,
      code: 'no-version-commit',
      version,
      reason: `no commit introduces version ${version}`,
    };
  }
  // Reached only when the history says a DIFFERENT version has existed and yet the current one
  // traces back to a commit with no parent. A never-versioned repo no longer arrives here at all;
  // it is classified above. What is left is a checkout whose history has been cut off, which is
  // what a shallow clone looks like from here: its oldest commit has no parent and reads as a root.
  // That is not a release with no record, it is a record that was not fetched, so the message says
  // so rather than repeating the deadlock's wording.
  if (!commit.hasParent) {
    throw new NotesError(
      `version ${version} traces back to a commit with no parent, yet this repository's history ` +
        `also carries a different version, so that commit cannot be where ${version} began. The ` +
        `usual cause is a shallow checkout, whose oldest commit reads as a root commit and hides ` +
        `the version bump. Check that the release job checks out with fetch-depth: 0.`,
    );
  }

  // A VERSION THAT MOVED DOWN IS A RECOVERY, NEVER A RELEASE.
  //
  // WHAT THIS UNBLOCKS. Recovering a stranded version commit means REVERTING it: the version goes
  // back down (`0.0.4` -> `0.0.3`) and the reverting commit consumes no changesets -- it RESTORES
  // them, by construction, since the commit it undoes is the one that deleted them. This gate read
  // that as a pending `0.0.3` release with nothing to derive from and refused in `prepare`, which
  // runs BEFORE `changesets/action` with no `continue-on-error`. So no Version PR ever opened and
  // every later push to main failed identically. `@cosyte/fhir` was held there on 2026-07-29 and
  // there is no fix available inside fhir: any commit that lowers a version consumes no changesets.
  // `ccda` and `dicom` survived a byte-identical recovery only because they carry tags from real
  // publishes and hit the `already-released` short-circuit above; fhir has zero tags, local and
  // remote, because an npm name-similarity rejection has kept it unpublished. And `never-versioned`
  // does not cover it either, because `0.0.4` IS a real prior version.
  //
  // THE SIGNAL IS THE DIRECTION OF THE MOVE, read at the commit that introduced HEAD's version and
  // nowhere else. Under ADR 0001 a version never moves backwards and a published version is
  // permanent, so a version this repository's own history has already moved PAST is not one it is
  // releasing; it is one it has returned to. The release that follows a recovery is the FRESH Version
  // PR, which bumps back up, consumes the reworded changesets, and goes through this gate whole.
  //
  // IT CANNOT BE WRONG IN THE DANGEROUS DIRECTION, and that does not rest on the detector being
  // accurate. This verdict GRANTS NOTHING: it sets `is-release=false`, which is precisely what
  // WITHHOLDS the publish command from `changesets/action`. There is no path from this answer to npm.
  // The worst a false positive can do is decline to publish, which a fresh Version PR then undoes.
  //
  // AND IT DOES NOT WEAKEN THE FAIL-CLOSED PROPERTY BELOW. A FORWARD move that consumed no
  // changesets still throws, loudly, exactly as before: that refusal is what catches a version commit
  // whose changesets went missing, and it is not reached from here because a forward move is not a
  // downward one. The test is strictly on `-1`, and `compareNumericVersions` answers `null` -- which
  // is not `-1` -- for anything it cannot order with certainty, so an unorderable pair falls through
  // to that same hard failure rather than into this branch.
  //
  // ALTERNATIVES REJECTED, each for a reason rather than a preference:
  //
  //   tag `v0.0.3` on the unpublished version to force `already-released` -- REJECTED BY THE FOUNDER
  //     and not implemented. The tag is this pipeline's proxy for "npm has this version". Creating one
  //     for a version npm does not have makes the proxy assert a falsehood, and trades away a
  //     deliberately fail-closed ADR 0001 property to route around a bug in the classifier.
  //   detect "the reverting commit RESTORED changesets" as the precondition -- rejected as a
  //     PRECONDITION, kept as reported EVIDENCE below. It is real evidence, but making the fix depend
  //     on the recovery commit having that exact file shape makes the unblocking fragile (reword the
  //     changesets in the same commit, or drop one, and fhir stays blocked), and it buys no safety:
  //     every extra conjunct only narrows a verdict that already grants nothing.
  //   compare against the HIGHEST version anywhere in history -- rejected on a counter-example. One
  //     botched bump to `1.0.0`, reverted, would then classify every subsequent genuine `0.0.x`
  //     release as superseded, forever and silently. That is the permanent deadlock this change
  //     exists to remove, rebuilt. The comparison is LOCAL to the version commit for that reason.
  //   require `consumed.length === 0` as well -- considered and deliberately widened. A downward move
  //     that DID consume changesets is not a release either, and today it derives notes and publishes
  //     a version lower than one this repository has already carried, which ADR 0001 forbids outright.
  //     Declining is strictly safer than that. The two shapes are told apart in the `reason` instead
  //     of one of them being hidden, so the log still says which happened.
  if (compareNumericVersions(version, commit.previousVersion) === -1) {
    const restored = git(repo, [
      'diff',
      '--diff-filter=A',
      '--name-only',
      `${commit.sha}^`,
      commit.sha,
      '--',
      '.changeset',
    ])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\.changeset\/.+\.md$/.test(line) && !/\/README\.md$/i.test(line));
    // Evidence, not a precondition: it tells the reader of the log which of the two shapes this is.
    const shape =
      restored.length > 0
        ? `that commit restored ${restored.length} changeset(s), which is the shape of a reverted ` +
          `version commit`
        : `that commit restored no changesets, so it is not shaped like a reverted version commit; ` +
          `check that lowering the version was intended`;
    return {
      isRelease: false,
      code: 'version-reverted',
      version,
      previousVersion: commit.previousVersion,
      restored,
      reason:
        `${packageName} moved DOWN from ${commit.previousVersion} to ${version} in ` +
        `${commit.sha.slice(0, 7)}, so ${version} is a version this repository has already moved past ` +
        `rather than one it is releasing, and ${shape}`,
    };
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
    setOutput('is-release', 'false');
    // `is-release` is what release.yml hands to `changesets/action` as permission to publish, so a
    // false here means npm is not reached at all. That is safe only when we KNOW there is nothing to
    // publish, which is what `already-released` says: the version is tagged, and this pipeline only
    // ever creates that tag after a successful publish.
    //
    // `never-versioned` is benign for the same reason and by a different route: package.json's
    // version has never changed, so no changeset has ever been consumed and nothing has ever been
    // published from this repo. There is no release on this commit to describe. What this run SHOULD
    // do is let `changesets/action` open the "Version Packages" PR, which is precisely what
    // `is-release=false` allows: the action opens that PR whether or not a publish command is set.
    // Merging it produces a version commit with a real previous version and real consumed
    // changesets, and THAT run goes through this gate whole. Nothing is skipped, it is deferred by
    // one commit to the commit that actually has something to say.
    //
    // The other codes are different in kind. They mean this run could not work out what the commit
    // is, and answering "then do not publish" would be a guess dressed as a decision: it would end
    // green having shipped nothing, on a commit that may well have been a release. Stop instead, red
    // and before the publish step, which is the whole point of deriving the notes first.
    //
    // `version-reverted` is benign by the same argument and a third route: the version at HEAD is
    // LOWER than one this repository has already carried, so under ADR 0001 it is not a version this
    // pipeline may publish at all. What this run should do is let `changesets/action` open the fresh
    // "Version Packages" PR that bumps back up and consumes the reworded changesets, and that is
    // exactly what `is-release=false` allows.
    if (
      release.code !== 'already-released' &&
      release.code !== 'never-versioned' &&
      release.code !== 'version-reverted'
    ) {
      fail(
        `Cannot establish what a publish of ${packageName} from this commit would ship: ` +
          `${release.reason}. Release notes are derived from git, so an unclassifiable commit has no ` +
          `notes, and publishing to npm is permanent. Nothing has been published. Check that the ` +
          `checkout has full history (fetch-depth: 0) and that package.json is readable at HEAD.`,
      );
      return;
    }
    process.stdout.write(`No release pending: ${release.reason}.\n`);
    if (release.code === 'never-versioned') {
      // Deliberately conditional about the PR. With pending changesets this run opens one; with
      // none it opens nothing, and there is no signal here that tells the two apart. Re-deriving
      // "are there pending changesets" to firm up a log line is the same predicate this workflow
      // refuses to re-derive anywhere it matters, so the sentence hedges instead.
      process.stdout.write(
        `This is the state before a first release, not a failure. The release is the "Version ` +
          `Packages" pull request, which this run opens if any changesets are pending: merging it ` +
          `bumps the version and consumes them, and the release it cuts is derived from those ` +
          `changesets and checked in full.\n`,
      );
    }
    if (release.code === 'version-reverted') {
      // Said at length rather than left as one line, because this is the state a human is most
      // likely to be standing in front of wondering whether the pipeline noticed. It has, and it is
      // declining to publish rather than failing to.
      //
      // CONDITIONAL ON THE EVIDENCE, and this file's own defect-2 lesson is why. An earlier revision
      // printed the "this is a recovery" paragraph unconditionally, so on the widened shape (a
      // downward move that DID consume changesets) all three of its clauses were false, and it
      // overrode the line above it that had correctly said this is not revert-shaped. A message that
      // contradicts its own evidence is confidently misleading at exactly the moment someone is
      // trusting the tool, which is the defect this same commit fixes in the over-cap refusal.
      process.stdout.write(
        release.restored.length > 0
          ? `This is a recovery, not a failure, and nothing has been published. A reverted version ` +
              `commit consumes no changesets by construction, so there is nothing here to derive ` +
              `notes from and nothing here to release: ${release.version} is behind ` +
              `${release.previousVersion}, which this repository has already carried. Correct the ` +
              `changesets on main and let Changesets open a fresh "Version Packages" pull request, ` +
              `which this run opens if any are pending: merging it bumps the version forward again, ` +
              `consumes them, and the release it cuts is derived and checked in full.\n`
          : `Nothing has been published, and nothing is being published from this commit: ` +
              `${release.version} is behind ${release.previousVersion}, which this repository has ` +
              `already carried, and a version may not move backwards. This commit is NOT shaped like ` +
              `a reverted version commit, so do not assume it is one: check that lowering the ` +
              `version was intended, and note that if changesets were consumed here their record of ` +
              `what shipped has been spent without a release. Moving forward again through a fresh ` +
              `"Version Packages" pull request is what this gate can derive notes from.\n`,
      );
    }
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
