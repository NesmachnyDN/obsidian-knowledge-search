import { DenseMachine } from './ai/dense-machine';
import { DenseUiController } from './ai/dense-ui-controller';
import { ApiDenseHost } from './ai/dense-host';
import { AdvancedHealthBridge } from './advanced/health';
import { AdvancedIngestionManager } from './advanced/manager';
import { AdvancedRetrievalManager } from './advanced/retrieval-manager';
import { AdvancedSearchModal } from './advanced/search-modal';
import { ModelError } from './advanced/model-protocol';
import { readSource, trustedVaultRoot } from './advanced/source';
import type { AdvancedEvidenceHit, RetrievalRequest, RetrievalResponse } from './advanced/retrieval';
import { IngestError, type IngestResponse } from './advanced/protocol';
import { FileSystemAdapter, MarkdownView, Modal, Notice, Plugin, TFile, type App, type TAbstractFile } from 'obsidian';
import { ProbeController } from './controller';
import { FIXTURE_PATH, type Response } from './protocol';
import { Supervisor } from './supervisor';
import { StandaloneEngine } from './standalone/engine';
import { BoundedVaultReader, privateIndexPath } from './standalone/source';
import { GenerationStore } from './standalone/storage';
import { WorkerMarkdownParser } from './standalone/worker';
import { StandaloneError, type EvidenceHit } from './standalone/contracts';
import { join, resolve } from 'node:path';
import { SearchController, StandaloneApi } from './search/controller';
import { purgeDerivedIndex } from './search/purge';
import { defaultSettings, parseSettings, type SearchSettings } from './search/settings';
import { SearchSettingsTab } from './search/settings-tab';
import { SearchView, SEARCH_VIEW } from './search/view';
import { obsidianNavigator } from './search/obsidian-navigation';
import { verifySpan, type SourceNavigator } from './search/navigation';

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
// Legacy and API-dense storage owners share a reload-safe drain barrier.
const ingestionBarrierKey = Symbol.for('oks.ingestion.close-barriers.v1');
const ingestionHost = globalThis as typeof globalThis & { [ingestionBarrierKey]?: Map<string, Promise<void>> };
const ingestionBarriers = ingestionHost[ingestionBarrierKey] ??= new Map<string, Promise<void>>();

// A reload must not read a settings snapshot while the old instance can
// still persist a different configuration. Scope to the same Vault/plugin.
const settingsBarrierKey = Symbol.for('oks.settings.close-barriers.v1');
const settingsHost = globalThis as typeof globalThis & { [settingsBarrierKey]?: Map<string, Promise<void>> };
const settingsBarriers = settingsHost[settingsBarrierKey] ??= new Map<string, Promise<void>>();

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
  private sourceReader?: BoundedVaultReader;
  private denseHost?: ApiDenseHost;
  private denseSettingsChanging = false;
  // Retain the last completely applied runtime configuration until a
  // successful save and application reconcile any interrupted transaction.
  private settingsRuntimeBase?: SearchSettings;
  private settingsApplyInterrupted = false;
  private readonly denseUi = new DenseUiController({
    host: () => this.unloaded || this.denseSettingsChanging ? undefined : this.denseHost,
    sharedFence: () => this.unloaded || this.denseSettingsChanging || (this.searchController?.sharedAuthorityTransition() ?? false),
    revokeNavigation: () => this.navigator?.invalidate(),
    navigate: async hit => {
      if (this.unloaded || this.denseSettingsChanging || !this.navigator) throw new StandaloneError('NAVIGATION_REJECTED');
      await this.navigator.open(hit);
    },
  });
  private readonly denseMachine = new DenseMachine(this.denseUi,{
    host:()=>this.unloaded||this.denseSettingsChanging||!this.settings.enabled||this.settings.paused
      ||this.settings.ingestion.enabled?undefined:this.denseHost,
    preference:()=>this.settings.ai.embedding,
  });
  readonly denseApi=Object.freeze({apiVersion:1 as const,request:(input:unknown)=>this.denseMachine.request(input)});
  private rootId?: string;
  private initializing?: Promise<void>;
  private layoutReady = false;
  private lifecycleRevision = 0;
  private settingsQueue: Promise<void> = Promise.resolve();
  private purgeInFlight?: Promise<number>;
  readonly advancedHealth = new AdvancedHealthBridge();
  readonly advancedIngestion = new AdvancedIngestionManager();
  readonly advancedRetrieval = new AdvancedRetrievalManager(this.advancedIngestion);
  private advancedStartup?: Promise<void>;
  readonly searchController: SearchController = new SearchController(async hit => {
    if (this.unloaded || this.denseSettingsChanging || !this.navigator) throw new StandaloneError('NAVIGATION_REJECTED');
    await this.navigator.open(hit);
  }, () => this.advancedHealth.snapshot(), () => this.advancedIngestion.snapshot(), {
    config: () => this.settings.ai.reranking,
    scopeId: () => this.sourceReader?.rootId,
    verify: hit => this.verifyAiEvidence(hit),
  }, {
    config: () => this.settings.ai.generation,
    scopeId: () => this.sourceReader?.rootId,
    verify: hit => this.verifyAiEvidence(hit),
  }, () => this.revokeDenseAuthority());
  private revokeDenseAuthority(): void {
    this.denseUi.authority.revoke(() => {
      // Lexical navigation has its own revision even when both dense owners
      // are idle. Revoke it before any dense retirement can publish.
      try { this.navigator?.invalidate(); }
      finally {
        try { this.denseMachine.invalidate(); }
        finally { this.denseUi.invalidate(); }
      }
    });
  }
  private async verifyAiEvidence(hit: EvidenceHit): Promise<void> {
    const reader = this.sourceReader, file = this.app.vault.getAbstractFileByPath(hit.sourceId);
    if (!reader || !(file instanceof TFile) || file.path !== hit.sourceId) throw new StandaloneError('SOURCE_REJECTED');
    verifySpan(hit, await reader.read(hit.sourceId));
    if (this.sourceReader !== reader || this.app.vault.getAbstractFileByPath(hit.sourceId) !== file)
      throw new StandaloneError('SOURCE_CHANGED');
  }
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
    try {
      const key = this.settingsStorageKey();
      if (key !== undefined) await settingsBarriers.get(key);
      if (this.unloaded) return;
      saved = await this.loadData();
    }
    catch { saved = { version: -1 }; } // Invalid/unreadable settings stay disabled and repairable in settings UI.
    if (this.unloaded) return;
    try { this.settings = parseSettings(saved); }
    catch { this.settings = { ...defaultSettings(), enabled: false }; this.standaloneError = 'SETTINGS_INVALID'; }
    this.searchController.configure(this.settings.enabled, this.settings.paused, this.standaloneError);
    this.registerView(SEARCH_VIEW, leaf => new SearchView(leaf, this.searchController,
      () => this.settings, action => this.controlSearch(action), this.denseUi, this.denseMachine));
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
      () => this.advancedHealth.snapshot(), () => this.checkAdvancedHealth(),
      () => this.advancedIngestion.snapshot(), () => this.ingestAdvancedActiveFile(),
      () => this.advancedRetrieval.snapshot(), () => this.indexAdvancedActiveFile(),
      () => this.openAdvancedSearch(), () => this.cancelAdvancedWork(),
      () => this.indexAdvancedActiveFile(true), () => this.searchController.status(),
      () => this.searchController.snapshot().response ?? undefined,
      role => role === 'embedding' ? this.denseMachine.pending() ?
        {phase:'permission-required',error:null} : this.denseUi.operationStatus() :
        this.searchController.evidenceOperationStatus(role)));
    this.addCommand({ id:'ingest-active-advanced-source', name:'Ingest active Vault document (Advanced opt-in)',
      callback: () => { void this.ingestAdvancedActiveFile().catch(error =>
        new Notice('OKS Advanced: '+(error instanceof IngestError?error.code:'ADVANCED_UNAVAILABLE'))); } });
    this.addCommand({ id:'index-active-advanced-source', name:'Build BGE-M3 index for active Vault document (Advanced)',
      callback:()=>{void this.indexAdvancedActiveFile().catch(error=>
        new Notice('OKS Advanced: '+(error instanceof Error?error.message:'INDEX_FAILED')));}});
    this.addCommand({ id:'rebuild-active-advanced-source', name:'Rebuild model index for active Vault document (Advanced)',
      callback:()=>{void this.indexAdvancedActiveFile(true).catch(error=>
        new Notice('OKS Advanced: '+(error instanceof Error?error.message:'INDEX_FAILED')));}});
    this.addCommand({ id:'open-advanced-search',name:'Open Advanced lexical/dense/hybrid search',
      callback:()=>{this.openAdvancedSearch();}});
    this.addCommand({ id:'cancel-advanced-work',name:'Cancel Advanced indexing / retrieval',
      callback:()=>{void this.cancelAdvancedWork().catch(()=>new Notice('OKS Advanced: cancel failed'));}});
    this.addCommand({ id: 'run-synthetic-evidence-probe' , name: 'Run synthetic evidence probe', callback: () => { void this.runProbe(); } });
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
      this.denseHost?.invalidate(file.path);
      if (oldPath !== undefined) this.denseHost?.invalidate(oldPath);
      this.searchController.invalidate();
      this.standalone?.changed(file.path);
      this.advancedIngestion.invalidate(file.path);
      this.advancedRetrieval.invalidate(file.path);
      if (oldPath !== undefined) { this.standalone?.changed(oldPath); this.advancedIngestion.invalidate(oldPath);this.advancedRetrieval.invalidate(oldPath); }
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
  private settingsStorageKey(): string | undefined {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter
      ? JSON.stringify([resolve(adapter.getBasePath()), this.manifest.id]) : undefined;
  }
  private persistSettings(settings: SearchSettings): Promise<void> {
    const key = this.settingsStorageKey();
    const prior = key === undefined ? undefined : settingsBarriers.get(key);
    // Only persistence, not the later storage-owner drain, blocks reload.
    const writing = Promise.resolve(prior).then(() => {
      // A queued write is not an admitted write. Unload may happen while
      // waiting for the previous barrier (or before this microtask runs).
      if (!this.unloaded) return this.saveData(settings);
    });
    if (key !== undefined) {
      const barrier = writing.then(() => undefined, () => undefined);
      settingsBarriers.set(key, barrier);
      void barrier.then(() => { if (settingsBarriers.get(key) === barrier) settingsBarriers.delete(key); });
    }
    return writing;
  }
  private queueSettings(change: (current: SearchSettings) => SearchSettings): Promise<void> {
    if (this.unloaded) return Promise.resolve();
    const task = this.settingsQueue.then(async () => {
      if (this.purgeInFlight) await this.purgeInFlight.catch(() => {});
      if (this.unloaded) return;
      const settings = parseSettings(change(this.settings));
      if (this.unloaded) return;
      const recovering = this.settingsRuntimeBase !== undefined;
      const repairing = this.settingsApplyInterrupted;
      if (!recovering && JSON.stringify(settings) === JSON.stringify(this.settings)) return;
      // A view preference never revokes live requests, grants or index state.
      const {presentationMode: _oldMode, ...beforeRuntime} = this.settings;
      const {presentationMode: _newMode, ...afterRuntime} = settings;
      if (!recovering && JSON.stringify(beforeRuntime) === JSON.stringify(afterRuntime)) {
        await this.persistSettings(settings);
        if (!this.unloaded) this.settings = settings;
        return;
      }
      this.denseSettingsChanging = true;
      try {
        const retiringHost = this.denseHost;
        this.searchController.beginRuntimeSettingsChange(retiringHost,
          !settings.enabled || JSON.stringify(this.settings.ai.reranking) !== JSON.stringify(settings.ai.reranking));
        // Retirement publishes synchronous lifecycle observers. An observer
        // can unload this instance and start a replacement before persistence
        // has been reserved. Never start a new write after terminal unload.
        if (this.unloaded) return;
        this.settingsRuntimeBase ??= this.settings;
        try { await this.persistSettings(settings); }
        catch (error) {
          // A rejection is not proof of rollback. Read the durable snapshot
          // while the admission fence is still closed; future edits start
          // from that snapshot, not from superseded role preferences.
          if (!this.unloaded) {
            try {
              const durable = parseSettings(await this.loadData());
              if (!this.unloaded) {
                if (!durable.enabled || JSON.stringify(this.settings.ai.reranking) !== JSON.stringify(durable.ai.reranking))
                  this.searchController.revokeRerankProfile();
                this.settings = durable;
              }
            } catch {
              // An unreadable/ambiguous store cannot authorize the old
              // runtime. Retain the requested snapshot for explicit retry.
              if (!this.unloaded) this.settings = settings;
            }
          }
          throw error;
        }
        if (this.unloaded) return;
        // Persistence committed. Admission has remained fenced since the first
        // retirement; publish the persisted preferences before any fallible
        // teardown so recovery cannot resurrect the previous configuration.
        const before = this.settingsRuntimeBase;
        this.settingsApplyInterrupted = true;
        this.settings = settings;
        this.standaloneError = null;
        const wasPaused = this.searchController.status().paused;
        this.searchController.configure(settings.enabled, settings.paused);
        if (this.unloaded) return;
        if (repairing || before.ingestion.enabled !== settings.ingestion.enabled) {
          await this.stopDenseHost();
        }
        if (this.unloaded) return;
        if (repairing || JSON.stringify(before.ingestion) !== JSON.stringify(settings.ingestion))
          await this.stopIngestion();
        if (this.unloaded) return;
        if (!repairing && !settings.ingestion.enabled && this.standalone && !this.denseHost)
          this.attachDenseHost();
        if (repairing || JSON.stringify(before.advanced) !== JSON.stringify(settings.advanced)) {
          await this.stopAdvanced();
          if (settings.advanced.enabled && this.layoutReady && !this.unloaded) await this.initializeAdvanced();
        }
        if (this.unloaded) return;
        if (repairing || before.enabled !== settings.enabled) {
          this.lifecycleRevision++;
          await this.stopStandalone();
          await this.initializing;
          if (settings.enabled && this.layoutReady && !this.unloaded) await this.initializeStandalone();
        } else if (this.standalone && (wasPaused !== settings.paused || before.paused !== settings.paused)) {
          if (settings.paused) this.standalone.cancel(); else this.standalone.resume();
        }
        this.settingsRuntimeBase = undefined;
        this.settingsApplyInterrupted = false;
      } finally {
        // A successful host retirement alone cannot reconcile a failed save
        // or partially applied runtime. Keep authority closed until retry.
        this.denseSettingsChanging = this.settingsRuntimeBase !== undefined;
        if (!this.denseSettingsChanging) this.searchController.endRuntimeSettingsChange();
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
    const retiringHost = this.denseHost;
    const result = this.searchController.control(action, retiringHost);
    if (!result.ok) { new Notice(`OKS: ${result.error}`); return; }
    try { await this.patchSettings(settings => { settings.paused = action === 'pause' || action === 'cancel'; }); }
    catch { new Notice('OKS: settings could not be saved.'); }
  }
  async ingestAdvancedActiveFile(): Promise<void> {
    const file=this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) throw new IngestError('SOURCE_REJECTED');
    const response=await this.ingestAdvancedPath(file.path);
    const blocks=response.source?.blocks.length??0;
    new Notice('OKS Advanced: '+response.status+'; '+blocks+' blocks. Use verified results for source navigation.');
  }
  /** Public opt-in action: only existing Obsidian TFile, never arbitrary host path. */
  async ingestAdvancedPath(path: string): Promise<IngestResponse> {
    const adapter=this.app.vault.adapter;
    const file=this.app.vault.getAbstractFileByPath(path);
    if (this.unloaded || !this.layoutReady || !this.settings.ingestion.enabled
        || !(adapter instanceof FileSystemAdapter) || !(file instanceof TFile)
        || file.path!==path) throw new IngestError('SOURCE_REJECTED');
    const root=resolve(adapter.getBasePath());
    try { await ingestionBarriers.get(root); }
    catch { throw new IngestError('ADVANCED_UNAVAILABLE'); }
    const cfg={...this.settings.ingestion};
    const allowed=():boolean=>!this.unloaded && this.layoutReady && this.settings.ingestion.enabled
      && JSON.stringify(this.settings.ingestion)===JSON.stringify(cfg)
      && this.app.vault.getAbstractFileByPath(path) === file && file.path===path;
    if (!allowed()) throw new IngestError('ADVANCED_CANCELLED');
    return this.advancedIngestion.ingest(cfg,root,this.manifest.id,path,allowed);
  }
  /** Re-reads source bytes before returning any Advanced evidence to a caller. */
  async verifiedAdvancedResult(path: string): Promise<IngestResponse|null> {
    const file=this.app.vault.getAbstractFileByPath(path);
    if (!this.settings.ingestion.enabled || this.unloaded || !(file instanceof TFile)) return null;
    const adapter=this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    try { await ingestionBarriers.get(resolve(adapter.getBasePath())); }
    catch { throw new IngestError('ADVANCED_UNAVAILABLE'); }
    if (this.unloaded || !this.settings.ingestion.enabled || this.app.vault.adapter!==adapter
        || this.app.vault.getAbstractFileByPath(path)!==file) return null;
    await this.advancedIngestion.recover(resolve(adapter.getBasePath()),this.manifest.id);
    const allowed=()=>!this.unloaded && this.settings.ingestion.enabled
      && this.app.vault.getAbstractFileByPath(path) === file && file.path===path;
    return this.advancedIngestion.verified(path,allowed);
  }
  async indexAdvancedActiveFile(rebuild=false):Promise<void>{
    const file=this.app.workspace.getActiveFile();
    if(!(file instanceof TFile))throw new ModelError('SOURCE_REJECTED');
    await this.indexAdvancedPath(file.path,rebuild);
    new Notice('OKS Advanced: real BGE-M3 index committed for '+file.name);
  }
  async indexAdvancedPath(path:string,rebuild=false):Promise<void>{
    const adapter=this.app.vault.adapter;
    const file=this.app.vault.getAbstractFileByPath(path);
    if(this.unloaded||!this.layoutReady||!this.settings.ingestion.enabled
       ||!(adapter instanceof FileSystemAdapter)||!(file instanceof TFile)||file.path!==path)
      throw new ModelError('SOURCE_REJECTED');
    const root=resolve(adapter.getBasePath());
    try { await ingestionBarriers.get(root); }
    catch { throw new ModelError('MODEL_UNAVAILABLE'); }
    if(this.unloaded||!this.settings.ingestion.enabled||this.app.vault.adapter!==adapter
       ||this.app.vault.getAbstractFileByPath(path)!==file)throw new ModelError('SOURCE_STALE');
    const cfg={...this.settings.ingestion};
    const authorized=()=>!this.unloaded&&this.layoutReady&&this.settings.ingestion.enabled
      &&JSON.stringify(this.settings.ingestion)===JSON.stringify(cfg)
      &&this.app.vault.getAbstractFileByPath(path)===file&&file.path===path;
    if(!await this.verifiedAdvancedResult(path))await this.ingestAdvancedPath(path);
    if(!authorized())throw new ModelError('SOURCE_STALE');
    await this.advancedRetrieval.index(cfg,root,this.manifest.id,path,authorized,rebuild);
  }
  async searchAdvanced(request:RetrievalRequest):Promise<RetrievalResponse>{
    const adapter=this.app.vault.adapter;
    if(this.unloaded||!this.layoutReady||!this.settings.ingestion.enabled
       ||!(adapter instanceof FileSystemAdapter))throw new ModelError('MODEL_UNAVAILABLE');
    const root=resolve(adapter.getBasePath());
    try { await ingestionBarriers.get(root); }
    catch { throw new ModelError('MODEL_UNAVAILABLE'); }
    if(this.unloaded||!this.settings.ingestion.enabled||this.app.vault.adapter!==adapter)
      throw new ModelError('MODEL_UNAVAILABLE');
    const cfg={...this.settings.ingestion};
    const authorized=(path:string):boolean=>this.layoutReady&&!this.unloaded
      &&this.settings.ingestion.enabled
      &&JSON.stringify(this.settings.ingestion)===JSON.stringify(cfg)
      &&this.app.vault.getAbstractFileByPath(path) instanceof TFile;
    return this.advancedRetrieval.search(cfg,root,this.manifest.id,request,authorized);
  }
  openAdvancedSearch():void{
    if(!this.settings.ingestion.enabled){new Notice('Enable Advanced document ingestion first.');return;}
    new AdvancedSearchModal(this.app,request=>this.searchAdvanced(request),
      hit=>this.openAdvancedHit(hit),()=>this.cancelAdvancedWork(),
      ()=>JSON.stringify(this.advancedRetrieval.snapshot())).open();
  }
  async openAdvancedHit(hit:AdvancedEvidenceHit):Promise<void>{
    const path=hit.vaultRelativeReference,file=this.app.vault.getAbstractFileByPath(path);
    const adapter=this.app.vault.adapter;
    if(!(file instanceof TFile)||!(adapter instanceof FileSystemAdapter)||this.unloaded)
      throw new ModelError('SOURCE_STALE');
    const authorized=()=>!this.unloaded&&this.settings.ingestion.enabled
      &&this.app.vault.getAbstractFileByPath(path)===file&&file.path===path;
    await this.advancedRetrieval.verifyHit(hit,path,authorized);
    const root=await trustedVaultRoot(resolve(adapter.getBasePath()));
    const source=await readSource(root,path);
    if(source.sha256!==hit.sourceSha256||!authorized())throw new ModelError('SOURCE_STALE');
    const loc=hit.sourceLocators[0];
    if(!loc||loc.sourceVersion!==source.sha256)throw new ModelError('EVIDENCE_INVALID');
    if(loc.locatorKind==='markdown'){
      if(loc.byteStart===null||loc.byteEnd===null||loc.lineStart===null
          ||loc.lineEnd!==loc.lineStart)throw new ModelError('EVIDENCE_INVALID');
      const excerpt=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes.subarray(loc.byteStart,loc.byteEnd));
      if(excerpt!==hit.originalExcerpt)throw new ModelError('EVIDENCE_INVALID');
    }else if(loc.locatorKind!=='native'||!loc.nativeItemRef)
      throw new ModelError('EVIDENCE_INVALID');
    const leaf=this.app.workspace.getLeaf('tab');
    await leaf.openFile(file,{active:true});
    await this.advancedRetrieval.verifyHit(hit,path,authorized);
    if(loc.locatorKind==='markdown'){
      const view=leaf.view;
      if(!(view instanceof MarkdownView)||view.file!==file)throw new ModelError('NAVIGATION_REJECTED');
      const sourceText=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes);
      if(view.editor.getValue().replace(/\r\n|\r/g,'\n')!==sourceText.replace(/\r\n|\r/g,'\n'))
        throw new ModelError('SOURCE_STALE');
      const prefix=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes.subarray(0,loc.byteStart!));
      const line=loc.lineStart!-1,ch=prefix.split(/\r\n|\r|\n/).at(-1)!.length;
      view.editor.setSelection({line,ch},{line,ch:ch+hit.originalExcerpt.length});
      view.editor.scrollIntoView({from:{line,ch},to:{line,ch:ch+hit.originalExcerpt.length}},true);
    }
    // PDF/DOCX: preserve the true native locator in the result; Obsidian's
    // public file-open API cannot guarantee page/cell navigation for DOCX.
  }
  async cancelAdvancedWork():Promise<void>{await this.advancedRetrieval.stop();}
  private stopIngestion(): Promise<void> {
    return this.trackStorageDrain(this.advancedRetrieval.releaseStorage().then(()=>this.advancedIngestion.stop()));
  }
  private trackStorageDrain(stopping: Promise<void>): Promise<void> {
    const adapter=this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return stopping;
    const key=resolve(adapter.getBasePath());
    const prior=ingestionBarriers.get(key);
    const barrier=prior?Promise.all([prior,stopping]).then(()=>undefined):stopping;
    ingestionBarriers.set(key,barrier);
    void barrier.then(()=>{if(ingestionBarriers.get(key)===barrier)ingestionBarriers.delete(key);},
      ()=>{/* Retain rejected barrier: do not admit a replacement process. */});
    return barrier;
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
      this.sourceReader = provider;
      this.attachDenseHost();
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
  private attachDenseHost(): void {
    const engine = this.standalone, reader = this.sourceReader, adapter = this.app.vault.adapter;
    if (!engine || !reader || this.denseHost || this.unloaded || !this.settings.enabled
        || this.settings.ingestion.enabled || !(adapter instanceof FileSystemAdapter)) return;
    this.denseHost = new ApiDenseHost(engine, resolve(adapter.getBasePath()), reader.rootId, this.manifest.id, {
      config: () => this.settings.ai.embedding,
      admitStorage: async () => { await ingestionBarriers.get(resolve(adapter.getBasePath())); },
      enabled: () => !this.unloaded && !this.denseSettingsChanging && this.settings.enabled && !this.settings.paused
        && !this.settings.ingestion.enabled && this.standalone === engine && this.sourceReader === reader
        && this.app.vault.adapter === adapter,
      allowedPath: path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile && file.path === path;
      },
    });
  }
  private async stopDenseHost(): Promise<void> {
    // Callers have already retired shared authority through the controller
    // (configure/detach/dispose). Do not retry a failed trusted hook outside
    // that fault transaction, particularly during a persisted settings change.
    const host = this.denseHost;
    if (host) {
      // Publish the drain before losing ownership even after a failed UI hook.
      // close() revokes synchronously; its rejected barrier stays closed.
      const drain = this.trackStorageDrain(host.close());
      this.denseHost = undefined;
      await drain;
    }
    // A delayed drain must not revoke a newer owner. A later synchronous
    // shared transition retries any retained retirement fence.
  }
  private async stopStandalone(): Promise<void> {
    this.navigator?.dispose(); this.navigator = undefined; this.sourceReader = undefined;
    this.searchController.detach();
    const drain = this.stopDenseHost().catch(() => { /* storage barrier stays closed */ });
    const engine = this.standalone; this.standalone = undefined;
    if (!engine) { await drain; return; }
    // Basic search owns a separate writer; an AI drain must not block its reload.
    const closing = engine.close();
    if (this.rootId) barriers.set(this.rootId, closing);
    await closing;
    if (this.rootId && barriers.get(this.rootId) === closing) barriers.delete(this.rootId);
    await drain;
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
    const cleanup = (action: () => void): void => {
      try { action(); } catch { console.warn('PLUGIN_UNLOAD_CLEANUP_FAILED'); }
    };
    cleanup(() => this.resultModal?.close());
    this.resultModal = undefined;
    void this.controller?.unload().catch(() => { console.warn('PLUGIN_UNLOAD_CLEANUP_FAILED'); });
    this.lifecycleRevision++;
    // Revoke navigation before any observer or host teardown may run.
    cleanup(() => this.navigator?.dispose());
    cleanup(() => this.denseMachine.dispose());
    cleanup(() => this.denseUi.dispose());
    cleanup(() => this.searchController.dispose());
    cleanup(() => this.app.workspace.detachLeavesOfType(SEARCH_VIEW));
    void this.stopStandalone().catch(() => { console.warn('PLUGIN_UNLOAD_CLEANUP_FAILED'); });
    void this.stopAdvanced().catch(() => { /* failed barrier remains closed to reload */ });
    void this.stopIngestion().catch(() => { /* failed shutdown denies new ingestion */ });
    this.controller = undefined;
  }
}
