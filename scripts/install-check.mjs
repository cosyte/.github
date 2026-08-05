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
//   3. "INVITES A RE-RUN OF A JOB THAT ALREADY PUBLISHED" does not carry the same cost here, and the
//      load-bearing half is the SECOND one. `changeset publish` queries npm and skips a version
//      already on the registry, so a re-run cannot double-publish, unconditionally. There is a
//      second mechanism, that the release step has by then pushed the `v<version>` tag so a re-run's
//      `release-notes.mjs prepare` classifies the commit `already-released` and the publish command
//      is withheld, and it is NOT unconditional: this step runs under `!cancelled()` precisely so it
//      still reports when the release step FAILED, and in that case the tag may never have been
//      pushed. An earlier draft of this comment claimed the property held "twice over". It holds
//      once, always, and twice in the ordinary case.
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
//   uninstallable            a clean anonymous install of the published version failed, the retry
//                            budget is exhausted, the registry ANSWERED for every dependency the
//                            package declares, and the failure is still not explained by the
//                            declared allowance.
//
// Every other outcome warns and exits 0: not propagated yet, explained by a declared allowance, a
// network fault, an npm crash, a malformed response, or an unexpected throw anywhere in this file.
//
// The clause about the registry having ANSWERED is the one that took a refutation to get right, and
// it is the difference between a gate and a flake. There is no safe boolean for "does this
// dependency exist" when the registry returns a 503: reading it as PRESENT eliminates the
// explanation for the install failure and the verdict silently becomes "the defect is in this
// package's own tree", which is a red; reading it as ABSENT invents an excuse. So the answer is
// three-valued, and an unanswered dependency yields `inconclusive`, which reports and exits 0. A
// failure this cannot EXPLAIN must not be a failure it CONDEMNS.
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
// So the retry wraps the entire attempt (serve check, then install), and every failure the declared
// allowance has not ALREADY SETTLED spends the whole budget before a verdict is taken. What
// distinguishes the outcomes is not a message, it is WHICH ORACLE IS STILL FAILING AT THE END:
//
//   our own package@version still not served    -> not-propagated  (warn)
//   a dependency name the registry will not
//     answer for at all                         -> inconclusive    (warn)
//   served, but a dependency NAME still 404s    -> blocked-peer if declared (warn), else fail
//   served, all dependency names present,
//     install still fails                       -> uninstallable   (fail)
//
// ONLY a failure the allowance fully explains skips the retry, because the allowance is a statement
// that the absence is known and standing rather than transient, so re-asking cannot change it. An
// earlier version had this backwards: it retried ONLY when an absent dependency was undeclared,
// which meant an install failure with NOTHING missing returned on attempt 1 with the budget
// untouched. "Nothing missing" is vacuously true for the six packages that declare no consumer
// dependencies at all, so for them every install failure went straight to a red, ordinary
// propagation lag included.
//
// The oracles are plain registry HTTP, not `npm view`: a packument GET, a version-manifest GET, and
// a HEAD on `dist.tarball`. That is three fewer npm-version behaviours to depend on, and it answers
// "has the registry actually served this yet" rather than "did a CLI succeed". ALL THREE are asked,
// and the packument is not redundant with the version document: they are separate objects with
// independent propagation, and the packument is the one npm resolves a version from. Believing the
// version document alone left a real window in which a correct release was declared uninstallable.
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
// THE GATE OWNS ITS OWN CLOCK, AND THAT IS NOT THE SAME AS THE STEP'S TIMEOUT.
//
// `timeout-minutes` on the workflow step is a FAILURE: GitHub kills the step and the run goes red.
// This deadline is a WARNING: the gate stops, says it ran out of time, and exits 0. If the only
// bound were the step's, then a slow or flaky registry would red a correct, permanent release
// through the timeout, which is exactly the outcome the whole fail-open design exists to prevent.
//
// It is not hypothetical. Measured against a dependency packument returning 503: a SINGLE `npm
// install` took 211 seconds, because npm retries a 5xx internally before giving up. At eight
// attempts that ladder is roughly thirty minutes, which sails past any sane step timeout. So the
// deadline is checked before each attempt, and an attempt is only STARTED if the whole of its
// install could still finish inside it.
export const DEFAULT_DEADLINE_MS = 540_000;
// EVERY REGISTRY FETCH IS BOUNDED, because `globalThis.fetch` is not.
//
// Node's fetch has no default request timeout. Measured in this gate: a single unbounded fetch
// against a socket that accepts and never answers stalls for 300.8 SECONDS before Node gives up. The
// deadline above is only checked BETWEEN attempts, so one attempt holding three stalled registry
// fetches plus a stalled dependency sweep could run past the workflow step's `timeout-minutes`
// without the deadline guard ever getting a turn, and a step timeout is a red run.
//
// Bounding the individual request is the fix, and it composes with everything else: a timed-out
// packument GET is indistinguishable from a 5xx here, which already means `unknown`, which already
// means retry and then warn. So this makes the gate faster to give up and changes no verdict.
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Wrap a fetch so every request carries a deadline. The wrapper preserves the caller's own `signal`
 * if one is supplied, and injected test doubles simply ignore the extra option.
 */
export function withFetchTimeout(fetchImpl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  if (!timeoutMs || typeof AbortSignal?.timeout !== "function") return fetchImpl;
  return (url, options = {}) =>
    fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMs) });
}

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
// defect. A package declaring neither condition has no entry point probed at all, and the reporting
// says so rather than claiming its entry points loaded.
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
// into exactly one of `VERDICTS` below. That list is exported and asserted against `classify`'s real
// output in the tests, rather than restated as a number in prose: this comment said "five" while the
// function produced seven, which is the stale-count class ADR 0023 exists about. Kept free of I/O so the whole taxonomy is unit-testable without a network,
// which is also what proves the retry and allowance logic actually runs rather than merely existing.
//
// @param {{
//   specifierFindings: {field: string, name: string, spec: string}[],
//   ownServed: boolean,
//   installOk: boolean,
//   installAttempted: boolean,
//   missingDependencies: string[],
//   unknownDependencies: string[],
//   deadlineExceeded: boolean,
//   declaredAllowance: string[],
//   entryFailures: string[],
//   entryPointsProbed: string[],
// }} facts
export const VERDICTS = Object.freeze([
  "pass",
  "non-registry-specifier",
  "uninstallable",
  "blocked-peer",
  "not-propagated",
  "inconclusive",
  "deadline-exceeded",
]);

export function classify(facts) {
  const {
    specifierFindings,
    ownServed,
    installOk,
    installAttempted,
    missingDependencies,
    unknownDependencies = [],
    deadlineExceeded = false,
    declaredAllowance,
    entryFailures,
    entryPointsProbed = [],
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

  // Ran out of the gate's OWN clock. Whatever we saw is not a finished measurement, so it cannot be
  // a condemnation. Placed after the specifier finding, which is deterministic and offline and stays
  // valid however little time was left.
  if (deadlineExceeded) {
    return {
      verdict: "deadline-exceeded",
      failing: false,
      reason:
        "The gate ran out of its own time budget before it could settle a verdict, so nothing is " +
        "asserted about this release either way. It stops itself rather than letting the workflow " +
        "step time out, because a step timeout is a red run and running slowly is not a defect in " +
        "the published package.",
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
    // The registry did not answer for at least one dependency, so the failure cannot be EXPLAINED.
    // A failure this cannot explain must not be a failure it condemns: without this, a transient 5xx
    // on a dependency packument is indistinguishable from that dependency being fine, and the
    // verdict silently becomes "the defect is in this package's own tree".
    if (unknownDependencies.length > 0) {
      return {
        verdict: "inconclusive",
        failing: false,
        reason:
          `A clean anonymous install failed, but the registry gave no usable answer for ` +
          `${unknownDependencies.join(", ")}, so the failure cannot be attributed. Reporting rather ` +
          `than failing: a registry fault must never red a release that may be perfectly correct.`,
      };
    }
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
    reason:
      entryPointsProbed.length > 0
        ? `Installed from the registry into a clean anonymous directory, and everything it declares ` +
          `loads (${entryPointsProbed.join(", ")}).`
        : `Installed from the registry into a clean anonymous directory. It declares no entry point ` +
          `and no bin, so nothing beyond the install itself was asserted.`,
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
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
    });
    if (res.status !== 200) return { status: res.status, body: null };
    return { status: 200, body: await res.json() };
  } catch {
    // A thrown fetch is a transport fault, not an answer. `0` is not a real HTTP status and is
    // deliberately unmatched by every caller's 200/404 test, so it lands in "unknown".
    return { status: 0, body: null };
  }
}

// THREE-VALUED ON PURPOSE, AND THE THIRD VALUE IS THE WHOLE POINT.
//
// This used to return a boolean, reading anything that was not 200 or 404 as PRESENT, with a comment
// claiming that stopped a flaky registry manufacturing a red. The refuter showed the comment asserted
// the exact inverse of what the composition does, and reproduced it: a 503 on the `@cosyte/fhir`
// packument made it "present", which emptied the absent set, which made `classify` conclude that the
// failure lay in the package's OWN tree, which is `uninstallable` and exit 1. So a transient 5xx
// turned the declared, expected `blocked-peer` warning on transform and synth into a red release.
//
// Neither boolean is safe, because both are a guess. "Present" manufactures a red by eliminating the
// explanation; "absent" manufactures a false excuse. The honest answer is that the registry did not
// say, and a failure this cannot EXPLAIN must not be a failure it CONDEMNS.
/** @returns {Promise<"present" | "absent" | "unknown">} */
export async function dependencyStatus(registry, name, fetchImpl) {
  const { status } = await getJson(`${registry}/${encodeName(name)}`, fetchImpl);
  if (status === 200) return "present";
  if (status === 404) return "absent";
  return "unknown";
}

/** The version manifest the registry actually serves, or null if it does not serve one yet. */
export async function fetchVersionManifest(registry, name, version, fetchImpl) {
  const { status, body } = await getJson(
    `${registry}/${encodeName(name)}/${encodeURIComponent(version)}`,
    fetchImpl,
  );
  return status === 200 ? body : null;
}

// THE PACKUMENT IS A SEPARATE OBJECT FROM THE VERSION DOCUMENT, AND IT IS THE ONE npm READS.
//
// `npm install pkg@version` resolves the version out of the PACKUMENT (`GET /pkg`). This gate's
// propagation oracle originally asked only for the version document (`GET /pkg/version`) and a HEAD
// on the tarball. Those are different registry and CDN objects with independent propagation, so
// there is a real window in which the version document and the tarball are both live and the
// packument still tops out at the previous version. In that window the oracle said "fully served",
// the install failed to resolve, and a correct release went red. Reproduced by the refuter against
// the real script. Asking the packument as well closes the window, because it is the object npm
// itself consults.
/** @returns {Promise<"yes" | "no" | "unknown">} */
export async function packumentListsVersion(registry, name, version, fetchImpl) {
  const { status, body } = await getJson(`${registry}/${encodeName(name)}`, fetchImpl);
  if (status !== 200) return "unknown";
  const versions = body?.versions;
  if (!versions || typeof versions !== "object") return "unknown";
  return Object.hasOwn(versions, version) ? "yes" : "no";
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

// BOUNDED, because this holds a protected `release` environment while it runs. Without a timeout a
// stalled `npm install` (a hung socket to the registry is the obvious way) inherits the six-hour job
// default, and six hours of a held release environment is a far worse outcome than a missed check.
// A kill is reported as an ordinary non-zero exit, which the retry ladder then treats as any other
// install failure: retried, and never on its own a red.
export const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;

function run(cmd, args, options = {}) {
  const { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, ...spawnOptions } = options;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: -1, out, err: `${err}\ntimed out after ${timeoutMs}ms and was killed` });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => done({ code: -1, out, err: `${err}\n${e.message}` }));
    child.on("close", (code) => done({ code, out, err }));
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

// EVERY INHERITED npm CONFIG VARIABLE IS STRIPPED, IN BOTH CASES, RATHER THAN OVERRIDDEN.
//
// This used to set only the lowercase `npm_config_userconfig`. `actions/setup-node` exports the
// UPPERCASE `NPM_CONFIG_USERCONFIG` job-wide, pointing at the npmrc that holds
// `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`, and the refuter measured that the uppercase
// form WINS IN BOTH INSERTION ORDERS on npm 10.9.8. So the probe was loading the job's authenticated
// npmrc, and the file's own claim that it installs "exactly what an anonymous outsider gets" was
// false. It was benign only by accident of a second line, the blanking of `NODE_AUTH_TOKEN`, which
// made the token interpolate empty.
//
// That accident is one edit away from arming: the comment at `release.yml`'s `setup-node` step
// already instructs a future maintainer to set `NODE_AUTH_TOKEN` at JOB level if a `scope:` input is
// ever added. Do that with the old code and the probe silently installs AUTHENTICATED, which would
// mask exactly the failure this gate is meant to catch, with no error and no test failure.
//
// Stripping the whole `npm_config_*` namespace rather than overriding the two names known to matter
// is the difference between defending against a list and defending against the mechanism. npm maps
// every config key to an env var, so any inherited one is a way for the job's environment to reach
// into a directory that is supposed to know nothing.
//
// THE RESIDUAL, STATED RATHER THAN LEFT TO BE DISCOVERED. The strip is indiscriminate, so it also
// drops transport settings expressed as npm config: `npm_config_proxy`, `npm_config_https_proxy`,
// `npm_config_cafile`, `npm_config_strict_ssl`. That is deliberate and it is safe HERE because every
// caller runs `runs-on: ubuntu-latest`, a GitHub-hosted runner with no egress proxy and no private
// CA, and because the standard `HTTPS_PROXY` / `NO_PROXY` / `NODE_EXTRA_CA_CERTS` variables are NOT
// in the `npm_config_*` namespace and survive, which is how a proxy would normally be expressed
// anyway. On a self-hosted runner that configures its proxy through npm config specifically, this
// probe would fail to reach the registry. It would fail SAFE: an unreachable registry yields
// `not-propagated` or `inconclusive`, both of which warn and exit 0. An allowlist of transport keys
// was considered and rejected, because a list is the thing this is replacing.
export function cleanRoomEnv(dir, registry) {
  /** @type {Record<string, string | undefined>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_config_/i.test(key)) continue;
    env[key] = value;
  }
  const settings = {
    userconfig: path.join(dir, "cfg", "user.npmrc"),
    globalconfig: path.join(dir, "cfg", "global.npmrc"),
    cache: path.join(dir, ".npm-cache"),
    registry,
  };
  for (const [key, value] of Object.entries(settings)) {
    // Both cases, deliberately. Setting only one leaves the other free to be inherited, and the
    // uppercase one is the form `setup-node` exports.
    env[`npm_config_${key}`] = value;
    env[`NPM_CONFIG_${key.toUpperCase()}`] = value;
  }
  // Not `npm_config_*` variables, so the strip above does not reach them, and both are read as
  // credentials by an npmrc that interpolates them.
  env.NODE_AUTH_TOKEN = "";
  env.NPM_TOKEN = "";
  return env;
}

/** Install `<name>@<version>` into a clean room. Resolves, never rejects. */
export async function installIntoCleanRoom({
  dir,
  name,
  version,
  registry,
  npmBin = "npm",
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
}) {
  // `--ignore-scripts` IS A DELIBERATE TRADE, DECIDED 2026-08-04, AND IT COSTS SOMETHING.
  //
  // WHY: this runs inside the release job. When the flag was added, `changesets/action` had left the
  // org-scoped `RELEASE_PR_TOKEN` on disk in `~/.netrc` and the raw `NPM_TOKEN` in `~/.npmrc`, both
  // for the rest of the job, so a `postinstall` in any TRANSITIVE dependency of the probed package
  // executed with them readable, on a tree that is range-resolved at probe time rather than
  // lockfile-pinned. `release.yml` now deletes both immediately after that action, before this step,
  // and THE FLAG IS STILL RIGHT: the job's own `ACTIONS_ID_TOKEN_REQUEST_TOKEN` (`id-token: write`,
  // for npm provenance) is in this step's environment, `cleanRoomEnv` below copies all of
  // `process.env` except the `npm_config_*` namespace, and a lifecycle script is a shell command
  // with the whole environment rather than a module evaluation. That variable is not impossible to
  // remove, and the sentence used to say so: a step-level `env:` entry in `release.yml` overrides
  // the runner's value and this gate needs neither it nor its URL. Not done here, because it is a
  // second behaviour change to the shared workflow in one slice, and it is stated so the next
  // person can take it rather than rediscover it.
  //
  // ▶ IT NARROWS THE WINDOW, IT DOES NOT CLOSE IT. The flag governs only the install;
  // `probeEntryPoints` below still executes third-party MODULE-INIT code. Measured on
  // `@cosyte/ncpdp@0.0.10`: the ESM arm evaluates 8 third-party packages across 39 module files,
  // ALL EIGHT reached through `^` ranges; the CJS arm 1, because ESM evaluates the static import
  // graph eagerly and `require` is lazy. What that code can REACH while it runs is a separate
  // question from whether it runs at all, and it is owned by `probeChildEnv` below, not here.
  //
  // ▶ IT HAS TWO RESIDUALS AND THE SECOND IS THE DANGEROUS ONE. It cannot catch a package whose
  // install hooks fail for a consumer (missed detection); and because `node-gyp rebuild` is npm's
  // DEFAULT `install` script, a native dependency is left UNBUILT, the install still exits 0, and
  // the entry probe below then fails to load it, producing `uninstallable` and EXIT 1 on a release
  // that is fine for consumers (false red). Both are empty today, measured across every installable
  // tree: zero install hooks and zero `binding.gyp` anywhere, including `@cosyte/cli`'s 111 packages.
  //
  // ▶ THE FULL ACCOUNT LIVES IN THE README, under "The post-publish install gate" and "What it does
  // not narrow", and that is where the next residual goes. It covers the `optionalDependencies`
  // pruning change, transitive `prepare`, why `bin` linking is unaffected, the `prepare`-in-cli's-tree
  // nuance, and the condition that would force this decision to be revisited: A NATIVE DEPENDENCY
  // ENTERING ANY OF THESE TREES MAKES THIS FLAG A SOURCE OF RED RELEASES. Keep this block short and
  // put narrative there; it reached 65 lines for one flag before this note existed.
  const result = await run(
    npmBin,
    [
      "install",
      `${name}@${version}`,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
    ],
    { cwd: dir, env: cleanRoomEnv(dir, registry), timeoutMs },
  );
  return { ok: result.code === 0, code: result.code, output: `${result.out}\n${result.err}`.trim() };
}

// ── The entry probe's environment ───────────────────────────────────────────────────────────────

// Passed through to the probe child BY NAME. Not one of them is a credential, and each is something
// a consumer's own shell would ordinarily carry: the locale and TZ a module may format with, the
// TLS and proxy settings a module-init network call would need on a runner that has them (a
// GitHub-hosted one does not), and the Windows variables node's own crypto and dns paths read. PATH
// is here because a missing PATH is a behaviour change with no credential bought; `process.execPath`
// is absolute, so the spawn itself never needed it.
//
// NOT here, deliberately: `NODE_OPTIONS`, which can `--require` an arbitrary file into the child and
// is not something an anonymous consumer has set for us; and `GITHUB_*`, which names the run, the
// repo and the workspace path.
export const PROBE_ENV_PASSTHROUGH = Object.freeze([
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "PATHEXT",
]);

// THE PROBE CHILD RUNS THIRD-PARTY CODE, SO ITS ENVIRONMENT IS BUILT FROM NOTHING RATHER THAN
// INHERITED. This is the single code owner of that exposure; the full inventory of what runs with a
// credential in scope is the README, under "What it does not narrow".
//
// `probeEntryPoints` loads the published package BY NAME, which evaluates the module-init code of
// its whole import graph, in a tree range-resolved at probe time rather than lockfile-pinned. Before
// this function the child simply inherited `process.env`, and the gap was written down in three
// places and closed in none, which is how it stayed open through two edits.
//
// ▶ WHAT WAS ACTUALLY IN THAT INHERITED ENVIRONMENT, DERIVED FROM `release.yml` RATHER THAN NAMED
// FROM MEMORY, BECAUSE THE FIRST DRAFT OF THIS COMMENT NAMED THREE VARIABLES THAT WERE NOT THERE.
// Not `NODE_AUTH_TOKEN`, `NPM_TOKEN` or `RELEASE_PR_TOKEN`: that workflow declares no job-level and
// no workflow-level `env`, all three are set on the `changesets/action` step alone, step `env` does
// not persist to later steps, and setup-node v7 stopped exporting the dummy `NODE_AUTH_TOKEN`
// job-wide. What IS in every step of that job is `ACTIONS_ID_TOKEN_REQUEST_TOKEN` and
// `ACTIONS_ID_TOKEN_REQUEST_URL`, present because the workflow requests `id-token: write` for npm
// provenance, and they exchange for a signed OIDC token naming the repo. Two more reasons this is a
// guard rather than hygiene, and both are one line of YAML away: `release.yml`'s own setup-node
// comment instructs a future maintainer to set `NODE_AUTH_TOKEN` at JOB level if a `scope:` input
// is ever added, which arms exactly this; and a caller's secret becomes job-wide the moment someone
// hoists an `env:` block to make it available to two steps.
//
// ▶ AN ALLOW-LIST, WHICH IS NOT A CONTRADICTION OF `cleanRoomEnv` ABOVE REJECTING ONE. There the
// thing defended against has a NAMESPACE, `npm_config_*`, so denying the namespace defends against
// the mechanism and an allow-list of transport keys would have been a weaker spelling of it. A
// secret has no namespace: `NODE_AUTH_TOKEN`, `NPM_TOKEN`, `RELEASE_PR_TOKEN` and
// `DOCS_REPO_DISPATCH_TOKEN` share no prefix, and the next secret a caller adds shares nothing with
// those either. A deny-list of names would not cover it and would report green while not covering
// it. The child needs nothing from the job to evaluate `await import(name)`, so it gets nothing but
// the list above, and a secret added later is excluded by construction rather than by memory.
//
// ▶ HOME IS MOVED INSIDE THE CLEAN ROOM, which takes `~/.netrc` and `~/.npmrc` off the child's `~`
// path. `os.homedir()` reads HOME first on POSIX and USERPROFILE on Windows, so both are set.
// `release.yml` also deletes both of those files immediately after `changesets/action`, before this
// step runs; the two measures are independent and neither is load-bearing on the other.
//
// ▶ THE RESIDUAL, STATED RATHER THAN LEFT TO BE FOUND. This narrows what third-party code is HANDED.
// It is not a sandbox and does not pretend to be one: an absolute path is still an absolute path,
// `os.userInfo().homedir` reads the passwd entry and ignores HOME, and the caller's checkout is
// still on disk. What covers a file at a known absolute path is deleting it, which is why the
// credential removal in `release.yml` is the other half of this rather than a duplicate of it, and
// what neither covers is `ACTIONS_ID_TOKEN_REQUEST_TOKEN` reaching anything else in the job.
export function probeChildEnv(dir, source = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of PROBE_ENV_PASSTHROUGH) {
    const value = source[key];
    // Skipped rather than set to undefined: spawn stringifies an `undefined` value to "undefined",
    // which is a set variable with a nonsense value, not an absent one.
    if (typeof value === "string") env[key] = value;
  }
  const home = path.join(dir, "probe-home");
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
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
export async function probeEntryPoints({ dir, name, env = probeChildEnv(dir) }) {
  /** @type {string[]} */
  const failures = [];
  const manifestPath = path.join(dir, "node_modules", ...name.split("/"), "package.json");
  /** @type {Record<string, any>} */
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return {
      failures: [`npm reported success but ${name} is not readable in the install tree: ${error?.message}`],
      probed: [],
    };
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

  // The child's `~`. Created whether or not either probe runs, so that HOME never names a directory
  // that does not exist: a module init that writes to `~` would then fail for a reason that is this
  // gate's doing and would be reported as the package being uninstallable.
  await mkdir(path.join(dir, "probe-home"), { recursive: true });

  // Resolved by NAME from inside the clean room, which is what a consumer does. Loading the files by
  // path would resolve an `exports` map that does not point at them. `env` is `probeChildEnv`'s, not
  // this process's: see the block above it for why that is an allow-list.
  if (esm) {
    const probe = path.join(dir, "probe-entry.mjs");
    await writeFile(probe, `await import(${JSON.stringify(name)});\n`);
    const r = await run(process.execPath, [probe], { cwd: dir, env, timeoutMs: 60_000 });
    if (r.code !== 0) failures.push(`ESM entry point failed to load: ${firstLine(r.err)}`);
  }
  if (cjs) {
    const probe = path.join(dir, "probe-entry.cjs");
    await writeFile(probe, `require(${JSON.stringify(name)});\n`);
    const r = await run(process.execPath, [probe], { cwd: dir, env, timeoutMs: 60_000 });
    if (r.code !== 0) failures.push(`CJS entry point failed to load: ${firstLine(r.err)}`);
  }
  const probed = [...binTargets(manifest).map((t) => `bin:${t}`), ...(esm ? ["esm"] : []), ...(cjs ? ["cjs"] : [])];
  return { failures, probed };
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
  deadlineMs = DEFAULT_DEADLINE_MS,
  installTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  now = () => Date.now(),
  fetchImpl: rawFetchImpl = globalThis.fetch,
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
  let unknownDependencies = [];
  /** @type {string[]} */
  let entryFailures = [];
  /** @type {string[]} */
  let entryPointsProbed = [];
  /** @type {Record<string, any> | null} */
  let servedManifest = null;
  const startedAt = now();
  let deadlineExceeded = false;
  const fetchImpl = withFetchTimeout(rawFetchImpl, fetchTimeoutMs);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Only START an attempt whose install could still finish inside the deadline. Checking merely
    // that the deadline has not passed would let a 180s install begin one second before it and
    // overrun into the step's timeout, which is the red this exists to avoid.
    if (attempt > 1 && now() - startedAt + installTimeoutMs > deadlineMs) {
      deadlineExceeded = true;
      trail.push(
        `stopped after ${attempt - 1} attempt(s): the gate's own ${Math.round(deadlineMs / 1000)}s ` +
          `deadline would not fit another install. Reporting rather than letting the step time out, ` +
          `because a step timeout is a red run and this is not a defect in the package.`,
      );
      log(`deadline reached after ${attempt - 1} attempt(s); reporting without a verdict`);
      break;
    }
    servedManifest = await fetchVersionManifest(registry, name, version, fetchImpl);
    if (!servedManifest) {
      trail.push(`attempt ${attempt}: registry does not serve ${name}@${version} yet`);
      log(`attempt ${attempt}/${attempts}: ${name}@${version} not served by the registry yet`);
      if (attempt < attempts) await waiter(delayMs);
      continue;
    }
    // The object npm ACTUALLY resolves from. See `packumentListsVersion`: the version document and
    // the packument propagate independently, and believing the version document alone left a real
    // window in which a correct release was declared uninstallable.
    const listed = await packumentListsVersion(registry, name, version, fetchImpl);
    if (listed !== "yes") {
      trail.push(
        `attempt ${attempt}: version document served but the packument does not list ${version} ` +
          `yet (${listed})`,
      );
      log(`attempt ${attempt}/${attempts}: packument does not list ${name}@${version} yet`);
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
        unknownDependencies,
        entryFailures,
        entryPointsProbed,
        deadlineExceeded,
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
      const install = await installer({ dir: room, name, version, registry, npmBin, timeoutMs: installTimeoutMs });
      installAttempted = true;
      installOk = install.ok;
      installOutput = install.output;
      if (install.ok) {
        const probe = await entryProber({ dir: room, name });
        entryFailures = probe.failures;
        entryPointsProbed = probe.probed;
        trail.push(
          `attempt ${attempt}: install succeeded; entry points probed: ` +
            `${probe.probed.length ? probe.probed.join(", ") : "none declared"}`,
        );
        return finish({
          specifierFindings: [],
          ownServed,
          installOk,
          installAttempted,
          missingDependencies: [],
          presentDependencies: consumerDependencyNames(servedManifest),
          unknownDependencies: [],
          entryFailures,
          entryPointsProbed,
          deadlineExceeded,
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
      const unknown = [];
      for (const dep of declaredNames) {
        // The sweep is the one loop inside an attempt whose length is set by the PACKAGE rather than
        // by this file: `@cosyte/cli` declares ten. Checked here as well as between attempts, so a
        // package with many dependencies against a slow registry cannot walk past the deadline
        // inside a single attempt. A dependency not reached is `unknown`, not `present`, which is
        // the conservative reading: it yields `inconclusive` and warns.
        if (now() - startedAt > deadlineMs) {
          unknown.push(...declaredNames.filter((n) => !present.includes(n) && !missing.includes(n)));
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        const status = await dependencyStatus(registry, dep, fetchImpl);
        if (status === "present") present.push(dep);
        else if (status === "absent") missing.push(dep);
        else unknown.push(dep);
      }
      missingDependencies = missing;
      presentDependencies = present;
      unknownDependencies = unknown;
      trail.push(
        `attempt ${attempt}: install failed (exit ${install.code}); ` +
          `absent: ${missing.length ? missing.join(", ") : "none"}; ` +
          `unanswered: ${unknown.length ? unknown.join(", ") : "none"}`,
      );
      log(
        `attempt ${attempt}/${attempts}: install failed; absent dependency names: ` +
          `${missing.length ? missing.join(", ") : "none"}`,
      );

      // RETRY ANY FAILURE THE ALLOWANCE HAS NOT ALREADY SETTLED, AND SPEND THE WHOLE BUDGET.
      //
      // This previously retried ONLY when a dependency name was both absent and undeclared, which
      // meant an install failure with nothing missing returned `uninstallable` on attempt 1 with the
      // budget untouched. That is the single most common shape in this org: six of the thirteen
      // packages declare no consumer dependencies at all, so "nothing missing" is VACUOUSLY true for
      // them and every install failure went straight to a red. The refuter reproduced a correct
      // `@cosyte/hl7` release going red on ordinary packument lag, in one attempt, with the
      // annotation telling the reader to cut a needless patch. It also contradicted this file's own
      // comments in three places.
      //
      // The one failure that is genuinely settled and needs no retry is one the declared allowance
      // fully explains: the allowance is a statement that the absence is known and standing, not
      // transient, so re-asking cannot change the answer. Everything else gets the budget, because
      // everything else might be propagation.
      const explainedByAllowance =
        unknown.length === 0 &&
        missing.length > 0 &&
        missing.every((n) => allowance.includes(n));
      if (!explainedByAllowance && attempt < attempts) {
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
        unknownDependencies,
        entryFailures,
        entryPointsProbed,
        deadlineExceeded,
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
    unknownDependencies,
    entryFailures,
    entryPointsProbed,
    deadlineExceeded,
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
    unknownDependencies: state.unknownDependencies ?? [],
    deadlineExceeded: state.deadlineExceeded ?? false,
    declaredAllowance: state.allowance,
    entryFailures: state.entryFailures,
    entryPointsProbed: state.entryPointsProbed ?? [],
  });
  return {
    ...decision,
    package: state.name,
    version: state.version,
    allowance: state.allowance,
    missingDependencies: state.missingDependencies,
    unknownDependencies: state.unknownDependencies ?? [],
    deadlineExceeded: state.deadlineExceeded ?? false,
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
  if (result.verdict === "deadline-exceeded") {
    return (
      `::warning title=Install gate ran out of time::${spec} could not be checked within the gate's ` +
      `own time budget, so its installability is UNKNOWN and the run is not failed. This usually ` +
      `means the registry was slow or erroring. Re-check by hand with: npm install ${spec} in an ` +
      `empty directory.`
    );
  }
  if (result.verdict === "inconclusive") {
    return (
      `::warning title=Install gate could not attribute a failure::${spec} did not install from the ` +
      `registry, but the registry gave no usable answer for ` +
      `${result.unknownDependencies.join(", ")}, so this may be a registry fault rather than a ` +
      `defect. The run is NOT failed on an unattributed failure. Re-check by hand with: ` +
      `npm install ${spec} in an empty directory.`
    );
  }
  // Reached only if a verdict is added above without a branch here. Kept as a loud catch-all rather
  // than removed: a silent unreported verdict is the failure mode this whole file is about.
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
      `> Drop it from \`expect-unpublished-deps\` in the caller, or from the default in`,
      `> \`cosyte/.github\`.`,
    );
  }
  if (result.trail.length > 0) {
    lines.push("", "<details><summary>What the gate observed</summary>", "", ...result.trail.map((t) => `- ${t}`), "</details>");
  }
  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

// F7: `Number("30s")` is NaN, and NaN is falsy, so a mistyped `--fetch-timeout-ms` silently returned
// the RAW, UNBOUNDED fetch from `withFetchTimeout`, reinstating exactly the stall this gate was hardened
// against. `release.yml` passes none of these flags so it was never a production path, but a numeric
// option that fails open on a typo is the wrong shape for a file whose whole subject is unbounded waits.
export function numericOption(raw, fallback, { min = 0 } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(
      `expected a number >= ${min} but got "${raw}". Refusing to fall back to a default, because a ` +
        `mistyped bound silently becomes NO bound.`,
    );
  }
  return value;
}

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
        "                        [--registry URL] [--attempts N] [--delay-ms N] [--deadline-ms N]\n" +
        "                        [--summary FILE] [--json FILE]\n",
    );
    return 2;
  }
  const allowance = parseAllowance(args["expect-unpublished-deps"]);
  const result = await runCheck({
    name,
    version,
    registry: args.registry || DEFAULT_REGISTRY,
    allowance,
    attempts: numericOption(args.attempts, DEFAULT_ATTEMPTS, { min: 1 }),
    delayMs: numericOption(args["delay-ms"], DEFAULT_DELAY_MS),
    deadlineMs: numericOption(args["deadline-ms"], DEFAULT_DEADLINE_MS, { min: 1 }),
    fetchTimeoutMs: numericOption(args["fetch-timeout-ms"], DEFAULT_FETCH_TIMEOUT_MS, { min: 1 }),
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
