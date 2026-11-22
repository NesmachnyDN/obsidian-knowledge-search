"""CI-checkable immutable 03B measured evidence, without model weights or downloads."""
from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benchmarks.corpus_v1 import ROOT as CORPUS, validate
from benchmarks.lexical_metrics import summarize

ROOT = Path(__file__).resolve().parents[1] / "benchmarks" / "retrieval"
MODES = ("lexical", "dense", "hybrid")


class MeasuredRetrievalEvidenceTests(unittest.TestCase):
    def test_case_stream_hash_full_coverage_and_aggregate(self):
        stored = json.loads((ROOT / "results.json").read_text())
        raw = (ROOT / "cases.ndjson").read_bytes()
        self.assertEqual(sha256(raw).hexdigest(), stored["case_stream_sha256"])
        cases = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual(stored["case_count"], 93)
        self.assertEqual(len(cases), 93)
        self.assertTrue(stored["model_backed"])
        self.assertTrue(stored["no_fake_embedding"])
        self.assertTrue(stored["real_tokenizer_runtime_parity"])
        self.assertEqual(stored["dense_record_count"], stored["block_count"])
        manifest, _ = validate()
        self.assertEqual(stored["source_manifest_sha256"],
                         sha256((CORPUS / "manifest.json").read_bytes()).hexdigest())
        self.assertEqual(stored["judgment_sha256"], manifest["judgments"])
        identity = stored["model_identity"]
        self.assertEqual(identity["revision"], "5617a9f61b028005a4858fdac845db406aefb181")
        self.assertEqual(identity["dimension"], 1024)
        self.assertEqual(identity["normalization"], "l2-cls")
        seen = set()
        for split in ("tuning", "held_out"):
            ids = [q["id"] for q in json.loads((CORPUS / (split + ".json")).read_text())]
            for mode in MODES:
                these = [case for case in cases if case["split"] == split and case["mode"] == mode]
                self.assertEqual([case["id"] for case in these], ids)
                actual = summarize(these)
                self.assertEqual(actual, stored["split_metrics"][split][mode]["summary"])
                for case in these:
                    marker = (case["split"], case["mode"], case["id"])
                    self.assertNotIn(marker, seen)
                    seen.add(marker)
        self.assertEqual(len(seen), 93)

    def test_model_runs_within_pinned_scope_and_no_fake_promotion(self):
        for name in ("results.json", "chunk-policy-results.json"):
            result = json.loads((ROOT / name).read_text())
            self.assertTrue(result["model_backed"])
            self.assertTrue(result["no_fake_embedding"])
            self.assertTrue(result["offline"])
            c = result["resource_evidence"]
            self.assertEqual(c["memory_max_bytes"], 4 * 1024**3)
            self.assertEqual(c["memory_swap_max_bytes"], 0)
            self.assertLessEqual(c["memory_peak_bytes"], c["memory_max_bytes"])
            self.assertEqual(c["pids_max"], 128)
            self.assertTrue(all(c["memory_events"][event] == 0
                                for event in ("high", "max", "oom", "oom_kill")))

    def test_policy_comparison_same_model_source_and_budget(self):
        direct = json.loads((ROOT / "results.json").read_text())
        policy = json.loads((ROOT / "chunk-policy-results.json").read_text())
        self.assertEqual(policy["source_manifest_sha256"], direct["source_manifest_sha256"])
        self.assertEqual(policy["judgment_sha256"], direct["judgment_sha256"])
        self.assertEqual(policy["model_identity"], direct["model_identity"])
        self.assertEqual(policy["fixed_full_token_budget"], 96)
        self.assertEqual(policy["fixed_original_overlap_tokens"], 0)
        self.assertEqual(policy["comparison_policies"], [
            "fixed-window", "paragraph", "structure"])
        for row in policy["policy_record_counts"].values():
            self.assertEqual(row["source_coverage_failures"], 0)
            self.assertEqual(row["token_budget_violations"], 0)
            self.assertGreater(row["model_backed_vectors"], 0)
        # Observation for this exact frozen pilot, not a generalized quality claim.
        held = policy["quality"]["held_out"]
        self.assertGreater(held["paragraph"]["hybrid"]["span"]["10"]["ndcg"],
                           held["structure"]["hybrid"]["span"]["10"]["ndcg"])


if __name__ == "__main__":
    unittest.main()
