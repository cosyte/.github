#!/usr/bin/env node
// @ts-check
//
// CHANGESETS SWALLOWS A CHANGELOG-WRITE FAILURE WITH `console.warn`, AND NOTHING ANYWHERE NOTICED.
//
// This is the whole reason this file exists, so it is stated first and in full. `changeset version`
// writes three things: the new version into `package.json`, the release section into `CHANGELOG.md`,
// and the deletion of the changesets it consumed. The changelog write is the only one of the three
// that is allowed to fail quietly. When the changelog formatter cannot be resolved -- a declared
// Prettier config that does not load is the case that was reproduced -- Changesets catches the
// error, prints a `console.warn`, and carries on. The version is bumped. The changesets are
// consumed. NO CHANGELOG IS WRITTEN AT ALL, not a partial one.
//
// So the Version PR merges, the publish runs, and `@cosyte/<pkg>@<version>` reaches the registry
// with a `CHANGELOG.md` in its tarball that does not mention `<version>`. The run's conclusion is
// `success`. `format:check` reads a file that is valid markdown and says nothing. `release-notes.mjs`
// composes the GitHub release body from `.changeset/*.md` and never opens `CHANGELOG.md`, so it says
// nothing either. Every gate this pipeline has passes, and the artifact is defective. A published
// version is permanent (ADR 0001), so there is no correcting it afterwards.
//
// THIS GATE ASSERTS THE ONE FACT NONE OF THEM ASSERT: the changelog about to be packed carries a
// section for the version about to be published.
//
// WHY IT KEYS ON `.changeset/config.json` AND NOT ON A LIST OF REPOS. Half this org's callers hand-
// maintain `CHANGELOG.md` under a `## [Unreleased]` heading (`"changelog": false`) and half have the
// generator on, and repos move from the first group to the second one at a time. A gate holding a
// list of names is wrong the day after it ships, and wrong in the dangerous direction: a repo that
// turned the generator on is exactly a repo this check should now be covering. The discriminator is
// mechanical and lives in the caller's own tree:
//
//   "changelog": false        the generator is OFF. `changeset version` writes no version section by
//                             design, `CHANGELOG.md` is written by hand, and there is nothing here
//                             for this gate to assert. It reports `not-applicable` and exits 0.
//   anything else             the generator is ON. `changeset version` MUST have written
//                             `## <version>`, and its absence is the swallowed failure above.
//
// `not-applicable` IS NOT A CLAIM THAT THE CHANGELOG IS CORRECT. It is a claim that this gate does
// not govern it. A hand-maintained changelog can be wrong in every way this one can and several it
// cannot; that is a different problem with a different owner.
//
// THE HEADING IS COMPARED AS A WHOLE LINE, AT COLUMN 0, AND BOTH HALVES OF THAT ARE LOAD-BEARING.
//
//   WHOLE, because `## 0.0.1` is a SUBSTRING of `## 0.0.10`. A `String.includes` or `indexOf` over
//   the heading passes on a repo's first release and reds on its tenth, which is the worst possible
//   time to discover it: `0.0.10` is where several of these packages already are.
//
//   AT COLUMN 0, because a changeset summary can quote a version heading and that quoted copy lands
//   INSIDE the rendered release section. `getReleaseLine` indents every continuation line of a
//   summary by two spaces, so no line inside a release section starts at column 0 -- which makes
//   "starts at column 0" a sound test for "this is a real heading the generator wrote" and makes a
//   trimmed comparison an unsound one. A gate satisfied by an author quoting the string it looks for
//   is not a gate.
//
// Exit codes: 0 the changelog is fit to publish (or this gate does not govern it), 1 it is not,
// 2 bad usage.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

/**
 * Whether the Changesets changelog generator is on for this caller.
 *
 * `"changelog": false` is off. A string (`"@changesets/cli/changelog"`) or a two-element
 * `[module, options]` array is on. An ABSENT key is on too, and that is Changesets' own default
 * rather than a guess made here: with no `changelog` key the CLI falls back to its built-in
 * generator and writes sections. Reading an absent key as "off" would exempt exactly the repo that
 * never configured anything, which is the one least likely to have noticed a missing section.
 *
 * @param {unknown} value the `changelog` field of `.changeset/config.json`
 */
export function generatorIsOn(value) {
  return value !== false && value !== null;
}

/**
 * The lines of `text` that ARE the heading `## <version>`, by index.
 *
 * Trailing whitespace is tolerated because it is invisible and no formatter preserves it
 * deliberately. LEADING whitespace is not: see the header for why a trimmed comparison is unsound.
 *
 * @param {string} text
 * @param {string} version
 * @returns {number[]} 1-based line numbers
 */
export function versionHeadingLines(text, version) {
  const wanted = `## ${version}`;
  const found = [];
  String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      if (line.replace(/[ \t]+$/, '') === wanted) found.push(i + 1);
    });
  return found;
}

/**
 * Every heading the file does carry, for the failure message.
 *
 * A gate that says "`## 0.0.9` is missing" and stops leaves the reader guessing whether the file is
 * empty, stale, or written in a different shape entirely. The three are diagnosed differently and
 * the answer is one grep, so it is done here instead of asking for it.
 *
 * @param {string} text
 */
export function topLevelHeadings(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => /^#{1,2} \S/.test(line))
    .map((line) => line.replace(/[ \t]+$/, ''));
}

const NOT_WRITTEN =
  'This is what a SWALLOWED changelog write looks like. `changeset version` bumped the version and ' +
  'consumed the changesets, and its call to the changelog generator threw and was caught: ' +
  'Changesets reports that failure with `console.warn` and completes successfully, so the run that ' +
  'produced this commit was green. The reproduced cause is a declared Prettier config that cannot ' +
  'be resolved from the repository root; check that first, then re-run `pnpm run version` locally ' +
  'against this commit and read the warnings. NOTHING HAS BEEN PUBLISHED by this run.';

/**
 * @param {{ repo: string, version: string, changelogPath?: string, configPath?: string }} options
 * @returns {{ verdict: string, failing: boolean, reason: string }}
 */
export function checkChangelog({ repo, version, changelogPath, configPath }) {
  const root = resolve(repo);
  const config = resolve(configPath ?? `${root}/.changeset/config.json`);
  const changelog = resolve(changelogPath ?? `${root}/CHANGELOG.md`);

  // FAIL CLOSED ON AN UNREADABLE CONFIG, and it is worth saying why rather than leaving it to be
  // read as caution. Every caller of this pipeline runs `changesets/action`, which cannot function
  // without this file, so "it is not there" is not a state a release run can legitimately be in.
  // Reading the absence as "generator off" would turn a broken checkout into a silent exemption for
  // the one gate that would have caught what the broken checkout did.
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(config, 'utf8'));
  } catch (error) {
    return {
      verdict: 'unreadable-config',
      failing: true,
      reason:
        `Cannot read ${config}: ${error instanceof Error ? error.message : String(error)}. This ` +
        `pipeline runs \`changesets/action\`, which requires that file, so a release run cannot ` +
        `legitimately be missing it. Refusing to guess whether the changelog generator is on: ` +
        `guessing "off" would exempt this release from the only check that reads CHANGELOG.md.`,
    };
  }

  if (!generatorIsOn(parsed?.changelog)) {
    return {
      verdict: 'not-applicable',
      failing: false,
      reason:
        `${config} sets "changelog": false, so the Changesets changelog generator is OFF here and ` +
        `\`changeset version\` writes no version section by design. CHANGELOG.md is maintained by ` +
        `hand in this repo and this gate does not govern it -- which is not a statement that it is ` +
        `correct, only that its correctness is not established here.`,
    };
  }

  let text;
  try {
    text = readFileSync(changelog, 'utf8');
  } catch (error) {
    return {
      verdict: 'no-changelog',
      failing: true,
      reason:
        `The changelog generator is ON (${config} sets "changelog": ` +
        `${JSON.stringify(parsed?.changelog)}) but ${changelog} cannot be read: ` +
        `${error instanceof Error ? error.message : String(error)}. ${NOT_WRITTEN}`,
    };
  }

  const lines = versionHeadingLines(text, version);
  if (lines.length === 0) {
    const headings = topLevelHeadings(text);
    return {
      verdict: 'missing-section',
      failing: true,
      reason:
        `The changelog generator is ON, but ${changelog} carries no \`## ${version}\` heading, so ` +
        `the release about to be published has NO SECTION IN THE CHANGELOG THAT SHIPS INSIDE ITS ` +
        `OWN TARBALL. ${NOT_WRITTEN}\n` +
        `The headings it does carry are:\n` +
        (headings.length > 0 ? headings.map((h) => `  ${h}`).join('\n') : '  (none)'),
    };
  }

  return {
    verdict: 'pass',
    failing: false,
    reason:
      `${changelog} carries \`## ${version}\` at line ${lines.join(', ')} of ` +
      `${String(text).split('\n').length}, matched as a whole line at column 0.` +
      (lines.length > 1
        ? ` MORE THAN ONE line matches. The generator writes one; a second is text that reproduces ` +
          `the heading at column 0, which a changeset summary can do and which renders as a second ` +
          `heading inside the release section permanently. Worth a look, but it is not what this ` +
          `gate refuses.`
        : ''),
  };
}

const USAGE = 'usage:\n  changelog-check.mjs --repo <dir> --version <v> [--changelog <file>] [--config <file>]\n';

/** @param {string[]} argv */
function parseArgv(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    options[token.slice(2)] = value;
    i += 1;
  }
  return options;
}

/** @param {string[]} argv */
export function main(argv) {
  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (!options.repo || !options.version) {
    process.stderr.write(USAGE);
    return 2;
  }

  const result = checkChangelog({
    repo: options.repo,
    version: options.version,
    changelogPath: options.changelog,
    configPath: options.config,
  });

  process.stdout.write(`verdict: ${result.verdict}\n${result.reason}\n`);
  if (result.failing) {
    // One annotation, on the run that is about to publish, naming the artifact rather than the step.
    process.stdout.write(
      `::error title=The changelog has no section for this release::` +
        `CHANGELOG.md ships inside the published tarball and does not mention ${options.version}. ` +
        `Refusing to publish a release whose own changelog does not record it.\n`,
    );
  }
  return result.failing ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main(process.argv.slice(2));
}
