# Reuse assessment

Status: OKS-00 design assessment for review. No prior application code, datasets, model artifacts or operational configuration imported.

## Redistribution and dependency gate

The prior engineering implementation was inspected as a reference. No redistribution license was established for its source. Reimplement transferable algorithms from public specifications and independently authored requirements. No source, private repository identifiers, internal file paths, private evaluation reports or fixtures are published here. Maintainer-only provenance records remain outside public Git. If a later slice proposes direct reuse, require explicit written redistribution rights, exact source revision/path/symbol, author/copyright and third-party provenance, license compatibility, transitive dependency inventory, notices, and independent review before copying. A repository-level MIT license does not grant rights to third-party or private source. A blocked direct-copy decision does not block independently authored implementation.

The proposed [ADR-0006](adr/0006-standalone-execution-profiles.md) retains the Python implementation as a measured reference and eligible opt-in backend, **not** a baseline installation dependency. The native plugin-side lexical implementation will reuse shared evidence semantics and independently reviewed algorithms, not private code or a Python interpreter. Any plugin-managed advanced runtime requires its own licensing and host-policy gate.

## Engineering dispositions

| Component | Reference findings / transferable approach | Dependency concerns | Adaptation effort | Decision / gate |
|---|---|---|---|---|
| Document adapter | Separate extraction from policy; preserve native tree, reading order, tables, captions, locations and diagnostics. Text reconstruction alone cannot guarantee structural fidelity. | Existing server HTTP/config/office rendering and application extraction contracts; native Docling and separately licensed model assets. | High | New local Docling adapter; inspect upstream native hierarchy and prove mapping (02B). No external parser service by default. |
| Canonical source blocks | Neutral ordered blocks, page geometry, typed elements, extraction confidence. | Earlier structured/parsed compatibility layers and application metadata. | Medium | Define one small independent canonical schema; keep original source identity and explicit missing locators. (02A/B) |
| Section classifier | Heading, clause, definition, list, glossary and table signals can improve boundary selection. | Previous taxonomy, exclusion rules and scoring encode application-specific policies. | Medium/high | Start with native structure and simple independently written rules; add only measured signals. No automatic appendix/table/definition suppression. (02C) |
| Chunk planner | Alternative entry/table/heading/paragraph/window strategies; whole-block overlap; approximate character/token ratio is insufficient. | Previous quality configuration, types and multi-stage retrieval units; true model tokenizer. | High | Compare simple baseline, actual-token structural planner and native HybridChunker on identical extraction. No direct import; validate serialized input and source coverage. (02C) |
| BGE-M3 embedding | Pinned local snapshot, dense-only capability honesty, normalization and strict index binding. | Model artifacts, tokenizer, PyTorch/Sentence Transformers or alternative CPU runtime; no server or hash substitute. | Medium/high | Treat dense BGE-M3 as first candidate; prove tokenizer/runtime identity, memory, actual inference and offline behavior. (02C/03A) |
| Cross-encoder reranker | Pinned offline weights, bounded candidates, explicit activation/failure; CPU smoke alone is not proof of retrieval gain. | Large model/runtime, separate throughput and memory demands; previous HTTP deployment stack not needed. | Medium/high | Defer until MVP, compare paired retrieval quality and resource cost; no simultaneous heavy workers by default. (06A) |
| Rank fusion | RRF based on rank positions rather than cross-leg raw score comparability. | Earlier candidate/profile types and server-side retrieval contracts. | Low | Independently implement deterministic two-leg RRF; deduplicate per leg, define ties, preserve leg ranks/scores and explicit degraded status. (03B) |
| Source-aware expansion | Keep anchor hit and expand adjacent evidence only under compatible source/version/hierarchy/scope; deduplicate by exact spans. | Earlier canonical knowledge, graph and application composer contracts. | Medium | Independent bounded same-source expansion after MVP; graph via vault links only if proven. Do not import fact/claim or graph models. (06B) |
| Index/model identity | Reject missing or incompatible artifact, dimension, normalization and representation identity, even at identical vector dimension. | Prior database/model binding registry and vector-store-specific metadata. | Medium | Local manifest, explicit tokenizer/serialization/runtime/profile and artifact fingerprints; staged rebuild, no mixed spaces. (01B/03A) |
| Evaluation | Positive/hard-negative source/span labels, production-path parity, blind ground truth, immutable comparable runs. | Earlier DB-backed application runner, taxonomy and private fixtures; simple metrics can be independently implemented. | Medium | New deterministic synthetic RU/EN fixtures and compact harness; never copy past corpora or results. (02A onward) |
| Application and infrastructure | No prior application deployment, canonical metamodel, ORM, API, workflow engine, vector server, graph DB, or generation layer required. | Server persistence, governance and operational dependencies. | High if imported | Omit. Obsidian is the only authoritative knowledge source; index/cache is disposable. |

Historical experiments are design inputs, not OKS benchmarks. In particular, native tokenizer-aware chunking has not been established as the previous operational algorithm, alternative multilingual embeddings are research candidates rather than approved replacements, and isolated model inference does not establish corpus-level retrieval superiority or reference-host capacity.

## Public upstream candidates (preliminary, not an approved lockfile)

| Candidate | Upstream license evidence | Gate |
|---|---|---|
| [Obsidian API](https://github.com/obsidianmd/obsidian-api/blob/master/LICENSE.md), [sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/LICENSE) | Permissive upstream license text; preserve applicable notices for copied scaffold. | 01A: verify exact npm packages, lockfile and transitive runtime/build licenses. Do not bundle Obsidian. |
| [Python standard library](https://docs.python.org/3/license.html), [Node child process](https://nodejs.org/api/child_process.html) | PSF/associated Python terms; Node distribution has its own licenses. | 01A: use installed interpreter and host API, not bundled runtime. |
| [Docling](https://github.com/docling-project/docling), [docling-core](https://github.com/docling-project/docling-core/blob/main/LICENSE) | MIT code; model licenses separate. | 02B: pin actual versions, verify models/OCR, dependencies and offline provisioning. |
| [BGE-M3](https://huggingface.co/BAAI/bge-m3) | MIT model card; 1024 dense dimensions, upstream maximum sequence length 8192. | 02C/03A: separately pin tokenizer and actual artifact/license; selected max input is benchmarked, not automatically 8192. |
| [BGE-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3) | Apache-2.0 model card. | 06A: verify revision, weights, notices, runtime, token limit and bounded CPU comparison. |
| [SQLite FTS5](https://www.sqlite.org/fts5.html), [SQLite copyright](https://www.sqlite.org/copyright.html) | SQLite public domain; builds/extensions carry their own dependencies/terms. | 01B/02A: verify local build support, exact-ID punctuation and Russian morphology behavior; no external database. |
| [sqlite-vec](https://github.com/asg017/sqlite-vec), exact dense baseline | sqlite-vec declares MIT OR Apache-2.0; pre-v1 API may change. | 01B: compare exact search, filter correctness, atomic publication, extension loading, bounded memory and pinned compatibility. Do not assume ANN or transactional cross-store guarantees. |
| [Tesseract](https://github.com/tesseract-ocr/tesseract), [tessdata](https://github.com/tesseract-ocr/tessdata) | Apache-2.0 engine and language data declarations. | 02B: compare local rus+eng recognition, coverage, table/number fidelity, explicit offline provisioning and resource limits. |
| Model runtimes / other OCR | Not yet selected or transitively audited. | Separate dependency closure and license check before installation or production selection. |

Upstream declarations reviewed at assessment time; exact versioned package/artifact terms, dependency closure and notices remain implementation gates. No external model, parser or database is required in OKS-01A.

## Evidence and decision gaps

- [Docling chunking](https://docling-project.github.io/docling/concepts/chunking/) describes hierarchical chunking, token-aware splitting and compatible-peer merging, not optimal sliding overlap. Count the actual contextualized payload including special tokens and repeated table headers; preserve exact source spans separately. Compare overlap and query-time expansion independently.
- Lexical exact identifier and morphology tests precede dense retrieval. Measure punctuation-sensitive identifiers, clause numbering, negation, newer/older source revisions and table row context.
- A model's card, architecture or single synthetic inference cannot replace measured end-to-end evaluation. Compare runtime profiles and use one active compatible embedding space; do not mix vectors from different artifacts or pipelines.
- No private host capacity, benchmark or legacy deployment figures are transferred to public Git. All OKS measurements must be generated independently on authorized synthetic inputs.
- See the roadmap and ADR-0002 for experiment order, boundaries and acceptance gates.


## Risk and PoC register (design hypotheses, not completed experiments)

| Risk | Proof required | Slice / stop condition |
|---|---|---|
| Host resource exhaustion or orphan worker | Admission before allocation, one heavy job, enforce process-tree memory/CPU and thread limits (evaluate Linux cgroup v2 delegation); measure entire worker tree, pressure, disk reserve and cancellation; fail closed if controls are unavailable. | 01A lifecycle; 01B enforceable isolation before arbitrary/heavy workloads. |
| Loss of structural evidence | Native item-to-block-to-chunk span mapping; synthetic nested clauses, exceptions, multi-page tables, duplicated headers, OCR numeric and unit accuracy; record missing locator/coverage rather than invent spans. | 02B/C: reject policies with critical loss or unverifiable provenance. |
| Token and model identity drift | Pin tokenizer, serialization, special tokens, effective input limit, weights and runtime; count serialized input without truncation; reject same-dimension incompatible vectors. | 02C/03A: no activation on mismatch. |
| False exact matches or missed identifiers | Exercise Cyrillic morphology, mixed script, punctuation, hyphens, dots, clause IDs; separate exact identifier field from full-text analysis; compare lexical, dense and fusion results. | 02A/03B: no critical exact-ID regression. |
| Stale or mixed-generation results | Single publication boundary for manifest, lexical and dense records; fault injection between writes, rename/delete, source hash verification, cleanup, disk-full and process kill. | 01B/04A: no stale or mixed evidence advertised as current. |
| Silent degraded retrieval | Explicit component readiness, skipped/failed stages, mode requested vs executed; no lexical-only result labeled hybrid. | 03B: failure-path checks before activation. |
| Local interface or parser crosses trust boundary | Bounded framing, restricted roots and untrusted parser inputs; no shell interpolation, runtime egress or default listener; evaluate authenticated local client access and actual Obsidian CLI affordances. | 01A/B, 02B, 04B: deny unsupported boundary. |
| Benchmark bias / incumbent incomparable | Freeze independent judgments and run manifest; distinguish retrieval hits from generated answers; capture incumbent version/settings and unavailable metrics; report paired deltas including negative cases. | 02A/05: no adoption claim on incomparable evidence. |

Historical synthetic evaluations motivate an optional reranking stage: a potential small gain in top-rank quality must be weighed against CPU latency and memory cost. Prior fusion comparisons likewise motivate rank-based fusion but do not establish the optimal production strategy. Earlier native-chunking and source-expansion research remains incomplete. No prior numeric results or private references are included; reproduce the relevant comparisons independently.

## Multi-format extraction reference reassessment (OKS-06G.1)

Prioritize provider-neutral registry/routing and canonical normalization, native spreadsheet/presentation extraction and embedded-image OCR, and deterministic bounded compound-file/MAPI message and attachment identity. Benchmark maintained upstream libraries (Unstructured, openpyxl, python-pptx, python-docx, olefile) alongside Docling/Tika/POI under ADR-0017. Test source-only content coverage and true locators, including original row/cell positions, formula/cached-value distinction, multi-line slide titles, nested shapes/notes, missing OCR and attachment digest/parent lineage. A declared extension, scanner recognition or successful parser call is not proof of indexed content. Select independently implemented adaptations unless direct reuse meets the existing written redistribution, exact provenance and review gate above. Preserve local-only processing; no prior app services, private fixtures or internal identifiers in public Git. This reassessment is static design input, not a new OKS runtime benchmark.
