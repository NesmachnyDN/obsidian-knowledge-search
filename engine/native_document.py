"""Canonical mapping of native Docling items, not Markdown reconstruction.

Optional dependency: this module is used only by the extraction experiment.
"""
from dataclasses import replace
import math
import re

from engine.document import Cell, NativeAnchor, NativeLocation, ParsedBlock, ParsedDocument

MAX_BLOCKS = 8192
MAX_CHARS = 1_000_000
CLAUSE = re.compile(r'^(REQ-[A-Za-z0-9-]+|[0-9]+(?:\.[0-9]+)+):')


def _bbox(value):
    coords = (value.l, value.t, value.r, value.b)
    if not all(math.isfinite(v) for v in coords):
        raise ValueError('nonfinite native geometry')
    return coords, value.coord_origin.value


def _locations(item, document):
    result = []
    for prov in item.prov:
        bbox, origin = _bbox(prov.bbox)
        page = document.pages.get(prov.page_no)
        if page is None or prov.page_no < 1:
            raise ValueError('unknown native page')
        left, top, right, bottom = bbox
        if (not 0 <= left <= right <= page.size.width + 0.1
                or not 0 <= min(top, bottom) <= max(top, bottom) <= page.size.height + 0.1):
            raise ValueError('native geometry outside page')
        start, end = prov.charspan
        if not 0 <= start <= end:
            raise ValueError('invalid native char span')
        if hasattr(item, 'text') and end > max(len(item.text), len(item.orig or '')):
            raise ValueError('native char span outside item')
        result.append(NativeLocation(prov.page_no, bbox, origin, (start, end)))
    return tuple(result)


def furniture_kind(item, document):
    """Resolve Docling's native header/footer group, not text heuristics."""
    if item.content_layer.value != 'furniture':
        return None
    parent = item.parent
    seen = set()
    while parent is not None:
        ref = parent.cref
        if ref in seen or len(seen) >= 64:
            raise ValueError('invalid native parent chain')
        seen.add(ref)
        node = parent.resolve(document)
        name = getattr(node, 'name', None)
        if name in ('page header', 'page footer'):
            return name.replace(' ', '_')
        parent = node.parent
    return None


def map_document(document, path, digest, profile, diagnostics=(), *,
                 require_page_anchors: bool, text_representation='native-text'):
    from docling_core.types.doc import ContentLayer, ListItem, SectionHeaderItem, TableItem, TextItem

    blocks, headings, issues = [], [], set(diagnostics)
    table_number = 0
    for item, _ in document.iterate_items(
            included_content_layers=set(ContentLayer), traverse_pictures=True):
        ref = item.self_ref
        layer = item.content_layer.value
        label = item.label.value
        locations = _locations(item, document)
        # PDF text and tables require page provenance; unlike DOCX, an
        # unlocated item is incomplete source evidence, even if text survived.
        if require_page_anchors and not locations and (
            isinstance(item, TextItem) and bool(item.text.strip())
            or isinstance(item, TableItem) and any(c.text.strip() for c in item.data.table_cells)
        ):
            issues.add('native-page-location-missing')
        anchor = NativeAnchor(ref, layer, text_representation, locations)
        page = locations[0].page if len(locations) == 1 else None
        bbox = locations[0].bbox if len(locations) == 1 else None
        hierarchy = tuple(v for _, v in headings) if layer == 'body' else ()
        if isinstance(item, TableItem):
            table_number += 1
            if not (0 <= item.data.num_rows <= MAX_BLOCKS and 0 <= item.data.num_cols <= MAX_BLOCKS):
                raise ValueError('native table bound')
            rows = [[] for _ in range(item.data.num_rows)]
            for entry in item.data.table_cells:
                r0, r1 = entry.start_row_offset_idx, entry.end_row_offset_idx
                c0, c1 = entry.start_col_offset_idx, entry.end_col_offset_idx
                if not (0 <= r0 < r1 <= len(rows) and 0 <= c0 < c1 <= item.data.num_cols):
                    raise ValueError('invalid native cell range')
                cell_bbox, origin = _bbox(entry.bbox) if entry.bbox is not None else (None, None)
                cell_anchor = NativeAnchor(ref, layer, ('ocr-table-cell' if text_representation == 'ocr-native-text'
                                                       else 'native-table-cell'), (),
                                           (r0, r1), (c0, c1), cell_bbox, origin)
                rows[r0].append(Cell(c0 + 1, entry.text, None, cell_anchor))
            for row_number, row in enumerate(rows, 1):
                cells = tuple(sorted(row, key=lambda cell: cell.column))
                block_anchor = replace(anchor, representation=('ocr-table-cell-serialization'
                                       if text_representation == 'ocr-native-text'
                                       else 'table-cell-serialization'),
                                       row_range=(row_number - 1, row_number))
                blocks.append(ParsedBlock(path, digest, len(blocks), 'table_row',
                                          ' | '.join(c.text for c in cells), None, hierarchy,
                                          cells, table_number, row_number, page=page, bbox=bbox,
                                          native=block_anchor))
        elif isinstance(item, TextItem):
            text = item.text
            kind = {'section_header': 'heading', 'title': 'heading',
                    'page_header': 'page_header', 'page_footer': 'page_footer',
                    'list_item': 'list_item'}.get(label, 'paragraph')
            if label not in ('page_header', 'page_footer'):
                kind = furniture_kind(item, document) or kind
            # Docling removes list markers from text while retaining orig.
            # Preserve its actual evidence, not an invented bullet or number.
            if isinstance(item, ListItem) and item.orig != item.text:
                text = item.orig
                anchor = replace(anchor, representation=(
                    'ocr-native-original-text' if text_representation == 'ocr-native-text'
                    else 'native-original-text'))
                if item.enumerated and locations:
                    issues.add('numbered-list-heading-ambiguous')
            clause = CLAUSE.match(text)
            if clause and layer == 'body' and kind in ('heading', 'paragraph', 'list_item'):
                if kind != 'paragraph':
                    issues.add('native-clause-label-conflict')
                kind = 'clause'
            # Do not allow a misclassified requirement to become a section ancestor.
            if kind == 'heading' and isinstance(item, SectionHeaderItem) and layer == 'body':
                level = item.level
                headings = [(k, v) for k, v in headings if k < level]
                headings.append((level, text))
                hierarchy = tuple(v for _, v in headings)
            elif kind == 'heading' and label == 'title' and layer == 'body':
                headings = [(0, text)]
                hierarchy = (text,)
            blocks.append(ParsedBlock(path, digest, len(blocks), kind, text, None, hierarchy,
                                      clause=clause[1] if clause else None, page=page, bbox=bbox,
                                      native=replace(anchor, original_text=item.orig)))
        else:
            issues.add('unmapped-native-item:' + label)
        if len(blocks) > MAX_BLOCKS:
            raise ValueError('native block bound')
    if sum(len(b.text) for b in blocks) > MAX_CHARS:
        raise ValueError('native text bound')
    meaningful = any(block.text.strip() for block in blocks)
    # A successfully processed textless source is empty even when the chosen
    # extraction profile reports structural limitations or other warnings.
    status = ('empty' if not meaningful else 'partial' if issues else 'ok')
    if not meaningful:
        issues.add('no-extracted-text')
    return ParsedDocument(path, digest, status, tuple(blocks), tuple(sorted(issues)),
                          extraction_profile=profile, page_count=len(document.pages) or None)
