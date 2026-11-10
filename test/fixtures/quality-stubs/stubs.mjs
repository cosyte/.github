// Stand-ins for `cosyte-mutate` (from `@cosyte/vitest-config`) and `cosyte-ratchet` (from
// `@cosyte/script-utils`). The fixture under `test/fixtures/ci-caller/` installs them, so
// `self-check.yml` can run the testing standard's jobs on a real runner before the real tools are on
// npm. They mutate, measure and judge nothing. `test/quality-stubs.test.mjs` tests them.
//
// `cosyte-mutate full` also reads the two variables `weekly-mutation.yml` sets for a sharded run,
// COSYTE_MUTATE_SHARD and COSYTE_MUTATE_INCREMENTAL_FILE: the contract that workflow asks of the real
// tool. With a shard it writes `reports/mutation/shard-<k>-of-<n>.json` for its share of `src/*.mjs`.
//
// Each accepts exactly the command lines the real tool accepts for the calls the shared jobs make,
// and refuses the rest with exit 2, as the real one does. Each checks what a job must have done
// before it ran: that the base ref has a merge base with HEAD (the checkout fetched the history),
// and that the reports the real tool would read are on disk (the steps ran in order, in one
// directory). `raise` is refused outright: no shared job may move a floor.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** An empty StrykerJS report: what a run over no file leaves. */
const EMPTY_REPORT = `${JSON.stringify({ schemaVersion: "2", thresholds: { high: 80, low: 60 }, files: {} })}\n`;

/** The source files a sharded stand-in run shares out: every `.mjs` file under `src/`. */
function sourceFiles(cwd, dir = join(cwd, "src")) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(cwd, path));
    else if (entry.name.endsWith(".mjs")) found.push(relative(cwd, path).split(sep).join("/"));
  }
  return found.sort();
}

/** FNV-1a over a path: the shard a file belongs to stays the same from run to run. */
function hashOf(text) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The shard named in COSYTE_MUTATE_SHARD (`<k>/<n>`), or null when it is unset. This is the contract
 * `weekly-mutation.yml` hands a sharding `cosyte-mutate`.
 */
function shardOf(value) {
  if (value === undefined || value === "") return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const [k, n] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (!match || n < 1 || k < 1 || k > n) throw new Refused(`COSYTE_MUTATE_SHARD must be <k>/<n> with 1 <= k <= n, not ${JSON.stringify(value)}`);
  return { k, n };
}

/** Thrown for a command line or an input the real tool would refuse. Exit 2. */
class Refused extends Error {}

/** Read `--flag value` pairs, allowing only `allowed`; `--skip` may repeat. */
function flags(rest, allowed) {
  const out = { skip: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (!allowed.includes(flag)) throw new Refused(`unknown argument ${JSON.stringify(flag)}`);
    if (value === undefined || value.startsWith("--")) throw new Refused(`${flag} needs a value`);
    if (flag === "--skip") out.skip.push(value);
    else out[flag.slice(2)] = value;
  }
  return out;
}

/** The merge base of `base` and HEAD, or a refusal naming the base. */
function mergeBase(base, cwd) {
  const result = spawnSync("git", ["merge-base", base, "HEAD"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Refused(`no merge base between ${base} and HEAD: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** A file the real tool would read, or a refusal naming it. */
function needs(cwd, file, log) {
  if (!existsSync(join(cwd, file))) throw new Refused(`${file} is missing`);
  log(`  read ${file}`);
}

/** Run a stand-in, turning a refusal into exit 2 on stderr. */
function guarded(name, body, io) {
  try {
    return body();
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    io.err(`${name} (a stand-in): could not run: ${error.message}`);
    return 2;
  }
}

/**
 * `cosyte-mutate full` or `cosyte-mutate changed --base <ref>`, each with an optional `--config`.
 *
 * @returns {number} The exit code.
 */
export function mutate(argv, io) {
  return guarded("cosyte-mutate", () => {
    const [mode, ...rest] = argv;
    if (mode !== "full" && mode !== "changed") throw new Refused(`the mode must be full or changed, not ${JSON.stringify(mode)}`);
    const options = flags(rest, ["--base", "--config"]);
    if (mode === "changed" && options.base === undefined) throw new Refused("changed needs --base <ref>");
    if (mode === "full" && options.base !== undefined) throw new Refused("full takes no --base");
    const dir = join(io.cwd, "reports", "mutation");
    const shard = mode === "full" ? shardOf(io.env.COSYTE_MUTATE_SHARD) : null;
    if (mode === "changed") {
      const base = mergeBase(options.base, io.cwd);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "changed.json"), EMPTY_REPORT);
      io.log(`cosyte-mutate changed (a stand-in): against ${options.base}, merge base ${base.slice(0, 12)}; it mutates nothing`);
    } else if (shard === null) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mutation.json"), EMPTY_REPORT);
      io.log("cosyte-mutate full (a stand-in): wrote an empty reports/mutation/mutation.json; it mutates nothing");
    } else {
      // One killed mutant a file, for each file in this shard: enough for a merge and a score.
      const mine = sourceFiles(io.cwd).filter((file) => hashOf(file) % shard.n === shard.k - 1);
      const files = Object.fromEntries(
        mine.map((file) => [file, { language: "javascript", source: "", mutants: [{ id: file, mutatorName: "stand-in", status: "Killed", location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }] }]),
      );
      const report = `${JSON.stringify({ schemaVersion: "2", thresholds: { high: 80, low: 60 }, files })}\n`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `shard-${shard.k}-of-${shard.n}.json`), report);
      io.log(`cosyte-mutate full (a stand-in): shard ${shard.k} of ${shard.n}, ${mine.length} file(s); it mutates nothing`);
      const incremental = io.env.COSYTE_MUTATE_INCREMENTAL_FILE;
      if (incremental !== undefined && incremental !== "") {
        const at = join(io.cwd, incremental);
        if (existsSync(at)) {
          const earlier = Object.keys(JSON.parse(readFileSync(at, "utf8")).files ?? {}).length;
          io.log(`  incremental: read ${earlier} earlier result(s) from ${incremental}`);
        } else {
          io.log(`  incremental: no earlier results at ${incremental}`);
        }
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, report);
      }
    }
    return 0;
  }, io);
}

/**
 * `cosyte-ratchet check [--floor <file>] [--base <ref>] [--skip coverage|mutation]...`.
 *
 * @returns {number} The exit code.
 */
export function ratchet(argv, io) {
  return guarded("cosyte-ratchet", () => {
    const [command, ...rest] = argv;
    if (command === "raise") throw new Refused("no shared job may raise a floor; raising one is a pull request");
    if (command !== "check") throw new Refused(`the command must be check, not ${JSON.stringify(command)}`);
    const options = flags(rest, ["--floor", "--base", "--skip"]);
    for (const kind of options.skip) {
      if (kind !== "coverage" && kind !== "mutation") throw new Refused(`--skip takes coverage or mutation, not ${JSON.stringify(kind)}`);
    }
    const floorFile = options.floor ?? "quality-floor.json";
    if (!existsSync(join(io.cwd, floorFile))) throw new Refused(`${floorFile} is missing`);
    const lines = [];
    const log = (line) => lines.push(line);
    if (options.base !== undefined) log(`  base ${options.base}, merge base ${mergeBase(options.base, io.cwd).slice(0, 12)}`);
    if (!options.skip.includes("coverage")) needs(io.cwd, "coverage/coverage-summary.json", log);
    if (!options.skip.includes("mutation")) {
      needs(io.cwd, options.base === undefined ? "reports/mutation/mutation.json" : "reports/mutation/changed.json", log);
    }
    io.log(`cosyte-ratchet check (a stand-in): ${floorFile}, 1 package(s); it judges nothing`);
    for (const line of lines) io.log(line);
    io.log("cosyte-ratchet: OK (a stand-in, which compares nothing with its floor)");
    return 0;
  }, io);
}

/** What a bin passes: its own directory and streams. */
export function processIo() {
  return { cwd: process.cwd(), env: process.env, log: (line) => console.log(line), err: (line) => console.error(line) };
}
