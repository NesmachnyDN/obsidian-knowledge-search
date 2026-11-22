# OKS-03B — real-model Retrieval benchmark

**Status:** model-backed offline Python reference experiment measured; not Obsidian Standalone, not an accepted production retrieval policy or MVP. See [03B execution contract](../../docs/prompts/OKS-03B.md), [ADR-0006](../../docs/adr/0006-standalone-execution-profiles.md), and the [02C provisional decision](../../docs/adr/0005-provisional-structural-chunking.md).

## Inputs and exact evidence

- The unchanged, fully synthetic and SHA-pinned [02A corpus v1](../corpus/v1/README.md) has **21 Markdown sources**, 15 tuning + 16 previously frozen held-out queries. Graded evidence is a unique (vault-relative path, physical one-based source line); no revised oracle/judgment labels.
- **Real BGE-M3** snapshot `5617a9f61b028005a4858fdac845db406aefb181`, pinned SHA-256 weights and tokenizer as recorded in [03A](../embedding/README.md); PyTorch CPU 2.14.1, Transformers 5.18.0, tokenizers 0.23.3. Fast-tokenizer ID parity with exact 02C source serialization verified; model CLS 1024-dim, L2 normalization, no fake/hash vectors, no auto downloads.
- The guarded reference runner used a **single transient cgroup**, 4 GiB memory maximum, swap maximum 0, two CPUs, max 128 tasks, <=180-second time limit, network namespace with only loopback; only synthetic files read, no production Vault opened. Model inference and retrieval never run on the Obsidian renderer.
- Machine-readable [base retrieval summary](results.json), **all 93 original query/mode observations** in [cases.ndjson](cases.ndjson), and [same-model chunk-policy comparison](chunk-policy-results.json). The [lossless summarizer](summarize.py) recomputes the per-mode frozen quality aggregates and verifies complete tuning/held-out query coverage, with the source-case SHA-256 included in results.json. No private paths or raw source text in published result content.
- The native Docling HybridChunker bridge remains excluded from **production-policy** ranking comparison because 02C already measured 36 failed canonical coverage cases and six full-token-budget violations; no silent repair or false comparison with the canonical policies.

## Experiment A: direct original-line retrieval

The experimental index builds **91 exact-source line-backed candidate blocks**, and model-backed vectors for all 91 with a single published in-memory generation. Independent lexical FTS5 ranking, dense cosine similarity over real normalized vectors and deterministic RRF (k=60) were queried separately. Original source digest/bytes/line spans are reverified on every returned hit; failed modes return typed errors, never lexical success under a hybrid label. Typed Properties filters are applied using their declared types; source changes/deletes/renames suppress stale candidates. This does **not** implement durable storage or a plugin-native index.

| Frozen split / mode | Recall@10 | nDCG@10 | MRR@10 |
|---|---:|---:|---:|
| Tuning — lexical | 1.0000 | 0.9900 | 1.0000 |
| Tuning — dense | 0.9643 | 0.8919 | 0.8929 |
| Tuning — hybrid | 1.0000 | 0.9821 | 1.0000 |
| Held-out — lexical | 0.9667 | 0.9412 | 0.9444 |
| Held-out — dense | 0.9667 | 0.9355 | 0.9429 |
| Held-out — hybrid | 0.9667 | **0.9456** | **0.9500** |

All frozen exact-ID queries found a grade-2 hit at K=10 in this small corpus. Hybrid's held-out nDCG gain over lexical (~0.0044) is **marginal**, not a statistical claim of superiority; it is worse than lexical on tuning, and one held-out unanswerable query still returns real but irrelevant evidence. A ranked retrieval hit is not an automatically justified answer.

Index build was 19.76 s (model loading 11.55 s), with 91 real embeddings; full per-query timings and process/cgroup memory evidence are in results.json. There were **zero invalid original locators, zero failed/incomplete retrieval legs and zero generated evidence references** in the measured run. Freshness failure paths are exercised separately in deterministic tests.

## Experiment B: paired model-backed 02C chunk policies

All three policies process **the same** 21 original canonical Markdown sources, tokenizer, real model weights, queries, score function, budget **96 tokens including contextual prefix and BOS/EOS**, and overlap **0**. Every candidate has preserved original SourceSlices and verifiable Markdown byte/line anchors; no silent truncation. To compare against frozen *line-granular* judgments, an explicitly documented **chunk-to-unique-original-line projection** is applied before dense/RRF ranking. Multi-line chunks can receive credit for supporting lines and have different numbers of source lines; therefore this projection and the 21-source pilot limit the generality of the results.

| Policy | Real dense chunks | Coverage/budget failures | Held-out dense nDCG@10 | Held-out hybrid nDCG@10 |
|---|---:|---:|---:|---:|
| Fixed-window | 20 | 0 / 0 | 0.3943 | 0.8101 |
| Paragraph-aware | 105 | 0 / 0 | **0.9344** | **0.9456** |
| Structure-aware | 42 | 0 / 0 | 0.5825 | 0.8650 |

The previous 02C **structure-aware** provisional choice excelled at source coverage and reduced duplication, but **paragraph-aware gives the stronger observed retrieval quality in this specific model-backed 96-token test**. This is a valid reason to **revise the provisional ranking for the experimental Python reference retrieval profile** rather than promoting structure-aware solely on structural metrics. It is not sufficient to declare paragraph-aware the production default: evaluate larger nested documents, tables, PDF/DOCX native anchors, different budgets/overlap, latency and different graded queries before adoption.

## Runtime, privacy and limitations

Both real retrieval runs exited cleanly; no external model/service contact, no production Vault sources and no code/model downloads were involved. No high/max/OOM/kill cgroup memory events. The primary retrieval trial's process peak was **2,185,684 KiB** (~2.08 GiB); the policy trial's peak was **2,186,752 KiB**. The enforced `memory.max` was 4,294,967,296 bytes, `memory.swap.max` 0. Cgroup `memory.peak` was ~0.9 GiB despite higher process RSS (different accounting/attribution); both counters are retained without conflation. CPU throttling events were recorded and must be considered in latency interpretation.

A **separate lightweight cancellation/recovery integration proof** on 2026-11-22 used a disposable private systemd user scope with effective 128 MiB memory cap, zero swap, 50% CPU quota, 16-task cap and offline namespace. An intentionally long-running `sleep` command was terminated by a **2-second timeout** (exit code 124); the named scope became inactive, and a new recovery scope completed with exit code 0 and also became inactive. This verifies **scope lifecycle for a synthetic worker**, not model-inference cancellation under pressure. No unrelated process was touched.

Actual model vector quality is **not** proof of Standalone shipping, Community Plugins compatibility, binary-format compatibility, long-context effectiveness, statistical non-inferiority to an incumbent, or full CAP-02 PDF/OCR. A real model-load/pressure-cancellation recovery trial and the final **independent full-phase review** remain mandatory or must be explicitly dispositioned as acceptance limitations. Existing standalone requirement (Obsidian + plugin only; Markdown lexical without Python) is still assigned to 04A/04B.
