import { AdvancedHealthBridge } from './advanced/health';
import { FileSystemAdapter, Modal, Notice, Plugin, TFile, type App, type TAbstractFile } from 'obsidian';
import { ProbeController } from './controller';
import { FIXTURE_PATH, type Response } from './protocol';
import { Supervisor } from './supervisor';
import { StandaloneEngine } from './standalone/engine';
import { BoundedVaultReader, privateIndexPath } from './standalone/source';
import { GenerationStore } from './standalone/storage';
import { WorkerMarkdownParser } from './standalone/worker';
import { StandaloneError } from './standalone/contracts';
import { join, resolve } from 'node:path';
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
// Also serialize a cold-disabled cache purge against a new instance's writer.
const pathBarrierKey = Symbol.for('oks.standalone.path-barriers');
const pathHost = globalThis as typeof globalThis & { [pathBarrierKey]?: Map<string, Promise<void>> };
const pathBarriers = pathHost[pathBarrierKey] ??= new Map<string, Promise<void>>();
// Optional stdio worker reload barrier: a new plugin instance cannot start a child
// until the previous instance's owned process group has been stopped.
const advancedBarrierKey = Symbol.for('oks.advanced.close-barriers.v1');
const advancedHost = globalThis as typeof globalThis & { [advancedBarrierKey]?: Map<string, Promise<void>> };
const advancedBarriers = advancedHost[advancedBarrierKey] ??= new Map<string, Promise<void>>();

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
  readonly advancedHealth = new AdvancedHealthBridge();
  private advancedStartup?: Promise<void>;
  readonly searchController = new SearchController(async hit => {
    if (!this.navigator) throw new StandaloneError('NAVIGATION_REJECTED');
    await this.navigator.open(hit);
  }, () => this.advancedHealth.snapshot());
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
    this.addSettingTab(new SearchSettingsTab(this.app, this, () => this.settings, change => this.patchSettings(change), () => this.purgeIndex(),
      () => this.advancedHealth.snapshot(), () => this.checkAdvancedHealth()));
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
      if (!this.unloaded) { void this.initializeStandalone(); void this.initializeAdvanced(); }
    });
  }
  async openSearch(): Promise<void> {
    if (this.unloaded) return;
    const leaf = this.app.workspace.getLeavesOfType(SEARCH_VIEW)[0] ?? this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: SEARCH_VIEW, active: true });
    if (!this.unloaded) await this.app.workspace.revealLeaf(leaf);
  }
  /** Explicit complete replacement (tests/machine adapter); never used by individual settings controls. */
  updateSettings(next: SearchSettings): Promise<void> {
    const snapshot = parseSettings(next);
    return this.queueSettings(() => snapshot);
  }
  /** Apply a field-level change at the dequeue boundary to prevent lost updates. */
  patchSettings(change: (s: SearchSettings) => void): Promise<void> {
    return this.queueSettings(current => { const next = structuredClone(current); change(next); return next; });
  }
  private queueSettings(change: (current: SearchSettings) => SearchSettings): Promise<void> {
    const task = this.settingsQueue.then(async () => {
      if (this.purgeInFlight) await this.purgeInFlight.catch(() => {});
      if (this.unloaded) return;
      const settings = parseSettings(change(this.settings));
      await this.saveData(settings);
      if (this.unloaded) return;
      const before = this.settings;
      this.settings = settings;
      this.standaloneError = null;
      this.searchController.configure(settings.enabled, settings.paused);
      if (JSON.stringify(before.advanced) !== JSON.stringify(settings.advanced)) {
        await this.stopAdvanced();
        if (settings.advanced.enabled && this.layoutReady && !this.unloaded) await this.initializeAdvanced();
      }
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
    if (this.unloaded || this.settings.enabled || this.standalone || this.initializing)
      throw new StandaloneError('LIFECYCLE_INVALID');
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new StandaloneError('UNSUPPORTED_FILESYSTEM');
    const root = adapter.getBasePath();
    const key = resolve(root);
    if (pathBarriers.has(key)) throw new StandaloneError('BUSY');
    const job = this.purgeVerifiedDerivedIndex(root, this.rootId);
    this.purgeInFlight = job;
    // Protect even a fresh plugin reloaded while persisted settings are disabled
    // (no cached rootId yet). Acquire by trusted adapter root before first await.
    const barrier = job.then(() => undefined, () => undefined);
    pathBarriers.set(key, barrier);
    void barrier.then(() => {
      if (this.purgeInFlight === job) this.purgeInFlight = undefined;
      if (pathBarriers.get(key) === barrier) pathBarriers.delete(key);
    });
    return job;
  }
  private async purgeVerifiedDerivedIndex(root: string, expectedRootId?: string): Promise<number> {
    const provider = await BoundedVaultReader.open(root,
      () => this.app.vault.getMarkdownFiles().map(file => file.path));
    // Prior writer may still be closing after a disabled-state transition.
    await barriers.get(provider.rootId);
    if (this.unloaded || this.settings.enabled || this.standalone || this.initializing
        || (expectedRootId !== undefined && expectedRootId !== provider.rootId))
      throw new StandaloneError('LIFECYCLE_INVALID');
    const dir = privateIndexPath(root, provider.rootId, this.manifest.id);
    return purgeDerivedIndex(dir, provider.rootId, dir);
  }
  async controlSearch(action: 'pause' | 'cancel' | 'resume' | 'rebuild'): Promise<void> {
    this.navigator?.invalidate();
    const result = this.searchController.control(action);
    if (!result.ok) { new Notice(`OKS: ${result.error}`); return; }
    try { await this.patchSettings(settings => { settings.paused = action === 'pause' || action === 'cancel'; }); }
    catch { new Notice('OKS: settings could not be saved.'); }
  }
  private stopAdvanced(): Promise<void> {
    const stopping = this.advancedHealth.stop();
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return stopping;
    const key = resolve(adapter.getBasePath());
    const previous = advancedBarriers.get(key);
    const barrier = previous ? Promise.all([previous, stopping]).then(() => undefined) : stopping;
    advancedBarriers.set(key, barrier);
    void barrier.then(() => {
      if (advancedBarriers.get(key) === barrier) advancedBarriers.delete(key);
    }, () => { /* Keep a failed shutdown barrier; never admit a replacement. */ });
    return barrier;
  }
  private async advancedAdmissionAllowed(): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      try { await advancedBarriers.get(resolve(adapter.getBasePath())); }
      catch { this.advancedHealth.blockOnPriorShutdown(); return false; }
    }
    return !this.unloaded && this.settings.advanced.enabled;
  }
  /** Advanced is an independent explicit opt-in; a healthy transport is not a dense-ready leg. */
  private initializeAdvanced(): Promise<void> {
    if (!this.layoutReady || this.unloaded || !this.settings.advanced.enabled) return Promise.resolve();
    if (this.advancedStartup) return this.advancedStartup;
    const config = { ...this.settings.advanced };
    this.advancedStartup = (async () => {
      if (await this.advancedAdmissionAllowed() &&
          JSON.stringify(config) === JSON.stringify(this.settings.advanced))
        await this.advancedHealth.start(config);
    })().finally(() => { this.advancedStartup = undefined; });
    return this.advancedStartup;
  }
  async checkAdvancedHealth(): Promise<void> {
    if (this.unloaded || !this.settings.advanced.enabled) return;
    await this.advancedStartup;
    if (await this.advancedAdmissionAllowed()) await this.advancedHealth.start(this.settings.advanced);
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
      await pathBarriers.get(resolve(root));
      if (!valid()) return;
      const provider = await BoundedVaultReader.open(root, () => this.app.vault.getMarkdownFiles().map(file => file.path));
      if (!valid()) return;
      this.rootId = provider.rootId;
      await barriers.get(provider.rootId);
      await pathBarriers.get(resolve(root));
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
    void this.stopAdvanced().catch(() => { /* failed barrier remains closed to reload */ });
    this.controller = undefined;
  }
}
