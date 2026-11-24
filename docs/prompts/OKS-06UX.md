# OKS-06UX — Settings usability and operational readiness

**Status:** planned, not implemented. Maintainer-approved direction 2026-11-24.
**Workflow:** bounded PR to develop. Reconcile exact fresh base and in-flight work before starting; independent contract review where behavior is ambiguous, independent full-diff exact-HEAD implementation review and applicable CI before merge.
**Authority:** AGENTS.md, SECURITY.md, docs/development/SDD.md, SPEC AC-07/08/09/10 and AC-04/05/11 only for existing claimed functions, ARCHITECTURE, ADR-0015/0006/0008, ROADMAP OKS-06UX and [UX specification](../ux/settings/README.md).
**Entry:** 05E accepted; 05P accepted for AI-specific controls being exposed. Reconcile actual capability/host states, current configuration schema, active PRs and native Obsidian APIs. This does not reopen 05E or block independent 06B research; prioritize before optional feature UI expansion and require completion before 07. Record actual base SHA at execution, not the planning commit.

## Bounded implementation tasks

- UX-01 Inventory every current setting, owner, persisted field, default, validation, dependency, visibility and operational effect. Reconcile all settings introduced by D1–D8 and later merges. Preserve a field-to-control mapping; identify legacy diagnostics, unsupported controls and stale text. No removal without evidence and maintainer agreement if semantic.
- UX-02 Introduce task-oriented sections and Basic (default)/Expert presentation. Use native Obsidian components and theme variables, accessible labels, keyboard navigation, responsive layout. Prefer existing supported SDK facilities after verifying manifest minimum version and API semantics. No new dependency unless justified.
- UX-03 Implement progressive disclosure and local targeted rendering; no full-tab redraw per keystroke. Use explicit draft/validation/commit for dependent configuration sets; atomic enable after valid required fields, and clear inline errors. Preserve focus, unsaved drafts during unrelated status refresh, and user-entered configuration on failed commit. No invalid intermediate persisted state.
- UX-04 Independent AI-role cards for embedding, reranking and generation. Add provider connection editor/reuse of common settings only where it maps safely to existing per-role contracts; never force shared models/endpoints. Offer verified preset/default values only for supported adapters; expose required unknown model revision even in Basic. Separate configuration from activation, readiness, permissions and real execution. No new adapters, automatic discovery, default provider, unverified network test, or new credential persistence in this slice.
- UX-05 Present index state, lexical/dense coverage when authoritative, requested/executed modes, reasons for unavailable capability, and existing safe actions. Show staged rebuild impact on embedding-space change, retain old verified generation until atomic switch. Separate maintenance and destructive cleanup with confirmation and existing guards.
- UX-06 Separate local document processing, OCR and structural artifact paths, optional local backend and legacy synthetic probe. Render only applicable controls; expose advanced setup as a guided draft without requiring Python for baseline. Do not claim unsupported format or model readiness.
- UX-07 Verify configuration round-trip, migration of actual schema (v5 at planning; recheck), rollback, invalid/malformed historical configs and mode-only preference. UI mode is presentation-only, must not modify grants, provider identities, index or lifecycle. Preserve hidden values except explicit documented disable/delete semantics; no hidden active state surprise.
- UX-08 Add automated state/visibility/validation and interaction tests, exact real-host acceptance in an isolated generated vault and sanitized screenshots; update user-facing documentation and release notes. Record limitations and traceability to UX acceptance IDs below.

## Engineering constraints

Do not alter retrieval, ranking, ingestion, source freshness, disclosure authorization, host APIs, index compatibility rules or existing execution contracts to make UX easier. Reuse existing controllers and typed validation. No separate parallel settings model as runtime authority. A UI draft or presentation preference is not a grant. Cloud remains denied unless the existing authorized path explicitly supports it; configured does not mean ready. Do not introduce API keys in plugin data.json, vault, logs or screenshots; use existing credential resolver and verify supported secure storage separately. No real vault modifications, provider calls, bulk indexing or downloads without separate authorization. Existing local API restriction is literal loopback; do not broaden it. Do not copy Knowledge AI code, styles or assets. Do not add unavailable capabilities as functional buttons.

## Acceptance matrix

| ID | Observable test |
|---|---|
| UX-AC01 | Clean install: Basic opens with working offline lexical/Properties search without API/secret/Python; no network or model download on opening settings. |
| UX-AC02 | Basic/Expert round-trip preserves configuration and operational state across reload; hidden field values survive where existing contract allows; active optional functions visible in summary. |
| UX-AC03 | Disabled or unsupported parent hides irrelevant descendants; draft configuration remains reachable; OCR/structured combination reveals exactly required paths; local/cloud fields and role cards are independent. |
| UX-AC04 | Type multi-character text and numbers, navigate by keyboard, validate invalid endpoint/path/model/limit inline; focus survives unrelated refresh; no partial persisted update; save failure preserves draft and committed state. |
| UX-AC05 | Fresh and migrated configs, including disabled legacy backend, valid configured providers and malformed values, retain existing safe defaults and no implicit enablement. No secret leakage. |
| UX-AC06 | Configured/unavailable/permission-required/ready/busy/error statuses derive from existing authoritative state; no fabricated coverage or implicit fallback. Permission denial and no-route tests preserve basic search. |
| UX-AC07 | Changing embedding space gives explicit impact and controlled action; no silent rebuild or index mixing; rerank/LLM changes do not trigger dense rebuild; destructive cleanup obeys existing guard and confirmation. |
| UX-AC08 | Light/dark themes, narrow settings panel, long translated labels, 200% zoom where supported, logical focus order, accessible names, status not color-only; no clipped primary actions. |
| UX-AC09 | Real Obsidian synthetic-vault smoke: open settings, edit, save, reopen, restart, switch modes, run offline search, optional capability states; sanitized screenshots per state. Existing tests, package, CI, security scanning and applicable regression pass at exact HEAD. |
| UX-AC10 | Docs identify Basic/Expert, setup and diagnostics, unsupported capabilities and rollback. User-facing names understandable without engineering jargon; English canonical strings and localization mechanism if present. |

## Delivery evidence

Before implementation pin the exact base, mapping and supported SDK. At completion provide changed paths, test commands/results, sanitized screenshots (Basic clean, Basic configured, Expert, local/cloud draft, OCR variants, error/maintenance), CAP/AC/UX-AC traceability, exact base/head and independent review. Do not claim new Gate B/C capability or re-open historical gates merely by improving presentation. Re-run applicable previously accepted behavior before adoption. No main changes.
