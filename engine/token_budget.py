"""Verified, tokenizer-only BGE-M3 input accounting. No model or network loading."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Protocol

MANIFEST = Path(__file__).with_name("tokenizer-artifacts.json")
SERIALIZATION_VERSION = "bge-m3-heading-lines-v1"


class TokenBudgetError(ValueError):
    """Invalid or unavailable exact tokenizer contract."""


class TokenCounter(Protocol):
    def count(self, text: str) -> int: ...


def verify_snapshot(snapshot: Path) -> dict:
    """Verify immutable HF snapshot metadata and exact bytes without loading weights."""
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if not snapshot.is_dir() or snapshot.name != manifest["revision"]:
        raise TokenBudgetError("wrong or missing pinned tokenizer snapshot")
    for name, expected in manifest["files"].items():
        path = snapshot / name
        if not path.is_file() or path.stat().st_size != expected["bytes"]:
            raise TokenBudgetError("missing or size-mismatched tokenizer artifact: " + name)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != expected["sha256"]:
            raise TokenBudgetError("tokenizer artifact checksum mismatch: " + name)
    config = json.loads((snapshot / "tokenizer_config.json").read_text())
    if (config.get("model_max_length") != manifest["model_max_length"]
            or config.get("tokenizer_class") != manifest["tokenizer_class"]
            or config.get("cls_token") != manifest["cls_token"]
            or config.get("sep_token") != manifest["sep_token"]):
        raise TokenBudgetError("tokenizer configuration drift")
    readme = (snapshot / "README.md").read_text()
    if "license: mit" not in readme.lower().split("---", 2)[1]:
        raise TokenBudgetError("unverified tokenizer upstream license")
    return manifest


class ExactTokenizer:
    """Counts full serialized input including BOS/EOS. No auto truncation/padding."""

    def __init__(self, snapshot: Path):
        manifest = verify_snapshot(snapshot)
        try:
            import tokenizers
            from tokenizers import Tokenizer
        except ImportError as exc:
            raise TokenBudgetError("pinned tokenizers runtime unavailable") from exc
        self.version = tokenizers.__version__
        if self.version != manifest["tokenizers_version"]:
            raise TokenBudgetError("pinned tokenizers runtime version mismatch")
        self.identity = {
            "repository": manifest["repository"],
            "revision": manifest["revision"],
            "tokenizer_sha256": manifest["files"]["tokenizer.json"]["sha256"],
            "tokenizers_version": self.version,
            "serialization_version": SERIALIZATION_VERSION,
            "model_max_length": manifest["model_max_length"],
            "special_tokens": [manifest["cls_token"], manifest["sep_token"]],
            "embedding_runtime_verified": False,
        }
        self._raw = Tokenizer.from_file(str(snapshot / "tokenizer.json"))
        self._raw.no_truncation()
        self._raw.no_padding()
        if self._raw.truncation is not None or self._raw.padding is not None:
            raise TokenBudgetError("tokenizer truncation/padding must be disabled")
        sample = self._raw.encode("Проверка ID-7", add_special_tokens=True)
        bos = self._raw.token_to_id(manifest["cls_token"])
        eos = self._raw.token_to_id(manifest["sep_token"])
        if (bos is None or eos is None or not sample.ids
                or sample.ids[0] != bos or sample.ids[-1] != eos):
            raise TokenBudgetError("tokenizer special-token policy mismatch")

    def count(self, text: str) -> int:
        if not isinstance(text, str):
            raise TokenBudgetError("text must be unicode")
        return len(self._raw.encode(text, add_special_tokens=True).ids)

    def pieces(self, text: str) -> tuple[tuple[int, int], ...]:
        """Return exact original-text Unicode offsets, without special-token spans."""
        return tuple((start, end) for start, end in
                     self._raw.encode(text, add_special_tokens=False).offsets
                     if end > start)


def serialize_text(headings: tuple[str, ...], original: str, *, literal_prefix: str = "") -> tuple[str, str]:
    """Original content is not changed; derived headings/prefix stay separate."""
    prefix = literal_prefix + ("\n".join(headings) + "\n" if headings else "")
    return prefix + original, prefix
