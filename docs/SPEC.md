# Product specification

Status: product-owner API-first AI rebaseline (ADR-0015, 2026-11-23); documentation review pending. Historical experimental acceptance and numeric budgets are not product release claims.

## Purpose and non-goals

Deliver accurate, inspectable, local retrieval over Obsidian vaults. The original files and note metadata are authoritative. OKS supplies evidence to users or authorized AI consumers; it does not make authoritative compliance decisions or require an LLM. No replacement vault, separate knowledge metamodel, multi-user platform, mandatory cloud inference, mandatory local AI runtime, mandatory generator, or dependency on a prior application. Cloud inference is optional, explicitly approved and disabled by default. First target: desktop Linux, 16 GiB-class CPU workstation.

## Execution profiles and acceptance partition

**Mandatory autonomous baseline:** Obsidian + OKS plugin alone must provide offline text-occurrence search and typed Properties/metadata filtering (including supported tags and wiki-link metadata), with safe source navigation, freshness, index durability and lifecycle. No separate Python/AI runtime, embedding model, LLM, network, API key, vector index or provider is required. Confirm actual literal occurrence/phrase behavior separately from existing tokenized lexical ranking; do not assert equivalence without tests.

**Optional connected AI profile:** dense semantic search, hybrid lexical+dense fusion, reranking and LLM/RAG are independently enabled by configured API providers. An explicitly configured local API can operate without Internet when the model service is independently verified offline; a cloud API works only with connectivity and approved data egress. A selected API can supply embeddings, reranking and/or LLM independently. Cloud requests are disabled by default and forbidden for unapproved source classifications. Original local evidence and typed Properties remain authoritative; no cloud-hosted Vault or vector store is required.

**Optional advanced extraction:** reviewed PDF/DOCX/OCR processing can be local and opt-in and may feed approved AI retrieval, but is not mandatory for standalone Markdown search. Retain canonical source/evidence contracts and report unsupported/partial formats truthfully.

| Capability / gate | Autonomous base (mandatory) | Optional AI API profile | Optional advanced extraction |
|---|---|---|---|
| Offline text occurrences, typed Properties/links/tags, source freshness, navigation | **Required** without any AI API | Preserved even when API fails | Preserved |
| PDF/DOCX and RU/EN OCR | Not required for basic Markdown MVP | Can consume approved extracted text | Separate supported-format proof |
| CAP-04 dense embeddings | Explicitly unavailable if API/index not ready | Real model-backed query and document embeddings; local compatible dense index | Not an extraction claim |
| CAP-05 hybrid/RRF | Not required for basic MVP | Only when lexical and dense legs genuinely execute | Not an extraction claim |
| Rerank / LLM generation | Not required | Optional independent API roles and gates | No generator prerequisite |
| Lifecycle, privacy, provenance and resource safety | **Always required** | **Always required**, including egress authorization | **Always required** |

**Release gates (additive and feature-scoped):** Gate A is mandatory for every MVP: autonomous offline basic search and the **baseline-only** obligations of CAP-01/06/07/08/09/10 (including local safety, lifecycle, durability, source freshness, navigation, and privacy). Gate A requires **no** AI provider configuration, API connection, credentials, embeddings, dense index, model provisioning, or permission for cloud egress. Gate B is conditional on **each AI capability actually claimed**, not on enabling all AI roles together; Gate C is conditional on **each advanced document format actually claimed**. Basic-only MVP acceptance requires Gate A alone, with unimplemented optional features explicitly unavailable. Combined profiles must meet the union of applicable gates.

| Conditional gate | Trigger (claimed capability) | Required evidence / CAP/AC | Not a prerequisite |
|---|---|---|---|
| B-Dense | API-backed embedding/dense retrieval | CAP-04: real provider document/query embeddings, compatible single active local index, model/version/serialization checks, source freshness, independently observed provider failures and egress controls | Hybrid fusion, reranker or LLM |
| B-Hybrid | Hybrid lexical + dense retrieval | B-Dense **and** CAP-05: independently executed lexical/dense legs, compatible candidate generations, deterministic RRF, truthful per-leg status and failure propagation | Reranker or LLM |
| B-Rerank | API reranking of any supported lexical/dense/hybrid candidate set | Relevant CAP-11: actual configured reranker API, bounded source-authorized candidates, measured ranking effect/latency/cost, error states and no fabricated evidence | Dense/hybrid if only lexical candidates are reranked; LLM; separate vector index |
| B-Generation | API LLM/RAG synthesis over source-backed evidence | Relevant CAP-11: actual configured generation API, versioned scoped EvidenceHits (lexical evidence suffices), verified citations, safe disclosure, latency/cost controls and truthful errors | Dense/hybrid or reranker unless explicitly claimed |
| C-Format | Each claimed PDF/DOCX/OCR format | Relevant CAP-02/03: real extraction/structure/native provenance and format-specific partial/failure handling | Any AI provider or dense retrieval |

Each claimed B role requires its own endpoint/authentication, authorization, privacy, provider-outage and bounded-runtime checks; choosing one role never implicitly activates another. A requested dense/hybrid mode must never silently return basic results as successful AI search; an explicit labeled basic retry remains available. Historical OKS-03A/B and original OKS-05D local BGE experiments remain valid evidence but do not establish provider-API acceptance or a mandatory product configuration.

See [ADR-0015](adr/0015-api-first-ai-optional-dense.md) for the controlling product-owner revision, [ADR-0006](adr/0006-standalone-execution-profiles.md) for the preserved Standalone foundation, and the [provider evaluation plan](AI-PROVIDER-EVALUATION.md).

## Capabilities and acceptance criteria

| ID | Capability | Acceptance |
|---|---|---|
| CAP-01 | Vault scope and lifecycle | AC-01: initial scan plus create/modify/rename/delete reconciliation; configured scope, ignored folders and supported types; no access outside allowed roots including symlink/traversal tests. Deleted or superseded source evidence cannot be returned as current. |
| CAP-02 | Document extraction | AC-02: Markdown, text PDF and DOCX on test corpus; local Russian/English OCR on a scanned PDF fixture; preserve headings, clauses, lists and table semantics with source locators. Report empty, unsupported or failed sources; no silent exclusions. XLSX/PPTX and legacy DOC tracked separately. |
| CAP-03 | Structural chunking | AC-03: hierarchical boundaries, model-token budget including contextual prefix, deterministic identity, verifiable coverage; no silent truncation, lost source spans or cross-section mixing. Handle oversized atomic elements explicitly. Compare current-style windows with structure-aware alternatives under identical parsing. |
| CAP-04 | Optional API-backed embedding and dense search | AC-04: selected local/cloud embedding API is explicitly configured and authorized, actual model/tokenizer/instruction/normalization and vector dimension/version checked, a single active locally stored compatible dense index maintained per Vault, complete reindex and atomic switch on model change, typed failures on API/index outage. Offline model inference is not required; local API offline capability must be verified if claimed. |
| CAP-05 | Optional hybrid retrieval | AC-05: real lexical + model-backed dense candidates and deterministic RRF only when both legs run, exact IDs, typed Properties/scope filters and provenance, per-leg diagnostics and controlled provider errors. No mislabeled hybrid result or hidden basic fallback; standalone basic remains separately searchable during provider outages. |
| CAP-06 | Evidence and context | AC-06: stable file reference, source hash, page/heading/clause/table-row where available, excerpt and scores; original vs contextualized text distinguished; missing provenance explicit. Context expansion respects source version, scope and bounded budgets. Negative queries do not fabricate evidence. |
| CAP-07 | Plugin integration | AC-07: **Mandatory Gate A:** offline basic text-occurrence/Properties search, settings, status, source open, pause/resume/cancel/rebuild, sanitized diagnostics, versioned local machine-readable API and tested Obsidian CLI compatibility; unconfigured optional AI roles are explicitly unavailable, not prerequisites. **Conditional Gate B, per claimed role only:** independent embedding/reranker/LLM provider configuration, disabled-by-default cloud egress, scoped consent, authentication, provider readiness, requested/executed mode visibility and typed failures. No embedding/reranker/LLM settings, credentials, endpoints or provider connectivity are required to pass Gate A. |
| CAP-08 | Durability | AC-08: atomic publication of consistent index versions, idempotent incremental updates, restart/resume and crash recovery; reconcile after missed events. Cache deletion never deletes source files. |
| CAP-09 | Local resource control | AC-09: bounded queue and concurrency, CPU/memory/disk guardrails, cancellation and workload prioritization. Model workloads outside UI. Explicit provisioning; no automatic heavyweight downloads. Resource exhaustion is observable and recoverable. |
| CAP-10 | Quality and confidentiality | AC-10: reproducible labeled corpus and per-query baselines; no source escapes, unexplained truncation, evidence fabrication, unauthorized cloud transfer or credential leakage. Basic offline and optional AI/provider acceptance evaluated separately; no model superiority claim without controlled RU/EN trials. |
| CAP-11 | Optional reranking and context generation | AC-11: independent configurable reranker API and optional LLM/RAG API, limited approved excerpts/candidates, source-grounded context expansion and citations, controlled measured retrieval gain, latency/cost/failure/egress safeguards. No graph DB or persistent reranker vector index required. |
| CAP-12 | Optional portable embedding reuse | AC-12: securely import/export compatible immutable document embedding artifacts between separately authenticated local Vault indexes, bound to a verified embedding space, model/provider, exact input digest, source/scope and complete atomic generation. No mandatory cloud and no concurrent SQLite sharing. Applies only where dense is claimed; [ADR-0010](adr/0010-portable-bge-m3-embedding-cache.md). |
| CAP-13 | Optional local structured extraction cache | AC-13: local-only, private, source-byte and exact Docling/OCR-profile keyed ParsedDocument cache retaining authentic locators and truthful partial/empty/failure states. Reuse unchanged extraction independently of embedding/index changes; crash-safe bounds and no default sync of extracted text. Applies only to the claimed format; [ADR-0011](adr/0011-local-docling-extraction-cache.md). |
| CAP-14 | Optional Cloud.ru BGE-M3 embedding API | AC-14: opt-in Cloud.ru dense-provider candidate under Gate B-Dense, with source classification/consent checks before every disclosure, private secrets, quotas/cost caps, strict provider/embedding-space compatibility, locally stored single active dense index and typed outages. No mandatory local inference, provider account or cloud egress for Gate A; [ADR-0012](adr/0012-optional-cloudru-bge-m3-provider.md). |

## Optional derived caches and storage responsibilities (CAP-12–14)

The source Vault is authoritative. Host-private parsed-document cache (CAP-13), immutable optional portable document-embedding artifacts (CAP-12), and one locally active model-compatible dense search generation are separate derived layers. Cache compatibility must be based on exact extraction/serialization/provider identities and current source authorization. A Cloud.ru BGE-M3 embedding adapter is one **candidate** for the separately gated API-backed dense role (CAP-14); no offline model is mandated. No source-text transfer, bucket provisioning, real-Vault migration, or bulk reindexing is authorized by these architecture additions.

## Proposed performance and quality gates

For **optional locally executed** model/parser profiles on the documented 16 GiB-class reference host: one heavy worker by default; proposed engine RSS <= 4 GiB in normal search, separately measured indexing peak, >=3 GiB available system memory before heavy work and pressure admission. A remote API profile instead needs explicit timeout/rate-limit/token/cost budgets and measured p50/p95 network latency. Historic warm hybrid p95 <= 3 seconds remains a candidate target, not an achieved result or a Gate A requirement.

Measure Recall@K, Precision@K, nDCG@K, MRR, exact-ID hit rate, source-locator accuracy, chunk coverage, oversize/truncation counts, token duplication, time, RSS and recovery. Agree non-inferiority margins and sample sizes before opening held-out judgments. Require zero critical provenance, privacy and lifecycle violations. For any AI-capable release or controlled adoption, require a demonstrated retrieval quality gain and operational stability without material regression against the incumbent Knowledge AI baseline. Where the incumbent cannot be tested comparably and safely, AI adoption remains blocked until the maintainer reviews an explicit alternative acceptance decision; basic-only MVP is not blocked by an unrun AI comparison. See benchmarks/README.md.

## Foundation vertical (partial capability proof)

OKS-01A proves a real desktop command, bounded local process and typed synthetic evidence response without a search index. It partially exercises AC-06/07/09; it does not satisfy the full capability criteria or count as lexical/hybrid retrieval. The exact candidate tokenizer and serialized input policy must be verified before structural token-budget experiments; model inference parity is verified separately. See the roadmap and ADR-0002.

## Scope of MVP

The **minimum MVP** requires real Obsidian+plugin offline text occurrence and Properties/metadata search, supported Markdown evidence, basic source lifecycle, scope, provenance, durability and privacy. It does not require CAP-04/05 or local AI provisioning. Those capabilities are independently required **only before declaring the optional AI profile production-ready**; native PDF/DOCX/OCR acceptance applies only before claiming those formats. Retain capability IDs for traceability; mark unimplemented optional claims unavailable rather than implying they are gone.

No production-Vault adoption, public release or external data egress is authorized by documentation acceptance. A single active dense model/index is maintained when AI search is configured; temporary staging for migrations is permitted. Reranker and LLM providers do not require dense-index duplication. A failed remote/local AI API never disables basic search.

Basic typed Properties filtering and preservation of resolvable wiki-link metadata belong to MVP; link traversal and cross-source graph expansion remain optional. Source freshness, no-truncation, confidentiality and exact original provenance are hard gates for every supported mode.

## Standalone UI candidate traceability

OKS-04B implements the CAP-07/AC-07 candidate search panel, commands, typed settings, safe status/diagnostic export and [in-process API v1](standalone-api.md). Source-open validation supports CAP-06/AC-06 and event revocation CAP-01/AC-01; lifecycle uses the existing CAP-08/09 generation/worker controls. Dense/hybrid remain unavailable. These implementation references do not mark acceptance: independent review and real-host smoke remain required, with [current validation limits](../benchmarks/standalone/04b-validation.md) explicitly recorded.
