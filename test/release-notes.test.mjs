// Unit tests for scripts/release-notes.mjs.
//
// The success case is proved against REAL captured input: the 15 changesets that cosyte/hl7's
// "Version Packages" PR #61 consumed to cut v0.0.2 (recovered from d655bb6^), sitting in
// test/fixtures/hl7-v0.0.2/changeset/. That release is the one the founder called out as saying
// nothing, and the body derived from these fixtures is asserted byte-for-byte against the body
// that is live on the release today.
//
// The failure cases are seeded, not asserted about in the abstract: each one runs the real CLI and
// proves it exits non-zero. An unproven guard is not a guard.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertPublishableNotes,
  collectHeadlines,
  DANGLING_TAIL,
  dejargon,
  extractChangeEntries,
  findViolations,
  findVersionCommit,
  hasPriorVersion,
  headlineOf,
  inspectRelease,
  isConsumerFacing,
  isSafeCut,
  parseChangeset,
  renderNotes,
  rewriteEmDashes,
  sanitizeInternal,
  tidy,
  toHeadline,
} from '../scripts/release-notes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/release-notes.mjs');
const FIXTURE_DIR = join(HERE, 'fixtures/hl7-v0.0.2/changeset');
const EXPECTED_BODY = join(HERE, 'fixtures/hl7-v0.0.2/expected-release-body.md');

/** The exact body every cosyte release carried before this change. */
const PRODUCTION_STUB = 'Automated release of v0.0.2.';

/** U+2014 as an escape: these files must not contain the character under test. */
const EM = '\u2014';

function loadFixtureFiles() {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ id: name, text: readFileSync(join(FIXTURE_DIR, name), 'utf8') }));
}

function runCli(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/**
 * Run `prepare` the way the workflow does, and hand back the step outputs it wrote.
 *
 * The outputs are not a diagnostic here: `is-release` is what release.yml passes to
 * `changesets/action` as the publish command, so this is the value that decides whether npm is
 * reached at all.
 */
function runPrepare(dir, { out = join(dir, 'notes.md'), package: pkg = '@cosyte/hl7' } = {}) {
  const outputsFile = join(mkdtempSync(join(tmpdir(), 'release-notes-outputs-')), 'outputs.txt');
  writeFileSync(outputsFile, '');
  const result = runCli(['prepare', '--repo', dir, '--package', pkg, '--out', out], {
    GITHUB_OUTPUT: outputsFile,
  });
  const outputs = Object.fromEntries(
    readFileSync(outputsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  rmSync(dirname(outputsFile), { recursive: true, force: true });
  return { ...result, outputs };
}

// ===============================================================================================
// The three traps. These bit for real on 2026-07-27, across 14 public releases.
// ===============================================================================================

test('TRAP 1: keying is on project prefixes, so healthcare field references survive', () => {
  // Ours, and they must go.
  for (const id of ['HL7-U', 'MLLP-8.1', 'CCDA-P7', 'DOCS-CONTENT-P4', 'TERMINOLOGY-3', 'MLLP-10']) {
    const out = sanitizeInternal(`Fix the thing ${id} covers`);
    assert.ok(!out.includes(id), `${id} should have been removed, got ${JSON.stringify(out)}`);
  }
  // Theirs, and they are exactly the reference material a consumer needs.
  for (const ref of ['SCH-11', 'PID-3', 'MSH-2', 'NM1-03', 'OBX-5', 'MSA-2', 'TXA-1', 'ISA-13']) {
    const text = `Read the ${ref} field verbatim`;
    assert.equal(sanitizeInternal(text), text, `${ref} must survive untouched`);
    assert.deepEqual(findViolations(`### What changed\n\n- Read the ${ref} field verbatim.\n`), []);
  }
});

test('TRAP 2: decapitation is repaired, never left as a fragment', () => {
  const { headline } = toHeadline('Phase 7 (thirteenth slice): builder emits Assessment Scale Observations.');
  assert.ok(!headline.startsWith('('), `leading orphan parenthetical survived: ${JSON.stringify(headline)}`);
  assert.ok(!/thirteenth/i.test(headline));
  assert.ok(!/^[\s,;:.-]/.test(headline), 'leading punctuation survived');
  assert.equal(headline, 'Builder emits Assessment Scale Observations');

  // The real astm case: an identifier plus phase talk inside one parenthetical leaves nothing worth
  // keeping, so the whole parenthetical goes rather than shipping "(: the final phase)".
  const astm = toHeadline(`Release hardening (ASTM-10, roadmap Phase 10 ${EM} the final phase). Publish-readiness.`);
  assert.equal(astm.headline, 'Release hardening');
});

test('TRAP 3: the identifier check is case sensitive, so real content survives', () => {
  for (const text of [
    'Add the FHIR-bridge IR-stability contract + coverage proof',
    'Bring `docs-content/` to the full canonical Diataxis spine',
    'Correct the x12-parser entry point',
  ]) {
    assert.equal(sanitizeInternal(text), text, `${JSON.stringify(text)} must survive`);
  }
});

test('leading digits are content, not decapitation: X12 transaction numbers survive', () => {
  for (const text of ['835 remittance advice decoding', '271 eligibility response', '837P claim builder']) {
    assert.equal(tidy(sanitizeInternal(text)), text);
  }
});

test('DICOM slice vocabulary is never rewritten to "change"', () => {
  // Grounded in @cosyte/dicom's own generated tag dictionary.
  for (const text of [
    'Read the slice thickness from the first frame',
    'Expose the Number of Slices attribute',
    'Correct the Time Slice Vector decoding',
    'Honour the slice location when sorting a series',
    'Fix the Slice Progression Direction lookup',
    'Decode Spacing Between Slices',
  ]) {
    assert.equal(dejargon(text), text, `${JSON.stringify(text)} must not be dejargoned`);
    assert.deepEqual(findViolations(`### What changed\n\n- ${text}.\n`), [], text);
  }
  // But our own unit-of-work usage is rewritten.
  assert.equal(dejargon('the misfiling-prevention slice'), 'the misfiling-prevention change');
  assert.equal(dejargon('one of which that slice created'), 'one of which that change created');
});

// ===============================================================================================
// Translation at the boundary
// ===============================================================================================

test('phase and slice language is removed, ordinary English is not', () => {
  assert.equal(sanitizeInternal('Add streaming parse (HL7-S, Phase S)'), 'Add streaming parse');
  assert.equal(sanitizeInternal('Ship it (roadmap Phase K)'), 'Ship it');
  assert.equal(sanitizeInternal('Ship it, Phase 5b'), 'Ship it');
  assert.equal(sanitizeInternal('Ship it (the sixth and final phase)'), 'Ship it');
  assert.equal(
    sanitizeInternal('Keep the reader in phase with the source system'),
    'Keep the reader in phase with the source system',
  );
});

test('ADR references are removed', () => {
  assert.equal(
    sanitizeInternal('Grounded in a public spec, not an invented quirk (ADR 0018)'),
    'Grounded in a public spec, not an invented quirk',
  );
  assert.ok(!sanitizeInternal('Per ADR-0021 the cap moved').includes('ADR'));
});

test('the internal priority label is removed but real P-codes are not', () => {
  assert.equal(sanitizeInternal('Patient-identity / merge events (P0 safety)'), 'Patient-identity / merge events');
  assert.equal(
    sanitizeInternal('Reorder the P1 documentation pass'),
    'Reorder the pass',
  );
  // The label rule must never key on the `P<n>` SHAPE. These are ICD-10-CM perinatal codes and an
  // ASTM patient record, and deleting one to remove an internal label is not a trade worth making.
  for (const text of [
    'Map ICD-10 P07, P22 and P29 to SNOMED CT',
    'Add crosswalk coverage for ICD-10 chapter P00-P96',
    'Support the ASTM P1 record, P2, and P3 variants',
    'Model the full patient `P` record identity',
  ]) {
    assert.equal(sanitizeInternal(text), text, `${JSON.stringify(text)} must survive untouched`);
  }
});

test('every known project prefix is caught by the gate, including the ones minted in roadmaps', () => {
  // TERM-N is live in operations/roadmaps/terminology.md, and terminology calls this workflow.
  for (const id of ['TERM-6', 'TERM-N', 'PKG-5', 'WF-3', 'PARSERS-PUBLIC-2', 'VERIFY-AT']) {
    const violations = findViolations(`### What changed\n\n- A described change carrying ${id} detail.\n`);
    assert.ok(
      violations.some((v) => v.rule === 'internal project identifier'),
      `${id} must be caught, got ${JSON.stringify(violations)}`,
    );
  }
});

test('a tail left dangling by translation is REFUSED, never repaired by rewriting', () => {
  // The real ccda case: once "phase log" is removed, "..., not a phase log" leaves "..., not a".
  // Walking back off those loose words is what turns "the emitter does not" into "the emitter
  // does", so the pipeline stops and asks for a sentence that survives instead.
  assert.throws(
    () =>
      collectHeadlines(
        [
          {
            id: 'docs.md',
            text: '---\n"@cosyte/ccda": patch\n---\n\nDocs: rewrite `docs-content/` capability claims as a capability doc, not a phase log.\n',
          },
        ],
        '@cosyte/ccda',
      ),
    /trails off/,
  );
});

test('translation NEVER changes what a sentence claims', () => {
  // Every one of these ends in a word an over-eager tail trim would eat, and every one is
  // load-bearing. Measured across the caller repos' changesets and changelogs, 45 real sentences
  // end this way. Inverting one on a public release page is a lie a well-formed-prose gate cannot
  // catch, which is why the dangling list holds pure function words only.
  for (const sentence of [
    'The parser tolerates a truncated trailer, the emitter does not',
    '`Dataset.get` / `has` take the 8-character `(group,element)` tag form only',
    'R5 and DSTU2 are read-tolerance only',
    'The certification is the qualified expert\'s, always',
    'Both the sender and the receiver must agree, and each retries',
  ]) {
    assert.equal(toHeadline(`${sentence}.`).headline, sentence, `meaning changed: ${sentence}`);
  }
  // Nothing walks back off a dangling word any more, but the word list still decides what counts as
  // one, so the list itself is what has to stay honest. Negations and quantifiers must never join
  // it: reading "the emitter does not" as a dangling tail is how a gate starts editing meaning.
  assert.ok(DANGLING_TAIL.test('and `reescape` emits a'), 'a pure function word is a dangling tail');
  assert.ok(!DANGLING_TAIL.test('the emitter does not'), '`not` must never be treated as danglable');
  assert.ok(!DANGLING_TAIL.test('take the tag form only'), '`only` must never be treated as danglable');
  assert.ok(!DANGLING_TAIL.test('Add `profiles.epic`'));
  for (const word of ['not', 'no', 'never', 'only', 'both', 'more', 'each']) {
    assert.ok(!DANGLING_TAIL.test(`the emitter is ${word}`), `${word} must not be in the list`);
  }
});

// ===============================================================================================
// TRAP 2 continued: the mid-sentence cut, and the length cut. Both shipped before they were caught.
// ===============================================================================================

test('a cut is taken only where the sentence survives it', () => {
  //          0123456789...
  const text = 'Reorder the P1 documentation pass';
  assert.equal(isSafeCut(text, 12, 28), true, 'a modifier inside one clause can be lifted out');
  assert.equal(isSafeCut('Ship it, Phase 5b', 9, 17), true, 'the tail of the sentence goes with it');
  assert.equal(isSafeCut('Phase 7: builder emits X', 0, 7), true, 'the head of the sentence goes with it');
  assert.equal(isSafeCut('Emit X, Phase 5b, and Y', 8, 16), true, 'a whole clause between separators');
  // The measured defect: a separator on exactly one side means the rest of the clause stays behind.
  assert.equal(isSafeCut('It no longer carries phase language, and more', 21, 35), false);
});

test('DEFECT 1: a mid-clause cut is REFUSED, and the banned text survives so the gate can see it', () => {
  // Verbatim from hl7@1c5c0f5:.changeset/public-surface-hygiene-dist.md, which was one approval
  // away from a real @cosyte/hl7 publish. Before this change the translator produced "...no longer
  // carries, item identifiers or ADR numbers...", reported changed: true, and findViolations
  // reported NOTHING, because a mangled sentence carries no banned bytes to find.
  const summary =
    '**The published JSDoc no longer carries phase language, item identifiers or ADR numbers, and\n' +
    '`src/` doc comments are gated (`PUBLIC-SURFACE-HYGIENE`).** Doc comments compile into `dist`.\n';
  const { headline, refused } = toHeadline(summary);

  assert.ok(headline.includes('carries phase language,'), `sentence was mangled: ${JSON.stringify(headline)}`);
  assert.deepEqual(
    refused.map((r) => r.match),
    ['phase language'],
  );
  // And now the gate can observe it, which is the whole point: leaving the banned span in place is
  // what puts something in the bytes for a byte-level rule to find.
  const violations = findViolations(`### What changed\n\n- ${headline}.\n`);
  assert.ok(
    violations.some((v) => v.rule === 'phase or slice language'),
    `the gate must see it, got ${JSON.stringify(violations)}`,
  );
  // End to end, the release stops before anything is published.
  assert.throws(
    () => collectHeadlines([{ id: 'dist.md', text: `---\n"@cosyte/hl7": patch\n---\n\n${summary}` }], '@cosyte/hl7'),
    /sits in the middle of a clause/,
  );
});

test('DEFECT 2: an over-long opening sentence is REFUSED, never silently shortened', () => {
  // The real ccda case, verbatim from ccda@.changeset/ccda-nullflavor-residuals.md. The published
  // v0.0.2 body carries this cut to "...naming **two different drugs** with o." to this day.
  const long =
    'Close the two residuals the previous change named and argued rather than fixed: a **patient ' +
    'identifier** read out of a `nullFlavor`-marked `<id>`, and a medication naming **two different ' +
    'drugs** with one silently dropped.';
  const head = headlineOf(long);
  assert.ok(head.endsWith('with one silently dropped'), `the sentence was cut: ${JSON.stringify(head)}`);
  assert.ok(head.length > 200, 'this fixture must exercise the over-cap path');
  assert.throws(
    () => collectHeadlines([{ id: 'residuals.md', text: `---\n"@cosyte/ccda": patch\n---\n\n${long}\n` }], '@cosyte/ccda'),
    /opening sentence is \d+ characters/,
  );
});

test('the gate sees a body that was cut short, whatever produced it', () => {
  // `assert` re-reads finished bytes and knows nothing about the renderer, so these are the shapes
  // it can actually observe: the stump a word-boundary cut leaves, a dangling function word, and an
  // entry too long to be a bullet.
  const stump = '### What changed\n\n- A medication naming two different drugs with o.\n';
  assert.ok(
    findViolations(stump).some((v) => v.rule === 'a change entry cut short mid-sentence'),
    JSON.stringify(findViolations(stump)),
  );
  const dangling = '### What changed\n\n- Rewrite the capability claims as a capability doc, not a.\n';
  assert.ok(findViolations(dangling).some((v) => v.rule === 'a change entry cut short mid-sentence'));
  const overlong = `### What changed\n\n- ${'A described change that runs on. '.repeat(8)}\n`;
  assert.ok(findViolations(overlong).some((v) => v.rule === 'a change entry longer than a release bullet'));
  for (const body of [stump, dangling, overlong]) {
    assert.ok(assertPublishableNotes(body).some((p) => p.startsWith('line 3 carries')), body);
  }

  // And a single-letter API name is not a stump: the code span sits between the letter and the end.
  assert.deepEqual(findViolations('### What changed\n\n- Model the query record `Q`.\n'), []);
});

test('nothing tidies further than the cut it is tidying', () => {
  // The X12 composite is verbatim from cosyte/x12's own 837P edge-case fixture. A revision of the
  // mid-clause fix collapsed adjacent clause punctuation over the finished string, to close the
  // "X, , and Y" a whole-clause cut leaves. It deleted three empty composite positions here and
  // moved the amount from HI-01-05 to HI-01-03, on a sentence with no internal reference in it, and
  // the gate scored the corrupted output clean. The collapse now happens only at the seam.
  for (const text of [
    'Tolerate an empty composite position in `HI*BE:01:::500:1` on parse',
    'Expose `parse()` and `serialize()` on the reader',
    'Read the ISA at 10:30 exactly',
    'Emit the ratio as 1:2:1 verbatim',
  ]) {
    assert.equal(sanitizeInternal(text), text, `${JSON.stringify(text)} must survive untouched`);
    assert.deepEqual(findViolations(`### What changed\n\n- ${text}.\n`), [], text);
  }
  // And the seam itself is still closed when a whole clause does come out.
  assert.equal(sanitizeInternal('Emit warnings, Phase 5b, and round-trip the ISA'), 'Emit warnings, and round-trip the ISA');

  // The cases above never reach the collapse, because there is nothing in them to cut. These two
  // do. `CI-1` is a real prefix; in the first it sits between two STRUCTURAL colons binding an X12
  // composite, so the collapse must DECLINE and leave the position empty, or `500` moves from the
  // fifth composite position to the third. A separator only ends a clause when whitespace sits on
  // the far side of it. In the second the same token sits between two real clause commas, so the
  // collapse must FIRE, which is what makes the first assertion evidence rather than an accident.
  assert.equal(
    sanitizeInternal('Fix `HI*BE:CI-1:500:1` so the amount lands right'),
    'Fix `HI*BE::500:1` so the amount lands right',
  );
  assert.equal(sanitizeInternal('Read the ISA at 10:30, CI-1, exactly'), 'Read the ISA at 10:30, exactly');
  // A full stop joins two sentences, not two clauses, so its comma stays.
  assert.equal(sanitizeInternal('Fix A. Phase 5b, and C'), 'Fix A., and C');
});

test('headlineOf never emits a sentence stop followed by a space, which the collapse relies on', () => {
  // The seam collapse is safe partly because a headline cannot contain "X. Y": headlineOf ends the
  // sentence there. That invariant is load-bearing, so it is asserted rather than assumed.
  for (const text of [
    'Fix A. Then fix B.',
    'Correct the MSH-9 lookup. Also the MSH-10 echo.',
    '**Bold lead-in.** Then detail. And more.',
    'Ship v0.0.2 and move on.',
  ]) {
    assert.ok(!/[.!?]\s/.test(headlineOf(text)), `${JSON.stringify(headlineOf(text))} carries a stop and a space`);
  }
});

test('a span glued to its neighbour is part of one word, and is refused', () => {
  // `The MLLP-1-driven reconnect` used to translate to `The -driven reconnect`.
  const { headline, refused } = toHeadline('The MLLP-1-driven reconnect now backs off.');
  assert.equal(headline, 'The MLLP-1-driven reconnect now backs off');
  assert.deepEqual(refused.map((r) => r.match), ['MLLP-1']);
  assert.equal(isSafeCut('The MLLP-1-driven reconnect', 4, 10), false);
});

test('a parenthetical is cleaned against the whole sentence, not one segment at a time', () => {
  // Same defect as DEFECT 1, one parenthesis away. Splitting on commas first made the segment's own
  // end look like the end of the text, so the cut read as a safe tail cut and was taken:
  // "(it no longer carries, item identifiers or ADR numbers)" shipped.
  const { headline } = toHeadline(
    'Gate the published JSDoc (it no longer carries phase language, item identifiers or ADR numbers) on every build.',
  );
  assert.ok(!headline.includes('carries,'), `mangled: ${JSON.stringify(headline)}`);
  assert.equal(headline, 'Gate the published JSDoc (item identifiers or ADR numbers) on every build');
});

test('a complete sentence is never read as a cut-off one', () => {
  // Every one of these is correct English that ends in a word a wider truncation rule eats. The
  // second is from ccda/.changeset/ccda-silent-clinical-data.md, which a real @cosyte/ccda release
  // consumed: refusing it would have blocked a publish on a lie.
  for (const entry of [
    'Read the field exactly the way the sender wrote it',
    'Close four instances of one defect class: the parser got quieter the more broken the document was',
    'Pass an unknown Z-segment through to the emitter as is',
    'Convert every dose quantity the builder emits to mL',
    'Report the potassium result in mmol per L',
    'Accept a blood group recorded as A, B, AB, or O',
    'Emit the acknowledgement code AA',
    'Model the query record `Q`',
    'R5 and DSTU2 are read-tolerance only',
  ]) {
    assert.deepEqual(findViolations(`### What changed\n\n- ${entry}.\n`), [], entry);
  }
});

test('the renderer and the gate agree on what fits in a bullet, at the cap exactly', () => {
  // renderNotes appends the full stop, so a headline of exactly the cap renders one character over
  // it. A gate that refuses what its own renderer produces is a gate nobody can satisfy.
  for (const length of [198, 199, 200]) {
    const headline = `Correct the MSH-9 structure lookup ${'x'.repeat(length - 35)}`;
    assert.equal(headline.length, length);
    const body = renderNotes({ packageName: '@cosyte/hl7', version: '0.0.3', headlines: [headline] });
    assert.deepEqual(assertPublishableNotes(body), [], `${length} characters must pass both halves`);
  }

  // The cap is measured on what SHIPS, so translation is accounted for in both directions.
  const frontmatter = '---\n"@cosyte/hl7": patch\n---\n\n';
  const grows = `Correct the MSH-9 lookup in the final slice ${'x'.repeat(156)}`;
  assert.equal(grows.length, 200, 'the author sentence is exactly at the cap');
  assert.equal(toHeadline(`${grows}.`).headline.length, 201, '"slice" -> "change" pushes it over');
  assert.throws(
    () => collectHeadlines([{ id: 'g.md', text: `${frontmatter}${grows}.\n` }], '@cosyte/hl7'),
    /is 201 characters/,
  );

  const shrinks = `Add conformance-profile tooling (HL7-U, roadmap Phase U) ${'x'.repeat(150)}`;
  assert.ok(shrinks.length > 200, 'the author sentence is over the cap');
  const { kept } = collectHeadlines([{ id: 's.md', text: `${frontmatter}${shrinks}.\n` }], '@cosyte/hl7');
  assert.equal(kept.length, 1, 'but the bullet that ships fits, so it is not refused');
  assert.ok(kept[0].length <= 200);
});

test('the gate sees the wreckage a cut leaves in the bytes', () => {
  for (const [label, line] of [
    ['doubled clause punctuation', 'Emit warnings,, and round-trip the ISA byte-exact.'],
    ['a gap before punctuation', 'Emit warnings for every segment , and round-trip the ISA.'],
    ['an empty parenthetical', 'Emit warnings for every unknown segment ( ) on parse.'],
  ]) {
    const body = `### What changed\n\n- ${line}\n`;
    assert.ok(
      findViolations(body).some((v) => v.rule.startsWith('mangled prose')),
      `${label} must be caught, got ${JSON.stringify(findViolations(body))}`,
    );
  }
});

test('release.yml derives the notes once, and asserts them on both sides of the publish step', () => {
  // The composition test below proves the CLI supports this shape. This proves the workflow
  // actually uses it: re-introducing a second `prepare` after the publish would otherwise pass.
  //
  // TWO asserts, and which side of the publish each one sits on is the whole of the ordering fix.
  // The first proves the finished bytes while npm is still untouched, so a body that is unfit costs
  // a re-run and nothing else. The second reconciles those same bytes against the version Changesets
  // reported publishing, which does not exist any earlier and is the only check that legitimately
  // follows the publish. A single assert on the far side, which is what this workflow had, makes the
  // check a report on an irreversible act rather than a gate in front of it.
  const workflow = readFileSync(resolve(HERE, '../.github/workflows/release.yml'), 'utf8');
  const prepares = [...workflow.matchAll(/release-notes\.mjs prepare\b/g)];
  assert.equal(prepares.length, 1, 'the notes must be derived exactly once');
  const asserts = [...workflow.matchAll(/release-notes\.mjs assert\b/g)];
  assert.equal(asserts.length, 2, 'the bytes must be proved before the publish and reconciled after it');

  const changesetsAction = workflow.indexOf('uses: changesets/action@');
  assert.ok(changesetsAction > 0);
  assert.ok(prepares[0].index < changesetsAction, 'prepare must run BEFORE the publish step');
  assert.ok(asserts[0].index < changesetsAction, 'the body must be proved fit before npm is reached');
  assert.ok(asserts[1].index > changesetsAction, 'the published version must still be reconciled after');
  // Every one of the three steps must name the same file, or the asserts guard nothing.
  assert.equal([...workflow.matchAll(/\$RUNNER_TEMP\/release-notes\.md/g)].length, 3);
});

test('a single short but genuine change is a publishable release', () => {
  for (const headline of ['Add `profiles.epic`', 'Fix the CRLF split']) {
    const body = renderNotes({ packageName: '@cosyte/hl7', version: '0.0.3', headlines: [headline], repoSlug: 'cosyte/hl7' });
    assert.deepEqual(assertPublishableNotes(body), [], headline);
  }
});

test('a parenthetical with no internal reference is left exactly as written', () => {
  const text = 'Add `profiles.philips` (Philips Vue PACS, "IS Link")';
  assert.equal(sanitizeInternal(text), text);
});

test('em dashes are rewritten, never deleted', () => {
  assert.equal(
    rewriteEmDashes(`TLS hardening ${EM} verification on by default`),
    'TLS hardening: verification on by default',
  );
  assert.equal(
    rewriteEmDashes(`A much longer leading clause that runs past the colon threshold ${EM} an aside`),
    'A much longer leading clause that runs past the colon threshold, an aside',
  );
  assert.ok(!rewriteEmDashes(`a ${EM} b ${EM} c`).includes(EM));
});

test('headlineOf takes the first sentence, including one closed inside emphasis', () => {
  assert.equal(headlineOf('Add a thing.\n\nMore detail here.'), 'Add a thing');
  assert.equal(headlineOf('**Bold lead-in.** Then detail.'), 'Bold lead-in');
  assert.equal(
    headlineOf('Query record surfaced, so **the record-content layer is now feature-complete.** Model the `Q`.'),
    'Query record surfaced, so **the record-content layer is now feature-complete.**',
  );
});

test('headlineOf never shortens: the first sentence comes back entire, however long', () => {
  const long = `Ratify the parser choice and add ${'the first runtime dependency '.repeat(12)}chosen for safety.`;
  const head = headlineOf(long);
  assert.equal(head, long.replace(/\.$/, ''), 'the whole sentence must survive');
  assert.ok(head.length > 200, 'and it is over the bullet cap, which collectHeadlines refuses');
});

test('changes a consumer cannot observe are recognised', () => {
  for (const internal of [
    'Add the em-dash brand gate to CI',
    'Add a repo-side PHI commit-scanner (`scripts/phi-scan.ts`)',
    'Harden `scripts/sync-version.mjs` and gate it in CI',
    'Add reusable CodeQL + Scorecard workflows',
    'Bump a dev-dependency advisory with no runtime impact',
    'Add a trademark notice',
    'Correct stale publish-status language in the docs site',
    'Refresh the README status line to current reality',
  ]) {
    assert.equal(isConsumerFacing(internal), false, `${JSON.stringify(internal)} should be internal-only`);
  }
  for (const external of [
    'Add streaming / incremental parse: `parseStream`',
    'Correct the MSH-9 structure lookup so ORU^R01 resolves ORU_R01',
    'Add `profiles.visage`, the sixth built-in vendor profile',
    '835 remittance advice decoding',
  ]) {
    assert.equal(isConsumerFacing(external), true, `${JSON.stringify(external)} should be reported`);
  }
});

// ===============================================================================================
// The real hl7 v0.0.2 input, against the body that is live today
// ===============================================================================================

test('the derived body for hl7 v0.0.2 matches the published release byte for byte', () => {
  const files = loadFixtureFiles();
  assert.equal(files.length, 15, 'fixture should be the 15 changesets hl7 #61 consumed');

  const { kept, dropped } = collectHeadlines(files, '@cosyte/hl7');
  assert.equal(kept.length, 10, 'ten of the fifteen changes are observable by a consumer');
  assert.equal(dropped.length, 5);

  const body = renderNotes({
    packageName: '@cosyte/hl7',
    version: '0.0.2',
    headlines: kept,
    dropped,
    repoSlug: 'cosyte/hl7',
  });

  assert.equal(body, readFileSync(EXPECTED_BODY, 'utf8'));
  assert.deepEqual(assertPublishableNotes(body, { expectVersion: '0.0.2', expectPackage: '@cosyte/hl7' }), []);
  assert.deepEqual(findViolations(body), []);
  assert.equal(extractChangeEntries(body).length, 10);

  // No preamble and no count: the reader is already looking at the list.
  assert.ok(body.startsWith('### What changed\n'));
  assert.ok(!/\b(?:collects|contains) \d+ changes\b/.test(body));
});

test('a version whose changes are all internal says exactly that', () => {
  const body = renderNotes({
    packageName: '@cosyte/dicom',
    version: '0.0.3',
    headlines: [],
    dropped: [{ id: 'a.md', headline: 'Add reusable CodeQL + Scorecard workflows' }],
    repoSlug: 'cosyte/dicom',
  });
  assert.ok(body.includes('Internal tooling and CI only. No change to the published package surface.'));
  assert.ok(!body.includes('CHANGELOG.md'), 'no changelog pointer when there is nothing to point at');
  assert.ok(body.includes('npm install @cosyte/dicom@0.0.3'));
  // It is honest content, so the gate must accept it.
  assert.deepEqual(assertPublishableNotes(body, { expectVersion: '0.0.3', expectPackage: '@cosyte/dicom' }), []);
});

test('renderNotes refuses a release with nothing at all to report', () => {
  assert.throws(
    () => renderNotes({ packageName: '@cosyte/hl7', version: '0.0.3', headlines: [], dropped: [] }),
    /no changes to report/,
  );
});

// ===============================================================================================
// The gate. Every refusal is seeded and proven.
// ===============================================================================================

test('the gate rejects the exact stub every release carried before this change', () => {
  const problems = assertPublishableNotes(PRODUCTION_STUB);
  assert.ok(
    problems.some((p) => p.includes('stub')),
    JSON.stringify(problems),
  );
});

for (const [label, body] of [
  ['empty', ''],
  ['whitespace only', '   \n\n\t\n'],
  ['a bare title', '## v0.0.2\n'],
  ['the tag alone', 'v0.0.2'],
  ['prose with no change list', 'This release is now available.\n'],
  ['links only', '### Install\n\n**npm:** https://www.npmjs.com/package/@cosyte/hl7/v/0.0.2\n'],
  ['an empty change section', '### What changed\n\n'],
  ['a change section of blank bullets', '### What changed\n\n-\n-\n'],
  ['a stub inside a real-looking section', '### What changed\n\n- Automated release of v0.0.2.\n'],
  ['bumped-version boilerplate', '### What changed\n\n- Bump version to 0.0.2.\n'],
  ['too little said', '### What changed\n\n- fix typo.\n'],
]) {
  test(`the gate rejects ${label}`, () => {
    assert.ok(assertPublishableNotes(body).length > 0, `expected ${label} to be rejected`);
  });
}

// Every banned category, each proven to fail the gate on its own.
for (const [label, line, expected] of [
  ['an internal project identifier', 'Add conformance-profile tooling (HL7-U, Phase U).', 'internal project identifier'],
  ['a sweep name', 'Correct stale wording (README-ORG-SWEEP).', 'internal project identifier'],
  ['a lettered phase', 'Builder emits a section, Phase W.', 'phase or slice language'],
  ['a suffixed numeric phase', 'Builder emits a section, Phase 5b.', 'phase or slice language'],
  ['a roadmap phase', 'Builder emits a section, roadmap Phase K.', 'phase or slice language'],
  ['an ordinal slice', 'Builder emits a section (thirteenth slice).', 'phase or slice language'],
  ['an ADR number', 'Grounded in a public spec, not invented (ADR 0018).', 'ADR reference'],
  ['our jargon', 'Close the residuals the previous slice created.', 'internal jargon ("slice")'],
  ['an em dash', `TLS hardening ${EM} verification on by default.`, 'em dash (U+2014)'],
  ['an unobservable change', 'Add the em-dash brand gate to CI.', 'change a consumer of the package cannot observe'],
]) {
  test(`the gate fails on ${label}, and names the line`, () => {
    const body = `### What changed\n\n- A genuine described change with detail.\n- ${line}\n`;
    const violations = findViolations(body);
    assert.ok(
      violations.some((v) => v.rule === expected),
      `expected rule ${JSON.stringify(expected)}, got ${JSON.stringify(violations)}`,
    );
    assert.equal(violations[0].line, 4, 'the offending line number must be reported');
    const problems = assertPublishableNotes(body);
    assert.ok(
      problems.some((p) => p.startsWith('line 4 carries')),
      JSON.stringify(problems),
    );
  });
}

test('the gate rejects a body over the GitHub size limit', () => {
  const body = `### What changed\n\n- ${'A described change. '.repeat(9000)}\n`;
  assert.ok(assertPublishableNotes(body).some((p) => p.includes('GitHub rejects')));
});

test('the gate rejects a body about the wrong version or the wrong package', () => {
  const body = renderNotes({
    packageName: '@cosyte/hl7',
    version: '0.0.2',
    headlines: ['Correct the MSH-9 structure lookup for ORU^R01'],
    repoSlug: 'cosyte/hl7',
  });
  assert.deepEqual(assertPublishableNotes(body, { expectVersion: '0.0.2', expectPackage: '@cosyte/hl7' }), []);
  assert.ok(assertPublishableNotes(body, { expectVersion: '0.9.9', expectPackage: '@cosyte/hl7' }).length > 0);
  assert.ok(assertPublishableNotes(body, { expectVersion: '0.0.2', expectPackage: '@cosyte/mllp' }).length > 0);
});

test('extractChangeEntries ignores list items outside the change section', () => {
  const body = [
    '### What changed',
    '',
    '- A real described change that carries some detail.',
    '',
    '### Install',
    '',
    '- Package on npm: https://example.invalid/p',
  ].join('\n');
  assert.equal(extractChangeEntries(body).length, 1);
});

// ===============================================================================================
// git recovery, against synthesized repositories
// ===============================================================================================

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  return { dir, run };
}

function writeFile(dir, relative, contents) {
  mkdirSync(dirname(join(dir, relative)), { recursive: true });
  writeFileSync(join(dir, relative), contents);
}

/** A repo whose HEAD is a Changesets version commit, as the release workflow sees it. */
function makeVersionCommitRepo({ changesets, from = '0.0.1', to = '0.0.2' }) {
  const { dir, run } = makeRepo();
  writeFile(dir, 'package.json', `${JSON.stringify({ name: '@cosyte/hl7', version: from }, null, 2)}\n`);
  for (const [name, text] of Object.entries(changesets)) writeFile(dir, `.changeset/${name}`, text);
  writeFile(dir, '.changeset/README.md', 'changesets live here\n');
  run('add', '-A');
  run('commit', '-qm', 'feat: the work');
  run('tag', `v${from}`);

  writeFile(dir, 'package.json', `${JSON.stringify({ name: '@cosyte/hl7', version: to }, null, 2)}\n`);
  for (const name of Object.keys(changesets)) rmSync(join(dir, '.changeset', name));
  run('add', '-A');
  run('commit', '-qm', 'Version Packages');
  return { dir, run };
}

const GOOD_CHANGESETS = {
  'a.md': '---\n"@cosyte/hl7": patch\n---\n\nCorrect the MSH-9 structure lookup for ORU^R01.\n',
  'b.md': '---\n"@cosyte/hl7": minor\n---\n\nAdd streaming parse for multi-megabyte batch files.\n',
};

test('inspectRelease recovers the consumed changesets from a version commit', () => {
  const { dir } = makeVersionCommitRepo({ changesets: GOOD_CHANGESETS });
  const release = inspectRelease(dir, '@cosyte/hl7');
  assert.equal(release.isRelease, true);
  assert.equal(release.version, '0.0.2');
  assert.equal(release.kept.length, 2);
  assert.deepEqual(release.consumed.sort(), ['.changeset/a.md', '.changeset/b.md']);
  rmSync(dir, { recursive: true, force: true });
});

test('inspectRelease still finds the changesets when the publish lands on a LATER commit', () => {
  // The failure this closes: a version-commit run that dies before `changeset publish` (a test
  // flake, an approval timeout) means the NEXT push to main is what publishes. Anchoring on HEAD
  // would find nothing there, and the release body would be lost after npm already had the package.
  const { dir, run } = makeVersionCommitRepo({ changesets: GOOD_CHANGESETS });
  writeFile(dir, 'src.ts', 'export const x = 1;\n');
  run('add', '-A');
  run('commit', '-qm', 'docs: a follow-up commit, no version change');

  const release = inspectRelease(dir, '@cosyte/hl7');
  assert.equal(release.isRelease, true, 'a pending untagged version is still a pending release');
  assert.equal(release.version, '0.0.2');
  assert.equal(release.kept.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('inspectRelease reports nothing pending once the version is tagged', () => {
  const { dir, run } = makeVersionCommitRepo({ changesets: GOOD_CHANGESETS });
  run('tag', 'v0.0.2');
  const release = inspectRelease(dir, '@cosyte/hl7');
  assert.equal(release.isRelease, false);
  assert.match(release.reason, /already tagged/);
  rmSync(dir, { recursive: true, force: true });
});

test('findVersionCommit points at the commit that introduced the version', () => {
  const { dir } = makeVersionCommitRepo({ changesets: GOOD_CHANGESETS });
  const found = findVersionCommit(dir, '0.0.2');
  assert.equal(found.previousVersion, '0.0.1');
  assert.equal(found.hasParent, true);
  assert.equal(findVersionCommit(dir, '9.9.9'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('inspectRelease refuses a version bump that consumed no changesets', () => {
  const { dir, run } = makeRepo();
  writeFile(dir, 'package.json', '{"name":"@cosyte/hl7","version":"0.0.1"}\n');
  run('add', '-A');
  run('commit', '-qm', 'one');
  writeFile(dir, 'package.json', '{"name":"@cosyte/hl7","version":"0.0.2"}\n');
  run('add', '-A');
  run('commit', '-qm', 'Version Packages');
  assert.throws(() => inspectRelease(dir, '@cosyte/hl7'), /consumed no changesets/);
  rmSync(dir, { recursive: true, force: true });
});

test('inspectRelease refuses when the consumed changesets name another package', () => {
  const { dir } = makeVersionCommitRepo({
    changesets: { 'a.md': '---\n"@cosyte/mllp": patch\n---\n\nSomething about mllp entirely.\n' },
  });
  assert.throws(() => inspectRelease(dir, '@cosyte/hl7'), /none name @cosyte\/hl7/);
  rmSync(dir, { recursive: true, force: true });
});

test('collectHeadlines refuses a consumed changeset with an empty summary', () => {
  assert.throws(
    () => collectHeadlines([{ id: 'empty.md', text: '---\n"@cosyte/hl7": patch\n---\n\n   \n' }], '@cosyte/hl7'),
    /summary is empty/,
  );
});

test('collectHeadlines refuses a changeset that is nothing but internal bookkeeping', () => {
  assert.throws(
    () =>
      collectHeadlines([{ id: 'x.md', text: '---\n"@cosyte/hl7": patch\n---\n\nHL7-U, Phase U.\n' }], '@cosyte/hl7'),
    /nothing is left of/,
  );
});

test('parseChangeset rejects malformed input', () => {
  assert.throws(() => parseChangeset('just prose\n', 'c.md'), /not a changeset/);
  assert.throws(() => parseChangeset('---\n"@cosyte/hl7": huge\n---\n\nx\n', 'd.md'), /unknown bump type/);
});

// ===============================================================================================
// end to end through the CLI, which is what the workflow runs
// ===============================================================================================

test('prepare writes publishable notes for a real release commit', () => {
  const changesets = Object.fromEntries(loadFixtureFiles().map((f) => [f.id, f.text]));
  const { dir } = makeVersionCommitRepo({ changesets });
  const out = join(dir, 'notes.md');

  const result = runCli([
    'prepare', '--repo', dir, '--package', '@cosyte/hl7', '--out', out, '--repo-slug', 'cosyte/hl7',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /15 consumed changeset\(s\)/);
  assert.match(result.stdout, /10 reported, 5 internal-only/);
  // Stripping is never silent.
  assert.match(result.stdout, /translated [^\n]+\n\s*from: [^\n]+\n\s*to: /);
  assert.match(result.stdout, /dropped [^\n]+ as not observable by a consumer/);

  assert.equal(readFileSync(out, 'utf8'), readFileSync(EXPECTED_BODY, 'utf8'));

  const check = runCli(['assert', '--file', out, '--expect-version', '0.0.2', '--expect-package', '@cosyte/hl7']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /carries 10 described change\(s\) and no banned content/);
  rmSync(dir, { recursive: true, force: true });
});

test('the workflow composition holds: derive BEFORE publish, assert AFTER the tag exists', () => {
  // This is the shape release.yml runs, and testing the two halves in isolation missed it.
  // `changeset publish` creates the v<version> tag in the runner's local clone, so anything that
  // asks "is a release pending" after the publish step is answered no. Deriving twice therefore
  // cannot work: the second derivation finds nothing and every successful release ends red with no
  // GitHub release created. The notes must be derived once, before publish, and reused.
  const { dir, run } = makeVersionCommitRepo({ changesets: GOOD_CHANGESETS });
  const notes = join(dir, 'notes.md');

  // Step 1, before `changesets/action`.
  const prepared = runCli(['prepare', '--repo', dir, '--package', '@cosyte/hl7', '--out', notes]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.ok(readFileSync(notes, 'utf8').includes('npm install @cosyte/hl7@0.0.2'));

  // `changeset publish` runs here and tags locally.
  run('tag', 'v0.0.2');

  // Step 2, inside the publish step: assert the file that already exists, and publish it.
  const asserted = runCli([
    'assert', '--file', notes, '--expect-version', '0.0.2', '--expect-package', '@cosyte/hl7',
  ]);
  assert.equal(asserted.status, 0, `assert must still pass after the tag exists: ${asserted.stderr}`);

  // And the thing that made this a blocker: re-deriving at this point yields nothing at all.
  const reprepared = runCli(['prepare', '--repo', dir, '--package', '@cosyte/hl7', '--out', join(dir, 'again.md')]);
  assert.equal(reprepared.status, 0);
  assert.match(reprepared.stdout, /No release pending/);
  assert.throws(() => readFileSync(join(dir, 'again.md'), 'utf8'), /ENOENT/);
  rmSync(dir, { recursive: true, force: true });
});

test('prepare exits 0 and writes nothing when no release is pending', () => {
  const { dir, run } = makeVersionCommitRepo({ changesets: GOOD_CHANGESETS });
  run('tag', 'v0.0.2');
  const result = runCli(['prepare', '--repo', dir, '--package', '@cosyte/hl7', '--out', join(dir, 'notes.md')]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No release pending/);
  rmSync(dir, { recursive: true, force: true });
});

test('prepare goes red when a version bump consumed no changesets', () => {
  const { dir, run } = makeRepo();
  writeFile(dir, 'package.json', '{"name":"@cosyte/hl7","version":"0.0.1"}\n');
  run('add', '-A');
  run('commit', '-qm', 'one');
  writeFile(dir, 'package.json', '{"name":"@cosyte/hl7","version":"0.0.2"}\n');
  run('add', '-A');
  run('commit', '-qm', 'Version Packages');
  const result = runCli(['prepare', '--repo', dir, '--package', '@cosyte/hl7', '--out', join(dir, 'notes.md')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::/);
  assert.match(result.stderr, /consumed no changesets/);
  rmSync(dir, { recursive: true, force: true });
});

test('prepare goes red when a consumed changeset says nothing', () => {
  const { dir } = makeVersionCommitRepo({
    changesets: {
      'good.md': '---\n"@cosyte/hl7": patch\n---\n\nA genuine described change with detail.\n',
      'blank.md': '---\n"@cosyte/hl7": patch\n---\n\n\n',
    },
  });
  const result = runCli(['prepare', '--repo', dir, '--package', '@cosyte/hl7', '--out', join(dir, 'notes.md')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /blank\.md[\s\S]*summary is empty/);
  rmSync(dir, { recursive: true, force: true });
});

// Seeded end to end, because a refusal that has never been watched fail is not a gate. Each shape
// is run through the real CLI red, then the changeset is rewritten the way its author would rewrite
// it and the same CLI is watched green.
for (const [label, bad, good, expected] of [
  [
    'an identifier the sentence is built around',
    // hl7@1c5c0f5:.changeset/public-surface-hygiene-dist.md, held one approval short of a publish.
    'The published JSDoc no longer carries phase language, item identifiers or ADR numbers, and `src/` doc comments are gated.',
    'The published JSDoc no longer carries internal project bookkeeping, and `src/` doc comments are gated.',
    /sits in the middle of a clause/,
  ],
  [
    'an opening sentence too long for a bullet',
    'Close the two residuals the previous change named and argued rather than fixed: a **patient identifier** read out of a `nullFlavor`-marked `<id>`, and a medication naming **two different drugs** with one silently dropped.',
    'Close two reading defects: a **patient identifier** read out of a `nullFlavor`-marked `<id>`, and a medication naming **two different drugs** with one silently dropped.',
    /opening sentence is \d+ characters/,
  ],
]) {
  test(`prepare goes red on ${label}, and green once it is rewritten`, () => {
    const frontmatter = '---\n"@cosyte/hl7": patch\n---\n\n';
    const red = makeVersionCommitRepo({ changesets: { 'a.md': `${frontmatter}${bad}\n` } });
    const onBad = runCli(['prepare', '--repo', red.dir, '--package', '@cosyte/hl7', '--out', join(red.dir, 'n.md')]);
    assert.equal(onBad.status, 1, `expected a refusal, got: ${onBad.stdout}`);
    assert.match(onBad.stderr, expected);
    assert.throws(() => readFileSync(join(red.dir, 'n.md'), 'utf8'), /ENOENT/, 'nothing may be written');
    rmSync(red.dir, { recursive: true, force: true });

    const green = makeVersionCommitRepo({ changesets: { 'a.md': `${frontmatter}${good}\n` } });
    const out = join(green.dir, 'n.md');
    const onGood = runCli(['prepare', '--repo', green.dir, '--package', '@cosyte/hl7', '--out', out]);
    assert.equal(onGood.status, 0, onGood.stderr);
    const body = readFileSync(out, 'utf8');
    assert.deepEqual(assertPublishableNotes(body, { expectVersion: '0.0.2', expectPackage: '@cosyte/hl7' }), []);
    rmSync(green.dir, { recursive: true, force: true });
  });
}

test('assert goes red on the stub body, on banned content, and on a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-assert-'));

  writeFileSync(join(dir, 'stub.md'), `${PRODUCTION_STUB}\n`);
  const onStub = runCli(['assert', '--file', join(dir, 'stub.md')]);
  assert.equal(onStub.status, 1);
  assert.match(onStub.stderr, /::error::/);
  assert.match(onStub.stderr, /Refusing to create a release/);

  writeFileSync(join(dir, 'leaky.md'), '### What changed\n\n- Add conformance-profile tooling (HL7-U, Phase U).\n');
  const onLeak = runCli(['assert', '--file', join(dir, 'leaky.md')]);
  assert.equal(onLeak.status, 1);
  assert.match(onLeak.stderr, /internal project identifier/);
  assert.match(onLeak.stderr, /line 3/);

  const onMissing = runCli(['assert', '--file', join(dir, 'nope.md')]);
  assert.equal(onMissing.status, 1);
  assert.match(onMissing.stderr, /Refusing to create a release without derived notes/);
  rmSync(dir, { recursive: true, force: true });
});

// ===============================================================================================
// npm is downstream of the gate, not upstream of a complaint
//
// The workflow used to publish and THEN check, with an error echo reporting that npm had the
// package and the notes gate had not classified the commit. A published version is permanent, so
// that echo was a correction. `is-release` is now the publish permission itself, which is why these
// tests are about the OUTPUT and not about the log.
// ===============================================================================================

test('prepare grants publish permission only for a pending release', () => {
  const { dir, run } = makeVersionCommitRepo({ changesets: GOOD_CHANGESETS });

  const pending = runPrepare(dir);
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(pending.outputs['is-release'], 'true');
  assert.equal(pending.outputs.version, '0.0.2', 'the publish step needs the version to assert on');

  // `changeset publish` has now run and tagged, which is the state of every ordinary push to main
  // between releases. Permission is withheld, and withholding it is what `changeset publish` would
  // have done anyway: there is nothing left to publish.
  run('tag', 'v0.0.2');
  const settled = runPrepare(dir, { out: join(dir, 'again.md') });
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(settled.outputs['is-release'], 'false');
  rmSync(dir, { recursive: true, force: true });
});

test('inspectRelease reports WHY nothing is pending in a form the caller can act on', () => {
  // The prose is for a human; `code` is what decides whether a run may publish, and the four cases
  // are not interchangeable.
  const { dir, run } = makeVersionCommitRepo({ changesets: GOOD_CHANGESETS });
  run('tag', 'v0.0.2');
  assert.equal(inspectRelease(dir, '@cosyte/hl7').code, 'already-released');
  rmSync(dir, { recursive: true, force: true });

  const bare = makeRepo();
  writeFile(bare.dir, 'README.md', 'no package here\n');
  bare.run('add', '-A');
  bare.run('commit', '-qm', 'one');
  assert.equal(inspectRelease(bare.dir, '@cosyte/hl7').code, 'no-package-json');
  rmSync(bare.dir, { recursive: true, force: true });
});

test('prepare goes RED, before npm, when it cannot tell what the commit would publish', () => {
  // This exited 0 and withheld nothing before, which was survivable only because the publish ran
  // regardless and the disagreement was reported afterwards. Now that the publish is downstream of
  // this output, exiting 0 would mean a silent green that shipped nothing on a commit that may have
  // been a release. So it stops here, with npm untouched.
  const { dir, run } = makeRepo();
  writeFile(dir, 'README.md', 'no package here\n');
  run('add', '-A');
  run('commit', '-qm', 'one');

  const result = runPrepare(dir);
  assert.equal(result.status, 1, `expected a refusal, got: ${result.stdout}`);
  assert.match(result.stderr, /::error::/);
  assert.match(result.stderr, /Cannot establish what a publish/);
  assert.match(result.stderr, /Nothing has been published/);
  assert.equal(result.outputs['is-release'], 'false');
  assert.throws(() => readFileSync(join(dir, 'notes.md'), 'utf8'), /ENOENT/, 'nothing may be written');
  rmSync(dir, { recursive: true, force: true });
});

// ===============================================================================================
// The first-release deadlock, and the proof that closing it relaxes nothing
//
// Measured 2026-07-29: `transform`, `cli`, `deid` and `synth` are all at 0.0.0, have never
// published, and every one of their release runs failed at this gate. The refusal is what closed
// the loop: no derivation means no `changesets/action`, which means no "Version Packages" PR, which
// means the version never leaves 0.0.0, which means the next run refuses for the same reason.
// `transform`'s oldest waiting run dates to 2026-07-21.
//
// These tests are written in pairs on purpose. A gate change with only a passing test is not
// evidence, so every "it no longer refuses" below has a partner proving the SAME code path still
// refuses the moment a previous version exists.
// ===============================================================================================

const FIRST_RELEASE_CHANGESETS = {
  'a.md': '---\n"@cosyte/hl7": patch\n---\n\nAdd the first transform pipeline for HL7 v2 messages.\n',
  'b.md': '---\n"@cosyte/hl7": minor\n---\n\nAdd `mapCodes`, which resolves a ConceptMap translation.\n',
};

/** A repo in the state all four deadlocked repos are in: scaffolded, changesets pending, never bumped. */
function makeNeverVersionedRepo({ version = '0.0.0', changesets = FIRST_RELEASE_CHANGESETS } = {}) {
  const { dir, run } = makeRepo();
  writeFile(dir, 'package.json', `${JSON.stringify({ name: '@cosyte/hl7', version }, null, 2)}\n`);
  writeFile(dir, '.changeset/README.md', 'changesets live here\n');
  for (const [name, text] of Object.entries(changesets)) writeFile(dir, `.changeset/${name}`, text);
  run('add', '-A');
  run('commit', '-qm', 'chore: scaffold @cosyte/hl7 from the standard template');
  return { dir, run };
}

test('DEADLOCK: a repo that has never been versioned is not a pending release, and does not refuse', () => {
  const { dir } = makeNeverVersionedRepo();

  const release = inspectRelease(dir, '@cosyte/hl7');
  assert.equal(release.isRelease, false);
  assert.equal(release.code, 'never-versioned');
  assert.match(release.reason, /has never been versioned/);

  // The whole point: exit 0, so `changesets/action` runs and opens the Version PR that moves the
  // version off its scaffold value. Refusing here is what made that PR impossible to create.
  const result = runPrepare(dir);
  assert.equal(result.status, 0, `expected no refusal, got: ${result.stderr}`);
  assert.equal(result.outputs['is-release'], 'false', 'nothing is published from a scaffold commit');
  assert.doesNotMatch(result.stderr, /::error::/);
  assert.match(result.stdout, /Version Packages/, 'a human reading this run needs the next step');
  assert.throws(() => readFileSync(join(dir, 'notes.md'), 'utf8'), /ENOENT/, 'no notes are derived');
  rmSync(dir, { recursive: true, force: true });
});

test('the deadlock has two shapes and both close: package.json arriving after the root commit', () => {
  // `hasParent` is false only when package.json is in the ROOT commit, which is where all four
  // repos happen to have it. Put it in the second commit instead and the identical never-released
  // repo refused with "consumed no changesets" rather than "the repository's first commit". One
  // deadlock, two error messages, and a detector that keys on either message closes only half of it.
  const { dir, run } = makeRepo();
  writeFile(dir, 'README.md', '# @cosyte/hl7\n');
  run('add', '-A');
  run('commit', '-qm', 'chore: repository skeleton');
  writeFile(dir, 'package.json', '{"name":"@cosyte/hl7","version":"0.0.0"}\n');
  writeFile(dir, '.changeset/a.md', FIRST_RELEASE_CHANGESETS['a.md']);
  run('add', '-A');
  run('commit', '-qm', 'chore: scaffold the package');

  const release = inspectRelease(dir, '@cosyte/hl7');
  assert.equal(release.isRelease, false);
  assert.equal(release.code, 'never-versioned');
  rmSync(dir, { recursive: true, force: true });
});

test('the FIRST release still goes through the gate whole: deferred by one commit, not skipped', () => {
  // This is what the deadlock was denying. Merging the Version PR produces a version commit with a
  // real previous version and real consumed changesets, and that commit derives real notes and is
  // checked in full. Nothing about the first release is exempt; it just is not the scaffold commit.
  const { dir, run } = makeNeverVersionedRepo();
  writeFile(dir, 'package.json', `${JSON.stringify({ name: '@cosyte/hl7', version: '0.0.1' }, null, 2)}\n`);
  for (const name of Object.keys(FIRST_RELEASE_CHANGESETS)) rmSync(join(dir, '.changeset', name));
  run('add', '-A');
  run('commit', '-qm', 'Version Packages');

  const release = inspectRelease(dir, '@cosyte/hl7');
  assert.equal(release.isRelease, true, 'the first release IS a release');
  assert.equal(release.version, '0.0.1');
  assert.equal(release.kept.length, 2);

  const result = runPrepare(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs['is-release'], 'true');
  const body = readFileSync(join(dir, 'notes.md'), 'utf8');
  assert.match(body, /Add the first transform pipeline for HL7 v2 messages\./);
  assert.match(body, /npm install @cosyte\/hl7@0\.0\.1/);
  rmSync(dir, { recursive: true, force: true });
});

test('FAIL CLOSED: a repo that HAS been versioned still refuses when its notes are underivable', () => {
  // The partner test, and the one that matters most. Same code path, one fact changed: a previous
  // version exists in the history. Everything the gate did before, it still does.
  const { dir, run } = makeRepo();
  writeFile(dir, 'package.json', '{"name":"@cosyte/hl7","version":"0.0.1"}\n');
  run('add', '-A');
  run('commit', '-qm', 'the released state');
  run('tag', 'v0.0.1');
  writeFile(dir, 'package.json', '{"name":"@cosyte/hl7","version":"0.0.2"}\n');
  run('add', '-A');
  run('commit', '-qm', 'Version Packages');

  assert.throws(() => inspectRelease(dir, '@cosyte/hl7'), /consumed no changesets/);
  const result = runPrepare(dir);
  assert.equal(result.status, 1, `a published package must still fail closed: ${result.stdout}`);
  assert.notEqual(result.outputs['is-release'], 'true', 'npm must stay unreachable');
  assert.throws(() => readFileSync(join(dir, 'notes.md'), 'utf8'), /ENOENT/);
  rmSync(dir, { recursive: true, force: true });
});

test('FAIL CLOSED: a released repo whose consumed changeset says nothing still refuses', () => {
  // The other way a released repo can be unable to say what shipped. Also unaffected.
  const { dir } = makeVersionCommitRepo({
    changesets: { 'a.md': '---\n"@cosyte/hl7": patch\n---\n\n   \n' },
  });
  assert.throws(() => inspectRelease(dir, '@cosyte/hl7'), /summary is empty/);
  const result = runPrepare(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.notEqual(result.outputs['is-release'], 'true');
  rmSync(dir, { recursive: true, force: true });
});

test('the detector does not key on tags, so deleting one cannot buy an exemption', () => {
  // Why "no `v*` tag exists" was rejected as the detector. A tag is one `git push --delete` away,
  // and a deleted tag would make a repo that HAS released look like one that never has, which is
  // the dangerous direction. History is not deletable from outside the repo, so this keys on that.
  const { dir, run } = makeRepo();
  writeFile(dir, 'package.json', '{"name":"@cosyte/hl7","version":"0.0.1"}\n');
  run('add', '-A');
  run('commit', '-qm', 'the released state');
  writeFile(dir, 'package.json', '{"name":"@cosyte/hl7","version":"0.0.2"}\n');
  run('add', '-A');
  run('commit', '-qm', 'Version Packages');
  assert.equal(run('tag', '-l').toString().trim(), '', 'no tag exists anywhere in this repo');

  assert.equal(hasPriorVersion(dir, '0.0.2'), true, '0.0.1 is in the history whatever the tags say');
  assert.throws(() => inspectRelease(dir, '@cosyte/hl7'), /consumed no changesets/);
  rmSync(dir, { recursive: true, force: true });
});

test('the detector does not key on the version being 0.0.0', () => {
  // Why "the version is 0.0.0" was rejected. It is a magic value that is neither necessary nor
  // sufficient: a scaffold may start anywhere, and 0.0.0 is a publishable version.
  const { dir } = makeNeverVersionedRepo({ version: '0.1.0' });
  assert.equal(inspectRelease(dir, '@cosyte/hl7').code, 'never-versioned', 'not about the number');
  assert.equal(hasPriorVersion(dir, '0.1.0'), false);
  rmSync(dir, { recursive: true, force: true });
});

test('a SHALLOW checkout is never read as never-versioned, and still goes red', () => {
  // The one way this detector could have turned a loud failure into a silent green. A shallow
  // clone's oldest commit has no parent and reads as a root commit, so "no other version anywhere in
  // the history" is unknowable rather than false. Answering `false` there would withhold the publish
  // command on a real release and end the run green having shipped nothing.
  const { dir, run } = makeVersionCommitRepo({ changesets: GOOD_CHANGESETS });
  run('tag', '-d', 'v0.0.1');
  const clonedInto = mkdtempSync(join(tmpdir(), 'release-notes-shallow-'));
  const shallow = join(clonedInto, 'clone');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow], { stdio: 'pipe' });
  assert.equal(
    execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: shallow, encoding: 'utf8' }).trim(),
    'true',
  );

  assert.equal(hasPriorVersion(shallow, '0.0.2'), null, 'unknowable, not false');
  assert.throws(() => inspectRelease(shallow, '@cosyte/hl7'), /shallow checkout/);
  const result = runPrepare(shallow);
  assert.equal(result.status, 1, `a shallow checkout must not pass quietly: ${result.stdout}`);
  assert.notEqual(result.outputs['is-release'], 'true');
  rmSync(dir, { recursive: true, force: true });
  rmSync(clonedInto, { recursive: true, force: true });
});

test('hasPriorVersion answers a question about history alone', () => {
  const never = makeNeverVersionedRepo();
  assert.equal(hasPriorVersion(never.dir, '0.0.0'), false);
  rmSync(never.dir, { recursive: true, force: true });

  const bumped = makeVersionCommitRepo({ changesets: GOOD_CHANGESETS });
  assert.equal(hasPriorVersion(bumped.dir, '0.0.2'), true);
  // And it stays true for every version this repo will ever be at: history only grows, so a package
  // that has been versioned can never re-enter the never-versioned branch.
  assert.equal(hasPriorVersion(bumped.dir, '0.0.3'), true);
  rmSync(bumped.dir, { recursive: true, force: true });
});

// A gate the workflow does not consult is documentation. `is-release` only guards anything because
// release.yml hands it to `changesets/action` as the publish command, and that wiring lives in a
// file the script cannot see. Six gates in this org have shipped green while unable to observe their
// subject; this assertion is one line and it is the one that would have caught a seventh.
test('release.yml withholds the publish command unless the notes gate derived notes', () => {
  const workflow = readFileSync(resolve(HERE, '../.github/workflows/release.yml'), 'utf8');
  const publishInput = /^\s*publish:\s*(.+)$/m.exec(workflow);
  assert.ok(publishInput, 'release.yml no longer passes a publish input to changesets/action');
  // The WHOLE expression, not a substring of it. Merely requiring the condition to appear somewhere
  // passes on `is-release == 'true' && '' || 'pnpm run release'`, which contains exactly the same
  // text and publishes precisely when the gate says not to. This is one line, it decides whether npm
  // can be reached, and there is no edit to it that should be anything other than deliberate.
  assert.equal(
    publishInput[1].trim(),
    "${{ steps.notes.outputs.is-release == 'true' && 'pnpm run release' || '' }}",
    'the publish command must be the notes gate and nothing else',
  );
  // The version-PR half must NOT be conditional. changesets/action opens the "Version Packages" PR
  // whenever pending changesets exist, whether or not a publish command is set, so gating `version`
  // as well would stop releases from ever starting.
  assert.match(workflow, /^\s*version:\s*pnpm run version\s*$/m);
});

// The version-PR CI trap, asserted on the YAML because it cannot be asserted anywhere else.
//
// A "Version Packages" PR opened with GITHUB_TOKEN arrives with ZERO checks, because GitHub does not
// start workflow runs for that token's events. A required check that never reports is PENDING, not
// failing, so with `bypass_actors: []` the PR is unmergeable by anyone. The only true test of the fix
// is a live Version PR, which is exactly what nothing in this repo is allowed to merge. So what is
// provable here is the wiring, and the wiring is where all three ways to get this wrong live.
test('release.yml authors the version PR with a credential that is not GITHUB_TOKEN', () => {
  const workflow = readFileSync(resolve(HERE, '../.github/workflows/release.yml'), 'utf8');
  const EXPECTED = '${{ secrets.RELEASE_PR_TOKEN || secrets.GITHUB_TOKEN }}';

  // Declared, and OPTIONAL. Required would take every caller's release pipeline down on the first
  // run after this lands, to protect them from a state they are already in.
  assert.match(
    workflow,
    /^ {6}RELEASE_PR_TOKEN:\n {8}required: false$/m,
    'RELEASE_PR_TOKEN must be a declared, optional workflow_call secret',
  );

  // WRONG WAY 1: fixing only the PR and not the push. The version commit is pushed by `git push` out
  // of the caller's checkout, and actions/checkout persists an Authorization extraheader that git
  // sends preemptively, which outranks the `~/.netrc` the action writes with our token. Leave that
  // persisted and the `opened` event is fixed while every later `synchronize` is not, so the PR
  // returns to zero applicable checks as soon as a second changeset lands on main.
  // Anchored STRUCTURALLY, on the first step of the job rather than on text adjacency. An earlier
  // version matched `fetch-depth: 0` followed by `persist-credentials: false` anywhere, which passes
  // if the caller checkout loses the setting while the SECOND (tooling) checkout, which has always
  // had it, happens to sit next to a `fetch-depth: 0`. The caller checkout is the one that owns the
  // push, and it is the first step; that is the thing worth pinning.
  const steps = workflow.slice(workflow.indexOf('\n    steps:')).split(/\n      - (?=\S)/);
  const callerCheckout = steps[1];
  assert.match(
    callerCheckout ?? '',
    /^uses: actions\/checkout@/,
    'the first step of the release job is expected to be the caller checkout',
  );
  assert.match(
    callerCheckout,
    /^\s*persist-credentials: false$/m,
    'the caller checkout must set persist-credentials: false, or its GITHUB_TOKEN extraheader wins over the netrc and the version commit push stays bot-authored',
  );
  assert.match(callerCheckout, /^\s*fetch-depth: 0$/m, 'the caller checkout still needs full history');

  // WRONG WAY 1b, the tempting shortcut: handing the PAT to actions/checkout instead. It works, and
  // it puts an org-scoped credential in .git/config from step one, through `pnpm install` (no caller
  // sets ignore-scripts) and the whole verify ladder, in public repos. The netrc route keeps the PAT
  // off this runner until the changesets step, which removes exactly that window. It does NOT remove
  // every window, and the workflow says where the rest are rather than implying there are none.
  assert.doesNotMatch(
    workflow,
    /^\s*token:/m,
    'do not persist the release-PR token into git config; the netrc route has a far smaller window',
  );

  // WRONG WAY 2: leaving the action's env at GITHUB_TOKEN. This is the token it opens the PR with.
  const envTokens = [...workflow.matchAll(/^\s*GITHUB_TOKEN:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(
    envTokens,
    [EXPECTED],
    'changesets/action must open the PR with the release-PR token',
  );

  // WRONG WAY 3, and the quiet one: setting the action's `github-token` INPUT and considering it
  // done. Read against the action's source at the sha pinned in the workflow, it resolves
  // `process.env.GITHUB_TOKEN || core.getInput("github-token")`, so an env var set anywhere in that
  // step BEATS the input. The input would look like the fix, lint clean, and change nothing.
  assert.doesNotMatch(
    workflow,
    /^\s*github-token:/m,
    'github-token is an input the GITHUB_TOKEN env var overrides; set the env, not the input',
  );

  // The fallback has to be audible. Unset, the behaviour is byte-identical to the trap, and the
  // symptom (a PR sitting at zero checks) reads like a slow queue rather than a permanent block.
  assert.match(workflow, /::warning title=Version PR will land with zero checks::/);
  // Read via `env`, never a step-level `if`: the `secrets` context is not available to
  // `jobs.<id>.steps.<id>.if`. actionlint rejects it there, so the mistake is loud rather than
  // silent, but `env` is the construct that can actually read it.
  assert.match(workflow, /^\s*HAS_RELEASE_PR_TOKEN:\s*\$\{\{ secrets\.RELEASE_PR_TOKEN != '' \}\}$/m);
  assert.doesNotMatch(workflow, /^\s*if:.*secrets\.RELEASE_PR_TOKEN/m);

  // Every claim above is a property of ONE revision of changesets/action: that the env beats the
  // input, that the push is `git push` and not an API call, that `setupGitUser` hardcodes the commit
  // author. A pin bump can falsify any of them while leaving every assertion above green, so the pin
  // is asserted too. If this line fails, the answer is to re-read the action's source at the new sha
  // before changing the number, not to change the number.
  assert.match(
    workflow,
    /uses: changesets\/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d/,
    'the version-PR reasoning was read against this sha; re-read the source before repinning',
  );
});
