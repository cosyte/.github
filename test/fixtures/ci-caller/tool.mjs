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
//                 failing to pass the fixture's own text, or failing to find a planted em dash. On
//                 macOS it cannot run: it needs GNU grep's `-P`, the runner's BSD grep has none, and
//                 the checker refuses every input rather than reporting a clean one. So on macOS
//                 the verb requires that refusal, and turns red the day the checker passes there
//   phi-scan      the PHI scanner callers run (`cosyte-phi-scan`) failing to pass the fixture, or
//                 failing to find a planted, synthetic SSN shape
//   test          a run on a system other than the one the runner says it is, and a source module
//                 that does not load
//   coverage      the test verb failing; on a pass it writes the two reports the coverage ratchet
//                 reads (`coverage/coverage-summary.json` and `coverage/lcov.info`)
//   properties    a depth in `COSYTE_PROPERTY_RUNS` that is not a whole number of cases, the
//                 variable the nightly property run sets; on a pass it prints a planted failure
//                 report, in colour as vitest prints one, so the nightly run's seed recorder has a
//                 seed to find
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
const SKIPPED = new Set(["node_modules", "dist", "coverage", "reports", PLANTED]);

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

/** What a checker that runs answers: 0 on the clean input, 1 on the planted one. */
export const RUNS = { clean: 0, planted: 1 };

/** What a checker that cannot run answers when it fails closed: 1 on every input. */
export const REFUSES = { clean: 1, planted: 1 };

/** What the dash checker must answer on `platform`: it refuses on macOS, which has no GNU grep. */
export function dashExpectation(platform) {
  return platform === "darwin" ? REFUSES : RUNS;
}

/**
 * Judge a checker by two runs against what it must answer: `expected`, by default `RUNS`.
 *
 * @returns The problems, empty when both runs answered as they must.
 */
export function judge(name, cleanStatus, plantedStatus, expected = RUNS) {
  const problems = [];
  if (cleanStatus !== expected.clean) problems.push(`${name} exited ${cleanStatus} on the clean input, not ${expected.clean}`);
  if (plantedStatus !== expected.planted) {
    problems.push(`${name} exited ${plantedStatus} on the planted input, not ${expected.planted}, so its clean verdict proves nothing`);
  }
  return problems;
}

/** The seed and path of the planted failure report `properties` prints. */
export const PLANTED_REPLAY = "COSYTE_PROPERTY_SEED=20261110 COSYTE_PROPERTY_PATH=0:1";

/** The failure report the property runners print, as vitest shows it with colour on. */
export function plantedFailure() {
  const esc = String.fromCodePoint(0x1b);
  return [
    ` ${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m test/planted.test.mjs > a planted property`,
    `${esc}[31mError: a planted property: property failed after 1 case(s), shrunk 0 time(s).${esc}[39m`,
    `${esc}[31mReplay exactly: ${esc}[1m${PLANTED_REPLAY}${esc}[22m${esc}[39m`,
  ];
}

/** Write the two coverage reports a coverage run leaves, for one fully covered file. */
function writeCoverage(root) {
  const full = { total: 1, covered: 1, skipped: 0, pct: 100 };
  const total = { lines: full, branches: full, functions: full, statements: full };
  mkdirSync(join(root, "coverage"), { recursive: true });
  writeFileSync(join(root, "coverage", "coverage-summary.json"), `${JSON.stringify({ total }, null, 2)}\n`);
  writeFileSync(join(root, "coverage", "lcov.info"), "TN:\nSF:src/index.mjs\nDA:1,1\nLF:1\nLH:1\nend_of_record\n");
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
    const expected = dashExpectation(platform);
    if (expected === REFUSES) {
      log("lint: on macOS the dash checker needs GNU grep (-P), which the runner lacks, so it must refuse every input");
      log("lint: if it passes the clean input here, it now runs on macOS and this expectation is out of date");
    }
    const passed = expected === REFUSES ? "the dash checker refused on macOS rather than passing" : "the dash checker passed clean text and found a planted dash";
    return report(verb, judge("cosyte-no-emdash", clean, planted, expected), passed, log);
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
  if (verb === "coverage") {
    const tested = await run("test", context);
    if (tested !== 0) return tested;
    writeCoverage(root);
    return report(verb, [], "wrote coverage/coverage-summary.json and coverage/lcov.info", log);
  }
  if (verb === "properties") {
    const runs = env.COSYTE_PROPERTY_RUNS;
    if (runs === undefined || !/^[1-9]\d*$/.test(runs)) {
      log(`properties: COSYTE_PROPERTY_RUNS is ${JSON.stringify(runs ?? null)}, not a whole number of cases`);
      return 1;
    }
    log(`properties: ${runs} cases a property`);
    log("properties: the next lines are a planted failure report, so the nightly run's seed recorder has one to find");
    for (const line of plantedFailure()) log(line);
    return 0;
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
  log(`usage: node tool.mjs <format-check|lint|phi-scan|test|coverage|properties|build|attw>, not ${verb}`);
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const context = { root: process.cwd(), env: process.env, platform: process.platform, versions: process.versions, log: console.log };
  process.exitCode = await run(process.argv[2], context);
}
