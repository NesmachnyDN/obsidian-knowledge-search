# Retrieval evaluation protocol

Use only generated, redistribution-safe documents in this repository. No private vault snapshots, original regulated documents, derived excerpts, raw embeddings or production indexes.

## Corpus
Generate deterministic Russian and English Markdown, PDF and DOCX including nested headings, numbered constraints, exceptions, explicit negation, glossary, cross-page tables, similar product names, exact identifiers, numeric values/units, scanned PDF and unsupported/empty/duplicate files. Include malformed inputs and source lifecycle cases. Record generator and fixture checksums. Separate tuning from held-out queries and freeze ground truth before comparison. Relevance labels include source spans and locators, not merely document titles. Include negative and ambiguity cases.

## Comparisons
Measure lexical-only, dense-only, hybrid and optional rerank; incumbent plugin with known settings and identical source scope when possible. For chunking compare fixed/paragraph baseline, true-token-budget planner and Docling HybridChunker under identical extraction and embedding settings. Vary parser independently. Record quality/efficiency and failure coverage, not only chunk count. Suggested starting token-budget candidates 256, 512 and 1024 actual tokens; adapt to selected tokenizer and structure, not forced fixed windows. Count serialized headings/table headers in the budget. Quantify overlap and prefix duplication independently.

## Metrics and acceptance
Recall@10, nDCG@10, MRR, exact-ID hit rate, locator validity, source coverage, dropped and duplicate spans, oversize/truncation counts, latency p50/p95 (cold and warm separately), index size, peak RSS, CPU, indexing time and recovery. Pin model/runtime/tokenizer/weights identity, parser versions, corpus hash, hardware profile, index config, random seeds and code revision. Record errors/degraded legs; do not score silent fallbacks as successful hybrid retrieval. Agree margins, query count and go/no-go before held-out evaluation. Zero critical evidence, security or lifecycle violations; no silent truncation. Use actual measurements, not guessed results.

Authorized private acceptance may run locally only, with sanitized aggregate results and no private inputs transferred. Any published results must identify the limitations and synthetic nature of the corpus.
