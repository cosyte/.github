# cosyte/.github

Org-wide reusable GitHub Actions workflows for the `@cosyte/*` suite. Each repo's own workflow is a
thin caller, so the pipeline is defined once here. All actions are pinned to commit SHAs.

> Currently **private** (the suite is pre-launch). It must become **public** at launch, because a
> public repository cannot call reusable workflows from a private one.

## Reusable workflows

| Workflow | Purpose | Used by |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | typecheck · lint(`--max-warnings=0`) · format:check · [PHI scan] · test · coverage (gating) · build · `attw` · dual ESM/CJS smoke · actionlint | every parser |
| [`release.yml`](.github/workflows/release.yml) | Changesets → npm publish **with provenance** → docs artifacts → GitHub release → `repository_dispatch` to `cosyte/docs` | every published parser |
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

See the meta-repo `documentation/conventions.md` for the engineering standard these enforce.
