# OKS-06UX-L10N — Obsidian-language settings (bounded remediation)

- Base: `7013ff1825f62a639c386e59cc0dc603c25d4f5f` (`origin/develop` at start).
- Authority: AGENTS.md, SECURITY.md, docs/SPEC.md CAP-07/08/10,
  docs/ARCHITECTURE.md, docs/ROADMAP.md OKS-06UX,
  docs/development/SDD.md, docs/prompts/OKS-06UX.md (UX-AC08/09/10),
  docs/ux/settings/IMPLEMENTATION.md.
- Scope: render existing Obsidian Settings tab and AI provider editors in the
  **selected Obsidian application language**. Use public Obsidian `getLanguage()`.
  Support `ru` and regional variants, `en`; English fallback for other languages.
  Localize headings, control names, options, accessible labels, explanatory and
  warning text, inline validation, status summaries, confirmation dialogs and notices.
  Reopen Settings to reflect a language switch; respect host restart requirements.
- No new locale preference, schema version, provider role, permission, model,
  download, external service, index action, source access, or search-mode behavior.
  Keep protocol codes, input identifiers, paths, models and diagnostics verbatim.
  Preserve draft/focus and no-redraw-per-keystroke behavior.
- Positive acceptance: RU/EN labels and explanatory text; English fallback;
  localized status and validation while preserving raw error codes; actual
  Obsidian desktop synthetic-vault smoke for both languages; no AI/API egress.
  Existing English task-oriented Settings UX must remain valid.
- Negative acceptance: wrong/unknown locale does not throw or change state;
  UI strings cannot activate hidden roles, overwrite settings, or issue consent;
  validation failure keeps uncommitted drafts, deleting index remains guarded.
- Validation: typecheck, `npm test`, `npm run test:python`, packaging,
  licenses, isolated real-Obsidian RU and EN smoke, security/diff checks,
  independent exact-HEAD full-diff review, CI and conditional merge gate.
  Screenshots are synthetic only; no production Vault/adoption.
