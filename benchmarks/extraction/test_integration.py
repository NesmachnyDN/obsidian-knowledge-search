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
