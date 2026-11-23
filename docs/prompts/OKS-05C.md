# OKS-05C — Canonical source/evidence wire and opt-in document ingestion

**Delivery:** one bounded slice, Draft PR to `develop`; review in a separate non-author session. **Pinned base:** `f94f65809669d648df674c8a66272942d7cb952b` (merged OKS-05B PR #14). No aggregated phase exception.

## Authority and traceability

Apply AGENTS.md, SECURITY.md, docs/SPEC.md (CAP-02/03/06/07/08/09/10 and AC-02/03/06/07/08/09/10), docs/ARCHITECTURE.md, docs/ROADMAP.md (OKS-05C), docs/development/SDD.md, docs/DEPENDENCIES.md, docs/REUSE.md, contracts/portable-model.md and ADR-0001–0009. In particular, ADR-0006 mandates default native Standalone, ADR-0008 owns its immutable index, and ADR-0009 limits health-only v2 to health. Build a separate versioned production document wire, not a v2 extension.

## Scope

1. Freeze schema/codec contract for request IDs, deadlines, source identity/version, structured blocks, native and Markdown source locators, typed metadata, source slices, chunks, extraction status and diagnostics, compatibility identity, and future evidence hits. Reject unknown/duplicate/protocol-invalid frames, BOM, invalid UTF-8, oversize and fabricated locators; independently assert TS/Python conformance against common synthetic fixtures.
2. Implement optional **manual-only** Advanced ingestion of authorized vault-local Markdown, text PDF, DOCX and scanned PDF with offline RU/EN OCR using existing bounded Python extraction and structural token-budget planner. No arbitrary raw document path from an untrusted query may select an external source. Reject unsafely scoped sources, symlinks, changed content, profile mismatch and incomplete evidence. Retain source original text and distinct contextual text, explicit missing native locators and table-cell provenance.
3. Run extraction in a verified local Linux cgroup v2 unit with enforced bounded memory/CPU/pids/swap, no-network address family, deadline and whole-tree stop on cancellation/unload/reload. Refuse when isolation, artifacts, reserve or limits cannot be verified. Strict opt-in; no automatic indexing and no private content in diagnostics or logs.
4. Bind admitted results to a file hash and root identity. An incomplete/failed source is never labeled fully ready. Publish a derived generation atomically to a private local namespace only after a second source hash check. Preserve Standalone state and native lexical API. Dense and hybrid stay `CAPABILITY_UNAVAILABLE`/`executedMode:none`.
5. Supply real-host offline Obsidian Desktop 1.15.1 acceptance in disposable isolated profile, plus adversarial, cancellation, failure/recovery, schema and resource tests; record actual observations. No production Vault, external provider or automatic model/parser asset download.

**Exclusions:** no new model-backed embeddings, dense/hybrid, RRF, network listener, unattended vault crawl, production Vault writes, global release, main branch mutation or self-approval. Those gates belong to OKS-05D/05E.

## Measurable acceptance

- Exact original UTF-8 span and Unicode scalar offsets for Markdown, explicit native item/page/geometry anchors for PDF, explicit DOCX structural anchors (no PDF/DOCX byte offsets), cell-specific provenance and diagnosed unlocated/partially extracted content.
- Typed Properties retain JSON scalar/list types; unsupported frontmatter is `partial`, not stringified. Original excerpts and contextualized embedding text are distinct and version-bound.
- Request/response UTF-8 canonical frame parity and at least negative coverage for duplicate fields, wrong protocol/version, oversized and invalid bytes, forged request ID, invalid schema, status mismatch and coordinate spoof.
- Cgroup limits verified by **the worker itself before parser imports or source reads**, and by local host tests. No-route/no-AF_INET proof; bounded subprocess and whole-process-tree cleanup. Any missing necessary control refuses heavy extraction.
- Modified or deleted source before commit or source open denies visibility; failed/incomplete publications never appear as ready. Cold restart cannot adopt corrupt generation.
- `npm test`, `npm run test:python`, `npm run typecheck`, `npm run build`, `npm run licenses`, `npm run test:package`, `npm run benchmark:standalone`, `git diff --check`, real host Standalone and Advanced offline tests must be executed and results attached to PR (failed gates called out, not faked).
- Before merge: separate-session independent review of full pinned diff at exact HEAD and exact-HEAD CI; leave Draft if absent.
