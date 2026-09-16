## The docs-content gate

**`check-docs-content` is OFF by default, and no caller changes behaviour until it opts in by
name.** Every caller tracks `@main` and picks up an edit to this workflow on its next run, so a
default of `false` is the whole of what keeps a new gate from redding thirteen repositories on the
day it merges.

**The hole it closes.** A repo that publishes `docs-content/` can merge and release content that
breaks `docs.cosyte.com`, because nothing between the author and the published site resolves the
links in that content. `x12` did exactly that: its own pull request checks were green, because no
check had an opinion about `docs-content/` at all, and the `cosyte/docs` build was red for **eight
consecutive days** on a broken link `x12`'s docs-content introduced. With the input on, that link
reds the pull request that introduces it instead.

```yaml
jobs:
  ci:
    uses: cosyte/.github/.github/workflows/ci.yml@workflows-YYYY-MM-DD-COMMIT
    with:
      run-phi-scan: true
      check-docs-content: true # requires docs-content/sidebars.json
```

**Opting in REQUIRES `docs-content/sidebars.json`, by that exact name.** It is the only source of
document ids this gate has, so a tree without it fails (`B3`) rather than passing over a check it
could not run. That is a requirement of THIS GATE and not Docusaurus's default: `sidebars.js` and
`sidebars.ts` are JavaScript, and reading them means executing caller code, which this does not do.
**A repo shipping only `sidebars.ts` must not set the input.** `intro.md` is NOT required and its
absence is no finding at all: `release.yml` asserts nothing about docs-content filenames, and a repo
using Docusaurus's `index.md` convention builds fine.

**Where it runs, and why there.** Two steps inside the `verify` job, which is the only job in
`ci.yml` with no job-level `if:` and no `needs:`. Both halves of that matter and both are measured
rather than assumed: a new JOB would emit a new status check context, and this repository cannot
edit any caller's branch protection to require it, so a failure there would leave a caller's
required set green; and a job skipped by a conditional **satisfies** its required context (see
"What a skipped required context does to a merge" below), so hanging the gate off the input-guarded
`prepublish` or `actionlint` would report success having never run. The checker is fetched into
`$RUNNER_TEMP`, **outside `$GITHUB_WORKSPACE`**, at `job.workflow_sha`: `actions/checkout`
refuses a path outside the workspace, and a second tree inside it would be visible to `pnpm lint`,
`pnpm format:check` and `pnpm phi-scan`, whose scanner walks from the repository root. The gate
creates, modifies and deletes nothing anywhere under the caller's workspace.

### How the checker reaches a caller's runner, and what an unresolvable ref does

**It is fetched, not checked out, and the ref is `job.workflow_sha`.** One unauthenticated
`curl` of
`https://raw.githubusercontent.com/cosyte/.github/<ref>/scripts/docs-content-check.mjs` into
`$RUNNER_TEMP`, before `pnpm install`, needing no secret and no permission beyond the
`contents: read` this workflow already declares and this repository being public. `job.workflow_sha`
is **the commit SHA of the workflow file that defines the current job**, which inside a reusable
workflow is this file rather than the caller's, so the checker that runs is the one belonging to the
version of `ci.yml` the caller resolved. The `prepublish` job's tooling checkout of
`cosyte/.github` reads the same property, so both places a caller reaches this repository's code
resolve one way.

**This did not work for the first caller that opted in, and the failure was silent about why.**
The step shipped reading `github.job_workflow_sha`, which is not a property of the `github` context:
that context carries `workflow_sha` and `workflow_ref`, which describe the CALLER's workflow file,
and the identity of the file defining a called job lives on the `job` context. An unknown property
is not an expression error, it is the empty string, so the URL collapsed to
`.../cosyte/.github//scripts/docs-content-check.mjs` and the job died on
`curl: (22) The requested URL returned error: 404` **before the checker started**, on both matrix
legs and again on a re-run. Nothing about `docs-content/` was decided: not a pass, not a finding.
The same empty value in the `prepublish` checkout was invisible, because an empty `ref:` is not an
error for `actions/checkout`, it resolves the default branch.

**So the step now says which ref it used, every time, and refuses to be quiet about a bad
delivery.** The ref and the URL are printed before the fetch. If the expression is empty the step
prints `job.workflow_sha was empty, falling back to main` and proceeds on the provider's default
branch, which is what the `prepublish` checkout had been silently doing all along: substituting a
ref is allowed, substituting one without saying so is not. Every other way a delivery can fail (a
non-2xx status, a network error, a zero-length file, a file that is not the checker) **reds the
job** with a line naming the ref it used and the location it tried, so a bare `curl: (22)` is never
the whole explanation. There is no `|| true`, no `continue-on-error` and no trailing `exit 0` on
either step. Once the checker is on disk the job's docs-content outcome is the checker's own exit
status and nothing else. The controls are in `test/ci-docs-content-delivery.test.mjs`, which runs
the step's own script against a stubbed `curl`, one case per failure mode.

### The same expression was in `release.yml` four more times, and there it was silent

**`ci.yml` was the half that failed loudly, and it was not the half with the widest blast radius.**
`release.yml` checked `cosyte/.github` out at `${{ github.job_workflow_sha }}` at **four** sites:
twice in the `version` job and twice in the `release` job, because `actions/checkout` at the
workspace root clears that directory, so the tooling has to be fetched again after the caller's tree
lands. An empty `ref:` is not an error for `actions/checkout`; it resolves the provider's default
branch. So the release environment gate, the release-notes gate, the changelog gate and the publish
floor were all running from whatever `main` held mid-run, on thirteen repositories, on a path that
runs every day, while the prose directly above each checkout said they came from the commit of this
workflow file. Nothing was ever red. All four now read `${{ job.workflow_sha }}`, which is the one
property the contexts reference defines for a called job, and the same one the docs-content delivery
reads.

**Each of the four is announced before it happens.** A step immediately above each checkout prints
`release tooling: ref <sha>, from cosyte/.github`, and when the property is empty it prints
`release tooling: job.workflow_sha was empty, falling back to the cosyte/.github default branch`
first. The fallback is not a swallowed failure and not new behaviour: it is exactly what the empty
value has been producing here all along, said out loud, and the run proceeds on that default branch
rather than refusing. `job.workflow_sha` is documented as unavailable on GitHub Enterprise Server,
which is the platform case that line has to stay legible for. `test/workflow-sha.test.mjs` asserts
the ref and the announcement at every one of the four, refuses the old expression on every
executable line of every file under `.github/workflows/`, and pins the job ids of both published
workflows, because a job id is the check-run context a caller's ruleset names.

### A probe that asks a runner, because no test here can answer this

**Every offline assertion about `job.workflow_sha` compares strings.** An expression is text until
GitHub evaluates it, and an unknown context property is not an error, it is the empty string. A full
green suite in this repository is exactly what was true while `github.job_workflow_sha` was shipping
that empty string to a caller. So `.github/workflows/workflow-sha-probe.yml` reads the property on a
GitHub-hosted runner, prints what it got, and **fails the run** unless it is a 40 character lowercase
hexadecimal commit SHA: the empty string fails, the literal `main` fails, a short SHA fails.
`.github/workflows/self-workflow-sha-probe.yml` is the thin caller that starts it, wired the way
`self-codeql.yml` is: `uses: ./.github/workflows/workflow-sha-probe.yml`, the same-repository form
with no `@ref`, which GitHub resolves from the commit under test, so a pull request is probed with
the definition that pull request itself proposes. It runs on every pull request and every push to
the default branch, from a job with no condition, no dependency and no matrix, because a skipped job
and a matrix of zero jobs both report as a **satisfied** context.

**What it does not prove**, stated so it is not read as more: it says nothing about what a CALLING
repository sees. Thirteen callers live in thirteen other repositories and this one has no route to
them. What it proves is that the property resolves to a real commit for a job defined by a reusable
workflow of this repository, which is the fact that was assumed and wrong.

**It is a `workflow_call` workflow and it is not one of the six.** The trigger is there because that
is the only kind of file a `uses:` line resolves; it takes no input, is handed no secret, checks
nothing out and asks for `contents: read`. The published reference tracks the six reusables a caller
names plus everything under `scripts/`, and this file is in neither set, so changing it mints
nothing and demands nothing of anybody. `test/workflow-sha-probe.test.mjs` asserts that wiring
offline and runs the probe's own script against every answer a runner could give it.

### What it blocks on

Every finding is printed with the path from the repository root, the 1-based line where there is
one, the raw target or id, and what was looked for. It never stops at the first.

| | Blocks on |
|---|---|
| **B1** | a package-internal LINK target that resolves to no REGULAR FILE under `docs-content/`, through any of the five spellings `<t>`, `<t>.md`, `<t>.mdx`, `<t>/index.md`, `<t>/index.mdx`. A bare directory named `<t>` resolves nothing: the list already spells `<t>/index.md`, and letting the directory itself resolve would pass the exact class this gate exists to catch |
| **B2** | a document id `sidebars.json` names that equals no id the tree DECLARES, or an `{"type": "autogenerated"}` `dirName` naming no directory. A file's id is its path without the extension, with a frontmatter `id` replacing the last segment. A `dirName` that climbs out of `docs-content/` (`".."`) names no directory under it, so it is a B2 and it covers nothing: reading it as the root would excuse the whole tree from the zero-ids finding |
| **B3** | `docs-content/sidebars.json` absent, unparseable, not a JSON object at its top level, or collecting zero ids over files no `autogenerated` entry covers; any sidebar shape or item malformation; a frontmatter block opened and never closed, or an `id` opening a block scalar (`|`, `>`) or a flow collection (`[`, `{`) |
| **B4** | the input is `true` and there is no `docs-content/` at the repository root. A gate that silently no-ops is not a gate |
| **B5** | a package-internal IMAGE destination with no regular file at exactly that path. No build step invents an extension for an asset, and a directory sitting there is not a resolution |
| **B6** | any entry under `docs-content/` that cannot be READ: an unreadable file, a directory the walk cannot list, a dangling symlink. Reported wherever it sits, whether or not anything references it, and the walk continues over everything it can read |

Resolution is compared **case-sensitively against a listing of the tree**, never through a
filesystem lookup, so `./Troubleshooting` does not resolve `troubleshooting.md` on a macOS or
Windows runner while failing on Linux. The `os` matrix axis is caller-supplied and the site builds
case-sensitively; a gate reaching two verdicts for one tree would be worse than none.

### Reported, never failed

Printed with the same detail, failing nothing: **same-page anchors**, **external URLs**,
**site-absolute paths** and **cross-package relative links** that escape the `docs-content/` root;
a sidebar `"type"` this gate does not enumerate; a symlink cycle; **orphans**, meaning files no
sidebar entry references and no `autogenerated` entry covers; and an **unchecked id**, meaning one
that no readable document declares while a file that would not read could be declaring it, since a
frontmatter `id` replaces the last path segment and that file's frontmatter went unread. That run is
red already, on the unreadable file's own B6. The four link classes are excluded
deliberately: `cosyte/docs` rewrites cross-package relative links at mount time, so site-absolute
and version-mounted paths are owned there, external URLs are covered by that repo's scheduled link
check, and Docusaurus treats a broken anchor as a warning. Unlinked is not broken, but the orphan
count is the only visibility anyone has into content the site will not show.

### What it does NOT claim, stated so nobody reads more into a green run

**Residuals inside the check.** Raw HTML and JSX attributes (`<a href=...>`, `<img src=...>`), HTML
comments and MDX expressions are not targets, so a broken one there is invisible. A tag is skipped
whole, attribute values included; a `<!-- ... -->` comment and a `{/* ... */}` expression are skipped
whole even when they run across blank lines, because neither renders anything. That last one is
applied to `.md` as well as `.mdx`, which is the wider of the two readings: a repository configuring
Docusaurus with `format: 'mdx'` gets MDX in both, and the cost of the reading is a residual this
gate already accepts rather than a false red on a page nobody can see. The skip refuses to guess,
so prose is never swallowed: `a<b and [see](./x)>c` is not a tag, an unbalanced `{` is literal text,
and a tag inside a code span is code. A destination inside an **image's alt text**
(`![see [here](./missing)](./logo.svg)`) is not checked either: the alt renders as plain text, so
that destination is never live in the page, while the image's own destination is checked as any
other. Nested brackets otherwise follow CommonMark, which is not a residual but is worth saying:
`[![Logo](./logo.svg)](./intro)`, the clickable-badge shape, has BOTH destinations checked, and
where a link is nested in link text (`[a [b](./b) c](./intro)`) the INNER one is the link, so the
outer text is literal and its destination is not a target. **Duplicate declared ids are not even
reported**: two files declaring one id is an error Docusaurus raises and this gate does not detect.
A frontmatter `id:` written twice takes the first; a `sidebars.json` key written twice takes the
last, which is `JSON.parse`. And rule 1 URL-decodes every target, so a file whose NAME literally
contains a percent escape (`guide%20name.md`) linked as `./guide%20name.md` decodes to
`guide name.md` and reds.

**A construct may wrap across a line break, and one that does is still checked.** A paragraph is
read as a paragraph, not as a row of lines, so `[x12 envelope\nreference](./gone)` is one link and a
code span opened on one line and closed on the next is one span. Hard-wrapped prose is the house
style of every markdown file in this org, so a line-by-line scan would leave a large share of every
corpus silently outside the gate. Block boundaries are still boundaries: two list items, two
paragraphs and a heading beside its neighbour are never joined. An unclosed code fence inside a list
item ends with that item rather than running to end of file, so a malformed sample in one bullet
cannot hide every link after it; an unclosed fence at the top level does run to end of file, which
is what CommonMark says it is. A BLOCK QUOTE is a container in exactly the same way: an unclosed
fence inside one ends where the QUOTE ends, so a forgotten closer under a `>` cannot hide the prose
below it either, and a `>` carrying nothing ends the quoted paragraph as a blank line ends any
other. Where containers nest, the TIGHTER one wins and both sentences hold at once: a fence opened
in a list item that is itself inside a quote ends with that ITEM, so the bullet, the paragraph or
the heading below it is prose again and the links in it are checked.

**Three paths to a broken site this gate cannot stand in front of**, each owned elsewhere: a direct
or administrative push to `main`; a release cut from a commit no gated pull request produced (the
input goes on the CI workflow, deliberately not on `release.yml`); and the merge race, where one
pull request deletes a document while another links to it and both are green against their own
heads.

**And three facts that live on the caller's side, not here.** Whether the failing context is
REQUIRED is branch protection, which is per-caller settings this repository can neither read nor
write; whether a caller's workflow even triggers on a given pull request depends on that caller's
own `on:` block, which may carry `paths:` filters (this workflow never filters on the diff); and
whether an adopting repository's content passes is a question about that repository's tree, which
nothing here reads. The red and green controls are fixture trees in
`test/docs-content-check.test.mjs`.

**The out-of-scope promise for code covers every container a document can put code in.** A code span
between backticks, a fenced block under any info string and a four-space indented block are all
code at the TOP LEVEL, inside a LIST ITEM, inside a BLOCK QUOTE and inside a `:::tip` admonition
alike, at every nesting depth those containers reach, and nothing inside any of them is ever a
target. A quote's `>` markers come off the line - one per nesting level, `> >` included - BEFORE the
fence and the four-space indent are measured, and the column after them is the column both are
measured from, so a quoted sample is read exactly as the same sample is at the top level. What that
buys is an ordinary piece of technical writing:

```markdown
> **Note**, from the runtime docs:
>
> ~~~ts runnable
> const out = handlers[0](event);
> ~~~
```

which yields no target at all rather than a `B1` for `event` over a page the site renders exactly as
its author intended. The promise is bounded in the direction that matters: a quote is a container,
not a hole, so a broken link in quoted PROSE is still a `B1` on the line the link opens on, a
wrapped one included, and an unclosed fence inside a quote ends where the quote ends - or with the
quoted list item that holds it, whichever comes first - rather than swallowing the rest of the file.

### One correction, because an org-side artifact gets it backwards

**This repository is PUBLIC, and until 2026-09-03 it carried no `LICENSE` file.** Both halves were
true at once, and `cards/github-profile.md` in the umbrella infers from the second that this repo
should be treated as "private/internal". That inference is wrong, and adding the licence does not
make it right, it only removes the input: a repository can be public and unlicensed, and
`gh repo view cosyte/.github --json visibility,isPrivate,licenseInfo` returned
`{"isPrivate":false,"licenseInfo":null,"visibility":"PUBLIC"}` on 2026-08-22. It matters here
because the delivery step fetches this file from `raw.githubusercontent.com` with **no credential**,
which only works because the repository is public. That card is generated, so the rule stays wrong
for the next repository it is applied to until its generator stops inferring visibility from a
missing licence; this paragraph is the record. The licence itself is
["What the account inherits, and the two things it cannot"](#what-the-account-inherits-and-the-two-things-it-cannot)
below.
