## The release environment gate

**Nothing reaches npm from a `@cosyte/*` repository without a human who could have stopped it, and
this is where that stops being a claim.** `release.yml` puts its **publishing** job in
`environment: release`, and until 2026-08-23 a comment above that key asserted every caller had
configured that environment with a required reviewer and a main-only deployment branch policy.
**Nothing read a caller's actual configuration.**

### Which job the environment holds, and why it is not all of them

**Until 2026-08-25 this workflow was one job, and that one job did two unrelated things**: it either
opened or refreshed the "Version Packages" pull request, or it published to npm. A GitHub
environment attaches to a **job**, never to a step, so putting one on that job asked a human to
approve **every merge to a caller's default branch**, including the overwhelming majority that would
never touch a registry.

**The measured result was not extra safety. It was that nothing released at all**: the approval
request that would have *opened* a Version PR was itself unapproved, so the queue of unshipped
changesets grew while every approval anyone was asked for bought nothing. GitHub also fails a job
that is not approved within 30 days, so those requests did not merely wait, they expired.

So the job is split on the one line that matters, which is **reversibility**:

| job | environment | what it does | what it is handed |
|---|---|---|---|
| `version` | **none** | the protection gate, the caller checkout, `Verify`, the release-notes derivation, the changelog gate, and `changesets/action` with **no publish command at all** | `RELEASE_PR_TOKEN` (or its `GITHUB_TOKEN` fallback) |
| `release` | **`release`** | `needs: version`, `if:` the version job's `is-release` output. The publish-path floor gate, the npm publish (staged or direct), the GitHub release, the docs dispatch, the post-publish install gate | the same PR token, **plus `NPM_TOKEN`** |

**Merging the Version PR is the release decision; the environment approval is that same decision
confirmed on the runner about to make it permanent.** One approval per release, on the irreversible
half, instead of one per merge on both halves. Nothing is skipped and no approval is traded away.

**The job id `release` is load-bearing and did not change.** A caller's check context for a reusable
workflow is `<caller job id> / <called job id>`, so every caller's required-check configuration names
`release`. Renaming the publishing job would leave those contexts reporting nothing at all, which is
the failure mode that leaves a pull request **pending and unmergeable by anyone** (see "What a
skipped required context does to a merge", below). On a run that only opens a Version PR the
`release` job is skipped by its job-level `if:`, which the same measurement shows concludes `skipped`
and **satisfies** a required context.

**A refused gate lands on `version`, not on `release`.** The gate refuses by failing a step of
`version`; the **run** concludes failure, and `release` never starts because it `needs: version`, so
the `release` context concludes `skipped` on that run too. The refusal itself is not softened by
this: the run fails, no Version PR is opened and the registry is never reached. What changed with the
split is only which context carries it. Before the split there was one job and one context, so the
question could not arise; after it, `version` is the context that runs on **every** path and the one
a refusal shows up on, and it is therefore the context to require if a caller requires one for this
workflow.

**The gate does not move into the publish job**, and that is the whole reason the split is safe. It
stays in `version`, unconditional, so it runs on every path this workflow has. A gate that only ran
on the publish arm would stop proving anything on the arm that runs every day, and it would stop
**silently**: a job or step skipped by a conditional concludes `skipped`, which a required context
counts as success. The gate needs `actions: read` and an API call, not membership of the environment
it reads; the **publish** is the thing that has to be inside it.

**The release notes cross the job boundary rather than being re-derived.** `$RUNNER_TEMP` is
per-job, and re-deriving after the publish is impossible in principle: `changeset publish` creates
the `v<version>` tag locally, and "is a release pending" is answered by whether that tag exists, so a
second derivation always finds nothing. The `version` job therefore derives the body **once**,
base64-encodes it into a job output, and the `release` job decodes it back to the same path before
the two `assert` calls that bracket the publish. Base64 rather than a multi-line output because the
body is human-written markdown and the transport must not be able to eat a trailing newline or be
terminated early by a line of the body itself.

**The publish-path floor gate stays in `release`, which is the opposite answer to the protection
gate's and for the opposite reason.** `publish-floor.mjs` asks which tool will perform *this*
caller's publish, whether that tool clears the floor its staging mode needs, and whether the package
exists on the registry at all; three step conditions in `release` read its answer as
`steps.publish-floor.outputs.mode`. A step output does not cross a job boundary, and the tool it
measures is the one on the runner that publishes, so the step belongs in the job that publishes,
ahead of that job's `pnpm install` and `Verify` ladder. It carries no `if:` of its own: the
predicate it used to run on, `is-release`, is now this job's own condition, so a step condition
would be a tautology in front of the step that decides the publish arm. The protection gate goes the
other way because what it proves has to be proved on **every** path, including the ones that never
reach `release`.

**One caller-side residual, and it is the only one this split creates: `RELEASE_PR_TOKEN` must not
be an environment secret.** An environment secret is scoped to jobs that reference that environment.
Before the split the single job referenced `release`, so a `RELEASE_PR_TOKEN` stored there resolved;
the Version PR is now opened from `version`, which references no environment on purpose, so a token
stored that way reads **empty** in the job that needs it and this workflow falls back to
`GITHUB_TOKEN`, which is the zero-checks trap described under "Who authors the 'Version Packages'
PR" below. It degrades rather than breaking, and it announces itself: the "Version PR will land with
zero checks" warning fires exactly as it would for a caller that never set the token, so the log is
the diagnosis. The fix is caller-side and takes no change to this file: **store `RELEASE_PR_TOKEN`
as a repository or organization secret**. `NPM_TOKEN` and `DOCS_REPO_DISPATCH_TOKEN` are unaffected
from either placement, because both are consumed in `release`, which does reference the environment.

The failure that hides in is quiet in the worst way: a `release` environment carrying **no protection
rules** produces a run that looks identical to a genuinely gated one. Same environment badge on the
job, same green steps, no approval prompt, and nothing anywhere saying there was never anything to
approve. Whether such an environment was created by a maintainer and left unprotected, or came into
being on first reference, is not a distinction any run can draw: the payload is the same either way.
So this pipeline does not draw it, and neither does the refusal.

`scripts/environment-gate.mjs` now runs as the **first thing the `version` job does**, on every run
of this workflow, and reads the calling repository's own environment configuration. It exits
non-zero, before any caller tree is on disk and long before anything is packed, unless that
environment carries **both**:

| rule | what passes | what refuses |
|---|---|---|
| at least one required reviewer | a `required_reviewers` protection rule with a non-empty reviewer list | the rule absent, its list empty, or no protection rules at all |
| a deployment branch policy limited to the default branch | a **custom** policy with exactly **one** branch pattern, equal to the literal `default_branch`, with no wildcard character | no policy (all branches), protected-branches-only, a wildcard that merely matches (`main*`), more than one pattern, or any tag pattern |

The refusal names the calling repository and the **specific** rule that is not there, never a generic
denial: a caller with a reviewer and no branch policy is told about the branch policy and not about
the reviewer it already has.

**Protected-branches-only is refused deliberately, not accepted as a near miss.** The set of protected
branches is caller state this workflow cannot enumerate or bound from the environment payload, and
GitHub's own documentation is explicit that "if no branch protection rules are defined for any branch
in the repository, then all branches can deploy". Accepting it would be accepting an unproven claim,
which is the exact failure this gate closes.

**Unreadable protection is not proof of protection.** A permission denial, a rate limit, a 5xx, a
transport fault, a body that does not parse, and a paginated list that cannot be walked to the end all
**fail the run**, naming the repository and the reason. None of them is reported as an unprotected or
absent environment: a permission error that sends a maintainer to inspect a correctly configured
environment has cost them the actual diagnosis.

**The behaviour does not depend on the caller's visibility.** Required reviewers on a private
repository need an Enterprise plan, this org is on Enterprise, and so the rule, the outcome and the
refusal wording are identical for a public and a private caller. There is no exemption clause and no
second wording, and `test/environment-gate.test.mjs` proves it by flipping one caller between the two
and comparing the bytes.

### The caller-side grant, and it is a prerequisite

The gate reads with the automatic `GITHUB_TOKEN`. A reusable workflow's `github` context is always the
caller's and that token's permissions are limited to the repository containing the workflow, so this
is a repository reading **its own** environments, not a cross-repository read. The permission it needs
is **`actions: read`**, which is what `release.yml` declares.

> **Grant `actions: read` in each caller's calling job BEFORE adopting a version of `release.yml` that
> requests it.** "The `GITHUB_TOKEN` permissions passed from the caller workflow can be only
> downgraded (not elevated) by the called workflow." A calling job that pins a `permissions:` block
> without `actions` is granting `actions: none`, and a request for `actions: read` against that is an
> **elevation**: GitHub rejects the whole workflow at **startup**, before any job or step runs, for
> every caller in that state at once. The gate's own refusal for a token that lacks the grant is
> self-explaining and prints the exact block to add, but it can only print it in a run that started.
> The two failure modes are different and only one of them tells you what to do.

The declaration in `release.yml` is **additive**, and that word is load-bearing rather than
descriptive: "if you specify the access for any of these permissions, all of those that are not
specified are set to `none`", so a block whose only key was `actions: read` would not add a
permission, it would strip `contents` off the job and 403 the very next checkout, on a **fully
compliant** caller, with none of the fail-closed refusal above. The workflow-level block therefore
names all four keys, `contents` stays at `write` because the publish job creates tags and a GitHub
release, and `test/install-check.test.mjs` pins that set whole. It is what this file **requests** of
a caller, and it is unchanged by the split: no caller grants anything new.

**Each job then narrows it, and a job block replaces the workflow one rather than adding to it**, so
each names every key it needs. `version` is `contents: write` + `pull-requests: write` +
`actions: read`; `release` is those three plus `id-token: write`. **`id-token` is deliberately absent
from `version`**: it is npm provenance, provenance is a publish-time concern, and that job cannot
publish, so the token that signs a publish has no business existing on a runner nobody approved.
`test/environment-gate.test.mjs` pins **both** sets whole, in both directions.

The default branch itself is in **neither** environment payload, though four of the refusal wordings
name it. It comes from `GET /repos/{owner}/{repo}`, which sits under `Metadata: read`: not a
`permissions:` key at all, always granted, and therefore nothing a caller can withhold by accident.
`github.event.repository.default_branch` is the fallback, for an event whose payload carries no
`repository` object. An empty default branch is never **compared**: with both sources empty the run
fails as unreadable rather than refusing a compliant caller and blaming its branch policy for it.

### What it does not establish

- **That the reviewer is a second person.** It proves a reviewer is *required*. With one credential in
  this org there is no second-party review to have, and this does not pretend there is.
- **That a caller stays compliant.** It reads the configuration of the run in front of it. A rule
  removed after a passing run is caught by the next run and not before.
- **Anything about how the publish authenticates** once the gate is proven. That is a separate change.
