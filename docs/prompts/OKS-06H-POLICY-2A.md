# OKS-06H-POLICY.2a — deterministic new-material rule substrate

Status: bounded implementation contract for issue #79. Base: `e5815a72e34f529ef43c868fa814d4384a0336cd`. Depends on accepted POLICY.1b current-original proof substrate. This is not POLICY.2b settings, lifecycle UI, or writer authorization.

## Scope and authority

Implements the local, typed, versioned dry-run rule decision required by SPEC AC-11-POLICY-02, ROADMAP POLICY.2, SECURITY.md and ADR-0019 “New material marking and provenance”. Reuse the existing canonical source bytes and bundled browser-worker policy proof. The result is a recommendation only: it is neither eligibility, provider admission, consent, a grant, nor a write instruction.

The rule configuration is bounded and exact: a schema version, default `leave-absent` / `set-external` / `set-private`, and ordered rules with folder **segments**, a verified import channel, `type`, `template`, tags and typed Property predicates. Its digest is the local rule revision. The existing compact worker proof is extended compatibly with validated typed frontmatter Properties for this rules-only use; lexical document/schema behavior is unchanged and no YAML parser is added.

## Decisions and failure handling

The caller supplies the exact source ID, SHA-256 and root; the current worker proof, a trusted lifecycle binding and (only where applicable) trusted import provenance must bind to those exact values. Import provenance is host/adaptor supplied and digest-bound; a note Property cannot assert it. Existing material is always left unchanged. Only `verified-new` material can receive a recommendation. Invalid/unresolved metadata, a version/root mismatch, lifecycle/provenance mismatch, missing required rule input, or invalid configuration returns immutable `leave-absent` with a typed reason. No diagnostic contains note body text. Decision completeness and external blocking are separate from the recommended action; any proposed mutation blocks external processing until authorized write and re-read. A completed leave-absent result is not consent.

Explicit `private` is never changed. Explicit `external` on verified-new material still undergoes all rules; private matches override it. Matching private rules win irrespective of order. Otherwise, the first matching external rule wins; absent a match, the default applies. All configuration rules are validated before evaluation, including unreachable ones. Folder matches use exact directory segments, not string prefixes. No coercion of Property types/values or tags is permitted.

## Explicit non-goals

No runtime wiring, native RU/EN settings, controller/provider/grant/persistence/transport, Vault access, note writing, external request, index/cache use, attachment inheritance, or full lifecycle UI occurs in this slice. POLICY.2b will own settings, separately authorized bounded/idempotent writing, re-read/re-evaluate and lifecycle presentation.

## Required evidence

Run typecheck and focused POLICY.1b/POLICY.2a tests. Cover synthetic original bytes and the bundled browser-worker adapter; invalid config/metadata, exact segment/type/template/tag/typed-property matching, private precedence, untrusted or missing channel, existing/new/unresolved lifecycle, root/version mismatch, stable revision, immutability, and zero outbound/write behavior. Do not commit, push, open a PR, or merge in this task.
