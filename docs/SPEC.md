# Product specification

Status: initial baseline; numeric budgets are proposed acceptance targets and must be confirmed by the first benchmark.

## Purpose and non-goals

Deliver accurate, inspectable, local retrieval over Obsidian vaults. The original files and note metadata are authoritative. OKS supplies evidence to users or authorized AI consumers; it does not make authoritative compliance decisions or require an LLM. No replacement vault, separate knowledge metamodel, multi-user platform, cloud inference, mandatory generator, or dependency on a prior application. First target: desktop Linux, 16 GiB-class CPU workstation.

## Capabilities and acceptance criteria

| ID | Capability | Acceptance |
|---|---|---|
| CAP-01 | Vault scope and lifecycle | AC-01: initial scan plus create/modify/rename/delete reconciliation; configured scope, ignored folders and supported types; no access outside allowed roots including symlink/traversal tests. Deleted or superseded source evidence cannot be returned as current. |
| CAP-02 | Document extraction | AC-02: Markdown, text PDF and DOCX on test corpus; local Russian/English OCR on a scanned PDF fixture; preserve headings, clauses, lists and table semantics with source locators. Report empty, unsupported or failed sources; no silent exclusions. XLSX/PPTX and legacy DOC tracked separately. |
| CAP-03 | Structural chunking | AC-03: hierarchical boundaries, model-token budget including contextual prefix, deterministic identity, verifiable coverage; no silent truncation, lost source spans or cross-section mixing. Handle oversized atomic elements explicitly. Compare current-style windows with structure-aware alternatives under identical parsing. |
| CAP-04 | Local embedding | AC-04: explicit model/tokenizer/runtime identity, dimension and normalization checks, deterministic index compatibility, offline operation after explicit provisioning. BGE-M3 is the initial candidate, not an untested quality claim. Fail visibly when the selected model cannot run. |
| CAP-05 | Hybrid retrieval | AC-05: lexical + dense candidates, deterministic RRF, exact identifiers and metadata filters, typed ranked evidence with diagnostics. Evaluate lexical and dense legs independently. No implicit search outside the vault. |
| CAP-06 | Evidence and context | AC-06: stable file reference, source hash, page/heading/clause/table-row where available, excerpt and scores; original vs contextualized text distinguished; missing provenance explicit. Context expansion respects source version, scope and bounded budgets. Negative queries do not fabricate evidence. |
| CAP-07 | Plugin integration | AC-07: desktop search panel, settings, status, open source, pause/resume/cancel/rebuild, diagnostic export without source text by default. Versioned machine-readable search/status interface accessible through a supported local mechanism; verify Obsidian CLI integration rather than assume it. |
| CAP-08 | Durability | AC-08: atomic publication of consistent index versions, idempotent incremental updates, restart/resume and crash recovery; reconcile after missed events. Cache deletion never deletes source files. |
| CAP-09 | Local resource control | AC-09: bounded queue and concurrency, CPU/memory/disk guardrails, cancellation and workload prioritization. Model workloads outside UI. Explicit provisioning; no automatic heavyweight downloads. Resource exhaustion is observable and recoverable. |
| CAP-10 | Quality and confidentiality | AC-10: reproducible frozen corpus, per-query evidence labels and baseline comparison. Zero unexplained truncation, forbidden-file indexing or external document transmission in tests. No adoption before quality and stability gates pass. |
| CAP-11 | Advanced retrieval (post-MVP) | AC-11: optional cross-encoder rerank and bounded link/property context expansion; each independently improves agreed quality metrics without unacceptable latency; no graph database required. |

## Proposed performance and quality gates

On the documented 16 GiB-class reference host: one heavy worker by default; target engine RSS <= 4 GiB in normal search, separate measured indexing peak, at least 3 GiB available system memory before starting heavy work, pause on pressure; no concurrent heavyweight parser/reranker by default. Provisional warm hybrid p95 <= 3 seconds on the pilot corpus; assess reranker separately. These are initial budgets, not achieved performance.

Measure recall@10, nDCG@10, MRR, exact-ID hit rate, source-locator accuracy, chunk coverage, oversize/truncation counts, token duplication, time, RSS and recovery. Agree non-inferiority margins and sample sizes before opening held-out judgments. Require zero critical provenance, privacy and lifecycle violations. Require a demonstrated retrieval quality gain or other agreed material benefit without material regression against the baseline. See benchmarks/README.md.

## Scope of MVP

CAP-01 through CAP-10. Reranking and graph expansion are separate, conditional increments. Existing vault configuration and incumbent search remain unchanged until a controlled adoption decision. No claim of support for formats, hosts or distribution channels that have not been tested.
