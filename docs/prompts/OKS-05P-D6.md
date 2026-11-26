# OKS-05P-D6 — Trusted host lifecycle and embedding permission bridge

Base: d652fc298fd91a59209df99825661016db24c74a. Standard bounded PR.
Authority: AGENTS, SECURITY, SDD, SPEC AC-01/04/05/06/07/08/09/10
(partial), ARCHITECTURE, ADR-0015, ROADMAP 05P and merged D1-D5.

Attach an internal API-dense coordinator to the actual Standalone host
lifecycle. Reuse D3-D5, the one CURRENT store and authoritative lexical
corpus lease. No startup provider calls, implicit indexing, automatic
disclosure or second vector store. Legacy ingestion/model and API dense
operations are mutually exclusive in this slice. No new dependency.

Prepare an explicit selected-corpus rebuild or dense/hybrid query preview
from the current engine, configured local pilot endpoint and declared
embedding space; no HTTP at prepare. Preview must bind exact operation,
source bytes/evidence, lexical generation, Vault, config and space.
Only a matching, unexpired, one-time confirmation explicitly classifying
the query and all selected source evidence as synthetic or public may
issue ephemeral per-batch document or query grants. Credentials are
transient, never part of preview, persistence or diagnostics. No generic
grant minting from note metadata, persisted config or machine requests.
Recheck authoritative selection and original evidence, deny unknown or
changed sources, and enforce a single active operation.

Invalidate pending preview and abort active work on Vault create/modify/
rename/delete/metadata events, settings changes, pause/cancel/rebuild,
disable or unload. Revoke affected store snapshots; prevent replacement
host from racing a prior writer on reload. Preserve lexical independence,
last consistent CURRENT, no stale or fabricated hits, explicit errors.
No network listener, cloud, real provider, real Vault, model downloads or
paid credits. No public UI/machine API in D6; subsequent bounded slices
wire explicit consent UI and versioned API with separate review.

Positive and negative synthetic loopback tests: no HTTP before consent,
tampered/replayed/expired preview, config/source revocation, exact
selected corpus, query-only egress, metadata-filtered hybrid, cancellation
during HTTP, restart/dispose, disabled/cloud/legacy conflict and basic
search preservation. Run typecheck, full local regression, immutable
package and isolated host smoke, CI and separate exact-HEAD review.
No Gate B claim.

## Prospective transition reference (not a change to this pilot)

This reviewed pilot contract and its stricter synthetic/public authorization remain unchanged for current execution and historical evidence. Subsequent 05P role integration (including all B/C/D clients) follows [ADR-0019](../adr/0019-note-processing-policy.md) and [OKS-06H-POLICY](OKS-06H-POLICY.md) only through independently accepted bounded implementation slices. No grant from metadata alone, no change to provider admission, one-shot consent, scope, credential, lifecycle or existing evidence gates.
