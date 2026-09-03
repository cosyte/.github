# Contributing to cosyte

Thanks for considering a contribution. The `@cosyte/*` packages (the HL7, MLLP,
DICOM, X12, C-CDA, and NCPDP parsers) get better when real integration teams
surface the vendor quirks they hit in production. A bug report with a reproducing
fixture is one of the most valuable things you can send us.

This is the org-wide guide. Some repos add their own `CONTRIBUTING.md` with
package-specific detail (for example, `@cosyte/hl7` documents how to add a
vendor-quirk fixture and author a profile). When a repo has its own, that one
wins.

## Who decides, and how

The answer is here rather than behind a link, because this guide is the file you
are reading in whichever repo you arrived at, and a file that lives only in
`cosyte/.github` is not.

- **Who decides.** One maintainer holds the final call: `noah`, the account owner
  of record for `cosyte`. No committee, no vote, no tie to break.
- **How a decision is reached.** In the open, on the issue or pull request, in
  writing. Propose it as an issue (for anything larger than a small fix, before
  you build). The maintainer accepts it, declines it, or says what would change
  the answer, on that thread. A declined proposal gets a reason. Silence is not
  consent: an unanswered proposal has not been accepted.
- **How you escalate.** On the thread first, and in public. Say what you think is
  wrong and what you expected. If the thread has stalled, open an issue naming the
  stall and linking it. If you still disagree once a decision is given, say so on
  the issue and ask for the reason in writing; you are entitled to a reason, and
  the maintainer's call stands once it is given with one. Two things never use
  this route: a security vulnerability goes to the
  [security policy](https://github.com/cosyte/.github/security/policy), never a
  public issue, and conduct goes to the route in
  [CODE_OF_CONDUCT.md](https://github.com/cosyte/.github/blob/main/CODE_OF_CONDUCT.md).

The long version, including how those terms themselves change, is
[GOVERNANCE.md in `cosyte/.github`](https://github.com/cosyte/.github/blob/main/GOVERNANCE.md).
It is written as a full URL because this guide is served into repositories that
do not contain it, where a relative path would resolve somewhere else or nowhere.

**And the limit, in the same breath: a repo with its own `CONTRIBUTING.md` gets
none of the above.** Its guide replaces this one whole, and its governance answer
is that repo's to state. Nothing here claims to govern it.

## Before you start

- **Use synthetic data only, never real PHI.** Swap names, MRNs, and dates for
  fabricated values in every issue, fixture, and example. This is the one rule we
  don't bend.
- Search existing issues first: your quirk may already be logged.
- For anything larger than a small fix, open an issue to discuss it before you
  build. It saves everyone a round-trip.

## Filing an issue

Reduce the problem to the smallest input that reproduces it, and include the
package version, the exact call, and the error or warning code you saw. The issue
forms will walk you through it.

## Opening a pull request

1. Fork and branch from `main`.
2. Run the full pipeline locally before pushing: every `@cosyte/*` package uses
   the same toolchain:

   ```bash
   pnpm install
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   ```

   All of them must exit zero. CI runs the same checks on Node 22 and 24.
3. Record the change. **How you do that differs by repo, and the repo tells you which
   kind it is**. See [Recording your change](#recording-your-change) below.
4. Keep PRs focused: one logical change each. Large refactors start as an issue.
5. Write a clear commit message. Imperative mood (`fix(parser): …`) is encouraged,
   not enforced.

## Recording your change

Every `@cosyte/*` package has a `CHANGELOG.md`, and it ships **inside the published
tarball**, so what goes in it is part of the package. But the two kinds of repo want
opposite things from you, and doing the wrong one is not harmless, so check which
kind you are in before you write anything.

**The check is one file, and its absence is an answer too.** Look for
`.changeset/config.json`. Nothing else decides this: not the repo's age, not what
`CHANGELOG.md` looks like today, not what a sibling package does.

**No `.changeset/` directory at all: there is no changeset to add.** If the repo has
a `CHANGELOG.md`, add a bullet under `## [Unreleased]` and you are done. **If it has
neither, there is nothing to record beyond the pull request itself**. Several repos
here publish nothing to npm and have deliberately never kept a changelog, and adding
one is a change in its own right, not part of your fix. This is the arm to take when
you cannot find `.changeset/config.json`.

**`.changeset/config.json` with `"changelog": false`: the changelog is written by
hand, and a changeset is needed as well.** Add the `## [Unreleased]` bullet *and* run
`pnpm changeset`. The changeset drives the version bump and the public release notes;
the `CHANGELOG.md` entry is separate and still yours to write.

**`.changeset/config.json` with anything else: the Changesets generator is on, and
your changeset summary *is* the changelog entry.** Add the changeset and leave
`CHANGELOG.md` alone. The release writes it: `changeset version` inserts a
`## <version>` section from the changesets it consumes. Hand-editing the file fights
that, and a hand-added `## [Unreleased]` heading is worse than untidy: generated
releases are prepended above it, so it would sit below every future release claiming
to be the unreleased one, permanently.

Repos move between these arrangements one at a time, so **re-read the file rather
than remembering the answer**. If you are unsure, say so in the pull request: adding
a `CHANGELOG.md` entry that was not wanted is trivially reverted, and losing one is
not.

### Writing a changeset

A changeset is a small markdown file in `.changeset/`; `pnpm changeset` will create
one for you. Two things about it are worth knowing before you write, because both are
enforced by the release pipeline rather than by review:

- **Its opening sentence becomes a bullet in the public GitHub release notes**, and
  that bullet is capped at 400 characters. The rest of the body can be as long as it
  needs to be. The pipeline **refuses** an over-length opening sentence rather than
  trimming it, because a mechanical cut publishes a fragment that reads like a whole
  sentence. Write the first sentence for a reader of the package, and put the detail
  in the paragraphs after it.
- **Do not start a line at the left margin with a `#` heading.** In a repo with the
  generator on, a changeset summary is indented into the generated release section by
  two spaces, so a heading at column 0 renders as a heading *inside* that section, and
  once published it is there for good. Use an inline code span instead.

## The toolchain, briefly

Every package is TypeScript, built with `tsup` (dual ESM + CJS), tested with
Vitest, linted with ESLint, and formatted with Prettier, all inherited from the
shared `@cosyte/*` config packages, not copied per repo. Most parsers ship with
**zero runtime dependencies**, and we keep it that way unless there's a strong
reason not to.

## Licensing

The parsers are MIT-licensed. By contributing, you agree your contribution is
licensed under the same terms as the repository you're contributing to.

**Those terms are a file, not a phrase, and they are per repository.** Read the
`LICENSE` file in the repo you are contributing to; that is the one your
contribution is licensed under. GitHub cannot serve a license from this account
the way it serves this guide, and the reason is in its own words: "You cannot
create a default license file. License files must be added to individual
repositories so the file will be included when a project is cloned, packaged, or
downloaded." So a repo with no `LICENSE` file has stated no terms, and neither
this guide nor any file in `cosyte/.github` supplies them for it. Say so on an
issue if you find one; it is a defect in that repo.

For `cosyte/.github` itself, the terms are the MIT License at
[LICENSE](https://github.com/cosyte/.github/blob/main/LICENSE), copyright Cosyte.

---

Questions, or want to talk through an integration? Open an issue, or see
[cosyte.com](https://cosyte.com).
