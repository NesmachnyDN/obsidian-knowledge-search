# OKS-06B.4 measured acceptance candidate

AC-11-GRAPH-04; ADR-0020; contract [OKS-06B-4](../../docs/prompts/OKS-06B-4.md). Linux desktop / CPU-first synthetic evidence only. Base f9f754dbbdd6b3657cf89f5b348e9616f1faa96e. Corpus and protocol frozen at c5c0d5c76961ca38f2982fc854e4d0ff7402646d before execution, SHA-256 888f125c9fa07383b858358d5b8155494f3bd1f06df9edf53804899bc88aa4c3. Final measured executable tree at 818f1544df45903a4455bfdbed0ea21df407943f; subsequent evidence-only commit. [128 results](results-128.json), [512 results](results-512.json). Reproduce with `node scripts/graph-benchmark.mjs`; no provider or real Vault. No tuning split, model selection or threshold change.

## Paired quality
40 queries per scale, 10 in each RU/EN and required/ordinary cell, no exclusions or failures in final run. Distinct-source rankings, raw ranks, path oracle and exact original locators in JSON.

| Metric | Basic lexical | Local graph | Gate |
|---|---:|---:|---|
| Graph-required Recall@10 | 0.4583 | 1.0000 | +0.5417 >= +0.10 |
| Graph-required nDCG@10 | 0.8012 | 1.0000 | +0.1988 >= 0 |
| Ordinary nDCG@10 / MRR@10 | 1 / 1 | 1 / 1 | no degradation |
| Exact-ID retention | 40/40 | 40/40 | unchanged |
| Authored edge precision / recall | not applicable | 1 / 1 | 49/49 at 128; 432/432 at 512 |
| Returned path precision / recall | not applicable | 1 / 1 | exact ordered oracle |
| Original locator verification | combined | 470/470 at 128; 2385/2385 at 512 | zero invalid |

Negative fixtures: ambiguous business IDs and aliases, unresolved links, navigation-only edges, cycles, private local note, selected-scope exclusion, silent edits to an identity competitor, rename/delete, cancel, disable rollback, reload. All recorded lifecycle checks passed. No external graph path admitted, no external provider calls; API tokens/cost for graph zero, other role profiles not run.

## Resources (final run)

| Metric | 128 | 512 | Threshold |
|---|---:|---:|---|
| Warm paired added p95 | 117.90 ms | 441.76 ms | <=250 ms at 128 only |
| Pure projection p95 | 22.69 ms | 83.46 ms | <=500 ms at 512 |
| Serialized projection | 76,665 B | 518,518 B | <=4 MiB |
| Incremental peak RSS during projection + paired retrieval | 29.70 MiB | 50.46 MiB | <=64 MiB |
| Cold graph retrieval | 232.41 ms | 838.31 ms | reported |
| Basic index build / restart | 493.44 / 406.14 ms | 1699.60 / 1640.94 ms | reported |
| Node event-loop p95 | 10.95 ms | 11.35 ms | supplemental, not UI |
| CPU user/system | 2625.10 / 1439.48 ms | 13822.42 / 5157.07 ms | reported |
| Basic generation bytes / change during graph workload | 366,656 / 0 | 1,583,173 / 0 | no graph persistence |

The frozen protocol measures the graph workload relative to the ready Basic engine; lifecycle stress is reported separately. Whole subsequent mutation/reconciliation/worker restart scenario peaked 44.98 MiB / 69.84 MiB above initial ready RSS. This is not a measurement of graph-only incremental RSS and must not be represented as a <=64 MiB end-to-end lifecycle guarantee. It includes rebuilding and restarting the Basic worker; monitor broader lifecycle memory on larger/other hosts. Exact source read counts/bytes/durations, hint I/O, and lifecycle I/O in JSON. Generation-file size unchanged; source/graph storage architecture has no extra persistent graph store. Real host storage/cleanup also checked.

## Actual host
Verified same runtime package attestation used for measurement (functional source at c2cdbcd, later benchmark/test-only additions). Obsidian 1.15.1, disposable no-route profile, frozen 512-note corpus, 80 timer samples: cold native graph UI 839.20 ms, UI event-loop p95 2.50 ms (<=50), max 19.60 ms. Scoped CLI, settings mapping, original Property anchor selection, lexical retry, mutation/revocation, disabled graph, reload, original Markdown preserved and clean package removal passed. Basic host source navigation/storage passed. No production installation, other OS/architecture, real model or graph-to-AI acceptance claim.

## Rerun history and validation
R1: 128 added p95 388.89 ms failed the 250 ms criterion; 512 run aborted on a degraded lexical response when the 30-second audit triggered. No acceptance. Corrected cooperative yield cadence and complete guarded catalog freshness reuse; source proofs and cancellation checks remain. R2: both scales passed, 128 added p95 114.03 ms; 512 projection p95 92.00 ms. R3: same corpus and runtime, added raw ranks and stricter returned path-anchor oracle and separated graph versus lifecycle resource reporting. Both scales passed all recorded gates; actual no-route host stress passed. This is a rerun of the same held-out sample after remediation, not independent statistical replication; synthetic exact identifiers and authored relations are not real-world semantic-search evidence.

Full local final executable-tree validation: TypeScript typecheck; Node 690 pass / 4 expected skips; Python 133 pass / 5 expected skips; package 17 pass; licenses, package attestation and diff check passed. Local exact evidence retained; published JSON contains only synthetic results. Independent full-diff review and required CI must still pass before merge. Gate A remains unchanged; no authorization to enable AI or deploy to a real Vault.
