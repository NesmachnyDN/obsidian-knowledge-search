"""Lossless per-case benchmark evidence split with failure checks."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benchmarks.chunking.summarize import run


class SummaryEvidenceTests(unittest.TestCase):
    def sample(self):
        return {
            "policies": ["structure"], "budgets": [48], "overlap_tokens": [0],
            "input": {"sources": 1},
            "cases": [{
                "source": "synthetic.md", "policy": "structure",
                "max_tokens": 48, "overlap_tokens": 0,
                "metrics": {
                    "lost_spans": [], "source_coverage": 1.,
                    "source_characters": 12, "covered_source_characters": 12,
                    "token_budget_violations": 0, "cross_section_chunks": 0,
                    "table_cells_preserved": True,
                    "duplicated_source_characters": 0, "token_duplication_ratio": 1.25,
                    "chunks": 1, "prefix_tokens_total": 2,
                    "locator_incorrect": 0, "locator_missing": 0, "locator_incomplete": 0,
                },
                "native_unaligned_count": None, "seconds": 0.002
            }],
        }

    def test_round_trip_of_all_cases_and_manifest_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inp, out, cases = (root / n for n in ("input.json", "summary.json", "cases.ndjson"))
            specimen = self.sample()
            inp.write_text(json.dumps(specimen, ensure_ascii=False))
            run(inp, out, cases)
            summary = json.loads(out.read_text())
            self.assertEqual(summary["case_count"], 1)
            self.assertEqual(summary["by_policy"]["structure"]["zero_lost_span_runs"], 1)
            self.assertEqual([json.loads(s) for s in cases.read_text().splitlines()],
                             specimen["cases"])
            self.assertEqual(summary["case_record_path"], "cases.ndjson")

    def test_incomplete_case_set_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inp, out, cases = (root / n for n in ("input.json", "summary.json", "cases.ndjson"))
            payload = self.sample()
            payload["cases"] = []
            inp.write_text(json.dumps(payload))
            with self.assertRaises(ValueError):
                run(inp, out, cases)
            self.assertFalse(out.exists())

    def test_no_in_place_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / "a.json"
            with self.assertRaises(ValueError):
                run(p, p, p)


if __name__ == "__main__":
    unittest.main()
