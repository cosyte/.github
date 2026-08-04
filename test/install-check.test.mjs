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
  packageExists,
  fetchVersionManifest,
  tarballServed,
  renderAnnotation,
  renderSummary,
  parseArgs,
  cleanRoomEnv,
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

test("a 404 packument means the package is absent", async () => {
  const f = fakeFetch({ "GET https://r/@cosyte%2ffhir": { status: 404, body: null } });
  assert.equal(await packageExists("https://r", "@cosyte/fhir", f), false);
});

test("a 200 packument means the package is present", async () => {
  const f = fakeFetch({ "GET https://r/@cosyte%2fhl7": { status: 200, body: { name: "@cosyte/hl7" } } });
  assert.equal(await packageExists("https://r", "@cosyte/hl7", f), true);
});

test("a 5xx or a rate limit is NOT read as absence, so a flaky registry cannot manufacture a red", async () => {
  for (const status of [500, 502, 429, 403]) {
    const f = fakeFetch({ "GET https://r/@cosyte%2fhl7": { status, body: null } });
    assert.equal(await packageExists("https://r", "@cosyte/hl7", f), true, `status ${status}`);
  }
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
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || "GET";
    if (method === "HEAD") return { status: 200, json: async () => null, headers: new Map() };
    if (url.endsWith(`/${manifest.version}`)) {
      versionCalls += 1;
      return { status: versionCalls >= servedAfter ? 200 : 404, json: async () => manifest, headers: new Map() };
    }
    const key = `GET ${url}`;
    const hit = routes[key];
    return { status: hit ? hit.status : 200, json: async () => (hit ? hit.body : {}), headers: new Map() };
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
      entryProber: async () => [],
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
    entryProber: async () => ["ESM entry point failed to load: ERR_MODULE_NOT_FOUND"],
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
  // Written as an escape rather than the character, so this file itself stays free of one.
  const EM_DASH = "\u2014";
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
