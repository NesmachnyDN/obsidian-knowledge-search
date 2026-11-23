import { FileSystemAdapter, Modal, Notice, Plugin, TFile, type App, type TAbstractFile } from 'obsidian';
import { ProbeController } from './controller';
import { FIXTURE_PATH, type Response } from './protocol';
import { Supervisor } from './supervisor';
import { StandaloneEngine } from './standalone/engine';
import { BoundedVaultReader, privateIndexPath } from './standalone/source';
import { GenerationStore } from './standalone/storage';
import { WorkerMarkdownParser } from './standalone/worker';
import { StandaloneError } from './standalone/contracts';
import { join } from 'node:path';
import { SearchController, StandaloneApi } from './search/controller';
import { purgeDerivedIndex } from './search/purge';
import { defaultSettings, parseSettings, type SearchSettings } from './search/settings';
import { SearchSettingsTab } from './search/settings-tab';
import { SearchView, SEARCH_VIEW } from './search/view';
import { obsidianNavigator } from './search/obsidian-navigation';
import type { SourceNavigator } from './search/navigation';

// Reload barrier: the prior writer must finish before a replacement store opens.
const barrierKey = Symbol.for('oks.standalone.close-barriers');
const host = globalThis as typeof globalThis & { [barrierKey]?: Map<string, Promise<void>> };
const barriers = host[barrierKey] ??= new Map<string, Promise<void>>();

class ResultModal extends Modal {
  constructor(app: App, private readonly response: Response) { super(app); }
  onOpen(): void {
    const node = document.createElement('pre');
    const r = this.response;
    node.textContent = !r.ok ? `Probe error: ${r.error.code}` : r.evidence === null ? 'No matching evidence.'
      : `${r.evidence.excerpt}\n\n${FIXTURE_PATH}:${r.evidence.line}\nSHA-256: ${r.evidence.digest}\nRequest: ${r.id}`;
    this.contentEl.appendChild(node);
  }
  onClose(): void { this.contentEl.replaceChildren(); }
}
export default class SyntheticEvidencePlugin extends Plugin {
  settings: SearchSettings = defaultSettings();
  private navigator?: SourceNavigator<TFile>;
  private rootId?: string;
  private initializing?: Promise<void>;
  private layoutReady = false;
  private lifecycleRevision = 0;
  private settingsQueue: Promise<void> = Promise.resolve();
  private purgeInFlight?: Promise<number>;
  readonly searchController = new SearchController(async hit => {
    if (!this.navigator) throw new StandaloneError('NAVIGATION_REJECTED');
    await this.navigator.open(hit);
  });
  readonly api = new StandaloneApi(this.searchController);
  private loaded = false;
  private unloaded = false;
  private controller?: ProbeController;
  private resultModal?: ResultModal;
  // Existing native core; public consumers use the validated api object.
  standalone?: StandaloneEngine;
  standaloneError: string | null = null;
  async onload(): Promise<void> {
    if (this.loaded || this.unloaded) return;
    this.loaded = true;
    let saved: unknown;
    try { saved = await this.loadData(); }
    catch { saved = { version: -1 }; } // Invalid/unreadable settings stay disabled and repairable in settings UI.
    if (this.unloaded) return;
    try { this.settings = parseSettings(saved); }
    catch { this.settings = { ...defaultSettings(), enabled: false }; this.standaloneError = 'SETTINGS_INVALID'; }
    this.searchController.configure(this.settings.enabled, this.settings.paused, this.standaloneError);
    this.registerView(SEARCH_VIEW, leaf => new SearchView(leaf, this.searchController,
      () => this.settings, action => this.controlSearch(action)));
    this.addCommand({ id: 'open-standalone-search', name: 'Open Standalone search', callback: () => { void this.openSearch(); } });
    this.addCommand({ id: 'open-first-search-source', name: 'Verify and open first search source', callback: () => { void this.searchController.open(0); } });
    for (const action of ['pause','resume','cancel','rebuild'] as const)
      this.addCommand({ id: `${action}-standalone`, name: `${action[0]!.toUpperCase() + action.slice(1)} Standalone indexing`,
        callback: () => { void this.controlSearch(action); } });
    this.controller = new ProbeController(new Supervisor(), {
      status: value => { this.resultModal?.close(); new Notice(`Synthetic probe: ${value}`); },
      result: response => { this.resultModal?.close(); this.resultModal = new ResultModal(this.app, response); this.resultModal.open(); },
    });
    this.addSettingTab(new SearchSettingsTab(this.app, this, () => this.settings, settings => this.updateSettings(settings), () => this.purgeIndex()));
    this.addCommand({ id: 'run-synthetic-evidence-probe', name: 'Run synthetic evidence probe', callback: () => { void this.runProbe(); } });
    this.addCommand({ id: 'cancel-synthetic-evidence-probe', name: 'Cancel synthetic evidence probe', callback: () => this.controller?.cancel() });
    const invalidate = (file: TAbstractFile, oldPath?: string): void => {
      const affectsFixture = (path: string): boolean => path === FIXTURE_PATH || FIXTURE_PATH.startsWith(path + '/');
      if (affectsFixture(file.path) || (oldPath !== undefined && affectsFixture(oldPath))) {
        this.controller?.cancel(); this.resultModal?.close();
      }
    };
    this.registerEvent(this.app.vault.on('modify', file => invalidate(file)));
    this.registerEvent(this.app.vault.on('delete', file => invalidate(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => invalidate(file, oldPath)));
    // Changes can arrive before the asynchronous core has opened; startup does
    // a full authoritative reconciliation after the event handlers are registered.
    const nativeChange = (file: TAbstractFile, oldPath?: string): void => {
      this.navigator?.invalidate();
      this.searchController.invalidate();
      this.standalone?.changed(file.path);
      if (oldPath !== undefined) this.standalone?.changed(oldPath);
    };
    this.registerEvent(this.app.vault.on('create', file => nativeChange(file)));
    this.registerEvent(this.app.vault.on('modify', file => nativeChange(file)));
    this.registerEvent(this.app.vault.on('delete', file => nativeChange(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => nativeChange(file, oldPath)));
    this.registerEvent(this.app.metadataCache.on('changed', file => nativeChange(file)));
    // The renderer remains responsive during Obsidian's initial layout/mount.
    // A full reconciliation covers all source changes before layout readiness.
    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      if (!this.unloaded) void this.initializeStandalone();
    });
  }
  async openSearch(): Promise<void> {
    if (this.unloaded) return;
    const leaf = this.app.workspace.getLeavesOfType(SEARCH_VIEW)[0] ?? this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: SEARCH_VIEW, active: true });
    if (!this.unloaded) await this.app.workspace.revealLeaf(leaf);
  }
  updateSettings(next: SearchSettings): Promise<void> {
    const settings = parseSettings(next);
    const task = this.settingsQueue.then(async () => {
      // Never reopen the generation writer while a derived-only purge is in progress.
      if (this.purgeInFlight) await this.purgeInFlight.catch(() => {});
      if (this.unloaded) return;
      await this.saveData(settings);
      if (this.unloaded) return;
      const before = this.settings;
      this.settings = settings;
      this.standaloneError = null;
      this.searchController.configure(settings.enabled, settings.paused);
      if (before.enabled !== settings.enabled) {
        this.lifecycleRevision++;
        await this.stopStandalone();
        await this.initializing;
        if (settings.enabled && this.layoutReady && !this.unloaded) await this.initializeStandalone();
      } else if (this.standalone && before.paused !== settings.paused) {
        if (settings.paused) this.standalone.cancel(); else this.standalone.resume();
      }
    });
    this.settingsQueue = task.catch(() => {});
    return task;
  }
  /** A deliberate disabled-only operation, serialized against restart and reload. */
  async purgeIndex(): Promise<number> {
    if (this.purgeInFlight) throw new StandaloneError('BUSY');
    if (this.unloaded || this.settings.enabled || this.standalone || this.initializing || !this.rootId)
      throw new StandaloneError('LIFECYCLE_INVALID');
    const rootId = this.rootId;
    const job = this.purgeVerifiedDerivedIndex(rootId);
    this.purgeInFlight = job;
    // A new plugin instance must wait before opening the same generation store.
    const barrier = job.then(() => undefined, () => undefined);
    barriers.set(rootId, barrier);
    void barrier.then(() => {
      if (this.purgeInFlight === job) this.purgeInFlight = undefined;
      if (barriers.get(rootId) === barrier) barriers.delete(rootId);
    });
    return job;
  }
  private async purgeVerifiedDerivedIndex(rootId: string): Promise<number> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new StandaloneError('UNSUPPORTED_FILESYSTEM');
    const root = adapter.getBasePath();
    const provider = await BoundedVaultReader.open(root,
      () => this.app.vault.getMarkdownFiles().map(file => file.path));
    if (this.unloaded || this.standalone || this.initializing || provider.rootId !== rootId)
      throw new StandaloneError('LIFECYCLE_INVALID');
    const dir = privateIndexPath(root, provider.rootId, this.manifest.id);
    return purgeDerivedIndex(dir, provider.rootId, dir);
  }
  async controlSearch(action: 'pause' | 'cancel' | 'resume' | 'rebuild'): Promise<void> {
    this.navigator?.invalidate();
    const result = this.searchController.control(action);
    if (!result.ok) { new Notice(`OKS: ${result.error}`); return; }
    try { await this.updateSettings({ ...this.settings, paused: action === 'pause' || action === 'cancel' }); }
    catch { new Notice('OKS: settings could not be saved.'); }
  }
  private initializeStandalone(): Promise<void> {
    if (this.initializing) return this.initializing;
    if (this.unloaded || !this.settings.enabled || this.standalone) return Promise.resolve();
    const revision = this.lifecycleRevision;
    this.initializing = this.startStandalone(revision).finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  private async startStandalone(revision: number): Promise<void> {
    const valid = (): boolean => !this.unloaded && this.settings.enabled && revision === this.lifecycleRevision;
    const adapter = this.app.vault.adapter;
    try {
      if (!(adapter instanceof FileSystemAdapter)) throw new StandaloneError('UNSUPPORTED_FILESYSTEM');
      const root = adapter.getBasePath();
      const provider = await BoundedVaultReader.open(root, () => this.app.vault.getMarkdownFiles().map(file => file.path));
      if (!valid()) return;
      this.rootId = provider.rootId;
      await barriers.get(provider.rootId);
      if (!valid()) return;
      const store = await GenerationStore.open(privateIndexPath(root, provider.rootId, this.manifest.id), provider.rootId);
      if (!valid()) return;
      const parser = new WorkerMarkdownParser(join(root, this.app.vault.configDir, 'plugins', this.manifest.id, 'standalone-worker.js'));
      let engine: StandaloneEngine;
      try { engine = new StandaloneEngine(provider, store, parser); }
      catch (error) { await parser.close(); throw error; }
      this.standalone = engine;
      this.navigator = obsidianNavigator(this.app, provider);
      this.searchController.attach(engine);
      await engine.start();
      if (!valid()) { await this.stopStandalone(); return; }
      if (this.settings.paused) engine.cancel();
    } catch (error) {
      await this.stopStandalone();
      if (valid()) {
        this.standaloneError = error instanceof StandaloneError ? error.code : 'INITIALIZATION_FAILED';
        this.searchController.configure(this.settings.enabled, this.settings.paused, this.standaloneError);
      }
    }
  }
  private async stopStandalone(): Promise<void> {
    this.navigator?.dispose(); this.navigator = undefined;
    this.searchController.detach();
    const engine = this.standalone; this.standalone = undefined;
    if (!engine) return;
    const closing = engine.close();
    if (this.rootId) barriers.set(this.rootId, closing);
    await closing;
    if (this.rootId && barriers.get(this.rootId) === closing) barriers.delete(this.rootId);
  }
  private async runProbe(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) { new Notice('Synthetic probe: UNSUPPORTED_FILESYSTEM'); return; }
    await this.controller?.run({ ...this.settings.probe }, {
      root: adapter.getBasePath(),
      verifyNote: () => {
        const file = this.app.vault.getAbstractFileByPath(FIXTURE_PATH);
        if (!(file instanceof TFile)) throw new Error('FIXTURE_REJECTED');
        if (file.path !== FIXTURE_PATH) throw new Error('FIXTURE_REJECTED');
      },
    });
  }
  onunload(): void {
    this.unloaded = true;
    this.resultModal?.close();
    this.resultModal = undefined;
    void this.controller?.unload();
    this.lifecycleRevision++;
    this.searchController.dispose();
    this.app.workspace.detachLeavesOfType(SEARCH_VIEW);
    void this.stopStandalone();
    this.controller = undefined;
  }
}
