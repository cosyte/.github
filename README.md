# cosyte/.github

Org-wide reusable GitHub Actions workflows for the `@cosyte/*` suite. Each repo's own workflow is a
thin caller, so the pipeline is defined once here. All actions are pinned to commit SHAs.

> This repository is **public**, and must stay that way: a public repository cannot call a reusable
> workflow from a private one.

Longer sections are in their own file under [`documentation/`](documentation/), linked from the
heading they belong to.

## Reusable workflows

See [documentation/reusable-workflows.md](documentation/reusable-workflows.md).

## Calling them

**Name a published reference, not `@main`.** `@main` is a branch, and a branch delivers every later
change to your pipeline on **this** repository's clock rather than yours: the next merge here changes
your CI and your release, reviewed by nobody in your repository. A published reference names one
commit and never names another, so nothing reaches you until you edit your own `uses:` line.

Pick the newest from <https://github.com/cosyte/.github/releases> and paste it in place of the
placeholder below. Each release's notes say what a caller adopting it has to act on. See
"[The published reference](#the-published-reference-and-what-main-costs-a-caller)" for how they are
produced and what they do not promise.

```yaml
# <parser>/.github/workflows/ci.yml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  ci:
    # Copy a real one from the releases page; this placeholder resolves to nothing.
    uses: cosyte/.github/.github/workflows/ci.yml@workflows-YYYY-MM-DD-COMMIT
    with:
      run-phi-scan: true # parsers that handle PHI / raw bytes
      check-docs-content: true # repos that publish docs-content/; see below
```

```yaml
# <parser>/.github/workflows/release.yml
name: Release
on:
  push: { branches: [main] }
jobs:
  release:
    # Copy a real one from the releases page; this placeholder resolves to nothing.
    uses: cosyte/.github/.github/workflows/release.yml@workflows-YYYY-MM-DD-COMMIT
    with:
      package-name: "@cosyte/hl7"
    secrets: inherit # NPM_TOKEN + RELEASE_PR_TOKEN + DOCS_REPO_DISPATCH_TOKEN
    permissions: # actions: read is a PREREQUISITE, see below
      actions: read
      contents: write
      id-token: write
      pull-requests: write
```

GitHub allows three kinds of ref here: "the `{ref}` can be a SHA, a release tag, or a branch name",
and "Using the commit SHA is the safest option for stability and security"
([reusing workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)).
A published reference is the release-tag form. A SHA is safer still and is always available, at the
cost of a name nobody can read; either one is a reference that does not move, which is the property
that matters.

## The published reference, and what `@main` costs a caller

Thirteen repositories call these workflows, and until each one moves its own `uses:` line, every push
to `main` here changes thirteen pipelines that nobody in those repositories reviewed. This repository
cannot move them: GitHub's "Require actions to be pinned to a full-length commit SHA" policy says in
the same breath that "Reusable workflows can still be referenced by tag", so the one switch that
would force it exempts exactly what this repository publishes. What this repository can do is offer
something to move to, and that is what
[`.github/workflows/publish-reference.yml`](.github/workflows/publish-reference.yml) and
[`scripts/reference-publish.mjs`](scripts/reference-publish.mjs) do, proved by
[`test/reference-publish.test.mjs`](test/reference-publish.test.mjs).

**One reference per default-branch state, named after the commit it carries.** On a push to `main`,
the script compares this commit against the most recently published reference and publishes
`workflows-YYYY-MM-DD-<first 12 of the commit>` when anything a caller resolves has moved. That name
is a pure function of the commit, so there is no such thing as the same name at a different commit,
and there is deliberately **no `v1`-style major alias**: a moved reference is worse than a branch
because it looks immutable. The release body is the note, and it says what a caller adopting this
reference has to act on.

**What "a change a caller must act on" means, exactly.** For any of the six reusables: a
`workflow_call` input added without a default or made required, an input removed, a default changed,
any change to the set of `secrets`, any change to the permissions the caller must grant (at the
workflow level or on any job), or any job added, removed or renamed, because a job id is the
check-run context a caller's ruleset may require. Everything else is reported in a second list and
demanded of nobody: an input added **with** a default breaks no caller, which is how
`check-docs-content` reached thirteen repositories without touching one of them.

**What moves the reference is wider than what the note demands.** The state a caller resolves is the
six workflow files **plus everything under `scripts/`**, because `ci.yml` fetches
`docs-content-check.mjs` and `prepublish-check.mjs` at `job.workflow_sha` and `release.yml`
runs five more: a caller pinned to a reference runs those scripts as of that commit. So a script fix
mints a reference (otherwise no caller could ever adopt it) whose note truthfully says there is
nothing to act on. A README edit or a test change mints nothing.

### It refuses rather than publishing something it cannot stand behind

See [documentation/published-reference-refusals.md](documentation/published-reference-refusals.md).

### The platform's half, which is a human's click

Enabling **Settings, "Releases", `Enable release immutability`** on this repository makes GitHub
enforce what the script already refuses to do: "Once an immutable release is published, its
associated Git tag is locked to a specific commit, cannot be changed, and cannot be deleted while the
release exists"
([immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)).
Note that "immutability will only apply to future releases"
([preventing changes to your releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/preventing-changes-to-your-releases)),
so it is worth turning on before the reference stream is long rather than after.

**Nothing here depends on that setting.** That a reusable-workflow reference AT such a tag is
therefore immutable is a composition of two documented facts rather than a documented guarantee, and
it is written down as one. The safety property is enforced in this repository's own code, by the
refusals above, and holds whether or not the setting is on. A green run does not mean it is on: the
only way to know is to look at the setting.

### What this does not do

It does not move a single caller. Thirteen `uses:` lines live in thirteen other repositories, and
this repository has no way to edit them and no policy that can force them. Until each one moves, the
`@main` fan-out is exactly what it was, and this is an offer rather than an enforcement.

## The docs-content gate

See [documentation/docs-content-gate.md](documentation/docs-content-gate.md).

## The release environment gate

See [documentation/release-environment-gate.md](documentation/release-environment-gate.md).

## What a skipped required context does to a merge

**Settled 2026-08-07 against a primary source and a live run, in `#46`, because it had been guessed
at twice in opposite directions and one of the guesses was shipped as prose in this file.**

**The answer: a job skipped by a conditional SATISFIES its required context. It does not block a
merge.** So putting a required job behind a job-level `if:` does not strand a pull request. It
**silently un-requires the gate**, leaving the ruleset still naming a context that now proves
nothing. That is the false-green direction, and it is quiet. The loud direction, a pull request
stranded forever, has a different cause and is a different row of the same table: a context that is
**never reported at all**.

**Three routes reach that false green, and this section is the only place any of them is written
down here.** A required context is skipped by a **job-level** condition, or its work is skipped by a
**step-level** condition, or the job is skipped **because a job it depends on failed**. The first
two are settled below against the live run; the third is "The third route: a job skipped because a
job it depends on failed", further down, and it is the one this repository now refuses to build.

### The primary source

GitHub, *Troubleshooting required status checks*,
<https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks>.
Under "Required check needs to succeed against the latest commit SHA", verbatim:

> Successful check statuses are `success`, `skipped`, and `neutral`.

And under "Handling skipped but required checks", all three rows of that table, verbatim:

| Cause | Result | How to fix or check |
| --- | --- | --- |
| A workflow is skipped by path filtering, branch filtering, or a commit message | Associated checks stay in a "Pending" state and block merging | Avoid requiring workflows that can be skipped. |
| A job is skipped by a conditional | The job reports "Success" | ... |
| A job depends on a failed job | The dependent job is skipped and may not block merging | Use `always()` with `needs` for required checks that depend on other jobs. |

### The live run

See [documentation/skipped-required-context-live-run.md](documentation/skipped-required-context-live-run.md).

### Which shape `ci.yml` produces, and what that means for a caller

`ci.yml`'s `actionlint` job carries `if: ${{ inputs.run-actionlint }}`. That is a **job-level**
condition inside a `workflow_call` workflow, which is row one above, measured on the identical **job**
shape rather than reasoned across from row two. The context is still emitted, still named
`<caller job id> / <inner job id>` the way `ci / actionlint` is, and still satisfies.

**One axis of row one was not varied, stated rather than glossed:** the probe called its reusable
workflow **locally** (`uses: ./.github/workflows/probe-reusable.yml`) while every real caller calls it
**remotely** (`cosyte/.github/.github/workflows/ci.yml@main`). Nothing in the finding rests on that
axis, and row two reaches the same conclusion through a plain job with no reusable workflow at all,
so the word to use is "the identical job shape" and not "identical".

**So a caller setting `run-actionlint: false` does not strand its pull requests. It removes the gate
while its ruleset still lists the context, and nothing anywhere says so.** A maintainer reading a
green merge button gets no signal that a required check stopped checking.

**A required job gates all of its steps, and that cuts the same way, only more quietly.** Moving a
gate into a step behind an `if:` un-requires it exactly as completely, and the context then reports
`success` rather than `skipped`, so it is invisible to anyone auditing conclusions. The rule that
follows from the whole table is one sentence: **a context that does not do its work on every pull
request cannot gate every pull request**, whether the skip is at the job level or the step level.

### The third route: a job skipped because a job it depends on failed

**The two routes above are reached by a condition somebody wrote. This one is reached by a
dependency, and nothing in this repository produced it when the rest of this section was settled.**
A job that declares `needs:` on another job does not run when that job fails. The consequence, in
the primary source's own words, is that **the dependent job is skipped and may not block merging**:
the conclusion is `skipped`, `skipped` is a successful check status, and so a required context is
satisfied by a job that never ran. That is the same false green as the conditional route, reached
without anyone writing a condition at all, and it arrives at exactly the moment the pipeline was
supposed to be loudest, on a pull request where something already failed.

**The remedy is the source's own, and this repository takes it as a rule.** A required job in a
reusable workflow published here that depends on another job carries a condition that runs it
regardless of that dependency's outcome. GitHub states it as "Use `always()` with `needs` for
required checks that depend on other jobs", so `if: ${{ always() }}` on the dependent job is the
shape to write. The job then runs, reaches a real conclusion against whatever the dependency left
behind, and the context reports something rather than being satisfied by a skip.

**It is enforced, not only written.** `test/skipped-required-context.test.mjs` holds the rule over
every workflow carrying a `workflow_call` trigger, and names the file and the job id when one
appears without the condition. That check also refuses an examination that found no reusable
workflow at all, and refuses a workflow file it cannot read or that declares no `on:` block, because
either of those measures nothing while reporting the rest of the tree clean.

**One job here declares `needs:`, and the remedy is forbidden on it rather than merely unnecessary.**
`release.yml`'s `release` job depends on `version`, and it is the job that publishes to npm behind
the caller's `release` environment. `always()` there would do one of two things and neither is the
thing the source's remedy is for. Either the dependency's job outputs survive its failure, in which
case the publish runs on a commit whose release-environment gate, release-notes gate, changelog gate,
verification or publish-floor check has just failed, and **an npm publish is permanent**. Or they do
not, in which case the condition reading them is false, the job skips exactly as it does now, and the
only thing that changed is that the file **looks** compliant. So for a job that references a
deployment environment the rule asks for the opposite, in the same breath and by the same check: it
must **not** survive a failed dependency, and `always()` or `!cancelled()` on such a job is a
finding that nothing refused before. That is keyed on the `environment:` key and on nothing else, so
no job that is not making a deployment can reach it.

**The residual that leaves, stated rather than traded away.** When `version` fails, `release` still
concludes `skipped`, and a caller ruleset naming only `<caller job>/release` still counts that as a
pass. What answers it is that the failure is loud where a ruleset can see it: the run itself is red,
and `version` emits its own check-run context, which **fails**. `version` is therefore the context to
require for this workflow, as "Which job the environment holds" says above.

**Where this rule stops, which matters because the same word means the opposite one line over.** A
condition that survives a failed dependency belongs on a job that declares a dependency **and makes
no deployment**. On a check's OWN failure path it does the reverse: `always()`, `failure()` and
`!cancelled()` there turn a real failure into a green run, which is why `test/self-scan.test.mjs`
refuses all three anywhere on this repository's self-analysis path and
`test/org-defaults-coverage.test.mjs` refuses them on the org-defaults check's path. Both
prohibitions stand unchanged. The rule above permits such a condition on one thing only, a job that
declares `needs:` and holds no environment, and nothing here relaxes a gate that already exists.

### What deliberately does not follow here

See [documentation/skipped-required-context-what-does-not-follow.md](documentation/skipped-required-context-what-does-not-follow.md).

## Who authors the "Version Packages" PR

See [documentation/version-packages-pull-request.md](documentation/version-packages-pull-request.md).

## The two pre-publish layers

See [documentation/pre-publish-layers.md](documentation/pre-publish-layers.md).

## Staged publishing

See [documentation/staged-publishing.md](documentation/staged-publishing.md).

## The post-publish install gate

See [documentation/post-publish-install-gate.md](documentation/post-publish-install-gate.md).

## Release notes

See [documentation/release-notes.md](documentation/release-notes.md).

## The org defaults coverage check

See [documentation/org-defaults-coverage-check.md](documentation/org-defaults-coverage-check.md).

## What the account inherits, and the two things it cannot

**Two documents this account owes a newcomer cannot be delivered the way the other four are, and
until 2026-09-03 that was an assumption nobody had read the page for.** The measurement, taken
against a copy of
[Creating a default community health file](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)
fetched 2026-09-03:

| | |
|---|---|
| **the supported set, verbatim from its table** | *CODE_OF_CONDUCT.md*, *CONTRIBUTING.md*, discussion category forms, *FUNDING.yml*, issue and pull request templates with their *config.yml*, *SECURITY.md*, *SUPPORT.md* |
| **a governance file** | absent from that table. The string `governance` occurs zero times on the page |
| **a licence** | ruled out in the page's own words: "You cannot create a default license file. License files must be added to individual repositories so the file will be included when a project is cloned, packaged, or downloaded." |

**So the answer to "who decides, and how" travels in the contributing guide.**
[`CONTRIBUTING.md`](CONTRIBUTING.md) is served account-wide, and the governance answer is written
inline in it under "Who decides, and how", so a reader who only ever sees that one file still gets
it; [`GOVERNANCE.md`](GOVERNANCE.md) holds the long version for whoever follows the link. That long
version is reached by a link and is never served: it is not a supported type, so it appears in no
repository but this one. Putting the answer only in `GOVERNANCE.md` and linking to it would have
shipped the reach without the answer, which is the shape of the claim this section exists to refuse.

**And the licence is this repository's own.** [`LICENSE`](LICENSE) is MIT, copyright Cosyte, and it
covers `cosyte/.github` and nothing else. Every other `@cosyte/*` repository states its terms in its
own tree or states none; this file cannot supply them, and the contributing guide now says so rather
than leaving "the same terms as the repository you're contributing to" pointing at nothing.

**The limit, stated rather than papered over: a repository with its own `CONTRIBUTING.md` gets none
of this.** The override is per type, so its guide replaces this one whole and takes the inline
governance answer with it. Thirteen callers is not thirteen repositories covered, and the coverage
check above is the thing that measures which are, per type, rather than assuming.

**Every pointer in a defaulted file here is a full URL, not a relative path.** A rendered default is
read from a page belonging to the repository it renders in, and the source documents no resolution
for a relative link in that position, in either direction. An absolute URL is correct under both
readings and a relative one is correct under at most one, so the defaulted files carry absolute
URLs and [`test/governance-surface.test.mjs`](test/governance-surface.test.mjs) fails the run on a
relative link in any of them, the defaulted issue templates and their `config.yml` included, where
the pointer is a `url:` field rather than a link.

**That test also holds the rest of this section, and a negation counts where it attaches.** It reads
every tracked markdown document and fails naming the one that asserts account-wide reach for a
governance file or for the licence, and it fails if `LICENSE` and the contributing guide's
`## Licensing` section stop agreeing. The assertion it hunts is ordinarily written with a negative
in it, because the mechanism it borrows is "a repository with no file of its own gets this
account's", so a check that skipped every sentence carrying `no` would skip the ordinary spellings
of the claim along with it: that is a green run over prose nothing read. A denial therefore has to
sit beside the assertion, inside the same clause, to cover it. Correct prose that puts one a few
words the wrong side of that line reads as a claim and reds this repository's own run, which is the
cheap direction to be wrong in: one edit here, against a promise nobody out there can see is false.

## The em-dash gate

See [documentation/em-dash-gate.md](documentation/em-dash-gate.md).
