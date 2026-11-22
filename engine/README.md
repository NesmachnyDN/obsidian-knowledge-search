# Local synthetic worker

`probe.py` is a one-shot Python 3.12 standard-library entry point. It reads bounded JSON Lines from stdin, independently validates the pinned synthetic identity and returns exact literal evidence. No file-content access, subprocesses, socket/listener, model, telemetry, download or persistent state exists in this runtime. Invoke only with a trusted configured interpreter and entry point. See [setup and smoke](../plugin/README.md) and [protocol](../contracts/README.md).
