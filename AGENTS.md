# AGENTS.md

`cosyte/.github` is our organization's shared GitHub repository: the reusable workflows every
`@cosyte/*` library calls (`ci.yml`, `release.yml`, and the `gate-*` workflows in
`.github/workflows/`), the `scripts/` they run, the community health files GitHub serves to every
repository without its own, and the organization profile in `profile/`. It ships no package: there
is no `package.json`, no lockfile, and no changeset.

## Build and test

There is nothing to build or install. Use Node.js 22 or later; the tests use only `node:test` and
`node:assert`.

```sh
node --test "test/*.test.mjs"
```

## The gate

Run these from the repository root, in this order, before you push. CI runs the same checks.

1. `actionlint` 1.7.12, with `shellcheck` on `PATH`.
2. `node --test "test/*.test.mjs"`
3. `node scripts/check-no-emdash.mjs`
4. `node test/package-lists.mjs`, which needs the network: it checks the package lists in
   `SECURITY.md`, `CONTRIBUTING.md`, and `profile/README.md` against the catalog in the latest
   `@cosyte/script-utils` on npm.

The em dash gate also reads the pull request title, body, and commit messages: pipe each through
`node scripts/check-no-emdash.mjs --stdin <label>` before you open one.

## Data

This repository is public, and a merge is live at once. Synthetic data only: real patient data
never enters a file, a fixture, a log, or an issue. Name no private repository and no person.

`CLAUDE.md` holds the rules that bind changes here and the failure behind each.
[CONTRIBUTING.md](CONTRIBUTING.md) is the organization's contributing guide.
