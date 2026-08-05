// Unit tests for the two PRE-PUBLISH layers.
//
// Zero dependencies and no network: `node:test` + `node:assert` only, matching the rest of this
// repo. Every I/O the pack layer performs is injected, so the taxonomy, the retry and — above all —
// the DECLARED ALLOWANCE are driven here against fakes.
//
// The allowance is the reason this file is long. It is a mechanism whose entire job is to EXCUSE a
// failure, and an excuse that is wider than it looks is worse than no gate, because it reads as a
// gate. So every route through it is taken: the absence it excuses, the absence it refuses, the
// kind that never excuses a publishable package, the untagged spelling `release.yml` already ships,
// and the malformed entry that must not be silently narrowed away.
//
// The manifests below are transcribed from the live working trees on 2026-08-05, and the registry
// state they assume was re-derived the same day with `npm view`: `@cosyte/fhir` 404, `@cosyte/hl7`
// 0.0.8, `@cosyte/assets` and `@cosyte/docs` 404 and `private: true` BY DESIGN.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ALLOWANCE_KINDS,
  MANIFEST_VERDICTS,
  PACK_VERDICTS,
  TOOLING_DIR,
  absentFrom,
  allowanceExcuses,
  classifyManifest,
  classifyPack,
  declaredFiles,
  main,
  parseDeclaredAllowance,
  parsePackJson,
  renderAnnotation,
  renderSummary,
  runManifestLayer,
  runPackLayer,
  staleAllowance,
  toolingEntries,
  unexplainedAbsences,
} from "../scripts/prepublish-check.mjs";
import { parseAllowance } from "../scripts/install-check.mjs";

// ── Fixtures, transcribed from the live working trees ───────────────────────────────────────────

// What `@cosyte/cli`'s manifest looked like at the moment it published 0.0.1 permanently
// uninstallable. Layer 1 is the gate that would have refused it.
const CLI_AT_0_0_1 = {
  name: "@cosyte/cli",
  version: "0.0.1",
  dependencies: {
    "@cosyte/hl7": "file:vendor/cosyte-hl7-0.0.0.tgz",
    "@cosyte/fhir": "file:vendor/cosyte-fhir-0.0.0.tgz",
    "@cosyte/transform": "file:vendor/cosyte-transform-0.0.0.tgz",
    "@cosyte/terminology": "file:vendor/cosyte-terminology-0.0.1.tgz",
  },
  optionalDependencies: {
    "@cosyte/x12": "file:vendor/cosyte-x12-0.0.1.tgz",
    "@modelcontextprotocol/sdk": "1.29.0",
  },
};

// `@cosyte/cli` today: real registry ranges in the consumer fields, and the `file:vendor/*.tgz`
// specifiers moved to `devDependencies`, which no consumer ever installs.
const CLI_TODAY = {
  name: "@cosyte/cli",
  version: "0.0.4",
  dependencies: { "@cosyte/hl7": "^0.0.7", "@cosyte/terminology": "^0.0.9" },
  optionalDependencies: { "@cosyte/x12": "^0.0.8", "@modelcontextprotocol/sdk": "1.29.0" },
  devDependencies: { "@cosyte/fhir": "file:vendor/cosyte-fhir-0.0.0.tgz", tsup: "8.5.1" },
};

const TRANSFORM = {
  name: "@cosyte/transform",
  version: "0.0.6",
  dependencies: {},
  peerDependencies: { "@cosyte/fhir": ">=0.0.0", "@cosyte/hl7": ">=0.0.0" },
  main: "./dist/index.cjs",
  module: "./dist/index.mjs",
  types: "./dist/index.d.ts",
};

// ── The allowance grammar ───────────────────────────────────────────────────────────────────────

test("an untagged entry is accepted and read as blocked, which is the spelling release.yml ships", () => {
  const { entries, malformed } = parseDeclaredAllowance("@cosyte/fhir");
  assert.deepEqual(malformed, []);
  assert.deepEqual(entries, [{ name: "@cosyte/fhir", kind: "blocked", tagged: false }]);
});

test("a tagged entry carries its kind, and both kinds parse", () => {
  const { entries, malformed } = parseDeclaredAllowance("@cosyte/fhir=blocked, @cosyte/assets=private");
  assert.deepEqual(malformed, []);
  assert.deepEqual(
    entries.map((e) => [e.name, e.kind, e.tagged]),
    [
      ["@cosyte/assets", "private", true],
      ["@cosyte/fhir", "blocked", true],
    ],
  );
});

test("commas, whitespace and newlines all separate, and duplicates collapse", () => {
  const { entries } = parseDeclaredAllowance("  @cosyte/fhir=blocked,\n@cosyte/fhir , @cosyte/docs=private ");
  assert.deepEqual(entries.map((e) => e.name), ["@cosyte/docs", "@cosyte/fhir"]);
});

test("an empty or absent allowance is empty, not an error", () => {
  for (const raw of [undefined, "", "   ", ",,, "]) {
    const { entries, malformed } = parseDeclaredAllowance(raw);
    assert.deepEqual(entries, []);
    assert.deepEqual(malformed, []);
  }
});

test("an unknown kind is malformed rather than silently ignored", () => {
  const { entries, malformed } = parseDeclaredAllowance("@cosyte/fhir=pending");
  assert.deepEqual(entries, []);
  assert.equal(malformed.length, 1);
  assert.match(malformed[0], /not one of blocked, private/);
});

test("a kind with no name, and more than one '=', are both malformed", () => {
  assert.match(parseDeclaredAllowance("=blocked").malformed[0], /no package name/);
  assert.match(parseDeclaredAllowance("a=b=c").malformed[0], /more than one/);
});

// De-duplicating on the NAME alone keeps whichever kind was written first, so a second, narrower
// entry silently WIDENS the allowance. The argument for failing on a typo is symmetric.
test("one name written twice with different kinds is malformed, not last-wins or first-wins", () => {
  const { entries, malformed } = parseDeclaredAllowance("@cosyte/a=blocked,@cosyte/a=private");
  assert.equal(malformed.length, 1);
  assert.match(malformed[0], /named twice with different kinds/);
  assert.deepEqual(entries.map((e) => e.name), ["@cosyte/a"]);
});

test("an exact duplicate collapses silently, because it says nothing new", () => {
  const { entries, malformed } = parseDeclaredAllowance("@cosyte/a=blocked, @cosyte/a=blocked");
  assert.deepEqual(malformed, []);
  assert.equal(entries.length, 1);
});

// The untagged spelling and `=blocked` mean the same thing, so pairing them is not a contradiction.
test("untagged plus =blocked for one name is not a conflict", () => {
  assert.deepEqual(parseDeclaredAllowance("@cosyte/fhir, @cosyte/fhir=blocked").malformed, []);
});

test("ALLOWANCE_KINDS is the list the parser actually enforces, not a restated one", () => {
  for (const kind of ALLOWANCE_KINDS) {
    assert.deepEqual(parseDeclaredAllowance(`@cosyte/x=${kind}`).malformed, []);
  }
  assert.equal(parseDeclaredAllowance("@cosyte/x=notakind").malformed.length, 1);
});

// ONE GRAMMAR, TWO GATES, AND ONLY ONE KIND IS STRIPPED. `install-check.mjs` reads the same input
// string and must not start seeing "@cosyte/fhir=blocked" as a package literally named that. It must
// ALSO not start excusing `=private`, which is the kind defined as "must not excuse a package that
// publishes" — and the post-publish gate only ever observes packages that published. Stripping every
// tag was written first and was wrong in exactly that direction.
test("the post-publish gate strips =blocked and ONLY =blocked", () => {
  assert.deepEqual(parseAllowance("@cosyte/fhir=blocked"), ["@cosyte/fhir"]);
  assert.deepEqual(parseAllowance("@cosyte/fhir"), ["@cosyte/fhir"]);
  // Left attached, so it matches no dependency name and excuses nothing — byte-for-byte what this
  // function did before tags existed.
  assert.deepEqual(parseAllowance("@cosyte/assets=private"), ["@cosyte/assets=private"]);
  assert.deepEqual(parseAllowance("@cosyte/fhir=pending"), ["@cosyte/fhir=pending"]);
});

// The claim that carries the whole tag design: for the ONE kind both gates honour, the tagged and
// untagged spellings are indistinguishable to the post-publish gate.
test("=blocked is behaviour-identical to the untagged spelling release.yml shipped with", () => {
  for (const raw of ["@cosyte/fhir", "@cosyte/fhir=blocked", " @cosyte/fhir=blocked , @cosyte/fhir "]) {
    assert.deepEqual(parseAllowance(raw), ["@cosyte/fhir"], raw);
  }
});

// ── What the allowance does and does not excuse ─────────────────────────────────────────────────

// EXACTLY ONE KIND EXCUSES ANYTHING. An earlier draft let `private` excuse "a package that is itself
// private", which reads reasonable and is UNREACHABLE — a private manifest settles `not-published`
// before anything is installed — so it was a behaviour only a test could ever exhibit.
test("blocked excuses; private excuses nothing, anywhere", () => {
  assert.equal(allowanceExcuses({ kind: "blocked" }), true);
  assert.equal(allowanceExcuses({ kind: "private" }), false);
  for (const kind of ALLOWANCE_KINDS) assert.equal(allowanceExcuses({ kind }), kind === "blocked");
});

// THE POINT OF THE KINDS. `@cosyte/fhir` and `@cosyte/assets` are both 404 and the difference is
// invisible to the registry: one is a block expected to clear, the other is a deliberate absence
// that never will. Naming a `private` package cannot make depending on it "the expected state".
test("a 404 that is deliberate and a 404 that is a block do not share words", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir=blocked,@cosyte/assets=private");
  const unexplained = unexplainedAbsences(["@cosyte/fhir", "@cosyte/assets"], entries);
  assert.deepEqual(unexplained.map((u) => u.name), ["@cosyte/assets"]);
  assert.match(unexplained[0].why, /absent by design and never going to clear/);
});

test("an absence nobody declared is a finding — the allowance is exact, not a mute", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir=blocked");
  const unexplained = unexplainedAbsences(["@cosyte/fhir", "@cosyte/somethingnew"], entries);
  assert.deepEqual(unexplained.map((u) => u.name), ["@cosyte/somethingnew"]);
  assert.match(unexplained[0].why, /not named in the allowance at all/);
});

test("an allowance that covers every absence leaves nothing unexplained", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir=blocked");
  assert.deepEqual(unexplainedAbsences(["@cosyte/fhir"], entries), []);
});

test("an entry whose package is on the registry, or is not a dependency here, reads stale", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir=blocked,@cosyte/hl7=blocked,@cosyte/nope=blocked");
  const stale = staleAllowance(entries, {
    presentNames: ["@cosyte/hl7"],
    declaredNames: ["@cosyte/fhir", "@cosyte/hl7"],
  });
  assert.deepEqual(stale.map((s) => s.name), ["@cosyte/hl7", "@cosyte/nope"]);
  assert.match(stale[0].why, /on the registry now/);
  assert.match(stale[1].why, /not a consumer dependency/);
});

// `null` is UNKNOWN and `[]` is KNOWN-EMPTY. A `length > 0` guard collapses the two and then
// declines to report a dead entry on exactly the package where it is most obviously dead.
test("staleness is not asserted when the dependency list is unknown, and IS when it is empty", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir=blocked");
  assert.deepEqual(staleAllowance(entries, { presentNames: [] }), []);
  assert.deepEqual(
    staleAllowance(entries, { presentNames: [], declaredNames: [] }).map((s) => s.name),
    ["@cosyte/fhir"],
  );
});

// ── Layer 1: the manifest lint ──────────────────────────────────────────────────────────────────

test("layer 1 refuses @cosyte/cli as it was when it published 0.0.1", () => {
  const r = classifyManifest({ manifest: CLI_AT_0_0_1 });
  assert.equal(r.verdict, "non-registry-specifier");
  assert.equal(r.failing, true);
  assert.equal(r.findings.length, 5);
  assert.match(r.reason, /dependencies\.@cosyte\/hl7="file:vendor\/cosyte-hl7-0\.0\.0\.tgz"/);
  assert.match(r.reason, /optionalDependencies\.@cosyte\/x12=/);
});

// The load-bearing half of "this reds nobody today": seven repos still carry `file:vendor/*.tgz`,
// all of them in devDependencies, which a consumer never installs.
test("layer 1 passes @cosyte/cli today, with file: specifiers still in devDependencies", () => {
  const r = classifyManifest({ manifest: CLI_TODAY });
  assert.equal(r.verdict, "pass");
  assert.equal(r.failing, false);
  assert.deepEqual(r.findings, []);
});

test("layer 1 passes transform and synth, whose peers are ordinary registry ranges", () => {
  assert.equal(classifyManifest({ manifest: TRANSFORM }).verdict, "pass");
  assert.equal(
    classifyManifest({
      manifest: { name: "@cosyte/synth", peerDependencies: { "@cosyte/fhir": ">=0.0.0" } },
    }).verdict,
    "pass",
  );
});

test("layer 1 refuses workspace:, link:, git and the GitHub owner/repo shorthand", () => {
  for (const spec of ["workspace:*", "link:../hl7", "git+ssh://git@github.com/cosyte/hl7.git", "cosyte/hl7"]) {
    const r = classifyManifest({ manifest: { name: "x", dependencies: { "@cosyte/hl7": spec } } });
    assert.equal(r.verdict, "non-registry-specifier", spec);
  }
});

test("layer 1 accepts an npm: alias and a dist-tag", () => {
  const r = classifyManifest({
    manifest: { name: "x", dependencies: { a: "npm:@cosyte/hl7@^0.0.7", b: "latest", c: "*" } },
  });
  assert.equal(r.verdict, "pass");
});

test("layer 1 says out loud that it asserted nothing about a private package", () => {
  const r = classifyManifest({ manifest: { name: "x", private: true, dependencies: { a: "file:./a" } } });
  assert.equal(r.verdict, "not-published");
  assert.equal(r.failing, false);
  assert.match(r.reason, /Nothing was asserted/);
});

// A typo in the thing that EXCUSES failures must not narrow it silently.
test("a malformed allowance fails layer 1 before anything else is looked at", () => {
  const r = classifyManifest({ manifest: CLI_AT_0_0_1, malformedAllowance: ['"x=y" bad'] });
  assert.equal(r.verdict, "malformed-allowance");
  assert.equal(r.failing, true);
});

test("MANIFEST_VERDICTS is asserted against what classifyManifest actually produces", () => {
  const produced = new Set([
    classifyManifest({ manifest: CLI_TODAY }).verdict,
    classifyManifest({ manifest: CLI_AT_0_0_1 }).verdict,
    classifyManifest({ manifest: { private: true } }).verdict,
    classifyManifest({ manifest: {}, malformedAllowance: ["x"] }).verdict,
  ]);
  assert.deepEqual([...produced].sort(), [...MANIFEST_VERDICTS].sort());
});

// ── What the manifest promises the tarball will contain ─────────────────────────────────────────

test("declaredFiles reads main/module/types, a nested exports map and every bin", () => {
  assert.deepEqual(
    declaredFiles({
      main: "./dist/index.cjs",
      module: "./dist/index.mjs",
      types: "./dist/index.d.ts",
      exports: {
        ".": { import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" }, require: "./dist/index.cjs" },
        "./profiles": "./dist/profiles.mjs",
      },
      bin: { cosyte: "./dist/bin/cosyte.mjs" },
    }),
    [
      "dist/bin/cosyte.mjs",
      "dist/index.cjs",
      "dist/index.d.mts",
      "dist/index.d.ts",
      "dist/index.mjs",
      "dist/profiles.mjs",
    ],
  );
});

test("declaredFiles ignores a null exports leaf, which is a deliberate block and not a file", () => {
  assert.deepEqual(declaredFiles({ exports: { ".": "./dist/index.mjs", "./internal": null } }), [
    "dist/index.mjs",
  ]);
});

// A LEADING `./` IS OPTIONAL AND LEGAL. This org's `attw` preflight shipped requiring one, and
// three repos closed that same blind spot independently. Dropping a legal spelling here does not
// red anything — it asserts NOTHING about the entry point and reads as a pass.
test("declaredFiles takes a bin and an entry point written without a leading ./", () => {
  assert.deepEqual(declaredFiles({ bin: "cli.mjs", main: "index.js" }), ["cli.mjs", "index.js"]);
});

test("declaredFiles ignores anything that is not a path inside the tarball", () => {
  assert.deepEqual(declaredFiles({ main: "node:fs", module: "/abs/x.mjs", types: "  " }), []);
});

// MEASURED, NOT DEFENSIVE. `npm pack --json --loglevel error` in this org's own trees emitted this
// exact line on stdout ahead of the document. Because this gate fails CLOSED, a naive `JSON.parse`
// turns that into a red pull request on a package with nothing wrong with it.
const PACK_NOISE = "[ERROR], Was not able to set git hooks. Error: Error: EACCES: permission denied\n";
const PACK_DOC = `[\n  {\n    "filename": "cosyte-hl7-0.0.8.tgz",\n    "files": [{ "path": "dist/index.mjs" }]\n  }\n]\n`;

test("pack output is read past a prefix line that itself starts with '['", () => {
  const entry = parsePackJson(PACK_NOISE + PACK_DOC);
  assert.equal(entry.filename, "cosyte-hl7-0.0.8.tgz");
  assert.deepEqual(entry.files, [{ path: "dist/index.mjs" }]);
});

test("clean pack output parses, and so does a bare object rather than an array", () => {
  assert.equal(parsePackJson(PACK_DOC).filename, "cosyte-hl7-0.0.8.tgz");
  assert.equal(parsePackJson(`{ "filename": "a.tgz" }`).filename, "a.tgz");
});

test("a prefix that is valid JSON but names no tarball is skipped, not accepted", () => {
  assert.equal(parsePackJson(`[{"warning":"x"}]\n${PACK_DOC}`).filename, "cosyte-hl7-0.0.8.tgz");
});

// Both of these throw with a line-anchored, slice-to-the-end parser, and because this gate fails
// CLOSED a throw is a red pull request on a good package.
test("noise AFTER the document does not hide it", () => {
  assert.equal(parsePackJson(`${PACK_DOC}npm notice New major version of npm available!\n`).filename, "cosyte-hl7-0.0.8.tgz");
  assert.equal(parsePackJson(PACK_NOISE + PACK_DOC + "trailing\n").filename, "cosyte-hl7-0.0.8.tgz");
});

test("a prefix that does not end in a newline does not hide the document", () => {
  assert.equal(parsePackJson(`warning: [something] ${PACK_DOC}`).filename, "cosyte-hl7-0.0.8.tgz");
});

test("a bracket inside a filename does not unbalance the span", () => {
  const doc = `[{ "filename": "weird[name].tgz", "files": [{ "path": "a}b" }] }]`;
  assert.equal(parsePackJson(`noise ${doc} more`).filename, "weird[name].tgz");
});

test("output with no tarball document anywhere throws rather than returning something empty", () => {
  assert.throws(() => parsePackJson("npm error code E404\n"), /no document naming a tarball/);
  assert.throws(() => parsePackJson(""), /no document naming a tarball/);
  assert.throws(() => parsePackJson("[unterminated"), /no document naming a tarball/);
});

test("absentFrom normalises the ./ prefix on both sides", () => {
  assert.deepEqual(absentFrom(["dist/index.mjs"], ["./dist/index.mjs"]), []);
  assert.deepEqual(absentFrom(["dist/index.mjs"], ["README.md"]), ["dist/index.mjs"]);
});

test("toolingEntries catches the gate's own checkout and nothing that merely resembles it", () => {
  assert.deepEqual(toolingEntries([`${TOOLING_DIR}/scripts/x.mjs`, "dist/index.mjs"]), [
    `${TOOLING_DIR}/scripts/x.mjs`,
  ]);
  assert.deepEqual(toolingEntries([`${TOOLING_DIR}-other/x`]), []);
});

// ── Layer 2: the taxonomy ───────────────────────────────────────────────────────────────────────

test("a clean install with everything loading passes and names what it probed", () => {
  const r = classifyPack({ installOk: true, entryPointsProbed: ["esm", "cjs"] });
  assert.equal(r.verdict, "pass");
  assert.equal(r.failing, false);
  assert.match(r.reason, /esm, cjs/);
});

test("a package with no entry point and no bin passes, and says nothing more was asserted", () => {
  const r = classifyPack({ installOk: true, entryPointsProbed: [] });
  assert.equal(r.verdict, "pass");
  assert.match(r.reason, /nothing beyond the install itself was asserted/);
});

// "You forgot to build" and "your files field drops dist" are the same absence in the tarball and
// different defects in the world. Collapsing them would blame thirteen repos for this workflow.
test("a declared entry point absent from the TREE is not-built, and blames this workflow", () => {
  const r = classifyPack({ missingFromTree: ["dist/index.mjs"] });
  assert.equal(r.verdict, "not-built");
  assert.equal(r.failing, true);
  assert.match(r.reason, /not the package's/);
});

test("a declared entry point present on disk and absent from the tarball is not-packed", () => {
  const r = classifyPack({ missingFromTarball: ["dist/index.d.ts"] });
  assert.equal(r.verdict, "not-packed");
  assert.equal(r.failing, true);
  assert.match(r.reason, /"files" field or \.npmignore/);
});

test("the gate's own checkout landing in the tarball is refused, not measured around", () => {
  const r = classifyPack({ toolingInTarball: [`${TOOLING_DIR}/scripts/prepublish-check.mjs`] });
  assert.equal(r.verdict, "tooling-in-tarball");
  assert.equal(r.failing, true);
});

// THE BLOCKER THE ITEM WAS FILED FOR. transform and synth are genuinely uninstallable today, and a
// gate that reds them for it is a gate people learn to ignore.
test("an install failure fully explained by a declared block warns rather than failing", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir=blocked");
  const r = classifyPack({ installOk: false, absentDependencies: ["@cosyte/fhir"], allowance: entries });
  assert.equal(r.verdict, "blocked-peer");
  assert.equal(r.failing, false);
  assert.match(r.reason, /expected state rather than a regression/);
});

test("an absent dependency the allowance does not name still fails", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir=blocked");
  const r = classifyPack({
    installOk: false,
    absentDependencies: ["@cosyte/fhir", "@cosyte/newthing"],
    allowance: entries,
  });
  assert.equal(r.verdict, "undeclared-absent-dependency");
  assert.equal(r.failing, true);
  assert.match(r.reason, /@cosyte\/newthing/);
  assert.doesNotMatch(r.reason.replace(/@cosyte\/newthing.*/s, ""), /@cosyte\/fhir \(/);
});

test("a private-kind entry does not excuse a publishable package's install failure", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/assets=private");
  const r = classifyPack({ installOk: false, absentDependencies: ["@cosyte/assets"], allowance: entries });
  assert.equal(r.verdict, "undeclared-absent-dependency");
  assert.equal(r.failing, true);
});

// THE ORDERING PROPERTY, OWNED BY THE VERDICT FUNCTION RATHER THAN BY THE WORKFLOW'S STEP ORDER.
// `@cosyte/cli@0.0.1` is four `file:` specifiers AND a genuinely blocked `@cosyte/fhir`; classified
// after the install, the allowance excuses a package broken for a permanent, unrelated reason. When
// this lived only in `ci.yml`'s step order, a caller with `run-prepublish-manifest-lint: false` and
// `run-prepublish-install: true` got `blocked-peer` and exit 0 on exactly that shape.
test("a non-registry specifier outranks a fully-explained install failure", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir=blocked");
  const r = classifyPack({
    specifierFindings: [{ field: "dependencies", name: "@cosyte/hl7", spec: "file:vendor/x.tgz" }],
    installOk: false,
    absentDependencies: ["@cosyte/fhir"],
    allowance: entries,
  });
  assert.equal(r.verdict, "non-registry-specifier");
  assert.equal(r.failing, true);
  assert.match(r.reason, /never excusable by the allowance/);
});

test("only a malformed allowance outranks the specifier lint", () => {
  const r = classifyPack({
    malformedAllowance: ["x"],
    specifierFindings: [{ field: "dependencies", name: "a", spec: "file:./a" }],
  });
  assert.equal(r.verdict, "malformed-allowance");
});

// The registry not answering is not evidence about this package. This is the one place the
// post-publish gate's fail-open reasoning survives the flip to fail-closed.
test("an unanswered dependency is inconclusive, and outranks a declared absence", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir=blocked");
  const r = classifyPack({
    installOk: false,
    absentDependencies: ["@cosyte/fhir"],
    unknownDependencies: ["@cosyte/hl7"],
    allowance: entries,
  });
  assert.equal(r.verdict, "inconclusive");
  assert.equal(r.failing, false);
});

test("an install failure with every dependency present is the package's own defect", () => {
  const r = classifyPack({ installOk: false, absentDependencies: [], allowance: [] });
  assert.equal(r.verdict, "uninstallable");
  assert.equal(r.failing, true);
  assert.match(r.reason, /permanently uninstallable version on the registry/);
});

test("an install that succeeds but whose entry points do not load is uninstallable", () => {
  const r = classifyPack({ installOk: true, entryFailures: ["ESM entry point failed to load: boom"] });
  assert.equal(r.verdict, "uninstallable");
  assert.equal(r.failing, true);
});

test("PACK_VERDICTS is asserted against what classifyPack actually produces", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir=blocked");
  const produced = new Set([
    classifyPack({ installOk: true }).verdict,
    classifyPack({ malformedAllowance: ["x"] }).verdict,
    classifyPack({ specifierFindings: [{ field: "dependencies", name: "a", spec: "file:./a" }] }).verdict,
    classifyPack({ missingFromTree: ["a"] }).verdict,
    classifyPack({ missingFromTarball: ["a"] }).verdict,
    classifyPack({ toolingInTarball: ["a"] }).verdict,
    classifyPack({ installOk: false, absentDependencies: ["@cosyte/fhir"], allowance: entries }).verdict,
    classifyPack({ installOk: false, unknownDependencies: ["a"] }).verdict,
    classifyPack({ installOk: false, absentDependencies: ["zz"], allowance: entries }).verdict,
    classifyPack({ installOk: false }).verdict,
    "not-published",
  ]);
  assert.deepEqual([...produced].sort(), [...PACK_VERDICTS].sort());
});

// ── Reporting ───────────────────────────────────────────────────────────────────────────────────

test("only a failing verdict produces an error annotation, and it is one line", () => {
  assert.equal(renderAnnotation({ failing: false, layer: "pack", verdict: "pass" }), "");
  const a = renderAnnotation({ failing: true, layer: "pack", verdict: "uninstallable", reason: "a\nb" });
  assert.match(a, /^::error title=Pre-publish pack layer: uninstallable::a b$/);
});

test("the summary nags about an untagged entry rather than silently reading it as blocked", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir");
  const s = renderSummary({ layer: "pack", verdict: "blocked-peer", reason: "r", allowance: entries });
  assert.match(s, /Untagged allowance entries/);
  assert.match(s, /@cosyte\/fhir/);
});

test("a fully tagged allowance produces no untagged nag", () => {
  const { entries } = parseDeclaredAllowance("@cosyte/fhir=blocked");
  const s = renderSummary({ layer: "pack", verdict: "blocked-peer", reason: "r", allowance: entries });
  assert.doesNotMatch(s, /Untagged allowance entries/);
});

test("a stale allowance is reported in the summary so it gets deleted", () => {
  const s = renderSummary({
    layer: "pack",
    verdict: "pass",
    reason: "r",
    staleAllowance: [{ name: "@cosyte/fhir", why: "is on the registry now, so the allowance is spent" }],
  });
  assert.match(s, /The declared allowance is stale/);
  assert.match(s, /Delete the entry/);
});

// ── End to end, against a real tree on disk, with npm and the network faked ─────────────────────

async function scratchRepo(manifest, files = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "cosyte-prepublish-test-"));
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  }
  return dir;
}

test("layer 1 end to end reads the manifest off disk", async () => {
  const dir = await scratchRepo(CLI_AT_0_0_1);
  try {
    const r = await runManifestLayer({ repo: dir, allowanceRaw: "@cosyte/fhir=blocked" });
    assert.equal(r.verdict, "non-registry-specifier");
    assert.equal(r.package, "@cosyte/cli");
    assert.equal(r.layer, "manifest");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layer 1 refuses a repo with no manifest rather than passing it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cosyte-prepublish-test-"));
  try {
    await assert.rejects(() => runManifestLayer({ repo: dir }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The `transform` case, end to end: a real tree, a real declared allowance, a faked npm that fails
// the way npm actually fails, and a faked registry that 404s `@cosyte/fhir` and serves `@cosyte/hl7`.
test("layer 2 end to end warns on transform's declared block and never retries it", async () => {
  const dir = await scratchRepo(TRANSFORM, {
    "dist/index.cjs": "x",
    "dist/index.mjs": "x",
    "dist/index.d.ts": "x",
  });
  let installs = 0;
  try {
    const r = await runPackLayer({
      repo: dir,
      allowanceRaw: "@cosyte/fhir=blocked",
      attempts: 4,
      delayMs: 0,
      pack: async () => ({ tarball: "/tmp/t.tgz", files: ["dist/index.cjs", "dist/index.mjs", "dist/index.d.ts"] }),
      install: async () => {
        installs += 1;
        return { ok: false, code: 1, output: "npm error code E404" };
      },
      fetchImpl: async (url) => ({
        status: String(url).includes("fhir") ? 404 : 200,
        json: async () => ({ versions: {} }),
      }),
    });
    assert.equal(r.verdict, "blocked-peer");
    assert.equal(r.failing, false);
    assert.equal(installs, 1, "an absence the allowance settles must not be retried");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layer 2 end to end fails when the same failure has an undeclared absence in it", async () => {
  const dir = await scratchRepo(TRANSFORM, {
    "dist/index.cjs": "x",
    "dist/index.mjs": "x",
    "dist/index.d.ts": "x",
  });
  try {
    const r = await runPackLayer({
      repo: dir,
      allowanceRaw: "", // nothing declared: the very condition the allowance exists to cover
      attempts: 1,
      delayMs: 0,
      pack: async () => ({ tarball: "/tmp/t.tgz", files: ["dist/index.cjs", "dist/index.mjs", "dist/index.d.ts"] }),
      install: async () => ({ ok: false, code: 1, output: "E404" }),
      fetchImpl: async (url) => ({ status: String(url).includes("fhir") ? 404 : 200, json: async () => ({}) }),
    });
    assert.equal(r.verdict, "undeclared-absent-dependency");
    assert.equal(r.failing, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layer 2 retries an unsettled failure and reports the last attempt", async () => {
  const dir = await scratchRepo({ name: "@cosyte/x", version: "1.0.0", main: "./dist/index.cjs" }, {
    "dist/index.cjs": "x",
  });
  let installs = 0;
  try {
    const r = await runPackLayer({
      repo: dir,
      allowanceRaw: "",
      attempts: 3,
      delayMs: 0,
      pack: async () => ({ tarball: "/tmp/t.tgz", files: ["dist/index.cjs"] }),
      install: async () => {
        installs += 1;
        return { ok: false, code: 1, output: "boom" };
      },
      fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
    });
    assert.equal(installs, 3);
    assert.equal(r.verdict, "uninstallable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layer 2 catches a build that never ran before it packs anything", async () => {
  const dir = await scratchRepo(TRANSFORM);
  let packed = false;
  try {
    const r = await runPackLayer({
      repo: dir,
      allowanceRaw: "",
      pack: async () => {
        packed = true;
        return { tarball: "/tmp/t.tgz", files: [] };
      },
    });
    assert.equal(r.verdict, "not-built");
    assert.equal(packed, false, "there is nothing to learn from packing an unbuilt tree");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layer 2 catches a files field that drops a declared entry point", async () => {
  const dir = await scratchRepo(TRANSFORM, {
    "dist/index.cjs": "x",
    "dist/index.mjs": "x",
    "dist/index.d.ts": "x",
  });
  try {
    const r = await runPackLayer({
      repo: dir,
      allowanceRaw: "",
      pack: async () => ({ tarball: "/tmp/t.tgz", files: ["dist/index.cjs", "dist/index.mjs"] }),
    });
    assert.equal(r.verdict, "not-packed");
    assert.match(r.reason, /dist\/index\.d\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layer 2 refuses a tarball carrying the gate's own checkout", async () => {
  const dir = await scratchRepo({ name: "@cosyte/x", version: "1.0.0", main: "./dist/index.cjs" }, {
    "dist/index.cjs": "x",
  });
  try {
    const r = await runPackLayer({
      repo: dir,
      allowanceRaw: "",
      pack: async () => ({
        tarball: "/tmp/t.tgz",
        files: ["dist/index.cjs", `${TOOLING_DIR}/scripts/prepublish-check.mjs`],
      }),
    });
    assert.equal(r.verdict, "tooling-in-tarball");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layer 2 passes a good tree and reports a spent allowance as stale", async () => {
  const dir = await scratchRepo({ name: "@cosyte/x", version: "1.0.0", main: "./dist/index.cjs" }, {
    "dist/index.cjs": "x",
  });
  try {
    const r = await runPackLayer({
      repo: dir,
      allowanceRaw: "@cosyte/hl7=blocked",
      pack: async () => ({ tarball: "/tmp/t.tgz", files: ["dist/index.cjs"] }),
      install: async () => ({ ok: true, code: 0, output: "" }),
      probe: async () => ({ failures: [], probed: ["cjs"] }),
    });
    assert.equal(r.verdict, "pass");
    assert.deepEqual(r.staleAllowance.map((s) => s.name), ["@cosyte/hl7"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layer 2 asserts nothing about a private package", async () => {
  const dir = await scratchRepo({ name: "internal", version: "1.0.0", private: true });
  try {
    const r = await runPackLayer({ repo: dir, allowanceRaw: "" });
    assert.equal(r.verdict, "not-published");
    assert.equal(r.failing, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layer 2 fails on a malformed allowance before it packs anything", async () => {
  const dir = await scratchRepo(TRANSFORM);
  let packed = false;
  try {
    const r = await runPackLayer({
      repo: dir,
      allowanceRaw: "@cosyte/fhir=maybe",
      pack: async () => {
        packed = true;
        return { tarball: "", files: [] };
      },
    });
    assert.equal(r.verdict, "malformed-allowance");
    assert.equal(r.failing, true);
    assert.equal(packed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── The CLI contract ────────────────────────────────────────────────────────────────────────────

test("an unknown or missing layer name exits 2 rather than checking something arbitrary", async () => {
  assert.equal(await main([]), 2);
  assert.equal(await main(["--repo", "."]), 2);
  assert.equal(await main(["install"]), 2);
});

// ── The workflow wiring itself ──────────────────────────────────────────────────────────────────
//
// THE DOMINANT DEFECT CLASS IN THIS ORG'S PIPELINE IS A STEP THAT HAS NEVER ONCE EXECUTED. The docs
// dispatch was guarded on a secret that did not exist, so its guard was false on every release ever
// run and the bug inside it sat undiscovered for the life of the step. A gate wired but not passed
// its own allowance would be the same defect, so the wiring is asserted by reading the file.

test("ci.yml wires both layers the way the script expects", async () => {
  const { readFile } = await import("node:fs/promises");
  const yml = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

  // The tooling path. A reusable workflow runs against the CALLER's checkout, so the script exists
  // only under the tooling checkout; a bare `scripts/` path would resolve to a caller-side file.
  assert.match(yml, /node \.cosyte-ci-tooling\/scripts\/prepublish-check\.mjs manifest/);
  assert.match(yml, /node \.cosyte-ci-tooling\/scripts\/prepublish-check\.mjs pack/);
  // The checkout path and the constant the pack layer refuses a tarball over must be the same
  // string. If they drift, the contamination guard silently guards nothing.
  assert.match(yml, new RegExp(`path: ${TOOLING_DIR}`));
  // Pinned to the workflow's own commit, so the script can never be a different version from the
  // workflow that calls it.
  assert.match(yml, /ref: \$\{\{ github\.job_workflow_sha \}\}/);

  // The allowance must actually REACH both invocations.
  assert.equal(yml.match(/--expect-unpublished-deps "\$EXPECT_UNPUBLISHED_DEPS"/g)?.length, 2);
  assert.equal(
    yml.match(/EXPECT_UNPUBLISHED_DEPS: \$\{\{ inputs\.expect-unpublished-deps \}\}/g)?.length,
    2,
  );

  // The defaults are the policy, so they are pinned rather than described: layer 1 on (measured zero
  // findings across all thirteen callers), layer 2 off (turning it on for thirteen repos at once is
  // a policy call, not a build).
  assert.match(yml, /run-prepublish-manifest-lint:[\s\S]{0,400}?default: true/);
  assert.match(yml, /run-prepublish-install:[\s\S]{0,400}?default: false/);

  // And the default allowance must parse, in the grammar this script owns.
  const declaredDefault = yml.match(/expect-unpublished-deps:[\s\S]{0,600}?default: "([^"]*)"/)?.[1];
  assert.equal(declaredDefault, "@cosyte/fhir=blocked");
  const { entries, malformed } = parseDeclaredAllowance(declaredDefault);
  assert.deepEqual(malformed, []);
  assert.deepEqual(entries, [{ name: "@cosyte/fhir", kind: "blocked", tagged: true }]);

  // Layer 2 packs what layer 2 built. Reversed, every opted-in caller reports `not-built`.
  //
  // SCOPED TO THE `prepublish` JOB, and the first draft was not, which made it a test that could not
  // fail: `verify` has its own `run: pnpm build` far earlier in the file, so the comparison was
  // satisfied by a line in a different job and deleting the build step under test changed nothing.
  // That is the defect class this repo records as the sharpest of the 2026-08-04 run.
  const job = yml.slice(yml.indexOf("\n  prepublish:"), yml.indexOf("\n  actionlint:"));
  assert.ok(job.includes("prepublish-check.mjs pack"), "the prepublish job was not located");
  assert.ok(
    job.indexOf("run: pnpm build") >= 0 &&
      job.indexOf("run: pnpm build") < job.indexOf("prepublish-check.mjs pack"),
    "the prepublish job must build the tree before it packs it",
  );
  // And it installs before it builds, or `pnpm build` has no toolchain. The `>= 0` is not belt and
  // braces: with the step ABSENT, `indexOf` returns -1, which is less than the build index, so the
  // comparison alone passes on exactly the failure it names — the same vacuity the assertion above
  // was just corrected for, reintroduced by its own companion.
  assert.ok(
    job.indexOf("pnpm install --frozen-lockfile") >= 0 &&
      job.indexOf("pnpm install --frozen-lockfile") < job.indexOf("run: pnpm build"),
    "the prepublish job must install before it builds",
  );
});

test("both gates' defaults are the same string, so the allowance has one spelling", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = async (f) =>
    (await readFile(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8")).match(
      /expect-unpublished-deps:[\s\S]{0,600}?default: "([^"]*)"/,
    )?.[1];
  assert.equal(await read("ci.yml"), await read("release.yml"));
});

test("the manifest layer's exit code is the verdict's, both ways", async () => {
  const bad = await scratchRepo(CLI_AT_0_0_1);
  const good = await scratchRepo(CLI_TODAY);
  try {
    assert.equal(await main(["manifest", "--repo", bad, "--summary", path.join(bad, "s.md")]), 1);
    assert.equal(await main(["manifest", "--repo", good, "--summary", path.join(good, "s.md")]), 0);
  } finally {
    await rm(bad, { recursive: true, force: true });
    await rm(good, { recursive: true, force: true });
  }
});
