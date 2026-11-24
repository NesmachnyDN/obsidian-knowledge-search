import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseMarkdown } from '../plugin/src/standalone/markdown';
import { defaultSettings } from '../plugin/src/search/settings';
const TEST_PYTHON = '/usr/bin/python3.12';
// Controlled Node-only host adapter. Actual DOM/editor acceptance remains host smoke.
const Module = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown };
class HostPlugin {
  app: unknown; manifest = { id: 'oks-synthetic-evidence' }; saved: unknown = null;
  loadData(): Promise<unknown> { return Promise.resolve(this.saved); }
  async saveData(value: unknown): Promise<void> { this.saved = value; }
  registerView(): void {} addCommand(): void {} addSettingTab(): void {} registerEvent(): void {}
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
