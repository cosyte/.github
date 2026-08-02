# cosyte/.github

Org-wide reusable GitHub Actions workflows for the `@cosyte/*` suite. Each repo's own workflow is a
thin caller, so the pipeline is defined once here. All actions are pinned to commit SHAs.

> This repository is **public**, and must stay that way: a public repository cannot call a reusable
> workflow from a private one.

## Reusable workflows

| Workflow | Purpose | Used by |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | typecheck · lint(`--max-warnings=0`) · format:check · [PHI scan] · test · coverage (gating) · build · `attw` · dual ESM/CJS smoke · actionlint | every parser |
| [`release.yml`](.github/workflows/release.yml) | Changesets → npm publish **with provenance** → docs artifacts → GitHub release **with derived notes** → `repository_dispatch` to `cosyte/docs`. On failure, uploads the redacted npm debug log as a run artifact. The docs dispatch is the one operation whose failure **warns rather than failing the run**: it happens after the publish is permanent, so the run conclusion is reserved for what happened to the artifact | every published parser |
| [`nightly-fuzz.yml`](.github/workflows/nightly-fuzz.yml) | run the fuzz target; malformed bytes must never crash/hang/OOM | byte parsers (`dicom`, `mllp`) |
| [`drift-check.yml`](.github/workflows/drift-check.yml) | fail when a repo diverges from `config/drift-manifest.json` | the meta-repo (umbrella) |

## Calling them

```yaml
# <parser>/.github/workflows/ci.yml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  ci:
    uses: cosyte/.github/.github/workflows/ci.yml@main
    with:
      run-phi-scan: true # parsers that handle PHI / raw bytes
```

```yaml
# <parser>/.github/workflows/release.yml
name: Release
on:
  push: { branches: [main] }
jobs:
  release:
    uses: cosyte/.github/.github/workflows/release.yml@main
    with:
      package-name: "@cosyte/hl7"
    secrets: inherit # NPM_TOKEN + RELEASE_PR_TOKEN + DOCS_REPO_DISPATCH_TOKEN
```

## Who authors the "Version Packages" PR

**`GITHUB_TOKEN` cannot, and the failure is silent.** GitHub does not start workflow runs for events
produced by `GITHUB_TOKEN`. That is deliberate anti-recursion. The consequence for Changesets is that
the "Version Packages" PR arrives with **zero checks**, and a required status check that never
reports is **pending, not failing**, so with `bypass_actors: []` on the rulesets nobody can merge it,
an admin included. It looks like a slow queue. It is a permanent block.

**Measured, not predicted, read 2026-07-29:** `cosyte/ccda#61` ("Version Packages", head branch
`changeset-release/main`, author `app/github-actions`) reports **0 check runs** and
`mergeStateStatus: BLOCKED` against 4 required contexts. Do not cite `cosyte/hl7#63` for this. It is
the PR the trap was found on, but a human then pushed `edcf4128 chore: run CI on the version PR` to
it, which is the manual escape, so it now reads MERGED with 8 green checks and refutes on sight the
thing it was cited for.

**The control**, which is what makes this the token rather than the repo or the ruleset:
`cosyte/dicom#23` is authored by `app/dependabot`, a **bot**, in a repo governed by the **same three
rulesets** as `ccda`, and it has 8 checks and reports `CLEAN`. Repo class and ruleset held constant,
actor varied, outcome flipped.

The trap predates the rulesets added on 2026-07-27/28; those widened it, taking `hl7` from 3 required
contexts to 5.

**The fix is `RELEASE_PR_TOKEN`**, a credential that is not `GITHUB_TOKEN`. Two things are needed,
and doing only the first buys a fix that decays after one changeset:

1. **the `GITHUB_TOKEN` env var on `changesets/action`**, which is what it opens the PR with. The
   action reads `process.env.GITHUB_TOKEN || core.getInput("github-token")`, so **the env wins**:
   adding a `github-token:` input while leaving the env in place is a silent no-op.
2. **`persist-credentials: false` on the caller checkout.** The version commit is pushed by
   `git push`, not through the API. Left at its default, `actions/checkout` persists an Authorization
   extraheader into the local git config and git sends it preemptively, so the `~/.netrc` that
   `changesets/action` writes with our token is never consulted and the push stays `GITHUB_TOKEN`.
   That push is what produces the `synchronize` event on every later update to the PR.

**Why not simply hand the PAT to `actions/checkout`?** It also works, and it was the first draft. It
puts an org-scoped credential into `.git/config` at step one, where it sits for the whole job. What
the netrc route buys is specific and worth naming exactly: the PAT is **absent during
`pnpm install --frozen-lockfile`**, which is where third-party dependency lifecycle scripts run (no
caller sets `ignore-scripts`), and absent during the `Verify` ladder after it. That is the window
that matters most, because it is the only one whose contents this org does not write.

**What it does not narrow**, measured rather than assumed, because an earlier draft of this section
claimed the PAT arrived "after all third-party code has run" and that is **false**. From the
`changesets/action` step onward the token is on disk in `~/.netrc` (written unconditionally, before
the arm switch) and injected as `GITHUB_TOKEN` into the environment of `pnpm run version` and
`pnpm run release`. Neither caller *script* reads it, but the process subtree does not stop there:
`release` is `changeset publish`, which spawns `pnpm publish` (every caller declares
`packageManager: pnpm@10`) without `--ignore-scripts`, which runs each caller's `prepublishOnly`
(`clean && typecheck && lint && test && build && attw`, plus `gen:all` in `dicom`). **The whole
verify ladder therefore runs a second time inside that step with the PAT in the environment.** It is
visible in the real `hl7` 0.0.3 publish (run `30354998951`, 2026-07-28): the `Verify` step took ~53s,
and the interval inside `changesets/action` between "is being published" and "packages published
successfully" took ~55s, which is not a 50 kB tarball upload.

On the publish arm the PAT buys nothing at all, since `createGithubReleases: false` leaves the
action's octokit unused there. Narrowing it to the version-PR arm is not done: the only predicate
available is `steps.notes.outputs.is-release`, which is not the action's own arm predicate, and a
disagreement would hand `GITHUB_TOKEN` back to the Version PR. The exposure is accepted and written
down rather than traded for that risk.

**If the netrc fallback does not apply**, the push fails loudly and the run goes red with npm
untouched, because the publish arm does not push at all (`createGithubReleases: false` means the
action never pushes a tag; `gh release create --target` makes it). The failure mode is a Version PR
that does not get opened, which is strictly better than one that opens and cannot be merged.

**Scope it narrowly.** All this job asks is: push a branch, open or update one pull request. As a
fine-grained PAT that is `Contents: read+write`, `Pull requests: read+write`, `Metadata: read`, on the
caller repos and nothing else. It does **not** need `Workflows: write`: the action commits with
`git add .`, and what `pnpm run version` changes is `package.json`, `CHANGELOG.md`, `.changeset/`,
and the `VERSION` constant `scripts/sync-version.mjs` rewrites in `src/index.ts` (`src/version.ts` in
`dicom`), none of which is under `.github/workflows/`. A classic PAT with `repo` is far wider
than what is needed here. **Do not reuse `DOCS_REPO_DISPATCH_TOKEN`**, which needs write on
`cosyte/docs` alone: one token serving both purposes is over-scoped for each of them.

**What does not change:** `setupGitUser` still hardcodes the version commit's git author to
`github-actions[bot]` whichever token is in play. Only the PR's author changes, to the token's owner.

**Unset, the workflow warns rather than fails.** The secret is optional and falls back to
`GITHUB_TOKEN`, which is exactly the old behaviour, trap included. Failing closed would take every
caller's release pipeline down to protect against a state those repos are already in. The fallback is
announced in the run log, because a fix that silently is not applied is worse than no fix.

## Release notes

`release.yml` derives every GitHub release body from **the changesets that release consumed**. Each
changeset is a human-written summary of one change, they are what drove the version bump, and the
"Version Packages" commit deletes them, so the workflow recovers them from that commit's diff (hence
`fetch-depth: 0`).

The derivation lives in [`scripts/release-notes.mjs`](scripts/release-notes.mjs), not in the YAML,
because this workflow runs in 8+ public repos behind a protected environment and is awkward to
iterate on there. It has no dependencies (`node:test` only) and is unit-tested in
[`test/release-notes.test.mjs`](test/release-notes.test.mjs) against the real 15 changesets
`cosyte/hl7` consumed for `v0.0.2`, asserted **byte for byte** against the body live on that release.

### What a release body says

A release note lists what changed **for the reader**. The title is the tag and nothing else, there is
no preamble and no count, and the artifacts are not explained in terms of our own docs pipeline:

```markdown
### What changed

- Add streaming / incremental parse: `parseStream`.
- Add `profiles.visage`, the sixth built-in vendor profile: Visage 7 imaging/PACS.

Full detail for each change is in [`CHANGELOG.md`](https://github.com/cosyte/hl7/blob/main/CHANGELOG.md).

### Install

```bash
npm install @cosyte/hl7@0.0.2
```

**npm:** https://www.npmjs.com/package/@cosyte/hl7/v/0.0.2
```

A change a consumer of the published package cannot observe is **dropped**, not reworded: CI gates,
repo scanners, `sync-version`, CodeQL/Scorecard, dev-dependency-only advisories, trademark notices,
README and docs status-line corrections. When *every* change in a version is internal, the body says
exactly that rather than padding: `Internal tooling and CI only. No change to the published package
surface.`

**The drop is decided on the bullet's LEADING CLAUSE, not on the whole sentence.** It used to read the
whole sentence, so one internal clause condemned the entry it sat in however consumer-facing the rest
of it was. Measured on `@cosyte/dicom` on 2026-07-29: `Correct 174 SOP Class UID names and close two
holes in the dictionary regen gate` was dropped *whole*, so a version that genuinely corrected 174 SOP
Class UID names would have published three bullets for five changesets and never mentioned the
correction. A consumer-visible correction vanishing from a release body is the same class of harm as a
mangled sentence: the page is well-formed and wrong.

The principle, so this is not curve-fitting: **a release bullet is about its leading clause.** The
subject of a sentence sits in its head and later clauses coordinate with or elaborate on it, so
internal-tooling language in the *head* means the change is internal tooling and the bullet goes,
while the same language in a later clause means a consumer-observable change carrying internal
detail. All six live drops in the org separate on that reading, in both directions.

- **The boundary set is narrow and measured**: `;` and `:` when whitespace follows, plus the
  coordinating `and`. **A bare comma is deliberately not a boundary**: three live `@cosyte/deid`
  changesets open `Repository CI configuration only, with no runtime impact: …`, where that comma
  introduces a prepositional phrase and not a clause, and reading it as a boundary republishes three
  entries that say of themselves that nothing changed for a reader.
- **A code span and a parenthetical are masked when *locating* the boundary, never when reading it.**
  The clause is sliced out of the original text, or `` `scripts/sync-version.mjs` `` would be hidden
  inside its own backticks and an internal-only entry would be kept.
- **A match that *starts* in the leading clause condemns the entry, however far past the boundary it
  runs.** Testing the leading clause as a standalone string instead would systematically defeat the
  two rules whose match spans a conjunction, `\brelocat(?:e|ed|ing) .*tests?\b` and
  `\bworkflow\b.*\bred since\b`: `Relocate the fixtures and the tests into one place` has a neutral
  head half, so neither half matches alone and a wholly internal entry would publish. No pending
  changeset in the org hits that today, which is why it is closed here rather than left for the
  release that would have published it.
- **The direction of error, stated because it is the unfavourable one.** This can only ever turn a
  drop into a keep, and that is a **subset** argument rather than a claim about regexes: the old rule
  dropped on any match anywhere, this one drops on any match *starting* before the boundary, and the
  second set of matches is contained in the first. So it holds for any pattern the word list ever
  grows, with no dependency on that list staying free of anchors or lookarounds. The cost of being
  wrong is an internal-only bullet on a public page, never a lost consumer-facing one. That is why it
  shipped on a before/after count over every pending changeset in the org rather than on the argument:
  **exactly two bullets flip, org-wide** (`dicom` 3 → 4 kept, `cli` 9 → 10), and both are the defect
  above. Nothing that publishes today stops.
- **`assert`'s independent half moves with it, and has to.** `findViolations` reads the same rule,
  because if the two halves disagree the renderer keeps a bullet `assert` refuses, which is a release
  nobody can cut. The cost is that `assert`'s re-read of finished bytes is relaxed in the same step, so
  a body written by some *other* path can now carry an internal clause after its leading one.
  `release.yml` only ever asserts the file `prepare` itself wrote.
- **It does not cut the internal clause out and publish the rest.** That is the mid-sentence cut this
  pipeline exists to refuse, and the measured headline joins its clauses with a bare `and`, which
  `isSafeCut` correctly declines. The remedy for a mixed changeset remains: **reword the changeset, do
  not grow the gate.**

### The gate

**The pipeline refuses to publish a release whose body is not fit for a public surface.** Documentation
governs whoever reads it; a gate governs everyone. The run **fails and names the offending line**:

| Refusal | Fires on |
|---|---|
| Nothing to say | empty body, whitespace, a bare title, or an `Automated release of <tag>` stub |
| No record of what shipped | a version bump that consumed no changesets |
| An undescribed change | a consumed changeset with an empty summary |
| Internal project identifier | `HL7-U`, `CCDA-P7`, `MLLP-8.1`, `DOCS-CONTENT-P4`, `README-ORG-SWEEP` |
| Phase or slice language | `Phase W`, `Phase 5b`, `roadmap Phase K`, `(thirteenth slice)` |
| ADR reference | `ADR 0018` |
| Em dash | `U+2014`, inherited from changesets written before that ban |
| Unobservable change | a bullet describing something no consumer can see |
| A sentence built around the identifier | removing it would leave prose that does not parse |
| An opening sentence too long for a bullet | over 400 characters, where the alternative is cutting it. **No replacement sentence is offered**, see below |
| A bullet that was cut short | a one-letter stump, or an over-length entry, in the finished bytes |
| Mangled prose | doubled or orphaned clause punctuation, an emptied parenthetical |
| An unclassifiable commit | no readable `package.json` at `HEAD`, or a version that appears in no commit |
| Wrong release | a body that disagrees with the version or package that reached npm |

**Every refusal above bar the last fires before npm is reached**, and structurally rather than by
arrangement: `changesets/action` is only handed a publish command once the body has been derived and
its bytes proved fit, so a run that cannot say what it is shipping cannot publish. Only "wrong
release" can fire afterwards, because the version it reconciles against is what Changesets reported
publishing and does not exist any sooner.

The renderer **translates** first (identifiers belong in the changeset, the changelog, the commit and
the roadmap, never in a release body) and the gate then proves the translation worked. Translation is
never silent: every rewrite and every dropped change is printed to the run log.

**What the gate does and does not cover.** It enforces the *known* banned set, and it shares the
project-prefix list with the translator, so it cannot catch an identifier from a programme prefix
nobody has added to that list yet. No rule could: the only way to spot one from its shape alone is a
`WORD-N` pattern, which is exactly what destroys `SCH-11`, `PID-3`, `MSH-2`, `NM1-03`, and `ICD-10`.
What the gate *does* buy is that a rule cannot be quietly bypassed downstream, because it re-reads
the finished bytes. **Starting a new programme means adding its prefix to `PROJECT_PREFIXES`**; that
is the maintenance cost of keying on prefixes instead of shapes, and it is the cheaper mistake.

Three traps the implementation handles deliberately, each of which caused a real leak on 2026-07-27:

- **Prefix keying, never the `WORD-N` shape.** `MLLP-10` is ours; `SCH-11`, `PID-3`, `MSH-2`,
  `NM1-03` are HL7 and X12 segment-field references and are exactly the reference material a
  consumer needs.
- **Decapitation.** Stripping an identifier from the front leaves a fragment, and
  `(thirteenth slice): builder emits X` is worse than the original. The head is repaired afterwards.
  A dangling **tail** (removing `phase log` leaves `..., not a`) is a **refusal**, not a repair:
  walking back off loose words is how a translator starts editing meaning, and the same walk-back
  turns `the emitter does not` into `the emitter does`, which is well-formed prose no gate can catch
  and the opposite of the truth. The run stops and asks for a sentence that survives, which costs
  one changeset edit before anything is published.
- **Case sensitivity.** `FHIR-bridge` and `docs-content/` are legitimate content that a
  case-insensitive rule would flag.

**In running prose the cut is only ever taken where the sentence survives it, and this is the
load-bearing rule.** Removing a phrase from the middle of a clause leaves prose that does not parse:
`no longer carries phase language, item identifiers or ADR numbers` became
`no longer carries, item identifiers or ADR numbers`, and **nothing downstream could see it**,
because a mangled sentence carries no banned bytes for a byte-level rule to find. A gate reads
bytes, not grammar. So a span is removed only when the text on both sides of it is the same kind of
thing (nothing, a clause separator, or a plain word), and never when it is glued to its neighbour by
a hyphen or a slash (`The MLLP-1-driven reconnect` is one word). A separator on exactly one side
means the rest of that clause stays behind, and the run **refuses**, naming the changeset. Leaving
the identifier in place is deliberate: it keeps something in the bytes for the gate to catch.

**Inside a parenthetical the same test drops rather than refuses.** Parentheticals are split on
commas and cleaned segment by segment, so a segment that cannot be cleaned safely is dropped whole,
which is what this file already did with a segment that cleaned down to nothing. A parenthetical is
by construction removable; a clause in a sentence is not. Segment edges are told to read as the
separators they are, or the segment view calls a cut safe that the whole sentence would not.

**And a sentence is never shortened.** An over-long opening sentence used to be cut at the nearest
word boundary and nothing was said, which published `...a medication naming two different drugs with
o.` to one release and, in the same body, cut a three-part finding down to two and appended a full
stop so it read as a complete claim the author never made. A headline is now the author's first
sentence entire, or the run refuses and asks for a shorter one. **How many live bodies still carry
that cut is measured by [`scripts/release-diff.mjs`](scripts/release-diff.mjs)**, below; correcting
them is separate work and is not done here.

**What this costs, measured 2026-07-28** on the 242 changeset files, deduplicated by name, recovered
from every commit touching `.changeset/*.md` in the 13 repos that carry them. **214 changesets pass
untouched, 24 are asked to shorten a first sentence, 3 to rewrite one, 1 was already refused.**

`assert` re-reads finished bytes for the shapes a cut leaves behind, and **on the 17 live release
bodies it now finds none, while the differ finds 9 cut bullets.** That gap is deliberate and is the
honest limit of a byte rule. Every rule wide enough to catch `...reads MSA-2 whole to match, and
\`reescape\` emits a li.` also refuses `Pass an unknown Z-segment through as is.`, `...the more broken
the document was.`, `...recorded as A, B, AB, or O.` and `...quantity the builder emits to mL.`, all
of which are complete sentences and one of which a real release consumed. **Refusing a correct
sentence blocks a publish on a lie, so the byte rules stay narrow and the guarantee lives where it
can be kept: the renderer no longer cuts a sentence at all.** A body this pipeline produces cannot be
truncated; a body it merely inspects can be, and a byte rule will not tell you which.

A fourth, specific to this suite: `slice` is our word for a unit of work, but it is **also** real
clinical vocabulary. A DICOM study has a slice thickness, a slice location, and a Number of Slices,
so only the unambiguously-internal determiner forms are rewritten.

### Consequences worth knowing

- **Every change needs a changeset with a real summary.** `pnpm changeset` with a blank description
  now stops a release rather than producing an empty bullet.
- **The notes are derived exactly once, before the publish step**, and the publish step asserts and
  publishes that same file. The ordinary failure therefore costs nothing: npm is untouched and the
  fix is to amend the changeset and re-run. Deriving a second time after publishing cannot work,
  because `changeset publish` creates the `v<version>` tag locally and that tag is how the script
  answers "is a release pending".
- **npm is downstream of the gate.** `prepare` is the permission to publish, not a report on it: its
  `is-release` output is what `release.yml` passes to `changesets/action` as the publish command, so
  a run that could not derive a fit release body never reaches the registry. The body is proved a
  second time, from the finished bytes, in the step immediately before that one. Until 2026-07-28 the
  order was publish first and check second, with an error afterwards saying npm had the package and
  the gate had not run. **A published version is permanent, so that was a correction, not a gate.**
- **The one check that still follows the publish is the reconciliation**, which compares the body
  against the version Changesets reported publishing. That version does not exist any earlier. A
  disagreement there still leaves the package on npm with no GitHub release, and that remains the
  intended trade: a loud red beats a silent green carrying a meaningless release. Recovery is to
  create the release by hand, since re-running finds nothing left to publish.
- **The "Version Packages" PR body tells you to publish by hand. Do not.** `changesets/action` writes
  that sentence whenever it is opening the PR without a publish command set, and the command is
  withheld until the notes gate has passed. Merging the PR is still what
  releases; the publish then runs behind the protected `release` environment. The wording is left
  wrong on purpose: the only way to correct it is to re-derive "are there pending changesets"
  ourselves, and a predicate that disagrees with the action's own by one empty changeset file would
  hand the publish command back on the arm that actually publishes.
- **A commit the gate cannot classify is a red run, not a quiet skip.** "No release pending" is
  benign on exactly three readings, and the script distinguishes them by a `code` rather than by
  prose: `already-released` (`v<version>` is tagged, which is every ordinary push to main between
  releases), `never-versioned` (see below), and `version-reverted` (see below). If `package.json` is
  unreadable at `HEAD`, or the version at `HEAD` appears in no commit (a shallow checkout, so mind
  `fetch-depth: 0`), the run stops there rather than letting the publish step decide on its own.

### The bullet cap was raised from 200 to 400 on 2026-08-02

**A founder call about how much a release bullet is allowed to say, not a workaround for one failing
run.** `MAX_HEADLINE_CHARS` in `scripts/release-notes.mjs` is now **400**.

What it was decided on: **`@cosyte/dicom` `0.0.7` was refused by the 200 cap on 2026-08-02, after its
"Version Packages" PR had already merged**, which wedges the repo rather than merely annoying it. By
the time `prepare` runs the changeset has been consumed by the version commit, so recovery is the
revert dance the refusal message spells out. **Two** of that release's changesets were over the cap,
at **229** and **218** characters, though the run only ever named the first (see the open defect
below). The 229 opened *"PHI: an element whose on-wire VR is not one of the 34 PS3.5 §6.2 defines was
kept verbatim by `deidentify()`, carrying a source `(0010,0020)` Patient ID into de-identified output
next to `(0012,0062) PatientIdentityRemoved = YES`"*. That is a PHI leak, and what makes it sharp is
the juxtaposition: the output asserts the identity was removed while carrying it. **Cutting it to 200
forced real facts out of the opening sentence**, and the opening sentence is the only part that
becomes a bullet.

**`@cosyte/astm` `0.0.9` was wedged the same day and is NOT evidence for this raise**, which is worth
stating because the two get told as one story. Its opening sentence was 220 raw characters, but the
cap is measured on the **translated** headline, which was **185**, comfortably under even the old
cap. What refused astm was the internal-identifier rule: `ASTM-UNKNOWN-RECORD-REMERGE` was the object
of its opening verb and could not be lifted out. **The raise does not change astm's outcome by one
byte**, and the rule that refused it is untouched here on purpose.

**What the raise did not change.** Over-cap is still a **refusal**, not a trim: nothing is shortened
on the author's behalf, for the reasons in the section below. And the rule that an internal
identifier may not be load-bearing in the opening sentence is **untouched** by this call. That rule
is what actually refused `astm` above; it is a question about meaning, not about length, and the two
do not move together.

**The number lives in exactly one place** and every message, gate half and test derives from it:
`MAX_HEADLINE_CHARS` is read by the refusal in `collectHeadlines` (which computes the overage from
it) and by `findViolations` in `assert`, so the two halves cannot drift apart. The boundary is pinned
from both sides in `test/release-notes.test.mjs`: 400 characters ship entire, 401 are refused with
the arithmetic asserted literally, so moving the constant without moving the test goes red.

**Known open defect, filed not fixed:** `collectHeadlines` throws on the **first** refusal, so a run
with several bad changesets names one and hides the rest. This cost a second recovery round in
`astm` and again in `dicom`, where a second changeset at 218 characters was refused and reported
nowhere. Collecting all refusals and reporting them together is a real improvement and a behaviour
change in its own right, so it is not folded into the cap raise.

### The over-cap refusal offers no replacement sentence, on purpose

**It used to offer one, and the one it offered was the sentence it had just refused.** Measured on
`dicom` (253 characters), `ccda` (213) and `fhir` (241) on 2026-07-29: the refusal ended *"open the
changeset with a sentence that fits … : `<sentence>`"*, and `<sentence>` was character for character
the over-cap sentence being rejected. A reader who adopted it verbatim failed the next attempt
identically. **A wrong suggestion in an error message is worse than no suggestion**, because it is
confidently misleading at exactly the moment someone is trusting the tool.

**And a correct one cannot be derived here.** Choosing what to leave out of a sentence is a judgement
about which facts matter, which is precisely the judgement this gate refuses to make on an author's
behalf, and a mechanical cut is what published `…two different drugs with o.` to a real release. So the
message now states the constraint (the measured length, the cap, the overage), quotes the sentence
**labelled as refused**, reports the translated form when translation changed it because that is the
form measured, and says plainly that no shortened version is offered and why. The refusal itself is
unchanged: still red, still before npm.

### A phase phrase at the end of a sentence is cut whole, not decapitated

**`@cosyte/synth` `v0.0.1` published "Release hardening: the final."** `PHASE_TALK` matches `roadmap
phase`, and in *"…release hardening — the final roadmap phase"* that is the **head noun of "the final
roadmap phase"**. `isSafeCut` allows it because a cut at the end of a sentence has nothing on its
right to break, so the determiner run is left standing with nothing to govern. `DANGLING_TAIL` cannot
see it and **must not be grown to**: `final` is a content word, and that list may only ever hold words
that cannot change a sentence's meaning. `@cosyte/deid` wrote the same shape and would have published
"Release hardening, the final."

`PHASE_TALK` now names the phrase (`the <sequence adjective> roadmap phase`, **anchored to the end
of the sentence**), beside the `the \w+ and final phase` alternative that was already there for the
same reason. It publishes **"Release hardening."**, which is letter for letter what `x12` `v0.0.1`,
`ncpdp` `v0.0.1` and `astm` `v0.0.1` already publish for the same change, and what a human wrote by
hand when correcting `synth`'s body. **The modifier slot is a word list, not `\w+`**: `final`,
`last`, `next`, `first`, `current`, `remaining`, `penultimate`, every one a word that orders our own
work and can never be the *object* of a verb. A wildcard there reproduces the object deletion below
one word narrower: it turns "Regenerate and re-publish the dictionary roadmap phase" into
"Regenerate and re-publish". Across the corpus the slot is filled by `final` 5 times across the 464 changeset bodies (3 of the 406
opening sentences, 2 of them tail-anchored) and by nothing else; the older sibling still wildcards its own slot, which is pre-existing and its own work.

**The anchor is load-bearing:** a determiner run is only stranded when no noun follows it. Unanchored, the same alternative rewrites "Complete the final roadmap phase and ship
the parser" to "Complete and ship the parser", which is well-formed and missing the object the author
gave the verb. Mid-sentence the plain `roadmap phase` alternative still matches, so phase language is
detected exactly where it was before; only the wider cut is confined to the tail.

**Cost, measured on 406 opening sentences.** Every commit touching `.changeset/*.md` in the 15 repos
that carry them yields 464 distinct changeset blobs, which dedupe to 406 distinct (repo, opening
sentence) pairs. State the dedupe with the number, because the blob count is a different denominator.
**2 bullets change, both are the defect, and no changeset moves between publishing and being
refused.** Nothing else in the corpus moves.

### A general version of that rule was built and WITHDRAWN. Do not rebuild it

The general form is: widen any **tail** cut leftwards over "a determiner plus up to two lowercase
modifiers", so a cut takes the noun phrase rather than its head. It fixes both bullets above, moves
nothing else in the 406-changeset corpus, and is still **wrong**, because what it *can* reach is not
bounded by what the corpus happens to contain. It

- deletes the object of *"Regenerate and re-publish the DICOM dictionary roadmap phase"*, publishing
  *"Regenerate and re-publish"*;
- reads the **relative pronoun** in *"Add the check that catches phase 5b"* as a determiner and
  publishes *"Add the check"*, a claim the author never made. `that <lowercase word>` occurs in 32 of
  those 406 opening sentences, so the shape is native to this register;
- shortens a headline enough to flip the **length refusal into a publish** (the cap was 200 when this
  was measured and is 400 now; the failure mode is the same at any cap);
- takes the `a` from *"…as a capability doc, not a phase log"*, leaving *"…not"*, which
  `DANGLING_TAIL` is **forbidden** to catch, converting a visible refusal into a silent publish.

Every one of those turns a visible break into well-formed prose that is not what the author wrote,
which is this file's worst failure mode. **A named shape cannot delete a word the author chose: it
matches only the words it names**, which is why the alternative that replaced it names both the
phrase and the words allowed in its one variable slot. That is the general lesson, and it is why the
list above is a list.

One interaction is worth stating rather than leaving to be rediscovered: because the phrase is now
cut whole, a headline in the narrow band that was **just** over the cap can come in under it and
publish where it used to be refused. That is the cap behaving as specified: it is **measured on the
translated headline**, and the translated headline is the author's sentence minus phase language. No
changeset in the corpus sat in that band when it was measured, against the 200-character cap then in
force; the cap is 400 from 2026-08-02 and the band moved with it.

**A carried hole, stated rather than closed.** A tail cut can still destroy a negation's complement.
*"Ship the emitter now, not the next roadmap phase"* → *"…not"*, and nothing sees it, because
`DANGLING_TAIL` may not hold `not`. This is **pre-existing**: the base leaves *"…not the next"* on the
same input, equally uncaught. There is no live instance. Closing it needs its own evidence.

### Two gates proposed for the `synth` fragments, both REFUTED by the corpus

`synth` `v0.0.1` published **seven** bullets that read as fragments, and the standing diagnosis was
that the translator had cut away the subject and the verb. **Re-derived from the real release, it had
not: exactly one of the seven is the renderer's doing** (the one above). The other six are the
author's own words with a label removed. *"Phase 1 (SYNTH-1): the generator core"* has no verb
anywhere in it to lose. Two gates follow from the wrong diagnosis, and both are refused here:

- **"Refuse a bullet with no finite verb."** A release bullet is very often a noun phrase on this
  suite, and it publishes correctly. Verified live on the published pages: `Release hardening.`
  (`x12`, `ncpdp` and `astm` v0.0.1; `synth`'s own bullet was rewritten by hand and no longer reads
  this way), `Spec-clean Part 10 serializer.`, `Source/vendor profile
  system.`, `Safety-critical domain helpers.`, `VR value decode + dataset navigation.`,
  `Pre-publication docs polish.` (`dicom` v0.0.1), `The first working parser.`, `The clinical
  reconciliation triad.` (`ccda` v0.0.1) and `RxNorm drug relationship graph.` (`terminology`
  v0.0.1). The rule refuses every one of them.
- **"Refuse the `Phase N (ID):` headline shape at authoring time."** Under the reading that catches
  the `synth` bullets (*translation removes a run at index 0, and the remainder then opens on one of
  `, ; : . / -` or an em dash*), it fires on **133 of 406 opening sentences, across 13 repos**, and
  nearly all of them publish correctly: `Builder emits a Family History section.`, `835 Healthcare
  Claim Payment/Advice (ERA), TR3 005010X221A1.`, `Metadata-level de-identification (PS3.15 Annex
  E).` A gate that refuses a third of everything is one nobody can satisfy. **State the reading with
  the number**: looser ones ("the headline starts with `Phase`") measure 117 to 168 and are a
  different claim.

**The remedy for a terse bullet is the standing one: reword the changeset, not grow the gate.** Do not
re-propose either rule without new evidence.

### A version that moved backwards is a recovery, not a release

**Recovering a stranded version commit means reverting it, and a revert moves the version DOWN and
consumes no changesets**: it *restores* them, by construction, since the commit it undoes is the one
that deleted them. The gate read that as a pending lower-version release with nothing to derive from
and refused in `prepare`, which runs *before* `changesets/action` with no `continue-on-error`. So no
Version PR ever opened and **every later push to `main` failed identically**.

`@cosyte/fhir` was held there on 2026-07-29, and there was **no fix available inside `fhir`**: any
commit that lowers a version consumes no changesets. `ccda` and `dicom` survived a byte-identical
recovery only because they carry tags from real publishes and hit the `already-released`
short-circuit; `fhir` has **zero tags, local and remote**, because an npm name-similarity rejection
has kept it unpublished. `never-versioned` does not cover it either, because `0.0.4` **is** a real
prior version.

**The signal is the direction of the move, read at the commit that introduced `HEAD`'s version and
nowhere else.** Under ADR 0001 a version never moves backwards and a published version is
permanent, so a version this repository's own history has already moved *past* is not one it is
releasing; it is one it has returned to. The release that follows a recovery is the **fresh Version
PR**, which bumps back up, consumes the reworded changesets, and goes through this gate whole.

**It cannot be wrong in the dangerous direction, and that does not rest on the detector being
accurate.** A `version-reverted` verdict **grants nothing**: it sets `is-release=false`, which is
precisely what *withholds* the publish command from `changesets/action`. There is no path from this
verdict to npm, so the worst a false positive can do is decline to publish, which a fresh Version PR
then undoes.

**And it does not weaken the fail-closed property next to it.** A **forward** bump that consumed no
changesets still fails, loudly, exactly as before: that refusal is what catches a version commit whose
changesets went missing, and a forward move is not a downward one. The test is strictly "lower", and
the comparison answers *"cannot order"*, which is not "lower", for anything that is not a plain
dotted numeric version, so an unorderable pair falls through to that same hard failure.

| Rejected alternative | Why |
|---|---|
| tag `v0.0.3` on the unpublished version, to force `already-released` | **rejected by the founder, and not implemented.** The tag is this pipeline's proxy for "npm has this version". Creating one for a version npm does not have makes the proxy assert a falsehood, and trades away a deliberately fail-closed ADR 0001 property to route around a bug in the classifier. |
| require that the commit **restored** changesets | rejected as a *precondition*, kept as reported **evidence**. Real evidence, but depending on that file shape makes the unblocking fragile (reword in the same commit, or drop one, and `fhir` stays blocked), and it buys no safety: every extra conjunct only narrows a verdict that already grants nothing. |
| compare against the **highest** version anywhere in history | refuted by counter-example. One botched bump to `1.0.0`, reverted, would classify every subsequent genuine `0.0.x` release as superseded, forever and silently: the permanent deadlock this change removes, rebuilt. The comparison is **local** to the version commit for that reason. |
| also require `consumed.length === 0` | considered and deliberately **widened**. A downward move that *did* consume changesets is not a release either, and today it derives notes and publishes a version lower than one the repository has already carried, which ADR 0001 forbids outright. Declining is strictly safer. The two shapes are told apart in the logged `reason` rather than one being hidden. |

**The log does not claim "recovery" on a commit that restored nothing.** The reported evidence is
whether the commit *restored* changesets, and the paragraph that says "this is a recovery, and a
reverted version commit consumes no changesets by construction" is printed only when it did. Printing
it anyway would override the line that had just correctly said the commit is not revert-shaped, which
is the same defect as offering back a refused sentence: confidently misleading at the moment someone is
trusting the tool. It is keyed on what was **restored** and not on what was consumed, so a downward
commit that both restores and consumes changesets still reads as a recovery. Computing `consumed` here
to sharpen a log line would grow the branch for prose, and every one of these paths is
`is-release=false` regardless.

### A repo that has never released

**A first release has no previous version and no consumed changeset, so there is nothing here for
the gate to derive from.** That is not a release whose notes are missing; it is a repo with no
release in it yet, and `prepare` now classifies it as `never-versioned` and exits 0 having derived
nothing and set `is-release=false`.

**Why it had to change.** Measured against `origin/main` on 2026-07-29: `cli`, `deid` and `synth`
are at `0.0.0` with no tags and have never published, and every one of their release runs failed
here. The refusal closed the loop on itself. The gate refused in `prepare`, so `changesets/action`
never ran, so no "Version Packages" PR was ever opened, so the version never left `0.0.0`, so the
next run refused for the same reason. The version could not advance past the check that was waiting
for it to advance.

`transform` was a fourth and is now at `0.0.1`, which is worth stating precisely rather than
quietly dropping. It escaped hours before this landed, by merging a "Version Packages" PR opened on
2026-07-22, *before* the notes gate was made fail-closed. That route requires a PR that already
exists, so it is not a fix and it did not generalise: `cli` and `synth` have no Version PR at all,
and no run of theirs could open one.

**The test is a property of the history and of nothing else:** no commit reachable from `HEAD` has
ever carried a `package.json` version other than the one at `HEAD`. The three alternatives were each
rejected for being wrong in the dangerous direction, which is letting a package that HAS released
skip the gate:

| Rejected test | How it goes wrong |
|---|---|
| the version is `0.0.0` | a magic value, neither necessary nor sufficient. A scaffold may start anywhere, and `0.0.0` is publishable. |
| no `v*` tag exists | a tag is one `git push --delete` from gone, and a deleted tag makes a released repo look unreleased. |
| the registry 404s | needs a network call this gate does not otherwise make. **Measured refutation: `@cosyte/fhir` is 404 on npm and has real version bumps with derivable notes**, so this test would have exempted it. |
| `findVersionCommit` hit the first commit | what the old error already reported, and too narrow: false whenever `package.json` arrived in the second commit, where the same repo instead refused with "consumed no changesets". One deadlock, two error messages. |

**It cannot be wrong in the dangerous direction, and that does not rest on the test being accurate.**
A `never-versioned` verdict grants nothing: it sets `is-release=false`, which is precisely what
*withholds* the publish command from `changesets/action`. The worst a false positive can do is
decline to publish. There is no path from this verdict to npm, and the gate is never *passed* here,
only deferred.

**The first release still goes through the gate whole.** The run that classifies `never-versioned`
is the run that opens the Version PR; merging it produces a version commit with a real previous
version and real consumed changesets, and *that* run derives notes and is checked in full. Nothing
is skipped, it is deferred by one commit, to the commit that has something to say. A package that
has been versioned does not re-enter this state without a history rewrite, and if it ever did the
verdict would still withhold the publish command rather than hand it over.

**A shallow checkout is not read as never-versioned.** Its oldest commit has no parent and reads as
a root commit, so the question is unanswerable rather than answered `false`; `hasPriorVersion`
returns `null` and the run goes red pointing at `fetch-depth: 0`. Answering `false` there would turn
a misconfigured checkout into a green run that published nothing.

### Auditing the releases that predate the gate

The gate above stops a new truncation. It does nothing about the ones already published, and those
bodies are permanent. [`scripts/release-diff.mjs`](scripts/release-diff.mjs) is what says how many
there are: for one published release it diffs **the body live on the release page** against **the
changesets the tagged version commit consumed**, and classifies every bullet.

```bash
node scripts/release-diff.mjs sweep --repo ../hl7 --package @cosyte/hl7
node scripts/release-diff.mjs classify --repo ../ccda --package @cosyte/ccda --tag v0.0.2 --json
```

| Verdict | Means |
|---|---|
| `untouched` | the bullet is the changeset's own words, unchanged |
| `deliberately-short` | the same, and short because the author wrote it short |
| `identifier-removed` | it differs only by spans the translator removes on purpose. **Not a truncation** |
| `truncated` | the author's sentence carries on past the bullet, in prose no rule explains |
| `rewritten` | the bullet says something the changeset does not, so it was edited by hand |
| `unmatched` | no consumed changeset aligns with the bullet |

**Telling `identifier-removed` from `truncated` is the entire job.** A bullet with its trailing
`(CCDA-P7)` removed *is* a proper prefix of its changeset sentence while being a complete sentence,
so a prefix comparison calls it cut; that is why one earlier count read 25. A cut that landed on a
clean word boundary is well-formed prose, so a scan over the bytes alone cannot see it at all; that
is why another read 6. The differ asks what the missing text *is*, using
`release-notes.mjs`'s own `TRANSLATION_RULES`, rather than how much of it there is.

**Measured 2026-07-28, across all 17 published releases of the 8 published packages, 149 bullets:
9 are genuinely truncated, in 6 releases across 5 packages.**

| Package | Release | Cut bullets |
|---|---|---|
| `@cosyte/hl7` | `v0.0.1` | 1 |
| `@cosyte/mllp` | `v0.0.1` | 3 |
| `@cosyte/x12` | `v0.0.1` | 1 |
| `@cosyte/ccda` | `v0.0.1` | 1 |
| `@cosyte/ccda` | `v0.0.2` | 2 |
| `@cosyte/astm` | `v0.0.1` | 1 |

The other 140: 117 `identifier-removed`, 15 `untouched`, 6 `rewritten`, 2 `deliberately-short`, none
unmatched. The 6 `rewritten` are exactly the 6 bodies corrected by hand on 2026-07-28, which is a
useful check on the method: it recovers a known set it was not told about.

**What it can still miss**, stated because a count is only worth what its limits are. A `rewritten`
bullet is not graded for truncation: once a person has edited the page there is no derivation left
to compare against, and guessing would be worse than declining. A bullet that ends on a sentence end
is read as complete even when the changeset carries on: a cut that landed exactly on a full stop is
invisible, and no rule can separate it from an author who stopped there. Words missing from the **middle** of a
bullet are checked the same way as the tail but never make it a truncation, since nothing came off
the end; unaccounted interior spans are printed under their own heading (there are none across the
149). And the pairing is by content, so a body whose bullets share most of their wording could in
principle pair one against the wrong changeset; none did here, and `--json` prints the pairing.

**It is a classifier, not a regenerator, and that limit is the finding underneath it.** Running
`release-notes.mjs prepare` against the historical version commits **refuses on six of them**, because
their source changesets' opening sentences are themselves over the cap, which is exactly why they
were cut. That count was measured against the **200-character cap then in force**; the cap was raised
to 400 on 2026-08-02 and the sweep has not been re-run, so read "six" as the number then and expect a
smaller one now. The limit it illustrates does not move with the cap. These bodies cannot be
regenerated mechanically: each needs a person to
write a shorter sentence that keeps the meaning. So the tool quotes the missing tail and stops, and
there is no command that emits a replacement body. `sweep` exits 1 when anything is cut, which makes
it a check you can run; **nothing in this repo's workflows runs it**, on purpose, because a red build
over a permanent published page is a nag, not a gate.

### CHANGELOG promotion (specified, not implemented)

Every caller's `CHANGELOG.md` currently has zero versioned sections: all content lives forever under
`## [Unreleased]`, so nothing has ever been attributed to a version. Fixing that means editing the
8 caller repos, so it is deliberately out of scope here, and **the release body does not depend on
it**: the notes come from the changesets, which are what actually drove the release.

For each of `hl7`, `mllp`, `dicom`, `x12`, `ccda`, `ncpdp`, `astm`, `fhir`, extend the `version`
script in `package.json`, which today reads:

```
"version": "changeset version && node scripts/sync-version.mjs && prettier --write package.json src/index.ts"
```

Insert a promotion step after `changeset version` (which has already written the new version into
`package.json`) and before `prettier`. It should rename `## [Unreleased]` to
`## [<new version>] - <YYYY-MM-DD>`, insert a fresh empty `## [Unreleased]` above it, and leave the
file untouched when `[Unreleased]` holds no entries. Because it runs inside `changeset version`, the
result lands in the "Version Packages" PR, where it is reviewable and shows what the release will
contain before anyone approves the publish. That is the point: nothing currently surfaces what a
release will contain.

Doing it in the release job instead would mean pushing to `main` from CI after the publish, which is
strictly worse: unreviewable, and it races the branch it is pushing to.

See the meta-repo `documentation/conventions.md` for the engineering standard these enforce.
