# OKS-05E-B2 — Isolate Standalone initial-publication cancel/reload recovery

**Bounded remediation** of an independently reproduced `develop` regression, from PR #18 remediation B2, without accepting any optional Advanced OCR/model features.
**Base:** `develop=86569aab8c031ca7dab0b74257691ade60b8f47e`.
**Traceability:** SPEC CAP-01/06/07/08/09/10; ADR-0008, ADR-0015, OKS-05E Gate A, 05D remediation B2.

## In
- Authenticate and discard *only* the owned initial unpublished immutable generation when publication is canceled strictly before the first `CURRENT` rename. Never discard a pre-existing committed, foreign or ambiguous generation; unknown `CURRENT` remains fail-closed.
- Reuse exact recovery fix from PR #18 only for `plugin/src/standalone/storage.ts`, one deterministic initial-cancel/reopen test and lifecycle diagnostics in tests. No model worker, OCR, parser, telemetry, dependency, schema or user-Vault change.
- Independently repeat overlapping Advanced-health/Standalone reload test; complete TypeScript, Python, licenses, build, package, actual offline synthetic Obsidian Desktop/CLI and recovery/regression suite.
- New standalone Draft PR to `develop` with independent full-diff review before merge. The overlapping code in PR #18 must be re-synchronized with `develop` after independently accepted fix. Do not approve/merge from author session.

## Out
- PR #18 optional real BGE-M3 model/retrieval integration and full RU+EN OCR acceptance.
- User Vault, credentials, cloud, dependency/model/OCR downloads, `main` and unrelated cleanup.
