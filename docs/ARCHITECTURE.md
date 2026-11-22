# Architecture

Status: initial design. Concrete libraries, packaging and thresholds are gated by OKS-01/02 experiments.

## Logical components

Obsidian (authoritative files, links and Properties)
  -> TypeScript vault adapter / UI / commands
  -> versioned local IPC contract
  -> isolated Python worker runtime
     -> parse / OCR -> canonical source blocks -> chunk planning / token validation
     -> local embeddings -> transactional derived index
     -> lexical + dense retrieval -> rank fusion -> evidence / context expansion
     -> optional rerank (post-MVP)
  -> ranked evidence / diagnostics -> Obsidian or authorized local client.

The plugin owns the user experience, scope, change-event reconciliation and runtime management. The engine owns parsing, indexing, search and resource arbitration. The contract carries opaque source IDs and scoped path references, never arbitrary execution requests. No service dependency on any other product. No required server database or external orchestrator.

## Data and contracts

- Source: vault-relative canonical path, hash, type, scope and metadata. Track rename/delete and changed hash.
- ParsedBlock: source identity, block type, text, order, heading hierarchy, page/table/row/cell provenance where available, extraction diagnostics.
- Chunk: deterministic ID derived from source version + ordered original spans + pipeline/profile version; exact original spans, contextual embedding text, real token count, locator and failure/coverage metadata.
- Index manifest: schema, parser/OCR/chunker/serialization/model/tokenizer/backend identity, source hashes, committed generation and readiness. Incompatible embedding spaces never mix. Source files are never modified by indexing.
- EvidenceHit: source reference, source hash, exact excerpt, original locator, rank, scores by leg, diagnostics; optional derived context explicitly distinguished from source evidence.
- Request/response: protocol version, request ID, bounded query/scope/filter/limit, cancellation and typed error; health, search, reconcile, pause/resume/cancel and status. Define JSON Schema and contract tests before freezing wire format.

## Technology candidates

Docling native document hierarchy and HybridChunker for PDF/DOCX; lightweight Markdown parser with Obsidian-compatible boundaries; explicitly provisioned Russian/English OCR. Compare native model runtime with existing local embedding runtime candidates, with tokenizer identity and no silent truncation. BGE-M3 dense first; sparse/multi-vector only if justified. SQLite FTS5 with Russian exact-ID/tokenization tests is a lexical candidate. Compare embedded vector backends (e.g. exact NumPy baseline, sqlite-vec or embedded ANN) before committing. Do not copy a server-dependent storage stack. RRF is the initial fusion strategy. Optional BGE-reranker-v2-m3 conditioned on latency and evidence gain.

## Operational and trust boundaries

Desktop-only first. Evaluate child process over stdio or authenticated loopback; stdio preferred if lifecycle/streaming tests pass. No open network listener by default. Model/parser runtime is an implementation dependency supervised by the plugin, not a separately administered knowledge system. Explicit installation/verification and version pinning; no auto-download or shell execution on untrusted document input. Redact diagnostics by default. Restrict file access to scoped roots; validate paths and symlinks in both layers. Do not include confidential content in development artifacts.

Bound queue, use a single heavy job at a time initially, enforce process-level limits and monitor memory/disk, stop or pause on pressure, keep search responsive. Avoid simultaneous full parser/embedding/reranker residency when possible. Persist transactional checkpoints, stage generation before activation, cancel safely and reconcile on startup. No source files removed on uninstall or rebuild. On errors keep last consistent index with explicit staleness or suppress affected hits.

## Open decisions

Exact parser/runtime versions and licenses, tokenizer integration, OCR fallback, index backend, IPC/packaging, resource budgets and Obsidian CLI access require prototypes. Linux is the first target. Public community distribution and cross-platform support need separate policy and packaging gates. See ADRs and roadmap.
