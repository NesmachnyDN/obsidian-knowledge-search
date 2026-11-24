# OKS-06UX-CHECK — Explicit connection tests in Settings

**Status:** proposed maintainer-requested acceptance contract; no runtime
implementation, provider approval or production access is implied.
**Planning base:** `2e6bcd3e6c21e4fc7391ae7e718d1f8805026144`.
**Authority:** AGENTS.md, SECURITY.md, SPEC AC-04/07/09/10/11/12/14,
ARCHITECTURE, ROADMAP, ADR-0010/0013/0015, SDD, OKS-06UX UX-04/UX-AC04/06/08/09,
OKS-06UX-L10N. Preserve all already accepted behavior.

## User-facing requirement

In each independent embedding, reranking and generation connection editor,
and in the optional OKS portable-artifact S3 connection editor when implemented,
show an accessible **Check** action (Russian: **Проверка**) next to the
connection settings / Save action in Basic and Expert views. Check the current
complete draft, including unsaved edits, not an older persisted connection.
No implicit Save, enabling a role, grant issuance, indexing or sync. A check
must be a real role-specific operation, not merely local field validation,
TCP reachability, model-list lookup or unconditional success.

Validate the draft before network access. One explicit click starts one
bounded test using the exact displayed settings and the approved credential
mechanism. If a credential is needed, request it transiently using a masked
field (or reuse an existing approved secure resolver); do not persist it in
settings, Vault data, logs or diagnostics. No additional consent to send
private content follows from Check. Explain the synthetic-only network
operation and possible request billing before execution; use no Vault data.
Opening, changing or saving Settings never issues a test request.

While running show Checking / Проверка выполняется and prevent duplicate
requests. On completion show an adjacent textual success or actionable typed
failure, with elapsed time and checked capability; raw diagnostic codes may
be shown but never raw response bodies, credentials or untrusted server text.
Editing any checked field invalidates the prior result. Bind completion to
the exact draft snapshot and editor lifetime; cancellation/closing/disabling/
unloading aborts the request and discards late results. Localize through the
existing RU/EN catalog. No result is persisted as an authorization, permanent
readiness or a claim about the quality of the model/index.

## AI — role-specific checks

Use the actual supported runtime transport and validation contract for the
selected role, including exact model/revision or approved provider-specific
identity, authentication, endpoint policy, deadline, bounded request and
response, and cancellation. Do not add a second generic HTTP client or bypass
a runtime identity check. Use fixed synthetic text independent of the Vault.

| Role | Actual check | Success means |
|---|---|---|
| Embedding | One synthetic embedding request | Nonempty finite vector, correct model identity and adapter-required shape/normalization; configured dimension if present, otherwise report observed dimension without claiming space compatibility. |
| Reranking | Synthetic query and one or two synthetic candidates within configured limits | Valid score/index response under the real reranker contract, exact runtime identity where required; not a ranking quality benchmark. |
| Generation (LLM) | Small synthetic question and evidence, bounded output | Valid role-specific structured response under the actual generation adapter contract, correct identity; no real evidence or tool invocation. |

For unsupported endpoint or provider modes show unavailable and why, never
simulate a pass. As of the planning base, only the authenticated literal
HTTP 127.0.0.1 pilot is implemented. Do not extend local endpoint policy.
Cloud checks require a reviewed, implemented provider-specific HTTPS adapter,
approved origin/authentication, synthetic-only authorization, quota/cost
and transport rules (no redirects, no arbitrary proxy routing, no TLS bypass).
Do not use the local wire format for an arbitrary cloud endpoint or send a
token to a different origin. Reuse the same adapter as actual role execution;
an HTTP 200 alone is insufficient. Separate connection success from any
remaining consent or capability acceptance gates.

## S3 — portable embeddings only

ADR-0013 assigns ordinary Vault file sync to an external S3-compatible sync
client. This requirement applies to the optional OKS portable embedding
artifact transport (OKS-06C / ADR-0010), not a second Vault sync client.
No S3 settings UI or storage adapter exists in the planning base. Introduce
the Check action with the reviewed S3 adapter and settings contract, not a
nonfunctional button or new source-Vault sync implementation.

Use the configured endpoint, region/signing profile, bucket, prefix, access
role and dedicated S3 credentials with the same reviewed S3 client used by
portable transport. Start with a least-privilege read-only operation scoped
to the configured bucket/prefix and report exactly which permission was
verified; an empty bucket/prefix is not a connection failure. HeadBucket
alone is not proof of object-level read or write authorization. Never
enumerate other buckets, return real object names, read real artifacts,
create a bucket, alter ACLs or modify existing objects.

A separate explicitly authorized publisher read/write check may use a tiny
synthetic object under a collision-resistant, isolated probe key in a
designated test prefix, with conditional creation, read-back integrity and
cleanup of that exact key only. Respect publisher/consumer permission
separation and versioning/retention; do not imply cleanup where a retained
version or deletion failure remains. Do not perform write tests on a
read-only consumer. Report read-only versus write-verified explicitly;
do not claim portable publication/import or data-processing approval from
a successful connection check. Live bucket tests require separate approved
scope and credentials; use synthetic S3 fixtures for development and CI.

## Delivery order and non-regression

1. Independently review this contract; reconcile fresh develop, #53 (rerank
   identity, transport and Settings changes) and #46 (06C content-reconciliation
   contract) before implementation in their respective areas. Do not merge
   stale/overlapping code or amend those candidates without authorization.
2. Bounded AI Settings implementation: supported local roles first, using
   the accepted runtime contracts. Each approved cloud adapter subsequently
   delivers its own supported check, before claiming that role ready.
3. Bounded S3 implementation within OKS-06C after its architecture and
   adapter prerequisites. Reconcile the contract with the final accepted
   06C content-reconciliation scope. No Gate A dependency.
4. Independent exact-HEAD full-diff review and applicable CI for each
   implementation PR. No real Vault install, credentials, production
   endpoint calls, paid inference or deployment authorized by this contract.

## Acceptance

- CHECK-01: all supported role editors and the future S3 editor expose
  Check / Проверка in RU/EN Basic and Expert views; keyboard accessible,
  readable in narrow panels, no color-only status.
- CHECK-02: invalid/missing settings, token and unsupported profiles fail
  closed before I/O. Saved vs unsaved configuration and independent roles
  are exercised. No network from render, save or unrelated settings.
- CHECK-03: synthetic local fixtures prove real role request, response
  shape/model identity, exact endpoint/auth, success and bounded failures
  (401/403, rate limit, timeout, connection failure, malformed response,
  mismatch, redirect, cancellation). No secret or payload leakage.
- CHECK-04: configuration edits, duplicate click, close, disable, unload
  and late responses cannot publish stale success or keep requests alive.
  No new durable state, index changes, source access or standing consent.
- CHECK-05: S3 synthetic fixtures verify exact signing scope, endpoint,
  bucket/prefix, read-only versus publisher rights, empty bucket, wrong key,
  access denied, timeout, missing bucket, TLS/redirect rejection, and
  failure/cleanup semantics where write checks are authorized.
- CHECK-06: deterministic unit/contract tests, actual isolated Obsidian
  RU/EN UI smoke, typecheck, build/package, security and applicable
  regression/CI. Basic offline search and previous valid index remain
  usable after all check failures. Live provider verification, if
  separately authorized, is recorded independently of synthetic evidence.
