# Architecture decision records

- [ADR-0001](0001-local-first-boundaries.md) — Original accepted local-first baseline (deployment assumptions refined by ADR-0006).
- [ADR-0002](0002-first-vertical-and-experiment-gates.md) — Proposed first synthetic vertical, tokenizer ordering and experiment gates.
- [ADR-0003](0003-runtime-storage-foundation.md) — SQLite storage, bounded persistent stdio, scope and resource foundation; accepted for the bounded slice upon review and merge.
- [ADR-0006](0006-standalone-execution-profiles.md) — Accepted architecture baseline: default plugin-native Standalone and explicit bundled/external advanced profiles, canonical cross-runtime evidence and acceptance gates; supersedes the mandatory-Python-runtime reading of ADR-0001.
- [ADR-0007](0007-retrieval-calibrated-chunking.md) — Proposed retrieval-calibrated choice from actual BGE-M3 offline pilot: paragraph-aware ahead of structure-aware for the measured reference profile; no production-policy acceptance before full-phase review.
- Future ADRs: native index/worker compatibility, measured model runtime, advanced package distribution, secure backend IPC, resource controls and adoption. Choose after evidence; document alternatives, consequences and supersession.

Use states Proposed, Accepted, Superseded or Rejected. Do not mark an experiment as implemented or accepted merely because it is listed.

- [ADR-0004](0004-native-extraction-profiles.md) — Measured native extraction profiles; the structured-PDF candidate remains subject to its recorded semantic limitations.
- [ADR-0005](0005-provisional-structural-chunking.md) — Measured tokenizer identity, source-preserving chunking comparison and provisional independent-structure shortlist; retrieval-quality acceptance deferred to OKS-03B.
- [ADR-0009 — Opt-in local Advanced transport](0009-opt-in-local-advanced-transport.md) (05B proposal; health-only, independent review pending).
- [ADR-0010 — Portable BGE-M3 embedding cache and multi-device sync](0010-portable-bge-m3-embedding-cache.md) — Proposed post-MVP decision on local indexes, reusable immutable vectors and opt-in synchronized-folder transport; review pending.
- [ADR-0011 — Local Docling extraction and ParsedDocument cache](0011-local-docling-extraction-cache.md) — Proposed local-only Docling/OCR and derived document cache, no cloud Docling; post-MVP acceptance.
- [ADR-0012 — Optional Cloud.ru BGE-M3 provider](0012-optional-cloudru-bge-m3-provider.md) — Proposed opt-in text-embedding API, separate provider space and strict confidentiality/cost controls; offline MVP unchanged.
