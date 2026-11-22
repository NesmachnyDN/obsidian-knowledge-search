"""02C chunk-to-source-line projection checks for 03B paired model benchmark."""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benchmarks.retrieval.chunk_policy_run import (
    decode_line_key, line_anchors, line_key, POLICIES, MAX_TOKENS,
)
from engine.chunking import ChunkPolicy, plan_chunks, coverage_report
from engine.markdown import parse_markdown


class UnitScalarCounter:
    """Test-only fake character counter; not an embedding or acceptance tokenizer."""

    def count(self, text: str) -> int:
        return len(text) + 2


class PolicyAnchorTests(unittest.TestCase):
    def test_immutable_canonical_original_lines_and_unicode_byte_offsets(self):
        raw = "# Глава 🚀\r\nREQ-ID-21: Реальный исходный текст\r\n".encode()
        doc = parse_markdown("unicode.md", raw)
        for name in POLICIES:
            with self.subTest(policy=name):
                tokenizer = UnitScalarCounter()
                chunks = plan_chunks(doc, ChunkPolicy(name, MAX_TOKENS, 0), tokenizer)
                all_anchors = set()
                for chunk in chunks:
                    anchors = line_anchors(doc, chunk)
                    self.assertTrue(anchors)
                    all_anchors.update(anchors)
                    for source_slice, locator in zip(chunk.slices, chunk.locators, strict=True):
                        span = locator.file_bytes
                        self.assertIsNotNone(span)
                        original = doc.blocks[source_slice.block_order].text[
                            source_slice.start:source_slice.end]
                        self.assertEqual(raw[span.start:span.end].decode(), original)
                self.assertEqual(all_anchors, {("unicode.md", 1), ("unicode.md", 2)})
                report = coverage_report(doc, chunks, tokenizer)
                self.assertFalse(report["lost_spans"])
                self.assertEqual(report["token_budget_violations"], 0)

    def test_forged_byte_coordinates_are_never_promoted(self):
        doc = parse_markdown("a.md", "# 🎓\nOriginal".encode())
        chunk = plan_chunks(doc, ChunkPolicy("structure", 96, 0), UnitScalarCounter())[0]
        locator = chunk.locators[0]
        self.assertIsNotNone(locator.file_bytes)
        bad_locator = replace(locator, file_bytes=replace(locator.file_bytes, start=999))
        forged = replace(chunk, locators=(bad_locator, *chunk.locators[1:]))
        with self.assertRaises(ValueError):
            line_anchors(doc, forged)

    def test_line_identity_uses_json_not_ambiguous_delimiter(self):
        for anchor in (("my:path:3.md", 10), ("colon[1].md", 99), ("🚀.md", 2)):
            self.assertEqual(decode_line_key(line_key(anchor)), anchor)


if __name__ == "__main__":
    unittest.main()
