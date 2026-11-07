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
//   3. `gh release view`, then either create the release with its assets in one call, or bring an
//      existing one up to date: its body is edited, and its assets are compared, never replaced. An
//      asset already attached with the same content is left as it is, one attached with different
//      content fails the run, and only an asset the release does not carry yet is uploaded.
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
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

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

/**
 * NO `--clobber`, AND THAT IS THE IMMUTABLE-RELEASE FIX. With release immutability on, GitHub refuses to
 * modify or delete an asset of a published release, so `--clobber` turned every re-run of a release
 * job into a failure at this step, after the release it was re-running had already succeeded. An
 * asset the release already carries is now compared rather than uploaded (see `compareAssets`), so
 * this is only ever handed the assets the release does not carry yet.
 */
export function uploadArgs({ tag, assets }) {
  return ['release', 'upload', tag, ...assets];
}

/** The names of the assets a release already carries, one per line. */
export function assetNamesArgs({ tag }) {
  return ['release', 'view', tag, '--json', 'assets', '--jq', '.assets[].name'];
}

/** One attached asset, downloaded into a fresh directory so it can be compared with the one built. */
export function downloadArgs({ tag, name, dir }) {
  return ['release', 'download', tag, '--pattern', name, '--dir', dir];
}

// ---------------------------------------------------------------------------
// Comparing an attached asset with the one this run built
// ---------------------------------------------------------------------------
//
// "THE SAME CONTENT" MEANS THE SAME FILES WITH THE SAME BYTES, NOT THE SAME ARCHIVE BYTES. Most callers
// pack their docs with `tar -czf`, which records each file's modification time (the checkout's time on
// a runner, so a different one on every run) and gzip's own timestamp. A re-run from the same commit
// therefore builds a tarball whose bytes differ from the attached one while every file inside it is
// identical, and a byte comparison would fail exactly the re-runs this exists to make safe. So when
// the bytes differ, both are read as gzipped tars and compared entry by entry: the set of paths, and
// for each one its kind and its bytes (or a link's target). Directories are implied by the files in
// them, and modes, owners and times are archive metadata, not content. Anything that cannot be read
// that way is compared by its bytes alone, so an unreadable asset is never called the same.

/** A NUL-terminated header field, as text. */
function headerText(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

/** A numeric header field: octal text, or base-256 when its first byte has the high bit set. */
function headerNumber(bytes) {
  if (bytes[0] & 0x80) {
    let value = bytes[0] & 0x7f;
    for (let i = 1; i < bytes.length; i += 1) value = value * 256 + bytes[i];
    return value;
  }
  const text = headerText(bytes).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error(`a numeric header field reads ${JSON.stringify(text)}, which is not octal`);
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/** The header checksum, which tells a tar header from bytes that merely sit where one would. */
function checksumMatches(header) {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  const recorded = headerNumber(header.subarray(148, 156));
  return recorded === unsigned || recorded === signed;
}

/** A pax extended header's `length key=value` records. */
function paxRecords(data) {
  /** @type {Record<string, string>} */
  const records = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(at, space).toString('ascii'), 10);
    if (!Number.isInteger(length) || length <= space - at) throw new Error('a pax record has no readable length');
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals !== -1) records[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return records;
}

/** `./docs/intro.md` and `docs/intro.md` are one path. */
function entryPath(name) {
  let at = name;
  while (at.startsWith('./')) at = at.slice(2);
  return at.replace(/\/+$/, '');
}

/**
 * The entries of a gzipped tar, by path: what `tar -czf` writes in either its GNU or its POSIX form,
 * long names included. Throws on anything it cannot read, rather than returning what it read so far.
 *
 * @param {Buffer} gzipped
 * @returns {Map<string, {kind: string, data?: Buffer, target?: string}>}
 */
export function tarEntries(gzipped) {
  const tar = gunzipSync(gzipped);
  /** @type {Map<string, {kind: string, data?: Buffer, target?: string}>} */
  const entries = new Map();
  /** @type {string|null} */
  let longName = null;
  /** @type {string|null} */
  let longLink = null;
  /** @type {Record<string, string>} */
  let pax = {};
  let offset = 0;
  for (;;) {
    if (offset + 512 > tar.length) throw new Error('the archive ends without its end-of-archive marker');
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return entries;
    if (!checksumMatches(header)) throw new Error(`the header at byte ${offset} fails its checksum`);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const meta = type === 'L' || type === 'K' || type === 'x' || type === 'g';
    const size = !meta && pax.size !== undefined ? Number(pax.size) : headerNumber(header.subarray(124, 136));
    const start = offset + 512;
    if (!Number.isSafeInteger(size) || size < 0 || start + size > tar.length) {
      throw new Error(`the entry at byte ${offset} runs past the end of the archive`);
    }
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'L') longName = headerText(data);
    else if (type === 'K') longLink = headerText(data);
    else if (type === 'x') pax = paxRecords(data);
    if (meta) continue;
    const posix = header.subarray(257, 263).toString('latin1') === 'ustar\0';
    const prefix = posix ? headerText(header.subarray(345, 500)) : '';
    const short = headerText(header.subarray(0, 100));
    const name = longName ?? pax.path ?? (prefix ? `${prefix}/${short}` : short);
    const link = longLink ?? pax.linkpath ?? headerText(header.subarray(157, 257));
    longName = null;
    longLink = null;
    pax = {};
    const key = entryPath(name);
    if (type === '5' || key === '' || key === '.') continue;
    if (type === '0' || type === '7') entries.set(key, { kind: 'file', data });
    else if (type === '2') entries.set(key, { kind: 'symbolic link', target: link });
    else if (type === '1') entries.set(key, { kind: 'hard link', target: entryPath(link) });
    else entries.set(key, { kind: `type ${type} entry` });
  }
}

/**
 * Is an asset this run built the same content as the one a release already carries?
 *
 * @param {Buffer} built
 * @param {Buffer} attached
 * @returns {{same: boolean, how: string}}
 */
export function compareAssets(built, attached) {
  if (built.equals(attached)) return { same: true, how: 'byte for byte' };
  let ours;
  let theirs;
  try {
    ours = tarEntries(built);
    theirs = tarEntries(attached);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { same: false, how: `the bytes differ, and the two cannot both be read as gzipped tars to compare file by file (${why})` };
  }
  const paths = [...new Set([...ours.keys(), ...theirs.keys()])].sort();
  for (const at of paths) {
    const mine = ours.get(at);
    const there = theirs.get(at);
    if (!mine) return { same: false, how: `\`${at}\` is in the attached one and not in this run's` };
    if (!there) return { same: false, how: `\`${at}\` is in this run's and not in the attached one` };
    if (mine.kind !== there.kind) return { same: false, how: `\`${at}\` is a ${mine.kind} in this run's and a ${there.kind} in the attached one` };
    const differs = mine.kind === 'file' ? !mine.data?.equals(/** @type {Buffer} */ (there.data)) : mine.target !== there.target;
    if (differs) return { same: false, how: `\`${at}\` has different content` };
  }
  return { same: true, how: `the same ${paths.length} file(s) with the same bytes, packed at another time` };
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

/**
 * The one spawn site whose output is read: the list of a release's asset names. Errors still reach
 * the log.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{code: number, stdout: string}}
 */
export function captureCommand(cmd, args, { env = process.env } = {}) {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], env, encoding: 'utf8' });
  if (result.error) return { code: 127, stdout: '' };
  return { code: typeof result.status === 'number' ? result.status : 1, stdout: result.stdout ?? '' };
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
    capture = captureCommand,
    exists = existsSync,
    readFile = readFileSync,
    readBytes = (/** @type {string} */ file) => readFileSync(file),
    makeTempDir = () => mkdtempSync(path.join(tmpdir(), 'github-release-asset-')),
    removeDir = (/** @type {string} */ dir) => rmSync(dir, { recursive: true, force: true }),
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
  //
  //    AN EXISTING RELEASE'S ASSETS ARE COMPARED, NEVER REPLACED. A re-run of a release job reaches
  //    this branch for a release its first run already published, and with release immutability on,
  //    GitHub refuses to modify an asset of a published release; its title and notes stay editable.
  //    So each asset this run built is checked against the one the release carries: the same content
  //    is left alone, different content fails the run with what differs, and only an asset the
  //    release does not carry yet is uploaded.
  const attach = () => {
    if (assets.length === 0) return 0;
    const listed = capture('gh', assetNamesArgs({ tag }), { env });
    if (listed.code !== 0) {
      err(`::error title=GitHub release assets not read::gh could not list the assets ${tag} already carries for ${coordinate}, so none was compared or uploaded.\n`);
      return 1;
    }
    const carried = new Set(listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
    const missing = [];
    for (const file of assets) {
      const name = path.basename(file);
      if (!carried.has(name)) {
        missing.push(file);
        continue;
      }
      const dir = makeTempDir();
      try {
        if (run('gh', downloadArgs({ tag, name, dir }), { env }).code !== 0) {
          err(`::error title=GitHub release asset not read::gh could not download ${name} from ${tag} to compare it with the one this run built for ${coordinate}.\n`);
          return 1;
        }
        const verdict = compareAssets(readBytes(file), readBytes(path.join(dir, name)));
        if (!verdict.same) {
          // A path read out of an archive reaches a workflow command here, so the three characters
          // that command syntax gives a meaning to are escaped the way the runner unescapes them.
          const how = verdict.how.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
          err(
            `::error title=Release asset differs::${tag} already carries ${name}, and the ${name} this run built for ${coordinate} ` +
              `has different content: ${how}. A published release's assets cannot be replaced, so the attached one ` +
              `is left as it is. Rebuild ${name} from the commit ${tag} was released from, or release a new version if the attached one is wrong.\n`,
          );
          return 1;
        }
        out(`${tag} already carries ${name} with the same content (${verdict.how}); leaving it as it is.\n`);
      } finally {
        removeDir(dir);
      }
    }
    if (missing.length === 0) return 0;
    const names = missing.map((file) => path.basename(file)).join(' and ');
    if (run('gh', uploadArgs({ tag, assets: missing }), { env }).code !== 0) {
      err(
        `::error title=GitHub release asset not attached::gh could not attach ${names} to the existing ${tag} release for ${coordinate}. ` +
          'An immutable release takes no new asset once it is published, so a release created without it stays without it.\n',
      );
      return 1;
    }
    return 0;
  };
  const update = () => {
    if (run('gh', editArgs({ tag, notes }), { env }).code !== 0) {
      err(`::error title=GitHub release not updated::gh could not update the body of the existing ${tag} release for ${coordinate}.\n`);
      return 1;
    }
    return attach();
  };
  if (run('gh', ['release', 'view', tag], { env, quiet: true }).code === 0) {
    out(`${tag} already has a GitHub release; updating its body and checking its assets.\n`);
    if (update() !== 0) return 1;
  } else {
    const created = run('gh', createArgs({ tag, assets, target, notes }), { env });
    if (created.code !== 0) {
      if (run('gh', ['release', 'view', tag], { env, quiet: true }).code === 0) {
        out(`${tag} was created by another run while this one was creating it; updating it instead.\n`);
        if (update() !== 0) return 1;
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
