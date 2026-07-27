---
"@cosyte/hl7": patch
---

Add streaming / incremental parse: `parseStream` (HL7-S, Phase S).

hl7 could only parse a whole message (`parseHL7`) or a whole in-memory batch (`splitBatch`); a large
ELR/IIS/lab file or a live feed had to be fully buffered first. `parseStream(source, opts?)` parses
**incrementally**: it consumes a chunked source (a Node `Readable`, an async-iterable, or an
iterable of `string`/`Buffer` chunks) and **yields one message per `MSH`-delimited boundary** as it
completes, with **O(one-message)** memory (the whole stream is never retained; the source is pulled
lazily and each message is released before the next is read).

A message split across chunk boundaries (mid-segment, mid-field, even mid-`MSH|^~\&`) is reassembled:
feeding the same bytes in 1-byte chunks vs. one big chunk yields **identical** messages; `\r`, `\r\n`,
and `\n` terminators are all tolerated (a `\r\n` straddling a chunk boundary is not mistaken for a
bare `\r`). Property-tested across randomized chunk boundaries and 1-byte chunks.

No second grammar: each demarcated message is parsed by the shipped `parseHL7` (the second argument,
profile / `strict` / `charset` / `dateFormats`, is forwarded per message), so a streamed message is
byte-for-byte what `splitBatch` produces for the same bytes.

Isolation, never a dropped tail: a malformed message mid-stream is an isolated typed failure entry and
the stream continues: it never suppresses later messages. Batch-envelope segments
(`FHS`/`BHS`/`BTS`/`FTS`) act as boundaries and are never yielded, so yielded count == `MSH` count
(envelope count reconciliation stays `splitBatch`'s job). A final message with no trailing terminator
is still yielded in full, flagged via the new stream-level `UNTERMINATED_STREAM_MESSAGE` warning on the
entry's `streamWarnings` (never on `Hl7Message.warnings`, never a throw). Consumes an already-de-framed
stream: MLLP framing/timing/TLS remain `@cosyte/mllp`'s.

Additive: no change to `parseHL7` / `splitBatch` output. New public exports: `parseStream`,
`unterminatedStreamMessage`, the `Hl7StreamSource` / `StreamMessageEntry` types, and the
`UNTERMINATED_STREAM_MESSAGE` warning code.
