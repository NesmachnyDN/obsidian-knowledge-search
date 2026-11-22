"""Actual BGE-M3 worker cancellation -> clean restart, in two bounded scopes.

Opt-in, local-only reference experiment. No downloads, model distribution,
private Vault access, or extra concurrency. Synthetic pressure is *injected*
only after real weights have loaded and produced a verified embedding; this
does not claim that host/kernel memory exhaustion was induced.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.run_embedding_bounded import ROOT, run
from scripts.run_structured_bounded import scope_active

UNIT = "oks-03a-embedding.scope"


def exercise(python: Path, snapshot: Path, output: Path,
             *, explicitly_approved: bool = False) -> dict:
    if not explicitly_approved:
        raise RuntimeError("APPROVAL_REQUIRED")
    if output.exists() or output.with_suffix(output.suffix + ".partial").exists():
        raise RuntimeError("refuse overwrite of recovery evidence")
    if output.resolve().is_relative_to(ROOT):
        raise RuntimeError("recovery evidence must be outside repository")
    if scope_active(UNIT):
        raise RuntimeError("active model scope; refuse competing recovery")
    # The runner performs a fresh provenance, memory/disk, cgroup and offline
    # preflight before each of the two successive model imports.
    stage = "cancel"
    try:
        with tempfile.TemporaryDirectory(prefix="oks-03a-model-recovery-") as temp:
            cancel_path = Path(temp) / "cancel.json"
            restart_path = Path(temp) / "restart.json"
            run(python, snapshot, cancel_path,
                explicitly_approved=True, task="03a-cancel")
            cancelled = json.loads(cancel_path.read_text(encoding="utf-8"))
            if (cancelled.get("phase") != "OKS-03A-CANCELLED"
                    or cancelled.get("worker_exit_nonzero") is not True
                    or cancelled.get("scope_inactive_after_cancel") is not True
                    or scope_active(UNIT)):
                raise RuntimeError("MODEL_CANCELLATION_NOT_PROVEN")
            stage = "restart"
            run(python, snapshot, restart_path,
                explicitly_approved=True, task="03a")
            restarted = json.loads(restart_path.read_text(encoding="utf-8"))
            ready = cancelled["model_ready"]
            if (restarted.get("model_backed") is not True
                    or restarted.get("offline") is not True
                    or restarted.get("identity") != ready["identity"]
                    or restarted.get("dimension") != 1024
                    or restarted.get("test_count", 0) < 2
                    or restarted.get("repeat_max_abs_difference", 1) > 1e-5
                    or not restarted.get("resource_evidence")
                    or scope_active(UNIT)):
                raise RuntimeError("MODEL_RECOVERY_NOT_PROVEN")
        result = {
            "schema_version": 1,
            "phase": "OKS-03A-MODEL-RECOVERY",
            "profile": "python-reference-only",
            "model_backed": True,
            "offline": True,
            "trigger": cancelled["trigger"],
            "fault_injection": "simulated-pressure-cancellation-not-live-oom",
            "model_ready_before_stop": True,
            "initial_vector_dimension": ready["dimension"],
            "initial_vector_norm": ready["unit_norm"],
            "initial_model_identity": ready["identity"],
            "cancelled_worker_exit_nonzero": True,
            "cancelled_scope_inactive": True,
            "cancelled_scope_resource_evidence": ready["resource_evidence"],
            "fresh_model_restart_success": True,
            "restart_embedding_test_count": restarted["test_count"],
            "restart_repeat_max_abs_difference": restarted["repeat_max_abs_difference"],
            "restart_process_peak_rss_kib": restarted["process_peak_rss_kib"],
            "restart_resource_evidence": restarted["resource_evidence"],
            "model_identity_unchanged": True,
            "scope_inactive_after_recovery": True,
            "no_source_content_recorded": True,
            "standalone_implemented": False,
            "host_oom_induced": False,
        }
    except BaseException as exc:
        # Preserve a bounded metadata-only incomplete run record without
        # exposing model/cache/host paths or advertising a successful restart.
        partial = output.with_suffix(output.suffix + ".partial")
        with partial.open("x", encoding="utf-8") as stream:
            json.dump({
                "phase": "OKS-03A-MODEL-RECOVERY",
                "status": "incomplete",
                "failed_stage": stage,
                "exception_type": type(exc).__name__,
                "scope_inactive_at_failure": not scope_active(UNIT),
                "model_recovery_proven": False,
            }, stream, sort_keys=True)
            stream.write("\n")
        raise
    # Publish only after both stages succeeded and their scopes are inactive.
    partial = output.with_suffix(output.suffix + ".partial")
    with partial.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, sort_keys=True, indent=2)
        stream.write("\n")
    partial.replace(output)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--explicit-model-approval", action="store_true")
    args = parser.parse_args()
    exercise(args.python, args.snapshot, args.output,
             explicitly_approved=args.explicit_model_approval)
