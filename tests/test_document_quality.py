"""Synthetic-only canonical extraction and lexical baseline behavior."""
import dataclasses
import tempfile
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from benchmarks.corpus_v1 import ROOT, validate
from benchmarks.lexical_metrics import metrics
from benchmarks.oks02a import run
from engine.document import Span
from engine.lexical import LexicalIndex
from engine.markdown import MAX_BYTES, parse_markdown, read_markdown
from engine.scope import ScopedReader


class DocumentTest(unittest.TestCase):
    def test_exact_crlf_unicode_and_cells(self):
        raw = '# Тест\r\n## Раздел\r\n| А | B |\r\n| --- | --- |\r\n| ё | 🚀 |\r\n\r\nREQ-1: текст'.encode()
        doc = parse_markdown('sample.md', raw)
        self.assertEqual(doc.status, 'ok')
        self.assertEqual(doc.blocks[-1].clause, 'REQ-1')
        self.assertEqual(doc.blocks[-1].headings, ('Тест', 'Раздел'))
        self.assertEqual(doc.blocks[-1].span.line_start, 7)
        self.assertEqual(doc.blocks[4].row, 2)
        for block in doc.blocks:
            self.assertEqual(raw[block.span.start:block.span.end], block.text.encode())
            for cell in block.cells:
                self.assertEqual(raw[cell.span.start:cell.span.end], cell.text.encode())
        self.assertEqual(doc.blocks[5].kind, 'blank')
        self.assertEqual(doc.blocks[4].cells[1].text, ' 🚀 ')

    def test_properties_links_and_partial(self):
        doc = parse_markdown('x.md', b'---\nstatus: accepted\n---\n# Title\nSee [[note|alias]]')
        self.assertEqual(doc.properties, (('status', 'accepted'),))
        self.assertEqual(doc.blocks[-1].wiki_links, ('note|alias',))
        doc = parse_markdown('x.md', b'---\nstatus: bad\nno close')
        self.assertEqual(doc.properties, ())
        self.assertEqual(doc.status, 'partial')
        self.assertEqual(doc.blocks[-1].text, 'no close')
        self.assertEqual(parse_markdown('x.md', b'```\n# literal').status, 'partial')
        self.assertEqual(parse_markdown('x.md', b'| a\\|b |').status, 'partial')

    def test_fences_do_not_create_headings(self):
        data = (b'# Outer\n  ~~~~ code\n# literal\n  ~~~\n'
                b'## still literal\n  ~~~~\n## Real\ntext')
        doc = parse_markdown('x.md', data)
        self.assertEqual(doc.status, 'partial')
        self.assertEqual(doc.diagnostics, ('fenced-content-literal',))
        self.assertEqual([b.text for b in doc.blocks if b.kind == 'heading'],
                         ['# Outer', '## Real'])
        self.assertEqual(doc.blocks[4].headings, ('Outer',))
        self.assertEqual(doc.blocks[-1].headings, ('Outer', 'Real'))

    def test_unsupported_structures_are_diagnosed(self):
        for data, diagnostic in (
                (b'| standalone |', 'unsupported-table-structure'),
                (b'| a | b |\n| --- |\n| c |', 'unsupported-table-structure'),
                (b'| a | b |\n| --- | --- |\n| c |', 'unsupported-table-structure'),
                (b'Title\n=====', 'unsupported-setext-heading')):
            with self.subTest(data=data):
                doc = parse_markdown('x.md', data)
                self.assertEqual(doc.status, 'partial')
                self.assertIn(diagnostic, doc.diagnostics)
                for block in doc.blocks:
                    self.assertEqual(data[block.span.start:block.span.end], block.text.encode())

    def test_failure_and_empty(self):
        for data in (b'\xff', b'abc\x00', b'x' * (MAX_BYTES + 1)):
            self.assertEqual(parse_markdown('x.md', data).status, 'failed')
        self.assertEqual(parse_markdown('x.pdf', b'x').status, 'unsupported')
        self.assertEqual(parse_markdown('x.md', b'\n \n').status, 'empty')

    def test_frozen_oracle_and_tuning_invariants(self):
        self.assertEqual(len(validate()[0]['sources']), 21)
        result = run('tuning')
        self.assertEqual(result['structure']['oracle_coverage'], 1)
        self.assertEqual(result['structure']['locator_errors'], 0)
        self.assertEqual(result['summary']['queries'], 15)
        self.assertEqual(result['structure']['statuses'], {'ok': 18, 'partial': 2, 'empty': 1})

    def test_metrics_known_example(self):
        result = metrics(['miss', 'good'], {'good': 2, 'other': 1}, 5)
        self.assertEqual(result['precision'], 0.2)
        self.assertEqual(result['recall'], 0.5)
        self.assertEqual(result['mrr'], 0.5)
        self.assertIsNone(metrics([], {}, 5))


class LexicalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'a.md').write_bytes(b'REQ-X-21: approved\nShared phrase')
        (self.root / 'b.md').write_bytes(b'REQ-X-210: rejected\nShared phrase')
        self.reader = ScopedReader(self.root)
        self.addCleanup(self.reader.close)
        self.docs = tuple(read_markdown(self.reader, p) for p in ('a.md', 'b.md'))
        self.index = LexicalIndex(self.reader, self.docs)
        self.addCleanup(self.index.close)

    def test_exact_and_deterministic(self):
        hits = self.index.search('REQ-X-21')
        self.assertEqual([b.path for b in hits], ['a.md'])
        second = LexicalIndex(self.reader, self.docs[::-1])
        self.addCleanup(second.close)
        self.assertEqual(second.search('Shared phrase'), self.index.search('Shared phrase'))
        self.assertEqual(self.index.search('unknownzzy'), ())
        self.assertEqual(self.index.search('" OR * NEAR('), ())
        for query, limit in [('x'*513, 1), ('x', 0), ('x', 51)]:
            with self.assertRaises(ValueError):
                self.index.search(query, limit)

    def test_stale_and_deleted(self):
        (self.root / 'a.md').write_bytes(b'changed')
        self.assertEqual(self.index.search('REQ-X-21'), ())
        (self.root / 'b.md').unlink()
        self.assertEqual(self.index.search('REQ-X-210'), ())
        self.assertEqual(self.index.search('Shared phrase'), ())

    def test_scope_and_forged_locator(self):
        (self.root / 'link.md').symlink_to(self.root / 'a.md')
        for path in ('../a.md', 'link.md', '/etc/passwd'):
            self.assertEqual(read_markdown(self.reader, path).status, 'failed')
        doc = self.docs[0]
        forged = dataclasses.replace(doc.blocks[0], text='forged')
        with self.assertRaises(ValueError):
            LexicalIndex(self.reader, (dataclasses.replace(doc, blocks=(forged, *doc.blocks[1:])),))
        with self.assertRaises(ValueError):
            LexicalIndex(self.reader, (dataclasses.replace(doc, blocks=doc.blocks[:1]),))

    def test_malformed_front_matter_remains_searchable(self):
        (self.root / 'bad.md').write_bytes(b'---\nrequirement: Encrypt payload\n')
        (self.root / 'good.md').write_bytes(b'---\nproperty: Encrypt payload\n---\n# Title')
        docs = tuple(read_markdown(self.reader, name) for name in ('bad.md', 'good.md'))
        self.assertEqual(docs[0].status, 'partial')
        self.assertEqual(docs[0].properties, ())
        self.assertEqual(docs[1].status, 'ok')
        with_index = LexicalIndex(self.reader, docs)
        self.addCleanup(with_index.close)
        self.assertEqual([(b.path, b.text) for b in with_index.search('encrypt')],
                         [('bad.md', 'requirement: Encrypt payload')])

    def test_rejects_forged_cell_and_heading_provenance(self):
        (self.root / 'table.md').write_bytes(b'| Name | Value |\n| --- | --- |\n| Alice | 12 |')
        doc = read_markdown(self.reader, 'table.md')
        row = doc.blocks[-1]
        cell = dataclasses.replace(row.cells[0], text='fabricated', span=Span(0, 1, 1, 1))
        for forged in (dataclasses.replace(row, cells=(cell, *row.cells[1:])),
                       dataclasses.replace(row, headings=('fabricated',)),
                       dataclasses.replace(row, page=99),
                       dataclasses.replace(row, kind='property')):
            with self.subTest(forged=forged), self.assertRaises(ValueError):
                LexicalIndex(self.reader, (dataclasses.replace(
                    doc, blocks=(*doc.blocks[:-1], forged)),))

    def test_manifest_rejects_mutation(self):
        import shutil
        target = self.root / 'corpus'
        shutil.copytree(ROOT, target)
        (target / 'held_out.json').write_text('[]')
        with self.assertRaisesRegex(ValueError, 'judgment digest'):
            validate(target)


if __name__ == '__main__':
    unittest.main()
