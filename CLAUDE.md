# cosyte/.github

The org's shared GitHub surface: the reusable workflows every `@cosyte/*` library calls (`ci.yml`,
`release.yml` and the `gate-*` workflows in `.github/workflows/`), the `scripts/` they run, the
community health files GitHub serves to every repo without its own, and the org profile in
`profile/`. It ships no package (no `package.json`, no changeset). `CHANGELOG.md` records what each
`workflows-*` reference changed for a caller: a change to a reusable or to `scripts/` adds its lines
under "Unreleased", and the next change to the file moves them under the reference its merge minted.

## Gate

From the repo root, in this order; the tests use only `node:test` and `node:assert`, so no install.

1. `actionlint` 1.7.12 (`mise exec actionlint@1.7.12 -- actionlint`) with shellcheck on `PATH`:
   CI runs rhysd/actionlint's release binary at that version, checked against a pinned SHA-256, and
   an older one reports `job.workflow_sha` false positives that `.github/actionlint.yaml` misses.
2. `node --test "test/*.test.mjs"`
3. `node scripts/check-no-emdash.mjs`

Steps 1 and 2 are `self-check.yml`'s `actionlint` and `scripts` jobs, step 3 is `no-emdash.yml`'s
`no-emdash` job; its `no-emdash-messages` job runs the script with `--stdin` over the PR title, body
and commits. CI alone adds CodeQL, the `job.workflow_sha` probe and the org defaults coverage check.

The `actionlint` jobs run the binary itself, so their exit status is actionlint's own over every
tracked workflow file. Never move them back to `reviewdog/action-actionlint`: it annotated only
lines in the diff, which let stale ignores turn `main` red behind a green PR (#61); #80 measured it
exiting 0 on a finding; and from v1.75.0 it installs actionlint from a fork with `curl | bash`.
Moving to a new actionlint means changing the version and the SHA-256 together, in both files.

## Hazard: public at once, and a merge reaches every library

This repo is public. A pushed branch, a PR and its text are public, and a merge is live, at once:
name no private repo and no person, and say "the owner". `ci.yml`, `release.yml` and the `gate-*`
workflows run in every library's CI and release. A caller on `@main` gets a merge on its next run,
and a push to `main` that moves a reusable or `scripts/` mints a `workflows-*` release the rest
adopt. A job id is a check context in the callers' rulesets, so renaming one silently detaches it; a
renamed job, a new required input, or a changed default, secret or permission is a change every
caller must act on. The community health files (`CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`,
`CODE_OF_CONDUCT.md`, the issue and PR templates) render in repos without their own, so their links
are absolute URLs. A PR touching `profile/`, the org's public profile, is gated as public-facing.

## Rules that bind here

- Read the commit of the workflow file that defines a job as `job.workflow_sha`.
  `github.job_workflow_sha` is the empty string: a caller's `verify` died on a 404 (#58), and the
  release gates ran from whatever `main` held, on every caller, with nothing red (#60).
- Never write which contexts are required, or any other ruleset state, into a file as a fact; derive
  it: `gh api repos/cosyte/.github/rules/branches/main`. A test comment saying `actionlint` was the
  only required context rotted when `scripts` became required (#47).
- A job skipped by an `if:`, or by a failed `needs:` dependency, satisfies its required context, so
  a gate behind either stops gating while the ruleset still lists it (#46, #56). README.md, "What a
  skipped required context does to a merge", owns the detail.
- A test that reads a workflow asks `test/workflow-reader.mjs`, which refuses what it cannot model:
  three hand-rolled readers each answered "absent" about constructs they skipped, so an edit could
  drop the release environment gate with every suite green (#59).
- Keep `release.yml`'s `release` job on Node 24 or later: on Node 22, npm is below staged
  publishing's floor, and every release of an already-published package refused (#67).
- Title every pull request in Conventional Commits form: `self-pr-title.yml` checks it here, and
  `test/pr-title.test.mjs` holds the titles `release.yml` and Dependabot write to the same rule,
  since the changesets default, `Version Packages`, fails it.
