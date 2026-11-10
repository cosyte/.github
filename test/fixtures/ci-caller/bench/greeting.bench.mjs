// The fixture's benchmark suite, for `ci.yml`'s `bench-compare` job: `cosyte-bench compare` hands
// it the base build and the head build in turn, so the work it times reads only what the built entry
// exports. Every input is built here, from an index; the runner never reads a data file.

import { defineBenchmark, defineSuite } from "@cosyte/bench";

/** A synthetic text of `count` lines, each holding the fixture's greeting once. */
const text = (greeting, index, count) =>
  Array.from({ length: count }, (_value, line) => `${String(index)}:${String(line)} ${greeting}`).join("\n");

export default defineSuite({
  name: "ci-caller-fixture greeting",
  benchmarks: [
    defineBenchmark({
      name: "count the greetings",
      sizes: [
        {
          label: "64 lines",
          build: () => ({ inputs: Array.from({ length: 32 }, (_value, index) => text("hello from the CI caller fixture", index, 64)) }),
        },
      ],
      bind: (pkg) => (raw) => raw.split(pkg.greeting).length - 1,
      weigh: (found) => found,
    }),
  ],
});
