"use strict";

/** Split a synthetic pipe-delimited message into segments of fields. */
function parse(text) {
  return String(text)
    .split(/\r\n|\r|\n/)
    .filter((line) => line !== "")
    .map((line) => line.split("|"));
}

module.exports = { parse };
