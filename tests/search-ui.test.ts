import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchController, StandaloneApi, propertyInput, uiRequest } from '../plugin/src/search/controller';
import { defaultSettings, parseSettings } from '../plugin/src/search/settings';
import { diagnostics, statusSnapshot } from '../plugin/src/search/status';
import { SourceNavigator, verifySpan, type Position } from '../plugin/src/search/navigation';
import { textElement } from '../plugin/src/search/render';
import { BoundedVaultReader } from '../plugin/src/standalone/source';
import { parseMarkdown } from '../plugin/src/standalone/markdown';
import { hash, type EvidenceHit, type SearchResponse } from '../plugin/src/standalone/contracts';
import type { EngineState } from '../plugin/src/standalone/engine';

const RAW = '# Привет 🚀\r\nREQ-UI-42: café 😀 <img src=x onerror=alert(1)>\r\n';
function hit(raw = RAW, path = 'Заметка.MD'): EvidenceHit {
  const doc = parseMarkdown(path, Buffer.from(raw), hash('synthetic-root'));
  const block = doc.blocks[1]!;
  return { sourceId: path, sourceSha256: doc.sha256, originalExcerpt: block.originalText,
    sourceLocators: [block.locator], rank: 1, lexicalRank: 1, retrievalMode: 'lexical',
    indexGenerationId: hash('generation'), score: 1, headings: [], wikiLinks: [], properties: [] };
}
const state = (): EngineState => ({ status: 'ready', generationId: hash('generation'), sources: 1,
  records: 2, busy: false, error: null, maintenanceWarning: null });
const response = (): SearchResponse => ({ protocolVersion: 2, requestId: 'ui', requestedMode: 'lexical',
  executedMode: 'lexical', status: 'ok', indexGenerationId: hash('generation'), hits: [hit()],
  capabilityReadiness: { lexical: 'ready', dense: 'unavailable' }, error: null, staleSourceCount: 0 });
function engine(search: () => Promise<SearchResponse> = async () => response()) {
  return { search, status: state, cancel: () => true, resume: () => {}, rebuild: () => {} };
}
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

test('settings strictly migrate v1 probe fields; unknown versions/keys/types fail closed', () => {
  assert.deepEqual(parseSettings(null), defaultSettings());
  for (const version of [undefined, 1]) {
    const migrated = parseSettings({ version, fixtureMode: true, interpreter: '/synthetic/python', entry: '/synthetic/probe.py' });
    assert.equal(migrated.version, 4); assert.equal(migrated.probe.fixtureMode, true);
    assert.equal(migrated.advanced.enabled, false);
  }
  for (const v of [{}, { version: 9 }, { ...defaultSettings(), enabled: 'true' },
    { ...defaultSettings(), topK: 51 }, { ...defaultSettings(), topK: 1.5 },
    { ...defaultSettings(), unknown: 'secret' }, { ...defaultSettings(), advanced: { enabled: true, profile: 'local-stdio', interpreter: '', entry: '' } },
    { ...defaultSettings(), advanced: { enabled: false, profile: 'https://example.invalid' } },
    { ...defaultSettings(), probe: { fixtureMode: false, interpreter: '\0', entry: '' } }]) assert.throws(() => parseSettings(v));
  const original = defaultSettings(), copy = parseSettings(original); copy.probe.entry = 'changed';
  assert.equal(original.probe.entry, '');
});
test('typed filters never coerce scalars; JSON lists, dates, null and bounds validated', () => {
  assert.equal(propertyInput('id','string','eq','1').value, '1');
  assert.equal(propertyInput('id','number','eq','1').value, 1);
  assert.equal(propertyInput('flag','boolean','eq','true').value, true);
  assert.equal(propertyInput('x','null','eq','null').value, null);
  assert.deepEqual(propertyInput('tags','list','eq','["1",1,true,null]').value, ['1',1,true,null]);
  assert.equal(propertyInput('tags','list','contains','"1"').value, '1');
  for (const args of [['x','number','eq','"1"'], ['x','boolean','eq','1'], ['x','date','eq','2026-02-30'],
    ['x','null','eq','"null"'], ['x','list','contains','{}'], ['x','string','contains','a'], ['','string','eq','a']])
    assert.throws(() => propertyInput(...args as [string,string,string,string]));
  assert.throws(() => propertyInput('x','string','eq','a'.repeat(4097)));
  assert.throws(() => uiRequest('😀'.repeat(129), 1));
  assert.throws(() => uiRequest('x', 51)); assert.throws(() => uiRequest(' ', 1));
  assert.equal(uiRequest('Привет REQ-UI-42', 50).query, 'Привет REQ-UI-42');
});
test('API v1 rejects malformed envelope, unknown versions and predicates; reports readiness truthfully', async () => {
  const controller = new SearchController(async () => {}), api = new StandaloneApi(controller);
  for (const input of [null, [], {}, { apiVersion: 0, operation: 'status' },
    { apiVersion: 2, operation: 'status' }, { apiVersion: 1, operation: 'status', extra: 1 },
    { apiVersion: 1, operation: 'search' }, { apiVersion: 1, operation: 'open' },
    { apiVersion: 1, operation: 'search', request: { ...uiRequest('x',1), protocolVersion: 1 } },
    { apiVersion: 1, operation: 'search', request: { ...uiRequest('x',1), predicates: [{ ...propertyInput('id','number','eq','1'), unknown: true }] } }]) {
    const result = await api.request(input); assert.equal(result.ok, false);
  }
  assert.deepEqual(await api.request({ apiVersion: 2, operation: 'status' }), { apiVersion: 1, ok: false, error: 'API_VERSION_UNSUPPORTED' });
  assert.equal((await api.request({ apiVersion: 1, operation: 'search', request: uiRequest('x',1) })).ok, false);
  controller.attach(engine());
  const result = await api.request({ apiVersion: 1, operation: 'status' });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual((result.value as ReturnType<typeof controller.status>).capabilityReadiness,
    { lexical: 'ready', dense: 'unavailable', hybrid: 'unavailable' });
  assert.equal((await api.request({ apiVersion: 1, operation: 'search', request: uiRequest('x',1) })).ok, true);
  controller.dispose(); assert.equal((await controller.search(uiRequest('x',1))).ok, false);
});
test('latest query replaces queued queries; no stale async response painting and single active call', async () => {
  const first = deferred<SearchResponse>(); let calls = 0;
  const controller = new SearchController(async () => {});
  controller.attach(engine(async () => ++calls === 1 ? first.promise : response()));
  const a = controller.search(uiRequest('first',1));
  const b = controller.search(uiRequest('second',1));
  const c = controller.search(uiRequest('third',1));
  assert.deepEqual(await b, { apiVersion: 1, ok: false, error: 'SUPERSEDED' });
  assert.equal(calls, 1); first.resolve(response());
  assert.equal((await a).ok, false); assert.equal((await c).ok, true); assert.equal(calls, 2);
  assert.equal(controller.snapshot().phase, 'results');
});
test('source event, cancellation, disabling and disposal revoke in-flight evidence; subscriptions clean up', async () => {
  for (const action of ['invalidate','cancel','disable','dispose'] as const) {
    const wait = deferred<SearchResponse>(); let renders = 0;
    const c = new SearchController(async () => {}); c.attach(engine(() => wait.promise));
    const unsubscribe = c.subscribe(() => { renders++; });
    const pending = c.search(uiRequest('x',1));
    if (action === 'cancel') c.control('cancel');
    else if (action === 'disable') c.configure(false, false);
    else c[action]();
    wait.resolve(response()); assert.equal((await pending).ok, false);
    assert.equal(c.snapshot().response, null); unsubscribe(); const count = renders;
    c.invalidate(); assert.equal(renders, count); c.dispose(); c.dispose();
  }
});
test('controller navigation refuses detached stale result buttons and reports failure without raw error', async () => {
  const c = new SearchController(async () => { throw new Error('/private/content'); }); c.attach(engine());
  await c.search(uiRequest('x',1)); const old = hit(); old.sourceSha256 = hash('stale');
  assert.equal((await c.open(0, old)).ok, false);
  assert.equal((await c.open(0)).ok, false); assert.equal(c.snapshot().message, 'NAVIGATION_REJECTED');
  assert.equal(c.snapshot().response, null);
});
test('controller fault and cancel-deferred paths remain explicit', async () => {
  const c = new SearchController(async () => {});
  c.attach({ ...engine(async () => { throw new Error('secret'); }), cancel: () => false });
  assert.deepEqual(await c.search(uiRequest('x',1)), { apiVersion: 1, ok: false, error: 'INTERNAL_FAILURE' });
  const result = c.control('pause'); assert.deepEqual(result, { apiVersion: 1, ok: true, value: { cancelled: false } });
  assert.equal(c.status().paused, true); c.control('resume'); assert.equal(c.status().paused, false);
  c.control('rebuild'); assert.equal(c.snapshot().response, null);
});
test('diagnostics reconstruct allowlisted metadata and reject injected source/path/error/properties', () => {
  const source = { ...state(), error: '/private/secret.md', maintenanceWarning: 'source text', excerpt: 'secret', properties: ['secret'], path: '/private' };
  const status = statusSnapshot(source, true, false, null);
  const output = diagnostics({ ...status, injected: 'secret' } as typeof status);
  for (const privateValue of ['secret','/private','excerpt','properties','injected','source text']) assert.equal(output.includes(privateValue), false);
  assert.equal(status.error, 'INTERNAL_FAILURE'); assert.equal(status.maintenanceWarning, 'INTERNAL_FAILURE');
  assert.equal(JSON.parse(output).generationId, hash('generation'));
});
test('text rendering uses textContent only for malicious HTML and Markdown', () => {
  const events: string[] = [];
  const document = { createElement(tag: string) { events.push(tag); return {
    set textContent(v: string) { events.push(v); }, set innerHTML(_v: string) { assert.fail('HTML injection'); },
  }; } } as unknown as Document;
  const value = '<img src=x onerror=alert(1)> [link](javascript:alert(1))';
  textElement(document, 'pre', value); assert.deepEqual(events, ['pre',value]);
});
test('navigation verifies exact raw UTF-8 bytes, codepoints, full physical CRLF line and UTF-16 editor position', () => {
  const evidence = hit(), bytes = Buffer.from(RAW), span = verifySpan(evidence, bytes);
  assert.deepEqual(span.from, { line: 1, ch: 0 }); assert.equal(span.to.ch, evidence.originalExcerpt.length);
  assert.notEqual(span.to.ch, [...evidence.originalExcerpt].length);
  for (const key of ['byteStart','byteEnd','charStart','charEnd','lineStart','lineEnd','blockOrder'] as const) {
    const bad = structuredClone(evidence); bad.sourceLocators[0]![key] = key === 'blockOrder' ? -1 : 999999;
    assert.throws(() => verifySpan(bad, bytes), key);
  }
  for (const path of ['../escape.md','/absolute.md','x/../a.md','x\\a.md','.hidden.md'])
    assert.throws(() => verifySpan({ ...evidence, sourceId: path }, bytes));
  assert.throws(() => verifySpan({ ...evidence, sourceLocators: [] }, bytes));
  assert.throws(() => verifySpan({ ...evidence, sourceSha256: hash('wrong') }, bytes));
  assert.throws(() => verifySpan({ ...evidence, originalExcerpt: 'wrong' }, bytes));
  assert.throws(() => verifySpan(evidence, Buffer.from(RAW.replace('café','edited'))));
});
test('navigation uses real no-follow provider; rejects changed, renamed, deleted, symlink and traversal sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oks-ui-synthetic-'));
  const path = 'Заметка.MD'; const file = { path }; let exists = true; let opened = 0;
  let selected: [Position, Position] | null = null;
  const reader = await BoundedVaultReader.open(root, () => [path]);
  const navigator = new SourceNavigator(reader, {
    exact: p => exists && p === path ? file : null,
    open: async f => { assert.equal(f, file); opened++; return { text: () => RAW.replace(/\r\n/g, '\n'), select: (a,b) => { selected = [a,b]; } }; },
  });
  try {
    await writeFile(join(root,path), RAW); await navigator.open(hit()); assert.equal(opened,1); assert.ok(selected);
    await writeFile(join(root,path), RAW + 'changed'); await assert.rejects(navigator.open(hit())); assert.equal(opened,1);
    await writeFile(join(root,path), RAW); await rename(join(root,path),join(root,'renamed.md'));
    exists = false; await assert.rejects(navigator.open(hit())); assert.equal(opened,1);
    exists = true; await assert.rejects(navigator.open(hit()));
    await symlink(join(root,'renamed.md'),join(root,path)); await assert.rejects(navigator.open(hit()));
    await assert.rejects(navigator.open(hit(RAW,'../escape.md'))); assert.equal(opened,1);
    navigator.dispose(); navigator.dispose(); await assert.rejects(navigator.open(hit()));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('navigation rejects source changes while waiting, replaced TFile identity, dispose and editor mismatch', async () => {
  for (const fault of ['event','identity','bytes','editor','dispose'] as const) {
    const waiting = deferred<Uint8Array>(); const file = {}; let identity = file; let reads = 0; let opened = 0; let selections = 0;
    const nav = new SourceNavigator({ read: async () => ++reads === 1 ? waiting.promise : Buffer.from(fault === 'bytes' ? RAW + 'new' : RAW) }, {
      exact: () => identity,
      open: async () => { opened++; return { text: () => fault === 'editor' ? RAW + 'unsaved' : RAW, select: () => { selections++; } }; },
    });
    const task = nav.open(hit());
    if (fault === 'event') nav.invalidate(); if (fault === 'identity') identity = {};
    if (fault === 'dispose') nav.dispose(); waiting.resolve(Buffer.from(RAW));
    await assert.rejects(task); assert.equal(selections,0); assert.equal(opened, fault === 'editor' ? 1 : 0);
  }
});
test('navigation revalidates bytes after asynchronous open before selecting', async () => {
  const file = {}; let raw = RAW; let selections = 0;
  const nav = new SourceNavigator({ read: async () => Buffer.from(raw) }, {
    exact: () => file, open: async () => { raw += 'changed'; return { text: () => raw, select: () => { selections++; } }; },
  });
  await assert.rejects(nav.open(hit())); assert.equal(selections,0);
});
test('public responses cannot mutate engine generation records or UI snapshots', async () => {
  const original = response();
  const c = new SearchController(async () => {}); c.attach(engine(async () => original));
  const r = await c.search(uiRequest('x',1)); assert.ok(r.ok);
  r.value.hits[0]!.originalExcerpt = 'changed'; r.value.hits[0]!.sourceLocators[0]!.byteStart = 999;
  assert.equal(original.hits[0]!.originalExcerpt, hit().originalExcerpt);
  assert.equal(c.snapshot().response!.hits[0]!.originalExcerpt, hit().originalExcerpt);
  const api = new StandaloneApi(c);
  assert.equal((await api.request({ apiVersion: 1, operation: { toString: () => 'status' } })).ok,false);
});
