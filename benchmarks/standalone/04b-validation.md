# OKS-04B candidate — local validation evidence (2026-11-23)

**Evidence status:** full author + orchestrator local validation completed on the Linux test host; **not independent SDD approval**. This report is pinned to the feature-branch implementation relative to baseline `a8ad950201fd7a5caebb8639b147d70f6f53a964`; the final candidate HEAD and CI/review outcome must be recorded in the PR conversation. Only synthetic notes, disposable Vault/profile and host-private index fixtures were used. No private working Vault was accessed. Previous author-only Codex sandbox Xvfb/Python environment failures are superseded by actual checks in the normal authorized Linux test host environment, not represented as product failures.

## Scope and CAP/AC traceability

- **CAP-07 / AC-07:** actual Obsidian ItemView and commands, status/diagnostic export, typed Properties opt-in filter, settings v2, versioned in-process API v1 via documented supported Obsidian CLI `eval` (no listener).
- **CAP-01 / AC-01 and CAP-06 / AC-06:** exact source path/identity/SHA, byte/codepoint/physical-line locator verification, editor text equality, stale UI revocation on source events, navigation errors for rename/delete, Unicode/emoji/CRLF and HTML as text.
- **CAP-08 / AC-08 and CAP-09 / AC-09:** unchanged 04A generation writer/crash recovery, bounded latest-request controller, lifecycle/reload barrier, disabling Worker, pause/resume/cancel/rebuild, disabled-only identity-checked derived-index file deletion.
- **CAP-10 / AC-10:** no backend model/download/listener/egress, diagnostics metadata-only, no plaintext settings persistence, safe rendering and own-Vault provenance checks. Dense/hybrid explicitly unavailable. Legacy Python diagnostic remains manual and outside Standalone.
- **ADR-0006, ADR-0008:** mandatory offline lexical without additional runtime; accepted Linux host-private transactional index. No changes to 04A index schema or retrieval ranking algorithm. Future OKS-05/Bundled Advanced and public distribution remain explicitly out of scope.

## Executed validation gates

| Check | Result |
|---|---|
| `npm run typecheck` | PASS; TypeScript strict |
| `npm test` | PASS; 180 Node tests, 0 failed or skipped, including B1–B9, mixed-case/Unicode and derived-only purge tests |
| `npm run test:python` | PASS; 124 Python tests, 5 intentional skips, no failures (outside the Codex sandbox) |
| `npm run build` | PASS; main bundle, worker and manifest |
| `npm run licenses` | PASS; no new runtime dependencies |
| `npm run benchmark:standalone` | PASS; 21 synthetic sources, 91 records, 31 queries; 0 stale returned evidence and 0 bad locator |
| `git diff --check` | PASS |
| Real `scripts/obsidian-host-smoke.sh` | PASS on Obsidian Desktop/CLI 1.15.1 in isolated Xvfb/electron HOME/XDG profile, including extended UI eval driver |
| Exact-HEAD CI and independent reviewer | PENDING — publication and review are separate non-negotiable gates |

**Actual host smoke evidence:** `OBSIDIAN_UI_SMOKE_PASS` validates mounted/visible ItemView, lexical query, typed-filter positive/negative, raw `<img>` text not executable DOM, emoji/Unicode/CRLF selection in actual Obsidian editor, stale-click suppression, stale digest rejection, modify/rename/delete, pause/resume/cancel/rebuild, actual Settings dialog toggle/refresh, confirmation and disabled-only purge of derived index without source notes deletion, versioned API, dense mode refusal, disabled/re-enabled worker and metadata-only diagnostics. `OBSIDIAN_HOST_SMOKE_PASS` additionally validates original-line SHA, command-based navigation, persisted recovered generation, `plugin:reload` and termination of old Worker. Script exits 0; `OBSIDIAN_HOST_STORAGE_PASS` verifies private XDG index outside temporary Vault. This is not a mock/UI-only simulation.

## Performance and resource measurements

All numbers are measured on **synthetic** data. The unchanged retrieval benchmark runs the engine in Node rather than inside the Obsidian UI. Original 04A reference numbers below are from the checked baseline; these are non-identical local runs, so modest differences are not attributable to 04B UI.

| Metric | 04A baseline | Latest 04B benchmark |
|---|---:|---:|
| Initial index build, ms | 173.94 | 145.89 |
| Incremental rebuild, ms | 48.03 | 60.08 |
| Query p50 / p95, ms | 0.288 / 2.237 | 0.625 / 3.225 |
| Process RSS, MiB | 85.90 | 84.38 |
| Max event-loop delay, ms | 13.71 | 11.98 |
| Index generation, bytes | 77,372 | 77,372 |
| Query cases / returned-stale / invalid locators | 31 / 0 / 0 | 31 / 0 / 0 |

Actual nine end-to-end visible Obsidian UI queries (including test polling): p50 **30.80 ms**, p95 **31.00 ms**, maximum sampled UI event-loop delay **0.30 ms**. The test poll cadence is ~30 ms. Obsidian total process-tree RSS was not separately measured; Node harness RSS above must not be misrepresented as host RSS. These are short-run smoke measurements, **not** a production resource SLA. Current bundle sizes after purge UI: `main.js` approximately 103 KiB, `standalone-worker.js` 10,471 bytes and `manifest.json` 275 bytes. No external Python runtime needed for host search.

## Limitations and review gates

Verified only on Linux and Obsidian 1.15.1 with bounded Markdown sources and synthetic queries, not a production-Vault or large-scale capacity benchmark. No PDF/DOCX/OCR, embedding, dense/hybrid, graph expansion, independent backend or cloud synchronization. Host-private index is not a hard separate cgroup memory sandbox. Concurrent hostile filesystem manipulation has the ADR-0008 limits; verified stale/different source bytes are refused. The index purge is deliberately disabled-only, confirmed in UI, allowlist-only with unknown-file/symlink/hardlink refusal and never recursively removes files or notes. A broader total-quota alert/policy and full release packaging validation are future work. PHASE_CLOSE requires **new independent full-diff exact-HEAD APPROVE** and hosted CI, Ready PR and confirmed squash merge; no author test result alone satisfies these.
