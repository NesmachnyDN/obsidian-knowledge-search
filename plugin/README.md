# Obsidian Knowledge Search — Linux Standalone Markdown profile

**Status:** OKS-05E accepted the Gate A **Basic-only Markdown MVP**; it did not accept optional Gate B/C AI or document capabilities. OKS-06UX is an unmerged Settings usability implementation candidate and not a public plugin release. The historical OKS-01A Python-backed synthetic evidence probe is retained only as an explicitly configured, manually run legacy diagnostic; it is **not** required for Standalone.

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
npm run test:package
```

## Reproducible Standalone package (OKS-05A candidate)

From a previously reviewed development checkout, run:

```sh
npm run test:package
node scripts/standalone-package.mjs verify
OKS_STANDALONE_PACKAGE_DIR="$PWD/build/standalone-package" bash scripts/obsidian-host-smoke.sh
```

`npm run package:standalone` first builds the app, then creates `build/standalone-package/` with **exactly** `main.js`, `manifest.json` and `standalone-worker.js`. The separate `build/standalone-package.sha256.json` lists deterministic SHA-256 and byte sizes, without source text or machine paths. It is a local integrity ledger, **not a signature or proof of publisher authenticity**. Re-running a build with identical inputs checks identity and does not overwrite a foreign/different package. A different build requires removing only the known disposable `build/standalone-package/` and its adjacent ledger before repackaging. The package verifier rejects extra/missing/altered, symlinked or multiply-linked files and incorrect manifest identity. The installed package itself does not contain build tooling, test fixtures, model artifacts, OCR binaries or Python.

Copy **only the three files inside that package directory** to the corresponding subfolder of a **disposable synthetic** Vault, `.obsidian/plugins/oks-synthetic-evidence/`, and enable it in Obsidian Community Plugins. Do not copy the SHA-256 ledger into the installed plugin directory. No model/backend provisioning is necessary for lexical search. The plugin ID `oks-synthetic-evidence` remains stable for existing installations; the display name/description now identify the actual Standalone search capability. `minAppVersion` is conservatively pinned to tested Obsidian Desktop 1.15.1; support on earlier versions is not claimed. This candidate is not a signed archive or a Community Plugins submission. A verified isolated host test is distinct from the offline/no-egress security gate.

## Native data, storage and privacy

- Obsidian Vault APIs enumerate Markdown sources and subscribe to create/modify/delete/rename; MetadataCache changes invalidate and trigger reconciliation. The **authoritative source** is an uncached, bounded filesystem read checked against a verified Vault root — MetadataCache contents alone are never considered the source of evidence.
- The native parser records SHA-256 of original bytes, canonical source IDs and block order, heading hierarchy, wiki-link strings, UTF-8 byte ranges, Unicode code-point ranges, one-based physical line numbers, original excerpts, strict typed frontmatter Properties and diagnostics. Unknown/malformed YAML expressions are not interpreted or executed. A limited YAML subset is supported; unsupported frontmatter is marked partial with no fabricated typed Properties.
- A versioned, immutable, atomic index is stored in the local **host-private** `$XDG_DATA_HOME/obsidian-knowledge-search/plugins/<id>/<root-digest>/index` (falling back to `~/.local/share`). The cache is outside the Vault and is **not** part of normal Obsidian Sync Vault settings. It contains original excerpts and metadata and must be treated as private application data. A separately configured whole-home backup/sync system may also copy it. It is disposable/rebuildable; the original notes are never modified or removed by OKS.
- On startup, reconcile with authoritative source versions. Unknown index schema/identity fails closed rather than silently migrating; explicit rebuild is needed. A valid previous generation can recover after CURRENT corruption. After an irreversible CURRENT rename, in-memory and persisted generations switch together; subsequent directory fsync uncertainty or garbage-collection errors degrade the engine and are exposed through `status().maintenanceWarning` (respectively `INDEX_DURABILITY_UNCERTAIN` or `INDEX_GC_FAILED`). Deferred cancellation is reported separately as `CANCEL_DEFERRED`, never as a successful pre-publication cancel. Every candidate is rehashed and checked against original locator bytes **before** return; stale or inaccessible sources are suppressed even if an event is delayed.
- Storage and security decision: [ADR-0008](../docs/adr/0008-standalone-generation-storage.md). Canonical semantics: [portable-model.md](../contracts/portable-model.md).

Resource limits: 512 Markdown sources, 65,536 bytes per source, 32,768 source blocks, 16 MiB maximum generation, 512 UTF-8 bytes/query, up to 50 hits, 32 typed predicates, one index rebuild at a time. Indexing parses Markdown in a bundled, bounded browser Web Worker (Blob URL, 5-second per-source deadline) rather than the Obsidian UI thread; the single-flight generation writer and source checks use cooperative asynchronous work. The browser worker is not a separate installed runtime, service or model. This does not imply a hard isolated Web Worker memory quota or compatibility with a malicious concurrently renaming filesystem. Larger Vaults fail with explicit diagnostic rather than silent partial success.

## Settings: Basic and Expert (OKS-06UX candidate)

New installations open the **Basic** settings presentation. The task sections cover Overview, Search & scope, optional AI capabilities, Documents, and Index & maintenance. Select **Expert** from Settings view to see health-only backend configuration, legacy synthetic probe, and per-role API limits. This changes presentation only; it never activates a provider, changes a disclosure grant, or rebuilds an index. The existing API-backed embedding, reranking, and LLM roles have independent configuration forms with Save/Cancel/Disable. A saved connection is not proof of readiness. Local API origins require literal loopback; cloud does not gain egress authorization simply because an HTTPS origin is saved.

Optional document processing is an explicit local setup with mode-dependent OCR/structured paths. Invalid edits never commit a partial configuration; failed saves retain the draft. Model identity changes announce the need for a separately authorized staged dense rebuild. Destructive derived-index cleanup remains disabled-only and requires confirmation. See the [user and rollback guide](../docs/ux/settings/IMPLEMENTATION.md) and [field inventory](../docs/ux/settings/implementation-inventory.md).

Settings persist as validated schema v6 (v1–v5 migrate). **Rollback to a v5 plugin requires restoring the private pre-upgrade v5 settings backup**; an old version cannot interpret v6. Keep private backups out of public artifacts.

## Search view and controls

Run **Open Standalone search** in the command palette. Enter a bounded lexical query, choose Top K (1–50), and press Search or Enter. Results render original excerpts and exact source paths as text only. **Verify and open** freshly authenticates source bytes/locator and selects the original physical line, including Unicode/emoji and CRLF. **Verify and open first search source** is also available as a command. Source changes clear displayed rows; stale clicks fail closed.

The view shows actual lexical readiness, unavailable dense/hybrid, generation ID, source/record counters, busy state, errors and maintenance warnings. Pause/resume/cancel/rebuild are available in the view and command palette. Cancel during publication can be deferred; no committed work is falsely reported undone. Settings control indexing/search enablement, paused state, default Top K and opt-in typed Property controls. Settings migration/validation is strict; field edits are serialized as patches against the latest committed settings so overlapping UI changes cannot revert an indexing-disable decision. Advanced is disabled by default; explicit opt-in to a trusted local stdio profile starts a supervised **health-only** Python worker. It does not load models/retrieve documents and dense/hybrid remain unavailable (ADR-0009).

**Export safe diagnostics** produces selectable JSON in the view with only allowlisted status metadata. Copy that text for diagnostics; do not export search results to public reports. Closing a view releases subscriptions/timers; disabling/unloading stops the worker. Derived host-private cache normally persists after disable/uninstall. The settings tab includes a confirmed, disabled-only cleanup (also supported after a cold restart with indexing disabled) of recognized derived index files, preserving all Vault notes; re-enabling builds a fresh index.

## Optional local graph search (OKS-06B.3)

In Expert settings, explicitly save a valid graph mapping. The search view then shows a separate local graph search panel. Its query, match mode, Top-K and typed Property/tag/wiki-link filters are shared with text search; filtered graph requests cannot expand outside the selected scope. Choose depth 0–2, direction and a configured relation type (or all configured types), then select **Search graph**. The result distinguishes lexical seeds from expanded sources, displays original ranks and paths through authored, unverified relations, and offers exact source/edge-anchor navigation after renewed source verification. Cancel or explicitly retry text-only search; graph search never falls back automatically. The panel is hidden when graph mapping is disabled. No provider, model, persistent graph index or AI preview is activated by this operation. Quality/resource acceptance remains a separate 06B.4 gate.

## Versioned API and real-host smoke

The [API v1 reference](../docs/standalone-api.md) documents exact envelope validation, native protocol-v2 response semantics and supported `obsidian eval code=...` commands. Use `plugin.api.request(...)`; the historical `standalone` engine field is an internal developer hook, not the stable interface.

```sh
bash scripts/obsidian-host-smoke.sh
```

The script installs into a disposable synthetic Vault with separate HOME/XDG/Electron profile, opens the real ItemView through a CLI command, clicks controls, checks typed filters/text-only rendering and exact editor selection, tests source mutation/rename/delete, lifecycle and API refusal, and verifies reload persistence/worker termination. It never uses a production Vault. The independent host invocation through Remote Desktop Commander passed with Obsidian Desktop 1.15.1 in a disposable Vault (2026-11-23). The Codex implementation sandbox could not create Xvfb sockets; that isolated environment failure is not the actual host outcome. See [candidate evidence](../benchmarks/standalone/04b-validation.md).

## Limitations and legacy diagnostic

- The default Basic search remains Markdown lexical-only. Optional local graph search is separate; PDF/DOCX/OCR, embeddings, real dense/hybrid, reranker and semantic retrieval are not part of Basic search. Unsupported modes return `CAPABILITY_UNAVAILABLE`, not a lexical result mislabeled hybrid.
- Typed Properties support unambiguous YAML subset of strings, finite numbers, booleans, ISO dates, null and scalar lists. No arbitrary YAML objects/anchors, implicit coercion or external execution. wiki-link targets are retained as strings in Basic search; optional graph traversal uses only the explicitly configured local mapping.
- First supported execution target is Linux desktop with host filesystem APIs and local fsync/rename. No cross-OS, signed release or public distribution claim. A release-shaped package is a pre-release candidate until independent acceptance.
- The manually invoked legacy `Run synthetic evidence probe` command still uses a maintainer-configured Python interpreter for OKS-01A regression only; it is disabled by default and is **outside Standalone**. For historical probe acceptance and its independent process safeguards, see [OKS-01A contract](../docs/prompts/OKS-01A.md) and [ADR-0002](../docs/adr/0002-first-vertical-and-experiment-gates.md). Do not enable it for normal native indexing.

## OKS-05B opt-in Advanced transport candidate

The optional External Backend candidate is separate from mandatory Standalone. Schema-v3 settings migrate schema-v2 with Advanced disabled, and provide explicit `local-stdio` opt-in with absolute trusted Python executable and entry paths. The fixed Python v2 health experiment (`engine/persistent.py`) is the only exercised protocol; the child has private stdio, no listener and receives no source material. Its readiness means only `advancedTransport.status=ready` and `transportOnly=true`. It **does not mean** PDF/DOCX/OCR, embedding, lexical+dense or hybrid are available. Dense/hybrid requests continue to fail explicitly. Disable/unload terminates the owned process group without deleting sources or the Standalone index. A developer can run the explicit synthetic-host health test with:

```sh
OKS_ADVANCED_HEALTH_TEST=1 OKS_STANDALONE_PACKAGE_DIR="$PWD/build/standalone-package" bash scripts/obsidian-host-smoke.sh
```

This optional test needs a trusted local Python interpreter and is **not required** for default package-only acceptance. No working Vault is accessed. See [ADR-0009](../docs/adr/0009-opt-in-local-advanced-transport.md) and [05B contract](../docs/prompts/OKS-05B.md). This is unreviewed until exact-HEAD independent SDD approval.
