### It refuses rather than publishing something it cannot stand behind

There is no `continue-on-error` and no `|| true` on any step, the same rule the em-dash gate states,
and every refusal below is a red run on this repository that publishes nothing:

- **A name that already exists.** Never deleted, never force-updated, never pointed at another
  commit. Someone decides by hand what that existing reference is.
- **An interface it cannot read.** Node ships no YAML parser and this repository has no
  `package.json` to add one to, so `reference-publish.mjs` carries a narrow reader that recognises
  the shapes these six files use and refuses, naming the workflow and the line, on anything else.
  That asymmetry is the design: a reader that refuses on an unfamiliar shape cannot silently miss a
  caller-affecting change, and a permissive one can. That includes anything indented under a value
  that already ended on its own line: a plain scalar wrapped onto a second line is legal YAML that a
  line-oriented reader would truncate to its first line, which would turn a changed input `default:`
  or a changed job `name:` into a note reporting that nothing changed. **If you add a shape it does
  not know, widen the reader and pin the new shape as a test; do not loosen it.**
- **An earlier reference it cannot read**, because the comparison the note owes a caller cannot be
  made against it.
- **A note it cannot compose.** Neither the note nor the reference is published: a reference without
  its note is one nobody can adopt safely. The tag and its note are created by **one**
  `gh release create` call for that reason, rather than a tag first and a note second.
- **A shallow checkout, or a release on GitHub whose tag is not in the checkout.** Reading "no tags"
  as "nothing has ever been published" would mint a second name for a state that already has one.
- **A publish whose outcome it cannot read back**, including a tag that turns out to name a different
  commit. Nothing is reported as published, and nothing is deleted to make room for a retry.
- **A denied permission**, named as `contents: write` rather than reported as a generic failure.
