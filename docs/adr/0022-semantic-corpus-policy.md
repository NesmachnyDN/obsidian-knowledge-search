# ADR-0022 — Curated semantic corpus and indexing policy

Status: maintainer-approved target direction (2026-11-27), pending independent DOCS_ONLY acceptance. Not a runtime or deployment acceptance. Applies prospectively to CAP-04/05/06/07/08/09/10/11/12/14 and AC-18 below; does not change historical evidence, active slice contracts or the mandatory provider-free Gate A.

**Refinement (ADR-0023):** a configured hard search-scope exclusion applies to ordinary search as well as AI and cannot be overridden by explicit-source selection; AI-only exclusions retain the Basic Search behavior below. No producer dependency or mandatory note writes. This is a prospective requirement, not evidence that the exclusion is implemented.

## Context and decision

A Vault is the authoritative knowledge and evidence repository, not a vector index. Curated notes can contain reusable findings while their linked raw logs, datasets, spreadsheets, scripts and historical originals are evidence rather than useful default retrieval candidates. Conversely, an original technical document may be the only useful content. Select the semantic corpus independently of storage, ordinary text search and processing permission.

Use one optional exact scalar string note Property, `ai_indexing`, with the following target contract:

| Value | Note eligible for automatic AI retrieval | Verified owned attachments eligible |
| --- | --- | --- |
| `full` | yes | yes |
| `note_only` | yes | no |
| `attachments_only` | no | yes |
| `none` | no | no |

"Eligible" is an upper bound, not a provider grant or supported-format claim. Verified absence uses the configured default (initial default `note_only`). A missing or unreadable original, ambiguous/duplicate key, malformed YAML, null, list, unknown value or conflicting interpretation is not absence: exclude from automatic AI retrieval with a diagnostic until resolved. Parse current original metadata using the existing canonical local source/metadata path. Do not write Properties automatically, require new mandatory fields, or infer ownership from arbitrary wiki-links.

## Resolution and scope

Offer native RU/EN settings for the default and deterministic configurable folder-segment, note-type, typed Property, tag, file-type and purpose/collection rules. Global exclusions (including explicitly designated control-plane folders, raw intake, logs/dumps, test datasets and temporary/cache material) are hard upper bounds; a note Property may narrow but cannot override them. The initial default is note_only, with configurable exclusions by Vault; never hard-code a particular user's folder names, blanket exclude all PDF/XLSX/TXT, or treat a file extension as a confidentiality classification. Expose a local preview with effective decision and reason. A user can deliberately reconfigure an exclusion; no silent automatic widening. No new note metadata writes or bulk migration are authorized.

For a shared attachment, verify all owning notes and their versions using the existing source/attachment ownership contract; intersect each owner's attachment eligibility with independent file rules and the permitted scope. Missing/ambiguous ownership excludes automatic AI retrieval until resolved; a permissive owner or direct link cannot override a restrictive owner. Attachment formats remain independently gated under ADR-0017. Unrelated backlinks are not ownership. Derived excerpts, cached chunks, summaries, graph expansion and portable artifacts retain source identity/version, eligibility and restrictive provenance. Unknown lineage is not automatically eligible.

The effective automatic AI corpus is the intersection of indexing eligibility, current verified sources, existing Vault and selected-material scope, supported capability/format, and applicable role/provider processing restrictions. Apply the same corpus predicate **before** document-embedding requests, dense candidate generation, the lexical leg of hybrid, lexical-only automatic AI retrieval, reranking and automatic RAG/context/graph expansion (including history reuse). No excluded content through an alternate path. A basic text/Properties result, linked original, or locally extracted attachment may still be visible to the user under existing basic/document-profile scope, format and safety rules; do not make AI eligibility a prerequisite of ordinary offline search or original navigation.

Explicit deliberate reference to a particular excluded original is not automatic retrieval: where an independently accepted explicit-source context path exists, allow a user to deliberately select the exact original/range without silently adding it to the semantic index or widening automatic retrieval. Show the exclusion and explicit-use boundary, verify current source/version, scope, all applicable processing restrictions and exact consent; no implicit selection via links, graph, history or folder scope. Hard organizational, scope, security and unsupported-format denials cannot be overridden. If explicit-use handling is unavailable, return a typed unavailable result; opening the original locally remains separate.

`llm_processing` (ADR-0019) remains the independent confidentiality/provider eligibility policy. Indexing permission never grants processing, trusted profile admission, external egress, access or consent. `private` is not a synonym for `none`; `full` never overrides `private`. Preserve the existing strict pilot and all provider/role/format/host gates. No additional authorization to use actual Vaults, providers, paid requests or secrets.

## Lifecycle, persistence and UX

Use the existing host authority and canonical generations, not a second search engine or parallel index. Bind effective corpus/rule revision, original versions, owner identities and applicable profile/scope to the existing lease/consent/manifest contracts. On Property/rule/default/ownership/source change, rename/delete, disable or restart, immediately fence obsolete candidates, in-flight work, grants and publication before observers; reconcile missed events. Remove excluded vectors from the active compatible dense generation and invalidate affected automatic-AI caches/derived context and portable activation. Retain ordinary Basic Search and authorized source files/local extraction caches under existing policies; do not delete source originals. Re-enable through verified incremental reconciliation and reuse only exact compatible permitted artifacts. Publish atomically, recover after crash, retain one active compatible dense index per Vault, with staging only for atomic rebuild. No provider work merely because a setting changes, unless independently authorized and budgeted.

Show counts of eligible/excluded notes, attachments and chunks, estimated tokens where measured or clearly labeled estimates, reasons, pending work, stale/unavailable status and cost/coverage diagnostics. No raw private text, secrets or unnecessary paths in exported diagnostics. A missing optional AI corpus does not disable offline basic search. Do not label a denied or partial hybrid/RAG operation as successful; distinguish intentional policy exclusions from errors and unprocessed sources.

## Delivery and acceptance

See CAP-18 / AC-18 in SPEC and OKS-06I in ROADMAP. Documentation acceptance approves only this target contract. Implement in dependency-ordered bounded slices after reconciling active OKS-06 work and relevant role/ownership/lifecycle contracts; verify the exact supported host and role before claiming functionality. No production Vault or metamodel changes, provider calls, source writes or historical acceptance changes in this ADR.
