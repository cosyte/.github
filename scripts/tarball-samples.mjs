#!/usr/bin/env node
// @ts-check
//
// THE RELEASE'S SAMPLES GATE: THE DOCS SAMPLES, RUN AGAINST THE EXACT TARBALL `npm pack` MAKES.
//
// A library's own test suite runs its documentation samples against its build (`docSnippetSuite` in
// `@cosyte/vitest-config`). That proves the samples agree with `dist/`, and not that they work for a
// reader, who installs the TARBALL: a file left out by `files`, an `exports` entry pointing nowhere or
// a dependency only the workspace has passes the first and breaks the second. So this packs the
// working tree, installs that one tarball into a clean directory that resolves nothing else, and runs
// every sample there, importing the package by its published name, exactly as a reader's project
// would.
//
//   node tarball-samples.mjs --repo . [--docs-dir docs-content] [--registry <url>]
//
// WHAT A SAMPLE IS, as the docs standard (cosyte/config, decision 0006) says: every `ts`,
// `typescript`, `tsx`, `js`, `javascript` and `mjs` block on a page under the docs directory, the
// generated `api/` folder left out. A line `<expression>; // => <value>` asserts the two are deeply
// and strictly equal. A block tagged `throws` must throw. A block tagged `no-run <reason>` is listed
// with its reason and not run; `no-run` with no reason fails. TypeScript runs with Node's own type
// stripping, so it is not type-checked here (the library's suite does that against its built types);
// a `tsx` block needs a JSX transform a clean install does not have, and is listed as not run.
//
// VERDICTS. Exit 0 when every sample that runs passed, or when there is nothing to run: no docs
// directory, or no sample in it, each said by name. Exit 1 when a sample failed, when the tarball
// did not install, or when a `no-run` gives no reason. Exit 2 when the input cannot be used.
//
// The install and the samples run with an environment built from nothing (`probeChildEnv`), so no
// credential of the job reaches a sample or a dependency's install script.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { DEFAULT_REGISTRY, makeCleanRoom, probeChildEnv, runCommand } from './install-check.mjs';
import { installTarball, packTree } from './prepublish-check.mjs';

/** The fence languages that make a block a sample. */
export const SAMPLE_LANGS = Object.freeze(['ts', 'typescript', 'tsx', 'js', 'javascript', 'mjs']);

/** How long one sample may run. */
export const SAMPLE_TIMEOUT_MS = 60_000;

/** The name a sample's assertions call; prepended to each sample as an import. */
const ASSERT = '__cosyteSampleAssert';

/** The module each sample language runs as. ESM in every case, whatever the package's `type`. */
function extensionOf(lang) {
  if (lang === 'js' || lang === 'javascript' || lang === 'mjs') return '.mjs';
  if (lang === 'tsx') return '.tsx';
  return '.mts';
}

/**
 * Every sample on a markdown page.
 *
 * @param {string} markdown
 * @returns {{ lang: string, tags: string[], code: string, line: number, throws: boolean, skip: string | null, extension: string }[]}
 */
export function extractSamples(markdown) {
  const lines = markdown.split(/\r?\n/);
  const samples = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open) continue;
    const [, indent, fence, info] = open;
    const words = info.trim().split(/\s+/).filter(Boolean);
    const lang = (words[0] ?? '').toLowerCase();
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const trimmed = lines[j].trim();
      if (trimmed.startsWith(fence[0].repeat(fence.length)) && trimmed.replaceAll(fence[0], '') === '') break;
      body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j].trimStart());
    }
    if (SAMPLE_LANGS.includes(lang)) {
      const tags = words.slice(1);
      const at = tags.indexOf('no-run');
      samples.push({
        lang,
        tags,
        code: body.join('\n'),
        line: i + 2,
        throws: (at === -1 ? tags : tags.slice(0, at)).includes('throws'),
        skip: at === -1 ? null : tags.slice(at + 1).join(' '),
        extension: extensionOf(lang),
      });
    }
    i = j;
  }
  return samples;
}

/**
 * Turn each `<expression>; // => <value>` line into an assertion that the two are deeply and strictly
 * equal. A line whose marker ends it, with no value after, is left alone.
 *
 * @param {string} code
 * @returns {{ code: string, assertions: number }}
 */
export function rewriteAssertions(code) {
  let assertions = 0;
  const rewritten = code.split('\n').map((line) => {
    for (const marker of line.matchAll(/;\s*\/\/\s*=>/g)) {
      const end = (marker.index ?? 0) + marker[0].length;
      const expected = line.slice(end).trim();
      if (expected === '') continue;
      const ws = line.slice(0, line.length - line.trimStart().length);
      const expression = line.slice(ws.length, marker.index);
      if (expression.trim() === '') continue;
      assertions += 1;
      return `${ws}${ASSERT}(${expression}, ${expected});`;
    }
    return line;
  });
  return { code: rewritten.join('\n'), assertions };
}

/**
 * The documentation pages: every `.md` and `.mdx` file under `docsDir`, its top-level `api/` folder
 * left out, sorted.
 *
 * @param {string} docsDir
 * @returns {string[]}
 */
export function samplePages(docsDir) {
  const generated = path.join(docsDir, 'api');
  /** @type {string[]} */
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full !== generated && entry.name !== 'node_modules') walk(full);
      } else if (/\.mdx?$/i.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(docsDir);
  return found.sort();
}

/** `--flag value` pairs. */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!['--repo', '--docs-dir', '--registry'].includes(flag)) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  return flags;
}

/**
 * What a failed sample printed, for its failure message: the first line naming an error, which a
 * stack trace pushes far from the end, then the last lines.
 */
function tail(text, lines = 8) {
  const all = String(text ?? '').trim().split('\n');
  const last = all.slice(-lines);
  const first = all.find((line) => /\b\w*Error\b|ERR_/.test(line));
  return (first === undefined || last.includes(first) ? last : [first, '...', ...last]).join('\n');
}

/**
 * Run the gate.
 *
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, out?: (s: string) => void }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.out ?? ((s) => process.stdout.write(s));
  const summary = (lines) => {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n\n`);
  };
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    out(`::error title=Samples gate refused its input::${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const repo = path.resolve(flags.repo ?? '.');
  const docsName = (flags['docs-dir'] ?? 'docs-content').replace(/\/+$/, '');
  const docsDir = path.resolve(repo, docsName);
  if (docsName === '' || path.isAbsolute(docsName) || path.relative(repo, docsDir).startsWith('..')) {
    out(`::error title=Samples gate refused its input::docs-dir must be a directory inside the repository, not ${JSON.stringify(docsName)}\n`);
    return 2;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  } catch (error) {
    out(`::error title=Samples gate refused its input::${path.join(repo, 'package.json')} could not be read: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const name = String(manifest?.name ?? '(unnamed package)');
  const skip = (why) => {
    out(`samples gate skipped: ${why}\n`);
    summary(['### Samples against the packed tarball: skipped', '', `${why}.`]);
    return 0;
  };
  if (!existsSync(docsDir) || !statSync(docsDir).isDirectory()) return skip(`${name} has no ${docsName}/ directory, so no sample runs against its tarball`);

  const plan = [];
  for (const page of samplePages(docsDir)) {
    for (const sample of extractSamples(readFileSync(page, 'utf8'))) {
      plan.push({ ...sample, label: `${path.relative(repo, page).split(path.sep).join('/')}:${sample.line}` });
    }
  }
  if (plan.length === 0) return skip(`${name} has no TypeScript or JavaScript sample under ${docsName}/`);

  const work = mkdtempSync(path.join(env.RUNNER_TEMP || tmpdir(), 'cosyte-tarball-samples-'));
  /** @type {string[]} */
  const failures = [];
  let ran = 0;
  let notRun = 0;
  const fail = (label, why) => {
    failures.push(label);
    out(`::error title=Sample failed against the tarball::${label}: ${why.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`);
  };
  try {
    const packed = await packTree({ repo, destination: work });
    out(`packed ${path.basename(packed.tarball)}\n`);
    const room = await makeCleanRoom(work);
    const installed = await installTarball({ dir: room, tarball: packed.tarball, registry: flags.registry || DEFAULT_REGISTRY });
    if (!installed.ok) {
      out(`::error title=Tarball did not install::${path.basename(packed.tarball)} did not install into a clean directory (npm exited ${installed.code}), so no sample could run against it.\n${installed.output}\n`);
      summary(['### Samples against the packed tarball: fail', '', `${path.basename(packed.tarball)} did not install into a clean directory.`]);
      return 1;
    }
    const samplesDir = path.join(room, 'samples');
    mkdirSync(samplesDir, { recursive: true });
    const childEnv = probeChildEnv(room, env);
    const stripFlag = process.features?.typescript ? [] : ['--experimental-strip-types'];
    for (const [index, sample] of plan.entries()) {
      if (sample.skip === '') {
        fail(sample.label, 'no-run with no reason: a sample that cannot run says why after no-run, as in: ts no-run <why>');
        continue;
      }
      if (sample.skip !== null) {
        notRun += 1;
        out(`not run ${sample.label}: ${sample.skip}\n`);
        continue;
      }
      if (sample.extension === '.tsx') {
        notRun += 1;
        out(`not run ${sample.label}: a tsx sample needs a JSX transform, which a clean install of the tarball does not have\n`);
        continue;
      }
      const file = path.join(samplesDir, `sample-${index}${sample.extension}`);
      const { code } = rewriteAssertions(sample.code);
      writeFileSync(file, `import { deepStrictEqual as ${ASSERT} } from "node:assert/strict";\n${code}\n`);
      const args = [...(sample.extension === '.mts' ? stripFlag : []), '--no-warnings', file];
      const result = await runCommand(process.execPath, args, { cwd: room, env: childEnv, timeoutMs: SAMPLE_TIMEOUT_MS });
      ran += 1;
      if (sample.throws) {
        if (result.code === 0) fail(sample.label, 'tagged throws and ran clean');
        else out(`ran ${sample.label} (threw, as tagged)\n`);
      } else if (result.code !== 0) {
        fail(sample.label, tail(`${result.out}\n${result.err}`) || `exited ${result.code}`);
      } else {
        out(`ran ${sample.label}\n`);
      }
    }
  } catch (error) {
    out(`::error title=Samples gate did not complete::${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  out(`samples gate: ${ran} sample(s) ran against the tarball, ${notRun} not run, ${failures.length} failed\n`);
  summary([
    `### Samples against the packed tarball: ${failures.length === 0 ? 'pass' : 'fail'}`,
    '',
    `${ran} sample(s) ran against the installed tarball, ${notRun} not run, ${failures.length} failed.`,
    ...failures.map((label) => `- failed: \`${label}\``),
  ]);
  return failures.length === 0 ? 0 : 1;
}

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stdout.write(`::error title=Samples gate did not complete::${error?.message ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
