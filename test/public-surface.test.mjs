// This repository is public, and every tracked file in it is read by anyone. Our planning lives
// elsewhere, so a file here that names a planning path or one of its ids points a reader at
// something they cannot open. The README named both once, in its dash gate section, and nothing
// caught it. This reads every tracked file, so a new mention is red here before it merges.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What names our planning: its folder, and its item, standard and decision ids. The folder counts
 * after a slash, a dot or a hyphen too (a path into another checkout, a relative path), and only a
 * letter, digit or underscore before it makes it another word. Decision ids run from one digit to
 * four.
 */
const INTERNAL = [
  { what: 'the planning folder', pattern: /(?<!\w)plans\// },
  { what: 'an open-work id', pattern: /\bOW\d+\b/ },
  { what: 'a standards id', pattern: /\bST\d+\b/ },
  { what: 'a decision id', pattern: /\bD\d{1,4}\b/ },
];

test('no tracked file names our planning folder or one of its ids', () => {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split('\0').filter((file) => file !== '');
  assert.ok(files.length > 0, 'git ls-files listed nothing');
  const found = [];
  for (const file of files) {
    const lines = readFileSync(join(REPO, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const { what, pattern } of INTERNAL) if (pattern.test(line)) found.push(`${file}:${index + 1}: ${what}`);
    });
  }
  assert.deepEqual(found, []);
});

// Each sample is built from parts, so no line of this file names what the scan above looks for.
const folder = (before) => `${before}${['plans', 'open-work.md'].join('/')}`;
const decision = (digits) => ['D', digits].join('');

test('the planning folder pattern catches the folder wherever a path puts it', () => {
  const { pattern } = INTERNAL.find(({ what }) => what === 'the planning folder');
  for (const before of ['', 'see ', '`', '(', 'cosyte/', '../', './', '.', 'the-']) {
    assert.match(folder(before), pattern, JSON.stringify(before));
  }
  // A word that merely ends in the same letters is not the folder.
  assert.doesNotMatch(folder('ex'), pattern);
});

test('the decision id pattern catches ids of one to four digits, and nothing longer', () => {
  const { pattern } = INTERNAL.find(({ what }) => what === 'a decision id');
  for (const digits of ['7', '42', '153', '1024']) assert.match(`see ${decision(digits)}.`, pattern, digits);
  assert.doesNotMatch(`see ${decision('12345')}.`, pattern);
  assert.doesNotMatch(`see A${decision('12')}.`, pattern);
});
