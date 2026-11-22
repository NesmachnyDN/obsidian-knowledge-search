"""Dependency-free regression and failure gates for OKS-02C."""
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.chunking import (ChunkPolicy, SourceSlice, coverage_report, make_chunk,
                             plan_chunks)
from engine.document import Cell, NativeAnchor, NativeLocation, ParsedBlock, ParsedDocument
from engine.markdown import parse_markdown
from engine.token_budget import TokenBudgetError, serialize_text, verify_snapshot


class ScalarCounter:
    """Only for dependency-free unit behavior; never used in benchmark or production."""
    def count(self, text: str) -> int:
        return len(text) + 2  # synthetic special tokens


class ChunkingTests(unittest.TestCase):
    def setUp(self):
        self.counter = ScalarCounter()

    def test_markdown_unicode_byte_span_and_original_identity(self):
        source = "# Проект\nREQ-01: Срок — 30 дней.\n".encode()
        doc = parse_markdown("notes/one.md", source)
        chunks = plan_chunks(doc, ChunkPolicy("paragraph", 120), self.counter)
        score = coverage_report(doc, chunks, self.counter)
        self.assertEqual(score["source_coverage"], 1.0)
        self.assertEqual(score["locator_incorrect"], 0)
        for chunk in chunks:
            self.assertEqual(chunk.source_hash, sha256(source).hexdigest())
            for slice_, loc in zip(chunk.slices, chunk.locators):
                original = doc.blocks[slice_.block_order].text[slice_.start:slice_.end]
                self.assertEqual(source[loc.file_bytes.start:loc.file_bytes.end].decode(), original)
                self.assertIsNone(loc.native_item_ref)

    def test_oversized_requirement_and_list_no_loss(self):
        source = ("# Contract\n## Conditions\nREQ-BIG-01: " + "Clause ABC-0. " * 110
                  + "\n- " + "Long list item. " * 95 + "\n").encode()
        doc = parse_markdown("long.md", source)
        for name in ("fixed-window", "paragraph", "structure"):
            chunks = plan_chunks(doc, ChunkPolicy(name, 56), self.counter)
            self.assertGreater(len(chunks), 4)
            metrics = coverage_report(doc, chunks, self.counter)
            self.assertEqual(metrics["source_coverage"], 1.0, name)
            self.assertEqual(metrics["lost_spans"], [], name)
            self.assertEqual(metrics["token_budget_violations"], 0, name)
            self.assertTrue(metrics["deterministic_ids_unique"], name)
            self.assertEqual(tuple(c.id for c in chunks),
                             tuple(c.id for c in plan_chunks(doc, ChunkPolicy(name, 56),
                                                             self.counter)))

    def test_long_repeated_text_and_heading_boundary(self):
        doc = parse_markdown("head.md", b"# First\nSame text.\n# Second\nSame text.\n")
        structural = plan_chunks(doc, ChunkPolicy("structure", 60), self.counter)
        metrics = coverage_report(doc, structural, self.counter)
        self.assertEqual(metrics["cross_section_chunks"], 0)
        self.assertEqual(metrics["source_coverage"], 1.0)
        self.assertGreaterEqual(len(structural), 2)

    def test_intentional_overlap_must_preserve_budget_and_source(self):
        doc = parse_markdown("small.md", ("# Section\n" + "abc " * 38 + "\n").encode())
        chunks = plan_chunks(doc, ChunkPolicy("fixed-window", 48, 12), self.counter)
        metrics = coverage_report(doc, chunks, self.counter)
        self.assertEqual(metrics["source_coverage"], 1.0)
        self.assertEqual(metrics["token_budget_violations"], 0)

    def test_prefix_budget_failure_is_not_silent_truncation(self):
        doc = parse_markdown("a.md", b"# A\nText\n")
        with self.assertRaises(TokenBudgetError):
            plan_chunks(doc, ChunkPolicy("structure", 16, literal_prefix="X" * 100),
                        self.counter)

    def test_invalid_policy_and_failed_source_rejected(self):
        with self.assertRaises(ValueError):
            ChunkPolicy("structure", 10, 10)
        with self.assertRaises(ValueError):
            ChunkPolicy("structure", 9000)
        with self.assertRaises(ValueError):
            ChunkPolicy("made-up", 32)
        doc = parse_markdown("a.md", b"Real text")
        for status in ("failed", "unsupported"):
            with self.assertRaises(ValueError):
                plan_chunks(replace(doc, status=status), ChunkPolicy("structure", 50),
                            self.counter)
        bad = replace(doc, blocks=(replace(doc.blocks[0], digest="0" * 64),))
        with self.assertRaises(ValueError):
            plan_chunks(bad, ChunkPolicy("structure", 50), self.counter)

    def test_partial_pdf_native_provenance_is_not_file_byte_offset(self):
        source = "Нормативный пункт длительного хранения 000-ABC"
        digest = sha256(b"%PDF-synthetic").hexdigest()
        native = NativeAnchor("#/texts/0", "body", "native-text",
                              (NativeLocation(2, (1., 2., 11., 20.), "BOTTOMLEFT",
                                              (0, len(source))),))
        block = ParsedBlock("synthetic.pdf", digest, 0, "clause", source, None,
                            ("Section 1",), native=native, page=2)
        doc = ParsedDocument("synthetic.pdf", digest, "partial", (block,),
                             ("numbered-list-heading-ambiguous",),
                             extraction_profile="docling-heron-tableformer-fast-2.151.1")
        chunks = plan_chunks(doc, ChunkPolicy("structure", 60), self.counter)
        self.assertEqual(coverage_report(doc, chunks, self.counter)["source_coverage"], 1)
        for c in chunks:
            self.assertIn("source-extraction-partial", c.diagnostics)
            for loc in c.locators:
                self.assertIsNone(loc.file_bytes)
                self.assertEqual(loc.native_item_ref, "#/texts/0")
                self.assertEqual(loc.native.locations[0].page, 2)

    def test_missing_pdf_geometry_diagnosed_without_invention(self):
        digest = sha256(b"file").hexdigest()
        block = ParsedBlock("n.pdf", digest, 0, "paragraph", "Text", None, (),
                            native=NativeAnchor("#/texts/0", "body", "native-text"))
        doc = ParsedDocument("n.pdf", digest, "partial", (block,),
                             extraction_profile="structured-pdf")
        chunks = plan_chunks(doc, ChunkPolicy("structure", 32), self.counter)
        metrics = coverage_report(doc, chunks, self.counter)
        self.assertEqual(metrics["locator_incomplete"], 1)
        self.assertIsNone(chunks[0].locators[0].file_bytes)

    def test_table_merged_cell_refs_and_oversized_split(self):
        digest = sha256(b"table").hexdigest()
        anchor = NativeAnchor("#/tables/0", "body", "table-cell-serialization",
                              (NativeLocation(1, (1., 1., 90., 90.), "BOTTOMLEFT"),),
                              (0, 1))
        cell = Cell(1, "long merged data " * 28, None,
                    NativeAnchor("#/tables/0", "body", "native-table-cell",
                                 row_range=(0, 1), col_range=(0, 2),
                                 cell_bbox=(1., 1., 90., 90.),
                                 cell_coordinate_origin="BOTTOMLEFT"))
        block = ParsedBlock("t.pdf", digest, 0, "table_row", cell.text, None, (),
                            (cell,), 1, 1, native=anchor)
        doc = ParsedDocument("t.pdf", digest, "ok", (block,),
                             extraction_profile="structured-pdf")
        chunks = plan_chunks(doc, ChunkPolicy("structure", 54), self.counter)
        score = coverage_report(doc, chunks, self.counter)
        self.assertEqual(score["source_coverage"], 1.0)
        self.assertEqual(score["table_cells_total"], 1)
        self.assertTrue(score["table_cells_preserved"])
        self.assertTrue(any("partial-table-row-serialization" in c.diagnostics
                            for c in chunks))
        self.assertEqual(chunks[0].locators[0].cells[0].native.col_range, (0, 2))
        self.assertIsNone(chunks[0].locators[0].file_bytes)

    def test_no_confused_source_coverage_with_fake_chunk(self):
        doc = parse_markdown("a.md", b"Real source")
        policy = ChunkPolicy("structure", 60)
        c = make_chunk(doc, (SourceSlice(0, 0, 4),), policy, self.counter)
        score = coverage_report(doc, [c], self.counter)
        self.assertLess(score["source_coverage"], 1)
        self.assertTrue(score["lost_spans"])
        with self.assertRaises(ValueError):
            coverage_report(doc, [replace(c, token_count=999)], self.counter)
        with self.assertRaises(ValueError):
            coverage_report(doc, [replace(c, tokenizer_fingerprint="0" * 64)], self.counter)

    def test_empty_and_tokenizer_missing(self):
        doc = parse_markdown("blank.md", b"")
        self.assertEqual(plan_chunks(doc, ChunkPolicy("structure", 50), self.counter), ())
        self.assertEqual(coverage_report(doc, (), self.counter)["source_coverage"], 1)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(TokenBudgetError):
                verify_snapshot(Path(directory))

    def test_contextual_text_separated_from_original(self):
        complete, prefix = serialize_text(("Chapter", "Clause"), "Actual clause",
                                          literal_prefix="search: ")
        self.assertEqual(prefix, "search: Chapter\nClause\n")
        self.assertEqual(complete, prefix + "Actual clause")


if __name__ == "__main__":
    unittest.main()
