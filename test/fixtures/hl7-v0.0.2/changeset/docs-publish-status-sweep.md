---
"@cosyte/hl7": patch
---

Correct stale publish-status language in the docs site (README-ORG-SWEEP).

`@cosyte/hl7` is published on npm at `0.0.1` and public, but two `docs-content/*.md` pages still said otherwise:

- `docs-content/installation.md`: the Status blockquote said "not yet published to npm… the shape it will take at first publish; until then, consume it from source or a workspace link." Rewritten to state the package is published on npm at `0.0.1` and public, still pre-alpha on the `0.0.x`-until-first-alpha ladder, and that the `npm install @cosyte/hl7` command is live rather than aspirational.
- `docs-content/troubleshooting.md`: "Pre-alpha (`0.0.x`), unpublished" now reads "Pre-alpha (`0.0.x`), published on npm at `0.0.1`."

Docs-site content only (renders on docs.cosyte.com; not in the published tarball). No runtime or public-API change.
