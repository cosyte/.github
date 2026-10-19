// A sample that checks for a value the parser never returns, so the job must report it failing.
import assert from "node:assert/strict";
import { parse } from "@cosyte-fixture/published-check";

const segments = parse("MSH|SYNTH-APP|SYNTH-FACILITY\rPID|1|SYNTH-0001");
assert.equal(segments[1][2], "SYNTH-9999");
