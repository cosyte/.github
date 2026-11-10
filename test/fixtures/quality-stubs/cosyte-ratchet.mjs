#!/usr/bin/env node
// A stand-in for cosyte-ratchet; see stubs.mjs.
import { processIo, ratchet } from "./stubs.mjs";

process.exitCode = ratchet(process.argv.slice(2), processIo());
