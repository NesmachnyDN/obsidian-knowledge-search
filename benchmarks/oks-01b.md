# OKS-01B candidate evidence

Status: Measured on final candidate implementation; delivery remains subject to exact-head CI and independent review.
Base: `60680ab636d58d40b55bc2c6d723c41af3dac7f1`.
Requirements: V01B-01–06; partial CAP-01/08/09, not production acceptance.

Reproduce with `python3 benchmarks/oks01b.py` (storage and stdio only).
Loopback was measured using an isolated network namespace:
```sh
unshare -Urn sh -c 'ip link set lo up && exec python3 -I -B benchmarks/oks01b.py --loopback-local'
timeout --kill-after=3s 30s python3 -I -B scripts/oks01b_host_proof.py --run-host-proof
unshare -Urn python3 -I -B -m unittest discover -s tests -p 'test_*.py'
```
The loopback option is never a runtime default.

Final candidate rerun: Python 3.12.3, SQLite 3.45.1, Ubuntu 24.04, systemd 255. Includes root/path validation overhead. Single tiny experiment, not a general performance estimate.

| Storage (32 records × 4 coordinates, 60 queries) | Bytes | Median ms | p95 ms |
|---|---:|---:|---:|
| Packed float32 | 36864 | 0.0887 | 0.1414 |
| Normalized coordinates | 45056 | 0.1105 | 0.1719 |

Both layouts use the same deterministic mathematical vectors, scoped exact scores
and stable ties; the benchmark asserts parity. These are not embeddings. FTS5
availability and transaction recovery are also covered by acceptance tests.

| Health IPC (20 messages) | Median ms | p95 ms | Total ms |
|---|---:|---:|---:|
| One-shot stdio (20 processes) | 20.6648 | 21.639 | 416.105 |
| Persistent stdio (1 process) | 0.0535 | 0.1901 | 20.87 including stop |
| Authenticated isolated loopback (1 process) | 0.0496 | 0.122 | 56.854 including stop |

Actual final host proof: PASS, kernel memory/swap/CPU/pids limits verified,
both members of the transient process tree stopped and explicit restart proved
in two cycles. Portable isolated Python regression: 36/36 passed; existing
TypeScript regression: 101/101 passed. Typecheck, dependency/license checks
and build passed; no dependency or v1/plugin changes. Exact-head hosted CI
and fresh independent review remain delivery gates.

Packed storage and persistent stdio are selected for the bounded foundation in
[ADR-0003](../docs/adr/0003-runtime-storage-foundation.md). These tiny measurements
support only a foundation choice: no scale, retrieval-quality, production resource,
real-vault, or cross-platform claim. No additional dependencies or copied code.
The source tree and cache directory remain caller trusted; these controls are not
an OS sandbox against hostile same-user concurrent filesystem mutation.
