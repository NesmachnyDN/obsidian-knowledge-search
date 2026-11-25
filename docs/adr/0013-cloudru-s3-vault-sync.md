# ADR-0013 — Cloud.ru S3 as the sync backend for the new Obsidian Vault

**Status:** Proposed; maintainer-selected deployment direction 2026-11-23, independent SDD review and merge pending. **Scope:** new Vault deployment, controlled migration and external sync tool; **not** a mandatory OKS plugin or MVP feature. Related: ADR-0006/0008/0010/0011/0012.

## Context

The historical Obsidian Vault (~1.67 GB visible in Yandex Cloud console) uses **Yandex Cloud Object Storage S3**, not Yandex Disk, and formerly synchronized between a corporate workstation, personal PC and tablet. The corporate workstation can no longer reach Yandex services, so the old sync is not working. A **new** Vault is being developed and gradually populated from selected historical documents. The maintainer has already configured **Cloud.ru Foundation Models** for opt-in BGE-M3 and wants one provider/account for S3 storage and AI billing. Prior advice to retain Yandex as the new primary sync assumed the old sync was still operational; that premise is superseded.

## Decision and ownership boundaries

1. **Select Cloud.ru Evolution Object Storage S3** as the central storage candidate for the **new** Obsidian Vault. Each workstation and tablet keeps its own local working Vault. An independently tested S3-compatible Obsidian sync client (e.g., Remotely Save) replicates files and resolves conflicts. Do not open Obsidian directly on an S3 FUSE mount or attempt POSIX/WAL synchronization.
2. **Separate private buckets and credentials:** one for synchronized source Markdown/PDF/DOCX/attachments, one for optional immutable portable model-compatible embedding artifacts (ADR-0010). A single Cloud.ru tenant/billing is a deployment convenience, not a product requirement; never reuse AI-service credentials as S3 credentials. Restrict each S3 principal by bucket and read/write purpose; no public ACL.
3. **Keep local-only derived data:** Docling and RU/EN OCR, its ParsedDocument cache containing source text, host-private SQLite/WAL and vector/lexical ANN indexes do not move to S3. Cloud.ru BGE-M3 calls remain optional, separately consented and scoped to permitted embedding-input text. Working offline Standalone/local Advanced does not require S3 availability.
4. **Corporate authorization gate:** test direct reachability of the Cloud.ru S3 endpoint from the corporate workstation using only approved paths and obtain approval for the exact data classification. Access to Cloud.ru and permission to upload work documents do **not** follow automatically from inability to reach Yandex. Do not bypass network restrictions.
5. **Multi-device proof:** before cutover, validate desktop/tablet sync on a disposable synthetic Vault: create/edit/rename/delete, offline concurrent edits, conflict recovery, Unicode/Russian filenames, larger attachments, clock skew, CORS if relevant, configuration/ignored files and client E2E encryption if enabled. Do not sync device-local secrets/settings or two independent sync providers into one active Vault.
6. **Storage class and costs:** Cloud.ru publishes up to 15 GB free Standard storage for an organization, but the documented initial **Standard quota is 0 GB** for some configurations and the UI may recommend One Zone. Check the *actual account* quota before choosing. Standard is preferred for a resilient primary sync bucket once enabled. One Zone is an interim low-cost, single-site/single-copy class and is not an independently recoverable backup. Versioning/storage operations/old versions are separately billed; configure lifecycle/monitoring and verify restore.
7. **Controlled migration, not wholesale replacement:** treat Yandex S3 as a **legacy source** and keep its backups intact. Gradually import selected approved files into the **new local Vault**, verify raw-byte hashes and source mapping, then synchronize to Cloud.ru. Never start two writers against the same active Vault or delete historical Yandex objects merely because a new bucket exists. Reconcile migrated subsets on intended devices and perform backup restore before disabling Yandex billing or access. Migration and decommission are separate owner-approved operations.
8. **Privacy:** Vault files, filenames and embeddings can be confidential. Use private buckets, secure transport, least privilege and appropriate encryption. Require a specific policy/consent review for corporate materials and any client-side encryption before putting them in Cloud.ru; do not assume S3 storage or Remotely Save E2E meets every organizational security requirement.

The Cloud.ru selection describes the initial operator deployment only. OKS cache transport is independently configurable and disabled by default; it may use another approved S3-compatible provider (including Yandex Cloud as a candidate), or no object storage at all. The source sync client may be independently disabled or changed, subject to its own migration/approval checks. Neither selection constrains AI providers or model identity. See [ADR-0010](0010-portable-bge-m3-embedding-cache.md#optional-transport-and-modelprovider-independence-maintainer-direction-2026-11-24).

## Independent delivery and consistency boundary

Source synchronization and optional OKS portable-cache publication are independent; either may arrive first, be incomplete, or diverge. A cache commit does not establish that the source bucket or any replica has the corresponding files. OKS treats the authorized local Vault as the source of truth and uses the authenticated content manifest and deferred local activation protocol in [ADR-0010](0010-portable-bge-m3-embedding-cache.md#cross-bucket-consistency-and-deferred-activation-maintainer-direction-2026-11-24). OKS neither reads nor writes the source bucket to validate imports, does not orchestrate the external sync client, and does not share its credentials. The external sync client's synthetic acceptance remains separate; before claiming portable reuse across synchronized replicas, OKS-06C must independently prove both delivery orders, missing/divergent content, recovery and zero stale evidence. Eventual convergence requires eventual delivery and reconciliation; neither bucket is a transactional peer of the other.

## Deployment

```text
Legacy Yandex Cloud S3 (reference, phased authorized import only)
       -> New locally resident Obsidian Vaults on approved devices
                     <-> tested S3 sync client
                            |
                 Cloud.ru Evolution Object Storage
                  - new Vault sync bucket (private)
                  - separate immutable embedding cache bucket (private)
                            |
                  one Cloud.ru account/billing
                            |
              Foundation Models (separate opt-in BGE-M3 API)

Each host: local Docling/OCR -> private ParsedDocument cache
         -> BGE-M3 vector cache -> local SQLite / retrieval index
```

## Acceptance before migration of real documents

Verify actual corporate firewall reachability and policy, S3 credentials and device sync client compatibility; test two-device synthetic conflict/recovery + tablet; confirm bucket quota/class/versioning/cost guardrails; verify encrypted independent backup and restore; compare per-file checksum/manifest and scoped permission during each controlled migration wave. No real Vault content upload, migration, deletion, bucket provisioning or account changes are authorized by this **documentation-only ADR**.

This selection is provider-specific at deployment but does not require a Cloud.ru-specific OKS storage implementation: portable vectors use a provider-neutral S3 object adapter (ADR-0010), while ordinary Obsidian Vault synchronization is external to OKS.
