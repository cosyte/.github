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

- `pr-title.yml` now requires the scope: `type(scope): description`, with the optional `!` after the
  scope. A title with no scope, such as `fix: keep the escape sequence`, is refused, and the error
  message says the scope is required. Each repository takes the rule when its pin of this workflow
  moves to a reference that carries this change. Act on: before moving the pin, check that the
  repository's Dependabot config sets `prefix: chore` with `include: scope`, so its titles read
  `chore(deps): bump ...`, and that its pull requests are titled with a scope.

- `weekly-mutation.yml`'s check that `cosyte-mutate` can shard no longer runs `<mutate-cmd> --help`.
  It runs `mutate-cmd` as written, once, with `COSYTE_MUTATE_SHARD` naming a shard no file can be in,
  and fails, saying that sharding needs `@cosyte/vitest-config` 0.1.5 or later, when the command
  wrote a `mutation.json`, is still running after 180 seconds (it is stopped), exits non-zero, or
  wrote no shard report; the empty shard reports it leaves are deleted. Before, `--help` went only
  at the end of the line, so a compound `mutate-cmd` (`a && b`) ran a full mutation inside the check,
  and a tool whose help named the variable but which ignored it passed the check and was caught only
  after the full run. Inputs and their defaults, job ids, outputs, secrets and permissions are
  unchanged. **Act on:** with more than one shard, the check now runs your `mutate-cmd` once more
  than before, for seconds with a tool that shards; a command that does more than mutate (a build
  before it, say) does that part in the check too.

## workflows-2026-11-10-27aa79969b26

2026-11-10. Act on: nothing, against `workflows-2026-11-10-ab87aabbbafc`.

- `weekly-mutation.yml` can be adopted before the tool that shards is on npm (README.md, "The
  sharded weekly run"). With more than one shard, each shard has a new step right after the install,
  "Check that cosyte-mutate can shard", which runs `<mutate-cmd> --help` and fails within seconds
  unless every help printed names `COSYTE_MUTATE_SHARD`, saying that sharding needs
  `@cosyte/vitest-config` 0.1.5 or later; before, a tool that does not shard ran the whole suite on
  every shard, hours each, and only then failed. With `shard-count: 1`, the `mutation.json` a tool
  that does not shard writes during the run is read as the report of shard 1 of 1, so the run works
  with 0.1.4 as a full run. The workflow's comment no longer says that a shard stopped at its time
  limit saves its results: a cancelled job does not run the save step. Inputs and their defaults,
  job ids, secrets and permissions are unchanged. **Act on:** with more than one shard, a
  `mutate-cmd` that cannot take `--help` at its end now fails the check; until 0.1.5 is published,
  run with `shard-count: 1`.

## workflows-2026-11-10-ab87aabbbafc

2026-11-10. Act on: the new job `shard` in `weekly-mutation.yml`, a new check-run context, against `workflows-2026-11-10-0be6757a7738`.

- `release.yml` runs pre-publish gates in its `version` job, after `Verify` and before anything can
  publish (README.md, "The release gates"). It runs no full mutation pass. Eight inputs are added
  after `node-version`, each optional with a default; job ids, secrets and permissions are unchanged,
  and the `version` job's bound moves from 30 to 60 minutes.
  - The mutation gate is on for every caller: it reads the latest completed run of the caller's
    `mutation-workflow` (default `weekly-mutation.yml`) on the default branch through the GitHub API
    and refuses when that run did not succeed or finished more than `mutation-max-age-days` (default
    8) ago. **Act on:** a caller that has a `.github/workflows/weekly-mutation.yml` must keep its
    latest run green and recent, or each release refuses; a caller without the file skips the gate
    and is told so in the log.
  - `run-benchmarks` (with `bench-suites` and `bench-target`), `run-package-checks` and
    `run-tarball-samples` (with `docs-dir`) are `false` by default and each says by name that it
    skipped. To opt in, set the input under `with:`.
  - Every GitHub release now carries `sbom.cdx.json`, a CycloneDX SBOM of the package's production
    tree, written before the publish (and in `finalize` from the release commit) and attached by
    `scripts/github-release.mjs`'s new `--sbom` in the call that creates the release.
- `weekly-mutation.yml` is sharded and incremental (README.md, "The sharded weekly run"). A new job,
  `shard`, runs the caller's `mutate-cmd` on each of `shard-count` shards (a new input, default 8,
  1 to 16) with `COSYTE_MUTATE_SHARD` and `COSYTE_MUTATE_INCREMENTAL_FILE` set, restoring and saving
  each shard's incremental results through the Actions cache. `mutation` keeps its id and now merges
  the shard reports (`scripts/mutation-shards.mjs`) before the ratchet; it fails when a shard failed.
  A new input, `report-name` (default `mutation-report`), names the merged artifact. **Act on:** it
  needs a `cosyte-mutate` that reads `COSYTE_MUTATE_SHARD`, which `@cosyte/vitest-config` 0.1.4 does
  not, so no caller should adopt it before that release; and schedule it at least every 6 days, so
  each shard's cache entry is read before GitHub evicts it.

## workflows-2026-11-10-0be6757a7738

2026-11-10. Act on: the new jobs `scaling-gate` and `bench-compare` in `ci.yml`, each a new check-run context, against `workflows-2026-11-10-ed625b471274`.

- The performance standard's jobs, both off until a caller opts in (README.md, "The performance
  standard's jobs"). `ci.yml` takes four inputs: `run-scaling-gate` and `run-bench-compare`, both
  `false` by default, and `bench-suites` (default `""`) and `bench-target` (default
  `"dist/index.mjs"`), which only `bench-compare` reads. A caller that passes nothing sees two
  skipped checks, `ci / scaling-gate` and `ci / bench-compare`, and no other change. Job ids before
  them, every other input and default, secrets and permissions are unchanged.
  - `scaling-gate` runs `pnpm test:perf`, the caller's run of the scaling gate from
    `@cosyte/test-utils/perf`, and is red when it fails. To opt in, add `run-scaling-gate: true`
    under `with:`; require it only while that input is on.
  - `bench-compare` runs on a pull request only. It builds the head and, in a worktree, the base,
    and times both with `cosyte-bench compare` from `@cosyte/bench` for each suite (every
    `bench/*.bench.mjs` and `bench/*.bench.ts`, or those `bench-suites` names). The Markdown goes in
    the job summary, and the `results-v1` documents in the `bench-comparison` artifact. It never
    fails: a regression is a warning on the run's page. To opt in, add `run-bench-compare: true`;
    never require it.

## workflows-2026-11-10-ed625b471274

2026-11-10. Act on: the new jobs `coverage-ratchet` and `mutation` in `ci.yml`, each a new check-run context, against `workflows-2026-11-10-4522886e8c1e`.

- The testing standard's jobs, all off until a caller opts in (README.md, "The testing standard's
  jobs"). The tools they run, `cosyte-ratchet` from `@cosyte/script-utils` and `cosyte-mutate` from
  `@cosyte/vitest-config`, are not on npm yet, so a caller opts in only after that release and after
  it has added both packages, a `stryker.config.mjs` and a `quality-floor.json`.
  - `ci.yml` takes two inputs, `run-coverage-ratchet` and `run-mutation`, both `false` by default,
    which add the jobs `coverage-ratchet` and `mutation`. A caller that passes nothing sees two
    skipped checks, `ci / coverage-ratchet` and `ci / mutation`, and no other change. To opt in, add
    `run-coverage-ratchet: true` and `run-mutation: true` under `with:`. `coverage-ratchet` runs
    `pnpm test:coverage` and then `cosyte-ratchet check --skip mutation`, against
    `origin/<base branch>` on a pull request; `mutation` runs on a pull request only,
    `cosyte-mutate changed` and then `cosyte-ratchet check --skip coverage`, both against
    `origin/<base branch>`. Both run beside `verify`, on `ubuntu-latest` at the first Node line,
    with the whole history checked out, and write the ratchet's report to the job summary. Require
    either check only while its input is on, since a skipped job satisfies a required context.
  - A new reusable, `nightly-properties.yml`, job `properties`: the caller's `test-cmd` (default
    `pnpm test`) with `COSYTE_PROPERTY_RUNS` at `property-runs` (default `"10000"`), and every
    replay seed a failing property prints kept in the job summary and the `property-run` artifact.
    To opt in, call it from a scheduled workflow of the caller's own.
  - A new reusable, `weekly-mutation.yml`, job `mutation`: the caller's `mutate-cmd` (default
    `pnpm exec cosyte-mutate full`), then `cosyte-ratchet check --skip coverage`, with each
    package's score against its floor in the job summary and `reports/mutation/` in the
    `mutation-report` artifact. A score below its floor is red. It never commits. To opt in, call
    it from a scheduled workflow of the caller's own.
  - The `working-directory` input's description now names every job that reads it; its default and
    behavior are unchanged. Job ids `verify`, `prepublish`, `actionlint`, `bun` and `deno`, every
    other input and default, secrets and permissions are unchanged.

## workflows-2026-11-10-4522886e8c1e

2026-11-10. Act on: the new jobs `bun` and `deno` in `ci.yml`, each a new check-run context, against `workflows-2026-11-09-402d4e1568e7`.

- `ci.yml` takes two opt-in inputs, `run-bun` and `run-deno`, both `false` by default, which add the
  jobs `bun` and `deno`: each installs with pnpm from the committed lockfile, as `verify` does, and
  runs the caller's own `test` script under that runtime, `bun --bun run test` and `deno task test`
  (with `node` taken off PATH, so a script's literal `node` runs on Deno too). A caller that passes
  nothing sees two skipped checks, `ci / bun` and `ci / deno`, and no other change. To opt in, add
  `run-bun: true` and `run-deno: true` under `with:`; `bun-version` (default `"1.4.4"`) and
  `deno-version` (default `"2.9.8"`) pick the runtime. Require `ci / bun` or `ci / deno` in a ruleset
  only while its input is on, since a skipped job satisfies a required context.
- To run `verify` on every system, pass
  `os: '["ubuntu-latest", "windows-latest", "macos-latest"]'`; the default is still
  `'["ubuntu-latest"]'`. Each new leg is a new check, `ci / verify (<node>, <os>)`. Every shared step of
  `verify` is now proven on all three systems by `self-check.yml`'s new `systems` job, which runs
  `ci.yml` itself against `test/fixtures/ci-caller/` (README.md, "Every system and runtime"). One
  limit it found: the dash checker in `@cosyte/script-utils` cannot run on macOS, where grep has no
  `-P`; it refuses rather than passing, so a caller whose own `lint` runs it reds on macOS.
- `verify` has a new first step, before the checkout, on every system: it sets git's
  `core.autocrlf false` and `core.eol lf`, so text files check out with LF line endings. Measured on
  2026-11-10: without it, `windows-latest` checks out with CRLF every text file whose eol no
  `.gitattributes` sets. A caller does nothing. On `ubuntu-latest`, the only system a caller runs
  today, and on `macos-latest`, the same run checked those files out LF without the step, so there
  it changes no byte. A file whose eol the caller's `.gitattributes` sets keeps that eol, since the
  attribute overrides both settings, so a caller with `* text=auto eol=lf` gets LF with or without
  the step.
- `scripts/docs-content-check.mjs`, which `verify` fetches when `check-docs-content` is on, now runs on
  a Windows runner. Its entry guard compared its own URL's pathname with `argv[1]` as paths, which on
  Windows never matched, so the step exited 0 without checking anything. It compares file URLs now.
  A caller does nothing: no caller runs `verify` on Windows yet, and on Linux and macOS the checker
  runs as before.
- `ci.yml` takes a `working-directory` input, `"."` by default, naming where `verify`, `bun` and
  `deno` find `package.json`. It exists so this repository can run the workflow against its fixture;
  at `"."` every step reads what it read before. `prepublish` and `actionlint` ignore it.
- Job ids `verify`, `prepublish` and `actionlint`, every existing input and default, secrets and
  permissions are unchanged.

## workflows-2026-11-09-402d4e1568e7

2026-11-09. Act on: nothing, against `workflows-2026-11-08-810a8affe9de`.

- `release.yml` takes an optional `node-version` input, the Node line every job that sets up Node
  runs on: `version`, `release` and `finalize`. It defaults to empty, which keeps each job on the
  line it ran on before the input existed, `version` on 22 and `release` and `finalize` on 24, so a
  caller passing nothing runs exactly as it did. A package whose `engines.node` starts above 22, whose
  `version` job pnpm refuses to install on 22 (`ERR_PNPM_UNSUPPORTED_ENGINE`), passes its floor with
  `with: { node-version: "24" }`, and all three jobs then install, build and publish on it. The value
  must be a version of Node 24 or later, because the `release` job publishes on it and the npm that
  Node 22 bundles is below the publish floor: the `version` job refuses anything else, an alias such
  as `lts/*` included, before it sets Node up, installs, tags or publishes. Job ids, the other inputs
  and their defaults, secrets and permissions are unchanged.

## workflows-2026-11-08-810a8affe9de

2026-11-08. Act on: the default of `expect-unpublished-deps` in `ci.yml` and `release.yml`, from `"@cosyte/fhir=blocked"` to `""`, against `workflows-2026-11-08-c0db8d8e5927`.

- `ci.yml`'s and `release.yml`'s `expect-unpublished-deps` default to empty instead of
  `@cosyte/fhir=blocked`. That entry dates from before `@cosyte/fhir` was on npm; it is published
  now, so the entry was stale and every caller's install gates printed a notice saying the
  allowance "is on the registry now". A caller needs to do nothing: a package the registry serves
  is never absent, so the entry already excused nothing, no verdict changes, and only the notice
  stops. The reference note lists the changed default under "must act on", because it lists every
  changed default there. The input stays, in the same grammar, for a caller that has to name a
  blocked dependency, and a caller that passes it, empty or not, is unaffected. Job ids, the other
  inputs and their defaults, secrets and permissions are unchanged.

## workflows-2026-11-08-c0db8d8e5927

2026-11-08. Act on: nothing, against `workflows-2026-11-08-ebece960a9ac`.

- `ci.yml`'s `actionlint` job restores rhysd/actionlint's release tarball from the caller's own
  Actions cache with `actions/cache/restore` and `actions/cache/save` at v6.1.0, keyed on the
  actionlint version and its SHA-256, and downloads it only when the cache holds no copy that
  matches. GitHub's release downloads answered 504 for hours on 2026-11-08 and failed this job in
  every caller. The SHA-256 is checked on whatever is unpacked, cached or downloaded; a cached copy
  that does not match is downloaded again with a warning; a download retries up to five times with
  curl's own backoff; and the tarball is saved on a miss, before the lint, so a pull request whose
  lint finds something still seeds the cache. A cache that cannot be reached is a miss with a
  warning. The cache steps use the runner's own cache token, so a caller grants nothing new: inputs,
  secrets, permissions and job ids are unchanged. A run on the caller's default branch seeds the
  entry every pull request can read. `self-check.yml`, this repository's own check, does the same
  (#111).
- `gate-no-emdash.yml`, `gate-no-emdash-install.yml`, `gate-no-internal-refs.yml` and
  `gate-no-internal-refs-install.yml` take an optional `node-version` input, defaulting to `"22"`,
  the line every job in them ran on before. A caller passing nothing runs exactly as it did. A
  package whose `engines.node` starts above 22 with `engine-strict`, where pnpm refuses to install or
  run a script on 22, passes its floor with `with: { node-version: "24" }`. Job ids, the other inputs
  and their defaults, secrets and permissions are unchanged (#111).

## workflows-2026-11-08-ebece960a9ac

2026-11-08. Act on: nothing, against `workflows-2026-11-08-a3be6a780b17`.

- `release.yml` tags the version commit in the `version` job, seconds after the merge and before
  anything is published, with the new `scripts/release-tag.mjs`, and creates every GitHub release
  at that existing tag with `--verify-tag` and no `--target`. GitHub refuses a `GITHUB_TOKEN` any ref
  at a commit whose `.github/workflows/` differ from the default branch's, and the release step used
  to make the tag minutes later, after the publish, through `gh release create --target`. So a pull
  request that changed workflow files and merged mid-release stranded `@cosyte/transform@0.1.4` on
  npm with no tag or release, twice on 2026-11-08, and no later run could tag it either. The rule was
  measured that day and is reproduced in `test/release-tag.test.mjs`. The tag is made with the
  automatic token at the `contents: write` the `version` job already holds, and `is-release` and
  `finalize` are withheld unless it is on the version commit (#110).
- If GitHub refuses that tag, nothing is published and the `version` job ends red, after the Version
  PR step, with the one command that makes the tag with a maintainer's own credentials and the
  re-run that finishes the release. A release the old pipeline stranded is finished the same way
  (#110).
- Only the version commit's own run publishes it. A later commit's run no longer publishes, from its
  own tree, a version whose own run stopped short: it finalizes one that is published, or reports
  the run to re-run. The tag no longer proves a publish, so the notes gate looks past it on the tagged
  version commit, and every run asks the GitHub release, and when that is missing the registry, what
  a tagged version is owed. Inputs, secrets, permissions and job ids are unchanged (#110).

## workflows-2026-11-08-a3be6a780b17

2026-11-08. Act on: nothing, against `workflows-2026-11-07-0d5dbc3a9a72`.

- The caller examples in the headers of `pr-title.yml`, `gate-no-emdash.yml` and
  `gate-no-emdash-install.yml`, and the em-dash and PR title callers in README.md, no longer show a
  `concurrency:` block. Those callers run on `edited`, so a push and an edit can arrive together,
  and a group cancels one of the two runs, even a queued one under `cancel-in-progress: false`; a
  cancelled run in the newer check suite counts as a failing required context and blocks the merge
  until someone re-runs it. A caller that copied the old example should remove its block. Comments
  only: no job, input, secret, permission or step changes (#109).

## workflows-2026-11-07-0d5dbc3a9a72

2026-11-07. Act on: nothing, against `workflows-2026-11-07-e3a24dad0713`.

- `release.yml`'s workflow-level `permissions:` block is `contents: read`. Every job already
  declares its own complete block, so no job's token changes and a caller grants exactly what it
  granted before: `actions: read`, `contents: write`, `id-token: write` and `pull-requests: write`.
  A job added later without a block of its own runs read-only. The reference note now compares what
  a caller must grant, every job's block together at its strongest, rather than the workflow-level
  block alone, so this move reports no permission change (#103).

## workflows-2026-11-07-e3a24dad0713

2026-11-07. Act on: nothing, against `workflows-2026-11-07-9c75b80bfbf0`.

- The release pipeline's registry lookups, in `scripts/install-check.mjs` and
  `scripts/publish-floor.mjs`, escape every `/` in a package name rather than only the first. A
  valid npm name has at most one, so no caller's lookup changes. `scripts/org-defaults-coverage.mjs`,
  which only this repository runs, reads each issue template through one file descriptor. Inputs,
  secrets, permissions and job ids are unchanged (#102).

## workflows-2026-11-07-9c75b80bfbf0

2026-11-07. Act on: nothing, against `workflows-2026-11-07-498c7c13c886`.

- Every job in the reusable workflows carries a `timeout-minutes`. A caller cannot bound a job that
  calls a reusable workflow, so a hung step could hold its runner for the six-hour default. The
  bounds sit well above the slowest runs measured on 2026-11-07: 30 minutes for `ci.yml`'s `verify`
  (4 minutes at most) and `prepublish` (above its install step's own 15), `codeql.yml`'s `analyze`
  and `release.yml`'s `version`; 15 for `scorecard.yml`'s `analysis`; 10 for the jobs of the four
  gate workflows and `drift-check.yml`; and 60 for `nightly-fuzz.yml`. Job ids, inputs, secrets and
  permissions are unchanged (#99).

## workflows-2026-11-07-498c7c13c886

2026-11-07. Act on: nothing, against `workflows-2026-11-07-f1c57f871cba`.

**This is the reference every caller moves to**, all at once. It carries everything in the
references below it as well, so a caller moving here from an earlier reference, or from `@main`,
takes in `workflows-2026-11-07-32f9f01541de`'s change to act on too.

- Every `github/codeql-action` pin, `init` and `analyze` in `codeql.yml` and `upload-sarif` in
  `scorecard.yml`, moves together from v4.37.9 to v4.39.3, in one commit (#97).

## workflows-2026-11-07-f1c57f871cba

2026-11-07. Act on: nothing, against `workflows-2026-11-07-b3061b0471d4`.

- Every `actions/setup-node` pin moves from 7.0.0 to 7.1.0, the tests that quote the pin with it
  (#73).

## workflows-2026-11-07-b3061b0471d4

2026-11-07. Act on: nothing, against `workflows-2026-11-07-d84b6fe790ff`.

- Every `github/codeql-action` pin, `init` and `analyze` in `codeql.yml` and `upload-sarif` in
  `scorecard.yml`, moves together from v4.37.5 to v4.37.9, the last patch on that line, because
  `analyze` refuses a config `init` wrote at any other version. A test now fails the build when the
  pins disagree (#95).

## workflows-2026-11-07-d84b6fe790ff

2026-11-07. Act on: nothing, against `workflows-2026-11-07-5c8c01fe48d2`.

- `actions/upload-artifact` moves from 7.0.1 to 7.0.2, a patch, in `release.yml` and
  `scorecard.yml` (#77).

## workflows-2026-11-07-5c8c01fe48d2

2026-11-07. Act on: nothing, against `workflows-2026-11-07-6c358640421d`.

- `ci.yml`'s `actionlint` job runs rhysd/actionlint's own release binary, version 1.7.12, checked
  against a pinned SHA-256 before it is unpacked, in place of reviewdog/action-actionlint. From
  v1.75.0 that action installs actionlint by piping a download script from a fork into bash. The
  job id and the `run-actionlint` input are unchanged. The job now fails on actionlint's own exit
  status over every tracked workflow file, where the action reported only findings on lines a pull
  request changed, and it needs shellcheck on the runner, which the hosted runner has (#93).

## workflows-2026-11-07-6c358640421d

2026-11-07. Act on: nothing, against `workflows-2026-11-07-32f9f01541de`.

It carries everything in `workflows-2026-11-07-32f9f01541de` below as well.

- A re-run of a release job is safe against an immutable release. `scripts/github-release.mjs` no
  longer replaces an asset with `--clobber`, which GitHub refuses for a published immutable release.
  For a release that already exists it edits the body and compares each asset it built with the one
  the release carries: the same content is left as it is, different content fails the run naming the
  first path that differs, and only an asset the release does not carry yet is uploaded. The same
  content means the same files with the same bytes, so a tarball packed again from the same commit,
  whose timestamps differ, still counts as the same (#87).

## workflows-2026-11-07-32f9f01541de

2026-11-07. Act on: `ci.yml`'s `node-versions` default is `["22", "24", "26"]`, so a caller that
passes no list now runs its suite on Node 26 too. A caller that cannot run there yet passes
`'["22", "24"]'` until it can.

- `ci.yml` adds Node 26 to the matrix a caller gets when it passes no `node-versions` (#88).
- `pr-title.yml` is new: one job, `conventional-commits`, that holds a pull request title to
  Conventional Commits. There is nothing to act on until a caller adopts it, with the example in
  README.md, "Calling them"; its context is `<caller job id> / conventional-commits`. Before
  requiring it, a caller sets its Dependabot `commit-message` to `prefix: chore` with
  `include: scope`, as this repository now does, so that Dependabot's titles read
  `chore(deps): bump ...` and pass (#88).
- `release.yml` titles the "Version Packages" pull request and its commit
  `chore(release): version packages`, which `pr-title.yml` passes; the changesets default,
  `Version Packages`, does not (#88).
- The reference note no longer counts the reusable workflows as six, and comments in
  `drift-check.yml`, `scripts/release-notes.mjs`, and `scripts/org-defaults-coverage.mjs` no longer
  point at deleted documents (#88).

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
