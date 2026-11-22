"""Run actual optional extraction dependency integration tests offline."""
import hashlib
from io import BytesIO
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from engine.extraction import DOCX, PDF, STRUCTURED_PDF, extract
from engine.scope import ScopedReader


class ExtractionIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if {name for _, name in socket.if_nameindex()} - {'lo'}:
            raise RuntimeError('offline namespace required')

    def test_native_profiles_keep_structure_and_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixtures = Path(__file__).resolve().parent / 'fixtures'
            for name in ('policy.docx', 'policy.pdf'):
                (root / name).write_bytes((fixtures / name).read_bytes())
            reader = ScopedReader(root)
            try:
                doc = extract(reader, 'policy.docx', DOCX)
                self.assertEqual(doc.status, 'ok')
                self.assertEqual(doc.digest, hashlib.sha256((root/'policy.docx').read_bytes()).hexdigest())
                self.assertEqual(len([b for b in doc.blocks if b.kind == 'heading']), 3)
                self.assertEqual([(b.kind,b.text) for b in doc.blocks if b.native.content_layer=='furniture'],
                                 [('page_header','Synthetic header'),('page_footer','Synthetic footer')])
                self.assertTrue(any(c.native.col_range == (0, 2) for b in doc.blocks for c in b.cells))
                self.assertTrue(all(b.span is None and b.native for b in doc.blocks))
                pdf = extract(reader, 'policy.pdf', PDF)
                self.assertEqual(pdf.status, 'partial')
                self.assertEqual(pdf.page_count, 2)
                self.assertTrue(all(b.native.locations for b in pdf.blocks))
                self.assertIn('native-pdf-layout-tables-reading-order-not-inferred', pdf.diagnostics)
                missing = extract(reader, 'policy.pdf', STRUCTURED_PDF, artifacts=root)
                self.assertEqual(missing.status, 'failed')
                self.assertEqual(missing.extraction_profile, STRUCTURED_PDF)
                self.assertFalse(missing.blocks)
            finally:
                reader.close()

    def test_native_list_marker_and_clause_label_conflict(self):
        from docling_core.types.doc import DoclingDocument
        from engine.native_document import map_document
        doc = DoclingDocument(name='synthetic')
        doc.add_heading(text='Section', level=1)
        doc.add_heading(text='REQ-SYN-100: Keep evidence.', level=2)
        doc.add_list_item(text='Evidence', orig='2. Evidence', marker='2.', enumerated=True)
        parsed = map_document(doc, 'synthetic.pdf', 'digest', STRUCTURED_PDF,
                              require_page_anchors=False)
        self.assertEqual(parsed.status, 'partial')
        self.assertIn('native-clause-label-conflict', parsed.diagnostics)
        self.assertEqual(parsed.blocks[1].kind, 'clause')
        self.assertEqual(parsed.blocks[1].clause, 'REQ-SYN-100')
        self.assertEqual(parsed.blocks[2].headings, ('Section',))
        self.assertEqual(parsed.blocks[2].text, '2. Evidence')
        self.assertEqual(parsed.blocks[2].native.representation, 'native-original-text')

    def test_structured_pdf_missing_page_location_is_partial(self):
        from docling_core.types.doc import DocItemLabel, DoclingDocument
        from engine.native_document import map_document
        document = DoclingDocument(name='synthetic')
        document.add_text(label=DocItemLabel.TEXT, text='Unlocated evidence')
        parsed = map_document(document, 'unlocated.pdf', 'digest', STRUCTURED_PDF,
                              require_page_anchors=True)
        self.assertEqual(parsed.status, 'partial')
        self.assertIn('native-page-location-missing', parsed.diagnostics)
        self.assertEqual(parsed.blocks[0].text, 'Unlocated evidence')
        self.assertFalse(parsed.blocks[0].native.locations)

    def test_blank_scanned_pdf_is_empty_not_failed(self):
        from pypdf import PdfWriter
        from unittest.mock import patch
        from engine.extraction import OCR
        output = BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=300, height=200)
        writer.write(output)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'blank.pdf').write_bytes(output.getvalue())
            reader = ScopedReader(root)
            try:
                with patch('engine.ocr._lines', return_value=iter(())):
                    parsed = extract(reader, 'blank.pdf', OCR, tessdata=root)
                self.assertEqual(parsed.status, 'empty')
                self.assertEqual(parsed.page_count, 1)
                self.assertEqual(parsed.blocks, ())
                self.assertIn('no-extracted-text', parsed.diagnostics)
            finally:
                reader.close()

    def test_empty_native_document_is_explicit(self):
        from docx import Document
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            Document().save(root / 'empty.docx')
            reader = ScopedReader(root)
            try:
                doc = extract(reader, 'empty.docx', DOCX)
                self.assertEqual(doc.status, 'empty')
                self.assertIn('no-extracted-text', doc.diagnostics)
            finally:
                reader.close()

    def test_archive_expansion_and_pdf_page_bounds(self):
        from pypdf import PdfWriter
        from zipfile import ZIP_DEFLATED
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            reader = ScopedReader(root)
            try:
                zip_bytes = BytesIO()
                with ZipFile(zip_bytes, 'w', compression=ZIP_DEFLATED) as archive:
                    archive.writestr('[Content_Types].xml', b'<Types/>')
                    archive.writestr('word/document.xml', b'<document/>')
                    archive.writestr('word/expanded.xml', b'A' * (8 * 1024 * 1024 + 1))
                (root / 'bomb.docx').write_bytes(zip_bytes.getvalue())
                self.assertLess(len(zip_bytes.getvalue()), 65536)
                self.assertEqual(extract(reader, 'bomb.docx', DOCX).status, 'failed')
                writer = PdfWriter()
                for _ in range(9):
                    writer.add_blank_page(width=300, height=200)
                output = BytesIO()
                writer.write(output)
                (root / 'long.pdf').write_bytes(output.getvalue())
                self.assertEqual(extract(reader, 'long.pdf', PDF).status, 'failed')
            finally:
                reader.close()

    def test_docx_rejects_traversal_and_external_relationship(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            reader = ScopedReader(root)
            try:
                for name, content in (
                    ('../escape', b'bad'),
                    ('word/_rels/document.xml.rels',
                     b'<Relationships><Relationship TargetMode="External" Target="https://example.invalid/"/></Relationships>'),
                ):
                    buf = BytesIO()
                    with ZipFile(buf, 'w') as z:
                        z.writestr('[Content_Types].xml', b'<Types/>')
                        z.writestr('word/document.xml', b'<document/>')
                        z.writestr(name, content)
                    (root/'bad.docx').write_bytes(buf.getvalue())
                    doc = extract(reader, 'bad.docx', DOCX)
                    self.assertEqual(doc.status, 'failed')
                    self.assertEqual(doc.diagnostics, ('extraction-error:ValueError',))
            finally:
                reader.close()


if __name__ == '__main__':
    unittest.main()
