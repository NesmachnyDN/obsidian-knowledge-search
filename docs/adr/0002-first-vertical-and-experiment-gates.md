# ADR-0002: First vertical slice and evidence-first experiment gates

Status: Proposed for OKS-00 review; the IPC, storage and model decisions remain conditional on prototypes.

## Context

The initial local-first architecture is sound, but the first slice must prove a real plugin-to-engine boundary without starting ML or altering a real vault. Structural token-budget experiments also need the exact candidate tokenizer before full model inference is introduced.

## Decision proposed

- OKS-01A is a non-indexed synthetic evidence probe, implemented as a desktop Obsidian command and a one-shot supervised Python standard-library process over bounded UTF-8 JSON Lines on stdio. It reads only the explicitly installed known synthetic fixture; no automatic startup, file crawling or model downloads. This is a transport/lifecycle prototype, not a production search backend or fallback.
- Use a versioned success/error envelope, request correlation, fixed input and output bounds, one in-flight request, deadline, cancellation and child cleanup. Return a literal source line and locator, source digest and request ID for a deterministic fixture match; no fake vectors or claims of semantic search. See the bounded execution contract.
- Prefer installed Python and the host's child-process API. An explicit trusted executable/entry point is configured by the operator; no shell, no arbitrary command or path from document input, no listening network socket. Do not claim OS sandboxing. The later storage/IPC prototype must test stronger resource and filesystem isolation before arbitrary vault processing.
- Keep SQLite/FTS5 and an exact dense search baseline as candidates. Benchmark alternatives; transactional visibility, source freshness and bounded resource usage matter more than selecting a vector extension early.
- Separate tokenizer-only provisioning and validation from embedding weight provisioning. First verify the exact pinned tokenizer and effective input policy before chunker experiments; record artifact identity and count actual serialized input. Full model/tokenizer parity and resource limits are revalidated at 03A. Any tokenizer/model download or heavy experiment requires separate authorization.
- Before indexing arbitrary sources, verify canonical source locators, symlink/scope controls, content hashes and failure policy. Original content and derived embedding representation are distinct. Unavailable provenance is explicit, not guessed. Search must not label stale/deleted evidence as current.
- Treat heavy operations as opt-in, one at a time. Admission checks must precede initialization, not follow a large allocation; resource stops must preserve the last committed index. Retain an explicit no-network/runtime-download policy and test restart recovery.
- No direct private code transfer; independently implement narrow algorithms and use licensed upstream packages only after version-specific dependency review.

## Alternatives and consequences

A permanent loopback service simplifies external clients but increases listener/authentication/lifecycle risk; defer comparison to 01B. Starting with Docling or embedding inference confounds integration, quality and resource problems; defer to measured slices. A ping-only probe proves less than a fixture evidence response, while a real search index in 01A broadens its scope. A single-shot process has startup overhead; measure persistent stdio vs alternatives before production adoption.

The first slice can be validated with no ML packages, databases, or real knowledge material. It cannot establish hybrid retrieval, general document parsing, durable index behavior, external agent API or host production readiness. No benchmark or experimental technology choice is considered passed by this ADR.
