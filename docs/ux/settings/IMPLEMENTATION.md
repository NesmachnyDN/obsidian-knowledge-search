# OKS-06UX — Settings usability implementation

Applies to the candidate Linux desktop Standalone plugin. It is **not**
authorization to install into a production Vault, perform external data
disclosure, enable unsupported formats, or claim Gate B/C acceptance.

## First use (Basic)

The Settings tab opens in **Basic** on a clean install. No API connection,
Python, tokenizer or model download is required for offline Markdown search.
The **Overview** shows the current offline index/worker state, disabled or
configured optional AI roles and the difference between a saved preference and
operational readiness.

**Search & scope** offers offline search, pause, typed Properties filtering and
**Results per search** (1–50). For the latter, enter a whole number and press
**Save**; **Cancel** restores the committed value. Invalid input and failed
persistence do not write partial configurations. The existing Search view owns
the actual search execution and verified source-navigation controls.

## Optional AI connections

**AI capabilities** has independent cards for Semantic search (embedding),
ranking improvement (reranking) and evidence-based answers (generation). Use
**Configure**, select the exact local or cloud transport, enter canonical
origin, model identifier and revision, and explicitly **Save connection**.
The configured preference is **not a readiness probe, permission grant or
provider activation**. Endpoint syntax rejects credentials, paths, queries,
noncanonical local aliases, and unknown model identity. API keys cannot be
entered in this settings interface. Cloud remains unavailable for disclosure
unless the existing per-operation, per-source authorization process permits
it. Local loopback is not an assumption of a trusted model.

Each card has its own Save/Cancel/Disable actions, drafts and error state;
changing one does not configure the others. Technical limits are visible in
Expert; hidden values persist on switching back to Basic.

For an embedding transport/origin/model/revision change, a confirmation
explains **embedding-space incompatibility and explicit staged rebuild**.
Saving only updates preferences; it does not create a dense generation,
perform a network request, issue permissions or delete the previous verified
index. Reranker/LLM changes do not require dense reindexing. Use the existing
separately authorized dense rebuild and selected-corpus flow if applicable;
do not assume dense or hybrid execution from a configured connection.

## Documents and indexing

**Documents** presents current local processing status, with an explicit
**Configure documents** editor. When local ingestion is disabled, runtime
paths are hidden. On enabling the draft, only the paths relevant to the
selected PDF extraction mode are shown: native text, OCR, structured layout,
or structured+OCR. Missing required trusted paths prevent Save. The same
section can ingest the active synthetic/authorized document manually; there
is no automatic whole-Vault ingestion, model setup, or download.

**Index & maintenance** displays the committed offline index state and
two optional index paths separately. Source and record counts **do not
measure total coverage** without an authoritative denominator. The last
verified basic request shows requested and executed modes when available.

- **API dense index (selected Markdown corpus):** Settings shows provider
  configuration/unavailability, not verified index readiness or coverage.
  Use **Open Standalone search → Optional local API dense / hybrid search →
  Prepare explicit dense index rebuild** with exact corpus paths and vector
  dimension, then review and authorize the existing one-operation preview.
  The current pilot is local-only; cloud execution is unavailable.
- **Legacy local BGE-M3 index (documents):** the legacy retrieval snapshot
  and **Legacy document index operations** apply to the active document
  only. Index/rebuild/cancel and legacy search use the existing legacy
  controllers, never the API dense index.

**Delete derived offline index** requires Standalone indexing to be disabled
and a separate confirmation. It uses the existing recognized-file guard and
never deletes original notes.

## Expert, diagnostics and troubleshooting

Use **Settings view → Expert** to expose existing technical provider limits,
the opt-in health-only local backend, and historical synthetic probe.
The backend health status does not imply extraction or AI readiness, and
the probe is not needed for Basic. Overview in both modes shows whether
the health-only backend, document ingestion and manual probe are enabled;
transport/processing status is separate from AI readiness, and a configured
probe is not a running-state indicator. Technical paths remain in the
respective editors. The setting is a **presentation preference
only**; switching Basic/Expert cannot change search operation, credentials,
grants, index state or enabled provider identities.

For errors: check the status/reason shown in Overview, Documents or
Index & maintenance. Retry a failed draft with its values preserved or
Cancel; use the existing Search view's sanitized **Export safe diagnostics**
for shareable metadata only. Permission denial, provider outage and no-route
conditions do not convert requested AI search into a falsely successful
lexical response. Explicit offline basic search remains independent.

## Migration and rollback

- Existing v1 probe, v2 health-only, v3 optional backend, v4 document
  ingestion and v5 per-role configurations are parsed under strict v6
  validation. New installs default Basic; existing enabled/paused/AI state
  is preserved. A malformed configuration fails closed; no automatic
  provider or backend is enabled as a repair mechanism.
- **Before upgrading, retain a secure backup of existing plugin settings**
  using your approved private backup process. This is particularly
  important when rolling back to a plugin that only supports schema v5:
  **v5 cannot read v6 directly**. To downgrade safely, first disable
  the plugin, restore the pre-upgrade v5 settings backup and the previously
  verified plugin package, then explicitly re-enable it. Never copy
  source documents, credentials or host-private index data into a public
  artifact. If no compatible backup exists, use a documented deliberate
  defaults reset with all optional roles disabled, then configure again.
- Rollback of the view does not require changing the host-private search
  index. Do not manually delete or mix active dense generations when
  changing the embedding identity; use the existing staged migration and
  verified rollback controls.
- A damaged settings file remains a failure, not a reason to silently
  enable advanced features. Preserve its private backup for diagnosis.

## Acceptance and evidence

The field-level inventory is in
[implementation-inventory.md](implementation-inventory.md). Automated tests
include the exact v1–v6 migration, draft validation and independent role
contracts. Real-host acceptance must run against the packaged artifact,
a disposable synthetic Vault, and an isolated no-route Obsidian session:

```sh
npm run typecheck
npm test
npm run test:python
npm run test:package
npm run licenses
OKS_06UX_TEST=1 OKS_HOST_NO_ROUTE=1 \
  OKS_STANDALONE_PACKAGE_DIR="$PWD/build/standalone-package" \
  bash scripts/obsidian-host-smoke.sh
```

The UX harness validates real Obsidian Settings DOM, offline typed source
search, configuration drafts/failure retention, role isolation, conditional
OCR/structured paths, view-only mode switches and disabled-only cleanup.
Complete release acceptance still requires exact-HEAD CI, CodeQL and
**a separate independent full-diff SDD review** before any merge.

## Visual and keyboard acceptance (B-VISUAL-01–04)

The separate Settings Electron window is captured directly on a dedicated
X11/Xvfb display in an isolated no-route generated Vault. The host runner
does not inherit the workstation's Wayland/DBus session. The reproducible
visual mode must use a fresh absolute evidence directory:

```sh
OKS_06UX_TEST=1 OKS_HOST_NO_ROUTE=1 OKS_HOST_TIMEOUT_SECONDS=250 \
  OKS_06UX_VISUAL_DIR=/tmp/oks-settings-evidence-fresh \
  OKS_STANDALONE_PACKAGE_DIR="$PWD/build/standalone-package" \
  bash scripts/obsidian-host-smoke.sh
```

The visual harness captures the actual Settings window, checks actual
computed visibility and nonzero layout rectangles (not only the hidden
attribute), sends native Tab/Shift+Tab/Space events, and measures overflow
at 900×700 and 760×700 windows with 100% and 200% native zoom. Long translated
labels are synthetic DOM stress inputs, not an implemented translation.
It saves PNGs, geometry results and SHA-256 sums outside the repository.
A failing scenario does not emit a visual PASS. Review the rendered
screenshots separately; a green DOM test alone does not prove visual
acceptance. No real Vault, provider or credentials are used.

Settings layout rules are scoped to OKS; they respect hidden descendants
despite host CSS, wrap native controls and keep disclosure openers before
their editors in DOM order. Save/Cancel restores focus to the relevant
control and status refresh does not replace an unrelated editor.

The Current AI operation row is a read-only projection of the existing
role controller, updated when Settings opens or Refresh is selected.
Idle, permission-required, busy, completed and failed/cancelled are
separate from provider preferences. Completion is evidence of one
authorized operation, **not standing provider readiness or permission**.
No operation, credential or source content is created or read by this
projection. Optional role transition/failure evidence uses the existing
isolated loopback fixture with OKS_AI_RERANK_TEST=1; it is not Gate B
acceptance of any real provider.
