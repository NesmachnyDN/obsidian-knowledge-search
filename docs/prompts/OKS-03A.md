# OKS-03A — BGE-M3 offline model runtime and feasibility

**Base:** `6011110b9303f5eb850de9c5d8179d200f403451` (merged OKS-03-ARCH PR #9). **Target:** `develop`. **SDD profile:** ITERATION. **Dependency:** accepted ADR-0006 and frozen OKS-02C tokenizer/benchmark.

## Authority

AGENTS.md, SECURITY.md, docs/development/SDD.md, docs/SPEC.md CAP-04/09 (AC-04/09), CAP-03/06 source semantics, docs/ARCHITECTURE.md, docs/ROADMAP.md, ADR-0001–0006, docs/REUSE.md, docs/DEPENDENCIES.md, contracts/portable-model.md, OKS-02C contract, 600-case chunking evidence. This experiment **does not** implement the default Obsidian-native Standalone and does not establish CAP-05 hybrid.

## Scope and acceptance

1. Audit existing BGE-M3 tokenizer-only snapshot and cached weight provenance, exact revision, immutable SHA-256 and license; no downloading, copying or bundling weights, no unreviewed optional dependency.
2. Implement narrow, opt-in **Python reference backend** for actual model-backed dense-only inference, completely separate from the plugin-native Standalone and synthetic probe. Verify full contextual token input including special tokens, exact tokenizer parity with 02C, no truncation, 1024-dimensional finite vectors, L2 normalization, deterministic repeated inputs, explicit errors and model-space identity. Any inference result must come from pinned actual weights; no fake/hash vectors.
3. Run real model benchmark **only after an additional explicit permission and resource preflight** under a single dedicated Linux systemd transient cgroup scope with <=4 GiB memory, zero swap, <=2 logical CPUs, bounded tasks/time, no network, no Vault access and cancellation on pressure. Verify effective kernel limits before model import. Do not run a heavy experiment merely because the artifacts happen to be cached.
4. Evaluate standalone-compatible browser/WASM/ONNX candidate feasibility and plugin-managed bundled candidate (host APIs, tokenizer parity, model size/license, plugin distribution policy and CPU resources), without assuming Node itself is an independently installed runtime. Unproven candidate is marked unavailable, not represented as working.
5. Use only synthetic test texts and the frozen corpus. Preserve existing 02A/02B/02C artifacts, v1 probe, original evidence and index contracts. No production indexing, deployment, network endpoint or unconsented source processing.
6. Record measured CPU/RSS/latency, repeatability, vector norms, tokenizer length, model-missing/error/pressure/cancel recovery and offline status in synthetic aggregate-only evidence. Do not declare acceptance if actual model weights/inference permission/host guards are unavailable.

## Mandatory tests

- Dependency-free unit tests for missing/wrong snapshot, SHA mismatch, invalid model/card, bounds, dimension/NaN/zero/norm failures, identity, no silent truncation, malformed input, offline guard and no-auto-download behavior.
- Optional real-inference integration suite under explicit host scope only, with pinned licensed model and exact installed runtime versions, including 02C serialization parity, deterministic vectors and resource accounting.
- Existing Node/Python regressions, typecheck, licenses, build, `git diff --check`, exact-HEAD CI, independent full-diff review by a **separate reviewer**. Heavy integration unavailable means an explicit **unmet exit gate**, never a green 03A.
- No merge until real model-backed evidence, acceptable resource/runtime comparison, independent APPROVE and checks exist.

## Out of scope

No 03B retrieval/fusion, no plugin-native 04A search, no production Vault/config writes, no cloud inference, no model downloads, no packaged Python interpreter, no automatic backend, no unrelated runtime upgrade or locked historical benchmark changes.

## Delivery

Create a bounded Draft PR into develop with exact base/HEAD, source/model manifests, actual test results and limitations. After independent review and all measured gates, the authorized orchestrator may squash merge. An unapproved heavy experiment or missing separate reviewer keeps PR Draft and Retrieval PHASE_CLOSE blocked.
