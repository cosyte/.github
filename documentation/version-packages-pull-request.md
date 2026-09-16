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
action's octokit unused there. **Handing it to the `version` job alone is not done**, even though
that is the job whose whole purpose is the Version PR: the action picks its arm from **its own**
reading of the pending changesets, not from the job it is in, so a changeset landing on main between
the two jobs puts the publish job on the version arm. A publish job without the token would then open
a Version PR authored by `GITHUB_TOKEN`, which is the exact trap this credential exists to close. The
exposure is accepted and written down rather than traded for that risk. **What the split did remove
is the other credential**: `NPM_TOKEN` is handed to the environment-held job and to nothing else.

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
