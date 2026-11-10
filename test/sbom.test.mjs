// `scripts/sbom.mjs`: the CycloneDX software bill of materials `release.yml` attaches to every
// GitHub release it creates. It lists the package and every package a consumer installs with it,
// read from the caller's installed production dependency tree (`pnpm list --prod`), each with its
// version, its purl and its declared license. The same tree always gives the same bytes, so a re-run
// that finds the release already carrying it compares equal.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SBOM_ASSET, buildSbom, main, purlOf } from '../scripts/sbom.mjs';

const MANIFEST = { name: '@example/lib', version: '1.2.3', license: 'MIT' };

/** What `pnpm list --prod --depth Infinity --json` prints for a package with two runtime deps. */
const TREE = [
  {
    name: '@example/lib',
    version: '1.2.3',
    path: '/work',
    dependencies: {
      'left-pad': { from: 'left-pad', version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', path: '/work/node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad' },
      '@scope/tool': {
        from: '@scope/tool',
        version: '2.0.0',
        resolved: 'https://registry.npmjs.org/@scope/tool/-/tool-2.0.0.tgz',
        path: '/work/node_modules/.pnpm/@scope+tool@2.0.0/node_modules/@scope/tool',
        dependencies: {
          'left-pad': { from: 'left-pad', version: '1.3.0', path: '/work/node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad' },
        },
      },
    },
  },
];

const LICENSES = {
  '/work/node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad': { license: 'WTFPL' },
  '/work/node_modules/.pnpm/@scope+tool@2.0.0/node_modules/@scope/tool': { license: { type: 'Apache-2.0' } },
};

test('a purl names the scope encoded, the name and the version', () => {
  assert.equal(purlOf('@cosyte/hl7', '0.1.0'), 'pkg:npm/%40cosyte/hl7@0.1.0');
  assert.equal(purlOf('left-pad', '1.3.0'), 'pkg:npm/left-pad@1.3.0');
});

test('the asset is named so a reader knows what it is', () => {
  assert.equal(SBOM_ASSET, 'sbom.cdx.json');
});

test('the SBOM is CycloneDX 1.5 JSON naming the package and each runtime dependency once, with its license', () => {
  const bom = buildSbom({ manifest: MANIFEST, tree: TREE, readManifestAt: (path) => LICENSES[path] ?? null });
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.equal(bom.specVersion, '1.5');
  assert.match(bom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(bom.metadata.component, {
    type: 'library',
    'bom-ref': 'pkg:npm/%40example/lib@1.2.3',
    group: '@example',
    name: 'lib',
    version: '1.2.3',
    purl: 'pkg:npm/%40example/lib@1.2.3',
    licenses: [{ license: { id: 'MIT' } }],
  });
  assert.deepEqual(
    bom.components.map((c) => [c.purl, c.licenses]),
    [
      ['pkg:npm/%40scope/tool@2.0.0', [{ license: { id: 'Apache-2.0' } }]],
      ['pkg:npm/left-pad@1.3.0', [{ license: { id: 'WTFPL' } }]],
    ],
  );
  assert.deepEqual(bom.components[0].externalReferences, [{ type: 'distribution', url: 'https://registry.npmjs.org/@scope/tool/-/tool-2.0.0.tgz' }]);
  assert.deepEqual(bom.dependencies, [
    { ref: 'pkg:npm/%40example/lib@1.2.3', dependsOn: ['pkg:npm/%40scope/tool@2.0.0', 'pkg:npm/left-pad@1.3.0'] },
    { ref: 'pkg:npm/%40scope/tool@2.0.0', dependsOn: ['pkg:npm/left-pad@1.3.0'] },
    { ref: 'pkg:npm/left-pad@1.3.0', dependsOn: [] },
  ]);
});

test('the same tree gives the same bytes, and another tree another serial number', () => {
  const one = JSON.stringify(buildSbom({ manifest: MANIFEST, tree: TREE, readManifestAt: (p) => LICENSES[p] ?? null }));
  const two = JSON.stringify(buildSbom({ manifest: MANIFEST, tree: TREE, readManifestAt: (p) => LICENSES[p] ?? null }));
  assert.equal(one, two);
  const other = buildSbom({ manifest: { ...MANIFEST, version: '1.2.4' }, tree: TREE, readManifestAt: () => null });
  assert.notEqual(other.serialNumber, JSON.parse(one).serialNumber);
});

test('a license that is not an SPDX id is kept as a name, and none at all is left out', () => {
  const bom = buildSbom({
    manifest: { name: 'solo', version: '0.0.1', license: 'SEE LICENSE IN LICENSE.md' },
    tree: [{ name: 'solo', version: '0.0.1', dependencies: { a: { version: '1.0.0', path: '/a' } } }],
    readManifestAt: () => ({}),
  });
  assert.deepEqual(bom.metadata.component.licenses, [{ license: { name: 'SEE LICENSE IN LICENSE.md' } }]);
  assert.equal('licenses' in bom.components[0], false);
  assert.equal('group' in bom.metadata.component, false);
});

test('a package with no runtime dependency has an SBOM with no component', () => {
  const bom = buildSbom({ manifest: MANIFEST, tree: [{ name: '@example/lib', version: '1.2.3' }], readManifestAt: () => null });
  assert.deepEqual(bom.components, []);
  assert.deepEqual(bom.dependencies, [{ ref: 'pkg:npm/%40example/lib@1.2.3', dependsOn: [] }]);
});

test('the CLI writes the SBOM where it is told, and refuses a tree it cannot read', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sbom-'));
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify(MANIFEST)}\n`);
  const outFile = join(repo, 'out', SBOM_ASSET);
  const lines = [];
  const ok = main(['--repo', repo, '--out', outFile], {
    listTree: () => ({ code: 0, stdout: JSON.stringify(TREE), stderr: '' }),
    readManifestAt: (path) => LICENSES[path] ?? null,
    out: (s) => lines.push(s),
  });
  assert.equal(ok, 0, lines.join(''));
  const bom = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(bom.components.length, 2);
  assert.match(lines.join(''), /^wrote .*sbom\.cdx\.json: @example\/lib@1\.2\.3 and 2 runtime package\(s\)$/m);

  for (const listTree of [() => ({ code: 1, stdout: '', stderr: 'ERR_PNPM' }), () => ({ code: 0, stdout: 'not json', stderr: '' }), () => ({ code: 0, stdout: '[]', stderr: '' })]) {
    const err = [];
    assert.equal(main(['--repo', repo, '--out', outFile], { listTree, out: () => {}, err: (s) => err.push(s) }), 2);
    assert.match(err.join(''), /^::error title=SBOM not written::/m);
  }
  assert.equal(main(['--repo', repo], { listTree: () => ({ code: 0, stdout: JSON.stringify(TREE) }), out: () => {}, err: () => {} }), 2);
});
