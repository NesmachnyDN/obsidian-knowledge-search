# ADR-0008 — Host-private, plugin-managed transactional Standalone index

**Status:** Proposed (pending independent OKS-04A full-diff review). **Decision owner:** OKS maintainers. **Supersedes:** no accepted prior Standalone-native storage decision; ADR-0003's Python SQLite experiment is retained unchanged.

## Decision and security boundary

For the **Linux desktop Standalone profile**, keep the bounded, versioned, disposable Markdown lexical index under the local user's private durable application-data location:

```text
$XDG_DATA_HOME/obsidian-knowledge-search/plugins/<plugin-id>/<vault-root-digest>/index/
```

When `XDG_DATA_HOME` is missing or relative, use `~/.local/share` per the XDG convention. This is **not** inside the Obsidian Vault and is not included in the plugin bundle or the Obsidian Sync Vault configuration by default. A source Vault rooted at/above this cache path is rejected; the product never writes original Markdown. Every plugin installation requires only Obsidian + the packaged JavaScript bundle. No SQLite service, Python, binary runtime, model, Docker, internet or user-created filesystem configuration is needed.

The canonical `rootId` is SHA-256 over the real root path, device and inode. Stored `rootId`, schema version, lexical index ID, `sourceVersionSet`, `generationId`, `publishedAt` and hashed generation bytes are checked on open. A moved/replaced Vault intentionally gets a new storage partition and a rebuild. Unknown/foreign indexes fail closed; no automatic destructive recovery.

A generation is an immutable size-capped JSON file with canonical source versions and original-line locators. Commit stages each file with `O_EXCL`, `O_NOFOLLOW` and mode 0600, `fsync`s content, atomically renames it into place and `fsync`s the directory. Publication is the atomic replacement of `CURRENT`; `PREVIOUS` remains the recovery pointer. Cancellation is checked again after the staged CURRENT pointer is written and fsynced, immediately before starting its atomic rename. A requested cancel **before** this checkpoint vetoes publication; after the rename has started, publication cannot be revoked safely, so cancellation is reported as deferred (not as a successful cancellation), finishes the committed generation, and pauses subsequent indexing. A canceled, crashed or failed *pre-publication* stage never becomes a published generation. On recovery from a valid PREVIOUS, the recovered pointer becomes the active snapshot and is preserved as PREVIOUS on the next commit. Startup reconciliation repairs a corrupt CURRENT even if the recovered source versions are unchanged. On startup, accept only a fully authenticated and compatible generation or previous compatible pointer. No partial generation is ever advertised as ready. Recoverable `.stage-UUID` files older than 60 seconds are cleaned conservatively; more than eight unresolved stages cause a bounded fail-closed error. Known unreachable generation files are garbage-collected only after successful publication. All cleanup targets are known derived filenames; never traverse or remove source notes.

Reconciliation is one in-process, bounded and cancellable generation writer with cooperative scheduling. Actual Markdown parsing is performed by a bundled browser Web Worker (not Node `worker_threads`; rejected by the tested Electron runtime), with one outstanding document, a 5-second timeout and worker termination on failure/unload. Source enumeration is through public Obsidian Vault APIs; bounded descriptor-backed reads from the verified root (64 KiB/source) use no-follow and identity checks to avoid stale cache and unbounded `Vault.readBinary` allocations. The index is revalidated against current source bytes before any evidence is shown. Missed file events trigger lazy repair after stale-hit suppression. No graph traversal or inferred source coordinates.

## Alternatives considered

| Candidate | Assessment | Decision |
|---|---|---|
| **IndexedDB** | Real transactions, but renderer origin/profile, storage eviction, quota, multi-Vault isolation and app-profile backup/portability need a dedicated Obsidian test. Global renderer storage may combine unrelated Vaults. | Defer; not selected solely for API convenience |
| **`Plugin.saveData()/data.json`** | Supported for small settings, not a proven atomic/persistent multi-megabyte index with generation rollback. In-Vault settings may be synchronized. | Reject for index |
| **In-Vault plugin-owned files (`.obsidian/plugins/…`)** | Easy packaging, but the file content contains original excerpts and typed Properties and may be included in optional Obsidian Sync of community-plugin config/data. | Reject as default on privacy grounds |
| **Host-private XDG plugin-owned files** | No extra dependency, Linux fsync/rename, explicit quotas/recovery, no default Vault Sync transport; can be tested with a disposable host profile. | **Choose for OKS-04A** |
| **SQLite native binding/server** | SQLite Python reference is valid for optional advanced backend, but does not provide a built-in browser/Obsidian-native runtime without bundling a binary or server. | Reject in Standalone |

## Guarantees, limits and evidence

- Bounded: 512 Markdown sources, 64 KiB source bytes, 32,768 source blocks, 16 MiB generation, 50 hits, 512 query bytes, 32 predicates and one active reconciliation job. Refusal and degraded status replace silent truncation.
- Current and previous generations are kept. The hard admission limit is four named generation files (two committed/previous and up to two orphan crash candidates) plus capped transient staging; eight stage-orphan files are the fail-closed admission ceiling. A non-silent cache pressure error replaces unlimited accumulation. A total cache quota alarm and user-initiated purge UI belong to OKS-04B.
- The host profile is a trusted single-user desktop running a single Obsidian plugin instance per Vault. Node does not expose a portable `openat2`-style pinned path walk; checks mitigate but do not prove security against a hostile, continuously renaming *external* filesystem attacker. Multi-process writers sharing the same cache root are not supported. A plugin-reload or concurrent-instance test is mandatory before acceptance.
- Atomicity and crash-durability claims depend on the local filesystem's rename/fsync semantics. Network filesystems and alternative OS hosts are not within this decision's verified support.
- Freshness safety is independent of event delivery: every displayed candidate must pass a new authoritative SHA-256 check and exact byte/Unicode/line locator verification. An in-flight source mutation may still occur after the last check, which is an unavoidable race absent a filesystem snapshot/locking API; no stale *known* content is ever knowingly returned.
- Host-private cache is not part of Obsidian Sync by default. Users' separate whole-home backup/sync utilities may still copy local application data; this is outside OKS network behavior and must be disclosed in privacy docs.
- The plugin neither starts network services nor transmits source/index data. Diagnostic outputs must not contain original excerpts or private paths.
- Native integration test evidence: Obsidian desktop 1.15.1, isolated synthetic profile/Vault, native source indexing, lexical query with original line, event-driven modification and plugin reload. This is **not** a 04B UI acceptance or product release.
- Initial proof uses single-machine Linux desktop and synthetic fixture. Broader UI/workspace, cross-platform support and public packaging remain separate gates.

This ADR becomes **Accepted only after exact-HEAD CI and independent SDD full-diff approval**, not by the author writing the document.
