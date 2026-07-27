---
"@cosyte/hl7": patch
---

Add typed emit symmetry: composite setters + `buildAdt` / `buildOru` (HL7-T, Phase T).

hl7 could read a message into typed objects but could only _write_ one through stringly-typed field
arrays (the consumer hand-encoding `^`/`&`/`~`). Phase T makes hl7 an **authoring** library (the
conservative-emit mirror of the read helpers) on top of Phase R's encode-safe codec.

`encodeComposite(kind, value)` (and the per-type `encodeXpn`/`encodeCx`/`encodeTs`/… + `encodeCompositeReps`)
turn a typed composite into a spec-clean `RawField`; `Hl7Message.setComposite(path, kind, value)` sets
one at a field or `field[rep]` dot-path. Values are stored decoded and re-escaped on emit, so an
embedded delimiter (`"Smith^Jr"`) is **escaped, never injected**: it re-parses to the exact string,
never forging a component boundary. The **emit ∘ parse identity** holds on every modelled field;
property-tested across all composites.

`buildAdt(event, init)` and `buildOru(init)` assemble a full message (MSH + EVN + PID + PV1 for ADT;
MSH + PID + OBR + OBX for ORU) from typed inputs and emit a **spec-clean, zero-warning, structurally
complete** message: it re-parses with `warnings: []` and `msg.structure.missingGroups` empty.

**Never fabricate:** only supplied values are emitted; an omitted optional field stays absent; a
required-but-absent input (`patient`, an empty ADT `event`, or an ORU with no observation) is a typed
`TypeError`, not a guessed value. Complements the shipped `buildAck` (Phase C); `buildMessage` remains
for the long tail. Additive: no change to parse output or existing emit. Depends on Phase R.

New public exports: `buildAdt`, `buildOru`, `encodeComposite`, `encodeCompositeReps`, the eleven
per-type `encodeXxx` functions, `Hl7Message.setComposite`, and the `CompositeKind` /
`CompositeValueByKind` / `BuildAdtInit` / `AdtPatient` / `AdtVisit` / `AdtEvent` / `BuildOruInit` /
`OruPatient` / `OruOrder` / `OruObservation` types.
