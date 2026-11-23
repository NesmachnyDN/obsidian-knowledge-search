import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
const fsPromises = require('node:fs/promises') as typeof import('node:fs/promises');
import { WorkerMarkdownParser, type WorkerPort } from '../plugin/src/standalone/worker';
import { syntheticNodeWorkerPort } from './helpers/browser-worker-port';
import {
  BOUNDS, PROTOCOL, StandaloneError, hash, makeGeneration,
  type SearchRequest, type Predicate,
} from '../plugin/src/standalone/contracts';
import { parseMarkdown, terms } from '../plugin/src/standalone/markdown';
import { BoundedVaultReader, privateIndexPath } from '../plugin/src/standalone/source';
import { GenerationStore } from '../plugin/src/standalone/storage';
import { StandaloneEngine } from '../plugin/src/standalone/engine';

function newEngine(reader: BoundedVaultReader, store: GenerationStore, yieldJob?: () => Promise<void>,
  now?: () => number): StandaloneEngine {
  return new StandaloneEngine(reader, store,
    new WorkerMarkdownParser(join(process.cwd(), '.test-build', 'standalone-worker.js'),
      syntheticNodeWorkerPort), yieldJob, now);
}

const FIXTURE = [
  '---',
  'id: "1"',
  'version: 1',
  'enabled: true',
  'missing: null',
  'start: 2026-11-22',
  'tags: ["1", 1, true, null]',
  '---',
  '# Проект 🚀',
  '## Архитектура',
  'REQ-BOR-21: SSD хранит объекты 14 суток.',
  'See [[boreal-cache|Cache]].',
].join('\r\n');
const SECOND = '# Boreal cache\nREQ-BOR-22: HDD archive stores objects.\n';
const search = (query: string, overrides: Partial<SearchRequest> = {}): SearchRequest => ({
  protocolVersion: PROTOCOL, requestId: 'synthetic-1', query, requestedMode: 'lexical',
  limit: 10, ...overrides,
});
async function setup(source: Record<string, string> = { 'boreal.md': FIXTURE, 'more/note.md': SECOND }) {
  const root = await mkdtemp(join(tmpdir(), 'oks-04a-synthetic-'));
  const paths = new Set(Object.keys(source));
  for (const [path, content] of Object.entries(source)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const reader = await BoundedVaultReader.open(root, () => [...paths]);
  const store = await GenerationStore.open(join(root, '.obsidian/plugins/oks-synthetic-evidence/index'), reader.rootId);
  const engine = newEngine(reader, store);
  await engine.start();
  await engine.whenIdle();
  const cleanup = async () => { await engine.close(); await rm(root, { force: true, recursive: true }); };
  return { root, paths, reader, store, engine, cleanup };
}
function error(code: string) {
  return (e: unknown) => e instanceof StandaloneError && e.code === code;
}
test('canonical extraction preserves raw hash, CRLF byte+codepoint spans, heading hierarchy and literal links', () => {
  const data = Buffer.from(FIXTURE);
  const doc = parseMarkdown('boreal.md', data, hash('root'));
  assert.equal(doc.sha256, hash(data));
  assert.deepEqual(doc.properties.map(p => [p.key, p.valueType]), [
    ['id','string'], ['version','number'], ['enabled','boolean'], ['missing','null'],
    ['start','date'], ['tags','list'],
  ]);
  assert.deepEqual(doc.properties.at(-1)?.value, ['1', 1, true, null]);
  assert.deepEqual(doc.wikiLinks, ['boreal-cache|Cache']);
  const block = doc.blocks.find(b => b.originalText.startsWith('REQ-'))!;
  assert.deepEqual(block.headings, ['Проект 🚀', 'Архитектура']);
  assert.equal(block.locator.lineStart, 11);
  assert.equal(block.locator.lineEnd, 11);
  assert.equal(block.originalText, data.subarray(block.locator.byteStart, block.locator.byteEnd).toString());
  const prefix = data.subarray(0, block.locator.byteStart).toString();
  assert.equal([...prefix].length, block.locator.charStart);
  assert.equal(block.locator.charEnd, block.locator.charStart + [...block.originalText].length);
  assert.equal(doc.blocks[8]?.locator.lineStart, 9);
  assert.notEqual(Buffer.byteLength(prefix), prefix.length);
});
test('typed scalar/list predicates do not coerce, malformed YAML never becomes Properties', async () => {
  const { engine, cleanup } = await setup();
  try {
    const check = async (predicate: Predicate) =>
      (await engine.search(search('REQ-BOR-21', { predicates: [predicate] }))).hits.length;
    assert.equal(await check({ key:'id', valueType:'string', value:'1', operator:'eq' }), 1);
    assert.equal(await check({ key:'id', valueType:'number', value:1, operator:'eq' }), 0);
    assert.equal(await check({ key:'version', valueType:'number', value:1, operator:'eq' }), 1);
    assert.equal(await check({ key:'version', valueType:'string', value:'1', operator:'eq' }), 0);
    assert.equal(await check({ key:'enabled', valueType:'boolean', value:true, operator:'eq' }), 1);
    assert.equal(await check({ key:'missing', valueType:'null', value:null, operator:'eq' }), 1);
    assert.equal(await check({ key:'missing', valueType:'string', value:'null', operator:'eq' }), 0);
    assert.equal(await check({ key:'start', valueType:'date', value:'2026-11-22', operator:'eq' }), 1);
    assert.equal(await check({ key:'tags', valueType:'list', value:1, operator:'contains' }), 1);
    assert.equal(await check({ key:'tags', valueType:'list', value:'1', operator:'contains' }), 1);
    assert.equal(await check({ key:'tags', valueType:'list', value:false, operator:'contains' }), 0);
    assert.equal(await check({ key:'tags', valueType:'list', value:[1,'1',true,null], operator:'eq' }), 0);
    await assert.rejects(engine.search(search('SSD', { predicates: [
      { key:'enabled', valueType:'boolean', value:'true' as unknown as boolean, operator:'eq' },
    ] })), error('INVALID_REQUEST'));
  } finally { await cleanup(); }
  const invalid = parseMarkdown('bad.md', Buffer.from('---\na: 1\na: "1"\n---\n# still retained'),
    hash('root'));
  assert.equal(invalid.extractionStatus, 'partial');
  assert.deepEqual(invalid.properties, []);
});
test('lexical exact identifiers, Unicode RU/EN, scope, deterministic tie, filters BEFORE Top-K and original EvidenceHit', async () => {
  const { engine, cleanup } = await setup();
  try {
    const one = await engine.search(search('REQ-BOR-21'));
    assert.equal(one.status, 'ok');
    assert.equal(one.hits[0]?.originalExcerpt, 'REQ-BOR-21: SSD хранит объекты 14 суток.');
    assert.equal(one.hits[0]?.sourceLocators[0]?.lineStart, 11);
    assert.equal(one.hits[0]?.retrievalMode, 'lexical');
    assert.match(one.hits[0]?.indexGenerationId ?? '', /^[a-f0-9]{64}$/);
    assert.equal(one.hits[0]?.sourceSha256, hash(FIXTURE));
    assert.deepEqual(await engine.search(search('REQ-BOR-21')), one);
    assert.equal((await engine.search(search('объекты'))).hits.length, 1);
    assert.equal((await engine.search(search('HDD', { scope:['boreal.md'] }))).hits.length, 0);
    assert.equal((await engine.search(search('HDD', { scope:['more/note.md'] }))).hits.length, 1);
    assert.equal((await engine.search(search('SSD', { limit: 1,
      predicates: [{ key:'id', valueType:'string', value:'1', operator:'eq' }] }))).hits[0]?.sourceId, 'boreal.md');
    assert.equal((await engine.search(search('SSD', { requestedMode:'hybrid' }))).error, 'CAPABILITY_UNAVAILABLE');
    assert.equal((await engine.search(search('SSD', { requestedMode:'dense' }))).hits.length, 0);
    assert.deepEqual(terms('REQ-BOR-21 POST /v2/items'), ['req-bor-21','req','bor','21','post','v2/items','v2','items']);
  } finally { await cleanup(); }
});
test('B9: mixed-case and Unicode source order remains stable without false reconciliation', async () => {
  const { root, reader, store, engine, cleanup } = await setup({
    'Z.md': 'REQ-MIX-UPPER: original upper-case file\n',
    'a.md': 'REQ-MIX-LOWER: original lower-case file\n',
    'Ёж.md': 'REQ-MIX-RU: исходный документ\n',
    'écho.md': 'REQ-MIX-UNICODE: accented name\n',
  });
  const realRead = reader.read.bind(reader);
  let readCount = 0;
  let restarted: StandaloneEngine | null = null;
  try {
    const generation = engine.status().generationId;
    assert.equal(engine.status().status, 'ready');
    reader.read = async path => { readCount++; return realRead(path); };
    for (let i = 0; i < 3; i++) {
      const negative = await engine.search(search('REQ-MIX-NOT-FOUND'));
      assert.equal(negative.status, 'ok');
      assert.equal(negative.error, null);
      assert.deepEqual(negative.hits, []);
      assert.equal(negative.indexGenerationId, generation);
      assert.equal(engine.status().busy, false);
    }
    assert.equal(readCount, 0, 'stable negative queries must not trigger a full source audit');
    for (const [term, path] of [['REQ-MIX-UPPER', 'Z.md'], ['REQ-MIX-LOWER', 'a.md'],
      ['REQ-MIX-RU', 'Ёж.md'], ['REQ-MIX-UNICODE', 'écho.md']] as const) {
      const result = await engine.search(search(term, { scope: [path] }));
      assert.equal(result.status, 'ok');
      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0]?.sourceId, path);
      assert.equal(result.indexGenerationId, generation);
    }
    await writeFile(join(root, 'Z.md'), 'REQ-MIX-CHANGED: missed modify event\n');
    const missed = await engine.search(search('REQ-MIX-CHANGED'));
    assert.equal(missed.status, 'degraded');
    assert.equal(missed.error, 'RECONCILING');
    assert.equal(missed.hits.length, 0);
    await engine.whenIdle();
    assert.equal(engine.status().status, 'ready');
    const repaired = await engine.search(search('REQ-MIX-CHANGED'));
    assert.equal(repaired.status, 'ok');
    assert.equal(repaired.hits.length, 1);
    assert.equal((await engine.search(search('REQ-MIX-UPPER'))).hits.length, 0);
    await engine.close();
    restarted = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await restarted.start();
    await restarted.whenIdle();
    assert.equal(restarted.status().status, 'ready');
    const recovered = await restarted.search(search('REQ-MIX-CHANGED'));
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.hits.length, 1);
    assert.equal(recovered.indexGenerationId, repaired.indexGenerationId);
  } finally {
    reader.read = realRead;
    await restarted?.close();
    await cleanup();
  }
});

test('invalid protocol, query, scope, type, version, unsupported source', async () => {
  const { engine, reader, cleanup } = await setup();
  try {
    for (const query of ['', ' ', 'x'.repeat(BOUNDS.queryBytes + 1)]) {
      await assert.rejects(engine.search(search(query)), error('INVALID_REQUEST'));
    }
    await assert.rejects(engine.search(search('x', { protocolVersion: 9 as 2 })), error('INVALID_REQUEST'));
    await assert.rejects(engine.search(search('x', { scope: ['../outside.md'] })), error('INVALID_REQUEST'));
    await assert.rejects(reader.read('not.md/../outside.md'), error('SOURCE_REJECTED'));
    await assert.rejects(reader.read('some.pdf'), error('SOURCE_REJECTED'));
    assert.throws(() => parseMarkdown('x.md', Buffer.from([0xff]), reader.rootId), error('INVALID_UTF8'));
    assert.throws(() => parseMarkdown('x.md', Buffer.alloc(BOUNDS.fileBytes + 1), reader.rootId), error('SOURCE_LIMIT'));
  } finally { await cleanup(); }
});
test('lifecycle: restart, create, modify, rename, delete and stale suppression without any events', async () => {
  const { engine, root, paths, reader, store, cleanup } = await setup();
  try {
    const original = await engine.search(search('SSD'));
    const oldId = original.indexGenerationId;
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD хранит', 'HDD хранит'));
    const stale = await engine.search(search('SSD'));
    assert.equal(stale.hits.length, 0);
    assert.equal(stale.staleSourceCount, 1);
    assert.equal(stale.status, 'degraded');
    engine.changed('boreal.md'); await engine.whenIdle();
    assert.equal((await engine.search(search('HDD'))).hits.length >= 1, true);
    assert.notEqual(engine.status().generationId, oldId);
    const reloaded = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await reloaded.start(); await reloaded.whenIdle();
    assert.equal((await reloaded.search(search('HDD'))).hits.length >= 1, true);
    await reloaded.close();
    await mkdir(join(root, 'new'), {recursive:true});
    await writeFile(join(root, 'new/new.md'), '# New\nREQ-NEW-1: fresh note.');
    paths.add('new/new.md'); engine.changed('new/new.md'); await engine.whenIdle();
    assert.equal((await engine.search(search('REQ-NEW-1'))).hits.length, 1);
    await rename(join(root, 'new/new.md'), join(root, 'new/moved.md'));
    paths.delete('new/new.md'); paths.add('new/moved.md');
    assert.equal((await engine.search(search('REQ-NEW-1'))).hits.length, 0);
    engine.changed('new/new.md'); engine.changed('new/moved.md'); await engine.whenIdle();
    assert.equal((await engine.search(search('REQ-NEW-1'))).hits[0]?.sourceId, 'new/moved.md');
    await rm(join(root, 'new/moved.md')); paths.delete('new/moved.md');
    engine.changed('new/moved.md'); await engine.whenIdle();
    assert.equal((await engine.search(search('REQ-NEW-1'))).hits.length, 0);
  } finally { await cleanup(); }
});
test('cancellation prevents publication; failed commit keeps committed generation and degrades', async () => {
  const { root, reader, store, cleanup } = await setup();
  const initial = (await store.load()).generation!;
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const enteredGate = new Promise<void>(r => { entered = r; });
  let block = true;
  const pause = new Promise<void>(r => { release = r; });
  const engine = newEngine(reader, store, async () => {
    if (block) { entered(); await pause; }
  });
  try {
    await engine.start();
    await enteredGate;
    engine.cancel();
    block = false; release(); await engine.whenIdle();
    assert.equal(engine.status().generationId, initial.generationId);
    assert.equal(engine.status().error, 'CANCELLED');
    const real = store.commit.bind(store);
    store.commit = async () => { throw new StandaloneError('INDEX_IO_ERROR'); };
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD','GPU'));
    engine.resume(); await engine.whenIdle();
    assert.equal(engine.status().generationId, initial.generationId);
    assert.equal(engine.status().status, 'degraded');
    assert.equal((await engine.search(search('SSD'))).hits.length, 0);
    store.commit = real;
    engine.rebuild(); await engine.whenIdle();
    assert.equal((await engine.search(search('GPU'))).hits.length, 1);
  } finally { await engine.close(); await cleanup(); }
});
test('B1: cancel inside a pending store commit vetoes CURRENT and survives restart', async () => {
  const { root, reader, store, cleanup } = await setup();
  const original = (await store.load()).generation!;
  const commit = store.commit.bind(store);
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const enteredCommit = new Promise<void>(resolve => { entered = resolve; });
  const commitGate = new Promise<void>(resolve => { release = resolve; });
  store.commit = async (next, beginPublication, onPublished) => {
    entered();
    await commitGate; // Delayed asynchronous commit: not the earlier parser/yield gate.
    return commit(next, beginPublication, onPublished);
  };
  const engine = newEngine(reader, store);
  try {
    await engine.start(); await engine.whenIdle();
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'GPU'));
    engine.changed('boreal.md');
    await enteredCommit;
    assert.equal(engine.cancel(), true);
    release(); await engine.whenIdle();
    assert.equal(engine.status().error, 'CANCELLED');
    assert.equal(engine.status().generationId, original.generationId);
    const disk = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(disk.generation?.generationId, original.generationId);
    const restarted = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    try {
      await restarted.start();
      assert.equal((await restarted.search(search('SSD'))).hits.length, 0); // Stale SHA suppressed.
      await restarted.whenIdle();
      assert.equal((await restarted.search(search('GPU'))).hits.length, 1);
    } finally { await restarted.close(); }
  } finally { release(); await engine.close(); await cleanup(); }
});

test('B1: unload during delayed commit vetoes CURRENT before publication', async () => {
  const { root, reader, store, cleanup } = await setup();
  const original = (await store.load()).generation!;
  const commit = store.commit.bind(store);
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const enteredCommit = new Promise<void>(resolve => { entered = resolve; });
  const commitGate = new Promise<void>(resolve => { release = resolve; });
  store.commit = async (next, beginPublication, onPublished) => {
    entered(); await commitGate;
    return commit(next, beginPublication, onPublished);
  };
  const engine = newEngine(reader, store);
  try {
    await engine.start(); await engine.whenIdle();
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'GPU'));
    engine.changed('boreal.md');
    await enteredCommit;
    const unloading = engine.close();
    release(); await unloading;
    const persisted = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(persisted.generation?.generationId, original.generationId);
  } finally { release(); await engine.close(); await cleanup(); }
});

test('B1: cancel at CURRENT rename boundary is deferred, not falsely acknowledged', async () => {
  const { root, reader, store, cleanup } = await setup();
  const commit = store.commit.bind(store);
  let engine: StandaloneEngine;
  let observedBoundary = false;
  store.commit = async (next, beginPublication, onPublished) => commit(next, () => {
    beginPublication?.(); // The actual store invokes this immediately before rename.
    observedBoundary = true;
    assert.equal(engine.cancel(), false);
    assert.equal(engine.status().error, 'CANCEL_DEFERRED');
  }, onPublished);
  engine = newEngine(reader, store);
  try {
    await engine.start(); await engine.whenIdle();
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'GPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    assert.equal(observedBoundary, true);
    assert.equal(engine.status().status, 'degraded');
    assert.equal(engine.status().error, 'CANCEL_DEFERRED');
    const durable = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(engine.status().generationId, durable.generation?.generationId);
    assert.equal((await engine.search(search('GPU'))).hits.length, 1);
    engine.resume(); await engine.whenIdle();
    assert.equal(engine.status().status, 'ready');
  } finally { await engine.close(); await cleanup(); }
});


// These cases fault-inject real Node filesystem operations, not GenerationStore.commit.
// The on-disk CURRENT, PREVIOUS and generation files are independently reopened.
test('B3: post-publish GC EACCES with deferred cancel preserves CURRENT and memory, then cleans orphans', async () => {
  const { root, reader, store, engine, cleanup } = await setup();
  const realUnlink = fsPromises.unlink;
  let releaseGc: () => void = () => {};
  let gcEntered: () => void = () => {};
  const gcGate = new Promise<void>(resolve => { releaseGc = resolve; });
  const enteredGc = new Promise<void>(resolve => { gcEntered = resolve; });
  let restart: StandaloneEngine | null = null;
  let injected = false;
  try {
    const a = engine.status().generationId!;
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'GPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    const b = engine.status().generationId!;
    assert.notEqual(a, b);

    (fsPromises as { unlink: typeof realUnlink }).unlink = async path => {
      if (String(path) === join(store.dir, 'gen-' + a + '.json')) {
        injected = true;
        gcEntered(); await gcGate;
        throw Object.assign(new Error('synthetic GC EACCES'), { code: 'EACCES' });
      }
      return realUnlink(path);
    };
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'NPU'));
    engine.changed('boreal.md');
    await enteredGc;
    // The durable and observable generation already switched BEFORE awaited GC.
    const c = JSON.parse(await readFile(join(store.dir, 'CURRENT'), 'utf8')).generationId as string;
    assert.notEqual(c, b);
    assert.equal(engine.status().generationId, c);
    assert.equal(engine.status().error, 'COMMIT_FINALIZING');
    const duringGc = await engine.search(search('NPU'));
    assert.equal(duringGc.status, 'degraded');
    assert.equal(duringGc.indexGenerationId, c);
    assert.ok(duringGc.hits.length > 0);
    assert.ok(duringGc.hits.every(hit => hit.indexGenerationId === c));
    assert.equal(engine.cancel(), false);
    assert.equal(engine.status().error, 'CANCEL_DEFERRED');
    releaseGc(); await engine.whenIdle();
    assert.equal(injected, true);
    assert.equal(engine.status().generationId, c);
    assert.equal(engine.status().maintenanceWarning, 'INDEX_GC_FAILED');
    assert.equal(engine.status().status, 'degraded');
    assert.equal(engine.status().error, 'CANCEL_DEFERRED');
    const durable = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(durable.generation?.generationId, c);
    assert.equal((await engine.search(search('NPU'))).hits.length, 1);
    assert.equal((await readFile(join(root, 'boreal.md'), 'utf8')).includes('NPU'), true);

    (fsPromises as { unlink: typeof realUnlink }).unlink = realUnlink;
    restart = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await restart.start(); await restart.whenIdle();
    assert.equal(restart.status().generationId, c);
    assert.equal((await restart.search(search('NPU'))).hits.length, 1);
    await restart.close(); restart = null;

    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'TPU'));
    engine.resume(); await engine.whenIdle();
    assert.equal(engine.status().status, 'ready');
    assert.equal(engine.status().maintenanceWarning, null);
    assert.equal((await engine.search(search('TPU'))).hits.length, 1);
    const gens = (await fsPromises.readdir(store.dir)).filter(f => /^gen-[0-9a-f]{64}\.json$/.test(f));
    assert.equal(gens.length, 2); // CURRENT plus valid PREVIOUS, no orphan leak.
    const clean = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(clean.generation?.generationId, engine.status().generationId);
  } finally {
    releaseGc();
    (fsPromises as { unlink: typeof realUnlink }).unlink = realUnlink;
    await restart?.close();
    await cleanup();
  }
});

test('B3: unload during post-publication GC keeps durable CURRENT and permits a clean reload', async () => {
  const { root, reader, store, engine, cleanup } = await setup();
  const realUnlink = fsPromises.unlink;
  let releaseGc: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>(resolve => { releaseGc = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let restart: StandaloneEngine | null = null;
  try {
    const a = engine.status().generationId!;
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'GPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    (fsPromises as { unlink: typeof realUnlink }).unlink = async path => {
      if (String(path) === join(store.dir, 'gen-' + a + '.json')) {
        entered(); await gate;
      }
      return realUnlink(path);
    };
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'NPU'));
    engine.changed('boreal.md');
    await started;
    const c = JSON.parse(await readFile(join(store.dir, 'CURRENT'), 'utf8')).generationId as string;
    assert.equal(engine.status().generationId, c);
    const closing = engine.close();
    releaseGc();
    await closing;
    (fsPromises as { unlink: typeof realUnlink }).unlink = realUnlink;
    const disk = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(disk.generation?.generationId, c);
    restart = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await restart.start(); await restart.whenIdle();
    assert.equal(restart.status().generationId, c);
    assert.equal((await restart.search(search('NPU'))).hits.length, 1);
    assert.equal((await readFile(join(root, 'boreal.md'), 'utf8')).includes('NPU'), true);
  } finally {
    releaseGc();
    (fsPromises as { unlink: typeof realUnlink }).unlink = realUnlink;
    await restart?.close();
    await cleanup();
  }
});

test('B3: CURRENT rename success with directory fsync failure reports uncertainty and keeps same generation', async () => {
  const { root, reader, store, engine, cleanup } = await setup();
  const realRename = fsPromises.rename;
  const realOpen = fsPromises.open;
  let renamedCurrent = false, injected = false;
  let restart: StandaloneEngine | null = null;
  try {
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'GPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    const b = engine.status().generationId!;
    const current = join(store.dir, 'CURRENT');
    (fsPromises as { rename: typeof realRename }).rename = async (src, dst) => {
      await realRename(src, dst);
      if (String(dst) === current) renamedCurrent = true;
    };
    (fsPromises as { open: typeof realOpen }).open = async (path, flags, mode) => {
      const handle = await realOpen(path, flags, mode);
      if (renamedCurrent && String(path) === store.dir && !injected) {
        injected = true;
        return new Proxy(handle, {
          get(target, prop) {
            if (prop === 'sync') return async () => {
              throw Object.assign(new Error('synthetic directory fsync EIO'), { code: 'EIO' });
            };
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      return handle;
    };
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'NPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    assert.equal(injected, true);
    const c = JSON.parse(await readFile(current, 'utf8')).generationId as string;
    assert.notEqual(c, b);
    assert.equal(engine.status().generationId, c);
    assert.equal(engine.status().status, 'degraded');
    assert.equal(engine.status().error, 'INDEX_DURABILITY_UNCERTAIN');
    assert.equal(engine.status().maintenanceWarning, 'INDEX_DURABILITY_UNCERTAIN');
    assert.equal((await engine.search(search('NPU'))).hits.length, 1);

    (fsPromises as { open: typeof realOpen }).open = realOpen;
    (fsPromises as { rename: typeof realRename }).rename = realRename;
    restart = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await restart.start(); await restart.whenIdle();
    assert.equal(restart.status().generationId, c);
    assert.equal((await restart.search(search('NPU'))).hits.length, 1);
    const previous = JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8'));
    assert.equal(previous.generationId, b);
    await restart.close(); restart = null;

    // Reconciliation can clear the uncertainty after a new durable publication.
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'TPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    assert.equal(engine.status().maintenanceWarning, null);
    assert.equal(engine.status().status, 'ready');
    assert.equal((await engine.search(search('TPU'))).hits.length, 1);
  } finally {
    (fsPromises as { open: typeof realOpen }).open = realOpen;
    (fsPromises as { rename: typeof realRename }).rename = realRename;
    await restart?.close();
    await cleanup();
  }
});

test('B3: CURRENT rename rejection before publication preserves prior generation and recovers on retry', async () => {
  const { root, reader, store, engine, cleanup } = await setup();
  const realRename = fsPromises.rename;
  const before = engine.status().generationId!;
  let injected = false;
  try {
    (fsPromises as { rename: typeof realRename }).rename = async (src, dst) => {
      if (String(dst) === join(store.dir, 'CURRENT')) {
        injected = true;
        throw Object.assign(new Error('synthetic rename EACCES'), { code: 'EACCES' });
      }
      return realRename(src, dst);
    };
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'GPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    assert.equal(injected, true);
    assert.equal(engine.status().generationId, before);
    assert.equal(engine.status().status, 'degraded');
    assert.equal(engine.status().error, 'IO_FAILURE');
    assert.equal(engine.status().maintenanceWarning, null);
    assert.equal((await (await GenerationStore.open(store.dir, reader.rootId)).load()).generation?.generationId, before);
    assert.equal((await engine.search(search('SSD'))).hits.length, 0); // Source freshness suppresses stale bytes.

    (fsPromises as { rename: typeof realRename }).rename = realRename;
    engine.rebuild(); await engine.whenIdle();
    assert.equal(engine.status().status, 'ready');
    assert.equal((await engine.search(search('GPU'))).hits.length, 1);
    assert.equal((await (await GenerationStore.open(store.dir, reader.rootId)).load()).generation?.generationId,
      engine.status().generationId);
  } finally {
    (fsPromises as { rename: typeof realRename }).rename = realRename;
    await cleanup();
  }
});

test('corrupt CURRENT falls back to previous full generation and suppresses superseded hits', async () => {
  const { root, engine, reader, store, cleanup } = await setup();
  try {
    const old = engine.status().generationId;
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'GPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    const newer = engine.status().generationId;
    assert.notEqual(old, newer);
    await writeFile(join(store.dir, 'CURRENT'), '{corrupt');
    const recovered = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.generation?.generationId, old);
    const oldEngine = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await oldEngine.start();
    // Current authoritative source no longer matches the old recovered snapshot.
    assert.equal((await oldEngine.search(search('SSD'))).hits.length, 0);
    await oldEngine.whenIdle();
    await oldEngine.close();
  } finally { await cleanup(); }
});
test('B2: two consecutive corrupt CURRENT events preserve the recovered PREVIOUS generation', async () => {
  const { reader, store, cleanup } = await setup();
  try {
    const a = (await store.load()).generation!;
    const b = makeGeneration(reader.rootId, [parseMarkdown('b.md', Buffer.from('# B\nREQ-B-2'), reader.rootId)]);
    const c = makeGeneration(reader.rootId, [parseMarkdown('c.md', Buffer.from('# C\nREQ-C-3'), reader.rootId)]);
    await store.commit(b);
    await writeFile(join(store.dir, 'CURRENT'), '{corrupt-1');
    const afterFirstCrash = await GenerationStore.open(store.dir, reader.rootId);
    const recovered = await afterFirstCrash.load();
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.generation?.generationId, a.generationId);
    await afterFirstCrash.commit(c);
    const savedPrevious = JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8'));
    assert.equal(savedPrevious.generationId, a.generationId);
    assert.equal((await readFile(join(store.dir, 'gen-' + a.generationId + '.json'))).length > 0, true);
    await writeFile(join(store.dir, 'CURRENT'), '{corrupt-2');
    const afterSecondCrash = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(afterSecondCrash.recovered, true);
    assert.equal(afterSecondCrash.generation?.generationId, a.generationId);
    assert.equal(afterSecondCrash.error, 'INDEX_CORRUPT');
  } finally { await cleanup(); }
});

test('B2: startup reconciliation repairs corrupt CURRENT even with unchanged source versions', async () => {
  const { root, reader, store, engine, cleanup } = await setup();
  let restart: StandaloneEngine | undefined;
  try {
    const original = (await store.load()).generation!;
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD', 'GPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    await writeFile(join(root, 'boreal.md'), FIXTURE);
    await writeFile(join(store.dir, 'CURRENT'), '{corrupt');
    restart = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await restart.start(); await restart.whenIdle();
    assert.equal(restart.status().status, 'ready');
    assert.equal(restart.status().generationId, original.generationId);
    const verified = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(verified.recovered, false);
    assert.equal(verified.error, null);
    assert.equal(verified.generation?.generationId, original.generationId);
    assert.equal((await restart.search(search('SSD'))).hits.length, 1);
  } finally { await restart?.close(); await cleanup(); }
});

test('symlink source and foreign copied Vault cache fail closed; empty/emoji-only Markdown do not invent evidence', async () => {
  const { root, reader, store, engine, cleanup } = await setup();
  const external = join(root, 'outside.txt');
  try {
    await writeFile(external, 'not a vault note');
    await symlink(external, join(root, 'link.md'));
    await assert.rejects(reader.read('link.md'));
    assert.equal(parseMarkdown('empty.md', Buffer.alloc(0), reader.rootId).extractionStatus, 'empty');
    assert.equal(parseMarkdown('emoji.md', Buffer.from('😀 🚀'), reader.rootId).blocks[0]?.terms.length, 0);
    const alien = await mkdtemp(join(tmpdir(), 'oks-04a-foreign-'));
    try {
      const other = await BoundedVaultReader.open(alien, () => []);
      const wrong = await GenerationStore.open(store.dir, other.rootId);
      await assert.rejects(wrong.load(), error('VAULT_IDENTITY_CHANGED'));
    } finally { await rm(alien, {recursive:true,force:true}); }
  } finally { await cleanup(); }
});

test('language-neutral source fixture parity: Python reference vs native schema semantics', async () => {
  const fixtures: {
    version: string;
    cases: { path:string; text:string; sha256:string; referenceParserStatus:string;
      nativeExtractionStatus:string; invalidTypedProperties:boolean;
      blocks: {kind:string;text:string;lineStart:number;byteStart:number;byteEnd:number;
        charStart:number;charEnd:number;headings:string[];wikiLinks:string[]}[] }[];
  } = JSON.parse(await readFile('contracts/fixtures/standalone-v2.json', 'utf8'));
  assert.equal(fixtures.version, 'oks-04a-lexical-contract-v1');
  for (const fixture of fixtures.cases) {
    const bytes=Buffer.from(fixture.text,'utf8');
    assert.equal(hash(bytes),fixture.sha256);
    const actual=parseMarkdown(fixture.path,bytes,hash('synthetic-root'));
    assert.equal(actual.extractionStatus,fixture.nativeExtractionStatus,fixture.path);
    assert.equal(actual.sha256,fixture.sha256);
    assert.equal(actual.blocks.length,fixture.blocks.length,fixture.path);
    for(let i=0;i<fixture.blocks.length;i++) {
      const block=actual.blocks[i]!, expected=fixture.blocks[i]!;
      assert.equal(block.originalText,expected.text);
      assert.equal(block.kind,expected.kind);
      assert.equal(block.locator.lineStart,expected.lineStart);
      assert.equal(block.locator.byteStart,expected.byteStart);
      assert.equal(block.locator.byteEnd,expected.byteEnd);
      assert.equal(block.locator.charStart,expected.charStart);
      assert.equal(block.locator.charEnd,expected.charEnd);
      assert.deepEqual(block.headings,expected.headings);
      assert.deepEqual(block.wikiLinks,expected.wikiLinks);
      assert.equal(bytes.subarray(expected.byteStart,expected.byteEnd).toString(),expected.text);
    }
    if (fixture.invalidTypedProperties) assert.equal(actual.properties.length,0);
  }
});

test('unknown index schema fails closed until explicitly rebuilt; source remains untouched', async () => {
  const { root, reader, store, cleanup } = await setup();
  const sourceBefore=await readFile(join(root,'boreal.md'));
  try {
    const pointer=JSON.parse(await readFile(join(store.dir,'CURRENT'),'utf8'));
    pointer.schemaVersion='oks-other-version';
    await writeFile(join(store.dir,'CURRENT'),JSON.stringify(pointer));
    const nextStore=await GenerationStore.open(store.dir,reader.rootId);
    const engine=newEngine(reader,nextStore);
    try {
      await engine.start(); await engine.whenIdle();
      assert.equal(engine.status().status,'failed');
      assert.equal(engine.status().error,'INDEX_INCOMPATIBLE');
      assert.equal((await engine.search(search('SSD'))).hits.length,0);
      assert.equal((await readFile(join(store.dir,'CURRENT'),'utf8')).includes('oks-other-version'),true);
      engine.rebuild(); await engine.whenIdle();
      assert.equal(engine.status().status,'ready');
      assert.equal((await engine.search(search('SSD'))).hits.length,1);
      assert.deepEqual(await readFile(join(root,'boreal.md')),sourceBefore);
    } finally { await engine.close(); }
  } finally { await cleanup(); }
});
test('crash orphan stage is reclaimed only after grace; foreign cache files never touched', async () => {
  const { store,reader,cleanup }=await setup();
  try {
    const old=join(store.dir,'.stage-12345678-1234-4123-8123-123456789abc');
    const unknown=join(store.dir,'user-owned.data');
    await writeFile(old,'synthetic interrupted publish');
    await writeFile(unknown,'DO_NOT_DELETE');
    const time=new Date(Date.now()-180000);
    await utimes(old,time,time);
    const reopened=await GenerationStore.open(store.dir,reader.rootId);
    assert.equal((await reopened.load()).generation!==null,true);
    await assert.rejects(stat(old),{code:'ENOENT'});
    assert.equal(await readFile(unknown,'utf8'),'DO_NOT_DELETE');
  } finally { await cleanup(); }
});
test('source mutated while snapshot build is in flight cannot be published', async () => {
  const { root,reader,store,cleanup }=await setup();
  let mutated=false;
  const concurrent=newEngine(reader,store,async()=>{
    if(!mutated){mutated=true;await writeFile(join(root,'boreal.md'),FIXTURE.replace('SSD','GPU'));}
  });
  try {
    const previous=(await store.load()).generation!;
    await concurrent.start(); await concurrent.whenIdle();
    assert.equal(mutated,true);
    assert.equal(concurrent.status().generationId,previous.generationId);
    assert.equal(concurrent.status().status,'degraded');
    assert.equal((await concurrent.search(search('SSD'))).hits.length,0);
    concurrent.rebuild(); await concurrent.whenIdle();
    assert.equal(concurrent.status().status,'ready');
    assert.equal((await concurrent.search(search('GPU'))).hits.length,1);
  } finally { await concurrent.close();await cleanup(); }
});
test('unload during active indexing aborts unpublished generation', async () => {
  const { root, reader, store, cleanup }=await setup();
  let entered:()=>void=()=>{};
  let release:()=>void=()=>{};
  const enteredGate=new Promise<void>(resolve=>entered=resolve);
  const gate=new Promise<void>(resolve=>release=resolve);
  const previous=(await store.load()).generation!.generationId;
  const run=newEngine(reader,store,async()=>{entered();await gate;});
  try {
    await writeFile(join(root,'boreal.md'),FIXTURE.replace('SSD','GPU'));
    await run.start();await enteredGate;
    const close=run.close();
    release();await close;
    assert.equal((await (await GenerationStore.open(store.dir,reader.rootId)).load()).generation?.generationId,previous);
  } finally {release();await cleanup();}
});
test('scoped directory symlink cannot escape source root; corrupt derived directory symlink rejected', async()=>{
  const { root,reader,cleanup }=await setup();
  const outside=await mkdtemp(join(tmpdir(),'oks-04a-foreign-'));
  try {
    await writeFile(join(outside,'secret.md'),'synthetic inaccessible note');
    await symlink(outside,join(root,'outside-dir'));
    await assert.rejects(reader.read('outside-dir/secret.md'),error('SOURCE_REJECTED'));
    await symlink(outside,join(root,'fake-cache'));
    await assert.rejects(GenerationStore.open(join(root,'fake-cache/index'),reader.rootId),
      error('CACHE_PATH_REJECTED'));
  } finally {await rm(outside,{recursive:true,force:true});await cleanup();}
});
test('size limit, invalid prefix and empty markdown are deterministic fail-closed',async()=>{
  const { root,paths,engine,reader,cleanup }=await setup();
  try {
    assert.equal((await engine.search(search('🚀'))).hits.length,0);
    await writeFile(join(root,'oversized.md'),'Z'.repeat(BOUNDS.fileBytes+1));
    paths.add('oversized.md');
    engine.changed('oversized.md');await engine.whenIdle();
    assert.equal(engine.status().status,'degraded');
    assert.equal((await engine.search(search('SSD'))).hits.length,1);
    await assert.rejects(reader.read('oversized.md'),error('SOURCE_REJECTED'));
    assert.equal((await engine.search(search('SSD',{scope:[]}))).hits.length,0);
    await assert.rejects(engine.search(search('SSD',{predicates:[
      {key:'version',valueType:'number',value:Number.NaN,operator:'eq'},
    ]})),error('INVALID_REQUEST'));
  } finally {await cleanup();}
});
test('equal-score repeated evidence stays ordered and distinct by canonical line/ID',async()=>{
  const text='# Repeated\nREQ-TST-10: same\nREQ-TST-10: same\n';
  const {engine,cleanup}=await setup({'same.md':text});
  try{
    const r=await engine.search(search('REQ-TST-10'));
    assert.equal(r.status,'ok');
    assert.equal(r.hits.length,2);
    assert.deepEqual(r.hits.map(h=>h.sourceLocators[0]!.lineStart),[2,3]);
    const generation=(engine.status().generationId);
    assert.ok(generation);
    assert.equal(new Set(r.hits.map(h=>h.sourceLocators[0]!.blockOrder)).size,2);
  }finally{await cleanup();}
});

test('bounded per-source metadata/blocks reject pathological Markdown without execution',()=>{
  const rootId=hash('synthetic-root');
  const tooManyLines='\n'.repeat(BOUNDS.blocksPerSource+1);
  assert.throws(()=>parseMarkdown('long.md',Buffer.from(tooManyLines),rootId),error('SOURCE_LIMIT'));
  const tooManyLinks='[[a]] '.repeat(BOUNDS.wikiLinksPerBlock+1);
  assert.throws(()=>parseMarkdown('links.md',Buffer.from(tooManyLinks),rootId),error('SOURCE_LIMIT'));
  const front=['---',...Array.from({length:BOUNDS.propertiesPerSource+1},(_,i)=>'a'+i+': '+i),'---','# safe'];
  const source=parseMarkdown('many.md',Buffer.from(front.join('\n')),rootId);
  assert.equal(source.extractionStatus,'partial');
  assert.equal(source.properties.length,0);
});
test('derived cache defaults outside Vault and is bound to Vault identity',async()=>{
  const { root,reader,cleanup }=await setup();
  try{
    const path=privateIndexPath(root,reader.rootId,'oks-synthetic-evidence');
    assert.equal(path.startsWith(root+'/'),false);
    assert.ok(path.includes(reader.rootId));
    assert.throws(()=>privateIndexPath(root,reader.rootId,'../bad'),error('CACHE_PATH_INVALID'));
    assert.throws(()=>privateIndexPath(root,'invalid','oks-synthetic-evidence'),error('CACHE_PATH_INVALID'));
  }finally{await cleanup();}
});
test('event storm is coalesced into bounded full reconciliation',async()=>{
  const {engine,cleanup}=await setup();
  try{
    engine.cancel();
    for(let i=0;i<BOUNDS.sources+200;i++)engine.changed('synthetic-'+i+'.md');
    engine.resume();await engine.whenIdle();
    assert.equal(engine.status().status,'ready');
    assert.equal((await engine.search(search('SSD'))).hits.length,1);
  }finally{await cleanup();}
});

test('missing packaged Web Worker asset fails closed; no inline parser fallback', async()=>{
  assert.throws(()=>new WorkerMarkdownParser(join(process.cwd(),'.test-build','does-not-exist.js'),
    syntheticNodeWorkerPort),error('PARSER_ASSET_INVALID'));
  const {root,reader,store,cleanup}=await setup();
  let fail:()=>void=()=>{};
  const broken:WorkerPort={
    send:()=>fail(),stop:()=>{},onMessage:()=>{},onError:handler=>{fail=handler;},
  };
  const parser=new WorkerMarkdownParser(join(process.cwd(),'.test-build','standalone-worker.js'),
    ()=>broken);
  const engine=new StandaloneEngine(reader,store,parser);
  try {
    await writeFile(join(root,'boreal.md'),FIXTURE.replace('SSD','GPU'));
    await engine.start();await engine.whenIdle();
    assert.equal(engine.status().status,'degraded');
    assert.equal(engine.status().error,'PARSER_FAILURE');
    assert.equal((await engine.search(search('GPU'))).hits.length,0);
  }finally{await engine.close();await cleanup();}
});

test('generation hard quota blocks repeated interrupted commits without source deletion',async()=>{
  const {root,reader,store,cleanup}=await setup();
  const original=await readFile(join(root,'boreal.md'));
  try{
    for(let i=0;i<4;i++)
      await writeFile(join(store.dir,'gen-'+i.toString(16).padStart(64,'0')+'.json'),'derived-orphan');
    await assert.rejects(GenerationStore.open(store.dir,reader.rootId),error('INDEX_LIMIT'));
    assert.deepEqual(await readFile(join(root,'boreal.md')),original);
  }finally{await cleanup();}
});

function asynchronousGate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { entered, held, enter: () => enter(), release: () => release() };
}

test('B4: search pinned to generation A while B publishes across delayed real-file evidence read', async () => {
  const { root, paths, reader, engine, store, cleanup } = await setup({ 'a.md': '# A\nREQ-RACE-11: stable evidence\n' });
  const actualRead = reader.read.bind(reader);
  const gate = asynchronousGate();
  let held = false;
  try {
    const a = engine.status().generationId!;
    reader.read = async path => {
      if (path === 'a.md' && !held) {
        held = true; gate.enter(); await gate.held;
      }
      return actualRead(path);
    };
    const oldSearch = engine.search(search('REQ-RACE-11'));
    await gate.entered;
    await writeFile(join(root, 'b.md'), '# B\nREQ-RACE-12: new evidence\n');
    paths.add('b.md'); engine.changed('b.md'); await engine.whenIdle();
    const b = engine.status().generationId!;
    assert.notEqual(b, a);
    gate.release();
    const result = await oldSearch;
    assert.equal(result.indexGenerationId, a);
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]?.indexGenerationId, a);
    assert.equal(result.hits[0]?.sourceSha256, hash('# A\nREQ-RACE-11: stable evidence\n'));
    assert.equal(result.status, 'degraded'); // Cannot claim A is still the current snapshot.
    const current = await engine.search(search('REQ-RACE-12'));
    assert.equal(current.status, 'ok');
    assert.equal(current.indexGenerationId, b);
    assert.equal(current.hits[0]?.indexGenerationId, b);
    assert.equal((await (await GenerationStore.open(store.dir, reader.rootId)).load()).generation?.generationId, b);
  } finally { gate.release(); await cleanup(); }
});

test('B5: actual CURRENT rename followed by EIO authenticates B, preserves PREVIOUS and permits next commit', async () => {
  const { root, engine, reader, store, cleanup } = await setup();
  const actualRename = fsPromises.rename;
  const a = engine.status().generationId!;
  let injected = false;
  let publication: string | null = null;
  const actualCommit = store.commit.bind(store);
  store.commit = async (...args) => {
    const outcome = await actualCommit(...args);
    publication = outcome.publication;
    return outcome;
  };
  let restarted: StandaloneEngine | null = null;
  try {
    (fsPromises as { rename: typeof actualRename }).rename = async (src, dst) => {
      await actualRename(src, dst);
      if (!injected && String(dst) === join(store.dir, 'CURRENT')) {
        injected = true;
        throw Object.assign(new Error('synthetic post-rename EIO'), { code: 'EIO' });
      }
    };
    await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD','GPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    assert.equal(injected, true);
    assert.equal(publication, 'rename-authenticated-after-error');
    const b = JSON.parse(await readFile(join(store.dir, 'CURRENT'), 'utf8')).generationId as string;
    assert.notEqual(b, a);
    assert.equal(engine.status().generationId, b);
    assert.equal(engine.status().maintenanceWarning, 'INDEX_DURABILITY_UNCERTAIN');
    assert.equal(engine.status().status, 'degraded');
    assert.equal((await engine.search(search('GPU'))).hits[0]?.indexGenerationId, b);
    assert.equal(JSON.parse(await readFile(join(store.dir,'PREVIOUS'),'utf8')).generationId, a);
    assert.equal((await (await GenerationStore.open(store.dir, reader.rootId)).load()).generation?.generationId, b);
    (fsPromises as { rename: typeof actualRename }).rename = actualRename;
    restarted = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await restarted.start(); await restarted.whenIdle();
    assert.equal(restarted.status().generationId, b);
    await restarted.close(); restarted = null;
    await writeFile(join(root,'boreal.md'), FIXTURE.replace('SSD','NPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    assert.equal(engine.status().status, 'ready');
    assert.equal(engine.status().maintenanceWarning, null);
    assert.equal((await engine.search(search('NPU'))).hits.length, 1);
    assert.equal((await (await GenerationStore.open(store.dir, reader.rootId)).load()).generation?.generationId,
      engine.status().generationId);
  } finally {
    (fsPromises as { rename: typeof actualRename }).rename = actualRename;
    await restarted?.close(); await cleanup();
  }
});

for (const action of ['cancel', 'unload'] as const) {
  test(`B5: ${action} after filesystem CURRENT rename but before EIO resolution is deferred and restart-safe`, async () => {
    const { root, engine, reader, store, cleanup } = await setup();
    const actualRename = fsPromises.rename;
    const gate = asynchronousGate();
    const a = engine.status().generationId!;
    let injected = false;
    let restart: StandaloneEngine | null = null;
    try {
      (fsPromises as { rename: typeof actualRename }).rename = async (src, dst) => {
        await actualRename(src, dst);
        if (!injected && String(dst) === join(store.dir, 'CURRENT')) {
          injected = true; gate.enter(); await gate.held;
          throw Object.assign(new Error('synthetic uncertain rename EIO'), { code: 'EIO' });
        }
      };
      await writeFile(join(root, 'boreal.md'), FIXTURE.replace('SSD','GPU'));
      engine.changed('boreal.md'); await gate.entered;
      const durableId = JSON.parse(await readFile(join(store.dir,'CURRENT'),'utf8')).generationId as string;
      assert.notEqual(durableId, a);
      let closing: Promise<void> | null = null;
      if (action === 'cancel') assert.equal(engine.cancel(), false);
      else closing = engine.close();
      gate.release();
      if (closing) await closing;
      else await engine.whenIdle();
      assert.equal(engine.status().generationId, durableId);
      assert.equal(engine.status().maintenanceWarning, 'INDEX_DURABILITY_UNCERTAIN');
      if (action === 'cancel') assert.equal(engine.status().error, 'CANCEL_DEFERRED');
      assert.equal(JSON.parse(await readFile(join(store.dir,'PREVIOUS'),'utf8')).generationId, a);
      (fsPromises as { rename: typeof actualRename }).rename = actualRename;
      restart = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
      await restart.start(); await restart.whenIdle();
      assert.equal(restart.status().generationId, durableId);
      assert.equal((await restart.search(search('GPU'))).hits.length, 1);
    } finally {
      gate.release(); (fsPromises as { rename: typeof actualRename }).rename = actualRename;
      await restart?.close(); await cleanup();
    }
  });
}

test('B5: unidentifiable CURRENT after ambiguous rename fails closed, PREVIOUS recovers on restart', async () => {
  const { root, engine, reader, store, cleanup } = await setup();
  const actualRename = fsPromises.rename;
  const a = engine.status().generationId!;
  let injected = false;
  let restart: StandaloneEngine | null = null;
  try {
    (fsPromises as { rename: typeof actualRename }).rename = async (src, dst) => {
      await actualRename(src, dst);
      if (!injected && String(dst) === join(store.dir,'CURRENT')) {
        injected = true;
        await writeFile(String(dst), '{ambiguous-corruption');
        throw Object.assign(new Error('synthetic uncertain outcome'), { code: 'EIO' });
      }
    };
    await writeFile(join(root,'boreal.md'), FIXTURE.replace('SSD','GPU'));
    engine.changed('boreal.md'); await engine.whenIdle();
    assert.equal(injected, true);
    assert.equal(engine.status().status, 'failed');
    assert.equal(engine.status().generationId, null);
    assert.equal(engine.status().error, 'INDEX_PUBLICATION_UNCERTAIN');
    assert.deepEqual((await engine.search(search('SSD'))).hits, []);
    await assert.rejects(store.commit(makeGeneration(reader.rootId, [])), error('INDEX_PUBLICATION_UNCERTAIN'));
    assert.equal(JSON.parse(await readFile(join(store.dir,'PREVIOUS'),'utf8')).generationId, a);
    (fsPromises as { rename: typeof actualRename }).rename = actualRename;
    restart = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await restart.start();
    assert.equal(restart.status().generationId, a); // authenticated rollback snapshot
    await restart.whenIdle(); // repairs CURRENT from sources
    assert.equal(restart.status().status, 'ready');
    assert.equal((await restart.search(search('GPU'))).hits.length, 1);
  } finally {
    (fsPromises as { rename: typeof actualRename }).rename = actualRename;
    await restart?.close(); await cleanup();
  }
});

test('B6: missed create and missed modify with entirely new terms are diagnosed before false OK', async () => {
  const { root, paths, engine, cleanup } = await setup({ 'a.md': '# A\nREQ-BASE-01: base\n' });
  try {
    await writeFile(join(root,'b.md'),'# B\nREQ-NEW-42: created without event\n');
    paths.add('b.md');
    const missedCreate = await engine.search(search('REQ-NEW-42'));
    assert.equal(missedCreate.status, 'degraded');
    assert.equal(missedCreate.error, 'RECONCILING');
    assert.equal(missedCreate.hits.length, 0);
    await engine.whenIdle();
    assert.equal(engine.status().status, 'ready');
    assert.equal((await engine.search(search('REQ-NEW-42'))).hits.length, 1);
    await writeFile(join(root,'a.md'),'# A\nREQ-EDIT-99: changed without event\n');
    const missedEdit = await engine.search(search('REQ-EDIT-99'));
    assert.equal(missedEdit.status, 'degraded');
    assert.equal(missedEdit.hits.length, 0);
    await engine.whenIdle();
    assert.equal(engine.status().status, 'ready');
    assert.equal((await engine.search(search('REQ-EDIT-99'))).hits.length, 1);
    assert.equal((await engine.search(search('REQ-BASE-01'))).hits.length, 0);
  } finally { await cleanup(); }
});

test('B6: missed rename/delete update authoritative path set and restore ready on reconciliation', async () => {
  const { root, paths, engine, cleanup } = await setup({ 'a.md':'REQ-MOVE-34: source\n' });
  try {
    await rename(join(root,'a.md'),join(root,'moved.md'));
    paths.delete('a.md'); paths.add('moved.md');
    const before = await engine.search(search('REQ-MOVE-34'));
    assert.equal(before.status,'degraded');
    assert.equal(before.hits.length,0);
    await engine.whenIdle();
    assert.equal((await engine.search(search('REQ-MOVE-34'))).hits[0]?.sourceId,'moved.md');
    await rm(join(root,'moved.md')); paths.delete('moved.md');
    const deleted = await engine.search(search('REQ-MOVE-34'));
    assert.equal(deleted.status,'degraded');
    assert.equal(deleted.hits.length,0);
    await engine.whenIdle();
    assert.equal(engine.status().status,'ready');
    assert.equal(engine.status().sources,0);
    assert.equal((await engine.search(search('REQ-MOVE-34'))).hits.length,0);
  } finally { await cleanup(); }
});

test('B6: restart reconciles event loss, no full content read for ordinary stable negative queries', async () => {
  const { root, paths, engine, reader, store, cleanup } = await setup({ 'a.md':'REQ-ONE-11: initial\n' });
  let restarted: StandaloneEngine | null = null;
  const actualRead = reader.read.bind(reader);
  try {
    await writeFile(join(root,'b.md'),'REQ-TWO-12: missed\n'); paths.add('b.md');
    restarted = newEngine(reader, await GenerationStore.open(store.dir,reader.rootId));
    await restarted.start(); await restarted.whenIdle();
    assert.equal(restarted.status().sources,2);
    assert.equal(restarted.status().status,'ready');
    let reads = 0;
    reader.read = async path => { reads++; return actualRead(path); };
    const absent = await restarted.search(search('NONEXISTENT-ABC-999'));
    assert.equal(absent.status,'ok');
    assert.equal(absent.hits.length,0);
    assert.equal(reads,0); // Only capped lstat hint verification, not content reads.
  } finally { reader.read = actualRead; await restarted?.close(); await cleanup(); }
});

for (const action of ['cancel', 'unload'] as const) {
  test(`B6: missed-event reconciliation ${action} before publication retains previous CURRENT`, async () => {
    const { root, reader, engine, store, cleanup } = await setup({ 'a.md':'REQ-CANCEL-11: old\n' });
    const realRead = reader.read.bind(reader);
    const gate = asynchronousGate();
    let hold = false;
    try {
      const a = engine.status().generationId!;
      await writeFile(join(root,'a.md'),'REQ-CANCEL-22: new\n'); // No event.
      reader.read = async path => {
        if (!hold && path === 'a.md') { hold = true; gate.enter(); await gate.held; }
        return realRead(path);
      };
      const found = await engine.search(search('REQ-CANCEL-22'));
      assert.equal(found.status,'degraded');
      await gate.entered;
      let closing: Promise<void> | null = null;
      if (action === 'cancel') assert.equal(engine.cancel(),true);
      else closing = engine.close();
      gate.release();
      if (closing) await closing;
      else await engine.whenIdle();
      assert.equal((await (await GenerationStore.open(store.dir,reader.rootId)).load()).generation?.generationId,a);
      assert.equal(engine.status().generationId,a);
      if (action === 'cancel') {
        reader.read = realRead;
        engine.resume(); await engine.whenIdle();
        assert.equal(engine.status().status,'ready');
        assert.equal((await engine.search(search('REQ-CANCEL-22'))).hits.length,1);
      }
    } finally { gate.release(); reader.read = realRead; await cleanup(); }
  });
}

test('B6: query-driven 30s content audit repairs metadata-invisible edits without an unbounded timer', async () => {
  const { root, reader, store, cleanup } = await setup({ 'a.md':'REQ-OLD-88: original\n' });
  let clock = 1_000_000;
  const engine = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId), undefined, () => clock);
  const realHints = reader.versionHints.bind(reader);
  try {
    await engine.start(); await engine.whenIdle();
    const baseline = await realHints(['a.md']);
    await writeFile(join(root,'a.md'),'REQ-NEW-99: updated!\n');
    // Simulate an indistinguishable metadata snapshot, not merely a lost event.
    reader.versionHints = async () => baseline;
    assert.equal((await engine.search(search('REQ-NEW-99'))).hits.length, 0);
    assert.equal(engine.status().busy, false); // No background polling when idle.
    clock += 30_001;
    const pending = await engine.search(search('REQ-NEW-99'));
    assert.equal(pending.status,'degraded');
    assert.equal(pending.error,'RECONCILING');
    await engine.whenIdle();
    assert.equal(engine.status().status,'ready');
    assert.equal((await engine.search(search('REQ-NEW-99'))).hits.length,1);
  } finally { reader.versionHints = realHints; await engine.close(); await cleanup(); }
});


test('B6: concurrent query storm does not repeatedly invalidate an already running reconciliation', async () => {
  const { root, reader, engine, cleanup } = await setup({ 'a.md':'REQ-STORM-11: old\n' });
  const actualRead = reader.read.bind(reader);
  const gate = asynchronousGate();
  let blocked = false;
  try {
    await writeFile(join(root, 'a.md'), 'REQ-STORM-22: new\n');
    reader.read = async path => {
      if (!blocked && path === 'a.md') {
        blocked = true; gate.enter(); await gate.held;
      }
      return actualRead(path);
    };
    const first = await engine.search(search('REQ-STORM-22'));
    assert.equal(first.status, 'degraded');
    await gate.entered;
    const concurrent = await Promise.all(Array.from({length: 30}, () => engine.search(search('REQ-STORM-22'))));
    assert.ok(concurrent.every(result => result.status === 'degraded'));
    gate.release();
    await engine.whenIdle();
    assert.equal(engine.status().status,'ready');
    assert.equal((await engine.search(search('REQ-STORM-22'))).hits.length,1);
  } finally { gate.release(); reader.read = actualRead; await cleanup(); }
});

test('B7: search A fails closed after unauthenticated CURRENT publication B during gated source read', async () => {
  const { root, paths, reader, store, engine, cleanup } = await setup({
    'a.md': '# A\nREQ-B7-441: stable original evidence\n',
  });
  const realRead = reader.read.bind(reader);
  const realRename = fsPromises.rename;
  const gate = asynchronousGate();
  let held = false, injected = false;
  let restarted: StandaloneEngine | null = null;
  try {
    const a = engine.status().generationId!;
    reader.read = async path => {
      if (path === 'a.md' && !held) {
        held = true; gate.enter(); await gate.held;
      }
      return realRead(path);
    };
    const pendingSearch = engine.search(search('REQ-B7-441'));
    await gate.entered;
    (fsPromises as { rename: typeof realRename }).rename = async (src, dst) => {
      await realRename(src, dst);
      if (!injected && String(dst) === join(store.dir, 'CURRENT')) {
        injected = true;
        await writeFile(String(dst), '{not-authenticated');
        throw Object.assign(new Error('EIO after physical rename'), { code: 'EIO' });
      }
    };
    await writeFile(join(root, 'b.md'), '# B\nREQ-B7-442: new evidence\n');
    paths.add('b.md'); engine.changed('b.md'); await engine.whenIdle();
    assert.equal(injected, true);
    assert.equal(engine.status().error, 'INDEX_PUBLICATION_UNCERTAIN');
    assert.equal(engine.status().generationId, null);
    gate.release();
    const result = await pendingSearch;
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'INDEX_PUBLICATION_UNCERTAIN');
    assert.equal(result.indexGenerationId, null);
    assert.equal(result.capabilityReadiness.lexical, 'unavailable');
    assert.equal(result.executedMode, 'none');
    assert.deepEqual(result.hits, []);
    assert.equal((await engine.search(search('REQ-B7-441'))).hits.length, 0);
    (fsPromises as { rename: typeof realRename }).rename = realRename;
    restarted = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await restarted.start();
    assert.equal(restarted.status().generationId, a);
    await restarted.whenIdle();
    assert.equal(restarted.status().status, 'ready');
    assert.equal((await restarted.search(search('REQ-B7-442'))).hits.length, 1);
  } finally {
    gate.release(); reader.read = realRead;
    (fsPromises as { rename: typeof realRename }).rename = realRename;
    await restarted?.close(); await cleanup();
  }
});

test('B7: in-flight evidence search cannot return hits after unload', async () => {
  const { reader, engine, cleanup } = await setup({ 'a.md': 'REQ-B7-UNLOAD-11: original\n' });
  const actualRead = reader.read.bind(reader);
  const gate = asynchronousGate();
  let held = false;
  try {
    reader.read = async path => {
      if (path === 'a.md' && !held) {
        held = true; gate.enter(); await gate.held;
      }
      return actualRead(path);
    };
    const searchInFlight = engine.search(search('REQ-B7-UNLOAD-11'));
    await gate.entered;
    await engine.close();
    gate.release();
    const result = await searchInFlight;
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'LIFECYCLE_INVALID');
    assert.equal(result.indexGenerationId, null);
    assert.deepEqual(result.hits, []);
  } finally {
    gate.release(); reader.read = actualRead; await cleanup();
  }
});

test('B8: rejected CURRENT C preserves PREVIOUS=A, and B corruption recovers A', async () => {
  const { root, reader, store, engine, cleanup } = await setup({
    'a.md': 'REQ-B8-A: original A\n',
  });
  const realRename = fsPromises.rename;
  let restarted: StandaloneEngine | null = null;
  let injected = false;
  try {
    const a = engine.status().generationId!;
    await writeFile(join(root, 'a.md'), 'REQ-B8-B: committed B\n');
    engine.changed('a.md'); await engine.whenIdle();
    const b = engine.status().generationId!;
    assert.notEqual(b, a);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8')).generationId, a);
    (fsPromises as { rename: typeof realRename }).rename = async (src, dst) => {
      if (String(dst) === join(store.dir, 'CURRENT')) {
        injected = true;
        throw Object.assign(new Error('rename rejected before filesystem mutation'), { code: 'EACCES' });
      }
      return realRename(src, dst);
    };
    await writeFile(join(root, 'a.md'), 'REQ-B8-C: rejected C\n');
    engine.changed('a.md'); await engine.whenIdle();
    assert.equal(injected, true);
    assert.equal(engine.status().generationId, b);
    assert.equal(engine.status().status, 'degraded');
    assert.equal(JSON.parse(await readFile(join(store.dir, 'CURRENT'), 'utf8')).generationId, b);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8')).generationId, a);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'INFLIGHT_PREVIOUS'), 'utf8')).generationId, b);
    (fsPromises as { rename: typeof realRename }).rename = realRename;
    await writeFile(join(store.dir, 'gen-' + b + '.json'), '{damaged-generation');
    const recovery = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.error, 'INDEX_CORRUPT');
    assert.equal(recovery.generation?.generationId, a);
    // The fallback must be usable by a real restarted engine: a stale
    // in-flight pointer to damaged B must not prevent repairing CURRENT=A.
    await writeFile(join(root, 'a.md'), 'REQ-B8-A: original A\n');
    await engine.close();
    restarted = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await restarted.start(); await restarted.whenIdle();
    assert.equal(restarted.status().status, 'ready');
    assert.equal(restarted.status().generationId, a);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'CURRENT'), 'utf8')).generationId, a);
    assert.equal((await restarted.search(search('REQ-B8-A'))).hits.length, 1);
  } finally {
    (fsPromises as { rename: typeof realRename }).rename = realRename;
    await restarted?.close(); await cleanup();
  }
});

test('B8: malformed stale INFLIGHT pointer cannot destroy authenticated PREVIOUS', async () => {
  const { root, store, engine, cleanup } = await setup({ 'a.md': 'REQ-B8-OLD: original A\n' });
  try {
    await writeFile(join(root, 'a.md'), 'REQ-B8-MIDDLE: committed B\n');
    engine.changed('a.md'); await engine.whenIdle();
    const b = engine.status().generationId!;
    const a = JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8')).generationId;
    await writeFile(join(store.dir, 'INFLIGHT_PREVIOUS'), '{malformed-inflight');
    await writeFile(join(root, 'a.md'), 'REQ-B8-NEW: committed C\n');
    engine.changed('a.md'); await engine.whenIdle();
    assert.equal(engine.status().status, 'ready');
    assert.notEqual(engine.status().generationId, b);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8')).generationId, b);
    assert.notEqual(b, a);
    assert.equal((await engine.search(search('REQ-B8-NEW'))).hits.length, 1);
  } finally { await cleanup(); }
});

test('B8: cancel before CURRENT rename keeps PREVIOUS=A despite durable in-flight B', async () => {
  const { root, store, engine, cleanup } = await setup({ 'a.md': 'REQ-B8-A: baseline\n' });
  const realRename = fsPromises.rename;
  const gate = asynchronousGate();
  let held = false;
  try {
    const a = engine.status().generationId!;
    await writeFile(join(root, 'a.md'), 'REQ-B8-B: committed\n');
    engine.changed('a.md'); await engine.whenIdle();
    const b = engine.status().generationId!;
    (fsPromises as { rename: typeof realRename }).rename = async (src, dst) => {
      await realRename(src, dst);
      if (!held && String(dst) === join(store.dir, 'INFLIGHT_PREVIOUS')) {
        held = true; gate.enter(); await gate.held;
      }
    };
    await writeFile(join(root, 'a.md'), 'REQ-B8-C: canceled\n');
    engine.changed('a.md'); await gate.entered;
    assert.equal(engine.cancel(), true);
    gate.release(); await engine.whenIdle();
    assert.equal(engine.status().generationId, b);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'CURRENT'), 'utf8')).generationId, b);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8')).generationId, a);
  } finally {
    gate.release(); (fsPromises as { rename: typeof realRename }).rename = realRename;
    await cleanup();
  }
});

test('B8: crash after CURRENT but before PREVIOUS finalization recovers from INFLIGHT_PREVIOUS', async () => {
  const { root, reader, store, engine, cleanup } = await setup({ 'a.md': 'REQ-B8-A: original\n' });
  const realRename = fsPromises.rename;
  let injected = false;
  try {
    const a = engine.status().generationId!;
    await writeFile(join(root, 'a.md'), 'REQ-B8-B: committed\n');
    engine.changed('a.md'); await engine.whenIdle();
    const b = engine.status().generationId!;
    (fsPromises as { rename: typeof realRename }).rename = async (src, dst) => {
      if (!injected && String(dst) === join(store.dir, 'PREVIOUS')) {
        injected = true;
        throw Object.assign(new Error('PREVIOUS publication EACCES'), { code: 'EACCES' });
      }
      return realRename(src, dst);
    };
    await writeFile(join(root, 'a.md'), 'REQ-B8-C: committed but rollback update failed\n');
    engine.changed('a.md'); await engine.whenIdle();
    const c = engine.status().generationId!;
    assert.equal(injected, true);
    assert.notEqual(c, b);
    assert.equal(engine.status().maintenanceWarning, 'INDEX_DURABILITY_UNCERTAIN');
    assert.equal(JSON.parse(await readFile(join(store.dir, 'CURRENT'), 'utf8')).generationId, c);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8')).generationId, a);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'INFLIGHT_PREVIOUS'), 'utf8')).generationId, b);
    (fsPromises as { rename: typeof realRename }).rename = realRename;
    await writeFile(join(store.dir, 'gen-' + c + '.json'), '{corrupt-current-generation');
    const recovered = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.generation?.generationId, b);
  } finally {
    (fsPromises as { rename: typeof realRename }).rename = realRename;
    await cleanup();
  }
});

test('B8: next failed publication repairs an older pending rollback before replacing in-flight slot', async () => {
  const { root, reader, store, engine, cleanup } = await setup({ 'a.md': 'REQ-B8-A: original\n' });
  const realRename = fsPromises.rename;
  let injectedPrev = false, injectedCurrent = false;
  try {
    const a = engine.status().generationId!;
    await writeFile(join(root, 'a.md'), 'REQ-B8-B: committed\n');
    engine.changed('a.md'); await engine.whenIdle();
    const b = engine.status().generationId!;
    (fsPromises as { rename: typeof realRename }).rename = async (src, dst) => {
      if (!injectedPrev && String(dst) === join(store.dir, 'PREVIOUS')) {
        injectedPrev = true;
        throw Object.assign(new Error('PREVIOUS finalize EACCES'), { code: 'EACCES' });
      }
      return realRename(src, dst);
    };
    await writeFile(join(root, 'a.md'), 'REQ-B8-C: published\n');
    engine.changed('a.md'); await engine.whenIdle();
    const c = engine.status().generationId!;
    assert.equal(injectedPrev, true);
    assert.equal(engine.status().maintenanceWarning, 'INDEX_DURABILITY_UNCERTAIN');
    assert.equal(JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8')).generationId, a);
    (fsPromises as { rename: typeof realRename }).rename = async (src, dst) => {
      if (!injectedCurrent && String(dst) === join(store.dir, 'CURRENT')) {
        injectedCurrent = true;
        throw Object.assign(new Error('next CURRENT rename EACCES'), { code: 'EACCES' });
      }
      return realRename(src, dst);
    };
    await writeFile(join(root, 'a.md'), 'REQ-B8-D: rejected\n');
    engine.changed('a.md'); await engine.whenIdle();
    assert.equal(injectedCurrent, true);
    assert.equal(engine.status().generationId, c);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8')).generationId, b);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'INFLIGHT_PREVIOUS'), 'utf8')).generationId, c);
    (fsPromises as { rename: typeof realRename }).rename = realRename;
    await writeFile(join(store.dir, 'gen-' + c + '.json'), '{corrupted-current');
    const recovered = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.generation?.generationId, b);
  } finally {
    (fsPromises as { rename: typeof realRename }).rename = realRename;
    await cleanup();
  }
});

test('B8: repairing a corrupted CURRENT from INFLIGHT at unchanged B must retain older A rollback', async () => {
  const original = 'REQ-B8-A: oldest\n';
  const committed = 'REQ-B8-B: published\n';
  const { root, reader, store, engine, cleanup } = await setup({ 'a.md': original });
  const renameActual = fsPromises.rename;
  let reopened: StandaloneEngine | null = null;
  try {
    const a = engine.status().generationId!;
    await writeFile(join(root, 'a.md'), committed);
    engine.changed('a.md'); await engine.whenIdle();
    const b = engine.status().generationId!;
    assert.notEqual(a, b);
    (fsPromises as { rename: typeof renameActual }).rename = async (src, dst) => {
      if (String(dst) === join(store.dir, 'CURRENT'))
        throw Object.assign(new Error('synthetic rejected C'), { code: 'EACCES' });
      return renameActual(src, dst);
    };
    await writeFile(join(root, 'a.md'), 'REQ-B8-C: rejected\n');
    engine.changed('a.md'); await engine.whenIdle();
    (fsPromises as { rename: typeof renameActual }).rename = renameActual;
    await writeFile(join(root, 'a.md'), committed); // B source remains authoritative after rejected C.
    await engine.close();
    await writeFile(join(store.dir, 'CURRENT'), '{broken-pointer');
    reopened = newEngine(reader, await GenerationStore.open(store.dir, reader.rootId));
    await reopened.start();
    assert.equal(reopened.status().generationId, b);
    await reopened.whenIdle(); // Repair identical B generation pointer; not a logical new publication.
    assert.equal(reopened.status().status, 'ready');
    assert.equal(JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8')).generationId, a);
    await writeFile(join(store.dir, 'gen-' + b + '.json'), '{damaged-b');
    const rollback = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(rollback.recovered, true);
    assert.equal(rollback.generation?.generationId, a);
  } finally {
    (fsPromises as { rename: typeof renameActual }).rename = renameActual;
    await reopened?.close(); await cleanup();
  }
});

test('B8: corrupt predecessor generation before C must not erase the last valid PREVIOUS=A', async () => {
  const { root, reader, store, engine, cleanup } = await setup({ 'a.md': 'REQ-OLD-A: original\n' });
  try {
    const a = engine.status().generationId!;
    await writeFile(join(root, 'a.md'), 'REQ-NEW-B: version B\n');
    engine.changed('a.md'); await engine.whenIdle();
    const b = engine.status().generationId!;
    assert.notEqual(a, b);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8')).generationId, a);
    await writeFile(join(store.dir, 'gen-' + b + '.json'), '{damaged-generation');
    await writeFile(join(root, 'a.md'), 'REQ-NEW-C: version C\n');
    engine.changed('a.md'); await engine.whenIdle();
    assert.equal(engine.status().status, 'degraded');
    assert.equal(engine.status().generationId, b);
    assert.equal(engine.status().error, 'INDEX_CORRUPT');
    assert.equal(JSON.parse(await readFile(join(store.dir, 'PREVIOUS'), 'utf8')).generationId, a);
    assert.equal(JSON.parse(await readFile(join(store.dir, 'CURRENT'), 'utf8')).generationId, b);
    const reopened = await (await GenerationStore.open(store.dir, reader.rootId)).load();
    assert.equal(reopened.recovered, true);
    assert.equal(reopened.generation?.generationId, a);
  } finally { await cleanup(); }
});
