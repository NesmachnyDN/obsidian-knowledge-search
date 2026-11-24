# OKS-06A-H — synthetic reranker benchmark harness

Status: implementation candidate; independent SDD review pending. Contract: [OKS-06A](../../docs/prompts/OKS-06A.md), 06A-P merged at e964bd3975dfeca2fad4b9f7d20124fe3b33450d. Scope: H only (AC-01/06/07/09/10/11 partial). No production code or dependency changes. No Gate B-Rerank acceptance.

## Corpus and freeze

Corpus v2 contains 80 invented Markdown notes: 20 architecture families with accepted, rejected and review/operational notes, plus 20 cross-domain technical distractors. The 120 queries remain split by family (30 tuning/90 held-out), including 15 held-out exact-ID and 15 unanswerable queries. Categories: exact identifier, design decision, requirement, table value, typed Property intersection, negative. English, Russian and mixed technical wording. Grade 2 denotes direct normative or directly answering evidence; grade 1 corroborates or supports but is not the authoritative answer; grade 0 denotes irrelevant evidence (including references that merely repeat a requirement ID). Unlisted spans are nonrelevant. Sources, request inputs and judgments are separate files. Retrieval/provider code never receives judgments. Labels require independent review before any held-out model execution.

The initial H candidate (c536fe3f28984a00562b5728537cf3c200b3a3be) had no full Top-50 held-out query, all held-out exact IDs were singletons, and Properties/line positions were overly homogeneous. In response to independent review B-CORPUS-01, before any real model execution, v2 adds domain-specific review evidence, explicit rejected/traceability collisions, more diverse layouts and natural RU/EN question formulations, and five typed Property forms (boolean, number, list contains, date and string, some combined with domain). Relevance grades are re-judged by semantic content and authority, not physical line template; review observations can corroborate but are not normative. Model-free candidate-count preflight verified list syntax and that slash/hyphen token semantics did not unintentionally make answerable queries empty. No real-model scores, outputs or acceptance margins were used or changed. Prior H v1 is recoverable from its original Git commit; historical benchmarks/corpus/v1 is unchanged.

- Corpus manifest SHA-256: `f912dcbe66fc85bd86fc2c20ea296fe275fc9749928e1412e3f604c8a7fd2b08`
- Candidate manifest SHA-256: `86a3cc7bc9f6a0d272a568ab320bfae8fbbf1fa94b552f8d7a58c6e5f1e751a6`

All four artifact digests, including candidate JSONL, are pinned in the single v2 manifest snapshot. To address B-SEC-01/02, all reads use an anchored Linux descriptor walk, O_NOFOLLOW/O_NONBLOCK, regular single-link fstat checks, actual 2 MiB read cap, pre/post identity and timestamp checks and digest verification. Manifest/judgment digests are retained from the initial read rather than reopening the manifest after the trials. Test-only paths use the same reader. Negative tests cover symlinks (including ancestors), directory, FIFO, hard link, oversized input, growth during read, replacement and digest mismatch. This mitigates the concrete race without alert suppression; the committed corpus/manifest remains the trusted review input, not an authenticated external dataset.

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
| Frozen candidate capture and independent limit=20 parity | 120/120, 587 unique spans |
| Candidate coverage | 75 queries >=20, 30 full 50; held-out 56 >=20, 24 full 50 (22 answerable); one empty; no padding |
| Fixture | 60 successful authenticated operations, 12 no-candidate outcomes, no model calls |
| TypeScript typecheck | PASS |
| Node regression | 327 PASS / 4 SKIP / 0 FAIL |
| Python regression | 133 PASS / 5 SKIP / 0 FAIL |
| License verification, production build and package | PASS; package 17 PASS |
| Historical standalone benchmark | PASS; tracked historical result restored unchanged |

Author lexical baseline (positive queries only, K=10, both N=20 and 50):

| Split | nDCG | MRR | Recall | Precision | Exact direct hits |
|---|---:|---:|---:|---:|---:|
| Tuning | 0.8847 | 0.9333 | 0.9000 | 0.1400 | 5/5 |
| Held-out | 0.7874 | 0.8514 | 0.8602 | 0.1440 | 15/15 |

Held-out candidate recall ceiling: 0.9158 at N=20 and 0.9433 at N=50. All 15 held-out exact-ID queries now have competing candidates (nine with 4, six with 13); the latter can actually lose a direct hit at K=10. All 20 typed-Property cases have candidates. These are model-free author measurements, not model acceptance. Coverage assertions protect the new frozen corpus from regression; they are not new model-selection margins. Remaining limitations: compact synthetic documents, correlated query families, common author, heterogeneous but still constructed layouts, nine exact-ID lists shorter than K=10, no population-level representativeness. Neither the independent corpus adequacy review nor model acceptance is self-certified. Node/Python optional integration skips are not evidence of model support.

## Remaining gates

- H independent full-diff review, including independent corpus judgments, freeze/replay, metrics, fixture-only boundary and exact-HEAD CI/CodeQL before merge.
- R independently review and implement only evidenced runtime gaps; enforce preview expiry, real pair-token/context, profile identity, resource and privacy checks. Do not use the fixture grant construction as machine self-authorization.
- E needs both actual approved model revisions and authorized API endpoints, pinned tokenizer/template/no-truncation behavior, real-model runner authorization, full fixed trial schedule, API-duration/usage/cost/resource measurement, cold/warm and per-language/category results, controlled failure and paired-only sensitivity, real host proof. Current fixture API duration/tokens/cost are null, not zero; never treat fixture scores/latency as model evidence. Real-model and incumbent evidence are absent.
- X and B-Rerank remain blocked. Gate A and production deployment are unchanged. No real Obsidian smoke was rerun for H (no shipped code, UI, or package-input changes); real host/provider acceptance remains required at applicable R/E/X gates.

No credentials, private source material, raw real-provider data, or real-Vault access. No runtime changes, cloud, downloads or heavy inference.
