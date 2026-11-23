# OKS-05E-A1 — Standalone literal occurrence & exact-line phrase search

**Mode:** BOUNDED_SLICE -> IMPLEMENTATION -> VALIDATION -> DRAFT_PR -> INDEPENDENT_REVIEW_REQUIRED.
**Base:** `develop` at `86569aab8c031ca7dab0b74257691ade60b8f47e` (merged ADR-0010–0013).
**Requirements:** ADR-0015, SPEC mandatory Gate A: AC-01/06/07/08/09/10; ROADMAP OKS-05E. No dependency on optional OKS-05D/05P or OCR.
**Motivation:** The existing Standalone token-based lexical search cannot satisfy literal Unicode substring and ordered phrase queries. The mandatory Gate A must not infer occurrence behavior from token ranking.

## Scope
- Add an explicit `matchMode: 'literal' | 'terms'` to the existing local search protocol-v2 request, rejecting unknown values. Backward-compatible requests without this field continue using terms/identifier ranking; the Obsidian UI selects literal by default and explicitly permits terms.
- Literal is case-insensitive original-physical-line substring search on Markdown source text (including punctuation, UTF-8 Cyrillic, emoji and phrase order). It excludes frontmatter typed-Property and empty lines, which remain metadata/unsupported text search. Return the same verified original-line EvidenceHit with validated source byte hash and locators. Never search heading context as if it appeared on a source line.
- Reuse existing bounded index, freshness, scope, predicate, cancellation, publication and source navigation. Do not add network, Python, backend, model, dependencies, new index schema, raw paths in logs or new persistent settings.
- Add automated positive and negative tests, and real isolated Obsidian Desktop/CLI 1.15.1 no-route UI smoke using the already packaged three assets.

## Explicit exclusions / remaining Gate A work
- Cross-physical-line phrase matching and text-range highlighting (only verified original line selection in A1).
- Metadata-only search with an empty text query; independent tag/wiki-link predicate filtering and Obsidian frontmatter compatibility expansion. These require separate bounded slices and acceptance.
- Optional PDF/DOCX/OCR (Gate C), embeddings/rerank/LLM/API (Gate B), new-Vault deployment and production documents.
- Independent release acceptance: an author cannot APPROVE or merge this Draft PR.

## Validation gates
- Existing TS/Python suites, typecheck, licenses, build, packaging, benchmark (record observed values, do not claim universal targets).
- Literal vs ranked terms RU/EN, partial tokens, phrase order, punctuation-only inputs, emoji, typed predicate and scope, non-indexed YAML lines, malformed requests and source mutation without events. Legacy protocol-v2 requests unchanged.
- Desktop/CLI synthetic Vault under `unshare -Urn`: mode toggle, literal match, negative out-of-order phrase, explicit terms mode, typed Properties, navigation and clean removal. No real Vault access and no downloads.
- `git diff --check`, clean source boundary, exact-HEAD CI, and new independent full-diff SDD review before any Ready/merge.
