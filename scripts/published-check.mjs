#!/usr/bin/env node
// @ts-check
//
// THE SCHEDULED CHECK OF THE PUBLISHED PACKAGE: WHAT USERS INSTALL, ON THE DAYS BETWEEN RELEASES.
//
// `install-check.mjs` asks the consumer's question once per release, straight after the publish, and
// nothing asks it again until the next release. The answer can change without one: a dependency
// publishes a broken version inside a range we declare, a Node patch release changes how something
// loads, a dist-tag moves. `ci.yml`'s `published` job runs this on the caller's `schedule` and
// `workflow_dispatch` events only, against whatever `latest` is that day:
//
//   1. read the caller's own package name from its root `package.json`;
//   2. in a clean room outside the workspace, `npm install <name>@latest` as an anonymous user;
//   3. load every entry point BY NAME from the clean room, once with `import` and once with
//      `require`, each in its own process, the way a consumer's program is one or the other;
//   4. run the caller's synthetic smoke sample there, when the caller names one.
//
// Any of those failing exits 1, and the red run lands in the caller's repository, which is the one
// place a fix can be made.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// FAIL CLOSED, AND WHY THAT IS NOT `install-check.mjs`'s RULE.
//
// The post-publish gate fails open on anything it cannot explain, because a red there misreports a
// permanent release a moment after it happened and invites a re-run of the job that published it.
// Neither holds here. Nothing is published by this job, the version under test has been on the
// registry for at least a day, so there is no propagation to wait out, and a red run is the finding
// itself: the package as users get it today does not work. A registry that does not answer is red
// too. npm retries a transient fault itself before giving up (`fetch-retries`, default 2), and the
// log carries npm's own error code, so a red run that is weather reads as weather.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// AN ENTRY POINT THAT IS NOT JAVASCRIPT IS RESOLVED, NOT PARSED.
//
// A config package publishes JSON: `@cosyte/prettier-config` exports `./index.json`, and
// `@cosyte/tsconfig` exports only `./base.json` and `./library.json`, with no `.` at all. `import`
// of a JSON file throws `ERR_IMPORT_ATTRIBUTE_MISSING` without `with { type: "json" }`, and the
// consumer of such a file is a tool reading a path, not a module loader. So each arm RESOLVES the
// entry (`import.meta.resolve`, `require.resolve`), confirms the file is there, and LOADS it only
// when it is a `.js`, `.mjs` or `.cjs` file. A package with no `.` export has each of its exported
// subpaths resolved instead, which is how `@cosyte/tsconfig` is consumed (`extends:
// "@cosyte/tsconfig/library.json"`).
//
// `import.meta.resolve` DOES NOT CHECK THAT THE FILE EXISTS. Measured on Node 24.22.0: an export
// map entry pointing at a missing `./dist/index.mjs` resolves to a URL without complaint, where
// `require.resolve` throws `MODULE_NOT_FOUND`. So the ESM arm stats what it resolved, and a
// resolved-but-missing JSON entry is a failure on both arms rather than on one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLEAN MEANS WHAT `install-check.mjs` SAYS IT MEANS, AND THE CODE IS ITS CODE.
//
// The clean room, the anonymous npm environment, `--ignore-scripts` and the allow-listed environment
// the probe children run in are all imported from `install-check.mjs` rather than restated, so the
// two checks of the published package cannot drift apart. The reasons for each are written down
// there. This file adds one guard of its own: the clean room must not sit inside the caller's
// checkout, because Node's resolver walks upward from the importing file and would find anything
// installed above it.

import { realpathSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_REGISTRY,
  installIntoCleanRoom,
  makeCleanRoom,
  parseArgs,
  probeChildEnv,
  runCommand,
} from "./install-check.mjs";

/** Per arm. The same bound `install-check.mjs` gives each of its entry probes. */
export const PROBE_TIMEOUT_MS = 60_000;

/** The caller's sample is code we did not write, doing real work, so it gets twice that. */
export const SAMPLE_TIMEOUT_MS = 120_000;

/** What Node runs as JavaScript without a loader or a flag on every supported line. */
export const SAMPLE_EXTENSIONS = Object.freeze([".mjs", ".cjs", ".js"]);

/**
 * The probes and the copied sample are written into the clean room under these CONSTANT names and
 * run by name with the clean room as `cwd`. The clean room's absolute path comes from `RUNNER_TEMP`
 * or the command line, and a path built from it is not handed to a child process as an argument.
 */
export const PROBE_FILES = Object.freeze({ esm: "published-probe.mjs", cjs: "published-probe.cjs" });
export const SAMPLE_FILES = Object.freeze({ ".mjs": "smoke-sample.mjs", ".cjs": "smoke-sample.cjs", ".js": "smoke-sample.js" });

/** The prefix a probe line carries, so module-init output on stdout is never read as a report. */
export const PROBE_MARK = "@@published-check ";

// ── The caller ──────────────────────────────────────────────────────────────────────────────────

/**
 * The caller's own package name, or the reason there is nothing to test.
 *
 * @param {unknown} manifest the caller's parsed root `package.json`
 * @returns {{ name: string } | { error: string }}
 */
export function publishedName(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { error: "the root package.json is not a JSON object" };
  }
  const m = /** @type {Record<string, unknown>} */ (manifest);
  if (m.private === true) {
    return { error: 'the root package.json is "private": true, so there is no published package to test' };
  }
  if (typeof m.name !== "string" || m.name.trim() === "") {
    return { error: "the root package.json names no package" };
  }
  return { name: m.name };
}

/**
 * Where the caller's sample is, or why it cannot be run. Checked before anything touches the
 * network: a misnamed sample is the caller's typo, deterministic, and one line to fix.
 *
 * @param {string} repo
 * @param {string | undefined} sample
 * @returns {Promise<{ file: string | null } | { error: string }>}
 */
export async function locateSample(repo, sample) {
  if (sample === undefined || sample.trim() === "") return { file: null };
  const file = path.resolve(repo, sample);
  const ext = path.extname(file);
  if (!SAMPLE_EXTENSIONS.includes(ext)) {
    return { error: `the smoke sample "${sample}" is not a ${SAMPLE_EXTENSIONS.join(", ")} file` };
  }
  try {
    if (!(await stat(file)).isFile()) return { error: `the smoke sample "${sample}" is not a file` };
  } catch {
    return { error: `the smoke sample "${sample}" does not exist in the caller's checkout` };
  }
  return { file };
}

// ── What to load ────────────────────────────────────────────────────────────────────────────────

/**
 * The specifiers a consumer writes for this package: the bare name when the package exports `.`,
 * otherwise every subpath it exports. Patterns (`./*`) name no single file and `./package.json` is
 * metadata, so neither is probed; a `null` target is a deliberate block, not an entry point.
 *
 * Falls back to the bare name when nothing else is left, so a package that exports nothing usable
 * fails on Node's own `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than passing on an empty list.
 *
 * @param {Record<string, any>} manifest the INSTALLED manifest
 * @returns {string[]}
 */
export function entrySpecifiers(manifest) {
  const name = String(manifest?.name ?? "");
  const exp = manifest?.exports;
  if (!exp || typeof exp !== "object" || Array.isArray(exp)) return [name];
  const keys = Object.keys(exp);
  if (!keys.some((key) => key.startsWith("."))) return [name];
  if (Object.hasOwn(exp, ".") && exp["."] !== null) return [name];
  const subpaths = keys
    .filter((key) => key.startsWith("./") && key !== "./package.json" && !key.includes("*") && exp[key] !== null)
    .map((key) => `${name}/${key.slice(2)}`);
  return subpaths.length > 0 ? subpaths : [name];
}

// ── The probes ──────────────────────────────────────────────────────────────────────────────────
//
// NEITHER FUNCTION BELOW IS EVER CALLED IN THIS PROCESS. Each one's source is written into the clean
// room and run there by `process.execPath`, so `import.meta`, `import()`, `require` and
// `require.resolve` are the CLEAN ROOM's and resolve from its `node_modules`, the way a consumer's
// do. That is also why each imports what it needs inside its own body: a closure over this module
// would not survive being turned into text.
//
// Each reports one marked JSON line per specifier, and exits 0 even when an entry fails, so that a
// failure on one specifier does not hide the verdict on the next. A specifier with no report (the
// module's own init killed the process, say) is a failure the parent names.

/** @param {string[]} specs */
export async function esmProbe(specs) {
  const { statSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const MARK = "@@published-check ";
  const report = (spec, outcome, detail) =>
    process.stdout.write(`${MARK}${JSON.stringify({ arm: "esm", spec, outcome, detail })}\n`);
  for (const spec of specs) {
    try {
      const file = fileURLToPath(import.meta.resolve(spec));
      if (!statSync(file).isFile()) throw new Error(`resolves to ${file}, which is not a file`);
      if (/\.(?:mjs|cjs|js)$/.test(file)) {
        await import(spec);
        report(spec, "loaded", file);
      } else {
        report(spec, "resolved", file);
      }
    } catch (error) {
      const code = error && error.code ? `${error.code}: ` : "";
      report(spec, "failed", `${code}${String((error && error.message) || error).split("\n")[0]}`);
    }
  }
}

/** @param {string[]} specs */
export function cjsProbe(specs) {
  const { statSync } = require("node:fs");
  const MARK = "@@published-check ";
  const report = (spec, outcome, detail) =>
    process.stdout.write(`${MARK}${JSON.stringify({ arm: "cjs", spec, outcome, detail })}\n`);
  for (const spec of specs) {
    try {
      const file = require.resolve(spec);
      if (!statSync(file).isFile()) throw new Error(`resolves to ${file}, which is not a file`);
      if (/\.(?:mjs|cjs|js)$/.test(file)) {
        require(spec);
        report(spec, "loaded", file);
      } else {
        report(spec, "resolved", file);
      }
    } catch (error) {
      const code = error && error.code ? `${error.code}: ` : "";
      report(spec, "failed", `${code}${String((error && error.message) || error).split("\n")[0]}`);
    }
  }
}

/**
 * Read a probe's stdout into one check per specifier. Unmarked lines are the package's own output
 * and are ignored; a specifier the probe never reported on is a failure, never a silent pass.
 *
 * @param {"esm" | "cjs"} arm
 * @param {string[]} specs
 * @param {{ code: number | null, out: string, err: string }} result
 * @returns {Check[]}
 */
export function readProbe(arm, specs, result) {
  /** @type {Map<string, { outcome: string, detail: string }>} */
  const seen = new Map();
  for (const line of String(result.out).split("\n")) {
    if (!line.startsWith(PROBE_MARK)) continue;
    try {
      const entry = JSON.parse(line.slice(PROBE_MARK.length));
      if (entry && entry.arm === arm && typeof entry.spec === "string") seen.set(entry.spec, entry);
    } catch {
      // A torn line is no report, which the loop below turns into a failure.
    }
  }
  const verb = arm === "esm" ? "import" : "require";
  return specs.map((spec) => {
    const entry = seen.get(spec);
    if (!entry) {
      return {
        label: `${verb} ${spec}`,
        ok: false,
        detail: `the ${arm} probe exited ${result.code} without reporting on it: ${firstLine(result.err)}`,
      };
    }
    if (entry.outcome === "loaded") return { label: `${verb} ${spec}`, ok: true, detail: "loaded" };
    if (entry.outcome === "resolved") {
      return { label: `${verb} ${spec}`, ok: true, detail: `resolved to ${path.basename(entry.detail)}, not parsed` };
    }
    return { label: `${verb} ${spec}`, ok: false, detail: String(entry.detail) };
  });
}

/**
 * Write both probes into the clean room and run each, in its own process, over `specs`. One check
 * per specifier per arm, ESM first.
 *
 * @param {{ room: string, specs: string[], env: Record<string, string> }} options
 * @returns {Promise<Check[]>}
 */
export async function probeEntries({ room, specs, env }) {
  /** @type {Check[]} */
  const checks = [];
  for (const [arm, fn] of /** @type {const} */ ([
    ["esm", esmProbe],
    ["cjs", cjsProbe],
  ])) {
    const call = arm === "esm" ? `await ${fn.name}(process.argv.slice(2));` : `${fn.name}(process.argv.slice(2));`;
    await writeFile(path.join(room, PROBE_FILES[arm]), `${fn.toString()}\n${call}\n`);
    const run = await runCommand(process.execPath, [PROBE_FILES[arm], ...specs], {
      cwd: room,
      env,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    checks.push(...readProbe(arm, specs, run));
  }
  return checks;
}

const firstLine = (s) =>
  String(s || "")
    .trim()
    .split("\n")
    .find((l) => l.trim()) || "(no output)";

/** The last lines of npm's output, which is where it says why. */
const tail = (s, lines = 15) => String(s || "").trim().split("\n").slice(-lines).join("\n");

/**
 * npm's own reason for a failed install, in one line: its error code and the first line that says
 * something, so the annotation on a red run reads `E404 ...` or `ETIMEDOUT ...` rather than `exit 1`.
 * That is the difference between a missing package and a registry that did not answer, and it is the
 * first thing whoever picks up the red run needs.
 *
 * @param {string} output
 */
export function npmReason(output) {
  const lines = String(output || "")
    .split("\n")
    .map((line) => line.trim());
  const code = lines.map((line) => /^npm (?:error|ERR!) code (\S+)/.exec(line)).find(Boolean)?.[1];
  const said = lines.find(
    (line) => /^npm (?:error|ERR!) \S+ \S/.test(line) && !/^npm (?:error|ERR!) code /.test(line),
  );
  const reason = said ? said.replace(/^npm (?:error|ERR!) /, "") : firstLine(output);
  return code && !reason.startsWith(code) ? `${code} ${reason}` : reason;
}

// ── The check ───────────────────────────────────────────────────────────────────────────────────

/** @typedef {{ label: string, ok: boolean, detail: string }} Check */

/**
 * The whole check. Resolves, never rejects for anything a package can do; the CLI below turns an
 * unexpected throw into a red run.
 *
 * @param {{
 *   repo: string,
 *   sample?: string,
 *   registry?: string,
 *   tempParent?: string,
 *   npmBin?: string,
 *   installTimeoutMs?: number,
 *   log?: (line: string) => void,
 * }} options
 */
export async function runPublishedCheck({
  repo,
  sample,
  registry = DEFAULT_REGISTRY,
  tempParent = tmpdir(),
  npmBin = "npm",
  installTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  log = () => {},
}) {
  /** @type {Check[]} */
  const checks = [];
  const result = (name = null, version = null) => ({
    ok: checks.length > 0 && checks.every((c) => c.ok),
    name,
    version,
    sample: sample || null,
    checks,
  });
  const record = (/** @type {Check} */ check) => {
    checks.push(check);
    log(`${check.ok ? "ok  " : "FAIL"}  ${check.label}: ${check.detail}`);
  };

  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
  } catch (error) {
    record({ label: "caller package.json", ok: false, detail: `cannot be read: ${firstLine(error?.message)}` });
    return result();
  }
  const named = publishedName(manifest);
  if ("error" in named) {
    record({ label: "caller package.json", ok: false, detail: named.error });
    return result();
  }
  const { name } = named;

  const located = await locateSample(repo, sample);
  if ("error" in located) {
    record({ label: "smoke sample", ok: false, detail: located.error });
    return result(name);
  }

  const room = await makeCleanRoom(tempParent);
  try {
    const inside = path.relative(path.resolve(repo), room);
    if (inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside))) {
      record({
        label: "clean room",
        ok: false,
        detail: `${room} is inside the caller's checkout, where the resolver would find the workspace's own modules`,
      });
      return result(name);
    }

    const install = await installIntoCleanRoom({
      dir: room,
      name,
      version: "latest",
      registry,
      npmBin,
      timeoutMs: installTimeoutMs,
    });
    if (!install.ok) {
      record({
        label: `npm install ${name}@latest`,
        ok: false,
        detail: `${npmReason(install.output)} (exit ${install.code})\n${tail(install.output)}`,
      });
      return result(name);
    }

    /** @type {Record<string, any>} */
    let installed;
    try {
      installed = JSON.parse(
        await readFile(path.join(room, "node_modules", ...name.split("/"), "package.json"), "utf8"),
      );
    } catch (error) {
      record({
        label: `npm install ${name}@latest`,
        ok: false,
        detail: `npm reported success but ${name} is not readable in the install tree: ${firstLine(error?.message)}`,
      });
      return result(name);
    }
    const version = typeof installed.version === "string" ? installed.version : null;
    record({ label: `npm install ${name}@latest`, ok: true, detail: `installed ${version ?? "an unversioned manifest"}` });

    // The probe children get `install-check.mjs`'s allow-listed environment, with `~` inside the
    // clean room. That directory has to exist before anything runs with HOME pointing at it.
    const env = probeChildEnv(room);
    await mkdir(path.join(room, "probe-home"), { recursive: true });

    for (const check of await probeEntries({ room, specs: entrySpecifiers(installed), env })) record(check);

    if (located.file) {
      // Copied INTO the clean room, so the sample's own `import "<name>"` resolves from the clean
      // room's `node_modules` and from nowhere in the caller's checkout. Its extension is kept,
      // because the extension is what tells Node whether it is ESM or CommonJS. `locateSample` has
      // already refused any extension `SAMPLE_FILES` does not name.
      const copy = SAMPLE_FILES[/** @type {keyof typeof SAMPLE_FILES} */ (path.extname(located.file))];
      await copyFile(located.file, path.join(room, copy));
      const run = await runCommand(process.execPath, [copy], { cwd: room, env, timeoutMs: SAMPLE_TIMEOUT_MS });
      record({
        label: `smoke sample ${sample}`,
        ok: run.code === 0,
        detail: run.code === 0 ? "exited 0" : `exited ${run.code}\n${tail(`${run.out}\n${run.err}`)}`,
      });
    }
    return result(name, version);
  } finally {
    await rm(room, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────────────────────────

/** One line, for the `::error` annotation on a red run; null on a green one. */
export function renderAnnotation(result) {
  if (result.ok) return null;
  const failed = result.checks.filter((c) => !c.ok);
  const subject = result.name ? `${result.name}@${result.version ?? "latest"}` : "the published package";
  const first = failed[0] ? `${failed[0].label}: ${firstLine(failed[0].detail)}` : "nothing was checked";
  const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : "";
  return `::error title=Published package check failed::${subject} as users install it: ${first}${more}`.replace(
    /\r?\n/g,
    " ",
  );
}

/** The step summary: what was tested, and the verdict on each part of it. */
export function renderSummary(result) {
  const subject = result.name ? `\`${result.name}@${result.version ?? "latest"}\`` : "the published package";
  const lines = [
    `### Published package check: ${result.ok ? "pass" : "FAIL"}`,
    "",
    `${subject}, installed from the registry into a clean directory as an anonymous user, on Node ${process.versions.node}.`,
    result.sample ? `Smoke sample: \`${result.sample}\`.` : "No smoke sample named, so the check is the install and the imports.",
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...result.checks.map(
      (c) => `| ${escapeCell(c.label)} | ${c.ok ? "ok" : "**FAIL**"} | ${escapeCell(firstLine(c.detail))} |`,
    ),
  ];
  return lines.join("\n");
}

// Backslashes first, so a `\|` already in the text cannot turn the escape below into a cell boundary.
const escapeCell = (s) =>
  String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.repo) {
    process.stderr.write("usage: published-check.mjs --repo <dir> [--sample <file>] [--registry URL] [--summary FILE]\n");
    return 2;
  }
  const result = await runPublishedCheck({
    repo: path.resolve(args.repo),
    // `--sample ""` arrives as an empty string from an unset workflow input, which means "none".
    sample: args.sample === "true" ? undefined : args.sample,
    registry: args.registry || DEFAULT_REGISTRY,
    tempParent: args["temp-parent"] || process.env.RUNNER_TEMP || tmpdir(),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  process.stdout.write(`\nverdict: ${result.ok ? "pass" : "fail"}\n`);
  const annotation = renderAnnotation(result);
  if (annotation) process.stdout.write(`${annotation}\n`);
  const summaryFile = args.summary || process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) await appendFile(summaryFile, `${renderSummary(result)}\n`).catch(() => {});
  return result.ok ? 0 : 1;
}

// FAIL CLOSED ON A CRASH, the opposite of `install-check.mjs` and for the reason the header gives:
// nothing irreversible is reported on here, and a check that swallowed its own crash would be a
// green nightly over nothing tested.
//
// REAL PATHS ON BOTH SIDES. Node gives `import.meta.url` the real path of the main module, and
// `process.argv[1]` is the path as typed, so comparing the two raw reads a script run through a
// symlinked directory as "not the entry point": `main` never runs, and the step exits 0 having
// checked nothing. Measured building this file's tests, which first ran it through a symlink.
const isEntryPoint = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntryPoint) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stdout.write(
        `::error title=Published package check did not complete::${firstLine(error?.stack || error)}\n`,
      );
      process.exitCode = 1;
    });
}
