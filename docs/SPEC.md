# Product specification

Status: architecture-aligned requirements; capability acceptance is profile-specific, and numeric budgets remain proposed until measured.

## Purpose and non-goals

Deliver accurate, inspectable, local retrieval over Obsidian vaults. The original files and note metadata are authoritative. OKS supplies evidence to users or authorized AI consumers; it does not make authoritative compliance decisions or require an LLM. No replacement vault, separate knowledge metamodel, multi-user platform, cloud inference, mandatory generator, or dependency on a prior application. First target: desktop Linux, 16 GiB-class CPU workstation.

## Execution profiles and MVP acceptance partition

**Standalone is mandatory by default.** Installing only Obsidian and the plugin must suffice for local, offline Markdown lexical search: supported notes indexed locally, typed Properties filtering and link metadata, exact source navigation and provenance, source mutation/delete freshness, durable derived index, no separate interpreter/service/model provisioning or outbound content. Plugin-native indexing (OKS-04A) and search UI (OKS-04B) are merged candidates; full MVP clean-install and security/resource acceptance remains assigned to OKS-05.

**Bundled Advanced is optional:** plugin-bundled, plugin-managed inference/parsing assets and workers may add formats, OCR, real dense and hybrid retrieval **only after** Obsidian API/distribution, offline, license, binary size, cancellation and resource verification. No manual dependency installation. **External Backend is optional and explicitly configured:** a separately managed authenticated local service may provide advanced features; it is never a prerequisite for Standalone and no content is transmitted without clear opt-in. No cloud communication by default.

| Capability / status | Standalone target | Bundled Advanced candidate | External Backend candidate |
|---|---|---|---|
| Markdown, typed Properties, wiki-link metadata, offline lexical search, navigate and source freshness | **Required**, no additional software | Inherited | Inherited locally even when backend is down |
| PDF/DOCX structured extraction and RU/EN OCR | Explicit `unsupported` until implemented; not falsely indexed | Optional after proof | Optional after local consent and proof |
| CAP-04 real model-backed dense search | `unavailable` unless independently shipped/validated; never implied by lexical search | Eligible, only with verified tokenizer/weights/runtime | Eligible, only with verified local/offline backend |
| CAP-05 hybrid lexical+dense+RRF | `unavailable` without working dense leg; not labeled hybrid | Eligible after both legs pass | Eligible after both legs pass |
| CAP-01/06/08/09 lifecycle, evidence, durability and safety | Mandatory for supported sources | Mandatory for advanced sources | Mandatory end-to-end |

CAP-02 full-format/OCR acceptance, CAP-04 and CAP-05 are **not dropped from the MVP**: they must be independently proven in at least one explicitly supported advanced **local/offline** profile before CAP-01–10 MVP acceptance. A successful Python-only experiment is not proof of a standalone install. Clean-install Standalone and advanced hybrid are separate release gates. Requested vs executed search mode, per-leg readiness and explicit failure codes are observable; hybrid/dense requests must fail visibly without their required leg rather than silently downgrade.

See [ADR-0006](adr/0006-standalone-execution-profiles.md) for canonical contract, profile boundaries and clean-install tests.

## Capabilities and acceptance criteria

| ID | Capability | Acceptance |
|---|---|---|
| CAP-01 | Vault scope and lifecycle | AC-01: initial scan plus create/modify/rename/delete reconciliation; configured scope, ignored folders and supported types; no access outside allowed roots including symlink/traversal tests. Deleted or superseded source evidence cannot be returned as current. |
| CAP-02 | Document extraction | AC-02: Markdown, text PDF and DOCX on test corpus; local Russian/English OCR on a scanned PDF fixture; preserve headings, clauses, lists and table semantics with source locators. Report empty, unsupported or failed sources; no silent exclusions. XLSX/PPTX and legacy DOC tracked separately. |
| CAP-03 | Structural chunking | AC-03: hierarchical boundaries, model-token budget including contextual prefix, deterministic identity, verifiable coverage; no silent truncation, lost source spans or cross-section mixing. Handle oversized atomic elements explicitly. Compare current-style windows with structure-aware alternatives under identical parsing. |
| CAP-04 | Local embedding (advanced MVP-wide gate) | AC-04: explicit model/tokenizer/runtime identity, dimension and normalization checks, deterministic index compatibility, offline operation after explicit provisioning. BGE-M3 is the initial candidate, not an untested quality claim. Fail visibly when the selected model cannot run. Does not imply Standalone model availability. |
| CAP-05 | Hybrid retrieval (advanced MVP-wide gate) | AC-05: real lexical + model-backed dense candidates, deterministic RRF, exact identifiers and typed metadata filters, ranked evidence and per-leg diagnostics. Evaluate both legs independently. When dense is absent, report unavailable/failed, never hybrid success or hidden lexical fallback. No implicit search outside the vault. |
| CAP-06 | Evidence and context | AC-06: stable file reference, source hash, page/heading/clause/table-row where available, excerpt and scores; original vs contextualized text distinguished; missing provenance explicit. Context expansion respects source version, scope and bounded budgets. Negative queries do not fabricate evidence. |
| CAP-07 | Plugin integration | AC-07: desktop search panel, settings, status, open source, pause/resume/cancel/rebuild, diagnostic export without source text by default. Default Standalone installs/runs with only Obsidian and plugin. Advanced profiles are explicit opt-in with truthful readiness. Versioned machine-readable search/status interface accessible through a supported local mechanism; verify Obsidian CLI integration rather than assume it. |
| CAP-08 | Durability | AC-08: atomic publication of consistent index versions, idempotent incremental updates, restart/resume and crash recovery; reconcile after missed events. Cache deletion never deletes source files. |
| CAP-09 | Local resource control | AC-09: bounded queue and concurrency, CPU/memory/disk guardrails, cancellation and workload prioritization. Model workloads outside UI. Explicit provisioning; no automatic heavyweight downloads. Resource exhaustion is observable and recoverable. |
| CAP-10 | Quality and confidentiality | AC-10: reproducible frozen corpus, per-query evidence labels and baseline comparison. Zero unexplained truncation, forbidden-file indexing or external document transmission in tests. No adoption before quality and stability gates pass. |
| CAP-11 | Advanced retrieval (post-MVP) | AC-11: optional cross-encoder rerank and bounded link/property context expansion; each independently improves agreed quality metrics without unacceptable latency; no graph database required. |
| CAP-12 | Portable embedding reuse (optional post-MVP) | AC-12: import/export exact-compatible BGE-M3 document vectors across distinct private Vault indexes without duplicate inference; enforce verified embedding identity and input digests, current source/scope checks, atomic complete-generation activation, opt-in privacy, safe failure/offline operation and no mandatory cloud. Tracked by [ADR-0010](adr/0010-portable-bge-m3-embedding-cache.md); **does not extend MVP CAP-01–10 acceptance**. |

## Proposed performance and quality gates

For advanced model/parser profiles on the documented 16 GiB-class reference host: one heavy worker by default; target engine RSS <= 4 GiB in normal search, separate measured indexing peak, at least 3 GiB available system memory before starting heavy work, pause on pressure; no concurrent heavyweight parser/reranker by default. Provisional warm hybrid p95 <= 3 seconds on the pilot corpus; assess reranker separately. These are initial budgets, not achieved performance.

Measure Recall@K, Precision@K, nDCG@K, MRR, exact-ID hit rate, source-locator accuracy, chunk coverage, oversize/truncation counts, token duplication, time, RSS and recovery. Agree non-inferiority margins and sample sizes before opening held-out judgments. Require zero critical provenance, privacy and lifecycle violations. Require a demonstrated retrieval quality gain and operational stability without material regression against the incumbent Knowledge AI baseline. Where the incumbent cannot be tested comparably and safely, adoption remains blocked until the maintainer reviews an explicit alternative acceptance decision. See benchmarks/README.md.

## Foundation vertical (partial capability proof)

OKS-01A proves a real desktop command, bounded local process and typed synthetic evidence response without a search index. It partially exercises AC-06/07/09; it does not satisfy the full capability criteria or count as lexical/hybrid retrieval. The exact candidate tokenizer and serialized input policy must be verified before structural token-budget experiments; model inference parity is verified separately. See the roadmap and ADR-0002.

## Scope of MVP

CAP-01 through CAP-10 across documented profiles, including separately proven CAP-04/05 and full CAP-02 advanced gates; Standalone additionally has its own mandatory clean-install lexical acceptance. Reranking and graph expansion are separate, conditional increments. Existing vault configuration and incumbent search remain unchanged until a controlled adoption decision. No claim of support for formats, hosts or distribution channels that have not been tested.


Basic typed Properties filtering and preservation of resolvable Obsidian wiki-link metadata belong to MVP; link traversal and cross-source graph expansion are optional post-MVP. Same-source evidence must retain its anchor and original locators; a missing or failed leg is not a successful hybrid result. Confidentiality, provenance, source freshness, no-truncation and safe resource admission are hard gates, not quality trade-offs.

## Standalone UI candidate traceability

OKS-04B implements the CAP-07/AC-07 candidate search panel, commands, typed settings, safe status/diagnostic export and [in-process API v1](standalone-api.md). Source-open validation supports CAP-06/AC-06 and event revocation CAP-01/AC-01; lifecycle uses the existing CAP-08/09 generation/worker controls. Dense/hybrid remain unavailable. These implementation references do not mark acceptance: independent review and real-host smoke remain required, with [current validation limits](../benchmarks/standalone/04b-validation.md) explicitly recorded.
