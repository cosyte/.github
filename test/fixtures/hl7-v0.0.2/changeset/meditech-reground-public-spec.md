---
"@cosyte/hl7": patch
---

Re-ground `profiles.meditech` to a publicly downloadable MEDITECH interface specification (HL7-I,
ADR 0018).

The profile previously declared a `ZVI` "visit info" Z-segment (`visitReason`/`admitSource`) that
was a community-sourced prior with no citable public source. No public MEDITECH spec documents a
`ZVI` segment, so (per the "encode a quirk only when a real, publicly-documented spec grounds it"
mandate) `ZVI` was removed and replaced with the DFT charge Z-segments MEDITECH documents verbatim
in its public Ancillary Charges (LAB/PHA/ITS/IDM) Outbound spec (Version 2.1, © 2021 Medical
Information Technology, Inc.): `ZF1` ("PROVIDER ENCOUNTER COPAY DATA") and `ZF2` ("ENCOUNTER
PROCEDURE DATA"), each field transcribed directly from the spec's segment tables. The profile's
`YYYYMMDDHHMM` minute-precision timestamp format is kept and now spec-cited: confirmed by that spec
(MSH-7 length 12; EVN-2/PID-7 "Format is YYYYMMDDHHMM") and by the public Admissions and Registration
Outbound spec (Version 2.4, © 2021). The vendor-shape fixture moved from
`vendor-shapes/meditech/adt-a04.hl7` to a synthetic, PHI-scanned `vendor-shapes/meditech/dft-p03.hl7`
(DFT^P03 carrying `ZF1`/`ZF2`).

Behavior change: consumers who relied on `ZVI` resolving by name under `profiles.meditech` (an
ungrounded mapping) must now declare it themselves via `defineProfile({ extends: profiles.meditech,
customSegments: { ZVI: … } })`. The profile only names fields; it never decodes or rewrites clinical
values. `epic`, `cerner`, `athena`, and `genericLab` remain community-sourced priors awaiting the
same public-spec treatment.
