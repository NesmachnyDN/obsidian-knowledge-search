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
- [ADR-0010 — Portable embedding reuse](0010-portable-bge-m3-embedding-cache.md) — Proposed optional provider/model-compatible immutable vectors and opt-in S3-compatible transfer, never a shared working index.
- [ADR-0011 — Local Docling extraction cache](0011-local-docling-extraction-cache.md) — Proposed private versioned ParsedDocument cache, no remote parsing.
- [ADR-0012 — Configurable embedding API](0012-optional-embedding-api.md) — Proposed conditional embedding API under ADR-0015; scoped explicit consent, no mandatory cloud.
- [ADR-0013 — Source synchronization boundary](0013-source-sync-boundary.md) — Proposed independent source synchronization boundary and freshness validation.
- [ADR-0014 — Experimental local BGE-M3 retrieval generation](0014-offline-advanced-retrieval-generation.md) — OKS-05D proposed local-only profile; independent review pending, not a substitute for ADR-0015 API providers.
- [ADR-0015 — API-first optional AI retrieval](0015-api-first-ai-optional-dense.md) — Product-owner target direction of 2026-11-23: autonomous basic search, local/cloud provider APIs, one active dense index, separated conditional acceptance gates; repository review pending.

- [ADR-0016 — Platform portability and managed optional document runtime](0016-platform-portability-managed-runtime.md) — Product-owner direction 2026-11-25: frictionless core-first onboarding, one-action optional desktop runtime, desktop/mobile adapters and distribution-policy gate; independent review pending.

- [ADR-0017 — Extensible local multi-format attachment extraction](0017-extensible-multiformat-extraction.md) — Product-owner format coverage, registry, canonical content indexing and source navigation; candidates require benchmark, independent review pending.

- [ADR-0018 — Scoped conversational generation](0018-scoped-conversation-authority.md) — Proposed bounded conversation and scope/authority design; independent review required.

- [ADR-0019 — Note processing policy and provider trust boundary](0019-note-processing-policy.md) — Proposed prospective eligibility, shared authority and local marking decision; strict pilot remains operative until accepted implementation.

- [ADR-0020 — Source-aware graph projection](0020-source-aware-graph-projection.md) — Proposed optional local graph, configurable typed relations, exact provenance and bounded scope-preserving expansion; 06B.1 design acceptance before implementation.

- [ADR-0021 — Durable material lifecycle](0021-durable-material-lifecycle.md) — Historical marking lifecycle design; prospective consumer dependency narrowed by ADR-0023.
- [ADR-0022 — Semantic corpus](0022-semantic-corpus-policy.md) — Independent automatic AI corpus eligibility; preserved by ADR-0023.
- [ADR-0023 — Standalone consumer, reuse and unified retrieval](0023-standalone-consumer-reuse.md) — Proposed 2026-11-27 rebaseline; independent review required; no runtime claim.
