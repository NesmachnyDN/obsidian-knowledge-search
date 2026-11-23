# Architecture decision records

- [ADR-0001](0001-local-first-boundaries.md) — Original accepted local-first baseline (deployment assumptions refined by ADR-0006).
- [ADR-0002](0002-first-vertical-and-experiment-gates.md) — Proposed first synthetic vertical, tokenizer ordering and experiment gates.
- [ADR-0003](0003-runtime-storage-foundation.md) — SQLite storage, bounded persistent stdio, scope and resource foundation; accepted for the bounded slice upon review and merge.
- [ADR-0006](0006-standalone-execution-profiles.md) — Historical accepted Standalone baseline; its mandatory offline Advanced AI release-gate and local-only backend restriction are prospectively superseded by ADR-0015.
- [ADR-0007](0007-retrieval-calibrated-chunking.md) — Proposed retrieval-calibrated choice from actual BGE-M3 offline pilot: paragraph-aware ahead of structure-aware for the measured reference profile; no production-policy acceptance before full-phase review.
- Future ADRs: native index/worker compatibility, measured model runtime, advanced package distribution, secure backend IPC, resource controls and adoption. Choose after evidence; document alternatives, consequences and supersession.

Use states Proposed, Accepted, Superseded or Rejected. Do not mark an experiment as implemented or accepted merely because it is listed.

- [ADR-0004](0004-native-extraction-profiles.md) — Measured native extraction profiles; the structured-PDF candidate remains subject to its recorded semantic limitations.
- [ADR-0005](0005-provisional-structural-chunking.md) — Measured tokenizer identity, source-preserving chunking comparison and provisional independent-structure shortlist; retrieval-quality acceptance deferred to OKS-03B.
- [ADR-0009 — Opt-in local Advanced transport](0009-opt-in-local-advanced-transport.md) (05B proposal; health-only, independent review pending).
- [ADR-0015 — API-first optional AI retrieval](0015-api-first-ai-optional-dense.md) — Product-owner target direction of 2026-11-23: autonomous basic search, local/cloud provider APIs, one active dense index, separated conditional acceptance gates; repository review pending.
