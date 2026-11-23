"""Opt-in one-shot offline production ingestion worker. Never run without cgroup admission.

This is deliberately independent from engine/persistent.py (health-only v2).
No parser/model imports or source reads occur before actual kernel limit checks.
"""
from __future__ import annotations

import contextlib
import os
from pathlib import Path
import socket
import sys
import time

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine import advanced_protocol as wire

MEMORY_LIMIT = 4 * 1024 ** 3
MEMORY_RESERVE = (5 * 1024 ** 3) // 2
DISK_RESERVE = 1024 ** 3
MAX_CPU = 2.0
MAX_PIDS = 64


def resource_preflight() -> None:
    if sys.platform != "linux":
        raise RuntimeError("unsupported platform")
    value = Path("/proc/self/cgroup").read_text().strip().splitlines()
    if len(value) != 1 or not value[0].startswith("0::"):
        raise RuntimeError("missing cgroup v2 membership")
    path = value[0][3:]
    name = path.rsplit("/", 1)[-1]
    if not name.startswith("oks-ingest-") or not name.endswith(".service"):
        raise RuntimeError("unverified ingestion process tree")
    directory = Path("/sys/fs/cgroup") / path.lstrip("/")
    for key, maximum in (("memory.max", MEMORY_LIMIT),
                         ("memory.swap.max", 0), ("pids.max", MAX_PIDS)):
        raw = (directory / key).read_text().strip()
        if not raw.isdigit() or int(raw) > maximum or key != "memory.swap.max" and int(raw) == 0:
            raise RuntimeError("unverified cgroup resource limit")
    cpu = (directory / "cpu.max").read_text().strip().split()
    if len(cpu) != 2 or not cpu[0].isdigit() or not cpu[1].isdigit() or not (
            0 < int(cpu[0]) <= MAX_CPU * int(cpu[1]) and int(cpu[1]) > 0):
        raise RuntimeError("unverified CPU quota")
    # Verify effective network denial, not a claimed command-line flag.
    try:
        forbidden = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except OSError:
        pass
    else:
        forbidden.close()
        raise RuntimeError("network isolation ineffective")
    info = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    if int(info["MemAvailable"].split()[0]) * 1024 < MEMORY_LIMIT + MEMORY_RESERVE:
        raise RuntimeError("host memory reserve")
    if os.statvfs("/tmp").f_bavail * os.statvfs("/tmp").f_frsize < DISK_RESERVE:
        raise RuntimeError("host disk reserve")
    for variable in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
        if os.environ.get(variable) != "1":
            raise RuntimeError("offline library environment missing")


def check_deadline(deadline: int) -> None:
    if time.time_ns() // 1_000_000 >= deadline:
        raise TimeoutError("extraction deadline")


def ingest(value: dict) -> dict:
    # All format/type checking before any source access.
    req = wire.request(value)
    nonce = req["requestId"]
    try:
        resource_preflight()
        deadline = req["deadlineUnixMs"]
        now = time.time_ns() // 1_000_000
        if not now < deadline <= now + 120_000:
            raise TimeoutError("invalid deadline window")
        from engine.scope import ScopedReader
        from engine.document import ParsedDocument
        from engine.token_budget import ExactTokenizer, TokenBudgetError
        from engine.chunking import ChunkPolicy, plan_chunks, coverage_report
        from engine.extraction import extract
        from engine.markdown import parse_markdown

        root = Path(req["rootPath"])
        reader = ScopedReader(root)
        try:
            if wire.source_root_id(str(root), *reader.identity) != req["scopeId"]:
                raise ValueError("root identity mismatch")
            source = reader.read(req["sourcePath"], 65536)
            if source.digest != req["expectedSha256"]:
                raise ValueError("source version mismatch")
            check_deadline(deadline)
            profile = req["profileId"]
            # Explicit library configuration and bounded parser operation.
            # Docling's incidental stdout is discarded rather than corrupting
            # the strict machine-readable protocol or collecting source text.
            with open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull):
                if profile == "oks-advanced-markdown-v1":
                    doc = parse_markdown(req["sourcePath"], source.data)
                    doc = ParsedDocument(doc.path, doc.digest, doc.status, doc.blocks,
                                         doc.diagnostics, doc.properties,
                                         extraction_profile=profile)
                else:
                    doc = extract(reader, req["sourcePath"], profile,
                                  tessdata=Path(req["tessdataPath"]) if req["tessdataPath"] else None,
                                  artifacts=Path(req["artifactsPath"]) if req["artifactsPath"] else None)
                check_deadline(deadline)
                # Tokenizer-only local model snapshot; no inference/weights loading.
                # A missing/incompatible tokenizer is not a best-effort fallback.
                tokenizer = ExactTokenizer(Path(req["tokenizerSnapshot"]))
                check_deadline(deadline)
                if doc.status in ("ok", "partial") and doc.blocks:
                    chunks = plan_chunks(doc, ChunkPolicy("structure", 384), tokenizer)
                    report = coverage_report(doc, chunks, tokenizer)
                    if (report["lost_spans"] or report["token_budget_violations"]
                            or report["source_coverage"] != 1.0):
                        raise ValueError("chunk coverage or token-budget violation")
                else:
                    chunks = ()
                check_deadline(deadline)
            # Reopen authoritative bytes after heavy extraction and before reply.
            if reader.read(req["sourcePath"], 65536).digest != source.digest:
                raise ValueError("source changed during extraction")
            if doc.digest is not None and doc.digest != source.digest:
                raise ValueError("extractor source hash mismatch")
            check_deadline(deadline)
            result_source = wire.project_document(doc, source.data, req["scopeId"], profile)
            result_chunks = wire.project_chunks(chunks, result_source)
            result_status = result_source["extractionStatus"]
            # Native missing page/geometry/derived text cannot be silently ready.
            incomplete = any(
                block["locator"]["diagnostics"] and
                any(item in block["locator"]["diagnostics"] for item in
                    ("native-page-location-missing", "source-locator-missing", "native-text-not-verbatim"))
                for block in result_source["blocks"])
            if incomplete and result_status == "ok":
                result_status = "partial"
                result_source["extractionStatus"] = "partial"
                result_source["diagnostics"] = sorted(
                    set(result_source["diagnostics"]) | {"native-provenance-incomplete"})
            return wire.response(nonce, result_status, result_source, result_chunks,
                                 result_source["diagnostics"])
        finally:
            reader.close()
    except TimeoutError:
        return wire.response(nonce, "failed", None, diagnostics=["deadline-exceeded"], error="ADVANCED_TIMEOUT")
    except (OSError, ValueError) as error:
        reason = str(error)
        code = ("SOURCE_STALE" if "version mismatch" in reason or
                "source changed" in reason else "SOURCE_REJECTED")
        return wire.response(nonce, "failed", None, diagnostics=["source-or-policy-rejected"], error=code)
    except Exception as error:
        # Never leak parser internals, original source, file names or traceback.
        kind = type(error).__name__
        code = ("ADVANCED_RESOURCE_REFUSED" if isinstance(error, RuntimeError)
                else "TOKENIZER_UNAVAILABLE" if kind == "TokenBudgetError"
                else "EXTRACTION_FAILED")
        return wire.response(nonce, "failed", None, diagnostics=["ingestion-failed"], error=code)


def main() -> int:
    # Require the complete canonical single request; no request queue or
    # transparent recovery from ambiguous output boundaries.
    data = sys.stdin.buffer.readline(wire.MAX_REQUEST + 1)
    try:
        req = wire.request(wire.decode(data))
    except (ValueError, KeyError, TypeError, OverflowError):
        return 2
    result = ingest(req)
    try:
        sys.stdout.buffer.write(wire.encode(result))
        sys.stdout.buffer.flush()
    except (ValueError, BrokenPipeError, OSError):
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
