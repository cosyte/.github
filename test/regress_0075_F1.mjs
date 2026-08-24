// REGRESSION ARTIFACT for S0075-landing-docs-validation, impl gate ordinal 1, finding F1.
// Run it with: node --test test/regress_0075_F1.mjs
//
// AN INLINE IMAGE NESTED INSIDE A LINK'S TEXT IS NEVER EXTRACTED, SO ITS DESTINATION IS NEVER
// CHECKED. `[![Logo](./img/missing.svg)](./intro)` is the ordinary shape of a clickable logo or a
// badge, and both destinations are live in what Docusaurus renders: the `<a href>` AND the
// `<img src>`. The checker resolves the outer link and drops the image entirely - the run prints
// "0 image(s)" - so a missing asset there exits ZERO while the SAME image on its own line exits
// non-zero with a B5.
//
// The spec puts this in scope in terms, twice:
//
//   "IN SCOPE: inline links `[text](target)`, inline images `![alt](target)`, and link reference
//    definitions `[label]: target`."                                          (spec.md:169-171)
//   "Image destinations are IN SCOPE THROUGHOUT and decided differently at rule 6; see B5."
//                                                                             (spec.md:183)
//   "**B5** - a package-internal IMAGE destination that fails rule 6's exact-path clause: no
//    REGULAR FILE at `<t>`, a directory sitting there included. Assets ride the same tarball, so a
//    missing one breaks the page as a document does."                         (spec.md:296-298)
//
// and its OUT OF SCOPE list is closed - code spans, fenced blocks, indented blocks, autolinks, raw
// HTML/JSX attributes, MDX expressions (spec.md:176-182). A nested image is none of those, and the
// residual list ("The four NOT-BLOCKING link classes, raw HTML/JSX targets, and duplicate declared
// ids", spec.md:101-102) does not name it either, nor does README.md's. So this is a false GREEN on
// the class B5 exists for, not a declared residual.
//
// This test FAILS against the implementation under review. It documents the bug; fixing it belongs
// to the implementer.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/docs-content-check.mjs');

function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'regress-0075-f1-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

function run(dir) {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, '--repo', dir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const sidebar = (value) => `${JSON.stringify(value, null, 2)}\n`;

test('F1: a broken IMAGE inside a link is a B5, exactly as the same image on its own line is', () => {
  const nested = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['home', 'intro'] }),
    'docs-content/home.md': '# Home\n\n[![Logo](./img/missing.svg)](./intro)\n',
    'docs-content/intro.md': '# Intro\n',
  });
  const bare = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['home', 'intro'] }),
    'docs-content/home.md': '# Home\n\n![Logo](./img/missing.svg)\n',
    'docs-content/intro.md': '# Intro\n',
  });

  // The control establishes that this tree IS a B5 when the image stands alone.
  const control = run(bare);
  assert.equal(control.code, 1, control.output);
  assert.match(control.output, /B5 docs-content\/home\.md:3/);

  const subject = run(nested);
  assert.match(
    subject.output,
    /Checked 2 file\(s\), 1 link\(s\), 1 image\(s\)/,
    `the image destination inside the link text must be counted as an image:\n${subject.output}`,
  );
  assert.equal(
    subject.code,
    1,
    `a missing asset behind a linked logo must red the run exactly as a bare one does:\n${subject.output}`,
  );
  assert.match(subject.output, /B5 docs-content\/home\.md:3/, subject.output);
  assert.match(subject.output, /\.\/img\/missing\.svg/, subject.output);

  rmSync(nested, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

test('F1 (green control): the same nested image RESOLVES when the asset is present', () => {
  const dir = makeTree({
    'docs-content/sidebars.json': sidebar({ docs: ['home', 'intro'] }),
    'docs-content/home.md': '# Home\n\n[![Logo](./img/logo.svg)](./intro)\n',
    'docs-content/img/logo.svg': '<svg/>\n',
    'docs-content/intro.md': '# Intro\n',
  });
  const { code, output } = run(dir);
  assert.equal(code, 0, output);
  assert.match(
    output,
    /Checked 2 file\(s\), 1 link\(s\), 1 image\(s\)/,
    `the image is in scope whether or not it resolves:\n${output}`,
  );
  rmSync(dir, { recursive: true, force: true });
});
