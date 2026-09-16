## The two pre-publish layers

**A gate that fires after an irreversible act cannot gate.** The install gate below is real and it
catches real defects, but it runs after `changeset publish`, so by the time it speaks the version is
on the registry and permanent (ADR 0001). It can report; it cannot prevent. These two run in
`ci.yml`, on every pull request, before anything is published. They live in
[`scripts/prepublish-check.mjs`](../scripts/prepublish-check.mjs), unit-tested with no network and no
npm in [`test/prepublish-check.test.mjs`](../test/prepublish-check.test.mjs).

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
    uses: cosyte/.github/.github/workflows/ci.yml@workflows-YYYY-MM-DD-COMMIT
    with:
      run-phi-scan: true
      run-prepublish-install: false # opt out of layer 2
```

Read what `blocked-peer` does and does not establish before treating those two as explained: it is
**less than "fully explained"**, and the gap is set out under [The verdicts](#the-verdicts) below.

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
