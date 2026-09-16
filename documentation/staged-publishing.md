## Staged publishing

**A version is permanent the instant it is published.** npm's own policy is that registry data is
immutable and that `package@version`, once used, can never be used again, an unpublish included. Every
gate above this line exists because of that sentence, and all of them run *before* the tarball
exists. Staged publishing adds the one thing none of them could: a reversible moment *after* it.

A version of a package that **already exists on the registry** is now submitted to npm's staging
area instead of being promoted to it. It is uploaded, it is inspectable, and **no consumer can
resolve it**: `npm view <package> versions` does not list it and an ordinary install will not find
it. It becomes real only when a maintainer approves it, by hand, with 2FA.

### What it changes for a maintainer

A release run that used to end with "published" now ends with a job summary saying a version is
staged and waiting. Nothing else about the run changes, and **nothing chases you**: an unapproved
stage is not a pending task somewhere, it is simply a version that never happened. Walk away and the
live registry keeps exactly the versions it already had.

```bash
pnpm stage list @cosyte/hl7          # find it (the run prints its stage id when the tool prints one)
pnpm stage view <stage-id>           # what the registry would serve
pnpm stage download <stage-id>       # the exact bytes, to open locally
pnpm stage approve <stage-id>        # promote it. Prompts for 2FA
```

Substitute `npm` for `pnpm` if your repository publishes through the npm CLI; the run's own output
names which one it used. The npmjs.com **Staged Packages** tab does the same four things.

**CI never approves and never rejects, and that is the design rather than a gap.** npm prompts for
2FA "whether you approve the package in the CLI or on npmjs.com", and this pipeline has no second
factor. Staging is the part a machine may do; deciding is the part it may not. `release.yml` has no
step that promotes or discards a staged version, and `test/staged-publish.test.mjs` asserts that by
running the real script against a fake tool and reading back every argument vector it was handed.

### A first publish is still a one-way door, and the run says so

npm: the package "**already exists** on the npm registry - you cannot stage a brand-new package". So
a package that has never published takes the direct path unchanged and the run raises a **warning**
naming the reason. That is not a degradation to work around; it is the one release of each package
that genuinely cannot be reviewed this way, and it is worth knowing which one it was.

If the registry will not say **whether** the package exists, the run **fails**. Guessing "never
published" there takes the direct arm and burns a version number permanently; guessing the other way
costs a re-run.

### There is no single floor, and a caller below its own one now reds

[`scripts/publish-floor.mjs`](../scripts/publish-floor.mjs) resolves which tool will perform *this*
caller's publish and compares **that** tool against **its** floor, before anything is packed:

| The caller's publish tool | Who actually publishes | Floor that binds |
|---|---|---|
| pnpm 11 and later | pnpm, natively | **pnpm 11.3.0** (`pnpm stage`, added in v11.3.0) |
| pnpm 10 and earlier | the npm CLI, by delegation | **npm 11.15.0 and Node 22.14.0** |
| npm | the npm CLI | **npm 11.15.0 and Node 22.14.0** |

**The obvious implementation is wrong and this is why the table exists.** Asserting `npm --version
>= 11.15.0` and stopping reasons from a call chain that no longer exists: since pnpm 11, `pnpm
publish` is implemented natively and does not delegate to the npm CLI, so on a pnpm-11 caller the npm
bundled with Node governs nothing about the publish. Node 22 bundles npm 10.9.8, which clears neither
npm floor, so that implementation would red every pnpm-11 release in this org for a binary that is
not on their publish path. `test/publish-floor.test.mjs` carries that defect as a named test.

**If your release run now fails with "the publish path is below its staged-publishing floor", the fix
is in your repository, not this one.** The refusal names the version it found and the floor it needs.
Either raise your `packageManager` pin to pnpm 11.3.0 or later, which is a one-line change and needs
nothing else, or move to a Node whose bundled npm is 11.15.0 or later. Nothing here can make that
change for you and nothing here should: a reusable workflow that edited its callers' toolchains would
be a worse problem than the one it solved.

**Every unknown is a refusal.** A tool nobody can name, a tool whose version will not parse, a
registry that answers 503: each fails the run before anything is packed rather than assuming a floor
is met. That is the opposite of the post-publish install gate below, and the difference is the clock.
Here nothing irreversible has happened and a red costs a re-run.

### What a staged run does NOT do

`staged-publish.mjs` never prints the `New tag:` marker `changesets/action` scans stdout for, and the
three steps that key off `steps.changesets.outputs.published` additionally carry an explicit
`mode != 'staged'`. So a staged version gets **no GitHub release**, **no docs rebuild dispatch**, and
is **not fed to the post-publish install gate**. Announcing a release for a version nobody can
install would be a lie on a public surface, and the install gate would spend its whole 540s budget
proving an absence that is expected.

**And there is no fallback.** If staging fails for any reason the run fails with the registry
untouched. A direct publish is permanent, and a failed staging is not evidence that publishing is
what was wanted. That is the one hazard this feature could add and it is the reason the script has a
single argument vector it is able to build.

### Two known limits, stated rather than discovered

- **A staged version leaves no tag, so a re-run stages it again.** `changeset publish` creates the
  `v<version>` tag and the staged path does not publish, so nothing is tagged and the next push to
  `main` sees the same release pending. Re-staging is harmless (nothing reaches the live registry
  either time) but you may find two stage entries for one version. Approve one.
- **A dist-tag other than `latest` is not carried through.** `changeset publish` derives `--tag` from
  prerelease state; the staged path does not, and stages at the default. No caller of this workflow
  uses prereleases today. Fix it here if one starts to.
