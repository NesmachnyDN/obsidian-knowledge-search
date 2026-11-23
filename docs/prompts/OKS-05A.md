# OKS-05A — Standalone release-shaped package and clean-install acceptance

**Workflow:** standard bounded SDD slice / Draft PR / independent exact-HEAD review / conditional squash merge. **Base SHA:** `df5e381a9c6ead353c837a13fa0215c299b97e48` (`origin/develop`, fetched 2026-11-23). **Dependency:** OKS-04A/04B merged in PR #11/#12. No aggregated-phase exception.

## Authority and requirements

Read `AGENTS.md`, `SECURITY.md`, `docs/development/SDD.md`, `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/DEPENDENCIES.md`, `docs/REUSE.md`, ADR-0001–0008, `contracts/portable-model.md`, 04A/04B contracts, standalone API/benchmarks and Obsidian official plugin manifest/release rules. This slice targets Standalone CAP-01/AC-01, CAP-06/AC-06, CAP-07/AC-07, CAP-08/AC-08, CAP-09/AC-09, CAP-10/AC-10; standalone Markdown subset of CAP-02/AC-02. Mandatory standalone Gate A proof is distinct from Gate B advanced search.

## In scope

1. Create reproducible, offline, release-shaped **standalone** package containing the minimal installed plugin files (`main.js`, `manifest.json`, `standalone-worker.js`, and optional warranted style assets), with explicit dependency/license/asset inventory and deterministic hashes. No fixture, private data, Python/backend/model/runtime or network asset.
2. Validate stable plugin ID, desktop-only manifest, version/minimum tested app compatibility and all worker references/assets. Document Obsidian manual install layout, offline clean removal, and legacy manual diagnostic as non-default.
3. Add self-contained package validation and executable real-host clean-install acceptance through a disposable Vault, disposable app data/profile and **packaged** files. Extend existing host smoke rather than duplicate the Standalone engine/parser/index. Cover real search panel, typed properties, source navigation, create/modify/rename/delete, reload, worker unload, disabled-derived purge and original-preservation where feasible. Preserve precise assertions and distinction between Node mocks and real Obsidian.
4. Test negative packaging cases (missing/unexpected asset, malformed or mismatched manifest, unsafe destination/foreign files, leaking development dependencies) and default offline/no egress/no listener with bounded non-invasive observation; write honest evidence (PASS/FAIL/SKIP) for untestable aspects.
5. Run targeted and full JS/Python/type/build/licenses/standalone benchmark, exact package tests, real Obsidian 1.15.1 host acceptance, `git diff --check`. No changes to frozen corpus.

## Out of scope / boundaries

No Advanced profile integration, PDF/DOCX/OCR or BGE-M3 runtime, new model downloads, real Vault writes, Community Plugins publication, release tag, `main` promotion, architecture/metamodel changes, code borrowed from private implementations, blanket refactor, concurrent heavy workers. Do not install system packages or network services. Preserve API v1, portable source locators, storage generation/worker semantics and previously fixed B1–B9 / 04B B1/B2.

## Acceptance and handoff

A fresh Obsidian install with isolated synthetic notes and only packaged OKS must prove real offline lexical, typed filters, SHA-256 and byte/codepoint/line navigation, source lifecycle and safe removal. Package contents/hash must reproduce deterministically for identical source/lockfile and reject tampering; report system resources and limitations. Exact-head CI, independent **different-session** full-diff APPROVE, and no mandatory blockers are gates before Ready/squash merge. Author must leave Draft and pinned handoff if reviewer unavailable; author cannot self-approve. No claim that passing 05A closes OKS-05 MVP.
