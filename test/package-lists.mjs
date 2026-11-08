#!/usr/bin/env node
// THE PACKAGE LISTS IN SECURITY.md, CONTRIBUTING.md AND profile/README.md FOLLOW THE CATALOG.
//
// Each of those files names our 14 libraries and Pathways. The one list of them is the catalog that
// cosyte/config generates from each library's package.json and ships in `@cosyte/script-utils` as
// `catalog.json`. GitHub renders these files as they are written, so they cannot read the catalog;
// this check reads them against it instead, and exits 1 when they differ.
//
// WHAT IT READS. Each list sits between two HTML comments, which no rendered page shows:
//
//   <!-- catalog:roster:start ... -->  ...  <!-- catalog:roster:end -->
//   <!-- catalog:table:start ... -->   ...  <!-- catalog:table:end -->
//
// A roster lists the libraries for each standard, then the libraries built on them, each list whole
// and in the catalog's order, with the serial comma: as package names in code spans (`@cosyte/hl7`)
// or as the names readers know them by (HL7 v2 for a standard, the bare name for a library built on
// them). A list opens after `(` or `:` and closes before `)`, `;` or `.`, so a name added or left
// over at either end is a finding. A roster also states the three counts and links Pathways to its
// repository, with its status. A table has one row per library, in the catalog's order, naming the
// package in its first cell and linking the catalog's npm, docs and repository addresses.
//
// Every count of the libraries anywhere in the three files ("14 libraries", "8 standards", "6 built
// on them", "All 14") must be the catalog's as well, so a count outside a list cannot go stale.
//
// WHICH CATALOG. The latest `@cosyte/script-utils` on npm, or the file `--catalog` names. The
// latest, not a pinned version: a release that changes the catalog turns this check red on its next
// run, the nightly one included, until the lists follow it. `npm pack` fetches the tarball (npm
// checks it against the registry's integrity hash) and none of the package's code runs: this reads
// `catalog.json` and `package.json` out of it.
//
//   node test/package-lists.mjs [--catalog <catalog.json>] [--root <repository root>]
//
// EXIT CODES: 0 every list follows the catalog, 1 a finding, 2 the check could not run (the catalog
// could not be fetched or read, a document could not be read, or an argument is unknown).
//
// It lives in test/ with this repository's other self-checks, not in scripts/: scripts/ is what the
// shared workflows run, and a change there mints a workflows reference for every caller.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The package whose `catalog.json` is the list, at the version npm calls latest. */
export const CATALOG_PACKAGE = '@cosyte/script-utils@latest';

/** The documents that list the libraries, and the lists each must carry. */
export const DOCUMENTS = Object.freeze({
  'SECURITY.md': Object.freeze(['roster']),
  'CONTRIBUTING.md': Object.freeze(['roster']),
  'profile/README.md': Object.freeze(['roster', 'table']),
});

/** The kinds of list a marker can open. */
export const KINDS = Object.freeze(['roster', 'table']);

/** Raised when the check cannot run, which is exit 2, never a finding. */
export class CheckError extends Error {}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * The parts of the catalog this check compares, refusing a catalog that lacks a field it reads.
 *
 * @param {any} catalog The parsed `catalog.json`.
 * @returns {{ libraries: any[], standards: any[], builtOn: any[], engine: any }}
 */
export function readCatalog(catalog) {
  const libraries = catalog?.libraries;
  const engine = catalog?.engine;
  if (!Array.isArray(libraries) || libraries.length === 0) {
    throw new CheckError('the catalog lists no libraries.');
  }
  for (const library of libraries) {
    for (const field of ['name', 'slug', 'tier', 'npm', 'docs', 'repository']) {
      if (typeof library?.[field] !== 'string' || library[field] === '') {
        throw new CheckError(`a library in the catalog has no ${field}: ${JSON.stringify(library)}.`);
      }
    }
    if (library.tier !== 'standard' && library.tier !== 'built-on') {
      const tier = JSON.stringify(library.tier);
      throw new CheckError(`${library.name} is tier ${tier}, which this check does not know.`);
    }
    if (library.tier === 'standard' && (typeof library.standard !== 'string' || library.standard === '')) {
      throw new CheckError(`${library.name} is a standard's library and names no standard.`);
    }
  }
  for (const field of ['name', 'displayName', 'status', 'repository']) {
    if (typeof engine?.[field] !== 'string' || engine[field] === '') {
      throw new CheckError(`the catalog's engine has no ${field}.`);
    }
  }
  return {
    libraries,
    standards: libraries.filter((library) => library.tier === 'standard'),
    builtOn: libraries.filter((library) => library.tier === 'built-on'),
    engine,
  };
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CheckError(`could not read ${what} (${path}): ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CheckError(`${what} (${path}) is not JSON: ${error.message}`);
  }
}

function run(command, args) {
  try {
    execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120_000 });
  } catch (error) {
    const said = String(error.stderr ?? '').trim().split('\n').slice(-3).join(' ');
    throw new CheckError(`\`${command} ${args.join(' ')}\` failed: ${said || error.message}`);
  }
}

/**
 * The catalog in a published `@cosyte/script-utils`, and the release it came from.
 *
 * @param {string} [spec] An npm package spec; the latest release by default.
 * @returns {{ catalog: any, source: string }}
 */
export function fetchCatalog(spec = CATALOG_PACKAGE) {
  const dir = mkdtempSync(join(tmpdir(), 'package-lists-'));
  try {
    run('npm', ['pack', spec, '--ignore-scripts', '--pack-destination', dir]);
    const tarballs = readdirSync(dir).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      throw new CheckError(`\`npm pack ${spec}\` left ${tarballs.length} tarballs, not one.`);
    }
    run('tar', ['-xzf', join(dir, tarballs[0]), '-C', dir, 'package/package.json', 'package/catalog.json']);
    const manifest = readJson(join(dir, 'package', 'package.json'), `${spec}'s package.json`);
    const catalog = readJson(join(dir, 'package', 'catalog.json'), `${spec}'s catalog.json`);
    return { catalog, source: `${manifest.name}@${manifest.version}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

/** `a`, `a and b`, `a, b, and c`: a list as our writing rules spell one. */
export function serialList(items) {
  if (items.length < 3) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** A marker's kind and edge, or `null` when the line is not a `catalog:` marker. */
function markerOf(line) {
  const text = line.trim();
  if (!text.startsWith('<!--') || !text.endsWith('-->')) return null;
  const match = /^<!--\s*catalog:([a-z]+):(start|end)\b/.exec(text);
  return match === null ? null : { kind: match[1], edge: match[2] };
}

const finding = (path, line, message) => ({ path, line, message });

/**
 * The lists in a document, each with the line its start marker is on and the lines it holds.
 *
 * @param {string} path The document's path, for the findings.
 * @param {string} text The document.
 * @returns {{ regions: { kind: string, line: number, first: number, lines: string[] }[],
 *   problems: { path: string, line: number, message: string }[] }}
 */
export function regionsOf(path, text) {
  const lines = text.split('\n');
  const regions = [];
  const problems = [];
  let open = null;
  lines.forEach((line, index) => {
    const marker = markerOf(line);
    if (marker === null) return;
    const at = index + 1;
    if (!KINDS.includes(marker.kind)) {
      const message = `"catalog:${marker.kind}" is not a list this check reads (${KINDS.join(', ')}).`;
      problems.push(finding(path, at, message));
    } else if (marker.edge === 'start') {
      if (open === null) {
        open = { kind: marker.kind, line: at };
      } else {
        const message = `a ${marker.kind} list starts inside the ${open.kind} list from line ${open.line}.`;
        problems.push(finding(path, at, message));
      }
    } else if (open === null) {
      problems.push(finding(path, at, `a ${marker.kind} list ends here, and none is open.`));
    } else if (open.kind !== marker.kind) {
      const message = `a ${marker.kind} list ends here, inside the ${open.kind} list from line ${open.line}.`;
      problems.push(finding(path, at, message));
    } else {
      regions.push({ kind: open.kind, line: open.line, first: open.line + 1, lines: lines.slice(open.line, index) });
      open = null;
    }
  });
  if (open !== null) problems.push(finding(path, open.line, `the ${open.kind} list opened here never ends.`));
  return { regions, problems };
}

/** Whether `list` appears whole in `flat`: after `(` or `:`, and before `)`, `;` or `.`. */
function listedWhole(flat, list) {
  for (let at = flat.indexOf(list); at !== -1; at = flat.indexOf(list, at + 1)) {
    const before = flat.slice(0, at).trimEnd().slice(-1);
    const after = flat.charAt(at + list.length);
    if ((before === '(' || before === ':') && (after === ')' || after === ';' || after === '.')) return true;
  }
  return false;
}

/** The phrases that count the libraries in a list, and the catalog's count for each. */
const COUNTS = Object.freeze([
  {
    what: 'libraries',
    pattern: /\b(\d+)\s+(?:open-source\s+)?libraries\b(?!\s+built\s+on)/,
    expected: (catalog) => catalog.libraries.length,
  },
  {
    what: 'standards',
    pattern: /\b(\d+)\s+standards\b/,
    expected: (catalog) => catalog.standards.length,
  },
  {
    what: 'libraries built on them',
    pattern: /\b(\d+)\s+(?:libraries\s+)?built\s+on\s+them\b/,
    expected: (catalog) => catalog.builtOn.length,
  },
]);

/** "All 14": a count of the libraries that only the whole-document sweep reads. */
const ALL_COUNT = Object.freeze({
  what: 'libraries',
  pattern: /\b[Aa]ll\s+(\d+)\b/,
  expected: (catalog) => catalog.libraries.length,
});

/** The findings for one roster. */
export function checkRoster(path, region, catalog) {
  const findings = [];
  const flat = region.lines.join('\n').replace(/\s+/g, ' ');
  const tiers = [
    ['libraries for a standard', catalog.standards, catalog.standards.map((library) => library.standard)],
    ['libraries built on them', catalog.builtOn, catalog.builtOn.map((library) => library.slug)],
  ];
  for (const [what, libraries, names] of tiers) {
    const asPackages = serialList(libraries.map((library) => `\`${library.name}\``));
    const asNames = serialList(names);
    if (!listedWhole(flat, asPackages) && !listedWhole(flat, asNames)) {
      const message =
        `the roster does not list the ${what} whole and in the catalog's order: ${asPackages}, or ${asNames}.`;
      findings.push(finding(path, region.line, message));
    }
  }
  for (const count of COUNTS) {
    if (!count.pattern.test(flat)) {
      const message = `the roster does not say how many ${count.what} there are (${count.expected(catalog)}).`;
      findings.push(finding(path, region.line, message));
    }
  }
  const { displayName, repository, status } = catalog.engine;
  if (!flat.includes(`[${displayName}](${repository})`)) {
    findings.push(finding(path, region.line, `the roster does not link ${displayName} to ${repository}.`));
  }
  if (!flat.includes(status)) {
    findings.push(finding(path, region.line, `the roster does not give the status of ${displayName}, "${status}".`));
  }
  return findings;
}

/** A table row's cells, split on the pipes that are not escaped. */
function cellsOf(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** Whether a docs link is the catalog's docs address, or a page, query or anchor under it. */
function isUnder(url, address) {
  return url === address || ['/', '?', '#'].some((next) => url.startsWith(address + next));
}

/** The findings for one table. */
export function checkTable(path, region, catalog) {
  const findings = [];
  const rows = [];
  region.lines.forEach((line, index) => {
    if (line.trim().startsWith('|')) rows.push({ line: region.first + index, cells: cellsOf(line) });
  });
  const separator = rows.findIndex((row) => row.cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
  if (separator !== 1) {
    return [finding(path, region.line, 'the table list holds no table: a header row, then a row of dashes.')];
  }
  const body = rows.slice(2);
  const { libraries } = catalog;
  const named = body.map((row) => row.cells[0]);
  const listed = libraries.map((library) => `\`${library.name}\``);
  for (const library of libraries) {
    const count = named.filter((name) => name === `\`${library.name}\``).length;
    if (count !== 1) {
      const rows = count === 0 ? 'no row' : `${count} rows`;
      const message = `the table has ${rows} for ${library.name}; the catalog lists it once.`;
      findings.push(finding(path, region.line, message));
    }
  }
  for (const row of body.filter((each) => !listed.includes(each.cells[0]))) {
    const message = `the table has a row for ${row.cells[0]}, which the catalog does not list.`;
    findings.push(finding(path, row.line, message));
  }
  if (findings.length === 0 && named.some((name, index) => name !== listed[index])) {
    const order = libraries.map((library) => library.slug).join(', ');
    findings.push(finding(path, region.line, `the table's rows are not in the catalog's order (${order}).`));
  }
  for (const row of body) {
    const library = libraries.find((each) => row.cells[0] === `\`${each.name}\``);
    if (library === undefined) continue;
    const links = new Map();
    for (const match of row.cells.join(' | ').matchAll(/\[([^\]\n]*)\]\(([^)\s]*)\)/g)) {
      links.set(match[1], [...(links.get(match[1]) ?? []), match[2]]);
    }
    const wanted = [
      ['npm', library.npm, (url) => url === library.npm],
      ['docs', library.docs, (url) => isUnder(url, library.docs)],
      ['repo', library.repository, (url) => url === library.repository],
    ];
    for (const [label, address, matches] of wanted) {
      const urls = links.get(label) ?? [];
      if (urls.length !== 1 || !matches(urls[0])) {
        const linked = urls.length === 0 ? 'nothing' : urls.join(' and ');
        const message = `the ${library.name} row links ${label} to ${linked}; the catalog's address is ${address}.`;
        findings.push(finding(path, row.line, message));
      }
    }
  }
  return findings;
}

/** The findings for every count of the libraries in a document, in a list or not. */
export function checkCounts(path, text, catalog) {
  const findings = [];
  for (const count of [...COUNTS, ALL_COUNT]) {
    const expected = count.expected(catalog);
    for (const match of text.matchAll(new RegExp(count.pattern.source, 'g'))) {
      if (Number(match[1]) !== expected) {
        const line = text.slice(0, match.index).split('\n').length;
        const said = match[0].replace(/\s+/g, ' ');
        const message = `"${said}" counts ${match[1]} ${count.what}; the catalog has ${expected}.`;
        findings.push(finding(path, line, message));
      }
    }
  }
  return findings;
}

/**
 * The findings for one document: its lists, then its counts.
 *
 * @param {string} path The document's path from the repository root.
 * @param {string} text The document.
 * @param {readonly string[]} kinds The lists it must carry.
 * @param {ReturnType<typeof readCatalog>} catalog
 */
export function checkDocument(path, text, kinds, catalog) {
  const { regions, problems } = regionsOf(path, text);
  const findings = [...problems];
  for (const kind of kinds) {
    if (!regions.some((region) => region.kind === kind)) {
      const message = `there is no ${kind} list (<!-- catalog:${kind}:start --> to <!-- catalog:${kind}:end -->).`;
      findings.push(finding(path, 0, message));
    }
  }
  for (const region of regions) {
    findings.push(...(region.kind === 'roster' ? checkRoster : checkTable)(path, region, catalog));
  }
  findings.push(...checkCounts(path, text, catalog));
  return findings;
}

/**
 * Every document, read from under `root`, refusing one that cannot be read.
 *
 * @returns {Record<string, string>}
 */
export function readDocuments(root = REPO) {
  const texts = {};
  for (const path of Object.keys(DOCUMENTS)) {
    try {
      texts[path] = readFileSync(join(root, path), 'utf8');
    } catch (error) {
      throw new CheckError(`could not read ${path} under ${root}: ${error.message}`);
    }
  }
  return texts;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const HELP = `package lists: check the package lists in ${Object.keys(DOCUMENTS).join(', ')} against the catalog.

  node test/package-lists.mjs [--catalog <catalog.json>] [--root <repository root>]

The catalog is the one in the latest @cosyte/script-utils on npm, unless --catalog names a file.
Exit 0 every list follows it, 1 a finding, 2 the check could not run.
`;

function parseArgs(argv) {
  const options = { catalog: null, root: REPO, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if ((arg === '--catalog' || arg === '--root') && typeof argv[i + 1] === 'string') {
      options[arg.slice(2)] = resolve(argv[i + 1]);
      i += 1;
    } else {
      throw new CheckError(`${JSON.stringify(arg)} is not an argument this check accepts. Nothing was checked.`);
    }
  }
  return options;
}

/**
 * Run the check and return its exit code. It never exits the process.
 *
 * @param {string[]} argv The arguments after the script.
 * @returns {0 | 1 | 2}
 */
export function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const { catalog: raw, source } =
      options.catalog === null
        ? fetchCatalog()
        : { catalog: readJson(options.catalog, 'the catalog'), source: options.catalog };
    const catalog = readCatalog(raw);
    const texts = readDocuments(options.root);
    const findings = Object.entries(DOCUMENTS).flatMap(([path, kinds]) =>
      checkDocument(path, texts[path], kinds, catalog),
    );
    const documents = Object.keys(DOCUMENTS).join(', ');
    if (findings.length > 0) {
      const report = findings.map((f) => `  ${f.path}${f.line > 0 ? `:${f.line}` : ''}: ${f.message}`).join('\n');
      process.stderr.write(
        `package lists: ${findings.length} finding(s) against the catalog in ${source}:\n${report}\n` +
          `Change ${documents} to match. The catalog is generated in cosyte/config from each package.json.\n`,
      );
      return 1;
    }
    process.stdout.write(
      `package lists: OK (${documents} follow the catalog in ${source}: ` +
        `${catalog.libraries.length} libraries and ${catalog.engine.displayName})\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof CheckError) {
      process.stderr.write(`package lists: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

/** Whether node was asked to run this file, rather than a test importing it. */
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
