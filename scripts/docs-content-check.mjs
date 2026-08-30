#!/usr/bin/env node
// @ts-check
//
// A REPO CAN SHIP `docs-content/` THAT BREAKS `docs.cosyte.com`, AND NOTHING BETWEEN THE AUTHOR AND
// THE PUBLISHED SITE HAS AN OPINION ABOUT IT.
//
// That is the whole reason this file exists, so it is stated first. `x12` merged and released
// `docs-content/` carrying a broken package-internal link. Its own pull request checks were green,
// because no check read `docs-content/` at all, and `cosyte/docs` stayed red for eight consecutive
// days. This script is the missing check: it reads a caller's checked-out working tree, resolves
// every package-internal link and image under `docs-content/` and every document id `sidebars.json`
// names, and exits non-zero when one of them does not resolve.
//
// WHAT IT CLAIMS, AND WHAT IT DOES NOT. It blocks on PACKAGE-INTERNAL targets only. A site-absolute
// path, a cross-package relative link, an external URL and a bare anchor are REPORTED and never
// failed: `cosyte/docs` rewrites cross-package links at mount time, its scheduled link check covers
// external URLs, and Docusaurus treats a broken anchor as a warning. It reads a pull request's tree,
// while the site gets `docs-content.tar.gz` cut from a RELEASE, so a direct push to `main`, a release
// cut from a commit no gated pull request produced, and the merge race (one pull request deleting a
// document while another links to it, both green against their own heads) all remain open. The
// honest claim is one sentence: in an opted-in repo, a broken package-internal link reds the pull
// request that introduces it.
//
// ---------------------------------------------------------------------------
// ZERO DEPENDENCIES, AND WHY THAT SHAPES EVERY PARSE BELOW
// ---------------------------------------------------------------------------
//
// This repository has no `package.json`, no lockfile and no install step, and it is delivered to a
// caller's runner as ONE FILE fetched into `$RUNNER_TEMP` (see `.github/workflows/ci.yml`). So it
// imports `node:*` AND NOTHING ELSE, this repository included: an entry point importing a sibling
// under `scripts/` passes every test here and dies `ERR_MODULE_NOT_FOUND` in the first adopting
// caller's run. There is no CommonMark library, no YAML parser and no JSON-schema validator
// available, which is why the markdown constructs, the sidebar shapes and the frontmatter reading
// are each enumerated by hand below rather than delegated.
//
// ---------------------------------------------------------------------------
// IT WRITES NOTHING, ANYWHERE
// ---------------------------------------------------------------------------
//
// The caller's `$GITHUB_WORKSPACE` is the input of every OTHER gate in the same job (`pnpm lint`,
// `pnpm format:check`, `pnpm phi-scan`, whose scanner walks from the repository root). A file this
// gate left behind would be a file those gates read. So this script opens nothing for writing,
// creates no temporary directory and emits its whole report on stdout.
//
// ---------------------------------------------------------------------------
// THE COMPARISON IS THE CHECKER'S OWN, AGAINST A LISTING
// ---------------------------------------------------------------------------
//
// The host job is a matrix over caller-supplied `node` and `os` axes, and a caller may widen `os` to
// a macOS or Windows runner, whose filesystem is case-INSENSITIVE. `existsSync` would therefore
// resolve `./Troubleshooting` against `troubleshooting.md` on one cell and refuse it on another: two
// verdicts for one tree, the site building case-sensitively. So resolution NEVER touches the
// filesystem for a lookup. The tree is listed once into a map of relative paths, and every candidate
// is compared against that map with `===`.
//
// Both sides of that comparison are `/`-separated, and only ONE side is ever normalized: paths this
// script CONSTRUCTS, by joining components it read from `readdir`. A NAME that came out of a
// directory read is used verbatim. On POSIX a file may legitimately be named `guides\intro.md`
// (extract a Windows-authored zip and you have one); normalizing that name to `guides/intro.md`
// would resolve `./guides/intro` against a file the site cannot serve, greening exactly the class
// this gate exists to catch. A Windows filename cannot contain a separator, so nothing is lost.
//
// Exit codes: 0 no blocking finding, 1 one or more, 2 bad usage.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

/** The one directory this gate reads, at the caller's repository root. */
export const DOCS_ROOT = 'docs-content';

/** The sidebar file, required BY THIS GATE rather than by any release contract. */
export const SIDEBARS = 'sidebars.json';

const MARKDOWN_EXTENSIONS = ['.md', '.mdx'];

/**
 * `/` on every platform, for paths THIS SCRIPT constructs.
 *
 * Never applied to a name that came out of `readdir`: see the header. It exists because
 * `node:path` joins with `\` on Windows, and a candidate built that way would miss every listing
 * entry on that cell alone.
 *
 * @param {string} value
 */
export function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

/** @param {unknown} error */
function describeError(error) {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    return `${String(/** @type {{code: unknown}} */ (error).code)}: ${String(/** @type {{message: unknown}} */ (error).message)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} value */
function isMarkdown(value) {
  return MARKDOWN_EXTENSIONS.some((extension) => value.endsWith(extension));
}

/**
 * A leading UTF-8 byte order mark, dropped.
 *
 * Assembled from its codepoint rather than written as a literal, so this file stays ASCII. Without
 * this a BOM before the opening `---` hides the frontmatter, the declared id goes unseen, and a
 * sidebar entry naming it reds against a tree the site builds.
 *
 * @param {string} line
 */
function stripBom(line) {
  return line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
}

/** @param {string} value */
function withoutExtension(value) {
  for (const extension of MARKDOWN_EXTENSIONS) {
    if (value.endsWith(extension)) return value.slice(0, -extension.length);
  }
  return value;
}

// ---------------------------------------------------------------------------
// THE TREE WALK
// ---------------------------------------------------------------------------

/**
 * List `docs-content/` into a map of relative path to object kind.
 *
 * Symbolic links are FOLLOWED, and a directory whose real path is already on the current path is
 * reported as a cycle and never entered, so `docs-content/self -> .` terminates. Anything the walk
 * cannot stat, list or read is collected as unreadable (B6) and the walk CONTINUES: a permission
 * denied halfway down must not turn into success over everything above it.
 *
 * @param {string} root absolute path of `docs-content/`, `/`-separated
 * @returns {{ entries: Map<string, 'file'|'dir'|'other'>, unreadable: {path: string, reason: string}[], cycles: {path: string, target: string}[] }}
 */
export function listTree(root) {
  /** @type {Map<string, 'file'|'dir'|'other'>} */
  const entries = new Map();
  /** @type {{path: string, reason: string}[]} */
  const unreadable = [];
  /** @type {{path: string, target: string}[]} */
  const cycles = [];

  /**
   * @param {string} rel
   * @param {string[]} ancestors real paths of every directory on the current path
   */
  function visit(rel, ancestors) {
    const absolute = rel === '' ? root : `${root}/${rel}`;
    /** @type {string[]} */
    let names;
    try {
      names = readdirSync(absolute);
    } catch (error) {
      unreadable.push({ path: rel, reason: describeError(error) });
      return;
    }
    for (const name of names.slice().sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const childAbsolute = `${absolute}/${name}`;
      let stats;
      try {
        stats = statSync(childAbsolute);
      } catch (error) {
        // A dangling symlink lands here, and it is B6 wherever it sits rather than only where
        // something references it: "ANY entry that cannot be read" governs, and a path that cannot
        // be resolved cannot be counted as a document either.
        unreadable.push({ path: childRel, reason: describeError(error) });
        continue;
      }
      if (stats.isDirectory()) {
        let real;
        try {
          real = realpathSync(childAbsolute);
        } catch (error) {
          unreadable.push({ path: childRel, reason: describeError(error) });
          continue;
        }
        entries.set(childRel, 'dir');
        if (ancestors.includes(real)) {
          cycles.push({ path: childRel, target: toPosix(real) });
          continue;
        }
        visit(childRel, [...ancestors, real]);
      } else if (stats.isFile()) {
        entries.set(childRel, 'file');
      } else {
        entries.set(childRel, 'other');
      }
    }
  }

  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch (error) {
    unreadable.push({ path: '', reason: describeError(error) });
    return { entries, unreadable, cycles };
  }
  visit('', [rootReal]);
  return { entries, unreadable, cycles };
}

// ---------------------------------------------------------------------------
// MARKDOWN: WHICH TEXT IS A TARGET AND WHICH TEXT IS CODE
// ---------------------------------------------------------------------------

/** @param {string} line */
function expandTabs(line) {
  let out = '';
  for (const character of line) {
    if (character === '\t') out += ' '.repeat(4 - (out.length % 4));
    else out += character;
  }
  return out;
}

/** @param {string} line */
function indentOf(line) {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

/**
 * @param {string} text
 * @param {number} start
 * @param {string} character
 */
function runLength(text, start, character) {
  let n = 0;
  while (start + n < text.length && text[start + n] === character) n += 1;
  return n;
}

/** A block quote's own marker: up to three spaces, one `>`, and at most one space after it. */
const QUOTE_MARKER = /^ {0,3}>( ?)/;

/**
 * The content of a line with its block-quote markers taken off, and how many came off.
 *
 * A quote nests, so a line carries one marker PER LEVEL and a peel that stops at the first gets
 * `> > ` wrong. `limit` is what a line already inside a fence needs: peeling exactly as many
 * markers as the fence was opened under leaves a DEEPER quote's own `>` in the content, where it
 * cannot be mistaken for the fence's closer.
 *
 * @param {string} content the line, already past its container's content column
 * @param {number} [limit] how many markers to take, at most
 * @returns {{content: string, depth: number}}
 */
function peelQuotes(content, limit = Number.POSITIVE_INFINITY) {
  let rest = content;
  let depth = 0;
  while (depth < limit) {
    const marker = QUOTE_MARKER.exec(rest);
    if (!marker) break;
    rest = rest.slice(marker[0].length);
    depth += 1;
  }
  return { content: rest, depth };
}

/**
 * The end of a code span opened by a run of `length` backticks at `from`, or -1.
 *
 * CommonMark closes a code span on a run of EXACTLY the same length, which is what lets a sample
 * hold a backtick. An unclosed run is literal text and never opens a span.
 *
 * @param {string} text
 * @param {number} from
 * @param {number} length
 */
function closingBacktickRun(text, from, length) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== '`') continue;
    const run = runLength(text, i, '`');
    if (run === length) return i;
    i += run - 1;
  }
  return -1;
}

/**
 * The index of the `]` closing the `[` at `open`, honouring nesting, escapes and code spans.
 *
 * @param {string} text
 * @param {number} open
 */
function matchBracket(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const character = text[i];
    if (character === '\\') {
      i += 1;
      continue;
    }
    if (character === '`') {
      const run = runLength(text, i, '`');
      const close = closingBacktickRun(text, i + run, run);
      if (close !== -1) {
        i = close + run - 1;
        continue;
      }
      i += run - 1;
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse an inline destination starting just after `(`.
 *
 * Three decorations are handled because reading any of them as part of the target is a FALSE RED:
 * an ANGLE-BRACKET destination (`[Guide](<./my guide.md>)`, target `./my guide.md`), a TITLE
 * (`[Guide](./quickstart "How to")`, target `./quickstart`), and BALANCED PARENTHESES in a bare
 * destination (`[Codes](./codes/(837).md)`, which cut at the first `)` would truncate).
 *
 * @param {string} text
 * @param {number} start
 * @returns {{ target: string, end: number } | null}
 */
function parseDestination(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  let target = '';
  if (text[i] === '<') {
    i += 1;
    while (i < text.length && text[i] !== '>') {
      if (text[i] === '\\') {
        target += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (text[i] === '<') return null;
      target += text[i];
      i += 1;
    }
    if (text[i] !== '>') return null;
    i += 1;
  } else {
    let depth = 0;
    for (; i < text.length; i += 1) {
      const character = text[i];
      if (character === '\\') {
        target += text[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (/\s/.test(character)) break;
      if (character === '(') {
        depth += 1;
        target += character;
        continue;
      }
      if (character === ')') {
        if (depth === 0) break;
        depth -= 1;
        target += character;
        continue;
      }
      target += character;
    }
  }
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] === '"' || text[i] === "'" || text[i] === '(') {
    const closer = text[i] === '(' ? ')' : text[i];
    i += 1;
    while (i < text.length && text[i] !== closer) {
      if (text[i] === '\\') i += 1;
      i += 1;
    }
    if (text[i] !== closer) return null;
    i += 1;
    while (i < text.length && /\s/.test(text[i])) i += 1;
  }
  if (text[i] !== ')') return null;
  return { target, end: i + 1 };
}

// ---------------------------------------------------------------------------
// RAW HTML, JSX AND MDX EXPRESSIONS, PARSED ONLY SO THEY CAN BE SKIPPED
// ---------------------------------------------------------------------------
//
// The spec puts these OUT OF SCOPE: "raw HTML and JSX attributes (`<a href=...>`, `<img src=...>`)
// and MDX expressions. A broken target there is a named residual, not a finding." Skipping them is
// not indulgence, it is the difference between a gate and a nuisance. An MDX expression comment is
// the standard - in MDX the only - way to comment content out of a page, so extracting a target
// from one reds a pull request over content the site never renders, which is the same class of
// defect as reddening a code sample.
//
// Every matcher below REFUSES rather than guesses: an unbalanced brace, an unterminated attribute
// value and a `<` that is not a tag are all left as ordinary text. A bad guess therefore costs a
// scan, never a swallowed paragraph.

/**
 * The end of the brace expression opened at `open`, or -1 when nothing closes it here.
 *
 * Two things inside an expression would otherwise unbalance the count, and both are consumed whole:
 * a comment (the `{` slash-star ... star-slash `}` form MDX uses to comment content out) and a
 * quoted string.
 *
 * @param {string} text
 * @param {number} open
 */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const character = text[i];
    if (character === '\\') {
      i += 1;
      continue;
    }
    if (character === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      const close = text.indexOf(character, i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The index just past the HTML or JSX tag opening at `start`, or -1 when that is not a tag.
 *
 * The whole point is the ATTRIBUTE VALUES: `<Card alt="see [here](./gone)" />` carries bracket-paren
 * text that is not a link, and `<a href="./gone">` carries a destination the spec calls a residual.
 * The grammar is deliberately strict - a name, then attributes that are names, quoted values,
 * unquoted values or brace expressions - so that prose like `a<b and [see](./x)>c` fails to match
 * and is scanned as the text it is, rather than swallowing the link between the two angles.
 *
 * @param {string} text
 * @param {number} start
 */
function matchTag(text, start) {
  const head = /^<\/?[A-Za-z][A-Za-z0-9.-]*/.exec(text.slice(start));
  if (!head) return -1;
  let i = start + head[0].length;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) return -1;
    if (text[i] === '>') return i + 1;
    if (text[i] === '/' && text[i + 1] === '>') return i + 2;
    if (text[i] === '{') {
      const close = matchBrace(text, i);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    const name = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(text.slice(i));
    if (!name) return -1;
    i += name[0].length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] !== '=') continue;
    i += 1;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, i + 1);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    if (quote === '{') {
      const close = matchBrace(text, i);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    const unquoted = /^[^\s"'=<>`]+/.exec(text.slice(i));
    if (!unquoted) return -1;
    i += unquoted[0].length;
  }
}

/**
 * Every in-scope target in one BLOCK of content, with its kind.
 *
 * `content` is a whole block, not a line: the lines of a paragraph are joined with `\n` before this
 * runs, because a link whose LABEL wraps across a line break is ONE link in CommonMark and one link
 * in the rendered page. Scanning line by line finds no `]` on the opening line and no `[` on the
 * closing one, so a broken target hidden by a hard wrap ships GREEN - and hard-wrapped prose is the
 * house style of every markdown file in this org. The same join is what lets a code span opened on
 * one line and closed on the next stay code instead of becoming a false red.
 *
 * BRACKETS NEST, and which of the nested destinations the published page actually serves is
 * CommonMark's answer, not the outermost pair's. Three ordinary shapes, all of them targets the
 * spec puts in scope, and reading only the outer construct gets each one wrong:
 *
 *   - `[![Logo](./img/logo.svg)](./intro)`, a clickable badge or logo. BOTH destinations are
 *     live - an `<img src>` inside an `<a href>` - so BOTH are checked. Scanning only the outer
 *     one drops the image entirely, and a missing asset behind a linked logo exits ZERO while
 *     the same image on its own line is a B5.
 *   - `[a [b](./missing) c](./intro)`. A link may not contain a link, so the INNER definition is
 *     the link and the outer brackets are literal text: `./missing` is live and `./intro` is NOT.
 *     Checking the outer one checks a destination the page never serves and misses one it does.
 *   - `![see [here](./x)](./logo.svg)`. An image's alt renders as PLAIN TEXT, so no destination
 *     inside it is ever live; the image's own destination is. A link there still deactivates an
 *     ENCLOSING link, exactly as one directly in the link's text does.
 *
 * @param {string} content the block's lines, container prefixes stripped, joined with `\n`
 * @param {number} base the offset of `content` within the block, for line attribution
 * @param {(index: number) => number} lineAt the 1-based file line an offset in the block sits on
 * @param {{line: number, raw: string, kind: 'link'|'image'|'definition'}[]} found
 * @param {boolean} [live] false inside an image's alt: constructs there are still parsed, because
 *   a link in an alt suppresses an enclosing link, but no destination inside one is ever served
 * @returns {boolean} whether this text IS or CONTAINS a link, which suppresses any enclosing one
 */
function scanInline(content, base, lineAt, found, live = true) {
  let i = 0;
  let containsLink = false;
  while (i < content.length) {
    const character = content[i];
    if (character === '\\') {
      i += 2;
      continue;
    }
    if (character === '`') {
      // A CODE SPAN, and the reason this arm exists at all: `handlers[0](event)` in a JavaScript
      // sample is not a link, and reddening a working sample is a defect of this gate. A span may
      // open on one line and close on the next, which is why the block is scanned as one string.
      const run = runLength(content, i, '`');
      const close = closingBacktickRun(content, i + run, run);
      i = close === -1 ? i + run : close + run;
      continue;
    }
    if (character === '<') {
      // An AUTOLINK is a whole construct in angle brackets and carries no target here. It is NOT
      // the angle-bracket DESTINATION above, which is in scope and handled in `parseDestination`.
      const match = /^<[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*>/.exec(content.slice(i));
      if (match) {
        i += match[0].length;
        continue;
      }
      // An HTML comment renders nothing, so nothing inside one is a target. Unterminated, it runs
      // to the end of this block and no further - a blank line ends an HTML block.
      if (content.startsWith('<!--', i)) {
        const end = content.indexOf('-->', i + 4);
        i = end === -1 ? content.length : end + 3;
        continue;
      }
      const tag = matchTag(content, i);
      i = tag === -1 ? i + 1 : tag;
      continue;
    }
    if (character === '{') {
      // An MDX expression. Out of scope by name, and the residual that buys is exactly the one the
      // spec accepts: a broken target inside one is invisible rather than a false red.
      const close = matchBrace(content, i);
      i = close === -1 ? i + 1 : close + 1;
      continue;
    }
    if (character === '[' || (character === '!' && content[i + 1] === '[')) {
      const isImage = character === '!';
      const start = i;
      const open = isImage ? i + 1 : i;
      const close = matchBracket(content, open);
      if (close === -1) {
        i = open + 1;
        continue;
      }
      const inner = content.slice(open + 1, close);
      if (content[close + 1] === '(') {
        const destination = parseDestination(content, close + 2);
        if (destination) {
          // The line reported is where the CONSTRUCT OPENS, which is where an author looks for it,
          // and is the only stable answer once a construct may span two of them.
          const line = lineAt(base + start);
          if (isImage) {
            // The alt is plain text in the page, so nothing inside it is a target - but a LINK in
            // there still deactivates an enclosing one, so it is parsed rather than skipped.
            if (scanInline(inner, base + open + 1, lineAt, found, false)) containsLink = true;
            if (live) found.push({ line, raw: destination.target, kind: 'image' });
            i = destination.end;
            continue;
          }
          /** @type {typeof found} */
          const nested = [];
          const nestedLink = scanInline(inner, base + open + 1, lineAt, nested, live);
          found.push(...nested);
          // A link may not contain a link: where one is nested, THAT is the link and this pair is
          // literal text, so this destination is not the page's and is not checked.
          if (!nestedLink && live) found.push({ line, raw: destination.target, kind: 'link' });
          containsLink = true;
          i = destination.end;
          continue;
        }
      }
      // `[see this][label]` and `[label][]` carry no target of their own: the DEFINITION is what
      // gets checked, once, so the use must not become a second target. The scan resumes INSIDE
      // the brackets, so an inline construct nested in the label text is still reached.
      i = open + 1;
      continue;
    }
    i += 1;
  }
  return containsLink;
}

/**
 * A LINK REFERENCE DEFINITION destination, from just after the `:`.
 *
 * Its own parser rather than `parseDestination`'s, because a definition may put its destination on
 * the LINE AFTER the label and because what follows the destination decides whether this was a
 * definition at all: anything but a title and whitespace to end of line means the whole thing is an
 * ordinary paragraph.
 *
 * @param {string} text
 * @param {number} start
 * @returns {{ target: string, end: number } | null}
 */
function parseDefinitionDestination(text, start) {
  let i = start;
  let newlines = 0;
  while (i < text.length && /\s/.test(text[i])) {
    if (text[i] === '\n') {
      newlines += 1;
      if (newlines > 1) return null;
    }
    i += 1;
  }
  if (i >= text.length) return null;
  let target = '';
  if (text[i] === '<') {
    i += 1;
    while (i < text.length && text[i] !== '>' && text[i] !== '\n') {
      if (text[i] === '\\') {
        target += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      target += text[i];
      i += 1;
    }
    if (text[i] !== '>') return null;
    i += 1;
  } else {
    for (; i < text.length && !/\s/.test(text[i]); i += 1) {
      if (text[i] === '\\') {
        target += text[i + 1] ?? '';
        i += 1;
        continue;
      }
      target += text[i];
    }
  }
  if (target === '') return null;
  while (i < text.length && text[i] !== '\n' && /\s/.test(text[i])) i += 1;
  if (i < text.length && text[i] !== '\n') {
    const quote = text[i];
    if (quote !== '"' && quote !== "'" && quote !== '(') return null;
    const closer = quote === '(' ? ')' : quote;
    i += 1;
    while (i < text.length && text[i] !== closer) {
      if (text[i] === '\\') i += 1;
      i += 1;
    }
    if (text[i] !== closer) return null;
    i += 1;
    while (i < text.length && text[i] !== '\n' && /\s/.test(text[i])) i += 1;
  }
  if (i < text.length && text[i] !== '\n') return null;
  return { target, end: i < text.length ? i + 1 : text.length };
}

/**
 * Consume the LINK REFERENCE DEFINITIONS a block opens with, and return where they end.
 *
 * Definitions sit at the FRONT of a block, one after another, and only there: `Some prose` followed
 * by `[label]: ./target` is a lazy paragraph continuation and declares nothing. A reference USE
 * (`[text][label]`) carries no target, so the definition is the one thing checked, once.
 *
 * @param {string} text
 * @param {(index: number) => number} lineAt
 * @param {{line: number, raw: string, kind: 'link'|'image'|'definition'}[]} found
 */
function consumeDefinitions(text, lineAt, found) {
  let i = 0;
  for (;;) {
    const indented = /^ {0,3}\[/.exec(text.slice(i));
    if (!indented) return i;
    const open = i + indented[0].length - 1;
    const close = matchBracket(text, open);
    if (close === -1 || text[close + 1] !== ':') return i;
    if (text.slice(open + 1, close).trim() === '') return i;
    const destination = parseDefinitionDestination(text, close + 2);
    if (!destination) return i;
    found.push({ line: lineAt(open), raw: destination.target, kind: 'definition' });
    i = destination.end;
  }
}

/**
 * Scan ONE BLOCK: its lines, container prefixes already stripped, with the file line each came from.
 *
 * @param {{content: string, line: number}[]} block
 * @param {{line: number, raw: string, kind: 'link'|'image'|'definition'}[]} found
 */
function scanBlock(block, found) {
  if (block.length === 0) return;
  const text = block.map((entry) => entry.content).join('\n');
  /** @type {number[]} */
  const offsets = [];
  let at = 0;
  for (const entry of block) {
    offsets.push(at);
    at += entry.content.length + 1;
  }
  /** @param {number} index */
  const lineAt = (index) => {
    let i = offsets.length - 1;
    while (i > 0 && offsets[i] > index) i -= 1;
    return block[i].line;
  };
  const after = consumeDefinitions(text, lineAt, found);
  scanInline(text.slice(after), after, lineAt, found);
}

/**
 * Every in-scope target in a document, by line.
 *
 * This walk exists for one reason: to decide which lines belong to the SAME BLOCK, and which are
 * CODE and belong to no block at all. Everything else is `scanBlock`'s. Each construct is measured
 * the way CommonMark measures it rather than by the shorthand:
 *
 *   - A PARAGRAPH is the unit, not the line. Its lines are joined and scanned together, because a
 *     link, an image or a code span may wrap across a line break and hard-wrapped prose is this
 *     org's house style. A list item, a heading, a thematic break, a blank line and a code fence
 *     each start a new block, so no construct is ever read across a boundary the page does not have.
 *   - A FENCED block opens on a run of three or more backticks or tildes and closes only on a run
 *     of the SAME character that is AT LEAST AS LONG. A page that fences a markdown sample with
 *     FOUR backticks so the sample can contain a three-backtick fence is all code; treating the
 *     inner three as the closer turns the next line into prose and reds a working sample. An
 *     UNCLOSED fence ends with the CONTAINER that holds it - a line dedented past the list item's
 *     content column closes it - so a malformed sample inside a bullet cannot hide every link in
 *     the rest of the file. Where containers nest, the TIGHTEST one holding the fence is the one it
 *     ends with, so a fence opened in a list item INSIDE a quote ends with that item and not with
 *     the whole quote.
 *   - An INDENTED block is four spaces measured from the CONTAINER'S CONTENT COLUMN, not from
 *     column zero. `- Parent` followed by `    - Child, see [the guide](./missing)` is a nested
 *     list and that link is a link; reading it as code is how the Origin incident ships green.
 *   - An indented line cannot interrupt a PARAGRAPH, so a lazily indented continuation line is
 *     prose and its links are links.
 *   - A BLOCK QUOTE is a container like any other, so its markers come off - one PER NESTING LEVEL,
 *     `> >` included - BEFORE the fence and indented-code tests run, and the column after them is
 *     the content column both tests measure from. A quoted sample is code exactly as the same
 *     sample is at the top level. The quote is a container in the other direction too: an unclosed
 *     fence inside one ends where the QUOTE ends - or with the quoted LIST ITEM that holds it,
 *     whichever comes first - so a broken link in the prose below it is still found, and a `>`
 *     carrying nothing is a quoted blank line that ends the quoted paragraph.
 *     Leaving a quote does NOT end a paragraph, because CommonMark continues one lazily and a link
 *     wrapped across that boundary is a link.
 *   - An HTML COMMENT and an MDX EXPRESSION COMMENT opening a line run to their closer across blank
 *     lines, exactly as the renderer reads them. Neither renders anything, so nothing inside one is
 *     a target.
 *
 * @param {string} text
 * @param {number} [startLine] 1-based line of `text` within the file (frontmatter is skipped)
 */
export function extractTargets(text, startLine = 1) {
  const lines = String(text).split(/\r?\n/);
  /** @type {{line: number, raw: string, kind: 'link'|'image'|'definition'}[]} */
  const found = [];
  /** @type {number[]} */
  const containers = [];
  /**
   * The same stack for list items opened INSIDE a block quote, whose content columns are measured
   * in the QUOTED content and so do not compare with the line's own columns above.
   * @type {number[]}
   */
  const quotedContainers = [];
  /**
   * The fence still open, and the container it was opened in. `base` is that container's column in
   * the LINE's own coordinate and `quotedBase` is it in the QUOTED content's, because a fence
   * opened in a list item INSIDE a quote is held by that item and ends with it, not with the quote.
   * @type {{character: string, length: number, base: number, quotedBase: number, depth: number} | null}
   */
  let fence = null;
  /** @type {string | null} the closer of a comment block still open */
  let comment = null;
  /** How many block-quote markers the block being built sits under. */
  let quoteDepth = 0;
  /** @type {{content: string, line: number}[]} */
  let block = [];

  const flush = () => {
    if (block.length > 0) {
      scanBlock(block, found);
      block = [];
    }
    quoteDepth = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = expandTabs(lines[index]);
    const lineNumber = startLine + index;
    const trimmed = line.trim();

    if (fence) {
      if (trimmed === '') {
        // A blank line ends a BLOCK QUOTE, so a fence the quote held ends with it; at the top level
        // or inside a list item a blank line is ordinary code and the fence stands. Without this
        // the quoted lines BELOW the blank one read as code too, which is a false green.
        if (fence.depth === 0) continue;
        fence = null;
      } else if (indentOf(line) >= fence.base) {
        const inner = peelQuotes(line.slice(fence.base), fence.depth);
        if (inner.depth === fence.depth) {
          const rest = inner.content.trim();
          // A `>` carrying nothing is a blank line of code: a blank line does not end the list item
          // that holds the fence, so the block spans it exactly as it does at the top level.
          if (rest === '') continue;
          if (indentOf(inner.content) >= fence.quotedBase) {
            const run = runLength(rest, 0, fence.character);
            if (run >= fence.length && rest.length === run) fence = null;
            continue;
          }
          // Dedented past the QUOTED container that held it - a sibling bullet, a quoted paragraph,
          // a quoted heading. The list item ended, so the fence ended with it and did not run on
          // to swallow the rest of the quote. This line is then the ordinary content it is.
          fence = null;
        } else {
          // Fewer markers than the fence opened under: the block quote ended on this line, so the
          // fence ended with it rather than running on and swallowing the rest of the file.
          fence = null;
        }
      } else {
        // Dedented past the container that held it: the list item ended, so the fence ended with
        // it. This line is then read as the ordinary content it is.
        fence = null;
      }
    }

    if (comment !== null) {
      const end = line.indexOf(comment);
      if (end === -1) continue;
      const rest = line.slice(end + comment.length);
      comment = null;
      if (rest.trim() === '') continue;
      block.push({ content: rest, line: lineNumber });
      continue;
    }

    if (trimmed === '') {
      // A blank line ends the block quote outright, so nothing it held is still open.
      quotedContainers.length = 0;
      flush();
      continue;
    }

    const indent = indentOf(line);
    while (containers.length > 0 && indent < containers[containers.length - 1]) containers.pop();
    const base = containers.length > 0 ? containers[containers.length - 1] : 0;

    // THE MARKERS COME OFF FIRST. Every test below measures the QUOTED CONTENT COLUMN, so a fence
    // and a four-space indent are seen inside a quote exactly as they are outside one.
    const quoted = peelQuotes(line.slice(base));
    const depth = quoted.depth;
    let content = quoted.content;

    let quotedBase = 0;
    if (depth === 0) {
      quotedContainers.length = 0;
    } else {
      // A block quote's own paragraph, which may wrap exactly as any other does. A different marker
      // run is a different quote, so it is a different block; a line with NO marker is left alone,
      // because CommonMark continues a quoted paragraph lazily and a link wrapped across that
      // boundary is a link.
      if (depth !== quoteDepth) flush();
      quoteDepth = depth;
      if (content.trim() === '') {
        // `>` carrying nothing is a quoted blank line: it ends the quoted paragraph, exactly as an
        // unquoted blank line ends an unquoted one. The list item it sits in survives it, so the
        // quoted container stack stands.
        flush();
        continue;
      }
      // A LIST ITEM INSIDE THE QUOTE MOVES THE CONTENT COLUMN exactly as one outside it does, and
      // the indented-code test below measures from there. Without this a nested bullet under a
      // quoted parent reads as four spaces of code and its link goes unchecked, which is the false
      // GREEN this whole change is guarding against.
      const inner = indentOf(content);
      while (quotedContainers.length > 0 && inner < quotedContainers[quotedContainers.length - 1]) {
        quotedContainers.pop();
      }
      quotedBase = quotedContainers.length > 0 ? quotedContainers[quotedContainers.length - 1] : 0;
      content = content.slice(quotedBase);
    }

    const relativeIndent = indentOf(content);

    const fenceOpen = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (fenceOpen && !(fenceOpen[1][0] === '`' && fenceOpen[2].includes('`'))) {
      flush();
      fence = { character: fenceOpen[1][0], length: fenceOpen[1].length, base, quotedBase, depth };
      continue;
    }

    if (relativeIndent >= 4 && block.length === 0) {
      // An indented code block. Nothing in it is a target.
      continue;
    }

    const marker = /^ {0,3}([-+*]|\d{1,9}[.)])( +)/.exec(content);
    if (marker) {
      // A new list item is a new block: `- [Item one` and `- Item two](./x)` are two items and no
      // link at all, so they must never be joined.
      flush();
      // Each stack holds the column in ITS OWN coordinate: the line's for an unquoted item, the
      // quoted content's for one inside a quote, because a marker past a `>` does not compare with
      // a marker before one.
      if (depth === 0) containers.push(base + marker[0].length);
      else {
        quotedContainers.push(quotedBase + marker[0].length);
        quoteDepth = depth;
      }
      content = content.slice(marker[0].length);
    }

    const opener = /^ {0,3}(\{\/\*|<!--)/.exec(content);
    if (opener) {
      const closer = opener[1] === '<!--' ? '-->' : '*/}';
      const end = content.indexOf(closer, opener[0].length);
      if (end === -1) {
        flush();
        comment = closer;
        continue;
      }
      content = content.slice(end + closer.length);
      if (content.trim() === '') continue;
    }

    if (/^ {0,3}(#{1,6}( |$)|([-*_])( *\3){2,} *$)/.test(content)) {
      // An ATX heading and a thematic break are each a block of their own: a construct cannot wrap
      // out of one and into the line below it.
      flush();
      block.push({ content, line: lineNumber });
      flush();
      continue;
    }

    block.push({ content, line: lineNumber });
  }

  flush();
  return found;
}

// ---------------------------------------------------------------------------
// FRONTMATTER, READ BY HAND
// ---------------------------------------------------------------------------

/**
 * The document id a file DECLARES, read without a YAML parser.
 *
 * The value is taken LITERALLY after trimming surrounding whitespace and stripping AT MOST ONE
 * surrounding pair of matching quotes, and no type judgement is made: `id: 837` declares `837`,
 * unquoted digits being a value rather than an error, and a bare `id:` declares nothing at all, so
 * the path derivation stands and nothing reds. What a hand parse CAN see is not a scalar is a value
 * opening a block scalar (`|` or `>`) or a flow collection (`[` or `{`), tested on the first
 * character of the raw value and nothing else. That test runs BEFORE the quote strip, so
 * `id: "[a]"` is an ordinary quoted string.
 *
 * @param {string} text
 * @returns {{ id: string | null, malformed: string | null }}
 */
export function declaredId(text) {
  const lines = String(text).split(/\r?\n/);
  const first = lines[0] === undefined ? '' : stripBom(lines[0]).replace(/\s+$/, '');
  if (first !== '---') return { id: null, malformed: null };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].replace(/\s+$/, '') === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { id: null, malformed: 'a frontmatter block is opened by `---` and never closed' };
  }
  for (let i = 1; i < end; i += 1) {
    const match = /^id:(.*)$/.exec(lines[i]);
    if (!match) continue;
    const raw = match[1].trim();
    if (raw === '') return { id: null, malformed: null };
    if (['|', '>', '[', '{'].includes(raw[0])) {
      return {
        id: null,
        malformed: `the frontmatter \`id\` opens a ${raw[0] === '|' || raw[0] === '>' ? 'block scalar' : 'flow collection'} (\`${raw[0]}\`), which is not a document id`,
      };
    }
    let value = raw;
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value[value.length - 1] === value[0]
    ) {
      value = value.slice(1, -1);
    }
    return { id: value === '' ? null : value, malformed: null };
  }
  return { id: null, malformed: null };
}

// ---------------------------------------------------------------------------
// TARGET RESOLUTION, RULES 1 TO 6
// ---------------------------------------------------------------------------

/**
 * Resolve `target` segments against a directory, normalizing `.` and `..`.
 *
 * EMPTY SEGMENTS ARE DROPPED on this side, and the listing side never has one, so a trailing slash
 * cannot make a link the site serves red: `./reference/` yields `reference`, whose `<t>/index.md`
 * spelling then matches `reference/index.md`.
 *
 * @param {string[]} directory segments of the containing file's directory, relative to the root
 * @param {string} target
 * @returns {string | null} the `/`-joined result, or null when it escapes the root
 */
export function resolveWithin(directory, target) {
  const out = [...directory];
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/** An RFC 3986 section 3.1 scheme MUST begin with a letter, so `837:institutional` is not one. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Rules 1 to 5: what class of target this is, and where it points when it is package-internal.
 *
 * @param {string} raw
 * @param {string} fileRelative the containing file's path relative to `docs-content/`
 * @returns {{ class: 'anchor'|'external'|'site-absolute'|'cross-package'|'internal', path?: string }}
 */
export function classifyTarget(raw, fileRelative) {
  const cut = raw.search(/[#?]/);
  const head = cut === -1 ? raw : raw.slice(0, cut);
  let decoded;
  try {
    decoded = decodeURIComponent(head);
  } catch {
    // A malformed escape (`./promos/50%off`) is never a finding and never a throw: the raw text
    // stands in for the decode that could not happen.
    decoded = head;
  }
  if (decoded === '') return { class: 'anchor' };
  if (SCHEME.test(decoded)) return { class: 'external' };
  if (decoded.startsWith('/')) return { class: 'site-absolute' };
  const directory = fileRelative.split('/').slice(0, -1);
  const resolved = resolveWithin(directory, decoded);
  if (resolved === null) return { class: 'cross-package' };
  return { class: 'internal', path: resolved };
}

/**
 * The five spellings a LINK may resolve through.
 *
 * The permissiveness runs across SPELLINGS and never across object types: every candidate must be a
 * REGULAR FILE, so a bare directory named `<t>` resolves nothing. The list already spells
 * `<t>/index.md`, which is the only way a directory participates.
 *
 * @param {string} target
 */
export function linkCandidates(target) {
  if (target === '') return ['index.md', 'index.mdx'];
  return [target, `${target}.md`, `${target}.mdx`, `${target}/index.md`, `${target}/index.mdx`];
}

// ---------------------------------------------------------------------------
// SIDEBARS
// ---------------------------------------------------------------------------

/** @param {string} token */
function pointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Collect every document id `sidebars.json` names, plus everything that is malformed.
 *
 * A sidebar VALUE that is an ARRAY is a list of items. A plain OBJECT carrying no `"type"` key is
 * the LEGACY category shape, whose keys are labels and whose values are each themselves a sidebar:
 * without that arm a legacy-shaped file yields zero ids and every dangling id in it passes
 * unnoticed. Anything else is B3 naming the sidebar key, an object CARRYING a `"type"` key
 * included, because that is a single ITEM standing where a sidebar belongs.
 *
 * Only an ARRAY POSITION carries an id. A string that is the value of a key (`label`, `type`,
 * `href`, `dirName`) is never one, which is what keeps `"category"` and `"Guides"` out.
 *
 * @param {Record<string, unknown>} parsed
 */
export function collectSidebar(parsed) {
  /** @type {{id: string, pointer: string}[]} */
  const ids = [];
  /** @type {{dirName: string, pointer: string}[]} */
  const autogenerated = [];
  /** @type {{href: string, pointer: string}[]} */
  const links = [];
  /** @type {{type: string, pointer: string}[]} */
  const unrecognized = [];
  /** @type {{pointer: string, message: string}[]} */
  const malformed = [];

  /** @param {unknown} value */
  const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

  /**
   * @param {unknown} item
   * @param {string} pointer
   */
  function walkItem(item, pointer) {
    if (typeof item === 'string') {
      ids.push({ id: item, pointer });
      return;
    }
    if (!isPlainObject(item)) {
      malformed.push({
        pointer,
        message: `a sidebar item is ${item === null ? 'null' : `a ${Array.isArray(item) ? 'array' : typeof item}`}, which is neither a document id nor an item object`,
      });
      return;
    }
    const record = /** @type {Record<string, unknown>} */ (item);
    if (!('type' in record)) {
      malformed.push({ pointer, message: 'a sidebar item object carries no "type"' });
      return;
    }
    if (typeof record.type !== 'string') {
      malformed.push({ pointer, message: `a sidebar item's "type" is ${typeof record.type}, not a string` });
      return;
    }
    switch (record.type) {
      case 'doc': {
        if (typeof record.id !== 'string') {
          malformed.push({ pointer, message: '`{"type": "doc"}` carries no string "id"' });
          return;
        }
        ids.push({ id: record.id, pointer: `${pointer}/id` });
        return;
      }
      case 'category': {
        if (isPlainObject(record.link)) {
          const link = /** @type {Record<string, unknown>} */ (record.link);
          if (link.type === 'doc') {
            if (typeof link.id !== 'string') {
              malformed.push({ pointer: `${pointer}/link`, message: 'a category `link` of `{"type": "doc"}` carries no string "id"' });
            } else {
              ids.push({ id: link.id, pointer: `${pointer}/link/id` });
            }
          }
        }
        if (!Array.isArray(record.items)) {
          malformed.push({ pointer, message: '`{"type": "category"}` carries no array "items"' });
          return;
        }
        record.items.forEach((child, index) => walkItem(child, `${pointer}/items/${index}`));
        return;
      }
      case 'autogenerated': {
        if (typeof record.dirName !== 'string') {
          malformed.push({ pointer, message: '`{"type": "autogenerated"}` carries no string "dirName"' });
          return;
        }
        // No id: an autogenerated category's ids do not exist until the site builds. Its `dirName`
        // is checked as a DIRECTORY instead, the one place a directory satisfies a check.
        autogenerated.push({ dirName: record.dirName, pointer: `${pointer}/dirName` });
        return;
      }
      case 'link': {
        if (typeof record.href !== 'string') {
          malformed.push({ pointer, message: '`{"type": "link"}` carries no string "href"' });
          return;
        }
        links.push({ href: record.href, pointer: `${pointer}/href` });
        return;
      }
      default: {
        // Docusaurus has more types than this gate enumerates, and reddening on one of them would
        // be a false red.
        unrecognized.push({ type: record.type, pointer });
      }
    }
  }

  /**
   * @param {unknown} value
   * @param {string} pointer
   * @param {string} sidebarKey
   */
  function walkSidebar(value, pointer, sidebarKey) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walkItem(item, `${pointer}/${index}`));
      return;
    }
    if (isPlainObject(value) && !('type' in /** @type {Record<string, unknown>} */ (value))) {
      for (const [key, child] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
        walkSidebar(child, `${pointer}/${pointerToken(key)}`, sidebarKey);
      }
      return;
    }
    const shape = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    malformed.push({
      pointer,
      message: isPlainObject(value)
        ? `sidebar "${sidebarKey}" is a single ITEM object (it carries a "type" key) where a sidebar belongs`
        : `sidebar "${sidebarKey}" is a ${shape}, which is neither a list of items nor a legacy category object`,
    });
  }

  for (const [key, value] of Object.entries(parsed)) {
    walkSidebar(value, `/${pointerToken(key)}`, key);
  }

  return { ids, autogenerated, links, unrecognized, malformed };
}

/**
 * `.`, `./x` and `x/` all name the same subtree; `null` means the name ESCAPES the root.
 *
 * The pop is CLAMPED, and that is the whole point of the null: popping past the root silently
 * turned `".."` into `""`, which reads as the root and so covers - and excuses from the zero-ids
 * finding - the entire tree. An escaping `dirName` names no directory under `docs-content/`, which
 * is what B2 asks about, and it covers nothing.
 *
 * @param {string} dirName
 * @returns {string | null}
 */
function normalizeDirName(dirName) {
  const segments = String(dirName).split('/');
  /** @type {string[]} */
  const out = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

// ---------------------------------------------------------------------------
// THE CHECK
// ---------------------------------------------------------------------------

/**
 * @typedef {{ code: string, path: string, line: number | null, subject: string, detail: string }} Finding
 * @typedef {{ kind: string, path: string, line: number | null, subject: string, detail: string }} Report
 */

/**
 * @param {{ repo: string }} options
 * @returns {{ findings: Finding[], reports: Report[], counts: Record<string, number>, coverage: {dirName: string, files: number}[] }}
 */
export function checkDocsContent({ repo }) {
  const workspace = toPosix(resolve(repo));
  const root = `${workspace}/${DOCS_ROOT}`;
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Report[]} */
  const reports = [];
  const counts = { files: 0, links: 0, images: 0, ids: 0 };
  /** @type {{dirName: string, files: number}[]} */
  const coverage = [];

  let rootStats;
  try {
    rootStats = statSync(root);
  } catch (error) {
    findings.push({
      code: 'B4',
      path: `${DOCS_ROOT}/`,
      line: null,
      subject: 'check-docs-content',
      detail:
        `the input \`check-docs-content\` is true and this repository has no \`${DOCS_ROOT}/\` ` +
        `directory at its root (${describeError(error)}). A gate that silently no-ops is not a gate: ` +
        `either publish docs-content here or stop passing the input.`,
    });
    return { findings, reports, counts, coverage };
  }
  if (!rootStats.isDirectory()) {
    findings.push({
      code: 'B4',
      path: `${DOCS_ROOT}/`,
      line: null,
      subject: 'check-docs-content',
      detail: `the input \`check-docs-content\` is true and \`${DOCS_ROOT}\` is not a directory.`,
    });
    return { findings, reports, counts, coverage };
  }

  const { entries, unreadable, cycles } = listTree(root);

  for (const entry of unreadable) {
    findings.push({
      code: 'B6',
      path: entry.path === '' ? `${DOCS_ROOT}/` : `${DOCS_ROOT}/${entry.path}`,
      line: null,
      subject: entry.reason,
      detail: 'this entry could not be read, so nothing under it has been checked.',
    });
  }
  for (const cycle of cycles) {
    reports.push({
      kind: 'cycle',
      path: `${DOCS_ROOT}/${cycle.path}`,
      line: null,
      subject: cycle.target,
      detail: 'a directory already on this path; reported once and not entered.',
    });
  }

  const markdownFiles = [...entries.entries()]
    .filter(([relative, kind]) => kind === 'file' && isMarkdown(relative))
    .map(([relative]) => relative)
    .sort();
  counts.files = markdownFiles.length;

  /** @type {Map<string, string>} the id each document declares, by relative path */
  const idsByFile = new Map();
  /** @type {Map<string, string[]>} the files declaring each id */
  const filesById = new Map();
  /** @type {Set<string>} files carrying an explicit frontmatter id */
  const explicitlyIdentified = new Set();
  /** @type {Set<string>} `.md`/`.mdx` files that ARE regular files but whose contents would not read */
  const unreadableFiles = new Set();
  /** @type {Map<string, string>} */
  const contents = new Map();

  for (const relative of markdownFiles) {
    let text;
    try {
      text = readFileSync(`${root}/${relative}`, 'utf8');
    } catch (error) {
      findings.push({
        code: 'B6',
        path: `${DOCS_ROOT}/${relative}`,
        line: null,
        subject: describeError(error),
        detail: 'this file could not be read, so its links and its document id have not been checked.',
      });
      unreadableFiles.add(relative);
      continue;
    }
    contents.set(relative, text);
    const declared = declaredId(text);
    if (declared.malformed) {
      findings.push({
        code: 'B3',
        path: `${DOCS_ROOT}/${relative}`,
        line: null,
        subject: 'frontmatter',
        detail: declared.malformed,
      });
    }
    const pathDerived = withoutExtension(relative);
    let effective = pathDerived;
    if (declared.id !== null) {
      const segments = pathDerived.split('/');
      segments.pop();
      effective = [...segments, declared.id].join('/');
      explicitlyIdentified.add(relative);
    }
    idsByFile.set(relative, effective);
    filesById.set(effective, [...(filesById.get(effective) ?? []), relative]);
  }

  // LINKS AND IMAGES.
  for (const relative of markdownFiles) {
    const text = contents.get(relative);
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    let startLine = 1;
    let body = text;
    if (lines[0] !== undefined && stripBom(lines[0]).replace(/\s+$/, '') === '---') {
      for (let i = 1; i < lines.length; i += 1) {
        if (lines[i].replace(/\s+$/, '') === '---') {
          startLine = i + 2;
          body = lines.slice(i + 1).join('\n');
          break;
        }
      }
    }
    for (const target of extractTargets(body, startLine)) {
      const isImage = target.kind === 'image';
      if (isImage) counts.images += 1;
      else counts.links += 1;
      const classified = classifyTarget(target.raw, relative);
      if (classified.class !== 'internal') {
        reports.push({
          kind: classified.class,
          path: `${DOCS_ROOT}/${relative}`,
          line: target.line,
          subject: target.raw,
          detail: isImage ? 'image destination, not package-internal' : 'not package-internal',
        });
        continue;
      }
      const resolved = /** @type {string} */ (classified.path);
      if (isImage) {
        // No build step invents an extension for an asset, so an image resolves only at its exact
        // path, and a directory sitting there is not a resolution.
        if (entries.get(resolved) === 'file') continue;
        findings.push({
          code: 'B5',
          path: `${DOCS_ROOT}/${relative}`,
          line: target.line,
          subject: target.raw,
          detail:
            `looked for a regular file at exactly \`${DOCS_ROOT}/${resolved}\`` +
            `${entries.has(resolved) ? ` (that path is a ${entries.get(resolved)}, not a regular file)` : ''}.`,
        });
        continue;
      }
      const candidates = linkCandidates(resolved);
      if (candidates.some((candidate) => entries.get(candidate) === 'file')) continue;
      findings.push({
        code: 'B1',
        path: `${DOCS_ROOT}/${relative}`,
        line: target.line,
        subject: target.raw,
        detail: `looked for a regular file at ${candidates.map((candidate) => `\`${DOCS_ROOT}/${candidate}\``).join(', ')}.`,
      });
    }
  }

  // THE SIDEBAR.
  const sidebarPath = `${DOCS_ROOT}/${SIDEBARS}`;
  let sidebarText;
  try {
    sidebarText = readFileSync(`${root}/${SIDEBARS}`, 'utf8');
  } catch (error) {
    findings.push({
      code: 'B3',
      path: sidebarPath,
      line: null,
      subject: describeError(error),
      detail:
        `\`${sidebarPath}\` is the only source of document ids this gate has, so without it no ` +
        `sidebar entry can be checked. Opting in REQUIRES that exact JSON spelling: ` +
        `\`sidebars.js\` and \`sidebars.ts\` cannot be read without executing caller code.`,
    });
    return { findings, reports, counts, coverage };
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(sidebarText);
  } catch (error) {
    findings.push({
      code: 'B3',
      path: sidebarPath,
      line: null,
      subject: 'unparseable JSON',
      detail: `${describeError(error)}. No document id has been checked, rather than checking the ids a partial parse would have produced.`,
    });
    return { findings, reports, counts, coverage };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    findings.push({
      code: 'B3',
      path: sidebarPath,
      line: null,
      subject: `top level is ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`}`,
      detail: 'the top level of the sidebar file must be a JSON object whose keys are sidebar names.',
    });
    return { findings, reports, counts, coverage };
  }

  const sidebar = collectSidebar(/** @type {Record<string, unknown>} */ (parsed));
  counts.ids = sidebar.ids.length;

  for (const entry of sidebar.malformed) {
    findings.push({ code: 'B3', path: sidebarPath, line: null, subject: entry.pointer, detail: entry.message });
  }
  for (const entry of sidebar.unrecognized) {
    reports.push({
      kind: 'unrecognized sidebar type',
      path: sidebarPath,
      line: null,
      subject: entry.pointer,
      detail: `"${entry.type}" is a type this gate does not enumerate; it collects no document id.`,
    });
  }
  for (const entry of sidebar.links) {
    reports.push({
      kind: 'sidebar link',
      path: sidebarPath,
      line: null,
      subject: entry.href,
      detail: 'an external or site-absolute href; it collects no document id.',
    });
  }

  const coveredFiles = new Set();
  for (const entry of sidebar.autogenerated) {
    const dirName = normalizeDirName(entry.dirName);
    if (dirName === null) {
      findings.push({
        code: 'B2',
        path: sidebarPath,
        line: null,
        subject: entry.pointer,
        detail:
          `\`{"type": "autogenerated", "dirName": "${entry.dirName}"}\` climbs out of ` +
          `\`${DOCS_ROOT}/\`, so it names no directory under it and the category would be built ` +
          'over nothing. It covers no file either: a name that escapes the root is not the root.',
      });
      continue;
    }
    if (dirName !== '' && entries.get(dirName) !== 'dir') {
      findings.push({
        code: 'B2',
        path: sidebarPath,
        line: null,
        subject: entry.pointer,
        detail:
          `\`{"type": "autogenerated", "dirName": "${entry.dirName}"}\` needs a DIRECTORY at ` +
          `\`${DOCS_ROOT}/${dirName}\`` +
          `${entries.has(dirName) ? ` (that path is a ${entries.get(dirName)}, not a directory)` : ' and there is none'}. ` +
          'The category would be built over nothing.',
      });
      continue;
    }
    const covered = markdownFiles.filter(
      (relative) => dirName === '' || relative === `${dirName}` || relative.startsWith(`${dirName}/`),
    );
    for (const relative of covered) coveredFiles.add(relative);
    coverage.push({ dirName: entry.dirName, files: covered.length });
  }

  // A `.md`/`.mdx` file that IS there but would not READ has an UNKNOWN declared id, and a
  // frontmatter `id` replaces only the LAST path segment - so an unreadable file could be declaring
  // any id in its own directory. "No document declares this id" is then a claim this run cannot
  // make. The run is already red on that file's B6; adding a B2 beside it would name a second
  // defect that may not exist, which is the same reasoning that keeps such a file out of the orphan
  // report.
  /** @param {string} value */
  const parentOf = (value) => value.split('/').slice(0, -1).join('/');
  const unreadableParents = new Set([...unreadableFiles].map(parentOf));
  /** @param {string} id */
  const couldBeDeclaredByAnUnreadableFile = (id) =>
    unreadableParents.has(parentOf(id)) ||
    unreadableFiles.has(`${id}/index.md`) ||
    unreadableFiles.has(`${id}/index.mdx`);

  const referenced = new Set();
  for (const entry of sidebar.ids) {
    const direct = filesById.get(entry.id);
    if (direct && direct.length > 0) {
      for (const relative of direct) referenced.add(relative);
      continue;
    }
    // The `<id>/index.md` fallback exists for an index file that declares NO id of its own. Where
    // one DOES declare an id, the tree declares that id and not this path, and resolving anyway
    // would green a dangling entry "against paths alone".
    const fallback = [`${entry.id}/index.md`, `${entry.id}/index.mdx`].find(
      (candidate) => entries.get(candidate) === 'file' && !explicitlyIdentified.has(candidate),
    );
    if (fallback) {
      referenced.add(fallback);
      continue;
    }
    if (couldBeDeclaredByAnUnreadableFile(entry.id)) {
      reports.push({
        kind: 'unchecked id',
        path: sidebarPath,
        line: null,
        subject: entry.id,
        detail:
          'a `.md`/`.mdx` file that would not read could be declaring this id, so whether it ' +
          'resolves is unknown. That file is named by its own B6 above, and this run is red on it.',
      });
      continue;
    }
    const shadowed = [`${entry.id}/index.md`, `${entry.id}/index.mdx`].find(
      (candidate) => entries.get(candidate) === 'file',
    );
    findings.push({
      code: 'B2',
      path: sidebarPath,
      line: null,
      subject: entry.pointer,
      detail:
        `no document under \`${DOCS_ROOT}/\` declares the id \`${entry.id}\`. Looked for a ` +
        `\`.md\`/\`.mdx\` regular file whose id (its path without the extension, with a ` +
        `frontmatter \`id\` replacing the last segment) is \`${entry.id}\`, and for ` +
        `\`${DOCS_ROOT}/${entry.id}/index.md\` or \`${DOCS_ROOT}/${entry.id}/index.mdx\`` +
        `${shadowed ? ` (\`${DOCS_ROOT}/${shadowed}\` exists but declares its own id, so the tree does not declare \`${entry.id}\`)` : ''}.`,
    });
  }

  if (sidebar.ids.length === 0) {
    const uncovered = markdownFiles.filter((relative) => !coveredFiles.has(relative));
    if (uncovered.length > 0) {
      findings.push({
        code: 'B3',
        path: sidebarPath,
        line: null,
        subject: 'zero document ids',
        detail:
          `the sidebar file collects NO document id while ${uncovered.length} \`.md\`/\`.mdx\` ` +
          `file(s) under \`${DOCS_ROOT}/\` are covered by no \`{"type": "autogenerated"}\` entry ` +
          `(${uncovered.slice(0, 5).join(', ')}${uncovered.length > 5 ? ', ...' : ''}). An empty ` +
          'sidebar and a deleted one say the same thing about what the site shows.',
      });
    }
  }

  for (const relative of markdownFiles) {
    if (referenced.has(relative) || coveredFiles.has(relative)) continue;
    // A file that IS a regular `.md`/`.mdx` file but would not READ is counted in `files` and does
    // satisfy B3's "at least one `.md`" clause - it exists, which is what those two count. What was
    // never read is its FRONTMATTER, so the id it declares is unknown and "no sidebar entry
    // references it" is a claim this run cannot make. It is named once, by the B6 above, rather
    // than a second time as an orphan whose id prints `undefined`. The broad-B6 reading's "counted
    // NOWHERE else" governs an entry that is not a regular file, which this one is.
    if (unreadableFiles.has(relative)) continue;
    reports.push({
      kind: 'orphan',
      path: `${DOCS_ROOT}/${relative}`,
      line: null,
      subject: /** @type {string} */ (idsByFile.get(relative)),
      detail: 'no sidebar entry references it and no autogenerated entry covers it; the site will not show it.',
    });
  }

  return { findings, reports, counts, coverage };
}

// ---------------------------------------------------------------------------
// OUTPUT
// ---------------------------------------------------------------------------

const CODES = {
  B1: 'a package-internal LINK target that resolves to no regular file',
  B2: 'a document id or an autogenerated dirName that resolves to nothing',
  B3: 'the sidebar file, a sidebar entry or a frontmatter block is malformed',
  B4: 'the input is on and this repository publishes no docs-content/',
  B5: 'a package-internal IMAGE destination that resolves to no regular file',
  B6: 'an entry under docs-content/ that could not be read',
};

/**
 * @param {{ findings: Finding[], reports: Report[], counts: Record<string, number>, coverage: {dirName: string, files: number}[] }} result
 */
export function render(result) {
  const lines = [];
  const { findings, reports, counts, coverage } = result;

  lines.push(
    `Checked ${counts.files} file(s), ${counts.links} link(s), ${counts.images} image(s) and ` +
      `${counts.ids} document id(s) under \`${DOCS_ROOT}/\`.`,
  );

  lines.push('');
  lines.push(`Reported, never failed (${reports.length}):`);
  if (reports.length === 0) lines.push('  (none)');
  for (const report of reports) {
    const at = report.line === null ? report.path : `${report.path}:${report.line}`;
    lines.push(`  ${report.kind}: ${at}  ${report.subject}  ${report.detail}`);
  }
  for (const entry of coverage) {
    lines.push(`  autogenerated coverage: dirName "${entry.dirName}" covers ${entry.files} file(s).`);
  }

  lines.push('');
  if (findings.length === 0) {
    lines.push('No blocking findings.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(`BLOCKING findings (${findings.length}), every one of them:`);
  for (const finding of findings) {
    const at = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
    lines.push(`  ${finding.code} ${at}  ${finding.subject}`);
    lines.push(`     ${finding.detail}`);
  }
  lines.push('');
  const seen = [...new Set(findings.map((finding) => finding.code))].sort();
  for (const code of seen) {
    lines.push(`  ${code} = ${CODES[/** @type {keyof typeof CODES} */ (code)]}`);
  }
  return `${lines.join('\n')}\n`;
}

const USAGE = 'usage:\n  docs-content-check.mjs [--repo <dir>]\n';

/** @param {string[]} argv */
export function main(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      process.stderr.write(`unexpected argument ${JSON.stringify(token)}\n${USAGE}`);
      return 2;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      process.stderr.write(`${token} needs a value\n${USAGE}`);
      return 2;
    }
    options[token.slice(2)] = value;
    i += 1;
  }
  if (Object.keys(options).some((key) => key !== 'repo')) {
    process.stderr.write(`${USAGE}`);
    return 2;
  }

  const result = checkDocsContent({ repo: options.repo ?? '.' });
  process.stdout.write(render(result));
  if (result.findings.length > 0) {
    process.stdout.write(
      `::error title=docs-content has ${result.findings.length} blocking finding(s)::` +
        `A link, an image or a sidebar document id in this repository's docs-content/ resolves to ` +
        `nothing. Published, it breaks docs.cosyte.com. Every finding is printed in the step log.\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && toPosix(resolve(process.argv[1])) === toPosix(resolve(new URL(import.meta.url).pathname))) {
  process.exitCode = main(process.argv.slice(2));
}
