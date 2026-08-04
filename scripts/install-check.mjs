#!/usr/bin/env node
// @ts-check
//
// THE POST-PUBLISH INSTALL GATE.
//
// Every other gate in this pipeline reads the WORKING TREE. `ci.yml` typechecks, lints, tests and
// builds the checkout, and smokes `dist/index.mjs` and `dist/index.cjs` from inside the repo, where
// the monorepo's own resolution is in scope and every sibling is a directory on disk. `release.yml`
// adds `attw` over a `npm pack` tarball. Not one of them ever asks the question a consumer asks:
// take the name and the version, from the registry, in a directory that knows nothing, and install.
//
// A manifest can be valid locally and meaningless remotely, and this org has shipped that three
// times. All three are reproduced as fixtures in `test/install-check.test.mjs`, measured against the
// live registry on 2026-08-04:
//
//   @cosyte/cli 0.0.1 and 0.0.2   published with FOUR `file:vendor/*.tgz` dependency specifiers plus
//                                 six more in optionalDependencies. Local paths that do not exist
//                                 inside the published tarball. `npm install @cosyte/cli@0.0.1`
//                                 dies ENOENT on `node_modules/@cosyte/cli/vendor/cosyte-fhir-0.0.0.tgz`.
//                                 Both versions are permanent and stay broken forever (ADR 0001).
//   @cosyte/transform 0.0.5       E404. A non-optional peer on `@cosyte/fhir`, which is not on the
//                                 registry (FHIR-NPM-NAME).
//   @cosyte/synth 0.0.6           ERESOLVE on the same peer, and note that synth marks it OPTIONAL
//                                 in peerDependenciesMeta. An optional peer whose PACKUMENT 404s
//                                 still fails the tree. Optionality is not protection.
//
// All three are on the registry today advertising themselves as installable.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS EXITS NON-ZERO FOR, AND WHY THAT IS NOT THE DISPATCH PRECEDENT
//
// One line up in `release.yml`, the docs dispatch was deliberately changed to WARN instead of fail,
// "because by then npm has published permanently and the release exists, so a red conclusion
// misreports the artifact and invites a re-run of a job that already published". That reasoning is
// right and it does not reach this gate. Three reasons, and the first is the one that matters:
//
//   1. THE DISPATCH FAILING MEANT THE ARTIFACT WAS FINE AND A NOTIFICATION WAS NOT. A positive
//      finding HERE means the artifact itself is defective: a published package no one can install.
//      A red conclusion is then the most accurate statement available about that release, not a
//      misreport of it. The two cases sit on opposite sides of the single axis the precedent turns
//      on.
//   2. THE DISPATCH HAD A BACKSTOP AND THIS HAS NONE. `cosyte/docs` rebuilds on any push to its
//      main and its prebuild re-reads every package's latest release, so one later rebuild covers
//      every missed dispatch. Nothing anywhere re-checks installability. That is the whole premise
//      of this gate: `@cosyte/cli@0.0.1` was found by a human doing an unrelated README sweep days
//      later, and `0.0.2` shipped carrying the identical defect in the meantime.
//   3. "INVITES A RE-RUN OF A JOB THAT ALREADY PUBLISHED" is structurally absent here, twice over.
//      By the time this runs the release step has created the `v<version>` tag on the remote, so a
//      re-run's `release-notes.mjs prepare` classifies the commit `already-released`, sets
//      `is-release=false`, and the publish command is withheld. And independently of that,
//      `changeset publish` queries npm and skips a version already on the registry. A re-run cannot
//      double-publish.
//
// THE STICKY-ISSUE ROUTE WAS THE PREFERRED DESIGN AND IS NOT AVAILABLE. Opening an issue needs
// `issues: write`, and a called workflow's token can only be equal to or more restrictive than the
// caller's. Every caller of `release.yml` pins exactly `contents` + `id-token` + `pull-requests`,
// against a repo default of `contents: read`. Adding `issues: write` here would be an escalation and
// GitHub rejects the whole workflow at startup, one second, no jobs, no logs, for all thirteen
// callers at once. So the menu is exactly {warn, fail}, and a warning on a green run notifies
// nobody. `release.yml` already writes that residual down for the dispatch and accepts it there ONLY
// because a backstop exists. Here none does, so warn-only would reproduce the exact defect this gate
// was built to close: a condition detected and never acted on.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// FAIL-CLOSED ON PROOF, FAIL-OPEN ON AMBIGUITY.
//
// This runs in the shared release pipeline for thirteen packages, so a bug in it must not be able to
// red a correct release. It exits 1 for exactly two findings, both of which require a POSITIVE
// determination:
//
//   non-registry-specifier   the manifest THE REGISTRY SERVES carries a specifier that cannot
//                            resolve from the registry. Deterministic, offline, no retry, and NOT
//                            excusable by any allowance.
//   uninstallable            a clean anonymous install of the published version failed, and the
//                            failure is not explained by the declared allowance, after the retry
//                            budget is exhausted.
//
// Every other outcome warns and exits 0: not propagated yet, explained by a declared allowance, a
// network fault, an npm crash, a malformed response, or an unexpected throw anywhere in this file.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// EVENTUAL CONSISTENCY, AND WHY THE RETRY WRAPS THE WHOLE ATTEMPT.
//
// npm's registry is eventually consistent after a publish, so an install fired immediately can 404 a
// package that is genuinely there. The naive fix is to retry until our own package resolves and then
// install once. That is not enough here, because this org publishes in WAVES: a ten-package release
// wave landed on 2026-08-02, and in a wave a package's SIBLING may have been published seconds ago
// and be just as unpropagated. Retrying only on our own name would then read a propagating sibling
// as a permanently missing dependency and red a correct release.
//
// So the retry wraps the entire attempt (serve check, then install), and the verdict is taken only
// once the budget is spent. What distinguishes the two failures constraint 2 demands is not a
// message, it is WHICH ORACLE IS STILL FAILING AT THE END:
//
//   our own package@version still not served    -> not-propagated  (warn)
//   served, but a dependency NAME still 404s    -> blocked-peer if declared (warn), else fail
//   served, all dependency names present,
//     install still fails                       -> uninstallable   (fail)
//
// The oracles are plain registry HTTP, not `npm view`: a packument GET, a version-manifest GET, and
// a HEAD on `dist.tarball`. That is three fewer npm-version behaviours to depend on, and it answers
// "has the registry actually served this yet" rather than "did a CLI succeed".
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLEAN MEANS ANONYMOUS, NOT MERELY EMPTY.
//
// The probe directory sits under RUNNER_TEMP, which is not a parent of the workspace, so npm's
// upward walk finds no sibling `node_modules`. It gets its own `package.json` so the walk stops
// there, its own cache so nothing is served from a warm monorepo cache, and EMPTY user and global
// npmrc files so the install is exactly what an anonymous outsider gets. That last one is not
// cosmetic: `setup-node` writes an `_authToken` into the job's npmrc, and installing with it would
// mask a package accidentally published private.
//
// Two npm behaviours learned building this, both of which cost a measurement:
//   - Pointing NPM_CONFIG_USERCONFIG and NPM_CONFIG_GLOBALCONFIG at the SAME file makes npm abort
//     with `double-loading config ... as "global", previously loaded as "user"`. They must be two
//     separate files.
//   - `npm install` does not fail with a stable exit code. `@cosyte/cli@0.0.1` exits 254 where
//     transform and synth exit 1. Only zero versus non-zero is load-bearing anywhere in this file.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const DEFAULT_ATTEMPTS = 8;
export const DEFAULT_DELAY_MS = 15_000;

// ── Specifier classification ────────────────────────────────────────────────────────────────────
//
// A POSITIVE test, deliberately, rather than a blacklist of `file:`/`link:`/`portal:`/`git+`. A
// blacklist is only ever as good as its last update, and the thing being guarded is permanent. The
// question asked is "can the registry resolve this", and only three shapes can:
//
//   a semver range or a dist-tag   `^0.0.7`, `>=0.0.0`, `1.29.0`, `latest`, `*`   (no `:` and no `/`)
//   an `npm:` alias                `npm:@scope/other@^1`
//
// Everything else is refused: anything carrying a protocol that is not `npm:` (`file:`, `link:`,
// `portal:`, `workspace:`, `git+ssh:`, `https:`), and the GitHub shorthand `owner/repo`, which has
// no protocol at all and is why the `/` clause is here rather than folded into the `:` clause.
/** @param {string} spec */
export function isRegistrySpecifier(spec) {
  if (typeof spec !== "string") return false;
  const value = spec.trim();
  if (value === "") return false;
  if (value.includes(":")) return value.startsWith("npm:");
  // `owner/repo` and `owner/repo#ref`, the protocol-less GitHub shorthand.
  if (value.includes("/")) return false;
  return true;
}

// Only the three fields that affect a CONSUMER's install tree. `devDependencies` is deliberately not
// linted: it is never installed from the registry by a consumer, so a `file:` specifier there is a
// local-development choice and not a defect this gate is entitled to red a release over.
export const CONSUMER_DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
]);

/**
 * Every non-registry specifier in the manifest the registry serves.
 * @param {Record<string, any>} manifest
 */
export function findNonRegistrySpecifiers(manifest) {
  /** @type {{field: string, name: string, spec: string}[]} */
  const findings = [];
  for (const field of CONSUMER_DEPENDENCY_FIELDS) {
    const block = manifest?.[field];
    if (!block || typeof block !== "object") continue;
    for (const [name, spec] of Object.entries(block)) {
      if (!isRegistrySpecifier(/** @type {string} */ (spec))) {
        findings.push({ field, name, spec: String(spec) });
      }
    }
  }
  return findings;
}

/**
 * Every dependency NAME a consumer install would have to resolve from the registry.
 * @param {Record<string, any>} manifest
 */
export function consumerDependencyNames(manifest) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const field of CONSUMER_DEPENDENCY_FIELDS) {
    const block = manifest?.[field];
    if (!block || typeof block !== "object") continue;
    for (const name of Object.keys(block)) names.add(name);
  }
  return [...names].sort();
}

/** Parse a comma/whitespace separated allowance into a normalized, de-duplicated list. */
export function parseAllowance(raw) {
  if (!raw) return [];
  return [
    ...new Set(
      String(raw)
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort();
}

// ── Entry points ────────────────────────────────────────────────────────────────────────────────
//
// An install can succeed and the package still be unusable: a `files` glob that omits `dist`, an
// `exports` map pointing at a file that was never packed. `npm install` does not read either.
//
// Probed ONLY where the manifest itself declares the condition, because a false red here is
// expensive. An ESM-only package legitimately cannot be `require`d, and this must not call that a
// defect. A package declaring neither condition is skipped and says so.
/** @param {Record<string, any>} manifest */
export function entryPointProbes(manifest) {
  const root = manifest?.exports?.["."] ?? manifest?.exports;
  const hasConditions = root && typeof root === "object" && !Array.isArray(root);
  const esm = hasConditions
    ? Boolean(root.import)
    : Boolean(manifest?.module) || manifest?.type === "module";
  const cjs = hasConditions
    ? Boolean(root.require)
    : Boolean(manifest?.main) && manifest?.type !== "module";
  return { esm, cjs };
}

/** Declared `bin` targets, normalized to a list of relative paths. */
export function binTargets(manifest) {
  const bin = manifest?.bin;
  if (!bin) return [];
  if (typeof bin === "string") return [bin];
  if (typeof bin === "object") return Object.values(bin).filter((v) => typeof v === "string");
  return [];
}

// ── The verdict ─────────────────────────────────────────────────────────────────────────────────
//
// Pure, and the only place a verdict is decided. Everything above gathers facts; this turns facts
// into one of five words. Kept free of I/O so the whole taxonomy is unit-testable without a network,
// which is also what proves the retry and allowance logic actually runs rather than merely existing.
//
// @param {{
//   specifierFindings: {field: string, name: string, spec: string}[],
//   ownServed: boolean,
//   installOk: boolean,
//   installAttempted: boolean,
//   missingDependencies: string[],
//   declaredAllowance: string[],
//   entryFailures: string[],
// }} facts
export function classify(facts) {
  const {
    specifierFindings,
    ownServed,
    installOk,
    installAttempted,
    missingDependencies,
    declaredAllowance,
    entryFailures,
  } = facts;

  // Deterministic and never excusable. Evaluated FIRST and independently of the install, which is
  // what stops the allowance from covering for a `file:` specifier in a package that also happens to
  // have a genuinely blocked peer. That is exactly `@cosyte/cli@0.0.1`: four `file:` specifiers AND
  // a blocked `@cosyte/fhir`. Ordering it after the install would have let the allowance excuse it.
  if (specifierFindings.length > 0) {
    return {
      verdict: "non-registry-specifier",
      failing: true,
      reason:
        `The published manifest carries ${specifierFindings.length} specifier(s) that cannot resolve ` +
        `from the registry: ` +
        specifierFindings.map((f) => `${f.field}.${f.name}="${f.spec}"`).join(", "),
    };
  }

  if (!ownServed) {
    return {
      verdict: "not-propagated",
      failing: false,
      reason:
        "The registry has not served this exact version yet. This is almost always publish " +
        "propagation lag rather than a defect, so it warns instead of failing.",
    };
  }

  if (installAttempted && !installOk) {
    const undeclared = missingDependencies.filter((n) => !declaredAllowance.includes(n));
    if (missingDependencies.length > 0 && undeclared.length === 0) {
      return {
        verdict: "blocked-peer",
        failing: false,
        reason:
          `Uninstallable, and fully explained by declared unpublished dependencies: ` +
          `${missingDependencies.join(", ")}. Every one is named in the allowance, so this is the ` +
          `expected state rather than a regression.`,
      };
    }
    return {
      verdict: "uninstallable",
      failing: true,
      reason:
        undeclared.length > 0
          ? `A clean anonymous install failed. ${undeclared.length} dependency name(s) are absent ` +
            `from the registry and NOT declared in the allowance: ${undeclared.join(", ")}.`
          : `A clean anonymous install failed, and every dependency name it declares is present on ` +
            `the registry. The failure is in this package's own published tree.`,
    };
  }

  if (entryFailures.length > 0) {
    return {
      verdict: "uninstallable",
      failing: true,
      reason:
        `The package installed, but its declared entry points do not work from a clean install: ` +
        entryFailures.join("; "),
    };
  }

  return {
    verdict: "pass",
    failing: false,
    reason: "Installed from the registry into a clean anonymous directory, and its entry points load.",
  };
}

// An allowance that no longer describes reality is its own small defect: it is a standing permission
// to be uninstallable, and it should be deleted the moment the peer publishes. Reported as a notice,
// never as a failure, because a stale allowance has never broken anything.
export function staleAllowanceEntries(declaredAllowance, presentNames) {
  return declaredAllowance.filter((n) => presentNames.includes(n));
}

// ── Registry oracles ────────────────────────────────────────────────────────────────────────────

const encodeName = (name) => name.replace("/", "%2f");

/** @returns {Promise<{status: number, body: any}>} */
async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
  });
  if (res.status !== 200) return { status: res.status, body: null };
  return { status: 200, body: await res.json() };
}

/** Does the registry know this package name at all? */
export async function packageExists(registry, name, fetchImpl) {
  const { status } = await getJson(`${registry}/${encodeName(name)}`, fetchImpl);
  if (status === 200) return true;
  if (status === 404) return false;
  // Anything else (rate limit, 5xx, proxy error) is NOT evidence of absence. Treated as present so
  // that a flaky registry can never manufacture an `uninstallable` verdict.
  return true;
}

/** The version manifest the registry actually serves, or null if it does not serve one yet. */
export async function fetchVersionManifest(registry, name, version, fetchImpl) {
  const { status, body } = await getJson(
    `${registry}/${encodeName(name)}/${encodeURIComponent(version)}`,
    fetchImpl,
  );
  return status === 200 ? body : null;
}

/** Is the tarball itself downloadable? A version manifest can be served before its bytes are. */
export async function tarballServed(url, fetchImpl) {
  if (!url) return false;
  try {
    const res = await fetchImpl(url, { method: "HEAD" });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ── The clean-room install ──────────────────────────────────────────────────────────────────────

function run(cmd, args, options) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out, err: `${err}\n${e.message}` }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/**
 * Build a directory that resolves nothing it is not told to. See the header for what each piece is
 * defending against; none of them is decoration.
 */
export async function makeCleanRoom(parent) {
  const dir = await mkdtemp(path.join(parent, "cosyte-install-check-"));
  await mkdir(path.join(dir, "cfg"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "cosyte-install-check", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  // Two separate files. Pointing both env vars at one path makes npm abort before it resolves any
  // config at all.
  await writeFile(path.join(dir, "cfg", "user.npmrc"), "");
  await writeFile(path.join(dir, "cfg", "global.npmrc"), "");
  return dir;
}

export function cleanRoomEnv(dir, registry) {
  return {
    ...process.env,
    npm_config_userconfig: path.join(dir, "cfg", "user.npmrc"),
    npm_config_globalconfig: path.join(dir, "cfg", "global.npmrc"),
    npm_config_cache: path.join(dir, ".npm-cache"),
    npm_config_registry: registry,
    // `setup-node` exports these job-wide on the publish step. They must not reach the probe: the
    // whole point is to install as an anonymous outsider.
    NODE_AUTH_TOKEN: "",
    NPM_TOKEN: "",
    npm_config__auth: "",
    npm_config_userconfig_token: "",
  };
}

/** Install `<name>@<version>` into a clean room. Resolves, never rejects. */
export async function installIntoCleanRoom({ dir, name, version, registry, npmBin = "npm" }) {
  const result = await run(
    npmBin,
    ["install", `${name}@${version}`, "--no-audit", "--no-fund", "--loglevel", "error"],
    { cwd: dir, env: cleanRoomEnv(dir, registry) },
  );
  return { ok: result.code === 0, code: result.code, output: `${result.out}\n${result.err}`.trim() };
}

/**
 * Load the package by NAME from the clean room, exactly as a consumer would. Returns the list of
 * failures, empty when everything the manifest declares actually loads.
 *
 * It reads the INSTALLED manifest itself rather than being handed the one the registry served. The
 * two can differ (npm normalizes on unpack), and what a consumer's resolver reads is the one on
 * disk. Owning that read also keeps every filesystem touch inside this function, which is what makes
 * the whole entry-point stage substitutable in the tests.
 */
export async function probeEntryPoints({ dir, name }) {
  /** @type {string[]} */
  const failures = [];
  const manifestPath = path.join(dir, "node_modules", ...name.split("/"), "package.json");
  /** @type {Record<string, any>} */
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return [`npm reported success but ${name} is not readable in the install tree: ${error?.message}`];
  }
  const { esm, cjs } = entryPointProbes(manifest);

  // A declared `bin` is asserted whether or not the package declares a library entry point, because
  // a bin-only package is a legitimate shape and a missing bin target is a defect in it either way.
  // This used to be reset alongside the entry-point probes when neither condition was declared,
  // which silently discarded every bin finding on exactly the packages that only have bins.
  for (const target of binTargets(manifest)) {
    const file = path.join(dir, "node_modules", ...name.split("/"), target);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size === 0) failures.push(`declared bin "${target}" is not a file`);
    } catch {
      failures.push(`declared bin "${target}" is missing from the installed package`);
    }
  }

  // Resolved by NAME from inside the clean room, which is what a consumer does. Loading the files by
  // path would resolve an `exports` map that does not point at them.
  if (esm) {
    const probe = path.join(dir, "probe-entry.mjs");
    await writeFile(probe, `await import(${JSON.stringify(name)});\n`);
    const r = await run(process.execPath, [probe], { cwd: dir });
    if (r.code !== 0) failures.push(`ESM entry point failed to load: ${firstLine(r.err)}`);
  }
  if (cjs) {
    const probe = path.join(dir, "probe-entry.cjs");
    await writeFile(probe, `require(${JSON.stringify(name)});\n`);
    const r = await run(process.execPath, [probe], { cwd: dir });
    if (r.code !== 0) failures.push(`CJS entry point failed to load: ${firstLine(r.err)}`);
  }
  return failures;
}

const firstLine = (s) => String(s || "").trim().split("\n").find((l) => l.trim()) || "(no output)";

// ── Orchestration ───────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The whole gate. Dependencies are injected so the retry ladder and the taxonomy can be driven
 * against fakes in the unit tests, with no network and no npm.
 */
export async function runCheck({
  name,
  version,
  registry = DEFAULT_REGISTRY,
  allowance = [],
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  fetchImpl = globalThis.fetch,
  installer = installIntoCleanRoom,
  cleanRoomFactory = makeCleanRoom,
  entryProber = probeEntryPoints,
  tempParent = tmpdir(),
  npmBin = "npm",
  waiter = sleep,
  log = () => {},
}) {
  /** @type {string[]} */
  const trail = [];
  let ownServed = false;
  let installOk = false;
  let installAttempted = false;
  let installOutput = "";
  /** @type {string[]} */
  let missingDependencies = [];
  /** @type {string[]} */
  let presentDependencies = [];
  /** @type {string[]} */
  let entryFailures = [];
  /** @type {Record<string, any> | null} */
  let servedManifest = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    servedManifest = await fetchVersionManifest(registry, name, version, fetchImpl);
    if (!servedManifest) {
      trail.push(`attempt ${attempt}: registry does not serve ${name}@${version} yet`);
      log(`attempt ${attempt}/${attempts}: ${name}@${version} not served by the registry yet`);
      if (attempt < attempts) await waiter(delayMs);
      continue;
    }
    if (!(await tarballServed(servedManifest?.dist?.tarball, fetchImpl))) {
      trail.push(`attempt ${attempt}: version manifest served but its tarball is not downloadable yet`);
      log(`attempt ${attempt}/${attempts}: tarball for ${name}@${version} not downloadable yet`);
      if (attempt < attempts) await waiter(delayMs);
      continue;
    }
    ownServed = true;

    // The specifier lint reads the manifest THE REGISTRY SERVES, never the working tree. That is the
    // distinction the whole gate exists for, and it is why this is not simply a `package.json` lint
    // in `ci.yml`: it asserts the bytes a consumer is actually handed.
    const specifierFindings = findNonRegistrySpecifiers(servedManifest);
    if (specifierFindings.length > 0) {
      // Deterministic. Retrying cannot change it, so the budget is not burned.
      return finish({
        specifierFindings,
        ownServed,
        installOk,
        installAttempted,
        missingDependencies,
        presentDependencies,
        entryFailures,
        allowance,
        trail,
        installOutput,
        name,
        version,
        attemptsUsed: attempt,
      });
    }

    const room = await cleanRoomFactory(tempParent);
    try {
      const install = await installer({ dir: room, name, version, registry, npmBin });
      installAttempted = true;
      installOk = install.ok;
      installOutput = install.output;
      if (install.ok) {
        entryFailures = await entryProber({ dir: room, name });
        trail.push(`attempt ${attempt}: install succeeded`);
        return finish({
          specifierFindings: [],
          ownServed,
          installOk,
          installAttempted,
          missingDependencies: [],
          presentDependencies: consumerDependencyNames(servedManifest),
          entryFailures,
          allowance,
          trail,
          installOutput,
          name,
          version,
          attemptsUsed: attempt,
        });
      }

      // The install failed. Explain it against the registry rather than against npm's prose, which
      // changes between npm versions and is not a contract. Ask, for every dependency name this
      // version declares, whether the registry knows it at all.
      const declaredNames = consumerDependencyNames(servedManifest);
      const missing = [];
      const present = [];
      for (const dep of declaredNames) {
        // eslint-disable-next-line no-await-in-loop
        if (await packageExists(registry, dep, fetchImpl)) present.push(dep);
        else missing.push(dep);
      }
      missingDependencies = missing;
      presentDependencies = present;
      trail.push(
        `attempt ${attempt}: install failed (exit ${install.code}); ` +
          `absent dependency names: ${missing.length ? missing.join(", ") : "none"}`,
      );
      log(
        `attempt ${attempt}/${attempts}: install failed, absent dependency names: ` +
          `${missing.length ? missing.join(", ") : "none"}`,
      );

      // A dependency that is missing but NOT declared in the allowance is the one case worth
      // retrying: in a release wave a sibling published seconds ago may still be propagating, and
      // reading that as a permanent absence would red a correct release. A failure explained by the
      // allowance needs no retry, and neither does a failure with nothing missing at all.
      const undeclaredMissing = missing.filter((n) => !allowance.includes(n));
      if (undeclaredMissing.length > 0 && attempt < attempts) {
        await waiter(delayMs);
        continue;
      }
      return finish({
        specifierFindings: [],
        ownServed,
        installOk,
        installAttempted,
        missingDependencies,
        presentDependencies,
        entryFailures,
        allowance,
        trail,
        installOutput,
        name,
        version,
        attemptsUsed: attempt,
      });
    } finally {
      await rm(room, { recursive: true, force: true }).catch(() => {});
    }
  }

  return finish({
    specifierFindings: [],
    ownServed,
    installOk,
    installAttempted,
    missingDependencies,
    presentDependencies,
    entryFailures,
    allowance,
    trail,
    installOutput,
    name,
    version,
    attemptsUsed: attempts,
  });
}

function finish(state) {
  const decision = classify({
    specifierFindings: state.specifierFindings,
    ownServed: state.ownServed,
    installOk: state.installOk,
    installAttempted: state.installAttempted,
    missingDependencies: state.missingDependencies,
    declaredAllowance: state.allowance,
    entryFailures: state.entryFailures,
  });
  return {
    ...decision,
    package: state.name,
    version: state.version,
    allowance: state.allowance,
    missingDependencies: state.missingDependencies,
    staleAllowance: staleAllowanceEntries(state.allowance, state.presentDependencies),
    entryFailures: state.entryFailures,
    attemptsUsed: state.attemptsUsed,
    trail: state.trail,
    installOutput: state.installOutput,
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────────────────────────

export function renderAnnotation(result) {
  const spec = `${result.package}@${result.version}`;
  if (result.verdict === "pass") return null;
  if (result.failing) {
    return (
      `::error title=Published package is not installable::${spec} is on the registry and cannot be ` +
      `installed. ${result.reason} The publish is PERMANENT (ADR 0001): do NOT re-run this job, cut a ` +
      `patch release with a corrected manifest.`
    );
  }
  if (result.verdict === "not-propagated") {
    return (
      `::warning title=Install gate could not reach the published version::${spec} was not served by ` +
      `the registry within ${result.attemptsUsed} attempt(s). This is almost certainly propagation ` +
      `lag, so the run is not failed. Re-check by hand with: npx --yes ${spec} --help, or ` +
      `npm view ${spec} version.`
    );
  }
  if (result.verdict === "blocked-peer") {
    return (
      `::warning title=Published package is uninstallable, as declared::${spec} cannot be installed ` +
      `because ${result.missingDependencies.join(", ")} is absent from the registry. That is the ` +
      `declared, expected state, so the run is not failed. It is still uninstallable for consumers.`
    );
  }
  return `::warning title=Post-publish install gate did not complete::${spec}: ${result.reason}`;
}

export function renderSummary(result) {
  const spec = `${result.package}@${result.version}`;
  const lines = [];
  if (result.verdict === "pass") {
    lines.push(`### Post-publish install gate: PASS`, "", `\`${spec}\` installs from the registry into a clean, anonymous directory and its declared entry points load.`);
  } else if (result.failing) {
    lines.push(
      `### Post-publish install gate: FAILED (\`${result.verdict}\`)`,
      "",
      `**\`${spec}\` is published and cannot be installed.**`,
      "",
      result.reason,
      "",
      `**Do not re-run this job.** The publish is permanent (ADR 0001) and a re-run cannot undo or`,
      `replace it. The remedy is a patch release carrying a corrected manifest.`,
      "",
      "Reproduce it exactly:",
      "",
      "```bash",
      "dir=$(mktemp -d) && cd \"$dir\"",
      'printf \'{"name":"probe","private":true}\' > package.json',
      ": > user.npmrc; : > global.npmrc",
      `npm_config_userconfig=$dir/user.npmrc npm_config_globalconfig=$dir/global.npmrc \\`,
      `  npm_config_cache=$dir/cache npm install ${spec}`,
      "```",
    );
  } else {
    lines.push(`### Post-publish install gate: ${result.verdict}`, "", result.reason);
  }
  if (result.staleAllowance.length > 0) {
    lines.push(
      "",
      `> **The declared allowance is stale.** ${result.staleAllowance.join(", ")} is now on the`,
      `> registry, so naming it as an expected-unpublished dependency no longer describes reality.`,
      `> Drop it from \`expected-unpublished-deps\` in the caller, or from the default in`,
      `> \`cosyte/.github\`.`,
    );
  }
  if (result.trail.length > 0) {
    lines.push("", "<details><summary>What the gate observed</summary>", "", ...result.trail.map((t) => `- ${t}`), "</details>");
  }
  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = "true";
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  const name = args.package;
  const version = args.version;
  if (!name || !version) {
    process.stderr.write(
      "usage: install-check.mjs --package <name> --version <version>\n" +
        "                        [--expect-unpublished-deps \"@scope/a,@scope/b\"]\n" +
        "                        [--registry URL] [--attempts N] [--delay-ms N] [--summary FILE]\n",
    );
    return 2;
  }
  const allowance = parseAllowance(args["expect-unpublished-deps"]);
  const result = await runCheck({
    name,
    version,
    registry: args.registry || DEFAULT_REGISTRY,
    allowance,
    attempts: Number(args.attempts || DEFAULT_ATTEMPTS),
    delayMs: Number(args["delay-ms"] ?? DEFAULT_DELAY_MS),
    tempParent: args["temp-parent"] || process.env.RUNNER_TEMP || tmpdir(),
    log: (m) => process.stdout.write(`${m}\n`),
  });

  process.stdout.write(`\nverdict: ${result.verdict}\n${result.reason}\n`);
  if (result.installOutput && result.verdict !== "pass") {
    process.stdout.write(`\n--- npm output ---\n${result.installOutput}\n------------------\n`);
  }
  const annotation = renderAnnotation(result);
  if (annotation) process.stdout.write(`${annotation}\n`);

  const summaryFile = args.summary || process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    await writeFile(summaryFile, `${renderSummary(result)}\n`, { flag: "a" }).catch(() => {});
  }
  if (args.json) await writeFile(args.json, `${JSON.stringify(result, null, 2)}\n`).catch(() => {});

  return result.failing ? 1 : 0;
}

// Fail-open on anything unforeseen. A crash in this file must never turn a correct release red; it
// must say loudly that the gate did not run. That is the one degradation this design accepts, and it
// is announced rather than silent.
const isEntryPoint =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stdout.write(
        `::warning title=Post-publish install gate did not complete::The gate crashed before ` +
          `reaching a verdict, so installability was NOT checked for this release: ${error?.message}\n`,
      );
      process.stdout.write(`${error?.stack || error}\n`);
      process.exitCode = 0;
    });
}
