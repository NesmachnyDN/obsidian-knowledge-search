"""Optional offline exact tokenizer and native chunking integration checks.

Set OKS_02C_TOKENIZER_SNAPSHOT and OKS_02C_CHUNK_EXTRAS to the
already reviewed local artifacts; default CI needs no model artifacts.
"""
from pathlib import Path
import os
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.token_budget import ExactTokenizer, TokenBudgetError
from engine.markdown import parse_markdown
from engine.chunking import ChunkPolicy, coverage_report, plan_chunks


SNAPSHOT = os.getenv("OKS_02C_TOKENIZER_SNAPSHOT")
EXTRAS = os.getenv("OKS_02C_CHUNK_EXTRAS")


@unittest.skipUnless(SNAPSHOT and EXTRAS, "requires explicitly pinned local offline artifacts")
class ExactOfflineTokenizerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        if os.environ.get("OKS_02C_REQUIRE_CGROUP") == "1":
            from benchmarks.extraction.run_structured import runtime_cgroup
            runtime_cgroup()  # verify actual kernel limits, not CLI parameters
        cls.tokenizer = ExactTokenizer(Path(SNAPSHOT))
        sys.path.insert(0, EXTRAS)

    def test_identity_and_bos_eos_parity_with_huggingface(self):
        from transformers import AutoTokenizer
        hf = AutoTokenizer.from_pretrained(SNAPSHOT, local_files_only=True,
                                           trust_remote_code=False, use_fast=True)
        for value in ("", "Русский нормативный пункт REQ-001",
                      "A document ID: ABC-123/45", "X" * 520):
            count = len(hf(value, add_special_tokens=True, truncation=False)["input_ids"])
            self.assertEqual(self.tokenizer.count(value), count)
        self.assertEqual(self.tokenizer.identity["embedding_runtime_verified"], False)
        self.assertEqual(self.tokenizer.count(""), 2)

    def test_large_input_is_not_truncated(self):
        large = ("REQ-HELLO-123, 45 дней.\n" * 4000)
        count = self.tokenizer.count(large)
        self.assertGreater(count, 8192)
        self.assertGreater(count, self.tokenizer.identity["model_max_length"])

    def test_overlong_clause_source_coverage_and_max_budget(self):
        doc = parse_markdown("long.md", ("# Раздел\n" +
                            "REQ-777: " + "Обязательная проверка ABC. " * 130 + "\n").encode())
        self.assertEqual(doc.status, "ok")
        for name in ("fixed-window", "paragraph", "structure"):
            policy = ChunkPolicy(name, 96, 12)
            chunks = plan_chunks(doc, policy, self.tokenizer)
            metrics = coverage_report(doc, chunks, self.tokenizer)
            self.assertEqual(metrics["source_coverage"], 1.0)
            self.assertEqual(metrics["token_budget_violations"], 0)

    def test_native_comparator_reports_loss_not_fake_coverage(self):
        from engine.native_chunking import run_native
        doc = parse_markdown("table.md", b"# Heading\n| A | B |\n|---|---|\n|1|2|\n")
        result = run_native(doc, ChunkPolicy("native-hybrid", 96), self.tokenizer,
                            Path(SNAPSHOT), plugin_path=Path(EXTRAS))
        metrics = coverage_report(doc, result.chunks, self.tokenizer)
        self.assertLessEqual(metrics["source_coverage"], 1.0)
        self.assertLessEqual(metrics["table_cells_covered"], metrics["table_cells_total"])
        self.assertTrue(result.native_output_count >= len(result.chunks))


if __name__ == "__main__":
    unittest.main()
