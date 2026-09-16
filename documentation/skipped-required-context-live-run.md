### The live run

`#46` on this repository, head `5381b69`, run `31208484929`. Three shapes were built as a temporary
probe workflow, measured on one real pull request, and the probe was then deleted from the branch, so
what merged carries this section and no workflow. Each context was added to ruleset `19990161` in
turn, pinned to `integration_id: 15368` like every other, and the ruleset was restored afterwards and
verified identical to its pre-measurement snapshot.

| Shape | Check-run `conclusion` | Required during the measurement | Pull request |
| --- | --- | --- | --- |
| A `workflow_call` job behind a job-level `if:` on a false boolean input | `skipped` | yes | `MERGEABLE`, `mergeable_state: clean` |
| A plain job behind a job-level `if:` that evaluates false | `skipped` | yes | `MERGEABLE`, `mergeable_state: clean` |
| A job that RUNS with every step behind an `if:` that evaluates false | `success` | yes | `MERGEABLE`, `mergeable_state: clean` |
| **Negative control:** a required context nothing emits | no check run at all | yes | `BLOCKED`, `mergeable_state: blocked` |

**The negative control is what makes the other three rows mean anything**, and it is the reason this
was worth a live run rather than a reading. `mergeable_state` reports `clean` for a great many
reasons, so a single green measurement proves only that the field was green. Requiring a context
nothing emits flipped the identical pull request to `blocked` and removing it flipped it back, which
establishes that the field is tracking required-check satisfaction here and not something else.

**One precision the documentation glosses and a reader will otherwise get wrong.** The conclusion
string on a conditionally skipped job is literally `skipped`, not `success`. "The job reports
Success" describes how the merge treats it, not what the API returns. Both are visible at once in the
rollup: `conclusion: SKIPPED`, `isRequired: true`, and `statusCheckRollup.state: SUCCESS`.
