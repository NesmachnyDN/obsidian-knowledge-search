"""Dependency-free canonical/profile boundary regression tests."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.document import NativeAnchor, NativeLocation, ParsedBlock
from engine.extraction import DOCX, PDF, extract
from engine.scope import ScopedReader


class NativeBoundaryTests(unittest.TestCase):
    def test_canonical_native_evidence_has_no_fabricated_byte_span(self):
        loc = NativeLocation(1, (10, 20, 30, 40), 'TOPLEFT', (0, 3))
        block = ParsedBlock('synthetic.pdf', 'digest', 0, 'paragraph', 'abc', None, (),
                            page=1, bbox=loc.bbox,
                            native=NativeAnchor('#/texts/0','body','native-text',(loc,)))
        self.assertIsNone(block.span)
        self.assertEqual(block.native.locations, (loc,))

    def test_explicit_profile_and_scoped_read_boundaries(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/'a.md').write_text('synthetic')
            (root/'oversize.pdf').write_bytes(b'x'*65537)
            (root/'link.pdf').symlink_to(root/'a.md')
            reader=ScopedReader(root)
            try:
                self.assertEqual(extract(reader,'a.md',PDF).status,'unsupported')
                self.assertEqual(extract(reader,'a.md',DOCX).status,'unsupported')
                for path in ('../a.pdf','oversize.pdf','link.pdf'):
                    self.assertEqual(extract(reader,path,PDF).status,'failed')
            finally:
                reader.close()

    def test_full_profile_does_not_fallback(self):
        from engine.extraction import STRUCTURED_PDF
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'bad.pdf').write_bytes(b'%PDF-1.7\ninvalid')
            reader = ScopedReader(root)
            try:
                doc = extract(reader, 'bad.pdf', STRUCTURED_PDF, artifacts=root)
                self.assertEqual(doc.status, 'failed')
                self.assertEqual(doc.extraction_profile, STRUCTURED_PDF)
                self.assertEqual(doc.blocks, ())
            finally:
                reader.close()

    def test_model_artifact_validation(self):
        from engine.model_artifacts import verify_artifacts, verify_file
        from hashlib import sha256
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            p = root / 'model.safetensors'
            p.write_bytes(b'abc')
            record = {'bytes': 3, 'sha256': sha256(b'abc').hexdigest()}
            verify_file(p, record)
            p.write_bytes(b'xyz')
            with self.assertRaises(ValueError):
                verify_file(p, record)
            with self.assertRaises(ValueError):
                verify_artifacts(root)
