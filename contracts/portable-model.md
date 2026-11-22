# Portable retrieval data contracts — architecture draft

Status: **architecture contract**, not a frozen JSON Schema or a production wire format. ADR-0006 defines why the contract is shared across plugin-native and optional Python runtime. The existing `contracts/request.schema.json` and `response.schema.json` remain **v1 synthetic-probe only**. OKS-03B defines and tests a new versioned concrete format before any cross-runtime IPC; OKS-04A tests independent JS conformance before production promotion.

## Cross-language invariants

- Fields are lower-camel-case JSON-compatible values; required/optional/null and validity are explicitly distinguished. Unknown protocol/schema versions fail closed rather than guessing. All hash fields are lower-case SHA-256 over original **raw bytes**; never hash rendered or contextualized text in their place.
- All paths are canonical vault-relative file identifiers with forward-slash segments, without `..`, absolute host prefixes, NUL or symlink escape. Do not leak absolute source paths or local cache paths across the API. Vault identity and scope are caller-bound, not supplied by untrusted source text.
- **Unicode span convention:** canonical original block `charStart`/`charEnd` are zero-based **Unicode scalar-value/code-point offsets** (half-open); JavaScript UTF-16 `string.length` is **not** the interchange unit. Markdown `byteStart`/`byteEnd` are zero-based half-open UTF-8 offsets into the verified original file, and `lineStart`/`lineEnd` are one-based physical lines. Native PDF/DOCX item offsets are over their explicitly named native representation, never invented file byte offsets. Missing coordinates are `null` and carry diagnostics.
- Source data and derived data stay separate: source excerpt is exact text from original supported representation; embedding input contains serialized contextual prefix and special tokens with full effective budget identity. No synthetic/generated summary may masquerade as original excerpt.
- A search candidate is displayable only if source is in authorized scope and its current content hash/identity is verified. Rename, delete, change, uncertain hash, inaccessible source or incompatible index generation suppress current evidence. Persisted caches are discardable; source files never are.
- Lexical, dense, and hybrid are three distinct algorithm identifiers; request and effective mode must both be visible. A requested hybrid cannot silently return lexical-only as successful hybrid. Any unavailable leg returns a typed failure and no wrong-mode success.
- All arrays have bounded lengths, deterministic ordering and stable tie-breaking. A self-validating parser must reject oversized, malformed and out-of-schema payloads; source text is not an execution instruction.

## Required abstract records (not yet frozen wire fields)

| Entity | Required semantic fields | Important optional / failure fields |
|---|---|---|
| `SourceVersion` | `sourceId`, `vaultRelativePath`, `sha256`, `sourceType`, `scopeId`, `extractionStatus`, `profileId` | `diagnostics`, `metadataVersion`; source identity and hash independently verifiable |
| `TypedProperty` | `key`, `valueType` (`string`, `number`, `boolean`, `date`, `list`, `null`), `value` | original YAML/frontmatter representation and explicit invalid/unsupported status; no lossy coercion |
| `ParsedBlock` | `sourceId`, `sourceSha256`, `order`, `kind`, `originalText`, `headings`, `locator` | typed Properties and resolvable/unresolved wiki links, clause, table/row/cell, extraction diagnostics |
| `SourceLocator` | `locatorKind` (`markdown`, `native`, `unavailable`), `sourceVersion`, `blockOrder`, `charStart`, `charEnd` | verified Markdown UTF-8 bytes/lines; native item `itemRef`, page/coordinate origin/geometry, row/column/cell anchors; documented missing fields |
| `Chunk` | `chunkId`, `sourceId`, `sourceSha256`, `orderedSourceSlices`, `originalText`, `embeddingText`, `chunkPolicyId`, `serializationId`, `locator[]` | `tokenizerFingerprint`, `effectiveTokenCount`, `embeddingSpaceId`, coverage/oversize and extraction diagnostics |
| `IndexGeneration` | `schemaVersion`, `generationId`, `sourceVersionSet`, `lexicalIndexId`, `publishedAt`, `readiness` | if dense ready: model/weights/tokenizer/runtime/normalization/dimension/serialization identities and exact dense generation; otherwise dense is explicitly unavailable |
| `SearchRequest` | `protocolVersion`, `requestId`, `query`, `requestedMode`, `scope`, `limit` | typed Property predicates, source-type predicates, cancellation/deadline and capability requirements |
| `EvidenceHit` | `sourceId`, `sourceSha256`, `originalExcerpt`, `sourceLocators[]`, `rank`, `retrievalMode`, `indexGenerationId` | per-leg `lexicalRank`/`denseRank`, raw leg scores and RRF score, extraction/evidence completeness diagnostics |
| `SearchResponse` | `requestId`, `requestedMode`, `executedMode`, `capabilityReadiness`, `indexGenerationId`, `hits[]`, `status` | per-leg diagnostics and typed `CAPABILITY_UNAVAILABLE`, `MODEL_UNAVAILABLE`, `INDEX_INCOMPATIBLE`, `LEG_FAILED`, `SOURCE_STALE`, `CANCELLED`, `RESOURCE_EXHAUSTED` errors |

`SourceLocator[]` may contain more than one original anchor, including table cells; a partial native row has its original item/cell anchors but cannot invent cell-local substrings. Exact Markdown excerpt verification must use the recorded raw bytes and Unicode convention. A 1024-dimensional finite vector alone does **not** establish model-space compatibility.

## Concrete-schema acceptance before adoption

1. Versioned strict schema and deterministic canonical field encoding with explicit nullable fields, envelope/input size and requested-vs-executed semantics.
2. Same fixtures validated independently by TypeScript and Python, including BOM/duplicate-field rejection, UTF-8/UTF-16 distinctions, CRLF, emoji, Cyrillic, punctuation-heavy identifiers, duplicated headings, table cells, missing native page/geometry, typed Properties and wiki-link resolution.
3. Source-hash and chunk-ID parity on identical canonical input and serialization profiles, with explicit mismatch errors rather than cross-language assumptions.
4. Transactional publication, compatible search index metadata and stale-hit tests for create/modify/rename/delete/missed events, rollback, inaccessible source and mixed generations.
5. Lexical-only, real dense-only and hybrid behavior tested independently; absent dense model and failed leg must never produce a successful hybrid label.
6. No production fixtures from a real Vault, no raw source text in logs, and no unconsented external transfer.

The above establishes shared **semantics** now, not a claim that the current two runtimes implement this future schema. The first implementing PR must choose exact field names/types and prove conformance before claiming any accepted bridge.
