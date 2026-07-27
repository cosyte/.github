---
"@cosyte/hl7": patch
---

Add the FHIR-bridge IR-stability contract + coverage proof (HL7-V, Phase V). Documents and versions
the mapping-source IR that `@cosyte/transform` builds against (IR Contract v1.0.0), and proves
firsthand against the HL7 v2-to-FHIR IG (v1.0.0, FHIR R4) that hl7 surfaces the IG's referenced v2
source paths over its public sample corpus: gaps recorded honestly. No v2→FHIR mapping is added to
hl7; this is documentation + a coverage test over existing surface.
