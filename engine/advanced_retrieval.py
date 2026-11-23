"""OKS-05D strict v4 model-envelope; no invocation from Standalone.

The sole privileged operation is bounded real BGE-M3 embedding. Search ranking
and original evidence are projected from the authoritative 05C v3 source/chunk
records in the Obsidian adapter, never generated or guessed by this worker.
"""
from __future__ import annotations

from dataclasses import asdict
import math
from pathlib import Path
import re
import sys
import time

if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine import advanced_protocol as wire

VERSION = 4
MAX_REQUEST = 128 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
MAX_TEXTS = 64
MAX_BATCH_TOKENS = 32768
HEX48 = re.compile(r'^[a-f0-9]{48}$')
REQ = {'protocolVersion', 'requestId', 'operation', 'deadlineUnixMs',
       'modelSnapshot', 'maxTokens', 'texts'}
REP = {'protocolVersion', 'requestId', 'operation', 'status', 'error',
       'identity', 'vectors', 'diagnostics'}


class ModelWireError(ValueError):
    pass


def request(v: object) -> dict:
    if type(v) is not dict or set(v) != REQ:
        raise ModelWireError('MODEL_PROTOCOL_INVALID')
    if (v['protocolVersion'] != VERSION or v['operation'] != 'embed'
            or type(v['requestId']) is not str or not HEX48.fullmatch(v['requestId'])
            or type(v['deadlineUnixMs']) is not int
            or not 0 < v['deadlineUnixMs'] <= wire.MAX_SAFE_INTEGER
            or type(v['maxTokens']) is not int or not 8 <= v['maxTokens'] <= 512
            or type(v['modelSnapshot']) is not str or not v['modelSnapshot'].startswith('/')
            or '\x00' in v['modelSnapshot'] or '\\' in v['modelSnapshot']
            or any(c in ('.', '..', '') for c in v['modelSnapshot'].split('/')[1:])
            or type(v['texts']) is not list or not 1 <= len(v['texts']) <= MAX_TEXTS):
        raise ModelWireError('MODEL_PROTOCOL_INVALID')
    if any(type(t) is not str or not t or '\x00' in t
           or len(t.encode('utf-8', errors='strict')) > 8192 for t in v['texts']):
        raise ModelWireError('MODEL_PROTOCOL_INVALID')
    return v


def response(nonce: str, status: str, *, identity: dict | None = None,
             vectors: list[list[float]] | None = None, error: str | None = None) -> dict:
    return {'protocolVersion': VERSION, 'requestId': nonce, 'operation': 'embed',
            'status': status, 'error': error, 'identity': identity,
            'vectors': vectors or [], 'diagnostics': []}


def embed(v: dict) -> dict:
    request(v)
    nonce = v['requestId']
    try:
        # Run cgroup v2, no AF_INET, host-memory and deadline admission BEFORE
        # importing torch / transformers or reading the local weight archive.
        from engine.advanced_ingest import resource_preflight
        resource_preflight()
        deadline = v['deadlineUnixMs']
        now = time.time_ns() // 1_000_000
        if not now < deadline <= now + 120_000:
            return response(nonce, 'failed', error='MODEL_TIMEOUT')
        from engine.embedding import (OfflineDenseReference, EmbeddingUnavailable,
                                      ADVANCED_MAX_TOKENS)
        from engine.token_budget import ExactTokenizer
        if v['maxTokens'] > ADVANCED_MAX_TOKENS:
            return response(nonce, 'failed', error='MODEL_INPUT_INVALID')
        snapshot = Path(v['modelSnapshot'])
        counter = ExactTokenizer(snapshot)
        counts = [counter.count(x) for x in v['texts']]
        if max(counts) > v['maxTokens'] or sum(counts) > MAX_BATCH_TOKENS:
            return response(nonce, 'failed', error='TOKEN_BUDGET_EXCEEDED')
        model = OfflineDenseReference(snapshot, max_tokens=v['maxTokens'],
                                      ceiling=ADVANCED_MAX_TOKENS,
                                      admission=resource_preflight)
        vectors = []
        for value in v['texts']:
            if time.time_ns() // 1_000_000 >= deadline:
                return response(nonce, 'failed', error='MODEL_TIMEOUT')
            vector = list(model.embed(value))
            if len(vector) != 1024 or any(not math.isfinite(x) for x in vector):
                return response(nonce, 'failed', error='VECTOR_INVALID')
            vectors.append(vector)
        return response(nonce, 'ok', identity=asdict(model.identity), vectors=vectors)
    except BaseException as exc:
        # Sanitized failure, no paths, content, imported library logs or traceback.
        code = getattr(exc, 'code', None)
        if code not in {'MODEL_UNAVAILABLE', 'MODEL_INCOMPATIBLE', 'TOKENIZER_INCOMPATIBLE',
                        'RUNTIME_UNAVAILABLE', 'VECTOR_INVALID', 'TOKEN_BUDGET_EXCEEDED'}:
            code = ('MODEL_RESOURCE_REFUSED' if isinstance(exc, RuntimeError)
                    else 'MODEL_FAILED')
        return response(nonce, 'failed', error=code)


def main() -> int:
    data = sys.stdin.buffer.readline(MAX_REQUEST + 1)
    try:
        req = request(wire.decode(data, limit=MAX_REQUEST))
    except (ValueError, TypeError, KeyError, UnicodeError, OverflowError):
        return 2
    out = embed(req)
    try:
        sys.stdout.buffer.write(wire.encode(out))
        sys.stdout.buffer.flush()
    except (ValueError, BrokenPipeError, OSError):
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())
