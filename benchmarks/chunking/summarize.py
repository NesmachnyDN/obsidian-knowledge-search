"""Deterministically split the full guarded benchmark into reviewable evidence files."""
from __future__ import annotations
import argparse
from hashlib import sha256
import json
from pathlib import Path
import statistics


def summarize(raw: dict, cases: list[dict], case_sha256: str):
    by_policy = {}
    for name in raw["policies"]:
        matching = [r for r in cases if r["policy"] == name]
        if len(matching) != len(cases) // len(raw["policies"]):
            raise ValueError("policy coverage mismatch")
        metrics = [r["metrics"] for r in matching]
        if any(m is None for m in metrics):
            raise ValueError("cannot finalize failed policy trials")
        by_policy[name] = {
            "runs": len(matching),
            "zero_lost_span_runs": sum(not m["lost_spans"] for m in metrics),
            "avg_source_coverage": statistics.mean(m["source_coverage"] for m in metrics),
            "min_source_coverage": min(m["source_coverage"] for m in metrics),
            "full_budget_violations": sum(m["token_budget_violations"] for m in metrics),
            "cross_section_mixed_chunks": sum(m["cross_section_chunks"] for m in metrics),
            "table_cells_preserved_runs": sum(m["table_cells_preserved"] for m in metrics),
            "lost_source_characters": sum(m["source_characters"] -
                                          m["covered_source_characters"] for m in metrics),
            "duplicated_source_characters": sum(m["duplicated_source_characters"]
                                                for m in metrics),
            "token_duplication_ratio_mean": statistics.mean(
                m["token_duplication_ratio"] for m in metrics),
            "chunk_count_total": sum(m["chunks"] for m in metrics),
            "prefix_tokens_total": sum(m["prefix_tokens_total"] for m in metrics),
            "locator_incorrect_total": sum(m["locator_incorrect"] for m in metrics),
            "locator_missing_total": sum(m["locator_missing"] for m in metrics),
            "locator_incomplete_total": sum(m["locator_incomplete"] for m in metrics),
            "native_unaligned_observations": sum(r["native_unaligned_count"] or 0
                                                  for r in matching),
            "worst_case_wall_seconds": max(r["seconds"] for r in matching),
        }
    return {
        **{key: val for key, val in raw.items() if key != "cases"},
        "case_record_path": "cases.ndjson",
        "case_record_format": "one complete original benchmark case JSON object per line",
        "case_record_sha256": case_sha256,
        "case_count": len(cases),
        "by_policy": by_policy,
    }


def run(source: Path, summary_path: Path, cases_path: Path):
    if source == summary_path or source == cases_path or summary_path == cases_path:
        raise ValueError("input/output paths must be distinct")
    data = json.loads(source.read_text(encoding="utf-8"))
    cases = data["cases"]
    expected = len(data["policies"]) * len(data["budgets"]) * len(data["overlap_tokens"])
    if len(cases) != data["input"]["sources"] * expected:
        raise ValueError("incomplete benchmark case set")
    lines = "".join(json.dumps(item, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":")) + "\n" for item in cases)
    encoded = lines.encode("utf-8")
    summary = summarize(data, cases, sha256(encoded).hexdigest())
    # Source is synthetic-only and output stays within the caller's approved scope.
    cases_path.write_bytes(encoded)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, sort_keys=True,
                                       indent=2) + "\n", encoding="utf-8")
    readback = [json.loads(line) for line in cases_path.read_text().splitlines()]
    if readback != cases or sha256(cases_path.read_bytes()).hexdigest() != summary["case_record_sha256"]:
        raise ValueError("lossy result serialization")
    print("summarized",len(cases),"cases; sha256",summary["case_record_sha256"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True)
    args = parser.parse_args()
    run(args.input, args.summary, args.cases)
