import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdown } from '../plugin/src/standalone/markdown';
import { defaultSettings } from '../plugin/src/search/settings';
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
