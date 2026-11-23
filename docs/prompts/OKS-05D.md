# OKS-05D — Verified local lexical, BGE-M3 dense, and deterministic hybrid retrieval

**Mode:** one bounded author-only SDD slice; Draft PR into `develop`, separate exact-HEAD independent review mandatory. **Base:** `bd60b5fd42eecdbd21fda9dac2af92e00c106b09` (merged PR #16). No changes to `main`, production Vault, external services, or model artifacts.

## Authority and acceptance

Read `AGENTS.md`, `SECURITY.md`, `docs/development/SDD.md`, `docs/SPEC.md` CAP-04/AC-04 and CAP-05/AC-05, CAP-02/03/06/07/08/09/10, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` OKS-05D, `docs/DEPENDENCIES.md`, `docs/REUSE.md`, ADR-0001–0009, proposed ADR-0014; account for independent pending PR #15 ADR-0010–0013, `contracts/advanced-ingestion-v1.md`, `contracts/portable-model.md`. PR #15 remains independent/unmerged; it is not authority for runtime changes.

## Bounded scope

1. Reuse OKS-05C canonical v3 sources/chunks, typed properties, descriptor-anchored freshness and private generation lifecycle; extend with strictly versioned retrieval/embedding compatibility contract instead of a parallel source/evidence model.
2. Admit a **real local, pinned** BGE-M3 model/tokenizer/weights via existing CPU-first cgroup v2 constraints (4 GiB memory, swap off, 200% CPU, <=64 tasks and >=2.5 GiB host reserve). Fail closed if an artifact, guard, model identity, or offline guarantee cannot be established. No automatic downloads, synthetic embeddings, external API, silent truncation or lexical fallback under dense/hybrid requests.
3. Build a bounded compatible lexical/dense index for explicitly indexed synthetic-Vault TFiles only. Atomically publish a private generation containing source versions, chunk IDs, embedding identity and bounded normalized vectors; stale mutation/rename/deletion invalidates hits. Query filters run before ranking, and no unverifiable original excerpt or invented PDF/DOCX/OCR native locator is returned.
4. Implement deterministic independent lexical/dense top-K legs and RRF (k=60, canonical tie-break), per-leg scores/ranks and explicit `requestedMode`, `executedMode`, readiness/error. Integrate user-controlled indexing/query/navigation/status/cancellation in Obsidian without affecting default Standalone.
5. Verify real model correctness, frozen RU/EN retrieval metrics, end-to-end source freshness, cgroup resource/security adversarial cases, true Offline Obsidian 1.15.1 Contour 1 and Contour 2. Preserve original Vault files. No proxy for actual-host acceptance.

## Reuse and dependencies

Reuse `engine/embedding.py` BGE-M3 reference, `engine/retrieval.py` typed predicate and RRF semantics, existing v3 tokenizer/ingestion/provenance, `plugin/src/advanced/{runner,manager,storage}.ts`, and Standalone lexical tokenizer principles. No new mandatory npm or Python dependencies; use only pre-provisioned local Python env and model snapshot in opt-in Advanced. No health-v2 search extension. The public package's Standalone assets must remain independent.

## Exit criteria

- Independently tested Python/TS strict v4 model-envelope compatibility, vector dimension/normalization/fingerprint and missing-mismatch/invalid-vector/overflow guards; actual offline forward-pass from the pinned local weights.
- Exact-ID and multilingual search, typed filters, stable deduplication/RRF, original evidence/freshness, explicit unavailable/failed legs, single indexed generation after crash/restart, cancellation and systemd unit cleanup.
- `npm test`, `npm run test:python`, `npm run typecheck`, `npm run build`, `npm run licenses`, `npm run test:package`, `npm run benchmark:standalone`, `git diff --check`; actual host adversarial and both no-route Desktop/CLI contours with measured CPU/RSS; all failures transparently reported.
- Commit and push a Draft PR to `develop` with exact Base/HEAD, changed paths, sanitized evidence and a ready-to-use independent full-diff review prompt. **Author cannot APPROVE, Ready or merge.** If any required model/Desktop gate fails, record `BLOCKED` rather than a false acceptance.
