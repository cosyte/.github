<!-- Keep it short. The "why" matters more than the "what". -->

## What & why

<!-- What does this change, and why? Link the issue if there is one. -->

## Checklist

- [ ] The full pipeline passes locally (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`).
- [ ] Tests cover the change.
- [ ] The change is recorded the way **this** repo records changes. Look for
      `.changeset/config.json`; its absence is an answer too:
  - **no `.changeset/` directory**: there is no changeset to add. Add a `## [Unreleased]` entry to
    `CHANGELOG.md` if the repo has one; if it has neither, there is nothing to record here. Take this
    arm when you cannot find `.changeset/config.json`.
  - **`"changelog": false`**: add a `## [Unreleased]` entry **and** a changeset.
  - **anything else**: the Changesets generator is on, so **your changeset summary is the changelog
    entry**. Add the changeset and do **not** hand-edit `CHANGELOG.md`: the release writes that file,
    and a hand-written `## [Unreleased]` section there would sit below every future release forever.
- [ ] **No PHI anywhere in the diff**: fixtures, examples, and tests use synthetic data only.
- [ ] Public API changes are documented (JSDoc + any affected docs content).
- [ ] One logical change per PR.
