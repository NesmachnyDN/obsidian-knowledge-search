# OKS-05A Standalone package and clean-install candidate evidence

**Date:** 2026-11-23. **Evidence class:** author/orchestrator tests, not independent SDD approval. **Base:** `df5e381a9c6ead353c837a13fa0215c299b97e48` (`develop`, PR #12 merged). **Candidate branch:** `feat/oks-05a-standalone-acceptance`. Record the exact candidate HEAD, GitHub CI and independent reviewer decision separately in PR Conversation; this report is not an approval. Only a disposable synthetic Vault and separate HOME/XDG/Electron profile were used. No working Vault or private content was read or modified.

## Profile, package and reproducibility

- Linux Obsidian Desktop/CLI **1.15.1**, Electron host and packaged browser Web Worker. `manifest.json` has the stable plugin ID `oks-synthetic-evidence`, desktop-only true and conservatively tested minimum application version 1.15.1. Manifest distribution and required `main.js` are consistent with the official Obsidian developer documentation; the additional `standalone-worker.js` is necessary for the production code path.
- `npm run test:package` builds then creates/verifies `build/standalone-package/`. Exactly three files are installed, with a separate adjacent deterministic SHA-256/byte ledger (not a cryptographic signature or publisher authenticity check). The package excludes Python, Node/npm installers, model weights, OCR/runtime binaries, test fixtures, network service and backend configuration. Node and Python used by the *developer harness* are not required by the installed search path.
- Verified checksums for this source/build snapshot: `main.js` f6b1bdf3ef87afa76c0711e4db4e3954b9f6e12347c18a29532991319f653cde; `manifest.json` e180a819f6cd1e379ea08496120cc040bb1efbcc1c63d6cf3a065044632fe803; `standalone-worker.js` d8f1e432253129ec6e3a92f9c134f06537eb5dad6b3023dcea2396cce789ae4e. No absolute host paths or source text are in the ledger.
- **10/10** package tests passed: deterministic/idempotent and separately instantiated identical outputs; missing/extra/mutated asset, invalid manifest, symlink/hardlink worker, tampered ledger, foreign destination and path outside the ignored build root fail closed. No source file or other workspace is deleted by the package builder.

## Executed validation

| Check | Observed result |
|---|---|
| `npm test` | PASS; 180 Node tests, 0 failures/skips; includes OKS-04A B1–B9, missed events and source/security failures |
| `npm run test:python` | PASS; 124 tests, 5 pre-existing skips; reference-only |
| `npm run typecheck` / `npm run build` | PASS |
| `npm run licenses` | PASS; unchanged build dependencies and no newly distributed runtime |
| `npm run test:package` | PASS; 10 package tests |
| `npm run benchmark:standalone` | PASS; 21 synthetic sources, 91 indexed lexical records, 31 frozen queries; 0 invalid locators and 0 stale evidence returned |
| `OKS_STANDALONE_PACKAGE_DIR=... bash scripts/obsidian-host-smoke.sh` | PASS, actual Obsidian 1.15.1 with clean temporary Vault/profile and **packaged** files; not Node mock |
| `git diff --check` | PASS on local candidate |
| Exact-HEAD GitHub CI / independent full-diff review | PENDING until PR creation/review |

### Real Obsidian acceptance observations

The host CLI reported `OBSIDIAN_UI_SMOKE_PASS`, `OBSIDIAN_HOST_SMOKE_PASS`, `OBSIDIAN_HOST_STORAGE_PASS`, and `OBSIDIAN_HOST_CLEAN_REMOVAL_PASS` with zero script failures. The actual mounted/visible ItemView performed lexical search, positive and negative number-vs-string typed filters, literal (non-executing) HTML display, Unicode/emoji/CRLF exact line selection, stale-click rejection, modified source digest failure, rename/delete rejection, real settings disable/re-enable and disabled-only derived-cache purge, pause/resume/cancel/rebuild, in-process API refusal for unavailable dense and hybrid, plugin reload generation continuity and prior Web Worker termination. Packaged plugin files were removed from the disposable Vault after the host exited and the original Markdown SHA remained unchanged. The derived XDG cache resided outside the Vault.

A single UI smoke trial measured UI query **p50 30.80 ms / p95 31.50 ms** over nine interactions, maximum sampled event-loop tick delay **0.40 ms**. These are small-fixture observations, not a p95 service-level guarantee. The same exact packaged host smoke independently passed again **inside `unshare -Urn`**: only loopback networking and no Internet route were available, with observed UI query p50 **30.60 ms**, p95 **30.80 ms**, and event-loop delay max **0.60 ms**. Both tests returned zero; the namespace run validates actual offline execution, not a proof that code never attempts an outbound request.

### Standalone frozen corpus (synthetic, harness rather than GUI)

Held-out lexical Recall@10 **0.9333**, Precision@10 **0.1400**, nDCG@10 **0.9406**, MRR@10 **0.9556**; frozen reference Python lexical nDCG@10 **0.9412** is a directional comparison of different rank policies, not claimed statistical non-inferiority. Exact ID direct hit was 12/12 across both splits. The observed Node harness indexing time was **150.94 ms**, incremental time **56.48 ms**, query p50/p95 **0.666 / 2.662 ms**, process RSS **88,838,144 bytes**, and index bytes **77,372**. RSS includes the test harness, not just the embedded engine; UI timings are an entirely separate measurement. The benchmark overwrites its generated results with run-specific timings; tracked results are restored to the previously committed baseline after capturing observations.

## Safety, limitations and deferred gates

- The observed installed lexical execution starts no separate Python interpreter, Node executable, model runtime, backend or listener. Offline host operation was verified with no non-loopback route using the `unshare -Urn` test; this does not replace tracing outbound connection attempts or checking future bundled code. Diagnostics are metadata-only. Source-root/symlink, stale-generation, traversal and failed publication safety primarily have independent **Node regression** evidence rather than full GUI attack injection.
- No bundled Advanced profile, OCR/PDF/DOCX ingestion, model inference, dense/hybrid RRF or cross-runtime binary evidence interchange is provided by this slice. A deliberate dense request returns `CAPABILITY_UNAVAILABLE`. CAP-02/04/05 advanced acceptance remains **NOT RUN** for this package.
- Frozen quality judgments do not include a controlled comparable Knowledge AI run. Incumbent non-inferiority/adoption and larger Vault resource/SLA claims remain unaccepted; an explicit alternative decision from the maintainer is required if a safe incumbent run is impossible.
- A release-shaped local directory is not a signed/zip public release. Earlier Obsidian releases, other operating systems, full offline/egress hardening, adversarial concurrent filesystem edits and user-provisioned model/resource controls need distinct evidence before public use.
- Standalone Gate A is a cumulative MVP acceptance gate; this bounded slice demonstrates clean-install UI/package behaviors, not the entire OKS-05 Gate A security/resource matrix. **No MVP phase closure** and no merge before independent review of exact HEAD.
