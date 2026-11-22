# Implementation roadmap

Initial baseline. All slices below are planned, not completed. One bounded PR at a time; dependencies must be satisfied and actual GitHub state checked. Track execution in PRs/issues, not duplicate status ledgers.

| Slice | Depends on | Outcome / exit gate |
|---|---|---|
| OKS-00 | Bootstrap | Design readiness: read specs, inspect license-safe reuse candidates and dependencies; select first vertical slice. Produce [reuse assessment](REUSE.md), decision gaps and [bounded execution contract](prompts/OKS-01A.md). No production code import. |
| OKS-01A | 00 | Minimal offline vertical slice in isolated synthetic vault: plugin command -> supervised one-shot lightweight engine -> typed synthetic evidence response. Bounded stdio, contract tests, build, cancel/unload/restart and real isolated-vault smoke. No model downloads or index. Partial CAP-06/07/09; [execution contract](prompts/OKS-01A.md). |
| OKS-01B | 01A | Choose index storage and production IPC with small measured prototypes; transactional manifest, scope, resource admission/termination and failure tests. ADRs before production adoption. CAP-01/08/09. [Execution contract](prompts/OKS-01B.md), [foundation decision](adr/0003-runtime-storage-foundation.md), [candidate evidence](../benchmarks/oks-01b.md). |
| OKS-02A | 01B | Reproducible synthetic corpus and baseline parser/lexical retrieval; source locator and coverage tests. Freeze train/tuning and held-out judgments. CAP-02/10. |
| OKS-02B | 02A | Docling-based PDF/DOCX native structure, Markdown extraction and local OCR PoC. Compare layout, table cells, headings and scan evidence; pin extractor and licenses. CAP-02. |
| OKS-02C | 02B | First verify and pin the candidate tokenizer (tokenizer artifacts only, separately authorized; no inference weights). Compare fixed/paragraph baseline, independent tokenizer-aware planner and native HybridChunker; vary budgets/overlap under same parsed input. Preserve exact spans, contextual prefixes, table rows; shortlist policies by structural/token metrics via ADR, explicitly provisional until retrieval comparison in 03B. CAP-03/10. |
| OKS-03A | 02C | BGE-M3 local runtime, model identity, parity with the tokenizer and input policy from 02C, actual token budget, vector validation, offline/pressure/error checks. Compare candidate implementations with a frozen corpus; pin chosen profile. CAP-04/09. |
| OKS-03B | 03A | Lexical + dense indexing, RRF, exact technical identifiers, typed Properties metadata scope filters, evidence contract and scores. Measure baselines and hybrid quality, validate shortlisted chunking policies on identical extraction/model/index settings (separate derived indexes), and confirm or revise the provisional policy. CAP-03/05/06/10. |
| OKS-04A | 03B | File events, resolvable wiki-link metadata reconciliation and startup reconciliation, atomic generation, incremental updates, rename/delete, crash/resume, cancel. Test failures and source deletion. CAP-01/08. |
| OKS-04B | 04A | Search panel/settings/status/open source and supported machine-readable interface; test actual Obsidian CLI access. Resource guards, installation and removal. CAP-07/09. |
| OKS-05 | 04B | MVP acceptance: locked benchmark vs Knowledge AI or reviewed alternative gate if not safely comparable, offline verification, real-host resource/stability test with synthetic data, clean install and rollback. Private authorized validation only locally. CAP-01–10. |
| OKS-06A | 05 | Cross-encoder reranker evaluation (BGE-reranker-v2-m3 candidate), bounded candidates and optional activation if net benefit. CAP-11. |
| OKS-06B | 05 | Source-neighbor expansion, Properties and wiki-link traversal, filtered evidence sets, compare with non-expanded baseline. CAP-06/11. |
| OKS-07 | 05; optional 06 | Controlled adoption via separate maintainer decision, backup incumbent settings, verify coverage, rollback path, operate one active search index. |
| OKS-08 | 07 | Public release hardening: supported OS matrix, licenses/notices/SBOM, reproducible package, security and Obsidian distribution policy review. No store publication claim before approval. |

## Phase exits

- Foundation (00–01B): design and protocol tested; no unresolved blocker to the next slice.
- Document quality (02): measurable structure and token/provenance metrics, provisional policy; retrieval-quality confirmation in 03B.
- Retrieval (03): reproducible offline evidence retrieval and compatible index.
- MVP (04–05): integration, incremental lifecycle, recovery, measured quality and bounded resources.
- Advanced / adoption (06–08): individually benchmarked optional features and separate rollout authorization.

No branch, PR, task ID or numeric metric is evidence by itself. Before each next slice reconcile the roadmap with current implementation and review. Production vault indexing must wait for maintainer approval and stability checks.
