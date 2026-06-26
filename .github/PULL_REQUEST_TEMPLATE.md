<!-- Keep it short. The "why" matters more than the "what". -->

## What & why

<!-- What does this change, and why? Link the issue if there is one. -->

## Checklist

- [ ] The full pipeline passes locally (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`).
- [ ] Tests cover the change.
- [ ] Added a `## [Unreleased]` entry to the package's `CHANGELOG.md` (and a Changeset if the repo uses them).
- [ ] **No PHI anywhere in the diff** — fixtures, examples, and tests use synthetic data only.
- [ ] Public API changes are documented (JSDoc + any affected docs content).
- [ ] One logical change per PR.
