# OKS-06UX candidate — Settings usability and operational readiness

**Release status:** implementation candidate, **not** a published release,
adoption approval or Gate B/C acceptance. This note must be confirmed by
exact-HEAD CI/CodeQL, independent full-diff SDD review, and an authorized
merge before calling the phase complete.

## Improvements

- New **Basic** default with task-oriented Overview, Search & scope, AI
  capabilities, Documents, and Index & maintenance; Expert reveals the
  existing optional health backend, synthetic probe and per-role API limits.
- Basic/Expert is strictly **presentation-only**: no permission grant,
  provider or index change, backend restart, network access or model
  provisioning on switching.
- Explicit **Draft → Validate → Save / Cancel** settings workflows, scoped
  validation and actionable inline errors. Failed storage operations
  preserve the draft instead of committing partial invalid state.
- Three independent AI task cards: Semantic search, reranking and evidence-
  based answers, each with its own connection, model revision and status.
  Saving a connection does not claim readiness, enable cloud disclosure,
  install an adapter or trigger a dense rebuild.
- Contextual ingestion paths, including independent OCR language assets
  and structured-layout artifacts, without requiring Python for Basic.
- Honest index and legacy extraction status, visible requested/executed
  basic search mode where verified, and existing disabled-only guarded
  cleanup of derived local index data.
- Native Obsidian UI controls and theme variables, labeled form inputs,
  explicit status text and keyboard-capable native widgets.
- Versioned settings schema v6 with read migration from v1–v5. The new
  presentation preference defaults to Basic on upgrade; active settings
  and hidden values are retained. **An older v5 plugin cannot read v6**
  without restoring a secure pre-upgrade v5 settings backup.

## Explicitly not included

No new model, provider adapter, credential store, AI readiness detection,
cloud egress permission, independent dense-index replica, graph service,
OCR feature claim, retrieval/ranking algorithm, machine API contract,
production Vault deployment, or public release.

## Verification references

- [Detailed user guide and rollback](IMPLEMENTATION.md)
- [Settings field inventory and dependencies](implementation-inventory.md)
- [Approved UX brief](README.md)
- [Execution contract](../../prompts/OKS-06UX.md)
- `tests/settings-ux.test.ts` and `tests/plugin-lifecycle.test.ts`
- `scripts/obsidian-settings-ux-smoke.js`, real Obsidian synthetic Vault
- `scripts/obsidian-host-smoke.sh` with `OKS_06UX_TEST=1`
- Real rendered visual/keyboard acceptance: opt-in
  OKS_06UX_VISUAL_DIR mode of the isolated host script captures the separate
  Settings window, verifies effective conditional visibility, native focus
  order, 200% zoom and long-label geometry. See the user guide for the
  reproducible command and evidence handling. Scoped layout and disclosure
  remediation address B-VISUAL-02–04.
- Current AI operation is metadata-only status from the existing role
  controller; successful execution is never advertised as standing provider
  readiness or consent. No new provider or execution contract.
