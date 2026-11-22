# Local synthetic worker

`probe.py` is a one-shot Python 3.12 standard-library entry point. It reads bounded JSON Lines from stdin, independently validates the pinned synthetic identity and returns exact literal evidence. No file-content access, subprocesses, socket/listener, model, telemetry, download or persistent state exists in this runtime. Invoke only with a trusted configured interpreter and entry point. See [setup and smoke](../plugin/README.md) and [protocol](../contracts/README.md).


OKS-01B adds separate bounded foundation modules: `storage.py`, `scope.py`,
`persistent.py`, `supervisor.py`, and `resources.py`. These do not activate a
production workload or alter the v1 probe. Callers must create a dedicated 0700
cache directory per database, separate from their trusted source root. Scope
readers are synchronous and must not be closed concurrently with an active read.
See [ADR-0003](../docs/adr/0003-runtime-storage-foundation.md) and
[candidate evidence](../benchmarks/oks-01b.md) for boundaries and deferred gates.

## OKS-02A synthetic lexical baseline

`document.py` defines neutral source blocks and exact half-open UTF-8 byte
spans with one-based physical lines. Markdown parsing is deliberately limited to
physical-line headings, simple scalar front matter, clauses, lists, pipe tables
and wiki-link literals. Blank and structural lines remain in the representation.
Unsupported markup is retained literally with partial diagnostics where detected;
this is not a full CommonMark/YAML parser or a rendering engine. Neither inline
markup nor links are executed or resolved. No PDF/DOCX handling yet. Failed,
empty and unsupported sources are explicit; missing digest means the bytes
were not safely available.

`lexical.py` is an in-memory SQLite FTS5 baseline on original line units plus
heading context. Casefolded, whole technical terms are encoded as ASCII hex so
FTS punctuation splitting does not conflate IDs. BM25 ranks OR terms with stable
path/order ties; no stemming, synonyms or semantic negation. No vector
records or persistent storage changes: the Foundation storage prototype requires
dense vectors, which this phase cannot honestly supply. The baseline uses the
existing descriptor-relative scoped reader, verifies original line/byte evidence
against the current source on construction and suppresses stale/deleted sources
before returning hits. Bounds: 128 sources, 8192 blocks, 8192 bytes/source,
512 query bytes, 50 results. A trusted caller controls sources; it is not an
OS sandbox or an integrated plugin search command.

See the frozen corpus and reproducible baseline in [benchmarks](../benchmarks/README.md).
