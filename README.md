# cosyte/.github

Org-wide reusable GitHub Actions workflows for the `@cosyte/*` suite. Each repo's own workflow is a
thin caller, so the pipeline is defined once here. All actions are pinned to commit SHAs.

> This repository is **public**, and must stay that way: a public repository cannot call a reusable
> workflow from a private one.

## Reusable workflows

| Workflow | Purpose | Used by |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | typecheck · lint(`--max-warnings=0`) · format:check · [PHI scan] · test · coverage (gating) · build · `attw` · dual ESM/CJS smoke · actionlint · **the two pre-publish layers**. Everything before those reads the working tree, where the monorepo's own resolution is in scope; the pre-publish layers ask the consumer's question **before** anything is published, which is the only place it can be prevented | every parser |
| [`release.yml`](.github/workflows/release.yml) | Changesets → npm publish **with provenance** → docs artifacts → GitHub release **with derived notes** → `repository_dispatch` to `cosyte/docs` → **post-publish install gate**. On failure, uploads the redacted npm debug log as a run artifact. The docs dispatch **warns rather than failing the run**, because it happens after the publish is permanent and the artifact itself is fine. The install gate is the one post-publish check that **can** fail the run, because a positive finding means the artifact is not fine | every published parser |
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

### What it does not narrow

**▶ THIS SECTION IS THE OWNER OF THAT INVENTORY. There is deliberately no second copy.** It stood in
three places at once (here, the `release.yml` header, and a comment in `scripts/install-check.mjs`),
owned by none of them, and a correction landed in one copy while the other two stayed confidently
wrong. Both of those now carry a pointer to this section and state only what is enforced at their own
site. **A documented exposure with no owner is how this one got understated twice.** Put the next
residual here.

Measured rather than assumed, because an earlier draft of this section
claimed the PAT arrived "after all third-party code has run" and that is **false**. From the
`changesets/action` step onward, **and until the removal step described below, which since 2026-08-05
is the very next step**, the token is on disk in `~/.netrc` (written unconditionally, before
the arm switch) **and the raw `NPM_TOKEN` is in `~/.npmrc` in plaintext** on the publish arm, and it is
injected as `GITHUB_TOKEN` into the environment of `pnpm run version` and
`pnpm run release`. Neither caller *script* reads it, but the process subtree does not stop there:
`release` is `changeset publish`, which spawns `pnpm publish` (every caller declares
`packageManager: pnpm@10`) without `--ignore-scripts`, which runs each caller's `prepublishOnly`
(`clean && typecheck && lint && test && build && attw`, plus `gen:all` in `dicom`). **The whole
verify ladder therefore runs a second time inside that step with the PAT in the environment.** It is
visible in the real `hl7` 0.0.3 publish (run `30354998951`, 2026-07-28): the `Verify` step took ~53s,
and the interval inside `changesets/action` between "is being published" and "packages published
successfully" took ~55s, which is not a 50 kB tarball upload.

**The post-publish install gate used to run in that same window, and it runs the WIDEST CLASS OF CODE
in this job.** It performs an `npm install` of the just-published package, whose transitive
dependencies are **range-resolved at probe time rather than lockfile-pinned**, where everything above
runs out of a lockfile the caller committed. It passes **`--ignore-scripts`** (founder decision,
2026-08-04), so it adds no third-party *lifecycle* execution to the list above. Since 2026-08-05 it no
longer runs in the credential window either: both files above are deleted from disk before it (see
below), and its entry probe's child gets an environment built from nothing. **What it still runs is
unchanged, and that is the part worth keeping in view.**

**But `--ignore-scripts` governs only the install, and the gate has a second half.**
`probeEntryPoints` loads the package by name, which **executes the module-init code of everything on
its import graph, in-process**. Measured against the live registry, probing `@cosyte/ncpdp@0.0.10`:
the **ESM** probe executes **8 third-party packages across 39 module files** (`fast-xml-parser` plus
its own `@nodable/entities`, `fast-xml-builder`, `is-unsafe`, `path-expression-matcher`, `strnum`,
`xml-naming`, and `anynum` transitively); the **CJS** probe executes **1**, because ESM evaluates the
whole static import graph eagerly while `require` is lazy. `@cosyte/ccda@0.0.10` executes
`@xmldom/xmldom`.

**All eight are reached through `^` ranges, not one of them.** `ncpdp` declares
`fast-xml-parser: "^5.10.1"`; that package declares its six at `^`; and `strnum` reaches `anynum` at
`^1.0.1`. So every one of them is third-party code **resolved at probe time**, which is the very
criterion this section uses to call the gate's tree wider than anything else in the job. An earlier
draft said "one of them a `^` range", which was literally true and misleading by implication, in the
one passage whose whole subject is range-resolution.

So what the flag bought is a real narrowing, from *every package in the tree as a shell command* to
*every package on the import graph as module-init code*. **It is not a closure.** What that
module-init code can *reach* while it runs is a separate question from whether it runs at all, and
that half was closed on **2026-08-05**, in two independent pieces:

- **The probe child's environment is built from nothing.** `probeChildEnv` in
  `scripts/install-check.mjs` hands it an **allow-list** (`PATH`, `TMPDIR`, locale, `TZ`, the TLS and
  proxy variables, the Windows ones node's own crypto and dns paths read) and nothing else, so the
  whole `npm_config_*` namespace, `NODE_OPTIONS`, `GITHUB_*` and every credential-shaped variable are
  absent rather than blanked. **An allow-list here is not a
  contradiction of the deny-list under [Clean means anonymous, not merely empty](#clean-means-anonymous-not-merely-empty)**,
  where the thing defended against has a
  namespace (`npm_config_*`) and denying the namespace defends against the mechanism. A secret has no
  namespace, so a list of known token names would not cover the next secret a caller adds. `HOME` and
  `USERPROFILE` are moved into the clean room, which takes `~/.netrc` and `~/.npmrc` off the child's
  `~` path, and `os.homedir()` follows both. **A test proves it through the real spawn**, on both the
  ESM and CJS arms, with a sentinel named `A_SECRET_ADDED_TO_A_CALLER_AFTER_THIS_TEST_WAS_WRITTEN` as
  the negative control: the scrub has to hold for a variable no list in this repo has ever seen.

  **Which variable was actually reachable is worth stating exactly, because the first draft of this
  bullet named three that were not.** `NODE_AUTH_TOKEN`, `NPM_TOKEN` and `RELEASE_PR_TOKEN` are set on
  the `changesets/action` **step**, `release.yml` declares no job-level or workflow-level `env`, and
  step `env` does not persist, so none of the three was ever in the probe child's inherited
  environment. What **is** in every step is `ACTIONS_ID_TOKEN_REQUEST_TOKEN` and its URL, present
  because the workflow requests `id-token: write` for npm provenance, and those exchange for a signed
  OIDC token naming the repo. The other two reasons this is a guard rather than hygiene are each one
  line of YAML away: the `setup-node` comment in `release.yml` tells a future maintainer to set
  `NODE_AUTH_TOKEN` at **job** level if a `scope:` input is ever added, and a caller's secret becomes
  job-wide the moment someone hoists an `env:` block to share it between two steps.
- **Both credential files are deleted from disk** by the `Drop the release credentials from disk`
  step, placed immediately after `changesets/action` rather than at the end of the job: `~/.netrc`,
  and `~/.npmrc`, which the action writes with the **raw `NPM_TOKEN` in plaintext** on the publish
  arm, which is the same arm that sets `published == 'true'` and therefore the only arm on which the
  entry probe runs at all. Neither has a consumer past that step: the netrc's only reader is the
  action's own `git push`, and the publish authenticated through the `RUNNER_TEMP` npmrc `setup-node`
  points `NPM_CONFIG_USERCONFIG` at, which outranks `~/.npmrc`. It **warns rather than fails** if a
  removal does not take, on the same axis the docs dispatch turns on: npm has published permanently by
  then, and a red run neither removes the credential nor makes the artifact less correct.

**Neither half reaches inside the `changesets/action` step itself, and that is now the widest window
in this job.** The verify ladder that `prepublishOnly` re-runs there, and any lifecycle script in the
caller's own lockfile-pinned tree, still execute with the token in the environment and both files on
disk. That is unchanged and is not something this repo can fix from here: the action writes them
itself, before its arm switch.

**What no environment scrub can do, stated so it is not mistaken for isolation.** It narrows what
third-party code is *handed*. An absolute path is still an absolute path, `os.userInfo().homedir`
reads the passwd entry and ignores `HOME`, and the caller's checkout is still on disk. What covers a
file at a known absolute path is deleting it, which is why the removal step is the other half of this
rather than a duplicate of it. **What neither covers**, and it is the one credential that is genuinely
in the probe's job environment: `ACTIONS_ID_TOKEN_REQUEST_TOKEN` is still reachable by every other
step in the job, because `id-token: write` is what npm provenance needs. And the removal step is a
best effort with a `::warning` branch, so "everything past it runs with these gone" is the expected
case, not a guarantee the log will not contradict.

**The cost is named rather than waved off, and it cuts both ways.** A real consumer's install *does*
run lifecycle scripts, so (1) the probe **cannot catch** a package whose `postinstall` fails for a
consumer, and (2) more dangerously, `--ignore-scripts` is not merely "skip a hook": `node-gyp rebuild`
is npm's **default `install` script** for anything carrying a `binding.gyp`, so a native dependency is
left **unbuilt** and a `postinstall` that generates files the entry point imports is left unrun. The
install still exits 0, `probeEntryPoints` then fails to load the package, and the verdict becomes
`uninstallable`, which **exits 1 on a release that is fine for consumers**. Given this gate's history
of accidentally redding correct releases, that direction is the one to watch.

**Two more effects on the install tree, since this passage claims to say what the flag changes.**
`optionalDependencies` are no longer **pruned**: npm normally drops an optional dependency whose
install fails, and with the flag its script cannot fail, so it stays. The probe tree is therefore a
**superset** of the consumer tree (`@cosyte/cli@0.0.3` declares eight optional dependencies). And
`prepare` is suppressed for a **transitive** git or hosted dependency, leaving it unbuilt: that is the
same false-red class as `node-gyp` but is **not** gated on `binding.gyp`, so the measurement below
does not cover it. A *direct* git specifier is already refused by `isRegistrySpecifier`; a transitive
one is not. **`bin` linking is not affected** (verified: after an `--ignore-scripts` install of
`cli@0.0.3`, every `node_modules/.bin` entry exists), and `probeEntryPoints` stats the bin target
rather than the link in any case.

**The residuals are empty today, measured rather than assumed:** none of the twelve published
`@cosyte/*` packages declares an install lifecycle script, and every installable tree was walked
(`hl7`/`mllp`/`x12`/`astm`/`dicom`/`terminology`/`deid` 1 package each, `ccda` 2, `ncpdp` 9, and the
widest in the org, `@cosyte/cli` at **111**) with **zero** `preinstall`/`install`/`postinstall` and
**zero** `binding.gyp` anywhere. One nuance for whoever re-runs this and thinks it contradicts:
five packages in `cli`'s tree do declare `prepare` (`content-type`, `eventsource`,
`express-rate-limit`, `ip-address`, `path-to-regexp`), and `prepare` does **not** run for
registry-tarball installs, so the claim stands.
**If a native dependency ever enters any of these trees, this flag becomes a source of red releases and
must be re-decided first.**

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

## The two pre-publish layers

**A gate that fires after an irreversible act cannot gate.** The install gate below is real and it
catches real defects, but it runs after `changeset publish`, so by the time it speaks the version is
on the registry and permanent (ADR 0001). It can report; it cannot prevent. These two run in
`ci.yml`, on every pull request, before anything is published. They live in
[`scripts/prepublish-check.mjs`](scripts/prepublish-check.mjs), unit-tested with no network and no
npm in [`test/prepublish-check.test.mjs`](test/prepublish-check.test.mjs).

| Layer | Input | Default | What it does |
|---|---|---|---|
| **1: manifest** | `run-prepublish-manifest-lint` | **on** | Offline, no npm, no network. `dependencies` / `peerDependencies` / `optionalDependencies` must carry only specifiers a registry can resolve |
| **2: pack** | `run-prepublish-install` | **on** | `npm pack` the tree, install **that tarball** into a clean anonymous directory, load what it declares |

**Layer 1 is on by default because it was measured, not because it feels safe.** Run against all
thirteen callers on 2026-08-05 it produced **zero findings**, `transform` and `synth` included. The
`file:vendor/*.tgz` specifiers that survive in seven repos are all in `devDependencies`, which no
consumer ever installs and which the lint deliberately does not read. It is also the layer that would
have refused `@cosyte/cli@0.0.1`: that tree carried those specifiers in `dependencies` and
`optionalDependencies` at the moment it published, and every other gate read that same tree and passed
it.

**Layer 2 was off by default until 2026-08-05, because turning it on for thirteen repos is a policy
call, not a build.** The mechanism shipped finished and measured, and the flip was held for the call
rather than for more work. It was made on 2026-08-05 and **layer 2 is now on by default.**

The measurement that flip rests on, stated as the dated measurement it is: run against all thirteen
callers on **2026-08-05**, with the default allowance, against the live registry: **11 `pass`, 2
`blocked-peer` (`transform`, `synth`), 0 red.** Both `blocked-peer` results warn and exit 0, so the
flip reds nobody that day. It is not a standing guarantee: the registry is not ours, and a package
that resolves today can stop resolving tomorrow. Re-measure before quoting it forward.

**Nothing to adopt.** As of the flip no caller passes `run-prepublish-install`, and none passes
`expect-unpublished-deps` either, so every caller picks up layer 2 and the default allowance from
here with no change on its side. `transform` and `synth` included: `@cosyte/fhir` is the only
registry-absent dependency **name** either of them carries, and the default allowance already names
it. That is the whole of what the allowance has to cover for them, which is not the same claim as
nothing else being wrong with them. See `blocked-peer` below.

A caller that cannot pay the cost (layer 2 is a full install per run and touches the network on
every pull request) opts **out**:

```yaml
jobs:
  ci:
    uses: cosyte/.github/.github/workflows/ci.yml@main
    with:
      run-phi-scan: true
      run-prepublish-install: false # opt out of layer 2
```

Read what `blocked-peer` does and does not establish before treating those two as explained: it is
**less than "fully explained"**, and the gap is set out under [The verdicts](#the-verdicts) below.

### Turning the layers on made them RUN everywhere. It did not make them BLOCK anywhere

**A default is a property of this repository. Whether a red check stops a merge is a property of the
caller's ruleset, and nothing here can reach it.** The layers run in their own job rather than as
steps inside `verify` (the reason is under [Two things measured while building
it](#two-things-measured-while-building-it-both-of-which-would-have-been-red-pull-requests)), and the
consequence is easy to miss: a separate job is a **separate check-run context**, `ci / prepublish`.
A caller whose ruleset requires the `verify` matrix and `ci / actionlint` does **not** thereby require
this one. It reports a red X on the pull request and the merge button stays green.

That is not a defect in the flip, and it is not fixable from here. It is one line per caller, in that
caller's own ruleset, and it belongs to that repository's own `CI-REQUIRED-CHECKS` pass.

**Censused 2026-08-07 against real `pull_request` check runs, not against workflow names.** Every one
of the thirteen callers emits `ci / prepublish` on its pull requests, as expected now that both
layers default on and no caller passes either input. **Of those thirteen, `cli` is the only one whose
ruleset requires it.** In the rest, a red pre-publish gate is documentation.

Both halves of that are a dated measurement rather than a standing fact, and both are derivable, so
derive them rather than quoting this paragraph forward:

```bash
# What a caller's ruleset actually requires. Nothing in a repository can read its own ruleset, which
# is why this tree states the rule and gives this command rather than naming a required set or a
# count. `includes_parents=true` is the default and matters: repo rulesets compose with org ones.
gh api repos/cosyte/<repo>/rulesets --jq '.[].id' \
  | xargs -I{} gh api repos/cosyte/<repo>/rulesets/{} \
      --jq '.rules[] | select(.type=="required_status_checks")
            | .parameters.required_status_checks[].context'

# What it actually emits. Read the context off the check run, never off the workflow's `name:`.
gh api repos/cosyte/<repo>/commits/<pr-head-sha>/check-runs --jq '.check_runs[].name'
```

**Before adding it to a caller, the same precondition governs as anywhere else:** the context may not
be required until that workflow has completed on the caller's `main`, and requiring it blocks any open
pull request whose branch predates the job until it rebases. That cost is documented, not a defect.

### The declared allowance, and why its entries carry a kind

`expect-unpublished-deps` is the same input `release.yml` takes, in the same grammar. A repo names its
known-unpublished consumer dependencies and the gate asserts **exactly that set**: a named absence is
the expected state and warns, an absence nobody named still fails. Without it, layer 2 reds
`transform` and `synth` for `@cosyte/fhir` (`FHIR-NPM-NAME`), which nobody can fix from those repos,
and a permanently red gate is one people learn to ignore, which is the same failure as a step that
never runs. With an open-ended one you get a mute, which is worse than no gate because it reads as a
gate.

**`@cosyte/assets` and `@cosyte/docs` are `E404` on the registry exactly like `@cosyte/fhir` is, and
they are `private: true` on purpose.** A deliberate absence and an unexplained block must not share
words, so an entry carries a kind:

| Entry | Meaning | Excuses an install failure? |
|---|---|---|
| `name=blocked` | absent for a reason outside this repo's control, and **expected to clear**. `@cosyte/fhir` is the only one today | **yes**, and it is self-clearing |
| `name=private` | absent **by design**, `private: true`, never going to clear | **no, anywhere.** A published package whose dependency will never exist is a permanent defect wearing the same 404 as a temporary one |
| `name` | untagged: the spelling `release.yml` shipped with in `#31` | **yes**, read as `blocked`, and reported as untagged in the step summary so it can be tightened |

**The two gates strip `=blocked` and only `=blocked`, and that asymmetry is load-bearing.**
`install-check.mjs` cannot fail closed on a typo (a red there misreports a permanent release), so
instead an unrecognised or `private` tag stays **attached** to the name, matches no dependency, and
excuses nothing. The first version stripped every tag, which is behaviour-identical for `blocked` and
quietly taught the **post-publish** gate to excuse `private`: measured against the same facts,
`@cosyte/assets=private` gave `uninstallable` before and `blocked-peer` after. `install-check.mjs`
only ever observes packages that published, which is the one place `private` must never excuse
anything.

A **malformed** entry fails, unlike every other failure mode here, which is about the package. This
one is about the thing that *excuses* failures. An unknown kind, an empty name, and **one name
written twice with different kinds** all count: the argument for failing on a typo is that a typo
silently *narrowing* the allowance would be invisible, and de-duplicating on the name alone would
silently *widen* it instead, keeping whichever kind was written first.

### The verdicts

| Verdict | Layer | Exit | When |
|---|---|---|---|
| `pass` | both | 0 | nothing found |
| `not-published` | both | 0 | the manifest declares `private: true`, so there is no consumer install to simulate. Said out loud rather than reported as a pass over something never examined |
| `non-registry-specifier` | both | **1** | a consumer-facing specifier a registry cannot resolve. Deterministic, offline, **never excusable by the allowance** |
| `malformed-allowance` | both | **1** | `expect-unpublished-deps` does not parse |
| `not-built` | 2 | **1** | a declared entry point is absent from the **working tree**. This workflow's mistake, not the package's |
| `not-packed` | 2 | **1** | present on disk and **absent from the tarball**: `files` or `.npmignore` drops something the manifest declares |
| `tooling-in-tarball` | 2 | **1** | the tarball contains this gate's own checkout, so the measurement is contaminated |
| `blocked-peer` | 2 | 0 | uninstallable, and every dependency name the registry does not serve is declared `blocked`. **Not the same as "fully explained"**. See below |
| `inconclusive` | 2 | 0 | the install failed and the registry gave **no usable answer** for a dependency |
| `undeclared-absent-dependency` | 2 | **1** | an absent dependency the allowance does not account for |
| `uninstallable` | 2 | **1** | the install failed with every declared dependency present, or it installed and its entry points do not load |

**`blocked-peer` establishes less than "fully explained", and the gap is `PRE-EXISTING`: the
post-publish gate makes the same claim in the same words.** What is actually established is that every
dependency *name* the registry will not serve is declared. npm short-circuits: measured live, a
package carrying `"@cosyte/hl7": "^99.0.0"` (a range that will never resolve, permanently
uninstallable for every consumer) **plus** a declared blocked peer settles `blocked-peer` and exits
0, because npm gives up on the `@cosyte/fhir` 404 and never reports the second defect. A declared
absence therefore masks any other install failure behind it. Not fixed here: closing it means
installing with the blocked names excised, which is a different probe from the one a consumer runs.

**`not-built` and `not-packed` are two verdicts on purpose.** From the tarball alone, "you forgot to
build" and "your `files` field drops `dist`" are the same absence; from the tarball *and* the working
tree they are distinguishable, and only the second is a defect in the package. Collapsing them would
report a mistake in this workflow's step ordering as a packaging bug in thirteen repos.

### It fails closed, which is the opposite of the gate below

`install-check.mjs` fails **open** on everything ambiguous and on any crash, because a red there
misreports a release that already happened and cannot be withdrawn. **The axis flips here.** Nothing
irreversible has happened, a red pull-request check costs a re-run, and a pre-publish gate that
swallowed its own crash would be a gate that is not there. So an unexpected throw exits non-zero.

**What does not flip is the treatment of a registry that will not answer.** A 503 on a dependency
packument is not evidence about this package, and reading it as one produces a check that reds on
weather. That stays three-valued and warns, exactly as it does post-publish.

### Two things measured while building it, both of which would have been red pull requests

- **`npm pack --json` does not guarantee that stdout is only JSON.** At `--loglevel error` in this
  org's own trees it emitted `[ERROR], Was not able to set git hooks. Error: ... EACCES ...` ahead of
  the document. `--ignore-scripts` does not stop `prepare`, and `prepare` runs on pack. "Slice from
  the first bracket" is the obvious fix and it is **wrong**: that prefix line starts with `[`. The
  parser scans every bracket, extracts a **balanced, string-aware** span rather than slicing to the
  end of the buffer, and takes the first document that names a tarball, so noise after the document
  and a prefix with no trailing newline are both survivable. This gate fails closed, so a parse
  failure here is a red pull request on a good package.
- **Layer 1 is stricter than reality for one shape, and it is default-ON, so it is stated here rather
  than left to be discovered.** It refuses `workspace:` and `catalog:`, which pnpm **rewrites to a
  real range at pack time**, so a working tree carrying one is not necessarily a defect the way a
  published manifest carrying one is. Latent today: **none of the thirteen callers is a pnpm
  workspace** (`config`, `docs`, `website` and `pathways` are, and none of them calls this workflow).
  The first caller to adopt one gets a false red. Fix it then, by reading the packed manifest rather
  than the working-tree one. Do not soften the rule, which is what makes it deterministic.
- **The layers run in their own job, not as steps in `verify`.** They need a checkout of this repo for
  the script, `actions/checkout` refuses a path outside `GITHUB_WORKSPACE`, and a second tree inside
  the caller's workspace is visible to `pnpm lint`, `pnpm format:check` and `pnpm phi-scan`.
  **`ccda`'s PHI scanner walks from the repo root.** Putting it in `verify` would have one gate
  seeding files inside another gate's scan roots. Belt and braces: layer 2 refuses a tarball that
  contains the tooling checkout (`tooling-in-tarball`) rather than trusting every caller's `files`
  field to keep it out.

## The post-publish install gate

**Nothing in this pipeline had ever installed what it published.** Every other gate reads the working
tree or a locally packed tarball, where the monorepo's own resolution is in scope and every sibling is
a directory on disk. None of them asks the question a consumer asks: take the name and the version,
from the registry, in a directory that knows nothing, and install.

A manifest can be valid locally and meaningless remotely, and this org has shipped that three times:

| Package | What the registry serves | What a consumer gets |
|---|---|---|
| `@cosyte/cli` `0.0.1` and `0.0.2` | four `file:vendor/*.tgz` dependencies plus six more in `optionalDependencies` | `ENOENT` on `node_modules/@cosyte/cli/vendor/cosyte-fhir-0.0.0.tgz`. Both versions are permanent and stay broken forever (ADR 0001) |
| `@cosyte/transform` `0.0.5` | a required peer on `@cosyte/fhir` | `E404`, because `@cosyte/fhir` is not on the registry (`FHIR-NPM-NAME`) |
| `@cosyte/synth` `0.0.6` | the same peer, marked **optional** in `peerDependenciesMeta` | `ERESOLVE`. An optional peer whose packument 404s still fails the tree. **Optionality is not protection** |

[`scripts/install-check.mjs`](scripts/install-check.mjs) closes it, unit-tested in
[`test/install-check.test.mjs`](test/install-check.test.mjs) with no network and no npm, against
fixtures transcribed from the live registry. Run it by hand against anything published:

```bash
node scripts/install-check.mjs --package @cosyte/hl7 --version 0.0.7
node scripts/install-check.mjs --package @cosyte/cli --version 0.0.1 --expect-unpublished-deps "@cosyte/fhir"
```

### Clean means anonymous, not merely empty

The probe directory sits under `RUNNER_TEMP`, which is not a parent of the workspace, so npm's upward
walk finds no sibling `node_modules`. It gets its own `package.json` so the walk stops there, its own
cache so nothing is served warm, and **empty user and global npmrc files** so the install is exactly
what an anonymous outsider gets. That last one is not cosmetic: `setup-node` writes an `_authToken`
into the job's npmrc, and installing with it would mask a package accidentally published private.

**The whole `npm_config_*` namespace is stripped from the inherited environment, in both cases.** An
earlier version set only the lowercase `npm_config_userconfig`, and `actions/setup-node` exports the
**uppercase** `NPM_CONFIG_USERCONFIG` job-wide, which **wins in both insertion orders** (measured on
npm 10.9.8). So the probe was loading the job's authenticated npmrc while claiming to be anonymous. It
was benign only by accident of a second line blanking `NODE_AUTH_TOKEN`, and that accident is one edit
away from arming: the `setup-node` comment in `release.yml` already tells a future maintainer to set
`NODE_AUTH_TOKEN` at job level if a `scope:` input is ever added. Stripping the namespace rather than
overriding the two names known to matter is the difference between defending against a list and
defending against the mechanism.

**That environment is the *install* child's, and only its.** The entry probe's child gets a different
and stricter one, `probeChildEnv`, because with `--ignore-scripts` the install runs npm and nothing
else while the probe runs third-party module-init code. Why that one is an allow-list where this one
is a namespace deny is in [What it does not narrow](#what-it-does-not-narrow), which owns it.

Two npm behaviours that each cost a measurement, recorded so they are not rediscovered:

- Pointing `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` at the **same file** makes npm abort
  with `double-loading config ... as "global", previously loaded as "user"`. They must be two files.
- **`npm install` has no stable failure exit code.** `@cosyte/cli@0.0.1` exits **254** where
  `transform` and `synth` exit **1**. Only zero versus non-zero is load-bearing anywhere in the script.

### The verdicts

| Verdict | Exit | When |
|---|---|---|
| `pass` | 0 | installed from the registry into a clean anonymous directory, and everything it declares loads |
| `non-registry-specifier` | **1** | the manifest **the registry serves** carries a specifier that cannot resolve from a registry. Deterministic, offline, no retry, and **never excusable by the allowance** |
| `uninstallable` | **1** | a clean install failed, the budget is spent, the registry **answered** for every dependency declared, and the allowance still does not explain it; or it installed and its declared entry points do not load |
| `blocked-peer` | 0 | uninstallable, and **fully** explained by dependencies declared in `expect-unpublished-deps` |
| `not-propagated` | 0 | the registry never served the version within the budget |
| `inconclusive` | 0 | the install failed and the registry gave **no usable answer** for a dependency, so the failure cannot be attributed |
| `deadline-exceeded` | 0 | the gate ran out of its own time budget before settling a verdict, so nothing is asserted either way |

The specifier lint is evaluated **first and independently of the install**, and that ordering is the
point rather than a detail. `@cosyte/cli@0.0.1` has both `file:` specifiers **and** a genuinely blocked
`@cosyte/fhir`. Classified after the install, the allowance would have excused a package that is broken
for a completely different and permanent reason.

### Why it can fail the run, when the docs dispatch one line above cannot

The dispatch was deliberately changed to warn, "because by then npm has published permanently and the
release exists, so a red conclusion misreports the artifact and invites a re-run of a job that already
published". That reasoning is right and **it does not reach this gate**:

1. **A failed dispatch meant the artifact was fine** and only a notification was missing. A positive
   finding here means the artifact **itself** is defective: published, permanent, uninstallable. A red
   conclusion is then the most accurate statement available about that release, not a misreport of it.
   The two cases sit on opposite sides of the single axis the precedent turns on.
2. **The dispatch has a backstop and this has none.** `cosyte/docs` rebuilds on any push to its main
   and re-reads every package's latest release, so one later rebuild covers every missed dispatch.
   Nothing anywhere re-checks installability. `@cosyte/cli@0.0.1` was found by a human doing an
   unrelated README sweep days later, and `0.0.2` shipped carrying the identical defect in between.
3. **"Invites a re-run" does not carry the same cost here.** `changeset publish` queries npm and skips
   a version already on the registry, so a re-run cannot double-publish, **unconditionally**. A second
   mechanism usually also applies, that the release step has by then pushed the `v<version>` tag so a
   re-run classifies `already-released` and the publish command is withheld, but it is **not**
   unconditional: this step runs under `!cancelled()` precisely so it still reports when the release
   step failed, and in that case the tag may never have been pushed. The property holds once always,
   and twice in the ordinary case.

**The sticky-issue route was the preferred design and is not available.** Opening an issue needs
`issues: write`, and a called workflow's token can only be equal to or more restrictive than the
caller's. Every caller pins exactly `contents` + `id-token` + `pull-requests` against a repo default of
`contents: read`, so requesting more would be an escalation and GitHub rejects the whole workflow at
startup, one second, no jobs, no logs, for **all thirteen callers at once**. The menu is therefore
exactly {warn, fail}, and a warning on a green run notifies nobody. `release.yml` already writes that
residual down for the dispatch and accepts it there **only** because a backstop exists.

### Fail-closed on proof, fail-open on ambiguity

This runs in the shared pipeline for thirteen packages, so a bug in it must not be able to red a
correct release. It exits non-zero only on a **positive determination**. A network fault, a 5xx, a rate
limit, a malformed response, an npm crash, a timed-out install, and any unexpected throw anywhere in
the script all warn and exit 0.

### The gate owns its own clock, and that is not the step's timeout

`timeout-minutes` on the step is a **failure**: GitHub kills the step and the run goes red. The gate's
own deadline is a **warning**: it stops, says it ran out of time, and exits 0. If the step's timeout
were the only bound, a slow or erroring registry would red a correct, permanent release *through the
very bound added to protect it*.

That is not hypothetical. Measured against a dependency packument returning 503, a **single**
`npm install` took **211 seconds**, because npm retries a 5xx internally before giving up; eight
attempts of that is roughly thirty minutes. So the gate carries `--deadline-ms` (default 540s), and an
attempt is only **started** if its whole install could still finish inside it. Checking merely that the
deadline had not yet passed would let a 180s install begin one second before it and overrun.

**Every registry fetch is bounded too, because `globalThis.fetch` is not.** Node's fetch has no
default request timeout; measured in this gate against a socket that accepts and never answers, a
single unbounded fetch stalls **300.8 seconds**. Since the deadline is only checked *between*
attempts, one attempt holding several stalled fetches could run past the step's `timeout-minutes`
without the guard ever getting a turn. Requests now carry `AbortSignal.timeout` (30s default), and the
dependency sweep, whose length is set by the package rather than by this file (`@cosyte/cli` declares
ten), checks the deadline on each iteration and calls anything it did not reach **unknown**, never
present.

Against a black-hole registry (accepts, never answers) at the **shipped defaults**, the gate exits **0**
with `not-propagated` after **345s**, which is `8 x (30s fetch + 15s wait) - 15s`. An earlier draft of
this paragraph claimed "about two seconds", which was measured at non-default flags and was wrong by two
orders of magnitude at the defaults it was printed next to. The safety property is the same either way,
which is exactly why the number went unchecked: **state the flags with the measurement, or do not state
the measurement.**

The layering: fetch 30s, install 180s, gate deadline 540s, step `timeout-minutes: 15`.

**Write the worst case down before you change any of those numbers.** The deadline admits an attempt
while elapsed is at most 360s, and an admitted attempt then costs at most 3 fetches (90s) plus the
install (180s) plus two entry probes (120s), so **750s against the 900s step bound**. That is a 150s
margin, and **the entry probes run after the deadline check and are never re-checked against it**, so a
third probe or any raised inner bound spends it. Reaching the step's `timeout-minutes` is a killed step,
which is a red run on a publish that already happened: the outermost bound is a backstop that should
never fire. A killed install is
fed back into the retry ladder as an ordinary failure, never as a verdict, and the deadline yields
`deadline-exceeded`, which asserts nothing about the package either way. The one thing the deadline
does **not** launder is a `non-registry-specifier` finding: that lint is offline and complete however
little time was left, so a permanently broken publish still fails.

### The retry wraps the whole attempt, not just our own name

npm's registry is eventually consistent, so an install fired immediately after a publish can 404 a
package that is genuinely there. The naive fix is to poll until our own version resolves, then install
once. That is not enough here, because **this org publishes in waves**: ten packages landed
near-simultaneously on 2026-08-02, and in a wave a package's sibling may have been published seconds
ago and be just as unpropagated. Retrying only on our own name would read a propagating sibling as a
permanently missing dependency and red a correct release.

So the retry wraps the entire attempt, and **every failure the allowance has not already settled spends
the whole budget** before a verdict is taken. Only a failure the allowance fully explains skips it,
because the allowance is a statement that the absence is standing rather than transient.

> **This was wrong in the first implementation and a refuter caught it.** The retry fired *only* when
> an absent dependency was undeclared, so an install failure with **nothing** missing returned
> `uninstallable` on attempt one with the budget untouched. "Nothing missing" is **vacuously true for
> the six packages that declare no consumer dependencies at all**, so for them ordinary propagation lag
> went straight to a red on a permanent release.

What distinguishes "not propagated yet" from "genuinely uninstallable" is not a message, it is **which
oracle is still failing at the end**. The oracles are plain registry HTTP, not `npm view`: a packument
`GET`, a version-manifest `GET`, and a `HEAD` on `dist.tarball`. **All three are asked, and the
packument is not redundant with the version document.** They are separate objects with independent
propagation, and the packument is the one npm resolves a version from, so there is a real window in
which the version document and the tarball are live and the packument still tops out at the previous
version. Believing the version document alone declared a correct release uninstallable.

### There is no safe boolean for "does this dependency exist"

Asking the registry whether a dependency is published has **three** answers, not two, and collapsing
them is what turns a gate into a flake. On a 503:

- reading it as **present** eliminates the explanation for the install failure, so the verdict silently
  becomes "the defect is in this package's own tree", which is a **red**;
- reading it as **absent** invents an excuse the registry never gave.

So the answer is `present` / `absent` / `unknown`, and an unanswered dependency yields `inconclusive`,
which reports and exits 0. **A failure the gate cannot EXPLAIN must not be a failure it CONDEMNS.**

**One known residual, stated rather than left to be discovered.** `classify` tests `unknown` *before*
`missing`, so a single unanswered dependency downgrades a verdict even when the gate already holds
positive proof that a *different*, undeclared dependency is absent. That is a real loss of strength, and
it is deliberately not fixed here: it is only reachable once the sweep has blown the 540s deadline, and a
healthy full ladder measures 2 to 107 seconds. Dependencies already found absent are preserved rather
than erased, and `non-registry-specifier` is unaffected, because attempt 1 is never deadline-checked so
the offline lint always gets one bounded shot.

### The allowance is a dated exception, not a setting

`expect-unpublished-deps` defaults to `@cosyte/fhir` and exists so that `transform` and `synth` do not
red on a condition nobody can fix from those repos. A permanently red gate is one people learn to
ignore, which is the same failure as a step that never runs.

It is an **exact** allowance, not a mute: any absent dependency **not** named in it still fails, so a
new unpublished dependency is still caught. And it is self-clearing. The moment `@cosyte/fhir`
publishes, nothing is absent, the installs simply pass, and the gate reports the entry as **stale** in
the step summary so it gets deleted. **Delete it then; it is not load-bearing.**

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
cap. What refused astm was the internal-identifier rule: `ASTM-UNKNOWN-RECORD-REMERGE` sat mid-clause
in *"Close the two findings `ASTM-UNKNOWN-RECORD-REMERGE` measured, pinned and deliberately did not
fix"*, where lifting it out leaves a sentence that does not parse. **The raise does not change astm's
outcome by one byte**, and the rule that refused it is untouched here on purpose.

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
with several bad changesets names one and hides the rest. Both wedged releases hit it: `dicom`'s run
named the 229 and never reached the changeset at **218**, and `astm`'s second changeset failed a
check its run never got to. Neither actually paid a second recovery round, because both were fixed by
running the pipeline locally instead of resubmitting and reading CI one refusal at a time. **That is
the cost, and it is a cost even when nobody pays it twice:** the tool is only safe to use if you know
not to trust it to tell you everything that is wrong. Collecting all refusals and reporting them
together is a real improvement and a behaviour change in its own right, so it is not folded into the
cap raise.

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
phase`, and in *"…release hardening: the final roadmap phase"* that is the **head noun of "the final
roadmap phase"**. (The published title used an em dash where the colon stands here, which this
repository no longer spells. `test/release-notes.test.mjs` asserts on the real form, built from its
codepoint, and `toHeadline` returns the same headline for both.) `isSafeCut` allows it because a cut at the end of a sentence has nothing on its
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

### An item identifier whose prefix nobody registered

`PROJECT_PREFIXES` is a list of names, and the rule above it strips an identifier only when its first
word is on that list. That works for `X12-75` and `MLLP-10`, which are named after a repo. It does
nothing for an item named after its **defect**: `REFUSAL-MESSAGE-PHI-ECHO`,
`CHANGELOG-PREAMBLE-FUTURE-TENSE`, `PHI-SCAN-RENAME-BLIND-AT-PRECOMMIT`. Every cross-repo item of
that kind mints a first word nobody has ever seen before, so registering them one at a time is a
deny-list, and a deny-list buys exactly one evasion per entry.

**Measured on `@cosyte/x12`, 2026-08-06: `(REFUSAL-MESSAGE-PHI-ECHO)` reached the published release
body, while `X12-*` identifiers in adjacent bullets were stripped correctly, and the gate passed it
by design.**

`UNREGISTERED_ID` reads the shape instead:

> three or more hyphen-joined runs, every run two or more **letters**, no digit anywhere.

That is not the `WORD-N` shape the header of `release-notes.mjs` rules out. `WORD-N` is ruled out
because `SCH-11`, `PID-3`, `MSH-2`, `NM1-03` and `ICD-10` **are** that shape; a digit is what every
segment-field reference has and what no item identifier has, so the two sets are disjoint.

#### It is a DETECTOR ONLY, and that is the whole design

It is in `CONTENT_RULES` and deliberately **not** in `TRANSLATION_RULES`, so it never cuts. The
`(REFUSAL-MESSAGE-PHI-ECHO)` case is now a **hard red at `prepare`**, before npm, with the sentence
quoted; the author rewrites the changeset. There is no position from which a false positive can edit
anything.

**This was the second thing tried, and the first one shipping would have been a serious defect.** A
translating version was built. It cut only where a boundary rule said the sentence survived (head,
tail, whole clause between separators, whole parenthetical) and refused the word-to-word cut. It
measured **clean over every changeset these repos have ever had**: 634 blobs, 64 distinct shape
matches, all 64 item identifiers, and the boundary restriction costing zero. It was refuted anyway,
by constructed input, because **the permitted cuts are exactly where a false positive does its
damage.** Run end to end through the real `prepare` on a real version commit, each of these published
with **exit 0** and no violation reported:

| changeset opening sentence | what the translating version published |
|---|---|
| `Map OBX to observation ONE-TO-ONE.` | `Map OBX to observation.` |
| `The 837 writer is now ALL-OR-NOTHING.` | `The 837 writer is now.` |
| `The reader is now correct END-TO-END.` | `The reader is now correct.` |
| `Round-trip the dataset BYTE-FOR-BYTE.` | `Round-trip the dataset.` |
| `YYYY-MM-DD is now the only accepted date form.` | `Is now the only accepted date form.` |
| `Emit the birthDate (YYYY-MM-DD).` | `Emit the birthDate.` |
| `Fix the header, YYYY-MM-DD, and the timezone handling.` | `Fix the header, and the timezone handling.` |

The first is the sharpest: **the cardinality was the claim**, and the published bullet then asserts
something else as fact on a permanent page. None of these is exotic. `YYYY-MM-DD` is the FHIR `date`
primitive's own form, and ALL-CAPS emphasis is how this org's own markdown is written. **The corpus
contained none of them**, which is the entire lesson, and the same one this repo learned when a
general tail-cut rule was built, measured clean, and withdrawn anyway: *what a rule can reach is not
bounded by what the corpus happens to contain.*

**So the rule may read a shape but may not edit prose on one.** A **name** may be translated, because
the gate knows the token is internal bookkeeping. A **shape** may only be refused, because the gate
merely suspects it. Of the two failure modes only one is recoverable: a refusal costs one changeset
edit before anything is published; a wrong cut is a permanent page saying something the author did
not write, in well-formed prose no gate can see.

#### What detect-only costs

Measured over the same 634 blobs:

| | |
|---|---|
| headlines it rewrites | **0**, and structurally so. It is not in `TRANSLATION_RULES` and cannot rewrite one |
| blobs it newly refuses | **8 of 634**, which are **4 distinct releases** (`mllp`, `ncpdp`, `fhir`, `cli`): a changeset is re-blobbed each time it is edited, so blobs are not the unit anyone pays in |
| of the changesets pending today | **1** (`fhir`), which carries two identifiers in a trailing parenthetical and would put both on a public page |

**And a refusal is not one price.** While the changeset is still **pending** it is one reworded
sentence. At **release** time it is not: `prepare` runs on the version commit, so the "Version
Packages" PR has already merged and consumed the changeset, and the price is the `RECOVERY` procedure
(recover the text from `<version-commit>^`, revert the version commit, reword, let Changesets open a
fresh PR). That is the same ordering trap the release-bullet cap has, it has been paid for real, and
it is why the pending-changeset lint filed below is the thing that actually closes this. The refusal
message now carries `RECOVERY`, which it did not when this rule first shipped: every other content
rule had a translation counterpart that refused earlier, and this is the first that does not.

A trailing `(ITEM-ID)` is this org's own habit, so expect refusals rather than none, and expect them
to name the sentence. **Do not re-propose translating this** without an argument that answers the
seven inputs above by name.

**`PRE-EXISTING`, recorded here because this change makes `RECOVERY` print more often and nobody
should read it as new.** `RECOVERY`'s own text opens *"Nothing has been published"*, and that is a
claim about the **`v<version>` tag proxy**, not about the registry. On a version that published but
was never tagged, both that clause and the instruction to revert the version commit would be wrong
under ADR 0001, which forbids moving a published version backwards. It is on `main` at
`scripts/release-notes.mjs`'s `RECOVERY` constant and was already printed unconditionally from two
other call sites before this change. **Not fixed here**: it is a claim about the tag-versus-registry
proxy that the `already-released` verdict also rests on, and it wants its own item.

**A pre-existing collision the measurement surfaced and does not fix:** `HL7-V2`, `X12-005010`,
`NCPDP-SCRIPT` and `DICOM-RT` are already eaten by the **registered** rule, because each opens with a
registered prefix, and `NCPDP-SCRIPT` is a real standard's real name. `PRE-EXISTING`, disclosed in a
test rather than folded into the disjointness claim.

**A silent drift closed alongside it.** `sanitizeInternalDetailed`'s parenthetical branch restated
three of the translation rules by hand, so it was structurally one edit from being wrong, silently
and in the worst direction. It is now derived from `TRANSLATION_RULES`.

#### Not closed here, and filed rather than half-built

A refusal lands **late**: `prepare` runs on the version commit, so it arrives after the "Version
Packages" PR merged and consumed the changeset, which is the expensive recovery under RECOVERY.
Closing that means a lint over the pending `.changeset/*.md` running in `ci.yml`, on the pull request
that introduces the changeset, where the fix is free. That is a new job across thirteen repos and
wants its own census and its own commit; it would also subsume the standing "assert every changeset
against the cap before merging a Version PR" procedure.


### The changelog must carry a section for the version being released

`scripts/changelog-check.mjs`, run by `release.yml` on the publish arm, **before**
`changesets/action`.

**Changesets swallows a failed changelog write with `console.warn`.** `changeset version` does three
things: bumps `package.json`, consumes the changesets, and writes the release section into
`CHANGELOG.md`. Only the third is allowed to fail quietly. When the changelog generator throws (a
declared Prettier config that cannot be resolved is the case that was reproduced) Changesets catches
it, warns, and completes successfully. **The version is bumped, the changesets are gone, and no
changelog is written at all.**

The Version PR then looks ordinary and merges. The publish runs. `@cosyte/<pkg>@<version>` reaches
the registry with a `CHANGELOG.md` inside its own tarball that does not mention `<version>`. Nothing
above catches it: `format:check` reads valid markdown, and `release-notes.mjs` composes the release
body from `.changeset/*.md` and **never opens `CHANGELOG.md`**. The run reports `success`. A
published version is permanent (ADR 0001).

**This is the only step in the pipeline that opens `CHANGELOG.md`**, and it asserts the one fact
none of the others assert.

**It runs before `changesets/action`**, which is what makes it a gate rather than a report: npm is
untouched, so the cost of being wrong is a re-run. It takes the version from the notes gate rather
than re-deriving it, so the two cannot disagree.

#### It decides from the caller's own config, never from a list of repo names

| `.changeset/config.json` | verdict | what it means |
|---|---|---|
| `"changelog": false` | `not-applicable`, exit 0 | the generator is off, `CHANGELOG.md` is hand-maintained, `changeset version` writes no version section **by design** |
| anything else, key absent included | `pass` / `missing-section` | the generator is on, so `## <version>` must be there |
| unreadable or unparseable | `unreadable-config`, exit 1 | fail closed |

Repos move from off to on **one at a time**, so a list of names kept here would be wrong the day
after it shipped, and wrong in the dangerous direction: a repo that has just turned the generator on
is exactly the repo this gate should now be covering. An **absent** `changelog` key reads as **on**,
because that is Changesets' own default; reading it as off would exempt precisely the repo that
configured nothing.

`not-applicable` is **not a claim that the changelog is correct.** It is a claim that this gate does
not govern it, and it says so where it prints.

#### The heading is compared as a whole line, at column 0

Both halves are load-bearing and both come from a measured trap.

**Whole**, because `## 0.0.1` is a **substring** of `## 0.0.10`. An `includes` or `indexOf` over the
heading passes on a repo's first release and reds on its tenth, and four callers are already at or
past `0.0.10`.

**At column 0**, because a changeset summary can quote a version heading, and `getReleaseLine`
indents every continuation line of a summary by two spaces. So nothing inside a release section
starts at column 0, which makes column 0 a sound test for "the generator wrote this" and makes a
trimmed comparison an unsound one. A gate satisfied by an author quoting the string it looks for is
not a gate.

#### Blast radius, measured 2026-08-06

**Zero of thirteen callers go red.** Seven have the generator on (`hl7`, `mllp`, `ccda`, `ncpdp`,
`transform`, `deid`, `synth`) and six off. Twelve are already tagged at their current version, so
`is-release` is `false` and the step is skipped entirely; the thirteenth, `fhir`, is `is-release ==
true` and has the generator **off**, so it reports `not-applicable` and exits 0. **That is a dated
measurement, not a standing guarantee**: it is re-derived by running the script against each
caller's tree at its `package.json` version.

The residual worth naming: for a repo that has just turned the generator on, **the first release
after the flip is the first one this gate governs**, and its version section is written by the very
`changeset version` call this gate exists to check. That is the intended coverage, not a gap.

## What gates this repository itself

Everything above is what this repository does **to** thirteen other repositories. This is what holds
it, and it matters more than its size suggests: `release.yml` and `ci.yml` are called at `@main`, so
a mistake here reds thirteen repositories at once with no version to pin back to.

[`.github/workflows/self-check.yml`](.github/workflows/self-check.yml) is the gate. A reusable
`workflow_call` workflow does not run on push by itself, so without this the YAML in this tree would
be unlinted until a caller broke. It has two jobs, and **the job id is the check-run context name**,
which is the only name a ruleset can be given:

| Job | What it covers |
|---|---|
| `actionlint` | every workflow in this tree, with `shellcheck` on the `run:` bodies |
| `scripts` | the unit suite for `scripts/`, `node --test` over `test/*.test.mjs`, zero dependencies |

**Both are safe to require, and both are meant to be required.** Neither reads a
pull request's title or body, so neither can be reddened by prose an outside author wrote, which is
the whole reason `no-emdash-messages` below must never be required. Run them locally with `actionlint`
and `node --test "test/*.test.mjs"`; there is no `pnpm` script because this repository has no
`package.json`, which is also why the suite is Node builtins only.

**`scripts` sat un-required for a stretch, and the recorded reason for that was wrong.** It was read
as a path-conditional job because it appeared on some open pull requests and not others. It is not
conditional and never was: there is no `paths:` filter and no job-level `if:`. The job was simply
**added after those branches already existed**, so it had never run on them, and a required context an
open branch cannot emit strands that branch. Same conclusion at the time, different cause, and the
difference is what made the state reversible: nothing had to change in the workflow, only the fact
that every current branch now carries the job. That was checked on 2026-08-07 by reading `scripts` off
the real `pull_request` check runs of every then-open pull request, rather than inferred from the
absence of a filter.

**The procedure for requiring one, wherever the job lives.** The precondition is that the workflow
emitting the context has **completed on `main`**; requiring one that has never run leaves every pull
request pending and unmergeable with nothing saying why. Then confirm on real `pull_request` check
runs that the job appears on pull requests that did not add it, fold the entry into the single
`ci-required-checks` ruleset rather than adding a second one, and pin it to `integration_id: 15368`
the way the existing entries are. An unpinned context can be satisfied by **any** app, which is a hole
rather than a convenience. Expect the price: requiring a new context blocks any open pull request
whose branch predates the job until it rebases.

**Do not write down which contexts are required.** Nothing inside a repository can observe its own
ruleset, so any list or count here goes stale the next time this workflow grows a job, and only a
comment defends it. Derive it:

```bash
gh api repos/cosyte/.github/rulesets/19990161 \
  --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks'
```

### Two ways a required job stops gating without anyone touching a ruleset

Two that are guarded, not two that exist. Both are silent, and
[`test/self-check.test.mjs`](test/self-check.test.mjs) is what makes them red here rather than
nowhere. Others exist and are not guarded; the bound at the end of this section says so.

**Rename the job id.** A ruleset entry names a string. Rename `scripts` and the entry detaches with
no error anywhere: the old context is required and emitted by nothing, so every pull request sits
**pending**, which is worse than red because nothing says why. Change the job id and the ruleset
entry together, or change neither.

**Narrow what selects the work.** A required job gates its **steps**, not the selection those steps
operate on. `node --test "test/*.test.mjs"` exits 0 just as happily over one file as over all of
them, and the context is green either way. So the glob is read out of the workflow and compared
against the test files actually on disk, and a plausible narrowing is exhibited as a failing case
rather than asserted to be catchable. The same hazard has a second door: splitting a step out into a
job nobody requires un-requires that step, silently.

A third is now refused rather than merely absent: a `paths:` filter, and an `if:` on either job. **A
context that does not run on every pull request cannot gate every pull request.**

The bound, named rather than chased: that test file is not a YAML parser and must not become one.
There is no dependency here to parse YAML with, by design. It reads the workflow as text, anchored on
indentation, which is enough to catch a rename, a narrowing and a new job-level conditional, and
**not** enough to catch every way a step can be neutralised from inside the job, nor a restructuring
its anchors no longer locate. The restructuring case is made to red rather than pass quietly, which is
the failure mode of every text-anchored assertion ever written. The rest is an open hole, stated
rather than closed: closing it is a rule per step attribute, and a guard that grows one rule per
spelling is the shape this ecosystem deletes rather than hardens.

## The em-dash gate

Founder directive 2026-07-24: cosyte never uses the em dash. Not in a file, not in a commit message,
not in a pull-request title or body. [`scripts/check-no-emdash.mjs`](scripts/check-no-emdash.mjs)
enforces it, [`.github/workflows/no-emdash.yml`](.github/workflows/no-emdash.yml) runs it, and
[`test/check-no-emdash.test.mjs`](test/check-no-emdash.test.mjs) proves it still bites. Run it
locally with `node scripts/check-no-emdash.mjs`; there is no `pnpm` script because this repository
has no `package.json`, which is also why the gate is Node builtins only.

**It landed with its sweep, in one commit.** 98 literal occurrences across 19 of the 45 tracked
files, plus 5 JavaScript escapes, rewritten in the same change. A gate landing before its sweep reds
`main` on arrival; a sweep landing before its gate grows the character back on the next session.

**The sweep changed comments and human-readable strings only, and that restriction is specific to
this repository.** Thirteen repos call these workflows at `@main`, so a mistake in the YAML reds
thirteen repos at once, and a required job gates all of its steps, so renaming a job id detaches any
ruleset entry naming it without error. Every workflow and `dependabot.yml` was verified to parse to a
byte-identical tree before and after: no job id, step, condition, `run:` body, `uses:` ref or input or
output name moved. **Keep that discipline when you fix a red here.**

**One trap measured during that sweep, because it is the exact shape a careless fix takes.** A colon
is the usual replacement for an em dash, and an unquoted YAML plain scalar cannot contain one
followed by a space. Rewriting an issue-form `label:` value that way produces a file that no longer
parses, on a surface every repository in the org inherits without asking. Inside a block scalar (`|`)
a colon is fine. Use a comma when you are not sure.

### Two jobs, and only one of them may ever be required

`no-emdash` scans tracked files and tracked filenames. Nothing outside this repository can put an em
dash into one, so it is safe to require and it should be required.

`no-emdash-messages` scans the pull-request title, body and commit range, which is the half no local
pre-commit hook can see: a new file is untracked so a scan of the index misses it, and nothing local
sees a PR body at all. **It must never be a required context.** Dependabot composes a PR body by
pasting the dependency's upstream release notes into it, em dashes included, and `dependabot.yml`
keeps a standing weekly `github-actions` schedule here, so such a pull request arrives on someone
else's clock indefinitely. (Stated as the configuration rather than as a count of open pull
requests, which goes stale between sessions.) Requiring it would block a dependency bump on prose
nobody here wrote.
Nor is an actor `if:` a fix.

Making `no-emdash` required has a precondition rather than a date: a context may not be required
before its workflow has completed on `main`, or every PR sits pending and unmergeable with nothing
saying why. Read the context name off a live check run, never off a workflow's `name:`. The current
state is derivable rather than quotable:

```bash
gh api repos/cosyte/.github/rulesets/19990161 \
  --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks'
```

### Nothing is exempt, and that is a strengthening

Sibling copies of this gate partition the tree into "scanned" and "declared binary", because they
track vendored `.tgz` archives where a DEFLATE stream can hold the three bytes by coincidence. This
repository tracks no binary and keeps no changelog archive, so there is no partition and no skip
path: every tracked file is read in full, `scanned` always equals `git ls-files`, and a `binary`
attribute is refused rather than honoured.

That matters because a refuter defeated the sibling's partition twice with a one-line path exclusion:
first by accounting the skipped paths into the declared-binary bucket so the arithmetic balanced,
then, once that was closed, by routing the identical exclusion through the scanned bucket, leaving
every asserted field byte-identical to an honest run. With no skip path there is no bucket to route
anything into, and the test suite recomputes the total bytes read **independently**, from
`git ls-files` plus `statSync`, because an in-script invariant is satisfied by the same edit that
breaks it. Both mutations are pinned as test cases rather than described.

**The bound, named rather than chased:** the gate and its tests are both files a mutator is editing,
so a mutation that ACCOUNTS for a file without reading it still passes with the suite green: the
cheapest one takes each path's `statSync` size, adds it to both totals, and skips the read, so every
number reconciles. No assertion inside a repository closes that class, only raises its cost. It is
now a block that measures a file in order to avoid opening it, which is visibly incoherent in
review. That is the stopping point, and the reason not to add a fourth rung chasing it.

### Known limits

- It matches U+2014 as UTF-8, plus the percent-encoding, the three HTML character references, and
  both JavaScript escapes. An em dash in some other charset (a CP1252 `0x97` fixture, a UTF-16
  document) scans clean. There is none today.
- The PCRE source spelling of the codepoint is deliberately **not** banned. It is how a PCRE-based
  scanner names this codepoint, and `test/fixtures/hl7-v0.0.2/changeset/emdash-ci-gate.md` carries
  one inside a code span: that fixture is a real captured changeset and its bytes are the input a
  release-notes test asserts on.
- `scripts/release-notes.mjs` and `scripts/release-diff.mjs` build their dash constants with
  `String.fromCodePoint` rather than a JavaScript escape. Those constants are operative, since the
  release-notes gate refuses a release body containing an em dash and has to be able to name the
  character. Assembling it keeps the ban total without exempting the one file that enforces it. **Do
  not answer a red here by adding an exclusion; assemble the spelling instead.**
- This repository has no `documentation/agent-notes.md`, so the agent-instruction contract gate some
  siblings run has nothing to check here. That is a stated absence, not a missing file to create.

See the meta-repo `documentation/conventions.md` for the engineering standard these enforce.
