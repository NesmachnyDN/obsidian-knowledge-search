# OKS-03A — BGE-M3 real dense inference experiment

**Status: authorized local CPU-only BGE-M3 reference inference measured; 03A acceptance remains provisional pending remaining phase gates and independent final review; not a plugin or CAP-05.** This is **not** an Obsidian-native search runtime, an installed model, CAP-05 retrieval, or permission to activate heavy inference. Consult [the execution contract](../../docs/prompts/OKS-03A.md) and [ADR-0006](../../docs/adr/0006-standalone-execution-profiles.md).

## Local artifact preflight (metadata/hashes only)

On the ZenBook, an already locally cached BGE-M3 revision `5617a9f61b028005a4858fdac845db406aefb181` was inspected. **No artifacts were downloaded, installed, copied to this repository or loaded into a neural runtime.**

- Local upstream model-card license: MIT. Exact bytes and SHA-256 are pinned in [embedding-artifacts.json](../../engine/embedding-artifacts.json); `pytorch_model.bin` is 2,271,145,830 bytes with SHA-256 `b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38`. Original `config.json` specifies XLM-RoBERTa, hidden dimension 1024, 24 layers and maximum position count 8194.
- The [02C tokenizer manifest](../../engine/tokenizer-artifacts.json) independently pins revision, tokenizer input, MIT model-card text and SHA-256. Exact text serialization remains `bge-m3-heading-lines-v1` (original text plus heading prefix, with BOS/EOS counted, no truncation). Do not confuse 8192 advertised tokens with an experimentally supported inference length.
- Available **optional pre-existing** CPU experiment environment: PyTorch 2.14.1+cpu, Transformers 5.18.0, tokenizers 0.23.3, NumPy 2.5.5, safetensors 0.8.0. These are not dependencies of the default plugin, nor a reviewed distributable lock for Bundled Advanced. The selected pinned model artifact is a PyTorch state-dict binary, not a verified same-revision SafeTensors; model serialization/deserialization and runtime memory remain security and resource gates.
- The installed cgroup v2 exposes memory/cpu/pids controllers, with adequate *observed* free resources for a **preflight**. This is not evidence that 1024-dim real inference fits within the proposed 4 GiB process-tree limit. The measured synthetic CPU-only result is described below; the artifacts still do not form a plugin distribution.

## Candidate modes and boundaries

| Candidate | Evidence | Disposition |
|---|---|---|
| CPU Python reference / opt-in External Backend | Local pinned weights/tokenizer, existing Python CPU libraries, direct offline adapter and guarded experiment launcher prepared | **Measured on synthetic reference inputs**, but not independently reviewed or promoted to Standalone; additional parity/failure-path evidence remains required |
| Browser worker with local WASM/ONNX | No verified BGE-M3 ONNX/WASM artifacts, tokenizer parity, host API/runtime proof or bounded CPU benchmark | **Unavailable; no automatic conversion/download**; candidate must earn its own host+license+resource evidence |
| Plugin-managed Bundled Advanced | 2.27 GB reference weights plus library/runtime closure; no reviewed plugin-compatible package/asset distribution or lifecycle test | **Not selected**. Must verify Obsidian Community Plugin policies, release dimensions, offline asset provisioning and uninstall behavior before proposal |
| Default Standalone | No external Python/service/model by design; lexical-only native plugin implementation occurs at 04A/04B | **Unaffected** by the experimental reference worker |

## Prepared bounded experiment (not executed)

The optional [guarded runner](../../scripts/run_embedding_bounded.py) performs SHA-256 preflight and Foundation cgroup resource admission, denies concurrent experimental scopes, sets 4 GiB process-tree memory, zero swap, two logical CPUs, a bounded timeout, task limit and a network-isolated Linux namespace. The inner worker rechecks effective kernel resource limits and offline interfaces **before** importing the model. All text is fixed, synthetic and not copied into result files. Results would contain aggregate CPU/RSS, vector dimension, norm and repeatability, runtime identity, and explicitly false standalone/hybrid implementation claims.

**The maintainer granted that specific permission on 2026-11-22**, as documented in [OKS-03A](../../docs/prompts/OKS-03A.md#maintainer-authorization--2026-11-22): only cached BGE-M3 CPU inference, <=4 GiB RAM process tree, <=2 logical CPUs, no swap/network, <=180 seconds, single managed job, synthetic data. Each attempt still requires a freshly verified resource preflight and a unique scratch output path outside the repo. In the absence of either authorization or host guards, the code fails closed with `APPROVAL_REQUIRED` or a guard failure. The `--explicit-model-approval` switch acknowledges this specific recorded authorization, not unlimited permission.

```sh
# AUTHORIZED envelope (2026-11-22); actual execution status must be measured separately:
python3 -I -B scripts/run_embedding_bounded.py \
  --python "$PINNED_CPU_PYTHON" \
  --snapshot "$PINNED_BGE_M3_SNAPSHOT" \
  --output "$UNIQUE_SYNTHETIC_RESULT_PATH" \
  --explicit-model-approval
```

Unit tests cover model absence and tampering, license/config identity, bounded numerical validation, refusal to run without approval, simulated effective cgroup limits, strict no-swap/no-network and wrong-scope failure. **These tests do not use fake vectors as a substitute for actual model inference.** The 02C 600-case benchmark is preserved unchanged.

## Actual authorized local experiment — 2026-11-22

This authorized bounded run completed with cached pinned BGE-M3 PyTorch weights and tokenizers, with **no download or model redistribution**. See [aggregate result](results.json); the managed scope was verified inactive after execution. No raw source text or private host paths were published.

- Three fully synthetic RU/EN inputs, genuine `AutoModel` XLM-RoBERTa CLS vectors (1024 dimensions), L2 norm 1.0, exact repeat (maximum absolute difference 0.0); no hash or simulated embedding.
- Model-load wall time 9.445 s; warm embedding median 208.36 ms and maximum 263.09 ms. This tiny sample is **not** a throughput/quality benchmark.
- Process RSS peak 1,868,856 KiB (~1.78 GiB); effective kernel `memory.max` 4,294,967,296 bytes, `memory.swap.max` 0 and `pids.max` 128; zero OOM/high/max/kill events. Cgroup `memory.peak` 623,337,472 bytes is **lower than process RSS**; attribution/cached-page accounting differs, so do not equate these counters or base memory acceptance solely on one of them.
- Offline network namespace, two CPU affinity; no heavy process left running. Actual pressure/cancellation scenario was not provoked in this initial successful run.

A second independent bounded CPU run, after adding an in-process HuggingFace fast-tokenizer vs 02C Tokenizers ID parity gate (including Cyrillic, technical IDs and Unicode), also completed successfully. [Parity result](results-parity.json): the actual model runtime tokenizer agreed with the pinned 02C encoding; model load 10.539 s, embedding median 162.81 ms, max 205.02 ms, process peak RSS 2,157,020 KiB (~2.06 GiB), cgroup peak 967,852,032 bytes, no OOM/pressure events and exactly repeated vector. The cgroup/RSS accounting disparity persists, and both counters are retained. No standalone or quality gate is inferred from these short synthetic runs.

This proves only an isolated opt-in **Python reference CPU candidate**. It does not prove Bundled Advanced distribution, a JS/WASM runtime, Standalone search, retrieval-quality acceptance, or all error modes. The final independent reviewer must assess 03A and 03B in the same aggregate exact-HEAD diff.

## Unmet adoption gates

A successful phase exit now requires additional runtime/tokenizer parity and failure/pressure/cancellation evidence, 03B real-hybrid frozen-corpus retrieval quality and index-generation/provenance checks, host feasibility comparison, and **one final independent exact-HEAD full-phase review**. No current document, unit test or CI status shall be interpreted as satisfying these gates.
