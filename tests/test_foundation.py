"""Synthetic OKS-01B storage/scope acceptance; discovered by existing CI."""
import hashlib
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.storage import Store, identity_json, IDENTITY_KEYS
from engine.scope import ScopedReader

IDENTITY = dict(schema=1, parser='none-v1', ocr='none-v1', chunker='none-v1',
                serialization='le-f32-v1', model='mathematical-v1', tokenizer='none-v1',
                backend='sqlite-v1', profile='tiny-v1', dimension=2, normalization='none-v1')
HASH = hashlib.sha256(b'synthetic').hexdigest()


def record(name='a', scope='allowed'):
    return dict(id=name, scope=scope, hash=HASH, text='synthetic', vector=[1, 0])


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'note').write_bytes(b'synthetic')
        (self.root / 'cache').mkdir(mode=0o700)
        self.cache = self.root / 'cache/cache.db'
        self.store = Store(self.cache, self.source, IDENTITY)
        self.addCleanup(self.store.close)
        self.store.publish(1, [record(), record('b', 'other')])

    def test_wrong_and_replaced_root(self):
        other = self.root / 'other'
        other.mkdir()
        with self.assertRaisesRegex(ValueError, 'incompatible'):
            Store(self.cache, other, IDENTITY)
        self.source.rename(self.root / 'old-source')
        self.source.mkdir()
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.store.snapshot('allowed', {'a': HASH})
        with self.assertRaisesRegex(ValueError, 'incompatible'):
            Store(self.cache, self.source, IDENTITY)

    def test_cache_aliases_never_write_source(self):
        for suffix in ('', '-wal', '-shm', '-journal'):
            for hard in (False, True):
                with self.subTest(suffix=suffix, hard=hard):
                    directory = self.root / 'aliases'
                    directory.mkdir(mode=0o700)
                    target = directory / ('data.db' + suffix)
                    note = self.source / 'note'
                    if hard:
                        os.link(note, target)
                    else:
                        target.symlink_to(note)
                    with self.assertRaises(ValueError):
                        Store(directory / 'data.db', self.source, IDENTITY)
                    self.assertEqual(note.read_bytes(), b'synthetic')
                    target.unlink()
                    directory.rmdir()

    def test_identity_complete_exact_and_reopen(self):
        for field in IDENTITY_KEYS:
            identity = IDENTITY.copy()
            del identity[field]
            with self.assertRaises(ValueError):
                identity_json(identity)
            identity = IDENTITY.copy()
            identity[field] = 3 if field in ('schema', 'dimension') else 'different'
            with self.assertRaises(ValueError):
                Store(self.cache, self.source, identity)
        with self.assertRaises(ValueError):
            identity_json(dict(IDENTITY, extra='x'))
        reopened = Store(self.cache, self.source, IDENTITY)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.snapshot('allowed', {'a': HASH})[0], 1)
        with self.assertRaises(ValueError):
            Store(self.source / 'cache.db', self.source, IDENTITY)

    def test_freshness_scope_and_source_unchanged(self):
        self.assertEqual(len(self.store.snapshot('allowed', {'a': HASH, 'b': HASH})[1]), 1)
        for hashes in ({}, {'a': '0' * 64}, {'a': None}):
            self.assertEqual(self.store.snapshot('allowed', hashes), (1, []))
        self.assertEqual(self.store.snapshot('absent', {'a': HASH}), (1, []))
        self.assertEqual((self.source / 'note').read_bytes(), b'synthetic')

    def test_rollback_fts_and_snapshot(self):
        reader = sqlite3.connect(self.cache, isolation_level=None)
        self.addCleanup(reader.close)
        reader.execute('BEGIN')
        self.assertEqual(reader.execute('SELECT generation FROM manifest').fetchone(), (1,))
        self.store.publish(2, [dict(record('new'), text='replacement')])
        self.assertEqual(reader.execute('SELECT id FROM records ORDER BY id').fetchall(), [('a',), ('b',)])
        self.assertEqual(reader.execute("SELECT id FROM lexical WHERE lexical MATCH 'synthetic' ORDER BY id").fetchall(), [('a',), ('b',)])
        reader.execute('ROLLBACK')
        self.assertEqual(reader.execute('SELECT generation FROM manifest').fetchone(), (2,))
        def fail():
            raise RuntimeError('injected')
        with self.assertRaises(RuntimeError):
            self.store.publish(3, [record()], fail)
        self.assertEqual(self.store.snapshot('allowed', {'new': HASH})[0], 2)
        self.assertEqual(reader.execute("SELECT id FROM lexical WHERE lexical MATCH 'replacement'").fetchall(), [('new',)])
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.publish(3, [record(), record()])
        self.assertEqual(reader.execute('SELECT generation FROM manifest').fetchone(), (2,))

    def test_actual_killed_writer_recovers(self):
        code = '''import json,sys,time
from pathlib import Path
from engine.storage import Store
s=Store(Path(sys.argv[1]),Path(sys.argv[2]),json.loads(sys.argv[3]))
def staged():
 print('staged',flush=True)
 time.sleep(10)
s.publish(2,[],staged)
'''
        import json
        # Trusted test program only, with a bounded readiness read via selector.
        worker = subprocess.Popen([sys.executable, '-B', '-c', code, str(self.cache),
                                   str(self.source), json.dumps(IDENTITY)], stdout=subprocess.PIPE)
        try:
            import selectors
            with selectors.DefaultSelector() as selector:
                selector.register(worker.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(3))
                self.assertEqual(worker.stdout.readline(), b'staged\n')
            worker.kill()
            worker.wait(timeout=2)
        finally:
            if worker.poll() is None:
                worker.kill()
                worker.wait(timeout=2)
            worker.stdout.close()
        reopened = Store(self.cache, self.source, IDENTITY)
        try:
            self.assertEqual(reopened.snapshot('allowed', {'a': HASH})[0], 1)
            self.assertEqual(reopened.snapshot('allowed', {'a': HASH})[1][0]['text'], 'synthetic')
            self.assertEqual(reopened.db.execute('PRAGMA integrity_check').fetchone(), ('ok',))
        finally:
            reopened.close()

    def test_record_bounds_and_generation(self):
        for change in ({'vector': [float('nan'), 0]}, {'vector': [1]}, {'hash': ''},
                       {'text': 'x' * 8193}, {'id': ''}, {'vector': [True, 0]},
                       {'vector': [1e39, 0]}, {'extra': 1}):
            with self.assertRaises(ValueError):
                self.store.publish(2, [dict(record(), **change)])
        with self.assertRaises(ValueError):
            self.store.publish(2, [record()] * 129)
        with self.assertRaises(ValueError):
            self.store.publish(1, [])
        self.assertEqual(self.store.snapshot('allowed', {'a': HASH})[0], 1)


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'folder').mkdir()
        (self.root / 'folder/note').write_bytes(b'synthetic')
        self.reader = ScopedReader(self.root)
        self.addCleanup(self.reader.close)

    def test_closed_reader_does_not_close_reused_fd(self):
        self.reader.close()
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            self.reader.close()
            os.fstat(fd)
            with self.assertRaisesRegex(ValueError, 'closed'):
                self.reader.read('folder/note')
            self.assertFalse(self.reader.fresh('folder/note', HASH))
        finally:
            os.close(fd)

    def test_replaced_root_and_symlink_ancestor(self):
        moved = self.root / 'moved'
        # Replace a reader root while its original descriptor remains open.
        folder = self.root / 'folder'
        reader = ScopedReader(folder)
        try:
            folder.rename(moved)
            folder.mkdir()
            (folder / 'note').write_bytes(b'synthetic')
            self.assertFalse(reader.fresh('note', HASH))
        finally:
            reader.close()
        alias = self.root / 'alias'
        alias.symlink_to(folder, target_is_directory=True)
        (folder / 'child').mkdir()
        with self.assertRaises((ValueError, OSError)):
            ScopedReader(alias / 'child')

    def test_read_hash_and_freshness(self):
        source = self.reader.read('folder/note')
        self.assertEqual(source.data, b'synthetic')
        self.assertEqual(source.digest, HASH)
        self.assertTrue(self.reader.fresh('folder/note', HASH))
        (self.root / 'folder/note').write_bytes(b'changed')
        self.assertFalse(self.reader.fresh('folder/note', HASH))
        (self.root / 'folder/note').unlink()
        self.assertFalse(self.reader.fresh('folder/note', HASH))

    def test_rejections(self):
        (self.root / 'link').symlink_to(self.root / 'folder', target_is_directory=True)
        (self.root / 'target').symlink_to(self.root / 'folder/note')
        os.mkfifo(self.root / 'pipe')
        for path in ('', '/folder/note', '../note', 'folder/../note', 'folder//note',
                     './folder/note', 'folder\\note', '.git/config', '.obsidian/config',
                     'link/note', 'target', 'pipe', 'folder', 'folder/note/'):
            with self.subTest(path=path), self.assertRaises((OSError, ValueError)):
                self.reader.read(path)
        with self.assertRaises(ValueError):
            self.reader.read('folder/note', 2)
        with self.assertRaises(ValueError):
            ScopedReader(self.root / 'link')

    def test_unsupported_interface(self):
        from unittest.mock import patch
        with patch('engine.scope.sys.platform', 'unsupported'), self.assertRaises(OSError):
            ScopedReader(self.root)

    def test_path_replaced_during_read(self):
        from unittest.mock import patch
        original = os.read
        changed = False
        def replace(fd, count):
            nonlocal changed
            data = original(fd, count)
            if not changed:
                changed = True
                (self.root / 'folder').rename(self.root / 'detached')
                (self.root / 'folder').mkdir()
                (self.root / 'folder/note').write_bytes(b'synthetic')
            return data
        with patch('engine.scope.os.read', side_effect=replace):
            self.assertFalse(self.reader.fresh('folder/note', HASH))

    def test_concurrent_edit_is_rejected(self):
        from unittest.mock import patch
        original_read = os.read
        changed = False
        def mutate(fd, count):
            nonlocal changed
            data = original_read(fd, count)
            if not changed:
                changed = True
                (self.root / 'folder/note').write_bytes(b'changed content')
            return data
        with patch('engine.scope.os.read', side_effect=mutate), self.assertRaises(ValueError):
            self.reader.read('folder/note')
