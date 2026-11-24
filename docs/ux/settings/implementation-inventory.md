# OKS-06UX — Persisted setting and visibility inventory

Implementation source: `plugin/src/search/settings.ts`, `plugin/src/search/settings-draft.ts`,
`plugin/src/search/settings-tab.ts`, `plugin/src/ai/config.ts`,
`plugin/src/ai/settings-ui.ts`, `plugin/src/main.ts`.
This is a field-to-control inventory, not a second runtime configuration model.

The single persisted `SearchSettings` schema is **v6**. Old versions v1–v5
are parsed into v6; the only v6 addition is `presentationMode`.
All saved values are revalidated through `parseSettings` before reaching the
runtime. Basic/Expert is presentation only. The only valid settings version
is the one written by the current plugin; invalid historical data causes a
fail-closed disabled Standalone with `SETTINGS_INVALID`, repairable by
explicit validated user save, not automatic enablement.

| Persisted field | Default | Validation | Current UI control / visibility | Dependency / runtime effect | Migration and rollback |
|---|---|---|---|---|---|
| `version` | `6` | Exact supported input 1–6 with version-aware allowed keys | No control | Schema, never a feature gate | v1 probe, v2–4 legacy and v5 provider schema parsed into v6; older plugin cannot read newer schema without version-compatible rollback |
| `presentationMode` | `basic` | `basic\|expert` | Basic/Expert selector, always visible | View only; dedicated save path avoids any runtime invalidation | v1–5 import defaults to Basic; v6 round-trip preserves; downgrade to v5 requires an explicitly reviewed v5-compatible settings backup |
| `enabled` | `true` | Boolean | Search & scope toggle, both modes | Starts/stops Standalone indexing; disabled guard for purge | Original behavior; no migration enablement from invalid data |
| `paused` | `false` | Boolean | Search & scope toggle, both | Explicit pause/resume; source freshness validation remains active | Preserved |
| `propertiesEnabled` | `false` | Boolean | Search & scope toggle, both | Enables typed Properties search-view controls | Preserved |
| `topK` | `10` | Integer 1–50; no coercion from malformed draft | Results per search, Save/Cancel, both | Default result count only | Preserved; draft never persisted until valid |
| `advanced.enabled` | `false` | Boolean; enabled requires trusted profile and absolute interpreter/entry | Expert → Advanced diagnostics → Configure backend | Opt-in health-only stdio; not an AI claim | v2 imports disabled, v3–5 preserved; draft saved atomically |
| `advanced.profile` | `none` | `none\|local-stdio` | Expert editor when draft enabled | Local backend selection; no network listener | Existing `none/local-stdio` retained |
| `advanced.interpreter` | Empty | Path ≤4096, no NUL/backslash/newlines; absolute when enabled | Expert backend editor when enabled | Trusted local executable path | Existing value retained while disabled; no implicit execution |
| `advanced.entry` | Empty | Same string/absolute rules | Expert backend editor when enabled | Trusted health entry | Existing value retained while disabled |
| `ingestion.enabled` | `false` | Boolean; enabled requires complete paths | Documents → Configure, both modes | Explicit local document ingestion only | v1–3 default off, v4–5 preserved |
| `ingestion.interpreter` | Empty | Trusted absolute path if enabled | Documents editor when enabled | Local Python extraction | Hidden when disabled; retained |
| `ingestion.entry` | Empty | Absolute ending `/advanced_ingest.py` if enabled | Documents editor when enabled | Local extraction entry | Hidden when disabled; retained |
| `ingestion.tokenizerSnapshot` | Empty | Absolute path if enabled | Documents editor when enabled | Pinned local tokenizer | Hidden when disabled; retained |
| `ingestion.pdfMode` | `text` | One of `text/ocr/structured/structured-ocr` | Documents editor when enabled | Selects exact extraction profile; no fallback | Preserved |
| `ingestion.tessdataPath` | Empty | Absolute when enabled and OCR chosen | Documents editor only for OCR or structured+OCR | RU/EN local Tesseract asset path | Retained even when hidden or mode changes |
| `ingestion.artifactsPath` | Empty | Absolute when enabled and structured chosen | Documents editor only for structured or structured+OCR | Pinned layout/table artifacts | Retained even when hidden or mode changes |
| `probe.fixtureMode` | `false` | Boolean | Expert → Legacy synthetic probe → Configure | Historical manual diagnostic; never Standalone | v1 probe fields imported; no auto-run |
| `probe.interpreter` | Empty | Path string; UI requests absolute when enabled | Expert probe editor when draft enabled | Explicit trusted Python only | Hidden when disabled; retained |
| `probe.entry` | Empty | Path string; UI requests absolute when enabled | Expert probe editor when draft enabled | Historical fixture entry | Hidden when disabled; retained |

## Independent AI roles

Every role has a distinct persisted `ai.<role>` preference. They share a
**schema**, not a model identity, runtime health, grant, credential or endpoint.
The roles are `embedding`, `reranking`, `generation`; all default to
`{state:'disabled'}`. A malformed role is isolated as `{state:'invalid'}`
without invalidating the other roles or autonomous search.

| Field in each AI role | Default | Validation | Editor and dependency | Operational impact / rollback |
|---|---|---|---|---|
| `state` | `disabled` | `disabled/invalid/configured` | Independent role card; Configure/Save/Cancel/Disable | Preferences do not imply execution, network access or permission |
| `transport` | Local draft only | Literal loopback origin for local; canonical HTTPS origin for cloud | Connection type; contextual cloud/local disclosure | Cloud still denied by existing execution contracts; no auto-egress |
| `origin` | Empty draft | Canonical origin only, ≤256; no path/credentials/secret | API origin in the role form | No request on save/open; prior value retained until valid Save |
| `identity.model` | Empty draft | Required bounded model identifier | Model ID in the role form | Explicit role identity; no guessed model default |
| `identity.revision` | Empty draft | Required bounded revision identifier | Model revision in the role form | Embedding-space change shown with confirmation; no automatic rebuild |
| `limits.timeoutMs` | 10000 draft | Integer 100–30000 | Expert editor | Preserves role-specific previous value when Basic hides limits |
| `limits.maxInputBytes` | 16384 draft | Integer 1–65536 | Expert editor | Same |
| `limits.maxCandidates` | 20 draft | Integer 1–50 | Expert editor | Same |
| `limits.maxOutputTokens` | 1024 draft | Integer 1–4096 | Expert editor | Same |
| `limits.maxConcurrent` | Fixed 1 | Exactly 1 | No editable control (supported runtime constant) | No second concurrency policy |

All role editors use a bounded local draft and a single validated commit. An
embedding identity/transport/origin change is explicitly confirmed; it does
**not** execute a rebuild, mutate the index generation, or grant permission.
Reranker/LLM changes do not affect embedding-space identity. The existing
exact-scope, classification and consent boundaries remain authoritative.

## Non-persisted operational states and actions

| State/action | Owner | UI treatment and constraints |
|---|---|---|
| Offline indexing status, busy, generation, sources/records, warnings | `SearchController.status()` | Overview / Index & maintenance. Counts refer to the committed index, **not measured total coverage** |
| Last basic requested/executed mode | `SearchController.snapshot().response` | Display only if a current verified response exists; never fabricated |
| Optional extraction status | `AdvancedIngestionManager.snapshot()` | Last processing state; not retrieval readiness |
| Optional Python dense/lexical index state | `AdvancedRetrievalManager.snapshot()` | Labeled model-backed index; its source/chunk counts are **not API embedding-index coverage** |
| AI availability | `preferenceStatus` plus existing permission/execution contracts | Disabled, invalid, configured/not verified; do not advertise Ready from saved fields |
| Manual ingestion, index, rebuild, cancel, health recheck | Existing plugin controller callbacks | Explicit buttons only; no background downloads, broad indexing or hidden API calls |
| Cleanup | `purgeIndex()` with existing gate | Only disabled Standalone, explicit warning modal, recognized derived files only, original notes untouched |

## UX status and security boundaries

A local API is not automatically safe, online or ready. Cloud configured is
not authorized for content disclosure. Credentials are not entered or saved
by this UI. An unsupported AI or format capability is not made available by
a presentation toggle. All UI inputs use native Obsidian Settings components
and text rendering; only generated synthetic Vaults are used for acceptance.

The UI does not store a second provider catalog, model registry, connection
secret, dense index, or source content. The original `SearchSettings` and
runtime controllers remain authoritative. Explicit technical settings are
retained if a section becomes hidden, except where a pre-existing disable
semantics requires removal.
