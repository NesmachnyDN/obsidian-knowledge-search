# OKS-06A-H — synthetic reranker benchmark harness

Status: implementation candidate; independent SDD review pending. Contract: [OKS-06A](../../docs/prompts/OKS-06A.md), 06A-P merged at e964bd3975dfeca2fad4b9f7d20124fe3b33450d. Scope: H only (AC-01/06/07/09/10/11 partial). No production code or dependency changes. No Gate B-Rerank acceptance.

## Corpus and freeze

The JSONL source bundle contains 60 invented Markdown notes: 20 independent architecture families with an accepted and rejected alternative each, plus 20 unrelated technical distractor notes. 120 authored query/label pairs, split by whole family (5 tuning families/30 queries, 15 held-out families/90 queries), with 15 held-out exact-ID and 15 unanswerable queries. Categories: exact identifier, design decision, requirement, table value, typed Property intersection, negative. English, Russian and mixed technical wording. Direct evidence grade 2; supporting grade 1; absent grade 0. Sources, request inputs and judgments are separate files, with source-byte and file digests. Retrieval/provider code never receives judgments. The authored labels must be independently reviewed before any held-out model execution. These short synthetic notes do not constitute independent human labels or representative production traffic; queries within a family are correlated.

Before freeze, a model-free candidate-count preflight found no full Top-50 list. Twenty distractor notes were added to exercise broader retrieval and one negative query was made an unknown identifier to exercise no-call behavior. No model outputs or relevance scores were consulted for those changes. The final source/query/judgment files are frozen; do not modify them after seeing held-out scores. Historical corpus/v1 is unchanged.

- Corpus manifest SHA-256: `90d1fca4be775b6c08771289e1fb82519649b0d7663c1d79bb4513ffebbd568d`
- Candidate manifest SHA-256: `321c8bb3f936a3eefe592deac50927b211691858a913dda652c9ff5b71c0ece9`

The candidate manifest deduplicates immutable source spans by SHA-256 of source identity, source digest and complete locator. Each query records the exact input digest and ordered IDs (one-based position = original rank). Catalog entries retain source/excerpt digests and full original locator. Actual per-run generation identity is pinned in memory but excluded from the portable manifest because the isolated root identity changes across runs. Candidate manifest equality is byte-for-byte, not approximate. Labels are validated by exact source digest and physical line.

## Reproduce (no model, real Vault or external service)

From the repository root after the normal development dependency installation:

```sh
node scripts/rerank-benchmark.mjs --capture > /tmp/oks-06a-candidates-replay.jsonl
cmp benchmarks/rerank/corpus/candidates.jsonl /tmp/oks-06a-candidates-replay.jsonl
node scripts/rerank-benchmark.mjs --fixture > /tmp/oks-06a-fixture-report.json
npm run typecheck
npm test
```

Capture uses the real StandaloneEngine, existing production worker bundle and Node test Worker adapter in a disposable synthetic vault with private XDG index. Verify exact original UTF-8 spans, one current generation and separate limit=20 versus limit=50 equality. Verify unchanged ordered candidates again before every fixture operation. No candidate padding or silent truncation. All trials are bounded and sequential. The only HTTP endpoint is an ephemeral authenticated literal IPv4 loopback server created by the fixture itself; there is no endpoint/credential/config CLI, no external provider path, no model selection or paid service.

The fixture uses two deliberately non-model ranking profiles (original order and reversed order), six fixed tuning queries, both N=20 and N=50, three repetitions, deterministic seeded order. It exercises the actual EvidenceReranker/VerifiedEvidenceOperation/disclosure contract and exact request body, complete permutation, original evidence preservation and no-request empty input. Fixture metrics are diagnostic only. Reports include fixed-K span/document metrics, exact-ID hits, candidate recall ceiling, negatives, per-query deltas and deterministic paired query-ID bootstrap (seed 601, 10,000 resamples); do not infer population or simultaneous confidence from the per-profile intervals. Failed answerable fixture outcomes are scored as zero, and a candidate capture/replay integrity failure blocks the run rather than silently scoring changed candidates.

## Author validation

| Check | Result |
|---|---|
| Frozen candidate capture and independent limit=20 parity | 120/120, 275 unique spans |
| Candidate coverage | 42 queries >=20, one full 50, one empty; no padding |
| Fixture | 60 successful authenticated operations, 12 no-candidate outcomes, no model calls |
| TypeScript typecheck | PASS |
| Node regression | 326 PASS / 4 SKIP / 0 FAIL |
| Python regression | 133 PASS / 5 SKIP / 0 FAIL |
| License verification, production build and package | PASS; package 17 PASS |
| Historical standalone benchmark | PASS; tracked historical result restored unchanged |

Author lexical baseline (positive queries only, K=10, both N=20 and 50):

| Split | nDCG | MRR | Recall | Precision | Exact direct hits |
|---|---:|---:|---:|---:|---:|
| Tuning | 0.9134 | 0.9400 | 0.9600 | 0.1360 | 5/5 |
| Held-out | 0.8938 | 0.9086 | 0.9200 | 0.1253 | 15/15 |

Candidate recall ceiling held-out 0.98; negatives with lexical hits 4/5 tuning and 15/15 held-out. These are model-free author measurements, not reranker evaluation/acceptance. Only one full-50 query and correlated family labels limit inference about high-K workloads. No changes to relevance labels or acceptance margins after these scores. Node/Python optional integration skips are not evidence of real model support.

## Remaining gates

- H independent full-diff review, including independent corpus judgments, freeze/replay, metrics, fixture-only boundary and exact-HEAD CI/CodeQL before merge.
- R independently review and implement only evidenced runtime gaps; enforce preview expiry, real pair-token/context, profile identity, resource and privacy checks. Do not use the fixture grant construction as machine self-authorization.
- E needs both actual approved model revisions and authorized API endpoints, pinned tokenizer/template/no-truncation behavior, real-model runner authorization, full fixed trial schedule, API-duration/usage/cost/resource measurement, cold/warm and per-language/category results, controlled failure and paired-only sensitivity, real host proof. Current fixture API duration/tokens/cost are null, not zero; never treat fixture scores/latency as model evidence. Real-model and incumbent evidence are absent.
- X and B-Rerank remain blocked. Gate A and production deployment are unchanged. No real Obsidian smoke was rerun for H (no shipped code, UI, or package-input changes); real host/provider acceptance remains required at applicable R/E/X gates.

No credentials, private source material, raw real-provider data, or real-Vault access. No runtime changes, cloud, downloads or heavy inference.
