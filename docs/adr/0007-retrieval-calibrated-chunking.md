# ADR-0007: Model-backed chunking quality overrides structural-only preference in Retrieval reference

**Status: Proposed** — measured synthetic 03B experiment, pending independent full-phase SDD review and a single merge of the aggregated Retrieval PR. **Scope:** opt-in Python reference runtime **only**. Does not select a default plugin-native or PDF/DOCX policy.

## Context and authority

[ADR-0005](0005-provisional-structural-chunking.md) selected **structure-aware provisionally** after a 600-case structural and exact-token comparison, explicitly conditioned on real dense/hybrid retrieval quality in 03B. That shortlist is **not a settled production default**. ADR-0006 separately mandates Standalone lexical and optional measured advanced local/offline profiles, and prohibits synthetic/hash vectors from masquerading as real retrieval.

## Paired experiment

The [03B report](../../benchmarks/retrieval/README.md) fixes BGE-M3 revision/weights/tokenizer, corpus v1, 31 pre-existing frozen queries, 96-token effective full-input limit, 0 original-source overlap, source extraction and source-locator semantics, and rank/scoring methodology. All three tested policies retain **zero missing original source spans and zero effective-token overruns** on the 21 annotated Markdown sources.

| Policy | Chunks | Dense nDCG@10 held-out | Hybrid nDCG@10 held-out |
|---|---:|---:|---:|
| Fixed-window | 20 | 0.3943 | 0.8101 |
| Paragraph-aware | 105 | **0.9344** | **0.9456** |
| Structure-aware | 42 | 0.5825 | 0.8650 |

This experiment measures actual normalized 1024-dimensional vectors and deterministic RRF, not inferred ranks from token statistics. Evidence is frozen and can be independently reproduced under the approved cgroup envelope. Ranking is evaluated on **original line locators projected from real chunk SourceSlices**, not fabricated offsets. All source-to-line projections are verified; however multi-line chunks expose multiple possible original-line judgments.

## Proposed decision

1. For the **measured 96-token / zero-overlap / synthetic Markdown Python reference experiment**, treat **paragraph-aware** as the **leading retrieval-quality candidate**, reversing the purely structural performance preference for the purpose of subsequent tuning.
2. Retain **structure-aware** as the preferred structural efficiency baseline, and fixed-window as the regression comparator; do not erase or modify any 02C evidence.
3. Do **not** change the Obsidian-native Standalone baseline, select model packaging/runtime, assert MVP CAP-05 acceptance or adopt this policy for all source formats based on this limited comparison.

## Alternatives, constraints, consequences

- **Adopt structure-aware outright** solely because it is smaller and retains coverage: rejected for this reference experiment because the actual 03B dense/hybrid nDCG falls substantially behind paragraph-aware.
- **Adopt paragraph-aware globally** based on one tiny pilot: rejected. It emitted 105 chunks rather than 42, consuming more indexing/inference/storage resources. The 21-source corpus lacks broad PDF/DOCX document-level judgments and user-labelled production searches.
- **Select native HybridChunker projection** as an equal-quality competitor: rejected until 02C's 36 source-coverage misses, six budget overruns and incomplete native-anchor mapping are remediated. This is a projection caveat, not a general criticism of Docling.
- **Quality tradeoff:** larger paragraph index improves this pilot's real-model nDCG but may raise memory/latency and duplicates. Multi-budget and overlap paired trials plus more realistic evidence labels are required before a stable product choice.

## Follow-on gates

Before 04A/04B or MVP adoption, freeze concrete versioned evidence schemas and plugin-native lexical behavior, validate native source anchors and exact tokenizer/input-policy parity, perform independent tests at larger scale and altered budgets, and complete final exact-HEAD full-phase SDD review of OKS-03A/B. No source files or model weights are stored in the public repository as a result of this ADR.
