# OKS-05P-D1 — embedding API pilot and exact space identity

Base: 2bda98033afa6d70a7bdad0dc8914f47d3ff23c3. Standard bounded PR.
Authority: AGENTS, SECURITY, SDD, SPEC AC-04/06/07/09/10 (partial), ADR-0015,
ROADMAP 05P, merged A/B/C1/C2; Gate A postmerge PASS.
Implement authenticated literal-loopback POST /v1/embeddings JSON float adapter,
bounded input/response, exact model revision alias and validated ordinal coverage,
finite unit-L2 vectors, explicit dimensions and versioned raw UTF-8 serialization
and identity instructions. No implicit normalization/truncation or model substitution.
Bind embedding scope, purpose and space identity to the exact disclosure grant;
reuse the bounded pre/post source-verification operation for documents and
query-only grants, with no transfer of source IDs or document metadata.
No index creation in D1: the existing experimental BGE-M3 store is model-specific;
D2 must migrate its single-active publication boundary rather than add a second
permanent dense index. No UI activation, remote/cloud service, real model,
model download or Gate B claim. Run synthetic HTTP integration/negative tests,
all regressions, both existing host fixtures and independent no-route Gate A.
Exact-HEAD independent review and CI mandatory before merge.
