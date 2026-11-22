# OKS-03B — real lexical, dense and hybrid Retrieval (aggregated PHASE_RUN)

**Dependency:** verified CPU reference BGE-M3 experiment OKS-03A (checkpoint `d572874`), ADR-0006 and immutable 02A/02B/02C evidence. **Base integration SHA:** `6011110b9303f5eb850de9c5d8179d200f403451`. **Candidate:** existing aggregated Draft PR #10; **no separate merge** until full Retrieval PHASE_CLOSE and one external full-diff review.

## Governing authority

AGENTS.md, SECURITY.md, docs/development/SDD.md (explicit aggregated PHASE_RUN exception), docs/SPEC.md CAP-03/04/05/06/08/09/10 and AC-03/04/05/06/08/09/10, docs/ARCHITECTURE.md, docs/ROADMAP.md, ADR-0001–0006, contracts/portable-model.md, docs/prompts/OKS-03A.md, frozen synthetic corpus and benchmarks (02A/02B/02C).

## Mandatory scope

1. Experimental Python reference backend only: implement **real** independent lexical and BGE-M3 1024-dim model-backed dense retrieval, plus documented deterministic RRF fusion with stable source IDs. No pseudo/random/hash embeddings; no hidden hybrid-to-lexical fallback. Explicitly report `requestedMode`, `executedMode`, model/index/capability readiness and per-leg failures.
2. Preserve authoritative source bytes, path + digest + verified original locator and text. Link candidate evidence to original ParsedBlock/SourceSlice, never contextualized text. At generation build, reject forged/stale metadata; validate exact source bytes, source hash, index identity and raw Unicode/byte locators. After mutation/rename/delete or uncertain source, suppress hits immediately. Bound index size and all query inputs.
3. Typed Properties filters distinguish strings, numeric, boolean, date, list and null without lossy coercion. Preserve wiki links as metadata, not invented graph edges. Scope is caller-controlled via the trusted descriptor-scoped reader.
4. Publish an **all-or-nothing** consistent in-memory lexical+dense generation with model/weights/tokenizer/normalization/serialization identity. A failed partial dense build cannot expose a successful hybrid index. Experiment does not replace future 04A plugin-native durable index.
5. Use original frozen 02A corpus and tuning/held-out queries, fixed rank metrics (Recall/Precision/nDCG/MRR/exact identifiers, K=5/10), plus 02C structural-policy paired comparisons with the **same real model** on identical source extraction and fair tokenization. Record resource admission, tail latency and failure counts separately. No label edits, post-hoc cherry-picking or invented superiority.
6. Run model workloads **only** within maintainer-approved offline resource envelope already recorded in OKS-03A: <=4 GiB whole scope, 2 logical CPUs, swap 0, timeout 180 seconds, network namespace, one heavy task and synthetic sources only. Reuse the verified bounded model runner; no downloads/new inference framework or private Vault.
7. Versioned shared evidence fields and strict negative tests: missing/failed model leg, dense unavailable/incompatible, typed predicate invalid, generation mismatch, source mutation/rename/delete, incomplete provenance, cancelled/pressure admission, no lexical relabel on hybrid failure.

## Explicit out of scope

No changes to synthetic probe v1, no production Vault files/indexes, no standalone plugin implementation, no UI, no cross-encoder or graph search, no model redistribution or new download, no incumbent Knowledge AI adoption. Experimental Python backend is **not** an additional installation requirement of standalone Obsidian.

## Exit and delivery

Carry a scoped 03B implementation checkpoint on the existing Draft PR #10, with exact changed paths, negative tests, actual guarded CPU benchmark, measured quality, model identity and resource report. After **both** 03A and 03B acceptance gates are complete and CI green, request **one independent full-phase exact HEAD review** in a genuinely separate chat/human, not the implementing conversation. Do not merge any intermediate checkpoint into develop. On final APPROVE, verify status/checks, make PR Ready and squash merge exactly once; otherwise keep Draft, report unmet gates, do not declare PHASE_CLOSE.
