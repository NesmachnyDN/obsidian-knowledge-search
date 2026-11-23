# OKS-05E-A2 — Typed metadata-only queries, tags and wiki-link targets

**Workflow:** BOUNDED_SLICE → AUTHOR_IMPLEMENTATION → HOST_VALIDATION → DRAFT_PR → INDEPENDENT_REVIEW.
**Base:** PR #19 A1 exact HEAD `e82f46cbc64ca3bfaf02efff462687e4620e92a0`, based on `develop=86569aab8c031ca7dab0b74257691ade60b8f47e`.
**Requirement:** ADR-0015; SPEC CAP-01/06/07/08/09/10 and mandatory Gate A; ROADMAP OKS-05E. No Gate B, C, Python, backend or network dependency.

## Scope
- Extend the existing strict Standalone in-process protocol-v2 request with optional bounded `metadata: {tag?:string;linkTarget?:string}`. Omitted metadata preserves all previous callers. Allow exactly `query: ''` only when one or more typed Properties predicates, a tag or a wiki-link target are specified. Reject whitespace-only queries, malformed/unknown metadata, unbounded values and empty unfiltered searches.
- AND-combine metadata constraints, existing exact typed Properties and scope **before** Top-K. Support frontmatter YAML `tags` as scalar/typed string array, inline Markdown `#tag` outside frontmatter/fenced code, and exact authored wiki-link target from `[[target|alias]]` with alias intentionally ignored. Do not resolve/expand the link graph or claim alias matching. Index and evaluate only existing parsed originals; no new persistent index schema.
- Metadata-only hits must select an **actual matching original line** (typed frontmatter key, inline hashtag or matching wiki-link), return its original verified byte/line/codepoint locator and never fabricate text. Preserve stale-version, cancel, rename, delete and navigation verification.
- Expose optional tag/link-target controls in Standalone UI alongside typed Property filter; changing any query/filter control clears stale results. Fully isolated no-route Obsidian Desktop/CLI with synthetic Vault only.
- Tight positive, negative and adversarial tests: tag case, scalar/list tags, mixed RU/EN, wiki alias vs exact target, malformed tags, metadata AND/typed filter/scope, no conditions/unknown keys, source mutation, forged text, UI after changes. No model/OCR/dependency downloads or production Vault access.

## Exclusions / limits
- No cross-file graph traversal, backlink resolution, Obsidian cache semantic inference, external URLs, cloud search, or full YAML parser replacement.
- Only supported standalone Markdown syntax; unsupported YAML and nested structures remain explicit partial/invalid, not silently coerced. Existing A1 physical-line phrase scope unchanged.
- No author self-approval; A2 review is dependent on independent exact-HEAD A1 review and integration; keep PR Draft with base #19 until A1 merges, then retarget to develop, rerun exact-head gates and review.
