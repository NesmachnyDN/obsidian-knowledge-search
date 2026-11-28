# OKS-06 P0 — Evidence reconciliation and minimum ownership design

Mode: bounded planning and DOCS_ONLY design. Authority: AGENTS, SECURITY, SDD, SPEC, ARCHITECTURE, ROADMAP, ADR-0015–0025, #105/#149/#78/#79, HARD-SCOPE-1–6, prior review and author evidence for #154/#155. Entry: independently accepted and merged ADR-0025; refresh actual develop and candidate refs. This contract does not authorize implementation, changing PR #155, runtime activation or merge of #155.

## Step 1 — independent acceptance reconciliation

Read complete relevant governing documents and exact pinned diff, independently verify current refs, PR metadata, CI, existing findings, author handoffs and recorded test evidence. Compare both independent #155 conclusions identified in ADR-0025. Establish explicit B-07 disposition using exact historical reviewer tests when available, or equivalent bounded synthetic checks and documented equivalence; distinguish missing evidence from demonstrated behavior. Do not silently drop, reinterpret or mark a finding closed on green regression alone. Record sanitized evidence and limitations. Keep #155 Draft regardless of this step's verdict. If evidence cannot be reconciled, document the blocker and design with the stronger existing safety invariant; do not claim independent acceptance or proceed to implementation.

## Step 2 — minimum ownership design (separate DOCS_ONLY candidate)

Map actual baseline and candidate responsibilities and state owners in SearchController, StandaloneEngine, source reader, host adapters, dense/advanced, policy, credentials, Graph, chat and publication. Identify required shared versus independent lifetimes. Produce a small explicit state/transition table with owner, entry, terminal conditions, failure and retry semantics, publication boundary and caller obligations. Trace each mechanism to CAP/AC or a reachable necessary safety case. Compare keeping the existing bounded protocol, targeted simplification, and bounded replacement only if justified; choose the smallest coherent change and preserve useful accepted code. A logical seal is not a provider grant or physical completion. A notification is not an operation owner.

Prove the design preserves hard scope, current-original provenance, ownership, fail-closed admission, independent role authorization, consent, credential lifecycle, deadline, cancellation, bounded resources, no stale evidence, no unauthorized disclosure and no source writes. Cover ordinary completion, supersession, settings/source change, reentry, exceptions, late settlement, shutdown, saturation and retries using the established negative requirements and historical evidence. Do not create a second authority, second production engine or speculative generic framework. Preserve existing storage/index and compatibility boundaries unless separately justified.

Deliver a DOCS_ONLY design PR with explicit baseline/candidate, alternatives, state/ownership table, migration impact, bounded implementation proposal and traceable before/after validation matrix. Specify exactly what is kept, moved or removed and why; no invented numerical complexity savings. Record unresolved questions as such. Independent exact-HEAD design review, applicable CI and normal delivery gates are mandatory; the author must not approve or merge their own unreviewed work. Production implementation requires a later independently accepted bounded contract; no source code changes in this step.

No production Vault, actual provider traffic, credentials, heavy inference, model downloads, deployment, source changes, PR #155 status changes or issue closure. Synthetic evidence only. Report in the maintainer's language; public repository records in English. Stop at a recoverable handoff if a mandatory gate remains unresolved.

## P0.1 candidate output

See [ADR-0026](../adr/0026-minimum-operation-ownership.md) and [proposed P0.2 execution contract](OKS-06-P0-OWNERSHIP-SIMPLIFICATION.md). These are pending independent DOCS_ONLY acceptance; no implementation or runtime acceptance follows from their creation.
