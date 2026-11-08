// Tests over `test/package-lists.mjs`, the check that holds the package lists in SECURITY.md,
// CONTRIBUTING.md and profile/README.md to the catalog in `@cosyte/script-utils`.
//
// Offline, every one. The check itself reads the latest catalog on npm, in `self-check.yml`'s
// `package-lists` job; these run its comparison over a small catalog written here, and over the
// tracked documents for what holds whatever the catalog says: every list is marked and readable,
// and the three documents name the same libraries in the same order.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CheckError,
  DOCUMENTS,
  checkCounts,
  checkDocument,
  readCatalog,
  regionsOf,
  serialList,
} from './package-lists.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SCRIPT = join(HERE, 'package-lists.mjs');

// ---------------------------------------------------------------------------
// A catalog of five libraries and Pathways, and three documents that follow it
// ---------------------------------------------------------------------------

function library(slug, tier, standard) {
  return {
    name: `@cosyte/${slug}`,
    slug,
    description: `The ${slug} library.`,
    line: '0.1',
    engines: { node: '>=22.0.0' },
    repository: `https://github.com/cosyte/${slug}`,
    docs: `https://docs.cosyte.com/${slug}`,
    npm: `https://www.npmjs.com/package/@cosyte/${slug}`,
    tier,
    ...(standard === undefined ? {} : { standard }),
  };
}

function rawCatalog() {
  return {
    libraries: [
      library('hl7', 'standard', 'HL7 v2'),
      library('fhir', 'standard', 'FHIR'),
      library('x12', 'standard', 'X12'),
      library('deid', 'built-on'),
      library('cli', 'built-on'),
    ],
    engine: {
      name: '@cosyte/pathways',
      slug: 'pathways',
      repository: 'https://github.com/cosyte/pathways',
      docs: 'https://docs.cosyte.com/pathways',
      tier: 'engine',
      displayName: 'Pathways',
      status: 'in development',
      onNpm: false,
    },
  };
}

const SECURITY = `# Security policy

<!-- catalog:roster:start: checked. -->

This policy covers our 5 open-source libraries and Pathways:

- one library for each of 3 standards: \`@cosyte/hl7\`, \`@cosyte/fhir\`, and \`@cosyte/x12\`;
- 2 libraries built on them: \`@cosyte/deid\` and \`@cosyte/cli\`;
- [Pathways](https://github.com/cosyte/pathways), our integration engine, in development.

<!-- catalog:roster:end -->

## Supported versions

- **The 5 libraries:** the 0.1 line is supported.
`;

const CONTRIBUTING = `# Contributing

<!-- catalog:roster:start -->

This guide covers our 5 libraries, one for each of 3 standards (\`@cosyte/hl7\`,
\`@cosyte/fhir\`, and \`@cosyte/x12\`) and 2 built on them (\`@cosyte/deid\` and
\`@cosyte/cli\`), and [Pathways](https://github.com/cosyte/pathways), our integration engine, in
development.

<!-- catalog:roster:end -->
`;

function row(slug, docs = `https://docs.cosyte.com/${slug}/quickstart?utm_source=github`) {
  return (
    `| \`@cosyte/${slug}\` | What ${slug} does | [npm](https://www.npmjs.com/package/@cosyte/${slug}) · ` +
    `[docs](${docs}) · [repo](https://github.com/cosyte/${slug}) |`
  );
}

const PROFILE = `# Profile

<!-- catalog:roster:start -->

We publish 5 libraries: one for each of 3 standards (HL7 v2, FHIR, and X12) and 2 built on them
(deid and cli). [Pathways](https://github.com/cosyte/pathways) is our integration engine, in
development.

<!-- catalog:roster:end -->

All 5 are MIT licensed.

## Libraries

<!-- catalog:table:start -->

| Package | What it does | Links |
|---|---|---|
${['hl7', 'fhir', 'x12', 'deid', 'cli'].map((slug) => row(slug)).join('\n')}

<!-- catalog:table:end -->
`;

const TEXTS = { 'SECURITY.md': SECURITY, 'CONTRIBUTING.md': CONTRIBUTING, 'profile/README.md': PROFILE };

/** Every finding over the three documents, against a catalog (the one above unless given). */
function findingsOver(texts = TEXTS, raw = rawCatalog()) {
  const catalog = readCatalog(raw);
  return Object.entries(DOCUMENTS).flatMap(([path, kinds]) => checkDocument(path, texts[path], kinds, catalog));
}

/** The findings as `path:line: message` lines, which is what an assertion failure prints best. */
const lines = (findings) => findings.map((f) => `${f.path}:${f.line}: ${f.message}`);

// ---------------------------------------------------------------------------
// What follows the catalog passes
// ---------------------------------------------------------------------------

test('a list is spelled with the serial comma, and two items take a plain and', () => {
  assert.equal(serialList(['a']), 'a');
  assert.equal(serialList(['a', 'b']), 'a and b');
  assert.equal(serialList(['a', 'b', 'c']), 'a, b, and c');
});

test('documents that follow the catalog have no finding, in every form a list takes', () => {
  assert.deepEqual(lines(findingsOver()), []);
});

test('a docs link may name a page, a query or an anchor under the catalog address', () => {
  const texts = { ...TEXTS, 'profile/README.md': PROFILE.replace(row('hl7'), row('hl7', 'https://docs.cosyte.com/hl7')) };
  assert.deepEqual(lines(findingsOver(texts)), []);
  const anchored = { ...TEXTS, 'profile/README.md': PROFILE.replace(row('hl7'), row('hl7', 'https://docs.cosyte.com/hl7#a')) };
  assert.deepEqual(lines(findingsOver(anchored)), []);
});

// ---------------------------------------------------------------------------
// The tracked documents, whatever the catalog says
// ---------------------------------------------------------------------------

test('every tracked document carries the lists the check reads, and each one is readable', () => {
  for (const [path, kinds] of Object.entries(DOCUMENTS)) {
    const { regions, problems } = regionsOf(path, readFileSync(join(REPO, path), 'utf8'));
    assert.deepEqual(lines(problems), [], `${path}'s markers`);
    assert.deepEqual(regions.map((region) => region.kind).sort(), [...kinds].sort(), `${path}'s lists`);
  }
});

test('the three tracked documents name the same libraries in the same order', () => {
  const region = (path, kind) =>
    regionsOf(path, readFileSync(join(REPO, path), 'utf8')).regions.find((r) => r.kind === kind).lines.join('\n');
  const named = (text) => [...text.matchAll(/`(@cosyte\/[a-z0-9.-]+)`/g)].map((match) => match[1]);
  const security = named(region('SECURITY.md', 'roster'));
  const contributing = named(region('CONTRIBUTING.md', 'roster'));
  const table = region('profile/README.md', 'table')
    .split('\n')
    .map((line) => /^\| `(@cosyte\/[a-z0-9.-]+)` \|/.exec(line)?.[1])
    .filter((name) => name !== undefined);
  assert.ok(security.length > 0, "SECURITY.md's roster names no library");
  assert.deepEqual(contributing, security);
  assert.deepEqual(table, security);
  const counted = /\b(\d+) libraries\b/.exec(region('profile/README.md', 'roster').replace(/\s+/g, ' '));
  assert.equal(Number(counted?.[1]), table.length, "the profile's roster counts the table's rows");
});

// ---------------------------------------------------------------------------
// What drifts from the catalog is a finding
// ---------------------------------------------------------------------------

test('a library the catalog adds is missing from every list and every count', () => {
  const raw = rawCatalog();
  raw.libraries.splice(3, 0, library('astm', 'standard', 'ASTM'));
  const found = lines(findingsOver(TEXTS, raw));
  for (const path of Object.keys(DOCUMENTS)) {
    assert.ok(found.some((f) => f.startsWith(`${path}:`) && f.includes('libraries for a standard')), `${path}: ${found}`);
  }
  assert.ok(found.includes('profile/README.md:15: the table has no row for @cosyte/astm; the catalog lists it once.'), found.join('\n'));
  assert.ok(found.some((f) => f.startsWith('profile/README.md:') && f.includes('"All 5" counts 5 libraries; the catalog has 6')));
  assert.ok(found.some((f) => f.includes('"3 standards" counts 3 standards; the catalog has 4')));
});

test('a library the catalog drops from the front of a list is a finding, not a shorter match', () => {
  const raw = rawCatalog();
  raw.libraries.splice(3, 1);
  const found = lines(findingsOver(TEXTS, raw));
  for (const path of Object.keys(DOCUMENTS)) {
    assert.ok(found.some((f) => f.startsWith(`${path}:`) && f.includes('libraries built on them whole')), `${path}: ${found}`);
  }
  assert.ok(found.includes('profile/README.md:22: the table has a row for `@cosyte/deid`, which the catalog does not list.'));
});

test('a standard renamed in the catalog is a finding where readers see the standard', () => {
  const raw = rawCatalog();
  raw.libraries[1].standard = 'FHIR R4';
  const found = lines(findingsOver(TEXTS, raw));
  assert.deepEqual(
    found.map((f) => f.split(':')[0]),
    ['profile/README.md'],
    'only the roster that names the standards changes',
  );
  assert.match(found[0], /HL7 v2, FHIR R4, and X12/);
});

test('a library moved to the other tier is a finding in every roster', () => {
  const raw = rawCatalog();
  const [x12] = raw.libraries.splice(2, 1);
  delete x12.standard;
  raw.libraries.splice(3, 0, { ...x12, tier: 'built-on' });
  const found = lines(findingsOver(TEXTS, raw));
  for (const path of Object.keys(DOCUMENTS)) {
    assert.ok(found.some((f) => f.startsWith(`${path}:`) && f.includes('libraries for a standard')), `${path}: ${found}`);
  }
});

test("Pathways' status and repository come from the catalog", () => {
  const raw = rawCatalog();
  raw.engine.status = 'released';
  raw.engine.repository = 'https://github.com/cosyte/engine';
  const found = lines(findingsOver(TEXTS, raw));
  for (const path of Object.keys(DOCUMENTS)) {
    assert.ok(found.some((f) => f.startsWith(`${path}:`) && f.includes('the status of Pathways, "released"')), `${path}: ${found}`);
    assert.ok(found.some((f) => f.startsWith(`${path}:`) && f.includes('link Pathways to https://github.com/cosyte/engine')));
  }
});

test('a count outside any list is read too, and the finding names its line', () => {
  const text = 'One.\n\nOur 4 libraries, and all 7 of them.\n';
  assert.deepEqual(lines(checkCounts('SECURITY.md', text, readCatalog(rawCatalog()))), [
    'SECURITY.md:3: "4 libraries" counts 4 libraries; the catalog has 5.',
    'SECURITY.md:3: "all 7" counts 7 libraries; the catalog has 5.',
  ]);
  assert.deepEqual(lines(checkCounts('SECURITY.md', 'The 6 libraries\nbuilt on them.', readCatalog(rawCatalog()))), [
    'SECURITY.md:1: "6 libraries built on them" counts 6 libraries built on them; the catalog has 2.',
  ]);
});

test('a roster that names no count, or a wrong one, is a finding', () => {
  const texts = { ...TEXTS, 'CONTRIBUTING.md': CONTRIBUTING.replace('our 5 libraries', 'our libraries') };
  assert.deepEqual(lines(findingsOver(texts)), [
    'CONTRIBUTING.md:3: the roster does not say how many libraries there are (5).',
  ]);
  const wrong = { ...TEXTS, 'SECURITY.md': SECURITY.replace('2 libraries built on them', '3 libraries built on them') };
  assert.deepEqual(lines(findingsOver(wrong)), [
    'SECURITY.md:8: "3 libraries built on them" counts 3 libraries built on them; the catalog has 2.',
  ]);
});

test('a name added at the end of a list is a finding, because a list must close there', () => {
  const texts = { ...TEXTS, 'profile/README.md': PROFILE.replace('(deid and cli)', '(deid and cli, and more)') };
  assert.ok(lines(findingsOver(texts)).some((f) => f.includes('libraries built on them whole')));
});

test('a table link that is not the catalog address is a finding naming both', () => {
  const texts = {
    ...TEXTS,
    'profile/README.md': PROFILE.replace(row('fhir'), row('fhir', 'https://docs.cosyte.com/fhir-r4'))
      .replace('(https://github.com/cosyte/cli)', '(https://github.com/cosyte/cli-old)')
      .replace('[npm](https://www.npmjs.com/package/@cosyte/x12) · ', ''),
  };
  assert.deepEqual(lines(findingsOver(texts)), [
    'profile/README.md:20: the @cosyte/fhir row links docs to https://docs.cosyte.com/fhir-r4; ' +
      "the catalog's address is https://docs.cosyte.com/fhir.",
    "profile/README.md:21: the @cosyte/x12 row links npm to nothing; the catalog's address is " +
      'https://www.npmjs.com/package/@cosyte/x12.',
    'profile/README.md:23: the @cosyte/cli row links repo to https://github.com/cosyte/cli-old; ' +
      "the catalog's address is https://github.com/cosyte/cli.",
  ]);
});

test('a row the catalog does not list, a row twice, or rows out of order are findings', () => {
  const extra = { ...TEXTS, 'profile/README.md': PROFILE.replace(row('cli'), `${row('cli')}\n${row('dicom')}`) };
  assert.deepEqual(lines(findingsOver(extra)), [
    'profile/README.md:24: the table has a row for `@cosyte/dicom`, which the catalog does not list.',
  ]);
  const twice = { ...TEXTS, 'profile/README.md': PROFILE.replace(row('cli'), `${row('cli')}\n${row('hl7')}`) };
  assert.deepEqual(lines(findingsOver(twice)), [
    'profile/README.md:15: the table has 2 rows for @cosyte/hl7; the catalog lists it once.',
  ]);
  const swapped = { ...TEXTS, 'profile/README.md': PROFILE.replace(`${row('deid')}\n${row('cli')}`, `${row('cli')}\n${row('deid')}`) };
  assert.deepEqual(lines(findingsOver(swapped)), [
    "profile/README.md:15: the table's rows are not in the catalog's order (hl7, fhir, x12, deid, cli).",
  ]);
});

test('a table without its row of dashes is a finding', () => {
  const headless = { ...TEXTS, 'profile/README.md': PROFILE.replace('|---|---|---|\n', '') };
  assert.deepEqual(lines(findingsOver(headless)), [
    'profile/README.md:15: the table list holds no table: a header row, then a row of dashes.',
  ]);
});

test('a list that is missing, unclosed, nested or of an unknown kind is a finding', () => {
  const catalog = readCatalog(rawCatalog());
  const check = (text, kinds = ['roster']) => lines(checkDocument('X.md', text, kinds, catalog));
  assert.deepEqual(check('No list here.\n'), [
    'X.md:0: there is no roster list (<!-- catalog:roster:start --> to <!-- catalog:roster:end -->).',
  ]);
  assert.ok(check('<!-- catalog:roster:start -->\nText.\n').includes('X.md:1: the roster list opened here never ends.'));
  assert.ok(
    check('<!-- catalog:roster:start -->\n<!-- catalog:table:start -->\n<!-- catalog:roster:end -->\n').includes(
      'X.md:2: a table list starts inside the roster list from line 1.',
    ),
  );
  assert.ok(check('<!-- catalog:rooster:start -->\n').includes('X.md:1: "catalog:rooster" is not a list this check reads (roster, table).'));
  assert.ok(check('<!-- catalog:roster:end -->\n').includes('X.md:1: a roster list ends here, and none is open.'));
  assert.ok(
    check('<!-- catalog:roster:start -->\n<!-- catalog:table:end -->\n<!-- catalog:roster:end -->\n').includes(
      'X.md:2: a table list ends here, inside the roster list from line 1.',
    ),
  );
});

test('a catalog without a field the check reads is refused, never compared', () => {
  assert.throws(() => readCatalog({}), CheckError);
  assert.throws(() => readCatalog({ libraries: [], engine: rawCatalog().engine }), CheckError);
  const noStandard = rawCatalog();
  delete noStandard.libraries[0].standard;
  assert.throws(() => readCatalog(noStandard), /names no standard/);
  const noDocs = rawCatalog();
  delete noDocs.libraries[4].docs;
  assert.throws(() => readCatalog(noDocs), /has no docs/);
  const strangeTier = rawCatalog();
  strangeTier.libraries[4].tier = 'engine';
  assert.throws(() => readCatalog(strangeTier), /does not know/);
  const noStatus = rawCatalog();
  delete noStatus.engine.status;
  assert.throws(() => readCatalog(noStatus), /engine has no status/);
});

// ---------------------------------------------------------------------------
// The command's exit codes
// ---------------------------------------------------------------------------

/** Run the command over documents and a catalog written to a scratch directory. */
function runOver(texts, catalog) {
  const dir = mkdtempSync(join(tmpdir(), 'package-lists-test-'));
  try {
    for (const [path, text] of Object.entries(texts)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const catalogPath = join(dir, 'catalog.json');
    if (catalog !== undefined) writeFileSync(catalogPath, typeof catalog === 'string' ? catalog : JSON.stringify(catalog));
    const result = spawnSync(process.execPath, [SCRIPT, '--catalog', catalogPath, '--root', dir], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the command exits 0 when every list follows the catalog, and says which catalog it read', () => {
  const result = runOver(TEXTS, rawCatalog());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^package lists: OK \(SECURITY\.md, CONTRIBUTING\.md, profile\/README\.md follow the catalog in /);
  assert.match(result.stdout, /: 5 libraries and Pathways\)\n$/);
});

test('the command exits 1 on a finding, and prints each one', () => {
  const raw = rawCatalog();
  raw.engine.status = 'released';
  const result = runOver(TEXTS, raw);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /^package lists: 3 finding\(s\) against the catalog in /);
  assert.match(result.stderr, /\n {2}SECURITY\.md:3: the roster does not give the status of Pathways, "released"\.\n/);
});

test('the command exits 2 when it cannot read the catalog or a document, or an argument', () => {
  const missing = runOver(TEXTS, undefined);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^package lists: could not read the catalog/);
  const garbled = runOver(TEXTS, '{ not json');
  assert.equal(garbled.status, 2);
  assert.match(garbled.stderr, /is not JSON/);
  const empty = runOver(TEXTS, { libraries: [] });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /the catalog lists no libraries/);
  const noProfile = runOver({ 'SECURITY.md': SECURITY, 'CONTRIBUTING.md': CONTRIBUTING }, rawCatalog());
  assert.equal(noProfile.status, 2);
  assert.match(noProfile.stderr, /could not read profile\/README\.md/);
  const unknown = spawnSync(process.execPath, [SCRIPT, '--offline'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /"--offline" is not an argument this check accepts/);
});
