# ADR-0026 — Minimum operation ownership and completion

Status: Proposed; independent DOCS_ONLY acceptance required. Authority: ADR-0023–0025, SPEC, SECURITY, SDD and [P0.1 contract](../prompts/OKS-06-P0-OWNERSHIP-DESIGN.md). No runtime acceptance or implementation authorization.

## Evidence and decision

Normative baseline: 4d58a923bf59df9dff6eacbd5debb9bf86219def (#157 merged). #155 is an unchanged Draft at 8d96c7b12f393b40e5a9b9a17cea4f8ffe2f8452, tree 72be2a39d84dd7c2a215992c56c65c12ec61ecc8, original base 7994fdd47f976ebb3364f0458cd59c24b556479b. The candidate adds HARD-SCOPE-6, controller/ChatView changes and four test files; it is not the merged runtime.

**B-07: CONFIRMED OPEN.** Original [negative review](https://github.com/NesmachnyDN/obsidian-knowledge-search/pull/155#issuecomment-7232460113) and [later positive review](https://github.com/NesmachnyDN/obsidian-knowledge-search/pull/155#issuecomment-7233606836) concern the same tree. Both sets of original reviewer source files were located and rebuilt against a fresh git archive of that HEAD, using existing dependencies and synthetic fixtures. Results:

| Original probe | Outcome |
| --- | --- |
| Graph and scoped cancellation: failed abort during seal-only, subsequent dispose | 2 FAIL |
| Admitted reranking, direct/shared, exception before/after abort signal | 4 FAIL |
| Nested actual disposal controls from negative reviewer | 2 PASS |
| Later review completion, role completion and policy alias transfer | 6 PASS |

The policy-transfer fixture initially lacked the built Markdown worker; after building the worker from the same tree, its unchanged test passed. The six failures retain no failed pin, attempt abort only once instead of twice, and deliver terminal hook/observer on later dispose without the required retry. Before-signal cases remain un-aborted; after-signal cases recorded one native abort. Reranking fixtures recorded zero outbound dispatches. Positive cases exercise different transitions, not the failed seal-only interval. This is completion-accounting evidence, not proof of unauthorized disclosure. No new blocker or closure of #155.

Reviewer artifacts retained locally; sanitized identifiers (SHA-256 of source, not a claim that the artifacts are published):

| Source basename | SHA-256 |
| --- | --- |
| reviewer-role-seal.ts | 53bb2e31fe8b9c3c431b9459960f76e0bde143c60cd2b1fc301574e68371afaf |
| reviewer-completion-probe.ts | 45ba7b9272967dbc5c2bd78c05d5c170480b984c5846e4b5655b85270b3d0686 |
| reviewer-completion-20261128.ts | d498329326b50358c0afa2a1b63b26be2f8b9b64fa9a97e5cec9b4ff2030f435 |
| reviewer-role-completion-20261128.ts | 08941dd7a5c575d5940ccbc061904a63190167d9732b6e51cb844efe9cc992d7 |
| reviewer-policy-transfer-20261128.ts | 6e45a4f820ee1bdd158895cacc68188f4e76730bf05f6b2b359f246d11c6be06 |

Cause at candidate controller.ts:639–686 and 2012–2044: the common executor keeps a failed obligation, but its callers discard non-running obligations when disposed is true. sealTerminal (2260–2278) sets disposed before dispose (2279 onward) sets terminalRetired and starts physical teardown. main.ts:1017 onward deliberately seals sibling authorities before cleanup. Thus a legitimate intermediate state loses a concrete owner. A successful hook, observer notification, or async result is not proof of that owner's completion. Keep the seal/dispose separation.

Alternatives:
- A: keep the current bounded protocol and add local cases. Low immediate change, but repeated completion paths and contradictory terminal cleanup rules remain.
- B (recommended): decompose responsibilities inside the existing controller. One local concrete-retirement outcome rule and one shared publication cut; independent operation slots stay with their owners. Moderate migration and regression cost, no new authority. Demonstrate simplification rather than merely renaming flags.
- C: replace the bounded controller contour. Higher migration risk, including accepted reentry and publication contracts. Not justified without proof B cannot meet the requirements. No whole-product rewrite.

## Existing and intended ownership

References below are relative to plugin/src at the pinned candidate; components outside the #155 diff are also present on its original base. The current develop includes accepted #154 engine guards. The passive host source seal and ChatView observation distinction are candidate mechanisms, not accepted runtime changes.

| Mechanism / code anchor | Responsibility and essential state | Disposition / requirement |
| --- | --- | --- |
| standalone/source.ts:76 onward, BoundedVaultReader | Authenticated root and descriptor-based originals, exact identity/hash, captured scope; openWithScope checks revocation including settlement | Keep; CAP-01/06/08/10. Removing it permits unverifiable or excluded evidence. |
| search/native-exclusions.ts:42 onward; standalone/hard-search-scope.ts | Version-pinned native matcher, config identity and irrevocable lease, event and missed-change checks | Keep inactive; CAP-01, AC-01, #149. No parallel matcher/settings; unknown denies. |
| standalone/engine.ts:52 onward, scopeCurrent, evaluateProcessingPolicy, captureGraphOperation, captureDenseCorpus, captureChatScope | Owns lexical generation, parser/reconcile and local read/settlement slots; source lease, pre/post publication checks, physical drain | Keep; CAP-01/06/08/09/10. No controller ownership of engine parser or generation. |
| search/controller.ts:152–285, 750–768, pump | Latest Basic reservation, request revision and source revision are distinct; candidate passive source seal is callback-free | Retain accepted Basic semantics and adopt candidate seal after review; AC-01/06/08/09/10. Observation is not admission. |
| controller.ts:769 onward, engine.ts:500 onward, graph mapping/projection | Graph operation and local lease, presentation separate from lexical/AI results | Keep optional, current and bounded; ADR-0020; CAP-06/09/10. No new graph engine. |
| controller.ts:886 onward, 1520 onward; search/chat-view.ts | Scoped turn, session and retained history, exact scope/generation/config; independent reads and navigation | Keep current limits and active-turn supersession; ADR-0018, AC-11-CHAT-03. Compatible completed selection/history survives ordinary Basic. |
| ai/dense-authority.ts, dense-machine.ts, dense-host.ts:41–163 | Dense UI/machine fences, attempt/preview, credential exclusivity, physical storage/close | Keep independent; CAP-07/09/10 and conditional AI gates. Shared host retirement coordinates, never owns these slots. |
| advanced/manager.ts:31 onward, retrieval-manager.ts:19 onward | Own process, store, path-specific invalidation, stop and drain | Keep separate; CAP-02/06/08/09/10/17, Gate C. Retain Advanced/Dense exclusion until shared-generation/authority coexistence proof. |
| ai/generation-policy-host.ts, processing-policy.ts, effective-policy.ts | Eligibility evaluation with exact source proof and role/config/owner binding; engine owns parser drain | Keep current effective and legacy safe paths; ADR-0019/0023, AC-11-POLICY-02/03. No marking or enrollment dependency in effective mode. Legacy removal separately reviewed. |
| ai/disclosure.ts, rerank-confirm.ts, role-specific evidence/transport | Exact consent/grant, payload and provider admission; eligibility alone cannot authorize | Keep; CAP-04/07/09/10/11/14, applicable Gate B. No provider grant from source seal. |
| ai/generation-credential.ts:14 onward | Shared exact owner/epoch/host/config, ephemeral secret and exclusive physical claim | Keep; role/profile security. Revoke secret immediately, release exclusive slot only after actual drain. |
| ai/active-deadline.ts:6 onward | Immutable bound context, elapsed budget, terminal reason | Keep; CAP-09/10. No new clock, renewal or reason overwrite. |
| controller.ts:380–552, 639–745, 2012–2044, 2260 onward | Mixed revocation, synchronous owner pins, shared hook reservations, observer delivery | Target B: consolidate pin outcome/cleanup in one bounded location, keep publication reservation independent of pins and notifications. |
| main.ts:145–220, 300–325, 821–927, 1017 onward | Source event/settings coordination; actual reader still opened without native lease; concrete storage barriers and terminal sibling seal | Keep unchanged in P0.2; later P0.3 wiring and acceptance. |

Essential shared fences: source/settings/host loss, teardown, exact credential/parser exclusivity, incompatible index generations, existing Basic supersession and actual storage conflicts. Independent role-only cancellation/failure, Graph display and scoped-turn lifetime are not global source-identity changes. Preserve existing compatibility and admission policy until a specific safe relaxation is independently demonstrated. Reuse existing reader, Markdown/Properties/lexical retrieval, index persistence, evidence and freshness mechanisms; no new knowledge-management state.

## Minimal state and transitions

The following are conceptual state axes, not a proposal for a new enum per axis, registry, queue or framework. Reuse existing slots, revisions, passive seal, obligation list, source drains, shared publication reservation and exact owner identity. Distinguish source identity (root, original identity/hash) from authority (current revision and valid scope), admission (reserve before effects), ownership (the reserved slot), logical revocation, concrete cancellation attempt, physical async completion, provider authorization and observer delivery.

| Owner / state | Event and transition | Required action / release |
| --- | --- | --- |
| Source seal: current -> retired | Source/config/host authority loss | Retire before callbacks; old seal never revives. Ordinary Basic revision alone does not retire it. Capture only after shared gate settled. |
| Operation slot: empty -> admitted | Validate input, check authority and capacity, reserve before effectful dispatch | Exact owner only; nested conflicting admission rejects or follows existing Basic latest reservation. Recheck after effectful ports. |
| Logical right: live -> revoked | Cancel, supersede, deadline, source loss, terminal seal | Clear visible rights/consent before callbacks; preserve exact terminal reason. No revival or stale publish. |
| Concrete pin: pending -> running -> succeeded / failed | Existing executor invokes registered owner | Success releases that pin; failure retains the exact pin for applicable existing retry. Running is not releasable by nested calls. |
| Failed pin -> running | Explicit eligible retry or actual terminal disposal | Preserve existing retry budgets and role-local independence; never retry concurrently. Failure after permitted final attempt remains explicit terminal cleanup failure; no admission/owner replacement. |
| Physical work: in flight -> settled | Actual resolve/reject and required local drain | Owner releases its own slot once; neither promise completion nor abort signal alone proves another pin succeeded. |
| Host: active -> sealed -> teardown requested | Callback-free logical seal, then actual dispose | Seal all siblings first. Seal alone cannot consume pins or publish terminal snapshot. Dispose reserves terminal publication and attempts eligible pins, including failures from seal-only interval. |
| Shared publication: absent -> reserved -> hook owned -> delivered | Shared reset/source change or actual dispose | Outermost synchronous owner completes one hook cut after eligible synchronous attempts return; hook exception preserves fail-closed state; nested requests join existing reservation. Terminal delivery occurs at most once. |
| Evidence notification: pending -> delivered/superseded | Role-local committed state | No ownership release or grant; preserve notification bounds/quarantine and revision checking. |

Logical revocation and physical settlement are independent. If an abort throws before or after changing its signal, its failed pin must not be lost at seal-only, late resolve/reject, or an unrelated role transition. A successful async result must not clear that pin. At actual dispose retry a failed non-running pin once as allowed by HARD-SCOPE-6. An owner already running when dispose reenters must return first; do not recursively retry it. Preserve the existing bounded terminal retry policy for previously failed, non-running owners; no new retry loop for owners failing during terminal teardown. Final failure cannot be reported as successful cleanup; any resource handoff still requires its own existing physical barrier. Do not equate synchronous cancellation callback completion with async drain. Terminal notifications need not await unrelated physical promises, but those promises must not reopen authority.

Synchronous reentry: logical state and exact reservation commit before any user/host/abort callback; nested shared changes cannot replace a pinned target or publish out of order. An observer can request work but cannot authorize or release a prior operation. Preserve latest-Basic queuing and existing lifecycle admission fences. Capture effectful accessor results before the last local check; no additional effectful port between the final check and settlement. Exceptional and late settlements use existing source/host/revision/deadline guards and exact owner identity, never a new timeout budget. Keep accepted #154 policy/preview physical and logical slots and all their post-await guards unchanged.

## Keep / move / remove

| Action | Mechanisms and rationale |
| --- | --- |
| Keep | Existing owner slots, source obligations/drains, 4096 source bound, eight unique concrete owner budget, deduplication of aliases, one initial attempt plus eligible terminal retry; existing role-specific retries, fail-closed overflow, shared hook and observer bounds. Capacity protects retained owners, not a reason to add another registry. |
| Keep | Passive source seal, strict admission and observational identity, engine/reader source guards, immutable generations, provider/consent/credential/deadline contracts, navigation revalidation and independent role/format acceptance. |
| Move | Pin outcome and release decisions from caller-specific drain and role cleanup into one cohesive controller-local retirement ownership rule; keep execution and result publication separate. Source callbacks retain their existing bounded category and terminal skip semantics; never treat source-event callbacks as concrete abort pins. |
| Remove | Duplicate caller-specific terminal pin filtering that equates sealed with teardown complete; any equivalent redundant cleanup branch only after equivalent tests. Do not delete protective checks or observer fences. |
| Defer | Simplification of native wiring, legacy marking lifecycle, Advanced/Dense coexistence and wider cross-role admission. Each needs its own traceable proof; no parallel search engine or generic operations framework. |

No additional runtime states, owners, queues or registries are necessary for the proposed slice. Existing flags may be consolidated only if the transition and retry matrix is preserved. No numerical complexity reduction is asserted; implementation review must compare before/after ownership decisions and explain any net additions.

## Security invariant matrix

| Invariant | Authority / verification |
| --- | --- |
| Read-only, hard scope, no source writes | Existing native lease/reader/engine; deny excluded/unknown at all boundaries; no main activation or marking writes. CAP-01/10. |
| Freshness, provenance, no stale evidence | Descriptor-bound original and hash, generation and captured scope, source seal and exact operation; verify on read, async settlement, publication/navigation. CAP-06/08/10. |
| Fail-closed admission and bounded resources | Existing shared gates, per-owner physical claims, capacity and overflow; no new slot until exact predecessor releases. CAP-09/10. |
| Role isolation and confidentiality | Existing policy, corpus eligibility, profile admission, payload/consent, independent role fences; zero unauthorized requests; Basic stays autonomous. CAP-04/07/10/11/14/18. |
| Credential and deadline | Owner/epoch/secret and original bound context; revoke immediately, retain actual physical exclusivity, preserve typed cancellation/timeout. |
| Cancellation and completion | Exact pin persists across failures and seal-only; bounded retry, no concurrent abort attempts; no observer-driven release. |
| Publication and terminal teardown | Sibling logical seals before callbacks; final current check then publish; hook/observer order and no late resurrection; async storage barriers remain with real owners. |

All existing CAP/AC and Gates A/B/C, including conditional profile/platform gates, remain authoritative. P0.2 does not establish native integration, provider admission, unified attachment retrieval or runtime acceptance.

## Migration and next gate

Use a fresh branch on then-current accepted develop. Keep #155 unchanged; selectively adapt its passive seal, necessary observational distinction and regression coverage, not assume its acceptance or blindly merge its changes. Limit production changes to the existing controller and, only if required for the existing observational contract, ChatView. Risks: dropped failed owners, alias double-counting, premature credential/worker release, history loss, observer reentry, cross-role starvation, old generation visibility. Mitigate by exact-owner checks, before/after negative and positive controls and unchanged external interfaces. No main/engine/reader/Dense/Advanced edits, activation, schema, dependencies, storage or provider changes in this slice. If the boundary cannot be maintained, stop for a revised design rather than broaden scope.

The [bounded implementation candidate contract](../prompts/OKS-06-P0-OWNERSHIP-SIMPLIFICATION.md) defines mandatory tests and independent acceptance. No implementation until this design and its contract are independently accepted and delivered.
