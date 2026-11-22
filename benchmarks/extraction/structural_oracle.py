"""Compare native anchors against independently authored source geometry."""
import json
from pathlib import Path

from benchmarks.extraction.run import normalize

ORACLE = Path(__file__).with_name('expected-layout.json')


def center_inside(bbox, origin, expected, height):
    if bbox is None or origin not in ('TOPLEFT', 'BOTTOMLEFT'):
        return False
    left, top, right, bottom = bbox
    x, y = (left + right) / 2, (top + bottom) / 2
    if origin == 'TOPLEFT':
        y = height - y
    l, b, r, t = expected
    return l <= x <= r and b <= y <= t


def score_layout(doc, name, height):
    spec = json.loads(ORACLE.read_text())['documents'][name]
    regions, cells = [], []
    for exp in spec['regions']:
        matches = [b for b in doc.blocks if normalize(b.text) == exp['text']]
        page_matches = [(b, loc) for b in matches for loc in b.native.locations
                        if loc.page == exp['page']]
        regions.append({
            'text': exp['text'], 'kind': exp['kind'], 'page': exp['page'],
            'text_page_match': bool(page_matches),
            'kind_match': any(b.kind == exp['kind'] for b, _ in page_matches),
            'geometry_match': any(center_inside(loc.bbox, loc.coordinate_origin,
                                                exp['bbox'], height) for _, loc in page_matches),
        })
    for exp in spec['cells']:
        matches = [(b, c) for b in doc.blocks for c in b.cells
                   if normalize(c.text) == exp['text'] and b.page == exp['page']]
        cells.append({
            'text': exp['text'], 'page': exp['page'], 'row': exp['row'],
            'column': exp['column'],
            'text_page_match': bool(matches),
            'topology_match': any(c.native.row_range == tuple(exp['row'])
                                  and c.native.col_range == tuple(exp['column']) for _, c in matches),
            'geometry_match': any(center_inside(c.native.cell_bbox,
                                                c.native.cell_coordinate_origin,
                                                exp['bbox'], height) for _, c in matches),
        })
    return {'regions': regions, 'cells': cells}
