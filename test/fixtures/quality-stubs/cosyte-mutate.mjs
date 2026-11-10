#!/usr/bin/env node
// A stand-in for cosyte-mutate; see stubs.mjs.
import { mutate, processIo } from "./stubs.mjs";

process.exitCode = mutate(process.argv.slice(2), processIo());
