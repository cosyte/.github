// Unit tests for scripts/release-diff.mjs.
//
// Every classification case below is REAL: the bullet is the text live on a published
// @cosyte/* release page on 2026-07-28, and the summary is the changeset that release consumed,
// recovered from the tagged version commit's parent. Provenance is named on each one.
//
// The case that matters most is `identifier-removed`. A bullet whose trailing `(CCDA-P7)` was
// removed IS a proper prefix of its changeset sentence, and calling that a truncation is exactly
// how the prefix-comparison method reported 25 truncations where the eye could find 6. If that
// test goes green while the tool reports it as cut, the tool has stopped being worth running.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  alignTokens,
  classifyEntry,
  classifyRelease,
  endsSentence,
  isExplainedRemoval,
  openingParagraph,
  tokenize,
} from '../scripts/release-diff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/release-diff.mjs');

/** U+2014 as an escape: these files must not contain the character under test. */
const EM = '\u2014';

// ---------------------------------------------------------------------------------------------
// Real captured input
// ---------------------------------------------------------------------------------------------

// cosyte/ccda v0.0.2, .changeset/ccda-builder-p7-family-history.md at 2957c87^.
const FAMILY_HISTORY = `Phase 7 (eleventh slice): builder emits a Family History section (CCDA-P7).

Extends \`buildCcda\` with one new optional input, \`BuildCcdaInit.familyHistory\`
(\`BuildCcdaFamilyHistory[]\`), that round-trips through \`getFamilyHistory()\` to the same structured
content by construction.`;

// cosyte/ccda v0.0.2, .changeset/ccda-arm-selection-residuals.md at 2957c87^.
const ARM_SELECTION = `Close the two arm-selection residuals the previous slice named and did not fix, one of which that
slice created: a \`<translation>\` was invisible to the conflict rule, a repeated arm was never
compared at all, and a shipped docstring justified a safety classification from a premise that had
stopped being true.`;

// cosyte/x12 v0.0.1, .changeset/x12-phase-2-syntactic-core.md at 36f213a^.
const SYNTACTIC_CORE = `Phase 2 syntactic core: every segment inside a transaction is now decoded into an immutable \`X12Segment\` carrying its id, raw text, and 1-indexed element array; the verbatim source survives on \`X12TransactionSet.rawSegments\` for byte-exact round-trip. The \`?\`-release-character escape is handled by \`unescapeRelease\` / \`escapeRelease\`.`;

// cosyte/astm v0.0.1, .changeset/astm-3-identity-comments-timestamps.md at 92ac210^.
const MISFILING = `Patient/order identity depth, comments, and partial-timestamp hardening (ASTM-3, roadmap Phase 3): the
misfiling-prevention slice. Model the full patient (\`P\`) identity ${EM} the practice-assigned (field 3),
laboratory-assigned (field 4), and third (field 5) patient IDs stay **distinct** and never collapse.`;

// cosyte/terminology v0.0.1, .changeset/terminology-readme-scope-complete-engine.md at e5ed368^.
const README_SCOPE = `Docs: correct the README scope description. The status/scope block led with "Ships **Phase 1**" and read as a phase-by-phase build ladder, understating the shipped surface.`;

// cosyte/ncpdp v0.0.1, .changeset/ncpdp-2-script-response-spine.md at 92e13a3^.
const RESPONSE_SPINE = `NCPDP-2 ${EM} SCRIPT response spine: read the \`Status\` / \`Error\` / \`Verify\` acknowledgment transactions
via \`status()\`/\`error()\`/\`verify()\` (and a \`disposition\` accessor that can never read an \`Error\` as a
success), with \`correlatesTo\` exposing \`<RelatesToMessageID>\` for request${EM}response correlation.`;

// ---------------------------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------------------------

test('tokenize strips emphasis and code fences from the key but keeps the raw', () => {
  const [token] = tokenize('**`buildCcda`**,');
  assert.equal(token.key, 'buildccda');
  assert.equal(token.raw, '**`buildCcda`**,');
});

test('tokenize keeps hyphens and slashes inside a word', () => {
  assert.deepEqual(
    tokenize('005010X222A2 ICD-9/ICD-10').map((t) => t.key),
    ['005010x222a2', 'icd-9/icd-10'],
  );
});

test('tokenize reads a name with and without an empty argument list as the same word', () => {
  assert.equal(tokenize('`splitBatch()`').at(-1).key, tokenize('`splitBatch`').at(-1).key);
});

test('tokenize gives a punctuation-only token no key, so it cannot align with another', () => {
  assert.equal(tokenize('a / b').at(1).key, '');
  assert.equal(tokenize(`x ${EM} y`).at(1).key, '');
});

test('tokenize canonicalises the one word the renderer rewrites', () => {
  assert.equal(tokenize('slice').at(0).key, 'change');
  assert.equal(tokenize('slices').at(0).key, 'changes');
});

test('endsSentence separates a sentence end from an abbreviation', () => {
  assert.equal(endsSentence(tokenize('true.').at(0)), true);
  assert.equal(endsSentence(tokenize('complete.**').at(0)), true);
  assert.equal(endsSentence(tokenize('e.g.').at(0)), false);
  assert.equal(endsSentence(tokenize('al.').at(0)), false);
  assert.equal(endsSentence(tokenize('section').at(0)), false);
});

test('a sentence ending on a single letter is a sentence end, not an initial', () => {
  // Both are sentences this suite really writes, and both are named in the item as the shape a
  // too-clever rule refuses. Reading the letter as an initial reported them as cut short.
  const bloodType = 'Blood type recorded as A, B, AB, or O.';
  assert.equal(endsSentence(tokenize(bloodType).at(-1)), true);
  assert.equal(
    classifyEntry(bloodType, `${bloodType} The value is surfaced verbatim.`).verdict,
    'deliberately-short',
  );
});

test('alignTokens matches a subsequence, not a prefix', () => {
  assert.deepEqual(alignTokens(['a', 'c'], ['a', 'b', 'c']), [
    [0, 0],
    [1, 2],
  ]);
});

test('openingParagraph stops at the first blank line', () => {
  assert.equal(openingParagraph(FAMILY_HISTORY), 'Phase 7 (eleventh slice): builder emits a Family History section (CCDA-P7).');
});

// ---------------------------------------------------------------------------------------------
// what a translation rule explains
// ---------------------------------------------------------------------------------------------

test('isExplainedRemoval accepts the spans the translator removes on purpose', () => {
  assert.equal(isExplainedRemoval('(CCDA-P7).'), true);
  assert.equal(isExplainedRemoval('(roadmap Phase L).'), true);
  assert.equal(isExplainedRemoval('(HL7-I, ADR 0018).'), true);
  assert.equal(isExplainedRemoval('(ASTM-10, roadmap Phase 10, the final phase).'), true);
});

test('isExplainedRemoval refuses prose, however short', () => {
  assert.equal(isExplainedRemoval('for byte-exact round-trip.'), false);
  assert.equal(isExplainedRemoval('at all, and a shipped docstring justified a safety classification.'), false);
  // The whole point: a rule that accepted this would report a lost clause as a deliberate removal.
  assert.equal(isExplainedRemoval('and availability status TXA-19 surfaced as DISTINCT fields.'), false);
});

// ---------------------------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------------------------

test('a bullet whose trailing identifier was removed is NOT a truncation', () => {
  const result = classifyEntry('Builder emits a Family History section.', FAMILY_HISTORY);
  assert.equal(result.verdict, 'identifier-removed');
  assert.equal(result.missingTail, '');
  assert.equal(result.explainedTail, '(CCDA-P7).');
});

test('a bullet whose leading phase language was removed is NOT a truncation', () => {
  const result = classifyEntry(
    'Syntactic core: every segment inside a transaction is now decoded into an immutable `X12Segment` carrying its id, raw text, and 1-indexed element array; the verbatim source survives on `X12TransactionSet.rawSegments` for byte-exact round-trip.',
    SYNTACTIC_CORE,
  );
  assert.equal(result.verdict, 'identifier-removed');
  assert.deepEqual(result.removed, ['Phase 2']);
});

test('a bullet cut at a clean word boundary is reported, with the rest of the sentence quoted', () => {
  // Live on cosyte/ccda v0.0.2. Well-formed prose, so no scan over the bytes alone can see it.
  const result = classifyEntry(
    'Close the two arm-selection residuals the previous change named and did not fix, one of which that change created: a `<translation>` was invisible to the conflict rule, a repeated arm was never compared.',
    ARM_SELECTION,
  );
  assert.equal(result.verdict, 'truncated');
  assert.match(result.missingTail, /^at all, and a shipped docstring/);
  assert.match(result.missingTail, /stopped being true\.$/);
});

test('a bullet cut inside a word is reported, and names the word it stopped inside', () => {
  // Live on cosyte/x12 v0.0.1.
  const result = classifyEntry(
    'Syntactic core: every segment inside a transaction is now decoded into an immutable `X12Segment` carrying its id, raw text, and 1-indexed element array; the verbatim source survives on `X12Tra.',
    SYNTACTIC_CORE,
  );
  assert.equal(result.verdict, 'truncated');
  assert.match(result.why, /stops inside the word/);
  assert.match(result.missingTail, /X12TransactionSet\.rawSegments/);
});

test('the one word the renderer rewrites does not read as a lost word', () => {
  // Live on cosyte/astm v0.0.1: the changeset says "slice", the bullet says "change", and reading
  // the difference as missing prose reported this complete sentence as cut short by one word.
  const result = classifyEntry(
    'Patient/order identity depth, comments, and partial-timestamp hardening: the misfiling-prevention change.',
    MISFILING,
  );
  assert.equal(result.verdict, 'identifier-removed');
  assert.equal(result.missingTail, '');
});

test('an interior span nothing accounts for is named, not folded into the verdict', () => {
  // Content lost from the MIDDLE cannot make a bullet truncated, since nothing was cut off its end.
  // But the verdict must not claim every difference is deliberate when only the tail was checked.
  const result = classifyEntry(
    'The parser tolerates a truncated trailer, and the round-trip stays byte-exact.',
    'The parser tolerates a truncated trailer, the emitter never does, and the round-trip stays byte-exact.',
  );
  assert.equal(result.verdict, 'identifier-removed');
  assert.deepEqual(result.unexplainedRemoved, ['the emitter never does,']);
  assert.match(result.why, /not accounted for/);
});

test('a bullet whose only interior difference is deliberate claims exactly that', () => {
  const result = classifyEntry('Builder emits a Family History section.', FAMILY_HISTORY);
  assert.deepEqual(result.unexplainedRemoved, []);
  assert.match(result.why, /every difference/);
});

test('a short bullet that is the whole of a short sentence is complete, not cut', () => {
  // Live on cosyte/terminology v0.0.1. Nothing about the bytes distinguishes it from a cut.
  const result = classifyEntry('Docs: correct the README scope description.', README_SCOPE);
  assert.equal(result.verdict, 'deliberately-short');
  assert.equal(result.missingTail, '');
});

test('a bullet that says exactly what its changeset says is untouched', () => {
  const summary = 'Reject an MSH-2 that double-encodes a high-bit control ID silently, which every downstream reader then mis-decodes.';
  assert.equal(classifyEntry(summary, summary).verdict, 'untouched');
});

test('a hand-edited bullet is reported as such, and is not graded as a truncation', () => {
  // Live on cosyte/ncpdp v0.0.1: rewritten by hand on the release page, so no derivation is left.
  const result = classifyEntry(
    'SCRIPT response spine: read the `Status` / `Error` / `Verify` acknowledgment transactions, with a `disposition` accessor that can never read an `Error` as a success.',
    RESPONSE_SPINE,
  );
  assert.equal(result.verdict, 'rewritten');
  assert.notEqual(result.verdict, 'truncated');
  assert.ok(result.added.length > 0);
});

// ---------------------------------------------------------------------------------------------
// pairing a whole release
// ---------------------------------------------------------------------------------------------

const BODY = `### What changed

- Builder emits a Family History section.
- Close the two arm-selection residuals the previous change named and did not fix, one of which that change created: a \`<translation>\` was invisible to the conflict rule, a repeated arm was never compared.

Full detail for each change is in [\`CHANGELOG.md\`](https://github.com/cosyte/ccda/blob/main/CHANGELOG.md).

### Install

\`\`\`bash
npm install @cosyte/ccda@0.0.2
\`\`\`
`;

const CHANGESETS = [
  { id: 'family.md', text: `---\n"@cosyte/ccda": patch\n---\n\n${FAMILY_HISTORY}\n` },
  { id: 'arm.md', text: `---\n"@cosyte/ccda": patch\n---\n\n${ARM_SELECTION}\n` },
  // Dropped from the body as unobservable, so the two lists do not line up by position.
  { id: 'emdash.md', text: `---\n"@cosyte/ccda": patch\n---\n\nAdd the em-dash brand gate to CI.\n` },
];

test('classifyRelease pairs bullets with changesets by content, not by position', () => {
  const results = classifyRelease({ body: BODY, changesets: CHANGESETS, packageName: '@cosyte/ccda' });
  assert.equal(results.length, 2);
  assert.equal(results[0].changeset, 'family.md');
  assert.equal(results[0].verdict, 'identifier-removed');
  assert.equal(results[1].changeset, 'arm.md');
  assert.equal(results[1].verdict, 'truncated');
});

test('classifyRelease ignores a changeset that does not name this package', () => {
  const results = classifyRelease({
    body: BODY,
    changesets: [...CHANGESETS, { id: 'other.md', text: '---\n"@cosyte/hl7": patch\n---\n\nSomething else entirely.\n' }],
    packageName: '@cosyte/ccda',
  });
  assert.deepEqual(
    results.map((r) => r.changeset),
    ['family.md', 'arm.md'],
  );
});

test('a bullet no changeset accounts for is reported as unmatched, not forced onto one', () => {
  const body = '### What changed\n\n- Something that appears in no changeset this release consumed.\n';
  const [result] = classifyRelease({ body, changesets: CHANGESETS, packageName: '@cosyte/ccda' });
  assert.equal(result.verdict, 'unmatched');
  assert.equal(result.changeset, null);
});

test('an internal-only body has no bullets to classify and reports none', () => {
  const body = '### What changed\n\nInternal tooling and CI only. No change to the published package surface.\n';
  assert.deepEqual(classifyRelease({ body, changesets: CHANGESETS, packageName: '@cosyte/ccda' }), []);
});

// ---------------------------------------------------------------------------------------------
// the CLI, end to end over a real git repo
// ---------------------------------------------------------------------------------------------

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** A repo whose `v0.0.2` tag names a version commit that consumed one changeset. */
function makeTaggedRepo(changesetText) {
  const dir = mkdtempSync(join(tmpdir(), 'release-diff-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  mkdirSync(join(dir, '.changeset'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: '@cosyte/ccda', version: '0.0.1' }, null, 2)}\n`);
  writeFileSync(join(dir, '.changeset/one.md'), changesetText);
  git('add', '-A');
  git('commit', '-qm', 'feat: the work');

  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: '@cosyte/ccda', version: '0.0.2' }, null, 2)}\n`);
  rmSync(join(dir, '.changeset/one.md'));
  git('add', '-A');
  git('commit', '-qm', 'Version Packages');
  git('tag', 'v0.0.2');
  return dir;
}

function bodyFile(dir, entry) {
  const path = join(dir, 'body.md');
  writeFileSync(path, `### What changed\n\n- ${entry}\n\n### Install\n\nnpm install @cosyte/ccda@0.0.2\n`);
  return path;
}

test('the CLI reads a tagged release and exits 1 when a bullet was genuinely cut', () => {
  const dir = makeTaggedRepo(`---\n"@cosyte/ccda": patch\n---\n\n${ARM_SELECTION}\n`);
  const body = bodyFile(
    dir,
    'Close the two arm-selection residuals the previous change named and did not fix, one of which that change created: a `<translation>` was invisible to the conflict rule, a repeated arm was never compared.',
  );
  const result = runCli(['classify', '--repo', dir, '--package', '@cosyte/ccda', '--tag', 'v0.0.2', '--body-file', body]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /GENUINELY TRUNCATED/);
  assert.match(result.stdout, /at all, and a shipped docstring/);
  rmSync(dir, { recursive: true, force: true });
});

test('the CLI exits 0 when the only difference is an identifier the translator removes', () => {
  const dir = makeTaggedRepo(`---\n"@cosyte/ccda": patch\n---\n\n${FAMILY_HISTORY}\n`);
  const body = bodyFile(dir, 'Builder emits a Family History section.');
  const result = runCli(['classify', '--repo', dir, '--package', '@cosyte/ccda', '--tag', 'v0.0.2', '--body-file', body]);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /GENUINELY TRUNCATED/);
  assert.match(result.stdout, /1 identifier-removed/);
  rmSync(dir, { recursive: true, force: true });
});

test('the CLI refuses a tag that does not exist rather than guessing at a commit', () => {
  const dir = makeTaggedRepo(`---\n"@cosyte/ccda": patch\n---\n\n${FAMILY_HISTORY}\n`);
  const result = runCli(['classify', '--repo', dir, '--package', '@cosyte/ccda', '--tag', 'v9.9.9', '--body-file', bodyFile(dir, 'x')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no tag v9\.9\.9/);
  rmSync(dir, { recursive: true, force: true });
});

test('the CLI rejects bad usage', () => {
  assert.equal(runCli(['classify', '--repo']).status, 2);
  assert.equal(runCli(['nonsense', '--package', 'x']).status, 2);
  assert.equal(runCli(['classify', '--repo', '.']).status, 2);
});

test('the CLI emits a report and never a replacement release body', () => {
  // The finding this tool sits on is that these bodies CANNOT be re-derived: six of them refuse
  // through `release-notes.mjs prepare` because their source sentences are over the cap. A command
  // that wrote a body would be that refusal quietly overruled, so there is no such command.
  const help = runCli(['--help']);
  assert.match(help.stdout, /classify/);
  assert.match(help.stdout, /sweep/);
  assert.doesNotMatch(help.stdout, /--out\b/);
});
