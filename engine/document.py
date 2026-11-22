"""Neutral source blocks; original evidence is distinct from derived metadata."""
from dataclasses import dataclass
import re
from typing import Literal


@dataclass(frozen=True)
class Span:
    # UTF-8 byte offsets, half-open; physical lines are one-based, inclusive.
    start: int
    end: int
    line_start: int
    line_end: int


@dataclass(frozen=True)
class Cell:
    column: int
    text: str
    span: Span


@dataclass(frozen=True)
class ParsedBlock:
    path: str
    digest: str
    order: int
    kind: str
    text: str
    span: Span
    headings: tuple[str, ...]
    cells: tuple[Cell, ...] = ()
    table: int | None = None
    row: int | None = None
    clause: str | None = None
    wiki_links: tuple[str, ...] = ()
    page: int | None = None
    bbox: tuple[float, float, float, float] | None = None


@dataclass(frozen=True)
class ParsedDocument:
    path: str
    digest: str | None
    status: Literal['ok', 'empty', 'partial', 'failed', 'unsupported']
    blocks: tuple[ParsedBlock, ...]
    diagnostics: tuple[str, ...] = ()
    properties: tuple[tuple[str, str], ...] = ()


def physical_lines(data: bytes):
    """Yield exact byte spans and bytes, excluding CRLF/CR/LF delimiters."""
    for n, match in enumerate(re.finditer(rb'[^\r\n]*(?:\r\n|\r|\n|$)', data), 1):
        if match.start() == match.end():
            break
        value = match.group().rstrip(b'\r\n')
        yield Span(match.start(), match.start() + len(value), n, n), value
