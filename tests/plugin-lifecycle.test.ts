import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { DenseUiController } from '../plugin/src/ai/dense-ui-controller';
import type { ApiDenseHost } from '../plugin/src/ai/dense-host';
import type { EmbeddingSpace } from '../plugin/src/ai/contracts';
import type { IngestResponse } from '../plugin/src/advanced/protocol';
import type { ModelReply } from '../plugin/src/advanced/model-protocol';
import { join, resolve } from 'node:path';
import { parseMarkdown } from '../plugin/src/standalone/markdown';
import { SourceNavigator } from '../plugin/src/search/navigation';
import { uiRequest } from '../plugin/src/search/controller';
import { hash, type EvidenceHit, type SearchRequest, type SearchResponse } from '../plugin/src/standalone/contracts';
import type { EngineState } from '../plugin/src/standalone/engine';
import { defaultSettings } from '../plugin/src/search/settings';
const TEST_PYTHON = '/usr/bin/python3.12';
// Controlled Node-only host adapter. Actual DOM/editor acceptance remains host smoke.
const Module = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown };
class HostPlugin {
  app: unknown; manifest = { id: 'oks-synthetic-evidence' }; saved: unknown = null;
  loadData(): Promise<unknown> { return Promise.resolve(this.saved); }
  async saveData(value: unknown): Promise<void> { this.saved = value; }
  registerView(): void {} addCommand(): void {} addSettingTab(): void {} registerEvent(): void {} register(_callback: () => void): void {}
}
class FileSystemAdapter { constructor(private root: string) {} getBasePath(): string { return this.root; } }
class Empty {}
const host = { Plugin: HostPlugin, FileSystemAdapter, ItemView: Empty, Modal: Empty, Notice: Empty,
  PluginSettingTab: Empty, Setting: Empty, TFile: Empty, MarkdownView: Empty };
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'obsidian' ? host : originalLoad.call(this,name,...args); };
// Use source type only: runtime is bundled separately and imports the adapter above.
let PluginClass: typeof import('../plugin/src/main').default;
try { PluginClass = (require(join(process.cwd(), '.test-build/plugin-main.cjs')) as { default: typeof PluginClass }).default; }
finally { Module._load = originalLoad; }
class SyntheticWorker {
  static instances: SyntheticWorker[] = [];
  onmessage?: (event: { data: unknown }) => void; onerror?: () => void; onmessageerror?: () => void;
  terminated = false;
  constructor() { SyntheticWorker.instances.push(this); }
  postMessage(v: { id: number; path: string; bytes: Uint8Array; rootId: string }): void {
    queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: {
      id: v.id, doc: parseMarkdown(v.path, v.bytes, v.rootId),
    } }); });
  }
  terminate(): void { this.terminated = true; }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oks-ui-lifecycle-'));
  const vault = join(root, 'vault'); const assets = join(vault,'.obsidian/plugins/oks-synthetic-evidence');
  await mkdir(assets, { recursive: true });
  await copyFile('.test-build/standalone-worker.js',join(assets,'standalone-worker.js'));
  await writeFile(join(vault,'fixture.md'),'# Synthetic\nREQ-LIFE-1: local only.\n');
  const oldXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root,'data');
  const oldWorker = globalThis.Worker;
  globalThis.Worker = SyntheticWorker as unknown as typeof Worker; SyntheticWorker.instances = [];
  let layout!: () => void;
  const app = { vault: { adapter: new FileSystemAdapter(vault), configDir: '.obsidian',
    getMarkdownFiles: () => [{ path: 'fixture.md' }], on: () => ({}) },
    metadataCache: { on: () => ({}) }, workspace: { onLayoutReady: (fn: () => void) => { layout = fn; }, detachLeavesOfType: () => {} } };
  const plugin = new PluginClass(app as never, { id: 'oks-synthetic-evidence' } as never);
  Object.assign(plugin, { app, manifest: { id: 'oks-synthetic-evidence' } });
  const internal = plugin as unknown as { initializeStandalone(): Promise<void>; initializing?: Promise<void>; settingsQueue: Promise<void> };
  return { root, vault, plugin, internal, layout: () => layout(), cleanup: async () => {
    plugin.onunload(); await internal.initializing; await internal.settingsQueue;
    if (oldXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldXdg;
    globalThis.Worker = oldWorker;
    await rm(root, { recursive: true, force: true });
  } };
}
test('plugin waits for layout; concurrent init shares one worker; disable/re-enable/unload cleanly own workers', async () => {
  const f = await fixture();
  try {
    await f.plugin.onload(); assert.equal(SyntheticWorker.instances.length,0);
    f.layout(); await Promise.all([f.internal.initializeStandalone(),f.internal.initializeStandalone()]);
    await f.plugin.standalone!.whenIdle(); assert.equal(f.plugin.standalone!.status().status,'ready');
    assert.equal(SyntheticWorker.instances.length,1);
    await f.plugin.updateSettings({ ...f.plugin.settings, enabled: false });
    assert.equal(SyntheticWorker.instances[0]!.terminated,true); assert.equal(f.plugin.standalone,undefined);
    assert.equal((await f.plugin.api.request({ apiVersion: 1, operation: 'search', request: {
      protocolVersion: 2, requestId: 'life', query: 'REQ-LIFE-1', requestedMode: 'lexical', limit: 1,
    } })).ok,false);
    await f.plugin.updateSettings({ ...f.plugin.settings, enabled: true }); await f.plugin.standalone!.whenIdle();
    assert.equal(SyntheticWorker.instances.length,2); assert.equal(SyntheticWorker.instances[1]!.terminated,false);
    f.plugin.onunload(); assert.equal(SyntheticWorker.instances[1]!.terminated,true);
    f.plugin.onunload(); f.layout(); assert.equal(SyntheticWorker.instances.length,2);
  } finally { await f.cleanup(); }
});
test('unload during initial asynchronous open never starts an orphan worker', async () => {
  const f = await fixture();
  try {
    await f.plugin.onload(); f.layout(); f.plugin.onunload(); await f.internal.initializing;
    assert.equal(SyntheticWorker.instances.length,0); assert.equal(f.plugin.standalone,undefined);
  } finally { await f.cleanup(); }
});
test('invalid versioned settings refuse indexing; explicitly saved defaults recover', async () => {
  const f = await fixture();
  try {
    Object.assign(f.plugin, { saved: { version: 99, enabled: true } });
    await f.plugin.onload(); f.layout(); await f.internal.initializeStandalone();
    assert.equal(f.plugin.settings.enabled,false); assert.equal(SyntheticWorker.instances.length,0);
    assert.equal(f.plugin.searchController.status().error,'SETTINGS_INVALID');
    assert.equal(f.plugin.standaloneError,'SETTINGS_INVALID');
    await f.plugin.updateSettings(defaultSettings()); await f.plugin.standalone!.whenIdle();
    assert.equal(f.plugin.standalone!.status().status,'ready');
  } finally { await f.cleanup(); }
});
test('missing bundled worker fails closed; unload leaves no live worker', async () => {
  const f = await fixture();
  try {
    await rm(join(f.vault,'.obsidian/plugins/oks-synthetic-evidence/standalone-worker.js'));
    await f.plugin.onload(); f.layout(); await f.internal.initializing;
    assert.equal(f.plugin.standaloneError,'PARSER_ASSET_INVALID'); assert.equal(f.plugin.standalone,undefined);
    assert.equal(SyntheticWorker.instances.length,0);
  } finally { await f.cleanup(); }
});
test('unreadable settings fail closed; repeated onload does not replace the controller or worker', async () => {
  const f = await fixture();
  try {
    Object.assign(f.plugin, { loadData: async () => { throw new Error('private settings path'); } });
    await f.plugin.onload(); f.layout(); await f.internal.initializeStandalone();
    assert.equal(f.plugin.standaloneError,'SETTINGS_INVALID'); assert.equal(SyntheticWorker.instances.length,0);
    await f.plugin.updateSettings(defaultSettings()); await f.plugin.standalone!.whenIdle();
    const engine = f.plugin.standalone; await f.plugin.onload();
    assert.equal(f.plugin.standalone,engine); assert.equal(SyntheticWorker.instances.length,1);
  } finally { await f.cleanup(); }
});
test('saved paused startup reconciles only after explicit resume', async () => {
  const f = await fixture();
  try {
    Object.assign(f.plugin, { saved: { ...defaultSettings(), paused: true } });
    await f.plugin.onload(); f.layout(); await f.internal.initializing; await f.plugin.standalone!.whenIdle();
    assert.equal(f.plugin.searchController.status().paused,true);
    assert.notEqual(f.plugin.standalone!.status().status,'ready');
    await f.plugin.controlSearch('resume'); await f.plugin.standalone!.whenIdle();
    assert.equal(f.plugin.standalone!.status().status,'ready');
  } finally { await f.cleanup(); }
});
test('replacement plugin waits for prior writer shutdown before opening a second worker', async () => {
  const f = await fixture(); let replacement: InstanceType<typeof PluginClass> | undefined;
  let release!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.plugin.onload(); f.layout(); await f.internal.initializing; await f.plugin.standalone!.whenIdle();
    const original = f.plugin.standalone!; const close = original.close.bind(original);
    original.close = async () => { await close(); await stopped; };
    f.plugin.onunload(); assert.equal(SyntheticWorker.instances[0]!.terminated,true);
    replacement = new PluginClass(f.plugin.app, f.plugin.manifest);
    Object.assign(replacement, { app: f.plugin.app, manifest: f.plugin.manifest });
    await replacement.onload(); f.layout();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(SyntheticWorker.instances.length,1);
    release();
    await (replacement as unknown as { initializing: Promise<void> }).initializing;
    await replacement.standalone!.whenIdle();
    assert.equal(SyntheticWorker.instances.length,2); assert.equal(replacement.standalone!.status().status,'ready');
  } finally { release(); replacement?.onunload(); await f.cleanup(); }
});

test('derived purge cannot race the re-enabled writer; original source stays intact', async () => {
  const f = await fixture();
  try {
    await f.plugin.onload(); f.layout(); await f.internal.initializing; await f.plugin.standalone!.whenIdle();
    await f.plugin.updateSettings({ ...f.plugin.settings, enabled: false });
    const cleanup = f.plugin.purgeIndex();
    const restart = f.plugin.updateSettings({ ...f.plugin.settings, enabled: true });
    assert.ok(await cleanup >= 1);
    await restart; await f.plugin.standalone!.whenIdle();
    assert.equal(f.plugin.standalone!.status().status,'ready');
    assert.equal(await readFile(join(f.vault,'fixture.md'),'utf8'), '# Synthetic\nREQ-LIFE-1: local only.\n');
  } finally { await f.cleanup(); }
});

test('B1: queued field edits cannot accidentally re-enable indexing or erase pause', async () => {
  const f = await fixture();
  try {
    await f.plugin.onload(); f.layout(); await f.internal.initializing; await f.plugin.standalone!.whenIdle();
    const original = f.plugin.saveData.bind(f.plugin);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let writes = 0;
    Object.assign(f.plugin, { saveData: async (value: unknown) => {
      if (++writes === 1) await blocked;
      await original(value);
    } });
    const disable = f.plugin.patchSettings(s => { s.enabled = false; });
    const filter = f.plugin.patchSettings(s => { s.propertiesEnabled = true; });
    const pause = f.plugin.patchSettings(s => { s.paused = true; });
    await Promise.resolve(); release();
    await Promise.all([disable, filter, pause]);
    assert.equal(f.plugin.settings.enabled, false);
    assert.equal(f.plugin.settings.propertiesEnabled, true);
    assert.equal(f.plugin.settings.paused, true);
    assert.equal(f.plugin.standalone, undefined);
    assert.equal((f.plugin as unknown as { saved: { enabled: boolean; propertiesEnabled: boolean; paused: boolean } }).saved.enabled, false);
  } finally { await f.cleanup(); }
});

test('B2: cold-disabled reload can purge only derived index without starting a worker', async () => {
  const f = await fixture(); let replacement: InstanceType<typeof PluginClass> | undefined;
  try {
    await f.plugin.onload(); f.layout(); await f.internal.initializing; await f.plugin.standalone!.whenIdle();
    await f.plugin.patchSettings(s => { s.enabled = false; });
    f.plugin.onunload();
    const app = f.plugin.app;
    replacement = new PluginClass(app as never, { id: 'oks-synthetic-evidence' } as never);
    const saved = (f.plugin as unknown as { saved: unknown }).saved;
    Object.assign(replacement, { app, manifest: { id: 'oks-synthetic-evidence' }, saved });
    await replacement.onload(); f.layout();
    assert.equal(replacement.standalone, undefined);
    assert.equal((replacement as unknown as { rootId?: string }).rootId, undefined);
    const count = await replacement.purgeIndex();
    assert.ok(count >= 1);
    assert.equal(await readFile(join(f.vault,'fixture.md'),'utf8'), '# Synthetic\nREQ-LIFE-1: local only.\n');
    await replacement.patchSettings(s => { s.enabled = true; });
    await replacement.standalone!.whenIdle();
    assert.equal(replacement.standalone!.status().status,'ready');
  } finally { replacement?.onunload(); await f.cleanup(); }
});

test('05B advanced health is opt-in, survives Standalone indexing and revokes child on disable', async () => {
  const f = await fixture();
  try {
    await f.plugin.onload(); f.layout(); await f.internal.initializing;
    await f.plugin.standalone!.whenIdle();
    assert.equal(f.plugin.advancedHealth.snapshot().status,'disabled');
    assert.equal(f.plugin.advancedHealth.pid,undefined);
    await f.plugin.patchSettings(s => {s.advanced={enabled:true, profile:'local-stdio',
      interpreter:TEST_PYTHON, entry:join(process.cwd(),'engine/persistent.py')};});
    assert.equal(f.plugin.advancedHealth.snapshot().status,'ready');
    assert.equal(f.plugin.searchController.status().capabilityReadiness.dense,'unavailable');
    const pid=f.plugin.advancedHealth.pid!;
    process.kill(pid,0);
    assert.equal(f.plugin.standalone!.status().status,'ready');
    await f.plugin.patchSettings(s => {s.advanced.enabled=false;});
    assert.equal(f.plugin.advancedHealth.snapshot().status,'disabled');
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    assert.equal(f.plugin.standalone!.status().status,'ready');
  } finally { await f.cleanup(); }
});
test('05B advanced reload barrier waits for prior subprocess stop with explicit saved opt-in',async()=>{
  const f=await fixture();
  let replacement: InstanceType<typeof PluginClass>|undefined;
  try {
    await f.plugin.onload();f.layout();await f.internal.initializing;
    await f.plugin.patchSettings(s=>{s.advanced={enabled:true,profile:'local-stdio',
      interpreter:TEST_PYTHON,entry:join(process.cwd(),'engine/persistent.py')};});
    const first=f.plugin.advancedHealth.pid!;
    assert.ok(first);process.kill(first,0);
    const saved=(f.plugin as unknown as {saved:unknown}).saved;
    f.plugin.onunload();
    replacement=new PluginClass(f.plugin.app,f.plugin.manifest);
    Object.assign(replacement,{app:f.plugin.app,manifest:f.plugin.manifest,saved});
    await replacement.onload();f.layout();
    await (replacement as unknown as {advancedStartup:Promise<void>}).advancedStartup;
    assert.equal(replacement.advancedHealth.snapshot().status,'ready');
    assert.throws(()=>process.kill(first,0),{code:'ESRCH'});
    const second=replacement.advancedHealth.pid!;
    assert.ok(second && second!==first);
    replacement.onunload();
  } finally { replacement?.onunload();await f.cleanup(); }
});


test('05B B2: overlapping recheck/disable/unload and replacement reload never overlap Advanced workers', async () => {
  const f = await fixture();
  let replacement: InstanceType<typeof PluginClass> | undefined;
  const raceRoot = await mkdtemp(resolve('.test-build/advanced-plugin-race-'));
  const entry = join(raceRoot, 'health-race.py');
  const registry = join(raceRoot, 'advanced-pids.log');
  await writeFile(entry, [
    'import sys,json,os,time,signal',
    'signal.signal(signal.SIGTERM,signal.SIG_IGN)',
    'with open(' + JSON.stringify(registry) + ",'a') as f:f.write(str(os.getpid())+'\\n')",
    'r=json.loads(sys.stdin.readline())',
    'sys.stdout.write(json.dumps(dict(version=2,id=r["id"],ok=True),separators=(",",":"))+"\\n")',
    'sys.stdout.flush()',
    'time.sleep(30)',
  ].join('\n') + '\n');
  const cfg = { enabled:true, profile:'local-stdio' as const, interpreter:TEST_PYTHON, entry };
  const isAlive = async (pid: number): Promise<boolean> => {
    try {
      const stat = await readFile('/proc/' + pid + '/stat','utf8');
      return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[0]!);
    } catch (error) {
      if (['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  };
  let watching = true, maxAlive = 0;
  let monitor = Promise.resolve();
  try {
    await f.plugin.onload(); f.layout();
    await (f.internal as unknown as { initializing?: Promise<void> }).initializing;
    await f.plugin.patchSettings(s => { s.advanced = cfg; });
    assert.equal(f.plugin.advancedHealth.snapshot().status,'ready');
    const initial = f.plugin.advancedHealth.pid!;
    const savedOptIn = { ...f.plugin.settings };
    monitor = (async () => {
      while (watching) {
        const list = (await readFile(registry,'utf8')).trim().split('\n').map(Number);
        maxAlive = Math.max(maxAlive, (await Promise.all(list.map(isAlive))).filter(Boolean).length);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    })();
    const rechecks = [f.plugin.checkAdvancedHealth(),f.plugin.checkAdvancedHealth(),
      f.plugin.checkAdvancedHealth()];
    const disable = f.plugin.patchSettings(s => { s.advanced.enabled = false; });
    f.plugin.onunload();
    replacement = new PluginClass(f.plugin.app, f.plugin.manifest);
    Object.assign(replacement,{app:f.plugin.app,manifest:f.plugin.manifest,saved:savedOptIn});
    await replacement.onload();
    f.layout();
    await Promise.allSettled([...rechecks,disable]);
    await (replacement as unknown as {advancedStartup?:Promise<void>}).advancedStartup;
    assert.equal(replacement.advancedHealth.snapshot().status,'ready',
      JSON.stringify(replacement.advancedHealth.snapshot()));
    assert.equal(await isAlive(initial),false);
    assert.ok(replacement.advancedHealth.pid && replacement.advancedHealth.pid !== initial);
    assert.equal(replacement.standalone!.status().status,'ready',
      JSON.stringify({engine:replacement.standalone!.status(),startup:replacement.standaloneError}));
    replacement.onunload();
    await replacement.advancedHealth.stop();
    await f.plugin.advancedHealth.stop();
    const list = (await readFile(registry,'utf8')).trim().split('\n').map(Number);
    for (const pid of list) assert.equal(await isAlive(pid),false,'reload survivor: ' + pid);
    assert.ok(maxAlive <= 1,'overlapping advanced workers: ' + maxAlive);
  } finally {
    watching = false;
    await monitor;
    replacement?.onunload();
    await replacement?.advancedHealth.stop();
    await f.plugin.advancedHealth.stop();
    await f.cleanup();
    await rm(raceRoot, { recursive:true, force:true });
  }
});


test('05B B2: failed process-group termination blocks reload and health recheck across instances', async () => {
  const f = await fixture();
  let replacement: InstanceType<typeof PluginClass> | undefined;
  const originalKill = process.kill.bind(process);
  let previousPid = 0;
  try {
    await f.plugin.onload(); f.layout();
    await f.plugin.patchSettings(s => {s.advanced={enabled:true,profile:'local-stdio',
      interpreter:TEST_PYTHON,entry:join(process.cwd(),'engine/persistent.py')};});
    assert.equal(f.plugin.advancedHealth.snapshot().status,'ready');
    previousPid = f.plugin.advancedHealth.pid!;
    const saved = structuredClone(f.plugin.settings);
    // Deny the exact group signal only, as if cleanup lost permissions. Do not
    // let this synthetic failure affect any other process or the real host.
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -previousPid && signal === 'SIGTERM')
        throw Object.assign(new Error('injected signal refusal'),{code:'EPERM'});
      return originalKill(pid,signal);
    }) as typeof process.kill;
    f.plugin.onunload();
    replacement = new PluginClass(f.plugin.app,f.plugin.manifest);
    Object.assign(replacement,{app:f.plugin.app,manifest:f.plugin.manifest,saved});
    await replacement.onload(); f.layout();
    await (replacement as unknown as {advancedStartup?:Promise<void>}).advancedStartup;
    assert.equal(replacement.advancedHealth.snapshot().status,'failed');
    assert.equal(replacement.advancedHealth.snapshot().error,'ADVANCED_UNAVAILABLE');
    assert.equal(replacement.advancedHealth.pid,undefined);
    await replacement.checkAdvancedHealth();
    assert.equal(replacement.advancedHealth.pid,undefined);
    originalKill(previousPid,0); // predecessor is deliberately still alive
  } finally {
    process.kill = originalKill as typeof process.kill;
    await f.plugin.advancedHealth.stop();
    replacement?.onunload();
    await replacement?.advancedHealth.stop();
    await f.cleanup();
  }
  assert.throws(() => originalKill(previousPid,0),{code:'ESRCH'});
});

type DenseLifecyclePort = {
  active?: Promise<unknown>;
  close(): Promise<void>;
  port: { admitStorage(): Promise<void> };
};
const denseLifecycle = (plugin: InstanceType<typeof PluginClass>) =>
  (plugin as unknown as { denseHost?: DenseLifecyclePort }).denseHost;
function deferredDrain() {
  let release!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  return { promise, release, reject };
}
function replacementPlugin(f: Awaited<ReturnType<typeof fixture>>) {
  const p = new PluginClass(f.plugin.app, f.plugin.manifest);
  Object.assign(p, { app: f.plugin.app, manifest: f.plugin.manifest,
    saved: structuredClone((f.plugin as unknown as { saved: unknown }).saved) });
  return p;
}
const legacyQuery = { query: 'synthetic', requestedMode: 'lexical' as const, limit: 1 };
const enableLegacy = (s: ReturnType<typeof defaultSettings>) => {
  s.ingestion = { ...s.ingestion, enabled: true, interpreter: '/synthetic/python',
    entry: '/synthetic/advanced_ingest.py', tokenizerSnapshot: '/synthetic/tokenizer' };
};

test('D6 B-LIFECYCLE-01: detached dense drain survives ingestion toggle and reload; legacy admission waits', async () => {
  const f = await fixture();
  const drain = deferredDrain(), entered = deferredDrain();
  let replacement: InstanceType<typeof PluginClass> | undefined;
  let toggle: Promise<void> | undefined, search: Promise<unknown> | undefined;
  try {
    await f.plugin.onload(); f.layout(); await f.internal.initializing;
    await f.plugin.standalone!.whenIdle();
    const dense = denseLifecycle(f.plugin)!;
    assert.ok(dense);
    // Hold the actual host close at its active-job drain, simulating a writer
    // still completing asynchronous publication/cleanup after cancellation.
    dense.active = drain.promise;
    const close = dense.close.bind(dense);
    dense.close = () => { entered.release(); return close(); };
    toggle = f.plugin.patchSettings(enableLegacy);
    await entered.promise;
    assert.equal(denseLifecycle(f.plugin), undefined);
    f.plugin.onunload();
    replacement = replacementPlugin(f);
    await replacement.onload(); f.layout();
    assert.equal(replacement.settings.ingestion.enabled, true);
    let calls = 0;
    // Observe actual production searchAdvanced admission at the manager boundary;
    // no model, subprocess, or provider is needed.
    replacement.advancedRetrieval.search = async () => {
      ++calls; throw new Error('synthetic admission reached');
    };
    search = replacement.searchAdvanced(legacyQuery);
    const outcome = assert.rejects(search, /synthetic admission reached/);
    await (replacement as unknown as { initializing: Promise<void> }).initializing;
    await replacement.standalone!.whenIdle();
    assert.equal(replacement.standalone!.status().status, 'ready');
    assert.equal(calls, 0, 'legacy manager reached before prior dense writer drained');
    drain.release();
    await toggle; await outcome;
    assert.equal(calls, 1);
  } finally {
    drain.release(); await toggle?.catch(() => {}); await search?.catch(() => {});
    replacement?.onunload(); await f.cleanup();
  }
});

test('D6 B-LIFECYCLE-01: reverse transition and reload wait for legacy drain without blocking lexical', async () => {
  const f = await fixture();
  const drain = deferredDrain(), entered = deferredDrain();
  let replacement: InstanceType<typeof PluginClass> | undefined;
  let toggle: Promise<void> | undefined, admission: Promise<void> | undefined;
  try {
    await f.plugin.onload(); f.layout(); await f.internal.initializing;
    await f.plugin.patchSettings(enableLegacy);
    assert.equal(denseLifecycle(f.plugin), undefined);
    const stop = f.plugin.advancedRetrieval.stop.bind(f.plugin.advancedRetrieval);
    f.plugin.advancedRetrieval.stop = async () => { entered.release(); await drain.promise; await stop(); };
    toggle = f.plugin.patchSettings(s => { s.ingestion.enabled = false; });
    await entered.promise;
    f.plugin.onunload();
    replacement = replacementPlugin(f);
    await replacement.onload(); f.layout();
    await (replacement as unknown as { initializing: Promise<void> }).initializing;
    await replacement.standalone!.whenIdle();
    assert.equal(replacement.standalone!.status().status, 'ready');
    const dense = denseLifecycle(replacement)!;
    assert.ok(dense);
    let admitted = false;
    admission = dense.port.admitStorage().then(() => { admitted = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(admitted, false);
    drain.release(); await toggle; await admission;
    assert.equal(admitted, true);
  } finally {
    drain.release(); await toggle?.catch(() => {}); await admission?.catch(() => {});
    replacement?.onunload(); await f.cleanup();
  }
});

test('D6 B-LIFECYCLE-01: failed prior storage drain denies replacement while lexical remains ready', async () => {
  const f = await fixture();
  let replacement: InstanceType<typeof PluginClass> | undefined;
  try {
    await f.plugin.onload(); f.layout(); await f.internal.initializing;
    const dense = denseLifecycle(f.plugin)!;
    const close = dense.close.bind(dense);
    dense.close = async () => { await close(); throw new Error('synthetic failed drain'); };
    await assert.rejects(f.plugin.patchSettings(enableLegacy), /synthetic failed drain/);
    f.plugin.onunload();
    replacement = replacementPlugin(f);
    await replacement.onload(); f.layout();
    await (replacement as unknown as { initializing: Promise<void> }).initializing;
    await replacement.standalone!.whenIdle();
    assert.equal(replacement.standalone!.status().status, 'ready');
    let calls = 0;
    replacement.advancedRetrieval.search = async () => { ++calls; throw new Error('unexpected admission'); };
    await assert.rejects(replacement.searchAdvanced(legacyQuery), /MODEL_UNAVAILABLE/);
    assert.equal(calls, 0);
  } finally { replacement?.onunload(); await f.cleanup(); }
});


test('D6 B-LIFECYCLE-02: same host transfers CURRENT ownership, handles events and reopens for legacy rebuild', async () => {
  const f = await fixture();
  const files = new Map([['fixture.md', Object.assign(new Empty(), {path:'fixture.md'})]]);
  const events = new Map<string, (file: {path:string}, oldPath?:string) => void>();
  const emit = (event:string,file:{path:string},oldPath?:string) => events.get(event)!(file,oldPath);
  Object.assign(f.plugin.app.vault, {
    getMarkdownFiles: () => [...files.values()],
    getAbstractFileByPath: (path:string) => files.get(path) ?? null,
    on: (event:string,cb:(file:{path:string},oldPath?:string)=>void) => { events.set(event,cb); return {}; },
  });
  let calls=0;
  const server=createServer((req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      ++calls;
      assert.equal(req.url,'/v1/embeddings');
      assert.equal(req.headers.authorization,'Bearer fixture-token');
      const payload=JSON.parse(body) as {model:string;input:string[]};
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({model:payload.model,data:payload.input.map((_,index)=>
        ({object:'embedding',index,embedding:[1,0,0]}))}));
    });
  });
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const addr=server.address();assert.ok(addr&&typeof addr!=='string');
    await f.plugin.onload();f.layout();await f.internal.initializing;
    await f.plugin.standalone!.whenIdle();
    await f.plugin.patchSettings(enableLegacy);
    assert.equal((await f.plugin.searchAdvanced(legacyQuery)).status,'ok','open actual legacy store');
    await f.plugin.cancelAdvancedWork(); // Ordinary cancellation is not an ownership handoff.
    assert.equal((await f.plugin.searchAdvanced(legacyQuery)).status,'ok');
    const space:EmbeddingSpace={model:'fixture',revision:'v1',dimension:3,normalization:'unit-l2',
      serializationId:'utf8-verbatim-v1',queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
    await f.plugin.patchSettings(s=>{
      s.ingestion.enabled=false;
      s.ai.embedding={state:'configured',transport:'local',origin:'http://127.0.0.1:'+addr.port,
        identity:{model:space.model,revision:space.revision},
        limits:{timeoutMs:1500,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}};
    });
    const dense=(f.plugin as unknown as {denseHost:ApiDenseHost}).denseHost;
    const preview=await dense.prepare({kind:'rebuild',paths:['fixture.md'],space});
    const built=await dense.confirm(preview,'synthetic','fixture-token');
    assert.equal(built.status,'ok',JSON.stringify(built));assert.ok(calls>0);

    // Exercise the real registered Vault handlers after the dense epoch changes.
    const extra=Object.assign(new Empty(),{path:'extra.md'});
    files.set(extra.path,extra);await writeFile(join(f.vault,extra.path),'# Extra\nnew synthetic note\n');
    assert.doesNotThrow(()=>emit('create',extra));
    const original=files.get('fixture.md')!;
    await writeFile(join(f.vault,original.path),'# Synthetic\nREQ-LIFE-2: changed.\n');
    assert.doesNotThrow(()=>emit('modify',original));
    await rename(join(f.vault,original.path),join(f.vault,'renamed.md'));
    files.delete(original.path);original.path='renamed.md';files.set(original.path,original);
    assert.doesNotThrow(()=>emit('rename',original,'fixture.md'));
    await f.plugin.standalone!.whenIdle();
    const basic=await f.plugin.standalone!.search({protocolVersion:2,requestId:'handoff',
      query:'REQ-LIFE-2',requestedMode:'lexical',limit:5});
    assert.equal(basic.status,'ok');assert.equal(basic.hits[0]?.sourceId,'renamed.md');
    assert.ok(basic.hits.every(hit=>hit.sourceId!=='fixture.md'));

    await f.plugin.patchSettings(enableLegacy);
    assert.equal(denseLifecycle(f.plugin),undefined);
    assert.equal((await f.plugin.searchAdvanced(legacyQuery)).status,'ok','reopen authoritative CURRENT');
    // Exercise actual legacy publication with the canonical synthetic fixture and
    // a mocked parser/model boundary; no external provider or model weights.
    const fixture=JSON.parse(await readFile('contracts/fixtures/advanced-ingestion-v1.json','utf8'))
      .cases[0] as {rawBase64:string;response:IngestResponse};
    const response=fixture.response;response.source!.scopeId=preview.scopeId;
    const path=response.source!.sourceId;
    files.set(path,Object.assign(new Empty(),{path}));
    await writeFile(join(f.vault,path),Buffer.from(fixture.rawBase64,'base64'));
    emit('create',files.get(path)!);
    f.plugin.advancedIngestion.verified=async (p,allowed)=>p===path&&allowed()?response:null;
    f.plugin.advancedIngestion.verifiedAll=async allowed=>({documents:allowed(path)?[response]:[],staleCount:0});
    const model=JSON.parse(await readFile('benchmarks/embedding/results.json','utf8'));
    f.plugin.advancedIngestion.runner.embed=async (_cfg,texts):Promise<ModelReply>=>({
      protocolVersion:4,requestId:'synthetic',operation:'embed',status:'ok',error:null,
      identity:{...model.identity,effective_max_tokens:384,runtime_tokenizer_parity_verified:true},
      vectors:texts.map(()=>Array.from({length:1024},(_,i)=>i===0?1:0)),diagnostics:[],
    });
    await f.plugin.indexAdvancedPath(path,true);
    assert.equal(f.plugin.advancedRetrieval.snapshot().indexedSources,1);
    const legacy=await f.plugin.searchAdvanced({...legacyQuery,query:'REQ-X-1',requestedMode:'hybrid'});
    assert.equal(legacy.status,'ok',legacy.error??'legacy rebuild failed');
    assert.ok(legacy.hits.some(hit=>hit.sourceId===path));
  } finally {
    server.closeAllConnections();
    if(server.listening)await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    // The final create event schedules a lexical writer independently of legacy.
    // Drain it before the fixture removes its private index directory.
    await f.plugin.standalone?.whenIdle();
    await f.cleanup();
  }
});

test('UX-AC02/05: presentation-only commits persist without revoking the live engine, evidence or dense host', async () => {
  const f = await fixture();
  try {
    await f.plugin.onload(); f.layout(); await f.internal.initializing;
    await f.plugin.standalone!.whenIdle();
    const engine = f.plugin.standalone;
    const host = (f.plugin as unknown as { denseHost: unknown }).denseHost;
    const before = await f.plugin.api.request({ apiVersion: 1, operation: 'search', request: {
      protocolVersion: 2, requestId: 'mode', query: 'REQ-LIFE-1', requestedMode: 'lexical', limit: 5,
    } });
    assert.equal(before.ok, true);
    const generation = f.plugin.standalone!.status().generationId;
    const searchResponse = f.plugin.searchController.snapshot().response;
    await f.plugin.patchSettings(s => { s.presentationMode = 'expert'; });
    assert.equal(f.plugin.settings.presentationMode, 'expert');
    assert.equal(f.plugin.standalone, engine);
    assert.equal((f.plugin as unknown as { denseHost: unknown }).denseHost, host);
    assert.equal(f.plugin.standalone!.status().generationId, generation);
    assert.deepEqual(f.plugin.searchController.snapshot().response, searchResponse);
    const saved = (f.plugin as unknown as { saved: unknown }).saved;
    assert.equal((saved as { presentationMode: string }).presentationMode, 'expert');
    const decoded = (await import('../plugin/src/search/settings')).parseSettings(saved);
    assert.equal(decoded.presentationMode, 'expert');
    await f.plugin.patchSettings(s => { s.presentationMode = 'basic'; });
    assert.equal(f.plugin.standalone, engine);
    assert.equal(f.plugin.settings.ai.embedding.state, 'disabled');
    assert.deepEqual(f.plugin.searchController.snapshot().response, searchResponse);
  } finally { await f.cleanup(); }
});

test('UX-AC04: failed persistent writes do not commit edited draft or disrupt the existing offline engine', async () => {
  const f = await fixture();
  try {
    await f.plugin.onload(); f.layout(); await f.internal.initializing;
    await f.plugin.standalone!.whenIdle();
    const engine = f.plugin.standalone!;
    const saved = (f.plugin as unknown as { saved: unknown }).saved;
    const previous = structuredClone(f.plugin.settings);
    const original = f.plugin.saveData.bind(f.plugin);
    Object.assign(f.plugin, { saveData: async () => { throw new Error('synthetic private storage refusal'); } });
    try {
      await assert.rejects(f.plugin.patchSettings(s => {
        s.presentationMode = 'expert'; s.topK = 42;
      }));
    } finally { Object.assign(f.plugin, { saveData: original }); }
    assert.deepEqual(f.plugin.settings, previous);
    assert.deepEqual((f.plugin as unknown as { saved: unknown }).saved, saved);
    assert.equal(f.plugin.standalone, engine);
    assert.equal(engine.status().status, 'ready');
  } finally { await f.cleanup(); }
});

for (const role of ['reranking','generation'] as const) {
  test('R1 B-R1-ROLE-01: '+role+' lifecycle preserves independent dense and reciprocal evidence consent', async t => {
    const f=await fixture();
    const file=Object.assign(new Empty(),{path:'fixture.md'});
    Object.assign(f.plugin.app.vault,{getMarkdownFiles:()=>[file],
      getAbstractFileByPath:(path:string)=>path===file.path?file:null});
    let calls=0, denseCalls=0;
    let onDenseRequest:()=>void=()=>{};
    let releaseDense:()=>void=()=>{};
    let onDelayedRequest:()=>void=()=>{};
    const server=createServer((req,res)=>{
      let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
        if(req.url==='/v1/embeddings'){
          denseCalls++;
          const payload=JSON.parse(body) as {model:string;input:string[]};
          releaseDense=()=>{
            res.writeHead(200,{'content-type':'application/json'});
            res.end(JSON.stringify({model:payload.model,data:payload.input.map((_,index)=>
              ({object:'embedding',index,embedding:[1,0,0]}))}));
          };
          onDenseRequest();return;
        }
        calls++;
        if(req.headers.authorization==='Bearer fixture-delay'){onDelayedRequest();return;}
        if(req.headers.authorization==='Bearer fixture-deny'){res.writeHead(401);res.end();return;}
        const payload=JSON.parse(body) as {model:string;documents?:string[]};
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify(req.url==='/v1/rerank'
          ? {model:payload.model,results:payload.documents!.map((_,index)=>({index,relevance_score:1}))}
          : {model:payload.model,usage:{completion_tokens:4},choices:[{index:0,finish_reason:'stop',
            message:{role:'assistant',content:JSON.stringify({claims:[{kind:'quotation',text:'REQ-LIFE-1',citationIds:[0]}]})}}]}));
      });
    });
    const denseUi=(f.plugin as unknown as {denseUi:DenseUiController}).denseUi;
    const c=f.plugin.searchController, other=role==='reranking'?'generation':'reranking';
    const prepare=()=>role==='reranking'?c.prepareRerank():c.prepareGeneration();
    const prepareOther=()=>other==='reranking'?c.prepareRerank():c.prepareGeneration();
    const cancel=()=>role==='reranking'?c.cancelRerank():c.cancelGeneration();
    const confirm=(preview:ReturnType<typeof prepare>,token:string)=>role==='reranking'
      ?c.rerankConfirmed(preview,'synthetic',token):c.generationConfirmed(preview,'synthetic',token);
    try {
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      const addr=server.address();assert.ok(addr&&typeof addr!=='string');
      await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
      const identity={model:'fixture',revision:'v1'};
      const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:'+addr.port,identity,
        limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}} as const;
      await f.plugin.patchSettings(s=>{s.ai.embedding=cfg;s.ai.reranking=cfg;s.ai.generation=cfg;});
      await f.plugin.standalone!.whenIdle();
      // Provision only this in-process synthetic server through the trusted host seam.
      const profileHost=c as unknown as {
        rerankProfiles:{installSyntheticFixture(config:typeof cfg,scopeId:string,fixtureId:string):unknown};
        rerankPort:{scopeId():string};
      };
      profileHost.rerankProfiles.installSyntheticFixture(cfg,profileHost.rerankPort.scopeId(),'role-lifecycle-fixture');

      const lexical=await c.search({protocolVersion:2,requestId:'role-lexical',query:'REQ-LIFE-1',requestedMode:'lexical',limit:5});
      assert.ok(lexical.ok&&lexical.value.hits.length>0);
      const space:EmbeddingSpace={...identity,dimension:3,normalization:'unit-l2',
        serializationId:'utf8-verbatim-v1',queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
      const request={protocolVersion:2,requestId:'role-d8',query:'REQ-LIFE-1',requestedMode:'dense',
        matchMode:'terms',scope:['fixture.md'],limit:1} as const;

      // Reproduce the review finding with an expired preview and a newly staged D8 slot.
      t.mock.timers.enable({apis:['setTimeout']});
      const expired=prepare();t.mock.timers.tick(300000);t.mock.timers.reset();
      assert.deepEqual(c.evidenceOperationStatus(role),{phase:'failed',error:'CANCELLED'});
      const staged=await f.plugin.denseApi.request({apiVersion:1,operation:'submit',request,space});
      assert.ok(staged.ok&&staged.value&&'operationId' in staged.value);
      const operationId=staged.value.operationId;
      const denseStatus=()=>f.plugin.denseApi.request({apiVersion:1,operation:'status',operationId});
      const pending=await denseStatus();
      assert.ok(pending.ok&&pending.value&&'phase' in pending.value&&pending.value.phase==='pending');
      const reciprocal=prepareOther();
      const unchanged=async()=>{
        assert.deepEqual(await denseStatus(),pending);
        assert.equal(c.isEvidencePreviewCurrent(other,reciprocal.sequence),true);
        assert.deepEqual(c.snapshot().response,lexical.value);
      };
      cancel();cancel();await unchanged();
      await assert.rejects(confirm(expired,'fixture-success'),{message:'DISCLOSURE_DENIED'});
      assert.equal(calls,0);await unchanged();
      t.mock.timers.enable({apis:['setTimeout']});
      prepare();t.mock.timers.tick(300000);t.mock.timers.reset();
      assert.deepEqual(c.evidenceOperationStatus(role),{phase:'failed',error:'CANCELLED'});
      await unchanged();
      const superseded=prepare();const replacement=prepare();
      assert.equal(c.isEvidencePreviewCurrent(role,superseded.sequence),false);
      const successful=confirm(replacement,'fixture-success');
      assert.equal(c.evidenceOperationStatus(role).phase,'busy');await unchanged();
      await successful;
      assert.equal(c.evidenceOperationStatus(role).phase,'complete');assert.equal(calls,1);await unchanged();
      await confirm(prepare(),'fixture-deny');
      assert.deepEqual(c.evidenceOperationStatus(role),{phase:'failed',error:'UNAUTHENTICATED'});
      assert.equal(calls,2);await unchanged();
      const entered=new Promise<void>(resolve=>{onDelayedRequest=resolve;});
      const running=confirm(prepare(),'fixture-delay');
      await Promise.race([entered,running.then(()=>{throw Error('request did not enter fixture');})]);
      await unchanged();cancel();await running;
      assert.deepEqual(c.evidenceOperationStatus(role),{phase:'failed',error:'CANCELLED'});
      assert.equal(calls,3);await unchanged();

      // Review the very same D8 request, then check owner-bound preview survival.
      const owner=Symbol('machine-review');
      const machine=(f.plugin as unknown as {denseMachine:{review(owner:symbol):Promise<void>}}).denseMachine;
      await machine.review(owner);
      const reviewed=denseUi.snapshot(owner);
      assert.equal(reviewed.phase,'preview');
      const second=prepare();await confirm(second,'fixture-success');
      assert.equal(c.evidenceOperationStatus(role).phase,'complete');
      assert.deepEqual(denseUi.snapshot(owner),reviewed);
      assert.equal(c.isEvidencePreviewCurrent(other,reciprocal.sequence),true);
      const cancelled=await f.plugin.denseApi.request({apiVersion:1,operation:'cancel',operationId});
      assert.ok(cancelled.ok);

      // Manual dense uses the same host but a distinct owner; evidence changes must not revoke it.
      const manual=Symbol('manual-dense');
      await denseUi.prepare(manual,{kind:'rebuild',paths:['fixture.md'],space});
      const manualPreview=denseUi.snapshot(manual);assert.equal(manualPreview.phase,'preview');
      await confirm(prepare(),'fixture-deny');cancel();
      assert.deepEqual(denseUi.snapshot(manual),manualPreview);
      assert.equal(c.isEvidencePreviewCurrent(other,reciprocal.sequence),true);
      assert.equal(calls,5);assert.equal(denseCalls,0);
      // A live, authorized synthetic embedding call must survive evidence-only transitions.
      assert.ok(manualPreview.phase==='preview');
      const denseEntered=new Promise<void>(resolve=>{onDenseRequest=resolve;});
      const denseRunning=denseUi.confirm(manual,manualPreview.preview.nonce,'synthetic','fixture-success');
      await Promise.race([denseEntered,denseRunning.then(()=>{throw Error('dense request did not enter fixture');})]);
      assert.equal(denseUi.operationStatus().phase,'busy');
      await confirm(prepare(),'fixture-success');cancel();
      assert.equal(denseUi.operationStatus().phase,'busy');
      assert.equal(c.isEvidencePreviewCurrent(other,reciprocal.sequence),true);
      releaseDense();await denseRunning;
      assert.equal(denseUi.operationStatus().phase,'complete');
      assert.equal(denseCalls,1);assert.equal(calls,6);
      assert.deepEqual(c.snapshot().response,lexical.value);
      // The shared lexical/source fence must still revoke every role.
      const final=prepare();
      let observedIdle=false, invoked=false;
      const off=c.subscribeEvidence(()=>{
        if(invoked)return;
        invoked=true;c.invalidate();
        observedIdle=denseUi.snapshot(manual).phase==='idle';
      });
      cancel();off();
      assert.equal(invoked,true);assert.equal(observedIdle,true);
      assert.equal(denseUi.snapshot(manual).phase,'idle');
      assert.equal(c.isEvidencePreviewCurrent(role,final.sequence),false);
      assert.equal(c.isEvidencePreviewCurrent(other,reciprocal.sequence),false);
      assert.equal(c.snapshot().response,null);
      assert.equal(calls,6);assert.equal(denseCalls,1);
    } finally {
      t.mock.timers.reset();
      server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
      await f.cleanup();
    }
  });
}

// LIFE-09: real plugin wiring, synthetic editor/source port. No AI/HTTP required.
for (const boundary of ['first-read','editor-open'] as const) {
  for (const transition of ['search','configure','detach','dispose','settings'] as const) {
    test('LIFE-09: '+boundary+' / '+transition+' revokes lexical navigation with both dense owners idle',async()=>{
      const f=await fixture(),c=f.plugin.searchController;
      const gate=deferredDrain(),entered=deferredDrain();
      const bytes=Buffer.from('alpha synthetic fixture\n'),generationId=hash('nav-generation');
      const doc=parseMarkdown('fixture.md',bytes,hash('nav-root'));
      const evidence:EvidenceHit={sourceId:'fixture.md',sourceSha256:doc.sha256,originalExcerpt:doc.blocks[0]!.originalText,
        sourceLocators:[doc.blocks[0]!.locator],rank:1,lexicalRank:1,retrievalMode:'lexical',
        indexGenerationId:generationId,score:1,headings:[],wikiLinks:[],properties:[]};
      let reads=0,opens=0,selections=0,blocked=true;
      const file={path:'fixture.md'};
      const nav=new SourceNavigator({read:async()=>{
        reads++;
        if(blocked&&boundary==='first-read'&&reads===1){entered.release();await gate.promise;}
        return bytes;
      }},{
        exact:()=>file,open:async()=>{
          opens++;
          if(blocked&&boundary==='editor-open'){entered.release();await gate.promise;}
          return {text:()=>bytes.toString(),select:()=>{selections++;}};
        },
      });
      const counts=()=>({reads,opens,selections});
      const engine={
        search:async(r:SearchRequest):Promise<SearchResponse>=>({protocolVersion:2,requestId:r.query,
          requestedMode:'lexical',executedMode:'lexical',status:'ok',indexGenerationId:generationId,hits:[evidence],
          capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0}),
        status:():EngineState=>({status:'ready',generationId,sources:1,records:1,busy:false,error:null,maintenanceWarning:null}),
        cancel:()=>true,resume:()=>{},rebuild:()=>{},
      };
      Object.assign(f.plugin,{navigator:nav});
      c.attach(engine);
      try{
        assert.equal((await c.search(uiRequest('old',1))).ok,true);
        const opening=c.open(0);
        await navigationWatchdog(entered.promise);
        if(transition==='search')assert.equal((await navigationWatchdog(c.search(uiRequest('new',1)))).ok,true);
        else if(transition==='configure')c.configure(true,false);
        else if(transition==='settings')await f.plugin.patchSettings(s=>{s.topK=s.topK===1?2:1;});
        else c[transition]();
        const before=counts();
        blocked=false;gate.release();
        assert.equal((await navigationWatchdog(opening)).ok,false);
        assert.deepEqual(counts(),before,'revoked navigation must not dispatch further reads, open or selection');
        if(transition==='search')assert.equal(c.snapshot().response?.requestId,'new');
        if(transition!=='dispose'){
          c.attach(engine);
          assert.equal((await navigationWatchdog(c.search(uiRequest('recovery',1)))).ok,true);
          assert.equal((await navigationWatchdog(c.open(0))).ok,true);
          assert.equal(selections,1);
        }
      }finally{gate.release();await f.cleanup();}
    });
  }
}
async function navigationWatchdog<T>(work:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('NAVIGATION_WATCHDOG')),1000);})]);}
  finally{clearTimeout(timer);}
}

test('B-R2-LIFE: failed settings shared retirement must deny lexical navigation until recovery',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  const bytes=Buffer.from('alpha synthetic fixture\n'),generationId=hash('review-nav-generation');
  const doc=parseMarkdown('fixture.md',bytes,hash('review-nav-root'));
  const evidence:EvidenceHit={sourceId:'fixture.md',sourceSha256:doc.sha256,originalExcerpt:doc.blocks[0]!.originalText,
    sourceLocators:[doc.blocks[0]!.locator],rank:1,lexicalRank:1,retrievalMode:'lexical',
    indexGenerationId:generationId,score:1,headings:[],wikiLinks:[],properties:[]};
  const file={path:'fixture.md'};
  let reads=0,opens=0,fail=false;
  const nav=new SourceNavigator({read:async()=>{reads++;return bytes;}},{
    exact:()=>file,open:async()=>{opens++;return {text:()=>bytes.toString(),select:()=>{}};}
  });
  const denseHost={prepare:async()=>({nonce:'synthetic',expiresUnixMs:Date.now()+100000}),
    invalidate:()=>{if(fail)throw Error('synthetic retirement failure');}};
  const denseUi=(f.plugin as unknown as {denseUi:DenseUiController}).denseUi;
  Object.assign(f.plugin,{navigator:nav,denseHost});
  c.attach({search:async(r:SearchRequest):Promise<SearchResponse>=>({protocolVersion:2,requestId:r.query,
    requestedMode:'lexical',executedMode:'lexical',status:'ok',indexGenerationId:generationId,hits:[evidence],
    capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0}),
    status:()=>({status:'ready',generationId,sources:1,records:1,busy:false,error:null,maintenanceWarning:null}),
    cancel:()=>true,resume:()=>{},rebuild:()=>{}});
  try {
    assert.equal((await c.search(uiRequest('old',1))).ok,true);
    const owner=Symbol('review-owner');
    await denseUi.prepare(owner,{} as never);
    assert.equal(denseUi.snapshot(owner).phase,'preview');
    fail=true;
    await assert.rejects(f.plugin.patchSettings(s=>{s.topK=s.topK===1?2:1;}),/synthetic retirement failure/);
    assert.equal(denseUi.authority.admissionClosed(),true);
    const result=await c.open(0);
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal(result.ok,false,'lexical navigation must remain closed after failed trusted retirement');
    assert.equal(reads,0);
    assert.equal(opens,0);
    assert.throws(()=>c.prepareGeneration());
    assert.throws(()=>c.prepareRerank());
    assert.equal((await c.search(uiRequest('denied',1))).ok,false);
    fail=false;
    await f.plugin.patchSettings(s=>{s.topK=s.topK===1?2:1;});
    assert.equal(c.sharedAuthorityTransition(),false);
    assert.equal((await c.search(uiRequest('recovered',1))).ok,true);
    assert.equal((await c.open(0)).ok,true);
  } finally {fail=false;Object.assign(f.plugin,{denseHost:undefined});await f.cleanup();}
});

test('B-R2-LIFE: disabling generation with pending settings save must revoke existing preview',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  const file=Object.assign(new Empty(),{path:'fixture.md'});
  Object.assign(f.plugin.app.vault,{getMarkdownFiles:()=>[file],
    getAbstractFileByPath:(p:string)=>p===file.path?file:null});
  const entered=deferredDrain(),gate=deferredDrain();
  let verifies=0;
  const original=f.plugin.saveData.bind(f.plugin);
  try {
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:1',identity:{model:'fixture',revision:'v1'},
      limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}} as const;
    await f.plugin.patchSettings(s=>{s.ai.generation=cfg;});
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const preview=c.prepareGeneration();
    Object.assign(f.plugin,{verifyAiEvidence:async()=>{verifies++;throw Error('synthetic stop before HTTP');},
      saveData:async(v:unknown)=>{entered.release();await gate.promise;await original(v);}});
    const disable=f.plugin.patchSettings(s=>{s.ai.generation={state:'disabled'};});
    await navigationWatchdog(entered.promise);
    const current=c.isEvidencePreviewCurrent('generation',preview.sequence);
    await c.generationConfirmed(preview,'synthetic','fixture-token').catch(()=>{});
    assert.equal(current,false);
    gate.release();await disable;
    assert.equal(verifies,0,'old consent must not read sources after role-disable transition begins');
  }finally{gate.release();Object.assign(f.plugin,{saveData:original});await f.cleanup();}
});

for (const role of ['reranking','generation'] as const) {
  for (const stage of ['preview','verification','transport'] as const) {
    test(`B-R2-LIFE-11 ${role} ${stage} save failure revokes consent and permits fresh recovery`,async()=>{
      const active=stage!=='preview';
      const f=await fixture(),c=f.plugin.searchController;
      const transportEntered=deferredDrain();
      let sends=0;
      const server=createServer((req,_res)=>{req.resume();req.on('end',()=>{sends++;transportEntered.release();});});
      const saveEntered=deferredDrain(),saveGate=deferredDrain(),verifyEntered=deferredDrain(),verifyGate=deferredDrain();
      const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:1',identity:{model:'fixture',revision:'v1'},
        limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}} as const;
      const original=f.plugin.saveData.bind(f.plugin);
      let verifies=0;
      const prepare=()=>role==='reranking'?c.prepareRerank():c.prepareGeneration();
      const confirm=(p:ReturnType<typeof prepare>)=>role==='reranking'
        ?c.rerankConfirmed(p,'synthetic','fixture'):c.generationConfirmed(p,'synthetic','fixture');
      const provision=()=>{
        const host=c as unknown as {rerankProfiles:{installSyntheticFixture(config:typeof cfg,scopeId:string,fixtureId:string):unknown};rerankPort:{scopeId():string}};
        host.rerankProfiles.installSyntheticFixture(cfg,host.rerankPort.scopeId(),'settings-fixture');
      };
      try {
        if(stage==='transport') {
          await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
          const address=server.address();assert.ok(address&&typeof address!=='string');
          Object.assign(cfg,{origin:'http://127.0.0.1:'+address.port});
          verifyGate.release();
        }
        await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
        await f.plugin.patchSettings(s=>{s.ai.reranking=cfg;s.ai.generation=cfg;});
        provision();
        assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
        const preview=prepare();
        const other=role==='reranking'?c.prepareGeneration():c.prepareRerank();
        Object.assign(f.plugin,{verifyAiEvidence:async()=>{verifies++;verifyEntered.release();await verifyGate.promise;},
          saveData:async()=>{saveEntered.release();await saveGate.promise;throw Error('synthetic save failure');}});
        const operation=active?confirm(preview):undefined;
        if(active)await navigationWatchdog(verifyEntered.promise);
        if(stage==='transport')await navigationWatchdog(transportEntered.promise);
        const saving=f.plugin.patchSettings(s=>{s.ai[role]={state:'disabled'};});
        const rejected=assert.rejects(saving,/synthetic save failure/);
        await navigationWatchdog(saveEntered.promise);
        assert.equal(c.sharedAuthorityTransition(),true);
        assert.equal(c.isEvidencePreviewCurrent(role,preview.sequence),false);
        assert.equal(c.isEvidencePreviewCurrent(role==='reranking'?'generation':'reranking',other.sequence),false);
        assert.throws(()=>c.prepareGeneration());assert.throws(()=>c.prepareRerank());
        assert.equal((await c.search(uiRequest('blocked',1))).ok,false);
        assert.equal(c.control('resume').ok,false);
        await assert.rejects(confirm(preview));
        if(operation)await navigationWatchdog(operation);
        assert.equal(verifies,active?1:0);
        assert.equal(sends,stage==='transport'?1:0);
        saveGate.release();await rejected;
        assert.equal(f.plugin.settings.ai[role].state,'configured');
        assert.equal(c.isEvidencePreviewCurrent(role,preview.sequence),false);
        await assert.rejects(confirm(preview));
        verifyGate.release();
        Object.assign(f.plugin,{saveData:original});
        await f.plugin.patchSettings(s=>{s.topK=s.topK===1?2:1;});
        assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
        // The shared search/consent revision is retired, but an unrelated role
        // preference cannot revoke the exact still-current reranker capability.
        if(role==='reranking') { assert.throws(()=>c.prepareRerank());provision(); }
        else { const freshRerank=c.prepareRerank();assert.equal(c.isEvidencePreviewCurrent('reranking',freshRerank.sequence),true); }
        const fresh=prepare();assert.equal(c.isEvidencePreviewCurrent(role,fresh.sequence),true);
        f.plugin.onunload();
        assert.equal(c.sharedAuthorityTransition(),true);
        await assert.rejects(confirm(fresh));
        assert.equal(verifies,active?1:0);
        assert.equal(sends,stage==='transport'?1:0);
      }finally{saveGate.release();verifyGate.release();Object.assign(f.plugin,{saveData:original});await f.cleanup();
        server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));}
    });
  }
}

test('B-R2-LIFE-11 persisted disable remains committed after post-save trusted hook failure',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  const original=f.plugin.saveData.bind(f.plugin);
  let fail=false;
  const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:1',identity:{model:'fixture',revision:'v1'},
    limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}} as const;
  try {
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    await f.plugin.patchSettings(s=>{s.ai.generation=cfg;});
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const preview=c.prepareGeneration();
    const nav=(f.plugin as unknown as {navigator:SourceNavigator<unknown>}).navigator;
    const invalidate=nav.invalidate.bind(nav);
    Object.assign(nav,{invalidate:()=>{if(fail)throw Error('synthetic post-save retirement failure');invalidate();}});
    Object.assign(f.plugin,{saveData:async(v:unknown)=>{await original(v);fail=true;}});
    await f.plugin.patchSettings(s=>{s.ai.generation={state:'disabled'};});
    assert.equal(f.plugin.settings.ai.generation.state,'disabled');
    assert.equal((f.plugin as unknown as {saved:{ai:{generation:{state:string}}}}).saved.ai.generation.state,'disabled');
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal(c.isEvidencePreviewCurrent('generation',preview.sequence),false);
    await assert.rejects(c.generationConfirmed(preview,'synthetic','fixture'));
    assert.equal((await c.open(0)).ok,false);
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,false);
    fail=false;
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    assert.throws(()=>c.prepareGeneration());
    await assert.rejects(c.generationConfirmed(preview,'synthetic','fixture'));
  }finally{fail=false;Object.assign(f.plugin,{saveData:original});await f.cleanup();}
});

test('B-R2-LIFE-10 failed trusted retirement is not retried within its lexical observer wave',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  let fail=false,attempts=0;
  const original=f.plugin.saveData.bind(f.plugin);
  let off=()=>{};
  try{
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    const nav=(f.plugin as unknown as {navigator:SourceNavigator<unknown>}).navigator;
    const invalidate=nav.invalidate.bind(nav);
    Object.assign(nav,{invalidate:()=>{attempts++;if(fail)throw Error('synthetic retirement failure');invalidate();}});
    fail=true;
    await assert.rejects(f.plugin.patchSettings(s=>{s.topK=s.topK===1?2:1;}));
    const nested:Promise<unknown>[]=[];
    off=c.subscribe(()=>{
      const before=attempts;
      nested.push(c.search(uiRequest('nested',1)).then(result=>assert.equal(result.ok,false)));
      assert.equal(c.control('resume').ok,false);
      assert.equal(attempts,before,'fault recovery must wait for a later external transition');
    });
    const before=attempts;
    assert.equal((await c.search(uiRequest('retry',1))).ok,false);
    await Promise.all(nested);
    assert.equal(attempts,before+1);
    assert.equal(nested.length,1);
    assert.equal(c.sharedAuthorityTransition(),true);
    off();fail=false;
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
  }finally{off();fail=false;Object.assign(f.plugin,{saveData:original});await f.cleanup();}
});

test('B-R2-LIFE-11 unload during a pending disable save cannot restore admission',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  const original=f.plugin.saveData.bind(f.plugin),entered=deferredDrain(),gate=deferredDrain();
  const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:1',identity:{model:'fixture',revision:'v1'},
    limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}} as const;
  let verifies=0;
  try{
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    await f.plugin.patchSettings(s=>{s.ai.generation=cfg;});
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const preview=c.prepareGeneration();
    Object.assign(f.plugin,{saveData:async(v:unknown)=>{entered.release();await gate.promise;await original(v);},
      verifyAiEvidence:async()=>{verifies++;throw Error('unexpected verification');}});
    const saving=f.plugin.patchSettings(s=>{s.ai.generation={state:'disabled'};});
    await navigationWatchdog(entered.promise);
    f.plugin.onunload();gate.release();await saving;
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal(c.isEvidencePreviewCurrent('generation',preview.sequence),false);
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,false);
    assert.equal((await c.open(0)).ok,false);
    await assert.rejects(c.generationConfirmed(preview,'synthetic','fixture'));
    assert.equal(verifies,0);
  }finally{gate.release();Object.assign(f.plugin,{saveData:original});await f.cleanup();}
});

test('B-R2-LIFE-10 pause command uses the same trusted retirement fault boundary',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  let fail=false,attempts=0;
  try{
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const host=(f.plugin as unknown as {denseHost:ApiDenseHost}).denseHost;
    const invalidate=host.invalidate.bind(host);
    Object.assign(host,{invalidate:(path?:string)=>{attempts++;if(fail)throw Error('synthetic idle host retirement failure');invalidate(path);}});
    fail=true;
    await f.plugin.controlSearch('pause');
    assert.equal(attempts,1);
    assert.equal(f.plugin.settings.paused,false);
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal((await c.open(0)).ok,false);
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,false);
    fail=false;
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
  }finally{fail=false;await f.cleanup();}
});

test('B-R2-LIFE-11 pending presentation-only save preserves both independent previews',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  const original=f.plugin.saveData.bind(f.plugin),entered=deferredDrain(),gate=deferredDrain();
  const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:1',identity:{model:'fixture',revision:'v1'},
    limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}} as const;
  try{
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    await f.plugin.patchSettings(s=>{s.ai.generation=cfg;s.ai.reranking=cfg;});
    const host=c as unknown as {rerankProfiles:{installSyntheticFixture(config:typeof cfg,scopeId:string,fixtureId:string):unknown};rerankPort:{scopeId():string}};
    host.rerankProfiles.installSyntheticFixture(cfg,host.rerankPort.scopeId(),'presentation-fixture');
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const generation=c.prepareGeneration(),rerank=c.prepareRerank();
    Object.assign(f.plugin,{saveData:async()=>{entered.release();await gate.promise;throw Error('synthetic presentation save failure');}});
    const saving=f.plugin.patchSettings(s=>{s.presentationMode='expert';});
    const rejected=assert.rejects(saving);
    await navigationWatchdog(entered.promise);
    assert.equal(c.sharedAuthorityTransition(),false);
    assert.equal(c.isEvidencePreviewCurrent('generation',generation.sequence),true);
    assert.equal(c.isEvidencePreviewCurrent('reranking',rerank.sequence),true);
    gate.release();await rejected;
    assert.equal(c.isEvidencePreviewCurrent('generation',generation.sequence),true);
    assert.equal(c.isEvidencePreviewCurrent('reranking',rerank.sequence),true);
  }finally{gate.release();Object.assign(f.plugin,{saveData:original});await f.cleanup();}
});

test('B-R2-LIFE-12: a write-then-reject disable remains fenced until durable settings are reconciled',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  const original=f.plugin.saveData.bind(f.plugin);
  const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:1',identity:{model:'fixture',revision:'v1'},
    limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}} as const;
  let verifies=0;
  try {
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    await f.plugin.patchSettings(s=>{s.ai.generation=cfg;});
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const old=c.prepareGeneration();
    Object.assign(f.plugin,{verifyAiEvidence:async()=>{verifies++;throw Error('synthetic stop before HTTP');},
      saveData:async(v:unknown)=>{await original(v);throw Error('synthetic ambiguous persistence');}});
    await assert.rejects(f.plugin.patchSettings(s=>{s.ai.generation={state:'disabled'};}),/synthetic ambiguous persistence/);
    assert.equal(f.plugin.settings.ai.generation.state,'disabled');
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,false);
    assert.equal(c.isEvidencePreviewCurrent('generation',old.sequence),false);
    await assert.rejects(c.generationConfirmed(old,'synthetic','fixture'));
    assert.throws(()=>c.prepareGeneration());
    Object.assign(f.plugin,{saveData:original});
    await f.plugin.patchSettings(s=>{s.topK=s.topK===1?2:1;});
    assert.equal(f.plugin.settings.ai.generation.state,'disabled');
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    assert.throws(()=>c.prepareGeneration());
    assert.equal(verifies,0);
  } finally {Object.assign(f.plugin,{saveData:original});await f.cleanup();}
});

test('B-R2-LIFE-12: recovery retires the original failed host before a replacement',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  const internal=f.plugin as unknown as {denseHost:ApiDenseHost};
  let old:ApiDenseHost|undefined,fail=true,originalAttempts=0,replacementAttempts=0;
  try {
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    old=internal.denseHost;assert.ok(old);
    const invalidate=old.invalidate.bind(old);
    Object.assign(old,{invalidate:(path?:string)=>{originalAttempts++;if(fail)throw Error('synthetic original owner');invalidate(path);}});
    await assert.rejects(f.plugin.patchSettings(s=>{s.topK=2;}),/synthetic original owner/);
    const replacement={invalidate:()=>{replacementAttempts++;}} as unknown as ApiDenseHost;
    internal.denseHost=replacement;
    await assert.rejects(f.plugin.patchSettings(s=>{s.topK=3;}),/synthetic original owner/);
    assert.equal(originalAttempts,2);
    assert.equal(replacementAttempts,0);
    assert.equal(c.sharedAuthorityTransition(),true);
    fail=false;
    await f.plugin.patchSettings(s=>{s.topK=3;});
    assert.equal(originalAttempts,3);
    assert.equal(replacementAttempts,1);
    assert.equal(c.sharedAuthorityTransition(),false);
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
  } finally {fail=false;if(old)internal.denseHost=old;await f.cleanup();}
});

test('B-R2-LIFE-12: a persisted runtime change with failed application requires explicit repair',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:1',identity:{model:'fixture',revision:'v1'},
    limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}} as const;
  let restore=()=>{};
  try {
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    await f.plugin.patchSettings(s=>{s.ai.generation=cfg;});
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const old=c.prepareGeneration(),engine=f.plugin.standalone!;
    const cancel=engine.cancel.bind(engine);
    restore=()=>{Object.assign(engine,{cancel});};
    Object.assign(engine,{cancel:()=>{throw Error('synthetic apply failure');}});
    await assert.rejects(f.plugin.patchSettings(s=>{s.ai.generation={state:'disabled'};s.paused=true;}),/synthetic apply failure/);
    assert.equal(f.plugin.settings.ai.generation.state,'disabled');
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,false);
    await assert.rejects(c.generationConfirmed(old,'synthetic','fixture'));
    restore();
    await f.plugin.updateSettings(structuredClone(f.plugin.settings));
    assert.equal(c.sharedAuthorityTransition(),false);
    assert.equal(f.plugin.settings.ai.generation.state,'disabled');
    assert.throws(()=>c.prepareGeneration());
  } finally {restore();await f.cleanup();}
});

test('B-R2-LIFE-12: replacement plugin cannot load stale settings during an old pending write',async()=>{
  const f=await fixture(),entered=deferredDrain(),gate=deferredDrain();
  const original=f.plugin.saveData.bind(f.plugin);
  const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:1',identity:{model:'fixture',revision:'v1'},
    limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}} as const;
  let replacement:InstanceType<typeof PluginClass>|undefined,loads=0;
  try {
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    await f.plugin.patchSettings(s=>{s.ai.generation=cfg;});
    Object.assign(f.plugin,{saveData:async(v:unknown)=>{entered.release();await gate.promise;await original(v);}});
    const saving=f.plugin.patchSettings(s=>{s.ai.generation={state:'disabled'};});
    await navigationWatchdog(entered.promise);
    f.plugin.onunload();
    replacement=new PluginClass(f.plugin.app,{id:'oks-synthetic-evidence'} as never);
    Object.assign(replacement,{app:f.plugin.app,manifest:{id:'oks-synthetic-evidence'},
      loadData:async()=>{loads++;return f.plugin.loadData();}});
    const loading=replacement.onload();
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(loads,0,'replacement must not read during the previous write');
    gate.release();await saving;await navigationWatchdog(loading);
    assert.equal(loads,1);
    assert.equal(replacement.settings.ai.generation.state,'disabled');
    assert.throws(()=>replacement!.searchController.prepareGeneration());
  } finally {gate.release();replacement?.onunload();Object.assign(f.plugin,{saveData:original});await f.cleanup();}
});

test('B-R2-LIFE-12: a rejected write with unavailable readback retains the requested disable for explicit retry',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  const save=f.plugin.saveData.bind(f.plugin),load=f.plugin.loadData.bind(f.plugin);
  const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:1',identity:{model:'fixture',revision:'v1'},
    limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}} as const;
  try {
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    await f.plugin.patchSettings(s=>{s.ai.generation=cfg;});
    Object.assign(f.plugin,{saveData:async()=>{throw Error('synthetic write failure');},
      loadData:async()=>{throw Error('synthetic readback failure');}});
    await assert.rejects(f.plugin.patchSettings(s=>{s.ai.generation={state:'disabled'};}),/synthetic write failure/);
    assert.equal(f.plugin.settings.ai.generation.state,'disabled');
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,false);
    Object.assign(f.plugin,{saveData:save,loadData:load});
    await f.plugin.updateSettings(structuredClone(f.plugin.settings));
    assert.equal(f.plugin.settings.ai.generation.state,'disabled');
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    assert.throws(()=>c.prepareGeneration());
  }finally{Object.assign(f.plugin,{saveData:save,loadData:load});await f.cleanup();}
});

test('B-R2-LIFE-12: committed disable does not perform the obsolete duplicate idle-host retirement',async()=>{
  const f=await fixture(),c=f.plugin.searchController;
  const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:1',identity:{model:'fixture',revision:'v1'},
    limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}} as const;
  let attempts=0,restore=()=>{};
  try{
    await f.plugin.onload();f.layout();await f.internal.initializing;await f.plugin.standalone!.whenIdle();
    await f.plugin.patchSettings(s=>{s.ai.generation=cfg;});
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const old=c.prepareGeneration();
    const host=(f.plugin as unknown as {denseHost:ApiDenseHost}).denseHost;
    const invalidate=host.invalidate.bind(host);
    restore=()=>{Object.assign(host,{invalidate});};
    Object.assign(host,{invalidate:(path?:string)=>{attempts++;if(attempts===2)throw Error('synthetic second retirement failure');invalidate(path);}});
    await f.plugin.patchSettings(s=>{s.ai.generation={state:'disabled'};});
    assert.equal(attempts,1);
    assert.equal(f.plugin.settings.ai.generation.state,'disabled');
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    assert.throws(()=>c.prepareGeneration());
    await assert.rejects(c.generationConfirmed(old,'synthetic','fixture'));
  }finally{restore();await f.cleanup();}
});

const reloadFixtureConfig = {state:'configured',transport:'local',origin:'http://127.0.0.1:1',
  identity:{model:'fixture',revision:'v1'},limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:8,
    maxOutputTokens:32,maxConcurrent:1}} as const;

for (const role of ['generation','reranking'] as const) {
  test('B-R2-LIFE-13: reentrant retirement unload cancels undispatched '+role+' save and queued edits',async()=>{
    const f=await fixture(),old=f.plugin,c=old.searchController;
    let replacement:InstanceType<typeof PluginClass>|undefined,loading:Promise<void>|undefined;
    let writes=0,reads=0,queued=0,verifies=0;
    const save=old.saveData.bind(old);
    try {
      await old.onload();f.layout();await f.internal.initializing;await old.standalone!.whenIdle();
      await old.patchSettings(s=>{s.ai.generation=reloadFixtureConfig;s.ai.reranking=reloadFixtureConfig;});
      const host=c as unknown as {rerankProfiles:{installSyntheticFixture(config:typeof reloadFixtureConfig,scopeId:string,fixtureId:string):unknown};rerankPort:{scopeId():string}};
      host.rerankProfiles.installSyntheticFixture(reloadFixtureConfig,host.rerankPort.scopeId(),'reload-fixture');
      assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
      const generation=c.prepareGeneration(),rerank=c.prepareRerank();
      Object.assign(old,{saveData:async(v:unknown)=>{writes++;await save(v);},
        verifyAiEvidence:async()=>{verifies++;throw Error('unexpected verification');}});
      let once=false;
      c.subscribe(()=>{
        if(once)return;once=true;old.onunload();
        replacement=new PluginClass(old.app,old.manifest);
        Object.assign(replacement,{app:old.app,manifest:old.manifest,loadData:async()=>{reads++;return old.loadData();}});
        loading=replacement.onload();
      });
      const changing=old.patchSettings(s=>{s.ai[role]={state:'disabled'};});
      const later=old.patchSettings(s=>{queued++;s.topK=2;});
      await navigationWatchdog(Promise.all([changing,later]));
      assert.ok(loading);await navigationWatchdog(loading);
      assert.equal(writes,0);assert.equal(queued,0);assert.equal(reads,1);
      assert.deepEqual(replacement!.settings,await old.loadData());
      assert.equal(replacement!.settings.ai[role].state,'configured','cancelled write must not pretend to commit');
      assert.equal(c.sharedAuthorityTransition(),true);
      assert.equal(c.isEvidencePreviewCurrent('generation',generation.sequence),false);
      assert.equal(c.isEvidencePreviewCurrent('reranking',rerank.sequence),false);
      await assert.rejects(c.generationConfirmed(generation,'synthetic','fixture'));
      await assert.rejects(c.rerankConfirmed(rerank,'synthetic','fixture'));
      assert.equal(verifies,0);
    }finally{replacement?.onunload();Object.assign(old,{saveData:save});await f.cleanup();}
  });
}

for (const rejects of [false,true]) {
  test('B-R2-LIFE-13: replacement reads dispatched '+(rejects?'write-then-reject':'successful write')+'; queued writes cannot resume',async()=>{
    const f=await fixture(),old=f.plugin,entered=deferredDrain(),gate=deferredDrain();
    const save=old.saveData.bind(old);
    let replacement:InstanceType<typeof PluginClass>|undefined,reads=0,writes=0,queued=0,readbacks=0,verifies=0;
    try {
      await old.onload();f.layout();await f.internal.initializing;await old.standalone!.whenIdle();
      await old.patchSettings(s=>{s.ai.generation=reloadFixtureConfig;s.ai.reranking=reloadFixtureConfig;});
      const load=old.loadData.bind(old);
      Object.assign(old,{loadData:async()=>{readbacks++;return load();},
        saveData:async(v:unknown)=>{writes++;entered.release();await gate.promise;await save(v);if(rejects)throw Error('synthetic committed rejection');}});
      const changing=old.patchSettings(s=>{s.ai.generation={state:'disabled'};s.ai.reranking={state:'disabled'};});
      const settled=rejects?assert.rejects(changing,/synthetic committed rejection/):changing;
      await navigationWatchdog(entered.promise);
      const later=old.patchSettings(s=>{queued++;s.ai.generation=reloadFixtureConfig;});
      old.onunload();
      replacement=new PluginClass(old.app,old.manifest);
      Object.assign(replacement,{app:old.app,manifest:old.manifest,loadData:async()=>{reads++;return load();},
        verifyAiEvidence:async()=>{verifies++;throw Error('unexpected verification');}});
      const loading=replacement.onload();
      await new Promise<void>(resolve=>setImmediate(resolve));
      assert.equal(reads,0);
      gate.release();await settled;await later;await navigationWatchdog(loading);
      assert.equal(writes,1);assert.equal(queued,0);assert.equal(readbacks,0);assert.equal(reads,1);
      assert.deepEqual(replacement.settings,await load());
      assert.equal(replacement.settings.ai.generation.state,'disabled');
      assert.equal(replacement.settings.ai.reranking.state,'disabled');
      f.layout();await (replacement as unknown as {initializing:Promise<void>}).initializing;
      await replacement.standalone!.whenIdle();
      const c=replacement.searchController;
      assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
      assert.throws(()=>c.prepareGeneration());assert.throws(()=>c.prepareRerank());
      assert.equal(verifies,0);
    }finally{
      gate.release();
      if(replacement){await (replacement as unknown as {stopStandalone():Promise<void>}).stopStandalone();replacement.onunload();}
      Object.assign(old,{saveData:save});await f.cleanup();
    }
  });
}

test('B-R2-LIFE-13: terminal unload before presentation save dispatch cancels the reserved write',async()=>{
  const f=await fixture(),old=f.plugin,save=old.saveData.bind(old);
  let writes=0;
  try {
    await old.onload();
    Object.assign(old,{saveData:async(v:unknown)=>{writes++;await save(v);}});
    await old.patchSettings(s=>{s.presentationMode='expert';queueMicrotask(()=>old.onunload());});
    assert.equal(writes,0);
    assert.equal(old.settings.presentationMode,'basic');
    assert.equal(old.searchController.sharedAuthorityTransition(),true);
  }finally{Object.assign(old,{saveData:save});await f.cleanup();}
});

test('B-R2-LIFE-14: terminal callbacks see one closed search snapshot, never re-admit consent, D8 or navigation',async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController;
  const internals=p as unknown as {denseUi:DenseUiController;denseMachine:import('../plugin/src/ai/dense-machine').DenseMachine};
  const {denseUi,denseMachine}=internals;
  const file=Object.assign(new Empty(),{path:'fixture.md'});
  Object.assign(p.app.vault,{getMarkdownFiles:()=>[file],getAbstractFileByPath:(path:string)=>path===file.path?file:null});
  const owner=Symbol('terminal-review'),observations:string[]=[];
  const replies:Promise<unknown>[]=[];
  let dispatches=0,reads=0,navReads=0,evidenceNotifications=0,throwing=0;
  try{
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    await p.patchSettings(s=>{s.ai.generation=reloadFixtureConfig;s.ai.reranking=reloadFixtureConfig;s.ai.embedding=reloadFixtureConfig;});
    const profiles=c as unknown as {rerankProfiles:{installSyntheticFixture(config:typeof reloadFixtureConfig,scopeId:string,fixtureId:string):unknown};rerankPort:{scopeId():string}};
    profiles.rerankProfiles.installSyntheticFixture(reloadFixtureConfig,profiles.rerankPort.scopeId(),'terminal-fixture');
    const lexical=await c.search(uiRequest('REQ-LIFE-1',1));assert.ok(lexical.ok&&lexical.value.hits.length>0);
    const g=c.prepareGeneration(),r=c.prepareRerank();
    const space:EmbeddingSpace={...reloadFixtureConfig.identity,dimension:3,normalization:'unit-l2',
      serializationId:'utf8-verbatim-v1',queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
    const submit={apiVersion:1,operation:'submit',request:{protocolVersion:2,requestId:'terminal-d8',
      query:'REQ-LIFE-1',requestedMode:'dense',matchMode:'terms',scope:['fixture.md'],limit:1},space};
    const staged=await p.denseApi.request(submit);
    assert.ok(staged.ok&&staged.value&&'operationId' in staged.value);
    const operationId=staged.value.operationId;
    await denseMachine.review(owner);assert.equal(denseUi.snapshot(owner).phase,'preview');
    const engine=p.standalone!,search=engine.search.bind(engine);
    Object.assign(engine,{search:(input:SearchRequest)=>{dispatches++;return search(input);}});
    Object.assign(p,{verifyAiEvidence:async()=>{reads++;throw Error('unexpected verification');}});
    const nav=new SourceNavigator({read:async()=>{navReads++;return Buffer.from('unexpected');}},
      {exact:()=>{navReads++;return file;},open:async()=>{throw Error('unexpected navigation');}});
    Object.assign(p,{navigator:nav});
    const denied=(action:()=>unknown):boolean=>{try{action();return false;}catch{return true;}};
    const observe=(source:string):void=>{
      observations.push(source);
      const closed=c.sharedAuthorityTransition()&&!c.isEvidencePreviewCurrent('generation',g.sequence)
        &&!c.isEvidencePreviewCurrent('reranking',r.sequence)&&denied(()=>c.prepareGeneration())&&denied(()=>c.prepareRerank())
        &&c.snapshot().response===null&&c.evidenceOperationStatus('generation').phase==='idle'
        &&c.evidenceOperationStatus('reranking').phase==='idle'&&!denseMachine.pending()&&!denseMachine.owns(owner)
        &&denseUi.snapshot(owner).phase==='idle'&&denseUi.operationStatus().phase==='idle'&&!denseUi.occupied()
        &&!c.control('rebuild').ok;
      if(!closed)observations.push('PARTIAL_TERMINAL_STATE');
      replies.push(c.generationConfirmed(g,'synthetic','fixture').then(()=>true,()=>false),
        c.rerankConfirmed(r,'synthetic','fixture').then(()=>true,()=>false),
        c.search(uiRequest('REQ-LIFE-1',1)).then(v=>v.ok),c.open(0).then(v=>v.ok),
        nav.open(lexical.value.hits[0]!).then(()=>true,()=>false),
        p.denseApi.request(submit).then(v=>v.ok),
        p.denseApi.request({apiVersion:1,operation:'status',operationId}).then(v=>v.ok));
      p.onunload(); // terminal teardown must be reentrantly idempotent
    };
    denseMachine.subscribe(()=>{throwing++;throw Error('synthetic terminal observer failure');});
    denseMachine.subscribe(()=>observe('D8'));denseUi.subscribe(()=>observe('dense'));
    c.subscribe(()=>observe('lexical'));c.subscribeEvidence(()=>{evidenceNotifications++;});
    Object.assign(p,{resultModal:{close:()=>observe('modal')}});
    Object.assign(p.app.workspace,{detachLeavesOfType:()=>observe('detach')});
    p.onunload();p.onunload();
    assert.deepEqual([...new Set(observations)].sort(),['D8','dense','detach','lexical','modal']);
    assert.equal(throwing,1);assert.equal(evidenceNotifications,0);
    assert.ok((await Promise.all(replies)).every(v=>v===false));
    assert.equal(dispatches,0);assert.equal(reads,0);assert.equal(navReads,0);
  }finally{await f.cleanup();}
});

test('B-R2-LIFE-14: abort callbacks of both active evidence roles see sealed sibling authorities',async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController;
  const {denseUi,denseMachine}=p as unknown as {denseUi:DenseUiController;denseMachine:import('../plugin/src/ai/dense-machine').DenseMachine};
  const gate=deferredDrain(),entered=deferredDrain();
  let reads=0,http=0;
  const server=createServer((_req,res)=>{http++;res.writeHead(500);res.end();});
  const observations:boolean[]=[],newReplies:Promise<boolean>[]=[];
  const active:Promise<void>[]=[];
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const addr=server.address();assert.ok(addr&&typeof addr!=='string');
    const cfg={...reloadFixtureConfig,origin:'http://127.0.0.1:'+addr.port};
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    await p.patchSettings(s=>{s.ai.generation=cfg;s.ai.reranking=cfg;s.ai.embedding=cfg;});
    const profiles=c as unknown as {rerankProfiles:{installSyntheticFixture(config:typeof cfg,scopeId:string,fixtureId:string):unknown};rerankPort:{scopeId():string}};
    profiles.rerankProfiles.installSyntheticFixture(cfg,profiles.rerankPort.scopeId(),'terminal-active-fixture');
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const g=c.prepareGeneration(),r=c.prepareRerank();
    Object.assign(p,{verifyAiEvidence:async()=>{reads++;if(reads===2)entered.release();await gate.promise;}});
    active.push(c.generationConfirmed(g,'synthetic','fixture'),c.rerankConfirmed(r,'synthetic','fixture'));
    await navigationWatchdog(entered.promise);
    const authority=c as unknown as {activeEvidence:Record<'generation'|'reranking',{abort:AbortController}>};
    for(const role of ['generation','reranking'] as const){
      authority.activeEvidence[role].abort.signal.addEventListener('abort',()=>{
        observations.push(c.sharedAuthorityTransition()&&c.snapshot().response===null
          &&c.evidenceOperationStatus('generation').phase==='idle'&&c.evidenceOperationStatus('reranking').phase==='idle'
          &&denseUi.isDisposed()&&!denseMachine.pending());
        newReplies.push(c.search(uiRequest('late',1)).then(v=>v.ok));
      },{once:true});
    }
    p.onunload();gate.release();await navigationWatchdog(Promise.all(active));
    assert.deepEqual(observations,[true,true]);assert.deepEqual(await Promise.all(newReplies),[false,false]);
    assert.equal(reads,2);assert.equal(http,0);
  }finally{
    gate.release();await Promise.allSettled(active);await f.cleanup();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

// A synchronous abort callback is a publication boundary even when the
// operation which caused it is not itself an unload.
for (const role of ['generation','reranking'] as const) {
  for (const action of ['search','cancel','invalidate','control','settings'] as const) {
    test(`B-R2-LIFE-15: ${role} abort during ${action} cannot reopen terminal state`,async()=>{
      const f=await fixture(),p=f.plugin,c=p.searchController;
      const active:Promise<void>[]=[];
      let callbacks=0,dispatches=0,saves=0;
      try {
        await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
        await p.patchSettings(s=>{s.ai.generation=reloadFixtureConfig;s.ai.reranking=reloadFixtureConfig;});
        const profiles=c as unknown as {rerankProfiles:{installSyntheticFixture(config:typeof reloadFixtureConfig,scopeId:string,fixtureId:string):unknown};rerankPort:{scopeId():string}};
        profiles.rerankProfiles.installSyntheticFixture(reloadFixtureConfig,profiles.rerankPort.scopeId(),'abort-reset-fixture');
        assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
        const g=c.prepareGeneration(),r=c.prepareRerank();
        Object.assign(p,{verifyAiEvidence:async()=>{throw Error('synthetic stop before HTTP');}});
        active.push(role==='generation'?c.generationConfirmed(g,'synthetic','fixture'):c.rerankConfirmed(r,'synthetic','fixture'));
        const internals=c as unknown as {activeEvidence:Record<typeof role,{abort:AbortController}>;pending?:unknown};
        const engine=p.standalone!,search=engine.search.bind(engine),save=p.saveData.bind(p);
        Object.assign(engine,{search:(input:SearchRequest)=>{dispatches++;return search(input);}});
        Object.assign(p,{saveData:(value:unknown)=>{saves++;return save(value);}});
        internals.activeEvidence[role].abort.signal.addEventListener('abort',()=>{callbacks++;p.onunload();},{once:true});
        if(action==='search'){
          const result=await navigationWatchdog(c.search(uiRequest('REQ-LIFE-1',1)));
          assert.ok(!result.ok&&result.error==='SUPERSEDED');
        }else if(action==='cancel'){
          if(role==='generation')c.cancelGeneration();else c.cancelRerank();
        }else if(action==='invalidate'){c.invalidate();}
        else if(action==='control'){assert.ok(!c.control('rebuild').ok);}
        else {await navigationWatchdog(p.patchSettings(s=>{s.ai.generation={state:'disabled'};}));}
        await navigationWatchdog(Promise.all(active));
        assert.equal(callbacks,1);assert.equal(c.snapshot().phase,'idle');
        assert.equal(c.snapshot().response,null);assert.equal(internals.pending,undefined);
        assert.equal(c.sharedAuthorityTransition(),true);
        assert.equal(c.isEvidencePreviewCurrent('generation',g.sequence),false);
        assert.equal(c.isEvidencePreviewCurrent('reranking',r.sequence),false);
        assert.equal(dispatches,0);assert.equal(saves,0);
      }finally{await Promise.allSettled(active);await f.cleanup();}
    });
  }
  test(`B-R2-LIFE-15: nested lexical search during ${role} abort wins without premature dispatch`,async()=>{
    const f=await fixture(),p=f.plugin,c=p.searchController;
    let operation:Promise<void>|undefined,nested:ReturnType<typeof c.search>|undefined;
    let dispatches=0,inside=0,closed=false,otherCurrent=true,controlOk=true;
    try {
      await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
      await p.patchSettings(s=>{s.ai.generation=reloadFixtureConfig;s.ai.reranking=reloadFixtureConfig;});
      const profiles=c as unknown as {rerankProfiles:{installSyntheticFixture(config:typeof reloadFixtureConfig,scopeId:string,fixtureId:string):unknown};rerankPort:{scopeId():string}};
      profiles.rerankProfiles.installSyntheticFixture(reloadFixtureConfig,profiles.rerankPort.scopeId(),'nested-abort-fixture');
      assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
      const g=c.prepareGeneration(),r=c.prepareRerank();
      Object.assign(p,{verifyAiEvidence:async()=>{throw Error('synthetic stop before HTTP');}});
      operation=role==='generation'?c.generationConfirmed(g,'synthetic','fixture'):c.rerankConfirmed(r,'synthetic','fixture');
      const engine=p.standalone!,search=engine.search.bind(engine);
      Object.assign(engine,{search:(input:SearchRequest)=>{dispatches++;return search(input);}});
      const internals=c as unknown as {activeEvidence:Record<typeof role,{abort:AbortController}>};
      internals.activeEvidence[role].abort.signal.addEventListener('abort',()=>{
        closed=c.sharedAuthorityTransition();
        otherCurrent=c.isEvidencePreviewCurrent(role==='generation'?'reranking':'generation',role==='generation'?r.sequence:g.sequence);
        controlOk=c.control('rebuild').ok;
        nested=c.search(uiRequest('Synthetic',1));inside=dispatches;
      },{once:true});
      const outer=await navigationWatchdog(c.search(uiRequest('REQ-LIFE-1',1)));
      assert.ok(!outer.ok&&outer.error==='SUPERSEDED');
      assert.ok(nested);const winner=await navigationWatchdog(nested);assert.ok(winner.ok);
      assert.equal(closed,true);assert.equal(otherCurrent,false);assert.equal(controlOk,false);
      assert.equal(inside,0);assert.equal(dispatches,1);assert.equal(c.snapshot().phase,'results');
      await navigationWatchdog(operation);
    }finally{await operation;await f.cleanup();}
  });
}

// Exercise the production wiring with a real source-backed preview. The completed
// result uses a controlled host response; no inference or HTTP is required.
for (const role of ['generation','reranking'] as const) {
  for (const phase of ['preview','complete'] as const) {
    test(`B-R2-LIFE-16: ${role} shared abort revokes ${phase} and D8 ownership before callback`,async()=>{
      const f=await fixture(),p=f.plugin,c=p.searchController;
      const {denseUi,denseMachine}=p as unknown as {denseUi:DenseUiController;denseMachine:import('../plugin/src/ai/dense-machine').DenseMachine};
      const file=Object.assign(new Empty(),{path:'fixture.md'}),owner=Symbol('life16');
      Object.assign(p.app.vault,{getMarkdownFiles:()=>[file],getAbstractFileByPath:(path:string)=>path===file.path?file:null});
      let active:Promise<void>|undefined;
      const replies:Promise<unknown>[]=[];
      const observations:boolean[]=[];
      try{
        await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
        await p.patchSettings(s=>{s.ai.generation=reloadFixtureConfig;s.ai.reranking=reloadFixtureConfig;s.ai.embedding=reloadFixtureConfig;});
        const profiles=c as unknown as {rerankProfiles:{installSyntheticFixture(config:typeof reloadFixtureConfig,scopeId:string,fixtureId:string):unknown};rerankPort:{scopeId():string}};
        profiles.rerankProfiles.installSyntheticFixture(reloadFixtureConfig,profiles.rerankPort.scopeId(),'life16-fixture');
        const lexical=await c.search(uiRequest('REQ-LIFE-1',1));assert.ok(lexical.ok&&lexical.value.hits.length);
        const space:EmbeddingSpace={...reloadFixtureConfig.identity,dimension:3,normalization:'unit-l2',serializationId:'utf8-verbatim-v1',queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
        const staged=await p.denseApi.request({apiVersion:1,operation:'submit',request:{protocolVersion:2,requestId:'life16-d8',query:'REQ-LIFE-1',requestedMode:'dense',matchMode:'terms',scope:['fixture.md'],limit:1},space});
        assert.ok(staged.ok&&staged.value&&'operationId' in staged.value);
        const operationId=staged.value.operationId;
        const rendered:string[]=[];const off=denseUi.subscribe(()=>rendered.push(denseUi.snapshot(owner).phase));
        await denseMachine.review(owner);
        const preview=denseUi.snapshot(owner);assert.ok(preview.phase==='preview'&&preview.preview.evidence.length);
        if(phase==='complete'){
          const host=(p as unknown as {denseHost:ApiDenseHost}).denseHost;
          const evidence=lexical.value.hits[0]!;
          const result:import('../plugin/src/ai/dense-retrieval').ApiRetrievalResult={version:1,requestedMode:'dense',executedMode:'dense',status:'ok',error:null,indexGenerationId:'fixture-dense',lexicalGenerationId:lexical.value.indexGenerationId,hits:[{evidence,rank:1,denseRank:1,denseSimilarity:1,lexicalRank:null,lexicalScore:null,rrfScore:null}],legs:{dense:{status:'ready',candidateCount:1},lexical:{status:'unavailable',candidateCount:0}}};
          Object.assign(host,{confirm:async()=>result});
          await denseUi.confirm(owner,preview.preview.nonce,'synthetic','fixture');
        }
        assert.equal(denseUi.snapshot(owner).phase,phase);assert.equal(rendered.at(-1),phase);
        assert.equal(denseMachine.owns(owner),true);
        const start=()=>role==='generation'?c.generationConfirmed(c.prepareGeneration(),'synthetic','fixture'):c.rerankConfirmed(c.prepareRerank(),'synthetic','fixture');
        Object.assign(p,{verifyAiEvidence:async()=>{throw Error('synthetic stop before HTTP');}});
        const internals=c as unknown as {activeEvidence:Record<typeof role,{abort:AbortController}>};
        const visible=()=>denseUi.owns(owner)&&denseMachine.owns(owner)&&denseUi.snapshot(owner).phase===phase;
        active=start();let localVisible=false;
        internals.activeEvidence[role].abort.signal.addEventListener('abort',()=>{localVisible=visible();},{once:true});
        if(role==='generation')c.cancelGeneration();else c.cancelRerank();
        await active;assert.equal(localVisible,true);assert.equal(visible(),true);
        active=start();
        const observe=()=>{
          observations.push(c.sharedAuthorityTransition()&&c.snapshot().response===null&&denseUi.snapshot(owner).phase==='idle'
            &&denseUi.metadata(owner).phase==='idle'&&denseUi.operationStatus().phase==='idle'&&!denseUi.owns(owner)&&!denseUi.occupied()
            &&!denseMachine.owns(owner)&&!denseMachine.pending());
          replies.push(p.denseApi.request({apiVersion:1,operation:'status',operationId}),p.denseApi.request({apiVersion:1,operation:'result',operationId}));
        };
        internals.activeEvidence[role].abort.signal.addEventListener('abort',observe,{once:true});
        const machineSlot=(denseMachine as unknown as {slot:{abort:AbortController}}).slot;
        machineSlot.abort.signal.addEventListener('abort',observe,{once:true});
        assert.equal((await navigationWatchdog(c.search(uiRequest('REQ-LIFE-1',1)))).ok,true);
        await active;off();
        assert.deepEqual(observations,[true,true]);
        assert.deepEqual(await Promise.all(replies),Array.from({length:4},()=>({apiVersion:1,ok:false,error:'INVALID_OPERATION'})));
        assert.equal(denseUi.snapshot(owner).phase,'idle');
        assert.equal(denseMachine.owns(owner),false);
      }finally{await active;await f.cleanup();}
    });
  }
}

test('B-R2-LIFE-16: source event dense abort cannot expose lexical evidence or old ownership',async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController;
  const {denseUi,denseMachine}=p as unknown as {denseUi:DenseUiController;denseMachine:import('../plugin/src/ai/dense-machine').DenseMachine};
  const owner=Symbol('source-event'),file=Object.assign(new Empty(),{path:'fixture.md'});
  const events=new Map<string,(changed:{path:string},oldPath?:string)=>void>();
  Object.assign(p.app.vault,{getMarkdownFiles:()=>[file],getAbstractFileByPath:(path:string)=>path===file.path?file:null,
    on:(name:string,callback:(changed:{path:string},oldPath?:string)=>void)=>{events.set(name,callback);return {};}});
  try{
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    await p.patchSettings(s=>{s.ai.generation=reloadFixtureConfig;s.ai.embedding=reloadFixtureConfig;});
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const preview=c.prepareGeneration();
    const space:EmbeddingSpace={...reloadFixtureConfig.identity,dimension:3,normalization:'unit-l2',serializationId:'utf8-verbatim-v1',queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
    const staged=await p.denseApi.request({apiVersion:1,operation:'submit',request:{protocolVersion:2,requestId:'life16-source',query:'REQ-LIFE-1',requestedMode:'dense',matchMode:'terms',scope:['fixture.md'],limit:1},space});
    assert.ok(staged.ok&&staged.value&&'operationId' in staged.value);
    await denseMachine.review(owner);assert.equal(denseUi.snapshot(owner).phase,'preview');
    const dense=(p as unknown as {denseHost:{abort:AbortController}}).denseHost;
    let observed=false,callbacks=0;
    dense.abort.signal.addEventListener('abort',()=>{callbacks++;observed=c.sharedAuthorityTransition()&&c.snapshot().response===null
      &&!c.isEvidencePreviewCurrent('generation',preview.sequence)&&!denseUi.owns(owner)&&!denseMachine.owns(owner)&&denseUi.snapshot(owner).phase==='idle';},{once:true});
    events.get('modify')!(file);
    assert.equal(callbacks,1);assert.equal(observed,true);
    assert.equal(denseUi.snapshot(owner).phase,'idle');
    await p.standalone!.whenIdle();assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
  }finally{await f.cleanup();}
});

const sourceRetirementLabels=['lexical:new.md','lexical:fixture.md','dense:new.md,fixture.md',
  'ingestion:new.md','retrieval:new.md','ingestion:fixture.md','retrieval:fixture.md'] as const;
for(const label of sourceRetirementLabels) for(const afterEffect of [false,true]){
  test('LIFE-17 source transaction: '+label+' fault '+(afterEffect?'after':'before')+' side effect',async()=>{
    const f=await fixture(),p=f.plugin,c=p.searchController;
    const events=new Map<string,(changed:{path:string},oldPath?:string)=>void>();
    const file=Object.assign(new Empty(),{path:'fixture.md'});
    Object.assign(p.app.vault,{getMarkdownFiles:()=>[file],getAbstractFileByPath:(path:string)=>path===file.path?file:null,
      on:(name:string,callback:(changed:{path:string},oldPath?:string)=>void)=>{events.set(name,callback);return {};}});
    const calls:string[]=[],observations:boolean[]=[],nested:ReturnType<typeof c.search>[]=[];
    let fault=true,inside=false;
    try{
      await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
      await p.patchSettings(s=>{s.ai.generation=reloadFixtureConfig;s.ai.embedding=reloadFixtureConfig;});
      assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
      const preview=c.prepareGeneration();
      const {denseHost,denseUi}=p as unknown as {denseHost:ApiDenseHost;denseUi:DenseUiController};
      const owner=Symbol('retirement');
      const space:EmbeddingSpace={...reloadFixtureConfig.identity,dimension:3,normalization:'unit-l2',
        serializationId:'utf8-verbatim-v1',queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
      await denseUi.prepare(owner,{kind:'rebuild',paths:['fixture.md'],space});
      assert.equal(denseUi.snapshot(owner).phase,'preview');
      const epoch=c.sourceAuthorityRevision();
      const wrap=(name:string,effect:()=>void):void=>{
        if(name==='dense:'){effect();return;} // generic host retirement is not a source-path obligation
        calls.push(name);
        observations.push(c.sharedAuthorityTransition()&&!c.sourceAuthorityCurrent(epoch)
          &&c.snapshot().response===null&&!c.isEvidencePreviewCurrent('generation',preview.sequence)&&!denseUi.owns(owner));
        if(name===label&&fault){
          if(afterEffect)effect();
          if(!inside){
            inside=true;
            nested.push(c.search(uiRequest('nested',1)));
            assert.equal(c.control('rebuild').ok,false);
            c.invalidate();
            inside=false;
          }
          throw Error('synthetic retirement failure');
        }
        effect();
      };
      const engine=p.standalone!,changed=engine.changed.bind(engine),dense=denseHost.invalidateSources.bind(denseHost);
      const ingest=p.advancedIngestion.invalidate.bind(p.advancedIngestion),retrieve=p.advancedRetrieval.invalidate.bind(p.advancedRetrieval);
      engine.changed=(path?:string)=>wrap('lexical:'+path,()=>changed(path));
      denseHost.invalidateSources=paths=>wrap('dense:'+paths.join(','),()=>dense(paths));
      p.advancedIngestion.invalidate=path=>wrap('ingestion:'+path,()=>ingest(path));
      p.advancedRetrieval.invalidate=path=>wrap('retrieval:'+path,()=>retrieve(path));
      events.get('rename')!({path:'new.md'},'fixture.md');
      assert.deepEqual(calls,sourceRetirementLabels);
      assert.ok(observations.every(Boolean));
      assert.equal(c.sharedAuthorityTransition(),true);
      assert.equal(c.snapshot().phase,'error');
      assert.equal((await navigationWatchdog(nested[0]!)).ok,false);
      assert.equal((await c.search(uiRequest('denied',1))).ok,false);
      c.invalidate();assert.equal(c.snapshot().phase,'error');
      await assert.rejects(p.patchSettings(s=>{s.topK=2;}),/INTERNAL_FAILURE/);
      assert.deepEqual(calls,sourceRetirementLabels);
      assert.equal(c.control('rebuild').ok,false);
      assert.deepEqual(calls,[...sourceRetirementLabels,label]);
      fault=false;
      assert.equal(c.control('rebuild').ok,true);
      assert.deepEqual(calls.slice(0,sourceRetirementLabels.length+2),[...sourceRetirementLabels,label,label]);
      assert.equal(c.sharedAuthorityTransition(),false);
      assert.equal(c.sourceAuthorityCurrent(epoch),false);
      assert.equal(c.sourceAuthorityCurrent(c.sourceAuthorityRevision()),true);
      assert.equal(c.isEvidencePreviewCurrent('generation',preview.sequence),false);
      await engine.whenIdle();
      assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    }finally{fault=false;await f.cleanup();}
  });
}

test('LIFE-17 nested source event retains multiple failed obligations; terminal unload seals before callbacks',async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController;
  const events=new Map<string,(changed:{path:string},oldPath?:string)=>void>();
  Object.assign(p.app.vault,{on:(name:string,callback:(changed:{path:string},oldPath?:string)=>void)=>{events.set(name,callback);return {};}});
  const calls:string[]=[];let nest=true,fail=true;
  try{
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    const engine=p.standalone!,original=engine.changed.bind(engine);
    engine.changed=path=>{
      calls.push(String(path));
      assert.equal(c.sharedAuthorityTransition(),true);
      if(nest){nest=false;events.get('modify')!({path:'nested.md'});}
      if(fail&&(path==='new.md'||path==='nested.md'))throw Error('synthetic');
      original(path);
    };
    events.get('rename')!({path:'new.md'},'fixture.md');
    assert.deepEqual(calls,['new.md','fixture.md','nested.md']);
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal(c.control('rebuild').ok,false);
    assert.deepEqual(calls,['new.md','fixture.md','nested.md','new.md','nested.md']);
    fail=false;
    engine.changed=path=>{calls.push(String(path));p.onunload();};
    assert.equal(c.control('rebuild').ok,false);
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal((await c.search(uiRequest('terminal',1))).ok,false);
    assert.equal(c.sourceAuthorityCurrent(c.sourceAuthorityRevision()),false);
    assert.deepEqual(calls,['new.md','fixture.md','nested.md','new.md','nested.md','new.md']);
  }finally{await f.cleanup();}
});

test('LIFE-17 shared retirement retains failed evidence abort and attempts independent sibling',async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController;
  const gate=deferredDrain(),entered=deferredDrain();
  let reads=0,http=0,fault=true;
  const calls:string[]=[],active:Promise<void>[]=[];
  const server=createServer((_req,res)=>{http++;res.writeHead(500);res.end();});
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const addr=server.address();assert.ok(addr&&typeof addr!=='string');
    const cfg={...reloadFixtureConfig,origin:'http://127.0.0.1:'+addr.port};
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    await p.patchSettings(s=>{s.ai.generation=cfg;s.ai.reranking=cfg;});
    const profiles=c as unknown as {rerankProfiles:{installSyntheticFixture(config:typeof cfg,scopeId:string,fixtureId:string):unknown};rerankPort:{scopeId():string}};
    profiles.rerankProfiles.installSyntheticFixture(cfg,profiles.rerankPort.scopeId(),'shared-abort-fault');
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const g=c.prepareGeneration(),r=c.prepareRerank();
    Object.assign(p,{verifyAiEvidence:async()=>{if(++reads===2)entered.release();await gate.promise;}});
    active.push(c.generationConfirmed(g,'synthetic','fixture'),c.rerankConfirmed(r,'synthetic','fixture'));
    await navigationWatchdog(entered.promise);
    const {activeEvidence}=c as unknown as {activeEvidence:Record<'generation'|'reranking',{abort:AbortController}>};
    for(const role of ['reranking','generation'] as const){
      const owner=activeEvidence[role].abort,original=owner.abort.bind(owner);
      owner.abort=()=>{
        calls.push(role);
        assert.equal(c.sharedAuthorityTransition(),true);
        assert.equal(c.snapshot().response,null);
        assert.equal(c.isEvidencePreviewCurrent('generation',g.sequence),false);
        assert.equal(c.isEvidencePreviewCurrent('reranking',r.sequence),false);
        if(role==='reranking'&&fault)throw Error('synthetic abort retirement fault');
        original();
      };
    }
    c.invalidate();
    assert.deepEqual(calls,['reranking','generation']);
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal(c.snapshot().phase,'error');
    assert.equal(c.status().status,'failed');
    assert.equal((await c.search(uiRequest('blocked',1))).ok,false);
    gate.release();await navigationWatchdog(Promise.all(active));assert.equal(http,0);
    assert.equal(c.control('rebuild').ok,false);
    assert.deepEqual(calls,['reranking','generation','reranking']);
    fault=false;assert.equal(c.control('rebuild').ok,true);
    assert.deepEqual(calls,['reranking','generation','reranking','reranking']);
    await p.standalone!.whenIdle();
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
  }finally{
    fault=false;gate.release();await Promise.allSettled(active);await f.cleanup();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

for(const failedPath of ['new.md','fixture.md'])test('LIFE-17 dense store retirement attempts both paths despite '+failedPath+' fault',async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController;
  const events=new Map<string,(changed:{path:string},oldPath?:string)=>void>();
  Object.assign(p.app.vault,{on:(name:string,callback:(changed:{path:string},oldPath?:string)=>void)=>{events.set(name,callback);return {};}});
  const calls:string[]=[];let fault=true;
  try{
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    const host=(p as unknown as {denseHost:{store?:{revoke(path:string):void}}}).denseHost;
    const previous=host.store;
    host.store={revoke(path){
      calls.push(path);assert.equal(c.sharedAuthorityTransition(),true);
      if(fault&&path===failedPath)throw Error('synthetic store retirement failure');
    }};
    try{
      events.get('rename')!({path:'new.md'},'fixture.md');
      assert.deepEqual(calls,['new.md','fixture.md']);
      assert.equal(c.sharedAuthorityTransition(),true);
      assert.equal(c.status().status,'failed');
      assert.equal((await c.search(uiRequest('denied',1))).ok,false);
      fault=false;assert.equal(c.control('rebuild').ok,true);
      assert.deepEqual(calls,['new.md','fixture.md','new.md','fixture.md']);
      assert.equal(c.sharedAuthorityTransition(),false);
    }finally{host.store=previous;}
  }finally{await f.cleanup();}
});

for(const role of ['reranking','generation'] as const)
test('systemic role-local failed abort preserves independent role and Basic: '+role,async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController;
  const gate=deferredDrain(),entered=deferredDrain();
  const server=createServer((_req,res)=>{res.writeHead(500);res.end();});
  let active:Promise<void>|undefined,fault=true,attempts=0;
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const addr=server.address();assert.ok(addr&&typeof addr!=='string');
    const cfg={...reloadFixtureConfig,origin:'http://127.0.0.1:'+addr.port};
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    await p.patchSettings(s=>{s.ai.generation=cfg;s.ai.reranking=cfg;});
    const profiles=c as unknown as {rerankProfiles:{installSyntheticFixture(config:typeof cfg,scopeId:string,fixtureId:string):unknown};rerankPort:{scopeId():string}};
    profiles.rerankProfiles.installSyntheticFixture(cfg,profiles.rerankPort.scopeId(),'local-abort-fault');
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    const generation=c.prepareGeneration(),reranking=c.prepareRerank();
    const other=role==='generation'?'reranking':'generation',otherPreview=role==='generation'?reranking:generation;
    const cancel=()=>role==='generation'?c.cancelGeneration():c.cancelRerank();
    Object.assign(p,{verifyAiEvidence:async()=>{entered.release();await gate.promise;}});
    active=role==='generation'?c.generationConfirmed(generation,'synthetic','fixture'):c.rerankConfirmed(reranking,'synthetic','fixture');
    await navigationWatchdog(entered.promise);
    const {activeEvidence}=c as unknown as {activeEvidence:Record<typeof role,{abort:AbortController}>};
    const owner=activeEvidence[role].abort,original=owner.abort.bind(owner);
    owner.abort=()=>{
      attempts++;
      assert.equal(c.sharedAuthorityTransition(),false);
      if(fault){cancel();throw Error('synthetic role-local abort fault');}
      original();
    };
    cancel();assert.equal(attempts,1);
    assert.equal(c.isEvidencePreviewCurrent(other,otherPreview.sequence),true);
    assert.equal(c.sharedAuthorityTransition(),false);
    assert.equal(c.evidenceOperationStatus(role).phase,'failed');
    gate.release();await navigationWatchdog(active);
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    assert.equal(attempts,1);
    assert.throws(()=>role==='generation'?c.prepareGeneration():c.prepareRerank(),/NOT_READY/);
    cancel();assert.equal(attempts,2);
    fault=false;cancel();assert.equal(attempts,3);
    assert.ok(role==='generation'?c.prepareGeneration():c.prepareRerank());
  }finally{
    fault=false;gate.release();await active?.catch(()=>{});await f.cleanup();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

for(const failed of [false,true])
test('systemic Advanced asynchronous source drain fences shared admission and reload: '+failed,async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController,gate=deferredDrain();
  const events=new Map<string,(file:{path:string})=>void>();
  Object.assign(p.app.vault,{on:(name:string,cb:(file:{path:string})=>void)=>{events.set(name,cb);return {};}});
  let replacement:InstanceType<typeof PluginClass>|undefined;
  const ingestion=p.advancedIngestion;
  const stop=ingestion.runner.stop.bind(ingestion.runner);
  const internals=ingestion as unknown as {active?:Promise<void>;activePath?:string;controller?:AbortController};
  try{
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    await p.patchSettings(enableLegacy);
    internals.active=gate.promise;internals.activePath='fixture.md';internals.controller=new AbortController();
    let attempts=0;
    ingestion.runner.stop=()=>{attempts++;return gate.promise;};
    events.get('modify')!({path:'fixture.md'});
    assert.equal(attempts,1);assert.equal(internals.controller.signal.aborted,true);
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,false);
    assert.equal(c.control('rebuild').ok,false);
    if(failed)gate.reject(Error('synthetic process drain failed'));else gate.release();
    await gate.promise.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));
    internals.active=undefined;internals.activePath=undefined;
    ingestion.runner.stop=stop;
    if(!failed){
      assert.equal(c.sharedAuthorityTransition(),false);
      await p.standalone!.whenIdle();
      assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    }else{
      assert.equal(c.sharedAuthorityTransition(),true);
      assert.equal(c.control('rebuild').ok,false);
      p.onunload();replacement=replacementPlugin(f);
      await replacement.onload();f.layout();
      await (replacement as unknown as {initializing:Promise<void>}).initializing;
      await replacement.standalone!.whenIdle();
      assert.equal((await replacement.searchController.search(uiRequest('REQ-LIFE-1',1))).ok,true);
      let calls=0;replacement.advancedRetrieval.search=async()=>{calls++;throw Error('unexpected admission');};
      await assert.rejects(replacement.searchAdvanced(legacyQuery),/MODEL_UNAVAILABLE/);
      assert.equal(calls,0);
    }
  }finally{
    gate.release();internals.active=undefined;ingestion.runner.stop=stop;
    replacement?.onunload();await f.cleanup();
  }
});

test('systemic unload attempts both Advanced manager drains after rejection',async()=>{
  const f=await fixture(),p=f.plugin;
  try{
    await p.onload();f.layout();await f.internal.initializing;
    const calls:string[]=[];
    p.advancedRetrieval.releaseStorage=async()=>{calls.push('retrieval');throw Error('synthetic');};
    p.advancedIngestion.stop=async()=>{calls.push('ingestion');};
    await assert.rejects((p as unknown as {stopIngestion():Promise<void>}).stopIngestion(),/ADVANCED_UNAVAILABLE/);
    assert.deepEqual(calls,['retrieval','ingestion']);
  }finally{await f.cleanup();}
});

test('systemic standalone shutdown attempts writer drain after navigation disposal throws',async()=>{
  const f=await fixture(),p=f.plugin;
  try{
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    const navigator=(p as unknown as {navigator:SourceNavigator<unknown>}).navigator;
    const original=navigator.dispose.bind(navigator);
    navigator.dispose=()=>{original();throw Error('synthetic');};
    await assert.rejects((p as unknown as {stopStandalone():Promise<void>}).stopStandalone(),/INTERNAL_FAILURE/);
    assert.equal(p.standalone,undefined);
    assert.equal(SyntheticWorker.instances[0]!.terminated,true);
  }finally{await f.cleanup();}
});

test('systemic Dense retirement retries the original store after replacement',async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController;
  const events=new Map<string,(file:{path:string},old?:string)=>void>();
  Object.assign(p.app.vault,{on:(name:string,cb:(file:{path:string},old?:string)=>void)=>{events.set(name,cb);return {};}});
  let fault=true;
  try{
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    const host=(p as unknown as {denseHost:{store?:{revoke(path:string):void}}}).denseHost;
    const previous=host.store,calls:string[]=[];
    host.store={revoke(path){calls.push('old:'+path);if(fault)throw Error('synthetic retirement failure');}};
    try{
      events.get('rename')!({path:'new.md'},'fixture.md');
      assert.equal(c.sharedAuthorityTransition(),true);
      host.store={revoke(path){calls.push('replacement:'+path);}};
      fault=false;assert.equal(c.control('rebuild').ok,true);
      assert.deepEqual(calls,['old:new.md','old:fixture.md','old:new.md','old:fixture.md']);
      assert.equal(c.sharedAuthorityTransition(),false);
    }finally{host.store=previous;}
  }finally{fault=false;await f.cleanup();}
});

test('systemic source retirement fault during persisted settings change preserves durable preferences and runtime fence',async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController;
  const events=new Map<string,(file:{path:string})=>void>();
  Object.assign(p.app.vault,{on:(name:string,cb:(file:{path:string})=>void)=>{events.set(name,cb);return {};}});
  let fault=true;
  const save=p.saveData.bind(p);
  try{
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    const engine=p.standalone!,changed=engine.changed.bind(engine);
    engine.changed=path=>{if(fault)throw Error('synthetic source fault');changed(path);};
    Object.assign(p,{saveData:async(v:unknown)=>{await save(v);events.get('modify')!({path:'fixture.md'});}});
    await assert.rejects(p.patchSettings(s=>{s.enabled=false;}),/INTERNAL_FAILURE/);
    assert.equal(p.settings.enabled,false);
    assert.equal((p as unknown as {saved:{enabled:boolean}}).saved.enabled,false);
    assert.equal(p.standalone,engine,'must not transfer owner while source retirement is unresolved');
    assert.equal(c.sharedAuthorityTransition(),true);
    Object.assign(p,{saveData:save});
    fault=false;
    // Recovery of the old obligation is not a successful settings/control
    // operation. Reapply the committed settings explicitly after it clears.
    assert.equal(c.control('rebuild').ok,false);
    assert.equal(c.sourceAuthorityCurrent(c.sourceAuthorityRevision()),true);
    assert.equal(c.sharedAuthorityTransition(),true);
    await p.updateSettings(structuredClone(p.settings));
    assert.equal(p.standalone,undefined);
    assert.equal(c.sharedAuthorityTransition(),false);
    assert.equal(SyntheticWorker.instances[0]!.terminated,true);
  }finally{fault=false;Object.assign(p,{saveData:save});await f.cleanup();}
});

test('systemic source event nested in generic trusted hook retains failed source obligation',async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController;
  const events=new Map<string,(file:{path:string})=>void>();
  Object.assign(p.app.vault,{on:(name:string,cb:(file:{path:string})=>void)=>{events.set(name,cb);return {};}});
  let fault=true,trigger=true,attempts=0;
  try{
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    const engine=p.standalone!,changed=engine.changed.bind(engine);
    engine.changed=path=>{if(path==='fixture.md'){attempts++;if(fault)throw Error('synthetic nested source fault');}changed(path);};
    const nav=(p as unknown as {navigator:SourceNavigator<unknown>}).navigator,original=nav.invalidate.bind(nav);
    nav.invalidate=()=>{
      original();
      if(trigger){trigger=false;events.get('modify')!({path:'fixture.md'});}
    };
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,false);
    assert.equal(attempts,1);
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal((await c.search(uiRequest('blocked',1))).ok,false);
    assert.equal(attempts,1);
    fault=false;assert.equal(c.control('rebuild').ok,true);
    assert.equal(attempts,2);assert.equal(c.sharedAuthorityTransition(),false);
    await engine.whenIdle();
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
  }finally{fault=false;await f.cleanup();}
});

test('systemic source ledger overflow is terminal-only and Basic reload reconciles original source',async()=>{
  const f=await fixture(),p=f.plugin,c=p.searchController;
  let replacement:InstanceType<typeof PluginClass>|undefined;
  try{
    await p.onload();f.layout();await f.internal.initializing;await p.standalone!.whenIdle();
    assert.equal((await c.search(uiRequest('REQ-LIFE-1',1))).ok,true);
    await writeFile(join(f.vault,'fixture.md'),'# Synthetic\nREQ-LIFE-NEW: changed source.\n');
    let attempts=0;
    c.invalidateSource(Array.from({length:4097},()=>()=>{attempts++;}));
    assert.equal(attempts,4096);
    assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal(c.control('rebuild').ok,false);
    assert.equal((await c.search(uiRequest('REQ-LIFE-NEW',1))).ok,false);
    p.onunload();replacement=replacementPlugin(f);
    await replacement.onload();f.layout();
    await (replacement as unknown as {initializing:Promise<void>}).initializing;
    await replacement.standalone!.whenIdle();
    const result=await replacement.searchController.search(uiRequest('REQ-LIFE-NEW',1));
    assert.ok(result.ok&&result.value.status==='ok');
    assert.equal(result.value.hits.length,1);
    assert.equal(result.value.hits[0]!.originalExcerpt,'REQ-LIFE-NEW: changed source.');
    assert.equal(c.sharedAuthorityTransition(),true);
  }finally{replacement?.onunload();await f.cleanup();}
});
