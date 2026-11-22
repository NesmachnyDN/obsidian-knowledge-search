# ADR-0003: Transactional storage and bounded local runtime foundation

Status: Accepted for bounded foundation upon OKS-01B review and merge. Production integration and workload validation remain deferred.

## Decision and experiment boundaries

Use one SQLite database for complete versioned identity, generation, scoped source
hashes, FTS5 lexical records and packed little-endian float32 records. Publish a
replacement generation in one transaction, with WAL reader snapshots and FULL
synchronous commits. Reject incompatible identity rather than mix spaces. The
caller supplies current hashes; missing or changed hashes suppress records. Cache
location must be in a dedicated caller-owned private directory outside the source
root (one database and its SQLite sidecars only). Reject symlinks, nonregular
files and multiply linked cache files/sidecars before SQLite opens them. Bind
manifest identity to a local SHA-256 fingerprint of canonical source-root path,
device and inode; reject cross-root reuse and replaced roots. The fingerprint
is local metadata, never benchmark output. Existing foreign or unbound caches are rejected before journal or schema changes,
without changing existing database or source bytes. This includes a newly created
cache closed or interrupted before its first generation is published. Recovery
requires the caller to stop all cache users, explicitly discard only the known
derived cache database and its sidecars, and rebuild; opening never automatically
deletes or adopts an unbound database. Source files must be preserved.
This is a bounded prototype,
not ingestion, embeddings or a production retrieval engine.

Compare packed records with normalized SQLite coordinates on the same tiny exact
mathematical vectors, filters and stable ties. Both can transact atomically;
packed records avoid coordinate rows and reconstructing vectors. Neither proves
production scale, semantic quality, tokenizer compatibility or ANN performance.
FTS5 creation/rollback is tested; language/tokenization quality is deferred.

Select persistent, sequential JSON Lines stdio for the future production IPC
boundary, conditional on integration and host proof. The separate v2 health-only
prototype reuses 01A validators; v1 and the desktop command remain unchanged.
A fixed worker entry point, bounded frames, fresh internal random correlation per request, deadlines and one active
request avoid arbitrary execution and unbounded queues. Cancel terminates the
worker; restart is explicit. One-shot avoids idle process lifetime but pays startup
per message. Authenticated loopback adds authentication, listener and lifecycle
surface; measure only with explicit local opt-in, never a default listener.

## Scope and resources

Descriptor-relative Linux reads open each component with O_NOFOLLOW and reject
noncanonical paths, ignored directories, symlinks, nonregular files and over-limit
content. Root ancestors are opened descriptor-relatively; reads recheck root and path
identity before returning. Close is idempotent and closed readers reject access.
Trusted root, source tree and private cache directory must remain controlled by
the caller (including no concurrent hostile same-user cache mutations): source hard links,
mount changes and malicious concurrent renames are outside this filesystem threat
model. Metadata checks detect ordinary concurrent edits but cannot prove a snapshot
against an adversarial writer. This is not an OS sandbox. No vault scanning occurs.

Linux user-systemd transient services provide cgroup v2 process-tree limits, with
pre-admission free-memory/disk reserves and a single active job. The explicit host
proof uses <=64 MiB RAM, no swap, <=25% CPU, <=8 tasks, a <=15-second runtime,
control-group kill and <=1-second stop deadline. Verify kernel limits before
starting the sleeping descendant, stop and verify both processes gone, then
restart. Deny unavailable controls or insufficient resources. Pressure cancels
work; recovery requires fresh admission and explicit restart, never automatic
work. Manager preflight failure releases admission before unit allocation. Failed stop
retains ownership unless a successful LoadState query confirms not-found; an
unavailable manager is not proof of absence. Portable tests do not constitute
actual cgroup proof.

## Consequences and deferred gates

No new package or runtime download. Independently authored code uses Python stdlib
(PSF distribution) and installed SQLite (public domain), consistent with REUSE;
no third-party code copied and no dependency lock changes. See
[reproducible evidence](../../benchmarks/oks-01b.md) for actual results and commands.
Host proof and Node regression passed; exact-head CI and independent review remain delivery gates. No production-vault or full CAP-01/08/09 acceptance is claimed.
