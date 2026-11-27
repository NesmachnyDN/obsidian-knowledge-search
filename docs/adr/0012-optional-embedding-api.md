# ADR-0012 — Opt-in embedding API without cloud document processing

**Status:** Proposed (maintainer-selected target, 2026-11-23; independent review/merge pending).
**Scope:** optional API-based dense embedding-provider candidate under ADR-0015 Gate B-Dense; mandatory offline Gate A is independent of model/API provisioning.
**Related:** ADR-0006 (Standalone/Advanced boundaries), ADR-0010 (embedding identity, local index and portable vectors), ADR-0011 (local Docling/extraction cache), CAP-04/05/08/10/14.

## Context

Optional dense retrieval can use a configurable compatible embedding API without requiring local inference or remote document parsing. BGE-M3 is a reference compatibility candidate, not a required product model. Verify endpoint behavior and model identity with synthetic inputs before claiming provider support.

## Decision

1. **Optional API-based embedding.** Evaluate a separate **disabled-by-default** provider-neutral embedding adapter for the independently claimed B-Dense role. A configured local API may also provide embeddings, including offline service where verified; the historic one-shot `local-offline` model remains an optional non-API experimental runtime, not a mandatory Advanced MVP dependency. Selection is explicit and visible; no automatic network fallback from local Docling, local BGE-M3 or search, and no silent downgrade from requested dense/hybrid to lexical. Failure returns a typed capability/provider error with separate recovery path.
2. **Fixed boundary:** all PDF/DOCX/scan parsing, local RU/EN OCR, original source metadata/provenance, chunking, embeddings cache lookup, SQLite/embedded vector indexing and RRF happen **on the user's machine**. Only canonical, user-authorized **embedding-input strings** (including their contextual prefixes) are transmitted over TLS to the BGE-M3 API, with the minimum provider-required request fields. Never upload source binary files, the Vault, local SQLite, full parsed-document artifacts or collected credentials.
3. **Consent and classification:** zero egress by default. Require explicit per-Vault *and per allowed scope/source category* opt-in before sending any text; deny sources lacking the required authorization under the applicable information-handling policy. Explain that embedding inputs contain document excerpts and contextual headers and are **not anonymized**. Provide preview/confirmation for initially enabled scope; allow revocation, offline disable and audit metadata. Lack of consent results in no cloud call, not a forced cloud upload.
4. **Credentials:** use scoped credentials in a private secret store. Support rotation/expiry, reject unsafe permissions and symlinks, never echo values or include secrets in process arguments, exceptions, diagnostics, repository artifacts or telemetry. Use runtime-only injection through a bounded provider adapter.
5. **Provider and index compatibility:** request the configured model from the configured embeddings endpoint. Confirm response shape, expected dimensions (1024 for the BGE-M3 reference profile), finite components, L2 norm, provider model identifier, input chunk count and usage metadata. Store provider namespace/endpoint, observed model identity, explicit serialization profile, numeric encoding and validated output probe fingerprint in a **separate, versioned cloud embeddingSpaceId**. A matching model name, dimensionality and normalized norm are **not** proof that remote and local spaces are equal. Do not mix cloud/local vectors or port them across runtimes until independently compared on a fixed RU/EN technical corpus with pinned identity and tolerance policy. When provider changes weights invisibly or parity cannot be established, isolate/rebuild its vector generation rather than silently reusing incompatible cached entries.
6. **Cost control:** track actual `usage.prompt_tokens`, request count, retry count, per-source/chunk cache hit rate, estimated currency spend and daily/monthly per-operator ceilings. Implement a **local hard stop** (admission check) on request/token budgets rather than relying only on cloud billing alerts; price is a configurable dated input, not a hard-coded truth. Enforce max batch payload, rate limit, concurrency, timeout, cancellation, bounded exponential retries and safe checkpoint/resume to prevent unintended repeated charges. Never claim the provider guarantees exact cost at the estimate. No bulk indexing until explicit authorization and privacy/cost preflight.
7. **Reuse and portability:** computed vectors are persisted in the local content-addressed embedding cache, reused for identical effective inputs, then placed in private local vector index. When compatible and explicitly authorized, vectors (not texts) may participate in ADR-0010's optional private S3-compatible immutable-artifact export, separate from the source-Vault sync bucket. Provider identification and model drift checks are prerequisites for multi-host reuse; one active compatible dense index is retained per Vault, with staged reindex on model change. A novel search query still needs a compatible selected query encoder.
8. **Operational safety:** Provider outages, expired key, quota, cost cap or internet loss must not break autonomous Standalone or any independently configured local AI API / local experimental profile. If the user explicitly requests cloud dense/hybrid and provider readiness is absent, report an error/status rather than mislabel lexical-only execution. No global cloud access, no direct key use in the browser renderer, no default listeners and no remote Docling.

## Options not selected

| Option | Status |
|---|---|
| Managed RAG / remote vector DB / GPU VM | Rejected as the default; index and data remain local. |
| Cloud Docling/Docling Serve | **Rejected**; ADR-0011 sets local-only extraction. |
| Cloud provider as mandatory MVP dependency | Rejected; violates autonomous Gate A and optional role-specific Gate B. |
| Assume cloud and local BGE-M3 are interchangeable | Rejected until fixed-corpus numerical/quality and identity validation. |
| Explicit opt-in cloud embeddings with local caching/indexing | **Selected candidate** for a later optional Gate B-Dense integration. |

## SDD delivery and acceptance

**OKS-05D:** preserve a separately reviewed local BGE-M3 experiment as optional reference, with no cloud provider claim. **OKS-05P** defines the API-provider contract for each independently enabled AI role. **OKS-06E (after 05P and baseline 05E acceptance)** validates configurable as a conditional B-Dense adapter with independent ADR/implementation reviews. Neither 05P nor 06E blocks Gate A.

Positive/negative acceptance: synthetic expected-dimension vector contract; local/offline profile unchanged; explicit consent required before any network egress; unauthorized scopes and Vault docs not transmitted; invalid/empty/error/rate-limited responses, network outage and rotated keys fail clearly; measured capped batches/retries, token-cost enforcement and zero duplicate calls on identical cache hit; model drift/parity mismatch isolates index space; secrets absent from artifacts/logs/test output; revoke/disable restores offline behavior and keeps last compatible generation, with no hidden fallback. Use only synthetic fixtures until separately authorized.

**No cloud account/bucket changes, secret reads, paid batch calls, source uploads or bulk indexing are authorized by this ADR.**
