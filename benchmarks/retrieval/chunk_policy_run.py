"""03B model-backed paired chunk-policy retrieval on immutable 02A pilot.

The three approved 02C canonical policies use exactly the same extraction,
BGE-M3 weights, tokenizer, query judgments, source span validation and budget.
The known-unaligned native projection remains excluded from ranked acceptance.
"""
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

from benchmarks.corpus_v1 import ROOT as CORPUS, read_json, sha, validate
from benchmarks.embedding.run import _resource_evidence
from benchmarks.lexical_metrics import score, summarize
from engine.chunking import ChunkPolicy, coverage_report, plan_chunks
from engine.embedding import OfflineDenseReference, verify_active_experiment_guard
from engine.lexical import LexicalIndex
from engine.markdown import read_markdown
from engine.retrieval import rrf_fusion
from engine.scope import ScopedReader

POLICIES = ("fixed-window", "paragraph", "structure")
MAX_TOKENS = 96
OVERLAP_TOKENS = 0


def line_anchors(doc, chunk):
    """Project only canonical, locally verifiable original Markdown line slices."""
    seen = set()
    result = []
    for fragment, locator in zip(chunk.slices, chunk.locators, strict=True):
        block = doc.blocks[fragment.block_order]
        if (block.span is None or locator.file_bytes is None or
                fragment.start < 0 or fragment.end > len(block.text)
                or fragment.start >= fragment.end or
                (locator.file_bytes.start, locator.file_bytes.end) != (
                    block.span.start + len(block.text[:fragment.start].encode("utf-8")),
                    block.span.start + len(block.text[:fragment.end].encode("utf-8")))):
            raise ValueError("unverifiable source slice: cannot claim evidence")
        anchor = (doc.path, block.span.line_start)
        if anchor not in seen:
            seen.add(anchor)
            result.append(anchor)
    return tuple(result)


def line_key(anchor):
    path, line = anchor
    return json.dumps([path, line], ensure_ascii=False, separators=(",", ":"))


def decode_line_key(value):
    path, line = json.loads(value)
    return path, line


def run(snapshot: Path) -> dict:
    verify_active_experiment_guard()
    manifest, _ = validate()
    reader = ScopedReader(CORPUS / "sources")
    lexical = None
    try:
        docs = tuple(read_markdown(reader, row["path"]) for row in manifest["sources"])
        start = time.perf_counter()
        model = OfflineDenseReference(snapshot)
        model_load_s = time.perf_counter() - start
        lexical = LexicalIndex(reader, docs)
        candidates = {}
        build_seconds = {}
        policies_summary = {}
        for name in POLICIES:
            started = time.perf_counter()
            policy = ChunkPolicy(name, MAX_TOKENS, OVERLAP_TOKENS)
            records = []
            coverage_errors = 0
            budget_errors = 0
            for doc in docs:
                if doc.status not in ("ok", "partial"):
                    continue
                chunks = plan_chunks(doc, policy, model._counter)
                report = coverage_report(doc, chunks, model._counter)
                if report["lost_spans"]:
                    coverage_errors += 1
                budget_errors += report["token_budget_violations"]
                for chunk in chunks:
                    if chunk.token_count > MAX_TOKENS:
                        raise ValueError("unvalidated embedding token count")
                    anchors = line_anchors(doc, chunk)
                    if not anchors:
                        raise ValueError("chunk without exact original locator")
                    vector = model.embed(chunk.embedding_text)
                    records.append((chunk.id, anchors, vector))
            if coverage_errors or budget_errors:
                raise ValueError("source coverage or token budget violated")
            if not all(reader.fresh(doc.path, doc.digest) for doc in docs
                       if doc.status in ("ok", "partial")):
                raise ValueError("source changed during model indexing")
            candidates[name] = records
            build_seconds[name] = time.perf_counter() - started
            policies_summary[name] = {
                "chunks": len(records),
                "source_coverage_failures": coverage_errors,
                "token_budget_violations": budget_errors,
                "model_backed_vectors": len(records),
            }
        results = {}
        times = {}
        for split in ("tuning", "held_out"):
            results[split], times[split] = {}, {}
            queries = read_json(CORPUS / (split + ".json"))
            for name in POLICIES:
                rows = []
                durations = []
                records = candidates[name]
                for item in queries:
                    started = time.perf_counter()
                    query_vector = model.embed(item["query"])
                    scored = sorted(
                        ((math.fsum(a*b for a, b in zip(vector, query_vector)), cid, anchors)
                         for cid, anchors, vector in records),
                        key=lambda x: (-x[0], x[1]))
                    dense_lines = list(dict.fromkeys(
                        line_key(anchor) for _, _, anchors in scored for anchor in anchors))
                    lexical_lines = list(dict.fromkeys(
                        line_key((block.path, block.span.line_start))
                        for block in lexical.search(item["query"], 50)))
                    fusion_lines = [row[0] for row in rrf_fusion(
                        tuple(lexical_lines), tuple(dense_lines))]
                    modes = {"lexical": lexical_lines, "dense": dense_lines,
                             "hybrid": fusion_lines}
                    graded = {(r["path"], r["line"]): r["grade"] for r in item["labels"]}
                    timings = (time.perf_counter() - started)*1000
                    durations.append(timings)
                    rows.append({
                        "id": item["id"],
                        "exact": item["exact"],
                        "unanswerable": item["unanswerable"],
                        "ranked": {
                            mode: [decode_line_key(key) for key in ranked[:10]]
                            for mode, ranked in modes.items()
                        },
                        "metrics": {
                            mode: score([decode_line_key(key) for key in ranked[:10]], graded)
                            for mode, ranked in modes.items()
                        },
                    })
                results[split][name] = {}
                for mode in ("lexical", "dense", "hybrid"):
                    mode_rows = [{
                        "id": row["id"], "exact": row["exact"],
                        "unanswerable": row["unanswerable"],
                        "ranked": row["ranked"][mode],
                        "metrics": row["metrics"][mode],
                    } for row in rows]
                    results[split][name][mode] = summarize(mode_rows)
                times[split][name] = {
                    "query_count": len(durations),
                    "p50_ms": statistics.median(durations),
                    "max_ms": max(durations),
                }
        resource_counters = _resource_evidence()
        if (resource_counters["memory_peak_bytes"] > resource_counters["memory_max_bytes"]
                or any(resource_counters["memory_events"].get(name, 0)
                       for name in ("high", "max", "oom", "oom_kill"))):
            raise ValueError("cgroup memory bound violated")
        return {
            "protocol_version": 1,
            "phase": "OKS-03B-CHUNKS",
            "profile": "python-reference-only",
            "model_backed": True,
            "offline": True,
            "no_fake_embedding": True,
            "model_identity": asdict(model.identity),
            "same_parser_and_tokenizer": True,
            "fixed_full_token_budget": MAX_TOKENS,
            "fixed_original_overlap_tokens": OVERLAP_TOKENS,
            "source_manifest_sha256": sha((CORPUS / "manifest.json").read_bytes()),
            "judgment_sha256": manifest["judgments"],
            "source_count": len(docs),
            "comparison_policies": list(POLICIES),
            "native_hybrid_policy": "excluded-provenance-incomplete-per-02c",
            "model_load_wall_seconds": model_load_s,
            "build_wall_seconds": build_seconds,
            "policy_record_counts": policies_summary,
            "quality": results,
            "latency": times,
            "process_peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "resource_evidence": resource_counters,
            "limitations": ["small-synthetic-corpus", "chunk-to-line-anchor-projection",
                            "not-a-production-policy-adoption", "no-native-pdf-docx-quality-judgments"],
        }
    finally:
        if lexical is not None:
            lexical.close()
        reader.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.snapshot), sort_keys=True, ensure_ascii=False,
                     separators=(",", ":")))
