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

## Concrete OKS-04A native Markdown lexical profile (candidate)

The concrete **in-process TypeScript** records in `plugin/src/standalone/contracts.ts` implement the abstract records above, not a competing domain model. This profile is intentionally separate from the historical `v1` synthetic-probe stdio envelope and from experimental Python FTS5/vector backend implementations. It is not yet a frozen cross-process wire format.

| Concern | Native encoding / validation |
|---|---|
| API request | `protocolVersion: 2`, `requestId` (bounded identifier), `requestedMode`, `query`, optional vault-relative `scope: string[]`, `limit`, optional `predicates`, optional lexical-only `range` (see below) |
| Modes | `lexical` executes; `dense`/`hybrid` respond `CAPABILITY_UNAVAILABLE`, `executedMode: none`, no fake vectors/fallback |
| Root identity | Local provider-only SHA-256 of canonical Vault root, device and inode; never accepted from user query; partitioned durable cache |
| `SourceVersion` | `sourceId` = `vaultRelativePath`; `sha256` over raw input, `sourceType: markdown`, `scopeId: rootId`, `profileId`, `extractionStatus`, `properties`, `wikiLinks`, `diagnostics`, `blocks` |
| `ParsedBlock` | `blockId` SHA-256 of source/version/order/byte range, `order`, `kind`, original physical line `originalText`, exact `headings`, `wikiLinks`, bounded lexical `terms` and one strict `SourceLocator` |
| `SourceLocator` | `locatorKind: markdown`, `sourceVersion`, `blockOrder`, `byteStart/End`, `charStart/End` as Unicode scalar values and `lineStart/End` one-based |
| `TypedProperty` | `key`, `valueType: string/number/boolean/date/null/list`, `value`; finite numeric only, dates ISO `YYYY-MM-DD`, lists of JSON primitives; no coercion |
| Property filtering | `Predicate {key,valueType,value,operator:eq|contains}`; type match required before evaluating, `contains` limited to list membership and preserves primitive value type |
| `IndexGeneration` | `schemaVersion`, `rootId`, `generationId`, `publishedAt` ISO UTC, `sourceVersionSet`, `lexicalIndexId`, `readiness: ready`, `documents`; digest based on stable ordered content **excluding wall-clock publication time** |
| `EvidenceHit` | `sourceId`, `sourceSha256`, exact `originalExcerpt`, verified `sourceLocators[]`, `rank`, `lexicalRank`, `score`, `retrievalMode: lexical`, `indexGenerationId`, headings/links/properties |
| Response | request version/ID/modes, capability readiness, generation ID, `status: ok/degraded/failed`, hits, typed error code and count of stale suppressed sources |

Canonical source text for this profile is a **verified physical Markdown line** rather than a synthetic context prefix or reassembled chunk. The Python structural chunking policy stays an independent reference/advanced candidate, not a hidden native dependency. Headings are preserved as metadata and used in ranking without inventing new source locators. Known unsupported markup is marked with extraction diagnostics. Full CommonMark/YAML coverage remains a separate compatibility gate.

Selected-range extension (06H.2-A1): a nonempty lexical text request may specify `range: {sourceId,sourceSha256,byteStart,byteEnd,charStart,charEnd}` together with the singleton matching scope. Both intervals are half-open and authenticated against original bytes. Editor-buffer mapping is host-local and does not enter the request. Range eligibility precedes ranking; only original line terms, no inherited heading or Properties context, enter scoped hits. Explicit source-level metadata predicates remain eligibility filters, not disclosed context. Metadata-only, dense and hybrid range requests are rejected rather than widened. This is an in-process retrieval substrate, not chat admission or host UI acceptance.

**Language-neutral parity fixtures:** `contracts/fixtures/standalone-v2.json`. Both `tests/standalone.test.ts` and `tests/test_standalone_conformance.py` independently validate source hash, Unicode/CRLF spans, original text, link metadata, block order and heading hierarchy. The reference line parser alone does not reject duplicate typed YAML properties, but the Python retrieval property validator does; the native parser marks the source `partial` and clears typed properties. The fixture explicitly encodes both statuses rather than falsely claiming byte-for-byte identical internal parser behavior.

No compatibility is claimed for binary-native source locators, embeddings, external IPC, or `Chunk` records in this Markdown-only lexical slice. Future 04B/05 extensions **must preserve these canonical semantics** and are not allowed to silently accept unknown `protocolVersion` or `schemaVersion`.
