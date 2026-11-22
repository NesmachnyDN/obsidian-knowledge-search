"""Bounded in-memory FTS5 baseline over canonical source blocks.

No persistent index, fake dense records, network, or query-language execution.
"""
import re
import sqlite3

from engine.document import ParsedBlock, ParsedDocument
from engine.markdown import parse_markdown
from engine.scope import ScopedReader

MAX_BLOCKS = 8192
MAX_SOURCES = 128
MAX_QUERY_BYTES = 512
MAX_RESULTS = 50
TERM = re.compile(r'/[^\W_]+(?:[._/-][^\W_]+)*|[^\W_]+(?:[._/-][^\W_]+)*', re.UNICODE)
EXCLUDED = frozenset({'blank', 'table_separator', 'property'})


def _terms(text: str) -> list[str]:
    # Whole technical terms have exact equality, without FTS punctuation splitting.
    # ASCII hex encoding keeps arbitrary Unicode casefolded terms SQL/FTS safe.
    return ['x' + match.group().casefold().encode().hex() for match in TERM.finditer(text)]


class LexicalIndex:
    def __init__(self, reader: ScopedReader, documents: tuple[ParsedDocument, ...]):
        if len(documents) > MAX_SOURCES or sum(len(d.blocks) for d in documents) > MAX_BLOCKS:
            raise ValueError('index bound')
        self.reader = reader
        self.blocks: dict[int, ParsedBlock] = {}
        self.db = sqlite3.connect(':memory:')
        try:
            self.db.execute('CREATE VIRTUAL TABLE lexical USING fts5(terms)')
            paths = set()
            for doc in sorted(documents, key=lambda item: item.path):
                if doc.path in paths:
                    raise ValueError('duplicate source path')
                paths.add(doc.path)
                if doc.status not in ('ok', 'partial'):
                    continue
                source = reader.read(doc.path)
                if source.digest != doc.digest:
                    raise ValueError('stale source')
                # This baseline accepts only Markdown canonicalization. Validate
                # all derived metadata (not just line text), including cell spans,
                # hierarchy, document status and diagnostics, against actual bytes.
                if parse_markdown(doc.path, source.data) != doc:
                    raise ValueError('inconsistent canonical Markdown or locator')
                malformed_front = 'unterminated-front-matter' in doc.diagnostics
                for block in doc.blocks:
                    if block.kind in EXCLUDED and not (
                            block.kind == 'property' and malformed_front):
                        continue
                    terms = _terms(' '.join((*block.headings, block.text)))
                    if not terms:
                        continue
                    key = len(self.blocks) + 1
                    self.blocks[key] = block
                    self.db.execute('INSERT INTO lexical(rowid, terms) VALUES (?,?)',
                                    (key, ' '.join(terms)))
            self.db.commit()
        except BaseException:
            self.db.close()
            raise

    def search(self, query: str, limit: int = 10) -> tuple[ParsedBlock, ...]:
        if type(query) is not str or len(query.encode()) > MAX_QUERY_BYTES:
            raise ValueError('query bound')
        if type(limit) is not int or not 1 <= limit <= MAX_RESULTS:
            raise ValueError('result bound')
        terms = list(dict.fromkeys(_terms(query)))
        if not terms:
            return ()
        expression = ' OR '.join('"' + item + '"' for item in terms)
        # Entire candidate set is bounded by MAX_BLOCKS. Check freshness before K.
        ranked = self.db.execute(
            'SELECT rowid FROM lexical WHERE lexical MATCH ? ORDER BY bm25(lexical), rowid',
            (expression,))
        checked: dict[str, bool] = {}
        results = []
        for (key,) in ranked:
            block = self.blocks[key]
            if block.path not in checked:
                checked[block.path] = self.reader.fresh(block.path, block.digest)
            if checked[block.path]:
                results.append(block)
                if len(results) == limit:
                    break
        return tuple(results)

    def size_bytes(self) -> int:
        return self.db.execute('PRAGMA page_count').fetchone()[0] * self.db.execute(
            'PRAGMA page_size').fetchone()[0]

    def close(self) -> None:
        self.db.close()
