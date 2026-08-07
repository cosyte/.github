#!/usr/bin/env node
/**
 * scripts/check-no-emdash.mjs: the em-dash gate, over every tracked file.
 *
 * Run: `node scripts/check-no-emdash.mjs`, or `node scripts/check-no-emdash.mjs --stdin <label>`
 * to hold a piece of text that is not a file (a PR title, a PR body, a commit message) to the
 * same rule. There is no `pnpm` script because this repository has no `package.json`: it ships no
 * package and installs nothing, which is also why the gate is Node builtins only.
 *
 * THE RULE. Founder directive 2026-07-24, stated canonically in the knowledgebase brand voice
 * document: cosyte never uses the em dash. Not in a file, not in a commit message, not in a PR
 * title or body. Rewrite the sentence with a period, a colon, a comma, or parentheses. NEVER
 * re-encode the character: the HTML entities, the percent-encoding and the JavaScript escapes are
 * banned on the same footing as the literal, and each has its own arm below.
 *
 * THIS GATE DID NOT ARRIVE ON A CLEAN TREE, AND THAT ORDERING IS THE POINT. The same change swept
 * 98 literal occurrences out of 19 of the 45 tracked files, plus 5 JavaScript escapes. A gate
 * landing before its sweep reds `main` on arrival; a sweep landing before its gate grows the
 * character back on the next session. They are one commit.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPOSITORY IS, AND WHY THAT RAISES THE STAKES ON A PUNCTUATION RULE
 * ---------------------------------------------------------------------------
 *
 * `cosyte/.github` holds the reusable `workflow_call` pipelines that thirteen other repositories
 * call at `@main`, and the org profile and community-health defaults that GitHub renders for every
 * repository without its own. So the prose here is read further than any single package's, and a
 * mistake in the YAML around it reds thirteen repositories at once.
 *
 * The sweep this gate landed with therefore changed COMMENTS AND HUMAN-READABLE STRINGS ONLY. Every
 * workflow and `dependabot.yml` was verified to parse to a byte-identical tree before and after; no
 * job id, step, condition, `run:` body, `uses:` ref or input or output name moved. Keep that
 * discipline when you fix a red here: rewrite the sentence, never the key.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NODE AND NOT A SHELL SCRIPT
 * ---------------------------------------------------------------------------
 *
 * Every other scanner in this ecosystem has had to defend itself against the agent container's
 * `grep`, which is a shell FUNCTION wrapping ugrep with `-G --ignore-files --hidden -I` forced on.
 * Two of those forced flags turn a scanner into the exact defect it exists to close: `-I` skips a
 * file it judges binary, silently, at exit 0, and `--ignore-files` honours `.gitignore`. Worse, the
 * census that sized this very sweep read `0` for every repository, because `/usr/bin/grep -P` fails
 * exit 2 in the container's empty locale and prints nothing, which `wc -l` reports as a clean tree.
 *
 * This gate shells out for nothing at all. It reads bytes with `node:fs`; the only child processes
 * are `git ls-files` and `git check-attr`, and both have their exit status checked rather than
 * assumed. There is no pipeline here whose status can be lost.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS EXCLUDED FROM THE SCAN. THERE IS NO EXEMPTION AND NO SKIP PATH.
 * ---------------------------------------------------------------------------
 *
 * A sibling gate partitions the tree into "scanned" and "declared binary in `.gitattributes`",
 * because it tracks vendored `.tgz` archives and a DEFLATE stream can hold the three bytes by
 * coincidence with no edit able to remove them. THIS REPOSITORY TRACKS NO BINARY AT ALL, and it has
 * no `CHANGELOG.md` and so no frozen archive either. So there is no partition here: every tracked
 * path is read, in full, and `scanned.length` always equals `files.length`.
 *
 * THAT IS A DELIBERATE STRENGTHENING, NOT A SIMPLIFICATION. A refuter defeated the sibling's
 * partition twice with a one-line path exclusion: first by accounting the skipped paths into the
 * declared-binary bucket so the arithmetic balanced, then, once that was closed, by routing the
 * identical exclusion through the scanned bucket instead, every asserted field byte-identical to an
 * honest run. With no skip path in the code there is no bucket to route anything into. A `binary`
 * declaration is REFUSED here rather than honoured, so re-introducing a skip means re-introducing
 * the mechanism in this file, in the open.
 *
 * A scanner that spells the forms it bans would also have to exclude itself, and a self-exclusion is
 * a demonstrated false green elsewhere in this org: an em dash appended to the gate script scanned
 * OK, because the gate was the one file nobody checked. There is no hole here, because there is
 * nothing to exclude. EVERY spelling below is ASSEMBLED at runtime from the codepoint `0x2014`, and
 * the prose names the forms rather than writing them out, so this file contains none of them as
 * text. It is scanned exactly like every other tracked file. If you add an arm, assemble it; do not
 * paste a literal in, and do not answer a red here by adding an exclusion.
 *
 * The same discipline is why `scripts/release-notes.mjs` and `scripts/release-diff.mjs` build their
 * dash constants with `String.fromCodePoint` rather than a JavaScript escape. Those constants are
 * operative: the release-notes gate refuses a release body containing an em dash, and it has to be
 * able to name the character to do that. Assembling it keeps the ban total without exempting the
 * one file that enforces it.
 *
 * ---------------------------------------------------------------------------
 * KNOWN LIMITS, named rather than discovered later
 * ---------------------------------------------------------------------------
 *
 *  (i)   It matches U+2014 as UTF-8 and as the textual encodings listed below. It does NOT match an
 *        em dash in some other charset (a CP1252 `0x97` fixture, a UTF-16 document). Such a file
 *        scans clean and this gate stays green. There is none today; every tracked file decodes as
 *        UTF-8.
 *  (ii)  The PCRE source spelling of the codepoint (a backslash, an `x`, and the hex in braces) is
 *        NOT banned as literal ASCII text. It is how a PCRE-based scanner names this codepoint, and
 *        `test/fixtures/hl7-v0.0.2/changeset/emdash-ci-gate.md` legitimately carries one: that
 *        fixture is a real captured changeset describing an earlier shell port of this gate, and its
 *        bytes are the input a release-notes test asserts on. It renders as nothing; banning it
 *        would red a scanner for being a scanner, and would red frozen test input for quoting one.
 *  (iii) It reads file CONTENTS and file NAMES. It cannot see a PR title, body or commit message on
 *        its own: CI feeds those through `--stdin`. On a squash merge the PR title and body BECOME
 *        the commit message, so those are the same surface.
 *  (iv)  NO ASSERTION INSIDE THIS REPOSITORY CAN CLOSE THE MUTATION CLASS, ONLY RAISE ITS COST. This
 *        gate and its tests are both files a mutator is editing. Removing the skip path (above)
 *        turns a 34-character exclusion into a visible re-architecture, and the suite recomputes the
 *        byte total independently (see below), so a mutation now has to READ each file and throw the
 *        bytes away to stay green. That is visibly incoherent in review, which is the right stopping
 *        point. Chasing further would be refuting an unbounded claim one exotic mutation at a time.
 *
 * ---------------------------------------------------------------------------
 * THE BYTE TOTAL IS THE LOAD-BEARING ASSERTION, AND IT IS MADE IN THE SUITE
 * ---------------------------------------------------------------------------
 *
 * `test/check-no-emdash.test.mjs` recomputes the total bytes this gate should have read, from
 * `git ls-files` plus `statSync`, and asserts it against the number in the banner below. THAT
 * ASSERTION HAS TO LIVE IN THE SUITE. The in-script check further down (that `bytesRead` equals the
 * sum of the sizes of the files this run opened) is worth its two lines, but it is satisfied by the
 * same edit that breaks it: a path exclusion drops a file from both sides at once. Only a total
 * derived from `git ls-files` OUTSIDE this file notices that the file was never opened.
 *
 * Zero dependencies. Node builtins only.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");

/** U+2014, built from the codepoint so this file never spells the character. */
const EM = String.fromCodePoint(0x2014);
const EM_BYTES = Buffer.from(EM, "utf8");

const HEX = (0x2014).toString(16); // the four hex digits
const DEC = String(0x2014); // the four decimal digits

// The remaining spellings, assembled rather than written out, so that this file contains none of
// them as text and needs no exclusion from its own scan.
const PCT = [...EM_BYTES].map((b) => `%${b.toString(16).toUpperCase()}`).join("");
const AMP = "&";
const NAMED = `${AMP}mdash`;
const NUM = `${AMP}#`;
const BS = "\\";

/**
 * Every banned spelling, as [label, RegExp], each paired index-for-index with a specimen built to
 * contain exactly that spelling.
 *
 * THE ENCODED ARMS ARE NOT DECORATION. A sibling sweep found its gate caught what the hand sweep
 * missed, precisely because a manifest held the named HTML entity rather than the literal character.
 * Measured on this tree at the time of landing: 98 literal occurrences, 5 JavaScript escapes, and
 * ZERO entity or percent forms. The arms stay anyway; the next contributor's editor may not agree
 * with this one's.
 *
 * The three entity arms tolerate a missing semicolon, because HTML5 consumes the named form and both
 * numeric forms without one, and each carries a boundary so that a longer digit run, a longer hex
 * run, or a longer word (all of which mean something else entirely) does not match. The numeric arms
 * tolerate leading zeros and either case, both of which are valid character references.
 *
 * The two JavaScript escape arms are case SENSITIVE on purpose: no language spells this character
 * with a capital `U` and four hex digits (JavaScript uses a lowercase `u`, bare or braced; Python's
 * capital form takes eight digits), so a case-insensitive arm buys no true positive and reds an
 * ordinary Windows path that happens to contain a user directory of that name. Measured as a live
 * false positive in a sibling before it was split out.
 */
const PATTERNS = [
  ["the literal character", new RegExp(EM, "g")],
  ["the percent-encoding", new RegExp(PCT, "gi")],
  ["the named HTML entity", new RegExp(`${NAMED}(?:;|(?![A-Za-z0-9]))`, "gi")],
  ["the decimal character reference", new RegExp(`${NUM}0*${DEC}(?:;|(?![0-9]))`, "gi")],
  ["the hex character reference", new RegExp(`${NUM}[xX]0*${HEX}(?:;|(?![0-9A-Fa-f]))`, "g")],
  ["the JavaScript escape", new RegExp(`${BS}${BS}u${HEX}`, "g")],
  ["the braced JavaScript escape", new RegExp(`${BS}${BS}u${BS}{0*${HEX}${BS}}`, "g")],
];

const SPECIMENS = [
  `a${EM}b`,
  `a${PCT}b`,
  `a${NAMED};b`,
  `a${NUM}${DEC};b`,
  `a${NUM}x${HEX};b`,
  `a${BS}u${HEX}b`,
  `a${BS}u{${HEX}}b`,
];

/**
 * The floor under `git ls-files`, deliberately NOT the current count. This repo tracked 48 paths
 * when the gate landed, so a floor of 30 leaves room to retire a script and its tests without
 * turning the refusal into a chore. Set it near the count and every ordinary deletion reads as a
 * filtered enumeration; set it at zero and there is no floor at all.
 */
const MIN_TRACKED = 30;

/**
 * Files known to be tracked TEXT, asserted present in the scanned set. A tool honouring
 * `.gitignore`, or an enumeration run from the wrong directory, drops real files silently. One from
 * each of the four surfaces this repository has: root prose, a reusable workflow, a script, and this
 * gate itself.
 */
const KNOWN_TEXT = [
  "README.md",
  "CONTRIBUTING.md",
  ".github/workflows/ci.yml",
  "scripts/check-no-emdash.mjs",
];

/** Every occurrence of every banned spelling in `text`, with a locus. */
function findEmDashes(text) {
  const hits = [];
  const lines = text.split("\n");
  for (const [label, re] of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        hits.push({
          line: i + 1,
          column: m.index + 1,
          label,
          excerpt: lines[i].slice(Math.max(0, m.index - 40), m.index + 40).trim(),
        });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }
  return hits;
}

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
  if (r.error) throw new Error(`could not run git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} exited ${r.status}: ${r.stderr?.toString("utf8").trim()}`);
  }
  return r.stdout;
}

/** Every tracked path, NUL separated so a newline in a name cannot split one. */
function trackedFiles() {
  return git(["ls-files", "-z"])
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0);
}

/**
 * Paths declared `binary` in `.gitattributes`. This repository tracks no binary and has no
 * `.gitattributes`, so the expected answer is the empty set and anything else is refused rather than
 * honoured: a declaration is the one thing that could otherwise argue a file out of this scan.
 */
function declaredBinary(files) {
  const r = spawnSync("git", ["check-attr", "--stdin", "-z", "binary"], {
    cwd: ROOT,
    input: Buffer.from(files.join("\0") + "\0", "utf8"),
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.error) throw new Error(`could not run git check-attr: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`git check-attr exited ${r.status}: ${r.stderr?.toString("utf8").trim()}`);
  }
  const fields = r.stdout.toString("utf8").split("\0");
  const out = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === "set") out.push(fields[i]);
  }
  return out;
}

function refuse(why, detail) {
  console.error(`[no-emdash] REFUSED: ${why}`);
  console.error(`            ${detail}`);
  console.error("            Refusing to report a clean tree on a scanner that cannot see.");
  process.exit(1);
}

function fail(what, hits) {
  console.error("");
  for (const h of hits) {
    console.error(`[no-emdash] FAIL  ${h.where}:${h.line}:${h.column}  (${h.label})`);
    console.error(`              ${h.excerpt}`);
  }
  console.error(
    `\n[no-emdash] ${hits.length} occurrence(s) in ${what}, across ` +
      `${new Set(hits.map((h) => h.where)).size} location(s).`,
  );
  console.error("[no-emdash] cosyte never uses em dashes (founder directive, 2026-07-24).");
  console.error(
    "[no-emdash] Rewrite with a period, a colon, a comma, or parentheses. " +
      "Never re-encode the character.",
  );
  console.error(
    "[no-emdash] In a workflow, rewrite the COMMENT or the human-readable string. Never a key, a " +
      "job id, a condition or a `run:` body: thirteen repositories call these at @main.",
  );
  process.exit(1);
}

/**
 * Refuse to report a clean tree on a scanner that cannot see.
 *
 * Each assertion closes a way this gate could return "no findings" having examined nothing. A probe
 * that only proved the patterns compile would miss every one of them after the second.
 */
function probe({ files, scanned, declared, bytesRead, sizeTotal }) {
  // 1. GROUND TRUTH. Everything above is derived from one codepoint constant, so the patterns and
  //    the specimens would agree with each other even if that constant were wrong. Anchor it on the
  //    bytes: U+2014 is E2 80 94 in UTF-8, and that is not a fact this repository gets to define.
  if (!EM_BYTES.equals(Buffer.from([0xe2, 0x80, 0x94]))) {
    refuse(
      "the character being scanned for is not U+2014",
      `built bytes ${[...EM_BYTES].map((b) => b.toString(16)).join(" ")}, expected e2 80 94.`,
    );
  }

  // 2. Every pattern matches a specimen built to contain exactly its spelling, and the two lists are
  //    index aligned by contract.
  if (SPECIMENS.length !== PATTERNS.length) {
    refuse(
      "the specimen list and the pattern list are different lengths",
      "they are index aligned by contract; one was edited without the other.",
    );
  }
  for (let i = 0; i < PATTERNS.length; i++) {
    const [label, re] = PATTERNS[i];
    re.lastIndex = 0;
    if (!re.test(SPECIMENS[i])) {
      refuse(`the pattern for ${label} does not match its own specimen`, "one of them built wrong.");
    }
  }

  // 3. THE SYNTHETIC CANARY. Checks 1 and 2 prove the PATTERNS are right. Neither of them runs
  //    `findEmDashes`, which is the function that actually scans a file, so a `findEmDashes`
  //    returning an empty array for every input would sail past both and report a clean tree.
  //
  //    THIS IS THE ONLY CANARY THIS REPOSITORY CAN HAVE, AND THAT IS A CONSEQUENCE OF THE SWEEP
  //    BEING TOTAL. A sibling's stronger canary is an on-disk one: a frozen CHANGELOG archive KNOWN
  //    to hold occurrences, so a scan reporting it clean has gone blind rather than found good news.
  //    There is no such file here, because there is no exemption here. The read path is instead
  //    pinned by the byte total below and by the suite's independent recomputation of it.
  for (const specimen of SPECIMENS) {
    if (findEmDashes(specimen).length === 0) {
      refuse(
        `the scanner found nothing in a buffer built to contain ${JSON.stringify(specimen)}`,
        "findEmDashes is blind; every clean result in this run would be worthless.",
      );
    }
  }

  // 4. Enumeration returned a tree. An empty or tiny `git ls-files` (wrong cwd, a filtered tool)
  //    must not read as a clean repository.
  if (files.length < MIN_TRACKED) {
    refuse(
      `git ls-files returned only ${files.length} path(s)`,
      `this repo tracks well over ${MIN_TRACKED}; the enumeration is filtered or wrong.`,
    );
  }

  // 5. EVERY TRACKED PATH WAS READ. There is no skip path in this gate, so this is an equality and
  //    not an arithmetic partition. The sibling this was ported from partitions into scanned and
  //    declared-binary, and a refuter defeated that partition twice by moving paths between the two
  //    buckets while keeping the sums balanced. An equality against the enumeration has no bucket.
  if (scanned.length !== files.length) {
    refuse(
      `${files.length - scanned.length} tracked path(s) were not read`,
      "this gate has no skip path: every tracked file is scanned, or the scan has a silent gap.",
    );
  }
  if (declared.length > 0) {
    refuse(
      `${declared.length} path(s) are declared 'binary' in .gitattributes`,
      `this repository tracks no binary and honours no such declaration: ${declared.slice(0, 5).join(", ")}. ` +
        "Drop the declaration, or widen this script deliberately and say why.",
    );
  }
  if (bytesRead === 0) refuse("the scan read zero bytes", "no file was opened.");

  // 6. The bytes read are the bytes on disk. Worth its two lines (it catches a short read), but it
  //    is NOT the load-bearing assertion: both sides are derived from the same `scanned` list, so an
  //    edit that drops a path drops it from both. `test/check-no-emdash.test.mjs` recomputes the
  //    total from `git ls-files` instead, which is outside this file and notices that.
  if (bytesRead !== sizeTotal) {
    refuse(
      `read ${bytesRead} bytes from files totalling ${sizeTotal} on disk`,
      "a tracked file was opened and not read in full.",
    );
  }

  // 7. Files known to be text ARE in the scanned set.
  for (const known of KNOWN_TEXT) {
    if (!scanned.includes(known)) {
      refuse(
        `${known} is not in the scanned set`,
        "it is tracked and it is text, so the enumeration is dropping files.",
      );
    }
  }
}

function scanStdin(label) {
  const text = readFileSync(0, "utf8");
  const hits = findEmDashes(text).map((h) => ({ ...h, where: label }));
  // The synthetic canary runs here too: this mode reads no repository file, so nothing else in this
  // run would prove the scanner can see.
  for (const specimen of SPECIMENS) {
    if (findEmDashes(specimen).length === 0) {
      refuse("the scanner found nothing in a buffer built to be dirty", "findEmDashes is blind.");
    }
  }
  if (hits.length) fail(label, hits);
  console.log(`[no-emdash] OK: no em dashes in ${label} (${text.length} bytes read).`);
}

function scanTree() {
  const files = trackedFiles();
  const declared = declaredBinary(files);

  // A tracked FILENAME can itself hold the character, and scanning contents never looks at one.
  const nameHits = [];
  for (const rel of files) {
    for (const h of findEmDashes(rel)) nameHits.push({ ...h, where: `tracked filename ${rel}` });
  }
  if (nameHits.length) fail("a tracked FILENAME (not its contents)", nameHits);

  const scanned = [];
  const hits = [];
  let bytesRead = 0;
  let sizeTotal = 0;

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    let buf;
    try {
      buf = readFileSync(abs);
      sizeTotal += statSync(abs).size;
    } catch (err) {
      // Fail closed: a tracked file this gate cannot open is not a clean file.
      console.error(`[no-emdash] FAIL  ${rel}: could not read (${err.message})`);
      console.error("[no-emdash] A tracked file this gate cannot open is a failure, never a skip.");
      process.exit(1);
    }
    scanned.push(rel);
    bytesRead += buf.length;
    for (const h of findEmDashes(buf.toString("utf8"))) hits.push({ ...h, where: rel });
  }

  probe({ files, scanned, declared, bytesRead, sizeTotal });

  if (hits.length) fail("the tracked files listed above", hits);

  console.log(
    `[no-emdash] OK: ${scanned.length} tracked file(s) scanned (${bytesRead} bytes), ` +
      `${files.length} filename(s) checked, 0 exempt.`,
  );
  console.log(
    "[no-emdash]     Nothing in this repository is exempt from the content scan: it tracks no " +
      "binary, keeps no changelog archive, and honours no 'binary' attribute.",
  );
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--stdin") {
    scanStdin(argv[1] ?? "stdin");
    return;
  }
  if (argv.length) {
    console.error(`[no-emdash] unknown argument: ${argv[0]}`);
    console.error("[no-emdash] usage: check-no-emdash.mjs [--stdin <label>]");
    process.exit(1);
  }
  scanTree();
}

try {
  main();
} catch (err) {
  console.error("[no-emdash] FAILED:", err.message);
  process.exit(1);
}
