"""Deterministic canonical source spans and exact-token structural planners."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Literal

from engine.document import Cell, NativeAnchor, ParsedBlock, ParsedDocument, Span
from engine.token_budget import TokenBudgetError, TokenCounter, SERIALIZATION_VERSION, serialize_text

CHUNKING_VERSION = "oks-02c-v1"
PolicyName = Literal["fixed-window", "paragraph", "structure", "native-hybrid"]
MAX_INPUT_BLOCKS = 8192
MAX_OUTPUT_CHUNKS = 100_000


@dataclass(frozen=True)
class ChunkPolicy:
    name: PolicyName
    max_tokens: int
    overlap_tokens: int = 0
    literal_prefix: str = ""

    def __post_init__(self):
        if self.name not in ("fixed-window", "paragraph", "structure", "native-hybrid"):
            raise ValueError("unknown chunking policy")
        if not (8 <= self.max_tokens <= 8192) or not (0 <= self.overlap_tokens < self.max_tokens):
            raise ValueError("invalid token budget or overlap")
        if len(self.literal_prefix) > 256:
            raise ValueError("unbounded contextual prefix")


@dataclass(frozen=True)
class SourceSlice:
    block_order: int
    start: int  # Unicode offset into canonical ParsedBlock.text, half-open
    end: int


@dataclass(frozen=True)
class SourceLocator:
    block_order: int
    source_char_span: tuple[int, int]
    file_bytes: Span | None
    native_item_ref: str | None
    native_item_char_span: tuple[int, int] | None
    native: NativeAnchor | None
    table: int | None
    row: int | None
    cells: tuple[Cell, ...]
    diagnostics: tuple[str, ...]


@dataclass(frozen=True)
class Chunk:
    id: str
    path: str
    source_hash: str
    extraction_profile: str | None
    extraction_status: str
    policy: ChunkPolicy
    version: str
    tokenizer_fingerprint: str
    slices: tuple[SourceSlice, ...]
    locators: tuple[SourceLocator, ...]
    headings: tuple[str, ...]
    original_text: str
    embedding_text: str
    prefix_tokens: int
    token_count: int
    diagnostics: tuple[str, ...]


def _validate_document(doc: ParsedDocument) -> None:
    if doc.status not in ("ok", "partial", "empty") or doc.digest is None:
        raise ValueError("cannot chunk failed/unsupported/unhashed source")
    if len(doc.blocks) > MAX_INPUT_BLOCKS:
        raise ValueError("source exceeds block bound")
    if len(doc.digest) != 64 or any(ch not in "0123456789abcdef" for ch in doc.digest):
        raise ValueError("invalid source digest")
    for index, block in enumerate(doc.blocks):
        if block.order != index or block.path != doc.path or block.digest != doc.digest:
            raise ValueError("inconsistent parsed-block source identity/order")


def _locator(block: ParsedBlock, fragment: SourceSlice) -> SourceLocator:
    start, end = fragment.start, fragment.end
    if not (0 <= start < end <= len(block.text)):
        raise ValueError("source character span is invalid")
    issues: list[str] = []
    file_span = None
    if block.span is not None:
        if block.span.end - block.span.start != len(block.text.encode("utf-8")):
            issues.append("source-file-span-unverifiable")
        else:
            file_span = Span(block.span.start + len(block.text[:start].encode("utf-8")),
                             block.span.start + len(block.text[:end].encode("utf-8")),
                             block.span.line_start, block.span.line_end)
    elif block.native is None:
        issues.append("source-locator-missing")
    item_char = None
    if block.native is not None:
        if block.native.original_text == block.text:
            item_char = (start, end)  # Offsets into verified native original text, NOT file bytes.
        elif start != 0 or end != len(block.text):
            issues.append("native-subspan-not-verifiable")
        if block.native.content_layer != "body":
            issues.append("non-body-content-layer")
        if not block.native.locations and block.page is not None:
            issues.append("native-page-location-inconsistent")
    cells = block.cells
    if cells and (start != 0 or end != len(block.text)):
        # Native table row is a derived cell serialization. Do not assign partial
        # string positions to native PDF cell text or invent a PDF byte offset.
        issues.append("partial-table-row-serialization")
    return SourceLocator(block.order, (start, end), file_span,
                         block.native.item_ref if block.native else None, item_char,
                         block.native, block.table, block.row, cells, tuple(issues))


def _original(doc: ParsedDocument, slices: tuple[SourceSlice, ...]) -> str:
    return "\n".join(doc.blocks[s.block_order].text[s.start:s.end] for s in slices)


def _headings(doc: ParsedDocument, slices: tuple[SourceSlice, ...]) -> tuple[str, ...]:
    headings = {doc.blocks[s.block_order].headings for s in slices}
    return headings.pop() if len(headings) == 1 else ()


def make_chunk(doc: ParsedDocument, slices: tuple[SourceSlice, ...], policy: ChunkPolicy,
               tokenizer: TokenCounter, *, embedding_override: str | None = None,
               diagnostics: tuple[str, ...] = (),
               prefix_override: str | None = None) -> Chunk:
    _validate_document(doc)
    if not slices:
        raise ValueError("empty chunk")
    if len(slices) > MAX_INPUT_BLOCKS:
        raise ValueError("chunk slice bound")
    locators = tuple(_locator(doc.blocks[s.block_order], s) for s in slices)
    original = _original(doc, slices)
    headings = _headings(doc, slices)
    contextual_headings = headings if policy.name != "fixed-window" else ()
    contextual, prefix = serialize_text(contextual_headings, original,
                                        literal_prefix=policy.literal_prefix)
    if embedding_override is not None:
        contextual = embedding_override
        # Native contextualization may use its own headings/table serialization.
        prefix = (prefix_override if prefix_override is not None else
                  contextual[:-len(original)] if original and contextual.endswith(original) else "")
    tokens = tokenizer.count(contextual)
    issues = set(diagnostics)
    if len({doc.blocks[s.block_order].headings for s in slices}) > 1:
        issues.add("cross-section-mixing")
    if embedding_override is not None and original not in contextual:
        issues.add("native-context-not-verbatim-source")
    for loc in locators:
        issues.update(loc.diagnostics)
    if doc.status == "partial":
        issues.add("source-extraction-partial")
    if tokens > policy.max_tokens:
        issues.add("token-budget-violation")
    # The tokenizer artifact/runtime is part of the immutable chunk identity.
    tokenizer_signature = getattr(tokenizer, "identity", {
        "counter_class": type(tokenizer).__module__ + "." + type(tokenizer).__qualname__
    })
    tokenizer_fingerprint = hashlib.sha256(json.dumps(
        tokenizer_signature, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    payload = [CHUNKING_VERSION, SERIALIZATION_VERSION, tokenizer_fingerprint,
               doc.path, doc.digest,
               doc.extraction_profile, policy.name, policy.max_tokens,
               policy.overlap_tokens, policy.literal_prefix,
               [(s.block_order, s.start, s.end) for s in slices],
               contextual if embedding_override is not None else None]
    identity = hashlib.sha256(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    return Chunk(identity, doc.path, doc.digest, doc.extraction_profile, doc.status,
                 policy, CHUNKING_VERSION, tokenizer_fingerprint,
                 slices, locators, headings, original,
                 contextual, tokenizer.count(prefix) - tokenizer.count("") if prefix else 0,
                 tokens, tuple(sorted(issues)))


def _fit(doc: ParsedDocument, block: ParsedBlock, start: int, policy: ChunkPolicy,
         tokenizer: TokenCounter, headings: tuple[str, ...]) -> SourceSlice:
    """Find the longest fitting original-character prefix without monotonicity assumptions.

    Subword token counts can *decrease* after adding a character: a tokenizer
    may merge the new suffix with an earlier token. Binary search can therefore
    reject an otherwise fitting element. Check exact serialized candidates from
    longest to shortest and fail only when no nonempty candidate fits.
    """
    for end in range(len(block.text), start, -1):
        contextual, _ = serialize_text(headings, block.text[start:end],
                                       literal_prefix=policy.literal_prefix)
        if tokenizer.count(contextual) <= policy.max_tokens:
            return SourceSlice(block.order, start, end)
    raise TokenBudgetError("prefix and every nonempty source fragment exceed token budget")


def _tail_overlap(doc: ParsedDocument, chunk: Chunk, policy: ChunkPolicy,
                  tokenizer: TokenCounter) -> SourceSlice | None:
    if not policy.overlap_tokens:
        return None
    last = chunk.slices[-1]
    value = doc.blocks[last.block_order].text
    # Subword suffix token counts are not monotonic in their start position.
    # Inspect longest first; never derive byte or native-cell offsets here.
    base_tokens = tokenizer.count("")
    for start in range(last.start, last.end):
        if tokenizer.count(value[start:last.end]) - base_tokens <= policy.overlap_tokens:
            return SourceSlice(last.block_order, start, last.end)
    return None


def _overlap(doc: ParsedDocument, chunks: list[Chunk], policy: ChunkPolicy,
             tokenizer: TokenCounter) -> list[Chunk]:
    if not policy.overlap_tokens:
        return chunks
    result = [chunks[0]] if chunks else []
    for current in chunks[1:]:
        prior = result[-1]
        tail = _tail_overlap(doc, prior, policy, tokenizer)
        if tail is not None:
            # Structural and paragraph policies never overlap across section boundaries.
            if (policy.name == "fixed-window"
                    or doc.blocks[tail.block_order].headings == current.headings):
                candidate = make_chunk(doc, (tail,) + current.slices, policy, tokenizer,
                                       diagnostics=("intentional-overlap",))
                if candidate.token_count <= policy.max_tokens:
                    result.append(candidate)
                    continue
        result.append(current)
    return result


def plan_chunks(doc: ParsedDocument, policy: ChunkPolicy, tokenizer: TokenCounter) -> tuple[Chunk, ...]:
    """Three independent, exact-token counted baselines/planners on the same blocks."""
    if policy.name == "native-hybrid":
        raise ValueError("native HybridChunker has a separate audited adapter")
    _validate_document(doc)
    current: list[SourceSlice] = []
    output: list[Chunk] = []

    def flush() -> None:
        if current:
            chunk = make_chunk(doc, tuple(current), policy, tokenizer)
            if chunk.token_count > policy.max_tokens:
                raise TokenBudgetError("internal planner budget violation")
            output.append(chunk)
            current.clear()

    for block in doc.blocks:
        if not block.text:
            continue  # Zero-character source block has zero coverable characters.
        start = 0
        # A new heading is a hard boundary in structural and paragraph strategies.
        if current and policy.name != "fixed-window":
            previous = doc.blocks[current[0].block_order]
            if (block.headings != previous.headings
                    or block.kind == "heading"
                    or block.kind in ("page_header", "page_footer")
                    or previous.kind in ("page_header", "page_footer")
                    or policy.name == "structure" and (
                        (block.table is not None) != (previous.table is not None)
                        or block.kind == "clause" and previous.kind == "clause")):
                flush()
        while start < len(block.text):
            if len(output) >= MAX_OUTPUT_CHUNKS:
                raise ValueError("chunk count limit exceeded")
            headings = () if policy.name == "fixed-window" else block.headings
            piece = _fit(doc, block, start, policy, tokenizer, headings)
            merged = tuple(current) + (piece,)
            merged_chunk = make_chunk(doc, merged, policy, tokenizer)
            if merged_chunk.token_count > policy.max_tokens and current:
                flush()
                # Retry this substring under fresh contextual budget.
                continue
            if merged_chunk.token_count > policy.max_tokens:
                raise TokenBudgetError("single fitted fragment unexpectedly oversized")
            current.append(piece)
            start = piece.end
            # Oversized blocks are explicitly split and never silently skipped.
            if start < len(block.text):
                flush()
            elif policy.name == "paragraph":
                flush()
    flush()
    return tuple(_overlap(doc, output, policy, tokenizer))


def coverage_report(doc: ParsedDocument, chunks: tuple[Chunk, ...] | list[Chunk],
                    tokenizer: TokenCounter) -> dict:
    """Audit exact source characters, duplicated chars and carried locators."""
    _validate_document(doc)
    covered = [[0] * len(block.text) for block in doc.blocks]
    inconsistent = 0
    cells_total = {(b.order, i) for b in doc.blocks for i, _ in enumerate(b.cells)}
    bound_violations = 0
    section_violations = 0
    locator_missing = 0
    locator_incorrect = 0
    locator_incomplete = 0
    tokenizer_signature = getattr(tokenizer, "identity", {
        "counter_class": type(tokenizer).__module__ + "." + type(tokenizer).__qualname__
    })
    actual_fingerprint = hashlib.sha256(json.dumps(
        tokenizer_signature, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    for chunk in chunks:
        if chunk.tokenizer_fingerprint != actual_fingerprint:
            raise ValueError("chunk bound to a different tokenizer identity")
        if chunk.path != doc.path or chunk.source_hash != doc.digest:
            raise ValueError("chunk assigned to wrong source version")
        if chunk.token_count != tokenizer.count(chunk.embedding_text):
            raise ValueError("stored token count disagrees with tokenizer")
        bound_violations += chunk.token_count > chunk.policy.max_tokens
        section_violations += "cross-section-mixing" in chunk.diagnostics
        if _original(doc, chunk.slices) != chunk.original_text:
            inconsistent += 1
        for span, loc in zip(chunk.slices, chunk.locators, strict=True):
            if loc.source_char_span != (span.start, span.end) or loc.block_order != span.block_order:
                locator_incorrect += 1
            block = doc.blocks[span.block_order]
            if not (loc.file_bytes or loc.native_item_ref):
                locator_missing += 1
            if (block.native and block.native.content_layer == "body"
                    and doc.extraction_profile and "pdf" in doc.extraction_profile
                    and not block.native.locations):
                locator_incomplete += 1
            if block.native and loc.native_item_ref != block.native.item_ref:
                locator_incorrect += 1
            if loc.file_bytes and (block.span is None
                                   or loc.file_bytes.start < block.span.start
                                   or loc.file_bytes.end > block.span.end):
                locator_incorrect += 1
            for k in range(span.start, span.end):
                covered[span.block_order][k] += 1
    cells_present = {(b.order, i) for b in doc.blocks
                     if b.cells and all(x > 0 for x in covered[b.order])
                     for i, _ in enumerate(b.cells)}
    total = sum(map(len, covered))
    retained = sum(sum(x > 0 for x in flags) for flags in covered)
    duplicate = sum(sum(max(0, x - 1) for x in flags) for flags in covered)
    missing = [{"block": i, "start": start, "end": end} for i, flags in enumerate(covered)
               for start, end in _gaps(flags)]
    unique_original = "\n".join(b.text for b in doc.blocks if b.text)
    unique_tokens = tokenizer.count(unique_original)
    all_tokens = sum(chunk.token_count for chunk in chunks)
    return {
        "source_characters": total, "covered_source_characters": retained,
        "source_coverage": retained / total if total else 1.0,
        "lost_spans": missing, "duplicated_source_characters": duplicate,
        "token_duplication_ratio": all_tokens / unique_tokens if unique_tokens else 0.0,
        "total_tokens_in_chunks": all_tokens, "unique_source_tokens": unique_tokens,
        "chunks": len(chunks), "tokens_min": min((c.token_count for c in chunks), default=0),
        "tokens_max": max((c.token_count for c in chunks), default=0),
        "tokens_mean": all_tokens / len(chunks) if chunks else 0.0,
        "prefix_tokens_total": sum(c.prefix_tokens for c in chunks),
        "token_budget_violations": bound_violations,
        "oversized_chunks": bound_violations,
        "cross_section_chunks": section_violations,
        "heading_boundary_violations": section_violations,
        "table_cells_covered": len(cells_present),
        "table_cells_total": len(cells_total),
        "table_cells_preserved": len(cells_present) == len(cells_total),
        "locator_missing": locator_missing, "locator_incomplete": locator_incomplete,
        "locator_incorrect": locator_incorrect,
        "canonical_content_mismatch_chunks": inconsistent,
        "deterministic_ids_unique": len({c.id for c in chunks}) == len(chunks),
        "extraction_status": doc.status, "source_diagnostics": list(doc.diagnostics),
    }


def _gaps(values: list[int]):
    start = None
    for index, count in enumerate(values):
        if not count and start is None:
            start = index
        if count and start is not None:
            yield start, index
            start = None
    if start is not None:
        yield start, len(values)
