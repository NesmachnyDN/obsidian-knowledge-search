# OKS-05B — candidate local stdio Advanced health-only bridge validation

**Date:** 2026-11-23. **Review status:** author/orchestrator evidence only, **not independent APPROVE**, **not Advanced Gate B**. **Base:** `990d82c11162e88701284b2af8469163480d26f8` (05A squash merge). **Feature branch:** `feat/oks-05b-advanced-execution`. Pin exact HEAD and CI separately in GitHub Draft PR before external review. Only synthetic disposable Vault/profile and test workers used. No real production Vault, model loading, private document transfer or runtime downloads.

## Architectural decision and implementation boundary

ADR-0009 proposes explicit optional External Backend over private local stdio for this slice. Installed default Standalone is still Obsidian plus the same three package assets, offline Markdown lexical; no Python/OCR/model dependencies are installed or started by default. Schema-v3 settings migrate schema-v2 with Advanced disabled, requiring **explicit opt-in** and trusted local executable/entry paths. Backend transport reads no source and accepts only fixed-shape Python v2 `health` with random nonce. Its state is exposed as `advancedTransport`; dense/hybrid remain **unavailable** and intentionally fail closed, including `executedMode:none`. This is not a PDF/OCR, retrieval, model identity, evidence or user-ready Advanced profile.

The selected synthetic lightweight backend entry is the repository's pre-existing `engine/persistent.py`, not a new Python runtime distribution. BGE-M3 bundle/ONNX selection remains unsupported: snapshot weight size is 2,271,145,830 bytes and there is no approved plugin-compatible runtime distribution or resource evidence. Do not promote 03A/03B reference results as Obsidian-integrated functionality.

## Independently measurable validation (author session, not independent reviewer)

| Check | Result |
|---|---|
| `npm test` | **PASS: 193/193**, including two new plugin lifecycle/reload tests and 11 direct health-bridge tests; previous 04A/04B regressions retained |
| `npm run test:python` | **PASS: 124, 5 pre-existing skips**, reference-only |
| `npm run typecheck` / `npm run build` / `npm run licenses` | **PASS** |
| `npm run test:package` | **PASS: 10/10**, after rebuilding and safely replacing only prior verified generated ignored package assets |
| `npm run benchmark:standalone` | **PASS** against unchanged frozen synthetic corpus; run-specific tracked results restored |
| `git diff --check` | **PASS** before handoff |
| `unshare -Urn node --test .test-build/advanced-health.test.js` | **PASS 11/11**, including true local v2 health, malicious framing, cancellation and SIGTERM-resistant process |
| `OKS_ADVANCED_HEALTH_TEST=1 ... unshare -Urn bash scripts/obsidian-host-smoke.sh` | **PASS** with actual Obsidian Desktop/CLI **1.15.1** and current release-shaped package, isolated synthetic Vault, no external route |
| Default Standalone package-only `unshare -Urn bash scripts/obsidian-host-smoke.sh` | **PASS** in same real host, no Advanced opt-in |
| GitHub exact-HEAD CI / independent separate-session full-diff review | **PENDING** until Draft PR creation and distinct reviewer handoff |

### Real host observations

The final opt-in offline run emitted `OBSIDIAN_ADVANCED_HEALTH_PASS`, `OBSIDIAN_UI_SMOKE_PASS`, `OBSIDIAN_HOST_SMOKE_PASS`, `OBSIDIAN_HOST_STORAGE_PASS`, and `OBSIDIAN_HOST_CLEAN_REMOVAL_PASS` with exit code 0. Explicit transport admission, nonce-correlated real Python stdio exchange, metadata-only API status/diagnostics, backend disable and PID cleanup succeeded. Importantly, attempted hybrid was rejected with no lexical fallback mislabeled as hybrid; the existing native lexical search and exact navigation still worked.

Native UI observation on the opt-in fixture: query p50/p95 **30.60/30.70 ms**, max sampled event-loop tick delay **0.50 ms**. Default package-only offline host: p50/p95 **30.60/30.80 ms**, max tick delay **0.40 ms**. These small synthetic observations are not production tail-latency or memory SLA guarantees. Both retained native parser Web Worker and generation reload behavior and source preservation after disposable package uninstall.

The new 05B three-asset package contains `main.js`, `manifest.json`, `standalone-worker.js`; `main.js` SHA-256 as of pre-PR validation: `9044ea0affb650b431e2bc9035814a24d6dad9a5267d74cb848ff54a7d56f94b`. A separate SHA-256 inventory is adjacent to, not inside, the installed plugin. This unsigned inventory is not a publisher signature.

### Pinned local model preflight, not inference

Fresh read-only SHA-256 checks against `engine/embedding-artifacts.json` and `engine/tokenizer-artifacts.json` confirmed **all declared files** under the cached BGE-M3 snapshot revision `5617a9f61b028005a4858fdac845db406aefb181`: 2,271,145,830-byte weight file SHA-256 `b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38`, config/model-card and tokenizer.json, tokenizer_config.json, special_tokens_map.json and sentencepiece.bpe.model hashes all matched. No model deserialization, tokenization/inference or BGE process was launched in 05B. Actual model readiness and resource admission remain 05D obligations.

### Security and resource notes

- The ZenBook preflight observed approximately 15 GiB RAM, 9 GiB available, 11 GiB swap and 59 GiB available disk. 05B starts only a small **health-only** interpreter. Real BGE memory/CPU/cgroup controls are **not** in this slice and cannot be claimed.
- Trusted path preflight rejects symlinks, nonregular/multiply-linked files and world-writable paths; only owned root/user files or restricted rootless namespace unmapped owner cases are allowed. For the existing group-writable user-owned development tree, the policy treats the caller's UID/GID as trusted. In verified `unshare -Urn` with single UID map, unmapped read-only system paths appear as UID 65534 and are admitted only when not group/world writable. This is a **same-user trust assumption**, not inode-pinned TOCTOU protection or isolation against a hostile local account. Reviewer should examine these choices carefully.
- The code uses `shell:false`, `python -I -B`, minimal environment, stdio-only bounded health frames, metadata-only diagnostics, deadline and process-group TERM/KILL on disable/unload. Synthetic negative tests exercise missing/unsafe paths, duplicate/oversized/bad UTF-8 frames, foreign nonce, crash, stderr flood, SIGTERM resistance, restart and reload.
- Prior host test iterations identified and corrected (a) a UI-test ordering issue after deliberate failed hybrid cleared selected results and (b) rootless user namespace UID mappings that previously rejected trusted root-owned interpreter paths. Final exact-package offline runs and 11 namespace tests succeeded. No production Vault was used.
- Remaining mandatory boundaries: full cross-language source/evidence schema, PDF/DOCX/OCR provenance, bounded and authenticated source transport, model-admission/cgroup isolation and full process descendant stress under resource pressure; real dense/lexical/hybrid, frozen quality comparison, Knowledge AI incumbent protocol and full two-gate acceptance are **NOT RUN**. The 05B PR must remain Draft until a separate independent reviewer validates its exact HEAD and CI.

**Acceptance interpretation:** OKS-05B is a bounded implementation **candidate**, not merged feature or full MVP gate. The independent reviewer must challenge transport path trust, process lifecycle/reload isolation, out-of-band failures and type/setting migration before authorizing merge.
