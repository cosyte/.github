// Tests over what this repository TELLS a maintainer to write in their `uses:` line.
//
// WHY THIS IS A TEST AND NOT A REVIEW HABIT. Every instruction in this repository is copied by hand
// into thirteen other repositories, and an example is the part that gets copied: a maintainer reads
// the header of the workflow they are adopting, or the README's "Calling them" block, and pastes
// what it shows. An example still showing `@main` after this repository started publishing
// references is not a stale document, it is thirteen repositories pinned to a branch on purpose.
//
// So these assertions read the TRACKED FILES, in the style of `scripts/check-no-emdash.mjs`, rather
// than trusting that a change was made everywhere it had to be. There is no YAML library here (this
// repository has no package.json), so the parse is line based and deliberately dumb; every
// assertion below is about text a human reads, which is exactly what line based reading is good at.
//
// ▶ WHAT IS DELIBERATELY NOT BANNED: the words `@main` in PROSE. Several of these files explain the
//   `@main` fan-out at length, and this work exists because of it, so a rule that banned the string
//   would delete the explanation along with the example. What is banned is a `uses:` line pointing a
//   caller at a branch, which is the thing that gets copied.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** The six `workflow_call` reusables. A caller's `uses:` line names one of these. */
const REUSABLES = ['ci.yml', 'codeql.yml', 'drift-check.yml', 'nightly-fuzz.yml', 'release.yml', 'scorecard.yml'];

/** The form that does not move: a published reference, named after the commit it carries. */
const REFERENCE_FORM = /@workflows-(?:YYYY-MM-DD-COMMIT|\d{4}-\d{2}-\d{2}-[0-9a-f]{12})\b/;

/** A `uses:` line pointing a caller at this repository, whatever ref it names. */
const CALLER_USES = /uses:\s*cosyte\/\.github\/\.github\/workflows\/([\w.-]+)@(\S+)/;

/** The releases page, which is where a real reference comes from. */
const RELEASES_PAGE = 'https://github.com/cosyte/.github/releases';

const read = (relative) => readFileSync(join(REPO, relative), 'utf8');

/** Every `uses:` line naming one of this repository's workflows, with the ref it names. */
function callerExamples(text) {
  return text
    .split('\n')
    .map((line) => CALLER_USES.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ workflow: match[1], ref: match[2] }));
}

// ---------------------------------------------------------------------------
// README.md, "Calling them": the instructions a maintainer is sent to
// ---------------------------------------------------------------------------

const README = read('README.md');

/** The lines of one `## ` section of the README, heading included. */
function section(heading) {
  const lines = README.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `README.md has no section ${JSON.stringify(heading)}`);
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start, end === -1 ? lines.length : end);
}

const CALLING_THEM = section('## Calling them');

test('AC11: the calling instructions show a reference form that does not move', () => {
  const examples = callerExamples(CALLING_THEM.join('\n'));
  assert.ok(examples.length >= 2, 'the section shows a ci and a release example');
  for (const example of examples) {
    assert.match(
      `@${example.ref}`,
      REFERENCE_FORM,
      `README.md "Calling them" points a caller at @${example.ref}, which moves`,
    );
  }
});

test('AC11: no calling example anywhere in the README points a caller at the default branch', () => {
  for (const example of callerExamples(README)) {
    assert.notEqual(example.ref, 'main', `a README example still shows ${example.workflow}@main`);
  }
});

test('AC11: the calling instructions say what a reference at the default branch costs a caller', () => {
  const text = CALLING_THEM.join('\n');
  // Prose in this repository wraps at about 100 columns, so every sentence asserted here is matched
  // across the line breaks it actually has rather than as one line it does not.
  assert.match(text, /`@main` is a branch/);
  assert.match(
    text,
    /delivers every later\s+change to your pipeline on \*\*this\*\* repository's clock rather than yours/,
    'the cost is stated, not implied',
  );
  assert.match(text, /reviewed by nobody in your\s+repository/);
  assert.match(text, /nothing reaches you until you edit your own\s+`uses:` line/);
});

test('AC11: the instructions send a maintainer somewhere a real reference can be found', () => {
  const text = CALLING_THEM.join('\n');
  assert.ok(text.includes(RELEASES_PAGE), 'the releases page is named, because the example is a placeholder');
  assert.match(text, /placeholder resolves to nothing/, 'and the placeholder says it is one');
});

test('the README owns a section explaining the reference, beside the other gates', () => {
  const gate = section('## The published reference, and what `@main` costs a caller').join('\n');
  assert.match(gate, /workflows-YYYY-MM-DD-<first 12 of the commit>/, 'the name form is documented');
  assert.match(gate, /no `v1`-style major alias/, 'and the alias that would break it is refused by name');
  assert.match(gate, /scripts\/reference-publish\.mjs/);
  assert.match(gate, /\.github\/workflows\/publish-reference\.yml/);
  assert.match(gate, /test\/reference-publish\.test\.mjs/);
  assert.match(gate, /Enable release immutability/, 'the operator setting is named');
  assert.match(gate, /does not depend on that setting|Nothing here depends on that setting/);
  assert.match(gate, /It does not move a single caller/, 'and what it does not do is stated');
});

// ---------------------------------------------------------------------------
// The six headers: the instructions a maintainer actually reads
// ---------------------------------------------------------------------------

/**
 * A workflow's header comment block: from its first comment line to the first line of YAML after it.
 *
 * Not "everything above the first non-comment line": every one of these files opens with `name:`, so
 * that rule returns an empty header and every assertion below passes over nothing.
 */
function header(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith('#'));
  assert.notEqual(start, -1, 'the workflow has no header comment at all');
  const end = lines.findIndex((line, index) => index > start && line.trim() !== '' && !line.trim().startsWith('#'));
  return lines.slice(start, end === -1 ? lines.length : end);
}

for (const workflow of REUSABLES) {
  const text = read(join('.github/workflows', workflow));
  const head = header(text).join('\n');

  test(`AC11: ${workflow}'s header shows a reference form that does not move`, () => {
    const examples = callerExamples(head);
    assert.ok(examples.length >= 1, `${workflow} shows no caller example in its header`);
    for (const example of examples) {
      assert.match(`@${example.ref}`, REFERENCE_FORM, `${workflow} points a caller at @${example.ref}, which moves`);
      assert.equal(example.workflow, workflow, 'a header example names its own workflow');
    }
  });

  test(`AC11: ${workflow}'s header states what a reference at the default branch costs a caller`, () => {
    // Read as prose rather than as lines: these headers wrap at about 100 columns behind a `# `, so
    // every sentence below is spread over two or three lines and none of them is a line.
    const prose = header(text)
      .map((line) => line.replace(/^\s*#\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    assert.match(prose, /NAME A PUBLISHED REFERENCE, NOT `@main`/, `${workflow} does not say which form to use`);
    assert.match(
      prose,
      /A reference at the default branch delivers every later change made here on THIS repository's clock rather than yours/,
      `${workflow} does not say what the branch form costs`,
    );
    assert.match(prose, /reviewed by nobody in your repository/);
    assert.match(prose, /a published reference names one commit and never moves/);
    assert.ok(prose.includes(RELEASES_PAGE), `${workflow} does not say where a real reference comes from`);
  });

  test(`AC11: nothing anywhere in ${workflow} points a caller at the default branch`, () => {
    // Not only the header. A `uses:` example further down would be copied just as readily, and
    // `ci.yml` and `release.yml` both discuss `@main` in prose several hundred lines in.
    for (const example of callerExamples(text)) {
      assert.notEqual(example.ref, 'main', `${workflow} still shows ${example.workflow}@main`);
    }
  });
}

test('AC11: the six headers say the same thing, so a maintainer reads one rule and not six', () => {
  const notes = REUSABLES.map((workflow) => {
    const head = header(read(join('.github/workflows', workflow))).join('\n');
    const start = head.indexOf('NAME A PUBLISHED REFERENCE');
    assert.notEqual(start, -1);
    return head.slice(start).split('\n').slice(0, 5).join('\n').replace(/^#\s*/gm, '');
  });
  for (const note of notes) assert.equal(note, notes[0], 'one wording, six files, so a fix lands everywhere');
});

test('the header edits stayed comment-only, which is what keeps them inert for thirteen callers', () => {
  // Every line this change touched in the six reusables is a comment. Asserted here rather than
  // trusted: an edit to a `uses:` pin, an input name or a job id in one of these files reaches
  // thirteen repositories on merge, and a rename of a job id detaches a ruleset entry silently.
  for (const workflow of REUSABLES) {
    const text = read(join('.github/workflows', workflow));
    const head = header(text);
    for (const line of head) {
      assert.ok(line.trim() === '' || line.trim().startsWith('#'), `${workflow}: ${line} is not a comment`);
    }
    assert.ok(head.some((line) => line.includes('NAME A PUBLISHED REFERENCE')), `${workflow} carries the note`);
  }
});
