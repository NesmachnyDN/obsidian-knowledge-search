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

Requests preserve [portable native-v2 semantics](../contracts/portable-model.md): normally nonempty query of at most 512 UTF-8 bytes, Top K integer 1–50, at most 32 typed predicates, bounded exact Markdown path scope and strict request ID. The optional `matchMode: "literal" | "terms"` selects case-insensitive exact substring/ordered phrase matching against original physical Markdown body lines (`literal`) or the original token/identifier ranking (`terms`). Omitted `matchMode` retains the historical `terms` behavior for protocol-v2 API callers. The Standalone UI defaults to `literal` and offers an explicit `terms` selector. Neither mode fabricates cross-line evidence. The optional bounded `metadata: {tag?: string, linkTarget?: string}` filter AND-combines with typed Properties and scope before Top-K. `tag` matches authored frontmatter `tags` (typed scalar or list strings) and inline `#tag` outside fenced code, case-insensitively; `linkTarget` matches the exact case-sensitive authored target of a `[[target|alias]]` link, not its display alias or an inferred resolved graph edge. Use `query: ""` only with at least one typed Property predicate or metadata selector. A metadata-only hit navigates to the matching original source line; frontmatter is never treated as ordinary body text. The feature remains entirely offline and does not add a persistent index schema. The public boundary additionally caps cumulative query/scope/predicate data at 16 KiB before cloning, rejects unknown nested predicate fields, and returns detached records so callers cannot mutate engine generations. A controller executes one search at a time and retains at most one pending latest request. A newer request or source event revokes older responses; settings changes, rebuild, cancel, disable and unload clear displayed results. Search controls are plugin UI/commands, not extra API operations.

## Settings and navigation

Settings schema v3 (with strict v1/v2 migration) stores only enable/pause state, default Top K, Property-control opt-in, a separate explicitly opt-in Advanced local stdio health-only profile (disabled by default; trusted interpreter/entry paths), and the historical manual probe configuration. Legacy unversioned/v1 fixture settings migrate explicitly. Unknown versions/fields/types fail closed with `SETTINGS_INVALID` and indexing disabled until valid settings are saved. Only explicit schema-v3 local-stdio activation may start a supervised lightweight Python v2 **health** process. Health is reported separately as `advancedTransport` (transportOnly); dense/hybrid remain unavailable. No binary extraction, model load, retrieval or document transfer is enabled by health-only opt-in; see ADR-0009.

Typed UI controls accept literal strings/ISO dates and JSON values for numbers, booleans, null and scalar lists. `eq` requires the exact declared type. `contains` is list membership only. Invalid input produces a visible diagnostic. The opt-in controls apply one predicate per UI search; API v2 supports up to 32. No source text or Properties are persisted in settings.

Each source-open action rechecks exact authorized `TFile` object/path, fresh bounded no-follow bytes and SHA-256, original UTF-8 byte span, Unicode codepoint span, physical line and exact excerpt. It rechecks before opening and after asynchronous open, compares the editor text (normalizing line delimiters only), and selects using UTF-16 editor columns. A source event revokes pending navigation. Changed/renamed/deleted files, symlinks, traversal, malformed anchors and unsaved editor differences fail with `NAVIGATION_REJECTED`. No fuzzy path or approximate location fallback exists. As in ADR-0008, an external mutation after the final check cannot be atomically excluded without filesystem locking/snapshots; a mutation detected during open suppresses selection and reports failure.

The view unsubscribes, clears its status timer and removes DOM on close. Unload revokes callers/navigation, detaches views and immediately terminates the parser before awaiting outstanding engine work. A reload barrier waits for the previous generation writer before reopening that Vault's store. Disabling stops the engine; resuming/rebuilding reconciles source versions. Cancel reports the engine's `CANCEL_DEFERRED` publication outcome instead of pretending a committed generation was undone. Diagnostics contain no excerpt, query, Properties, relative/absolute source path, settings, credentials or index blob.

The Settings tab exposes confirmed, disabled-only derived-index cleanup even after a cold restart with indexing disabled; the authorized Vault identity is recomputed without starting the search worker. Queued field-level settings changes are applied to the latest saved state, preventing lost updates. The purge and new writer opening are serialized by Vault-path and generation barriers. It enumerates a small allowlist of index pointer, generation and staging filenames in the identity-bound host-private index directory and refuses symlinks, hardlinks, unknown files or changed Vault identity. It does not perform recursive deletion; original notes are never touched. Re-enable to rebuild. A broader storage-quota management UI remains deferred; automatic 04A generation GC is unchanged. Linux CPU-first synthetic acceptance only; release, production Vault and other-host claims remain separate gates.

## Optional Advanced health-only transport (OKS-05B candidate)

A schema-v3 settings record enables the separately provisioned `local-stdio` transport only with explicit boolean opt-in and absolute trusted `interpreter` and `entry` paths. The default package remains Obsidian plus three Standalone assets, with no Python startup. `status` and metadata-only `diagnostics` additionally expose `advancedTransport: {profile,status,error,transportOnly:true}`. These do **not** confer dense/hybrid execution, PDF/OCR support or a canonical cross-runtime evidence contract. Dense/hybrid continue to return `CAPABILITY_UNAVAILABLE` and `executedMode: none`. The health channel uses existing Python v2 fixed-shape nonce-correlated health frames, not the search API protocol. Full Advanced integration remains in OKS-05C–05E.

## Separate consent-bound machine API (OKS-05P-D8 candidate)

The optional local embedding pilot exposes a separate `plugin.denseApi` object, version 1. The original `plugin.api` v1 is unchanged. Submit only stages one exact request for human review; no provider call, grant, credentials, classification or confirmation is accepted from a machine caller. This is a trusted in-process interface, **not** an isolation boundary against arbitrary already-trusted Obsidian plugin/eval code.

| Operation | Exact envelope in addition to `apiVersion:1` | Result |
|---|---|---|
| submit | operation, request (native v2), space (exact declared EmbeddingSpace) | Opaque operationId and fixed expiry |
| status | operation, operationId | Metadata only: phase, modes, expiry, typed error, per-leg status/counts |
| result | operation, operationId | One detached native API retrieval result after authoritative corpus and generation re-verification |
| cancel | operation, operationId | Revokes the operation; no result |
| rebuild | operation only | UNSUPPORTED_OPERATION |

Use `obsidian eval` on an explicitly configured, isolated synthetic Vault. Example (the model identity and dimension must match the declared provider and verified active index):

```sh
obsidian eval 'code=(async()=>JSON.stringify(await app.plugins.plugins["oks-synthetic-evidence"].denseApi.request({apiVersion:1,operation:"submit",request:{protocolVersion:2,requestId:"machine-1",query:"REQ-OKS-DENSE",requestedMode:"hybrid",matchMode:"terms",scope:["dense-a.md","dense-b.md"],limit:5},space:{model:"synthetic-embedding",revision:"fixture-v1",dimension:2,normalization:"unit-l2",serializationId:"utf8-verbatim-v1",queryInstructionId:"identity-v1",documentInstructionId:"identity-v1"}})))()'
```

Open the Standalone search ItemView and select **Review pending machine API request**. Inspect the exact D7 preview, select permitted classification, enter the one-operation local token and explicitly confirm. The operation capability is not displayed there. The machine caller retains the opaque ID from submit and uses the same CLI eval bridge, substituting its ID:

```sh
obsidian eval 'code=(async()=>JSON.stringify(await app.plugins.plugins["oks-synthetic-evidence"].denseApi.request({apiVersion:1,operation:"status",operationId:"REPLACE_WITH_SUBMIT_ID"})))()'
obsidian eval 'code=(async()=>JSON.stringify(await app.plugins.plugins["oks-synthetic-evidence"].denseApi.request({apiVersion:1,operation:"result",operationId:"REPLACE_WITH_SUBMIT_ID"})))()'
```

The envelope is `{apiVersion:1,ok:true,value:...}` or `{apiVersion:1,ok:false,error:CODE}`. Inspect result status, requested/executed modes and legs; there is no silent lexical fallback. Exact unique nonempty Markdown scope is required, with existing query/Top-K/typed predicate limits and a 16 KiB encoded input budget. One operation occupies the slot for at most five minutes, including preview and result read. Manual dense actions may supersede it; cancellation, source/configuration changes, view close, lifecycle invalidation and expiry revoke delivery. Successful delivery consumes the result. Result contents and capability IDs are sensitive: do not include them in public logs. No result history or new index, no machine rebuild, navigation, reranking or generation. Already returned evidence cannot be revoked, and a filesystem mutation after final verification cannot be excluded atomically without filesystem snapshots or locking. This candidate is not a Gate B acceptance claim.
