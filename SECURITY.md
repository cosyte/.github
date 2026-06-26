# Security policy

This policy covers the open-source `@cosyte/*` packages — the HL7, MLLP, DICOM,
X12, C-CDA, and NCPDP parsers and their shared build/lint/test tooling.

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue, and do
not include real patient data in a report.

- Preferred: open a private report through **GitHub Security Advisories** on the
  affected repository — *Security → Report a vulnerability*.
- Or email **security@cosyte.com** with `SECURITY` in the subject line.

Tell us the package and version, what you found, and the smallest input that
reproduces it. Use **synthetic data only** — never real PHI (see below).

We aim to acknowledge a report within **5 business days** and will keep you
posted as we confirm, fix, and release. cosyte is a small, solo-maintained
project, so we appreciate your patience — and we'll credit you in the advisory
unless you'd rather stay anonymous.

## What's in scope

The `@cosyte/*` packages are parsing and serialization libraries — they take
healthcare-format input and return typed data. The risk surface we care about
most:

- Inputs that cause a crash, hang, unbounded memory use, or pathological
  back-tracking. A malformed message should produce a typed error, never take
  down the process.
- Parser output that misrepresents the input in a way that could cause a
  downstream system to mishandle a record.
- Any path that writes received data somewhere it shouldn't, or leaks it into an
  error message or log.

Most packages ship with zero runtime dependencies, so the third-party surface is
small by design.

## A note on PHI

These libraries process Protected Health Information in real deployments, but the
**libraries themselves never need real PHI to reproduce a bug**. Every report,
fixture, and example must use synthetic identifiers — fabricated names, MRNs, and
dates. If you believe an issue can only be shown with real data, say so in your
private report and we'll work out a safe way to confirm it. Never paste PHI into
an issue, a pull request, or an email.

## A note on compliance

The `@cosyte/*` packages are building blocks, not a compliance product. They are
**HIPAA-capable** — they can be used inside a compliant system — but using them
does not by itself make a system HIPAA-compliant. That responsibility stays with
the system you build.
