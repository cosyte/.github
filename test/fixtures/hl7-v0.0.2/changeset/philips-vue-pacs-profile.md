---
"@cosyte/hl7": patch
---

Add `profiles.philips`, the seventh built-in vendor profile: Philips Vue PACS ("IS Link") imaging.

It declares the six Vue PACS custom Z-segments, one per filler role: `ZDS` (DICOM **Study Instance
UID**, an RP composite whose first component is the UID), `ZLK` (linked studies/orders), `ZAO` (order
additional details: modality, body part, transfer/acquisition status, technician + radiologist,
custom slots), `ZEB` (encrypted patient info), `ZAP` (patient additional details), and `ZAV` (visit
additional details). With the profile, a Vue PACS ORM/ADT feed parses without `UNKNOWN_SEGMENT`
warnings and each field resolves by name. Field positions are transcribed verbatim from the spec,
including its own gaps (`ZAO` has no field 7; `ZAP` has no field 2). Grounded in the publicly
published Vue PACS 12.2.8 HL7 Interface Specifications (Philips, doc HA1669 Rev A, §§5.11–5.16), not
an invented quirk (ADR 0018). Vendor timestamps are HL7-native, so the profile adds no custom date
formats. The profile only *names* fields (so a consumer knows `ZEB` is PHI-bearing); it never decodes
or rewrites them. Ships two synthetic, PHI-scanned fixtures (`vendor-shapes/philips/orm-o01.hl7`,
`vendor-shapes/philips/adt-a08.hl7`). Additive only: existing profiles, warning codes, and the
parse/serialize surface are unchanged.
