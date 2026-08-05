#!/usr/bin/env node
// @ts-check
//
// THE TWO PRE-PUBLISH LAYERS. A GATE THAT FIRES AFTER AN IRREVERSIBLE ACT CANNOT GATE.
//
// `install-check.mjs` runs in `release.yml` AFTER `changeset publish`. It is a real check and it
// catches real defects, but by the time it speaks the version is on the registry and permanent
// (ADR 0001). It can report; it cannot prevent. That is why it shipped described as the narrow half.
//
// These are the halves that can PREVENT, and they run in `ci.yml`, on every pull request, before
// anything is published:
//
//   LAYER 1  manifest       Offline, instant, no network and no npm. The consumer-facing dependency
//                           fields must carry only specifiers a registry can resolve. This is the
//                           one that would have stopped `@cosyte/cli@0.0.1`: its working tree
//                           carried `file:vendor/*.tgz` in `dependencies` and `optionalDependencies`
//                           at the moment it published, and every other gate read that tree and
//                           passed it. Measured 2026-08-05 against all thirteen callers: ZERO
//                           findings, `transform` and `synth` included. The `file:vendor/*.tgz`
//                           specifiers that survive in seven repos are all in `devDependencies`,
//                           which no consumer ever installs and which this deliberately does not
//                           read. So this layer is green today and turning it on reds nobody.
//
//   LAYER 2  pack           `npm pack` the working tree, then install THAT TARBALL into a clean
//                           anonymous directory and load what it declares. This is the layer with a
//                           blast radius: `transform` and `synth` are genuinely uninstallable today
//                           because their peer `@cosyte/fhir` is not on the registry, so it reds
//                           them for a condition nobody can fix from those repos. That is what the
//                           declared allowance below is for, and it is why this layer is OPT-IN.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE DECLARED ALLOWANCE, AND WHY IT HAS KINDS
//
// A repo names its known-unpublished consumer dependencies in `expect-unpublished-deps`, and the
// gate asserts EXACTLY that set and no more: an absence that is named is the expected state and
// warns, an absence that is NOT named still fails. Without it you get a permanently red CI people
// learn to ignore, which is the same failure as a dispatch step that had never once executed. With
// an open-ended one you get a mute, which is worse than no gate at all because it reads as a gate.
//
// A DELIBERATE ABSENCE AND AN UNEXPLAINED BLOCK MUST NOT SHARE WORDS, so an entry carries a kind:
//
//   name=blocked    Absent for a reason outside this repo's control, and EXPECTED TO CLEAR.
//                   `@cosyte/fhir` is the only one today: a persistent unexplained npm `E403`
//                   (FHIR-NPM-NAME), staged on `main`, not missing work. This kind EXCUSES an
//                   install failure, and it is self-clearing — the moment the package publishes,
//                   nothing is absent, the install simply passes, and the entry is reported stale
//                   so it gets deleted.
//
//   name=private    Absent BY DESIGN and never going to clear. `@cosyte/assets` and `@cosyte/docs`
//                   are both `E404` on the registry exactly like `@cosyte/fhir` is, and they are
//                   `private: true` on purpose. This kind EXCUSES NOTHING, anywhere, and refusing to
//                   let it is the whole reason the kinds exist: a published package whose consumer
//                   dependency will never exist is not "the expected state", it is a permanent
//                   defect wearing the same 404 as a temporary one. An earlier draft let it excuse
//                   a package that is itself private; that branch is UNREACHABLE, because a private
//                   manifest settles `not-published` before anything is packed, and a branch the
//                   pipeline can never take is a claim only the tests can prove.
//
//   name            Untagged. Accepted, because that is the spelling `release.yml` has shipped
//                   since `#31` and one grammar across both gates is worth more than a flag day.
//                   Read as `blocked`, and REPORTED as untagged in the step summary so it can be
//                   tightened. Stated rather than hidden: this is the route by which a package that
//                   is absent BY DESIGN could be excused, and it takes a human writing that exact
//                   name into a workflow input.
//
// A malformed entry FAILS — an unknown kind, an empty name, or one name written twice with
// different kinds. That last one is not pedantry: the argument for failing on a typo is that a typo
// silently NARROWING the allowance would be invisible, and de-duplicating on the name alone would
// silently WIDEN it instead, keeping whichever kind happened to be written first. Every other
// failure mode here is about the package; this one is about the thing that EXCUSES failures, and it
// is offline, deterministic and one line to fix.
//
// ▶ `install-check.mjs` READS THE SAME STRING AND STRIPS ONLY `=blocked`. It cannot fail closed on a
// typo — a red there misreports a permanent release — so instead an unrecognised or `private` tag is
// left ATTACHED to the name, matches no dependency, and excuses nothing. The two gates therefore
// agree on the only kind that excuses anything, which is what makes "one grammar" true rather than
// merely tidy. Stripping every tag was written first and quietly taught the post-publish gate to
// excuse `private`, which is the one kind defined not to.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// FAIL CLOSED, WHICH IS THE OPPOSITE OF THE POST-PUBLISH GATE, DELIBERATELY
//
// `install-check.mjs` fails OPEN on everything ambiguous and on any crash, because a red there
// misreports a release that already happened and cannot be withdrawn. THE AXIS FLIPS HERE. Nothing
// irreversible has happened yet, a red pull-request check costs a re-run, and a gate that swallowed
// its own crash before a publish would be a gate that is not there. So an unexpected throw in this
// file exits non-zero.
//
// What does NOT flip is the treatment of the registry not answering. A 503 on a dependency packument
// is not evidence about this package, and reading it as one would produce a check that reds on
// weather. That stays three-valued and warns, exactly as it does post-publish.

import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  CONSUMER_DEPENDENCY_FIELDS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_REGISTRY,
  cleanRoomEnv,
  consumerDependencyNames,
  dependencyStatus,
  findNonRegistrySpecifiers,
  makeCleanRoom,
  numericOption,
  parseArgs,
  probeEntryPoints,
  runCommand,
  withFetchTimeout,
} from "./install-check.mjs";

// The directory `ci.yml` checks this tooling out into, inside the caller's workspace because
// `actions/checkout` refuses a path outside it. Named here so the pack layer can REFUSE a tarball
// that contains it rather than trusting that every repo's `files` field keeps it out. All thirteen
// callers declare `files`, so this cannot fire today; it is a structural pin on a hazard that a
// single manifest edit in any of them would otherwise arm silently.
export const TOOLING_DIR = ".cosyte-ci-tooling";

export const DEFAULT_ATTEMPTS = 2;
export const DEFAULT_DELAY_MS = 10_000;

// ── The declared allowance ──────────────────────────────────────────────────────────────────────

export const ALLOWANCE_KINDS = Object.freeze(["blocked", "private"]);

/**
 * Parse `expect-unpublished-deps` into kinded entries. Never throws; a malformed entry is returned
 * as a finding so the caller can decide, which keeps this pure and unit-testable.
 * @param {string | undefined} raw
 */
export function parseDeclaredAllowance(raw) {
  /** @type {{name: string, kind: string, tagged: boolean}[]} */
  const entries = [];
  /** @type {string[]} */
  const malformed = [];
  const seen = new Map();
  for (const token of String(raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const parts = token.split("=");
    if (parts.length > 2) {
      malformed.push(`"${token}" has more than one "=" and is not a <name> or <name>=<kind>`);
      continue;
    }
    const name = parts[0].trim();
    const tagged = parts.length === 2;
    const kind = tagged ? parts[1].trim() : "blocked";
    if (!name) {
      malformed.push(`"${token}" declares a kind with no package name`);
      continue;
    }
    if (tagged && !ALLOWANCE_KINDS.includes(kind)) {
      malformed.push(
        `"${token}" names kind "${kind}", which is not one of ${ALLOWANCE_KINDS.join(", ")}`,
      );
      continue;
    }
    // A REPEAT WITH A DIFFERENT KIND IS MALFORMED, NOT A LAST-WINS OR A FIRST-WINS. The header
    // argues that a typo NARROWING the allowance must fail because it would be invisible; a typo
    // WIDENING it is the same defect pointed the other way, and de-duplicating on the name alone
    // silently keeps whichever kind happened to be written first.
    if (seen.has(name)) {
      if (seen.get(name) !== kind) {
        malformed.push(`"${name}" is named twice with different kinds ("${seen.get(name)}" and "${kind}")`);
      }
      continue;
    }
    seen.set(name, kind);
    entries.push({ name, kind, tagged });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, malformed };
}

/**
 * Does this entry excuse an absence? EXACTLY ONE KIND DOES.
 *
 * `private` deliberately does not, anywhere. A first draft let it excuse "a package that is itself
 * private", which reads reasonable and is unreachable: a private manifest never gets as far as an
 * install here, it settles `not-published` before anything is packed. A branch that cannot be taken
 * in production is a claim the tests can prove and the pipeline can never exhibit, so it is gone
 * rather than documented.
 * @param {{kind: string}} entry
 */
export function allowanceExcuses(entry) {
  return entry.kind === "blocked";
}

/**
 * Absences the allowance does not account for, each with the reason it does not. This is the
 * "exactly that set and no more" property, and it is the only thing standing between a declared
 * allowance and a mute.
 * @param {string[]} absentNames
 * @param {{name: string, kind: string}[]} entries
 */
export function unexplainedAbsences(absentNames, entries) {
  return absentNames
    .map((name) => {
      const entry = entries.find((e) => e.name === name);
      if (!entry) return { name, why: "not named in the allowance at all" };
      if (allowanceExcuses(entry)) return null;
      return {
        name,
        why:
          `named as "${name}=${entry.kind}", which means absent by design and never going to ` +
          `clear. A package that publishes must not depend on it, so this is a permanent defect ` +
          `rather than the expected state. Remove the dependency`,
      };
    })
    .filter((v) => v !== null);
}

/**
 * Allowance entries that no longer describe reality. A standing permission to be uninstallable
 * should be deleted the moment it stops applying, but a stale one has never broken anything, so
 * these are notices and never failures.
 * `declaredNames` is `null` for UNKNOWN and `[]` for KNOWN-EMPTY, and the distinction is the whole
 * reason it is not just an array. A package that declares no consumer dependencies at all is the
 * case where an allowance entry is MOST obviously dead weight, and an `array.length > 0` guard —
 * which is what this had first — silently declines to say so on exactly that package.
 * @param {{name: string, kind: string}[]} entries
 */
export function staleAllowance(entries, { presentNames = [], declaredNames = null } = {}) {
  /** @type {{name: string, why: string}[]} */
  const stale = [];
  for (const entry of entries) {
    if (presentNames.includes(entry.name)) {
      stale.push({ name: entry.name, why: "is on the registry now, so the allowance is spent" });
    } else if (Array.isArray(declaredNames) && !declaredNames.includes(entry.name)) {
      stale.push({
        name: entry.name,
        why: "is not a consumer dependency of this package, so it excuses nothing here",
      });
    }
  }
  return stale;
}

// ── The verdicts ────────────────────────────────────────────────────────────────────────────────
//
// Pure, and the only place a verdict is decided, for the same reason `install-check.mjs` keeps its
// `classify` free of I/O: the whole taxonomy is then provable without a network and without npm,
// which is what proves the allowance logic RUNS rather than merely exists.

export const MANIFEST_VERDICTS = Object.freeze([
  "pass",
  "not-published",
  "non-registry-specifier",
  "malformed-allowance",
]);

export const PACK_VERDICTS = Object.freeze([
  "pass",
  "not-published",
  "malformed-allowance",
  "non-registry-specifier",
  "not-built",
  "not-packed",
  "tooling-in-tarball",
  "blocked-peer",
  "inconclusive",
  "undeclared-absent-dependency",
  "uninstallable",
]);

/**
 * LAYER 1. Offline, deterministic, and never excusable by any allowance — the same rule
 * `install-check.mjs` applies to the manifest the registry serves, applied to the manifest that is
 * about to become it.
 * @param {{manifest: Record<string, any>, malformedAllowance?: string[]}} facts
 */
export function classifyManifest({ manifest, malformedAllowance = [] }) {
  if (malformedAllowance.length > 0) {
    return {
      verdict: "malformed-allowance",
      failing: true,
      reason: `expect-unpublished-deps does not parse: ${malformedAllowance.join("; ")}`,
    };
  }
  // A private package is never published, so "can a consumer resolve this from the registry" is not
  // a question about it. Said out loud rather than passing quietly, because a check that reports
  // `pass` over something it never examined is the shape this org has been bitten by.
  if (manifest?.private === true) {
    return {
      verdict: "not-published",
      failing: false,
      reason:
        "The manifest declares `private: true`, so it is never published and no consumer ever " +
        "resolves its dependencies from a registry. Nothing was asserted about its specifiers.",
    };
  }
  const findings = findNonRegistrySpecifiers(manifest);
  if (findings.length > 0) {
    return {
      verdict: "non-registry-specifier",
      failing: true,
      findings,
      reason:
        `${findings.length} specifier(s) in this manifest cannot resolve from a registry, so a ` +
        `consumer installing the published package would fail: ` +
        findings.map((f) => `${f.field}.${f.name}="${f.spec}"`).join(", ") +
        `. This is exactly how @cosyte/cli@0.0.1 and 0.0.2 reached the registry permanently ` +
        `uninstallable. devDependencies are not read and a file: specifier is fine there.`,
    };
  }
  return {
    verdict: "pass",
    failing: false,
    findings,
    reason:
      `Every specifier in ${CONSUMER_DEPENDENCY_FIELDS.join(", ")} is a registry range, a dist-tag ` +
      `or an npm: alias, so a consumer can resolve all of them.`,
  };
}

/**
 * LAYER 2.
 * @param {{
 *   malformedAllowance?: string[],
 *   specifierFindings?: {field: string, name: string, spec: string}[],
 *   missingFromTree?: string[],
 *   missingFromTarball?: string[],
 *   toolingInTarball?: string[],
 *   installOk?: boolean,
 *   absentDependencies?: string[],
 *   unknownDependencies?: string[],
 *   entryFailures?: string[],
 *   entryPointsProbed?: string[],
 *   allowance?: {name: string, kind: string}[],
 * }} facts
 */
export function classifyPack(facts) {
  const {
    malformedAllowance = [],
    specifierFindings = [],
    missingFromTree = [],
    missingFromTarball = [],
    toolingInTarball = [],
    installOk = false,
    absentDependencies = [],
    unknownDependencies = [],
    entryFailures = [],
    entryPointsProbed = [],
    allowance = [],
  } = facts;

  if (malformedAllowance.length > 0) {
    return {
      verdict: "malformed-allowance",
      failing: true,
      reason: `expect-unpublished-deps does not parse: ${malformedAllowance.join("; ")}`,
    };
  }

  // THE SPECIFIER LINT IS EVALUATED FIRST AND INDEPENDENTLY OF THE INSTALL, HERE TOO, AND THIS IS
  // NOT REDUNDANT WITH LAYER 1. `install-check.mjs`'s `classify` orders it first precisely so the
  // allowance cannot excuse a `file:` specifier in a package that ALSO has a genuinely blocked peer
  // — which is exactly `@cosyte/cli@0.0.1`, four `file:` specifiers and a blocked `@cosyte/fhir`.
  // Leaving that ordering to the workflow's step order made the property depend on a caller's
  // configuration: with `run-prepublish-manifest-lint: false` and `run-prepublish-install: true`,
  // that shape settled `blocked-peer` and exited 0. The verdict function owns it now, so no
  // arrangement of the inputs can lose it.
  if (specifierFindings.length > 0) {
    return {
      verdict: "non-registry-specifier",
      failing: true,
      reason:
        `${specifierFindings.length} specifier(s) in this manifest cannot resolve from a registry: ` +
        specifierFindings.map((f) => `${f.field}.${f.name}="${f.spec}"`).join(", ") +
        `. Deterministic, offline, and never excusable by the allowance.`,
    };
  }

  // WHY THIS PAIR IS TWO VERDICTS AND NOT ONE, AND IT IS THE DIFFERENCE BETWEEN A GATE AND A NAG.
  // From the tarball alone, "you forgot to build" and "your `files` field drops `dist`" are the
  // same absence. From the tarball AND the working tree they are distinguishable, and only the
  // second is a defect in the package. Collapsing them would make a workflow-ordering mistake here
  // look like a packaging bug in thirteen repos.
  if (missingFromTree.length > 0) {
    return {
      verdict: "not-built",
      failing: true,
      reason:
        `The manifest declares entry points that do not exist in the working tree: ` +
        `${missingFromTree.join(", ")}. Build before packing — this is this workflow's mistake, ` +
        `not the package's.`,
    };
  }
  if (toolingInTarball.length > 0) {
    return {
      verdict: "tooling-in-tarball",
      failing: true,
      reason:
        `The packed tarball contains this gate's own checkout (${TOOLING_DIR}): ` +
        `${toolingInTarball.slice(0, 5).join(", ")}. The measurement is contaminated and the ` +
        `published package would ship it. Narrow the manifest's "files" field.`,
    };
  }
  if (missingFromTarball.length > 0) {
    return {
      verdict: "not-packed",
      failing: true,
      reason:
        `These files exist in the working tree and are NOT in the tarball, so they would not be ` +
        `published: ${missingFromTarball.join(", ")}. The manifest's "files" field or .npmignore ` +
        `drops something the manifest declares.`,
    };
  }

  if (!installOk) {
    // The registry did not ANSWER for at least one dependency, so the failure cannot be attributed.
    // Identical reasoning to the post-publish gate: reading a 503 as "present" eliminates the
    // explanation and silently condemns this package's own tree; reading it as "absent" invents an
    // excuse. Neither boolean is safe, so it warns.
    if (unknownDependencies.length > 0) {
      return {
        verdict: "inconclusive",
        failing: false,
        reason:
          `The packed tarball failed to install into a clean directory, but the registry gave no ` +
          `usable answer for ${unknownDependencies.join(", ")}, so the failure cannot be ` +
          `attributed. Reporting rather than failing: a registry fault is not evidence about this ` +
          `package.`,
      };
    }
    const unexplained = unexplainedAbsences(absentDependencies, allowance);
    if (absentDependencies.length > 0 && unexplained.length === 0) {
      return {
        verdict: "blocked-peer",
        failing: false,
        reason:
          `Uninstallable, and every dependency name the registry does not serve is declared: ` +
          `${absentDependencies.join(", ")}. Each is named in expect-unpublished-deps as a standing ` +
          `block, so this is the expected state rather than a regression. Delete the entry the ` +
          `moment it publishes. NOT a claim that nothing else is wrong: npm short-circuits on the ` +
          `first unresolvable name, so a second defect behind it would be invisible here.`,
      };
    }
    if (unexplained.length > 0) {
      return {
        verdict: "undeclared-absent-dependency",
        failing: true,
        reason:
          `The packed tarball failed to install into a clean directory, and the allowance does ` +
          `not account for ${unexplained.length} absent dependency name(s): ` +
          unexplained.map((u) => `${u.name} (${u.why})`).join("; ") +
          `. The allowance is exact by design: an absence nobody declared is a finding.`,
      };
    }
    return {
      verdict: "uninstallable",
      failing: true,
      reason:
        `The packed tarball failed to install into a clean directory, and every dependency name ` +
        `it declares is present on the registry. The failure is in this package's own tree, and ` +
        `publishing it would put a permanently uninstallable version on the registry.`,
    };
  }

  if (entryFailures.length > 0) {
    return {
      verdict: "uninstallable",
      failing: true,
      reason:
        `The packed tarball installs, but what it declares does not work from a clean install: ` +
        entryFailures.join("; "),
    };
  }

  return {
    verdict: "pass",
    failing: false,
    reason:
      entryPointsProbed.length > 0
        ? `Packed, installed into a clean anonymous directory from the tarball, and everything it ` +
          `declares loads (${entryPointsProbed.join(", ")}).`
        : `Packed and installed into a clean anonymous directory from the tarball. It declares no ` +
          `entry point and no bin, so nothing beyond the install itself was asserted.`,
  };
}

// ── What the manifest promises the tarball will contain ─────────────────────────────────────────

/**
 * The files a consumer's resolver will reach for, read out of the manifest rather than guessed.
 * `exports` is walked to arbitrary depth because a conditional map nests, and only string leaves
 * that look like relative paths are taken — a leaf that is `null` is a deliberate block, not a file.
 * @param {Record<string, any>} manifest
 */
export function declaredFiles(manifest) {
  /** @type {Set<string>} */
  const files = new Set();
  // A LEADING `./` IS OPTIONAL IN `main`/`module`/`types`/`bin`, AND REQUIRING ONE IS A KNOWN
  // DEFECT IN THIS ORG'S OWN TOOLING, NOT A HYPOTHETICAL. The `attw` preflight shipped with exactly
  // this blind spot and three repos closed it independently (`cli#25` disclosed it, `fhir#49` and
  // `hl7#78` fixed it). A path filter that quietly drops a legal spelling does not produce a false
  // red — it produces a package with NO entry point asserted at all, which reads as a pass.
  const take = (value) => {
    if (typeof value !== "string") return;
    const v = value.trim();
    // A protocol (`node:`, `https:`) or an absolute path is not a file inside the tarball.
    if (!v || v.includes(":") || v.startsWith("/")) return;
    files.add(v.replace(/^\.\//, ""));
  };
  for (const key of ["main", "module", "types", "typings"]) take(manifest?.[key]);
  const walk = (node, depth = 0) => {
    if (depth > 8 || !node) return;
    if (typeof node === "string") return take(node);
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    if (typeof node === "object") for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(manifest?.exports);
  const bin = manifest?.bin;
  if (typeof bin === "string") take(bin);
  else if (bin && typeof bin === "object") for (const v of Object.values(bin)) take(v);
  return [...files].sort();
}

/** Which of `declaredFiles` are absent from a listing. Pure, so the tarball read stays substitutable. */
export function absentFrom(declared, present) {
  const set = new Set(present.map((p) => p.replace(/^\.\//, "")));
  return declared.filter((f) => !set.has(f));
}

/** Tarball entries that came from this gate's own checkout. */
export function toolingEntries(present) {
  return present.filter((p) => p === TOOLING_DIR || p.startsWith(`${TOOLING_DIR}/`));
}

// ── npm pack ────────────────────────────────────────────────────────────────────────────────────

// `npm pack --json` DOES NOT GUARANTEE THAT STDOUT IS ONLY JSON, and this is measured rather than
// defensive. Running it in this org's own trees at `--loglevel error` produced a leading
// `[ERROR], Was not able to set git hooks. Error: ... EACCES ...` line on stdout, from a package in
// the tree, ahead of the document. A plain `JSON.parse` of stdout then throws, and because this file
// fails CLOSED that throw is a RED pull request on a package with nothing wrong with it.
//
// "Slice from the first bracket" is the obvious fix and it is wrong: that prefix line STARTS with
// `[`. So the candidate starts are the document boundaries npm's pretty-printer actually produces —
// the beginning, and every line that opens with `[` or `{` — and the first one that parses into
// something carrying a `filename` wins. A prefix that happens to be valid JSON without a filename is
// skipped rather than accepted.
// The scan takes EVERY bracket as a candidate start, not only one that opens a line, and extracts a
// BALANCED span rather than slicing to the end of the buffer. Both matter and neither is theoretical
// for a gate that fails closed: a prefix without a trailing newline hides the document from a
// line-anchored scan, and ANY trailing noise (a `postpack` script's output, an npm notice) makes a
// slice-to-the-end `JSON.parse` throw. Either one is a red pull request on a package with nothing
// wrong with it.
/** @param {string} stdout */
export function parsePackJson(stdout) {
  const text = String(stdout ?? "");
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start];
    if (open !== "[" && open !== "{") continue;
    const end = balancedEnd(text, start);
    if (end < 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(text.slice(start, end));
    } catch {
      continue;
    }
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    if (entry?.filename) return entry;
  }
  throw new Error(
    `npm pack --json produced no document naming a tarball. First 400 characters of its output: ` +
      text.slice(0, 400),
  );
}

/**
 * Index just past the bracket that closes the one at `start`, or -1. String and escape aware, so a
 * bracket inside a filename does not unbalance the span.
 */
function balancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Pack the working tree and report the tarball path plus the exact file list npm put in it. Uses
 * `--json`, so the listing is npm's own answer rather than this file re-deriving `files`/`.npmignore`
 * semantics: a check that recomputes the thing it checks will agree with it forever.
 */
export async function packTree({
  repo,
  destination,
  npmBin = "npm",
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
}) {
  const result = await runCommand(
    npmBin,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination, "--loglevel", "error"],
    { cwd: repo, timeoutMs },
  );
  if (result.code !== 0) {
    throw new Error(`npm pack exited ${result.code}: ${`${result.out}\n${result.err}`.trim()}`);
  }
  const entry = parsePackJson(result.out);
  return {
    tarball: path.join(destination, path.basename(entry.filename)),
    files: (entry.files || []).map((f) => String(f?.path ?? f)),
  };
}

/** Install a tarball PATH into a clean room. Resolves, never rejects. */
export async function installTarball({
  dir,
  tarball,
  registry,
  npmBin = "npm",
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
}) {
  // `--ignore-scripts` for the same reason and with the same residual as the post-publish probe: it
  // narrows what a transitive dependency can run on a runner, and it means a native dependency is
  // left unbuilt so the entry probe below could fail on a package that is fine for consumers.
  // Measured empty today across every installable tree. The full account is the README's, not a
  // second copy here.
  const result = await runCommand(
    npmBin,
    ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel", "error"],
    { cwd: dir, env: cleanRoomEnv(dir, registry), timeoutMs },
  );
  return { ok: result.code === 0, code: result.code, output: `${result.out}\n${result.err}`.trim() };
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read a repo's manifest. Throws rather than defaulting: a missing manifest is not a pass. */
export async function readManifest(repo) {
  return JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
}

/**
 * LAYER 1, whole. Trivial by design — the value is that it is offline, so it can run before
 * `pnpm install` and cost a caller nothing.
 */
export async function runManifestLayer({ repo, allowanceRaw, manifest }) {
  const m = manifest ?? (await readManifest(repo));
  const { entries, malformed } = parseDeclaredAllowance(allowanceRaw);
  return {
    layer: "manifest",
    package: m?.name,
    // Carried even though this layer never consults it, so that the summary's untagged nag has
    // somewhere to fire. It is the layer that is ON BY DEFAULT; leaving the allowance off its result
    // made the nag dead in the shipped configuration, which is the "reported so it can be tightened"
    // promise being made by a line of prose and nothing else.
    allowance: entries,
    ...classifyManifest({ manifest: m, malformedAllowance: malformed }),
  };
}

/**
 * LAYER 2, whole. Dependencies are injected so the taxonomy, the retry and the allowance can all be
 * driven against fakes with no network and no npm.
 */
export async function runPackLayer({
  repo,
  allowanceRaw,
  registry = DEFAULT_REGISTRY,
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  tempParent = process.env.RUNNER_TEMP || tmpdir(),
  fetchImpl = globalThis.fetch,
  npmBin = "npm",
  pack = packTree,
  install = installTarball,
  probe = probeEntryPoints,
  statOnDisk = stat,
  log = () => {},
}) {
  const manifest = await readManifest(repo);
  const { entries: allowance, malformed } = parseDeclaredAllowance(allowanceRaw);
  const base = { layer: "pack", package: manifest?.name, allowance, staleAllowance: [] };

  if (malformed.length > 0) return { ...base, ...classifyPack({ malformedAllowance: malformed }) };
  if (manifest?.private === true) {
    return {
      ...base,
      verdict: "not-published",
      failing: false,
      reason:
        "The manifest declares `private: true`, so nothing is ever published and there is no " +
        "consumer install to simulate. Nothing was asserted about this tree.",
    };
  }

  // Asked here rather than left to layer 1's step, so the ordering property holds whatever a caller
  // does with the two inputs. See `classifyPack`.
  const specifierFindings = findNonRegistrySpecifiers(manifest);
  if (specifierFindings.length > 0) return { ...base, ...classifyPack({ specifierFindings }) };

  const declared = declaredFiles(manifest);
  const missingFromTree = [];
  for (const file of declared) {
    try {
      const info = await statOnDisk(path.join(repo, file));
      if (!info.isFile()) missingFromTree.push(file);
    } catch {
      missingFromTree.push(file);
    }
  }
  if (missingFromTree.length > 0) return { ...base, ...classifyPack({ missingFromTree }) };

  const work = await mkdtemp(path.join(tempParent, "cosyte-prepublish-"));
  try {
    log(`packing ${manifest.name} from ${repo}`);
    const packed = await pack({ repo, destination: work, npmBin });
    log(`packed ${path.basename(packed.tarball)} (${packed.files.length} file(s))`);

    const toolingInTarball = toolingEntries(packed.files);
    if (toolingInTarball.length > 0) return { ...base, ...classifyPack({ toolingInTarball }) };
    const missingFromTarball = absentFrom(declared, packed.files);
    if (missingFromTarball.length > 0) return { ...base, ...classifyPack({ missingFromTarball }) };

    const boundedFetch = withFetchTimeout(fetchImpl, fetchTimeoutMs);
    const declaredNames = consumerDependencyNames(manifest);
    let last = null;

    // RETRY THE WHOLE ATTEMPT, BOUNDED AND SMALL. Two attempts, not the post-publish gate's eight:
    // that ladder exists because the org publishes in WAVES and a sibling published seconds ago is
    // genuinely unpropagated. Nothing is being published here, so the only thing a retry buys is
    // insurance against a single transient fault turning into a red people learn to ignore. An
    // absence the allowance has already settled is not retried — the allowance is a statement that
    // it is standing rather than transient, so re-asking cannot change the answer.
    const budget = Math.max(1, attempts);
    for (let attempt = 1; attempt <= budget; attempt += 1) {
      const dir = await makeCleanRoom(work);
      const installed = await install({ dir, tarball: packed.tarball, registry, npmBin });
      if (installed.ok) {
        const { failures, probed } = await probe({ dir, name: manifest.name });
        last = {
          ...base,
          installOutput: installed.output,
          ...classifyPack({ installOk: true, entryFailures: failures, entryPointsProbed: probed, allowance }),
          entryPointsProbed: probed,
          // A successful install is proof that nothing this package declares is blocking, so every
          // allowance entry naming one of its dependencies is spent. Derived from the install
          // rather than from a second registry sweep, which would ask a question already answered.
          staleAllowance: staleAllowance(allowance, { presentNames: declaredNames, declaredNames }),
        };
        break;
      }

      /** @type {string[]} */
      const absent = [];
      /** @type {string[]} */
      const unknown = [];
      /** @type {string[]} */
      const present = [];
      for (const name of declaredNames) {
        const status = await dependencyStatus(registry, name, boundedFetch);
        if (status === "absent") absent.push(name);
        else if (status === "unknown") unknown.push(name);
        else present.push(name);
      }
      last = {
        ...base,
        installOutput: installed.output,
        ...classifyPack({
          installOk: false,
          absentDependencies: absent,
          unknownDependencies: unknown,
          allowance,
        }),
        staleAllowance: staleAllowance(allowance, { presentNames: present, declaredNames }),
      };
      // Settled by the allowance: re-asking cannot change it, so spend no more of the run's time.
      if (last.verdict === "blocked-peer") break;
      if (attempt < budget) {
        log(`attempt ${attempt} of ${budget} settled ${last.verdict}; retrying in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }
    return last;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────────────────────────

export function renderSummary(result) {
  const icon = result.failing ? "❌" : result.verdict === "pass" ? "✅" : "⚠️";
  const lines = [
    `### ${icon} Pre-publish ${result.layer} layer — \`${result.verdict}\``,
    "",
    `**${result.package ?? "(unnamed package)"}** — ${result.reason}`,
  ];
  const untagged = (result.allowance ?? []).filter((e) => !e.tagged);
  if (untagged.length > 0) {
    lines.push(
      "",
      `> **Untagged allowance entries:** ${untagged.map((e) => e.name).join(", ")}. These are read ` +
        `as \`=blocked\`. Write them as \`<name>=blocked\` or \`<name>=private\` so a temporary ` +
        `block and a deliberate absence stop sharing words.`,
    );
  }
  if ((result.staleAllowance ?? []).length > 0) {
    lines.push(
      "",
      `> **The declared allowance is stale.** ` +
        result.staleAllowance.map((s) => `\`${s.name}\` ${s.why}`).join("; ") +
        `. Delete the entry.`,
    );
  }
  return lines.join("\n");
}

export function renderAnnotation(result) {
  if (!result.failing) return "";
  const title = `Pre-publish ${result.layer} layer: ${result.verdict}`;
  return `::error title=${title}::${String(result.reason).replace(/\n/g, " ")}`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

const USAGE =
  "usage: prepublish-check.mjs <manifest|pack> [--repo DIR]\n" +
  '                            [--expect-unpublished-deps "@scope/a=blocked,@scope/b=private"]\n' +
  "                            [--registry URL] [--attempts N] [--delay-ms N]\n" +
  "                            [--summary FILE] [--json FILE]\n";

export async function main(argv) {
  const layer = argv.find((a) => !a.startsWith("--"));
  const args = parseArgs(argv);
  if (layer !== "manifest" && layer !== "pack") {
    process.stderr.write(USAGE);
    return 2;
  }
  const repo = path.resolve(args.repo || ".");
  const allowanceRaw = args["expect-unpublished-deps"];
  const result =
    layer === "manifest"
      ? await runManifestLayer({ repo, allowanceRaw })
      : await runPackLayer({
          repo,
          allowanceRaw,
          registry: args.registry || DEFAULT_REGISTRY,
          attempts: numericOption(args.attempts, DEFAULT_ATTEMPTS, { min: 1 }),
          delayMs: numericOption(args["delay-ms"], DEFAULT_DELAY_MS),
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

// FAIL CLOSED ON ANYTHING UNFORESEEN, WHICH IS THE OPPOSITE OF `install-check.mjs` AND DELIBERATE.
// There a crash must never red a permanent, already-published release, so it warns and exits 0.
// Here nothing has been published, a red pull-request check costs a re-run, and a pre-publish gate
// that swallows its own crash is a gate that is not there.
const isEntryPoint =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stdout.write(
        `::error title=Pre-publish gate did not complete::The gate crashed before reaching a ` +
          `verdict, so installability was NOT checked: ${error?.message}\n`,
      );
      process.stdout.write(`${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
