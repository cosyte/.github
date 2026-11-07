# Changelog

What each published `workflows-*` reference changed for a caller, newest first.

The reusable workflows in this repository, and the `scripts/` they run, reach a caller through a
reference named `workflows-YYYY-MM-DD-<first 12 of the commit>`, which
`.github/workflows/publish-reference.yml` publishes when a merge to `main` moves anything a caller
resolves (README.md, "The published reference, and what `@main` costs a caller"). Each reference's
release note on the [releases page](https://github.com/cosyte/.github/releases) is generated when it
is published and lists the files that moved. "Act on" below repeats the note's "What a caller must
act on" list, which is the part that can break a caller; the bullets say what changed, with the pull
requests that changed it.

**Keeping it current.** A pull request that changes a reusable workflow or anything under `scripts/`
adds its lines under "Unreleased". Its merge publishes the reference, whose name is known only then,
so the next change to this file moves those lines under a heading with that name.

## Unreleased

- `ci.yml`: the `node-versions` default is `["22", "24", "26"]`, adding Node 26 to the matrix of
  every caller that passes no list. Act on: a caller that passes no `node-versions` now runs its
  suite on Node 26 too; one that cannot yet passes `'["22", "24"]'`.
- `pr-title.yml` is new: one job, `conventional-commits`, that holds a pull request title to
  Conventional Commits. Nothing to act on until a caller adopts it; its context is
  `<caller job id> / conventional-commits`.
- `release.yml`: the "Version Packages" pull request and its commit are titled
  `chore(release): version packages`, so `pr-title.yml` passes them.
- The reference note no longer counts the reusable workflows as six, and comments in
  `drift-check.yml`, `scripts/release-notes.mjs`, and `scripts/org-defaults-coverage.mjs` no longer
  point at deleted documents.

## workflows-2026-11-07-6d0a8217760a

2026-11-07. Act on: nothing.

- `scripts/check-no-emdash.mjs` refuses the en dash as well as the em dash (#84).

## workflows-2026-11-07-d7b463968031

2026-11-07. Act on: nothing.

- `ci.yml`'s `prepublish` job installs the packed tarball on the first Node line in the caller's
  `node-versions`, not on a fixed 22 (#82).

## workflows-2026-10-20-d9861c355cf1

2026-10-20. Act on: `release.yml` no longer declares the `NPM_TOKEN` secret, so a caller that passes
it by name fails.

- `release.yml` publishes through npm trusted publishing (OIDC) instead of an `NPM_TOKEN` secret. Each
  package's trusted-publisher entry on npmjs.com names its own repository and `release.yml` (#78).

## workflows-2026-10-08-d4228724330b

2026-10-08. Act on: nothing.

- `release.yml` publishes directly by default. Staging stays available through the new
  `publish-mode` input, which defaults to `direct` (#72).

## workflows-2026-10-07-1fbe2a13ca87

2026-10-07. Act on: nothing.

- The company name is written as Cosyte in `release.yml` and `scripts/check-no-emdash.mjs` (#69).

## workflows-2026-10-07-ec6d7933feea

2026-10-07. Act on: `release.yml` adds the job `finalize`, a new check-run context.

- A staged release that a maintainer promotes after its run stopped waiting gets its GitHub release
  and docs dispatch from the new `finalize` job. The new `promotion-window-minutes` input defaults
  to 120 (#68).

## workflows-2026-09-25-77fc35879cc0

2026-09-25. Act on: nothing.

- `release.yml`'s `release` job runs on Node 24, so staged publishing clears its npm floor (#67).

## workflows-2026-09-22-acaa6cbe1745

2026-09-22. Act on: nothing.

- `gate-no-emdash-install.yml` and `gate-no-internal-refs-install.yml` are new: the two gates with
  the caller's dependencies installed from its lockfile before the scan (#65).

## workflows-2026-09-18-84ecccd771cb

2026-09-18. Act on: nothing.

- `gate-no-emdash.yml` and `gate-no-internal-refs.yml` are new: the em-dash and public-surface gates
  as reusable workflows that run the caller's own scan command (#64).

## workflows-2026-09-08-7b69a1cbbce3

2026-09-08. Act on: nothing.

- `release.yml` checks its tooling out at `job.workflow_sha`, so a caller runs the scripts of the
  reference it named; the expression it read before was always empty, which meant `main` (#60).

## workflows-2026-09-07-f994eb9b0df1

2026-09-07. Act on: nothing.

- `ci.yml` fetches the docs-content checker at `job.workflow_sha`; the expression it read before was
  always empty, and the first caller to opt in failed on the fetch (#58).

## workflows-2026-09-04-f29e9cc83cac

2026-09-04. Act on: `release.yml` is split into a `version` job and a `release` job. `version` is a
new check-run context, and `release` asks the caller to grant `actions: read`, `contents: write`,
`id-token: write`, and `pull-requests: write`; a caller that does not grant them fails at startup.

- The release environment holds only the publish path, so a release asks for one approval, on the
  half that cannot be undone (#50).

## workflows-2026-09-02-56ce4c7504ab

2026-09-02. Act on: nothing.

- `scripts/org-defaults-coverage.mjs` is new; this repository's own check runs it, and no caller
  does (#55).

## workflows-2026-08-30-c06d6a7d2e18

2026-08-30. Act on: nothing.

- The docs-content checker reads a code block inside a block quote as code (#53).

## workflows-2026-08-29-7e0a056ee954

2026-08-29. The first reference. Act on: the whole interface, read from the workflow headers at that
commit.

It carries the pipeline as built from June to August 2026 (#4 to #52), including:

- the protected release environment in front of every publish (#6, #49);
- release notes derived from the changesets a release consumed, and refused when unfit (#18, #19,
  #21, #24, #28, #29);
- the post-publish install gate, which installs what was published into a clean directory (#31 to
  #34);
- the two pre-publish layers in `ci.yml`, on by default (#35, #36);
- the opt-in docs-content gate (#48);
- staged publishing (#51);
- the reference publishing that minted this reference (#52).
