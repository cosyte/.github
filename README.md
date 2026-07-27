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
    secrets: inherit # NPM_TOKEN + DOCS_REPO_DISPATCH_TOKEN
```

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
| Wrong release | a body that disagrees with the version or package that reached npm |

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
  `(thirteenth slice): builder emits X` is worse than the original. The head is repaired afterwards,
  and so is the tail: removing an identifier from the *end* strips the words that introduced it, so
  `..., not a phase log.` would otherwise ship as `..., not a.`
- **Case sensitivity.** `FHIR-bridge` and `docs-content/` are legitimate content that a
  case-insensitive rule would flag.

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
- **A failure after the publish step leaves the package on npm with no GitHub release.** That is the
  intended trade: a loud red beats a silent green carrying a meaningless release. Recovery is to
  create the release by hand, since re-running finds nothing left to publish.

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
