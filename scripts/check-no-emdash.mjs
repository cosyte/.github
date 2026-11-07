#!/usr/bin/env node
/**
 * scripts/check-no-emdash.mjs: the em-dash gate, over every tracked file. It refuses the en dash
 * as well, under the same name.
 *
 * Run: `node scripts/check-no-emdash.mjs`, or `node scripts/check-no-emdash.mjs --stdin <label>`
 * to hold a piece of text that is not a file (a PR title, a PR body, a commit message) to the
 * same rule. There is no `pnpm` script because this repository has no `package.json`: it ships no
 * package and installs nothing, which is also why the gate is Node builtins only.
 *
 * THE RULE. Founder directive 2026-07-24, stated canonically in the knowledgebase brand voice
 * document: we never use the em dash. Not in a file, not in a commit message, not in a PR title or
 * body. The en dash (U+2013) is banned with it (owner decision, 2026-11-07), and every arm below
 * exists once for each dash. Write a range with "to"; rewrite a pause with a period, a colon, a
 * comma, or parentheses. NEVER re-encode the character: the HTML entities, the percent-encoding and
 * the JavaScript escapes are banned on the same footing as the literal, and each has its own arm.
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
 * NOTHING IS EXCLUDED FROM THE SCAN. THERE IS NO SKIP PATH, AND EXACTLY ONE EXEMPT OCCURRENCE.
 * ---------------------------------------------------------------------------
 *
 * A sibling gate partitions the tree into "scanned" and "declared binary in `.gitattributes`",
 * because it tracks vendored `.tgz` archives and a DEFLATE stream can hold the three bytes by
 * coincidence with no edit able to remove them. THIS REPOSITORY TRACKS NO BINARY AT ALL, and it has
 * no `CHANGELOG.md` and so no frozen archive either. So there is no partition here: every tracked
 * path is read, in full, and `scanned.length` always equals `files.length`.
 *
 * THE ONE EXEMPTION IS AN OCCURRENCE, NOT A PATH. `test/fixtures/hl7-v0.0.2/changeset/` holds the
 * real changesets a release-notes test derives a live release body from, byte for byte, and one of
 * them quotes a spec section range with an en dash. It is frozen input, so it keeps the character.
 * `EXEMPT` below names that occurrence by path, line, column and arm. The file is still read in
 * full and scanned like every other: any other occurrence in it reds. And the exemption is REQUIRED
 * to match: if the scan does not find exactly that occurrence, the run refuses, because an exemption
 * that has outlived its subject is a hole and a scan that cannot see a known en dash is blind. That
 * makes the fixture this gate's on-disk canary for the en dash arms.
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
 * nothing to exclude. EVERY spelling below is ASSEMBLED at runtime from the codepoints `0x2014` and
 * `0x2013`, and the prose names the forms rather than writing them out, so this file contains none
 * of them as text. It is scanned exactly like every other tracked file. If you add an arm, assemble
 * it; do not paste a literal in, and do not answer a red here by adding an exclusion.
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
 *  (i)   It matches U+2014 and U+2013 as UTF-8 and as the textual encodings listed below. It does
 *        NOT match either dash in some other charset (a CP1252 `0x97` or `0x96` fixture, a UTF-16
 *        document). Such a file scans clean and this gate stays green. There is none today; every
 *        tracked file decodes as UTF-8.
 *  (ii)  The PCRE source spelling of either codepoint (a backslash, an `x`, and the hex in braces)
 *        is NOT banned as literal ASCII text. It is how a PCRE-based scanner names a codepoint, and
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

const AMP = "&";
const NUM = `${AMP}#`;
const BS = "\\";

/**
 * The two banned codepoints. Each character is built from its number so this file never spells it,
 * and `utf8` is the ground truth the probe checks the built bytes against: E2 80 94 and E2 80 93 are
 * not facts this repository gets to define. The named HTML entity is written without its leading
 * ampersand, so it is a plain word here.
 */
const DASHES = [
  { name: "em dash", codepoint: 0x2014, entity: "mdash", utf8: [0xe2, 0x80, 0x94] },
  { name: "en dash", codepoint: 0x2013, entity: "ndash", utf8: [0xe2, 0x80, 0x93] },
].map((d) => {
  const char = String.fromCodePoint(d.codepoint);
  const bytes = Buffer.from(char, "utf8");
  return {
    ...d,
    char,
    bytes,
    hex: d.codepoint.toString(16), // the four hex digits
    dec: String(d.codepoint), // the four decimal digits
    // The remaining spellings, assembled rather than written out, so that this file contains none
    // of them as text and needs no exclusion from its own scan.
    pct: [...bytes].map((b) => `%${b.toString(16).toUpperCase()}`).join(""),
    named: `${AMP}${d.entity}`,
  };
});

/**
 * Every banned spelling, as [label, RegExp], each paired index-for-index with a specimen built to
 * contain exactly that spelling. Seven arms per dash, labelled with the dash they belong to.
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
const PATTERNS = DASHES.flatMap(({ name, char, pct, named, dec, hex }) => [
  [`${name}, the literal character`, new RegExp(char, "g")],
  [`${name}, the percent-encoding`, new RegExp(pct, "gi")],
  [`${name}, the named HTML entity`, new RegExp(`${named}(?:;|(?![A-Za-z0-9]))`, "gi")],
  [`${name}, the decimal character reference`, new RegExp(`${NUM}0*${dec}(?:;|(?![0-9]))`, "gi")],
  [`${name}, the hex character reference`, new RegExp(`${NUM}[xX]0*${hex}(?:;|(?![0-9A-Fa-f]))`, "g")],
  [`${name}, the JavaScript escape`, new RegExp(`${BS}${BS}u${hex}`, "g")],
  [`${name}, the braced JavaScript escape`, new RegExp(`${BS}${BS}u${BS}{0*${hex}${BS}}`, "g")],
]);

const SPECIMENS = DASHES.flatMap(({ char, pct, named, dec, hex }) => [
  `a${char}b`,
  `a${pct}b`,
  `a${named};b`,
  `a${NUM}${dec};b`,
  `a${NUM}x${hex};b`,
  `a${BS}u${hex}b`,
  `a${BS}u{${hex}}b`,
]);

/**
 * What the rule allows, and what no arm may match: hyphens, a range written with "to", and the
 * minus sign (U+2212, built from its number). An arm that matched it would red every tree, so its
 * findings could not be told from noise.
 */
const CLEAN_SPECIMEN = `a-b, pages 2 to 3, ${String.fromCodePoint(0x2212)}1`;

/**
 * THE ONE EXEMPT OCCURRENCE, named by its exact place. See "NOTHING IS EXCLUDED" in the header: the
 * file is read and scanned in full, only this one hit is set aside, and the run refuses unless the
 * scan finds it. `test/release-notes.test.mjs` derives the live hl7 v0.0.2 release body from this
 * frozen changeset byte for byte, so the fixture keeps the spec's section range as written.
 */
const EXEMPT = [
  {
    path: "test/fixtures/hl7-v0.0.2/changeset/philips-vue-pacs-profile.md",
    line: 14,
    column: 90,
    label: "en dash, the literal character",
  },
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
  console.error(
    "[no-emdash] We never use em or en dashes (founder directive, 2026-07-24; the en dash since " +
      "2026-11-07).",
  );
  console.error(
    '[no-emdash] Write a range with "to"; rewrite a pause with a period, a colon, a comma, or ' +
      "parentheses. Never re-encode the character.",
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
function probe({ files, scanned, declared, bytesRead, sizeTotal, exemptFound }) {
  // 1. GROUND TRUTH. Everything above is derived from two codepoint constants, so the patterns and
  //    the specimens would agree with each other even if a constant were wrong. Anchor each on the
  //    bytes: U+2014 is E2 80 94 and U+2013 is E2 80 93 in UTF-8.
  for (const { name, codepoint, bytes, utf8 } of DASHES) {
    if (!bytes.equals(Buffer.from(utf8))) {
      refuse(
        `the ${name} being scanned for is not U+${codepoint.toString(16).toUpperCase()}`,
        `built bytes ${[...bytes].map((b) => b.toString(16)).join(" ")}, expected ` +
          `${utf8.map((b) => b.toString(16)).join(" ")}.`,
      );
    }
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
  //    The one exempt occurrence (check 8) is that kind of canary for the literal en dash; for every
  //    other arm the read path is pinned by the byte total below and by the suite's independent
  //    recomputation of it. The clean specimen is the other direction: a scanner that matched what
  //    the rule allows would red every tree.
  for (const specimen of SPECIMENS) {
    if (findEmDashes(specimen).length === 0) {
      refuse(
        `the scanner found nothing in a buffer built to contain ${JSON.stringify(specimen)}`,
        "findEmDashes is blind; every clean result in this run would be worthless.",
      );
    }
  }
  if (findEmDashes(CLEAN_SPECIMEN).length !== 0) {
    refuse(
      "the scanner matched clean text (hyphens, a range written with to, a minus sign)",
      "an arm is matching what the rule allows, so its findings cannot be told from noise.",
    );
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

  // 8. EVERY EXEMPT OCCURRENCE WAS FOUND, AT ITS EXACT PLACE. An exemption the scan did not use is
  //    either stale (the fixture changed, and the entry now covers nothing anyone looked at) or a
  //    sign the scan cannot see a dash it is known to hold. Both refuse.
  EXEMPT.forEach((e, i) => {
    if (exemptFound[i] !== 1) {
      refuse(
        `the exempt occurrence ${e.path}:${e.line}:${e.column} (${e.label}) was not found`,
        "the fixture changed, or the scan cannot see it. Restore the fixture, or delete the entry " +
          "from EXEMPT if the occurrence is gone for good.",
      );
    }
  });
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
  if (findEmDashes(CLEAN_SPECIMEN).length !== 0) {
    refuse("the scanner matched clean text", "an arm is matching what the rule allows.");
  }
  if (hits.length) fail(label, hits);
  console.log(`[no-emdash] OK: no em or en dashes in ${label} (${text.length} bytes read).`);
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
  const exemptFound = EXEMPT.map(() => 0);
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
    for (const h of findEmDashes(buf.toString("utf8"))) {
      // Only an exact match on path, line, column and arm is set aside; anything else is a hit.
      const e = EXEMPT.findIndex(
        (x) => x.path === rel && x.line === h.line && x.column === h.column && x.label === h.label,
      );
      if (e === -1) hits.push({ ...h, where: rel });
      else exemptFound[e] += 1;
    }
  }

  probe({ files, scanned, declared, bytesRead, sizeTotal, exemptFound });

  if (hits.length) fail("the tracked files listed above", hits);

  console.log(
    `[no-emdash] OK: ${scanned.length} tracked file(s) scanned (${bytesRead} bytes), ` +
      `${files.length} filename(s) checked, ${EXEMPT.length} exempt occurrence(s).`,
  );
  console.log(
    "[no-emdash]     Every tracked file is read in full: this repository tracks no binary, keeps " +
      "no changelog archive, and honours no 'binary' attribute. The exempt occurrence is the en " +
      "dash in the frozen hl7 v0.0.2 changeset fixture, found where it is declared.",
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
