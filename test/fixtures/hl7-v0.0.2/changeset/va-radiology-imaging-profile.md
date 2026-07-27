---
"@cosyte/hl7": patch
---

Add `profiles.va`, the eighth built-in vendor profile: VA VistA Radiology/Nuclear Medicine imaging.

It declares the `ZDS` Z-segment that carries the DICOM **Study Instance UID** (field 1, `RP`
composite, the UID sits in the first component, ZDS-1.1 "Pointer"), so a VistA radiology feed parses
without an `UNKNOWN_SEGMENT` warning and `zds.get("studyInstanceUid")` resolves by name. `ZDS` is the
IHE Radiology RIS↔PACS bridge: the same cross-vendor extension `profiles.visage`/`profiles.philips`
declare, not a VA-proprietary quirk; the value this profile adds is a distinct **named federal source**
plus coverage of the shape the VA spec documents that the imaging-vendor specs do not: `ZDS` on **ORU**
(result) messages (VistA sends `ZDS` in both ORM and ORU). Grounded in the publicly published
Radiology/Nuclear Medicine 5.0 HL7 Interface Specification (Version 3.6, Patch RA*5.0*203, June 2024,
U.S. Department of Veterans Affairs), which documents "ZDS Segment Fields in ORU and ORM", not an
invented quirk (ADR 0018). The spec's messaging is HL7-native v2.4, so the profile adds no custom date
formats. Ships a synthetic, PHI-scanned `vendor-shapes/va/oru-r01.hl7` fixture. Additive only:
existing profiles, warning codes, and the parse/serialize surface are unchanged.
