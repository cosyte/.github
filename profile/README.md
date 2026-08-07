<a href="https://cosyte.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cosyte.com/tile/cosyte-lockup-tile-on-dark-1200x300.png">
    <img alt="Cosyte: a plus mark set in two overlapping rounded squares, one solid and one outlined, beside the Cosyte wordmark" src="https://cosyte.com/tile/cosyte-lockup-tile-on-light-1200x300.png">
  </picture>
</a>

# cosyte

**Open-source parsers and tooling for healthcare data** (HL7 v2, C-CDA, X12 EDI, DICOM, NCPDP, ASTM,
and FHIR), written in strict TypeScript for Node.js. Lenient on parse, spec-clean on emit, with a bias
toward *never silently mis-reading* a dose, a code system, or a patient identifier.

## Published on npm

Pre-alpha, on the `0.0.x`-until-first-alpha ladder.

**Parsers, plus the MLLP transport for HL7 v2.** Each installs on its own:

| Package | What it does |
|---|---|
| [`@cosyte/hl7`](https://www.npmjs.com/package/@cosyte/hl7) | HL7 v2 messages: parse, build, validate, stream |
| [`@cosyte/mllp`](https://www.npmjs.com/package/@cosyte/mllp) | MLLP transport for HL7 v2: client + server, framing, ACK correlation, TLS |
| [`@cosyte/dicom`](https://www.npmjs.com/package/@cosyte/dicom) | DICOM Part 10: metadata, routing keys, metadata-level PS3.15 de-identification |
| [`@cosyte/x12`](https://www.npmjs.com/package/@cosyte/x12) | ASC X12 EDI: HIPAA 005010 (837 / 835 / 271 / 834 / 999 / …) |
| [`@cosyte/ccda`](https://www.npmjs.com/package/@cosyte/ccda) | C-CDA R2.1: parse, build, and edit clinical documents |
| [`@cosyte/ncpdp`](https://www.npmjs.com/package/@cosyte/ncpdp) | NCPDP: SCRIPT ePrescribing + Telecom pharmacy claims |
| [`@cosyte/astm`](https://www.npmjs.com/package/@cosyte/astm) | ASTM lab instruments: E1394 records + E1381 framing |

```bash
npm install @cosyte/hl7
```

**Tooling that works across the formats,** rather than a parser for one:

| Package | What it does |
|---|---|
| [`@cosyte/terminology`](https://www.npmjs.com/package/@cosyte/terminology) | Terminology engine: `$lookup` / `$validate-code` / `$translate` / `$expand` over code systems you supply |
| [`@cosyte/transform`](https://www.npmjs.com/package/@cosyte/transform) | HL7 v2 → FHIR R4, grounded in the official v2-to-FHIR implementation guide |
| [`@cosyte/deid`](https://www.npmjs.com/package/@cosyte/deid) | HIPAA-grounded de-identification policy engine, fail-closed |
| [`@cosyte/synth`](https://www.npmjs.com/package/@cosyte/synth) | Deterministic, seedable synthetic test data across six formats, never real PHI |
| [`@cosyte/cli`](https://www.npmjs.com/package/@cosyte/cli) | The `cosyte` command + MCP server, for the terminal or an LLM |

Some of these do not install cleanly yet, and it is fair to know before you try: `transform` and `synth`
declare a peer dependency on [`@cosyte/fhir`](https://github.com/cosyte/fhir), which is not on npm yet,
and `@cosyte/cli@0.0.1`'s published manifest points at local tarballs. `terminology` and `deid` install
on their own today.

## Also in the suite

[`fhir`](https://github.com/cosyte/fhir) is public and in active development, not yet on npm: an FHIR R4
toolkit with a safety-critical status / negation model.

Shared CI/CD and toolchain config live in [`.github`](https://github.com/cosyte/.github) and
[`config`](https://github.com/cosyte/config), which publishes six `@cosyte/*` toolchain packages of its
own.

## What we care about

- **Correct, not merely green.** Healthcare data is safety-critical; a parser that silently
  mis-reads a value can harm someone. Conformance is graded against the standard, not the test suite.
- **PHI-safe by default.** Synthetic-only fixtures, redaction in logs, no realistic PHI in the repos.
- **Near-zero dependencies**, dual ESM/CJS, strict TypeScript, one enforced toolchain across the suite.

---

Learn more at **[cosyte.com](https://cosyte.com)** · developer docs at **[docs.cosyte.com](https://docs.cosyte.com)**

*Pre-alpha and pre-launch: APIs may change before the first alpha.*
