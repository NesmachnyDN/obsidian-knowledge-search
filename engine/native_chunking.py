"""Native Docling HybridChunker comparison against the *same* canonical blocks.

The projected DoclingDocument is an experiment input adapter, not re-extraction.
Table serialization and native semchunk spans may differ from canonical originals.
Unaligned items are deliberately NOT credited as source coverage.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from engine.chunking import (Chunk, ChunkPolicy, SourceSlice, make_chunk,
                             _tail_overlap, _validate_document)
from engine.document import ParsedBlock, ParsedDocument
from engine.token_budget import ExactTokenizer


@dataclass(frozen=True)
class NativeComparison:
    chunks: tuple[Chunk, ...]
    unaligned_chunks: tuple[dict, ...]
    native_output_count: int
    native_serialization: str
    overlap_applied: bool


def _add_table(target, rows: list[ParsedBlock]):
    from docling_core.types.doc import TableCell, TableData
    cells = []
    max_columns = 0
    row_size = len(rows)
    for i, row in enumerate(rows):
        for cell in row.cells:
            anchor = cell.native
            r0, r1 = anchor.row_range if anchor and anchor.row_range else (i, i + 1)
            c0, c1 = anchor.col_range if anchor and anchor.col_range else (cell.column - 1, cell.column)
            if r0 < 0 or r1 > row_size or c0 < 0 or c1 <= c0:
                raise ValueError("invalid canonical table cell range")
            cells.append(TableCell(text=cell.text, start_row_offset_idx=r0,
                                   end_row_offset_idx=r1, start_col_offset_idx=c0,
                                   end_col_offset_idx=c1, row_span=r1-r0, col_span=c1-c0,
                                   column_header=(i == 0)))
            max_columns = max(max_columns, c1)
    if not cells:
        raise ValueError("cannot project table without cells")
    return target.add_table(TableData(table_cells=cells, num_rows=row_size,
                                      num_cols=max_columns))


def project_blocks(doc: ParsedDocument):
    """Provenance-indexed native projection; never infer PDF/DOCX byte offsets."""
    from docling_core.types.doc import ContentLayer, DocItemLabel, DoclingDocument

    _validate_document(doc)
    native = DoclingDocument(name="synthetic-chunking-comparison")
    mapping: dict[str, tuple[int, ...]] = {}
    index = 0
    while index < len(doc.blocks):
        block = doc.blocks[index]
        if not block.text:
            index += 1
            continue
        if block.kind == "table_row" and block.table is not None and block.cells:
            rows = [block]
            k = index + 1
            while (k < len(doc.blocks) and doc.blocks[k].kind == "table_row"
                   and doc.blocks[k].table == block.table and doc.blocks[k].cells):
                rows.append(doc.blocks[k])
                k += 1
            try:
                item = _add_table(native, rows)
                mapping[item.self_ref] = tuple(row.order for row in rows)
                index = k
                continue
            except ValueError:
                pass  # Preserve unsupported table source text as literal items.
        if block.kind == "heading":
            item = native.add_heading(block.text, level=max(1, len(block.headings)))
        elif block.kind == "list_item":
            item = native.add_list_item(block.text, orig=block.text)
        else:
            layer = (ContentLayer.FURNITURE if block.kind in ("page_header", "page_footer")
                     else ContentLayer.BODY)
            label = (DocItemLabel.PAGE_HEADER if block.kind == "page_header" else
                     DocItemLabel.PAGE_FOOTER if block.kind == "page_footer" else
                     DocItemLabel.TEXT)
            item = native.add_text(label, block.text, orig=block.text,
                                   content_layer=layer)
        mapping[item.self_ref] = (block.order,)
        index += 1
    return native, mapping


def _align_item(doc: ParsedDocument, candidates: tuple[int, ...],
                native_text: str, item_count: int) -> tuple[SourceSlice, ...]:
    """Credit only verbatim uniquely anchored text. No fuzzy guessing."""
    result: list[SourceSlice] = []
    for order in candidates:
        source = doc.blocks[order].text
        if source and source in native_text:
            result.append(SourceSlice(order, 0, len(source)))
        elif len(candidates) == 1 and item_count == 1 and native_text:
            pos = source.find(native_text)
            if pos >= 0 and source.find(native_text, pos + 1) < 0:
                result.append(SourceSlice(order, pos, pos + len(native_text)))
    return tuple(result)


@lru_cache(maxsize=8)
def _native_chunker(snapshot: str, max_tokens: int):
    """Initialize a budget-specific, reusable native tokenizer once per process."""
    from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
    from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer
    from transformers import AutoTokenizer

    hf = AutoTokenizer.from_pretrained(snapshot, local_files_only=True,
                                       trust_remote_code=False, use_fast=True)
    if hf.name_or_path != snapshot:
        raise ValueError("native tokenizer identity mismatch")
    return HybridChunker(tokenizer=HuggingFaceTokenizer(tokenizer=hf,
                                                        max_tokens=max_tokens),
                         repeat_table_header=True, merge_peers=True)


def run_native(doc: ParsedDocument, policy: ChunkPolicy, tokenizer: ExactTokenizer,
               snapshot: Path, *, plugin_path: Path | None = None) -> NativeComparison:
    """Use Docling's actual HybridChunker with the verified BGE-M3 tokenizer.

    Optional chunking packages must be explicitly provisioned outside the
    repository; no installation or network access occurs here.
    """
    if policy.name != "native-hybrid":
        raise ValueError("native comparison requires native-hybrid policy")
    _validate_document(doc)
    if plugin_path is not None:
        # Used only by the benchmark runner with an operator-provisioned path.
        import sys
        if not plugin_path.is_dir():
            raise ValueError("missing provisioned chunking extras")
        if str(plugin_path) not in sys.path:
            sys.path.insert(0, str(plugin_path))
    native, mapping = project_blocks(doc)
    hybrid = _native_chunker(str(snapshot), policy.max_tokens)
    results, unaligned = [], []
    native_output_count = 0
    for index, native_chunk in enumerate(hybrid.chunk(dl_doc=native)):
        native_output_count += 1
        raw = native_chunk.text
        items = native_chunk.meta.doc_items
        fragments: list[SourceSlice] = []
        for item in items:
            if item.self_ref not in mapping:
                unaligned.append({"index": index, "cause": "unknown-projected-item"})
                continue
            aligned = _align_item(doc, mapping[item.self_ref], raw, len(items))
            if not aligned:
                unaligned.append({"index": index, "cause": "native-item-not-verbatim-aligned"})
            fragments.extend(aligned)
        # Native headings move to contextual metadata rather than body text.
        # Align the nearest preceding canonical heading with exact literal text;
        # never resolve repeated names by text alone without source order.
        if fragments:
            first_order = min(s.block_order for s in fragments)
            for heading_text in native_chunk.meta.headings or []:
                matching = [b for b in doc.blocks[:first_order + 1]
                            if b.kind == "heading" and b.text == heading_text]
                if matching:
                    heading_block = matching[-1]
                    fragments.append(SourceSlice(heading_block.order, 0, len(heading_text)))
        fragments = list(dict.fromkeys(fragments))
        contextual = policy.literal_prefix + hybrid.contextualize(native_chunk)
        if not fragments:
            unaligned.append({"index": index, "cause": "native-text-has-no-exact-canonical-alignment",
                              "token_count": tokenizer.count(contextual)})
            continue
        prefix = contextual[:-len(raw)] if raw and contextual.endswith(raw) else ""
        chunk = make_chunk(doc, tuple(sorted(fragments, key=lambda x: (x.block_order, x.start))),
                           policy, tokenizer, embedding_override=contextual,
                           prefix_override=prefix,
                           diagnostics=("native-canonical-projection",))
        results.append(chunk)
    # Native Docling has no native overlap option; separately apply a visible
    # canonical tail-overlap adapter without hiding native serialization.
    overlap_added = False
    if policy.overlap_tokens:
        augmented = [results[0]] if results else []
        for current in results[1:]:
            previous = augmented[-1]
            tail = _tail_overlap(doc, previous, policy, tokenizer)
            if tail and doc.blocks[tail.block_order].headings == current.headings:
                extra = doc.blocks[tail.block_order].text[tail.start:tail.end]
                embed = extra + "\n" + current.embedding_text
                if tokenizer.count(embed) <= policy.max_tokens:
                    current = make_chunk(doc, (tail,) + current.slices, policy,
                                         tokenizer, embedding_override=embed,
                                         prefix_override=extra + "\n",
                                         diagnostics=("native-canonical-projection",
                                                      "native-overlap-adapter"))
                    overlap_added = True
            augmented.append(current)
        results = augmented
    return NativeComparison(tuple(results), tuple(unaligned),
                            native_output_count,
                            "Docling HybridChunker.contextualize; optional explicit canonical-tail overlap",
                            overlap_applied=overlap_added)
