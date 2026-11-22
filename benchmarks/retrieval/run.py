"""Real offline BGE-M3 lexical/dense/hybrid 03B frozen-corpus trial.

Guarded worker only. No fake vectors, models on demand, Vault data, network,
or original query text in published diagnostics.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import json
from pathlib import Path
import resource
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from benchmarks.corpus_v1 import ROOT as CORPUS, read_json, sha, validate
from benchmarks.embedding.run import _resource_evidence
from benchmarks.lexical_metrics import score, summarize
from engine.embedding import OfflineDenseReference, verify_active_experiment_guard
from engine.markdown import read_markdown
from engine.retrieval import Predicate, RetrievalIndex
from engine.scope import ScopedReader


def run(snapshot: Path) -> dict:
    verify_active_experiment_guard()
    manifest, _ = validate()
    reader = ScopedReader(CORPUS / "sources")
    index = None
    try:
        docs = tuple(read_markdown(reader, src["path"]) for src in manifest["sources"])
        started = time.perf_counter()
        model = OfflineDenseReference(snapshot)
        model_load_s = time.perf_counter() - started
        started = time.perf_counter()
        index = RetrievalIndex(reader, docs, model)
        index_wall_s = time.perf_counter() - started
        if len(index._vectors) == 0 or len(index._vectors) != len(index._blocks):
            raise ValueError("partial dense leg cannot be accepted")
        # Explicit scope and type test with live dense-backed generation.
        pred = (Predicate("status", "string", "accepted"),)
        filtered = index.search("Aurora mutual TLS", "hybrid", predicates=pred)
        if filtered.status != "ok" or any(hit.path != "aurora-adr.md" for hit in filtered.hits):
            raise ValueError("typed hybrid metadata filter mismatch")
        modes = ("lexical", "dense", "hybrid")
        splits: dict[str, dict] = {}
        timings = {}
        errors = 0
        provenance_errors = 0
        leg_consistency_errors = 0
        for split in ("tuning", "held_out"):
            prompts = read_json(CORPUS / (split + ".json"))
            splits[split] = {}
            timings[split] = {}
            for mode in modes:
                rows, elapsed = [], []
                for query in prompts:
                    started = time.perf_counter()
                    response = index.search(query["query"], mode, limit=10)
                    elapsed.append((time.perf_counter() - started) * 1000)
                    if (response.status != "ok" or response.executed_mode != mode
                            or response.requested_mode != mode
                            or response.generation_id != index.generation_id):
                        errors += 1
                        raise ValueError("wrong-mode, missing-leg or incompatible generation")
                    ranked = [(h.path, h.line_start) for h in response.hits]
                    if len(set(ranked)) != len(ranked):
                        raise ValueError("duplicate evidence")
                    for hit in response.hits:
                        source = reader.read(hit.path)
                        if (source.digest != hit.source_sha256
                                or source.data[hit.byte_start:hit.byte_end].decode("utf-8")
                                != hit.excerpt):
                            provenance_errors += 1
                            raise ValueError("unsupported/generated provenance")
                        if mode == "hybrid" and hit.rrf_score is None:
                            leg_consistency_errors += 1
                            raise ValueError("unreported RRF or leg rank")
                        if mode == "dense" and hit.dense_rank is None:
                            leg_consistency_errors += 1
                            raise ValueError("missing dense leg")
                    labels = {(row["path"], row["line"]): row["grade"] for row in query["labels"]}
                    rows.append({
                        "id": query["id"], "exact": query["exact"],
                        "unanswerable": query["unanswerable"],
                        "ranked": ranked, "metrics": score(ranked, labels),
                    })
                splits[split][mode] = {
                    "summary": summarize(rows),
                    "per_query": rows,
                }
                timings[split][mode] = {
                    "queries": len(elapsed),
                    "median_ms": statistics.median(elapsed),
                    "max_ms": max(elapsed),
                    "p95_ms": sorted(elapsed)[min(
                        len(elapsed) - 1, (95 * len(elapsed) + 99) // 100 - 1)],
                }
        cap = _resource_evidence()
        if cap["memory_peak_bytes"] > cap["memory_max_bytes"]:
            raise ValueError("memory limit exceeded")
        if any(cap["memory_events"].get(event, 0)
               for event in ("high", "max", "oom", "oom_kill")):
            raise ValueError("cgroup memory pressure event")
        return {
            "schema_version": 1,
            "phase": "OKS-03B",
            "experimental_profile": "Python-reference-only",
            "model_backed": True,
            "offline": True,
            "no_source_content_recorded": True,
            "no_fake_embedding": True,
            "real_tokenizer_runtime_parity": model.identity.runtime_tokenizer_parity_verified,
            "model_identity": asdict(model.identity),
            "index_generation_id": index.generation_id,
            "source_manifest_sha256": sha((CORPUS / "manifest.json").read_bytes()),
            "judgment_sha256": manifest["judgments"],
            "source_count": len(docs),
            "block_count": len(index._blocks),
            "dense_record_count": len(index._vectors),
            "model_load_wall_seconds": model_load_s,
            "index_build_wall_seconds": index_wall_s,
            "timing": timings,
            "split_metrics": splits,
            "query_mode_error_count": errors,
            "provenance_error_count": provenance_errors,
            "leg_consistency_error_count": leg_consistency_errors,
            "process_peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "resource_evidence": cap,
            "standalone_implemented": False,
            "mvp_accepted": False,
        }
    finally:
        if index is not None:
            index.close()
        reader.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.snapshot), ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")))
