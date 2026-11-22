# Architecture decision records

- [ADR-0001](0001-local-first-boundaries.md) — Original accepted local-first baseline (deployment assumptions refined by ADR-0006).
- [ADR-0002](0002-first-vertical-and-experiment-gates.md) — Proposed first synthetic vertical, tokenizer ordering and experiment gates.
- [ADR-0003](0003-runtime-storage-foundation.md) — SQLite storage, bounded persistent stdio, scope and resource foundation; accepted for the bounded slice upon review and merge.
- [ADR-0006](0006-standalone-execution-profiles.md) — Accepted architecture baseline: default plugin-native Standalone and explicit bundled/external advanced profiles, canonical cross-runtime evidence and acceptance gates; supersedes the mandatory-Python-runtime reading of ADR-0001.
- Future ADRs: native index/worker compatibility, measured model runtime, advanced package distribution, secure backend IPC, resource controls and adoption. Choose after evidence; document alternatives, consequences and supersession.

Use states Proposed, Accepted, Superseded or Rejected. Do not mark an experiment as implemented or accepted merely because it is listed.

- [ADR-0004](0004-native-extraction-profiles.md) — Measured native extraction profiles; the structured-PDF candidate remains subject to its recorded semantic limitations.
- [ADR-0005](0005-provisional-structural-chunking.md) — Measured tokenizer identity, source-preserving chunking comparison and provisional independent-structure shortlist; retrieval-quality acceptance deferred to OKS-03B.
