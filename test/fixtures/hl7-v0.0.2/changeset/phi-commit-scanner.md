---
"@cosyte/hl7": patch
---

Add a repo-side PHI commit-scanner (`scripts/phi-scan.ts`, `pnpm phi-scan`).

A zero-dependency, HL7 v2-shape-aware scanner refuses fixtures (and a conservative text pass over
`src/`) that carry real-looking PHI, so a developer cannot commit a real patient message by accident.
It parses each message's delimiters (`MSH-1` / `MSH-2`) and inspects only the fields that actually
carry each category: patient / person names (PID-5/-6/-9, NK1-2, GT1-3, IN1-16, MRG-7 as XPN;
PV1-7/-8/-9/-17, ORC-12, OBR-16, AIP-3, TXA-9, ROL-4 as XCN), dates of birth (PID-7 / NK1-16), SSNs
(PID-19, CX identifier-type `SS`, and dashed patterns anywhere), MRN / account numbers (PID-3 / -18),
addresses (PID-11 / NK1-4 / …), phones (PID-13/-14 / NK1 without the `555` convention), emails, and a
site-defined `Z…`-segment name backstop, rather than a naive text regex that would trip on coded
values like `CBC^Complete Blood Count^LN`. Synthetic fixtures are declared in
`scripts/phi-allow-list.txt`; a whole-file bypass requires `--allow-fixture` plus an audit entry in
`phi-scan-overrides.md`. Runs at pre-commit (`simple-git-hooks --staged`) and in CI (`run-phi-scan:
true`); `scripts/verify.sh` now reports `phi-scan ✓`. Dev-tooling only: no change to the published
package surface or warning codes.
