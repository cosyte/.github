# Governance

**Who decides in the `@cosyte/*` repositories, how a decision is reached, how you escalate one you
disagree with, and how these terms themselves change.** Those four questions are answered in full
below, and the short version of the first three is answered inline in
[CONTRIBUTING.md](https://github.com/cosyte/.github/blob/main/CONTRIBUTING.md), which is where most
readers will meet it.

Read ["What this document reaches"](#what-this-document-reaches-and-what-it-does-not) before you
assume this file governs the repository you arrived from. A governance file is not one of the
community-health types GitHub serves account-wide, so this file is not rendered into any repository
but its own, and only the contributing guide carries the answer everywhere.

## Who decides

**One maintainer holds the final call: `noah`, the account owner of record for `cosyte`.** There is
no committee, no vote, and no tie to break. That is stated plainly rather than left to be inferred,
because a contributor who cannot name the decider reads silence as a rejection, and an implied
committee is a decision route nobody can actually use.

Anyone may open an issue or a pull request. Nobody needs permission to propose a change, and nothing
here is a barrier to contributing: it describes what happens after you propose, not whether you may.

## How a decision is reached

**In the open, on the issue or pull request, and in writing.** A decision that exists only in
somebody's memory cannot be pointed at later, and the parsers in this suite carry clinical data, so
the reasoning behind a change to how they behave has to outlive the session that made it.

1. **A proposal is an issue or a pull request.** For anything larger than a small fix, open the issue
   first, as `CONTRIBUTING.md` asks. It saves a round trip, and it is where the decision gets made.
2. **The maintainer responds on the thread**, accepting it, declining it, or naming what would change
   the answer. A declined proposal gets a reason. "No" with no reason is a defect in this process,
   not an outcome of it.
3. **Where a rule already answers it, the rule is quoted rather than re-argued.** The standing rules
   live in the repository they bind: this repository's `README.md` holds the pipeline rules, each
   parser's own docs hold its parsing rules. A decision that contradicts a written rule changes the
   written rule in the same change, or it is not a decision.
4. **Silence is not consent.** An unanswered proposal has not been accepted. If a thread has gone
   quiet, say so on the thread; see escalation below.

Two things are settled and are not reopened per pull request, because both are safety rules rather
than preferences: **no real PHI in any issue, fixture, or example**, and **no change that weakens a
release gate in order to ship a release**. A proposal that needs one of those is a proposal to change
the rule, argued on its own issue, before the change that depends on it.

## How to escalate a disagreement

**Escalate on the thread first, and escalate in public.** The route builds on the one
`CONTRIBUTING.md` already sends you down rather than adding a second, private one beside it.

1. **Say so on the issue or pull request itself.** State what you think is wrong and what you expected
   instead. Most disagreements here are a missed constraint on one side or the other, and the thread
   is where that surfaces.
2. **If the thread has stalled, open an issue naming the stall.** Link the thread and say what
   decision you are waiting on. An issue is visible to everyone; a re-ping in a comment is visible to
   whoever already muted the thread.
3. **If you still disagree with the decision, say that on the issue and ask for the reason in
   writing.** You are entitled to a reason. You are not entitled to a different answer, and the
   maintainer's call stands once it is given with one.
4. **Two exceptions do not use this route at all.** A security vulnerability goes to
   [the security policy](https://github.com/cosyte/.github/security/policy), never to a public issue.
   Conduct goes to the route in
   [CODE_OF_CONDUCT.md](https://github.com/cosyte/.github/blob/main/CODE_OF_CONDUCT.md), which is
   enforced by the same maintainer and is not a technical decision to be argued on a thread.

## How this document changes

**By a pull request against this file, in this repository, like anything else here.** There is no
separate amendment procedure, because a procedure nobody has ever run is not a safeguard.

Two properties are load-bearing and a change to this file has to keep them, or the change is
incomplete rather than merely disagreed with:

- **The answer stays readable where the reader is.** The short version lives inline in
  `CONTRIBUTING.md`, because that is the file this account serves into repositories that have none of
  their own. Moving the answer out of there and into a link would restore exactly the gap this
  document was written to close.
- **The claim about reach stays true.** This file states what it does and does not reach, and that
  statement is checked by `test/governance-surface.test.mjs` rather than maintained by memory. If
  GitHub's supported set changes, change the test with the document, and cite the page.

## What this document reaches, and what it does not

**It reaches this repository. It is not served to any other one.** GitHub's
["Creating a default community health file"](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file),
read on 2026-09-03, lists the types an account can publish once and have appear everywhere:
*CODE_OF_CONDUCT.md*, *CONTRIBUTING.md*, discussion category forms, *FUNDING.yml*, issue and pull
request templates with their *config.yml*, *SECURITY.md*, and *SUPPORT.md*. A governance file is
absent from that list, and the word does not appear anywhere on the page.

So the reach of the answer is the contributing guide's reach, not this file's:

- **A repository owned by this account with no `CONTRIBUTING.md` of its own** gets this account's,
  and the governance answer inline in it. That is every repository the answer reaches.
- **A repository that has its own `CONTRIBUTING.md`** gets none of this. Its own guide wins, whole,
  and its governance answer is that repository's to state. This document does not claim it.
- **A link is a link.** A reader who follows one from a rendered default lands in
  `cosyte/.github`, which is why every pointer in a defaulted file here is written as a full URL
  rather than as a relative path.

The same page states, verbatim, "You cannot create a default license file. License files must be
added to individual repositories so the file will be included when a project is cloned, packaged, or
downloaded." This repository's [LICENSE](https://github.com/cosyte/.github/blob/main/LICENSE) is
therefore its own and covers this repository only. Every `@cosyte/*` package states its terms in its
own repository.
