# Security policy

This policy covers our 14 open-source libraries and Pathways:

- one library for each of 8 standards: `@cosyte/hl7`, `@cosyte/mllp`, `@cosyte/fhir`,
  `@cosyte/ccda`, `@cosyte/x12`, `@cosyte/ncpdp`, `@cosyte/astm`, and `@cosyte/dicom`;
- 6 libraries built on them: `@cosyte/terminology`, `@cosyte/transform`, `@cosyte/deid`,
  `@cosyte/synth`, `@cosyte/dates`, and `@cosyte/cli`;
- [Pathways](https://github.com/cosyte/pathways), our integration engine, in development;
- the shared build, lint, and test tooling they use, in
  [cosyte/config](https://github.com/cosyte/config) and
  [cosyte/.github](https://github.com/cosyte/.github).

## Reporting a vulnerability

Report security issues **privately**. Do not open a public issue, and do not include real patient
data in a report. Either of these routes reaches us:

- **GitHub private vulnerability reporting** on the affected repository: open its **Security** tab
  and choose **Report a vulnerability**, or go straight to
  `https://github.com/cosyte/<repository>/security/advisories/new`.
- **Email** to [security@cosyte.com](mailto:security@cosyte.com), with `SECURITY` in the subject
  line.

Tell us the package and version (for Pathways, the commit), what you found, and the smallest input
that reproduces it. Use **synthetic data only**, never real PHI (see below).

We aim to acknowledge a report within **5 business days**, and we keep you posted as we confirm,
fix, and release. We credit you in the advisory unless you would rather stay anonymous.

## Supported versions

- **The 14 libraries:** the 0.1 line is supported. We release each fix as a new version on the 0.1
  line, so upgrade to the latest 0.1 release to get it. The older 0.0.x releases are not supported
  and get no fixes.
- **Pathways:** not released yet. Report against its `main` branch, where fixes land.

## What is in scope

The libraries parse, build, validate, and transform healthcare data in your own process. The risk
surface we care about most:

- Inputs that cause a crash, hang, unbounded memory use, or pathological backtracking. A malformed
  message should produce a typed error, never take down the process.
- Output that misrepresents the input in a way that could cause a downstream system to mishandle a
  record.
- `@cosyte/deid` output that keeps a value its de-identification policy says it removes.
- Any path that writes received data somewhere it should not, or leaks it into an error message or
  a log.
- In Pathways, which runs as a service: a way to reach a message or an endpoint without the
  credentials its configuration requires, a way to read messages stored encrypted at rest without
  the key, or PHI in a log, an error, or the health endpoint.

Three of the libraries have a third-party runtime dependency, one each: `@cosyte/ccda` on
`@xmldom/xmldom`, `@cosyte/ncpdp` on `fast-xml-parser`, and `@cosyte/dates` on `temporal-polyfill`.
The other 11 depend on nothing outside `@cosyte`, so the third-party surface is small by design.

## A note on PHI

The libraries and Pathways are built to handle Protected Health Information, but a bug in them
never needs real PHI to reproduce it. Every report, fixture, and example must use synthetic
identifiers: fabricated names, MRNs, and dates. If you believe an issue can only be shown with real
data, say so in your private report and we will work out a safe way to confirm it. Never paste PHI
into an issue, a pull request, or an email.

## A note on compliance

We make no compliance claim about our software. The libraries are code that runs in your own
process and acts on the data you pass it; only `@cosyte/mllp` sends data over a network, to the
hosts you configure. Pathways receives, stores, and delivers messages as its configuration directs.
Whether a system built with them meets its legal obligations depends on how that system is built,
configured, and run, and that responsibility stays with the system's owner.
