import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedVaultReader } from '../plugin/src/standalone/source';
import { BOUNDS, hash } from '../plugin/src/standalone/contracts';

test('canonical original version proof is exact, immutable and root/path-bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oks-original-proof-'));
  try {
    const path = join(root, 'note.md');
    await writeFile(path, 'original');
    const reader = await BoundedVaultReader.open(root, () => ['note.md']);
    const first = await reader.readVersionProof('note.md');
    assert.deepEqual(Object.keys(first).sort(), ['rootId', 'sha256', 'sourceId', 'versionId']);
    assert.ok(Object.isFrozen(first));
    assert.equal(first.rootId, reader.rootId);
    assert.equal(first.sha256, hash('original'));
    const reopened = await BoundedVaultReader.open(root, () => ['note.md']);
    assert.deepEqual(await reopened.readVersionProof('note.md'), first);
    await writeFile(path, 'modified');
    const changed = await reader.readVersionProof('note.md');
    assert.notEqual(changed.sha256, first.sha256);
    assert.notEqual(changed.versionId, first.versionId);
    await writeFile(join(root, 'replacement.md'), 'modified');
    await rename(join(root, 'replacement.md'), path);
    const replaced = await reader.readVersionProof('note.md');
    assert.equal(replaced.sha256, changed.sha256);
    assert.notEqual(replaced.versionId, changed.versionId);
    await rename(path, join(root, 'moved.md'));
    const moved = await reader.readVersionProof('moved.md');
    assert.equal(moved.sha256, replaced.sha256);
    assert.notEqual(moved.versionId, replaced.versionId);
    await mkdir(join(root, 'other'));
    await writeFile(join(root, 'other', 'moved.md'), 'modified');
    const other = await BoundedVaultReader.open(join(root, 'other'), () => ['moved.md']);
    assert.notEqual((await other.readVersionProof('moved.md')).versionId, moved.versionId);
    await assert.rejects(reader.readVersionProof('note.md'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('canonical original version proof refuses links, non-original paths, and oversized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oks-original-denial-'));
  try {
    await writeFile(join(root, 'original.md'), 'safe');
    await symlink(join(root, 'original.md'), join(root, 'alias.md'));
    await link(join(root, 'original.md'), join(root, 'hard.md'));
    await writeFile(join(root, 'large.md'), Buffer.alloc(BOUNDS.fileBytes + 1));
    await mkdir(join(root, 'directory.md'));
    const reader = await BoundedVaultReader.open(root, () => []);
    for (const path of ['alias.md', 'hard.md', 'original.md', '../note.md', 'directory.md', 'large.md'])
      await assert.rejects(reader.readVersionProof(path), { code: 'SOURCE_REJECTED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

const fs = require('node:fs/promises') as typeof import('node:fs/promises');

test('original reader denies ancestor move and symlink substitution after descriptor open', async t => {
  for (const proof of [false, true]) for (const duringRewalk of [false, true]) {
    const base = await mkdtemp(join(tmpdir(), 'oks-original-ancestor-race-'));
    const root = join(base, 'vault');
    const nested = join(root, 'nested');
    const outside = join(base, 'outside');
    try {
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, 'note.md'), 'original');
      const reader = await BoundedVaultReader.open(root, () => ['nested/note.md']);
      const original = fs.open;
      let substituted = false;
      let parentOpens = 0;
      const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        const path = String(args[0]);
        if (path.endsWith('/nested')) parentOpens++;
        if (!substituted && (duringRewalk ? path.endsWith('/nested') && parentOpens === 2 : path.endsWith('/note.md'))) {
          substituted = true;
          try {
            await rename(nested, outside);
            await symlink(outside, nested);
          } catch (error) {
            await handle.close();
            throw error;
          }
        }
        return handle;
      });
      try {
        const read = proof ? reader.readVersionProof('nested/note.md') : reader.read('nested/note.md');
        await assert.rejects(read, { code: duringRewalk ? 'SOURCE_CHANGED' : 'SOURCE_REJECTED' });
        assert.equal(substituted, true);
      } finally { mock.mock.restore(); }
    } finally { await rm(base, { recursive: true, force: true }); }
  }
});
