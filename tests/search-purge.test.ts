import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, link, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { purgeDerivedIndex } from '../plugin/src/search/purge';

const id = 'a'.repeat(64);
async function context() {
  const temp = await mkdtemp(join(tmpdir(), 'oks-derived-purge-'));
  const cache = join(temp, 'data', 'obsidian-knowledge-search', 'plugins', 'oks-synthetic-evidence', id, 'index');
  const note = join(temp, 'vault', 'original.md');
  await mkdir(cache, { recursive: true }); await mkdir(join(temp, 'vault'));
  await writeFile(note, 'Original Vault note must never be removed');
  return { temp, cache, note, cleanup: () => rm(temp, { recursive: true, force: true }) };
}
test('derived-only purge removes exact known files and preserves original notes and directory', async () => {
  const c = await context();
  try {
    await writeFile(join(c.cache, 'CURRENT'), 'pointer');
    await writeFile(join(c.cache, 'gen-' + 'b'.repeat(64) + '.json'), 'derived');
    assert.equal(await purgeDerivedIndex(c.cache, id, c.cache), 2);
    assert.deepEqual(await readdir(c.cache), []);
    assert.equal(await readFile(c.note, 'utf8'), 'Original Vault note must never be removed');
    assert.equal(await purgeDerivedIndex(c.cache, id, c.cache), 0);
  } finally { await c.cleanup(); }
});
test('purge rejects foreign, unknown and symlink entries atomically', async () => {
  const c = await context();
  try {
    await writeFile(join(c.cache, 'CURRENT'), 'pointer');
    await writeFile(join(c.cache, 'some-other-data'), 'foreign');
    await assert.rejects(purgeDerivedIndex(c.cache, id, c.cache));
    assert.deepEqual((await readdir(c.cache)).sort(), ['CURRENT','some-other-data']);
    await rm(join(c.cache, 'some-other-data'));
    await symlink(c.note, join(c.cache, 'PREVIOUS'));
    await assert.rejects(purgeDerivedIndex(c.cache, id, c.cache));
    assert.equal(await readFile(c.note,'utf8'), 'Original Vault note must never be removed');
    assert.equal((await readdir(c.cache)).includes('CURRENT'), true);
  } finally { await c.cleanup(); }
});
test('purge refuses hard-linked or wrong-root/wrong-id index path without removal', async () => {
  const c = await context();
  try {
    await link(c.note, join(c.cache, 'CURRENT'));
    await assert.rejects(purgeDerivedIndex(c.cache,id,c.cache));
    await assert.rejects(purgeDerivedIndex(c.cache,'b'.repeat(64),c.cache));
    await assert.rejects(purgeDerivedIndex(c.cache,id,join(c.temp,'other')));
    assert.equal(await readFile(c.note,'utf8'), 'Original Vault note must never be removed');
  } finally { await c.cleanup(); }
});
