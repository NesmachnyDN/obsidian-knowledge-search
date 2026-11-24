# OKS-05P-D3 — API-backed dense and hybrid retrieval core
Base: 7a3484572d87812793807ab6173b0efc6e2f1027. Standard bounded PR.
Authority: AGENTS, SECURITY, SDD, SPEC AC-04/05/06/08/09/10 (partial),
ADR-0015, ROADMAP 05P, merged D1/D2 and postmerge Gate A.
Use the existing single CURRENT API store and query-only EvidenceEmbedder.
A trusted host supplies the complete selected lexical EvidenceHit set, current
lexical generation, per-source permission and monotonic operation fence.
Authenticate exact entry identities/coverage; never substitute lexical hits
for missing vectors. Use compatible query vectors, cosine rank, deterministic
tie order and existing RRF (k=60) over independently executed lexical top-50
and dense top-50. Apply exact-path scope and typed Properties before rank.
Lexical leg uses the existing engine; reject candidates outside the approved
indexed set rather than silently dropping them. Empty executed lexical leg is
valid. Return a separate internal result envelope with explicit requested/
executed mode, leg statuses, original evidence and scores; never label a
failed AI search as lexical success. Retain lexical v2 API unchanged.
Reject metadata-anchor and dense literal requests explicitly in this slice;
host selection, metadata eligibility, index management, UI and machine API
integration follow separately. No whole-Vault coverage claim.
Bound candidates to D2 limits, one search at a time, verify the generation
before/after provider and lexical operations, add synchronous snapshot lease
fence to prevent same-process revocation between final await and return.
Test real existing lexical engine plus synthetic local HTTP query embeddings,
rank, scope/typed filters, zero lexical hits, mismatched space/source/coverage,
denial, cancellation, concurrent invalidation, provider/lexical failure.
No real provider, cloud egress, model downloads, real Vault or Gate B claim.
Full regression and isolated host evidence; independent exact-HEAD review and
CI before merge. No new dependency.
