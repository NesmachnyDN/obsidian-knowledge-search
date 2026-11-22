# OKS-03-ARCH: Standalone runtime architecture alignment

**Type:** bounded, documentation-only prerequisite to OKS-03A. **Base:** `0109feb373c62c4896704b8260f85bbbce3f810d`. **Target:** `develop`. **SDD profile:** ITERATION. **Dependency:** merged OKS-02C PR #8, frozen 02A/02B/02C artifacts.

## Authority and traceability

Read AGENTS.md, SECURITY.md, SDD, SPEC CAP-01–10 (especially CAP-04/05/07/08/09), ARCHITECTURE, ROADMAP, REUSE, DEPENDENCIES, ADR-0001–0005, applicable OKS-02A/B/C prompts and frozen benchmarks. The new product requirement mandates a no-extra-software Obsidian + plugin baseline, without weakening MVP-wide advanced criteria. Official Obsidian plugin manifest, API, submission and release requirements need source references.

## In scope

1. Audit actual plugin probe and existing Python extraction, chunking, lexical, storage, worker, inference gaps and dependencies; state accurately what is implemented versus not.
2. Define named Standalone, Bundled Advanced and External Backend profiles with availability matrix, installer/runtime lifecycle, privacy and offline behavior.
3. Fix authority contradiction in SPEC, ARCHITECTURE, ROADMAP and draft portable contract semantics; create ADR-0006; align README, ADR register and affected dependency/reuse explanatory text if directly needed.
4. Specify language-neutral versioned source/ParsedBlock/Chunk/Evidence semantics, index generation and freshness, typed Properties and wiki-links, without claiming a finalized wire format.
5. Preserve CAP-04/CAP-05 and full CAP-02 as MVP-wide requirements while clearly requiring Standalone offline Markdown lexical search.
6. Define bounded follow-on experiments for 03A/03B, native JS build in 04A/04B, clean install + advanced acceptance in 05; no undocumented downgrade.
7. Record official Obsidian requirements as design input, explicitly defer unverified compatibility/runtime/storage choices.

## Out of scope

No Python rewrite, model download, new dependencies, index migration, production implementation, new plugin commands, binaries, real vault access, benchmark label edits, new service, workstation config, modification of main, or unreviewed actual API choice.

## Validation gates

- Contract/document cross-check: profile boundaries and matrix consistent; CAP-04/05 remain MVP-wide and not mislabeled Standalone; provenance and freshness are preserved.
- Check referenced paths and links; `git diff --check`, independent full-diff review for exact base and head, required CI.
- No changes to production modules, frozen fixtures or results; no third-party code copied.
- Existing applicable Node/Python unit tests, typecheck, licenses and build are run with their actual outcomes reported, although documentation-only changes do not assert new implementation coverage.
- PR remains **Draft** until a separate independent reviewer publishes exact-HEAD APPROVE. Author self-check does not satisfy SDD. After approval and checks, authorized orchestrator performs squash merge and refreshes develop before starting 03A.

## Exit

A reviewed ADR and reconciled authoritative docs, a reproducible clean-install acceptance plan, explicit unresolved tests and limitations, a uniquely scoped PR into develop, and independently recorded review before merge. This PR does **not** prove Standalone, embedding inference, retrieval accuracy or Community Plugin approval.
