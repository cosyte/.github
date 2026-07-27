---
"@cosyte/hl7": patch
---

Add conformance-profile tooling: `validateAgainstProfile` (HL7-U, Phase U).

hl7 could parse and author messages and flag missing spec-Required segment groups
(`msg.structure`), but it could not answer "does this feed meet _our_ interface
spec?" `validateAgainstProfile(message, profile)` runs a **consumer-authored
declarative conformance profile** (per-segment/field usage (`R`/`RE`/`C`/`CE`/`O`/`X`),
cardinality, length, and value-set binding against a **consumer-supplied** code
list) against a parsed message and returns **typed findings**.

This is the sanctioned functionality-plane replacement for the retired
vendor-corpus arc: the consumer brings the profile and every value set. hl7 ships
**no** vendor/IHE/regulatory profile, **no** bundled code set (no LOINC/SNOMED/ICD/
RxNorm lookup), and makes **no** network call.

Four invariants hold absolutely: the engine **never throws** (a malformed profile
yields `PROFILE_MALFORMED` findings, not an exception: never a silent pass; the
optional `defineConformanceProfile` is a fail-fast authoring gate that _does_
throw `ProfileDefinitionError`); a **valid message yields zero findings**;
**no finding carries PHI**: each names the structural locus (segment / field /
component / repetition / occurrence) and the rule, never the offending value; and
validation is **read-only**. `C`/`CE` presence is not evaluated (no
conditional-predicate language, a documented boundary), which keeps
valid⇒zero-findings airtight.

**"No findings" is explicitly NOT a conformance attestation**: it means no
_declared_ rule was violated, nothing about undeclared parts of the message and
no conformance certification.

New public exports: `validateAgainstProfile`, `defineConformanceProfile`, the
`conformance` namespace, `FINDING_CODES`, `USAGE_CODES`, and the
`ConformanceProfile` / `SegmentRule` / `FieldRule` / `Cardinality` / `UsageCode` /
`ConformanceFinding` / `FindingLocus` / `FindingCode` / `FindingSeverity` /
`ConformanceResult` types. Six additive finding codes: `PROFILE_REQUIRED_ABSENT`,
`PROFILE_NOT_PERMITTED`, `PROFILE_CARDINALITY`, `PROFILE_LENGTH`,
`PROFILE_VALUE_NOT_IN_SET`, `PROFILE_MALFORMED`. Additive: no change to existing
output. Distinct from the parse-profile system (`defineProfile`/`profiles`), which
shapes how a message is parsed. See `docs-content/spec-notes-conformance.md`.
