# Contributing to cosyte

Thanks for considering a contribution. The `@cosyte/*` packages — the HL7, MLLP,
DICOM, X12, C-CDA, and NCPDP parsers — get better when real integration teams
surface the vendor quirks they hit in production. A bug report with a reproducing
fixture is one of the most valuable things you can send us.

This is the org-wide guide. Some repos add their own `CONTRIBUTING.md` with
package-specific detail (for example, `@cosyte/hl7` documents how to add a
vendor-quirk fixture and author a profile). When a repo has its own, that one
wins.

## Before you start

- **Use synthetic data only — never real PHI.** Swap names, MRNs, and dates for
  fabricated values in every issue, fixture, and example. This is the one rule we
  don't bend.
- Search existing issues first — your quirk may already be logged.
- For anything larger than a small fix, open an issue to discuss it before you
  build. It saves everyone a round-trip.

## Filing an issue

Reduce the problem to the smallest input that reproduces it, and include the
package version, the exact call, and the error or warning code you saw. The issue
forms will walk you through it.

## Opening a pull request

1. Fork and branch from `main`.
2. Run the full pipeline locally before pushing — every `@cosyte/*` package uses
   the same toolchain:

   ```bash
   pnpm install
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   ```

   All of them must exit zero. CI runs the same checks on Node 22 and 24.
3. Add a bullet under `## [Unreleased]` in the package's `CHANGELOG.md`, plus a
   Changeset if the repo uses them.
4. Keep PRs focused — one logical change each. Large refactors start as an issue.
5. Write a clear commit message. Imperative mood (`fix(parser): …`) is encouraged,
   not enforced.

## The toolchain, briefly

Every package is TypeScript, built with `tsup` (dual ESM + CJS), tested with
Vitest, linted with ESLint, and formatted with Prettier — all inherited from the
shared `@cosyte/*` config packages, not copied per repo. Most parsers ship with
**zero runtime dependencies**, and we keep it that way unless there's a strong
reason not to.

## Licensing

The parsers are MIT-licensed. By contributing, you agree your contribution is
licensed under the same terms as the repository you're contributing to.

---

Questions, or want to talk through an integration? Open an issue, or see
[cosyte.com](https://cosyte.com).
