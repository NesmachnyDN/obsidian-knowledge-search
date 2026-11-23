# OKS-04A — Standalone native lexical synthetic corpus v1

**Status:** OKS-04A implementation merged in PR #11. The current rerun and OKS-04B candidate validation are author-produced evidence; see [04B validation and open gates](04b-validation.md). This is a real TypeScript lexical-only (no model) experiment, **not** a claim of MVP, CAP-05, full Obsidian UI or optional advanced profile validation.

## Reproduction

From repository root on the development host:

```sh
npm ci
npm run typecheck
npm test
npm run test:python
npm run benchmark:standalone
npm run build
bash scripts/obsidian-host-smoke.sh
```

The benchmark bundles the independently authored native engine and browser-worker parser with the existing pinned esbuild test dependency. It runs the browser worker bundle through a Node worker_threads **test-only adapter**, not the Obsidian production runtime. It checks SHA-256 of all 21 unchanged synthetic corpus v1 Markdown files, copies them to a disposable Vault, creates a host-private disposable XDG cache **outside** that Vault, indexes, queries the frozen **15 tuning + 16 held-out** cases with unmodified original labels, calculates the original metrics, and fault-checks source staleness plus one incremental index update. The real Obsidian smoke launches version 1.15.1 via Xvfb into an isolated app profile and synthetic Vault, tests original source-backed line, Obsidian change, plugin reload and private XDG cache; it is distinct from the Node synthetic provider benchmark.

## Measured evidence

Machine-dependent values are in `results.json`; use that file, not hardcoded estimates, when checking precision, latency and memory. At the last 21-source baseline:

| Measure | Standalone TS |
|---|---|
| Source coverage | 21/21 synthetic Markdown files |
| Indexed lexical source records | 91 nonempty lexical blocks |
| Query count | 31: 15 tuning, 16 held-out |
| Exact-ID direct hit | 12/12 |
| Invalid original locators | 0 |
| Known stale evidence returned | 0 |
| Stale-source suppression before Top-K | 1 tested and suppressed |
| Query latency p50/p95 | ~0.75 / ~2.76 ms in Node benchmark harness |
| Initial index build | ~175 ms including browser-worker test adapter startup |
| Incremental update | ~63 ms |
| Serialized immutable generation | ~77 KiB |
| Heap use | ~10.4 MB for entire harness; process RSS ~88.4 MB, **not** isolated engine |
| Real Obsidian host smoke | historical 04A core smoke; extended 04B UI run blocked in sandbox |

The benchmark writes numeric results including process RSS, event-loop delay, exact-id/invalid-locator counts, Python baseline and source-change checks into `results.json`. Timing and memory are implementation/environment-specific, not guaranteed device-wide quotas or user-facing SLA.

## Python 03B lexical comparison (unchanged synthetic judgments)

| Split / span@10 | Native Recall | Python lexical Recall | Native nDCG | Python lexical nDCG | Native MRR | Python lexical MRR |
|---|---:|---:|---:|---:|---:|---:|
| Tuning (14 answerable cases) | 0.8929 | 1.0000 | 0.9469 | 0.9900 | 1.0000 | 1.0000 |
| Held-out (15 answerable cases) | 0.9333 | 0.9667 | 0.9406 | 0.9412 | 0.9556 | 0.9444 |

This is a **directional**, not algorithm-identical comparison: Python reference uses FTS5/BM25 and canonical retrieval chunks; native searches original physical Markdown lines, boosts complete technical identifiers and does not index invented contextual text. Tuning quality is lower; **this is a warning, not a post-hoc new mandatory threshold**, because the frozen 04A contract does not define a minimum quality score. Both use the same frozen judgments, and all required exact ID, source-freshness and original-locator correctness gates passed. No judgments or labels were altered for better metrics.

## Acceptance boundaries

This is a bounded lexical index prototype (512 sources, 64 KiB/source, 16 MiB generation). It does not validate large real Vault behavior, a hard memory sandbox for the tested browser Web Worker, all CommonMark/YAML, full UI lifecycle or privacy under a user's independent whole-home sync. Host smoke is a real Obsidian application interaction on a disposable synthetic Vault; Node mocks are not represented as host tests. The index can contain original excerpts and Properties, so it is **host-private outside Vault** by ADR-0008. Neither corpus nor results contain private production notes, indices or host paths. Python is needed only for historical reference/conformance tests, not for Standalone execution.

**Release status:** OKS-04A is the merged dependency. OKS-04B has completed local checks and actual Obsidian 1.15.1 extended host smoke (including disabled-only derived-index purge); it remains a candidate pending independent exact-final-diff review and hosted exact-HEAD CI. ADR-0008 now records acceptance anchored to the independently reviewed and merged PR #11. No UI release or MVP acceptance is implied.
