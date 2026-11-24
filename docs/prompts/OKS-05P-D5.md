# OKS-05P-D5 — Authoritative metadata eligibility for API retrieval

Base: f8388636b92ba3d4432fa343aa51a5498587c0e1. Standard bounded PR.
Reconciled with merged security PR #37; original implementation base
36b6e5cddedc1ec0ff4f7564c45f0f9ae67bd33c. No D5 source changes.
Authority: AGENTS, SECURITY, SDD, SPEC AC-01/05/06/07/09/10 (partial),
ARCHITECTURE, ADR-0015, ROADMAP 05P, merged D1-D4 and D4 postmerge regression.

For nonempty dense/hybrid text queries, apply existing source-authored tag
and exact wiki-link metadata eligibility before dense ranking and lexical
Top-K. Reuse Standalone metadataAnchor against the selected immutable lexical
generation; expose only eligible source paths through the internal D4 lease.
Do not infer tags/links from provider output or reparse evidence excerpts.
Require a trusted exact-corpus-and-generation-bound metadata eligibility port for metadata
requests; missing, stale or foreign generation/corpus selection fails closed before egress.
Intersect eligibility with existing exact scope and typed Properties; reject
unindexed or duplicated returned paths. Preserve original body evidence and
one CURRENT; do not index or fabricate metadata anchors. Empty text
metadata-only requests remain explicit lexical-only operations. Dense literal
remains unsupported. No metadata or source paths in embedding HTTP payload.

Test actual lexical engine and synthetic loopback API with frontmatter and
inline tags, exact wiki-link targets, alias, fenced-code exclusion, combined
filters, zero matches, missing/foreign/duplicate port output, lease revocation,
metadata-only rejection and unchanged lexical metadata navigation.
No UI, public machine API, event wiring, cloud/real provider, new dependencies
or real Vault. Full regression, isolated host evidence, CI and independent
exact-HEAD review before merge. Subsequent UI/machine API integration remains
a separate bounded slice; no Gate B claim.
