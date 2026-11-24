# OKS-05P-B — bounded loopback reranking vertical

Base: 9d1569d9420a0d20a1aecefa4f7f12ffd9827cfe. ITERATION, standard bounded PR.
Authority: AGENTS, SECURITY, SDD, SPEC AC-06/07/09/10/11 (partial), ADR-0015,
ROADMAP 05P, merged 05P-A (#28). Gate A post-merge smoke passed.

Implement the provider-neutral reranker's authenticated HTTP transport for an
explicitly approved literal IPv4 loopback origin, using the Cohere-compatible
vLLM POST /v1/rerank shape with a revision-pinned served model alias. No redirect,
proxy, remote endpoint, auto discovery, retry, persisted credential or implicit
model health claim. Separate exact disclosure grant and source verification
remain mandatory. One request per approved operation; bound serialized input,
response, concurrency and total deadline. Reject malformed, partial, duplicate,
out-of-range and model-mismatched responses. Preserve original EvidenceHit
objects with a separate rerank score; no fallback. Source verification before
and after call, and lifecycle guard across awaits. No cloud or live Vault.
Use a deterministic in-process synthetic loopback endpoint in integration
tests; no model benchmark or Gate B claim. Public protocol reference:
https://docs.vllm.ai/en/stable/models/pooling_models/scoring/#cohere-rerank-api

Connect explicit one-shot confirmation of the exact query, excerpts, classification,
endpoint and served alias in Search UI; password input is ephemeral, never saved.
SearchController owns cancellation, current configuration/generation and lifecycle
guard, and keeps lexical results independent. Test the actual packaged plugin with
a synthetic mock server inside an isolated network namespace with loopback only.
Run typecheck/build, tests, licenses/package and no-route Standalone smoke;
independent exact-head review and CI before merge.
