"""Dependency-free negative tests for opt-in BGE-M3 reference inference gates."""
from __future__ import annotations

from hashlib import sha256
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.embedding import (
    EmbeddingUnavailable, OfflineDenseReference, validate_dense_vector,
    validate_input, verify_active_experiment_guard, verify_model_snapshot,
)
from scripts.run_embedding_bounded import run as guarded_runner


class ModelArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.snapshot = root / "test-model-revision"
        self.snapshot.mkdir()
        self.manifest_path = root / "manifest.json"
        data = {
            "README.md": b"---\nlicense: mit\n---\nSynthetic test card",
            "config.json": json.dumps({
                "model_type": "xlm-roberta", "hidden_size": 1024,
                "architectures": ["XLMRobertaModel"],
                "max_position_embeddings": 8194,
            }).encode(),
            "pytorch_model.bin": b"SYNTHETIC ONLY, NEVER A MODEL",
        }
        for name, blob in data.items():
            (self.snapshot / name).write_bytes(blob)
        self.manifest = {
            "schema_version": 1,
            "repository": "synthetic-test-only",
            "revision": self.snapshot.name,
            "license": "MIT",
            "model_type": "xlm-roberta",
            "hidden_size": 1024,
            "serialization_version": "bge-m3-heading-lines-v1",
            "files": {
                name: {"sha256": sha256(blob).hexdigest(), "bytes": len(blob)}
                for name, blob in data.items()
            },
        }
        self._write_manifest()

    def _write_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest))

    def test_synthetic_model_identity_manifest(self):
        result = verify_model_snapshot(self.snapshot, manifest_path=self.manifest_path)
        self.assertEqual(result["hidden_size"], 1024)

    def test_reject_absent_weights_before_any_model_import(self):
        (self.snapshot / "pytorch_model.bin").unlink()
        with self.assertRaises(EmbeddingUnavailable) as raised:
            verify_model_snapshot(self.snapshot, manifest_path=self.manifest_path)
        self.assertEqual(raised.exception.code, "MODEL_UNAVAILABLE")

    def test_reject_tampered_weight_bytes(self):
        (self.snapshot / "pytorch_model.bin").write_bytes(b"X" * 29)
        with self.assertRaises(EmbeddingUnavailable):
            verify_model_snapshot(self.snapshot, manifest_path=self.manifest_path)

    def test_reject_modified_weight_with_same_size(self):
        source = self.snapshot / "pytorch_model.bin"
        source.write_bytes(b"X" * source.stat().st_size)
        with self.assertRaises(EmbeddingUnavailable) as raised:
            verify_model_snapshot(self.snapshot, manifest_path=self.manifest_path)
        self.assertEqual(raised.exception.code, "MODEL_INCOMPATIBLE")

    def test_reject_wrong_revision(self):
        other = self.snapshot.parent / "wrong-revision"
        self.snapshot.rename(other)
        with self.assertRaises(EmbeddingUnavailable):
            verify_model_snapshot(other, manifest_path=self.manifest_path)

    def test_reject_unverified_license(self):
        (self.snapshot / "README.md").write_bytes(b"---\nlicense: unknown\n---\nSynthetic")
        with self.assertRaises(EmbeddingUnavailable):
            verify_model_snapshot(self.snapshot, manifest_path=self.manifest_path)

    def test_reject_invalid_model_architecture(self):
        path = self.snapshot / "config.json"
        path.write_text('{"model_type":"causal-lm"}')
        self.manifest["files"]["config.json"] = {
            "bytes": path.stat().st_size, "sha256": sha256(path.read_bytes()).hexdigest(),
        }
        self._write_manifest()
        with self.assertRaises(EmbeddingUnavailable):
            verify_model_snapshot(self.snapshot, manifest_path=self.manifest_path)

    def test_reject_oversized_declared_artifact_before_read(self):
        self.manifest["files"]["pytorch_model.bin"]["bytes"] = 4 * 1024**3
        self._write_manifest()
        with self.assertRaises(EmbeddingUnavailable):
            verify_model_snapshot(self.snapshot, manifest_path=self.manifest_path)


class VectorAndInputTests(unittest.TestCase):
    def test_dimension_and_normalization(self):
        values = validate_dense_vector([3.0, 4.0] + [0.0] * 1022)
        self.assertEqual(len(values), 1024)
        self.assertAlmostEqual(values[0], 0.6)
        self.assertAlmostEqual(values[1], 0.8)
        self.assertAlmostEqual(math.hypot(*values), 1.0)

    def test_reject_nan_zero_wrong_dim_and_non_floats(self):
        bad = (
            [0.0] * 1024,
            [1.0],
            [float("nan")] + [0.0] * 1023,
            [float("inf")] + [0.0] * 1023,
            ["1"] + [0.0] * 1023,
            [True] + [0.0] * 1023,
        )
        for value in bad:
            with self.subTest(value=str(value[:1])):
                with self.assertRaises(EmbeddingUnavailable):
                    validate_dense_vector(value)

    def test_reject_invalid_inputs_and_oversized_payload(self):
        for text, budget in (("", 256), (42, 256), ("X" * 8193, 256),
                             (chr(0xD800), 256), ("valid", 257),
                             ("valid", 7), ("valid", True)):
            with self.subTest(text=str(text)[:16], budget=budget):
                with self.assertRaises(EmbeddingUnavailable):
                    validate_input(text, max_tokens=budget)

    def test_model_guard_is_prior_to_artifact_import(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(EmbeddingUnavailable) as raised:
                OfflineDenseReference(Path("/nonexistent"))
        self.assertEqual(raised.exception.code, "APPROVAL_REQUIRED")


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.root = root / "cgroup"
        self.group = self.root / "oks-03a-embedding.scope"
        self.group.mkdir(parents=True)
        self.proc = root / "proc"
        self.proc.write_text("0::/oks-03a-embedding.scope\n")
        self.network = root / "netdev"
        self.network.write_text("lo: 0 0 0 0\n")
        for name, data in {
            "memory.max": str(4 * 1024**3), "memory.swap.max": "0",
            "cpu.max": "200000 100000", "pids.max": "128",
        }.items():
            (self.group / name).write_text(data)

    def _verify(self):
        with patch.dict(os.environ, {"OKS_03A_EXPLICIT_MODEL_APPROVAL": "1"}):
            with patch("os.sched_getaffinity", return_value={0, 1}):
                verify_active_experiment_guard(
                    cgroup_root=self.root, cgroup_file=self.proc, network_file=self.network,
                )

    def test_effective_offline_guard(self):
        self._verify()

    def test_cgroup_must_have_correct_scope(self):
        self.proc.write_text("0::/not-the-scope.scope\n")
        with self.assertRaises(EmbeddingUnavailable):
            self._verify()

    def test_swap_never_allowed(self):
        (self.group / "memory.swap.max").write_text("1")
        with self.assertRaises(EmbeddingUnavailable):
            self._verify()

    def test_memory_cpu_and_tasks_are_bounded(self):
        for name, value in (("memory.max", "max"), ("cpu.max", "300000 100000"),
                            ("pids.max", "256")):
            original = (self.group / name).read_text()
            (self.group / name).write_text(value)
            with self.subTest(name=name):
                with self.assertRaises(EmbeddingUnavailable):
                    self._verify()
            (self.group / name).write_text(original)

    def test_no_network_except_loopback(self):
        self.network.write_text("lo: 0 0 0\neth0: 0 0 0\n")
        with self.assertRaises(EmbeddingUnavailable):
            self._verify()

    def test_guarded_runner_refuses_unapproved_execution(self):
        with self.assertRaisesRegex(RuntimeError, "APPROVAL_REQUIRED"):
            guarded_runner(Path("/not/python"), Path("/missing"), Path("/tmp/out.json"))


if __name__ == "__main__":
    unittest.main()
