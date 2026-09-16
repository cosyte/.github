## The em-dash gate

Founder directive 2026-07-24: cosyte never uses the em dash. Not in a file, not in a commit message,
not in a pull-request title or body. [`scripts/check-no-emdash.mjs`](../scripts/check-no-emdash.mjs)
enforces it, [`.github/workflows/no-emdash.yml`](../.github/workflows/no-emdash.yml) runs it, and
[`test/check-no-emdash.test.mjs`](../test/check-no-emdash.test.mjs) proves it still bites. Run it
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
Nor is an actor `if:` a fix, and **the reason stated here until 2026-08-07 was the wrong way round**.
It does not leave the check pending. A job skipped by a conditional satisfies its required context
(measured in `#46`, see "What a skipped required context does to a merge" above), so requiring this
one behind `if: github.actor != 'dependabot[bot]'` would produce a gate that quietly stops gating on
exactly the pull requests the condition names, while the ruleset goes on listing it as required.
That is worse than not requiring it, because nothing distinguishes it from a gate that ran.

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
