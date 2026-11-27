# ADR-0013 — Source synchronization boundary

**Status:** Proposed.

## Decision

Source synchronization is outside OKS. The plugin operates on locally accessible authoritative Vault files, regardless of how they arrive. No particular synchronization service, account, deployment topology or external client is required. Reconcile source changes and validate current identity and content before publishing evidence. Portable embedding exchange (ADR-0010) is independent, optional and disabled by default; it does not authorize or implement source synchronization. Use separate credentials and permissions for any independent services.

## Acceptance

Use synthetic source create, modify, rename, delete, conflict and delayed-arrival cases to verify freshness and recovery. No provider-specific deployment claim is implied.
