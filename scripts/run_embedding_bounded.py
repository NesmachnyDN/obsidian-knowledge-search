"""Guarded, opt-in offline CPU BGE-M3 experiment. NEVER run without explicit approval.

The script does not run inference until an operator authorizes a dedicated CPU,
memory, no-swap and network-isolated scope after an independent resource preflight.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from engine.embedding import verify_model_snapshot
from engine.resources import Budget, admit, available
from engine.token_budget import verify_snapshot
from scripts.run_structured_bounded import scope_active

GIB = 1024**3
BUDGET = Budget(memory=4*GIB, memory_reserve=3*GIB, disk=128*1024**2, disk_reserve=GIB)
UNIT = "oks-03a-embedding.scope"
OTHER = (
    "oks-02b-structured.scope", "oks-02b-full-runtime.scope",
    "oks-02b-opencv.scope", "oks-02b-model-download.scope",
    "oks-02c-chunking.scope",
)
LIMIT_SECONDS = 180


def run(python: Path, snapshot: Path, output: Path, *,
        explicitly_approved: bool = False, task: str = "03a") -> None:
    if task not in ("03a", "03b", "03b-chunks"):
        raise RuntimeError("TASK_INVALID")
    if not explicitly_approved:
        raise RuntimeError("APPROVAL_REQUIRED: explicit heavy-inference authorization absent")
    if not python.is_file() or not snapshot.is_dir():
        raise RuntimeError("MODEL_UNAVAILABLE")
    if output.exists() or output.with_suffix(output.suffix + ".partial").exists():
        raise RuntimeError("refuse overwrite or unreviewed recovery of partial evidence")
    if output.resolve().is_relative_to(ROOT):
        # A run writes only operator-owned scratch results, never the repository.
        raise RuntimeError("benchmark output must be outside the source repository")
    verify_snapshot(snapshot)
    verify_model_snapshot(snapshot)
    admit(*available(snapshot), BUDGET)
    if any(scope_active(name) for name in (UNIT, *OTHER)):
        raise RuntimeError("another bounded heavy experiment is active")
    cpus = sorted(os.sched_getaffinity(0))[:2]
    if len(cpus) != 2:
        raise RuntimeError("two logical CPUs required")
    argv = [
        "systemd-run", "--user", "--scope", "--unit=" + UNIT,
        "-p", "MemoryMax=4G", "-p", "MemorySwapMax=0",
        "-p", "CPUQuota=200%", "-p", "TasksMax=128",
        "timeout", "-k", "5s", str(LIMIT_SECONDS) + "s",
        "taskset", "-c", ",".join(map(str, cpus)), "unshare", "-Urn",
        "env", "OKS_03A_EXPLICIT_MODEL_APPROVAL=1",
        "OMP_NUM_THREADS=2", "OPENBLAS_NUM_THREADS=1",
        "MKL_NUM_THREADS=2", "OMP_THREAD_LIMIT=2",
        "TOKENIZERS_PARALLELISM=false",
        "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1",
        "HF_HUB_DISABLE_TELEMETRY=1", "CUDA_VISIBLE_DEVICES=",
        str(python), "-I", "-B",
        str(ROOT / {
            "03a": "benchmarks/embedding/run.py",
            "03b": "benchmarks/retrieval/run.py",
            "03b-chunks": "benchmarks/retrieval/chunk_policy_run.py",
        }[task]),
        "--snapshot", str(snapshot),
    ]
    partial = output.with_suffix(output.suffix + ".partial")
    with partial.open("xb") as result_stream:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL,
                                   stdout=result_stream, stderr=subprocess.DEVNULL)
        try:
            while process.poll() is None:
                memory, disk, _ = available(snapshot)
                if memory < BUDGET.memory_reserve or disk < BUDGET.disk_reserve:
                    raise RuntimeError("RESOURCE_EXHAUSTED: pressure cancellation")
                time.sleep(0.5)
            if process.returncode:
                raise RuntimeError("experimental subprocess failed (" + str(process.returncode)
                                   + "); no source/error stream captured")
        finally:
            if process.poll() is None or scope_active(UNIT):
                subprocess.run(["systemctl", "--user", "stop", UNIT],
                               stdin=subprocess.DEVNULL, timeout=15, check=True)
                process.wait(timeout=10)
            if scope_active(UNIT):
                raise RuntimeError("unable to prove scope teardown")
    evidence = json.loads(partial.read_text(encoding="utf-8"))
    if evidence.get("model_backed") is not True or evidence.get("offline") is not True:
        raise RuntimeError("invalid model measurement; no benchmark published")
    if task == "03a":
        if evidence.get("dimension") != 1024 or evidence.get("test_count", 0) < 2:
            raise RuntimeError("invalid 03A model measurement")
    elif task == "03b":
        if (evidence.get("phase") != "OKS-03B"
                or evidence.get("real_tokenizer_runtime_parity") is not True
                or evidence.get("no_fake_embedding") is not True
                or evidence.get("dense_record_count", 0) == 0
                or evidence.get("query_mode_error_count") != 0
                or evidence.get("provenance_error_count") != 0
                or evidence.get("leg_consistency_error_count") != 0
                or set(evidence.get("split_metrics", {})) != {"tuning", "held_out"}):
            raise RuntimeError("invalid 03B retrieval measurement")
    else:
        if (evidence.get("phase") != "OKS-03B-CHUNKS"
                or evidence.get("no_fake_embedding") is not True
                or set(evidence.get("quality", {})) != {"tuning", "held_out"}
                or evidence.get("comparison_policies") !=
                ["fixed-window", "paragraph", "structure"]
                or any(row.get("source_coverage_failures") != 0 or
                       row.get("token_budget_violations") != 0
                       for row in evidence.get("policy_record_counts", {}).values())):
            raise RuntimeError("invalid 03B structural-policy measurement")
    partial.replace(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--explicit-model-approval", action="store_true",
                        help="requires recorded maintainer permission and resource preflight")
    parser.add_argument("--task", choices=["03a", "03b", "03b-chunks"], default="03a")
    args = parser.parse_args()
    run(args.python, args.snapshot, args.output,
        explicitly_approved=args.explicit_model_approval, task=args.task)
