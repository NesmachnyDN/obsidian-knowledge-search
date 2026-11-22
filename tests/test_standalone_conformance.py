import json
import hashlib
import pathlib
import unittest
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from engine.markdown import parse_markdown
from engine.retrieval import parse_typed_properties, RetrievalError

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURE = json.loads((ROOT / 'contracts/fixtures/standalone-v2.json').read_text(encoding='utf-8'))


class StandaloneCrossRuntimeConformance(unittest.TestCase):
    def test_markdown_source_identity_and_provenance(self):
        self.assertEqual(FIXTURE['version'], 'oks-04a-lexical-contract-v1')
        for case in FIXTURE['cases']:
            with self.subTest(case=case['path']):
                raw = case['text'].encode('utf-8')
                self.assertEqual(hashlib.sha256(raw).hexdigest(), case['sha256'])
                doc = parse_markdown(case['path'], raw)
                self.assertEqual(doc.digest, case['sha256'])
                self.assertEqual(doc.status, case['referenceParserStatus'])
                self.assertEqual(len(doc.blocks), len(case['blocks']))
                for block, wanted in zip(doc.blocks, case['blocks']):
                    span = block.span
                    self.assertIsNotNone(span)
                    self.assertEqual(block.kind, wanted['kind'])
                    self.assertEqual(block.text, wanted['text'])
                    self.assertEqual(block.headings, tuple(wanted['headings']))
                    self.assertEqual(block.wiki_links, tuple(wanted['wikiLinks']))
                    self.assertEqual(span.start, wanted['byteStart'])
                    self.assertEqual(span.end, wanted['byteEnd'])
                    self.assertEqual(span.line_start, wanted['lineStart'])
                    self.assertEqual(len(raw[:span.start].decode()), wanted['charStart'])
                    self.assertEqual(len(raw[:span.end].decode()), wanted['charEnd'])
                    self.assertEqual(raw[span.start:span.end].decode(), block.text)

    def test_python_reference_rejects_ambiguous_typed_values(self):
        for case in FIXTURE['cases']:
            with self.subTest(case=case['path']):
                doc = parse_markdown(case['path'], case['text'].encode())
                if case['invalidTypedProperties']:
                    with self.assertRaises(RetrievalError) as context:
                        parse_typed_properties(doc)
                    self.assertEqual(context.exception.code, 'PROPERTY_INCOMPATIBLE')
                else:
                    parse_typed_properties(doc)


if __name__ == '__main__':
    unittest.main()
