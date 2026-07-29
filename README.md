# cosyte/.github

Org-wide reusable GitHub Actions workflows for the `@cosyte/*` suite. Each repo's own workflow is a
thin caller, so the pipeline is defined once here. All actions are pinned to commit SHAs.

> Currently **private** (the suite is pre-launch). It must become **public** at launch, because a
> public repository cannot call reusable workflows from a private one.

## Reusable workflows

| Workflow | Purpose | Used by |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | typecheck · lint(`--max-warnings=0`) · format:check · [PHI scan] · test · coverage (gating) · build · `attw` · dual ESM/CJS smoke · actionlint | every parser |
| [`release.yml`](.github/workflows/release.yml) | Changesets → npm publish **with provenance** → docs artifacts → GitHub release **with derived notes** → `repository_dispatch` to `cosyte/docs`. On failure, uploads the redacted npm debug log as a run artifact | every published parser |
| [`nightly-fuzz.yml`](.github/workflows/nightly-fuzz.yml) | run the fuzz target; malformed bytes must never crash/hang/OOM | byte parsers (`dicom`, `mllp`) |
| [`drift-check.yml`](.github/workflows/drift-check.yml) | fail when a repo diverges from `config/drift-manifest.json` | the meta-repo (umbrella) |

## Calling them

```yaml
# <parser>/.github/workflows/ci.yml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  ci:
    uses: cosyte/.github/.github/workflows/ci.yml@main
    with:
      run-phi-scan: true # parsers that handle PHI / raw bytes
```

```yaml
# <parser>/.github/workflows/release.yml
name: Release
on:
  push: { branches: [main] }
jobs:
  release:
    uses: cosyte/.github/.github/workflows/release.yml@main
    with:
      package-name: "@cosyte/hl7"
    secrets: inherit # NPM_TOKEN + RELEASE_PR_TOKEN + DOCS_REPO_DISPATCH_TOKEN
```

## Who authors the "Version Packages" PR

**`GITHUB_TOKEN` cannot, and the failure is silent.** GitHub does not start workflow runs for events
produced by `GITHUB_TOKEN`. That is deliberate anti-recursion. The consequence for Changesets is that
the "Version Packages" PR arrives with **zero checks**, and a required status check that never
reports is **pending, not failing**, so with `bypass_actors: []` on the rulesets nobody can merge it,
an admin included. It looks like a slow queue. It is a permanent block.

**Measured, not predicted, read 2026-07-29:** `cosyte/ccda#61` ("Version Packages", head branch
`changeset-release/main`, author `app/github-actions`) reports **0 check runs** and
`mergeStateStatus: BLOCKED` against 4 required contexts. Do not cite `cosyte/hl7#63` for this. It is
the PR the trap was found on, but a human then pushed `edcf4128 chore: run CI on the version PR` to
it, which is the manual escape, so it now reads MERGED with 8 green checks and refutes on sight the
thing it was cited for.

**The control**, which is what makes this the token rather than the repo or the ruleset:
`cosyte/dicom#23` is authored by `app/dependabot`, a **bot**, in a repo governed by the **same three
rulesets** as `ccda`, and it has 8 checks and reports `CLEAN`. Repo class and ruleset held constant,
actor varied, outcome flipped.

The trap predates the rulesets added on 2026-07-27/28; those widened it, taking `hl7` from 3 required
contexts to 5.

**The fix is `RELEASE_PR_TOKEN`**, a credential that is not `GITHUB_TOKEN`. Two things are needed,
and doing only the first buys a fix that decays after one changeset:

1. **the `GITHUB_TOKEN` env var on `changesets/action`**, which is what it opens the PR with. The
   action reads `process.env.GITHUB_TOKEN || core.getInput("github-token")`, so **the env wins**:
   adding a `github-token:` input while leaving the env in place is a silent no-op.
2. **`persist-credentials: false` on the caller checkout.** The version commit is pushed by
   `git push`, not through the API. Left at its default, `actions/checkout` persists an Authorization
   extraheader into the local git config and git sends it preemptively, so the `~/.netrc` that
   `changesets/action` writes with our token is never consulted and the push stays `GITHUB_TOKEN`.
   That push is what produces the `synchronize` event on every later update to the PR.

**Why not simply hand the PAT to `actions/checkout`?** It also works, and it was the first draft. It
puts an org-scoped credential into `.git/config` at step one, where it sits for the whole job. What
the netrc route buys is specific and worth naming exactly: the PAT is **absent during
`pnpm install --frozen-lockfile`**, which is where third-party dependency lifecycle scripts run (no
caller sets `ignore-scripts`), and absent during the `Verify` ladder after it. That is the window
that matters most, because it is the only one whose contents this org does not write.

**What it does not narrow**, measured rather than assumed, because an earlier draft of this section
claimed the PAT arrived "after all third-party code has run" and that is **false**. From the
`changesets/action` step onward the token is on disk in `~/.netrc` (written unconditionally, before
the arm switch) and injected as `GITHUB_TOKEN` into the environment of `pnpm run version` and
`pnpm run release`. Neither caller *script* reads it, but the process subtree does not stop there:
`release` is `changeset publish`, which spawns `pnpm publish` (every caller declares
`packageManager: pnpm@10`) without `--ignore-scripts`, which runs each caller's `prepublishOnly`
(`clean && typecheck && lint && test && build && attw`, plus `gen:all` in `dicom`). **The whole
verify ladder therefore runs a second time inside that step with the PAT in the environment.** It is
visible in the real `hl7` 0.0.3 publish (run `30354998951`, 2026-07-28): the `Verify` step took ~53s,
and the interval inside `changesets/action` between "is being published" and "packages published
successfully" took ~55s, which is not a 50 kB tarball upload.

On the publish arm the PAT buys nothing at all, since `createGithubReleases: false` leaves the
action's octokit unused there. Narrowing it to the version-PR arm is not done: the only predicate
available is `steps.notes.outputs.is-release`, which is not the action's own arm predicate, and a
disagreement would hand `GITHUB_TOKEN` back to the Version PR. The exposure is accepted and written
down rather than traded for that risk.

**If the netrc fallback does not apply**, the push fails loudly and the run goes red with npm
untouched, because the publish arm does not push at all (`createGithubReleases: false` means the
action never pushes a tag; `gh release create --target` makes it). The failure mode is a Version PR
that does not get opened, which is strictly better than one that opens and cannot be merged.

**Scope it narrowly.** All this job asks is: push a branch, open or update one pull request. As a
fine-grained PAT that is `Contents: read+write`, `Pull requests: read+write`, `Metadata: read`, on the
caller repos and nothing else. It does **not** need `Workflows: write`: the action commits with
`git add .`, and what `pnpm run version` changes is `package.json`, `CHANGELOG.md`, `.changeset/`,
and the `VERSION` constant `scripts/sync-version.mjs` rewrites in `src/index.ts` (`src/version.ts` in
`dicom`), none of which is under `.github/workflows/`. A classic PAT with `repo` is far wider
than what is needed here. **Do not reuse `DOCS_REPO_DISPATCH_TOKEN`**, which needs write on
`cosyte/docs` alone: one token serving both purposes is over-scoped for each of them.

**What does not change:** `setupGitUser` still hardcodes the version commit's git author to
`github-actions[bot]` whichever token is in play. Only the PR's author changes, to the token's owner.

**Unset, the workflow warns rather than fails.** The secret is optional and falls back to
`GITHUB_TOKEN`, which is exactly the old behaviour, trap included. Failing closed would take every
caller's release pipeline down to protect against a state those repos are already in. The fallback is
announced in the run log, because a fix that silently is not applied is worse than no fix.

## Release notes

`release.yml` derives every GitHub release body from **the changesets that release consumed**. Each
changeset is a human-written summary of one change, they are what drove the version bump, and the
"Version Packages" commit deletes them, so the workflow recovers them from that commit's diff (hence
`fetch-depth: 0`).

The derivation lives in [`scripts/release-notes.mjs`](scripts/release-notes.mjs), not in the YAML,
because this workflow runs in 8+ public repos behind a protected environment and is awkward to
iterate on there. It has no dependencies (`node:test` only) and is unit-tested in
[`test/release-notes.test.mjs`](test/release-notes.test.mjs) against the real 15 changesets
`cosyte/hl7` consumed for `v0.0.2`, asserted **byte for byte** against the body live on that release.

### What a release body says

A release note lists what changed **for the reader**. The title is the tag and nothing else, there is
no preamble and no count, and the artifacts are not explained in terms of our own docs pipeline:

```markdown
### What changed

- Add streaming / incremental parse: `parseStream`.
- Add `profiles.visage`, the sixth built-in vendor profile: Visage 7 imaging/PACS.

Full detail for each change is in [`CHANGELOG.md`](https://github.com/cosyte/hl7/blob/main/CHANGELOG.md).

### Install

```bash
npm install @cosyte/hl7@0.0.2
```

**npm:** https://www.npmjs.com/package/@cosyte/hl7/v/0.0.2
```

A change a consumer of the published package cannot observe is **dropped**, not reworded: CI gates,
repo scanners, `sync-version`, CodeQL/Scorecard, dev-dependency-only advisories, trademark notices,
README and docs status-line corrections. When *every* change in a version is internal, the body says
exactly that rather than padding: `Internal tooling and CI only. No change to the published package
surface.`

### The gate

**The pipeline refuses to publish a release whose body is not fit for a public surface.** Documentation
governs whoever reads it; a gate governs everyone. The run **fails and names the offending line**:

| Refusal | Fires on |
|---|---|
| Nothing to say | empty body, whitespace, a bare title, or an `Automated release of <tag>` stub |
| No record of what shipped | a version bump that consumed no changesets |
| An undescribed change | a consumed changeset with an empty summary |
| Internal project identifier | `HL7-U`, `CCDA-P7`, `MLLP-8.1`, `DOCS-CONTENT-P4`, `README-ORG-SWEEP` |
| Phase or slice language | `Phase W`, `Phase 5b`, `roadmap Phase K`, `(thirteenth slice)` |
| ADR reference | `ADR 0018` |
| Em dash | `U+2014`, inherited from changesets written before that ban |
| Unobservable change | a bullet describing something no consumer can see |
| A sentence built around the identifier | removing it would leave prose that does not parse |
| An opening sentence too long for a bullet | over 200 characters, where the alternative is cutting it |
| A bullet that was cut short | a one-letter stump, or an over-length entry, in the finished bytes |
| Mangled prose | doubled or orphaned clause punctuation, an emptied parenthetical |
| An unclassifiable commit | no readable `package.json` at `HEAD`, or a version that appears in no commit |
| Wrong release | a body that disagrees with the version or package that reached npm |

**Every refusal above bar the last fires before npm is reached**, and structurally rather than by
arrangement: `changesets/action` is only handed a publish command once the body has been derived and
its bytes proved fit, so a run that cannot say what it is shipping cannot publish. Only "wrong
release" can fire afterwards, because the version it reconciles against is what Changesets reported
publishing and does not exist any sooner.

The renderer **translates** first (identifiers belong in the changeset, the changelog, the commit and
the roadmap, never in a release body) and the gate then proves the translation worked. Translation is
never silent: every rewrite and every dropped change is printed to the run log.

**What the gate does and does not cover.** It enforces the *known* banned set, and it shares the
project-prefix list with the translator, so it cannot catch an identifier from a programme prefix
nobody has added to that list yet. No rule could: the only way to spot one from its shape alone is a
`WORD-N` pattern, which is exactly what destroys `SCH-11`, `PID-3`, `MSH-2`, `NM1-03`, and `ICD-10`.
What the gate *does* buy is that a rule cannot be quietly bypassed downstream, because it re-reads
the finished bytes. **Starting a new programme means adding its prefix to `PROJECT_PREFIXES`**; that
is the maintenance cost of keying on prefixes instead of shapes, and it is the cheaper mistake.

Three traps the implementation handles deliberately, each of which caused a real leak on 2026-07-27:

- **Prefix keying, never the `WORD-N` shape.** `MLLP-10` is ours; `SCH-11`, `PID-3`, `MSH-2`,
  `NM1-03` are HL7 and X12 segment-field references and are exactly the reference material a
  consumer needs.
- **Decapitation.** Stripping an identifier from the front leaves a fragment, and
  `(thirteenth slice): builder emits X` is worse than the original. The head is repaired afterwards.
  A dangling **tail** (removing `phase log` leaves `..., not a`) is a **refusal**, not a repair:
  walking back off loose words is how a translator starts editing meaning, and the same walk-back
  turns `the emitter does not` into `the emitter does`, which is well-formed prose no gate can catch
  and the opposite of the truth. The run stops and asks for a sentence that survives, which costs
  one changeset edit before anything is published.
- **Case sensitivity.** `FHIR-bridge` and `docs-content/` are legitimate content that a
  case-insensitive rule would flag.

**In running prose the cut is only ever taken where the sentence survives it, and this is the
load-bearing rule.** Removing a phrase from the middle of a clause leaves prose that does not parse:
`no longer carries phase language, item identifiers or ADR numbers` became
`no longer carries, item identifiers or ADR numbers`, and **nothing downstream could see it**,
because a mangled sentence carries no banned bytes for a byte-level rule to find. A gate reads
bytes, not grammar. So a span is removed only when the text on both sides of it is the same kind of
thing (nothing, a clause separator, or a plain word), and never when it is glued to its neighbour by
a hyphen or a slash (`The MLLP-1-driven reconnect` is one word). A separator on exactly one side
means the rest of that clause stays behind, and the run **refuses**, naming the changeset. Leaving
the identifier in place is deliberate: it keeps something in the bytes for the gate to catch.

**Inside a parenthetical the same test drops rather than refuses.** Parentheticals are split on
commas and cleaned segment by segment, so a segment that cannot be cleaned safely is dropped whole,
which is what this file already did with a segment that cleaned down to nothing. A parenthetical is
by construction removable; a clause in a sentence is not. Segment edges are told to read as the
separators they are, or the segment view calls a cut safe that the whole sentence would not.

**And a sentence is never shortened.** An over-long opening sentence used to be cut at the nearest
word boundary and nothing was said, which published `...a medication naming two different drugs with
o.` to one release and, in the same body, cut a three-part finding down to two and appended a full
stop so it read as a complete claim the author never made. A headline is now the author's first
sentence entire, or the run refuses and asks for a shorter one. **How many live bodies still carry
that cut is measured by [`scripts/release-diff.mjs`](scripts/release-diff.mjs)**, below; correcting
them is separate work and is not done here.

**What this costs, measured 2026-07-28** on the 242 changeset files, deduplicated by name, recovered
from every commit touching `.changeset/*.md` in the 13 repos that carry them. **214 changesets pass
untouched, 24 are asked to shorten a first sentence, 3 to rewrite one, 1 was already refused.**

`assert` re-reads finished bytes for the shapes a cut leaves behind, and **on the 17 live release
bodies it now finds none, while the differ finds 9 cut bullets.** That gap is deliberate and is the
honest limit of a byte rule. Every rule wide enough to catch `...reads MSA-2 whole to match, and
\`reescape\` emits a li.` also refuses `Pass an unknown Z-segment through as is.`, `...the more broken
the document was.`, `...recorded as A, B, AB, or O.` and `...quantity the builder emits to mL.`, all
of which are complete sentences and one of which a real release consumed. **Refusing a correct
sentence blocks a publish on a lie, so the byte rules stay narrow and the guarantee lives where it
can be kept: the renderer no longer cuts a sentence at all.** A body this pipeline produces cannot be
truncated; a body it merely inspects can be, and a byte rule will not tell you which.

A fourth, specific to this suite: `slice` is our word for a unit of work, but it is **also** real
clinical vocabulary. A DICOM study has a slice thickness, a slice location, and a Number of Slices,
so only the unambiguously-internal determiner forms are rewritten.

### Consequences worth knowing

- **Every change needs a changeset with a real summary.** `pnpm changeset` with a blank description
  now stops a release rather than producing an empty bullet.
- **The notes are derived exactly once, before the publish step**, and the publish step asserts and
  publishes that same file. The ordinary failure therefore costs nothing: npm is untouched and the
  fix is to amend the changeset and re-run. Deriving a second time after publishing cannot work,
  because `changeset publish` creates the `v<version>` tag locally and that tag is how the script
  answers "is a release pending".
- **npm is downstream of the gate.** `prepare` is the permission to publish, not a report on it: its
  `is-release` output is what `release.yml` passes to `changesets/action` as the publish command, so
  a run that could not derive a fit release body never reaches the registry. The body is proved a
  second time, from the finished bytes, in the step immediately before that one. Until 2026-07-28 the
  order was publish first and check second, with an error afterwards saying npm had the package and
  the gate had not run. **A published version is permanent, so that was a correction, not a gate.**
- **The one check that still follows the publish is the reconciliation**, which compares the body
  against the version Changesets reported publishing. That version does not exist any earlier. A
  disagreement there still leaves the package on npm with no GitHub release, and that remains the
  intended trade: a loud red beats a silent green carrying a meaningless release. Recovery is to
  create the release by hand, since re-running finds nothing left to publish.
- **The "Version Packages" PR body tells you to publish by hand. Do not.** `changesets/action` writes
  that sentence whenever it is opening the PR without a publish command set, and the command is
  withheld until the notes gate has passed. Merging the PR is still what
  releases; the publish then runs behind the protected `release` environment. The wording is left
  wrong on purpose: the only way to correct it is to re-derive "are there pending changesets"
  ourselves, and a predicate that disagrees with the action's own by one empty changeset file would
  hand the publish command back on the arm that actually publishes.
- **A commit the gate cannot classify is a red run, not a quiet skip.** "No release pending" is
  benign on exactly two readings, and the script distinguishes them by a `code` rather than by prose:
  `already-released` (`v<version>` is tagged, which is every ordinary push to main between releases)
  and `never-versioned` (see below). If `package.json` is unreadable at `HEAD`, or the version at
  `HEAD` appears in no commit (a shallow checkout, so mind `fetch-depth: 0`), the run stops there
  rather than letting the publish step decide on its own.

### A repo that has never released

**A first release has no previous version and no consumed changeset, so there is nothing here for
the gate to derive from.** That is not a release whose notes are missing; it is a repo with no
release in it yet, and `prepare` now classifies it as `never-versioned` and exits 0 having derived
nothing and set `is-release=false`.

**Why it had to change.** Measured against `origin/main` on 2026-07-29: `cli`, `deid` and `synth`
are at `0.0.0` with no tags and have never published, and every one of their release runs failed
here. The refusal closed the loop on itself. The gate refused in `prepare`, so `changesets/action`
never ran, so no "Version Packages" PR was ever opened, so the version never left `0.0.0`, so the
next run refused for the same reason. The version could not advance past the check that was waiting
for it to advance.

`transform` was a fourth and is now at `0.0.1`, which is worth stating precisely rather than
quietly dropping. It escaped hours before this landed, by merging a "Version Packages" PR opened on
2026-07-22, *before* the notes gate was made fail-closed. That route requires a PR that already
exists, so it is not a fix and it did not generalise: `cli` and `synth` have no Version PR at all,
and no run of theirs could open one.

**The test is a property of the history and of nothing else:** no commit reachable from `HEAD` has
ever carried a `package.json` version other than the one at `HEAD`. The three alternatives were each
rejected for being wrong in the dangerous direction, which is letting a package that HAS released
skip the gate:

| Rejected test | How it goes wrong |
|---|---|
| the version is `0.0.0` | a magic value, neither necessary nor sufficient. A scaffold may start anywhere, and `0.0.0` is publishable. |
| no `v*` tag exists | a tag is one `git push --delete` from gone, and a deleted tag makes a released repo look unreleased. |
| the registry 404s | needs a network call this gate does not otherwise make. **Measured refutation: `@cosyte/fhir` is 404 on npm and has real version bumps with derivable notes**, so this test would have exempted it. |
| `findVersionCommit` hit the first commit | what the old error already reported, and too narrow: false whenever `package.json` arrived in the second commit, where the same repo instead refused with "consumed no changesets". One deadlock, two error messages. |

**It cannot be wrong in the dangerous direction, and that does not rest on the test being accurate.**
A `never-versioned` verdict grants nothing: it sets `is-release=false`, which is precisely what
*withholds* the publish command from `changesets/action`. The worst a false positive can do is
decline to publish. There is no path from this verdict to npm, and the gate is never *passed* here,
only deferred.

**The first release still goes through the gate whole.** The run that classifies `never-versioned`
is the run that opens the Version PR; merging it produces a version commit with a real previous
version and real consumed changesets, and *that* run derives notes and is checked in full. Nothing
is skipped, it is deferred by one commit, to the commit that has something to say. A package that
has been versioned does not re-enter this state without a history rewrite, and if it ever did the
verdict would still withhold the publish command rather than hand it over.

**A shallow checkout is not read as never-versioned.** Its oldest commit has no parent and reads as
a root commit, so the question is unanswerable rather than answered `false`; `hasPriorVersion`
returns `null` and the run goes red pointing at `fetch-depth: 0`. Answering `false` there would turn
a misconfigured checkout into a green run that published nothing.

### Auditing the releases that predate the gate

The gate above stops a new truncation. It does nothing about the ones already published, and those
bodies are permanent. [`scripts/release-diff.mjs`](scripts/release-diff.mjs) is what says how many
there are: for one published release it diffs **the body live on the release page** against **the
changesets the tagged version commit consumed**, and classifies every bullet.

```bash
node scripts/release-diff.mjs sweep --repo ../hl7 --package @cosyte/hl7
node scripts/release-diff.mjs classify --repo ../ccda --package @cosyte/ccda --tag v0.0.2 --json
```

| Verdict | Means |
|---|---|
| `untouched` | the bullet is the changeset's own words, unchanged |
| `deliberately-short` | the same, and short because the author wrote it short |
| `identifier-removed` | it differs only by spans the translator removes on purpose. **Not a truncation** |
| `truncated` | the author's sentence carries on past the bullet, in prose no rule explains |
| `rewritten` | the bullet says something the changeset does not, so it was edited by hand |
| `unmatched` | no consumed changeset aligns with the bullet |

**Telling `identifier-removed` from `truncated` is the entire job.** A bullet with its trailing
`(CCDA-P7)` removed *is* a proper prefix of its changeset sentence while being a complete sentence,
so a prefix comparison calls it cut; that is why one earlier count read 25. A cut that landed on a
clean word boundary is well-formed prose, so a scan over the bytes alone cannot see it at all; that
is why another read 6. The differ asks what the missing text *is*, using
`release-notes.mjs`'s own `TRANSLATION_RULES`, rather than how much of it there is.

**Measured 2026-07-28, across all 17 published releases of the 8 published packages, 149 bullets:
9 are genuinely truncated, in 6 releases across 5 packages.**

| Package | Release | Cut bullets |
|---|---|---|
| `@cosyte/hl7` | `v0.0.1` | 1 |
| `@cosyte/mllp` | `v0.0.1` | 3 |
| `@cosyte/x12` | `v0.0.1` | 1 |
| `@cosyte/ccda` | `v0.0.1` | 1 |
| `@cosyte/ccda` | `v0.0.2` | 2 |
| `@cosyte/astm` | `v0.0.1` | 1 |

The other 140: 117 `identifier-removed`, 15 `untouched`, 6 `rewritten`, 2 `deliberately-short`, none
unmatched. The 6 `rewritten` are exactly the 6 bodies corrected by hand on 2026-07-28, which is a
useful check on the method: it recovers a known set it was not told about.

**What it can still miss**, stated because a count is only worth what its limits are. A `rewritten`
bullet is not graded for truncation: once a person has edited the page there is no derivation left
to compare against, and guessing would be worse than declining. A bullet that ends on a sentence end
is read as complete even when the changeset carries on: a cut that landed exactly on a full stop is
invisible, and no rule can separate it from an author who stopped there. Words missing from the **middle** of a
bullet are checked the same way as the tail but never make it a truncation, since nothing came off
the end; unaccounted interior spans are printed under their own heading (there are none across the
149). And the pairing is by content, so a body whose bullets share most of their wording could in
principle pair one against the wrong changeset; none did here, and `--json` prints the pairing.

**It is a classifier, not a regenerator, and that limit is the finding underneath it.** Running
`release-notes.mjs prepare` against the historical version commits **refuses on six of them**, because
their source changesets' opening sentences are themselves over the 200-character cap, which is
exactly why they were cut. These bodies cannot be regenerated mechanically: each needs a person to
write a shorter sentence that keeps the meaning. So the tool quotes the missing tail and stops, and
there is no command that emits a replacement body. `sweep` exits 1 when anything is cut, which makes
it a check you can run; **nothing in this repo's workflows runs it**, on purpose, because a red build
over a permanent published page is a nag, not a gate.

### CHANGELOG promotion (specified, not implemented)

Every caller's `CHANGELOG.md` currently has zero versioned sections: all content lives forever under
`## [Unreleased]`, so nothing has ever been attributed to a version. Fixing that means editing the
8 caller repos, so it is deliberately out of scope here, and **the release body does not depend on
it**: the notes come from the changesets, which are what actually drove the release.

For each of `hl7`, `mllp`, `dicom`, `x12`, `ccda`, `ncpdp`, `astm`, `fhir`, extend the `version`
script in `package.json`, which today reads:

```
"version": "changeset version && node scripts/sync-version.mjs && prettier --write package.json src/index.ts"
```

Insert a promotion step after `changeset version` (which has already written the new version into
`package.json`) and before `prettier`. It should rename `## [Unreleased]` to
`## [<new version>] - <YYYY-MM-DD>`, insert a fresh empty `## [Unreleased]` above it, and leave the
file untouched when `[Unreleased]` holds no entries. Because it runs inside `changeset version`, the
result lands in the "Version Packages" PR, where it is reviewable and shows what the release will
contain before anyone approves the publish. That is the point: nothing currently surfaces what a
release will contain.

Doing it in the release job instead would mean pushing to `main` from CI after the publish, which is
strictly worse: unreviewable, and it races the branch it is pushing to.

See the meta-repo `documentation/conventions.md` for the engineering standard these enforce.
