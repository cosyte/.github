# Fixtures for `test/published-check.test.mjs`

Each directory is a calling repository as `ci.yml`'s `published` job sees it: a root
`package.json` naming the package, and anything else the job reads. The test packs the ones that
are packages and serves them from a fake registry on localhost, so nothing here touches npm.

- `caller/`: a small dual ESM/CJS package and its synthetic smoke samples. The job passes on it.
  `smoke/sample.mjs` parses a synthetic message and checks the result; `smoke/failing-sample.mjs`
  checks for a value the parser never returns, so it must fail.
- `wrong-name/`: a caller whose `package.json` names a package the registry does not have. The job
  fails on it.
- `config-package/`: a config package that exports only JSON files and no `.`, like a shared
  tsconfig. Its entries are resolved, not parsed.
- `missing-esm/`: a package whose `files` drops its ESM build while `exports` still points at it.
  `require` works and `import` fails, so the job fails.

All data is synthetic.
