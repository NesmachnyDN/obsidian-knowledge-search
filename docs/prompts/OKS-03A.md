# OKS-03A — BGE-M3 offline model runtime and feasibility

**Base:** `6011110b9303f5eb850de9c5d8179d200f403451` (merged OKS-03-ARCH PR #9). **Target:** `develop`. **SDD profile:** ITERATION. **Dependency:** accepted ADR-0006 and frozen OKS-02C tokenizer/benchmark.

## Authority

AGENTS.md, SECURITY.md, docs/development/SDD.md, docs/SPEC.md CAP-04/09 (AC-04/09), CAP-03/06 source semantics, docs/ARCHITECTURE.md, docs/ROADMAP.md, ADR-0001–0006, docs/REUSE.md, docs/DEPENDENCIES.md, contracts/portable-model.md, OKS-02C contract, 600-case chunking evidence. This experiment **does not** implement the default Obsidian-native Standalone and does not establish CAP-05 hybrid.

## Scope and acceptance

1. Audit existing BGE-M3 tokenizer-only snapshot and cached weight provenance, exact revision, immutable SHA-256 and license; no downloading, copying or bundling weights, no unreviewed optional dependency.
2. Implement narrow, opt-in **Python reference backend** for actual model-backed dense-only inference, completely separate from the plugin-native Standalone and synthetic probe. Verify full contextual token input including special tokens, exact tokenizer parity with 02C, no truncation, 1024-dimensional finite vectors, L2 normalization, deterministic repeated inputs, explicit errors and model-space identity. Any inference result must come from pinned actual weights; no fake/hash vectors.
3. Run real model benchmark under the **explicit maintainer permission recorded below** and a freshly verified resource preflight, in a single dedicated Linux systemd transient cgroup scope with <=4 GiB memory, zero swap, <=2 logical CPUs, <=128 tasks, <=180 seconds per attempt, no network, no Vault access and cancellation on pressure. Verify effective kernel limits before model import. Permission is restricted to this synthetic BGE-M3 retrieval experiment, not a general override.
4. Evaluate standalone-compatible browser/WASM/ONNX candidate feasibility and plugin-managed bundled candidate (host APIs, tokenizer parity, model size/license, plugin distribution policy and CPU resources), without assuming Node itself is an independently installed runtime. Unproven candidate is marked unavailable, not represented as working.
5. Use only synthetic test texts and the frozen corpus. Preserve existing 02A/02B/02C artifacts, v1 probe, original evidence and index contracts. No production indexing, deployment, network endpoint or unconsented source processing.
6. Record measured CPU/RSS/latency, repeatability, vector norms, tokenizer length, model-missing/error/pressure/cancel recovery and offline status in synthetic aggregate-only evidence. Do not declare acceptance if actual model weights/inference permission/host guards are unavailable.

## Mandatory tests

- Dependency-free unit tests for missing/wrong snapshot, SHA mismatch, invalid model/card, bounds, dimension/NaN/zero/norm failures, identity, no silent truncation, malformed input, offline guard and no-auto-download behavior.
- Optional real-inference integration suite under explicit host scope only, with pinned licensed model and exact installed runtime versions, including 02C serialization parity, deterministic vectors and resource accounting.
- Existing Node/Python regressions, typecheck, licenses, build, `git diff --check`, exact-HEAD CI, independent full-diff review by a **separate reviewer**. Heavy integration unavailable means an explicit **unmet exit gate**, never a green 03A.
- Under the explicitly authorized aggregated Retrieval PHASE_RUN, **do not merge the 03A checkpoint separately**: integrate 03B commits on the same candidate branch and perform exactly one independent full-phase exact-HEAD review before the final merge.

## Out of scope

No 03B retrieval/fusion, no plugin-native 04A search, no production Vault/config writes, no cloud inference, no model downloads, no packaged Python interpreter, no automatic backend, no unrelated runtime upgrade or locked historical benchmark changes.

## Delivery

Use the existing Draft PR #10 as the **aggregated Retrieval candidate**, incorporating separately traceable OKS-03A and OKS-03B checkpoints under the maintainer-authorized exception in SDD. Keep the PR Draft until all 03A and 03B measured gates pass; only then request one separate-chat independent full-diff review covering the aggregate diff and merge once to develop. No implementation-chat self-review.

## Maintainer authorization — 2026-11-22

The maintainer expressly authorized a **local heavy BGE-M3 CPU-only inference experiment** in the current Retrieval PHASE_RUN, using the **already cached** weight/tokenizer artifacts pinned by `engine/embedding-artifacts.json` and `engine/tokenizer-artifacts.json`. Permitted envelope per experimental attempt: **entire process tree RAM <= 4 GiB; maximum two logical CPU cores; swap disabled; no external network; hard timeout 180 seconds; <=128 tasks; single managed heavy job**. The existing bounded wrapper and its kernel-level guards must verify cgroup, network namespace, affinity, available host reserve (>=3 GiB), free disk, provenance, and absence of concurrent heavy jobs *before* import. If any guard fails, abort and retain partial diagnostic evidence without claiming model validation. Only synthetic test data are permitted. This authorization **does not** permit downloads, runtime installation/upgrades, production Vault access, model packaging, or bypass of the final SDD review.

The same maintainer explicitly requested **one independent full-phase review at the end of Retrieval, immediately before the single merge into develop**, rather than independent reviews and merges per intermediate slice. This is a phase-specific SDD workflow exception: one cumulative Draft PR, individually auditable 03A/03B checkpoints, uninterrupted tests/CI and benchmark gates, one exact-base/exact-HEAD full-diff review by a genuinely separate session/human, and one final squash merge only after APPROVE. A different tab in the same authoring conversation is not independent.
