// The caller's synthetic smoke sample: import the package by name, parse a synthetic message, check
// the result. Self-contained, because the job copies this one file into a clean directory.
import assert from "node:assert/strict";
import { parse } from "@cosyte-fixture/published-check";

const segments = parse("MSH|SYNTH-APP|SYNTH-FACILITY\rPID|1|SYNTH-0001");
assert.equal(segments.length, 2);
assert.equal(segments[1][2], "SYNTH-0001");
console.log("smoke sample ok");
