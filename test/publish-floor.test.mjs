// Tests for scripts/publish-floor.mjs, the step that decides, BEFORE ANYTHING IS PACKED, which tool
// will perform this caller's publish, whether that tool clears the floor its staging mode needs, and
// whether the package exists on the registry at all.
//
// WHAT THESE TESTS ARE FOR, said once so each case reads against it. There are two ways to get this
// wrong and only one of them is recoverable.
//
//   THE CHEAP WRONG ANSWER is a red run. A caller that could have staged is told it cannot, someone
//   reads the refusal, and the version is released tomorrow.
//   THE EXPENSIVE WRONG ANSWER is a version number burned forever. It has exactly two routes: taking
//   the direct-publish arm because the registry did not answer and silence was read as "brand new",
//   and reporting a floor as met because nobody could read the tool's version.
//
// So every arm below is really asking: when this gate does not KNOW, does it refuse?
//
// AND ONE REGRESSION IN PARTICULAR IS GUARDED BY NAME. The roadmap phase that asked for this work
// carried false reasoning in its own evidence: that `changeset publish` calls `pnpm publish` which
// calls `npm publish`, so Node's bundled npm decides whether staging is reachable. Since pnpm 11 that
// chain does not exist, pnpm publishes natively, and `pnpm stage` has been there since v11.3.0. An
// implementation that hardcodes npm 11.15.0 as THE floor reds every pnpm-11 caller in this org for a
// binary that is not on their publish path. `the npm CLI on the runner does not decide a pnpm 11
// caller's floor` is that defect, written as a test.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  compareVersions,
  decide,
  lockfilesIn,
  meetsFloor,
  NPM_STAGING_FLOOR,
  NPM_STAGING_NODE_FLOOR,
  numericOption,
  parsePackageManagerField,
  parseVersion,
  PNPM_STAGING_FLOOR,
  registryExistence,
  registryExistenceWithRetry,
  renderAnnotation,
  resolvePublishTool,
  stagingRequirement,
} from '../scripts/publish-floor.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/publish-floor.mjs');
const WORKFLOW = resolve(HERE, '../.github/workflows/release.yml');

// ---------------------------------------------------------------------------
// Version arithmetic: the only three fields this gate ever compares
// ---------------------------------------------------------------------------

test('parseVersion reads a version and refuses anything that is not one', () => {
  assert.deepEqual(
    { ...parseVersion('11.17.0'), raw: undefined },
    { major: 11, minor: 17, patch: 0, raw: undefined },
  );
  assert.equal(parseVersion('v22.23.2').major, 22);
  assert.equal(parseVersion('11.3.0-beta.1').minor, 3);
  for (const junk of ['', 'latest', '11', '11.3', 'pnpm 11.3.0', null, undefined, 11.3]) {
    assert.equal(parseVersion(junk), null, `${JSON.stringify(junk)} is not a version`);
  }
});

test('compareVersions orders by major, then minor, then patch', () => {
  const v = (s) => parseVersion(s);
  assert.equal(compareVersions(v('10.9.8'), v('11.15.0')), -1);
  assert.equal(compareVersions(v('11.15.0'), v('11.15.0')), 0);
  assert.equal(compareVersions(v('11.17.0'), v('11.15.0')), 1);
  assert.equal(compareVersions(v('11.3.0'), v('11.15.0')), -1, '3 is less than 15, not more');
});

test('an unreadable version clears NO floor, which is the fail-closed direction', () => {
  assert.equal(meetsFloor('11.15.0', NPM_STAGING_FLOOR), true);
  assert.equal(meetsFloor('11.15.1', NPM_STAGING_FLOOR), true);
  assert.equal(meetsFloor('10.9.8', NPM_STAGING_FLOOR), false);
  assert.equal(meetsFloor('', NPM_STAGING_FLOOR), false);
  assert.equal(meetsFloor('unknown', NPM_STAGING_FLOOR), false);
  assert.equal(meetsFloor(undefined, NPM_STAGING_FLOOR), false);
});

test('numericOption refuses a bad value rather than shrinking the retry ladder by accident', () => {
  assert.equal(numericOption(undefined, 3), 3);
  assert.equal(numericOption('7', 3), 7);
  assert.equal(numericOption('nonsense', 3), 3);
  assert.equal(numericOption('0', 3), 3);
  assert.equal(numericOption('-4', 3), 3);
});

// ---------------------------------------------------------------------------
// A5: which tool performs the publish
// ---------------------------------------------------------------------------

test('parsePackageManagerField reads corepack pins, integrity suffix and all', () => {
  assert.deepEqual(parsePackageManagerField('pnpm@10.0.0'), { name: 'pnpm', version: '10.0.0' });
  assert.deepEqual(parsePackageManagerField('pnpm@11.17.0+sha512.abc123'), {
    name: 'pnpm',
    version: '11.17.0',
  });
  assert.deepEqual(parsePackageManagerField('npm@11.15.0'), { name: 'npm', version: '11.15.0' });
  for (const junk of ['pnpm', '', null, 42, {}]) {
    assert.equal(parsePackageManagerField(junk), null);
  }
});

test('resolvePublishTool takes a single agreeing signal from the caller tree', () => {
  assert.equal(resolvePublishTool({ packageManager: 'pnpm@11.17.0' }).tool, 'pnpm');
  assert.equal(resolvePublishTool({ packageManager: 'npm@11.15.0' }).tool, 'npm');
  assert.equal(resolvePublishTool({ lockfiles: ['pnpm-lock.yaml'] }).tool, 'pnpm');
  assert.equal(resolvePublishTool({ lockfiles: ['package-lock.json'] }).tool, 'npm');
  assert.equal(
    resolvePublishTool({ packageManager: 'pnpm@10.0.0', lockfiles: ['pnpm-lock.yaml'] }).tool,
    'pnpm',
    'a field and a lockfile that agree are one signal, not two',
  );
});

test('A6: an undecidable publish path is a refusal, not a default to npm', () => {
  // Nothing says anything.
  const silent = resolvePublishTool({});
  assert.equal(silent.tool, null);
  assert.match(silent.detail, /no packageManager field and no recognised lockfile/);

  // Two signals that disagree. Picking one here is picking one in production.
  const split = resolvePublishTool({ packageManager: 'pnpm@11.17.0', lockfiles: ['package-lock.json'] });
  assert.equal(split.tool, null);
  assert.match(split.detail, /more than one package manager/);
  assert.match(split.detail, /npm and pnpm/);

  // A manager this pipeline has no staging story for.
  const yarn = resolvePublishTool({ packageManager: 'yarn@4.0.0', lockfiles: ['yarn.lock'] });
  assert.equal(yarn.tool, null);
  assert.match(yarn.detail, /yarn/);
  assert.match(yarn.detail, /no staged-publishing floor/);
});

test('the refusal quotes what it actually read, so a caller can act on it without opening this repo', () => {
  const refused = resolvePublishTool({ packageManager: 'bun@1.2.0', lockfiles: ['bun.lockb'] });
  assert.match(refused.detail, /packageManager=bun@1\.2\.0/);
  assert.match(refused.detail, /lockfiles=bun\.lockb/);
});

test('lockfilesIn reports only the lockfiles that are really there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'floor-locks-'));
  assert.deepEqual(lockfilesIn(dir), []);
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  assert.deepEqual(lockfilesIn(dir), ['pnpm-lock.yaml']);
});

// ---------------------------------------------------------------------------
// A5: and which FLOOR that tool owes. This is the whole point of the criterion.
// ---------------------------------------------------------------------------

test('A5: pnpm 11 and later publishes natively, so pnpm owns the floor', () => {
  for (const version of ['11.3.0', '11.17.0', '12.0.1']) {
    const requirement = stagingRequirement({ tool: 'pnpm', version });
    assert.equal(requirement.stageTool, 'pnpm');
    assert.equal(requirement.floorTool, 'pnpm');
    assert.equal(requirement.floor, PNPM_STAGING_FLOOR);
    assert.equal(requirement.delegates, false);
    assert.equal(requirement.nodeFloor, null, 'pnpm documents no Node floor, so none is invented');
  }
});

test('A5: pnpm 10 still delegates, so the npm CLI floor is the one that binds', () => {
  for (const version of ['10.0.0', '10.34.5']) {
    const requirement = stagingRequirement({ tool: 'pnpm', version });
    assert.equal(requirement.stageTool, 'npm');
    assert.equal(requirement.floorTool, 'npm');
    assert.equal(requirement.floor, NPM_STAGING_FLOOR);
    assert.equal(requirement.nodeFloor, NPM_STAGING_NODE_FLOOR);
    assert.equal(requirement.delegates, true);
  }
});

test('A5: an npm caller owes the npm floor, both halves of npm own conjunctive sentence', () => {
  const requirement = stagingRequirement({ tool: 'npm', version: '11.17.0' });
  assert.equal(requirement.stageTool, 'npm');
  assert.equal(requirement.floor, NPM_STAGING_FLOOR);
  assert.equal(requirement.nodeFloor, NPM_STAGING_NODE_FLOOR);
});

test('A6: a tool that reports an unparseable version yields no requirement at all', () => {
  const requirement = stagingRequirement({ tool: 'pnpm', version: 'not a version' });
  assert.equal(requirement.stageTool, null);
  assert.match(requirement.detail, /cannot parse/);
});

// ---------------------------------------------------------------------------
// A12: does the package already exist, and what happens when the registry will not say
// ---------------------------------------------------------------------------

/**
 * A registry stub that answers exactly what a case asks it to.
 *
 * `closeAllConnections()` is not tidiness: Node's `fetch` keeps its sockets alive, and `close()`
 * alone waits for every one of them, so an in-process case would hang the whole file rather than
 * fail. The child-process cases below do not need it, because a socket dies with its process.
 */
async function stubRegistry(handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(() => done(undefined)));
    },
  };
}

test('A12: a packument with versions is "published"', async () => {
  // Recorded rather than asserted inside the handler: an assertion that throws in there never
  // answers the request, and the case hangs instead of failing.
  const paths = [];
  const registry = await stubRegistry((req, res) => {
    paths.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: '@cosyte/hl7', versions: { '0.0.6': {}, '0.0.7': {} } }));
  });
  try {
    const answer = await registryExistence(registry.url, '@cosyte/hl7', globalThis.fetch);
    assert.deepEqual(answer, { status: 'published', versions: 2 });
    // The scope separator is escaped and the `@` is not, which is the packument path npm serves and
    // the same encoding `install-check.mjs` uses against the live registry.
    assert.deepEqual(paths, ['/@cosyte%2fhl7']);
  } finally {
    await registry.close();
  }
});

test('A12: a 404 is the registry ANSWERING that nothing was ever published', async () => {
  const registry = await stubRegistry((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  try {
    assert.deepEqual(await registryExistence(registry.url, '@cosyte/new', globalThis.fetch), {
      status: 'never-published',
    });
  } finally {
    await registry.close();
  }
});

test('A12: everything else is "the registry did not say", and each one names why', async () => {
  const cases = [
    {
      what: 'a 503',
      handler: (_req, res) => {
        res.writeHead(503);
        res.end('upstream is having a day');
      },
      expect: /answered HTTP 503/,
    },
    {
      what: 'a 401, which is an auth problem and not an absence',
      handler: (_req, res) => {
        res.writeHead(401);
        res.end('{}');
      },
      expect: /answered HTTP 401/,
    },
    {
      what: '200 with a body that is not JSON',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('<html>a proxy interstitial</html>');
      },
      expect: /not JSON/,
    },
    {
      what: '200 with no versions map at all',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: '@cosyte/hl7' }));
      },
      expect: /no `versions` map/,
    },
    {
      // THE SUBTLE ONE. A name that exists but serves nothing is not npm's "brand-new package", and
      // the arm that reading would select is the irreversible one.
      what: '200 with an EMPTY versions map',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: '@cosyte/hl7', versions: {} }));
      },
      expect: /serves no versions at all/,
    },
    {
      what: 'a socket that accepts and then hangs up',
      handler: (_req, res) => {
        res.socket.destroy();
      },
      expect: /did not complete/,
    },
  ];
  for (const { what, handler, expect } of cases) {
    const registry = await stubRegistry(handler);
    try {
      const answer = await registryExistence(registry.url, '@cosyte/hl7', globalThis.fetch);
      assert.equal(answer.status, 'unknown', what);
      assert.match(answer.detail, expect, what);
    } finally {
      await registry.close();
    }
  }
});

test('only the unknown answer is retried, because a 200 and a 404 are both the registry speaking', async () => {
  let hits = 0;
  const registry = await stubRegistry((_req, res) => {
    hits += 1;
    res.writeHead(404);
    res.end('{}');
  });
  try {
    const answer = await registryExistenceWithRetry(registry.url, '@cosyte/new', globalThis.fetch, {
      attempts: 5,
      delayMs: 0,
    });
    assert.equal(answer.status, 'never-published');
    assert.equal(hits, 1, 'an answer is not asked for again');
  } finally {
    await registry.close();
  }

  let flaky = 0;
  const flakyRegistry = await stubRegistry((_req, res) => {
    flaky += 1;
    if (flaky < 3) {
      res.writeHead(503);
      res.end('');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ versions: { '0.0.1': {} } }));
  });
  try {
    const answer = await registryExistenceWithRetry(flakyRegistry.url, '@cosyte/hl7', globalThis.fetch, {
      attempts: 4,
      delayMs: 0,
    });
    assert.equal(answer.status, 'published', 'a blip is not an answer, so it is asked again');
    assert.equal(flaky, 3);
  } finally {
    await flakyRegistry.close();
  }
});

// ---------------------------------------------------------------------------
// The verdict, arm by arm
// ---------------------------------------------------------------------------

/** A caller that is fine in every way the case under test is not exercising. */
function facts(overrides = {}) {
  const publisher = overrides.publisher ?? { tool: 'pnpm', from: 'packageManager=pnpm@11.17.0' };
  const publisherVersion = overrides.publisherVersion ?? { version: '11.17.0' };
  return {
    packageName: '@cosyte/hl7',
    publisher,
    publisherVersion,
    requirement:
      overrides.requirement ??
      (publisher.tool && publisherVersion.version
        ? stagingRequirement({ tool: publisher.tool, version: publisherVersion.version })
        : { stageTool: null, detail: 'not reached' }),
    floorVersion: overrides.floorVersion ?? null,
    nodeVersion: overrides.nodeVersion ?? '22.23.2',
    existence: overrides.existence ?? { status: 'published', versions: 7 },
  };
}

test('A6: the tool cannot be identified, so the run is refused before anything is packed', () => {
  const verdict = decide(facts({ publisher: { tool: null, detail: 'nothing in the tree says' } }));
  assert.equal(verdict.failing, true);
  assert.equal(verdict.mode, 'refused');
  assert.match(verdict.message, /could not identify the tool/);
  assert.match(verdict.message, /nothing in the tree says/, 'it names what it could not read');
});

test('A6: the tool version cannot be read, so no floor is assumed met', () => {
  const verdict = decide(
    facts({
      publisherVersion: { version: null, detail: '`pnpm --version` failed: spawn pnpm ENOENT' },
    }),
  );
  assert.equal(verdict.failing, true);
  assert.match(verdict.message, /spawn pnpm ENOENT/);
  assert.match(verdict.message, /could not read the version of pnpm/);
});

test('A6: a pnpm 10 caller whose npm cannot be read is refused, not waved through', () => {
  const verdict = decide(
    facts({
      publisherVersion: { version: '10.34.5' },
      floorVersion: { version: null, detail: '`npm --version` printed no parseable version' },
    }),
  );
  assert.equal(verdict.failing, true);
  assert.match(verdict.message, /publishes through npm/);
  assert.match(verdict.message, /no parseable version/);
});

test('A12: the registry did not say, so the run is refused rather than taking the permanent arm', () => {
  const verdict = decide(
    facts({ existence: { status: 'unknown', detail: 'GET https://registry.npmjs.org/x answered HTTP 503' } }),
  );
  assert.equal(verdict.failing, true);
  assert.equal(verdict.mode, 'refused');
  assert.match(verdict.message, /could not determine whether the package already exists/);
  assert.match(verdict.message, /answered HTTP 503/, 'it names why it could not determine it');
  assert.match(verdict.message, /burns the version number permanently/);
});

test('A4: a package that has never been published publishes directly, and the run says staging was not available', () => {
  const verdict = decide(facts({ existence: { status: 'never-published' } }));
  assert.equal(verdict.failing, false);
  assert.equal(verdict.mode, 'direct');
  assert.match(verdict.message, /has never been published/);
  assert.match(verdict.message, /cannot stage a brand-new package/, 'it says WHY staging is unavailable');
  assert.match(verdict.message, /publishes DIRECTLY/);
  assert.match(verdict.message, /permanent/);
  assert.equal(verdict.outputs.mode, 'direct');
  assert.equal(verdict.outputs['registry-status'], 'never-published');
});

test('A4: the direct arm does NOT demand a staging floor it will not use', () => {
  // pnpm 9 clears no staging floor anywhere, and it does not have to: this release cannot stage.
  const verdict = decide(
    facts({
      publisherVersion: { version: '9.15.0' },
      floorVersion: { version: '10.9.8' },
      existence: { status: 'never-published' },
    }),
  );
  assert.equal(verdict.failing, false, 'a first release must not red for a capability npm forbids it');
  assert.equal(verdict.mode, 'direct');
});

test('A2: a publish path below its floor fails, naming the version found and the floor needed', () => {
  const verdict = decide(
    facts({
      publisher: { tool: 'pnpm', from: 'packageManager=pnpm@10.0.0' },
      publisherVersion: { version: '10.0.0' },
      floorVersion: { version: '10.9.8' },
    }),
  );
  assert.equal(verdict.failing, true);
  assert.equal(verdict.mode, 'refused');
  assert.match(verdict.message, /npm 10\.9\.8 is below the npm 11\.15\.0/, 'the version found and the floor needed');
  assert.match(verdict.message, /before anything is packed/);
  assert.match(verdict.message, /CALLING repository/, 'the fix is named, and it is not in this repo');
});

test('A2: the Node half of npm own floor is asserted too', () => {
  const verdict = decide(
    facts({
      publisher: { tool: 'npm', from: 'packageManager=npm@11.17.0' },
      publisherVersion: { version: '11.17.0' },
      nodeVersion: '22.13.1',
    }),
  );
  assert.equal(verdict.failing, true);
  assert.match(verdict.message, /Node 22\.13\.1 is below the Node 22\.14\.0/);
});

test('A1: an already-published package at or above its floor takes the staged arm', () => {
  const verdict = decide(facts());
  assert.equal(verdict.failing, false);
  assert.equal(verdict.mode, 'staged');
  assert.match(verdict.message, /already exists on the registry/);
  assert.match(verdict.message, /instead of being promoted/);
  assert.match(verdict.message, /does not become resolvable to a consumer until a maintainer approves it/);
  assert.equal(verdict.outputs.mode, 'staged');
  assert.equal(verdict.outputs['stage-tool'], 'pnpm');
  assert.equal(verdict.outputs.floor, PNPM_STAGING_FLOOR);
});

test('exactly at the floor is not below it', () => {
  const verdict = decide(facts({ publisherVersion: { version: PNPM_STAGING_FLOOR } }));
  assert.equal(verdict.failing, false);
  assert.equal(verdict.mode, 'staged');
});

// THE REGRESSION THE ROADMAP'S OWN EVIDENCE WOULD HAVE SHIPPED.
test('A5: the npm CLI on the runner does not decide a pnpm 11 caller floor', () => {
  // Node 22 bundles npm 10.9.8, which clears NEITHER npm floor. On a pnpm 11 caller that is simply
  // not the binary doing the publishing, and an implementation that compared against it would red
  // every pnpm-11 release in this org.
  const requirement = stagingRequirement({ tool: 'pnpm', version: '11.17.0' });
  assert.notEqual(requirement.floor, NPM_STAGING_FLOOR);
  assert.equal(requirement.floorTool, 'pnpm');

  const verdict = decide(
    facts({
      publisherVersion: { version: '11.17.0' },
      // Deliberately supplied and deliberately irrelevant: nothing may read it on this arm.
      floorVersion: null,
      nodeVersion: '22.23.2',
    }),
  );
  assert.equal(verdict.failing, false, 'a pnpm 11 caller stages, whatever npm the runner happens to bundle');
  assert.equal(verdict.mode, 'staged');
  assert.equal(verdict.outputs['stage-tool-version'], '11.17.0');
});

test('every refusal reports mode `refused`, which is neither of the two arms downstream reads', () => {
  const refusals = [
    facts({ publisher: { tool: null, detail: 'x' } }),
    facts({ publisherVersion: { version: null, detail: 'x' } }),
    facts({ existence: { status: 'unknown', detail: 'x' } }),
    facts({ publisherVersion: { version: '10.0.0' }, floorVersion: { version: '10.9.8' } }),
  ];
  for (const f of refusals) {
    const verdict = decide(f);
    assert.equal(verdict.failing, true);
    assert.equal(verdict.outputs.mode, 'refused');
    assert.notEqual(verdict.outputs.mode, 'direct');
    assert.notEqual(verdict.outputs.mode, 'staged');
  }
});

test('the annotation level tracks the outcome, so a one-way door is not reported as routine', () => {
  assert.match(renderAnnotation(decide(facts())), /^::notice /);
  assert.match(renderAnnotation(decide(facts({ existence: { status: 'never-published' } }))), /^::warning /);
  assert.match(renderAnnotation(decide(facts({ publisher: { tool: null, detail: 'x' } }))), /^::error /);
});

// ---------------------------------------------------------------------------
// The real entry point, as a real child process, with a real socket and real binaries on PATH
// ---------------------------------------------------------------------------
//
// A unit test of `decide` proves the classification and none of the wiring: not the argument
// parsing, not `<tool> --version` actually being spawned, not the GITHUB_OUTPUT contract three step
// conditions in release.yml read, and above all not THE PROCESS EXIT STATUS, which is the entire
// mechanism by which a refusal reaches a caller as a failure.

const SHIM = (tool) => `#!/usr/bin/env node
const fs = require('node:fs');
const tool = ${JSON.stringify(tool)};
const args = process.argv.slice(2);
if (process.env.ARGV_LOG) fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify([tool, ...args]) + '\\n');
const key = (s) => process.env['FAKE_' + tool.toUpperCase() + '_' + s];
if (args[0] === '--version') {
  if (key('VERSION') === 'MISSING') process.exit(127);
  process.stdout.write((key('VERSION') || '1.0.0') + '\\n');
  process.exit(0);
}
process.stdout.write(key('STDOUT') || '');
process.stderr.write(key('STDERR') || '');
process.exit(Number(key('EXIT') || 0));
`;

/** A throwaway caller checkout plus a bin directory holding fake `pnpm` and `npm`. */
export function makeCaller({ packageManager, lockfiles = [], version = '0.0.8', name = '@cosyte/hl7' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'floor-caller-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const tool of ['pnpm', 'npm']) {
    const file = join(bin, tool);
    writeFileSync(file, SHIM(tool));
    chmodSync(file, 0o755);
  }
  const repo = join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name, version, ...(packageManager ? { packageManager } : {}) }, null, 2)}\n`,
  );
  for (const lock of lockfiles) writeFileSync(join(repo, lock), '');
  return { root, bin, repo, outputs: join(root, 'outputs.txt'), summary: join(root, 'summary.md') };
}

/** Run the real entry point the way release.yml does. */
export async function runFloor(caller, { registry, env = {}, args = [] } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        SCRIPT,
        '--package',
        '@cosyte/hl7',
        '--repo',
        caller.repo,
        '--registry',
        registry,
        '--attempts',
        '2',
        '--retry-delay-ms',
        '0',
        ...args,
      ],
      {
        env: {
          PATH: `${caller.bin}:${process.env.PATH}`,
          GITHUB_OUTPUT: caller.outputs,
          GITHUB_STEP_SUMMARY: caller.summary,
          ...env,
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const outputsOf = (caller) => {
  let text = '';
  try {
    text = readFileSync(caller.outputs, 'utf8');
  } catch {
    return {};
  }
  return Object.fromEntries(
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
};

const packumentWith = (versions) => (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ name: '@cosyte/hl7', versions }));
};

test('end to end: a pnpm 11 caller of an existing package exits 0 and selects the staged arm', async () => {
  const caller = makeCaller({ packageManager: 'pnpm@11.17.0', lockfiles: ['pnpm-lock.yaml'] });
  const registry = await stubRegistry(packumentWith({ '0.0.7': {} }));
  try {
    const run = await runFloor(caller, {
      registry: registry.url,
      env: { FAKE_PNPM_VERSION: '11.17.0', FAKE_NPM_VERSION: '10.9.8' },
    });
    assert.equal(run.code, 0, run.stderr);
    const outputs = outputsOf(caller);
    assert.equal(outputs.mode, 'staged');
    assert.equal(outputs['stage-tool'], 'pnpm');
    assert.equal(outputs['stage-tool-version'], '11.17.0');
    assert.equal(outputs.floor, PNPM_STAGING_FLOOR);
    // The runner's npm is below both npm floors and it changed nothing, which is A5 end to end.
    assert.match(readFileSync(caller.summary, 'utf8'), /STAGED|staged for review/i);
  } finally {
    await registry.close();
  }
});

test('end to end: a pnpm 10 caller below the npm floor EXITS NON-ZERO, naming both numbers', async () => {
  const caller = makeCaller({ packageManager: 'pnpm@10.34.5', lockfiles: ['pnpm-lock.yaml'] });
  const registry = await stubRegistry(packumentWith({ '0.0.7': {} }));
  try {
    const run = await runFloor(caller, {
      registry: registry.url,
      env: { FAKE_PNPM_VERSION: '10.34.5', FAKE_NPM_VERSION: '10.9.8' },
    });
    assert.equal(run.code, 1, 'a refusal has to reach the caller as a FAILED step');
    assert.match(run.stdout, /::error title=The publish path is below its staged-publishing floor::/);
    assert.match(run.stderr, /npm 10\.9\.8 is below the npm 11\.15\.0/);
    assert.equal(outputsOf(caller).mode, 'refused');
  } finally {
    await registry.close();
  }
});

test('end to end: a pnpm 10 caller whose npm DOES clear the floor stages through npm', async () => {
  const caller = makeCaller({ packageManager: 'pnpm@10.34.5', lockfiles: ['pnpm-lock.yaml'] });
  const registry = await stubRegistry(packumentWith({ '0.0.7': {} }));
  try {
    const run = await runFloor(caller, {
      registry: registry.url,
      env: { FAKE_PNPM_VERSION: '10.34.5', FAKE_NPM_VERSION: '11.17.0' },
    });
    assert.equal(run.code, 0, run.stderr);
    const outputs = outputsOf(caller);
    assert.equal(outputs.mode, 'staged');
    assert.equal(outputs['stage-tool'], 'npm', 'the delegation is real on pnpm 10');
    assert.equal(outputs['stage-tool-version'], '11.17.0');
  } finally {
    await registry.close();
  }
});

test('end to end: a 404 selects the direct arm and warns that staging was not available', async () => {
  const caller = makeCaller({ packageManager: 'pnpm@11.17.0' });
  const registry = await stubRegistry((_req, res) => {
    res.writeHead(404);
    res.end('{}');
  });
  try {
    const run = await runFloor(caller, { registry: registry.url, env: { FAKE_PNPM_VERSION: '11.17.0' } });
    assert.equal(run.code, 0);
    assert.equal(outputsOf(caller).mode, 'direct');
    assert.match(run.stdout, /::warning title=Staged publishing is not available/);
    assert.match(run.stdout, /cannot stage a brand-new package/);
  } finally {
    await registry.close();
  }
});

test('end to end: a registry that will not answer EXITS NON-ZERO rather than guessing brand new', async () => {
  const caller = makeCaller({ packageManager: 'pnpm@11.17.0' });
  let hits = 0;
  const registry = await stubRegistry((_req, res) => {
    hits += 1;
    res.writeHead(503);
    res.end('');
  });
  try {
    const run = await runFloor(caller, { registry: registry.url, env: { FAKE_PNPM_VERSION: '11.17.0' } });
    assert.equal(run.code, 1);
    assert.equal(hits, 2, 'the ladder was spent before the verdict was taken');
    assert.match(run.stderr, /could not determine whether the package already exists/);
    assert.match(run.stderr, /after 2 attempts/);
    assert.equal(outputsOf(caller).mode, 'refused');
  } finally {
    await registry.close();
  }
});

test('end to end: a tool that is not installed EXITS NON-ZERO and never asks the registry', async () => {
  const caller = makeCaller({ packageManager: 'pnpm@11.17.0' });
  let hits = 0;
  const registry = await stubRegistry(
    /** @type {any} */ ((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ versions: { '0.0.7': {} } }));
    }),
  );
  try {
    const run = await runFloor(caller, { registry: registry.url, env: { FAKE_PNPM_VERSION: 'MISSING' } });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /could not read the version of pnpm/);
    assert.equal(hits, 0, 'a run that is already refusing does not spend a retry ladder first');
  } finally {
    await registry.close();
  }
});

test('end to end: a caller with no packageManager and no lockfile EXITS NON-ZERO', async () => {
  const caller = makeCaller({});
  const registry = await stubRegistry(packumentWith({ '0.0.7': {} }));
  try {
    const run = await runFloor(caller, { registry: registry.url });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /could not identify the tool/);
  } finally {
    await registry.close();
  }
});

test('end to end: an unreadable package.json EXITS NON-ZERO rather than assuming npm', async () => {
  const caller = makeCaller({ packageManager: 'pnpm@11.17.0' });
  writeFileSync(join(caller.repo, 'package.json'), '{ not json');
  const registry = await stubRegistry(packumentWith({ '0.0.7': {} }));
  try {
    const run = await runFloor(caller, { registry: registry.url, env: { FAKE_PNPM_VERSION: '11.17.0' } });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /package\.json could not be read/);
  } finally {
    await registry.close();
  }
});

// ---------------------------------------------------------------------------
// THE WIRING: A2's "before anything is packed", asserted by parsing release.yml
// ---------------------------------------------------------------------------
//
// A gate that exists and is reached too late is not a gate, and no exit status anywhere would say
// so. This needs no release, no caller and no network, so it runs on every push to main.

/** Every step of the `release` job, in order, with its comment lines stripped. */
export function releaseSteps(workflow) {
  const job = workflow.slice(workflow.indexOf('\n  release:'));
  const chunks = job.slice(job.indexOf('\n    steps:')).split(/\n {6}- (?=\S)/).slice(1);
  return chunks.map((chunk, index) => {
    const body = chunk
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    /** @type {Record<string, string>} */
    const fields = {};
    const lines = body.split('\n');
    const first = /^([\w-]+):\s?(.*)$/.exec(lines[0]);
    if (first) fields[first[1]] = first[2];
    for (const line of lines.slice(1)) {
      const match = /^ {8}([\w-]+):\s?(.*)$/.exec(line);
      if (match) fields[match[1]] = match[2];
    }
    return { index, body, fields, label: fields.name || fields.uses || `step ${index}` };
  });
}

test('the parser still understands release.yml, or every assertion below is vacuous', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));
  assert.ok(steps.length >= 20, `expected the release job's full step list, parsed ${steps.length}`);
  assert.equal(steps.filter((s) => /publish-floor\.mjs/.test(s.body)).length, 1);
});

test('A2: the floor gate precedes install, the verify ladder and the publish step', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));
  const gate = steps.findIndex((s) => /publish-floor\.mjs/.test(s.body));
  assert.ok(gate >= 0, 'the floor gate has to be in the release job');

  // `pnpm attw` shells out to `npm pack`, so the verify ladder IS a packing step.
  const packers = steps.filter(
    (s) =>
      /pnpm install/.test(s.body) ||
      /pnpm attw/.test(s.body) ||
      /pack:docs/.test(s.body) ||
      /changesets\/action@/.test(s.body),
  );
  assert.ok(packers.length >= 3, 'the packing and publishing steps must still be recognisable');
  for (const step of packers) {
    assert.ok(step.index > gate, `${step.label} must run AFTER the floor gate, not before it`);
  }
});

test('A2: the floor gate runs on exactly the runs that publish, on the pipeline own predicate', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));
  const gate = steps.find((s) => /publish-floor\.mjs/.test(s.body));
  assert.equal(gate.fields.id, 'publish-floor', 'three step conditions below read this id');
  assert.equal(gate.fields.if, "${{ steps.notes.outputs.is-release == 'true' }}");
});

test('A1: the publish command is the staged script on the staged arm and unchanged otherwise', () => {
  const steps = releaseSteps(readFileSync(WORKFLOW, 'utf8'));
  const action = steps.find((s) => /changesets\/action@/.test(s.body));
  const publish = /\n {10}publish: (.*)/.exec(action.body)[1];

  assert.match(publish, /steps\.notes\.outputs\.is-release == 'true'/, 'the notes gate still guards it');
  assert.match(publish, /steps\.publish-floor\.outputs\.mode == 'staged'/);
  assert.match(publish, /staged-publish\.mjs stage --package/);
  assert.match(publish, /'pnpm run release'/, 'the direct arm is unchanged');
  // The shape matters: `A && '' || B` would hand the command back on the run that must not have it.
  assert.ok(publish.trimEnd().endsWith("|| '' }}"), `withholding must stay the outer default: ${publish}`);
});
