"""Health-only v2 prototype. Fixed entry point; no source or command fields."""
from __future__ import annotations

import json
from pathlib import Path
import sys

if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from engine.probe import exact, request_id, unique_object

LIMIT = 1024


def decode(data: bytes) -> dict:
    if len(data) > LIMIT or not data.endswith(b'\n') or data.count(b'\n') != 1:
        raise ValueError('frame')
    return json.loads(data.decode('utf-8'), object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('number')))


def handle(value: dict) -> dict:
    if (not exact(value, ('version', 'id', 'method')) or type(value['version']) is not int
            or value['version'] != 2 or not request_id(value['id']) or value['method'] != 'health'):
        raise ValueError('request')
    return {'version': 2, 'id': value['id'], 'ok': True}


def encode(value: dict) -> bytes:
    data = (json.dumps(value, separators=(',', ':')) + '\n').encode('utf-8')
    if len(data) > LIMIT:
        raise ValueError('frame')
    return data


def main() -> int:
    while True:
        data = sys.stdin.buffer.readline(LIMIT + 1)
        if not data:
            return 0
        try:
            reply = handle(decode(data))
        except (ValueError, UnicodeError, RecursionError):
            return 2  # Invalid framing terminates; never resynchronize an ambiguous stream.
        sys.stdout.buffer.write(encode(reply))
        sys.stdout.buffer.flush()


if __name__ == '__main__':
    sys.exit(main())
