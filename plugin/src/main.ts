import { FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, type App, type TAbstractFile } from 'obsidian';
import { ProbeController, type ProbeConfig } from './controller';
import { FIXTURE_PATH, type Response } from './protocol';
import { Supervisor } from './supervisor';
import { StandaloneEngine } from './standalone/engine';
import { BoundedVaultReader, privateIndexPath } from './standalone/source';
import { GenerationStore } from './standalone/storage';
import { WorkerMarkdownParser } from './standalone/worker';
import { StandaloneError } from './standalone/contracts';
import { join } from 'node:path';

const DEFAULTS: ProbeConfig = { fixtureMode: false, interpreter: '', entry: '' };
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
  settings: ProbeConfig = { ...DEFAULTS };
  private unloaded = false;
  private controller?: ProbeController;
  private resultModal?: ResultModal;
  // Plugin-native search core; UI/settings/navigation are assigned to OKS-04B.
  standalone?: StandaloneEngine;
  standaloneError: string | null = null;
  async onload(): Promise<void> {
    const saved: unknown = await this.loadData();
    if (this.unloaded) return;
    if (typeof saved === 'object' && saved !== null) {
      const data = saved as Record<string, unknown>;
      this.settings = { fixtureMode: data.fixtureMode === true,
        interpreter: typeof data.interpreter === 'string' ? data.interpreter : '',
        entry: typeof data.entry === 'string' ? data.entry : '' };
    }
    this.controller = new ProbeController(new Supervisor(), {
      status: value => { this.resultModal?.close(); new Notice(`Synthetic probe: ${value}`); },
      result: response => { this.resultModal?.close(); this.resultModal = new ResultModal(this.app, response); this.resultModal.open(); },
    });
    this.addSettingTab(new ProbeSettings(this.app, this));
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
      this.standalone?.changed(file.path);
      if (oldPath !== undefined) this.standalone?.changed(oldPath);
    };
    this.registerEvent(this.app.vault.on('create', file => nativeChange(file)));
    this.registerEvent(this.app.vault.on('modify', file => nativeChange(file)));
    this.registerEvent(this.app.vault.on('delete', file => nativeChange(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => nativeChange(file, oldPath)));
    this.registerEvent(this.app.metadataCache.on('changed', file => this.standalone?.changed(file.path)));
    // The renderer remains responsive during Obsidian's initial layout/mount.
    // A full reconciliation covers all source changes before layout readiness.
    this.app.workspace.onLayoutReady(() => {
      if (!this.unloaded) void this.initializeStandalone();
    });
  }
  private async initializeStandalone(): Promise<void> {
    // No UI command or external backend is needed to initialize the native core.
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      this.standaloneError = 'UNSUPPORTED_FILESYSTEM';
    } else {
      try {
        const root = adapter.getBasePath();
        const provider = await BoundedVaultReader.open(root,
          () => this.app.vault.getMarkdownFiles().map(file => file.path));
        if (this.unloaded) return;
        const store = await GenerationStore.open(
          privateIndexPath(root, provider.rootId, this.manifest.id), provider.rootId);
        if (this.unloaded) return;
        this.standalone = new StandaloneEngine(provider, store,
          new WorkerMarkdownParser(join(root, this.app.vault.configDir,
            'plugins', this.manifest.id, 'standalone-worker.js')));
        await this.standalone.start();
      } catch (error) {
        this.standaloneError = error instanceof StandaloneError ? error.code : 'INITIALIZATION_FAILED';
      }
    }
  }
  private async runProbe(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) { new Notice('Synthetic probe: UNSUPPORTED_FILESYSTEM'); return; }
    await this.controller?.run({ ...this.settings }, {
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
    void this.standalone?.close();
    this.standalone = undefined;
    this.controller = undefined;
  }
}
class ProbeSettings extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SyntheticEvidencePlugin) { super(app, plugin); }
  display(): void {
    this.containerEl.replaceChildren();
    new Setting(this.containerEl).setName('Synthetic fixture mode')
      .setDesc('Enable only in a disposable synthetic vault. Reads only oks-synthetic/evidence.md with its pinned digest.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.fixtureMode).onChange(async value => {
        this.plugin.settings.fixtureMode = value; await this.plugin.saveData(this.plugin.settings);
      }));
    for (const [key, name] of [['interpreter', 'Trusted Python interpreter (absolute path)'], ['entry', 'Trusted engine probe.py (absolute path)']] as const) {
      new Setting(this.containerEl).setName(name).addText(text => text.setValue(this.plugin.settings[key]).onChange(async value => {
        this.plugin.settings[key] = value; await this.plugin.saveData(this.plugin.settings);
      }));
    }
  }
}
