"""Guarded CPU-only offline 02C benchmark, reusing Foundation admission/cgroup checks."""
from __future__ import annotations
import argparse
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from engine.resources import admit, available
from engine.token_budget import verify_snapshot
from scripts.run_structured_bounded import BUDGET, scope_active

UNIT = "oks-02c-chunking.scope"
OTHER_HEAVY = ("oks-02b-structured.scope", "oks-02b-full-runtime.scope",
               "oks-02b-opencv.scope", "oks-02b-model-download.scope")


def run(python: Path, snapshot: Path, extras: Path, output: Path):
    if not python.is_file() or not snapshot.is_dir() or not extras.is_dir():
        raise ValueError("missing explicitly provisioned local runtime")
    if output.exists():
        raise ValueError("refuse to overwrite existing benchmark evidence")
    verify_snapshot(snapshot)
    admit(*available(snapshot), BUDGET)
    if any(scope_active(unit) for unit in (UNIT, *OTHER_HEAVY)):
        raise RuntimeError("another CPU-heavy experiment is active")
    cpus = sorted(os.sched_getaffinity(0))[:2]
    if len(cpus) != 2:
        raise RuntimeError("insufficient CPU affinity")
    command = [
        "systemd-run", "--user", "--scope", "--unit=" + UNIT,
        "-p", "MemoryMax=4G", "-p", "MemorySwapMax=0",
        "-p", "CPUQuota=200%", "-p", "TasksMax=128",
        "timeout", "-k", "5s", "240s", "taskset", "-c", ",".join(map(str, cpus)),
        "unshare", "-Urn", "env", "OMP_NUM_THREADS=2", "OPENBLAS_NUM_THREADS=1",
        "MKL_NUM_THREADS=2", "OMP_THREAD_LIMIT=2", "TOKENIZERS_PARALLELISM=false",
        "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1",
        "HF_HUB_DISABLE_TELEMETRY=1", "CUDA_VISIBLE_DEVICES=",
        str(python), "-I", "-B", str(ROOT / "benchmarks/chunking/run.py"),
        "--snapshot", str(snapshot), "--chunk-extras", str(extras),
    ]
    scratch = output.with_suffix(output.suffix + ".partial")
    if scratch.exists():
        raise ValueError("stale partial output; operator must inspect")
    with scratch.open("wb") as out:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out)
        try:
            while process.poll() is None:
                memory, disk, _ = available(snapshot)
                if memory < BUDGET.memory_reserve or disk < BUDGET.disk_reserve:
                    raise RuntimeError("resource pressure: cancelling")
                time.sleep(0.5)
            if process.returncode:
                raise subprocess.CalledProcessError(process.returncode, command)
        finally:
            if process.poll() is None or scope_active(UNIT):
                subprocess.run(["systemctl", "--user", "stop", UNIT],
                               timeout=15, check=True)
                process.wait(timeout=10)
            if scope_active(UNIT):
                raise RuntimeError("cgroup still active after benchmark")
    # Guard JSON parse and exact preflight before atomic result publication.
    import json
    data = json.loads(scratch.read_text())
    if not data["cases"] or data["resource_evidence"]["swap_max"] != 0:
        raise RuntimeError("invalid benchmark output")
    scratch.replace(output)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--python", type=Path, required=True)
    p.add_argument("--snapshot", type=Path, required=True)
    p.add_argument("--chunk-extras", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    run(args.python, args.snapshot, args.chunk_extras, args.output)
