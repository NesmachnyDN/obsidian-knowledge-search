# OKS Standalone API v1

OKS-04B provides `app.plugins.plugins["oks-synthetic-evidence"].api`, an in-process object with `apiVersion: 1` and async `request(input: unknown)`. The installed plugin ID is still the historical development ID. No HTTP server, socket, external process, model, Python installation or network request is involved. This interface is available after plugin load; readiness can still be `initializing` until workspace layout and reconciliation finish. It is a local developer interface, not remote access or a security boundary against other already-trusted plugins/eval callers.

## Supported Obsidian CLI bridge

With the disposable test Vault open and Obsidian's supported CLI enabled, invoke `eval`:

```sh
obsidian eval 'code=(async()=>JSON.stringify(await app.plugins.plugins["oks-synthetic-evidence"].api.request({apiVersion:1,operation:"status"})))()'
obsidian eval 'code=(async()=>JSON.stringify(await app.plugins.plugins["oks-synthetic-evidence"].api.request({apiVersion:1,operation:"search",request:{protocolVersion:2,requestId:"cli-1",query:"REQ-OKS-SMOKE",requestedMode:"lexical",limit:10}})))()'
obsidian command id=oks-synthetic-evidence:open-standalone-search
obsidian command id=oks-synthetic-evidence:open-first-search-source
```

`obsidian` above denotes the installation's supported CLI executable (the smoke script accepts `OBSIDIAN_CLI` and `OBSIDIAN_EXE`). This is the actual `eval code=...` mechanism used by the existing 04A host smoke. The extended 04B script calls this same mechanism and drives real UI controls/editor selection; the Codex sandbox execution was blocked by Xvfb socket restrictions, but the same extended script subsequently **passed in real Obsidian 1.15.1 through Remote Desktop Commander** on 2026-11-23. No standalone `search` CLI command is assumed. The API's search results contain source excerpts, relative paths and typed Properties; do not paste them into public logs. Use `diagnostics` for safe metadata-only export.

## Envelope and responses

| Operation | Exact input fields | Successful `value` |
|---|---|---|
| Status | `{apiVersion:1, operation:"status"}` | Status, generation ID, counters, busy/pause/enable state, safe error/maintenance codes, explicit lexical/dense/hybrid readiness |
| Search | `{apiVersion:1, operation:"search", request: SearchRequestV2}` | Unchanged native protocol-v2 SearchResponse semantics |
| Diagnostics | `{apiVersion:1, operation:"diagnostics"}` | JSON string reconstructed from allowlisted status metadata |

Success is `{apiVersion:1, ok:true, value:...}`. Boundary failures are `{apiVersion:1, ok:false, error:CODE}`. Unknown/missing API versions return `API_VERSION_UNSUPPORTED`; malformed fields, unknown keys, wrong types, invalid limits, predicates or protocol versions return `INVALID_REQUEST`. Disabled/unloaded calls return `DISABLED`; not-yet-ready calls return `INDEX_UNAVAILABLE` or an initialization code. Superseded calls return `SUPERSEDED` without evidence. Unexpected exceptions become `INTERNAL_FAILURE` without their messages or paths.

An `ok:true` search means a valid native response was produced, **not** that retrieval succeeded: inspect `value.status` (`ok`, `degraded`, `failed`), `error`, `executedMode`, `capabilityReadiness`, `staleSourceCount` and `indexGenerationId`. A dense/hybrid request returns native `failed`, `CAPABILITY_UNAVAILABLE`, `executedMode: none` and zero hits. There is no fallback or fake dense readiness. Status snapshots are informational; callers must inspect each response's pinned generation and readiness.

Requests preserve [portable native-v2 semantics](../contracts/portable-model.md): nonempty query of at most 512 UTF-8 bytes, Top K integer 1–50, at most 32 typed predicates, bounded exact Markdown path scope and strict request ID. The public boundary additionally caps cumulative query/scope/predicate data at 16 KiB before cloning, rejects unknown nested predicate fields, and returns detached records so callers cannot mutate engine generations. A controller executes one search at a time and retains at most one pending latest request. A newer request or source event revokes older responses; settings changes, rebuild, cancel, disable and unload clear displayed results. Search controls are plugin UI/commands, not extra API operations.

## Settings and navigation

Settings schema v2 stores only enable/pause state, default Top K, Property-control opt-in, an inactive advanced profile (`none` or `local-stdio`, `enabled:false` only), and the historical manual probe configuration. Legacy unversioned/v1 fixture settings migrate explicitly. Unknown versions/fields/types fail closed with `SETTINGS_INVALID` and indexing disabled until valid settings are saved. Advanced configuration cannot start a backend in this version, even if hand-edited to request enablement.

Typed UI controls accept literal strings/ISO dates and JSON values for numbers, booleans, null and scalar lists. `eq` requires the exact declared type. `contains` is list membership only. Invalid input produces a visible diagnostic. The opt-in controls apply one predicate per UI search; API v2 supports up to 32. No source text or Properties are persisted in settings.

Each source-open action rechecks exact authorized `TFile` object/path, fresh bounded no-follow bytes and SHA-256, original UTF-8 byte span, Unicode codepoint span, physical line and exact excerpt. It rechecks before opening and after asynchronous open, compares the editor text (normalizing line delimiters only), and selects using UTF-16 editor columns. A source event revokes pending navigation. Changed/renamed/deleted files, symlinks, traversal, malformed anchors and unsaved editor differences fail with `NAVIGATION_REJECTED`. No fuzzy path or approximate location fallback exists. As in ADR-0008, an external mutation after the final check cannot be atomically excluded without filesystem locking/snapshots; a mutation detected during open suppresses selection and reports failure.

The view unsubscribes, clears its status timer and removes DOM on close. Unload revokes callers/navigation, detaches views and immediately terminates the parser before awaiting outstanding engine work. A reload barrier waits for the previous generation writer before reopening that Vault's store. Disabling stops the engine; resuming/rebuilding reconciles source versions. Cancel reports the engine's `CANCEL_DEFERRED` publication outcome instead of pretending a committed generation was undone. Diagnostics contain no excerpt, query, Properties, relative/absolute source path, settings, credentials or index blob.

The Settings tab exposes confirmed, disabled-only derived-index cleanup. It enumerates a small allowlist of index pointer, generation and staging filenames in the identity-bound host-private index directory and refuses symlinks, hardlinks, unknown files or changed Vault identity. It does not perform recursive deletion; original notes are never touched. Re-enable to rebuild. A broader storage-quota management UI remains deferred; automatic 04A generation GC is unchanged. Linux CPU-first synthetic acceptance only; release, production Vault and other-host claims remain separate gates.
