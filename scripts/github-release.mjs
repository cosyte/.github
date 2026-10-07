#!/usr/bin/env node
// @ts-check
//
// CUT THE GITHUB RELEASE FOR A VERSION npm SERVES, AND TELL cosyte/docs IT SHIPPED.
//
// `release.yml` creates a GitHub release from three places, and they are one act:
//
//   the direct arm     in the `release` job, straight after `changeset publish` reported a publish;
//   the promoted arm   in the same job, once a staged version was promoted inside the window
//                      `promotion.mjs await` watches;
//   the catch-up       in the `finalize` job of a later run, for a version promoted after that
//                      window, at the commit that released it.
//
// So all three run this file, and a rule about what a release is (its tag, its body, its assets, how
// the docs rebuild is asked for) is written once. What differs between them is passed in: which
// version, which commit the tag points at, and whether the registry must be seen serving the version
// first.
//
// THE ORDER IS THE GUARANTEE, and every step that can refuse runs before the first write:
//
//   1. (--require-live) the registry lists the version. A release is never created for a version
//      no consumer can install. The direct arm does not ask, because it runs seconds after its own
//      publish, where registry propagation lag would read as a refusal of a version that did ship.
//   2. `release-notes.mjs assert` proves the body's bytes against this version and package.
//   3. `gh release view`, then edit-and-upload or create, in one call with the assets.
//   4. the docs dispatch, which reports and never fails the run.
//
// THE CALLER'S PACK-DOCS COMMAND IS NOT RUN HERE. It is a shell string the calling repository supplies
// (`pnpm pack:docs` by default), so it runs where the caller's other commands run: in the workflow
// step, as `bash -c`, immediately before this script. Every process this script starts is a fixed
// binary (`gh`, or this Node running `release-notes.mjs`) with an argument vector it built, and none
// of them is a shell. It attaches whichever of `dist-artifacts/{docs-content,source}.tar.gz` that
// command left behind, exactly as the step it replaced did.
//
// Run it by hand from a caller checkout (it really does create a release):
//
//   pnpm pack:docs && GH_TOKEN=... node scripts/github-release.mjs --package @cosyte/x12 \
//     --version 0.1.1 --target <sha> --notes notes.md --dispatch-docs false

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { withFetchTimeout } from './install-check.mjs';
import { DEFAULT_REGISTRY, registryListsVersionWithRetry } from './promotion.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where every caller's pack-docs command writes, and the two files cosyte/docs ingests. */
export const ASSET_DIR = 'dist-artifacts';
export const ASSETS = Object.freeze(['docs-content.tar.gz', 'source.tar.gz']);

/**
 * THE TAG IS `v<version>`, AND IT MUST STAY PARSEABLE BY cosyte/docs. Every caller of this workflow is
 * a single-package repository, for which Changesets tags `v<version>`; it uses `<pkg>@<version>` only
 * in a multi-package one. docs' `parseTag()` strips a leading `v` and reads `/^(\d+)\.(\d+)\.(\d+)/`,
 * so `@cosyte/x12@0.0.1` parses to null and derives a version slot carrying a `/`, which is not a
 * directory name. docs keeps only releases carrying `docs-content.tar.gz`, so a release at that
 * spelling would be the one it selected.
 *
 * @param {string} version
 */
export function releaseTag(version) {
  return `v${version}`;
}

/**
 * `--target` IS REQUIRED ON CREATE. `changeset publish` creates the `v<version>` tag only in the
 * runner's local clone, and this pipeline turns off `createGithubReleases`, which is the only thing
 * that would have pushed it; a staged or caught-up version has no tag anywhere. Pointing `--target`
 * at the release commit makes gh create the tag itself, so there is one tag and one release, both made
 * here. The assets go in the same call: gh creates the release as a draft, uploads, and only then
 * publishes it, so no published release is ever visible without its artifacts. The title is the tag
 * and nothing else; the reader is already in the repository.
 */
export function createArgs({ tag, assets, target, notes }) {
  return ['release', 'create', tag, ...assets, '--target', target, '--title', tag, '--notes-file', notes];
}

export function editArgs({ tag, notes }) {
  return ['release', 'edit', tag, '--title', tag, '--notes-file', notes];
}

export function uploadArgs({ tag, assets }) {
  return ['release', 'upload', tag, ...assets, '--clobber'];
}

/**
 * `-f`, NOT `-F`. `gh api -F/--field` applies magic type conversion, and one of its rules is that "if
 * the value starts with `@`, the rest of the value is interpreted as a filename to read the value
 * from" (`gh api --help`). Every package in this org is `@cosyte/*`, so `-F
 * "client_payload[package]=@cosyte/synth"` makes gh try to open the file `cosyte/synth` and exit 1.
 * `-f/--raw-field` is the plain-string form, and it still builds the nested object from the
 * `client_payload[...]` keys that cosyte/docs reads as `github.event.client_payload.package` and
 * `.version`. `version` takes `-f` too: `-F` would turn a bare integer into a JSON number, and neither
 * field has any reason to be magic.
 */
export function dispatchArgs({ packageName, version }) {
  return [
    'api',
    'repos/cosyte/docs/dispatches',
    '-f',
    'event_type=package-released',
    '-f',
    `client_payload[package]=${packageName}`,
    '-f',
    `client_payload[version]=${version}`,
  ];
}

/**
 * The single spawn site. `quiet` discards output, which is only ever wanted for `gh release view`,
 * whose answer is its exit status.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, quiet?: boolean}} [options]
 * @returns {{code: number}}
 */
export function runCommand(cmd, args, { env = process.env, quiet = false } = {}) {
  const result = spawnSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit', env });
  if (result.error) return { code: 127 };
  return { code: typeof result.status === 'number' ? result.status : 1 };
}

const USAGE =
  'usage:\n' +
  '  github-release.mjs --package <name> --version <v> --target <sha> --notes <file>\n' +
  '                     [--dispatch-docs true|false] [--require-live]\n' +
  '                     [--registry <url>]\n' +
  '  GH_TOKEN creates the release; DISPATCH_TOKEN, when set, dispatches the docs rebuild.\n';

/** `--require-live` is the one flag that takes no value. */
export function parseArgv(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    if (token === '--require-live') {
      options['require-live'] = 'true';
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    options[token.slice(2)] = value;
    i += 1;
  }
  return options;
}

/**
 * @param {string[]} argv
 * @param {object} io
 */
export async function main(argv, io = {}) {
  const {
    env = process.env,
    run = runCommand,
    exists = existsSync,
    readFile = readFileSync,
    appendFile = appendFileSync,
    fetchImpl = globalThis.fetch,
    sleepImpl,
    stdout,
    stderr,
    toolingDir = HERE,
  } = io;
  const out = stdout ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const err = stderr ?? ((/** @type {string} */ s) => process.stderr.write(s));
  const summary = (/** @type {string[]} */ lines) => {
    if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  };

  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const packageName = options.package || env.PACKAGE_NAME || '';
  const version = options.version || '';
  const target = options.target || '';
  const notes = options.notes || '';
  const required = { '--package': packageName, '--version': version, '--target': target, '--notes': notes };
  for (const [name, value] of Object.entries(required)) {
    if (!value) {
      err(`${name} is required\n${USAGE}`);
      return 2;
    }
  }
  const tag = releaseTag(version);
  const coordinate = `${packageName}@${version}`;

  // 1. NEVER A RELEASE FOR A VERSION THE REGISTRY DOES NOT SERVE. Asked again here, immediately
  //    before anything is written, rather than trusted from the step that decided to come here: that
  //    decision may be minutes old and from another job. Not seeing it is not a failure. Nothing has
  //    been written, and the next run on the default branch asks the same question again.
  if (options['require-live'] === 'true') {
    const registry = options.registry || env.NPM_REGISTRY || DEFAULT_REGISTRY;
    const listed = await registryListsVersionWithRetry(registry, packageName, version, withFetchTimeout(fetchImpl), {
      ...(sleepImpl ? { sleepImpl } : {}),
    });
    if (listed !== 'yes') {
      const why = listed === 'no' ? 'does not list it' : 'did not answer';
      out(
        `::warning title=GitHub release not created::The registry ${why} for ${coordinate}, so no ${tag} tag, ` +
          'GitHub release or docs dispatch was created. A later run on the default branch creates them once it is live.\n',
      );
      summary([
        `### ${tag} NOT created`,
        '',
        `The registry ${why} for \`${coordinate}\`, and a release is only ever created for a version it serves.`,
        'Nothing was written. A later run on the default branch creates the tag, the release and the docs',
        'dispatch once it is live.',
        '',
      ]);
      return 0;
    }
    out(`The registry lists ${coordinate}.\n`);
  }

  // The assets the caller's pack-docs command left in its tree, in the step before this script.
  const assets = ASSETS.map((name) => path.join(ASSET_DIR, name)).filter((file) => exists(file));

  // 2. THE BODY, PROVED ON ITS BYTES BY THE ENTRY POINT THAT KNOWS NOTHING ABOUT HOW THEY WERE MADE.
  //    It is compared against the version being released here, which on the direct arm is the one
  //    Changesets reported publishing and on the other two is the one the registry was seen serving.
  //    The notes come from git and the version comes from npm, and a disagreement is a defect.
  const assertNotes = path.join(toolingDir, 'release-notes.mjs');
  const asserted = run(
    process.execPath,
    [assertNotes, 'assert', '--file', notes, '--expect-version', version, '--expect-package', packageName],
    { env },
  );
  if (asserted.code !== 0) {
    err(`::error title=Release notes refused::The body in ${notes} is not fit for ${coordinate}, so no release was created.\n`);
    return 1;
  }
  let body = '';
  try {
    body = readFile(notes, 'utf8');
  } catch {
    // The assert above has already read it; this is only the echo.
  }
  out(`Release body for ${tag}:\n${body}\n`);

  // 3. THE RELEASE. An existing one is brought up to date rather than duplicated. A create that
  //    fails because another run created the same release in the meantime (a later push catching up
  //    while this run's own wait saw the promotion) is that same update, not a failure; a create that
  //    fails for any other reason fails the run.
  const update = () => {
    const edited = run('gh', editArgs({ tag, notes }), { env });
    if (edited.code !== 0) return edited;
    if (assets.length > 0) return run('gh', uploadArgs({ tag, assets }), { env });
    return edited;
  };
  if (run('gh', ['release', 'view', tag], { env, quiet: true }).code === 0) {
    out(`${tag} already has a GitHub release; updating its body and assets.\n`);
    if (update().code !== 0) {
      err(`::error title=GitHub release not updated::gh could not update the existing ${tag} release for ${coordinate}.\n`);
      return 1;
    }
  } else {
    const created = run('gh', createArgs({ tag, assets, target, notes }), { env });
    if (created.code !== 0) {
      if (run('gh', ['release', 'view', tag], { env, quiet: true }).code === 0) {
        out(`${tag} was created by another run while this one was creating it; updating it instead.\n`);
        if (update().code !== 0) {
          err(`::error title=GitHub release not updated::gh could not update the ${tag} release for ${coordinate}.\n`);
          return 1;
        }
      } else {
        err(`::error title=GitHub release not created::gh could not create ${tag} at ${target} for ${coordinate}.\n`);
        return 1;
      }
    }
  }

  // 4. THE DOCS REBUILD. Four outcomes, and each one says so in the log, because the fifth outcome,
  //    doing nothing quietly, is indistinguishable from one that works.
  //
  //    A FAILED DISPATCH DOES NOT FAIL THE RUN, DELIBERATELY. By the time this runs the version is
  //    permanent on npm and its GitHub release exists. All a failed dispatch costs is that
  //    docs.cosyte.com rebuilds later rather than now, and any push to cosyte/docs rebuilds it anyway,
  //    re-reading every package's latest release. A red conclusion on a successful release invites a
  //    re-run of a job that has already published, and buries a real publish failure among cosmetic
  //    ones. So this annotates at `::error::` level, with the exact command to finish by hand, and
  //    returns success.
  //
  //    THE RESIDUAL: a run that concludes `success` notifies nobody, so nothing chases that
  //    annotation. If DOCS_REPO_DISPATCH_TOKEN expires or loses its scope, every release annotates on
  //    a green run. The backstop above bounds it; it is not a monitor.
  const dispatchDocs = String(options['dispatch-docs'] ?? env.DISPATCH_DOCS ?? 'true');
  const dispatchToken = env.DISPATCH_TOKEN || '';
  if (dispatchDocs !== 'true') {
    out('Docs dispatch not requested (dispatch-docs=false); skipping.\n');
  } else if (!dispatchToken) {
    out(
      `::warning title=Docs rebuild not triggered::dispatch-docs is true but DOCS_REPO_DISPATCH_TOKEN is unset, ` +
        `so cosyte/docs was never told that ${coordinate} shipped.\n`,
    );
    summary([
      '### Docs rebuild NOT triggered',
      '',
      '`dispatch-docs` is `true` but `DOCS_REPO_DISPATCH_TOKEN` is not set for this job,',
      `so docs.cosyte.com has not been told that \`${coordinate}\` shipped.`,
      '',
    ]);
  } else if (run('gh', dispatchArgs({ packageName, version }), { env: { ...env, GH_TOKEN: dispatchToken } }).code === 0) {
    out(`Dispatched package-released to cosyte/docs for ${coordinate}.\n`);
  } else {
    out(
      `::error title=Docs rebuild dispatch failed::The release itself SUCCEEDED. Only the cosyte/docs rebuild ` +
        `dispatch for ${coordinate} failed, and it needs running by hand.\n`,
    );
    summary([
      '### Docs rebuild dispatch FAILED (the release itself is fine)',
      '',
      `\`${coordinate}\` is on npm and its GitHub release exists. The only thing`,
      'that did not happen is the docs.cosyte.com rebuild. Trigger it by hand:',
      '',
      '```bash',
      'gh api repos/cosyte/docs/dispatches -f event_type=package-released \\',
      `  -f 'client_payload[package]=${packageName}' -f 'client_payload[version]=${version}'`,
      '```',
      '',
    ]);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
