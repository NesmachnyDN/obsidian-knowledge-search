"""Bounded, local Python-only 03B real lexical/dense/hybrid reference experiment.

Never imported by Obsidian Standalone or synthetic probe. A ready dense leg
requires the actual verified BGE-M3 OfflineDenseReference; no fake-vector
candidate may be passed as a successful production model.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date
from hashlib import sha256
import json
import math
import re
import sqlite3
from typing import Literal

from engine.document import ParsedBlock, ParsedDocument
from engine.embedding import (
    EmbeddingUnavailable, OfflineDenseReference, validate_dense_vector,
)
from engine.lexical import LexicalIndex, MAX_QUERY_BYTES, MAX_RESULTS, searchable_blocks
from engine.scope import ScopedReader

Mode = Literal["lexical", "dense", "hybrid"]
MAX_RECORDS = 256
RRF_K = 60
_NUMERIC = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


class RetrievalError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class PropertyValue:
    key: str
    value_type: str
    value: object


@dataclass(frozen=True)
class Predicate:
    key: str
    value_type: str
    value: object
    operator: Literal["eq", "contains"] = "eq"


@dataclass(frozen=True)
class Evidence:
    source_id: str
    source_sha256: str
    path: str
    line_start: int
    line_end: int
    byte_start: int
    byte_end: int
    excerpt: str
    headings: tuple[str, ...]
    wiki_links: tuple[str, ...]
    rank: int
    requested_mode: Mode
    lexical_rank: int | None
    dense_rank: int | None
    dense_similarity: float | None
    rrf_score: float | None
    generation_id: str


@dataclass(frozen=True)
class Response:
    status: Literal["ok", "failed"]
    requested_mode: Mode
    executed_mode: Literal["lexical", "dense", "hybrid", "none"]
    generation_id: str | None
    hits: tuple[Evidence, ...]
    error: str | None
    lexical_readiness: str
    dense_readiness: str
    stale_source_count: int


def _valid_list_member(value: object) -> bool:
    # JSON booleans and numbers are distinct types, despite True == 1 in Python.
    return (value is None or type(value) in (str, int, bool)
            or (type(value) is float and math.isfinite(value)))


def _typed_list_equal(left: object, right: object) -> bool:
    return (type(left) is tuple and type(right) is tuple
            and len(left) == len(right)
            and all(type(a) is type(b) and a == b
                    for a, b in zip(left, right)))


def parse_typed_properties(doc: ParsedDocument) -> tuple[PropertyValue, ...]:
    """Subset of canonical 02A scalars: reject ambiguous YAML, never coerce silently."""
    result: list[PropertyValue] = []
    seen: set[str] = set()
    for key, raw in doc.properties:
        if key in seen or not key or len(key.encode()) > 128:
            raise RetrievalError("PROPERTY_INCOMPATIBLE")
        seen.add(key)
        raw = raw.strip()
        if not raw:
            result.append(PropertyValue(key, "null", None))
        elif raw.lower() in ("true", "false"):
            result.append(PropertyValue(key, "boolean", raw.lower() == "true"))
        elif raw.lower() in ("null", "~"):
            result.append(PropertyValue(key, "null", None))
        elif _DATE.fullmatch(raw):
            try:
                result.append(PropertyValue(key, "date", date.fromisoformat(raw).isoformat()))
            except ValueError as exc:
                raise RetrievalError("PROPERTY_INCOMPATIBLE") from exc
        elif _NUMERIC.fullmatch(raw):
            n = float(raw) if "." in raw else int(raw)
            if type(n) is float and not math.isfinite(n):
                raise RetrievalError("PROPERTY_INCOMPATIBLE")
            result.append(PropertyValue(key, "number", n))
        elif raw.startswith("[") or raw.startswith('"'):
            try:
                value = json.loads(raw)
            except (ValueError, TypeError) as exc:
                raise RetrievalError("PROPERTY_INCOMPATIBLE") from exc
            if isinstance(value, list):
                if len(value) > 64 or any(
                        not _valid_list_member(item) for item in value):
                    raise RetrievalError("PROPERTY_INCOMPATIBLE")
                result.append(PropertyValue(key, "list", tuple(value)))
            elif type(value) is str:
                result.append(PropertyValue(key, "string", value))
            else:
                raise RetrievalError("PROPERTY_INCOMPATIBLE")
        elif any(c in raw for c in ("&", "*", "!", "{", "}", "\n", "\x00")):
            raise RetrievalError("PROPERTY_INCOMPATIBLE")
        else:
            result.append(PropertyValue(key, "string", raw))
    return tuple(result)


def validate_predicates(predicates: tuple[Predicate, ...]) -> None:
    if not isinstance(predicates, tuple) or len(predicates) > 32:
        raise RetrievalError("FILTER_INVALID")
    for predicate in predicates:
        if (not isinstance(predicate, Predicate) or type(predicate.key) is not str
                or not predicate.key or len(predicate.key.encode()) > 128
                or predicate.value_type not in ("string", "number", "boolean", "date", "list", "null")
                or predicate.operator not in ("eq", "contains")):
            raise RetrievalError("FILTER_INVALID")
        if predicate.operator == "contains" and predicate.value_type != "list":
            raise RetrievalError("FILTER_INVALID")
        if predicate.value_type == "number" and (
                type(predicate.value) not in (int, float)
                or not math.isfinite(predicate.value)):
            raise RetrievalError("FILTER_INVALID")
        if predicate.value_type in ("string", "date") and type(predicate.value) is not str:
            raise RetrievalError("FILTER_INVALID")
        if predicate.value_type == "date":
            try:
                if date.fromisoformat(predicate.value).isoformat() != predicate.value:
                    raise ValueError("noncanonical date")
            except ValueError as exc:
                raise RetrievalError("FILTER_INVALID") from exc
        if predicate.value_type == "list":
            if predicate.operator == "eq" and (
                    type(predicate.value) is not tuple or len(predicate.value) > 64
                    or any(not _valid_list_member(v) for v in predicate.value)):
                raise RetrievalError("FILTER_INVALID")
            if predicate.operator == "contains" and not _valid_list_member(predicate.value):
                raise RetrievalError("FILTER_INVALID")
        if predicate.value_type == "boolean" and type(predicate.value) is not bool:
            raise RetrievalError("FILTER_INVALID")
        if predicate.value_type == "null" and predicate.value is not None:
            raise RetrievalError("FILTER_INVALID")


def matches_predicates(properties: tuple[PropertyValue, ...],
                       predicates: tuple[Predicate, ...]) -> bool:
    indexed = {p.key: p for p in properties}
    for predicate in predicates:
        actual = indexed.get(predicate.key)
        if actual is None or actual.value_type != predicate.value_type:
            return False
        if predicate.operator == "contains":
            if (actual.value_type != "list"
                    or not any(type(item) is type(predicate.value)
                               and item == predicate.value for item in actual.value)):
                return False
        elif actual.value_type == "list":
            if not _typed_list_equal(actual.value, predicate.value):
                return False
        elif actual.value != predicate.value or (
                actual.value_type == "number" and type(actual.value) is bool):
            return False
    return True


def rrf_fusion(lexical: tuple[str, ...], dense: tuple[str, ...],
               *, k: int = RRF_K) -> list[tuple[str, int | None, int | None, float]]:
    if k < 1 or len(set(lexical)) != len(lexical) or len(set(dense)) != len(dense):
        raise RetrievalError("FUSION_INVALID")
    lexical_ranks = {value: i + 1 for i, value in enumerate(lexical)}
    dense_ranks = {value: i + 1 for i, value in enumerate(dense)}
    rows = []
    for key in lexical_ranks.keys() | dense_ranks.keys():
        lr, dr = lexical_ranks.get(key), dense_ranks.get(key)
        score = (1.0 / (k + lr) if lr else 0.0) + (
            1.0 / (k + dr) if dr else 0.0)
        rows.append((key, lr, dr, score))
    return sorted(rows, key=lambda x: (-x[3], x[0]))


class RetrievalIndex:
    """Atomic in-memory experimental generation; no persistence or user Vault access."""

    def __init__(self, reader: ScopedReader, documents: tuple[ParsedDocument, ...],
                 model: OfflineDenseReference | None):
        self.reader = reader
        self.lexical = LexicalIndex(reader, documents)
        self.generation_id: str | None = None
        self._model: OfflineDenseReference | None = None
        self._vectors: dict[str, tuple[float, ...]] = {}
        self._blocks: dict[str, ParsedBlock] = {}
        self._source_properties: dict[str, tuple[PropertyValue, ...]] = {}
        try:
            doc_map = {doc.path: doc for doc in documents}
            if len(doc_map) != len(documents):
                raise RetrievalError("SOURCE_DUPLICATE")
            for doc in documents:
                self._source_properties[doc.path] = parse_typed_properties(doc)
            # FTS may omit valid non-lexical content (e.g. emoji-only
            # paragraphs). Dense admission must use canonical source blocks,
            # not the subset of blocks containing lexical search terms.
            for doc in documents:
                for block in searchable_blocks(doc):
                    if block.span is None:
                        raise RetrievalError("EVIDENCE_INCOMPLETE")
                    key = self._key(block)
                    if key in self._blocks:
                        raise RetrievalError("EVIDENCE_DUPLICATE")
                    self._blocks[key] = block
            if len(self._blocks) > MAX_RECORDS:
                raise RetrievalError("INDEX_LIMIT")
            if model is not None:
                if type(model) is not OfflineDenseReference:
                    raise RetrievalError("MODEL_INCOMPATIBLE")
                if (not model.identity.runtime_tokenizer_parity_verified
                        or model.identity.dimension != 1024
                        or model.identity.normalization != "l2-cls"):
                    raise RetrievalError("MODEL_INCOMPATIBLE")
                staged = {}
                for key, block in self._blocks.items():
                    contextual = ("\n".join(block.headings) + "\n" if block.headings else "") + block.text
                    vector = model.embed(contextual)
                    staged[key] = validate_dense_vector(list(vector), 1024)
                self._vectors = staged
                self._model = model
            if any(not reader.fresh(doc.path, doc.digest) for doc in documents
                   if doc.status in ("ok", "partial")):
                raise RetrievalError("SOURCE_STALE")
            identity = asdict(model.identity) if model is not None else {"model": "unavailable"}
            payload = {
                "schema": "oks-03b-memory-v1",
                "sources": [(d.path, d.digest, d.status) for d in
                            sorted(documents, key=lambda x: x.path)],
                "model": identity,
                "lexical_records": sorted(
                    self._key(block) for block in self.lexical.blocks.values()),
                "dense_records": sorted(self._vectors),
            }
            self.generation_id = sha256(json.dumps(
                payload, ensure_ascii=False, sort_keys=True,
                separators=(",", ":")).encode()).hexdigest()
        except BaseException:
            self.lexical.close()
            raise

    @staticmethod
    def _key(block: ParsedBlock) -> str:
        return sha256(json.dumps(
            [block.path, block.digest, block.order, block.span.start, block.span.end],
            ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()

    def close(self) -> None:
        self.lexical.close()

    def search(self, query: str, mode: Mode, limit: int = 10,
               predicates: tuple[Predicate, ...] = (),
               allowed_paths: frozenset[str] | None = None) -> Response:
        if mode not in ("lexical", "dense", "hybrid"):
            raise RetrievalError("MODE_INVALID")
        if type(query) is not str or not query:
            raise RetrievalError("QUERY_INVALID")
        try:
            encoded_size = len(query.encode("utf-8"))
        except UnicodeError as exc:
            raise RetrievalError("QUERY_INVALID") from exc
        if encoded_size > MAX_QUERY_BYTES:
            raise RetrievalError("QUERY_INVALID")
        if type(limit) is not int or not 1 <= limit <= MAX_RESULTS:
            raise RetrievalError("QUERY_INVALID")
        validate_predicates(predicates)
        if allowed_paths is not None and not isinstance(allowed_paths, frozenset):
            raise RetrievalError("SCOPE_INVALID")
        if mode in ("dense", "hybrid") and self._model is None:
            return self._failed(mode, "CAPABILITY_UNAVAILABLE")
        # Select a single admissible candidate universe *before* rank/Top-K.
        # The unfiltered lexical index is still allowed to stream its bounded
        # rows; dense similarity and RRF only see the same eligible sources.
        eligible = {
            key for key, block in self._blocks.items()
            if (allowed_paths is None or block.path in allowed_paths)
            and matches_predicates(self._source_properties[block.path], predicates)
        }
        lex_blocks = ()
        if mode != "dense":
            try:
                lex_blocks = self.lexical.search(
                    query, MAX_RESULTS,
                    candidate_filter=lambda block: self._key(block) in eligible)
            except sqlite3.Error:
                # Do not expose SQLite internals or return partial hybrid hits.
                return self._failed(mode, "LEG_FAILED", failed_leg="lexical")
        lexical_keys = tuple(self._key(block) for block in lex_blocks)
        dense_scores: dict[str, float] = {}
        dense_keys: tuple[str, ...] = ()
        if mode != "lexical":
            try:
                assert self._model is not None
                vector = self._model.embed(query)
                dense_scores = {key: math.fsum(a * b for a, b in zip(vector, v))
                                for key, v in self._vectors.items() if key in eligible}
                dense_keys = tuple(sorted(dense_scores, key=lambda x: (-dense_scores[x], x)))
            except (EmbeddingUnavailable, ValueError, RuntimeError):
                return self._failed(mode, "LEG_FAILED", failed_leg="dense")
        if mode == "hybrid":
            ranked = rrf_fusion(lexical_keys, dense_keys)
        elif mode == "lexical":
            ranked = [(key, i + 1, None, 0.0)
                      for i, key in enumerate(lexical_keys)]
        else:
            ranked = [(key, None, i + 1, 0.0)
                      for i, key in enumerate(dense_keys)]
        stale: set[str] = set()
        checked: dict[str, bool] = {}
        hits: list[Evidence] = []
        for key, lexical_rank, dense_rank, score in ranked:
            block = self._blocks[key]
            if block.path not in checked:
                checked[block.path] = self.reader.fresh(block.path, block.digest)
                if not checked[block.path]:
                    stale.add(block.path)
            if not checked[block.path]:
                continue
            if block.span is None:
                return self._failed(mode, "EVIDENCE_INCOMPLETE")
            hits.append(Evidence(
                key, block.digest, block.path, block.span.line_start,
                block.span.line_end, block.span.start, block.span.end,
                block.text, block.headings, block.wiki_links, len(hits) + 1,
                mode, lexical_rank, dense_rank, dense_scores.get(key),
                score if mode == "hybrid" else None, self.generation_id or "",
            ))
            if len(hits) >= limit:
                break
        return Response("ok", mode, mode, self.generation_id, tuple(hits), None,
                        "ready", "ready" if self._model else "unavailable", len(stale))

    def _failed(self, mode: Mode, code: str, *,
                failed_leg: Literal["lexical", "dense"] | None = None) -> Response:
        return Response(
            "failed", mode, "none", self.generation_id, (), code,
            "failed" if failed_leg == "lexical" else "ready",
            "failed" if failed_leg == "dense" else (
                "ready" if self._model is not None else "unavailable"),
            0,
        )
