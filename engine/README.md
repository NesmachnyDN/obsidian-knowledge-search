# Local synthetic worker

`probe.py` is a one-shot Python 3.12 standard-library entry point. It reads bounded JSON Lines from stdin, independently validates the pinned synthetic identity and returns exact literal evidence. No file-content access, subprocesses, socket/listener, model, telemetry, download or persistent state exists in this runtime. Invoke only with a trusted configured interpreter and entry point. See [setup and smoke](../plugin/README.md) and [protocol](../contracts/README.md).


OKS-01B adds separate bounded foundation modules: `storage.py`, `scope.py`,
`persistent.py`, `supervisor.py`, and `resources.py`. These do not activate a
production workload or alter the v1 probe. Callers must create a dedicated 0700
cache directory per database, separate from their trusted source root. Scope
readers are synchronous and must not be closed concurrently with an active read.
See [ADR-0003](../docs/adr/0003-runtime-storage-foundation.md) and
[candidate evidence](../benchmarks/oks-01b.md) for boundaries and deferred gates.
