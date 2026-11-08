<a href="https://cosyte.com/?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=logo">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cosyte.com/tile/cosyte-lockup-tile-on-dark-1200x300.png">
    <img alt="The Cosyte logo on its own white ground: the icon beside the word Cosyte." src="https://cosyte.com/tile/cosyte-lockup-tile-on-light-1200x300.png">
  </picture>
</a>

# Integration that feels like modern software.

Open-source libraries for healthcare's data standards, and the integrations built on them.

<!-- catalog:roster:start: test/package-lists.mjs checks this list against the package catalog. -->

We publish 14 libraries: one for each of 8 standards (HL7 v2, MLLP, FHIR, C-CDA, X12, NCPDP, ASTM,
and DICOM) and 6 built on them (terminology, transform, deid, synth, dates, and cli). They are
written in TypeScript and published to npm on the 0.1 line, the first release line whose public API
we treat as settled. [Pathways](https://github.com/cosyte/pathways) is our integration engine, in
development, built on these libraries.

<!-- catalog:roster:end -->

```bash
npm install @cosyte/hl7
```

Each library installs on its own: swap `hl7` for any name in the table. All 14 are MIT licensed and
support Node.js 22 or later, tested on 22 and 24.

## Libraries

<!-- catalog:table:start: test/package-lists.mjs checks this table against the package catalog. -->

| Package | What it does | Links |
|---|---|---|
| `@cosyte/hl7` | Parse, build, and serialize HL7 v2 messages, and read fields by name (`msg.patient?.mrn`) instead of by position | [npm](https://www.npmjs.com/package/@cosyte/hl7) · [docs](https://docs.cosyte.com/hl7/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-hl7) · [repo](https://github.com/cosyte/hl7) |
| `@cosyte/mllp` | Send and receive HL7 v2 over MLLP: client and server, framing, ACK correlation, reconnects, TLS, and an in-memory transport for tests | [npm](https://www.npmjs.com/package/@cosyte/mllp) · [docs](https://docs.cosyte.com/mllp/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-mllp) · [repo](https://github.com/cosyte/mllp) |
| `@cosyte/fhir` | Read, write, and validate FHIR R4 in JSON and XML, keeping each value exactly as written | [npm](https://www.npmjs.com/package/@cosyte/fhir) · [docs](https://docs.cosyte.com/fhir/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-fhir) · [repo](https://github.com/cosyte/fhir) |
| `@cosyte/ccda` | Parse, build, and serialize C-CDA documents, with typed problems, medications, allergies, and results | [npm](https://www.npmjs.com/package/@cosyte/ccda) · [docs](https://docs.cosyte.com/ccda/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-ccda) · [repo](https://github.com/cosyte/ccda) |
| `@cosyte/x12` | Parse, build, and serialize X12 005010 healthcare transactions (837, 835, 270/271, 834, 999, and more), with typed models and every amount an exact decimal | [npm](https://www.npmjs.com/package/@cosyte/x12) · [docs](https://docs.cosyte.com/x12/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-x12) · [repo](https://github.com/cosyte/x12) |
| `@cosyte/ncpdp` | Parse and build NCPDP SCRIPT ePrescriptions and Telecom pharmacy claims | [npm](https://www.npmjs.com/package/@cosyte/ncpdp) · [docs](https://docs.cosyte.com/ncpdp/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-ncpdp) · [repo](https://github.com/cosyte/ncpdp) |
| `@cosyte/astm` | Parse and build ASTM E1394 lab-instrument records and E1381 checksummed frames | [npm](https://www.npmjs.com/package/@cosyte/astm) · [docs](https://docs.cosyte.com/astm/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-astm) · [repo](https://github.com/cosyte/astm) |
| `@cosyte/dicom` | Read, write, and de-identify DICOM Part 10 metadata (PS3.15 Basic Profile), without decoding pixels | [npm](https://www.npmjs.com/package/@cosyte/dicom) · [docs](https://docs.cosyte.com/dicom/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-dicom) · [repo](https://github.com/cosyte/dicom) |
| `@cosyte/terminology` | Run FHIR `$lookup`, `$validate-code`, `$translate`, and `$expand` over code systems, value sets, and maps you supply | [npm](https://www.npmjs.com/package/@cosyte/terminology) · [docs](https://docs.cosyte.com/terminology/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-terminology) · [repo](https://github.com/cosyte/terminology) |
| `@cosyte/transform` | Turn parsed HL7 v2 messages into FHIR R4 Bundles, with mappings taken from the HL7 Version 2 to FHIR implementation guide | [npm](https://www.npmjs.com/package/@cosyte/transform) · [docs](https://docs.cosyte.com/transform/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-transform) · [repo](https://github.com/cosyte/transform) |
| `@cosyte/deid` | Apply a de-identification policy (HIPAA Safe Harbor by default) to HL7 v2, C-CDA, FHIR R4, X12, NCPDP Telecom, and DICOM metadata, with a manifest that repeats no value | [npm](https://www.npmjs.com/package/@cosyte/deid) · [docs](https://docs.cosyte.com/deid/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-deid) · [repo](https://github.com/cosyte/deid) |
| `@cosyte/synth` | Generate seeded, reproducible synthetic test data in HL7 v2, FHIR R4, C-CDA, X12, NCPDP, and ASTM | [npm](https://www.npmjs.com/package/@cosyte/synth) · [docs](https://docs.cosyte.com/synth/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-synth) · [repo](https://github.com/cosyte/synth) |
| `@cosyte/dates` | Validate and convert healthcare dates without adding precision or guessing a timezone | [npm](https://www.npmjs.com/package/@cosyte/dates) · [docs](https://docs.cosyte.com/dates/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-dates) · [repo](https://github.com/cosyte/dates) |
| `@cosyte/cli` | The `cosyte` command: parse, validate, convert, and redact healthcare data from the terminal, with an MCP server for agents | [npm](https://www.npmjs.com/package/@cosyte/cli) · [docs](https://docs.cosyte.com/cli/quickstart?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=table-cli) · [repo](https://github.com/cosyte/cli) |

<!-- catalog:table:end -->

## Start here

- [Docs and quickstarts](https://docs.cosyte.com/?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=start-docs), one quickstart per library.
- [Examples](https://github.com/cosyte/examples): runnable end-to-end starters. Every message,
  document, and image in them is synthetic.
- [Discussions](https://github.com/cosyte/.github/discussions): the
  [0.1 announcement](https://github.com/cosyte/.github/discussions/70), questions, ideas, and what
  you build with the libraries. Report bugs in each library's own issue tracker.
- [Pathways](https://github.com/cosyte/pathways): our integration engine, in development.
- [cosyte.com](https://cosyte.com/?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=start-site): who we are and what we build.

Need an integration built? See [our integration services](https://cosyte.com/integration-services?utm_source=github&utm_medium=profile&utm_campaign=evergreen&utm_content=hire-us).
