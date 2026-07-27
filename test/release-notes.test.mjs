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
  dejargon,
  extractChangeEntries,
  findViolations,
  findVersionCommit,
  headlineOf,
  inspectRelease,
  isConsumerFacing,
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

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
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

test('the internal priority label is removed but ASTM P records are not', () => {
  assert.equal(sanitizeInternal('Patient-identity / merge events (P0 safety)'), 'Patient-identity / merge events');
  assert.equal(
    sanitizeInternal('Model the full patient `P` record identity'),
    'Model the full patient `P` record identity',
  );
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

test('an over-long opening sentence is cut at a word boundary, not mid-word', () => {
  const long = `Ratify the parser choice and add ${'the first runtime dependency '.repeat(12)}chosen for safety`;
  const head = headlineOf(long);
  assert.ok(head.length <= 200);
  assert.ok(long.startsWith(head), 'the headline must be a real prefix of the source');
  assert.ok(long[head.length] === undefined || long[head.length] === ' ', 'the cut fell mid-word');
  assert.ok(!/\s(a|an|the|and|of|to|for|with)$/i.test(head), `dangling function word: ${JSON.stringify(head)}`);
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
