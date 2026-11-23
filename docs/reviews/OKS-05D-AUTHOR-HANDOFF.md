# OKS-05D — Author handoff / independent full-diff SDD review

**Status: AUTHOR_CANDIDATE — independent exact-HEAD review and merge are pending.** This document describes author verification and never authorizes self-approval, Ready transition or merge. Exact HEAD must be taken from the published Draft PR metadata; do not embed a self-referential commit hash inside this committed file.

## Governance and diff boundary

- Repository: `NesmachnyDN/obsidian-knowledge-search`; branch `feat/oks-05d-verified-retrieval`; base `develop` = `bd60b5fd42eecdbd21fda9dac2af92e00c106b09` (merged OKS-05C PR #16), unless independently verified remote `develop` has advanced.
- Read `AGENTS.md`, `SECURITY.md`, `docs/development/SDD.md`, `docs/SPEC.md` CAP-02–10 / AC-02–10, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/DEPENDENCIES.md`, `docs/REUSE.md`, ADR-0001–0009, proposed ADR-0014, and account for still-unmerged PR #15 reserving ADR-0010–0013, `docs/prompts/OKS-05D.md`, `contracts/advanced-ingestion-v1.md` (v3), `contracts/advanced-retrieval-v1.md` (v4), `contracts/portable-model.md` and test fixtures before reviewing.
- Review the **full exact Base..HEAD diff** (not only later fixes). PR #15 may exist independently: do not merge it into this scope implicitly. New commits invalidate an earlier review and require a new full-diff review.

## Scope and architecture

- **AC-04**: `engine/advanced_retrieval.py` is a strict v4 model *worker* only; uses the existing real BGE-M3 reference, a previously downloaded immutable local model and tokenizer snapshot, exact pinned fingerprints, CPU-only PyTorch/Transformers, CLS/L2 normalized 1024D vectors. `plugin/src/advanced/model-protocol.ts` strictly validates exact model and runtime identity, dimension/norm/finite values and canonical v4 request-response framing. `plugin/src/advanced/runner.ts` reuses the 05C cgroup supervisor (4GiB memory; swap0; 200% CPU; 64 tasks; AF_UNIX only; host reserve; whole-unit cancellation). No synthetic vectors are sent from production to clients. No automatic downloads or hosted API are used.
- **AC-05**: `plugin/src/advanced/retrieval.ts` independently performs lexical technical-ID matching, true model-backed dense similarity and RRF with k=60 and canonical chunk ID ties. Both legs expose explicit status, scores and rank; missing dense never silently becomes hybrid. Typed Properties and Vault-relative scope run before top-K. Synthetic unit vectors appear **only in tests** of ranking and persistence, never in real-model acceptance.
- **AC-06/08/09**: `plugin/src/advanced/retrieval-storage.ts` binds ordered vectors to authoritative v3 source hashes, ingestion generation IDs, canonical chunk IDs and strict model identity in a separate immutable private XDG generation; atomic stage/fsync/CURRENT, cold-read validation, corrupt pointer refusal and source event revocation. Original source excerpts, native locations, table-cell provenance and `partial` extraction semantics are projected directly from 05C v3 chunks, never model contextual text. An unverifiable locator produces no invented hit. `plugin/src/advanced/retrieval-manager.ts` coordinates source freshness checks, compatibility and revocation, cancellation and query mode integrity. No writes inside original Vault.
- **AC-07**: supported Obsidian modal/settings/commands for opt-in Advanced ingestion, index/rebuild active authorized TFile, query in lexical/dense/hybrid, typed filters, status, verified navigation, cancel and disable with automatic Standalone regression. Obsidian native PDF/DOCX opening is supported; public Obsidian API does not guarantee native page/cell selection, and no selection is fabricated.
- **AC-10**: local synthetic RU+EN end-to-end metrics and frozen v3 fixture regressions, real host Desktop acceptance; no production user notes, credentials, vectors, private host paths, licenses or model weights in GitHub. No new production npm dependency.

## Validated on isolated synthetic host (author evidence, not independent approval)

The author previously completed a real offline CPU-model worker and four-mode end-to-end run on a pinned local BGE-M3 snapshot with two Markdown source versions and 4 document vectors. Source indexing measured ~13–17s each; a cold query embedding measured ~11–12s. The tiny four-query synthetic test had Recall@5=1, MRR=1, nDCG@5=1 and exact hit rate=1; **not statistically meaningful and NOT evidence of superiority over lexical**. Real RAM observed around 2.4GiB process RSS; host unit enforced MemoryMax=4GiB, CPUQuota=200%, TasksMax=64, swap disabled. A later host acceptance also exercised native PDF and DOCX plus local Tesseract RU+EN scanned PDF.

- Final author full `npm test`: **222 total, 218 pass, 4 opt-in skip, 0 fail** (a separate explicit model test and 05C cgroup tests executed on the actual host).
- `npm run test:python`: **138 total, 133 pass, 5 skip**. `npm run typecheck`, `npm run build`, `npm run licenses`, `npm run test:package` (**10/10**), `npm run benchmark:standalone` and `git diff --check` **all passed in the final author command chain**. The previous package and its attestation were preserved, the exact-candidate package was byte verified, and tracked benchmark output restored.
- Real 05D model-backed end-to-end host suite: **1/1 PASS**, including real 1024D inference, original evidence, RU/EN lexical/dense/hybrid, source identity, source mutation during active model inference (explicit `SOURCE_STALE`, no hits), corrupt CURRENT and cold recovery. No real model-workload process remained after completion.
- Frozen, real BGE-M3 4-query RU/EN paired mode metrics on the same two-source mini-corpus at K=5: lexical Recall=0.75/nDCG=0.75/MRR=0.75/exact-ID top-1=1; dense and hybrid each Recall=1/nDCG=1/MRR=1/exact-ID top-1=1. This is a **small deterministic smoke sample, not a statistically meaningful or deployment-grade lexical baseline comparison**; full held-out retrieval quality remains an independent acceptance risk.
- Real 05C host adversarial suite: **3/3 PASS**; native Markdown/PDF/DOCX/RU+EN OCR, midflight mutation, corrupt PDF and CURRENT, SIGTERM-resistant detached descendant and concurrent cancellation; no leftover runnable worker.
- `npm` synthetic retrieval and v4 protocol tests include missing model/dense leg, false-ready prevention, source generation mismatch, invalid or forged vectors/locators, original evidence, Unicode technical IDs, deterministic RRF ties and typed filters. Durable index tests cover staging crash, canceled publication, symlinked pointer, cold restart and folder revocation.
- Real Obsidian Desktop/CLI **1.15.1** under isolated `unshare -Urn` (no external routes): **Contour 1** clean package-only Standalone passed all `OBSIDIAN_UI_SMOKE_PASS`, `OBSIDIAN_HOST_SMOKE_PASS`, `OBSIDIAN_HOST_STORAGE_PASS`, `OBSIDIAN_HOST_CLEAN_REMOVAL_PASS`; **Contour 2** Advanced passed `OBSIDIAN_ADVANCED_INGESTION_PASS`, `OBSIDIAN_ADVANCED_RETRIEVAL_PASS`, and all host lifecycle markers. Four formats: Markdown `ok`, native PDF `partial`, native DOCX `partial`, scanned PDF RU+EN OCR `partial`; four indexed sources / ten real BGE-M3 chunks; real lexical/dense/hybrid, RRF, verified Markdown source open, changed-source revocation, Advanced disable, Standalone unaffected. Neither contour used the actual user Vault.

## Independent review reproduction

Run ALL relevant standard gates against the **exact PR HEAD**: `npm test`, `npm run test:python`, `npm run typecheck`, `npm run build`, `npm run licenses`, `npm run test:package`, `npm run benchmark:standalone`, `git diff --check`. Preserve immutable prior package and its attestation before rebuilding `build/standalone-package`; restore generated `benchmarks/standalone/results.json` after run. No unrelated overwrites/deletions.

Real BGE-M3 host test (separate reviewed, previously provisioned local Python/weights/tokenizer and OCR data; no download):

```shell
OKS_05D_REAL_MODEL=1 OKS_05C_PYTHON="$TRUSTED_PYTHON" \
  OKS_05C_TOKENIZER_SNAPSHOT="$TRUSTED_BGE_M3_SNAPSHOT" \
  OKS_05C_TESSDATA="$TRUSTED_RU_EN_TESSDATA" \
  node --test .test-build/advanced-retrieval-host.test.js
```

Real cgroup/adversarial host test:

```shell
OKS_05C_REAL_CGROUP=1 OKS_05C_PYTHON="$TRUSTED_PYTHON" \
  OKS_05C_TOKENIZER_SNAPSHOT="$TRUSTED_BGE_M3_SNAPSHOT" \
  OKS_05C_TESSDATA="$TRUSTED_RU_EN_TESSDATA" \
  node --test .test-build/advanced-cgroup-host.test.js
```

Use `OKS_HOST_NO_ROUTE=1` and `scripts/obsidian-host-smoke.sh` in **two separate** disposable-Vault/XDG runs. Standalone: `OKS_STANDALONE_PACKAGE_DIR="$PWD/build/standalone-package"`. Advanced: same package path plus `OKS_ADVANCED_INGESTION_TEST=1 OKS_ADVANCED_RETRIEVAL_TEST=1 OKS_HOST_TIMEOUT_SECONDS=420` and the three trusted offline artifact variables. Verify all `OBSIDIAN_*_PASS` markers, exact process exit 0 and no lingering `oks-ingest-*.service` workers. Capture actual unit RSS/CPU, no-route namespace and application version; do not report a scenario PASS based on partial markers.

## Open issues and review priorities

1. **Model cold startup:** 11–12s per query on the tested CPU; RAM ~2.4GiB at ~4GiB cgroup cap; no responsive/hot-cache guarantee. Strict profile is one active dense model and at most 32 indexed sources, 64 chunks/source, 256 vectors in the initial 05D bounded slice.
2. **Retrieval quality:** four-query measures are a smoke demonstration, not substantive comparison with frozen OKS-03B/02A lexical benchmark or incumbent. Reviewer must assess whether AC-10 corpus gate is satisfied; do not claim quality gains.
3. **Security high priority:** v4/Python-TS canonical parity, cgroup admission and whole-tree stop under SIGTERM-resistant descendants, partial stages, same-host symlink/path races, mid-flight source mutation, model identities and source/embedding generation alignment, proper `not-ready/unavailable/failed/ready` semantics. Check that no fields or raw private paths leak into public status, CI or PR reports.
4. **PDF/DOCX limitations:** partial native table/page fidelity is inherited from v3; unsupported native selection must not be presented as exact navigation. `originalExcerpt` must always derive from an authenticated original v3 chunk/cell, never contextual embedding text.
5. **No self approval**: this author session must leave PR Draft. Separate fresh ChatGPT reviewer verifies exact Base and HEAD, checks every changed file, reproduces actual offline host validation, and posts `APPROVE` or file:line-grounded `REQUEST CHANGES` in PR Conversation. Only independent approval, successful exact-HEAD CI, no blockers and explicit required gates permit Ready/squash merge by the authorized workflow.
