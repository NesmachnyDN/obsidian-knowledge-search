# Retrieval evaluation protocol

Use only generated, redistribution-safe documents in this repository. No private vault snapshots, original regulated documents, derived excerpts, raw embeddings or production indexes.

## Corpus
Generate deterministic Russian and English Markdown, PDF and DOCX including nested headings, numbered constraints, exceptions, explicit negation, glossary, cross-page tables, similar product names, exact identifiers, numeric values/units, scanned PDF and unsupported/empty/duplicate files. Include malformed inputs and source lifecycle cases. Record generator and fixture checksums. Separate tuning from held-out queries and freeze ground truth before comparison. Relevance labels include source spans and locators, not merely document titles. Include negative and ambiguity cases.

## Comparisons
Measure lexical-only, dense-only, hybrid and optional rerank; Knowledge AI as the named incumbent baseline, with recorded version, local/offline configuration, embedding profile when observable, identical synthetic source scope and matched queries. Compare ranked evidence, not generated answers. If a safe comparable run or metric is unavailable, record the limitation; do not bypass the adoption gate or assume superiority. For chunking, first compare fixed/paragraph baseline, true-token-budget planner and Docling HybridChunker under identical extraction and tokenizer settings, without embedding inference (02C). Shortlist policies using structure, coverage and token-efficiency metrics. In 03B compare retrieval quality with identical selected embedding/runtime/retrieval settings and separate derived indexes, then confirm or revise the policy. Vary parser independently. Pin and verify the candidate tokenizer artifact without loading inference weights before the chunking experiment; revalidate against the actual embedding runtime before index activation. Record special tokens and exact serialized payload. Record source spans separately from contextualized input. Record quality/efficiency and failure coverage, not only chunk count. Suggested starting token-budget candidates 256, 512 and 1024 actual tokens; adapt to selected tokenizer and structure, not forced fixed windows. Count serialized headings/table headers in the budget. Quantify overlap and prefix duplication independently.

## Metrics and acceptance
Recall@K, Precision@K, nDCG@K, MRR (including K=5 and K=10 where meaningful), exact-ID hit rate, locator validity, source coverage, dropped and duplicate spans, oversize/truncation counts, latency p50/p95 (cold and warm separately), index size, peak RSS, CPU, indexing time and recovery. Pin model/runtime/tokenizer/weights identity, parser versions, corpus hash, hardware profile, index config, random seeds and code revision. Record errors/degraded legs; do not score silent fallbacks as successful hybrid retrieval. Agree margins, query count and go/no-go before held-out evaluation. Freeze independent held-out labels; run the same production retrieval entry point with runtime-safe inputs only, expose reference labels to the evaluator after retrieval. Compare only compatible run manifests and report per-query errors/negative cases. Evaluate RRF, reranker and context expansion independently before combining them. Zero critical evidence, security or lifecycle violations; no silent truncation. Use actual measurements, not guessed results.

Authorized private acceptance may run locally only, with sanitized aggregate results and no private inputs transferred. Any published results must identify the limitations and synthetic nature of the corpus.


Before held-out testing, specify per-query relevance grades, counting unit (deduplicated source span), K, treatment of unanswerable queries, acceptable margins and pilot corpus size. Report paired per-query deltas, absolute counts and uncertainty where sample size supports it. Record extraction completeness against known generated source blocks; exact locator validity, lost/duplicate spans, table/requirement/definition coverage, actual token-count parity and prefix duplication separately. Capture index throughput, on-disk bytes, whole-process-tree peak memory/CPU, cancellation and restart/rebuild correctness. No model or incumbent baseline requiring confidential data or cloud egress is allowed. Missing required baseline evidence blocks adoption unless the maintainer explicitly revises the gate in a reviewed decision.

## OKS-02A baseline

See [frozen corpus v1](corpus/v1/README.md) and [baseline evidence](oks-02a.md). Run the synthetic-only benchmark with `python3 -I -B benchmarks/oks02a.py --split tuning` or `--split held_out`; the latter is for the frozen implementation evaluation, not tuning.

## OKS-02B native extraction

See [native extraction and offline OCR evidence](extraction/README.md). The model-free PDF profile is not a full semantic layout extraction strategy. The measured structured PDF profile has an explicit unresolved Russian numbered-heading classification limitation.

## OKS-02C tokenizer-verified chunking

See the [reproducible four-policy structural/token comparison](chunking/README.md), [600-case evidence summary](chunking/results.json), [complete case records](chunking/cases.ndjson), and [provisional ADR](../docs/adr/0005-provisional-structural-chunking.md). These are source-coverage/token-budget experiments, not retrieval-quality or embedding-inference validation.
