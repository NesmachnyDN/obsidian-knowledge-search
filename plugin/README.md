# Obsidian Knowledge Search — Linux Standalone Markdown core (OKS-04A)

**Status:** OKS-04A core merged in PR #11; OKS-04B adds a candidate search view, settings, status, verified source navigation and versioned in-process API. Real-host 04B smoke passed, including Settings dialog; fresh independent exact-HEAD review and CI are still required; this is not a production plugin release or full MVP. The existing OKS-01A Python-backed synthetic evidence probe is retained only as an explicitly configured, manually run legacy diagnostic. It is **not** required for Standalone.

## Runtime and installation

The minimum Standalone installation is **Obsidian desktop + this plugin** (packaged `main.js`, `standalone-worker.js` and `manifest.json`). Native indexing starts automatically after the Obsidian workspace layout becomes ready. The installed plugin runs lexical-only Markdown search offline inside Obsidian's existing Electron/Node runtime: no Python interpreter, npm, Docker, Ollama, model, API key, service, SQLite binary, extra process or network required. Node 22, npm and Python are **developer/test tooling only**, not installation requirements.

Do not deploy this candidate to a production or confidential Vault before independent review and release approval. Use a disposable synthetic Vault for development.

For contributors:

```sh
npm ci
npm run typecheck
npm test
npm run test:python
npm run benchmark:standalone
npm run licenses
npm run build
```

Copy `dist/main.js`, `dist/standalone-worker.js` and `dist/manifest.json` to a **disposable synthetic** Vault at `.obsidian/plugins/oks-synthetic-evidence/`; enable the community plugin only in that disposable Vault. The plugin name/ID remains the historical development ID in 04A. `plugin/manifest.json` declares desktop-only. The OKS-04B candidate uses the same package ID; final public naming/distribution is deferred.

## Native data, storage and privacy

- Obsidian Vault APIs enumerate Markdown sources and subscribe to create/modify/delete/rename; MetadataCache changes invalidate and trigger reconciliation. The **authoritative source** is an uncached, bounded filesystem read checked against a verified Vault root — MetadataCache contents alone are never considered the source of evidence.
- The native parser records SHA-256 of original bytes, canonical source IDs and block order, heading hierarchy, wiki-link strings, UTF-8 byte ranges, Unicode code-point ranges, one-based physical line numbers, original excerpts, strict typed frontmatter Properties and diagnostics. Unknown/malformed YAML expressions are not interpreted or executed. A limited YAML subset is supported; unsupported frontmatter is marked partial with no fabricated typed Properties.
- A versioned, immutable, atomic index is stored in the local **host-private** `$XDG_DATA_HOME/obsidian-knowledge-search/plugins/<id>/<root-digest>/index` (falling back to `~/.local/share`). The cache is outside the Vault and is **not** part of normal Obsidian Sync Vault settings. It contains original excerpts and metadata and must be treated as private application data. A separately configured whole-home backup/sync system may also copy it. It is disposable/rebuildable; the original notes are never modified or removed by OKS.
- On startup, reconcile with authoritative source versions. Unknown index schema/identity fails closed rather than silently migrating; explicit rebuild is needed. A valid previous generation can recover after CURRENT corruption. After an irreversible CURRENT rename, in-memory and persisted generations switch together; subsequent directory fsync uncertainty or garbage-collection errors degrade the engine and are exposed through `status().maintenanceWarning` (respectively `INDEX_DURABILITY_UNCERTAIN` or `INDEX_GC_FAILED`). Deferred cancellation is reported separately as `CANCEL_DEFERRED`, never as a successful pre-publication cancel. Every candidate is rehashed and checked against original locator bytes **before** return; stale or inaccessible sources are suppressed even if an event is delayed.
- Storage and security decision: [ADR-0008](../docs/adr/0008-standalone-generation-storage.md). Canonical semantics: [portable-model.md](../contracts/portable-model.md).

Resource limits: 512 Markdown sources, 65,536 bytes per source, 32,768 source blocks, 16 MiB maximum generation, 512 UTF-8 bytes/query, up to 50 hits, 32 typed predicates, one index rebuild at a time. Indexing parses Markdown in a bundled, bounded browser Web Worker (Blob URL, 5-second per-source deadline) rather than the Obsidian UI thread; the single-flight generation writer and source checks use cooperative asynchronous work. The browser worker is not a separate installed runtime, service or model. This does not imply a hard isolated Web Worker memory quota or compatibility with a malicious concurrently renaming filesystem. Larger Vaults fail with explicit diagnostic rather than silent partial success.

## Search view and controls

Run **Open Standalone search** in the command palette. Enter a bounded lexical query, choose Top K (1–50), and press Search or Enter. Results render original excerpts and exact source paths as text only. **Verify and open** freshly authenticates source bytes/locator and selects the original physical line, including Unicode/emoji and CRLF. **Verify and open first search source** is also available as a command. Source changes clear displayed rows; stale clicks fail closed.

The view shows actual lexical readiness, unavailable dense/hybrid, generation ID, source/record counters, busy state, errors and maintenance warnings. Pause/resume/cancel/rebuild are available in the view and command palette. Cancel during publication can be deferred; no committed work is falsely reported undone. Settings control indexing/search enablement, paused state, default Top K and opt-in typed Property controls. Settings migration/validation is strict; field edits are serialized as patches against the latest committed settings so overlapping UI changes cannot revert an indexing-disable decision. Advanced backend configuration is always inactive and never connects or downloads anything.

**Export safe diagnostics** produces selectable JSON in the view with only allowlisted status metadata. Copy that text for diagnostics; do not export search results to public reports. Closing a view releases subscriptions/timers; disabling/unloading stops the worker. Derived host-private cache normally persists after disable/uninstall. The settings tab includes a confirmed, disabled-only cleanup (also supported after a cold restart with indexing disabled) of recognized derived index files, preserving all Vault notes; re-enabling builds a fresh index.

## Versioned API and real-host smoke

The [API v1 reference](../docs/standalone-api.md) documents exact envelope validation, native protocol-v2 response semantics and supported `obsidian eval code=...` commands. Use `plugin.api.request(...)`; the historical `standalone` engine field is an internal developer hook, not the stable interface.

```sh
bash scripts/obsidian-host-smoke.sh
```

The script installs into a disposable synthetic Vault with separate HOME/XDG/Electron profile, opens the real ItemView through a CLI command, clicks controls, checks typed filters/text-only rendering and exact editor selection, tests source mutation/rename/delete, lifecycle and API refusal, and verifies reload persistence/worker termination. It never uses a production Vault. The independent host invocation through Remote Desktop Commander passed with Obsidian Desktop 1.15.1 in a disposable Vault (2026-11-23). The Codex implementation sandbox could not create Xvfb sockets; that isolated environment failure is not the actual host outcome. See [candidate evidence](../benchmarks/standalone/04b-validation.md).

## Limitations and legacy diagnostic

- Markdown lexical-only. No PDF/DOCX/OCR, embeddings, real dense/hybrid, reranker, graph traversal or semantic retrieval. Unsupported modes return `CAPABILITY_UNAVAILABLE`, not a lexical result mislabeled hybrid.
- Typed Properties support unambiguous YAML subset of strings, finite numbers, booleans, ISO dates, null and scalar lists. No arbitrary YAML objects/anchors, implicit coercion or external execution. wiki-link targets are retained as strings; graph traversal is deliberately absent.
- First supported execution target is Linux desktop with host filesystem APIs and local fsync/rename. No cross-OS or full clean-install/release claim.
- The manually invoked legacy `Run synthetic evidence probe` command still uses a maintainer-configured Python interpreter for OKS-01A regression only; it is disabled by default and is **outside Standalone**. For historical probe acceptance and its independent process safeguards, see [OKS-01A contract](../docs/prompts/OKS-01A.md) and [ADR-0002](../docs/adr/0002-first-vertical-and-experiment-gates.md). Do not enable it for normal native indexing.
