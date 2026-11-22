#!/usr/bin/env python3
"""Tiny mathematical/storage and health IPC measurements; no retrieval quality."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import multiprocessing
from pathlib import Path
import platform
import secrets
import socket
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.storage import Store
from engine.persistent import LIMIT, decode, encode, handle
from engine.supervisor import Supervisor, WORKER

COUNT = 20
IDENTITY = dict(schema=1, parser='none-v1', ocr='none-v1', chunker='none-v1',
                serialization='le-f32-v1', model='mathematical-v1', tokenizer='none-v1',
                backend='sqlite-v1', profile='tiny-v1', dimension=4, normalization='none-v1')


def milliseconds(samples):
    values = sorted(v * 1000 for v in samples)
    return {'median_ms': round(statistics.median(values), 4),
            'p95_ms': round(values[int(0.95 * len(values)) - 1], 4)}


def storage():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        source = root / 'source'
        source.mkdir()
        rows = [dict(id=f'r{i:02}', scope='even' if i % 2 == 0 else 'odd',
                     hash=hashlib.sha256(f'synthetic-{i}'.encode()).hexdigest(),
                     text=f'synthetic {i}', vector=[(i % 4) / 4, 1, 0, 0.5]) for i in range(32)]
        hashes = {r['id']: r['hash'] for r in rows}
        for name in ('packed', 'normalized'):
            (root / name).mkdir(mode=0o700)
        packed = Store(root / 'packed/data.db', source, IDENTITY)
        normalized = Store(root / 'normalized/data.db', source, IDENTITY)
        try:
            for store in (packed, normalized):
                store.publish(1, rows)
            db = normalized.db
            db.execute('CREATE TABLE coordinates(id TEXT, axis INTEGER, value REAL, PRIMARY KEY(id,axis))')
            db.executemany('INSERT INTO coordinates VALUES (?,?,?)',
                           [(r['id'], axis, value) for r in rows for axis, value in enumerate(r['vector'])])
            db.execute('ALTER TABLE records DROP COLUMN vector')
            results = {}
            for name, store in (('packed', packed), ('normalized', normalized)):
                store.db.execute('VACUUM')
                store.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                results[name] = {'bytes': (root / name / 'data.db').stat().st_size}
            timings = {'packed': [], 'normalized': []}
            query = [1, 0.5, 0, -0.5]
            def rank(records):
                return sorted(((r['id'], sum(a * b for a, b in zip(query, r['vector'])))
                               for r in records), key=lambda row: (-row[1], row[0]))
            for _ in range(COUNT):
                for scope in ('even', 'odd', 'missing'):
                    start = time.perf_counter()
                    packed_rank = rank(packed.snapshot(scope, hashes)[1])
                    timings['packed'].append(time.perf_counter() - start)
                    start = time.perf_counter()
                    db.execute('BEGIN')
                    try:
                        data = db.execute('''SELECT r.id,r.hash,l.text,c.axis,c.value FROM records r
                            JOIN lexical l ON l.id=r.id JOIN coordinates c ON c.id=r.id
                            WHERE r.scope=? ORDER BY r.id,c.axis''', (scope,)).fetchall()
                        reconstructed = {}
                        for i, h, text, axis, value in data:
                            if hashes.get(i) == h:
                                reconstructed.setdefault(i, dict(id=i, vector=[]))['vector'].append(value)
                        normalized_rank = rank(reconstructed.values())
                    finally:
                        db.execute('ROLLBACK')
                    timings['normalized'].append(time.perf_counter() - start)
                    assert packed_rank == normalized_rank
                    expected = rank([r for r in rows if r['scope'] == scope])
                    assert packed_rank == expected
            for name in results:
                results[name].update(milliseconds(timings[name]))
            return dict(records=32, dimensions=4, queries=COUNT * 3, exact_parity=True,
                        fts5=True, layouts=results)
        finally:
            packed.close()
            normalized.close()


def stdio():
    oneshot = []
    for index in range(COUNT):
        request = dict(version=2, id=str(index), method='health')
        start = time.perf_counter()
        reply = subprocess.run([sys.executable, '-I', '-B', str(WORKER)],
                               input=encode(request), capture_output=True, timeout=2, check=True)
        assert decode(reply.stdout) == handle(request)
        oneshot.append(time.perf_counter() - start)
    persistent = []
    worker = Supervisor()
    start = time.perf_counter()
    try:
        worker.start()
        for index in range(COUNT):
            before = time.perf_counter()
            worker.health(str(index))
            persistent.append(time.perf_counter() - before)
    finally:
        worker.cancel()
    return {'messages': COUNT, 'oneshot': dict(milliseconds(oneshot), processes=COUNT,
                                               total_ms=round(sum(oneshot) * 1000, 3)),
            'persistent': dict(milliseconds(persistent), processes=1,
                               total_with_stop_ms=round((time.perf_counter() - start) * 1000, 3),
                               warm=milliseconds(persistent[1:]))}


def serve(pipe, token):
    # Invoked only through the explicit --loopback-local benchmark mode.
    with socket.socket() as listener:
        listener.settimeout(3)
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        pipe.send(listener.getsockname()[1])
        pipe.close()
        connection, _ = listener.accept()
        with connection:
            connection.settimeout(3)
            with connection.makefile('rb') as stream:
                for _ in range(COUNT):
                    request = decode(stream.readline(LIMIT + 1))
                    if set(request) != {'token', 'request'} or not isinstance(request['token'], str):
                        raise ValueError('authentication envelope')
                    if not hmac.compare_digest(request['token'], token):
                        raise ValueError('authentication')
                    connection.sendall(encode(handle(request['request'])))


def loopback():
    context = multiprocessing.get_context('spawn')
    parent, child = context.Pipe(duplex=False)
    token = secrets.token_hex(32)
    worker = context.Process(target=serve, args=(child, token))
    started = time.perf_counter()
    worker.start()
    child.close()
    try:
        if not parent.poll(3):
            raise TimeoutError('listener startup')
        port = parent.recv()
        timings = []
        with socket.create_connection(('127.0.0.1', port), timeout=3) as connection:
            connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            with connection.makefile('rb') as stream:
                for index in range(COUNT):
                    request = dict(version=2, id=str(index), method='health')
                    before = time.perf_counter()
                    connection.sendall(encode(dict(token=token, request=request)))
                    assert decode(stream.readline(LIMIT + 1)) == handle(request)
                    timings.append(time.perf_counter() - before)
        worker.join(3)
        if worker.exitcode != 0:
            raise RuntimeError('listener did not exit successfully')
        return dict(milliseconds(timings), processes=1, messages=COUNT,
                    total_with_stop_ms=round((time.perf_counter() - started) * 1000, 3))
    finally:
        parent.close()
        if worker.is_alive():
            worker.terminate()
            worker.join(1)
        if worker.is_alive():
            worker.kill()
            worker.join(1)
        worker.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--loopback-local', action='store_true',
                        help='explicit authorization to bind 127.0.0.1 in this environment')
    args = parser.parse_args()
    result = {'python': platform.python_version(), 'sqlite': sqlite3.sqlite_version,
              'platform': platform.system(), 'storage': storage(), 'stdio': stdio()}
    if args.loopback_local:
        try:
            result['loopback'] = loopback()
        except Exception as error:
            result['loopback'] = {'blocked': type(error).__name__}
            print(json.dumps(result, indent=2))
            sys.exit(1)
    else:
        result['loopback'] = {'not_run': 'requires explicit --loopback-local; no listener opened'}
    print(json.dumps(result, indent=2))
