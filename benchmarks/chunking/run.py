"""Reproduce 02C four-policy comparisons under an offline, bounded cgroup."""
from __future__ import annotations
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import resource
import socket
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from engine.chunking import ChunkPolicy, coverage_report, plan_chunks
from engine.document import Cell, NativeAnchor, NativeLocation, ParsedBlock, ParsedDocument
from engine.extraction import DOCX, extract
from engine.markdown import parse_markdown
from engine.native_chunking import run_native
from engine.scope import ScopedReader
from engine.token_budget import ExactTokenizer
from benchmarks.extraction.run_structured import runtime_cgroup

CORPUS = ROOT / "benchmarks/corpus/v1"
EXTRACTION = ROOT / "benchmarks/extraction"
BUDGETS = (48, 96, 192)
OVERLAPS = (0, 12)
POLICIES = ("fixed-window", "paragraph", "structure", "native-hybrid")


def _check_file(path: Path, digest: str):
    if sha256(path.read_bytes()).hexdigest() != digest:
        raise ValueError("frozen source digest mismatch")


def _native_replay(name: str, result_file: Path, digest: str) -> ParsedDocument:
    """Read recorded verified 02B blocks without running PDF inference."""
    data = json.loads(result_file.read_text())
    if data["source_digest"] != digest or not data.get("blocks_detail"):
        raise ValueError("unverified recorded extraction")
    tables, row_indices, blocks = {}, {}, []
    for n, entry in enumerate(data["blocks_detail"]):
        ref = entry["ref"]
        locations = tuple(NativeLocation(x["page"], tuple(x["bbox"]), x["origin"],
                                         tuple(x["char_span"]) if x["char_span"] else None)
                          for x in entry["locations"])
        anchor = NativeAnchor(ref, entry["layer"], entry["representation"], locations)
        table = row = None
        if entry["kind"] == "table_row":
            if ref not in tables:
                tables[ref], row_indices[ref] = len(tables) + 1, 0
            row_indices[ref] += 1
            table, row = tables[ref], row_indices[ref]
        cells = tuple(Cell(i + 1, v["text"], None, NativeAnchor(
            ref, entry["layer"], "native-table-cell", (),
            tuple(v["row_range"]) if v["row_range"] else None,
            tuple(v["col_range"]) if v["col_range"] else None,
            tuple(v["bbox"]) if v["bbox"] else None, v["origin"]))
            for i, v in enumerate(entry["cells"]))
        blocks.append(ParsedBlock(name, digest, n, entry["kind"], entry["text"],
                                  None, tuple(entry["headings"]), cells, table, row,
                                  entry["clause"], page=entry["page"],
                                  bbox=locations[0].bbox if len(locations) == 1 else None,
                                  native=anchor))
    return ParsedDocument(name, digest, data["status"], tuple(blocks),
                          tuple(data["diagnostics"]), extraction_profile=data["extraction_profile"],
                          page_count=data["page_count"])


def _stress() -> ParsedDocument:
    clause = "REQ-STRESS-701: " + "Проверка исключения ABC-42, 30 дней. " * 35
    listing = "- " + "Нормативный пункт о доступе 0xDEAD-BEEF. " * 35
    cell = "Длинное объединённое значение " * 20
    data = ("# Synthetic stress\n## Requirements\n" + clause + "\n" +
            listing + "\n## Matrix\n| ID | Value |\n| --- | --- |\n" +
            "| REQ-MERGED | " + cell + " |\n").encode()
    if len(data) > 8192:
        raise ValueError("stress fixture exceeds 02A Markdown cap")
    return parse_markdown("generated-stress.md", data)


def load_documents() -> tuple[tuple[ParsedDocument, ...], dict]:
    manifest = json.loads((CORPUS / "manifest.json").read_text())
    docs = []
    for entry in manifest["sources"]:
        path = CORPUS / "sources" / entry["path"]
        _check_file(path, entry["sha256"])
        doc = parse_markdown(entry["path"], path.read_bytes())
        if doc.digest != entry["sha256"] or doc.status in ("failed", "unsupported"):
            raise ValueError("frozen Markdown parse failure")
        docs.append(doc)
    native_manifest = json.loads((EXTRACTION / "manifest.json").read_text())
    for name, file in (("policy.pdf", "results-structured-policy.json"),
                       ("scan.pdf", "results-structured-scan.json")):
        digest = native_manifest["sources"][name]["sha256"]
        _check_file(EXTRACTION / "fixtures" / name, digest)
        docs.append(_native_replay(name, EXTRACTION / file, digest))
    reader = ScopedReader(EXTRACTION / "fixtures")
    try:
        docx = extract(reader, "policy.docx", DOCX)
    finally:
        reader.close()
    if (docx.status != "ok" or
            docx.digest != native_manifest["sources"]["policy.docx"]["sha256"]):
        raise ValueError("native DOCX extraction changed or failed")
    docs.append(docx)
    stress = _stress()
    if stress.status != "ok":
        raise ValueError("synthetic stress parsing failed")
    docs.append(stress)
    return tuple(docs), {
        "markdown_manifest_sha256": sha256((CORPUS / "manifest.json").read_bytes()).hexdigest(),
        "extraction_manifest_sha256": sha256((EXTRACTION / "manifest.json").read_bytes()).hexdigest(),
        "recorded_pdf_sha256": sha256((EXTRACTION / "results-structured-policy.json").read_bytes()).hexdigest(),
        "recorded_scan_sha256": sha256((EXTRACTION / "results-structured-scan.json").read_bytes()).hexdigest(),
        "stress_sha256": stress.digest,
        "sources": len(docs), "partial_sources": sum(d.status == "partial" for d in docs),
    }


def _case(doc, policy, tokenizer, snapshot, extras):
    start = time.perf_counter()
    try:
        native = (run_native(doc, policy, tokenizer, snapshot, plugin_path=extras)
                  if policy.name == "native-hybrid" else None)
        chunks = native.chunks if native else plan_chunks(doc, policy, tokenizer)
        metrics = coverage_report(doc, chunks, tokenizer)
        failure = None
    except Exception as exc:
        metrics, native, failure = None, None, type(exc).__name__
    return {
        "source": doc.path, "source_hash": doc.digest,
        "extraction_profile": doc.extraction_profile or "markdown-lines-v1",
        "policy": policy.name, "max_tokens": policy.max_tokens,
        "overlap_tokens": policy.overlap_tokens, "metrics": metrics,
        "outcome": "failed" if failure else "measured", "failure_type": failure,
        "native_output_chunks": native.native_output_count if native else None,
        "native_unaligned_count": len(native.unaligned_chunks) if native else None,
        "native_unaligned_causes": sorted({v["cause"] for v in native.unaligned_chunks})
                                   if native else None,
        "native_overlap_applied": native.overlap_applied if native else None,
        "seconds": round(time.perf_counter() - start, 6),
        "cumulative_process_peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    }


def main(snapshot: Path, extras: Path):
    if os.getenv("HF_HUB_OFFLINE") != "1" or os.getenv("TRANSFORMERS_OFFLINE") != "1":
        raise ValueError("offline mode required")
    if {name for _, name in socket.if_nameindex()} - {"lo"}:
        raise ValueError("network-isolated namespace required")
    group = runtime_cgroup()
    docs, manifest = load_documents()
    tokenizer = ExactTokenizer(snapshot)
    cases = []
    for source_index, doc in enumerate(docs):
        for budget in BUDGETS:
            for overlap in OVERLAPS:
                for name in POLICIES:
                    cases.append(_case(doc, ChunkPolicy(name, budget, overlap),
                                       tokenizer, snapshot, extras))
        print(f"CHUNK_BENCH_SOURCE={source_index + 1}/{len(docs)}"
              f" CASES={len(cases)}", file=sys.stderr, flush=True)
    stress = next(d for d in docs if d.path == "generated-stress.md")
    repeated = {}
    for name in POLICIES:
        policy = ChunkPolicy(name, 96, 0)
        def ids():
            chunks = (run_native(stress, policy, tokenizer, snapshot, plugin_path=extras).chunks
                      if name == "native-hybrid" else plan_chunks(stress, policy, tokenizer))
            return tuple(c.id for c in chunks)
        repeated[name] = ids() == ids()
    if not all(repeated.values()):
        raise ValueError("nondeterministic chunk IDs")
    return {
        "protocol_version": 1, "input": manifest, "tokenizer": tokenizer.identity,
        "policies": list(POLICIES), "budgets": list(BUDGETS),
        "overlap_tokens": list(OVERLAPS), "cases": cases,
        "deterministic_repeat": repeated,
        "native_comparator": "Docling core 2.108.0 HybridChunker on canonical DoclingDocument projection",
        "summary": {
            "runs": len(cases), "failures": sum(c["metrics"] is None for c in cases),
            "zero_loss": sum(c["metrics"] is not None and not c["metrics"]["lost_spans"] for c in cases),
            "budget_violations": sum(c["metrics"] is not None
                                     and c["metrics"]["token_budget_violations"] > 0 for c in cases),
        },
        "resource_evidence": {
            "memory_max": int((group / "memory.max").read_text()),
            "swap_max": int((group / "memory.swap.max").read_text()),
            "pids_max": int((group / "pids.max").read_text()),
            "cpu_max": (group / "cpu.max").read_text().strip(),
            "affinity_cpus": len(os.sched_getaffinity(0)),
            "memory_peak_bytes": int((group / "memory.peak").read_text()),
            "memory_events": dict(v.split() for v in (group / "memory.events").read_text().splitlines()),
            "cpu_stat": dict(v.split() for v in (group / "cpu.stat").read_text().splitlines()),
            "process_peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "network_interfaces": ["lo"],
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--chunk-extras", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(main(args.snapshot, args.chunk_extras),
                     ensure_ascii=False, sort_keys=True, indent=2))
