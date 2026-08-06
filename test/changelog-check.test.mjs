// Tests for scripts/changelog-check.mjs, the gate that refuses to publish a release whose own
// CHANGELOG.md does not record it.
//
// WHAT THESE TESTS ARE FOR, said once so the individual cases read against it. The defect is not
// "the changelog is untidy". It is that `changeset version` can bump the version, consume the
// changesets, and write NO CHANGELOG, while reporting success -- so every arm here is really asking
// one question: does this gate still speak when everything else in the pipeline is green?
//
// The `assertVerdict` helper drives the REAL entry point over REAL files in a temp directory rather
// than calling the exported predicate, because the argument parsing, the file paths and the exit
// code are what `release.yml` depends on and a unit test of the predicate alone proves none of them.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkChangelog, generatorIsOn, topLevelHeadings, versionHeadingLines } from '../scripts/changelog-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/changelog-check.mjs');

/** A throwaway caller repo: `.changeset/config.json` plus, optionally, a `CHANGELOG.md`. */
function makeRepo({ config, changelog }) {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-check-'));
  mkdirSync(join(dir, '.changeset'), { recursive: true });
  if (config !== undefined) writeFileSync(join(dir, '.changeset/config.json'), config);
  if (changelog !== undefined) writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

/** Run the CLI exactly as release.yml does, and return { code, output }. */
function run(dir, version) {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, '--repo', dir, '--version', version], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const GENERATOR_ON = JSON.stringify({ changelog: '@changesets/cli/changelog', commit: false }, null, 2);
const GENERATOR_OFF = JSON.stringify({ changelog: false, commit: false }, null, 2);

/** The shape `@changesets/cli/changelog` actually writes, continuation lines indented by two. */
const GENERATED = `# Changelog

## 0.0.9

### Patch Changes

- abc1234: Stop a dropped LX segment from mis-filing the segments that follow it.
  The rest of the summary is indented by two spaces, which is what makes a
  column-0 comparison sound.

## 0.0.8

### Patch Changes

- def5678: An earlier release.
`;

test('the gate passes when the generator wrote the section it was supposed to write', () => {
  const dir = makeRepo({ config: GENERATOR_ON, changelog: GENERATED });
  const { code, output } = run(dir, '0.0.9');
  assert.equal(code, 0);
  assert.match(output, /verdict: pass/);
  rmSync(dir, { recursive: true, force: true });
});

// THE DEFECT ITSELF. This is what a swallowed `console.warn` leaves on disk: the version bumped in
// package.json, the changesets consumed, and a changelog that never heard about either.
test('THE DEFECT: a version bumped with NO changelog section is refused, loudly, before npm', () => {
  const dir = makeRepo({
    config: GENERATOR_ON,
    changelog: '# Changelog\n\n## 0.0.8\n\n### Patch Changes\n\n- def5678: An earlier release.\n',
  });
  const { code, output } = run(dir, '0.0.9');
  assert.equal(code, 1, 'a release whose changelog does not record it must not publish');
  assert.match(output, /verdict: missing-section/);
  // The message has to name the mechanism, because the symptom (a green run) points at nothing.
  assert.match(output, /console\.warn/);
  assert.match(output, /NOTHING HAS BEEN PUBLISHED/);
  // And it has to say what IS in the file, or the reader cannot tell empty from stale from reshaped.
  assert.match(output, /## 0\.0\.8/);
  // A GitHub annotation, so the failure is visible on the run rather than only in the log.
  assert.match(output, /::error title=The changelog has no section for this release::/);
  rmSync(dir, { recursive: true, force: true });
});

// TRAP 3, AND IT IS THE ONE THAT WOULD HAVE SHIPPED. `## 0.0.1` is a SUBSTRING of `## 0.0.10`, so
// an `includes`/`indexOf` gate passes on a repo's first release and reds on its tenth. Four of the
// thirteen callers are already at or past 0.0.10, so this is not a distant edge.
test('TRAP 3: the heading is compared WHOLE, so `## 0.0.1` does not satisfy a release of `0.0.10`', () => {
  const dir = makeRepo({
    config: GENERATOR_ON,
    changelog: '# Changelog\n\n## 0.0.1\n\n### Patch Changes\n\n- abc1234: The first release.\n',
  });
  assert.equal(run(dir, '0.0.10').code, 1, '0.0.1 must not satisfy 0.0.10');
  assert.equal(run(dir, '0.0.1').code, 0, 'and the whole-line match must still succeed');
  rmSync(dir, { recursive: true, force: true });

  // The other direction of the same substring: a longer version must not be satisfied by a prefix.
  assert.deepEqual(versionHeadingLines('## 0.0.10\n', '0.0.1'), []);
  assert.deepEqual(versionHeadingLines('## 0.0.1\n', '0.0.1'), [1]);
});

// TRAP 3'S SECOND HALF. `getReleaseLine` indents every continuation line of a summary by two
// spaces, so nothing INSIDE a release section starts at column 0. That is what makes column 0 a
// sound test for "the generator wrote this" -- and what makes a trimmed comparison unsound, because
// an author who quotes a version heading in a changeset summary would otherwise satisfy the gate
// with text the generator never wrote.
test('TRAP 3: a version heading QUOTED inside a release section does not satisfy the gate', () => {
  const quoted = `# Changelog

## 0.0.8

### Patch Changes

- abc1234: Explain the archive heading in the summary.
  ## 0.0.9
  which is where a quoted copy lands, indented by two spaces, inside the release section.
`;
  const dir = makeRepo({ config: GENERATOR_ON, changelog: quoted });
  const { code, output } = run(dir, '0.0.9');
  assert.equal(code, 1, 'an indented quotation is not the generator writing a heading');
  assert.match(output, /verdict: missing-section/);
  rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(versionHeadingLines('  ## 0.0.9\n', '0.0.9'), [], 'indented is not a heading');
  assert.deepEqual(versionHeadingLines('\t## 0.0.9\n', '0.0.9'), [], 'nor is a tab');
  assert.deepEqual(versionHeadingLines('## 0.0.9  \n', '0.0.9'), [1], 'trailing space is invisible');
  assert.deepEqual(versionHeadingLines('## 0.0.9\r\n', '0.0.9'), [1], 'and so is a CRLF');
  assert.deepEqual(versionHeadingLines('### 0.0.9\n', '0.0.9'), [], 'a different level is a different heading');
});

// THE HALF THAT KEEPS THIS FROM REDDING SIX REPOS. A caller with `"changelog": false` writes its
// changelog by hand and `changeset version` writes no version section there BY DESIGN.
test('a hand-maintained changelog is not this gate\'s business, and it says so rather than passing silently', () => {
  const dir = makeRepo({
    config: GENERATOR_OFF,
    changelog: '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Something, recorded by hand.\n',
  });
  const { code, output } = run(dir, '0.0.9');
  assert.equal(code, 0);
  assert.match(output, /verdict: not-applicable/);
  // It must NOT read as a clean bill of health for a file it did not check. That distinction is the
  // same one `install-check.mjs` draws between `pass` and `blocked-peer`: a verdict that establishes
  // less than it looks like it does has to say so at the point it is printed.
  assert.match(output, /not a statement that it is correct/);
  rmSync(dir, { recursive: true, force: true });
});

// The discriminator, read directly. An ABSENT `changelog` key is Changesets' own default, which is
// the built-in generator -- so absent must read as ON. Reading it as OFF would exempt precisely the
// repo that configured nothing, i.e. the one least likely to notice a missing section.
test('the generator discriminator matches Changesets, including for an absent key', () => {
  assert.equal(generatorIsOn(false), false);
  assert.equal(generatorIsOn(null), false);
  assert.equal(generatorIsOn(undefined), true, 'absent means the built-in generator, which writes sections');
  assert.equal(generatorIsOn('@changesets/cli/changelog'), true);
  assert.equal(generatorIsOn(['@changesets/changelog-github', { repo: 'cosyte/hl7' }]), true, 'the tuple form is on');
});

test('the tuple form of `changelog` is governed, not exempted', () => {
  const dir = makeRepo({
    config: JSON.stringify({ changelog: ['@changesets/changelog-github', { repo: 'cosyte/hl7' }] }),
    changelog: '# Changelog\n\n## 0.0.8\n',
  });
  assert.equal(run(dir, '0.0.9').code, 1);
  rmSync(dir, { recursive: true, force: true });
});

// FAIL CLOSED, and the direction matters. Reading an unreadable config as "generator off" would turn
// a broken checkout into a silent exemption from the one check that reads CHANGELOG.md.
test('an unreadable .changeset/config.json fails the run rather than exempting it', () => {
  for (const config of [undefined, '{ not json', '']) {
    const dir = makeRepo({ config, changelog: '# Changelog\n' });
    const { code, output } = run(dir, '0.0.9');
    assert.equal(code, 1, `config ${JSON.stringify(config)} must fail closed`);
    assert.match(output, /verdict: unreadable-config/);
    assert.match(output, /Refusing to guess/);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing CHANGELOG.md with the generator on is the same defect, not a different one', () => {
  const dir = makeRepo({ config: GENERATOR_ON });
  const { code, output } = run(dir, '0.0.9');
  assert.equal(code, 1);
  assert.match(output, /verdict: no-changelog/);
  assert.match(output, /console\.warn/);
  rmSync(dir, { recursive: true, force: true });
});

// A second column-0 match is possible -- trap 6: a changeset summary that opens a line at column 0
// with an ATX heading renders as a heading inside the release section, permanently. It is worth
// naming, and it is NOT what this gate refuses: the section the release needs is present.
test('more than one matching heading is reported, and is not a refusal', () => {
  const dir = makeRepo({ config: GENERATOR_ON, changelog: '# Changelog\n\n## 0.0.9\n\n## 0.0.9\n' });
  const { code, output } = run(dir, '0.0.9');
  assert.equal(code, 0, 'the section the release needs is there');
  assert.match(output, /MORE THAN ONE line matches/);
  rmSync(dir, { recursive: true, force: true });
});

test('bad usage is exit 2, distinct from a failing check', () => {
  assert.equal(run(makeRepo({ config: GENERATOR_ON }), '').code, 2, 'an empty version is not a check that failed');
  const missingArgs = (() => {
    try {
      execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return 0;
    } catch (error) {
      return error.status;
    }
  })();
  assert.equal(missingArgs, 2);
});

test('the reported heading list is the top-level headings and nothing else', () => {
  assert.deepEqual(topLevelHeadings('# Changelog\n\n## 0.0.8\n\n### Patch Changes\n\n- an entry\n'), [
    '# Changelog',
    '## 0.0.8',
  ]);
  assert.deepEqual(topLevelHeadings('##nospace\n#\n'), [], 'a heading needs a space and a word');
});

// THE WIRING. A gate that exists and is not called is not a gate, and every one of these is a
// property `release.yml` has to hold rather than something this script can enforce about itself.
test('release.yml runs this gate BEFORE changesets/action, on the release arm, at the derived version', () => {
  const workflow = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', resolve(HERE, '../.github/workflows/release.yml')],
    { encoding: 'utf8' },
  );

  const step = /- name: The changelog must carry a section for the version being released\n([\s\S]*?)\n      - name: /.exec(
    workflow,
  );
  assert.ok(step, 'release.yml no longer runs the changelog gate');

  // Only on the arm that is about to publish. Without this it fires on every push to main, where
  // there is no release and the version in package.json is the one already on the registry.
  assert.match(step[1], /if: \$\{\{ steps\.notes\.outputs\.is-release == 'true' \}\}/);
  // The version comes from the notes gate, never re-derived. Two derivations can disagree, and this
  // one deciding a publish on a version the other did not authorise is the whole failure it guards.
  assert.match(step[1], /NOTES_VERSION: \$\{\{ steps\.notes\.outputs\.version \}\}/);
  assert.match(step[1], /changelog-check\.mjs \\\n\s*--repo \. --version "\$NOTES_VERSION"/);

  // ORDER IS THE GATE. A check that runs after `changesets/action` runs after the publish, and a
  // check that runs after an irreversible act cannot gate it.
  const gateAt = workflow.indexOf('- name: The changelog must carry a section for the version being released');
  const actionAt = workflow.indexOf('uses: changesets/action@');
  assert.ok(gateAt > 0 && actionAt > 0);
  assert.ok(gateAt < actionAt, 'the changelog gate must run before anything can be published');
});

// The census that made turning this on a one-line change rather than a thirteen-repo migration.
// Kept as an assertion about the PREDICATE rather than about the live repos, which move.
test('the two verdicts that exit 0 are exactly not-applicable and pass', () => {
  const dir = makeRepo({ config: GENERATOR_OFF, changelog: '# Changelog\n' });
  assert.equal(checkChangelog({ repo: dir, version: '9.9.9' }).failing, false);
  assert.equal(checkChangelog({ repo: dir, version: '9.9.9' }).verdict, 'not-applicable');
  rmSync(dir, { recursive: true, force: true });

  const on = makeRepo({ config: GENERATOR_ON, changelog: '# Changelog\n\n## 9.9.9\n' });
  assert.equal(checkChangelog({ repo: on, version: '9.9.9' }).failing, false);
  assert.equal(checkChangelog({ repo: on, version: '9.9.9' }).verdict, 'pass');
  assert.equal(checkChangelog({ repo: on, version: '9.9.10' }).failing, true);
  rmSync(on, { recursive: true, force: true });
});
