# Architecture

Status: target API-first AI architecture under product-owner ADR-0015 rebaseline (repository review pending), preserving ADR-0006/0008 Standalone invariants. The Standalone native Markdown lexical core (PR #11) and UI/controller/navigation/settings/API integration (PR #12) are merged into develop. OKS-05 is the separate cumulative MVP acceptance stage; the Python reference retrieval remains experimental and is not an installed advanced profile.

## Logical components and deployment profiles

The **mandatory default** contains only Obsidian and the installed plugin:

```text
Obsidian authoritative Vault / Properties / MetadataCache / links
    -> plugin adapter, search UI and capability/status controller
    -> plugin-bundled native TS/JS search core (separate browser Web Worker for Markdown parsing)
        -> Markdown canonical extraction -> lexical derived index
        -> typed metadata/scope filter -> original-source evidence and navigation
    -> host-private Linux XDG-data versioned immutable index (ADR-0008, accepted)
```

No Python, Node installation, Ollama, Docling, Docker, separate server or manual model installation is required from the user. Obsidian desktop may expose Node/Electron APIs inside its process; these **do not** imply a separately installed interpreter. Avoid heavyweight work on the UI thread; validate worker APIs and cooperative bounded scheduling in an isolated Obsidian PoC. The OKS-04A TS plugin has a native lexical core that initializes after Obsidian layout readiness and does **not** require the legacy manually invoked Python synthetic probe. OKS-04B merged a public ItemView, commands/settings, versioned API and freshly verified source navigation over this same core; its feature merge is not a substitute for OKS-05 clean-install and MVP acceptance.

**Advanced extraction is optional**, preserving the existing opt-in verified local Docling/OCR worker path if needed. **AI search is API-provider driven**, with separately configured embedding, rerank and LLM roles; each API can be local or cloud-hosted. No local model weights or heavy runtime are mandatory for baseline search. A local API is offline-capable only when verified in a no-route environment; a cloud API requires network and scoped authorization. Disabling/losing either never disables Standalone. No implicit cloud egress, service discovery, runtime download or unconfigured listener.

Python-based extraction/chunking/SQLite/FTS5 and cgroup supervision already exist as bounded reference experiments. They remain candidates for the optional backend and retrieval benchmark in OKS-03A/B, not a mandatory plugin runtime. A future backend adapter converts through the **same** canonical source/chunk/evidence semantics, with an independently tested versioned wire contract; the prior `v1` fixture probe envelope is unaffected.

## API-first AI topology and index ownership

```text
Authoritative Obsidian Vault + Properties / links
  |-- Standalone offline text-occurrence + typed metadata / source navigation
  |     `-- one local, durable lexical/metadata generation (no API required)
  |
  `-- optional advanced extraction and canonical source/chunk pipeline
        `-- provider adapters (explicit opt-in, independently configured)
              |-- Embedding API: local service OR authorized cloud
              |     `-- one locally stored active model-bound dense generation
              |           `-- genuine hybrid fusion with local lexical leg (RRF)
              |-- Reranker API: local service OR authorized cloud (no vector index)
              `-- LLM/RAG API: local service OR authorized cloud (optional)
```

One active embedding model and dense index are permitted per Vault/profile. Store model/revision, dimensions, normalization, model-specific query/document instructions, tokenizer/serialization, provider adapter identity, source digests and generation version in the compatibility manifest. For model changes, rebuild fully into **temporary staging**, verify and atomically activate, then discard the prior dense generation; never mix model spaces or retain every candidate's index. Model/reranker/LLM selection is not coupled. The baseline typed Properties/occurrence index remains available during provisioning, timeout, rate limits, provider outage, migration or full AI disablement. Reconcile queued source changes when the AI endpoint becomes ready without stale-hit exposure.

API adapters require explicit endpoint allowlisting, TLS/authentication where applicable, secret storage, scoped classification-aware consent, minimal authorized excerpt disclosure, cancellation/deadline/retry/backoff, rate/cost limits, diagnostics redaction and typed provider errors. Local API does not imply permission to access every Vault source; cloud is disabled by default and never authorized merely by storing API credentials. Canonical source/evidence semantics are provider-neutral. Refer to [ADR-0015](adr/0015-api-first-ai-optional-dense.md), [evaluation plan](AI-PROVIDER-EVALUATION.md) and [security](../SECURITY.md).

## Data and contracts

- Source: vault-relative canonical path, hash, type, scope and metadata. Track rename/delete and changed hash.
- ParsedBlock: source identity, block type, text, order, heading hierarchy, page/table/row/cell provenance where available, extraction diagnostics.
- Chunk: deterministic ID derived from source version + ordered original spans + pipeline/profile version; exact original spans, contextual embedding text, real token count, locator and failure/coverage metadata.
- Index manifest: schema, parser/OCR/chunker/serialization/model/tokenizer/backend identity, source hashes, committed generation and readiness. Incompatible embedding spaces never mix. Source files are never modified by indexing.
- EvidenceHit: source reference, source hash, exact excerpt, original locator, rank, scores by leg, diagnostics; optional derived context explicitly distinguished from source evidence.
- Request/response: protocol version, request ID, bounded query/scope/filter/limit, cancellation and typed error; health, search, reconcile, pause/resume/cancel and status. Define JSON Schema and contract tests before freezing wire format.

## Readiness, algorithm identity and compatibility

An observable feature matrix distinguishes `lexical`, `dense`, and `hybrid` requests and executed modes; leg readiness and errors are not implicit. Standalone defaults to lexical. Hybrid is valid only when independently ready lexical and real dense legs both run and deterministic rank fusion completes against one compatible source/index generation. An unavailable dense leg returns a typed error, **not** a disguised lexical result. Readiness progresses through disabled/unavailable/provisioning/initializing/ready/degraded/failed; failed advanced provisioning does not invalidate the standalone index.

Use shared versioned, language-neutral contracts for source identity (vault-relative path/hash), extraction status, typed Properties and resolvable wiki-links, canonical blocks with original anchors, source slices and deterministic chunks, tokenizer/serialization identity, and evidence ranks/scores/diagnostics. Source-backed text is distinct from contextual embedding strings. For Markdown retain verifiable byte/line/character spans; binary formats use verified item/page/table/geometry anchors, never guessed file byte positions. Python structures in `engine/document.py` and `engine/chunking.py` are the current semantic reference. The [portable contract draft](../contracts/portable-model.md) records common semantics; a separate production schema/parity fixture gate precedes JS runtime adaptation; do not create a second incompatible evidence model.

Standalone index persistence must be local, vault-isolated, transactional/recoverable and safe on reinstall/uninstall; candidate IndexedDB or plugin-managed bounded storage requires crash/quota/Obsidian lifecycle proof. Existing Python SQLite transactions prove only its optional backend path. Publish generation+source hashes atomically or prove equivalent visibility; verify current source before showing hits and suppress stale/deleted/renamed evidence, even between event processing and reconciliation. ADR-0008 accepts a plugin-managed Linux XDG application-data index outside the Vault: immutable generation blobs, atomic fsync+rename publication, previous-generation rollback, versioned identity and runtime source verification. ADR-0008 acceptance is tied to the independently reviewed and merged PR #11 (`a8ad950…`), not a general-purpose storage/release approval.

## Technology candidates

Docling native document hierarchy and HybridChunker for PDF/DOCX; lightweight Markdown parser with Obsidian-compatible boundaries; explicitly provisioned Russian/English OCR. Compare actual **local or cloud embedding APIs** with explicit provider/model IDs, tokenizer/instruction identity and no silent truncation. BGE-M3 remains the historical local experiment baseline; Qwen3-Embedding-0.6B and Giga-Embeddings candidates require controlled RU/EN benchmarks and live API availability checks. Sparse/multi-vector only if justified. SQLite FTS5 with Russian exact-ID/tokenization tests is a **Python backend** lexical candidate; plugin-native lexical index now has a bounded Unicode/identifier tokenizer, original-block retrieval and host-private storage prototype tested against frozen corpus v1; the exact algorithm is deliberately not Python FTS5 BM25. Compare embedded vector backends (e.g. exact NumPy baseline, sqlite-vec or embedded ANN) before committing. Do not copy a server-dependent storage stack. RRF remains the initial hybrid fusion strategy. Compare optional Qwen3-Reranker-0.6B and BGE-reranker-v2-m3 through independently configured API adapters; there is no accepted production winner until a controlled benchmark.

## Operational and trust boundaries

Desktop-only first. Standalone native search owns its local processing and index, with no child process or listener requirement. The existing child-process stdio proof pertains to an optional Python backend only; authenticate any optional loopback API and require explicit user enablement. Bundled advanced workers need plugin-controlled lifecycle, permissions, verified artifacts and no manual dependency installation. No open network listener or outbound AI connection by default. Cloud AI requires explicit classification-aware opt-in, credentials distinct from S3 keys, endpoint restrictions and approval of data processing; existing opt-in local stdio is not a cloud transport. No auto-download or shell execution on untrusted document input. Redact diagnostics by default. Restrict file access to scoped roots; validate paths and symlinks in both layers. Do not include confidential content in development artifacts.

Bound queue, use a single heavy job at a time initially, enforce process-level limits and monitor memory/disk, stop or pause on pressure, keep search responsive. Avoid simultaneous full parser/embedding/reranker residency when possible. Persist transactional checkpoints, stage generation before activation, cancel safely and reconcile on startup. No source files removed on uninstall or rebuild. On errors keep last consistent index with explicit staleness or suppress affected hits.

## First vertical and experiment ordering

Use the bounded synthetic evidence probe in ADR-0002 and the OKS-01A execution contract to validate the plugin/process boundary without an index or ML dependency. Prototype single-shot stdio first; measure production IPC independently in OKS-01B. Before arbitrary-source processing, validate stronger filesystem and resource controls. Adopt native parser structure through an independent canonical mapping rather than reconstructing all hierarchy from flattened Markdown. Separate the candidate tokenizer-only validation/provisioning gate from full embedding runtime validation; count the exact contextualized input, including special tokens, and never infer compatibility from vector dimension alone. No prior application code or runtime dependency is required.

## New Vault storage and synchronized replicas (proposed ADR-0013)

The legacy Yandex **Cloud Object Storage S3** sync became unavailable from the corporate workstation. A **new** Vault is undergoing selective migration from this historical archive. Select **Cloud.ru Evolution Object Storage S3** for new-Vault synchronization, subject to corporate network/data-policy authorization and synthetic multi-device/client tests. Keep local working Vaults on each participating device, use only one tested S3-compatible sync mechanism, and never treat S3 as a live POSIX filesystem. If subsequently authorized, a separately permissioned S3 bucket will transport immutable portable embedding artifacts; Docling cache, working SQLite and full search indexes remain local. Same Cloud.ru billing as Foundation Models does not imply shared credentials. Retain independent backup and historical Yandex data until reconciled and recoverable. See [ADR-0013](adr/0013-cloudru-s3-vault-sync.md).

## Local document ingestion and derived caches (proposed ADR-0011)

Advanced PDF/DOCX and RU/EN OCR extraction is **local Docling/Tesseract only**. Cloud Docling, Docling Serve deployments, remote OCR, and implicit cloud parsing fallback are excluded. A future optional cache will retain parsed native structure and locators in a host-private, versioned `ParsedDocument` extraction cache, keyed by actual source bytes and exact extractor/layout/OCR configuration and artifacts. A compatible cache hit avoids rerunning Docling after re-chunking, re-embedding, index repair/rebuild, restart or rename; current source hashes/scope and locators must still be verified. The extraction cache contains source text: **never** export it to any synced folder or cloud by default.

The independent processing layers are:

```text
authoritative Vault -> local Docling/OCR -> private extraction cache (ParsedDocument)
    -> structural chunking / contextual serialization
    -> BGE-M3 document embedding cache (local, optionally portable)
    -> host-private lexical + vector index -> verified EvidenceHits
```

Each stage has a separate versioned identity, invalidation, quotas, checkpoint/recovery and truthful partial/failure semantics. Rebuilding downstream artifacts must not invalidate compatible upstream extraction. Full acceptance is a separate post-MVP OKS-06D slice, not an expansion of in-flight OKS-05C review; see [ADR-0011](adr/0011-local-docling-extraction-cache.md).

## Optional Cloud.ru BGE-M3 computation (proposed ADR-0012)

`Cloud.ru Evolution Foundation Models` with API model identifier `BAAI/bge-m3` is the proposed **optional** paid embedding-provider candidate; a single synthetic Linux smoke returned HTTP 200, 1024 finite L2-normalized dimensions and 19 billed input tokens, but **local/cloud model-output parity remains unproven**. Only explicitly consented contextual chunk text may cross the TLS boundary; never raw source files, full parsed artifacts or local database files. Treat cloud and local embeddings as incompatible distinct `embeddingSpaceId` profiles until exact fixed-corpus parity/revision checks succeed. Keep source ingestion/Docling/OCR, embedding cache, indexes and retrieval local. Explicit per-Vault scope consent, private credential storage, token/budget hard stops, bounded requests/retries and failure diagnostics are mandatory; no outbound connection is enabled by default. Cloud failure cannot break standalone or offline local Advanced. This optional B-Dense candidate follows the API-first 05P contract and conditional 06E validation; it is never a mandatory Gate A requirement; see [ADR-0012](adr/0012-optional-cloudru-bge-m3-provider.md).

## Post-MVP portable Advanced embedding reuse (proposed ADR-0010)

The first portable-embedding pilot is pinned `BAAI/bge-m3` with 1024-dimensional L2-normalized vectors; ADR-0015 does not mandate this model for any optional API provider. Exact model/tokenizer revision, contextual input serialization and output compatibility must be verified. SQLite is the local Advanced metadata/persistence candidate; `sqlite-vec` is an initial vector backend candidate subject to measured alternatives, not a final production selection. This does not alter the plugin-native Standalone index or its no-extra-dependencies offline default.

An optional future portable cache exports/imports **immutable, content-addressed model/provider-compatible document vectors** via private Cloud.ru S3, separately authorized and segregated from the new-Vault synchronization bucket, never a live shared SQLite/WAL database. Every host builds its own private vector index and validates original source bytes, scope, current source hashes, chunk identities and evidence locators. Shared `PortableVaultId` identifies the logical collection but does not supersede host-private `LocalVaultId` and ADR-0008 root authentication. Partial and out-of-order delivery cannot publish a local generation. Opt-in export is disabled by default; embeddings and hashes are potentially sensitive. A compatible query encoder is still required per host for new dense searches. Delivery is separately gated as optional OKS-06C after MVP; see [ADR-0010](adr/0010-portable-bge-m3-embedding-cache.md).

## Open decisions

Provider API/adapter schemas, access controls, credential storage, cloud data classification, real model availability and benchmarking, multi-OS compatibility, parser/model licenses, advanced packaging and product resource budgets still require prototypes. The old mandatory offline-model Advanced MVP gate is superseded by ADR-0015; ongoing OKS-05D local BGE implementation is not automatically a new release gate. OKS-04A implements a measured Linux Markdown-only lexical prototype with a real bundled browser Web Worker, cooperative generation writer, and disposable Obsidian CLI smoke; the candidate 04B UI builds on that core, while hard worker-memory sandbox and full-capacity guarantees are not claimed. Obsidian policy requires a valid manifest and minimum app version, and desktop-only declaration for Node/Electron; community release packages distribute main.js/manifest.json (and optional styles.css); the installed OKS-04A bundle also requires its bundled standalone-worker.js, and reproducible release-shaped packaging with real clean-install proof is evaluated in OKS-05A (not a public release). These facts do not authorize bundling heavyweight runtimes. See ADR-0006. Linux is the first target. Public community distribution and cross-platform support need separate policy and packaging gates. See ADRs and roadmap.


## Resource and freshness proof obligations

Evaluate enforceable Linux process-tree resource controls (for example delegated cgroup v2) before arbitrary-source or ML workloads. Admission must cover startup peak, descendants, free memory/disk, CPU thread count and cancellation; fail safely if required isolation is unavailable. Keep the UI responsive and prioritize search between bounded background work units. Publish lexical/dense records and manifest as one visible generation, or prove an equivalent atomic commit protocol; on mutation or uncertain freshness, suppress affected hits rather than presenting old evidence as current. Keep typed Properties and resolvable wiki-link metadata in the derived source record; defer graph traversal to a measured optional stage.

## OKS-04B adapter boundaries

`main.ts` owns host events and lifecycle. `search/view.ts` and `search/settings-tab.ts` use public Obsidian APIs; `search/controller.ts` owns bounded/latest-request scheduling, revocation and API v1 validation; `search/settings.ts` and `search/status.ts` validate small settings and sanitize diagnostics; queued field patches prevent lost UI settings updates. `search/navigation.ts` validates fresh raw source bytes and locators, while `search/obsidian-navigation.ts` binds exact TFile identity and public openFile/editor selection. No second parser, ranking algorithm, index, backend or runtime dependency is added. Source events revoke UI and navigation requests before engine reconciliation. Reload waits for the previous writer; unload immediately terminates its worker. See [API/lifecycle contract](standalone-api.md) and [04B validation limits](../benchmarks/standalone/04b-validation.md).

## OKS-05B opt-in execution candidate (not independently accepted)

A bounded `local-stdio` health-only transport prototype is prepared behind **explicit schema-v3 opt-in**, using the previous Python v2 health-only experiment and a TS lifecycle bridge. It remains separate from the standalone lexical controller, storage and default package (ADR-0009). Transport readiness is not algorithm readiness; no model, document or source evidence moves through v2. Historically, 05B required follow-up canonical source/evidence integration; 05C has since merged its versioned source/evidence protocol and advanced extraction. In-flight 05D local BGE/cgroup retrieval is an optional experiment, not a mandatory API-first or Gate A prerequisite. API-provider integration and its conditional acceptance are tracked separately in 05P. Do not treat the 05B health probe as retrieval readiness or production Advanced acceptance.
