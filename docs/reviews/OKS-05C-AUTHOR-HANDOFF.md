# OKS-05C — Author handoff for independent full-diff SDD review

**Delivery state:** author implementation and reproducible acceptance; **DRAFT PR pending independent review and exact-HEAD CI**. This handoff is not an independent approval. Independent reviewer shall pin exact current PR HEAD after fetch; no merge permitted on author self-verification.

## Base, governance, review boundaries

- Base `develop` commit after merged OKS-05B PR #14: `f94f65809669d648df674c8a66272942d7cb952b`.
- Branch `feat/oks-05c-canonical-ingestion`; review exact HEAD as shown by `git rev-parse HEAD` and GitHub REST on opening the Draft PR.
- Read AGENTS.md, SECURITY.md, docs/{SPEC,ARCHITECTURE,ROADMAP,DEPENDENCIES,REUSE}.md, docs/development/SDD.md, contracts/portable-model.md, ADR-0001–0009, docs/prompts/OKS-05B.md and docs/prompts/OKS-05C.md before reviewing. Compare **full base..HEAD**. Check no change to controlled ADRs, Standalone source/worker/search implementation or approved architecture.
- This is author verification, **not** a claim that requirements CAP/AC gates or independent review are complete. Do not mark Ready or merge until independently retested and approved.

## What is implemented

1. Strict, independently validated production **v3 document ingestion wire** (separate from health-only v2 and Standalone API): Python `engine/advanced_protocol.py` and TS `plugin/src/advanced/protocol.ts`, canonical byte framing, duplicate/unknown-field/UTF-8/version rejection, source identity, source version, typed Properties, wiki-links, heading hierarchy, exact source slices, native page/geometry and table-cell anchors, original-vs-contextual chunks, generation identity and error/status semantics. Shared canonical fixtures at `contracts/fixtures/advanced-ingestion-v1.json`; contract authority in `contracts/advanced-ingestion-v1.md` and `contracts/portable-model.md`. This stage **does not emit ranked EvidenceHits**, and does not claim retrieval generation or model readiness.
2. Real local Python `engine/advanced_ingest.py` worker using existing Docling 2.151.1, native Markdown, DOCX/PDF and explicit local Tesseract RU/EN OCR, existing exact-token BGE-M3 structural chunker and scoped descriptor-relative reader. **No fallback** to a different format/profile, no library downloads. Native incomplete structures and OCR layout report `partial`.
3. Obsidian opt-in `ingest-active-advanced-source`, profile fields and settings/status, `AdvancedIngestionManager`, TS raw-source provenance verifier, concurrent one-at-a-time `AdvancedIngestRunner` using `systemd-run` cgroup v2 memory4GiB/swap0/CPU200%/pids64/time120s, AF_UNIX-only, whole tree cancellation, refusal on unverified resource preflight and malformed response. Only active vault TFile accepted; read source uses O_NOFOLLOW and double stat. No backend at default Standalone startup.
4. Separate private generation snapshots under XDG outside the Vault; checksummed immutable generation and fsync+atomic `CURRENT` update; restart/rehydration checked; stale and corrupt generated evidence rejected. No modification of native Standalone index/identity or search modes. Dense/hybrid always explicit `CAPABILITY_UNAVAILABLE` with `executedMode:none`.

## Synthetic tests and measured results (author, ZenBook)

- `npm test` currently 210 total / 207 passed / 3 skipped (three host cgroup tests require explicitly enabled environment); `npm run test:python` 133 total / 128 passed / 5 skipped; `npm run typecheck` passed.
- `npm run build`, `npm run licenses`, `npm run test:package` (10/10), `npm run benchmark:standalone`, `git diff --check` passed in recorded author runs. Immutable prior package was verified and preserved under separate build/standalone-package-baseline-f94f6580 before generating a new 05C package. No modifications to historic benchmark baseline retained.
- Real isolated Python worker test: Markdown ok 8 blocks/2 chunks; native PDF partial 13/1; DOCX partial 11/6; RU/EN scanned PDF partial 2/2. No claim of universal layout/table/OCR fidelity.
- Cross-language real Node→systemd-run→Python→Node tests show 4 formats; private generation cold recovery; stale source refusal; corrupt CURRENT refusal; explicit bounded process tree. A separate adversarial script creates a **SIGTERM-resistant descendant in another session** and tests simultaneous stop and concurrent process admission; confirms no runnable descendants.
- **Obsidian Desktop/CLI 1.15.1** in disposable Vault and separate XDG profile under `unshare -Urn` with no external routes: standalone package-only smoke PASS and Advanced opt-in host smoke PASS. Advanced: `first.md:ok:5` blocks, `policy.pdf:partial:13`, `policy.docx:partial:11`, `scan.pdf:partial:2`; stale evidence rejected, dense/hybrid unavailable, opt-in disable and Standalone navigation/reload preserved. No real user Vault or external AI service.

## Reproduce locally without downloading models

1. Prefer a **separate synthetic Vault and isolated profile**. Re-run standard commands at repository root:
   `npm test`; `npm run test:python`; `npm run typecheck`; `npm run build`; `npm run licenses`; `npm run test:package`; `npm run benchmark:standalone`; `git diff --check`.
   When rerunning `test:package`, package creation is intentionally immutable and refuses replacing an older build. First `node scripts/standalone-package.mjs verify build/standalone-package`; preserve any old package under a new read-only named directory inside ignored `build/` and move its corresponding `.sha256.json` sidecar, **never overwrite or delete other sessions' artifacts**.
2. Verify local trusted offline artifacts and **resource reserve** before the heavy tests. Set `OKS_05C_PYTHON` to a reviewed, local absolute Python executable with Docling 2.151.1; `OKS_05C_TOKENIZER_SNAPSHOT` to the trusted, already-installed, version-pinned BGE-M3 tokenizer snapshot; `OKS_05C_TESSDATA` to a trusted local directory with English/Russian Tesseract data. The entry is repository-local `engine/advanced_ingest.py`. Never put workstation-local or private absolute paths into the public PR, CI logs or artifacts. The environment is host-specific; do not download missing artifacts implicitly. Required resources: Linux cgroup v2, user systemd-run, free RAM >=7GiB, local disk >=1GiB, memory cgroup 4GiB, swap0, CPU quota and pids limits, tested no-AF_INET address-family policy.
3. Run actual process-tree and extraction acceptance only with explicit opt-in:
   `OKS_05C_REAL_CGROUP=1 OKS_05C_PYTHON=... OKS_05C_TOKENIZER_SNAPSHOT=... OKS_05C_TESSDATA=... node --test .test-build/advanced-cgroup-host.test.js`.
4. Run actual desktop under `unshare -Urn`, without external routes:
   `OKS_HOST_NO_ROUTE=1 OKS_STANDALONE_PACKAGE_DIR="$PWD/build/standalone-package" bash scripts/obsidian-host-smoke.sh`;
   then repeat with `OKS_ADVANCED_INGESTION_TEST=1` plus exact `OKS_05C_*` variables above. Script creates and cleans an isolated synthetic Vault/profile. Verify all `OBSIDIAN_HOST_*`, `OBSIDIAN_UI_SMOKE_PASS`, `OBSIDIAN_ADVANCED_INGESTION_PASS` markers and final process exit 0; no pass from a partial marker alone.
5. Cross-check `systemctl --user list-units 'oks-ingest-*.service' --state=running` empty after cancellation, and verify source files untouched, no release-shaped package content includes private docs.

## Targeted independent review risks and deferrals

- **High-priority review:** whole-process-tree cleanup on abort, unit registration race, owner group/identity, exact source freshness during/after generation publication, source path symlink swaps, memory/load preflight, private index crash edges, strict canonical JSON cross-language numeric/Unicode parity, unknown/duplicate fields, derived native table-cell evidence, leakproof diagnostics.
- **Extractor limits:** 65,536 bytes/source, <=8 PDF pages, max DOCX expansion 8MiB, source/page/block/count quotas, cgroup4GiB. Incomplete PDF layout and OCR not silently ready. Structured table models and artifacts are supported only when explicit local artifacts pass preflight; tests cover native PDF and explicit Tesseract OCR, not full table-model inference.
- No automatic global vault crawl, no background sync, no arbitrary source folders, no model-backed dense/hybrid; those belong to OKS-05D/05E subject to separate design/acceptance. Advanced ingest does not itself generate ranked EvidenceHits.
- External Python/backend is required only for manually enabled Advanced. Standalone remains default package-only and self-contained.
- Do **not** use this author's test assertions as independent proof. Rerun and challenge all cited gates, inspect FULL DIFF pinned SHA, and independently post a reasoned `APPROVE` or `REQUEST CHANGES` in GitHub PR Conversation.

## Merge gate

Keep Draft if any mandatory blocker or no separate-session independent review. Only after separate reviewed exact HEAD, independent APPROVE, CI success on that HEAD, confirmed mergeability and no blockers may the reviewer mark Ready, squash merge into develop and record remote SHA. New HEAD after remediation **invalidates** previous approval. Do not start OKS-05D before merge.
