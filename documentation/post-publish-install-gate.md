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

[`scripts/install-check.mjs`](../scripts/install-check.mjs) closes it, unit-tested in
[`test/install-check.test.mjs`](../test/install-check.test.mjs) with no network and no npm, against
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
   re-run classifies `already-released` and the publish job never starts, but it is **not**
   unconditional: this step runs under `!cancelled()` precisely so it still reports when the release
   step failed, and in that case the tag may never have been pushed. The property holds once always,
   and twice in the ordinary case.

**The sticky-issue route was the preferred design and is not available.** Opening an issue needs
`issues: write`, and a called workflow's token can only be equal to or more restrictive than the
caller's. No caller grants it, so requesting it would be an escalation and GitHub rejects the whole
workflow at startup, one second, no jobs, no logs, for **all thirteen callers at once**. The menu is
therefore exactly {warn, fail}, and a warning on a green run notifies nobody. `release.yml` already
writes that residual down for the dispatch and accepts it there **only** because a backstop exists.

That mechanism is the same one behind [the caller-side `actions: read`
grant](#the-caller-side-grant-and-it-is-a-prerequisite) the release-environment gate needs. The
difference is not technical, it is that somebody decided to pay for one and not the other:
`actions: read` is a **read** that proves the human gate standing in front of a permanent publish,
and the grant is a one-line change in thirteen calling jobs. `issues: write` is a write that buys a
notifier. Adding a fourth key to `release.yml`'s `permissions:` block is that same decision again,
and `test/install-check.test.mjs` pins the set whole so it cannot be made by accident.

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
