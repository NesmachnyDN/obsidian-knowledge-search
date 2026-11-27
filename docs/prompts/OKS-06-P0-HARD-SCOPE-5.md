# OKS-06 P0.2b4 — revocable standalone engine generation boundary

Base: ec8a5c1b5b0c05fbbd1b82805011dfd79e361422. Authority: AGENTS, SECURITY, SDD, SPEC CAP/AC-01/06/08/10, ROADMAP P0, ADR-0023, #149/#105, accepted hard-scope contracts 1–4. Standard bounded PHASE_RUN.

Reuse the source owner's captured revocable scope (including empty configuration). Fence restored generation admission, parser admission, pre-rename publication and post-rename visibility, status and lexical/Properties search, including zero-hit and exceptional paths. A retired owner never regains authority; discard old in-memory generation and graph cache, do not initiate subsequent parse/read work, and deny existing engine-owned chat/dense/graph/processing-policy leases at their current/settlement boundaries. Preserve historical immutable/unscoped behavior, ordinary cancellation and authenticated CURRENT recovery. An already submitted rename may complete; do not throw from the store's synchronous onPublished callback or falsely claim disk rollback. A new owner must authenticate and scope-check restored state. No storage format change, main activation, provider calls, source writes or capability claim.

Synthetic negative tests: empty scope retirement, excluded restored records, revocation during load/read/parse and before/during/after publication, zero hits, stale leases and no subsequent parser work. Existing ordinary lifecycle/recovery regression. Main-level synchronous all-owner retirement, activation, derived cleanup and all-route/real-host acceptance remain mandatory subsequent gates. Full applicable validation and independent exact-HEAD review before merge.

## Systemic remediation of B-04–B-06

Prior candidate: ca7561e303176dcff5b11d4f60f53ffad9fefc5f. Independent findings and negative probes are recorded in the PR. Owner observation is distinct from local cancellation, timeout, revision or one-shot admission: observe the existing source authority before local short-circuits, after each nested asynchronous settlement before processing, and at physical drain even if the operation already denied outwardly. Keep the existing irreversible scopeCurrent/requireScope mechanism; no second authority.

| Boundary / exit | Required guard and ordinary behavior |
| --- | --- |
| Startup / restore / exceptional load | Observe before generation admission, recovery and error reporting; no incompatible CURRENT/rollback visibility. |
| Reconciliation list, hints, read, parser, all three cooperative yields | Fence returned data and every continuation before local cancellation/revision/stop checks or subsequent dispatch. |
| Reconciliation catch, finally, work drain, dirty obligations | Observe even if paused/stopped or no pending work; do not restore dirty work or schedule a retired owner. Release the physical slot only at actual settlement. |
| Commit pre/post rename, commit rejection and close/drain | Preserve authenticated cancellation before rename and nonthrowing post-rename visibility; observe at finalization without claiming disk rollback. |
| Basic/Properties incl. selected range and zero hits | Existing pre/post list, hints, read and error/final visibility fences; preserve ordinary snapshot pinning. |
| Dense capture / verify; Chat membership, verification, search | Existing pre/post read, nested settlement and exceptional lease checks; local retirement cannot hide owner retirement. |
| Graph admission, repeated read/verify, deadline and physical release | Owner before local started/result/retired guards, outer settlements, and physical release; keep one-shot semantics and timeout/abort slot ownership. |
| Graph catalog, projection, navigation and graph evidence | Guard each nested await at its caller, including checkpoint and navigation return, before metadata, identity, relation/navigation assembly and final hashing/serialization. Preserve bounded cooperative yields. |
| Preview and processing-policy dependency / logical terminal / physical drain | Existing source and parser proof fences; always observe owner at settlement/drain even when the outward operation expired. Preserve ordinary typed denial and physical ownership. |

Acceptance: reproduce the five independent negative scenarios on the prior HEAD and replay on the candidate. Permanent regressions must inspect raw owner state before status/current, include ordinary repeated admission and cancellation controls, dirty-obligation and physical-slot assertions, deterministic nested microtask revocation during identity/metadata/edge assembly, and full applicable validation. Author replay is not independent review. No host-wide synchronous retirement, production activation, physical cleanup or later slice.

## B-07 processing-policy callback and terminal assembly remediation

Prior candidate: 5b31d2397e299feb41bf89bf5161d1aa38954bac. Observe the same engine source owner before and immediately after current/snapshot/marking callbacks, including exceptional completion; do not validate, clone, hash or assemble returned or accumulated policy metadata after owner retirement, including denied envelope construction and late dependency settlement. Preserve ordinary allowed/denied/throwing callbacks and one physical slot; no new policy authority, host activation or later-slice behavior. Replay both independent snapshot probes and add deterministic initial/post-read, marking allow/deny/throw, current, ordinary and reentrant controls, inspecting raw owner/cache and no subsequent I/O/parser/metadata processing. Author replay is not independent review.
