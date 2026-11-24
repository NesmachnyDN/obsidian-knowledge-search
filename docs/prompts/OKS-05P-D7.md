# OKS-05P-D7 — Explicit API-dense host UI
Base: eb7d14a22d74db24d099e0faef94b8e8090321ca. Standard bounded PR.
Authority: AGENTS, SECURITY, SDD, SPEC AC-01/04/05/06/07/08/09/10
(partial), ARCHITECTURE, ADR-0015, ROADMAP 05P, merged D1-D6.
Entry: D6 merged, develop checks green, no open CodeQL alerts.

Expose D6 in the actual Standalone ItemView, through narrow host callbacks.
Keep existing lexical search default, API v1 and legacy Advanced UI unchanged.
Explicitly choose dense or hybrid, terms matching only for dense, existing
typed filters, tag/link predicates and Top-K; require explicit exact Markdown
path selection and declared dimension for the configured embedding model and
revision. Reuse existing supported identity serialization/normalization.
Provide separate explicit rebuild and search preparation, no automatic egress
or indexing. Display the exact selected corpus, embedding space, endpoint,
query, disclosed original excerpts (all document inputs for rebuild; query
only for search), classification boundary and expiry before confirmation.
No truncation of consent preview, no hidden fallback, no credential persistence
or echo. Use D6 host's authoritative preview/confirmation once, not a separate
grant issuer. Clear token and preview on confirmation, cancellation, view close,
input edits and source/settings/lifecycle invalidation. Prevent stale results
and navigation after any revocation or supersession, including asynchronous
prepare/confirm/open and multiple view lifecycles; reuse verified navigation.
Expose explicit requested/executed mode, per-leg results and typed errors;
configured is not ready, compatible verified generation is not proof of live
provider availability. Do not modify legacy API v1 or imply Gate B acceptance.
Versioned machine integration is a subsequent D8 contract, without machine
self-authorization. No cloud calls, real Vault, paid credits, model downloads,
new dependency or unrelated changes.

Tests: real host synthetic Markdown corpus, authenticated deterministic local
HTTP fixture with no route; no calls before explicit approval, cancellation,
source mutation, config/space changes, replay, missing index, provider failures
including 429/timeout and invalid responses, lexical independence, metadata
eligibility, verified navigation and lifecycle cleanup. Focused adversarial
unit tests plus real packaged host UI, no-route basic smoke, typecheck, full
Node/Python tests, licenses, package and security checks. Independent contract
review before production changes; exact-HEAD independent full-diff review and
CI before merge. No actual model quality/production readiness claim.
