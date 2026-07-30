![cosyte](https://cosyte.com/tile/cosyte-lockup-tile-on-light-1200x300.png)

# cosyte

**Open-source parsers and tooling for healthcare data** (HL7 v2, C-CDA, X12 EDI, DICOM, NCPDP, ASTM,
and FHIR), written in strict TypeScript for Node.js. Lenient on parse, spec-clean on emit, with a bias
toward *never silently mis-reading* a dose, a code system, or a patient identifier.

## Published on npm

Installable today, pre-alpha, on the `0.0.x`-until-first-alpha ladder.

**Parsers, plus the MLLP transport for HL7 v2:**

| Package | What it does |
|---|---|
| [`@cosyte/hl7`](https://www.npmjs.com/package/@cosyte/hl7) | HL7 v2 messages: parse, build, validate, stream |
| [`@cosyte/mllp`](https://www.npmjs.com/package/@cosyte/mllp) | MLLP transport for HL7 v2: client + server, framing, ACK correlation, TLS |
| [`@cosyte/dicom`](https://www.npmjs.com/package/@cosyte/dicom) | DICOM Part 10: metadata, routing keys, PS3.15 de-identification |
| [`@cosyte/x12`](https://www.npmjs.com/package/@cosyte/x12) | ASC X12 EDI: HIPAA 005010 (837 / 835 / 271 / 834 / 999 / …) |
| [`@cosyte/ccda`](https://www.npmjs.com/package/@cosyte/ccda) | C-CDA R2.1: parse, build, and edit clinical documents |
| [`@cosyte/ncpdp`](https://www.npmjs.com/package/@cosyte/ncpdp) | NCPDP: SCRIPT ePrescribing + Telecom pharmacy claims |
| [`@cosyte/astm`](https://www.npmjs.com/package/@cosyte/astm) | ASTM lab instruments: E1394 records + E1381 framing |

**Built on the parsers,** not parsers themselves:

| Package | What it does |
|---|---|
| [`@cosyte/terminology`](https://www.npmjs.com/package/@cosyte/terminology) | Terminology engine: `$lookup` / `$validate-code` / `$translate` / `$expand` over code systems you supply |
| [`@cosyte/transform`](https://www.npmjs.com/package/@cosyte/transform) | HL7 v2 → FHIR R4, grounded in the official v2-to-FHIR implementation guide |
| [`@cosyte/synth`](https://www.npmjs.com/package/@cosyte/synth) | Deterministic, seedable synthetic test data across six formats, never real PHI |
| [`@cosyte/cli`](https://www.npmjs.com/package/@cosyte/cli) | The `cosyte` command + MCP server, for the terminal or an LLM |

```bash
npm install @cosyte/hl7
```

## Also in the suite

Public and in active development, not yet on npm:

- [`fhir`](https://github.com/cosyte/fhir): FHIR R4 toolkit with a safety-critical status / negation model
- [`deid`](https://github.com/cosyte/deid): HIPAA-grounded de-identification policy engine, fail-closed

Shared CI/CD and toolchain config live in [`.github`](https://github.com/cosyte/.github) and
[`config`](https://github.com/cosyte/config).

## What we care about

- **Correct, not merely green.** Healthcare data is safety-critical; a parser that silently
  mis-reads a value can harm someone. Conformance is graded against the standard, not the test suite.
- **PHI-safe by default.** Synthetic-only fixtures, redaction in logs, no realistic PHI in the repos.
- **Near-zero dependencies**, dual ESM/CJS, strict TypeScript, one enforced toolchain across the suite.

---

Learn more at **[cosyte.com](https://cosyte.com)** · developer docs at **[docs.cosyte.com](https://docs.cosyte.com)**

*Pre-alpha and pre-launch: APIs may change before the first alpha.*
