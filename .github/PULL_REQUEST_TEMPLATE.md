<!-- Keep it short. The "why" matters more than the "what". -->

## What & why

<!-- What does this change, and why? Link the issue if there is one. -->

## Checklist

- [ ] The full pipeline passes locally (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`).
- [ ] Tests cover the change.
- [ ] The change is recorded the way **this** repo records changes. Open `.changeset/config.json` and
      read its `"changelog"` key, which is the only thing that decides it:
  - `"changelog": false` — `CHANGELOG.md` is written by hand. Add a `## [Unreleased]` entry, plus a
    changeset if the repo has a `.changeset/` directory.
  - anything else — the Changesets generator is on, so **your changeset summary is the changelog
    entry**. Add the changeset and do **not** hand-edit `CHANGELOG.md`: the release writes that file,
    and a hand-written `## [Unreleased]` section there would sit above generated releases forever.
- [ ] **No PHI anywhere in the diff** — fixtures, examples, and tests use synthetic data only.
- [ ] Public API changes are documented (JSDoc + any affected docs content).
- [ ] One logical change per PR.
