// The ONE reader every suite uses to answer a question about `.github/workflows/release.yml`.
//
// NOT a YAML parser, and deliberately not one. This repository has no `package.json`, no lockfile and
// no install step on purpose, so `node:test` and `node:assert` are the whole toolbox and Node ships
// no YAML parser. What this is instead is a reader that DECLARES ITS SUBSET AND REFUSES EVERYTHING
// OUTSIDE IT. Recognising that a line, a key or a value is not in the subset is strictly easier than
// understanding it, and refusing is the only answer that cannot silently stop enforcing a criterion.
//
// WHY THIS FILE EXISTS AT ALL, said once. Three suites decide whether `release.yml` still gates
// publication behind a human-approved environment: `environment-gate.test.mjs`,
// `release-notes.test.mjs` and `install-check.test.mjs`. Each used to read the workflow with its own
// line-oriented reader, and each of those answered "absent", "empty" or "unconditional" about a
// construct it did not model. An assertion handed that answer PASSES, so a legal edit to `release.yml`
// could remove the gate, or hand the npm write credential to the un-approved job, with every suite
// green. Four separate reviews found four different legal spellings that did exactly that, and each
// fix closed the spelling in one reader while leaving it open in the next. One reader is what stops a
// guard being defeated by moving the defect into the scope only the weakest of them owned.
//
// THE SUBSET, stated so a refusal can be checked against it rather than argued about:
//
//   workflow scope  a top-level `jobs:` key at column 0; `permissions:` and `env:` blocks whose
//                   children sit at two spaces; `env:` additionally as a one-line flow mapping and
//                   under a quoted key. Everything else above `jobs:` is read as TEXT, never parsed.
//                   Those two blocks are closed by the next key at column 0 and by NOTHING ELSE: a
//                   blank line inside a block mapping is legal YAML that means nothing, and a reader
//                   that stopped at one reported every key below it absent.
//   job scope       `  <id>:` at two spaces; job keys at four; the children of a key that opens a
//                   mapping at six. A job key whose value is a block or folded indicator, an alias,
//                   an anchor or a merge key is REFUSED, not read.
//   step scope      `      - ` opening a list entry; step keys at eight; the children of `with:` and
//                   `env:` at whatever indent that block's own first child establishes. A key whose
//                   value lives on the lines below it is folded to the value Actions would use, and
//                   never left holding `|`, `>-` or the empty string.
//   everywhere      a key that appears twice in one mapping cannot be resolved to a single value, so
//                   it is refused rather than resolved by last-one-wins.
//
// AND COMMENTS ARE NOT WHAT A `#` LOOKS LIKE. `#` starts a comment in YAML's flow of nodes and starts
// NOTHING inside a block scalar: a line whose first non-blank character is `#` inside a `run: |` body
// is content, Actions interpolates `${{ }}` in it before the shell sees it, and the runner executes
// it. A stripper that deleted every `#`-first line therefore erased a real, credential-carrying line
// out of the un-approved job before any sweep could read it. `decomment` below tracks block scalars
// for that reason and for no other - and it tracks them by the WHOLE `c-b-block-header` production,
// not by the one spelling of it this workflow happens to use, because a header the stripper does not
// recognise is a body it does not know exists.

const indentOf = (line) => line.length - line.replace(/^[ \t]*/, '').length;

/**
 * YAML 1.2's `c-b-block-header`, as a regex fragment, so every place that has to recognise one reads
 * the SAME definition:
 *
 *     c-b-block-header(m,t) ::= ( ( c-indentation-indicator(m) c-chomping-indicator(t) )
 *                               | ( c-chomping-indicator(t) c-indentation-indicator(m) ) )
 *                               s-b-comment
 *
 * A FAMILY OF SPELLINGS, NOT ONE, and it is written out of the production rather than off the file
 * in front of it because that is precisely the mistake it replaces. The indicators come in EITHER ORDER,
 * so `|2-` and `|-2` are the same scalar, and a comment may follow them, so `| # write the npmrc` is
 * still just `|`. The spec's own Example 8.1 prints `| # Empty header` and `>1- # Both indicators`
 * side by side. A reader that models the bare `|` alone does not merely misread the other two: it
 * does not see that a block scalar was opened at all, so `decomment` below deletes the `#`-first
 * lines of the body, which inside a block scalar are CONTENT the runner's shell receives.
 *
 * IT OVER-RECOGNISES ON PURPOSE, in the one direction that is safe. `[+-]?\d*[+-]?` accepts orders
 * and repetitions YAML rejects (`|--`, `|22`), and the comment is allowed to touch the indicator. A
 * header this fragment accepts and YAML rejects costs nothing, because a workflow YAML rejects never
 * runs; a header YAML accepts and this fragment rejects is a body silently stripped of content.
 */
const BLOCK_HEADER = String.raw`[|>][+-]?\d*[+-]?(?:[ \t]*#.*)?`;

/**
 * A key line that opens a block scalar: `run: |`, `body: >-`, `text: |2`, `run: | # note`, and the
 * same inside a sequence entry. Its body is every following line indented deeper than the key.
 */
const BLOCK_SCALAR_OPENER = new RegExp(
  String.raw`^([ \t]*(?:-[ \t]+)*)(?:"[^"]*"|'[^']*'|[\w.-]+)[ \t]*:[ \t]*${BLOCK_HEADER}[ \t]*$`,
);

/**
 * Drop whole-line comments, and ONLY the ones that are comments.
 *
 * Returns lines rather than text, which is what every caller here wants.
 */
export function decomment(text) {
  const kept = [];
  let bodyIndent = null;
  for (const line of String(text).split('\n')) {
    if (bodyIndent !== null) {
      if (line.trim() === '' || indentOf(line) >= bodyIndent) {
        kept.push(line);
        continue;
      }
      bodyIndent = null;
    }
    const opens = BLOCK_SCALAR_OPENER.exec(line);
    if (opens) {
      bodyIndent = opens[1].length + 1;
      kept.push(line);
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    kept.push(line);
  }
  return kept;
}

/** `write # create tags` -> `write`. Only ` # ` counts, so a `${{ }}` expression is never cut. */
export function stripTrailingComment(value) {
  return String(value).replace(/\s+#\s.*$/, '').trim();
}

/** A step's own keys sit here, one level under the `- ` that opens the list entry. */
export const STEP_KEY_INDENT = 8;

/**
 * A key-line value that is not the value: the key's real value is on the lines below it.
 *
 * Empty, or a block-scalar header in any of its spellings (`BLOCK_HEADER` above: the indicators in
 * either order, with or without a comment after them). YAML says all of those mean "read on", and a
 * line-oriented reader that stops at the colon comes back holding `""` or `">-"` and believes it.
 * That is the failure this constant exists to name: not a line the reader could not read, which it
 * refuses, but a line it read and got WRONG, which it used to hand on to an assertion as if it were
 * a condition. Built from the same fragment as the opener, because a header one of them recognises
 * and the other does not is a body kept as content under a key still holding two punctuation marks.
 */
export const VALUE_LIVES_BELOW = new RegExp(String.raw`^(?:${BLOCK_HEADER})?[ \t]*$`);

/** A value this reader cannot resolve to a single scalar: a YAML alias, or an anchor. */
const ALIAS_OR_ANCHOR = /^[*&]\S/;

/** A merge key. Its referent is elsewhere in the document and this reader does not resolve it. */
const MERGE_KEY = /^\s*(?:["']?<<["']?)\s*:/;

/**
 * The value that lives on the lines below `lines[at]`, folded onto one line.
 *
 * Everything more indented than the key, blanks skipped, joined with single spaces - which is what a
 * folded scalar (`>-`) means and is close enough for a literal one (`|`) too, because every caller
 * here matches patterns against the result rather than executing it.
 */
export function valueBelow(lines, at) {
  if (at < 0) return '';
  const keyIndent = indentOf(lines[at]);
  const folded = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') continue;
    if (indentOf(line) <= keyIndent) break;
    folded.push(line.trim());
  }
  return folded.join(' ');
}

/**
 * Parse ONE step from the raw lines of a `- ` list entry under a job's `steps:`.
 *
 * `fields` are the step's own keys; `with` and `env` are their nested maps, read only while the
 * reader is positioned inside those two blocks, so a `run:` script line can never be mistaken for an
 * input or a variable.
 *
 * IT REFUSES A LINE IT CANNOT READ, WHICH IS THE WHOLE POINT. An earlier version dropped a step-key
 * line its pattern did not match, and the pattern required the colon to touch the key:
 * `        if : ${{ ... }}` - one space before the colon - is valid YAML, a real condition GitHub
 * acts on and actionlint typechecks, and it went straight onto the floor. `fields.if` then came back
 * `undefined` for a step that carries a condition, and every step-condition assertion in this
 * repository read such a step as unconditional and stayed green.
 *
 * SO EVERY LINE HANDED TO THIS FUNCTION IS ACCOUNTED FOR, at one of three levels:
 *
 *   - at `STEP_KEY_INDENT`, it is a step key or it is a parse failure naming the job and the step;
 *   - inside an open `with:`/`env:` block, at whatever indent that block's FIRST child established
 *     (ten spaces here, but discovered rather than hardcoded, so a block written at nine is read
 *     rather than skipped), it is a child key, or a `- ` item continuing the child key above it, or
 *     it is a parse failure;
 *   - deeper than the key it follows, it is that key's value continued below the colon, and it is
 *     FOLDED INTO THAT KEY rather than discarded. A `run: |` body, a `>-` condition and a wrapped
 *     plain scalar are all the same shape, and discarding any of them leaves the key holding an
 *     indicator or an empty string that an assertion then believes.
 *
 * THE SEQUENCE ITEM IS READ RATHER THAN REFUSED, and that is the one direction this reader was wrong
 * in the other way. YAML lets a sequence sit at its parent key's own indent, so `path:` followed by
 * `- dist-artifacts/a` at the SAME column is legal, common in `actions/upload-artifact` inputs, and
 * was refused here as illegible. Refusing legal YAML fails closed, so it never let a criterion go
 * unenforced, but it spends the next maintainer's afternoon on a parse failure that is not a real
 * finding, and this reader's contract is to refuse what it cannot READ, not what it has not SEEN. An
 * item under no key at all, or under a key that already carries a scalar, is not legal YAML and
 * still refuses.
 *
 * A `with:` or `env:` carrying a value instead of opening a block (a flow mapping, `env: {A: b}`)
 * refuses for the same reason: this reader cannot read one, and returning an empty map for it would
 * report "no such input" about inputs that are there.
 */
export function parseStep(index, jobId, rawLines) {
  const lines = [`        ${rawLines[0]}`, ...rawLines.slice(1)];
  /** @type {Record<string, string>} */
  const fields = {};
  const blocks = { with: {}, env: {} };
  /** Step keys that opened a mapping this reader read into `blocks`, so `''` is not their value. */
  const opened = new Set();
  const at = `step ${index} of job \`${jobId}\``;
  /**
   * AC1 asks a refusal to name the job, and the step "by label or index". The index is always
   * available and the label often is not - the name may sit below the line that failed - so the
   * index is in the sentence and the label is APPENDED when it is known. Appended rather than
   * interpolated so the sentence a reader greps for does not change shape depending on which line
   * of a step went wrong.
   */
  const labelled = (message) =>
    `${message}${fields.name === undefined ? '' : ` [step: ${JSON.stringify(fields.name)}]`}`;
  const unreadable = (line, where) =>
    new Error(labelled(`parse failure: unreadable line in ${at}${where}: ${JSON.stringify(line)}`));
  const unresolvable = (key, why) => new Error(labelled(`parse failure: \`${key}:\` in ${at} ${why}`));

  /** `null` at step-key level; otherwise the open block and the indent its children were found at. */
  let open = null;
  /** The key whose value may continue on the lines below it, and the lines seen so far. */
  let pending = null;

  const startPending = (store, key, seed, keyIndent) => {
    pending = {
      store,
      key,
      seed,
      indicator: VALUE_LIVES_BELOW.test(seed) ? seed : null,
      indent: keyIndent,
      lines: [],
    };
  };

  const resolvePending = (sequenceFollows) => {
    if (!pending) return;
    const { store, key, seed, indicator, lines: body } = pending;
    pending = null;
    const folded = body.filter((line) => line.trim() !== '').map((line) => line.trim()).join(' ');
    if (indicator === null) {
      store[key] = folded === '' ? seed : `${seed} ${folded}`;
      return;
    }
    if (folded !== '') {
      // The indicator is dropped: `if: >-` with `${{ always() }}` below it IS `${{ always() }}` to
      // Actions, and handing an assertion the string `">-"` is how a condition stopped being read.
      store[key] = folded;
      return;
    }
    if (sequenceFollows) {
      store[key] = '';
      return;
    }
    throw unresolvable(
      key,
      indicator === ''
        ? 'is empty and nothing below it supplies a value, so it cannot be resolved to a single value'
        : `opens a \`${indicator}\` block scalar with no body, so it cannot be resolved to a single value`,
    );
  };

  const define = (store, key, value, where) => {
    if (Object.hasOwn(store, key)) {
      throw new Error(
        labelled(
          `parse failure: duplicate key \`${key}\` in ${at}${where}, which cannot be resolved to a single value`,
        ),
      );
    }
    if (ALIAS_OR_ANCHOR.test(value)) {
      throw unresolvable(key, 'is a YAML alias or anchor whose referent this reader does not resolve');
    }
    store[key] = value;
  };

  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = line.length - line.replace(/^ */, '').length;

    if (pending && indent > pending.indent) {
      pending.lines.push(line);
      continue;
    }
    const isSequenceItem =
      open !== null && open.indent !== null && indent === open.indent && /^ *- /.test(line);
    resolvePending(isSequenceItem);

    if (MERGE_KEY.test(line)) {
      throw unresolvable('<<', 'is a merge key whose referent this reader does not resolve');
    }

    if (open && open.indent === null && indent > STEP_KEY_INDENT) open.indent = indent;
    if (open && open.indent !== null && indent >= open.indent) {
      const item = new RegExp(`^ {${open.indent}}- (.*)$`).exec(line);
      if (item) {
        const under = open.last === null ? null : blocks[open.key][open.last];
        if (under === null || !(under === '' || under.startsWith('\n- '))) {
          throw unreadable(line, `, a sequence item inside \`${open.key}:\` under no key it can belong to`);
        }
        blocks[open.key][open.last] = `${under}\n- ${stripTrailingComment(item[1])}`;
        continue;
      }
      const child = new RegExp(`^ {${open.indent}}([\\w-]+):\\s?(.*)$`).exec(line);
      if (!child) throw unreadable(line, `, inside \`${open.key}:\``);
      define(blocks[open.key], child[1], stripTrailingComment(child[2]), `, inside \`${open.key}:\``);
      open.last = child[1];
      startPending(blocks[open.key], child[1], blocks[open.key][child[1]], open.indent);
      continue;
    }
    open = null; // anything shallower than the children closes the block

    if (indent > STEP_KEY_INDENT) throw unreadable(line, ', deeper than any key this step opened');
    if (indent < STEP_KEY_INDENT) throw unreadable(line, ', shallower than this step');
    const key = /^ {8}([\w-]+):\s?(.*)$/.exec(line);
    if (!key) throw unreadable(line, '');
    define(fields, key[1], stripTrailingComment(key[2]), '');
    if (key[1] === 'with' || key[1] === 'env') {
      if (fields[key[1]] !== '') throw unreadable(line, `, a \`${key[1]}:\` this parser cannot read`);
      opened.add(key[1]);
      open = { key: key[1], indent: null, last: null };
    } else {
      startPending(fields, key[1], fields[key[1]], STEP_KEY_INDENT);
    }
  }
  resolvePending(false);

  if (fields.name === undefined && fields.uses === undefined && fields.run === undefined) {
    throw new Error(
      `parse failure: step ${index} of job \`${jobId}\` has neither a name, a uses nor a run: ` +
        JSON.stringify(lines.join('\n').slice(0, 120)),
    );
  }
  const label = fields.name ?? fields.uses ?? `${jobId} step ${index}`;
  return { index, job: jobId, fields, opened, with: blocks.with, env: blocks.env, label, body: lines.join('\n') };
}

/**
 * A step-level condition spelled as TEXT, in every spelling of the key.
 *
 * `["']?` optional and `\s*` before the colon: that sees `if:`, `if :` and `"if":`, which are the
 * three spellings a reviewer has already got past a version of these suites. The reader refusing an
 * unreadable line is the guarantee; this is the backstop that keeps biting if a later edit loosens
 * the reader again, which is exactly the edit that already happened once.
 *
 * It does NOT match `if-no-files-found:` or a shell `if [ ... ]; then` in a `run:` body: the colon
 * has to follow the key, with only quotes and blanks between.
 */
export const STEP_CONDITION_LINE = /^\s*["']?if["']?\s*:/m;

/**
 * The same, as a scan: every condition a step spells, however it spells the key AND WHEREVER IT PUTS
 * THE VALUE.
 *
 * The second half is what a reader that stops at the colon gets wrong. Taking the text after the
 * colon is right for `if: ${{ always() }}` and wrong for `if: >-` with the expression on the next
 * line: that returns the block-scalar indicator `">-"`, which is not `undefined`, so every check that
 * only needs a condition to EXIST still fires while the one that needs the condition's CONTENT reads
 * a step's `always()` as no `always()` at all.
 */
export function conditionsOf(step) {
  const lines = step.body.split('\n');
  const spelled = [];
  for (const [at, line] of lines.entries()) {
    const key = /^[ \t]*["']?if["']?[ \t]*:(.*)$/.exec(line);
    if (!key) continue;
    const value = key[1];
    spelled.push(VALUE_LIVES_BELOW.test(value.trim()) ? `${value} ${valueBelow(lines, at)}` : value);
  }
  return [step.fields.if ?? '', ...spelled].join(' ');
}

/**
 * The status-check functions, which are how a step opts back in after something above it failed.
 *
 * ANY of them dropped into a condition removes the implicit `success()` Actions otherwise adds, so
 * the set is enumerated rather than sampled: `always()`, `failure()`, `cancelled()` were the three
 * that were known here, and `!success()` is a fourth spelling of the same thing that reached the
 * un-approved job's packing step with all three suites green. `success(` is matched whole rather
 * than only in its negated form, because `success() || failure()` is the same opt-in written round
 * the other way and enumerating negations is the game this closes rather than plays.
 */
export const STATUS_CHECK_FUNCTION = /\b(?:always|failure|cancelled|success)\s*\(/;

/** Does this step run after a step above it has failed? */
export function optsBackInAfterFailure(step) {
  return STATUS_CHECK_FUNCTION.test(conditionsOf(step));
}

/**
 * The pairs of a one-line YAML flow mapping, `{ A: b, C: "d" }`.
 *
 * ONE READER, USED AT BOTH SCOPES THAT CAN CARRY ONE. Best-effort, deliberately, and it is not the
 * guarantee: it exists so a failure message can NAME the variable. The guarantees are the raw text
 * sweeps in the suites, which cannot be out-spelled by the key at all.
 */
export function flowMappingPairs(text) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const [, name, value] of String(text).matchAll(/([\w-]+)\s*:\s*("[^"]*"|'[^']*'|[^,}]*)/g)) {
    vars[name] = value.trim().replace(/^["']|["']$/g, '');
  }
  return vars;
}

/**
 * Parse release.yml into its jobs, each with its own keys, its nested blocks and its ordered steps.
 *
 * A reader that THROWS, naming what it could not read, rather than returning an empty list. An empty
 * job list or an empty step list makes every assertion over it pass while asserting nothing, and a
 * suite whose subject is workflow composition has to fail loudly the moment the composition stops
 * being legible to it.
 */
export function parseWorkflow(text) {
  const lines = decomment(text);
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt < 0) throw new Error('parse failure: release.yml has no top-level `jobs:` key');

  const jobs = [];
  let job = null;
  let openBlock = null;
  let inSteps = false;
  /** @type {string[][]} */
  let rawSteps = [];

  const closeJob = () => {
    if (!job) return;
    for (const key of job.opened) {
      if (Object.keys(job.blocks[key]).length === 0) {
        throw new Error(
          `parse failure: \`${key}:\` in job \`${job.id}\` opens a mapping with nothing in it, ` +
            'so it cannot be resolved to a single value',
        );
      }
    }
    job.steps = rawSteps.map((raw, index) => parseStep(index, job.id, raw));
    if (job.steps.length === 0) throw new Error(`parse failure: job \`${job.id}\` parsed to zero steps`);
  };

  for (const line of lines.slice(jobsAt + 1)) {
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break; // a new top-level key closes the jobs block

    const jobStart = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobStart) {
      closeJob();
      job = { id: jobStart[1], keys: {}, blocks: {}, raw: {}, opened: new Set(), preamble: [], steps: [] };
      jobs.push(job);
      openBlock = null;
      inSteps = false;
      rawSteps = [];
      continue;
    }
    if (!job) throw new Error(`parse failure: ${JSON.stringify(line)} sits under \`jobs:\` but inside no job`);

    if (!inSteps) {
      if (/^ {4}steps:\s*$/.test(line)) {
        inSteps = true;
        openBlock = null;
        continue;
      }
      job.preamble.push(line);
      if (MERGE_KEY.test(line)) {
        throw new Error(
          `parse failure: \`<<:\` in job \`${job.id}\` is a merge key whose referent this reader does not resolve`,
        );
      }
      const key = /^ {4}([\w-]+):\s?(.*)$/.exec(line);
      if (key) {
        const value = stripTrailingComment(key[2]);
        if (Object.hasOwn(job.keys, key[1])) {
          throw new Error(
            `parse failure: duplicate key \`${key[1]}\` in job \`${job.id}\`, ` +
              'which cannot be resolved to a single value',
          );
        }
        if (ALIAS_OR_ANCHOR.test(value)) {
          throw new Error(
            `parse failure: \`${key[1]}:\` in job \`${job.id}\` is a YAML alias or anchor ` +
              'whose referent this reader does not resolve',
          );
        }
        // A BLOCK OR FOLDED INDICATOR IS NOT A VALUE, AND IS NOT READ AS ONE. `    if: >-` with the
        // expression on the line below used to leave `keys.if` holding `">-"`, which is legible and
        // WRONG: every check that only asks whether a condition EXISTS fires on it, and every check
        // that asks what it SAYS reads a two-character string. This reader refuses at job scope
        // rather than folding, because nothing at this scope needs the folded value and a refusal is
        // the answer that cannot be believed by accident.
        if (value !== '' && VALUE_LIVES_BELOW.test(value)) {
          throw new Error(
            `parse failure: \`${key[1]}:\` in job \`${job.id}\` opens a \`${value}\` block scalar ` +
              'this reader does not fold, so it cannot be resolved to a single value',
          );
        }
        job.keys[key[1]] = value;
        job.raw[key[1]] = key[2];
        if (value === '') {
          job.blocks[key[1]] = {};
          job.opened.add(key[1]);
          openBlock = key[1];
          continue;
        }
        openBlock = null;
        // A JOB-LEVEL `env:` THAT DOES NOT OPEN A BLOCK IS STILL EVERY STEP'S ENVIRONMENT. The
        // one-line flow mapping `env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" }` is the same
        // thing Actions does with the block spelling, and a reader that stored it as an ordinary key
        // value created no block at all, so a read of `job.blocks.env` came back EMPTY about a job
        // that hands the npm write credential to every step it has.
        if (key[1] === 'env') {
          if (!/^\{.*\}$/.test(job.keys.env)) {
            throw new Error(
              `parse failure: unreadable line in job \`${job.id}\`, a \`env:\` this parser cannot read: ` +
                JSON.stringify(line),
            );
          }
          // NOT recorded in `opened`: a flow mapping carries its value on the key's own line, so an
          // empty result here means the PAIR READER could not split it, not that the workflow
          // declared an empty mapping. That case is deliberately left to the raw text sweeps, which
          // read the line whether or not any reader could split it.
          job.blocks.env = flowMappingPairs(job.keys.env);
        }
        continue;
      }
      const child = /^ {6}([\w-]+):\s?(.*)$/.exec(line);
      if (child && openBlock) {
        const value = stripTrailingComment(child[2]);
        if (Object.hasOwn(job.blocks[openBlock], child[1])) {
          throw new Error(
            `parse failure: duplicate key \`${child[1]}\` inside \`${openBlock}:\` of job \`${job.id}\`, ` +
              'which cannot be resolved to a single value',
          );
        }
        if (ALIAS_OR_ANCHOR.test(value) || VALUE_LIVES_BELOW.test(value)) {
          throw new Error(
            `parse failure: \`${child[1]}:\` inside \`${openBlock}:\` of job \`${job.id}\` ` +
              'cannot be resolved to a single value',
          );
        }
        job.blocks[openBlock][child[1]] = value;
        job.raw[openBlock] = `${job.raw[openBlock]}\n${line}`;
        continue;
      }
      throw new Error(`parse failure: unreadable line in job \`${job.id}\`: ${JSON.stringify(line)}`);
    }

    const stepStart = /^ {6}- (.*)$/.exec(line);
    if (stepStart) {
      rawSteps.push([stepStart[1]]);
      continue;
    }
    if (rawSteps.length === 0) {
      throw new Error(`parse failure: ${JSON.stringify(line)} sits under \`${job.id}.steps:\` but inside no step`);
    }
    rawSteps[rawSteps.length - 1].push(line);
  }
  closeJob();

  if (jobs.length === 0) throw new Error('parse failure: release.yml declares `jobs:` but no job under it');
  return { jobs, byId: Object.fromEntries(jobs.map((j) => [j.id, j])) };
}

/** Every step of every job, in file order, so a whole-workflow property is asserted over all of it. */
export function allSteps(workflow) {
  return workflow.jobs.flatMap((job) => job.steps);
}

/**
 * The WORKFLOW-level `permissions:` block, at column 0 above `jobs:`, read WHOLE. `null` where the
 * workflow declares no `permissions:` key at all, because that absence is real.
 *
 * IT IS ITS OWN SCOPE AND ITS OWN QUESTION. This block is what a job that declares no `permissions:`
 * of its own inherits, and it is what thirteen calling repositories have to grant FIRST: a called
 * workflow's token can only be equal to or more restrictive than its caller's. A job's own block is a
 * different set about a different runner, so a pin on one says nothing about the other. `where` names
 * the scope in the refusals below, so a read taken on a job's behalf can say WHICH job's inherited
 * permissions could not be resolved while a direct read of the block says only what it read.
 *
 * IT ANSWERS AN ABSENCE CLAIM, so every way of ending the read early is a way of granting a
 * permission nobody asked for. `id-token: write` is npm provenance and is deliberately absent from
 * the un-approved half of this workflow; a suite pins the map WHOLE, and a read that stops before
 * `id-token:` hands that pin the exact map it expects while the job really does carry the
 * publish-signing token. So a line inside the block that this reader cannot read is a REFUSAL naming
 * the scope, never the end of the block, and never a key reported absent.
 *
 * WHAT ENDS THE BLOCK IS A KEY AT COLUMN 0, AND NOTHING ELSE. A blank line inside a block mapping is
 * legal YAML that means nothing, so it is stepped over rather than refused - refusing it would turn
 * a legal, harmless regrouping of four permissions into thirteen callers' red releases, and the
 * workflow-level `env:` read below already draws the line in the same place for the same reason.
 */
export function workflowPermissions(text, where = 'the workflow-level `permissions:` block') {
  const lines = decomment(text);
  const at = lines.findIndex((line) => /^["']?permissions["']?[ \t]*:/.test(line));
  if (at < 0) return null;
  if (!/^permissions:[ \t]*$/.test(lines[at])) {
    throw new Error(
      `parse failure: ${where} is ${JSON.stringify(lines[at])} rather than a block this reader reads, ` +
        'so the permissions it grants cannot be resolved',
    );
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') continue; // a blank line inside a block mapping does not close it
    if (/^\S/.test(line)) break; // a new top-level key does
    if (MERGE_KEY.test(line)) {
      throw new Error(
        `parse failure: \`<<:\` inside ${where} is a merge key whose referent this reader does not resolve`,
      );
    }
    const match = /^ {2}([\w-]+):\s?(.*)$/.exec(line);
    if (!match) {
      throw new Error(`parse failure: unreadable line inside ${where}: ${JSON.stringify(line)}`);
    }
    const value = stripTrailingComment(match[2]);
    if (Object.hasOwn(out, match[1])) {
      throw new Error(
        `parse failure: duplicate key \`${match[1]}\` inside ${where}, ` +
          'which cannot be resolved to a single value',
      );
    }
    if (ALIAS_OR_ANCHOR.test(value) || VALUE_LIVES_BELOW.test(value)) {
      throw new Error(
        `parse failure: \`${match[1]}:\` inside ${where} cannot be resolved to a single value`,
      );
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * The permissions in force on a job: its own block if it has one, else the workflow's.
 *
 * A PERMISSIONS KEY THAT IS NOT A BLOCK IS NOT AN ABSENT ONE. `permissions: read-all` at either
 * scope, or a job's `permissions: {}`, says something specific about the job in front of us and is
 * outside the subset this reader models. Falling through to the workflow's block for it, or
 * answering `null`, reports a permission set that is not the one in force.
 *
 * IT IS NOT A SUBSTITUTE FOR `workflowPermissions` ABOVE. On a workflow where every job declares its
 * own block this only ever answers about a job, so a suite that pinned the column-0 block and then
 * swapped in this call stopped reading that block at all while its assertion still looked like
 * coverage.
 */
export function effectivePermissions(text, job) {
  if (job.blocks.permissions) return job.blocks.permissions;
  if (job.keys.permissions !== undefined) {
    throw new Error(
      `parse failure: \`permissions:\` in job \`${job.id}\` is ` +
        `${JSON.stringify(job.raw.permissions ?? job.keys.permissions)} rather than a block this reader ` +
        'reads, so the permissions in force on that job cannot be resolved',
    );
  }
  return workflowPermissions(text, `the workflow-level \`permissions:\` in force on job \`${job.id}\``);
}

/**
 * The WORKFLOW-level `env:` block, above `jobs:`, with the raw text it was read out of.
 *
 * TWO DIFFERENCES FROM THE PERMISSIONS READ, both because this one is used for an ABSENCE claim and
 * that one for a presence claim, so the failure directions are opposite. A blank line inside the
 * block does not end it (ending there would silently stop reading and report "no credential"), and
 * the raw text comes back alongside the parsed map so a value this line-oriented reader cannot read
 * is still swept for the secret rather than passing as unreadable.
 *
 * THREE SPELLINGS OF THE KEY, because YAML has three and Actions accepts all three: the bare block
 * `env:`, the quoted `"env":`, and the one-line flow mapping `env: { A: b }`.
 */
export function workflowEnv(text) {
  const lines = decomment(text);
  const at = lines.findIndex((line) => /^(?:env|"env"|'env'):/.test(line));
  if (at < 0) return { vars: {}, raw: '' };
  /** @type {Record<string, string>} */
  const vars = {};
  const raw = [];

  // FLOW MAPPING FIRST: everything after the colon on the key's own line. `env: { A: b, C: d }` is
  // the whole block, so there is no indented body below it to walk.
  //
  // A COMMENT IS NOT A VALUE, and `\S` matches `#`. `env: # the environment both jobs inherit` is the
  // BLOCK spelling with an ordinary trailing comment on its key line, which is how every other key in
  // this workflow is written; taken for a one-line flow mapping it hands the pair reader a comment,
  // which contains no pairs, and the answer comes back "no variables" about a block full of them.
  // That answer is the one an absence claim about the npm write credential must never be handed.
  const inline = /^(?:env|"env"|'env'):[ \t]*(\S.*)$/.exec(lines[at]);
  if (inline && !inline[1].startsWith('#')) {
    // ... unless what follows the colon is a block-scalar header rather than a mapping, in which
    // case the value is on the lines BELOW and the pair reader would come back empty about a block
    // that has a body. Refused rather than read, at this scope for the same reason as at job scope:
    // nothing here needs the folded value, and "no variables" is the one answer an absence claim
    // must never be handed by accident.
    if (VALUE_LIVES_BELOW.test(stripTrailingComment(inline[1]))) {
      throw new Error(
        `parse failure: the workflow-level \`env:\` opens a \`${inline[1]}\` block scalar this reader ` +
          'does not fold, so it cannot be resolved to a mapping',
      );
    }
    raw.push(inline[1]);
    return { vars: flowMappingPairs(inline[1]), raw: raw.join('\n') };
  }

  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break; // a new top-level key closes the block
    raw.push(line);
    body.push(line);
  }
  for (const [index, line] of body.entries()) {
    const match = /^ {2}([\w-]+):\s?(.*)$/.exec(line);
    if (!match) continue;
    const value = stripTrailingComment(match[2]);
    // AND A VALUE THAT LIVES BELOW THE KEY IS THE VALUE, NOT THE INDICATOR THAT INTRODUCED IT.
    // `RELEASE_HELPER: >-` over `${{ secrets.NPM_TOKEN }}` parses to `">-"` in a reader that stops
    // at the colon, and a name-and-value sweep then reports a variable holding two punctuation
    // characters where the npm write credential is.
    vars[match[1]] = VALUE_LIVES_BELOW.test(value) ? valueBelow(body, index) : value;
  }
  return { vars, raw: raw.join('\n') };
}

/**
 * Everything above `jobs:`, comments removed - the workflow preamble as text.
 *
 * The backstop under every parsed read of the workflow-level environment. A reader can always be
 * out-spelled: a multi-line flow mapping, an anchor, a key this line-oriented reader does not
 * recognise. Text cannot.
 */
export function workflowPreamble(text) {
  const lines = decomment(text);
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt < 0) throw new Error('parse failure: release.yml has no top-level `jobs:` key');
  return lines.slice(0, jobsAt).join('\n');
}

/** Does `jobId` transitively depend on `targetId` through `needs:`? */
export function dependsOn(workflow, jobId, targetId, seen = new Set()) {
  if (jobId === targetId) return true;
  if (seen.has(jobId)) return false;
  seen.add(jobId);
  const raw = workflow.byId[jobId]?.keys.needs ?? '';
  const parents = raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((name) => name.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return parents.some((parent) => dependsOn(workflow, parent, targetId, seen));
}

/**
 * The npm write credential, in every form a workflow expression can name it.
 *
 * TWO AXES, AND BOTH OF THEM ARE CLOSED HERE. The SYNTAX axis: an expression names a context member
 * by `.` or by the INDEX form `secrets['NPM_TOKEN']`, which the docs give as an exact equivalent, and
 * none of the index spellings contains the substring `secrets.NPM_TOKEN`. Those two are what the
 * expression grammar has; a third syntax would be a change to the language.
 *
 * The NAME axis, which is not the grammar's and which an enumeration of the grammar therefore does
 * not close: secret names and context names are CASE INSENSITIVE to Actions, so
 * `${{ secrets.npm_token }}` reads the same credential and reaches the same steps as
 * `${{ secrets.NPM_TOKEN }}`. A pattern anchored on the upper-case spelling reports "no credential
 * here" about a job holding it, which is the failure mode every sweep in these suites exists to
 * refuse. Hence the `i` flag, which is what makes the enumeration above a closure and not a patch.
 *
 * What it must NOT match is the `workflow_call` declaration's own `NPM_TOKEN:` key, which names the
 * secret without reading it: the pattern requires the `secrets` context to be followed by the `.` or
 * the `[` that READS a member, and a declaration key is followed by a colon.
 */
export const NPM_SECRET_REF = /secrets\s*(?:\.\s*NPM_TOKEN|\[\s*['"]NPM_TOKEN)/i;

/**
 * Read the workflow, or fail naming the path that could not be read.
 *
 * A SUITE THAT CANNOT OPEN ITS SUBJECT MUST SAY SO, which is not what happens by default: a caller
 * that wraps the read, or reads it lazily inside a helper, can end up asserting over `''` and passing
 * every absence check it has. Absent, a directory and permission-refused are all the same answer here
 * and all of them name the path.
 */
export function readWorkflow(path, readFileSync) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`parse failure: cannot read the workflow at ${path}: ${error.code ?? error.message}`);
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`parse failure: the workflow at ${path} is empty`);
  }
  return text;
}
