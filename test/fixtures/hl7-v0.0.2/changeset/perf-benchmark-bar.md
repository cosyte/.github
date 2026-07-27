---
"@cosyte/hl7": patch
---

Add a performance / throughput bar: reproducible benchmark suite + a ratio-based perf-regression
guard (HL7-W, Phase W, the sixth and final phase of the v2.4 capability arc).

The reference parser now has a defensible, measured performance story. **`pnpm bench`**
(`scripts/bench.ts`) measures parse **throughput** (msgs/sec + MB/sec across a small ADT^A01 and a
larger multi-OBX ORU^R01), **per-message retained memory**, and the **streaming peak memory** that
substantiates `parseStream`'s O(one-message) claim, over synthetic, in-process inputs (no PHI, no
fixtures), so a run is self-contained and reproducible. Indicative numbers are published in
`docs-content/benchmarks.md`.

A CI-gating **performance-regression guard** (`test/perf/perf-regression.test.ts`) fails if throughput
or streaming memory regresses. Every assertion is **relative**, never an absolute floor, so it does
not flake across CI runners of different speed or under v8 coverage instrumentation: throughput
**linearity by message count** (`t(4N)/t(N) ≤ 10`, min-of-runs: catches super-linear-in-count),
**linearity by message size** (`t(4S)/t(S) ≤ 10`: catches an O(n²)-in-message-length tokenizer
regression the count test can't see), and streaming **read-ahead ≤ 2** (a pure count: the
O(one-message) memory invariant restated as a perf gate; it trips if `parseStream` ever buffers the
file). One coarse absolute liveness floor (~100× below real throughput) trips only on a catastrophic
hang. The gate deliberately does **not** assert an un-GC'd `heapUsed` ratio (that measures uncollected
garbage, not retained state, and would false-fail under a larger `--max-semi-space-size`); the
absolute memory numbers are published from the benchmark, which forces GC via `--expose-gc`.

**No behavior change**: this phase adds measurement + a guard only. Parse output is byte-identical;
no `src/` runtime code was touched, no public API added. New: the `bench` package script and the
`benchmarks` doc.
