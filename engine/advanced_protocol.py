"""OKS-05C strict, canonical production document wire (never health-only v2)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
import hashlib
import json
import math
import re
from typing import Any

VERSION = 3
MAX_REQUEST = 8192
MAX_RESPONSE = 8 * 1024 * 1024
MAX_BLOCKS = 8192
MAX_CHUNKS = 10000
HEX = re.compile(r"^[0-9a-f]{64}$")
NONCE = re.compile(r"^[0-9a-f]{48}$")
PROFILE = {
    "oks-advanced-markdown-v1": "markdown",
    "docling-docx-2.151.1": "docx",
    "docling-native-pdf-2.151.1": "pdf",
    "tesseract-cli-5.3.4-eng-rus": "pdf",
    "docling-heron-tableformer-fast-2.151.1": "pdf",
    "docling-heron-tableformer-fast-tesseract-2.151.1": "pdf",
}
STATUS = {"ok", "partial", "empty", "failed", "unsupported"}
REQ_KEYS = {"protocolVersion", "requestId", "operation", "rootPath",
            "sourcePath", "scopeId", "expectedSha256", "profileId",
            "deadlineUnixMs", "tokenizerSnapshot", "tessdataPath", "artifactsPath"}
REPLY_KEYS = {"protocolVersion", "requestId", "operation", "status", "source",
              "chunks", "generationId", "diagnostics", "error"}


def _object(pairs: list[tuple[str, Any]]) -> dict:
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate JSON field")
        obj[key] = value
    return obj


# v3 uses ECMAScript JSON.stringify-compatible shortest binary64 numbers, not
# Python's JSON exponent padding or its different fixed/scientific thresholds.
# Both language codecs sort object keys by Unicode *code points*.
MAX_SAFE_INTEGER = 2**53 - 1


def _number_text(value: float | int) -> str:
    if type(value) is int:
        if abs(value) > MAX_SAFE_INTEGER:
            # JSON parses unquoted 1e20 and other ECMAScript numeric spellings
            # as Python int. Accept only numbers whose shortest binary64 JSON
            # rendering is *exactly* that same decimal spelling.
            try:
                number = float(value)
            except OverflowError as exc:
                raise ValueError("non-interoperable JSON integer") from exc
            if not math.isfinite(number) or _number_text(number) != str(value):
                raise ValueError("non-interoperable JSON integer")
        return str(value)
    if not math.isfinite(value):
        raise ValueError("nonfinite JSON number")
    if value == 0:
        return "0"  # JSON.stringify(-0) is 0.
    shortest = repr(value)
    if 1e-6 <= abs(value) < 1e21:
        # Python and JavaScript use the same shortest round-trip digits, but
        # Python switches to exponent notation at different magnitudes.
        fixed = format(Decimal(shortest), "f")
        return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
    if "e" not in shortest:
        return shortest.removesuffix(".0")
    mantissa, exponent = shortest.split("e")
    return mantissa.removesuffix(".0") + "e" + f"{int(exponent):+d}"


def _canonical(value: Any) -> str:
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) in (int, float):
        return _number_text(value)
    if type(value) is str:
        # Unpaired surrogates have no UTF-8 representation; never serialize
        # them as seemingly valid JSON text in only one runtime.
        value.encode("utf-8", errors="strict")
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if type(value) in (tuple, list):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    if type(value) is dict:
        if any(type(key) is not str for key in value):
            raise ValueError("non-string JSON key")
        return "{" + ",".join(_canonical(key) + ":" + _canonical(value[key])
                              for key in sorted(value)) + "}"
    raise ValueError("unsupported canonical JSON type")


def encode(value: Any, limit: int = MAX_RESPONSE) -> bytes:
    try:
        payload = _canonical(value).encode("utf-8") + b"\n"
    except UnicodeError as exc:
        raise ValueError("invalid Unicode JSON scalar") from exc
    if len(payload) > limit:
        raise ValueError("oversized frame")
    return payload


def decode(data: bytes, limit: int = MAX_REQUEST) -> dict:
    if (type(data) is not bytes or not 2 <= len(data) <= limit
            or not data.endswith(b"\n") or data.count(b"\n") != 1
            or data.startswith(b"\xef\xbb\xbf")):
        raise ValueError("invalid frame")
    try:
        text = data[:-1].decode("utf-8", errors="strict")
        obj = json.loads(text, object_pairs_hook=_object,
                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("invalid JSON/UTF-8") from exc
    if type(obj) is not dict or encode(obj, limit) != data:
        raise ValueError("noncanonical JSON")
    return obj


def allowed_path(value: Any) -> bool:
    return (type(value) is str and 0 < len(value.encode("utf-8")) <= 1024
            and not value.startswith("/") and "\\" not in value and "\x00" not in value
            and all(part and part not in (".", "..") and not part.startswith(".")
                    and ":" not in part for part in value.split("/")))


def digest(value: Any) -> bool:
    return type(value) is str and HEX.fullmatch(value) is not None


def request(value: dict) -> dict:
    if (type(value) is not dict or set(value) != REQ_KEYS
            or type(value["protocolVersion"]) is not int or value["protocolVersion"] != VERSION
            or type(value["requestId"]) is not str or not NONCE.fullmatch(value["requestId"])
            or value["operation"] != "ingest"
            or not allowed_path(value["sourcePath"])
            or not digest(value["scopeId"]) or not digest(value["expectedSha256"])
            or value["profileId"] not in PROFILE
            or not value["sourcePath"].lower().endswith("." + PROFILE[value["profileId"]].replace("markdown", "md"))
            or type(value["deadlineUnixMs"]) is not int
            or not 0 < value["deadlineUnixMs"] < 2**53):
        raise ValueError("invalid request")
    for key in ("rootPath", "tokenizerSnapshot", "tessdataPath", "artifactsPath"):
        name = value[key]
        if name is None and key in ("tessdataPath", "artifactsPath"):
            continue
        if (type(name) is not str or not name.startswith("/") or len(name) > 4096
                or "\x00" in name or "\\" in name or any(p in (".", "..") for p in name.split("/")[1:])
                or name == "/"):
            raise ValueError("noncanonical trusted path")
    return value


def source_root_id(root: str, device: int, inode: int) -> str:
    # Parity with the existing Standalone BoundedVaultReader.rootId (JS JSON.stringify).
    payload = json.dumps([root, device, inode], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def scalar_type(value: Any) -> str:
    if value is None:
        return "null"
    if type(value) is bool:
        return "boolean"
    if type(value) in (float, int) and math.isfinite(value):
        return "number"
    if type(value) is str:
        try:
            return "date" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) and date.fromisoformat(value) else "string"
        except ValueError:
            return "string"
    raise ValueError("unsupported typed Property")


def _property_value(raw: str) -> tuple[Any, str]:
    raw = raw.strip()
    if raw.startswith("["):
        if not raw.endswith("]"):
            raise ValueError("invalid property list")
        value = json.loads(raw, object_pairs_hook=_object)
        if (type(value) is not list or len(value) > 64 or
                any(type(v) not in (str, int, float, bool, type(None)) or
                    type(v) in (int, float) and (
                        not math.isfinite(v) or
                        type(v) is int and abs(v) > MAX_SAFE_INTEGER) for v in value)):
            raise ValueError("unsupported property list")
        return value, "list"
    if raw in ("", "null", "~"):
        return None, "null"
    if raw in ("true", "false"):
        return raw == "true", "boolean"
    if re.fullmatch(r"-?(?:0|[1-9]\d*)(?:\.\d+)?", raw):
        number = json.loads(raw)
        if not math.isfinite(number) or type(number) is int and abs(number) > MAX_SAFE_INTEGER:
            raise ValueError("unbounded numeric property")
        return number, "number"
    if raw.startswith('"'):
        result = json.loads(raw)
        if type(result) is not str:
            raise ValueError("invalid quoted property")
        return result, "string"
    if raw.startswith("'") and raw.endswith("'"):
        return raw[1:-1].replace("''", "'"), "string"
    if (re.search(r"[\[\]{}&*!\x00]", raw) or raw.startswith((">", "|"))
            or "# " in raw or ": " in raw):
        raise ValueError("unsupported YAML syntax")
    return raw, scalar_type(raw)


def markdown_properties(raw: bytes) -> tuple[list[dict], list[str]]:
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return [], ["invalid-utf8"]
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        return [], []
    try:
        end = lines.index("---", 1)
    except ValueError:
        return [], ["unterminated-front-matter"]
    output, seen = [], set()
    try:
        position = 1
        while position < end:
            match = re.fullmatch(r"([A-Za-z_][\w-]*):(?:[ \t]*(.*))?", lines[position], re.ASCII)
            if not match:
                raise ValueError("unsupported frontmatter")
            key, raw_value = match[1], (match[2] or "").strip()
            if len(key.encode()) > 128 or key in seen or len(seen) >= 64:
                raise ValueError("duplicate/bounded frontmatter")
            seen.add(key)
            if not raw_value and position + 1 < end and re.match(r"^ {2,}- ", lines[position + 1]):
                values = []
                while position + 1 < end and re.match(r"^ {2,}- ", lines[position + 1]):
                    position += 1
                    item, kind = _property_value(re.sub(r"^ {2,}- ", "", lines[position]))
                    if kind == "list":
                        raise ValueError("nested list")
                    values.append(item)
                    if len(values) > 64:
                        raise ValueError("list bound")
                value, kind = values, "list"
            else:
                value, kind = _property_value(raw_value)
            output.append({"key": key, "valueType": kind, "value": value})
            position += 1
        return output, []
    except (ValueError, TypeError, KeyError, OverflowError, json.JSONDecodeError):
        return [], ["invalid-front-matter"]


def locator(block: Any, digest_: str, slice_start: int = 0, slice_end: int | None = None) -> dict:
    text = block.text
    if slice_end is None:
        slice_end = len(text)
    if not 0 <= slice_start <= slice_end <= len(text):
        raise ValueError("source slice outside original block")
    issues: list[str] = []
    result = dict(locatorKind="unavailable", sourceVersion=digest_, blockOrder=block.order,
                  byteStart=None, byteEnd=None, charStart=None, charEnd=None,
                  lineStart=None, lineEnd=None, nativeItemRef=None,
                  nativeRepresentation=None, contentLayer=None,
                  locations=[], table=block.table, row=block.row, diagnostics=issues)
    if block.span is not None:
        s = block.span
        if s.end - s.start != len(text.encode("utf-8")):
            issues.append("source-file-span-unverifiable")
        else:
            result.update(locatorKind="markdown",
                          byteStart=s.start + len(text[:slice_start].encode("utf-8")),
                          byteEnd=s.start + len(text[:slice_end].encode("utf-8")),
                          lineStart=s.line_start, lineEnd=s.line_end)
            # All Markdown parser blocks are single-line, so a file-wide Unicode
            # offset is reconstructable by decoding the verified original prefix.
            # set by bind_markdown_char_offsets(), not from file-byte estimates.
    elif block.native is not None:
        anchor = block.native
        result.update(locatorKind="native", nativeItemRef=anchor.item_ref,
                      nativeRepresentation=anchor.representation,
                      contentLayer=anchor.content_layer,
                      locations=[dict(page=l.page, bbox=list(l.bbox),
                                      coordinateOrigin=l.coordinate_origin,
                                      charStart=l.char_span[0] if l.char_span else None,
                                      charEnd=l.char_span[1] if l.char_span else None)
                                 for l in anchor.locations])
        if anchor.original_text != text:
            issues.append("native-text-not-verbatim")
        if not anchor.locations and block.path.lower().endswith(".pdf"):
            issues.append("native-page-location-missing")
        if block.cells:
            issues.append("table-row-is-derived-serialization")
    else:
        issues.append("source-locator-missing")
    return result


def bind_markdown_char_offsets(positioned: dict, raw: bytes) -> None:
    if positioned["locatorKind"] != "markdown":
        return
    start, end = positioned["byteStart"], positioned["byteEnd"]
    positioned["charStart"] = len(raw[:start].decode("utf-8"))
    positioned["charEnd"] = len(raw[:end].decode("utf-8"))


def _cell_locator(cell: Any, block: Any, digest_: str) -> dict:
    if cell.span is not None:
        info = dict(locatorKind="markdown", sourceVersion=digest_, blockOrder=block.order,
                    byteStart=cell.span.start, byteEnd=cell.span.end,
                    charStart=None, charEnd=None,
                    lineStart=cell.span.line_start, lineEnd=cell.span.line_end,
                    nativeItemRef=None, nativeRepresentation=None, contentLayer=None,
                    locations=[], table=block.table, row=block.row, diagnostics=[])
    elif cell.native is not None:
        info = dict(locatorKind="native", sourceVersion=digest_, blockOrder=block.order,
                    byteStart=None, byteEnd=None, charStart=None, charEnd=None,
                    lineStart=None, lineEnd=None, nativeItemRef=cell.native.item_ref,
                    nativeRepresentation=cell.native.representation,
                    contentLayer=cell.native.content_layer, locations=[], table=block.table,
                    row=block.row, diagnostics=["native-table-cell"],
                    rowRange=list(cell.native.row_range) if cell.native.row_range else None,
                    colRange=list(cell.native.col_range) if cell.native.col_range else None,
                    cellBBox=list(cell.native.cell_bbox) if cell.native.cell_bbox else None,
                    cellCoordinateOrigin=cell.native.cell_coordinate_origin)
    else:
        info = dict(locatorKind="unavailable", sourceVersion=digest_, blockOrder=block.order,
                    byteStart=None, byteEnd=None, charStart=None, charEnd=None,
                    lineStart=None, lineEnd=None, nativeItemRef=None, nativeRepresentation=None,
                    contentLayer=None, locations=[], table=block.table, row=block.row,
                    diagnostics=["cell-locator-unavailable"])
    return info


def project_document(doc: Any, raw: bytes, scope_id: str, profile: str) -> dict:
    if not digest(doc.digest) or len(doc.blocks) > MAX_BLOCKS:
        raise ValueError("source identity or block bound invalid")
    md = profile == "oks-advanced-markdown-v1"
    properties, md_errors = markdown_properties(raw) if md else ([], [])
    issues = sorted(set(doc.diagnostics) | set(md_errors))
    status = ("partial" if issues and doc.status == "ok" else doc.status)
    blocks, links = [], []
    for index, block in enumerate(doc.blocks):
        if block.order != index or block.digest != doc.digest or block.path != doc.path:
            raise ValueError("incompatible source block identity")
        loc = locator(block, doc.digest)
        if md:
            bind_markdown_char_offsets(loc, raw)
        cell_records = []
        for cell in block.cells:
            cl = _cell_locator(cell, block, doc.digest)
            if md:
                bind_markdown_char_offsets(cl, raw)
            cell_records.append({"column": cell.column, "originalText": cell.text, "locator": cl})
        text_nature = "table-cell-serialization" if block.cells and not md else "verbatim"
        block_id = hashlib.sha256(encode([doc.digest, profile, index, block.kind, block.text])[:-1]).hexdigest()
        record = {"sourceId": doc.path, "sourceSha256": doc.digest, "blockId": block_id,
                  "order": index, "kind": block.kind, "originalText": block.text,
                  "headings": list(block.headings), "wikiLinks": list(block.wiki_links),
                  "clause": block.clause, "textNature": text_nature,
                  "locator": loc, "cells": cell_records}
        blocks.append(record)
        links.extend(block.wiki_links)
    if md and doc.status != "failed" and not md_errors:
        pass
    if md_errors:
        properties = []
    return {"sourceId": doc.path, "vaultRelativePath": doc.path, "sha256": doc.digest,
            "sourceType": PROFILE[profile], "scopeId": scope_id, "profileId": profile,
            "extractionStatus": status, "properties": properties,
            "wikiLinks": list(dict.fromkeys(links)), "diagnostics": issues,
            "pageCount": doc.page_count, "blocks": blocks}


def project_chunks(chunks: tuple, source: dict) -> list[dict]:
    output = []
    blocks = source["blocks"]
    for chunk in chunks:
        slices = []
        locators = []
        for sl in chunk.slices:
            block = blocks[sl.block_order]
            # SourceSlice indices are block-local Unicode scalar offsets.
            if not 0 <= sl.start < sl.end <= len(block["originalText"]):
                raise ValueError("bad chunk slice")
            slices.append({"blockOrder": sl.block_order, "charStart": sl.start, "charEnd": sl.end})
            # The planner creates exact partial locators, but we must bind file-wide
            # Markdown offsets using the verified original block coordinates.
            if block["locator"]["locatorKind"] == "markdown":
                base = block["locator"]
                loc = dict(base)
                prefix = block["originalText"][:sl.start]
                frag = block["originalText"][sl.start:sl.end]
                loc.update(byteStart=base["byteStart"] + len(prefix.encode("utf-8")),
                           byteEnd=base["byteStart"] + len((prefix + frag).encode("utf-8")),
                           charStart=base["charStart"] + sl.start,
                           charEnd=base["charStart"] + sl.end)
            else:
                loc = dict(block["locator"])
                if sl.start != 0 or sl.end != len(block["originalText"]):
                    loc["diagnostics"] = sorted(set(loc["diagnostics"]) | {"native-subspan-unverified"})
            locators.append(loc)
        output.append({"chunkId": chunk.id, "sourceId": chunk.path,
                       "sourceSha256": chunk.source_hash, "profileId": source["profileId"],
                       "sourceSlices": slices, "sourceLocators": locators,
                       "originalText": chunk.original_text, "contextualText": chunk.embedding_text,
                       "chunkPolicyId": chunk.policy.name, "serializationId": chunk.version,
                       "tokenizerFingerprint": chunk.tokenizer_fingerprint,
                       "effectiveTokenCount": chunk.token_count,
                       "diagnostics": list(chunk.diagnostics)})
    if len(output) > MAX_CHUNKS:
        raise ValueError("unbounded chunks")
    return output


def generation_id(source: dict, chunks: list[dict]) -> str:
    return hashlib.sha256(encode(
        [VERSION, source["scopeId"], source["sha256"], source["profileId"],
         [c["chunkId"] for c in chunks]])[:-1]).hexdigest()


def response(nonce: str, status: str, source: dict | None,
             chunks: list[dict] | None = None, diagnostics: list[str] | None = None,
             error: str | None = None) -> dict:
    if not NONCE.fullmatch(nonce) or status not in STATUS:
        raise ValueError("invalid response")
    chunks = chunks or []
    issues = diagnostics or []
    if status not in ("ok", "partial") and chunks:
        raise ValueError("ineligible chunk response")
    return {"protocolVersion": VERSION, "requestId": nonce, "operation": "ingest",
            "status": status, "source": source, "chunks": chunks,
            "generationId": generation_id(source, chunks) if source and status in ("ok", "partial") else None,
            "diagnostics": issues, "error": error}
