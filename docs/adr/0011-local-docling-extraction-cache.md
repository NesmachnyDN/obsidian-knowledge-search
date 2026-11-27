# ADR-0011 — Local Docling extraction and versioned ParsedDocument cache

**Status:** Proposed (maintainer-selected target, 2026-11-23; independent review/merge pending).
**Scope:** local Advanced extraction, incremental reuse and persistence; standalone and original Vault files are unchanged.
**Related:** ADR-0004 (measured local native extraction profiles), ADR-0006 (offline execution profiles), ADR-0008 (host-private derived data), ADR-0010 (separate portable embedding cache), CAP-02/03/08/09/13.

## Context

Large personal Vaults contain Markdown, DOCX, text PDFs and scanned documents. Parsing/OCR may dominate the initial ingestion cost, even when embeddings are inexpensive. Rebuilding chunks, changing embedding providers, rebuilding vector indexes, restarting Obsidian or moving between embedding profiles must not force unchanged PDF/DOCX pages through Docling and OCR again.

Existing OKS-02B synthetic Linux experiments with pinned local Docling Heron/TableFormer and Tesseract English/Russian assets demonstrated structured-PDF extraction and OCR with explicitly partial provenance where needed; small synthetic examples took roughly 10–11 seconds for the measured full conversion and about 0.8 GiB charged peak memory. These are experiment results, **not** production-Vault throughput/SLA or permission for bulk ingestion.

## Decisions

1. **Docling stays local.** For all supported Advanced PDF/DOCX structural extraction, run the reviewed, explicitly provisioned Docling runtime **on the user's Linux host**, plus local English/Russian OCR. Use no cloud Docling/Docling Serve, managed OCR, remote Docling VM, auto-provisioned cloud fallback or automatic transmission of document binaries. Local parsing does not require internet access. Keep the default standalone Markdown lexical engine free of Docling/Python.
2. **Independent extraction cache is required.** Persist canonical extracted `ParsedDocument` / `ParsedBlock` content, original-page/table/row/cell locators, source version, explicit `ok/partial/empty/failed` diagnostics and provenance in a **private host-local derived cache** outside the Vault. Do not store only flattened Markdown and then invent native structure. The extraction cache is separate from (a) chunk planning/cache, (b) BGE-M3 vector cache and (c) lexical/ANN index. Updating chunk policy, serialization, embeddings, retrieval settings or a vector backend must reuse validated parse results without repeating Docling.
3. **Content and extraction-profile identity.** Compute `sourceByteDigest = SHA256(original file bytes)` independently from the extraction cache key. Build `extractionProfileId` from an unambiguous canonical, versioned manifest containing Docling/parser revision, layout/table/OCR model artifact identities, language/tessdata assets and settings, pipeline/extraction options, normalized output schema and semantic mapping version. `extractionCacheKey = SHA256(domain || sourceByteDigest || extractionProfileId)` with domain separation and unambiguous length-delimited serialization. Never assume a same-named extractor is compatible. No dependence on a host-specific absolute path for content reuse; authorizations and file-scoped locators are revalidated separately.
4. **Freshness and provenance.** Cache hits must first verify current trusted local source bytes/hash and scope; validate cached schema, object SHA-256, completeness and source/profile identity. Rebind cached native locators to the current local source version; renames may reuse identical extraction if the underlying bytes/profile match, but never reuse stale `sourceId` or unsupported anchors. Every `EvidenceHit` still checks the current source and original location before display. A stale, missing, unauthorized or incompatible cache cannot produce apparently fresh evidence.
5. **Transactional write and bounded cache.** Write immutable result objects to private staging and fsync; atomically publish a manifest/pointer only after all objects are durable and authenticated. Recover the last consistent generation after crash/cancel; no partial publication. Keep original files untouched. Limit object size, active jobs, concurrent streams, disk usage and retention. Safe garbage collection must only remove known derived artifacts, never original source data or files belonging to other profile/host. Provide observability: hit/miss, parse/OCR errors, partial coverage, bytes, time, disk use and reasons for invalidation; do not log document text.
6. **Failure semantics.** Cache successful `ok`, `partial` and `empty` outcomes with explicit versioned diagnostics if independently validated; never relabel a partial document as complete. A transient parse failure may have bounded retry metadata but must not be served as a successful cached document. On resource pressure or missing models: pause/fail explicitly, retain the last good parsed/index generation and avoid a silent model-free fallback.
7. **Privacy and portability.** Parsed documents **contain source text**, even when not original binary bytes. Keep them local and permission-restricted; do not place the extraction cache in the synced Vault or any cloud-backed folder or include it in ADR-0010's vector-only export. Portable parsed-cache sharing is **not selected**; it would require separate consent, authentication/encryption and source-authorization analysis before a future decision.

## Dataflow and invalidation

```text
authoritative local PDF/DOCX/scan (verify hash + scope)
    -> lookup [sourceByteDigest, extractionProfileId]
       -> valid hit: canonical ParsedDocument + source locators
       -> miss: local Docling / local OCR -> validate -> atomic cache commit
    -> structural chunking (separate profile / cache)
    -> compatible BGE-M3 embeddings (separate cache)
    -> local lexical/dense index (separate transactional generation)
```

Invalidation must be layered: a source byte change invalidates source extraction; a layout/OCR/model/profile change invalidates affected extraction objects; a chunking/embedding profile change does **not** invalidate a still-compatible extracted document. Repeated imports/renames with byte-identical content can reuse extraction only after source and scope reconciliation. Startup reconciliation catches missed file events.

## Alternatives

| Alternative | Decision |
|---|---|
| Re-run Docling whenever the index is rebuilt | Rejected (slow, redundant and wasteful). |
| Upload documents to a remote service or run Docling on cloud GPU/VM | **Rejected for target OKS** (privacy/operations and no demonstrated need). |
| Store derived extraction as Markdown-only chunks | Rejected (loses native provenance and tables). |
| Store extraction output in a sync folder by default | Rejected (contains potentially confidential source text). |
| Local versioned parsed-document cache and independent downstream caches | **Selected**. |

## Implementation slice and acceptance

**OKS-05C** is already an in-flight review candidate (PR #16); do **not** expand its scope or claim a cache has been implemented. Protect current canonical extraction contracts. **OKS-06D, after independent Gate A acceptance in OKS-05E**, is the bounded slice for the persistent local extraction cache and incremental reuse before any bulk real-Vault indexing decision.

Synthetic acceptance gates:
- Identical bytes and extraction profile cause zero Docling/OCR runs on second ingest and after index rebuild, even with changed chunking/vector backend; changed bytes or extraction settings require a new parse.
- Parsed native PDF page, geometry, DOCX item, table row/cell anchors, diagnostics and `partial/empty` survive serialization, recovery and rename with verified current local source identity.
- Fault injections: torn artifact, malicious metadata/path, truncated/oversize cache, crash/cancel during commit, missing local model, disk full, pressure; no partial publish and no accidental source deletion.
- Explicit cache quota, pruning and restart support; constrained memory/disk workload on 16 GiB Linux hardware without UI blocking or implicit downloads.
- Zero external network access in extraction tests; zero private source content in logs, public fixtures or cloud locations; standalone still works with cache disabled.
- Measure cache hit/miss, original vs cached ingestion latency, CPU/RSS/disk, OCR quality and retrieval evidence on frozen synthetic document sets. Do not claim production-scale performance without separately authorized sampling.

This is a **design decision, not implemented behavior or permission to process a production Vault**.

## Prospective extension (ADR-0017; review pending)

Generalize the same private cache contract to every reviewed local extraction adapter and source format, including its exact implementation/revision, detection/format options, assets, normalization and provenance mapping. Docling remains the structural candidate, not an exclusive extractor for every format. Host-local-only storage, source freshness, independent invalidation and transactional safety remain unchanged. See [ADR-0017](0017-extensible-multiformat-extraction.md).
