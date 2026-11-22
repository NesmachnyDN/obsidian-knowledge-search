"""Bounded physical-line Markdown baseline, not a complete Markdown renderer."""
import hashlib
import re

from engine.document import Cell, ParsedBlock, ParsedDocument, Span, physical_lines
from engine.scope import ScopedReader

MAX_BYTES = 8192  # Same source size as the Foundation freshness check.
HEADING = re.compile(r'^(#{1,6})[ \t]+(.+)$')
CLAUSE = re.compile(r'^(REQ-[A-Za-z0-9-]+|[0-9]+(?:\.[0-9]+)+):')
LIST = re.compile(r'^\s*(?:[-+*]|\d+[.)])\s+')
PROPERTY = re.compile(r'^([A-Za-z_][\w-]*):[ \t]*(.*)$')
SEPARATOR = re.compile(r'\s*:?-{3,}:?\s*')
LINK = re.compile(r'\[\[([^\]\n]+)\]\]')


def _cells(text: str, span: Span) -> tuple[Cell, ...]:
    if '\\|' in text or '`' in text:
        return ()  # Caller reports unsupported table syntax.
    parts = text.split('|')[1:-1]
    offset = text.index('|') + 1
    result = []
    for i, part in enumerate(parts, 1):
        start = span.start + len(text[:offset].encode())
        result.append(Cell(i, part, Span(start, start + len(part.encode()),
                                         span.line_start, span.line_end)))
        offset += len(part) + 1
    return tuple(result)


def parse_markdown(path: str, data: bytes) -> ParsedDocument:
    if len(data) > MAX_BYTES:
        return ParsedDocument(path, None, 'failed', (), ('source-size',))
    digest = hashlib.sha256(data).hexdigest()
    if not path.lower().endswith('.md'):
        return ParsedDocument(path, digest, 'unsupported', (), ('format',))
    try:
        source = data.decode('utf-8', errors='strict')
    except UnicodeDecodeError:
        return ParsedDocument(path, digest, 'failed', (), ('invalid-utf8',))
    if '\x00' in source or source.startswith('\ufeff'):
        return ParsedDocument(path, digest, 'failed', (), ('unsupported-control-or-bom',))
    lines = list(physical_lines(data))
    diagnostics = set()
    blocks, properties, headings = [], [], []
    front = bool(lines and lines[0][1] == b'---')
    front_closed = not front
    table = row = 0
    in_table = False
    fence = None
    for span, raw_line in lines:
        n, text = span.line_start, raw_line.decode('utf-8')
        kind, cells, clause = 'paragraph', (), None
        if not text.strip():
            kind = 'blank'
        elif front:
            match = PROPERTY.fullmatch(text)
            if n == 1 or text == '---':
                kind = 'property'
                if n != 1:
                    front, front_closed = False, True
            elif match:
                kind = 'property'
                properties.append(match.groups())
            else:
                front = False
                diagnostics.add('unsupported-front-matter')
                # Keep malformed payload as ordinary evidence, not parsed metadata.
        if not front and kind == 'paragraph':
            if text.startswith(('```', '~~~')):
                marker = text[:3]
                fence = None if fence == marker else marker if fence is None else fence
                diagnostics.add('fenced-content-literal')
            elif fence:
                pass
            elif match := HEADING.match(text):
                level, label = len(match[1]), match[2]
                headings = [(k, h) for k, h in headings if k < level]
                headings.append((level, label))
                kind = 'heading'
            elif match := CLAUSE.match(text):
                kind, clause = 'clause', match[1]
            elif text.strip().startswith('|') and text.strip().endswith('|'):
                cells = _cells(text, span)
                kind = ('table_separator' if cells and all(
                    SEPARATOR.fullmatch(cell.text) for cell in cells) else 'table_row')
                if not cells:
                    diagnostics.add('unsupported-table-syntax')
            elif LIST.match(text):
                kind = 'list_item'
            elif re.search(r'<[A-Za-z!/]', text) or text.startswith(('>', '    ', '\t')):
                diagnostics.add('unsupported-markup-literal')
        if kind in ('table_row', 'table_separator'):
            if not in_table:
                table, row, in_table = table + 1, 0, True
            if kind == 'table_row':
                row += 1
        else:
            in_table = False
        blocks.append(ParsedBlock(path, digest, len(blocks), kind, text, span,
                                  tuple(h for _, h in headings), cells,
                                  table if in_table else None,
                                  row if kind == 'table_row' else None, clause,
                                  tuple(LINK.findall(text))))
    if not front_closed:
        diagnostics.add('unterminated-front-matter')
        properties = []  # Never expose malformed values as authoritative metadata.
    if fence:
        diagnostics.add('unterminated-fence')
    status = ('partial' if diagnostics else 'ok' if source.strip() else 'empty')
    return ParsedDocument(path, digest, status, tuple(blocks),
                          tuple(sorted(diagnostics)), tuple(properties))


def read_markdown(reader: ScopedReader, path: str) -> ParsedDocument:
    try:
        source = reader.read(path, MAX_BYTES)
    except (OSError, ValueError):
        return ParsedDocument(path, None, 'failed', (), ('source-read-rejected',))
    return parse_markdown(path, source.data)
