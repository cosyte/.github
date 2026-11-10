// The scripts of the CI caller fixture: a package `self-check.yml` runs `ci.yml` against on Linux,
// Windows and macOS, and under Bun and Deno, so a change to the shared CI is proven on every system
// before any caller adopts it. It imports `node:*` only and has no build step, so the same file runs
// unchanged under Node, Bun and Deno. `test/ci-caller-fixture.test.mjs` tests it.
//
// Each verb stands in for one of a caller's own scripts, and each fails on the hazard it is there to
// catch:
//   format-check  a carriage return in any file: a Windows checkout that turned LF into CRLF, which
//                 every caller's formatter reports as a whole tree of unformatted files
//   lint          the dash checker callers run (`cosyte-no-emdash` from `@cosyte/script-utils`)
//                 failing to pass the fixture's own text, or failing to find a planted em dash
//   phi-scan      the PHI scanner callers run (`cosyte-phi-scan`) failing to pass the fixture, or
//                 failing to find a planted, synthetic SSN shape
//   test          a run on a system other than the one the runner says it is, and a source module
//                 that does not load
//   build         writes the dist/ the shared ESM and CJS smoke step loads
//   attw          a target in the package's exports map with no file behind it
//
// The planted inputs are what make a pass mean something: a checker that cannot run on a system,
// or that runs and reads nothing, passes clean text too.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/** The value of RUNNER_OS on each hosted runner, and the `process.platform` it implies. */
export const PLATFORM_OF_RUNNER = { Linux: "linux", Windows: "win32", macOS: "darwin" };

/** Where the planted inputs are written, ignored by git and by every check here. */
export const PLANTED = ".planted";

/** Directories a check never reads: what an install, a build or a plant writes. */
const SKIPPED = new Set(["node_modules", "dist", PLANTED]);

/** Every file under `dir`, recursively, as paths relative to `root` with forward slashes. */
export function filesUnder(root, dir = root) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(root, path));
    else found.push(relative(root, path).split("\\").join("/"));
  }
  return found.sort();
}

/** The files under `root` holding a carriage return. */
export function carriageReturns(root) {
  return filesUnder(root).filter((file) => readFileSync(join(root, file)).includes(13));
}

/** The name and version of the runtime executing this file. */
export function runtimeOf(versions) {
  if (versions.bun) return `bun ${versions.bun}`;
  if (versions.deno) return `deno ${versions.deno}`;
  return `node ${versions.node}`;
}

/** Why the runner and the platform disagree, or null when they agree or no runner is named. */
export function platformProblem(runnerOs, platform) {
  if (runnerOs === undefined) return null;
  const expected = PLATFORM_OF_RUNNER[runnerOs];
  if (expected === undefined) return `RUNNER_OS is ${runnerOs}, which this fixture does not know`;
  if (expected !== platform) return `RUNNER_OS is ${runnerOs} but process.platform is ${platform}`;
  return null;
}

/** The export targets of `manifest` with no file under `root`. */
export function missingTargets(root, manifest) {
  return Object.values(manifest.exports["."]).filter((target) => !existsSync(join(root, target)));
}

/** Run one of `@cosyte/script-utils`' bins from `binDir` with this runtime, and return its exit status. */
export function runChecker(binDir, root, name, args, input) {
  const result = spawnSync(process.execPath, [join(binDir, `${name}.js`), ...args], {
    cwd: root,
    input: input ?? "",
    stdio: ["pipe", "inherit", "inherit"],
  });
  return result.status;
}

/**
 * Judge a checker by two runs: the clean input must pass (0) and the planted one must be found (1).
 *
 * @returns The problems, empty when both runs answered as they must.
 */
export function judge(name, cleanStatus, plantedStatus) {
  const problems = [];
  if (cleanStatus !== 0) problems.push(`${name} exited ${cleanStatus} on the clean input, not 0`);
  if (plantedStatus !== 1) {
    problems.push(`${name} exited ${plantedStatus} on the planted input, not 1, so its clean verdict proves nothing`);
  }
  return problems;
}

/** Load the fixture's source module. */
async function loadSource(root) {
  return import(pathToFileURL(join(root, "src", "index.mjs")).href);
}

/** Print each problem and turn the list into an exit code. */
function report(verb, problems, passed, log) {
  for (const problem of problems) log(`${verb}: ${problem}`);
  if (problems.length > 0) return 1;
  log(`${verb}: ${passed}`);
  return 0;
}

/**
 * Run one verb against the fixture at `root`.
 *
 * @returns 0 when the verb passed, 1 when it found something, 2 for a verb it does not know.
 */
export async function run(verb, context) {
  const { root, env, platform, versions, log } = context;
  const binDir = context.binDir ?? join(root, "node_modules", "@cosyte", "script-utils", "bin");
  if (verb === "format-check") {
    const found = carriageReturns(root).map((file) => `${file} holds a carriage return`);
    return report(verb, found, `${filesUnder(root).length} files, LF line endings only`, log);
  }
  if (verb === "lint") {
    const text = filesUnder(root).map((file) => readFileSync(join(root, file), "utf8")).join("\n");
    const clean = runChecker(binDir, root, "cosyte-no-emdash", ["--stdin", "the fixture's files"], text);
    log("lint: the next run is fed a planted em dash, and must find it");
    const dash = String.fromCodePoint(0x2014);
    const planted = runChecker(binDir, root, "cosyte-no-emdash", ["--stdin", "a planted dash"], `a ${dash} b\n`);
    return report(verb, judge("cosyte-no-emdash", clean, planted), "the dash checker passed clean text and found a planted dash", log);
  }
  if (verb === "phi-scan") {
    const clean = runChecker(binDir, root, "cosyte-phi-scan", []);
    log("phi-scan: the next run reads a planted, synthetic SSN shape, and must find it");
    const dir = join(root, PLANTED);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phi.txt"), `synthetic ${["123", "45", "6789"].join("-")}\n`);
    let planted;
    try {
      planted = runChecker(binDir, root, "cosyte-phi-scan", [`${PLANTED}/phi.txt`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return report(verb, judge("cosyte-phi-scan", clean, planted), "the PHI scanner passed the fixture and found a planted SSN shape", log);
  }
  if (verb === "test") {
    log(`test: running under ${runtimeOf(versions)} on ${platform}`);
    const problem = platformProblem(env.RUNNER_OS, platform);
    const problems = problem === null ? [] : [problem];
    const source = await loadSource(root);
    if (source.greeting !== "hello from the CI caller fixture") problems.push("src/index.mjs did not export the greeting");
    return report(verb, problems, "passed", log);
  }
  if (verb === "build") {
    const source = await loadSource(root);
    mkdirSync(join(root, "dist"), { recursive: true });
    copyFileSync(join(root, "src", "index.mjs"), join(root, "dist", "index.mjs"));
    copyFileSync(join(root, "src", "index.d.ts"), join(root, "dist", "index.d.ts"));
    writeFileSync(join(root, "dist", "index.cjs"), `"use strict";\nmodule.exports = ${JSON.stringify({ ...source })};\n`);
    return report(verb, [], "wrote dist/index.mjs, dist/index.cjs and dist/index.d.ts", log);
  }
  if (verb === "attw") {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const missing = missingTargets(root, manifest).map((target) => `${target} is in the exports map but not on disk`);
    return report(verb, missing, "every export target is on disk", log);
  }
  log(`usage: node tool.mjs <format-check|lint|phi-scan|test|build|attw>, not ${verb}`);
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const context = { root: process.cwd(), env: process.env, platform: process.platform, versions: process.versions, log: console.log };
  process.exitCode = await run(process.argv[2], context);
}
