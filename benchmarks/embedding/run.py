"""Actual 03A synthetic-only CPU inference worker; invoked only by guarded wrapper."""
from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import math
from pathlib import Path
import resource
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from engine.embedding import OfflineDenseReference, verify_active_experiment_guard

SYNTHETIC_TEXTS = (
    "Раздел 3.1 предусматривает хранение записи и проверку идентификатора ИД-42.",
    "Clause 7.2 prohibits storing confidential documents outside the permitted vault.",
    "Документ по договору АБ-17 имеет отдельные типизированные метаданные.",
)


def _resource_evidence() -> dict:
    """Only numeric kernel counters, never host paths or source content."""
    rows = [
        line.split("::", 1)[1] for line in Path("/proc/self/cgroup").read_text().splitlines()
        if line.startswith("0::")
    ]
    if len(rows) != 1:
        raise RuntimeError("missing cgroup resource metrics")
    group = Path("/sys/fs/cgroup") / rows[0].lstrip("/")
    events = {}
    for line in (group / "memory.events").read_text().splitlines():
        key, value = line.split()
        if key in {"high", "max", "oom", "oom_kill"}:
            events[key] = int(value)
    cpu = {}
    for line in (group / "cpu.stat").read_text().splitlines():
        key, value = line.split()
        if key in {"usage_usec", "nr_throttled", "throttled_usec"}:
            cpu[key] = int(value)
    return {
        "memory_max_bytes": int((group / "memory.max").read_text()),
        "memory_peak_bytes": int((group / "memory.peak").read_text()),
        "memory_swap_max_bytes": int((group / "memory.swap.max").read_text()),
        "pids_max": int((group / "pids.max").read_text()),
        "memory_events": events,
        "cpu_stat": cpu,
    }


def run(snapshot: Path) -> dict:
    verify_active_experiment_guard()
    started = time.perf_counter()
    runtime = OfflineDenseReference(snapshot)
    load_s = time.perf_counter() - started
    vectors, durations = [], []
    for source in SYNTHETIC_TEXTS:
        started = time.perf_counter()
        vector = runtime.embed(source)
        durations.append((time.perf_counter() - started) * 1000)
        vectors.append(vector)
    repeat = runtime.embed(SYNTHETIC_TEXTS[0])
    max_repeat_difference = max(abs(a - b) for a, b in zip(vectors[0], repeat))
    if max_repeat_difference > 1e-5:
        raise ValueError("model-backed repeated embedding is not deterministic")
    if len({len(row) for row in vectors}) != 1 or len(vectors[0]) != 1024:
        raise ValueError("model-backed embedding dimension invalid")
    norms = [math.sqrt(math.fsum(x * x for x in values)) for values in vectors]
    if any(abs(n - 1.0) > 1e-5 for n in norms):
        raise ValueError("model-backed normalization failed")
    resource_evidence = _resource_evidence()
    if resource_evidence["memory_peak_bytes"] > resource_evidence["memory_max_bytes"]:
        raise ValueError("cgroup peak exceeded admitted memory")
    if any(resource_evidence["memory_events"].get(name, 0)
           for name in ("high", "max", "oom", "oom_kill")):
        raise ValueError("memory pressure/oom event: experiment not accepted")
    return {
        "protocol_version": 1,
        "phase": "OKS-03A",
        "profile": "python-reference-only",
        "model_backed": True,
        "offline": True,
        "identity": asdict(runtime.identity),
        "dimension": 1024,
        "test_count": len(vectors),
        "no_source_content_recorded": True,
        "repeat_max_abs_difference": max_repeat_difference,
        "minimum_unit_norm": min(norms),
        "maximum_unit_norm": max(norms),
        "model_load_wall_seconds": load_s,
        "embed_p50_ms": statistics.median(durations),
        "embed_max_ms": max(durations),
        "process_peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "resource_evidence": resource_evidence,
        "experimental": True,
        "plugin_standalone_implemented": False,
        "hybrid_retrieval_implemented": False,
    }


def run_cancel_ready_probe(snapshot: Path) -> None:
    """Hold a *real loaded model* alive until the outer cgroup is cancelled.

    The single stdout readiness message contains metadata only. The parent
    must verify effective limits and stop the entire named scope; this worker
    cannot mark its own cancellation as successful.
    """
    verify_active_experiment_guard()
    model = OfflineDenseReference(snapshot)
    vector = model.embed(SYNTHETIC_TEXTS[0])
    norm = math.hypot(*vector)
    if len(vector) != 1024 or abs(norm - 1.0) > 1e-5:
        raise ValueError("real model not ready for cancellation")
    resources = _resource_evidence()
    if (resources["memory_max_bytes"] != 4 * 1024**3
            or resources["memory_swap_max_bytes"] != 0
            or resources["pids_max"] > 128
            or resources["memory_peak_bytes"] > resources["memory_max_bytes"]
            or any(resources["memory_events"].get(event, 0)
                   for event in ("high", "max", "oom", "oom_kill"))):
        raise ValueError("invalid model worker resource limit")
    print(json.dumps({
        "phase": "OKS-03A-MODEL-READY",
        "model_backed": True,
        "offline": True,
        "identity": asdict(model.identity),
        "dimension": 1024,
        "unit_norm": norm,
        "no_source_content_recorded": True,
        "resource_evidence": resources,
    }, sort_keys=True, separators=(",", ":")), flush=True)
    # The model remains resident and its process deliberately stays alive;
    # only the outer bounded runner may stop the scope.
    while True:
        time.sleep(0.5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--cancel-ready-probe", action="store_true")
    args = parser.parse_args()
    if args.cancel_ready_probe:
        run_cancel_ready_probe(args.snapshot)
    else:
        print(json.dumps(run(args.snapshot), sort_keys=True, separators=(",", ":")))
