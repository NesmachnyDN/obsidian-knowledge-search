# ADR-0010 — Portable BGE-M3 Embedding Cache & Multi-Device Index Synchronization

**Status:** Proposed (maintainer architecture direction, 2026-11-23; independent SDD review and merge pending).
**Scope:** optional post-MVP capability, not an OKS-05C/05D/05E gate.
**Related:** ADR-0003 (SQLite experiment), ADR-0006 (execution profiles), ADR-0008 (host-private Standalone), `contracts/portable-model.md` (source/evidence identity).

## Context and objectives

A new Obsidian Vault is being populated incrementally from a legacy **Yandex Cloud Object Storage S3** bucket (~1.5 GiB historical corpus). Multi-device sync to Yandex stopped working on the corporate workstation after network access restrictions. The selected new deployment is **Cloud.ru Evolution Object Storage S3** for the new Vault and a separately permissioned S3 embedding cache (ADR-0013). Vault synchronization is a separate operator-managed Obsidian concern, not a required OKS runtime. Recalculating identical BGE-M3 document embeddings at each host wastes time and compute. ADR-0008 deliberately binds the existing Standalone local index to a real filesystem root path, device and inode. A copied index is **not** a valid portable index. A SQLite database and its WAL/SHM sidecars must not be treated as a multi-machine writable database through file synchronization.

The required outcome is **portable reuse of computed document vectors**, while each computer retains an independent, transactional, local search index. The source Vault remains authoritative for content, identity, access and evidence freshness.

## Decision

1. **Embedding model:** select pinned `BAAI/bge-m3`, **dense 1024-dimensional L2-normalized** vectors, for the Advanced document and query embedding profile. `engine/embedding-artifacts.json` supplies a pinned reference revision; it does not authorize automatic model downloads or weight redistribution. Freeze the exact model weights/tokenizer revision and digests, input serialization and contextual prefixes, dimension, normalization, numeric encoding and verified inference compatibility in a versioned `embeddingSpaceId`. Same name/dimension across different runtimes/providers is not sufficient without measured output parity. Sparse and multi-vector BGE-M3 are deferred.
2. **Local persistence:** preserve the plugin-native Standalone lexical index and no-extra-dependency default. Optional Advanced uses host-private, versioned, transactional embedded storage outside the Vault. SQLite is the preferred metadata/persistence candidate; `sqlite-vec` is an **unconfirmed candidate** for vector search, subject to benchmark against exact search and embedded ANN alternatives. No mandatory external database/server/Docker. Offline local BGE-M3 remains required for Advanced MVP; optional cloud inference is a separate future opt-in.
3. **Portable artifacts:** export/import immutable, content-addressed vector objects and complete immutable generation manifests, independent of a host's SQLite/ANN files, local paths and local `CURRENT`/rollback pointers. Select a private **Cloud.ru S3 bucket** using provider-neutral S3 semantics as the first optional immutable-artifact transport, separate from the source-Vault synchronization bucket. Publish immutable content-addressed objects before a complete generation manifest; incomplete S3 uploads cannot become active indexes. A synced-directory adapter remains a later alternative. No S3 API/key/bucket dependency is added to Standalone or local/offline Advanced.
4. **Security:** export and import are **disabled by default** and opt-in per trusted folder/collection. Do not include source text, source excerpts, original documents, credentials or absolute host paths by default. Embeddings and their hashes can leak source information and must be classified as derived confidential data. For restricted Vaults, require a separately designed and independently reviewed authenticated encryption/key/revocation scheme before enabling cloud sync. Digest integrity is not the same as publisher authenticity.
5. **Publisher model:** first delivery supports exactly **one publisher** of completed immutable generations and multiple read-only consumers. Multi-writer conflict resolution, cross-Vault sharing, object garbage collection and automatic revocation propagation are deferred. Never delete shared artifacts simply because one device no longer references them.
6. **No repeat document inference:** consumers import verified, compatible document embeddings into their own local vector structures **without calculating document embeddings again**. Changed effective inputs, absent artifacts or incompatible profiles require new embeddings or explicit degraded/unavailable status. Each **new dense query still requires a compatible query encoder**, local or through separately authorized inference.

## Separation from extraction caching and provider policy

ADR-0011 selects **local-only Docling/OCR** and a private extraction cache that retains ParsedDocument text/locators; those parsed artifacts are never part of the portable vector-only sync format. A compatible parsed-document cache survives downstream chunk/embedding/index changes; the separately keyed BGE-M3 vector cache survives local ANN/SQLite index rebuilds. ADR-0012 selects **optional** Cloud.ru BGE-M3 text embedding computation only with explicit user scope consent, local indexing, spending limits and a **separate cloud embedding space** until exact model-output parity is proven. No Cloud Docling or remote source-file upload is implied by S3 vector sharing; source-Vault sync itself is an independently authorized, separately credentialed S3 workflow under [ADR-0013](0013-cloudru-s3-vault-sync.md).

## Identities, keys and compatibility

- `LocalVaultId`: host-private trusted root fingerprint per ADR-0008, retaining file path/device/inode boundary and local scope enforcement.
- `PortableVaultId`: explicit stable identifier for the logical synchronized collection, never accepted as proof of local source equivalence or permission.
- `embeddingInputDigest`: SHA-256 over the **exact UTF-8 input** given to BGE-M3, including heading/context serialization. Compute only after the canonical chunk pipeline has produced the actual model input.
- `cacheKey`: domain-separated SHA-256 over a canonical length-delimited tuple `(artifactFormatVersion, embeddingSpaceId, embeddingInputDigest)`. Source-bound `ChunkId` and original `SourceLocator` are separate and cannot be replaced by the cache key. Identical inputs can reuse the same vector after file rename, but source identity and anchors must be rebuilt and verified locally.
- Verify vectors by strict schema/version, cache key, embedding space, type/length/dimension, finite values, L2 norm and SHA-256 integrity; enforce bounds before allocation and reject unknown or incompatible encoding. Provider/runtime parity requires test vectors and agreed tolerances before mixing embeddings.
- Import binds cached vectors to **locally** verified source hashes, scope, chunk input and provenance; user-visible `EvidenceHit` still needs current original evidence and location. Deleted, modified, renamed, inaccessible or excluded sources cannot produce stale results. A hybrid response requires independently ready, fresh lexical and dense legs and deterministic RRF.
- Local index publication occurs only after all referenced immutable objects in a complete generation are available and validated; atomic local commit with rollback. Out-of-order, conflicting, missing or truncated cloud-sync files must never activate partial generations. Cloud timestamps and sync status are not transactional commit evidence.

## Deployment

```text
Host A: authoritative synced Vault -> local extraction/chunking -> BGE-M3
        -> private local vector index -> opt-in export immutable embeddings/manifest
                                |
                 private Cloud.ru S3 embedding-cache bucket
                      (transport; not the working DB)
                                |
Host B: authoritative synced Vault -> local file/hash/chunk validation
        -> import compatible embeddings -> private local vector index
        -> compatible query encoder + lexical + RRF -> verified source evidence
```

Never synchronize a live SQLite database, WAL/SHM, active locks or host-private generation pointers. The Standalone lexical profile works offline and with sync disabled; requested dense/hybrid mode cannot silently downgrade on incomplete imports.

## Alternatives

| Alternative | Decision |
|---|---|
| Share live SQLite over sync folder | Rejected: concurrent writes, sidecar ordering, partial delivery and host-root binding. |
| Recompute all embeddings per computer | Rejected as default when exact inputs and profiles can be verified. |
| Always-on centralized Qdrant/pgvector or GPU service | Deferred: unnecessary infrastructure and privacy/availability costs for local-first use. |
| Portable native ANN index as authoritative artifact | Deferred until platform/backend portability evidence. |
| Immutable reusable vectors with local transactional indexes | **Selected** as target architecture. |

## Delivery and acceptance gates

**OKS-05C:** preserve the canonical source/chunk/evidence contract and deterministic encoding; do not expand scope to cloud transport.

**OKS-05D:** implement and validate local/offline BGE-M3 dense/hybrid, embedding-space identity and local index; benchmark SQLite/vector alternatives for 100k–750k vectors (disk/RSS/latency/freshness). No multi-device feature is required for MVP acceptance.

**OKS-06C (after OKS-05E):** separate bounded implementation of portable artifact format, opt-in Cloud.ru S3 (provider-neutral) export with objects-before-manifest commit, single-writer/multi-consumer import, synthetic host-to-host acceptance, recovery, data-leakage assessment and explicit user-facing diagnostics. No personal Vault scan, cloud upload, automatic model use or deployment is authorized by this document.

Acceptance scenarios: identical compatible inputs imported across distinct local roots without model execution; model/tokenizer/input/prefix/revision changes invalidate reuse; rename/delete/scope changes suppress stale evidence; partial, reordered, corrupted and malicious artifact delivery fails closed with rollback; offline/absent S3 endpoint does not break Standalone; query encoder availability is explicit; no text/credentials export by default; measurable initial/incremental transfer, disk, RSS, latency, vector precision and retrieval-quality regression. Multi-writer and encrypted sensitive-content mode require later separate gates.

## Consequences

Cache artifacts are disposable derived data, never authoritative source/evidence. Benchmarked vector-backend selection, encryption/authenticity, owner-controlled retention, cross-runtime vector parity and multi-writer protocol remain open. No runtime/code change or cloud setup is implied by this proposed ADR; independent review and merge are required before repository acceptance.
