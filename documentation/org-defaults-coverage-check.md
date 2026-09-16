## The org defaults coverage check

**The default issue templates promise a label, and until this check nothing had ever read one.**
This repository's `.github/ISSUE_TEMPLATE/bug_report.yml` sets `labels: ["bug"]` and
`feature_request.yml` sets `labels: ["enhancement"]`, and GitHub renders both into every repository
this account owns that has no issue templates of its own. GitHub's own requirement, verbatim from
[Creating a default community health file](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file):

> If an issue template sets a label, that label must be created in your `.github` repository and any
> repositories where the template will be used.

A repository that never created `bug` renders the form perfectly and files the issue **unlabelled**.
The run is green, the contributor sees nothing wrong, and nobody learns of it. Before this,
"the defaults cover every repository" was an assumption with no measurement behind it.

[`scripts/org-defaults-coverage.mjs`](../scripts/org-defaults-coverage.mjs) measures it,
[`.github/workflows/org-defaults-coverage.yml`](../.github/workflows/org-defaults-coverage.yml) runs it
weekly and on every pull request, and
[`test/org-defaults-coverage.test.mjs`](../test/org-defaults-coverage.test.mjs) proves it still bites.
Run it locally with `node scripts/org-defaults-coverage.mjs --repository cosyte/.github`; there is no
`pnpm` script because this repository has no `package.json`, which is also why the check is Node
builtins only.

### What it measures

| | |
|---|---|
| **the obligation** | the labels the tracked default issue templates declare, read off the files rather than restated |
| **the population** | every repository the run's owning account owns, listed to exhaustion, with the account's own repository count as the proof that the listing is all of it |
| **who owes what** | each repository classified `default-in-effect`, `overridden` or `unreadable`, and for each obligated one, whether it holds every declared label |
| **the report** | on the completed run's job summary: every repository with its state, every declared label, and per label every repository missing it |

**The override is per folder and all or nothing**, which is what makes the classification a single
read rather than per-file arithmetic: "if a repository defines valid issue templates or issue
template configuration in its own `.github/ISSUE_TEMPLATE` folder, none of the contents of the
default `.github/ISSUE_TEMPLATE` folder will be used." One file in that folder switches off every
default template and the default `config.yml` together, and a repository in that state owes no
label. Any other supported community-health file a repository defines suppresses the default **of
its own type**, which the report says and which changes no label obligation. A legacy
`ISSUE_TEMPLATE.md` is reported and does **not** waive the labels: the clause names the folder.

**Each type is looked for only where GitHub reads it from.** The documented order of precedence
(`.github`, then the root, then `docs`) is introduced as being "for supported files that can be
stored in more than one location", and three types cannot be: issue templates and their `config.yml`
must be in `.github/ISSUE_TEMPLATE`, discussion category forms in `.github/DISCUSSION_TEMPLATE`, and
`FUNDING.yml` in `.github`. So an `ISSUE_TEMPLATE` folder at a repository's **root** overrides
nothing, is not reported as overriding anything, and the default still renders there and the label is
still owed. The alternative would put one row saying `default-in-effect` beside another saying the
default is not in effect, and the only way to silence that red would be to create a label nothing
would ever apply.

**This repository is inside the population, not outside it.** The clause above names it first, so
`cosyte/.github` is classified `default-in-effect` like any repository the templates reach and is
required to hold `bug` and `enhancement` itself. Its own `ISSUE_TEMPLATE` folder is the defaults'
folder rather than an override of them.

**The account is derived from the run**, never written down in the source, so the same check under a
different owner measures that owner.

### It refuses rather than reporting a number it cannot stand behind

Partial coverage reported as full is the exact defect this closes, so every one of these **fails the
run** naming what could not be read, and none is ever reported as coverage:

- **a listing that cannot be shown to be the whole population.** Pagination not walked to the end, or
  the account's own record reporting more repositories than the listing returned. It names the
  shortfall and reports **no** coverage over the subset it did read.
- **an empty listing.** Full coverage over an empty population is a statement about nothing.
- **any read that did not answer**: permission denied, rate limited, any other non-success status, a
  transport fault, or a body that does not parse. The repository is classified neither covered nor
  overridden, and the refusal names the repository and the read.
- **a default template it cannot parse**, or one declaring labels in a form that is not a list of
  strings. This repository ships no YAML parser, so the reader recognises the shapes an issue form
  uses and refuses on anything else, naming the file. Reading an unparseable template as "declares no
  labels" would leave a real obligation unmeasured while the run went green. **If you add a shape it
  does not know, widen the reader and pin the new shape as a test; do not loosen it.**
- **a `labels` key spelled in a form the reader does not read**, quoted (`"labels":`), spaced
  (`labels :`), cased differently, or written as YAML's explicit key. The empty list is what the
  reader answers for a template that declares nothing, and "declares nothing" is the answer that
  turns into a green run over an unmeasured obligation, so it has to be earned rather than fallen
  into. CRLF and lone-CR line breaks and a byte order mark opening the file are **read**, not
  refused: YAML says those spell the same declaration.
- **a near miss.** A label differing from a declared one only by letter case or surrounding
  whitespace is reported as a near miss naming both spellings and does **not** satisfy the
  obligation.

**No declared label at all is reported as no obligation to measure**, and said in those words, rather
than as every repository being covered.

### What the credential can and cannot see

The check runs with the **workflow's automatic `GITHUB_TOKEN` and no other credential**. It adds no
secret, no third-party package and no write of any kind: every read is a GET, and the job grants
`contents: read` and `issues: read` and nothing else.

**That token's permissions are limited to the repository that contains the workflow**, so what it
enumerates of the account's *other* repositories is what any anonymous reader sees: the **public**
ones. `GET /orgs/{account}` returns `public_repos` to anyone and returns `owned_private_repos` only
to a credential the account shows it to. So when the account record carries no private count, the
population this check proves complete is the account's public repositories, and **the report says
exactly that** rather than leaving a reader to assume otherwise. A private repository this credential
cannot see is outside the measurement. Run the same check with a credential that can see them and the
private count appears, the listing is held to it, and a listing that falls short fails.

### What it does not prove

- **Not triage.** It proves each declared label **exists** where a default template can apply it. It
  proves nothing about whether the label is applied well, watched, or means anything to anyone.
- **Not that the label stays.** It reads the state in front of it. A label deleted after a passing
  run is caught by the next run and not before, which is why the schedule is the load-bearing trigger
  rather than a backstop for the pull-request one: the state being measured lives in other
  repositories and changes with no commit here.
- **Nothing about any caller's pipeline.** This check is a same-repository workflow and is
  deliberately not `on: workflow_call`. The thirteen repositories calling this repository's reusables
  at `@main` are untouched by it, and the test file asserts that no reusable workflow published here
  runs it.
