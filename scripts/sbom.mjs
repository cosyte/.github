#!/usr/bin/env node
// @ts-check
//
// THE SBOM A RELEASE CARRIES: a CycloneDX 1.5 JSON software bill of materials naming the package and
// every package a consumer installs with it, attached to the GitHub release by `github-release.mjs`
// in the same call that creates the release.
//
//   node sbom.mjs --repo . --out "$RUNNER_TEMP/sbom/sbom.cdx.json"
//
// WHAT IT READS. The caller's own installed production tree, from `pnpm list --prod --depth Infinity
// --json` after `pnpm install --frozen-lockfile`: the versions the lockfile pinned, the dependencies
// and optional dependencies and not the dev ones, which a consumer never installs. Each package's
// declared license is read from its own package.json in that tree. Nothing is fetched: it is written
// before the publish, and a registry that does not answer must not hold a release.
//
// THE SAME TREE GIVES THE SAME BYTES. Components and dependencies are sorted, there is no timestamp,
// and the serial number is derived from the content rather than drawn at random. A release that
// already carries this SBOM (a re-run, or a later run catching up) therefore compares equal in
// `github-release.mjs`, which never replaces an asset of a published release.
//
// Exit 0 when the file is written, 2 when the tree or the manifest cannot be read. Node built-ins
// only.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** The asset's file name on the release. */
export const SBOM_ASSET = 'sbom.cdx.json';

/** A single SPDX license id: what `license` in a package.json usually holds. */
const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/**
 * The package URL of an npm package.
 *
 * @param {string} name
 * @param {string} version
 */
export function purlOf(name, version) {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

/** A package.json `license` as CycloneDX licenses, or null when it names none. */
function licensesOf(manifest) {
  const raw = typeof manifest?.license === 'string' ? manifest.license : manifest?.license?.type;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = raw.trim();
  return [SPDX_ID.test(value) ? { license: { id: value } } : { license: { name: value } }];
}

/** The CycloneDX component for one package. */
function componentOf({ name, version, type = 'library', manifest, resolved }) {
  const purl = purlOf(name, version);
  /** @type {Record<string, any>} */
  const component = { type, 'bom-ref': purl };
  if (name.startsWith('@')) {
    const at = name.indexOf('/');
    component.group = name.slice(0, at);
    component.name = name.slice(at + 1);
  } else {
    component.name = name;
  }
  component.version = version;
  component.purl = purl;
  const licenses = licensesOf(manifest);
  if (licenses) component.licenses = licenses;
  if (typeof resolved === 'string' && /^https:\/\//.test(resolved)) component.externalReferences = [{ type: 'distribution', url: resolved }];
  return component;
}

/** The children of a node in `pnpm list --json` output. */
function childrenOf(node) {
  return [...Object.entries(node?.dependencies ?? {}), ...Object.entries(node?.optionalDependencies ?? {})];
}

/**
 * Build the SBOM.
 *
 * @param {{ manifest: any, tree: any[], readManifestAt: (dir: string) => any }} input
 *   `manifest` is the package's own package.json; `tree` is `pnpm list --prod --depth Infinity --json`;
 *   `readManifestAt` reads the package.json in a dependency's directory, or returns null.
 */
export function buildSbom({ manifest, tree, readManifestAt }) {
  const root = componentOf({ name: String(manifest.name), version: String(manifest.version), manifest });
  /** @type {Map<string, Record<string, any>>} */
  const components = new Map();
  /** @type {Map<string, Set<string>>} */
  const edges = new Map([[root['bom-ref'], new Set()]]);
  const visit = (parentRef, node) => {
    for (const [name, child] of childrenOf(node)) {
      const version = String(child?.version ?? '');
      if (version === '') continue;
      const ref = purlOf(name, version);
      /** @type {Set<string>} */ (edges.get(parentRef)).add(ref);
      if (components.has(ref)) continue;
      const dir = typeof child?.path === 'string' ? child.path : '';
      components.set(ref, componentOf({ name, version, manifest: dir ? readManifestAt(dir) : null, resolved: child?.resolved }));
      edges.set(ref, new Set());
      visit(ref, child);
    }
  };
  visit(root['bom-ref'], tree[0]);
  const sortedComponents = [...components.values()].sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));
  const dependencies = [
    { ref: root['bom-ref'], dependsOn: [.../** @type {Set<string>} */ (edges.get(root['bom-ref']))].sort() },
    ...sortedComponents.map((c) => ({ ref: c['bom-ref'], dependsOn: [.../** @type {Set<string>} */ (edges.get(c['bom-ref']))].sort() })),
  ];
  const content = { metadata: { component: root }, components: sortedComponents, dependencies };
  const hex = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  // A version 8 UUID (RFC 9562, custom), from the content: the same content, the same serial number.
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const serial = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      tools: { components: [{ type: 'application', group: 'cosyte', name: 'sbom.mjs', externalReferences: [{ type: 'vcs', url: 'https://github.com/cosyte/.github' }] }] },
      component: root,
    },
    components: sortedComponents,
    dependencies,
  };
}

/** Read a package.json in a directory, or null. */
function readManifestIn(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** `pnpm list` over the production tree. */
function pnpmList(repo) {
  const result = spawnSync('pnpm', ['list', '--prod', '--depth', 'Infinity', '--json'], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: `${result.stderr ?? ''}${result.error ? result.error.message : ''}` };
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv
 * @param {{ listTree?: (repo: string) => { code: number, stdout: string, stderr?: string }, readManifestAt?: (dir: string) => any, out?: (s: string) => void, err?: (s: string) => void }} [io]
 * @returns {number}
 */
export function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  const refuse = (why) => {
    err(`::error title=SBOM not written::${why}. Nothing was published.\n`);
    return 2;
  };
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--repo', '--out'].includes(argv[i]) || argv[i + 1] === undefined) return refuse(`usage: sbom.mjs --repo <dir> --out <file> (read ${JSON.stringify(argv[i])})`);
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  if (!flags.out) return refuse('usage: sbom.mjs --repo <dir> --out <file> (no --out)');
  const repo = path.resolve(flags.repo ?? '.');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  } catch (error) {
    return refuse(`${path.join(repo, 'package.json')} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof manifest?.name !== 'string' || typeof manifest?.version !== 'string') return refuse('package.json names no package name and version');
  const listed = (io.listTree ?? pnpmList)(repo);
  if (listed.code !== 0) return refuse(`pnpm list --prod exited ${listed.code}: ${String(listed.stderr ?? '').trim().slice(0, 400)}`);
  let tree;
  try {
    tree = JSON.parse(listed.stdout);
  } catch {
    return refuse(`pnpm list --prod printed something that is not JSON: ${listed.stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(tree) || tree.length === 0) return refuse('pnpm list --prod printed no package');
  const bom = buildSbom({ manifest, tree, readManifestAt: io.readManifestAt ?? readManifestIn });
  mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
  writeFileSync(flags.out, `${JSON.stringify(bom, null, 2)}\n`);
  out(`wrote ${flags.out}: ${manifest.name}@${manifest.version} and ${bom.components.length} runtime package(s)\n`);
  return 0;
}

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) process.exitCode = main(process.argv.slice(2));
