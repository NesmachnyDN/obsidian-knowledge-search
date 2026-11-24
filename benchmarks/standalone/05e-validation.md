# OKS-05E cumulative Gate A acceptance candidate

**Date:** 2026-11-24. **Evidence class:** orchestrator-executed cumulative validation, not independent acceptance. **Implementation baseline:** `9c707898322feff8daf8621be248d59bc5352db4` (develop, PR #43 merged; issue #41 closed). **Contract:** [OKS-05E](../../docs/prompts/OKS-05E.md). **Tracking:** issue #42. Candidate HEAD and independent decision belong in the PR conversation. Production code and package inputs remain unchanged. The proposed disposition is Gate A basic-only Markdown MVP; final acceptance is pending independent exact-HEAD review.

## Exact-baseline execution

| Check | Observed result |
|---|---|
| `npm run typecheck`, `npm run build`, `npm run licenses` | PASS |
| `npm test` | 311 PASS, 4 SKIP, 0 FAIL |
| `npm run test:python` | 133 PASS, 5 SKIP, 0 FAIL |
| `node --test tests/package-standalone.test.mjs` | 17 PASS, 0 FAIL |
| Two fresh builds; `node scripts/standalone-package.mjs pack <directory>` and `verify <directory>` | PASS; byte-identical three assets and SHA-256 ledger |
| Frozen Standalone benchmark (`npm run benchmark:standalone` in disposable equivalent baseline snapshot) | PASS; observations below; tracked historical results unchanged |
| `OKS_HOST_NO_ROUTE=1 OKS_STANDALONE_PACKAGE_DIR=<candidate> bash scripts/obsidian-host-smoke.sh` | PASS, real Linux Obsidian 1.15.1, clean synthetic Vault, separate HOME/XDG/Electron profile |
| Same smoke with `OKS_AI_RERANK_TEST=1` | PASS, isolated synthetic loopback fixtures only; not provider acceptance |
| Same basic smoke with `OKS_STANDALONE_PREVIOUS_PACKAGE_DIR=<verified D7 package>` | PASS, real update/rollback/re-update and normal host smoke |
| `bash -n scripts/obsidian-host-smoke.sh`; `git diff --check` | PASS |
| Develop validation [45361800433](https://github.com/NesmachnyDN/obsidian-knowledge-search/actions/runs/45361800433), dependency audit [45361800187](https://github.com/NesmachnyDN/obsidian-knowledge-search/actions/runs/45361800187), CodeQL [45361800628](https://github.com/NesmachnyDN/obsidian-knowledge-search/actions/runs/45361800628) | SUCCESS on exact baseline; zero open Code Scanning alerts on develop |

Node skips: three opt-in actual advanced Docling/tokenizer/cgroup scenarios and one actual CPU BGE-M3/cgroup scenario. Python skips: five integration cases requiring explicitly pinned optional artifacts. These are outside the basic-only claim; no optional downloads or model execution were attempted. CI for the acceptance PR itself and post-merge regression remain pending.

### Reproducible candidate assets

| Installed asset | SHA-256 |
|---|---|
| main.js | b2a44419bde54ba5fd67ce843290a4f87ae2b6433d4d1589d17167433943acdb |
| manifest.json | e180a819f6cd1e379ea08496120cc040bb1efbcc1c63d6cf3a065044632fe803 |
| standalone-worker.js | db470fb700d384beeebcb9fd96182a89eb3ebe886151c76d7a5082545e06ca62 |

The verified previous package from D7 develop `391d31430a98eb73a38619bec735f40ce750ab4f` has main.js SHA-256 `a11232c50fbe4ac7551261fb29d2d6a63800241e3e588758e358da08321fe6d6` and identical manifest/worker checksums. Both package ledgers verified before transition. These are local release-shaped unsigned packages, not published releases. For reproduction, build each pinned revision in separate clean worktrees with locked dependencies, copy the verified package directories with adjacent ledgers into the acceptance worktree's ignored build root, and use the commands above. Never operate on a working Vault.

## Mandatory Gate A evidence matrix

| Criterion | Observed coverage | Candidate evidence |
|---|---|---|
| AC-01 | Initial scan and actual create/modify/rename/delete; scope, ignored/unsupported sources, traversal/symlink denial, missed-event reconciliation, stale evidence rejection | PASS: real host smoke; standalone.test.ts, plugin-lifecycle.test.ts, codeql-security.test.ts |
| AC-06 | Original source SHA-256 and exact UTF-8 byte/codepoint/line spans, Unicode/CRLF, literal/terms, typed Properties/tags/link-target anchors, negative and stale evidence queries, navigation | PASS: real ItemView and CLI source selection; standalone.test.ts, standalone-metadata.test.ts, search-ui.test.ts, frozen corpus |
| AC-07 baseline | Default-off AI, autonomous packaged basic search in no-route namespace, real settings dialog, status, pause/resume/cancel/rebuild, safe diagnostics, versioned API v1 and CLI | PASS: real host smoke and search-ui.test.ts, plugin-lifecycle.test.ts; no required provider, credentials, separate model or Python runtime |
| AC-08 | Immutable publication, CURRENT boundary and uncertainty, recovery/rollback and missed events, real reload and disabled-only derived purge, clean removal, actual package update/rollback | PASS: standalone.test.ts B1-B8, search-purge.test.ts, host transition and lifecycle smoke |
| AC-09 | Bounded query/source/index/metadata limits, coalesced event storm, bounded queue, worker cancellation, recoverable disk quota/pressure failures; observed latency and memory | PASS for tested limits and fixtures: standalone.test.ts, search-ui.test.ts, plugin-lifecycle.test.ts; no universal workload or OS hard-sandbox guarantee |
| AC-10 | Frozen corpus, original locators, exact IDs, negative queries, stale suppression, sanitized diagnostics, no-route execution, package integrity/determinism and security checks | PASS for tested baseline: corpus benchmark, host smoke, package tests, CodeQL and audit |

**PASS in this matrix means observed test evidence, not an independent gate decision.** Limits in the implementation include 65,536 bytes/file, 512 sources, 32,768 blocks (4,096/source), 128 Properties/source, 256 wiki links/source, 16 MiB generation, 512 UTF-8 query bytes, Top-K 50, 32 predicates. Exceeding bounded limits is not silently equivalent to complete indexing. Existing fault-injection and lifecycle tests exercise recovery rather than asserting unlimited scale.

### Real host evidence

Basic no-route smoke: actual Obsidian 1.15.1, mounted ItemView, literal physical-line substring and explicit lexical terms, typed positive/negative metadata and tag/link filters, Unicode/CRLF exact navigation, stale-click/hash rejection, rename/delete, pause/resume/cancel/rebuild, real settings/AI preferences and safe diagnostics, API v1, reload with old worker stopped, host-private XDG index and source-preserving removal. UI p50/p95 30.60/31.00 ms, max sampled event-loop delay 2.10 ms.

Transition extension is validation-only and requires both verified packages, no route and basic-only mode. It installs D7, then copies all three verified D8 assets into the synthetic plugin directory and reloads, rolls back to D7, and re-updates to D8. At each transition the expected D8 machine API presence/absence distinguishes bundles, generation ID stays unchanged, prior worker stops, both original source hashes remain identical, basic original-evidence search succeeds, and AI/ingestion remain disabled. It then runs normal host acceptance and clean removal. Exit 0 and `OBSIDIAN_PACKAGE_TRANSITION_PASS`; UI p50/p95 30.50/30.60 ms, max sampled delay 0.30 ms. This tests the specified same-schema D7/D8 package pair, not arbitrary historical or interrupted installation compatibility.

Synthetic loopback AI host smoke: actual UI/CLI reranking, generation, dense/hybrid and D8 machine API fixtures; explicit consent, local HTTP, original evidence, typed errors, ownership, one-shot grants/results, cancellation, no pre-consent egress, stale suppression and lexical independence. Fixture cleanup PASS. UI p50/p95 30.60/31.70 ms, max sampled delay 0.90 ms. No real provider, cloud credential, external model or paid credit used.

### Frozen synthetic RU/EN benchmark

21 sources, 91 indexed records, 31 queries, 12/12 exact-ID direct hits. Zero invalid original locators, stale evidence returned or failed queries. One stale source suppressed; subsequent updated hit confirmed. Frozen corpus/judgments and historical tracked results preserved.

| Metric | Tuning (15 queries) | Held-out (16 queries) |
|---|---:|---:|
| Recall@10 | 0.892857 | 0.933333 |
| Precision@10 | 0.142857 | 0.140000 |
| nDCG@10 | 0.946944 | 0.940569 |
| MRR@10 | 1.000000 | 0.955556 |
| Unanswerable queries with hits | 0 | 0 |

Initial index 296.94 ms, incremental 508.01 ms; query p50/p95/max 0.788/3.750/18.388 ms; index 77,372 bytes; harness RSS 88,395,776 bytes, heap 9,985,496 bytes; max sampled event-loop delay 12.53 ms. The frozen Python lexical reference held-out nDCG@10 is 0.941184; different ranking policies, directional comparison only. These are small synthetic observations, not statistical non-inferiority, production capacity or latency SLA. No controlled incumbent Knowledge AI comparison is claimed; controlled adoption remains separate.

## Scope and final disposition

- Gate A: basic-only **candidate evidence complete**, pending fresh independent cumulative review and final develop regression.
- B-Dense/B-Hybrid/B-Rerank/B-Generation: implemented paths and synthetic evidence as applicable; **NOT CLAIMED / NOT ACCEPTED** for actual provider capability. No real-provider quality, availability, cloud egress or model compatibility proof.
- Gate C PDF/DOCX/OCR: **NOT CLAIMED / NOT ACCEPTED** in this cumulative candidate; historical experiments not substituted for fresh format-specific evidence.
- No production Vault access, deployment, release/tag, main modification, provider calls, paid credits, heavyweight provisioning or OKS-06 scope. Package excludes separate runtimes, model weights and credentials; Node/Python used by development/test harness are not installed plugin prerequisites. No-route tests prove offline operation and restrict external routing, not packet-level proof that no connection attempt ever occurs. Source attacks, durability faults and resource exhaustion are tested mainly through deterministic harnesses, not arbitrary real-host adversarial injection.
- A separate reviewer must inspect the full acceptance diff, source/tests and evidence against the contract and SPEC, confirm CI/security, then explicitly record APPROVE or REQUEST CHANGES. This report does not close #42 or authorize OKS-07. Final acceptance requires independent review, merge and verified post-merge regression.
