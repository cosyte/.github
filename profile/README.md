<a href="https://cosyte.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cosyte.com/tile/cosyte-lockup-tile-on-dark-1200x300.png">
    <img alt="Cosyte: a plus mark set in two overlapping rounded squares, one solid and one outlined, beside the Cosyte wordmark" src="https://cosyte.com/tile/cosyte-lockup-tile-on-light-1200x300.png">
  </picture>
</a>

We build open-source TypeScript libraries for healthcare data: HL7 v2, FHIR, C-CDA, X12, NCPDP, ASTM,
DICOM, MLLP, terminology and de-identification. We also build and run integrations on them.

```bash
npm install @cosyte/hl7
```

```ts
import { parseHL7 } from "@cosyte/hl7";

const msg = parseHL7(raw); // raw: an HL7 v2 message as a string
console.log(msg.patient?.mrn, msg.patient?.fullName); // MRN12345 John Q Doe
```

No segment or field numbers to look up: the parser accepts vendor-quirky messages as they arrive and
hands back fields by name. The [quickstart](https://docs.cosyte.com/hl7/quickstart) runs the same lines
on a synthetic message.

## Libraries

All 14 are MIT licensed and run on Node.js 22 or later.

| Package | What it does | Links |
|---|---|---|
| `@cosyte/hl7` | Parse, build and serialize HL7 v2 messages, and read fields by name | [npm](https://www.npmjs.com/package/@cosyte/hl7) · [docs](https://docs.cosyte.com/hl7/quickstart) · [repo](https://github.com/cosyte/hl7) |
| `@cosyte/mllp` | Send and receive HL7 v2 over MLLP: framing, ACK correlation, reconnects and TLS | [npm](https://www.npmjs.com/package/@cosyte/mllp) · [docs](https://docs.cosyte.com/mllp/quickstart) · [repo](https://github.com/cosyte/mllp) |
| `@cosyte/fhir` | Read, write and validate FHIR R4 resources, in JSON and XML | [npm](https://www.npmjs.com/package/@cosyte/fhir) · [docs](https://docs.cosyte.com/fhir/quickstart) · [repo](https://github.com/cosyte/fhir) |
| `@cosyte/ccda` | Parse, build and serialize C-CDA documents, with typed problems, medications and allergies | [npm](https://www.npmjs.com/package/@cosyte/ccda) · [docs](https://docs.cosyte.com/ccda/quickstart) · [repo](https://github.com/cosyte/ccda) |
| `@cosyte/x12` | Parse and build X12 005010 healthcare transactions (837, 835, 270/271, 834, 999 and more) with exact decimal amounts | [npm](https://www.npmjs.com/package/@cosyte/x12) · [docs](https://docs.cosyte.com/x12/quickstart) · [repo](https://github.com/cosyte/x12) |
| `@cosyte/ncpdp` | Parse and build NCPDP SCRIPT ePrescriptions and Telecom pharmacy claims | [npm](https://www.npmjs.com/package/@cosyte/ncpdp) · [docs](https://docs.cosyte.com/ncpdp/quickstart) · [repo](https://github.com/cosyte/ncpdp) |
| `@cosyte/astm` | Parse and build ASTM E1394 lab-instrument records and E1381 checksummed frames | [npm](https://www.npmjs.com/package/@cosyte/astm) · [docs](https://docs.cosyte.com/astm/quickstart) · [repo](https://github.com/cosyte/astm) |
| `@cosyte/dicom` | Read and write DICOM Part 10 metadata, with metadata-level de-identification (PS3.15 Basic Profile) | [npm](https://www.npmjs.com/package/@cosyte/dicom) · [docs](https://docs.cosyte.com/dicom/quickstart) · [repo](https://github.com/cosyte/dicom) |
| `@cosyte/terminology` | Run FHIR `$lookup`, `$validate-code`, `$translate` and `$expand` over code systems you supply | [npm](https://www.npmjs.com/package/@cosyte/terminology) · [docs](https://docs.cosyte.com/terminology/quickstart) · [repo](https://github.com/cosyte/terminology) |
| `@cosyte/deid` | Apply a HIPAA Safe Harbor policy to HL7 v2, C-CDA, FHIR, X12, NCPDP Telecom and DICOM, failing closed | [npm](https://www.npmjs.com/package/@cosyte/deid) · [docs](https://docs.cosyte.com/deid/quickstart) · [repo](https://github.com/cosyte/deid) |
| `@cosyte/transform` | Convert HL7 v2 messages to FHIR R4, following the HL7 v2-to-FHIR implementation guide | [npm](https://www.npmjs.com/package/@cosyte/transform) · [docs](https://docs.cosyte.com/transform/quickstart) · [repo](https://github.com/cosyte/transform) |
| `@cosyte/synth` | Generate seeded, reproducible synthetic test data in HL7 v2, FHIR, C-CDA, X12, NCPDP and ASTM | [npm](https://www.npmjs.com/package/@cosyte/synth) · [docs](https://docs.cosyte.com/synth/quickstart) · [repo](https://github.com/cosyte/synth) |
| `@cosyte/dates` | Validate and convert healthcare dates without losing precision or guessing a timezone | [npm](https://www.npmjs.com/package/@cosyte/dates) · [docs](https://docs.cosyte.com/dates/quickstart) · [repo](https://github.com/cosyte/dates) |
| `@cosyte/cli` | Parse, validate, convert and redact from the terminal with the `cosyte` command, or from an agent over MCP | [npm](https://www.npmjs.com/package/@cosyte/cli) · [docs](https://docs.cosyte.com/cli/quickstart) · [repo](https://github.com/cosyte/cli) |

## Examples

[cosyte/examples](https://github.com/cosyte/examples) holds runnable end-to-end starters. Every message,
document and image in it is synthetic.

## How we build them

- **Lenient on parse, spec-clean on emit.** Real vendor traffic parses, and each deviation we tolerate
  comes back as a stable warning code.
- **No confident wrong values.** When input contradicts itself, we withhold the value and flag it rather
  than guess. A wrong dose or a missed allergy is the failure we design against.
- **Synthetic data only.** No repository holds real patient data, and the parsers' CI runs a PHI scan on
  every change.
- **Few dependencies.** Most packages have no third-party runtime dependency, and none has more than one.

Need it integrated? [Talk to us](https://cosyte.com/contact).

[cosyte.com](https://cosyte.com) · [docs.cosyte.com](https://docs.cosyte.com)
