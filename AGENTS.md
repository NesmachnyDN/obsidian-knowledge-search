# Agent instructions

## Authority and scope
Read this file, docs/SPEC.md, docs/ARCHITECTURE.md, docs/ROADMAP.md, applicable ADRs and the nearest component instructions before making changes. The specification defines observable outcomes, ADRs establish decisions, and the roadmap defines dependency-ordered slices. Do not use conversation memory as project authority.

- Keep one bounded, traceable change per PR. Main is the integration branch; use short-lived feature branches. Inspect current head, working tree, open PRs and actual writers before editing. Preserve unrelated work.
- Start with the earliest admissible roadmap slice. If scope or a decision is inconsistent, update the controlling documents in a reviewed change before implementation. Do not implement an entire phase in one change.
- Use existing library mechanisms and narrowly scoped, license-reviewed reusable code. Never clone an obsolete application wholesale, require its runtime or introduce parallel implementations without a measured reason.
- Separate UI/Obsidian adapter, pure contracts, document processing, index persistence, retrieval policy and model runtime. No model inference or parsing on the UI thread.
- Prefer small, typed, cohesive functions and modules. Keep dependency direction explicit, no production imports from tests, and no broad cleanup or unrequested refactors.
- Test observable behavior, including failures and recovery. Do not claim a passed test or benchmark without actual evidence. Do not silently substitute hash vectors, truncate input, omit files or downgrade to lexical search.
- At each slice report base SHA, changed files, requirement IDs, tests actually run, evidence, limitations, risks, and readiness for independent review. Never merge without maintainer authorization. No force push.
- Respect SECURITY.md. Public repository, PR, CI, logs, issues and artifacts must not contain private source material, credentials, private paths, real vault content or indexes. Use generated fixtures and sanitized aggregate evidence only. Check license/provenance before copying any prior code. Do not transmit vault contents to a cloud provider.
- Read a target Vault's own instructions before touching it. No production vault writes, plugin replacement, heavy inference/indexing, or model downloads without explicit authorization and resource preflight. Use an isolated synthetic vault first.

Development baseline: Linux desktop, CPU-first; other hosts are not claimed supported. Avoid infrastructure that needs separate manual administration. Keep public documentation in English. User-facing orchestration can be in the maintainer's language.
