# OKS-05P-C1 — grounded generation transport and evidence contract

Base: 4fa91714eff7e050b40450ef6e9c473ea868fdf4. Standard bounded PR.
Authority: AGENTS, SECURITY, SDD, SPEC AC-06/07/09/10/11 (partial), ADR-0015,
ROADMAP 05P, merged 05P-A/B. Gate A post-merge smoke passed.

Extract shared bounded loopback JSON transport and verified evidence operation
from the reviewed reranker. Preserve its public behaviour and existing tests.
Add generation using a revision-pinned OpenAI-compatible chat-completions
request, structured JSON output, no tools, no streaming, token/wire limits,
source ordinals only and exact role-specific disclosure. Quotations must be
literal substrings of every cited excerpt; inferences are explicitly unverified
model conclusions with real evidence references, not validated facts.
Reject missing, fabricated, duplicate or invalid citation IDs, unknown fields,
truncated, tool-call or malformed responses, and wrong model. Empty claims
mean no answer. Verify source evidence before and after request and suppress
stale/aborted results. No model invocation outside the deterministic synthetic
loopback fixture; no cloud, real Vault, provider selection or Gate B claim.
No generation UI or readiness activation in this slice; next C2 integrates
explicit consent and host acceptance. Run tests, package, no-route smoke and
existing rerank host fixture to establish regression. Independent exact-HEAD
review plus CI before merge.
Protocol reference: https://docs.vllm.ai/en/stable/features/structured_outputs/
