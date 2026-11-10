// The docs-content checker's entry guard: the line that decides whether `node docs-content-check.mjs`
// runs `main` at all. On a Windows runner it did not. The guard compared `resolve(argv[1])` with
// `resolve(new URL(import.meta.url).pathname)`, that pathname is `/D:/a/_temp/docs-content-check.mjs`
// there, and the two never matched, so `ci.yml`'s docs-content step exited 0 having checked nothing.
// `self-check.yml`'s `systems` job found it: its Windows legs printed no summary line.
//
// This file runs on Linux, so it cannot start the checker on Windows. It asks the guard the
// question Windows asks, with Node's win32 path and URL rules, and keeps the old spelling beside it
// as the control that shows the question can fail.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { invokedDirectly } from '../scripts/docs-content-check.mjs';

const CHECKER = fileURLToPath(new URL('../scripts/docs-content-check.mjs', import.meta.url));

/** Where `ci.yml` puts the checker on a Windows runner, as node sees it there. */
const WINDOWS_ARGV1 = 'D:\\a\\_temp\\docs-content-check.mjs';
const WINDOWS_URL = 'file:///D:/a/_temp/docs-content-check.mjs';

/** Path to file URL by Windows rules, which is what the default does on a Windows runner. */
const windowsToUrl = (path) => pathToFileURL(win32.resolve(path), { windows: true }).href;

test('on Windows the old guard never matched, which is why main never ran there', () => {
  const old = win32.resolve(WINDOWS_ARGV1) === win32.resolve(new URL(WINDOWS_URL).pathname);
  assert.equal(old, false);
});

test('the guard matches the script node was started with, by Windows rules and by POSIX rules', () => {
  assert.equal(invokedDirectly(WINDOWS_ARGV1, WINDOWS_URL, windowsToUrl), true);
  assert.equal(invokedDirectly('/home/runner/work/_temp/docs-content-check.mjs', 'file:///home/runner/work/_temp/docs-content-check.mjs'), true);
});

test('the guard refuses another script, and a missing one', () => {
  assert.equal(invokedDirectly('D:\\a\\_temp\\other.mjs', WINDOWS_URL, windowsToUrl), false);
  assert.equal(invokedDirectly('/tmp/other.mjs', pathToFileURL(CHECKER).href), false);
  assert.equal(invokedDirectly(undefined, pathToFileURL(CHECKER).href), false);
  assert.equal(invokedDirectly('', pathToFileURL(CHECKER).href), false);
});

test('started as a script, the checker runs main and prints its summary', () => {
  const repo = mkdtempSync(join(tmpdir(), 'docs-entry-'));
  mkdirSync(join(repo, 'docs-content'));
  writeFileSync(join(repo, 'docs-content', 'intro.md'), '# Intro\n');
  writeFileSync(join(repo, 'docs-content', 'sidebars.json'), '{"docs":["intro"]}\n');
  const result = spawnSync(process.execPath, [resolve(CHECKER), '--repo', repo], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Checked 1 file\(s\), 0 link\(s\), 0 image\(s\) and 1 document id\(s\)/m);
});
