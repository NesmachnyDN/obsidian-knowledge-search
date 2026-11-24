# OKS-05P-D4 — Authoritative selected corpus and explicit dense index replacement
Base: d03ae59a07aad772a91880ef8cd0097af0773494. Standard bounded PR.
Authority: AGENTS, SECURITY, SDD, SPEC AC-01/04/05/06/08/09/10 (partial),
ADR-0015, ROADMAP 05P, merged D1-D3 and postmerge Gate A.
Capture a complete explicitly selected Markdown corpus from the authoritative
ready standalone lexical generation, never a top-K query or caller-assembled
EvidenceHit list. Reject unknown, partial/empty, duplicated or oversized
selection, and preserve original line evidence and typed Properties. Include
all nonblank body lines, including lines not matched by token search; exclude
frontmatter/blank lines. No metadata-anchor retrieval claim. Bind a monotonic
lease to the exact lexical generation, source events, readiness and cancellation.
Recheck original bytes/locators before and after each document embedding call.
Provide an internal explicit rebuild/model replacement manager using existing
EvidenceEmbedder, exact per-batch host grants, existing one CURRENT store and
D2 atomic publication. Validate all batch limits before egress; no truncation,
parallel generation, hidden indexing or background retry. Verify exact grant
scope, configured space, evidence and authorization fence; reject provider
failure, stale source, cancellation or incompatible input without promoting a
partial generation. Admission is single operation per manager, local filesystem
verification drains cooperatively; provider calls retain their existing bounds.
Keep prior compatible committed index on pre-publication failure, and use D2's
fail-closed behavior on uncertain publication. No new dependency, no UI/public
machine API change, no cloud/real Vault or real provider/model claim. UI, machine
API, source event wiring and metadata-anchor eligibility are subsequent slices.
Test real lexical engine and synthetic loopback HTTP: exact selected corpus,
limit and typed evidence, revision lease, batch grants/denial, failed second
batch, model switch, cancellation/invalidation, and old CURRENT preservation.
Full regression, isolated host evidence and independent exact-HEAD review
before merge; Gate B still requires real authorized provider acceptance.
