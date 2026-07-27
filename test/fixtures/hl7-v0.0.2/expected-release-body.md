### What changed

- Add conformance-profile tooling: `validateAgainstProfile`.
- Add the FHIR-bridge IR-stability contract + coverage proof.
- Re-ground `profiles.meditech` to a publicly downloadable MEDITECH interface specification.
- Add a performance / throughput bar: reproducible benchmark suite + a ratio-based perf-regression guard.
- Add `profiles.philips`, the seventh built-in vendor profile: Philips Vue PACS ("IS Link") imaging.
- Add streaming / incremental parse: `parseStream`.
- Add formatted-text rendering + a first-class text codec.
- Add typed emit symmetry: composite setters + `buildAdt` / `buildOru`.
- Add `profiles.va`, the eighth built-in vendor profile: VA VistA Radiology/Nuclear Medicine imaging.
- Add `profiles.visage`, the sixth built-in vendor profile: Visage 7 imaging/PACS.

Full detail for each change is in [`CHANGELOG.md`](https://github.com/cosyte/hl7/blob/main/CHANGELOG.md).

### Install

```bash
npm install @cosyte/hl7@0.0.2
```

**npm:** https://www.npmjs.com/package/@cosyte/hl7/v/0.0.2
