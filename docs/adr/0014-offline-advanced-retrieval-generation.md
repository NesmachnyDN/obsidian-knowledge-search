# ADR-0014 — Versioned BGE-M3 retrieval generation and bounded one-shot local model worker

**Status: Proposed, pending OKS-05D independent review.** Date: 2026-11-23. Scope: explicitly opted-in Advanced only. This is not authorization to index a production Vault.

## Context

OKS-05C has authenticated original Source/Evidence v3 chunks, descriptor-anchored path verification and immutable ingestion storage. OKS-03A/B established local BGE-M3 and a reference lexical/dense/RRF policy, but neither a production Obsidian-integrated dense index nor the authorization/resource gates. Standalone must continue to be package-only, offline and no-extra-software. A second independently defined Source/Chunk/Evidence schema would fragment provenance and violate SDD.

## Decision

- Reuse the pinned BGE-M3 weights/tokenizer, CLS/L2 pooling and v3 contextual chunk serialization, with a v4 strict **model-envelope only**. Keep 05B health-only v2 and 05C source v3 immutable; no silent protocol promotion.
- Reuse the previously tested cgroup 4GiB/200% CPU/64 PIDs/AF_UNIX/host reserve/no-download supervisor for bounded one-shot model batches. One-shot is safer for cancellation/OOM/process-tree containment and not a persistent unbounded background worker.
- Store a separate authenticated, atomic XDG retrieval generation bound to v3 source digests, exact source extraction generation, canonical chunk IDs and model/runtime identity, never in the Vault and never in the Standalone index. Fail closed on incompatibility/staleness/corruption.
- Reuse Standalone technical-ID tokenizer and typed Property predicates for lexical; deterministic real dense cosine similarity and RRF k=60 over canonical chunk IDs. Per-leg explicit readiness/status and no hybrid success if either required leg fails.
- Preserve original source excerpts and native locators as ingested; contextual model input is not source evidence. Use public Obsidian APIs for opening/navigation, report unsupported native anchor selection as a limitation rather than fabricate coordinates.

## Alternatives and trade-offs

Persistent model process could reduce cold-query latency but would keep large memory resident and make cgroup lifetime, concurrent event cancellation, reload and no-network validation harder. One-shot is a conservative first bounded slice: model reload can cost 10–20s/query on tested hardware, and this must be reflected as a performance warning or acceptance blocker, not hidden. Replacing the fixed 4GiB profile merely to improve benchmark results is rejected pending separate measured ADR approval. In-Vault FAISS/vector DB writes, external API and automatic weight download are rejected because they violate privacy/offline and index separation. Hash-vector fallback is rejected because it is not model-backed dense. Standalone worker reuse for vector inference is rejected because default standalone has no Python/model dependency.

## Consequences and verification

New compatibility contract and strict Python/TS checks, model/profile hash pinning, source freshness rechecks, bounded corpus metrics and exact-host regression tests are mandatory. A single source change may require reindexing that source and cannot preserve stale vector hits. A source lacking complete native location must not produce a fictitious anchor. Review must inspect the cost of loading model per query and test OOM, no-route, cancellation, corruption and actual Desktop/CLI; no self-approval. See `contracts/advanced-retrieval-v1.md` and `docs/prompts/OKS-05D.md`.
