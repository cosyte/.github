// Every `github/codeql-action/*` pin in this repository carries one SHA and one version.
//
// WHY. `analyze` refuses the configuration `init` wrote when the two versions differ, on any
// difference, so a skewed pair turns every caller's CodeQL job red and uploads no SARIF. Dependabot
// opens one pull request per action path and rebases each on its own, so its pull requests drift
// apart while they wait: merging them is how the skew arrives. `codeql.yml` explains the rest. This
// test is what makes the rule a gate rather than a comment.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = resolve(HERE, '..', '.github/workflows');

const USES = /^\s*(?:-\s*)?uses:\s*github\/codeql-action\/([\w-]+)@(\S+)(?:\s+#\s*(\S+))?\s*$/;

function pins() {
  const found = [];
  for (const name of readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file)).sort()) {
    readFileSync(join(WORKFLOWS, name), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const match = USES.exec(line);
        if (match) found.push({ at: `${name}:${index + 1}`, action: match[1], ref: match[2], version: match[3] ?? null });
      });
  }
  return found;
}

test('init, analyze and upload-sarif are all pinned, so the check below has something to compare', () => {
  assert.deepEqual([...new Set(pins().map((pin) => pin.action))].sort(), ['analyze', 'init', 'upload-sarif']);
});

test('every codeql-action pin is a full commit SHA with a version comment', () => {
  for (const pin of pins()) {
    assert.match(pin.ref, /^[0-9a-f]{40}$/, `${pin.at}: not pinned to a full commit SHA`);
    assert.match(pin.version ?? '', /^v\d+\.\d+\.\d+$/, `${pin.at}: no exact version comment`);
  }
});

test('every codeql-action pin carries the same SHA and the same version', () => {
  const all = pins();
  const refs = new Set(all.map((pin) => `${pin.ref} ${pin.version}`));
  assert.equal(refs.size, 1, `the pins disagree:\n${all.map((pin) => `  ${pin.at} ${pin.action}@${pin.ref} ${pin.version}`).join('\n')}`);
});
