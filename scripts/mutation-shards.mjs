#!/usr/bin/env node
// @ts-check
//
// THE MERGE AT THE END OF THE SHARDED WEEKLY MUTATION RUN. `weekly-mutation.yml` runs the caller's
// full mutation command once per shard, with `COSYTE_MUTATE_SHARD=<k>/<n>` set, and each shard leaves
// `<package>/reports/mutation/shard-<k>-of-<n>.json` in every package directory its command ran in.
// This joins each package's shards into the one `reports/mutation/mutation.json` beside them, which is
// the file `cosyte-ratchet check` scores against the package's floor, exactly as an unsharded run left
// it.
//
//   node mutation-shards.mjs merge --shards <dir> --count <n> --into <dir>
//
// `--shards` is where the shard artifacts were downloaded, merged into one tree: each report sits at
// the path it had under the caller's working directory, and each shard's `shard-<k>-of-<n>.txt` note
// (full, or incremental and from which cache entry) sits at the top. `--into` is that working
// directory.
//
// WHAT IT REFUSES, AND WHY EACH IS A FAILURE RATHER THAN A WARNING. A package missing a shard would be
// scored on part of its code, and the score would read as the package's. A file in two shards means
// the shards did not partition the files, so its mutants would count twice. A run that left no shard
// report at all is a `cosyte-mutate` that does not shard. Each is exit 1, with nothing written for the
// package concerned. Arguments it cannot use, and a report it cannot read as JSON, are exit 2.
//
// Node built-ins only: it runs from the tooling checkout, before or without any install of its own.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** The largest shard count `weekly-mutation.yml` accepts. */
export const MAX_SHARDS = 16;

/** The directory, under a package, that holds its mutation reports. */
export const REPORT_DIR = 'reports/mutation';

/**
 * The file a shard's run writes.
 *
 * @param {number} k The shard, from 1.
 * @param {number} n The shard count.
 */
export function shardReportName(k, n) {
  return `shard-${k}-of-${n}.json`;
}

/** Thrown for input this cannot read. Exit 2. */
class Unreadable extends Error {}

/** Thrown for a merge that would give a wrong score. Exit 1. */
class Refused extends Error {}

/**
 * Group shard report paths by the package directory they were written in.
 *
 * @param {string[]} paths Paths relative to the shards directory, with forward slashes.
 * @param {number} count The shard count of this run; reports of another count are not this run's.
 * @returns {Map<string, Map<number, string>>} Package directory (`.` for the top) to shard to path.
 */
export function groupShardReports(paths, count) {
  const pattern = new RegExp(`^(?:(.*)/)?${REPORT_DIR}/shard-(\\d+)-of-(\\d+)\\.json$`);
  /** @type {Map<string, Map<number, string>>} */
  const groups = new Map();
  for (const file of paths) {
    const match = pattern.exec(file);
    if (!match || Number(match[3]) !== count) continue;
    const dir = match[1] ?? '.';
    if (!groups.has(dir)) groups.set(dir, new Map());
    /** @type {Map<number, string>} */ (groups.get(dir)).set(Number(match[2]), file);
  }
  return groups;
}

/**
 * Join shard reports into one: every shard's files, the first report's header, the test files of
 * all of them.
 *
 * @param {any[]} reports Parsed mutation-testing-report-schema documents, one per shard.
 * @returns {any} The merged report.
 */
export function mergeReports(reports) {
  if (reports.length === 0) throw new Refused('there is no shard report to merge');
  /** @type {Record<string, any>} */
  const files = {};
  /** @type {Record<string, any>} */
  const testFiles = {};
  reports.forEach((report, index) => {
    if (typeof report?.files !== 'object' || report.files === null || Array.isArray(report.files)) {
      throw new Refused(`shard report ${index + 1} has no files object`);
    }
    for (const [name, file] of Object.entries(report.files)) {
      if (Object.hasOwn(files, name)) throw new Refused(`${name} is in more than one shard, so its mutants would count twice`);
      files[name] = file;
    }
    for (const [name, file] of Object.entries(report.testFiles ?? {})) {
      const tests = new Map((testFiles[name]?.tests ?? []).map((/** @type {any} */ t) => [t.id, t]));
      for (const t of file?.tests ?? []) if (!tests.has(t.id)) tests.set(t.id, t);
      testFiles[name] = { ...file, tests: [...tests.values()] };
    }
  });
  const { performance: _performance, files: _files, testFiles: _testFiles, ...header } = reports[0];
  const merged = { ...header, files };
  if (Object.keys(testFiles).length > 0) merged.testFiles = testFiles;
  return merged;
}

/** Every file under `root`, relative to it, with forward slashes. */
function filesUnder(root, dir = root) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(root, full));
    else if (entry.isFile()) found.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return found.sort();
}

/** The mutants in a report, counted. */
function mutantCount(report) {
  return Object.values(report.files).reduce((total, file) => total + (Array.isArray(file?.mutants) ? file.mutants.length : 0), 0);
}

/** `--flag value` pairs. */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!['--shards', '--count', '--into'].includes(flag)) throw new Unreadable(`unknown argument ${JSON.stringify(flag)}`);
    if (value === undefined) throw new Unreadable(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  for (const name of ['shards', 'count', 'into']) if (flags[name] === undefined) throw new Unreadable(`--${name} is required`);
  if (!/^\d+$/.test(flags.count) || Number(flags.count) < 1 || Number(flags.count) > MAX_SHARDS) {
    throw new Unreadable(`--count must be a whole number from 1 to ${MAX_SHARDS}, not ${JSON.stringify(flags.count)}`);
  }
  return { shards: flags.shards, count: Number(flags.count), into: flags.into };
}

const USAGE = 'usage: mutation-shards.mjs merge --shards <dir> --count <n> --into <dir>\n';

/**
 * Run the CLI.
 *
 * @param {string[]} argv The arguments after the script.
 * @param {{ out?: (s: string) => void, err?: (s: string) => void, env?: Record<string, string | undefined> }} [io]
 * @returns {number} The exit code.
 */
export function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  const env = io.env ?? process.env;
  try {
    const [command, ...rest] = argv;
    if (command !== 'merge') throw new Unreadable(`the command must be merge, not ${JSON.stringify(command)}`);
    const { shards, count, into } = parseFlags(rest);
    if (!existsSync(shards)) throw new Refused(`no shard report of ${count} shard(s) was found: ${shards} does not exist`);
    const all = filesUnder(shards);
    const groups = groupShardReports(all, count);
    if (groups.size === 0) {
      throw new Refused(
        `no shard report of ${count} shard(s) was found under ${shards}. A shard writes reports/mutation/shard-<k>-of-${count}.json ` +
          'only when its cosyte-mutate reads COSYTE_MUTATE_SHARD; each shard log says what it ran.',
      );
    }
    /** @type {string[]} */
    const lines = [];
    /** @type {[string, any][]} */
    const merged = [];
    for (const dir of [...groups.keys()].sort()) {
      const byShard = /** @type {Map<number, string>} */ (groups.get(dir));
      for (let k = 1; k <= count; k += 1) {
        if (!byShard.has(k)) throw new Refused(`${dir} has no report from shard ${k} of ${count}, so its score would be read from part of its code`);
      }
      const reports = [];
      for (let k = 1; k <= count; k += 1) {
        const file = /** @type {string} */ (byShard.get(k));
        try {
          reports.push(JSON.parse(readFileSync(path.join(shards, file), 'utf8')));
        } catch (cause) {
          throw new Unreadable(`${file} could not be read as a mutation report: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      let report;
      try {
        report = mergeReports(reports);
      } catch (cause) {
        if (cause instanceof Refused) throw new Refused(`${dir}: ${cause.message}`);
        throw cause;
      }
      merged.push([dir, report]);
      lines.push(`${dir}: ${count} shard(s), ${Object.keys(report.files).length} file(s), ${mutantCount(report)} mutant(s)`);
    }
    // Written only once every package merged, so a refusal leaves no package half-merged.
    for (const [dir, report] of merged) {
      const target = path.join(into, dir, REPORT_DIR);
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'mutation.json'), `${JSON.stringify(report)}\n`);
    }
    const notes = all.filter((file) => /^shard-\d+-of-\d+\.txt$/.test(file) && file.endsWith(`-of-${count}.txt`));
    notes.sort((a, b) => Number(/^shard-(\d+)/.exec(a)?.[1]) - Number(/^shard-(\d+)/.exec(b)?.[1]));
    const noteText = notes.map((file) => readFileSync(path.join(shards, file), 'utf8').trimEnd()).join('\n');
    mkdirSync(path.join(into, REPORT_DIR), { recursive: true });
    writeFileSync(path.join(into, REPORT_DIR, 'shards.txt'), noteText === '' ? '' : `${noteText}\n`);
    for (const line of lines) out(`${line}\n`);
    if (noteText !== '') out(`${noteText}\n`);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        ['### Mutation shards merged', '', ...lines.map((line) => `- ${line}`), '', ...(noteText === '' ? [] : ['```text', noteText, '```', '']), ''].join('\n'),
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof Refused) {
      err(`::error::${error.message}\n`);
      return 1;
    }
    if (error instanceof Unreadable) {
      err(`::error::${error.message}\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) process.exitCode = main(process.argv.slice(2));
