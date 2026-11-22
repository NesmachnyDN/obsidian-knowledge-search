# ADR-0005: Provisional source-preserving tokenizer-aware chunking policy

Status: **Proposed** — measured OKS-02C prototype; pending independent exact-head review and merge. Not a production policy acceptance.

## Context and immutable inputs

The single authoritative source is an Obsidian Vault; the canonical ParsedDocument output is the boundary between extraction and derived chunk/index content. Unlike OCR or native binary references, Markdown byte positions are direct and reconstructable. The DOCX and PDF profiles have typed original item anchors, sometimes with pages/geometry/table cells, never generalizable PDF/DOCX file-byte offsets. The measured structured PDF has an unresolved numbered Russian heading classified as a list item and reports `partial`; its source text, native geometry and diagnostics are preserved. No artificial classifier repair for this experiment.

OKS-02C requires a *real* tokenizer-only input budget, explicit oversize handling, deterministic chunk identity, no silent source loss, and comparable baseline policies. Full embedding runtime parity belongs to 03A; ranking quality confirmation belongs to 03B.

## Decision proposed

**Shortlist independent structure-aware as the leading provisional candidate**, retain paragraph-aware as the conservative structural baseline, and retain fixed-window as a lexical-style regression baseline. Do not adopt the evaluated native HybridChunker projection as an evidence-preserving production default. This is a judgment **about this exact provenance projection and input serialization**, not a statement that upstream Docling is inherently inaccurate or unsuitable.

Canonical source span slices are immutable, ordered and version-bound. The engine carries source path/hash, extraction status/profile, headings, page/item geometry where actually available, table/row/merged-cell references, explicit diagnosed missing locators, and the exact derived contextualized text. Markdown UTF-8 byte offsets derive from verified literal line spans; never synthesize them for PDF/DOCX. Repeated headings/identical fragments remain differentiated by ordered canonical block references. Chunk IDs bind source digest, extraction profile, canonical slices, policy, serialization version and tokenizer identity fingerprint.

The policy counts the **entire** serialized input (including literal contextual prefix, heading lines and two XLM-R BOS/EOS special tokens), with truncation/padding explicitly disabled and a checked input length. Oversized paragraphs, requirements, lists or rows split into exact-token-fitting original-character slices, never silently excluded. For an oversized table-row serialization, a split fragment retains the native source item and the full cell/row anchors but is marked `partial-table-row-serialization`; no exact cell-local offset is invented. This makes the limitation inspectable before any retrieval-policy promotion.

The initial tokenizer is `BAAI/bge-m3` revision `5617a9f61b028005a4858fdac845db406aefb181` (local model card MIT; `tokenizer.json` SHA-256 `21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08`; `tokenizers==0.23.3`). Only tokenizer artifacts are required; embedding weights are not loaded. The 8192-token advertised maximum is not yet a tested embedding runtime guarantee.

## Actual measurements (synthetic reference)

The checked benchmark [aggregate](../../benchmarks/chunking/results.json) and [complete 600-case stream](../../benchmarks/chunking/cases.ndjson), generated losslessly by the checked [summarizer](../../benchmarks/chunking/summarize.py), record 25 inputs × budgets 48/96/192 × overlaps 0/12 × four policies; zero failed cases, deterministic repeat true for all strategies. Sources are all manifest-listed frozen 02A Markdown files, checked recorded 02B PDF/scan native blocks, the live synthetic DOCX extraction and one generated oversized stress source. The same canonical inputs are used for all policies. The captured PDF and scan native blocks are not new layout-inference runs.

| Policy | Zero lost-source-span cases (of 150) | Full-input budget violations | Cross-section mixed chunks | Full-table-cell-preserved cases | Total chunks | Mean contextual token duplication ratio |
|---|---:|---:|---:|---:|---:|---:|
| Fixed-window | 150 | 0 | 84 | 150 | 278 | 0.988 |
| Paragraph | 150 | 0 | 0 | 150 | 904 | 1.783 |
| Independent structure | 150 | 0 | 0 | 150 | 502 | 1.275 |
| Docling HybridChunker via canonical projection | 114 | 6 | 108 | 114 | 224 | 0.951 |

The native bridge conservatively credits **only exact-aligned canonical original spans**. It yields mean verified coverage 87.1%, a minimum of about 4.2% on an oversized synthetic stress source, and 272 unmatched item/segment alignment observations. Its lower token-duplication ratio is **not a quality advantage**: unverified spans are absent from the accounting. Six cases exceed the external full-input budget by one or two tokens because native internal count can exclude specials; a separate external exact tokenizer always detects the violation. Native heading and tabular serialization can legitimately differ from canonical original text, so the observed coverage shortfall does not prove physical loss in upstream output.

At token budget 96, zero overlap, the **partial** structured PDF source produced 100% canonical source-character coverage with 0 budget/cross-section violations and preserved table cells under the independent structure planner. It does not restore the incorrectly classified numbered heading; the unresolved extraction diagnostic continues to apply. Both independent structural and paragraph policies satisfy the current structural gates; the former emits fewer chunks and repeats less contextual text under these measured constraints.

The corrected guarded run consumed 54.23 seconds wall end-to-end (versus 14.47 seconds before the exact-fit correction); the exhaustive token-fitting search trades higher CPU time for correctness and needs further large-document throughput evaluation before adoption. The measured cgroup peak memory was **1,710,645,248 bytes** with a 4,294,967,296-byte hard limit, `memory.swap.max=0`, two-CPU affinity and 200% CPU quota, `pids.max=128`, loopback-only namespace, and **zero** cgroup memory-pressure/oom events. Five offline integration tests confirmed exact full-input counts against HuggingFace fast tokenizer, intentional >8192-token inputs not being truncated, oversized canonical coverage and native provenance diagnostics. The existing Python/TypeScript regressions and code quality gates remain separate CI/review requirements.

## Rejected alternatives and consequences

- Choosing fixed windows as default would obscure section boundaries (84 mixing observations).
- Choosing paragraph-aware alone increases chunk and prefix duplication compared with measured structural planning while preserving boundaries.
- Declaring native HybridChunker the winner on count/duplication metrics would hide 36 observed source-coverage failures and six over-budget results of this specific bridge. Never silently repair or trust missing provenance.
- Increasing overlap is an explicit original-content repetition experiment, not a query-time retrieval improvement guarantee. It must fit the full prefix-inclusive token budget and may be omitted when insufficient headroom.

The original source is authoritative and index representations disposable. No production Vault or Obsidian configuration was changed. This ADR is a small-synthetic-corpus engineering decision, not a general Docling or BGE-M3 performance claim.

## Obligations and deferrals

1. Independent exact-HEAD SDD review plus passing hosted checks are mandatory before OKS-02C integration.
2. 03A must test BGE-M3 **embedding inference** identity against this tokenizer snapshot, runtime parity, chosen effective maximum length, resource admission/pressure and offline lifecycle. Tokenizer proof is not model-runtime proof.
3. 03B must compare the shortlisted independent structural and paragraph policies under identical embedding/index/retrieval settings and evaluate exact identifiers, relevance, provenance and bounded source context. Only then accept/revise the provisional selection. Test more realistic large document hierarchies and table continuation cases.
4. Improve native item/segment alignment before reconsidering HybridChunker as a provenance-preserving producer. Never attribute unverified bridge gaps to upstream document loss without further source-specific tests.
5. An oversized table row retains cell anchors but not exact cell-local substring offsets; this is an explicit limitation pending a stronger canonical cell-fragment contract if downstream evidence demands it.
