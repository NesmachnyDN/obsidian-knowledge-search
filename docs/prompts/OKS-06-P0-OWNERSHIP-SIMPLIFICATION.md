# OKS-06 P0.2 — bounded minimum ownership implementation (proposed)

Entry: independently accepted and merged ADR-0026 and this execution contract. Read AGENTS, SECURITY, SDD, SPEC, ARCHITECTURE, ROADMAP, REUSE, ADR-0015–0026, HARD-SCOPE-1–6 (6 is in #155), applicable OKS-06H/POLICY contracts and both historical reviews. Refresh exact refs; preserve historical evidence. This document is a design candidate, not present authorization to code.

## Scope

From accepted develop create a new bounded branch; #155 stays Draft and unchanged. Carry only necessary candidate behavior and tests by reviewed adaptation. Implement ADR-0026 B: a single consistent concrete-pin outcome/cleanup rule in SearchController, independent of logical sealing and notification; retain shared publication cut and exact host targets. Preserve source seal and ChatView observational identity. Only controller, strictly necessary ChatView adjustment, synthetic tests and corresponding documentation. No new authority, registry, scheduler, queue, framework, dependency, provider, schema, native integration or runtime activation. No changes to reader/engine/Dense/Advanced, no source writes, production Vault, real credentials or actual providers. If these boundaries are insufficient, stop and propose a revised bounded contract.

## Required validation matrix

| ID | Before / after evidence |
| --- | --- |
| O1 | Reproduce all six original B-07 failures at exact #155 HEAD using original or demonstrably equivalent synthetic tests. New candidate GREEN for Graph, scoped retrieval and admitted reranking direct/shared before/after-signal failures; prove exact retained owner, eligible retry, no duplicate abort, zero unauthorized dispatch. |
| O2 | First review two controls and later review six cases GREEN; policy alias transfer uses the actual built synthetic worker. Add analogous generation-role proof; never claim it was already reproduced. |
| O3 | Preserve all #155 B-01–B-06, ChatView identity, source seal, all existing tests including #154 publication/deadline/physical-slot negative regressions. |
| O4 | Ordinary success, explicit cancel, supersession, settings/source change, nested actual dispose and seal-only then dispose; assert logical state, concrete attempts, physical slot and order, not merely final status. Repeated dispose is idempotent. |
| O5 | Throw before/after signal, failed shared hook, retry and late resolve/reject; callback reentry into cancel/admission/source change/observer; no owner loss, concurrent retry, stale publication or terminal revival. Failed terminal attempt stays fail closed, no unbounded retry. |
| O6 | 4096 source and eight unique concrete owner budgets, alias transfer, detached pin, role-local isolation and fail-closed overflow; test saturation and bounded attempts. |
| O7 | Basic offline independent of provider/optional failures; latest Basic reservation, compatible completed Chat selection/history, Graph separate result; explicit scope/config/source invalidation revokes affected evidence. |
| O8 | Original bound deadline/cancellation precedence, exact credential lifecycle, policy and consent checks; no new egress, no implicit fallback, no source writes. Preserve separate storage/process and credential physical barriers. |
| O9 | Full applicable Node/Python regression, typecheck, build, package/reproducibility, license, security audit, publication hygiene, diff check and actual remote CI under SDD. Document exact commands, counts and unrun tests. |

For O1 preserve exact historical failure on #155 independently of develop; do not claim a failing baseline on develop if that behavior does not exist there. Record unchanged fixture identity or explicit equivalence; require candidate evidence for every preserved contract. All negative cases deterministic synthetic; no production material or actual provider traffic. No gate waiver: scope and actual runtime/provider/format/platform acceptance remain subsequent separate stages.

## Exit

Provide exact base/head, bounded diff, requirements and before/after evidence, component owner/release audit, measured code changes (no invented complexity savings), actual CI, limitations and independent exact-HEAD full-diff review in a separate session. No self-approval. Only normal reviewed delivery after gates. No issue closure or P0.3 activation on P0.2 acceptance alone.
