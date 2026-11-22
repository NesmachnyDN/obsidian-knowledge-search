"""Losslessly publish the guarded 03B frozen corpus trial as navigable case evidence."""
from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from benchmarks.corpus_v1 import ROOT as CORPUS, validate
from benchmarks.lexical_metrics import summarize

MODES = ("lexical", "dense", "hybrid")
SPLITS = ("tuning", "held_out")


def materialize(source: Path, summary_file: Path, cases_file: Path) -> None:
    paths = (source, summary_file, cases_file)
    if len({path.resolve() for path in paths}) != 3:
        raise ValueError("inputs and outputs must be distinct")
    if summary_file.exists() or cases_file.exists():
        raise ValueError("refuse to overwrite frozen evidence")
    raw = json.loads(source.read_text(encoding="utf-8"))
    if (raw.get("phase") != "OKS-03B" or raw.get("model_backed") is not True
            or raw.get("no_fake_embedding") is not True
            or set(raw.get("split_metrics", {})) != set(SPLITS)):
        raise ValueError("not a valid real-model 03B source")
    manifest, _ = validate()
    for name in ("tuning", "held_out"):
        if raw.get("judgment_sha256", {}).get(name + ".json") != manifest["judgments"][name + ".json"]:
            raise ValueError("judgments changed")
    cases = []
    summaries = {}
    for split in SPLITS:
        summaries[split] = {}
        for mode in MODES:
            source_group = raw["split_metrics"][split][mode]
            rows = source_group["per_query"]
            expected_ids = [q["id"] for q in json.loads((CORPUS / (split + ".json")).read_text())]
            if [r["id"] for r in rows] != expected_ids:
                raise ValueError("missing or misordered frozen queries")
            recalculated = summarize(rows)
            if recalculated != source_group["summary"]:
                raise ValueError("aggregated retrieval metric mismatch")
            summaries[split][mode] = {"summary": recalculated}
            for row in rows:
                cases.append({"split": split, "mode": mode, **row})
    content = "".join(json.dumps(case, ensure_ascii=False, sort_keys=True,
                                 separators=(",", ":")) + "\n" for case in cases)
    digest = sha256(content.encode()).hexdigest()
    summary = {
        **{key: value for key, value in raw.items() if key != "split_metrics"},
        "split_metrics": summaries,
        "case_count": len(cases),
        "case_stream_path": "cases.ndjson",
        "case_stream_sha256": digest,
    }
    cases_file.write_text(content, encoding="utf-8")
    summary_file.write_text(json.dumps(summary, sort_keys=True,
                                       ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    loaded = [json.loads(line) for line in cases_file.read_text().splitlines()]
    if loaded != cases or sha256(cases_file.read_bytes()).hexdigest() != digest:
        raise ValueError("lossy benchmark evidence publication")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True)
    args = parser.parse_args()
    materialize(args.input, args.summary, args.cases)
