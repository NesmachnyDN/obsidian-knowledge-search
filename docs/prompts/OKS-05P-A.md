# OKS-05P-A — provider contracts and disclosure foundation

Base: 0a2ff17746d47f1ceedb523979a2e88b28b2a1d4. ITERATION, standard bounded PR.
Authority: AGENTS, SECURITY, SDD, SPEC AC-06/07/09/10/11 (partial), ADR-0015,
ROADMAP 05P; 05R (#17), 05C (#16) and basic Gate A (#20) are merged.
The existing 05D model-specific worker and evidence remain unchanged.

Implement versioned provider-neutral interfaces for the three roles, independently
validated non-secret preferences (settings v5 migration), metadata-only status,
and a fail-closed pure disclosure projection. Grants must bind the exact
configuration, scope, query and authorized original excerpt versions, expire,
and admit only explicitly classified synthetic/public material in this slice.
No adapter, credential persistence, API call, network listener, inference,
dense generation, or production readiness claim. Configured is not ready.
No production Vault, paid calls, new dependencies or model downloads.

Verify role independence, migration, malformed settings isolation, endpoint
and grant denial, expiry, model/scope/source mismatch, bounded payloads,
cancellation, and no source paths or secrets in the projection. Run typecheck,
build, Node/Python regressions, licenses, package and isolated offline desktop
smoke. Independent exact-head full diff review plus CI before merge.
Next dependent slice: loopback authenticated rerank API adapter and controller
with verified lexical evidence and lifecycle revalidation. Real Gate B remains
unavailable pending measured authorized model API and host acceptance.

## Prospective transition reference (not a change to this pilot)

This reviewed pilot contract and its stricter synthetic/public authorization remain unchanged for current execution and historical evidence. Subsequent 05P role integration (including all B/C/D clients) follows [ADR-0019](../adr/0019-note-processing-policy.md) and [OKS-06H-POLICY](OKS-06H-POLICY.md) only through independently accepted bounded implementation slices. No grant from metadata alone, no change to provider admission, one-shot consent, scope, credential, lifecycle or existing evidence gates.
