# OKS-06C — Portable embedding reuse: planning and acceptance obligations

Status: prospective requirements, documentation-only maintainer direction (2026-11-24). This is not implementation authorization, a frozen wire schema, or evidence of a passed gate. Before implementing, reconcile the actual develop state and earlier admissible slices, pin the base SHA, review the bounded execution contract and exact schema/protocol, and satisfy SDD entry dependencies.

## Authority and scope

- AGENTS.md, SECURITY.md, SDD, SPEC CAP-12/AC-12 with CAP-01/06/08/09/10 and conditional CAP-04/05; ADR-0008, ADR-0010, ADR-0013, ADR-0015; canonical source/evidence contracts.
- After independent Gate A acceptance in 05E and applicable 05P/05E dense-role acceptance. Portable reuse is optional and never a new Gate A requirement. Preserve one active model-compatible dense index and separate autonomous basic search.
- Reuse source identity, scope, chunk/evidence validation, lifecycle fences, generation storage and provider consent/budget mechanisms where compatible. Review licensed S3/authentication dependencies and avoid new source sync, parsing or index subsystems.
- No source-bucket credentials, external sync orchestration, live SQLite transport, multi-writer, remote extraction, real-Vault scan, cloud provisioning/upload or model downloads authorized. Use synthetic sources and controlled artifact transport; live S3/provider checks require separate authorization. No private manifests, vectors, source text or credentials in public evidence.

## Design gate before implementation

Specify authenticated versioned generation and content manifests, deterministic serialization/digests, immutable object addressing, exact coverage and zero-chunk outcomes, publisher snapshot/commit protocol, identity/authorization and replay/rollback policy. Define local reconciliation and typed lifecycle states (at minimum waiting for artifacts, waiting for content, rejected/incompatible/denied, staging and active), bounded pending persistence, revalidation triggers, retry/cancel/abandon behavior, stale suppression and atomic commit/recovery. Distinguish transient waiting from permanent divergence and denied/corrupt input; do not silently auto-rebuild or infer while waiting. Specify privacy-approved source identifiers, trusted publisher authentication and encryption where required. Predeclare measurable workload, transfer, disk/RSS, latency and quality budgets before acceptance; no unmeasured performance claim.

## Mandatory acceptance matrix (synthetic, independently reviewed)

| ID | Scenario | Required observed result |
|---|---|---|
| 06C-AC-01 | Cache generation complete, source absent or old on source bucket and consumer | Pending content, no activation, no stale evidence or document inference; activate only after exact authorized local content arrives. |
| 06C-AC-02 | Source arrives before vectors/manifest in an enabled import workflow | Pending artifacts; no ready claim or repeated inference solely while waiting; matching complete generation activates once. |
| 06C-AC-03 | Partial/reordered/duplicate delivery on either channel, restart and repeated retries | Idempotent bounded staging, no partial activation; eventual complete valid delivery activates without duplicate inference. |
| 06C-AC-04 | Same path with changed raw bytes, Unicode/CRLF, differing extraction/chunk input or profile | No hash/path/name-only false matches; exact compatible inputs reusable only after local evidence validation. |
| 06C-AC-05 | Local concurrent edits, rename/delete, inaccessible/excluded file, scope change, additional local source inside/outside collection | No stale/unauthorized hit, no silent omission from claimed coverage, no forced overwrite; outside-scope sources do not block valid scoped import. Divergence is explicit; authorized abandon/rebuild path available. |
| 06C-AC-06 | In-flight mutation during publisher snapshot, consumer staging, commit or query | No mixed-source publication; source-event fence/revalidation rejects obsolete candidates/results. |
| 06C-AC-07 | Crash/cancel before and during publication, rollback after source/model/scope change | No half-active generation; idempotent restart/reconciliation; rollback only after fresh local validation; one active dense index. |
| 06C-AC-08 | Corrupt/truncated/missing object; malformed, oversized, forged or replayed manifest; incorrect collection/space | Fail closed with bounded resources and distinct typed rejection or pending reason; never accept stale replay or expose private payload. |
| 06C-AC-09 | S3 disabled/offline/timeout, permanent missing content, repeated restarts, provider unavailable | Basic occurrence/Properties remains available; truthful AI status, bounded retries/storage, cancel/abandon and explicit retry; no hidden fallback or automatic paid calls. |
| 06C-AC-10 | Two independent local roots, same authorized inputs and compatible model; incremental changes | Verified reuse with zero document-embedding calls for compatible inputs; unchanged chunks reused; new/mismatched inputs calculated only by authorized rebuild/provider workflow; query encoder independently verified. |
| 06C-AC-11 | Unapproved scope, credential misuse, private filenames/metadata and diagnostic export | No unauthorized read/export/activation; separate least-privilege credentials; authenticated manifests and required encryption; aggregate diagnostics only, no sensitive payload. |
| 06C-AC-12 | Real isolated Obsidian host with two synthetic replicas; event changes, missed events/startup and explicit retry | Pending state and counts distinguish artifacts/content/active index; event-driven reconciliation completes safely, no new sync-client dependency, no basic search regression; evidence and retrieval quality/resource budgets measured. |

Instrument document embedding invocation counts, activation attempts/generation IDs, source coverage and stale-hit counts using synthetic data. Require zero stale/unauthorized evidence, zero incomplete-generation activations, zero automatic document inference caused solely by waiting, and zero repeated document inference for verified compatible cache hits. Separate transport-level tests from real-host acceptance; mock/fixture success cannot be represented as live S3/provider or production deployment proof.

## Exit

Record exact base/HEAD, scope and requirement traceability, test commands and observed results, frozen corpus/budgets, privacy/resource/recovery evidence, limitations and independent full-diff review under SDD. No activation/merge claim from author checks alone. Keep external sync deployment authorization separate (ADR-0013); no expansion of existing 06UX or other in-flight work.
