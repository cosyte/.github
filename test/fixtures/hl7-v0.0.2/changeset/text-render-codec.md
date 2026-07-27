---
"@cosyte/hl7": patch
---

Add formatted-text rendering + a first-class text codec (HL7-R, Phase R).

`renderText(input, enc?, opts?)` turns HL7 v2 §2.7 escape/formatting-bearing field content into a
normalized **display model**: a plain-text string (formatting commands → whitespace/line breaks,
highlight boundaries dropped) plus highlight-aware `runs`, so a clinical narrative is surfaced to a
human without raw `\.br\`/`\H\` sentinels. It **never fabricates**: a charset switch, vendor `\Z..\`,
or malformed/unterminated escape is preserved as its literal characters and flagged in
`unrenderedSequences`, never dropped or guessed. `Field.render()` is the one-call form on a parsed
field.

A first-class text codec (`decodeText` / `encodeText`, also bundled as the `text` namespace
(`text.decode` / `text.encode` / `text.render`)) promotes the escape handling to public API. The
load-bearing invariant is **encode-safety**: `encodeText` escapes every reserved character (the escape
char first, then the field/component/subcomponent/repetition separators, the truncation char, and
framing-critical CR/LF) so an arbitrary string round-trips (`decodeText(encodeText(s)) === s`) and
re-parses to exactly itself with **no delimiter injection**. Property-tested over arbitrary strings.

This is an added rendering/encoding **layer**: the lenient raw extraction (Postel's Law) is unchanged
and existing parse output is byte-for-byte identical. New public exports: `renderText`, `decodeText`,
`encodeText`, the `text` namespace, `Field.render()`, and the `RenderedText` / `TextRun` /
`RenderTextOptions` types.
