# OKS-03A — BGE-M3 real dense inference experiment

**Status: candidate implementation and read-only artifact preflight; real model inference not yet executed at this checkpoint, CAP-04 not accepted.** This is **not** an Obsidian-native search runtime, an installed model, CAP-05 retrieval, or permission to activate heavy inference. Consult [the execution contract](../../docs/prompts/OKS-03A.md) and [ADR-0006](../../docs/adr/0006-standalone-execution-profiles.md).

## Local artifact preflight (metadata/hashes only)

On the ZenBook, an already locally cached BGE-M3 revision `5617a9f61b028005a4858fdac845db406aefb181` was inspected. **No artifacts were downloaded, installed, copied to this repository or loaded into a neural runtime.**

- Local upstream model-card license: MIT. Exact bytes and SHA-256 are pinned in [embedding-artifacts.json](../../engine/embedding-artifacts.json); `pytorch_model.bin` is 2,271,145,830 bytes with SHA-256 `b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38`. Original `config.json` specifies XLM-RoBERTa, hidden dimension 1024, 24 layers and maximum position count 8194.
- The [02C tokenizer manifest](../../engine/tokenizer-artifacts.json) independently pins revision, tokenizer input, MIT model-card text and SHA-256. Exact text serialization remains `bge-m3-heading-lines-v1` (original text plus heading prefix, with BOS/EOS counted, no truncation). Do not confuse 8192 advertised tokens with an experimentally supported inference length.
- Available **optional pre-existing** CPU experiment environment: PyTorch 2.14.1+cpu, Transformers 5.18.0, tokenizers 0.23.3, NumPy 2.5.5, safetensors 0.8.0. These are not dependencies of the default plugin, nor a reviewed distributable lock for Bundled Advanced. The selected pinned model artifact is a PyTorch state-dict binary, not a verified same-revision SafeTensors; model serialization/deserialization and runtime memory remain security and resource gates.
- The installed cgroup v2 exposes memory/cpu/pids controllers, with adequate *observed* free resources for a **preflight**. This is not evidence that 1024-dim real inference fits within the proposed 4 GiB process-tree limit. No peak RSS/latency/embedding result has yet been measured.

## Candidate modes and boundaries

| Candidate | Evidence | Disposition |
|---|---|---|
| CPU Python reference / opt-in External Backend | Local pinned weights/tokenizer, existing Python CPU libraries, direct offline adapter and guarded experiment launcher prepared | **Model-backed inference unverified** pending explicit operator permission, cgroup kernel checks, actual run and independent review; never required for Standalone |
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

## Unmet adoption gates

A successful phase exit requires measured actual BGE-M3 CLS-vector inference and tokenizer parity, repeatability, 1024-dimensional finite normalized vectors, effective token policy, no automatic download/network, single-worker resource/pressure/cancel/rollback evidence, host feasibility comparison, and an independent exact-HEAD PR review. No current document, unit test or CI status shall be interpreted as satisfying these gates.
