// Unit tests for the post-publish install gate.
//
// Zero dependencies and no network: `node:test` + `node:assert` only, matching the rest of this
// repo. The gate's I/O is injected, so the retry ladder, the propagation taxonomy and the allowance
// are all driven here against fakes. That matters more than usual for this file. The dominant defect
// class in this org's release pipeline is a step that has NEVER ONCE EXECUTED: the docs dispatch was
// guarded on a secret that did not exist, so its guard was false on every release ever run, and the
// one-character bug inside it sat undiscovered for the life of the step. A gate whose branches are
// never taken is not a gate, so every branch below is taken by a test.
//
// The three registry fixtures are transcribed from the LIVE registry on 2026-08-04, not invented:
// `npm view @cosyte/cli@0.0.1 --json`, `@cosyte/transform@0.0.5`, `@cosyte/synth@0.0.6`.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isRegistrySpecifier,
  findNonRegistrySpecifiers,
  consumerDependencyNames,
  parseAllowance,
  entryPointProbes,
  binTargets,
  classify,
  staleAllowanceEntries,
  dependencyStatus,
  packumentListsVersion,
  fetchVersionManifest,
  tarballServed,
  renderAnnotation,
  renderSummary,
  parseArgs,
  withFetchTimeout,
  numericOption,
  VERDICTS,
  cleanRoomEnv,
  probeChildEnv,
  PROBE_ENV_PASSTHROUGH,
  probeEntryPoints,
  installIntoCleanRoom,
  runCheck,
} from "../scripts/install-check.mjs";

// ── Fixtures, transcribed from the live registry ────────────────────────────────────────────────

const CLI_0_0_1 = {
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
    "@cosyte/astm": "file:vendor/cosyte-astm-0.0.1.tgz",
    "@modelcontextprotocol/sdk": "1.29.0",
  },
  bin: { cosyte: "dist/bin/cosyte.mjs" },
  exports: { ".": { import: { default: "./dist/index.mjs" }, require: { default: "./dist/index.cjs" } } },
  dist: { tarball: "https://registry.npmjs.org/@cosyte/cli/-/cli-0.0.1.tgz" },
};

const CLI_0_0_1_CLEAN_SPECIFIERS = {
  name: "@cosyte/cli",
  version: "0.0.1",
  dependencies: Object.fromEntries(
    ["hl7", "fhir", "transform", "terminology", "x12", "astm", "ccda", "mllp", "dicom", "ncpdp"].map(
      (n) => [`@cosyte/${n}`, "^0.0.1"],
    ),
  ),
  exports: { ".": { import: { default: "./dist/index.mjs" } } },
  dist: { tarball: "https://registry.npmjs.org/@cosyte/cli/-/cli-0.0.1.tgz" },
};

const TRANSFORM_0_0_5 = {
  name: "@cosyte/transform",
  version: "0.0.5",
  dependencies: {},
  peerDependencies: { "@cosyte/fhir": ">=0.0.0", "@cosyte/hl7": ">=0.0.0" },
  exports: { ".": { import: { default: "./dist/index.mjs" }, require: { default: "./dist/index.cjs" } } },
  dist: { tarball: "https://registry.npmjs.org/@cosyte/transform/-/transform-0.0.5.tgz" },
};

const SYNTH_0_0_6 = {
  name: "@cosyte/synth",
  version: "0.0.6",
  peerDependencies: { "@cosyte/fhir": ">=0.0.0", "@cosyte/hl7": ">=0.0.0", "@cosyte/deid": ">=0.0.0" },
  // Every peer is marked optional, and synth STILL fails ERESOLVE against the live registry.
  peerDependenciesMeta: {
    "@cosyte/fhir": { optional: true },
    "@cosyte/hl7": { optional: true },
    "@cosyte/deid": { optional: true },
  },
  exports: { ".": { import: { default: "./dist/index.mjs" }, require: { default: "./dist/index.cjs" } } },
  dist: { tarball: "https://registry.npmjs.org/@cosyte/synth/-/synth-0.0.6.tgz" },
};

const HL7_0_0_7 = {
  name: "@cosyte/hl7",
  version: "0.0.7",
  dependencies: {},
  exports: { ".": { import: { default: "./dist/index.mjs" }, require: { default: "./dist/index.cjs" } } },
  dist: { tarball: "https://registry.npmjs.org/@cosyte/hl7/-/hl7-0.0.7.tgz" },
};

// ── Specifier classification ────────────────────────────────────────────────────────────────────

test("a semver range, a pin, a tag and a wildcard are registry specifiers", () => {
  for (const spec of ["^0.0.7", ">=0.0.0", "1.29.0", "latest", "*", "0.0.1-alpha.1", "~1.2 || 2.x"]) {
    assert.equal(isRegistrySpecifier(spec), true, spec);
  }
});

test("every non-registry protocol is refused, including ones no blacklist would have listed", () => {
  for (const spec of [
    "file:vendor/cosyte-fhir-0.0.0.tgz",
    "link:../hl7",
    "portal:../hl7",
    "workspace:*",
    "workspace:^",
    "git+ssh://git@github.com/cosyte/hl7.git",
    "git+https://github.com/cosyte/hl7.git",
    "https://example.com/hl7.tgz",
    "http://example.com/hl7.tgz",
    "catalog:default",
    "patch:@cosyte/hl7@1.0.0#./p.patch",
  ]) {
    assert.equal(isRegistrySpecifier(spec), false, spec);
  }
});

test("the protocol-less GitHub shorthand is refused, which a colon-only rule would have missed", () => {
  assert.equal(isRegistrySpecifier("cosyte/hl7"), false);
  assert.equal(isRegistrySpecifier("cosyte/hl7#v1.0.0"), false);
});

test("an npm: alias is a registry specifier", () => {
  assert.equal(isRegistrySpecifier("npm:@cosyte/hl7@^0.0.7"), true);
});

test("empty and non-string specifiers are refused rather than thrown on", () => {
  assert.equal(isRegistrySpecifier(""), false);
  assert.equal(isRegistrySpecifier("   "), false);
  assert.equal(isRegistrySpecifier(undefined), false);
  assert.equal(isRegistrySpecifier(null), false);
  assert.equal(isRegistrySpecifier(42), false);
});

test("the real cli@0.0.1 manifest yields one finding per file: specifier, across both fields", () => {
  const findings = findNonRegistrySpecifiers(CLI_0_0_1);
  assert.equal(findings.length, 6);
  assert.deepEqual(
    findings.map((f) => f.name).sort(),
    ["@cosyte/astm", "@cosyte/fhir", "@cosyte/hl7", "@cosyte/terminology", "@cosyte/transform", "@cosyte/x12"],
  );
  // The one real registry specifier in optionalDependencies is not flagged.
  assert.equal(findings.some((f) => f.name === "@modelcontextprotocol/sdk"), false);
  assert.deepEqual(new Set(findings.map((f) => f.field)), new Set(["dependencies", "optionalDependencies"]));
});

test("clean manifests produce no specifier findings", () => {
  assert.deepEqual(findNonRegistrySpecifiers(HL7_0_0_7), []);
  assert.deepEqual(findNonRegistrySpecifiers(TRANSFORM_0_0_5), []);
  assert.deepEqual(findNonRegistrySpecifiers(SYNTH_0_0_6), []);
});

test("devDependencies are deliberately not linted", () => {
  const manifest = { dependencies: {}, devDependencies: { tsup: "file:../tsup" } };
  assert.deepEqual(findNonRegistrySpecifiers(manifest), []);
});

test("a missing or malformed dependency block does not throw", () => {
  assert.deepEqual(findNonRegistrySpecifiers({}), []);
  assert.deepEqual(findNonRegistrySpecifiers({ dependencies: null }), []);
  assert.deepEqual(findNonRegistrySpecifiers({ dependencies: "nonsense" }), []);
  assert.deepEqual(consumerDependencyNames({}), []);
});

test("dependency names are collected across all three consumer fields, de-duplicated and sorted", () => {
  assert.deepEqual(consumerDependencyNames(TRANSFORM_0_0_5), ["@cosyte/fhir", "@cosyte/hl7"]);
  assert.deepEqual(consumerDependencyNames(SYNTH_0_0_6), ["@cosyte/deid", "@cosyte/fhir", "@cosyte/hl7"]);
  assert.deepEqual(
    consumerDependencyNames({ dependencies: { a: "1" }, peerDependencies: { a: "1", b: "2" } }),
    ["a", "b"],
  );
});

// ── The allowance ───────────────────────────────────────────────────────────────────────────────

test("the allowance parses comma and whitespace separated lists, de-duplicating", () => {
  assert.deepEqual(parseAllowance("@cosyte/fhir"), ["@cosyte/fhir"]);
  assert.deepEqual(parseAllowance("@cosyte/fhir, @cosyte/web"), ["@cosyte/fhir", "@cosyte/web"]);
  assert.deepEqual(parseAllowance(" @cosyte/fhir \n @cosyte/fhir "), ["@cosyte/fhir"]);
  assert.deepEqual(parseAllowance(""), []);
  assert.deepEqual(parseAllowance(undefined), []);
});

test("an allowance naming a package that is now published is reported stale, never as a failure", () => {
  assert.deepEqual(staleAllowanceEntries(["@cosyte/fhir"], ["@cosyte/hl7", "@cosyte/fhir"]), ["@cosyte/fhir"]);
  assert.deepEqual(staleAllowanceEntries(["@cosyte/fhir"], ["@cosyte/hl7"]), []);
  assert.deepEqual(staleAllowanceEntries([], ["@cosyte/hl7"]), []);
});

// ── Entry points ────────────────────────────────────────────────────────────────────────────────

test("a dual ESM/CJS exports map declares both probes", () => {
  assert.deepEqual(entryPointProbes(HL7_0_0_7), { esm: true, cjs: true });
});

test("an ESM-only package is never probed for require, which would be a false red", () => {
  const esmOnly = { exports: { ".": { import: { default: "./dist/index.mjs" } } } };
  assert.deepEqual(entryPointProbes(esmOnly), { esm: true, cjs: false });
});

test("a legacy manifest with only main falls back to a CJS probe", () => {
  assert.deepEqual(entryPointProbes({ main: "./index.js" }), { esm: false, cjs: true });
  assert.deepEqual(entryPointProbes({ main: "./index.js", type: "module" }), { esm: true, cjs: false });
  assert.deepEqual(entryPointProbes({ module: "./index.mjs", main: "./index.cjs" }), { esm: true, cjs: true });
});

test("a manifest declaring no entry point at all is probed for neither", () => {
  assert.deepEqual(entryPointProbes({}), { esm: false, cjs: false });
  assert.deepEqual(entryPointProbes({ bin: { x: "./x.mjs" } }), { esm: false, cjs: false });
});

test("bin targets are normalized from both the string and object forms", () => {
  assert.deepEqual(binTargets(CLI_0_0_1), ["dist/bin/cosyte.mjs"]);
  assert.deepEqual(binTargets({ bin: "./cli.mjs" }), ["./cli.mjs"]);
  assert.deepEqual(binTargets({ bin: { a: "./a.mjs", b: "./b.mjs" } }), ["./a.mjs", "./b.mjs"]);
  assert.deepEqual(binTargets({}), []);
  assert.deepEqual(binTargets({ bin: 7 }), []);
});

// ── The verdict taxonomy ────────────────────────────────────────────────────────────────────────

const facts = (over = {}) => ({
  specifierFindings: [],
  ownServed: true,
  installOk: true,
  installAttempted: true,
  missingDependencies: [],
  declaredAllowance: [],
  entryFailures: [],
  ...over,
});

test("a clean install of a clean manifest passes", () => {
  const r = classify(facts());
  assert.equal(r.verdict, "pass");
  assert.equal(r.failing, false);
});

test("cli@0.0.1's file: specifiers fail, and the allowance CANNOT excuse them", () => {
  // The regression this ordering exists for: cli@0.0.1 has both file: specifiers AND a genuinely
  // blocked @cosyte/fhir peer. Classified after the install, the allowance would have excused a
  // package that is broken for a completely different and permanent reason.
  const r = classify(
    facts({
      specifierFindings: findNonRegistrySpecifiers(CLI_0_0_1),
      installOk: false,
      missingDependencies: ["@cosyte/fhir"],
      declaredAllowance: ["@cosyte/fhir"],
    }),
  );
  assert.equal(r.verdict, "non-registry-specifier");
  assert.equal(r.failing, true);
  assert.match(r.reason, /file:vendor/);
});

test("a version the registry has not served yet warns, and does not fail", () => {
  const r = classify(facts({ ownServed: false, installAttempted: false, installOk: false }));
  assert.equal(r.verdict, "not-propagated");
  assert.equal(r.failing, false);
  assert.match(r.reason, /propagation lag/);
});

test("transform's blocked fhir peer is a declared, non-failing outcome", () => {
  const r = classify(
    facts({ installOk: false, missingDependencies: ["@cosyte/fhir"], declaredAllowance: ["@cosyte/fhir"] }),
  );
  assert.equal(r.verdict, "blocked-peer");
  assert.equal(r.failing, false);
});

test("an UNDECLARED missing dependency fails even when a declared one is also missing", () => {
  // The cry-wolf guard has to cut both ways: the allowance must not widen into "any missing peer".
  const r = classify(
    facts({
      installOk: false,
      missingDependencies: ["@cosyte/fhir", "@cosyte/newthing"],
      declaredAllowance: ["@cosyte/fhir"],
    }),
  );
  assert.equal(r.verdict, "uninstallable");
  assert.equal(r.failing, true);
  assert.match(r.reason, /@cosyte\/newthing/);
  assert.doesNotMatch(r.reason, /@cosyte\/fhir/);
});

test("an empty allowance turns a blocked peer into a failure", () => {
  const r = classify(facts({ installOk: false, missingDependencies: ["@cosyte/fhir"], declaredAllowance: [] }));
  assert.equal(r.verdict, "uninstallable");
  assert.equal(r.failing, true);
});

test("an install failure with nothing missing is the package's own defect", () => {
  const r = classify(facts({ installOk: false, missingDependencies: [], declaredAllowance: ["@cosyte/fhir"] }));
  assert.equal(r.verdict, "uninstallable");
  assert.equal(r.failing, true);
  assert.match(r.reason, /this package's own published tree/);
});

test("an installed package whose entry points do not load fails", () => {
  const r = classify(facts({ entryFailures: ['declared bin "dist/bin/cosyte.mjs" is missing'] }));
  assert.equal(r.verdict, "uninstallable");
  assert.equal(r.failing, true);
});

// ── Registry oracles ────────────────────────────────────────────────────────────────────────────

const fakeFetch = (routes) => async (url, options = {}) => {
  const key = `${options.method || "GET"} ${url}`;
  if (!(key in routes)) throw new Error(`unrouted fetch: ${key}`);
  const entry = routes[key];
  if (entry instanceof Error) throw entry;
  return {
    status: entry.status,
    json: async () => entry.body,
    headers: new Map(),
  };
};

test("a 404 packument means the dependency is absent", async () => {
  const f = fakeFetch({ "GET https://r/@cosyte%2ffhir": { status: 404, body: null } });
  assert.equal(await dependencyStatus("https://r", "@cosyte/fhir", f), "absent");
});

test("a 200 packument means the dependency is present", async () => {
  const f = fakeFetch({ "GET https://r/@cosyte%2fhl7": { status: 200, body: { name: "@cosyte/hl7" } } });
  assert.equal(await dependencyStatus("https://r", "@cosyte/hl7", f), "present");
});

test("a 5xx, a rate limit or a thrown fetch is UNKNOWN, never present and never absent", async () => {
  // Both booleans are unsafe. "Present" eliminates the explanation for an install failure and the
  // verdict silently becomes the package's own defect, which is a red; "absent" invents an excuse.
  for (const status of [500, 502, 429, 403]) {
    const f = fakeFetch({ "GET https://r/@cosyte%2fhl7": { status, body: null } });
    assert.equal(await dependencyStatus("https://r", "@cosyte/hl7", f), "unknown", `status ${status}`);
  }
  const boom = fakeFetch({ "GET https://r/@cosyte%2fhl7": new Error("ECONNRESET") });
  assert.equal(await dependencyStatus("https://r", "@cosyte/hl7", boom), "unknown");
});

test("the packument oracle answers yes, no and unknown, and it is not the version document", async () => {
  // The object npm actually resolves a version from. It propagates independently of the version
  // document, so a version doc that is live while the packument still tops out at the previous
  // version is a real state, and it used to red a correct release.
  const listed = fakeFetch({
    "GET https://r/@cosyte%2fhl7": { status: 200, body: { versions: { "0.0.6": {}, "0.0.7": {} } } },
  });
  const lagging = fakeFetch({
    "GET https://r/@cosyte%2fhl7": { status: 200, body: { versions: { "0.0.6": {} } } },
  });
  const down = fakeFetch({ "GET https://r/@cosyte%2fhl7": { status: 503, body: null } });
  const garbage = fakeFetch({ "GET https://r/@cosyte%2fhl7": { status: 200, body: { versions: "nope" } } });
  assert.equal(await packumentListsVersion("https://r", "@cosyte/hl7", "0.0.7", listed), "yes");
  assert.equal(await packumentListsVersion("https://r", "@cosyte/hl7", "0.0.7", lagging), "no");
  assert.equal(await packumentListsVersion("https://r", "@cosyte/hl7", "0.0.7", down), "unknown");
  assert.equal(await packumentListsVersion("https://r", "@cosyte/hl7", "0.0.7", garbage), "unknown");
});

test("the version manifest oracle distinguishes served from not served", async () => {
  const f = fakeFetch({
    "GET https://r/@cosyte%2fhl7/0.0.7": { status: 200, body: HL7_0_0_7 },
    "GET https://r/@cosyte%2fhl7/9.9.9": { status: 404, body: null },
  });
  assert.deepEqual(await fetchVersionManifest("https://r", "@cosyte/hl7", "0.0.7", f), HL7_0_0_7);
  assert.equal(await fetchVersionManifest("https://r", "@cosyte/hl7", "9.9.9", f), null);
});

test("a tarball that does not answer 200 is not considered served, and a throw is not fatal", async () => {
  const ok = fakeFetch({ "HEAD https://r/t.tgz": { status: 200, body: null } });
  const missing = fakeFetch({ "HEAD https://r/t.tgz": { status: 404, body: null } });
  const boom = fakeFetch({ "HEAD https://r/t.tgz": new Error("socket hang up") });
  assert.equal(await tarballServed("https://r/t.tgz", ok), true);
  assert.equal(await tarballServed("https://r/t.tgz", missing), false);
  assert.equal(await tarballServed("https://r/t.tgz", boom), false);
  assert.equal(await tarballServed(undefined, ok), false);
});

// ── The clean room ──────────────────────────────────────────────────────────────────────────────

test("the clean room env is anonymous, isolated, and uses two distinct config files", () => {
  const env = cleanRoomEnv("/tmp/room", "https://r");
  // npm aborts outright if userconfig and globalconfig are the same path.
  assert.notEqual(env.npm_config_userconfig, env.npm_config_globalconfig);
  assert.match(env.npm_config_cache, /^\/tmp\/room\//);
  assert.equal(env.npm_config_registry, "https://r");
  // An auth token would mask a package accidentally published private.
  assert.equal(env.NODE_AUTH_TOKEN, "");
  assert.equal(env.NPM_TOKEN, "");
});

// ── The retry ladder, end to end against fakes ──────────────────────────────────────────────────

function harness({ servedAfter = 1, installResults = [], routes = {}, manifest = HL7_0_0_7 }) {
  let versionCalls = 0;
  const slept = [];
  const installs = [];
  const ownPackument = `https://r/${manifest.name.replace("/", "%2f")}`;
  const reply = (status, body) => ({ status, json: async () => body, headers: new Map() });
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || "GET";
    if (method === "HEAD") return reply(200, null);
    // The version document for the package under test, gated on propagation.
    if (url.endsWith(`/${manifest.version}`)) {
      versionCalls += 1;
      return versionCalls >= servedAfter ? reply(200, manifest) : reply(404, null);
    }
    // Its packument, which is a SEPARATE object and the one npm resolves from. Served in step with
    // the version document unless a test overrides it via `routes`.
    if (url === ownPackument && !routes[`GET ${url}`]) {
      return versionCalls >= servedAfter
        ? reply(200, { versions: { [manifest.version]: {} } })
        : reply(404, null);
    }
    const hit = routes[`GET ${url}`];
    // A dependency packument nothing routed: present, and shaped like a real one.
    return hit ? reply(hit.status, hit.body) : reply(200, { versions: {} });
  };
  return {
    slept,
    installs,
    versionCalls: () => versionCalls,
    opts: {
      registry: "https://r",
      fetchImpl,
      cleanRoomFactory: async () => "/tmp/fake-room",
      installer: async (args) => {
        installs.push(args);
        return installResults[installs.length - 1] ?? installResults.at(-1) ?? { ok: true, code: 0, output: "" };
      },
      entryProber: async () => ({ failures: [], probed: ["esm", "cjs"] }),
      waiter: async (ms) => {
        slept.push(ms);
      },
    },
  };
}

test("a good package installs on the first attempt and never sleeps", async () => {
  const h = harness({ installResults: [{ ok: true, code: 0, output: "added 1 package" }] });
  const r = await runCheck({ name: "@cosyte/hl7", version: "0.0.7", attempts: 8, delayMs: 1, ...h.opts });
  assert.equal(r.verdict, "pass");
  assert.equal(r.failing, false);
  assert.equal(h.installs.length, 1);
  assert.deepEqual(h.slept, []);
});

test("a version that propagates on the third poll is installed, not reported missing", async () => {
  const h = harness({ servedAfter: 3, installResults: [{ ok: true, code: 0, output: "" }] });
  const r = await runCheck({ name: "@cosyte/hl7", version: "0.0.7", attempts: 8, delayMs: 1, ...h.opts });
  assert.equal(r.verdict, "pass");
  assert.equal(r.attemptsUsed, 3);
  assert.equal(h.slept.length, 2);
});

test("a version that never propagates warns rather than failing, after the whole budget", async () => {
  const h = harness({ servedAfter: 99 });
  const r = await runCheck({ name: "@cosyte/hl7", version: "0.0.7", attempts: 4, delayMs: 1, ...h.opts });
  assert.equal(r.verdict, "not-propagated");
  assert.equal(r.failing, false);
  assert.equal(h.versionCalls(), 4);
  assert.equal(h.installs.length, 0);
});

test("cli@0.0.1 fails on the served manifest without burning the retry budget or installing", async () => {
  const h = harness({ manifest: CLI_0_0_1 });
  const r = await runCheck({
    name: "@cosyte/cli",
    version: "0.0.1",
    attempts: 8,
    delayMs: 1,
    allowance: ["@cosyte/fhir"],
    ...h.opts,
  });
  assert.equal(r.verdict, "non-registry-specifier");
  assert.equal(r.failing, true);
  assert.equal(h.installs.length, 0, "a deterministic manifest defect must not cost an install");
  assert.deepEqual(h.slept, [], "and must not cost the retry budget either");
});

test("transform's declared fhir block warns, once, without retrying", async () => {
  const h = harness({
    manifest: TRANSFORM_0_0_5,
    installResults: [{ ok: false, code: 1, output: "npm error code E404" }],
    routes: {
      "GET https://r/@cosyte%2ffhir": { status: 404, body: null },
      "GET https://r/@cosyte%2fhl7": { status: 200, body: {} },
    },
  });
  const r = await runCheck({
    name: "@cosyte/transform",
    version: "0.0.5",
    attempts: 8,
    delayMs: 1,
    allowance: ["@cosyte/fhir"],
    ...h.opts,
  });
  assert.equal(r.verdict, "blocked-peer");
  assert.equal(r.failing, false);
  assert.deepEqual(r.missingDependencies, ["@cosyte/fhir"]);
  assert.equal(h.installs.length, 1, "a declared block is settled, so it must not be retried");
});

test("synth's OPTIONAL fhir peer is treated exactly like transform's required one", async () => {
  // Optionality in peerDependenciesMeta does not protect the tree: measured ERESOLVE on the live
  // registry. The gate must not infer installability from the optional flag.
  const h = harness({
    manifest: SYNTH_0_0_6,
    installResults: [{ ok: false, code: 1, output: "npm error code ERESOLVE" }],
    routes: {
      "GET https://r/@cosyte%2ffhir": { status: 404, body: null },
      "GET https://r/@cosyte%2fhl7": { status: 200, body: {} },
      "GET https://r/@cosyte%2fdeid": { status: 200, body: {} },
    },
  });
  const r = await runCheck({
    name: "@cosyte/synth",
    version: "0.0.6",
    attempts: 8,
    delayMs: 1,
    allowance: ["@cosyte/fhir"],
    ...h.opts,
  });
  assert.equal(r.verdict, "blocked-peer");
  assert.deepEqual(r.missingDependencies, ["@cosyte/fhir"]);
});

test("without the allowance, transform's identical failure goes red", async () => {
  const h = harness({
    manifest: TRANSFORM_0_0_5,
    installResults: [{ ok: false, code: 1, output: "npm error code E404" }],
    routes: {
      "GET https://r/@cosyte%2ffhir": { status: 404, body: null },
      "GET https://r/@cosyte%2fhl7": { status: 200, body: {} },
    },
  });
  const r = await runCheck({
    name: "@cosyte/transform",
    version: "0.0.5",
    attempts: 3,
    delayMs: 1,
    allowance: [],
    ...h.opts,
  });
  assert.equal(r.verdict, "uninstallable");
  assert.equal(r.failing, true);
  assert.equal(h.installs.length, 3, "an undeclared absence is retried, in case a sibling is propagating");
});

test("a sibling that propagates mid-wave flips a red into a pass, which is the wave guard", async () => {
  // The 2026-08-02 wave published ten packages near-simultaneously. A sibling still propagating must
  // not be read as a permanently missing dependency.
  let fhirCalls = 0;
  const h = harness({
    manifest: TRANSFORM_0_0_5,
    installResults: [{ ok: false, code: 1, output: "E404" }, { ok: true, code: 0, output: "added 2 packages" }],
  });
  const wrapped = {
    ...h.opts,
    fetchImpl: async (url, options = {}) => {
      if ((options.method || "GET") === "GET" && url.endsWith("@cosyte%2ffhir")) {
        fhirCalls += 1;
        return { status: fhirCalls > 1 ? 200 : 404, json: async () => ({}), headers: new Map() };
      }
      return h.opts.fetchImpl(url, options);
    },
  };
  const r = await runCheck({
    name: "@cosyte/transform",
    version: "0.0.5",
    attempts: 4,
    delayMs: 1,
    allowance: [],
    ...wrapped,
  });
  assert.equal(r.verdict, "pass");
  assert.equal(r.failing, false);
});

test("a failing entry-point probe reds a package that installed cleanly", async () => {
  const h = harness({ installResults: [{ ok: true, code: 0, output: "" }] });
  const r = await runCheck({
    name: "@cosyte/hl7",
    version: "0.0.7",
    attempts: 2,
    delayMs: 1,
    ...h.opts,
    entryProber: async () => ({ failures: ["ESM entry point failed to load: ERR_MODULE_NOT_FOUND"], probed: ["esm"] }),
  });
  assert.equal(r.verdict, "uninstallable");
  assert.equal(r.failing, true);
});

test("a stale allowance is reported on an otherwise passing run, and does not fail it", async () => {
  const h = harness({ manifest: TRANSFORM_0_0_5, installResults: [{ ok: true, code: 0, output: "" }] });
  const r = await runCheck({
    name: "@cosyte/transform",
    version: "0.0.5",
    attempts: 2,
    delayMs: 1,
    allowance: ["@cosyte/fhir"],
    ...h.opts,
  });
  assert.equal(r.verdict, "pass");
  assert.equal(r.failing, false);
  assert.deepEqual(r.staleAllowance, ["@cosyte/fhir"]);
  assert.match(renderSummary(r), /allowance is stale/);
});

// ── Reporting ───────────────────────────────────────────────────────────────────────────────────

test("a failure annotates at error level and tells the reader NOT to re-run", async () => {
  const r = classify(facts({ specifierFindings: findNonRegistrySpecifiers(CLI_0_0_1) }));
  const line = renderAnnotation({ ...r, package: "@cosyte/cli", version: "0.0.1", attemptsUsed: 1, missingDependencies: [] });
  assert.match(line, /^::error title=/);
  assert.match(line, /do NOT re-run this job/);
  assert.match(line, /patch release/);
  assert.equal(line.includes("\n"), false, "an annotation must be a single line to render");
});

test("a pass annotates nothing at all", () => {
  assert.equal(renderAnnotation({ ...classify(facts()), package: "@cosyte/hl7", version: "0.0.7" }), null);
});

test("the not-propagated warning says how to re-check by hand", () => {
  const r = classify(facts({ ownServed: false, installAttempted: false, installOk: false }));
  const line = renderAnnotation({ ...r, package: "@cosyte/hl7", version: "0.0.7", attemptsUsed: 8, missingDependencies: [] });
  assert.match(line, /^::warning title=/);
  assert.match(line, /npm view @cosyte\/hl7@0\.0\.7 version/);
});

test("the blocked-peer warning still says the package is uninstallable for consumers", () => {
  const r = classify(facts({ installOk: false, missingDependencies: ["@cosyte/fhir"], declaredAllowance: ["@cosyte/fhir"] }));
  const line = renderAnnotation({ ...r, package: "@cosyte/synth", version: "0.0.6", attemptsUsed: 1, missingDependencies: ["@cosyte/fhir"] });
  assert.match(line, /^::warning title=/);
  assert.match(line, /still uninstallable for consumers/);
});

test("no annotation or summary carries an em dash, which the release gate bans org-wide", () => {
  // Assembled from its codepoint rather than written, so this file itself stays free of the
  // character in every spelling the em-dash gate bans, the JavaScript escape included.
  const EM_DASH = String.fromCodePoint(0x2014);
  const cases = [
    classify(facts({ specifierFindings: findNonRegistrySpecifiers(CLI_0_0_1) })),
    classify(facts({ ownServed: false, installAttempted: false, installOk: false })),
    classify(facts({ installOk: false, missingDependencies: ["@cosyte/fhir"], declaredAllowance: ["@cosyte/fhir"] })),
    classify(facts()),
  ];
  for (const c of cases) {
    const result = {
      ...c,
      package: "@cosyte/x",
      version: "1.0.0",
      attemptsUsed: 1,
      missingDependencies: c.verdict === "blocked-peer" ? ["@cosyte/fhir"] : [],
      staleAllowance: [],
      trail: ["attempt 1: something happened"],
    };
    assert.equal((renderAnnotation(result) || "").includes(EM_DASH), false, c.verdict);
    assert.equal(renderSummary(result).includes(EM_DASH), false, c.verdict);
  }
});

test("the failure summary carries a runnable reproduction", () => {
  const r = {
    ...classify(facts({ specifierFindings: findNonRegistrySpecifiers(CLI_0_0_1) })),
    package: "@cosyte/cli",
    version: "0.0.1",
    attemptsUsed: 1,
    missingDependencies: [],
    staleAllowance: [],
    trail: [],
  };
  const summary = renderSummary(r);
  assert.match(summary, /npm install @cosyte\/cli@0\.0\.1/);
  assert.match(summary, /Do not re-run this job/);
});

// ── CLI parsing ─────────────────────────────────────────────────────────────────────────────────

test("arguments parse, including a flag whose value is omitted", () => {
  assert.deepEqual(parseArgs(["--package", "@cosyte/hl7", "--version", "0.0.7"]), {
    package: "@cosyte/hl7",
    version: "0.0.7",
  });
  assert.deepEqual(parseArgs(["--json", "--package", "x"]), { json: "true", package: "x" });
  assert.deepEqual(parseArgs([]), {});
});

test("an empty allowance argument is not read as a package named the empty string", () => {
  assert.deepEqual(parseAllowance(parseArgs(["--expect-unpublished-deps", "--attempts", "3"])["expect-unpublished-deps"]), ["true"]);
  // ...which is why the workflow always passes a value, and why an absent flag yields [].
  assert.deepEqual(parseAllowance(parseArgs(["--attempts", "3"])["expect-unpublished-deps"]), []);
});

// ── Regression tests for the defects the gate-refuter found (2026-08-04) ────────────────────────
//
// Each of these FAILED against the first implementation. They are the reason the retry rule, the
// registry oracle and the clean-room environment look the way they do.

test("REGRESSION: an install failure with NOTHING missing spends the whole budget", async () => {
  // THE BLOCKER. The retry used to fire only when a dependency name was absent AND undeclared, so a
  // failure with nothing missing returned `uninstallable` on attempt 1 with the budget untouched.
  // "Nothing missing" is VACUOUSLY true for the six packages that declare no consumer dependencies,
  // so for them ordinary propagation lag went straight to a red on a permanent release.
  const h = harness({ manifest: HL7_0_0_7, installResults: [{ ok: false, code: 1, output: "E404" }] });
  const r = await runCheck({ name: "@cosyte/hl7", version: "0.0.7", attempts: 5, delayMs: 1, ...h.opts });
  assert.equal(h.installs.length, 5, "every attempt must be spent before condemning a permanent release");
  assert.equal(h.slept.length, 4);
  assert.equal(r.attemptsUsed, 5);
  assert.equal(r.verdict, "uninstallable");
});

test("REGRESSION: a package with no dependencies that starts installing mid-budget passes", async () => {
  // The same shape as above, with the lag resolving. This is the correct release the old code redded.
  const h = harness({
    manifest: HL7_0_0_7,
    installResults: [
      { ok: false, code: 1, output: "E404" },
      { ok: false, code: 1, output: "E404" },
      { ok: true, code: 0, output: "added 1 package" },
    ],
  });
  const r = await runCheck({ name: "@cosyte/hl7", version: "0.0.7", attempts: 8, delayMs: 1, ...h.opts });
  assert.equal(r.verdict, "pass");
  assert.equal(r.failing, false);
  assert.equal(h.installs.length, 3);
});

test("REGRESSION: the packument lagging behind the version document is not a defect", async () => {
  // `GET /pkg/version` and `GET /pkg` are separate objects with independent propagation, and npm
  // resolves from the packument. Believing the version document alone declared a live, correct
  // release uninstallable. Here the version doc and tarball are live and the packument is not.
  const h = harness({
    manifest: HL7_0_0_7,
    routes: { "GET https://r/@cosyte%2fhl7": { status: 200, body: { versions: { "0.0.6": {} } } } },
  });
  const r = await runCheck({ name: "@cosyte/hl7", version: "0.0.7", attempts: 3, delayMs: 1, ...h.opts });
  assert.equal(r.verdict, "not-propagated");
  assert.equal(r.failing, false);
  assert.equal(h.installs.length, 0, "npm must not be asked to resolve a version its packument lacks");
});

test("REGRESSION: a 503 on a dependency packument is inconclusive, not a red", async () => {
  // The 5xx path used to read as PRESENT, which emptied the absent set, which made `classify`
  // conclude the defect was in the package's own tree. A transient registry fault turned the
  // declared, expected blocked-peer warning on transform and synth into a failed release.
  const h = harness({
    manifest: TRANSFORM_0_0_5,
    installResults: [{ ok: false, code: 1, output: "npm error code E404" }],
    routes: {
      "GET https://r/@cosyte%2ffhir": { status: 503, body: null },
      "GET https://r/@cosyte%2fhl7": { status: 200, body: { versions: {} } },
    },
  });
  const r = await runCheck({
    name: "@cosyte/transform",
    version: "0.0.5",
    attempts: 2,
    delayMs: 1,
    allowance: ["@cosyte/fhir"],
    ...h.opts,
  });
  assert.equal(r.verdict, "inconclusive");
  assert.equal(r.failing, false);
  assert.deepEqual(r.unknownDependencies, ["@cosyte/fhir"]);
  assert.match(renderAnnotation(r), /^::warning title=Install gate could not attribute a failure::/);
});

test("REGRESSION: an unanswered dependency cannot be excused into a pass either", async () => {
  // Fail-open must not become excuse-everything: `inconclusive` reports the failure, it does not
  // claim the package is fine.
  const h = harness({
    manifest: TRANSFORM_0_0_5,
    installResults: [{ ok: false, code: 1, output: "boom" }],
    routes: { "GET https://r/@cosyte%2ffhir": { status: 500, body: null } },
  });
  const r = await runCheck({ name: "@cosyte/transform", version: "0.0.5", attempts: 2, delayMs: 1, ...h.opts });
  assert.notEqual(r.verdict, "pass");
  assert.equal(r.verdict, "inconclusive");
});

test("REGRESSION: the clean room neutralizes the UPPERCASE npm config the job exports", async () => {
  // `actions/setup-node` exports NPM_CONFIG_USERCONFIG job-wide, pointing at the npmrc holding
  // `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`, and the uppercase form WINS over the
  // lowercase one in both insertion orders. Setting only the lowercase name meant the probe loaded
  // the job's authenticated npmrc, so "exactly what an anonymous outsider gets" was false.
  const saved = { ...process.env };
  try {
    process.env.NPM_CONFIG_USERCONFIG = "/job/.npmrc";
    process.env.NPM_CONFIG_GLOBALCONFIG = "/job/global.npmrc";
    process.env.NPM_CONFIG_REGISTRY = "https://evil.example.com/";
    process.env.npm_config_cache = "/job/cache";
    const env = cleanRoomEnv("/tmp/room", "https://r");
    for (const [key, value] of Object.entries(env)) {
      if (/^npm_config_/i.test(key)) {
        assert.match(value, /^(\/tmp\/room|https:\/\/r)/, `${key} escaped the clean room: ${value}`);
      }
    }
    assert.equal(env.NPM_CONFIG_USERCONFIG, "/tmp/room/cfg/user.npmrc");
    assert.equal(env.npm_config_userconfig, "/tmp/room/cfg/user.npmrc");
    assert.equal(env.NPM_CONFIG_REGISTRY, "https://r");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("REGRESSION: an inherited npm_config_* variable with no override is stripped, not passed through", async () => {
  const saved = process.env.npm_config_legacy_peer_deps;
  try {
    // This one would silently make the probe install a tree npm would otherwise refuse, which is
    // exactly the ERESOLVE that `@cosyte/synth` fails on.
    process.env.npm_config_legacy_peer_deps = "true";
    const env = cleanRoomEnv("/tmp/room", "https://r");
    assert.equal(env.npm_config_legacy_peer_deps, undefined);
  } finally {
    if (saved === undefined) delete process.env.npm_config_legacy_peer_deps;
    else process.env.npm_config_legacy_peer_deps = saved;
  }
});

test("REGRESSION: the stale-allowance remedy names the input that actually exists", async () => {
  // It said `expected-unpublished-deps`; the input is `expect-unpublished-deps`. This is the one
  // message rendered exactly when @cosyte/fhir publishes, so a caller following it would have
  // written an undefined input into a workflow_call.
  const summary = renderSummary({
    ...classify(facts()),
    package: "@cosyte/transform",
    version: "0.0.5",
    attemptsUsed: 1,
    missingDependencies: [],
    staleAllowance: ["@cosyte/fhir"],
    trail: [],
  });
  assert.match(summary, /`expect-unpublished-deps`/);
  assert.doesNotMatch(summary, /expected-unpublished-deps/);
});

test("REGRESSION: a pass does not claim entry points loaded when none were declared", async () => {
  const none = classify(facts({ entryPointsProbed: [] }));
  assert.equal(none.verdict, "pass");
  assert.match(none.reason, /declares no entry point and no bin/);
  const some = classify(facts({ entryPointsProbed: ["esm", "cjs"] }));
  assert.match(some.reason, /esm, cjs/);
});

test("REGRESSION: a killed install is a retryable failure, never a verdict on its own", async () => {
  // The command timeout exists because this holds a protected `release` environment. A kill must
  // look like any other install failure to the ladder.
  const h = harness({
    manifest: HL7_0_0_7,
    installResults: [
      { ok: false, code: -1, output: "timed out after 180000ms and was killed" },
      { ok: true, code: 0, output: "added 1 package" },
    ],
  });
  const r = await runCheck({ name: "@cosyte/hl7", version: "0.0.7", attempts: 4, delayMs: 1, ...h.opts });
  assert.equal(r.verdict, "pass");
});

test("REGRESSION: every verdict the classifier can produce has its own annotation branch", async () => {
  // The dominant defect class in this org is a branch nothing ever takes. An unhandled verdict would
  // fall through to the generic "did not complete" line and misreport itself.
  const produced = new Set([
    classify(facts({ specifierFindings: findNonRegistrySpecifiers(CLI_0_0_1) })).verdict,
    classify(facts({ ownServed: false, installAttempted: false, installOk: false })).verdict,
    classify(facts({ installOk: false, missingDependencies: ["@cosyte/fhir"], declaredAllowance: ["@cosyte/fhir"] })).verdict,
    classify(facts({ installOk: false, unknownDependencies: ["@cosyte/fhir"] })).verdict,
    classify(facts({ installOk: false, missingDependencies: [] })).verdict,
    classify(facts()).verdict,
  ]);
  produced.add(
    classify(facts({ installOk: false, deadlineExceeded: true })).verdict,
  );
  // Asserted against the module's own exported list rather than a literal retyped here, so the two
  // cannot drift. The previous version of this test enumerated six and omitted `deadline-exceeded`,
  // which meant the test whose entire job is to catch an unhandled verdict could not catch one.
  assert.deepEqual([...produced].sort(), [...VERDICTS].sort());
  for (const verdict of produced) {
    if (verdict === "pass") continue;
    const line = renderAnnotation({
      verdict,
      failing: verdict === "uninstallable" || verdict === "non-registry-specifier",
      reason: "r",
      package: "@cosyte/x",
      version: "1.0.0",
      attemptsUsed: 1,
      missingDependencies: ["@cosyte/fhir"],
      unknownDependencies: ["@cosyte/fhir"],
    });
    assert.doesNotMatch(line, /did not complete/, `${verdict} fell through to the catch-all`);
  }
});

// ── The gate's own deadline (pass 2) ───────────────────────────────────────────────────────────
//
// The refuter measured a SINGLE `npm install` taking 211s against a dependency packument returning
// 503, because npm retries a 5xx internally. Eight attempts of that is roughly thirty minutes, which
// blows past any sane `timeout-minutes`. A step timeout is a RED RUN, so without an internal clock a
// slow registry would red a correct, permanent release through the very bound added to protect it.

test("the gate stops itself before the step's timeout, and reports rather than condemning", async () => {
  let clock = 0;
  const h = harness({ manifest: HL7_0_0_7, installResults: [{ ok: false, code: 1, output: "slow" }] });
  const r = await runCheck({
    name: "@cosyte/hl7",
    version: "0.0.7",
    attempts: 8,
    delayMs: 1,
    deadlineMs: 500,
    installTimeoutMs: 180,
    now: () => (clock += 100),
    ...h.opts,
  });
  assert.equal(r.verdict, "deadline-exceeded");
  assert.equal(r.failing, false, "running slowly is not a defect in the published package");
  assert.ok(h.installs.length < 8, "it must stop short of the attempt budget when time runs out");
});

test("an attempt is only STARTED if its whole install could finish inside the deadline", async () => {
  // Checking only that the deadline has not yet passed would let a 180s install begin one second
  // before it and overrun into the step timeout, which is the red being avoided.
  let clock = 0;
  const h = harness({ manifest: HL7_0_0_7, installResults: [{ ok: false, code: 1, output: "x" }] });
  await runCheck({
    name: "@cosyte/hl7",
    version: "0.0.7",
    attempts: 20,
    delayMs: 1,
    deadlineMs: 1000,
    installTimeoutMs: 400,
    now: () => (clock += 200),
    ...h.opts,
  });
  // The fake clock advances 200 per `now()` call and `startedAt` consumes the first, so at the top
  // of attempt k the elapsed time is (k-1)*200. The guard admits an attempt only while
  // elapsed + installTimeoutMs <= deadlineMs, i.e. (k-1)*200 + 400 <= 1000, i.e. k <= 4. Attempt 4
  // starts at 600 and its install could run to exactly 1000, which is inside the budget; attempt 5
  // would start at 800 and could run to 1200, which is not.
  assert.equal(h.installs.length, 4, "the guard must admit exactly the attempts that fit");
  const worstCaseFinish = (h.installs.length - 1) * 200 + 400;
  assert.ok(worstCaseFinish <= 1000, `worst case finish ${worstCaseFinish} overruns the deadline`);
});

test("a deterministic specifier finding still fails even if the clock ran out", async () => {
  // The manifest lint is offline and complete however little time was left, so the deadline must not
  // launder a permanently broken publish into a warning.
  const r = classify({
    specifierFindings: findNonRegistrySpecifiers(CLI_0_0_1),
    ownServed: true,
    installOk: false,
    installAttempted: true,
    missingDependencies: [],
    unknownDependencies: [],
    deadlineExceeded: true,
    declaredAllowance: [],
    entryFailures: [],
  });
  assert.equal(r.verdict, "non-registry-specifier");
  assert.equal(r.failing, true);
});

test("the deadline verdict has its own annotation and never says the package is broken", async () => {
  const r = classify({
    specifierFindings: [],
    ownServed: true,
    installOk: false,
    installAttempted: true,
    missingDependencies: [],
    unknownDependencies: [],
    deadlineExceeded: true,
    declaredAllowance: [],
    entryFailures: [],
  });
  const line = renderAnnotation({ ...r, package: "@cosyte/hl7", version: "0.0.7", attemptsUsed: 2, missingDependencies: [], unknownDependencies: [] });
  assert.match(line, /^::warning title=Install gate ran out of time::/);
  assert.doesNotMatch(line, /not installable|did not complete/);
  assert.match(line, /installability is UNKNOWN/);
});

// ── Every registry fetch is bounded (pass 2) ────────────────────────────────────────────────────
//
// `globalThis.fetch` has NO default request timeout. Measured in this gate against a socket that
// accepts and never answers: a single unbounded fetch stalls 300.8 SECONDS. The deadline is only
// checked BETWEEN attempts, so one attempt holding several stalled fetches could run past the
// workflow step's `timeout-minutes` without the guard getting a turn, and a step timeout is a red
// run. Bounding the request is what closes it.

test("withFetchTimeout attaches an abort signal to every request", async () => {
  const seen = [];
  const wrapped = withFetchTimeout(async (url, options) => {
    seen.push(options?.signal);
    return { status: 200, json: async () => ({}), headers: new Map() };
  }, 5000);
  await wrapped("https://r/x");
  assert.equal(seen.length, 1);
  assert.ok(seen[0], "no signal was attached, so the request is unbounded");
  assert.equal(typeof seen[0].aborted, "boolean");
});

test("withFetchTimeout does not clobber a caller's own signal", async () => {
  const mine = new AbortController().signal;
  let got;
  const wrapped = withFetchTimeout(async (url, options) => {
    got = options.signal;
    return { status: 200, json: async () => ({}), headers: new Map() };
  }, 5000);
  await wrapped("https://r/x", { signal: mine });
  assert.equal(got, mine);
});

test("a timed-out fetch is UNKNOWN, which warns, and is never read as absence", async () => {
  // NOTE FOR ANYONE EDITING THIS: `AbortSignal.timeout()` creates an UNREF'D timer, so it does not
  // keep the event loop alive on its own. In production the pending socket does that. With a fake
  // fetch nothing does, the loop drains, and the abort never fires, so the test needs a ref'd
  // keepalive or it hangs. That is a property of the test harness, not of the gate.
  const keepAlive = setInterval(() => {}, 1);
  // A real AbortSignal.timeout rejection, not a simulated one.
  const stalling = withFetchTimeout(
    (url, options) =>
      new Promise((resolve, reject) => {
        const signal = options.signal;
        // Guard the already-aborted case: if the signal fired before this listener attached, the
        // event never comes and the promise hangs forever, which is the very failure being tested.
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    5,
  );
  assert.equal(await dependencyStatus("https://r", "@cosyte/fhir", stalling), "unknown");
  assert.equal(await packumentListsVersion("https://r", "@cosyte/hl7", "0.0.7", stalling), "unknown");
  assert.equal(await fetchVersionManifest("https://r", "@cosyte/hl7", "0.0.7", stalling), null);
  assert.equal(await tarballServed("https://r/t.tgz", stalling), false);
  clearInterval(keepAlive);
});

test("the dependency sweep stops at the deadline and calls the rest unknown, not present", async () => {
  // `@cosyte/cli` declares ten consumer dependencies, so the sweep length is set by the package
  // rather than by this file. A package with many dependencies against a slow registry must not walk
  // past the deadline inside a single attempt.
  let clock = 0;
  const h = harness({
    manifest: CLI_0_0_1_CLEAN_SPECIFIERS,
    installResults: [{ ok: false, code: 1, output: "boom" }],
  });
  const r = await runCheck({
    name: "@cosyte/cli",
    version: "0.0.1",
    attempts: 1,
    delayMs: 1,
    deadlineMs: 300,
    installTimeoutMs: 10,
    now: () => (clock += 100),
    ...h.opts,
  });
  assert.equal(r.verdict, "inconclusive", "an unreached dependency must be unknown, never present");
  assert.equal(r.failing, false);
  assert.ok(r.unknownDependencies.length > 0);
});

test("a mistyped numeric bound is refused, never silently defaulted", () => {
  // `Number("30s")` is NaN and NaN is falsy, so the old `Number(x || DEFAULT)` returned NaN, and
  // `withFetchTimeout` treats a falsy timeout as "no timeout" and hands back the RAW unbounded fetch.
  // A numeric option that fails open on a typo is the wrong shape in a file about unbounded waits.
  assert.equal(numericOption(undefined, 42), 42);
  assert.equal(numericOption("", 42), 42);
  assert.equal(numericOption("7", 42), 7);
  assert.equal(numericOption(0, 42, { min: 0 }), 0);
  for (const bad of ["30s", "abc", "NaN", "Infinity", "-1"]) {
    assert.throws(() => numericOption(bad, 42, { min: 1 }), /Refusing to fall back/, bad);
  }
});

test("withFetchTimeout returning the raw fetch is only reachable via an explicit zero", () => {
  // Documenting the one remaining way to get an unbounded fetch, so it is a choice and not a typo.
  const raw = async () => ({ status: 200, json: async () => ({}), headers: new Map() });
  assert.equal(withFetchTimeout(raw, 0), raw);
  assert.notEqual(withFetchTimeout(raw, 1000), raw);
});

// ── The workflow wiring itself (F6) ─────────────────────────────────────────────────────────────
//
// `test/release-notes.test.mjs` already asserts `release.yml`'s wiring by reading the file, and this
// slice's 76 new lines there had no assertions at all. That is the one part of this change with a
// blast radius across all 13 callers, so it is the last part that should be untested.

test("release.yml wires the gate the way the script expects", async () => {
  const { readFile } = await import("node:fs/promises");
  const yml = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

  // The predicate. A strict superset of the sibling step's, which is observed running on real
  // releases; `!cancelled()` so a failure in the release step does not skip the installability check.
  assert.match(yml, /if: \$\{\{ !cancelled\(\) && steps\.changesets\.outputs\.published == 'true' \}\}/);

  // The tooling path. A reusable workflow runs against the CALLER's checkout, so the script only
  // exists under the tooling checkout; a bare `scripts/` path would be a caller-side file.
  assert.match(yml, /node \.cosyte-release-tooling\/scripts\/install-check\.mjs/);

  // The allowance must actually reach the script. Wired but not passed is the org's classic defect.
  assert.match(yml, /expect-unpublished-deps:/);
  assert.match(yml, /EXPECT_UNPUBLISHED_DEPS: \$\{\{ inputs\.expect-unpublished-deps \}\}/);
  assert.match(yml, /--expect-unpublished-deps "\$EXPECT_UNPUBLISHED_DEPS"/);

  // The outermost bound. Without it a stalled step holds a protected `release` environment.
  assert.match(yml, /timeout-minutes: 15/);

  // The input is OPTIONAL with a default, which is what keeps the other callers working unchanged.
  // ONE GRAMMAR, TWO GATES: the default carries `ci.yml`'s `=<kind>` tag, and what this gate must
  // prove is that the tag changes NOTHING here. Asserted by running the literal from the workflow
  // through this gate's own parser rather than by restating the expected string, so a future edit to
  // either the default or the parser has to keep them in step.
  const declaredDefault = yml.match(/expect-unpublished-deps:[\s\S]{0,600}?default: "([^"]*)"/)?.[1];
  assert.equal(declaredDefault, "@cosyte/fhir=blocked");
  assert.deepEqual(parseAllowance(declaredDefault), ["@cosyte/fhir"]);

  // The gate must stay AFTER the publish and release steps: it reports on what actually shipped.
  assert.ok(
    yml.indexOf("Publish the GitHub release + dispatch docs rebuild") <
      yml.indexOf("The published package must be installable from the registry"),
    "the install gate must run after the release step, not before it",
  );

  // WHAT THIS WORKFLOW ASKS OF A CALLER'S TOKEN, PINNED. A called workflow's token can only be equal
  // to or more restrictive than its caller's, so every key added here has to be granted in thirteen
  // calling jobs FIRST or GitHub rejects the whole workflow at startup, for all of them at once.
  // Asserted against the YAML with comments stripped, because the comments discuss the keys at length
  // and would match otherwise.
  //
  // `actions: read` IS DELIBERATE AND IS THE ONE ADDITION. It is what the release-environment gate at
  // the top of the job reads a caller's protection rules with, it carries the caller-side
  // precondition written up under "THE CALLER-SIDE PRECONDITION" in release.yml, and it is a READ.
  // `issues: write` is still refused: it is a write, it buys a notifier rather than a gate, and
  // nobody has decided it is worth thirteen grants. The set is pinned WHOLE rather than by a
  // presence check, so a fourth key cannot arrive without someone reading this comment.
  const code = yml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(code, /issues:\s*write/);
  const header = "\npermissions:\n";
  const declared = [];
  for (const line of code.slice(code.indexOf(header) + header.length).split("\n")) {
    const match = /^ {2}([\w-]+): *([a-z]+)/.exec(line);
    if (!match) break;
    declared.push(`${match[1]}: ${match[2]}`);
  }
  assert.deepEqual(declared, ["contents: write", "id-token: write", "pull-requests: write", "actions: read"]);
});

// ── `--ignore-scripts` (founder decision, 2026-08-04) ───────────────────────────────────────────

test("the probe install passes --ignore-scripts, and the flag is asserted not assumed", async () => {
  // This runs in the release job, where the org-scoped RELEASE_PR_TOKEN is on disk in ~/.netrc with
  // contents/pull-requests/id-token write in scope. Without the flag, a postinstall in any TRANSITIVE
  // dependency of the probed package executes in that window, and those dependencies are
  // range-resolved at probe time rather than lockfile-pinned.
  //
  // Driven through the REAL `installIntoCleanRoom` with `npmBin` pointed at a recorder, so this
  // asserts the argv npm would actually receive rather than re-reading the source.
  const { mkdtemp, writeFile, chmod, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "ignore-scripts-test-"));
  const recorder = join(dir, "fake-npm");
  await writeFile(recorder, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/argv.txt"\n`);
  await chmod(recorder, 0o755);

  const result = await installIntoCleanRoom({
    dir,
    name: "@cosyte/hl7",
    version: "0.0.7",
    registry: "https://r",
    npmBin: recorder,
  });
  assert.equal(result.ok, true, "the recorder should exit 0, proving the call was actually made");

  const argv = (await readFile(join(dir, "argv.txt"), "utf8")).trim().split("\n");
  assert.equal(argv[0], "install");
  assert.equal(argv[1], "@cosyte/hl7@0.0.7");
  assert.ok(argv.includes("--ignore-scripts"), `npm argv did not carry the flag: ${argv.join(" ")}`);
});

// ── The entry probe's environment ───────────────────────────────────────────────────────────────
//
// `--ignore-scripts` closed the lifecycle half of what runs in the release job's credential window.
// The entry probe is the other half: it evaluates the module-init code of the whole import graph,
// and until `probeChildEnv` existed it did so with `process.env` inherited whole. The values below
// are sentinels, never real credentials, and nothing here prints one.

// THE FIRST TWO GROUPS ARE DIFFERENT CLAIMS AND THE DIFFERENCE IS WORTH KEEPING. Only the first is
// in the probe child's inherited environment on a real release run today: `release.yml` declares no
// job-level and no workflow-level `env`, so the token variables are step-scoped to
// `changesets/action` and do not persist, while the OIDC pair is present in every step because the
// workflow requests `id-token: write` for npm provenance. The second group is one line of YAML from
// being job-wide (that same file instructs a maintainer to set `NODE_AUTH_TOKEN` at JOB level if a
// `scope:` input is ever added), which is what this guard is for. The last entry is the point of the
// whole fixture: a name no list in this repo has ever seen, which a deny-list would miss and an
// allow-list excludes for free.
const SENTINEL = "sentinel-not-a-real-credential";
const POISONED_JOB_ENV = {
  // Actually in this `run:` step's environment today, because the workflow requests
  // `id-token: write` for npm provenance.
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: SENTINEL,
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.example/_apis/distributedtask/hubs/actions",
  // NOT in a `run:` step: the runner exposes it to action processes only, which is why
  // `crazy-max/ghaction-github-runtime` exists at all. Kept in the fixture because the scrub should
  // hold for it anyway if a future step ever does export it.
  ACTIONS_RUNTIME_TOKEN: SENTINEL,
  // Step-scoped today, job-wide after one edit.
  NODE_AUTH_TOKEN: SENTINEL,
  NPM_TOKEN: SENTINEL,
  GITHUB_TOKEN: SENTINEL,
  RELEASE_PR_TOKEN: SENTINEL,
  DOCS_REPO_DISPATCH_TOKEN: SENTINEL,
  // Not credentials, and dropped anyway: the first two point at the job's authenticated npmrc, the
  // third names the caller's checkout, and the last can `--require` an arbitrary file into the child.
  npm_config_userconfig: "/home/runner/work/_temp/.npmrc",
  NPM_CONFIG_USERCONFIG: "/home/runner/work/_temp/.npmrc",
  GITHUB_WORKSPACE: "/home/runner/work/hl7/hl7",
  NODE_OPTIONS: "--require /tmp/anything.js",
  // The negative control.
  A_SECRET_ADDED_TO_A_CALLER_AFTER_THIS_TEST_WAS_WRITTEN: SENTINEL,
};

test("the probe child's env is built from an allow-list, so an unlisted secret is excluded by construction", () => {
  const env = probeChildEnv("/tmp/room", { ...POISONED_JOB_ENV, PATH: "/usr/bin", TZ: "UTC" });
  for (const key of Object.keys(POISONED_JOB_ENV)) {
    assert.ok(!(key in env), `${key} reached the probe child`);
  }
  // Not merely blanked. A blanked variable is still a variable, and `cleanRoomEnv` blanks two
  // deliberately because npm INTERPOLATES them; nothing interpolates here, so absence is available
  // and is stronger.
  assert.equal(env.NODE_AUTH_TOKEN, undefined);
  // The allow-list half, which is what keeps this from being an empty env that changes behaviour.
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.TZ, "UTC");
});

test("an allow-listed variable the job does not set is absent, not the string undefined", () => {
  const env = probeChildEnv("/tmp/room", { PATH: "/usr/bin" });
  // `spawn` stringifies an undefined value, which would hand the child `NO_PROXY=undefined`: a set
  // variable with a nonsense value rather than an unset one.
  assert.ok(!("NO_PROXY" in env));
  assert.ok(!Object.values(env).includes(undefined));
});

test("HOME and USERPROFILE are moved inside the clean room, which is what takes ~/.netrc off the child's path", () => {
  const env = probeChildEnv("/tmp/room", { HOME: "/home/runner" });
  assert.equal(env.HOME, "/tmp/room/probe-home");
  assert.equal(env.USERPROFILE, "/tmp/room/probe-home");
  // HOME is not passed through, it is overridden. If it were on the list the override would still
  // win, but the list is where a future edit would put it back by accident.
  assert.ok(!PROBE_ENV_PASSTHROUGH.includes("HOME"));
});

test("REGRESSION: a real probe child sees none of the job's credentials, on BOTH arms", async () => {
  // The only test here that spawns anything. Still no network and no npm: it is `process.execPath`
  // loading a fixture package off disk, which is exactly the code path a published package's
  // module-init code arrives through.
  //
  // BOTH ARMS, because there are two spawns and every `@cosyte/*` package is dual ESM/CJS, so both
  // run on every real release. An earlier version of this fixture was `import`-only, and reverting
  // the CJS spawn's `env` argument alone left the suite green.
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const room = await mkdtemp(join(tmpdir(), "cosyte-probe-env-"));
  const pkgDir = join(room, "node_modules", "@cosyte", "probe-fixture");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@cosyte/probe-fixture",
      version: "0.0.0",
      type: "module",
      exports: { ".": { import: "./index.mjs", require: "./index.cjs" } },
    }),
  );
  // Module-init code. It records the NAMES it can see plus where `~` resolves to, never the values,
  // because a test artifact that dumps an environment is the failure mode this is about.
  const record = (file) =>
    `require("node:fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify({\n` +
    "  keys: Object.keys(process.env).sort(),\n" +
    "  home: process.env.HOME,\n" +
    '  homedir: require("node:os").homedir(),\n' +
    "}));\n";
  const seenEsm = join(room, "seen-esm.json");
  const seenCjs = join(room, "seen-cjs.json");
  await writeFile(
    join(pkgDir, "index.mjs"),
    'import { createRequire } from "node:module";\n' +
      "const require = createRequire(import.meta.url);\n" +
      record(seenEsm),
  );
  await writeFile(join(pkgDir, "index.cjs"), record(seenCjs));

  const saved = new Map(Object.entries(POISONED_JOB_ENV).map(([k]) => [k, process.env[k]]));
  try {
    Object.assign(process.env, POISONED_JOB_ENV);
    // THE NEGATIVE CONTROL. Without this the test would pass just as happily against a child that
    // was never spawned or a parent that never held the sentinels.
    assert.equal(process.env.RELEASE_PR_TOKEN, SENTINEL, "the parent must hold the sentinels");

    const result = await probeEntryPoints({ dir: room, name: "@cosyte/probe-fixture" });
    assert.deepEqual(result.failures, [], "the fixture must actually load, or nothing was observed");
    assert.deepEqual(result.probed, ["esm", "cjs"], "both spawns must have run, or one is untested");

    for (const [arm, file] of [["ESM", seenEsm], ["CJS", seenCjs]]) {
      const observed = JSON.parse(await readFile(file, "utf8"));
      for (const key of Object.keys(POISONED_JOB_ENV)) {
        assert.ok(
          !observed.keys.includes(key),
          `${key} was visible to third-party module-init code on the ${arm} arm`,
        );
      }
      assert.equal(observed.home, join(room, "probe-home"), `${arm}: HOME`);
      // Through node's own API, not just the raw variable: `os.homedir()` is what a module calls.
      assert.equal(observed.homedir, join(room, "probe-home"), `${arm}: os.homedir()`);
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(room, { recursive: true, force: true });
  }
});

// THE WHOLE SECURITY PROPERTY OF THE REMOVAL STEP IS ITS POSITION, so the position is what is
// pinned. Nothing else pins where this step sits: `actionlint` checks that the workflow is valid,
// not that its steps are in the one order that makes this one do anything, so a future edit that
// moves this step to the end of the job, or drops it, would otherwise ship green. Anchored
// structurally on the steps array, the way the version-PR wiring is anchored in
// `test/release-notes.test.mjs`, rather than on text adjacency.
test("release.yml drops the release credentials between the publish and everything that follows", async () => {
  const { readFile } = await import("node:fs/promises");
  const yml = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const steps = yml.slice(yml.indexOf("\n    steps:")).split(/\n      - (?=\S)/);
  const at = (needle) => steps.findIndex((s) => s.startsWith(`name: ${needle}`) || s.includes(`\n        id: ${needle}`));

  const drop = at("Drop the release credentials from disk");
  const changesets = at("changesets");
  const ghRelease = at("Publish the GitHub release + dispatch docs rebuild");
  const installGate = at("The published package must be installable from the registry");
  assert.ok(changesets > 0, "the changesets step must be findable, or this test proves nothing");
  assert.ok(drop > 0, "release.yml must drop the release credentials from disk");

  // AFTER the action, because the action's own `git push` is the credential's only consumer, and
  // BEFORE both steps that run code this org did not write: the caller's `pack:docs`, and the entry
  // probe's third-party module-init. Adjacent to the action, not merely somewhere after it.
  assert.equal(drop, changesets + 1, "the drop must be the step immediately after changesets/action");
  assert.ok(drop < ghRelease, "the drop must precede the caller's pack:docs command");
  assert.ok(drop < installGate, "the drop must precede the post-publish install gate");

  // `always()`, so a failed or skipped release step cannot leave the credentials on disk: the
  // install gate below runs under `!cancelled()` and would otherwise still run with them present.
  assert.match(steps[drop], /^\s*if: \$\{\{ always\(\) \}\}$/m);
  // Both files. The npmrc holds the raw NPM_TOKEN in plaintext on the publish arm, which is the only
  // arm the entry probe runs on at all.
  assert.match(steps[drop], /"\$HOME\/\.netrc"/);
  assert.match(steps[drop], /"\$HOME\/\.npmrc"/);
  // It must not be able to red a release that already published, and `exit 1` is not the only way
  // to do that: `shell: bash` runs under `-eo pipefail`, so an unguarded failing `rm` would exit the
  // step before the warn branch that exists to prevent exactly this.
  assert.doesNotMatch(steps[drop], /^\s*exit 1$/m);
  assert.match(steps[drop], /rm -f "\$f" \|\| true/);

  // WHICH FILES TO REMOVE WAS READ OUT OF `changesets/action` AT THIS SHA, so a bump to the action
  // can invalidate the step silently: it would still exit 0, still print "Removed", and still leave
  // a credential wherever the new version puts it. Nothing else in this repo notices where that
  // action writes. This assertion is the notice: it reds the suite, so the bump has to say out loud
  // that someone re-read src/index.ts.
  //
  // WHETHER REDDING THE SUITE ALSO BLOCKS THE MERGE IS NOT SOMETHING THIS FILE CAN KNOW, AND THE
  // SENTENCE THAT USED TO ANSWER IT HERE WAS FALSE BY THE TIME ANYONE READ IT. A repository cannot
  // observe its own ruleset, so a required-context list or count written into one rots the next time
  // a workflow grows a job, silently, with nothing to catch it. Do not write one back in either
  // direction. Derive the live answer, which folds in any org-level ruleset for free:
  //
  //   gh api repos/cosyte/.github/rules/branches/main \
  //     --jq '.[] | select(.type=="required_status_checks")
  //                 | .parameters.required_status_checks[].context'
  //
  // Per ruleset instead, where `includes_parents` defaults to true and is worth passing anyway so
  // the reader can see it was accounted for:
  //
  //   gh api 'repos/cosyte/.github/rulesets?includes_parents=true' --jq '.[].id'
  //   gh api repos/cosyte/.github/rulesets/<id> \
  //     --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks'
  assert.match(
    yml,
    /uses: changesets\/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d/,
    "changesets/action moved off the sha the credential-removal step was derived against. Re-read " +
      "its src/index.ts for where it writes the netrc and the npmrc, update the step and this pin " +
      "together, and do not simply update this line.",
  );
});
