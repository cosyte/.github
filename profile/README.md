# cosyte

**Open-source parsers and tooling for healthcare data** — HL7 v2, C-CDA, X12 EDI, DICOM, NCPDP, and
FHIR — written in strict TypeScript for Node.js. Lenient on parse, spec-clean on emit, with a bias
toward *never silently mis-reading* a dose, a code system, or a patient identifier.

## Published on npm

The core parsers are installable today — pre-alpha, on the `0.0.x`-until-first-alpha ladder:

| Package | What it does |
|---|---|
| [`@cosyte/hl7`](https://www.npmjs.com/package/@cosyte/hl7) | HL7 v2 messages — parse, build, validate, stream |
| [`@cosyte/mllp`](https://www.npmjs.com/package/@cosyte/mllp) | MLLP transport for HL7 v2 — client + server, framing, ACK correlation, TLS |
| [`@cosyte/dicom`](https://www.npmjs.com/package/@cosyte/dicom) | DICOM Part 10 — metadata, SOP-class routing, PS3.15 de-identification |
| [`@cosyte/x12`](https://www.npmjs.com/package/@cosyte/x12) | ASC X12 EDI — HIPAA 005010 (837 / 835 / 270-271 / …) |
| [`@cosyte/ccda`](https://www.npmjs.com/package/@cosyte/ccda) | C-CDA R2.1 — parse, build, and edit clinical documents |
| [`@cosyte/ncpdp`](https://www.npmjs.com/package/@cosyte/ncpdp) | NCPDP — SCRIPT ePrescribing + Telecom pharmacy claims |

```bash
npm install @cosyte/hl7
```

## Also in the suite

Public and in active development (pre-alpha, not yet on npm):

- [`fhir`](https://github.com/cosyte/fhir) — FHIR R4 parser with a safety-critical status / negation model
- [`transform`](https://github.com/cosyte/transform) — HL7 v2 → FHIR, IG-grounded
- [`terminology`](https://github.com/cosyte/terminology) — LOINC / SNOMED / RxNorm / ICD / UCUM engine (BYO-data, license-clean)
- [`deid`](https://github.com/cosyte/deid) — de-identification across every format, fail-closed
- [`synth`](https://github.com/cosyte/synth) — deterministic, PHI-safe synthetic test data
- [`cli`](https://github.com/cosyte/cli) — the `cosyte` command + MCP server for the terminal or an LLM

Shared CI/CD and toolchain config live in [`.github`](https://github.com/cosyte/.github) and
[`config`](https://github.com/cosyte/config).

## What we care about

- **Correct, not merely green.** Healthcare data is safety-critical; a parser that silently
  mis-reads a value can harm someone. Conformance is graded against the standard, not the test suite.
- **PHI-safe by default.** Synthetic-only fixtures, redaction in logs, no realistic PHI in the repos.
- **Near-zero dependencies**, dual ESM/CJS, strict TypeScript, one enforced toolchain across the suite.

---

Learn more at **[cosyte.com](https://cosyte.com)** · developer docs at **[docs.cosyte.com](https://docs.cosyte.com)**

*Pre-alpha and pre-launch — APIs may change before the first alpha.*
