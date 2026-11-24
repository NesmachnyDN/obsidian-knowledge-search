# OKS-05P-D2 — single active API dense generation
Base: 8c8e983dd8cfbea7c820c60c308f50e415397032. Standard bounded PR.
Authority: AGENTS, SECURITY, SDD, SPEC AC-04/06/08/09/10 (partial),
ADR-0015, ROADMAP 05P, merged D1 and postmerge Gate A.
Extend the existing AdvancedRetrievalStore CURRENT publication boundary with
a versioned API generation. Keep legacy generation readability, explicit
full replacement between spaces, same private directory, no per-model cache.
Build a complete selected evidence-set generation from D1 document batches,
reject omissions, duplicates, wrong purpose, stale source and mixed spaces.
Use in-process verified batch and built-generation provenance capabilities;
reject swapped, fabricated, mutated or cross-scope batch/evidence pairs.
Persist only source/locator identity and vectors, not raw excerpts or tokens.
Verify exact source bytes at publication and on API snapshot; revoke on events.
Guard competing instances within the single Obsidian process, reject disk
pointer drift; concurrent separate OS processes remain unsupported.
Test legacy/API/model migration, cancellation, cold recovery, cleanup,
incorrect dimensions/coverage and freshness. No UI integration, query ranking,
hybrid fusion, real provider, cloud egress or Gate B claim in this slice.
Run full regressions and isolated host fixtures and no-route Gate A;
independent exact-HEAD review and CI mandatory before merge.
