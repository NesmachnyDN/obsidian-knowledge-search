# OKS-02C — Tokenizer-verified structural chunking

Base: `cdd32dc25d3a3d889192262e20498445c7b602f8`. Profile: ITERATION + Document Quality PHASE_CLOSE. Dependency: merged OKS-02A and OKS-02B. Authority: AGENTS, SECURITY, SPEC CAP-03/06/09/10 (AC-03/06/09/10), ARCHITECTURE Data and contracts / Operational and trust boundaries, ROADMAP OKS-02C, ADR-0002/0003/0004, REUSE, DEPENDENCIES, SDD, frozen corpus and extraction experiment.

## Scope

- Read and verify only the already cached BAAI/bge-m3 tokenizer snapshot: exact upstream revision, local file hashes/bytes, MIT model card, tokenizer implementation version, special tokens, untruncated full-input serialization, offline loading and explicit mismatch/failure behavior. No embedding inference or automatic tokenizer/model downloads. A separately reviewed operator preflight is required if artifacts are unavailable.
- Independently implement a typed canonical chunk and slice/locator contract, deterministic identities, original text versus contextual embedding serialization, source digest and extraction status propagation, section and table/cell tracking, oversized splitting without silent truncation, and explicit missing or unverifiable locator diagnostics.
- Compare fixed sliding-window, paragraph-aware, independent structure-aware tokenizer-budget planning, and the real installed Docling HybridChunker with identical canonical parsed inputs. Native output must be aligned and audited against the same source blocks; unalignable text cannot be silently assumed covered. Vary token budgets and overlap policies. Run all policies on frozen generated Markdown, native DOCX and captured verified PDF/scan extraction (or a documented subset with explicit blocker).
- Record source coverage, lost and duplicated original spans, budget violations, prefix size, headings/cross-section boundaries, rows/cells, deterministic identity, wall/RSS/cgroup pressure, recovery and offline behavior; do not mutate accepted 02A/02B results or oracle and do not claim retrieval quality.
- Capture a reproducible runner, unit/negative/host evidence, independent review handoff, and a provisional decision ADR. Update only directly relevant documentation.

## Requirements traceability

| Requirement | Implementation/evidence | Required independent review focus |
|---|---|---|
| CAP-03 / AC-03 | `engine/chunking.py`, exact-BGE-M3 `engine/token_budget.py`, four-policy `benchmarks/chunking/run.py`, 600-case `cases.ndjson` plus `results.json` aggregate, oversized/overlap tests | Original span coverage, contextual full-input budgets, heading boundaries, deterministic identity, native benchmark parity |
| CAP-06 / AC-06 | `SourceSlice`/`SourceLocator`/`Chunk` contracts, `engine/native_chunking.py`, Markdown UTF-8 byte ranges, native original item/geometry/table cell anchors, partial diagnostics | Verify no fabricated PDF/DOCX byte offsets, no false exact-native alignment, distinction from derived embedding strings |
| CAP-09 / AC-09 | `scripts/run_chunking_bounded.py`, Foundation admission reuse, 02B cgroup kernel verification, offline namespace, explicit cancelled-run recovery, peak RSS/cgroup `resource_evidence` | Verify actual cgroup memory/swap/CPU/pids, single process, no automatic heavyweight downloads, pressure cancellation and retained scope |
| CAP-10 / AC-10 | Frozen 02A and original 02B source/manifest SHA checks, stable synthetic stress generator, 72 dependency-free tests (4 conditional skips), 4 real-tokenizer isolated integration tests and 101 Node tests; ADR-0005 | Reproduce manifest, judge lost/duplicate spans, validate exact tokenizer/license and privacy, do not confuse source coverage with retrieval scores |

No downstream retrieval/index modifications or production acceptance are in this PR. Source/reference data are synthetic only.

## Excluded

No OKS-03A inference, retrieval-quality comparison, production Vault/Obsidian writes, model weights provisioning, graph/index schema changes, cloud processing, new model families, unrelated refactors or frozen judgments changes. Do not use Codex.

## Validation / stop gates

- V02C-01: tokenizer identity, checked sha256 and bytes, offline special-token count, mismatch and no-truncation tests; entire contextual input measured including BOS/EOS and contextual prefix.
- V02C-02: source/version-stable chunk IDs and verifiable canonical block character slices; exact byte spans only where original UTF-8 bytes are known, genuine item and table anchors otherwise; diagnosed partial and missing locators; no fabricated evidence.
- V02C-03: negative and regression tests for invalid extraction statuses, oversized clauses/list/table/merged cell, repeated text, heading collisions, prefix-over-budget, no silent loss, determinism and failures.
- V02C-04: actual four-policy, multi-budget/overlap comparison with shared source manifest, resource and offline evidence; distinguish violations/coverage failures in candidates from admissible policy.
- V02C-05: full existing regression, build/type/license, clean diff, exact-head CI, separate-chat independent full-diff review, no merge until recorded APPROVE.

Limits: CPU only, one heavy job, two logical CPUs, cgroup memory.max <=4 GiB, swap.max=0, >=3 GiB host reserve, time/process bounds, network-isolated experiment, only synthetic fixture content. Fail closed if host controls cannot be verified. Reuse Foundation resource primitives and the 02B bounded-extraction runner pattern. Public artifacts English and sanitized. The 02C policy remains provisional pending paired 03B retrieval tests.
