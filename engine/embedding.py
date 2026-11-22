"""Opt-in, offline BGE-M3 dense-only reference experiment; never a Standalone dependency.

No model import, download, inference, source indexing or process spawn on import.
Actual inference requires a separately authorized cgroup-scoped experiment.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from importlib.metadata import version, PackageNotFoundError
import json
import math
import os
from pathlib import Path
from typing import Any

from engine.token_budget import ExactTokenizer, SERIALIZATION_VERSION, verify_snapshot

MANIFEST = Path(__file__).with_name("embedding-artifacts.json")
MAX_INPUT_BYTES = 8192
EXPERIMENT_MAX_TOKENS = 256
MAX_WEIGHT_BYTES = 3 * 1024**3
MAX_CGROUP_BYTES = 4 * 1024**3
EXPECTED_SCOPE = "oks-03a-embedding.scope"


class EmbeddingUnavailable(RuntimeError):
    """Typed failure; never substitute lexical or fabricated dense vectors."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ModelIdentity:
    repository: str
    revision: str
    tokenizer_sha256: str
    weights_sha256: str
    dimension: int
    serialization_version: str
    normalization: str
    torch_version: str
    transformers_version: str
    tokenizers_version: str
    effective_max_tokens: int
    runtime_tokenizer_parity_verified: bool


def _hash_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model_snapshot(snapshot: Path, *, manifest_path: Path = MANIFEST) -> dict[str, Any]:
    """Verify exact cached revision, source license and weight bytes; no model loading."""
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (manifest["schema_version"] != 1 or snapshot.name != manifest["revision"]
                or not snapshot.is_dir() or manifest["hidden_size"] != 1024
                or manifest["model_type"] != "xlm-roberta"
                or manifest["serialization_version"] != SERIALIZATION_VERSION
                or manifest["license"] != "MIT"):
            raise EmbeddingUnavailable("MODEL_INCOMPATIBLE")
        for name, record in manifest["files"].items():
            if name not in ("README.md", "config.json", "pytorch_model.bin"):
                raise EmbeddingUnavailable("MODEL_INCOMPATIBLE")
            file = snapshot / name
            if not file.is_file() or file.stat().st_size != record["bytes"]:
                raise EmbeddingUnavailable("MODEL_UNAVAILABLE")
            if record["bytes"] > MAX_WEIGHT_BYTES or _hash_file(file) != record["sha256"]:
                raise EmbeddingUnavailable("MODEL_INCOMPATIBLE")
        card = (snapshot / "README.md").read_text(encoding="utf-8")
        if "license: mit" not in card.lower().split("---", 2)[1]:
            raise EmbeddingUnavailable("MODEL_INCOMPATIBLE")
        config = json.loads((snapshot / "config.json").read_text(encoding="utf-8"))
        if (config.get("model_type") != "xlm-roberta"
                or config.get("hidden_size") != manifest["hidden_size"]
                or config.get("architectures") != ["XLMRobertaModel"]
                or config.get("max_position_embeddings", 0) < EXPERIMENT_MAX_TOKENS + 2):
            raise EmbeddingUnavailable("MODEL_INCOMPATIBLE")
        return manifest
    except EmbeddingUnavailable:
        raise
    except (OSError, KeyError, ValueError, TypeError, IndexError, UnicodeError) as exc:
        raise EmbeddingUnavailable("MODEL_UNAVAILABLE") from exc


def validate_dense_vector(values: list[float], expected_dimension: int = 1024) -> tuple[float, ...]:
    if (not isinstance(values, list) or len(values) != expected_dimension
            or any(type(value) not in (float, int) or not math.isfinite(value) for value in values)):
        raise EmbeddingUnavailable("VECTOR_INVALID")
    norm = math.hypot(*(float(value) for value in values))
    if not math.isfinite(norm) or norm < 1e-12:
        raise EmbeddingUnavailable("VECTOR_INVALID")
    result = tuple(float(value) / norm for value in values)
    if abs(math.hypot(*result) - 1.0) > 1e-5:
        raise EmbeddingUnavailable("VECTOR_INVALID")
    return result


def _strict_cgroup_limit(path: Path, maximum: int) -> int:
    try:
        value = int(path.read_text(encoding="ascii").strip())
    except (OSError, ValueError) as exc:
        raise EmbeddingUnavailable("RESOURCE_GUARD_UNAVAILABLE") from exc
    if not 0 < value <= maximum:
        raise EmbeddingUnavailable("RESOURCE_GUARD_UNAVAILABLE")
    return value


def verify_active_experiment_guard(
    *, cgroup_root: Path = Path("/sys/fs/cgroup"),
    cgroup_file: Path = Path("/proc/self/cgroup"),
    network_file: Path = Path("/proc/net/dev"),
) -> None:
    """Fail closed before torch/model import unless effective Linux offline limits exist."""
    if os.environ.get("OKS_03A_EXPLICIT_MODEL_APPROVAL") != "1":
        raise EmbeddingUnavailable("APPROVAL_REQUIRED")
    try:
        entries = [line.split("::", 1)[1].strip()
                   for line in cgroup_file.read_text(encoding="ascii").splitlines()
                   if line.startswith("0::")]
        if len(entries) != 1 or EXPECTED_SCOPE not in entries[0].split("/"):
            raise EmbeddingUnavailable("RESOURCE_GUARD_UNAVAILABLE")
        directory = cgroup_root / entries[0].lstrip("/")
        _strict_cgroup_limit(directory / "memory.max", MAX_CGROUP_BYTES)
        _strict_cgroup_limit(directory / "pids.max", 128)
        if (directory / "memory.swap.max").read_text(encoding="ascii").strip() != "0":
            raise EmbeddingUnavailable("RESOURCE_GUARD_UNAVAILABLE")
        quota, period = (directory / "cpu.max").read_text(encoding="ascii").split()
        if not 0 < int(quota) <= 2 * int(period):
            raise EmbeddingUnavailable("RESOURCE_GUARD_UNAVAILABLE")
        if len(os.sched_getaffinity(0)) > 2:
            raise EmbeddingUnavailable("RESOURCE_GUARD_UNAVAILABLE")
        interfaces = {line.split(":", 1)[0].strip()
                      for line in network_file.read_text(encoding="ascii").splitlines()
                      if ":" in line}
        if interfaces != {"lo"}:
            raise EmbeddingUnavailable("OFFLINE_GUARD_UNAVAILABLE")
    except EmbeddingUnavailable:
        raise
    except (OSError, ValueError, IndexError) as exc:
        raise EmbeddingUnavailable("RESOURCE_GUARD_UNAVAILABLE") from exc


def validate_input(text: str, *, max_tokens: int) -> None:
    if not isinstance(text, str) or not text:
        raise EmbeddingUnavailable("INPUT_INVALID")
    try:
        size = len(text.encode("utf-8"))
    except UnicodeError as exc:
        raise EmbeddingUnavailable("INPUT_INVALID") from exc
    if size > MAX_INPUT_BYTES:
        raise EmbeddingUnavailable("INPUT_INVALID")
    if type(max_tokens) is not int or not 8 <= max_tokens <= EXPERIMENT_MAX_TOKENS:
        raise EmbeddingUnavailable("INPUT_INVALID")


class OfflineDenseReference:
    """Model-backed dense embeddings. Instantiate only inside authorized, guarded scope."""

    def __init__(self, snapshot: Path, *, max_tokens: int = EXPERIMENT_MAX_TOKENS):
        verify_active_experiment_guard()
        if type(max_tokens) is not int or not 8 <= max_tokens <= EXPERIMENT_MAX_TOKENS:
            raise EmbeddingUnavailable("INPUT_INVALID")
        model_manifest = verify_model_snapshot(snapshot)
        try:
            token_manifest = verify_snapshot(snapshot)
            counter = ExactTokenizer(snapshot)
        except (ImportError, ValueError, RuntimeError) as exc:
            raise EmbeddingUnavailable("TOKENIZER_INCOMPATIBLE") from exc
        try:
            import torch
            from transformers import AutoModel, AutoTokenizer
        except ImportError as exc:
            raise EmbeddingUnavailable("RUNTIME_UNAVAILABLE") from exc
        torch.set_num_threads(2)
        # Verify that the 02C exact-token contract is also the actual model-runtime input.
        try:
            runtime_tokenizer = AutoTokenizer.from_pretrained(
                str(snapshot), local_files_only=True, trust_remote_code=False,
                use_fast=True,
            )
            for sample in ("ID-42 / RFC 9110", "Раздел: договор № АБ-17", "emoji 🚀 CRLF\\r\\n"):
                actual = runtime_tokenizer(
                    sample, add_special_tokens=True, truncation=False, padding=False,
                )["input_ids"]
                expected = counter._raw.encode(sample, add_special_tokens=True).ids
                if actual != expected:
                    raise EmbeddingUnavailable("TOKENIZER_INCOMPATIBLE")
        except EmbeddingUnavailable:
            raise
        except Exception as exc:
            raise EmbeddingUnavailable("TOKENIZER_INCOMPATIBLE") from exc
        try:
            model = AutoModel.from_pretrained(
                str(snapshot), local_files_only=True, trust_remote_code=False,
                use_safetensors=False,
            )
            model.eval()
        except Exception as exc:
            raise EmbeddingUnavailable("MODEL_UNAVAILABLE") from exc
        self._torch = torch
        self._model = model
        self._counter = counter
        self.max_tokens = max_tokens
        self.identity = ModelIdentity(
            repository=model_manifest["repository"],
            revision=model_manifest["revision"],
            tokenizer_sha256=token_manifest["files"]["tokenizer.json"]["sha256"],
            weights_sha256=model_manifest["files"]["pytorch_model.bin"]["sha256"],
            dimension=model_manifest["hidden_size"],
            serialization_version=SERIALIZATION_VERSION,
            normalization="l2-cls",
            torch_version=version("torch"),
            transformers_version=version("transformers"),
            tokenizers_version=version("tokenizers"),
            effective_max_tokens=max_tokens,
            runtime_tokenizer_parity_verified=True,
        )

    def embed(self, text: str) -> tuple[float, ...]:
        validate_input(text, max_tokens=self.max_tokens)
        encoding = self._counter._raw.encode(text, add_special_tokens=True)
        if len(encoding.ids) > self.max_tokens:
            raise EmbeddingUnavailable("TOKEN_BUDGET_EXCEEDED")
        torch = self._torch
        with torch.inference_mode():
            outputs = self._model(
                input_ids=torch.tensor([encoding.ids], dtype=torch.long),
                attention_mask=torch.tensor([encoding.attention_mask], dtype=torch.long),
            )
            vector = outputs.last_hidden_state[0, 0, :].detach().cpu().tolist()
        return validate_dense_vector(vector, self.identity.dimension)
