"""Bounded SQLite generation prototype; no source writes or model inference."""
from __future__ import annotations

import json
import math
import hashlib
import os
import stat
from pathlib import Path
import sqlite3
import struct
from collections.abc import Callable, Mapping, Sequence

from engine.scope import root_identity
from engine.probe import digest, exact, utf8

IDENTITY_KEYS = ('schema', 'parser', 'ocr', 'chunker', 'serialization', 'model',
                 'tokenizer', 'backend', 'profile', 'dimension', 'normalization')
MAX_RECORDS = 128


def identity_json(identity: dict) -> str:
    if not exact(identity, IDENTITY_KEYS):
        raise ValueError('incomplete identity')
    if type(identity['schema']) is not int or identity['schema'] != 1:
        raise ValueError('schema')
    if type(identity['dimension']) is not int or not 1 <= identity['dimension'] <= 64:
        raise ValueError('dimension')
    if any(not utf8(identity[k], 256, True) for k in IDENTITY_KEYS
           if k not in ('schema', 'dimension')):
        raise ValueError('identity field')
    return json.dumps(identity, sort_keys=True, separators=(',', ':'))


class Store:
    def __init__(self, cache: Path, source_root: Path, identity: dict):
        root = source_root
        root_stamp = root_identity(root)
        if not cache.is_absolute() or cache.parent.resolve(strict=True) != cache.parent:
            raise ValueError('noncanonical cache directory')
        if cache.is_relative_to(root) or root.is_relative_to(cache.parent):
            raise ValueError('cache must be separate from source root')
        directory = cache.parent.stat()
        if directory.st_uid != os.getuid() or directory.st_mode & 0o077:
            raise ValueError('cache directory must be private and owned')
        allowed = {cache.name + suffix for suffix in ('', '-wal', '-shm', '-journal')}
        for entry in cache.parent.iterdir():
            info = entry.lstat()
            if (entry.name not in allowed or not stat.S_ISREG(info.st_mode)
                    or info.st_nlink != 1 or info.st_uid != os.getuid()):
                raise ValueError('untrusted cache file or alias')
        self.root = root
        self.root_stamp = root_stamp
        fingerprint = hashlib.sha256(json.dumps([str(root), *root_stamp]).encode()).hexdigest()
        self.identity = json.dumps([identity_json(identity), fingerprint])
        self.dimension = identity['dimension']
        self.db = sqlite3.connect(cache, timeout=1, isolation_level=None)
        try:
            self.db.execute('PRAGMA journal_mode=WAL')
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS manifest (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    generation INTEGER NOT NULL, identity TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS records (
                    id TEXT PRIMARY KEY, scope TEXT NOT NULL, hash TEXT NOT NULL,
                    vector BLOB NOT NULL);
                CREATE VIRTUAL TABLE IF NOT EXISTS lexical USING fts5(id UNINDEXED, text);
            ''')
            self._manifest()
        except BaseException:
            self.db.close()
            raise

    def _manifest(self):
        if root_identity(self.root) != self.root_stamp:
            raise ValueError('stale root')
        row = self.db.execute('SELECT generation, identity FROM manifest').fetchone()
        if row and row[1] != self.identity:
            raise ValueError('incompatible identity')
        return row

    def publish(self, generation: int, records: Sequence[dict],
                before_commit: Callable[[], None] = lambda: None) -> None:
        if type(generation) is not int or not 1 <= generation <= 2**63 - 1:
            raise ValueError('generation')
        if len(records) > MAX_RECORDS:
            raise ValueError('record count')
        prepared = []
        for record in records:
            if not exact(record, ('id', 'scope', 'hash', 'text', 'vector')):
                raise ValueError('record fields')
            if (not utf8(record['id'], 256, True) or not utf8(record['scope'], 128, True)
                    or not digest(record['hash']) or not utf8(record['text'], 8192)):
                raise ValueError('record identity/text')
            vector = record['vector']
            if (type(vector) not in (tuple, list) or len(vector) != self.dimension
                    or any(type(v) not in (int, float) or not math.isfinite(v)
                           or abs(v) > 3.4e38 for v in vector)):
                raise ValueError('vector')
            prepared.append((record, struct.pack('<' + 'f' * self.dimension, *vector)))
        self.db.execute('BEGIN IMMEDIATE')
        try:
            previous = self._manifest()
            if previous and generation <= previous[0]:
                raise ValueError('generation must increase')
            self.db.execute('DELETE FROM records')
            self.db.execute('DELETE FROM lexical')
            for record, blob in prepared:
                self.db.execute('INSERT INTO records VALUES (?,?,?,?)',
                                (record['id'], record['scope'], record['hash'], blob))
                self.db.execute('INSERT INTO lexical VALUES (?,?)', (record['id'], record['text']))
            self.db.execute('INSERT OR REPLACE INTO manifest VALUES (1,?,?)',
                            (generation, self.identity))
            before_commit()
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def snapshot(self, scope: str, current_hashes: Mapping[str, str]) -> tuple[int, list[dict]]:
        self.db.execute('BEGIN')
        try:
            manifest = self._manifest()
            if not manifest:
                raise ValueError('no generation')
            rows = self.db.execute('''SELECT r.id, r.hash, l.text, r.vector FROM records r
                JOIN lexical l ON r.id=l.id WHERE r.scope=? ORDER BY r.id''', (scope,))
            result = [dict(id=i, hash=h, text=t,
                           vector=struct.unpack('<' + 'f' * self.dimension, v))
                      for i, h, t, v in rows if digest(current_hashes.get(i))
                      and current_hashes[i] == h]
            return manifest[0], result
        finally:
            self.db.execute('ROLLBACK')

    def close(self) -> None:
        self.db.close()
