### What deliberately does not follow here

- **`ci.yml`'s behaviour is unchanged.** The settled fact may well argue for taking the input away,
  or for callers requiring something unskippable instead, but thirteen repositories call this
  workflow at `@main` and that is a policy change with an org-wide blast radius. It belongs to its
  own change with its own census, not to the investigation that measured it. The only edit made to
  `ci.yml` here is a comment at the input naming the consequence.
- **No context list and no count is written by this change.** Nothing in a repository can observe its
  own ruleset, so any list goes stale the next time a workflow grows a job, silently and with nothing
  to catch it. That is stated as what this change does rather than as a property of the repository.
  **The older count this measurement disproved lived in `test/install-check.test.mjs`. It was named
  here and left alone for its own change; that change has since landed, and it DELETED the claim
  rather than correcting it.** Deleting is the remedy to reach for every time, because a corrected
  count is still a count and rots on the same clock. Derive the live answer instead, either folded,
  which accounts for an org-level ruleset by construction:

  ```bash
  gh api repos/cosyte/<repo>/rules/branches/main \
    --jq '.[] | select(.type=="required_status_checks")
                | .parameters.required_status_checks[].context'
  ```

  or per ruleset, where `includes_parents` defaults to true and is worth passing anyway so a reader
  can see it was accounted for:

  ```bash
  gh api 'repos/cosyte/<repo>/rulesets?includes_parents=true' --jq '.[].id'
  gh api repos/cosyte/<repo>/rulesets/<id> \
    --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks'
  ```

- **No gate was built.** There is nothing here for one to check. `ci.yml`'s condition is deliberate,
  and the thing that would need guarding is each caller's ruleset, which no code in a repository can
  see. A CI job that reads the ruleset over the API is specifically **not** the answer until someone
  answers the flakiness question first: the anonymous rate limit is 60 requests per hour and it is
  charged per shared runner IP, so such a gate trades a false green for a flaky red on a required
  context, which is worse.
