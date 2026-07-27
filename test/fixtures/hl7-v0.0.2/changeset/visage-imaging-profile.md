---
"@cosyte/hl7": patch
---

Add `profiles.visage`, the sixth built-in vendor profile: Visage 7 imaging/PACS.

It declares the `ZDS` Z-segment that RIS/PACS order feeds use to carry the DICOM **Study Instance
UID** (field 1, first component): the IHE Radiology bridge correlating an HL7 order to its DICOM
study. With the profile, an imaging ORM parses without an `UNKNOWN_SEGMENT` warning and
`zds.get("studyInstanceUid")` resolves by name. Grounded in the publicly published Visage 7 HL7
Interface Specification (V23.00, Jun 2026), its ORM^O01 example and ZDS segment table, not an
invented quirk (ADR 0018). Vendor dates are HL7-native, so the profile adds no custom date formats.
Ships a synthetic, PHI-scanned `vendor-shapes/visage/orm-o01.hl7` fixture. Additive only: existing
profiles, warning codes, and the parse/serialize surface are unchanged.
