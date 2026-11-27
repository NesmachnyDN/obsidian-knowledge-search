# OKS-06 P0.2b5a — host source-revision retirement prerequisite

Base: 7994fdd47f976ebb3364f0458cd59c24b556479b. Authority: AGENTS, SECURITY, SDD, SPEC CAP/AC-01/06/08/10, ARCHITECTURE, ROADMAP P0, ADR-0023, #149/#105, HARD-SCOPE-1–5 and merged #154. Standard bounded PHASE_RUN. This is a prerequisite, not activation or cumulative acceptance.

## Existing ownership and gap

The native adapter owns irreversible native scope retirement; the reader and standalone engine now observe it. The standalone engine separately requires an actual host-operation retirement signal for revocable policy and preview calls. The current native main wiring creates an unscoped reader and policy host calls do not yet bind a host-operation signal. SearchController already owns sourceRevision, sourceAuthorityCurrent, source retirement obligations/drains, shared reset and terminal seal. Reuse these; do not make a parallel revision matcher or policy issuer.

The first bounded host-side slice must bind an irreversible source-revision retirement seal to the existing SearchController source authority. It is only a constituent of a later full host-operation signal: it cannot by itself establish active-file identity, role/profile, credentials, lifecycle, current operation, provider configuration, or current callback. Do not pass an incomplete seal as PolicyHost.authority or enable native scope.

## Implementation boundary

Inspect existing source revision transitions, settings begin/end, nested source invalidation, trackSourceDrain, source retirement failure/overflow and terminal teardown. Expose a host-internal captured current revision and its irreversible signal only while existing source authority permits capture. Seal the previous authority on revision/lifecycle loss before any observable result, new source work or relevant host callback; preserve exact concrete retirement obligations, nested waves, source-drain and fail-closed behavior. Do not let a reentrant signal listener reopen a retired revision, replace an outstanding retirement target, skip a retirement obligation, or dispatch stale work. Respect the terminal seal ordering across sibling owners; do not introduce a new callback in the terminal logical seal before sibling authority is closed. If the existing signal and terminal ordering cannot provide this invariant without wider redesign, stop and reconcile this contract before code rather than manufacturing a standalone AbortController that is not bound to the existing owner.

In scope: SearchController source-revision authority boundary, minimal cohesive internal helper if necessary, targeted synthetic tests and this contract. No main activation, native configuration subscription in production, role/preview signal plumbing, new source matcher, source writes, new dependency, storage schema, provider or producer calls, physical derived cleanup, expanded capability claim or unrelated refactor.

## Negative acceptance matrix

- Capture under current revision; successful source invalidation retires old signal permanently; a newly eligible revision receives a distinct live seal only after the existing retirement barrier settles.
- Nested invalidation, synchronous signal listener reentry, settings transition and failure, rejected/pending source drain, retirement failure/overflow, terminal unload and repeated retirement; no stale admission or missed concrete obligation, including empty-obligation invalidation.
- Retirement observed before any relevant observer/callback sees old publication rights; preserve shared reset behavior, source versus ordinary lexical revision distinction, and existing Basic/graph/evidence/chat/dense authority regression.
- Old signal remains retired after recovery; no revival and no new grants during retirement. Use generated synthetic data only. Instrument ordering and actual dispatch counts, not merely return codes.
- Full applicable validation: focused controller/retirement tests, full Node/Python, typecheck, build, license, isolated standalone package and contract checks, publication hygiene, diff check, exact-HEAD CI and separate independent full-diff review.

## Subsequent gates (not in this slice)

Bind actual per-operation host authority for policy roles and both metadata previews (including active file, exact engine/reader, lifecycle and configuration). Map main owner replacement and synchronous retirement across Basic, graph, navigation, chat/history, dense, Advanced ingestion/retrieval, marking/lifecycle, policy/grant and pending storage work. Only then activate the existing native adapter under validated compatibility, fail closed for unknown state, reconcile derived cleanup and newly eligible originals, and independently exercise all routes on a real supported isolated host. #149 and #105 remain open; no P0/OKS-06 completion claim.
