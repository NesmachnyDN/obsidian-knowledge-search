# OKS-06 P0.2 — minimum operation ownership implementation evidence

Status: author implementation candidate; independent exact-HEAD full-diff review required. Not a review, merge authorization, runtime acceptance, B-07 closure, or P0.3 activation.

## Authority and scope

Accepted develop: `77ed64ca5ff3f482264ffc4cdb90dd074b785665` (#158 merged). Historical #155 remains open Draft at `8d96c7b12f393b40e5a9b9a17cea4f8ffe2f8452`, tree `72be2a39d84dd7c2a215992c56c65c12ec61ecc8`. [Design acceptance](https://github.com/NesmachnyDN/obsidian-knowledge-search/pull/158#issuecomment-7241822624), [negative historical review](https://github.com/NesmachnyDN/obsidian-knowledge-search/pull/155#issuecomment-7232460113), [positive historical review](https://github.com/NesmachnyDN/obsidian-knowledge-search/pull/155#issuecomment-7233606836). #154 is merged at `7994fdd47f976ebb3364f0458cd59c24b556479b`.

[ADR-0024](../adr/0024-search-first-minimum-complexity.md), [ADR-0025](../adr/0025-search-first-delivery-and-ownership.md), [ADR-0026](../adr/0026-minimum-operation-ownership.md), [P0.2 execution contract](../prompts/OKS-06-P0-OWNERSHIP-SIMPLIFICATION.md), SPEC CAP-01/04/06/07/08/09/10/11/14/17/18 and AC-11-CHAT-02/03, AC-11-POLICY-02/03; applicable HARD-SCOPE, chat and policy contracts. Actual role/format/platform acceptance remains independent. HARD-SCOPE-6 is consulted as historical evidence, not adopted wholesale as a new normative contract.

Selectively adapted the historical controller/ChatView and four test files from #155 after examining the production diff. No merge/cherry-pick of its branch or contract. Runtime delta limited to `plugin/src/search/controller.ts` and `plugin/src/search/chat-view.ts`; the latter observes source identity without granting operation admission. Related tests use synthetic originals, controlled callbacks, actual built synthetic worker and loopback fixtures, never real providers or credentials. No engine, host/main, reader, Dense, Advanced, dependency, schema, transport, knowledge-management state, or native activation change. No source/Vault writes. All nine ADR-0024 principles and ADR-0025 sequence remain applicable; this slice delivers necessary safe search availability and teardown, not a document-format, provider, or native integration claim.

## Architecture comparison (same controller contour)

Count method: count each distinct concrete pin success/release branch, failure retention branch and caller-specific terminal discard branch, not every reference to the obligation list or every async operation slot. Report transfer producers and admission/retry decisions separately because their invariants differ. Source callback terminal skip is not concrete cancellation success. Counts below are code-derived, not a formal reachable-state proof.

| Mechanism | Develop | Historical #155 | P0.2 |
| --- | ---: | ---: | ---: |
| Concrete success release sites | 2 | 1 | 1 |
| Concrete callback failure retention sites | 2 | 1 | 1 |
| Caller-specific terminal concrete discard sites | 1 | 2 | 0 |
| Sum of pin outcome / caller discard decision sites | 5 | 4 | 2 |
| Duplicate successful cleanup paths beyond one | 1 | 0 | 0 |
| Concrete transfer producers (Graph, scoped, policy preparation, shared active role, direct role) | 5 | 5 | 5 |
| Concrete registration boundary | 1 | 1 | 1 |
| Source callback terminal skip/filter | 1 | 1 | 1 |
| Concrete capacity admission call sites | 0 | 5 | 5 |
| Explicit concrete retry routes (role / rebuild / actual dispose) | 3 | 3 | 3 |
| Proven-independent optional-to-Basic fault edges (active evidence and policy preparation, for each of two roles in a shared wave) | 4 | 4 | 0 |
| Conservative Graph/scoped-to-Basic failed cancellation edges | 2 | 2 | 2 |
| Existing retirement obligations collection | 1 | 1 | 1 |
| Additional persistent ownership registries, queues or authorities introduced by this slice | 0 | 0 | 0 |
| SearchController LOC (wc -l) | 2142 | 2317 | 2316 |
| ChatView LOC | 309 | 314 | 314 |

Develop success/retention is split across drainRetirements and retireRoleAbort; drainRetirements clears all obligations at disposed. Historical executeRetirement consolidates success/retention, but two caller filters discard failed pins at logical seal. P0.2 removes both filters; executeRetirement alone decides exact success removal or retained failure. Terminal disposal separately skips source callbacks. Registration remains in enqueueRetirement: duplicate exact owner (including aliases) cannot be transferred twice; historical admission counts live slots plus detached pins and preserves an already-owned transfer on defensive overflow. The Set is derived on demand, not a new lifetime registry. Source callbacks have their separate 4096 budget; eight unique concrete owners (including detached and final failed) have the existing bound, with fail-closed defensive overflow. The existing bounded wave allows an initial and eligible terminal retry; source callback category remains distinct.

Other unchanged physical/lifetime owners: Basic one active/one latest pending request; Graph slot; scoped/retained turn and physicalReads; generation/reranking active slots and prepared aliases; policy preparation and GenerationPolicyGate physical drain; GenerationCredentialAuthority exclusive claim; engine reader/parser/immutable generation, localRead/localSettlement and storage publication; Dense/Advanced process/storage; SourceNavigator. Existing bounded sessions and history are not new authorities. Existing host target/hook fault, observer waves, source drains, shared reset depth and revision ownership stay distinct. The historical passive source seal and shared publication reservation are necessary for B-01/B-02/B-03/B-05; no new state flag or slot relative to #155. A terminal failed pin uses existing attempted/running/failed plus terminalRetired; its extra diagnostic is an outcome, not a new authority. The additional shared-optional recovery predicate is derived and preserves explicit rebuild without making Basic depend on it. Relative to develop, retained historical protections add LOC and five capacity admission calls; complexity improvement is specifically fewer independent outcome decisions and unsupported fault edges, not a claim of overall LOC reduction or a smaller total controller state space.

## Failure domain and terminal implementation

- Shared-wave origin (`kind`) retains the existing retry route; exact evidence/policy owner role (`role`) denotes the proven optional failure domain. A shared active-role transfer now carries the same role as direct cancellation or policy preparation. Role fence covers both direct and shared pins; Basic admission no longer observes an optional role pin as a shared authority fault. Existing explicit rebuild recovers shared-wave pins and reports failure if recovery fails without latching independent Basic.
- Actual source/host/configuration loss, shared source drains, overflow, unproved Graph/scoped cancellation, and composite host hook remain fail-closed. In particular main's existing hook revokes lexical SourceNavigator authority as well as Dense; it is not an optional-only fault. Basic still joins the existing synchronous publication reservation; failed optional cancellation does not make the synchronous cut optional.
- Logical seal never filters concrete pins and stops new attempts until actual dispose. At the first actual disposal cut, non-running registered owners become eligible for one initial or terminal retry; running owners return without a second attempt. On success remove the exact pin only. On final failure retain it and emit exactly one stable `SEARCH_TERMINAL_RETIREMENT_FAILED` reason, separately from ordinary attempt failure and terminal observer delivery. Repeated disposal and late resolution/rejection do not retry or remove final failed pins. The sealed UI status is closed/idle, not proof of cleanup; the final failure diagnostic is distinct. The controller does not confer physical handoff. Underlying resource owners still govern physical drain/reload.
- Direct role retirement and shared drain use the same executor. Shared publication still uses reserveRetirementPublication / completeRetirementPublication and waits for executing synchronous owners, not unrelated async promises. Source retirement and passive identity are separate from ordinary Basic revision. No implicit retry of failed optional owner from Basic.

### Exact conservative Graph/scoped fence and bounded follow-up

Graph and scoped pins have no evidence role. A failed abort cannot prove their underlying lease stopped; the controller clears Graph lease/result on logical revoke and has no physical Graph settlement acknowledgment in its Engine port. StandaloneEngine.captureGraphOperation owns localRead/localSettlement and parser/catalog verification, updates graphCache/verifiedAt, and calls the same lexical search/reconcile path. Scoped lease capture/search/verify uses the same generation, provider membership/original reads and lexical search; retained citation navigation uses a host navigator and an exact scoped physicalReads claim. The port does not expose a proof that a failed cancellation has no pending shared generation/reconciliation/navigation effects. Basic does not itself need an optional Graph/scoped slot; the fence is conservative uncertainty about current shared authority/resources, not proof that all physical Graph/scoped reads conflict.

Owner: exact role-less concrete pin and existing engine/lease/navigation slot. Invariant: no new affected Basic/source or optional admission while failed retirement leaves shared currency unproved. Predicate: explicitRetirementPending includes failed/unsettled role-less obligations; resetSharedState denies a reserved Basic when such an obligation remains after the synchronous cut. Release: exact successful explicit rebuild retirement plus successful existing shared hook and current source/engine checks. Scoped physical slot remains until its own settlement, even after pin success; engine retains its local physical slot. Existing `06H.2-A2b1: failed physical abort latches existing retirement fault until explicit rebuild` remains unchanged, paired with `basic search supersedes chat immediately, drain does not block offline search`. New paired Graph/scoped controls distinguish successful cancellation with held physical work from failed cancellation and recovery; final failed Graph/scoped pins survive late physical rejection. Existing shared navigation/host failure and real engine resource regressions remain intact. These controls are synthetic; they do not prove the actual host's every reachable failed lease independent.

**P0.3-GS-01 (acceptance item, not commenced):** before any unrestricted Graph/scoped Basic-independence or native host capability claim, replay actual engine and SourceNavigator read/settlement paths with a held shared read/reconcile/navigation owner and a proven independent current-source read, failures before/after signal, exact owner replacement denial, freshness and physical release/handoff. Prove the exact remaining resource conflict or narrow this conservative fence via a separately reviewed bounded contract; no engine/host edits are authorized here.

## Historical and normative trace

The original five reviewer sources match the SHA-256 values in ADR-0026. Fresh historical archive at exact HEAD/tree: six B-07 failures and two nested-actual-dispose controls pass; later six independent cases pass with the actual built synthetic worker. Rebuilt unchanged sources against the P0.2 production candidate: 8/8 and 6/6 PASS. The original reviewer source files remain local; permanent tests reuse their fixture/transitions and strengthen exact retained/released-pin assertions, plus independently admitted generation and final-failed cases. These are author replay results, not independent review of the new HEAD.

| Contract | Evidence |
| --- | --- |
| O1 | Original Graph/scoped and admitted reranking direct/shared before/after-signal negative controls reproduced, all six now GREEN. Exact retained pin and eligible retry assertions in permanent terminal and admitted-role tests. |
| O2 | Two original positive controls and six later probes GREEN; actual built worker for policy alias transfer, same owner in preview and active slot, counted once and released at settlement. New actual admitted generation direct/shared before/after-signal coverage; not historical B-07 evidence. |
| O3 | B-01 source-revision-seal (source promotion, nested source drains, passive numeric/identity); B-02 terminal-retirement-publication; B-03 source-revision-seal and host lifecycle/ChatView retained selection; B-04 capacity/alias/detached tests; B-05 completion protocol Graph/navigation/scoped permutations; B-06 deferred actual reranking; B-07 O1/O2/O4/O5. #154 engine guards untouched, full regression incl current original/worker/physical slot/deadline. |
| O4 | Permanent terminal publication and role tests assert ordinary/explicit/supersession/settings/source and nested terminal vs seal-only transitions; terminal initial, eligible retry, running return and successful exact pin release, separate physical slot and order. |
| O5 | Admitted role terminal matrix: success/failure of retry, running failure and initial failure, before/after signal; exact final failed pin retained, diagnostic once, hook/observer once, no extra attempts on reentry/repeated dispose, no late revival. Graph/scoped final failed late physical rejection; existing failed shared hook and lifecycle physical close/reload tests retained. |
| O6 | 4096 source, eight unique concrete owner budget, dedup/alias transfer, detached owners, terminal-failed owners included, defensive overflow, no new registry. Synthetic saturation/overflow tests are boundary controls, not a claim of artificial production reachability. |
| O7 | LIFE-17 parameterized actual host-adapter admitted generation/reranking shared/ordinary Basic before/after signal; role-local tests both roles before/after; real worker policy preparation tests both roles and all three cancellation routes, current Basic original hits, zero provider dispatch, retained pin and policy/parser busy, no implicit retry. Paired source/host/physical/overflow denial and Graph/scoped conservative tests. P0.3-GS-01 remains a scoped limitation. |
| O8 | Existing hard-scope, descriptor/source identity/freshness, consent, exact credential/physical exclusivity, policy eligibility, provider admission and original deadline/cancellation precedence remain authoritative. No production changes outside controller/ChatView; existing negative tests retained, new policy preparation confirms independent Basic and no forbidden dispatch. |
| O9 | See mechanical validation below and actual remote CI on the Draft PR. |

LIFE-17 assertion reconciliation: old `sharedAuthorityTransition() === true`, `snapshot().phase === 'error'`, `status().status === 'failed'`, failed Basic search after failed shared optional abort; new `sharedAuthorityTransition() === false`, idle after explicit shared reset (successful result after Basic supersession), ready status, verified successful current lexical hit. Normative basis ADR-0026 B-158-01 and SECURITY.md: optional-only failure cannot permanently own shared authority. Paired controls preserve both sibling abort attempts, exact failed pin before/after signal, invalidated previews, affected role denial, zero HTTP, first explicit failed recovery, exact retry and final success. Direct role cases strengthened, not weakened. No assertion changes to 06H.2 failed scoped abort or other historical security invariants. First full candidate run identified the existing terminal UI closed-snapshot assertion (B-R2-LIFE-14); fixed production status presentation while retaining pins, not the historical assertion. Subsequent full regression passed; extra paired and late-rejection tests also passed.

## Mechanical validation

| Command / check | Observed result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | 1311 PASS / 4 SKIP / 0 FAIL (1315) |
| `npm run test:python` | 137 PASS / 5 SKIP / 0 FAIL (142) |
| `npm run licenses` | PASS |
| `npm run build` | PASS |
| `npm run test:package` | 17/17 PASS, deterministic/idempotent package check included |
| `node scripts/standalone-package.mjs verify` | PASS |
| `npm audit --package-lock-only --audit-level=high` | PASS, 0 vulnerabilities reported |
| `node --test tests/ci-pr-contract.test.mjs` | 5/5 PASS |
| Original independent fixture replay, historical / candidate | 2 PASS + 6 FAIL / 8 PASS; later 6 PASS / 6 PASS |
| Focused candidate regression | 63/63 PASS, plus eight later paired/late-rejection tests 8/8; overlap full suite |
| Diff and configured disclosure guard | Required before push; actual guard/CI status in PR handoff |

Fresh build and tests on candidate sources with Node 22.23.2 / Python 3.12.3, reusing installed dependencies from the identical lockfile; clean install is a separate CI check, not claimed locally. Original replay used esbuild with Node22 CJS bundles, node --test --test-concurrency=1, original review test-name selection and a rebuilt worker. Full suite skips are inherited conditional real Docling/model/cgroup/environment tests, not passes. Native integration, actual provider traffic, production Vault, platform/format claims and full phase/operational acceptance are outside this bounded slice. Applicable normative sections were consulted; this is not an exhaustive audit of every unrelated historical policy/format contract. No independent review by this author; do not close B-07 or change #155. Exact committed head and remote checks are recorded in the PR.
