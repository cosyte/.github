// THE DELIVERY OF THE DOCS-CONTENT CHECKER, WHICH IS THE HALF NOTHING TESTED.
//
// The gate was switched on, documented, unit tested and reachable, and it had never once run on a
// caller. `test/docs-content-check.test.mjs` proves the CHECKER against fixture trees and
// `test/ci-docs-content.test.mjs` proves the SHAPE of the two steps in `ci.yml`, and between them
// the one thing neither asked was whether the checker ever ARRIVES. It did not. The delivery step
// shipped as `TOOLING_SHA: ${{ github.job_workflow_sha }}`, that expression is not a property of the
// `github` context, an unknown property is `''` rather than an error, and the URL degenerated to
// `https://raw.githubusercontent.com/cosyte/.github//scripts/docs-content-check.mjs`. The first
// opted-in caller's `verify` job died on `curl: (22) The requested URL returned error: 404` before
// the checker started, on both matrix legs and again on a re-run: four job executions, no verdict
// about `docs-content/` at all, not a pass and not a finding (`cosyte/x12` run 33230794979).
//
// WHY THE `job` CONTEXT. The contexts reference gives the `github` context `github.workflow_sha` and
// `github.workflow_ref`, which describe the workflow file of the run, meaning the CALLER's; the
// identity of the file that defines a CALLED job lives on the `job` context, as `job.workflow_sha`,
// `job.workflow_repository`, `job.workflow_ref` and `job.workflow_file_path`. The reference's own
// reusable-workflow example checks a workflow's own source out with that pair, and its context
// availability table lists `job` for `steps.env`, `steps.run` and `steps.with`.
//
// WHAT THIS FILE DOES THAT A STATIC ASSERTION CANNOT. Half of it reads `ci.yml`, because the
// expression itself is only ever a string until a runner evaluates it. The other half EXTRACTS the
// delivery step's shell script out of `ci.yml` and RUNS IT, against a `curl` stub on `PATH` and a
// throwaway `RUNNER_TEMP`, once per way a delivery can fail: a 404, a network error, a zero length
// file, a file that is not the checker, an empty ref, and an unset one. Each case asserts the exit
// code AND that the log names the ref and the location, because the whole cost of the incident was
// a log that said `curl: (22)` and nothing else. A green case is paired with a red one throughout,
// the pattern `test/docs-content-check.test.mjs` sets.
//
// The parse is line based and dumb rather than a YAML library, for the reason `ci-docs-content`
// gives: this repository has no `package.json`, no lockfile and no install step.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(HERE, '../.github/workflows/ci.yml');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');
const LINES = WORKFLOW.split('\n');
const CHECKER = resolve(HERE, '../scripts/docs-content-check.mjs');

/** The one expression that names the commit of THIS workflow file inside a called job. */
const REF_EXPRESSION = '${{ job.workflow_sha }}';

/** The expression this incident was caused by, kept so the control names what it refuses. */
const EMPTY_EXPRESSION = 'github.job_workflow_sha';

const indentOf = (line) => /^ */.exec(line)[0].length;

/** Every line of the step introduced by the `- name: <name>` line, at step indent 6. */
function stepBody(name) {
  const start = LINES.findIndex((line) => line === `      - name: ${name}`);
  assert.notEqual(start, -1, `ci.yml has no step named "${name}"`);
  const out = [];
  for (let index = start + 1; index < LINES.length; index += 1) {
    const line = LINES[index];
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    if (indentOf(line) <= 6) break;
    out.push(line);
  }
  return out;
}

/** The step's `env:` mapping, values verbatim so an expression can be compared as written. */
function stepEnv(body) {
  const at = body.findIndex((line) => /^ {8}env:$/.test(line));
  if (at === -1) return {};
  const out = {};
  for (let index = at + 1; index < body.length; index += 1) {
    const line = body[index];
    if (line.trim() === '') continue;
    if (indentOf(line) < 10) break;
    const match = /^ {10}([A-Za-z_][\w]*): (.+)$/.exec(line);
    assert.ok(match, `unreadable env entry in ci.yml: ${line}`);
    out[match[1]] = match[2].trim();
  }
  return out;
}

/** The step's `run: |` block, dedented to what the runner hands to bash. */
function stepRun(body) {
  const at = body.findIndex((line) => /^ {8}run: \|$/.test(line));
  assert.notEqual(at, -1, 'the step has no `run: |` block');
  const out = [];
  for (let index = at + 1; index < body.length; index += 1) {
    const line = body[index];
    if (line.trim() !== '' && indentOf(line) < 10) break;
    out.push(line.slice(10));
  }
  return `${out.join('\n')}\n`;
}

const DELIVERY = stepBody('Fetch the docs-content checker');
const DELIVERY_ENV = stepEnv(DELIVERY);
const DELIVERY_SCRIPT = stepRun(DELIVERY);
const INVOCATION_SCRIPT = stepRun(stepBody('docs-content links, images and sidebar ids must resolve'));
const TOOLING_CHECKOUT = stepBody('Check out the shared CI tooling');

// ---------------------------------------------------------------------------
// THE EXPRESSION, WHICH IS THE WHOLE DEFECT
// ---------------------------------------------------------------------------

test('DELIVERY resolves the ref from the `job` context, the only one a called job carries', () => {
  assert.equal(
    DELIVERY_ENV.TOOLING_SHA,
    REF_EXPRESSION,
    'the delivery ref must come from job.workflow_sha, the commit SHA of the workflow file that defines this job',
  );
});

test('DELIVERY never interpolates `github.job_workflow_sha`, which is empty in a called job', () => {
  const executable = LINES.filter((line) => !line.trim().startsWith('#'));
  const offenders = executable.filter((line) => line.includes(EMPTY_EXPRESSION));
  assert.deepEqual(
    offenders,
    [],
    `${EMPTY_EXPRESSION} is not a property of the github context: it evaluates to '' and 404s the delivery`,
  );
});

test('DELIVERY guards the ref for emptiness BEFORE it builds the URL, and says so when it substitutes', () => {
  const lines = DELIVERY_SCRIPT.split('\n');
  const guard = lines.findIndex((line) => /if \[ -z "\$\{ref\}" \]; then/.test(line));
  const announce = lines.findIndex((line) => line.includes('job.workflow_sha was empty, falling back to main'));
  const url = lines.findIndex((line) => /^url=/.test(line));
  const fetch = lines.findIndex((line) => line.includes('curl'));

  assert.notEqual(guard, -1, 'an empty ref must be detected rather than interpolated');
  assert.notEqual(announce, -1, 'a substituted ref must be announced with the expression that was empty');
  assert.notEqual(url, -1, 'the URL must be built from the resolved ref');
  assert.ok(guard < url, 'the emptiness guard must run before the URL is built');
  assert.ok(announce < url, 'the substitution must be announced before the URL is built');
  assert.ok(url < fetch, 'the URL must exist before the fetch');
});

test('DELIVERY prints the ref it used before it fetches, so a reader can name the provider commit', () => {
  const lines = DELIVERY_SCRIPT.split('\n');
  const echo = lines.findIndex((line) => /^echo "docs-content delivery: ref \$\{ref\}, from \$\{url\}"$/.test(line));
  const fetch = lines.findIndex((line) => line.includes('curl'));
  assert.notEqual(echo, -1, 'the ref must appear in the job log');
  assert.ok(echo < fetch, 'the ref must be in the log before anything can fail');
});

// ---------------------------------------------------------------------------
// NEITHER DOCS-CONTENT STEP MAY SWALLOW A FAILURE
// ---------------------------------------------------------------------------

test('BOTH docs-content steps keep `set -euo pipefail` and swallow nothing', () => {
  for (const [label, script] of [
    ['delivery', DELIVERY_SCRIPT],
    ['invocation', INVOCATION_SCRIPT],
  ]) {
    assert.match(script, /^set -euo pipefail$/m, `${label}: an unset variable or a failed command must fail`);
    assert.doesNotMatch(script, /\|\| true/, `${label}: || true would green a failed delivery`);
    assert.doesNotMatch(script, /continue-on-error/, `${label}: continue-on-error would leave the context green`);
    assert.doesNotMatch(script, /\bexit 0\b/, `${label}: an explicit exit 0 defeats the gate`);
    assert.doesNotMatch(script, /\btee\b/, `${label}: tee-and-exit-zero prints findings into a green job`);
  }
});

// ---------------------------------------------------------------------------
// THE SIBLING CALL SITE, WHICH FAILED SILENTLY INSTEAD OF LOUDLY
// ---------------------------------------------------------------------------

test('the prepublish tooling checkout uses the SAME resolution, so one landmine is not left armed', () => {
  const ref = TOOLING_CHECKOUT.find((line) => /^ {10}ref: /.test(line));
  assert.ok(ref, 'the tooling checkout must pin a ref');
  assert.equal(
    ref.trim(),
    `ref: ${REF_EXPRESSION}`,
    // An empty ref is not an error for actions/checkout: it resolves the default branch. So the
    // identical empty value was fatal in the raw-URL delivery and SILENT here, in a job that is on
    // by default for every caller.
    'the checkout ref must resolve the same way the delivery does',
  );
});

// ---------------------------------------------------------------------------
// THE DELIVERY SCRIPT, RUN
// ---------------------------------------------------------------------------

/**
 * A `curl` stub on `PATH`. It records the URL it was asked for, then behaves as `tail` says.
 * `--output` is read the way the real invocation passes it.
 */
function curlStub(tail) {
  return [
    '#!/usr/bin/env bash',
    'out=""',
    'url=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --output) out="$2"; shift 2;;',
    '    -*) shift;;',
    '    *) url="$1"; shift;;',
    '  esac',
    'done',
    'printf "%s" "$url" > "$REQUESTED_URL"',
    tail,
    '',
  ].join('\n');
}

const STUBS = {
  delivers: `cp "$CHECKER" "$out"`,
  notFound: 'printf "curl: (22) The requested URL returned error: 404\\n" >&2; exit 22',
  networkDown: 'printf "curl: (6) Could not resolve host: raw.githubusercontent.com\\n" >&2; exit 6',
  deliversNothing: ': > "$out"',
  deliversSomethingElse: 'printf "<!DOCTYPE html>\\n<html>404: Not Found</html>\\n" > "$out"',
};

/** Run the delivery step's own script, exactly as extracted, under a stubbed `curl`. */
function runDelivery(stub, { sha } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-docs-content-delivery-'));
  const bin = join(dir, 'bin');
  const runnerTemp = join(dir, 'runner-temp');
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  const curl = join(bin, 'curl');
  writeFileSync(curl, curlStub(stub));
  chmodSync(curl, 0o755);

  const requestedUrl = join(dir, 'requested-url');
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: runnerTemp,
    CHECKER,
    REQUESTED_URL: requestedUrl,
  };
  if (sha === undefined) delete environment.TOOLING_SHA;
  else environment.TOOLING_SHA = sha;

  const result = spawnSync('bash', ['-c', DELIVERY_SCRIPT], { encoding: 'utf8', env: environment });
  const read = (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  };
  return {
    code: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    requestedUrl: read(requestedUrl),
    delivered: read(join(runnerTemp, 'docs-content-check.mjs')),
    runnerTemp,
  };
}

const SHA = '856fcf17a9a83f9054fad959855e9a9ef41cb5d4';

/** The exact location the step fetches from at a given ref. */
const urlFor = (ref) => `https://raw.githubusercontent.com/cosyte/.github/${ref}/scripts/docs-content-check.mjs`;

test('A RESOLVED REF DELIVERS THE CHECKER, from the provider commit the caller resolved', () => {
  const run = runDelivery(STUBS.delivers, { sha: SHA });
  assert.equal(run.code, 0, run.output);
  assert.equal(run.requestedUrl, urlFor(SHA));
  assert.equal(run.delivered, readFileSync(CHECKER, 'utf8'), 'what lands is the checker, byte for byte');
  assert.match(run.output, new RegExp(`docs-content delivery: ref ${SHA}, from `), 'the ref is in the log');
});

test('AN EMPTY REF IS ANNOUNCED AND SUBSTITUTED, never silently interpolated', () => {
  const run = runDelivery(STUBS.delivers, { sha: '' });
  assert.equal(run.code, 0, run.output);
  // The exact shape the incident wanted and did not get: what was empty, and what ran instead.
  assert.match(run.output, /job\.workflow_sha was empty, falling back to main/);
  assert.match(run.output, /docs-content delivery: ref main, from /);
  assert.equal(
    run.requestedUrl,
    urlFor('main'),
    'the substitute ref is the provider default branch, and it is the ref actually used',
  );
  // The empty value never reaches the URL, which is what produced `.../cosyte/.github//scripts/`.
  assert.equal(run.requestedUrl.includes(urlFor('')), false);
});

test('AN UNSET REF FAILS THE STEP, because `set -u` is load-bearing rather than decorative', () => {
  const run = runDelivery(STUBS.delivers, { sha: undefined });
  assert.notEqual(run.code, 0, 'an unset TOOLING_SHA must not be read as an empty one');
  assert.match(run.output, /TOOLING_SHA/, run.output);
  assert.equal(run.delivered, null, 'nothing is delivered when the step cannot resolve its input');
});

test('A 404 REDS THE STEP AND SAYS MORE THAN `curl: (22)`, naming the ref and the location', () => {
  const run = runDelivery(STUBS.notFound, { sha: SHA });
  assert.notEqual(run.code, 0);
  assert.match(run.output, new RegExp(`docs-content delivery FAILED at ref ${SHA}`));
  // The WHOLE url, compared as a string rather than matched as a pattern. An unanchored regex over
  // a host is the `js/regex/missing-regexp-anchor` shape, and there is nothing to pattern-match
  // here anyway: the exact location the step tried is known.
  assert.ok(run.output.includes(urlFor(SHA)), `the location it tried is named:\n${run.output}`);
  const explanation = run.output.split('\n').filter((line) => line.includes('docs-content delivery FAILED'));
  assert.ok(explanation.length > 0, 'a bare curl exit code must not be the only explanation in the log');
});

test('A NETWORK FAILURE REDS THE STEP, with the same named explanation', () => {
  const run = runDelivery(STUBS.networkDown, { sha: SHA });
  assert.notEqual(run.code, 0);
  assert.match(run.output, new RegExp(`docs-content delivery FAILED at ref ${SHA}`));
});

test('A ZERO LENGTH ARTIFACT REDS THE STEP, naming the ref and where it landed', () => {
  const run = runDelivery(STUBS.deliversNothing, { sha: SHA });
  assert.notEqual(run.code, 0, 'an empty file must not be run as a checker that found nothing');
  assert.match(run.output, new RegExp(`docs-content delivery FAILED at ref ${SHA}`));
  assert.match(run.output, /docs-content-check\.mjs/);
});

test('AN ARTIFACT THAT IS NOT THE CHECKER REDS THE STEP, rather than dying later as a syntax error', () => {
  const run = runDelivery(STUBS.deliversSomethingElse, { sha: SHA });
  assert.notEqual(run.code, 0);
  assert.match(run.output, new RegExp(`docs-content delivery FAILED at ref ${SHA}`));
  assert.match(run.output, /is not the checker/);
});

test('THE CHECKER THAT LANDS IS RUNNABLE where it lands, outside the caller workspace', () => {
  const run = runDelivery(STUBS.delivers, { sha: SHA });
  assert.equal(run.code, 0, run.output);
  // The invocation step runs exactly this path, and nothing else in `verify` may see it.
  assert.match(INVOCATION_SCRIPT, /^node "\$\{RUNNER_TEMP\}\/docs-content-check\.mjs" --repo \.$/m);
  const checked = spawnSync('node', ['--check', join(run.runnerTemp, 'docs-content-check.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(checked.status, 0, checked.stderr);
});
