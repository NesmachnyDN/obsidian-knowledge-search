import { FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, type App, type TAbstractFile } from 'obsidian';
import { ProbeController, type ProbeConfig } from './controller';
import { FIXTURE_PATH, type Response } from './protocol';
import { Supervisor } from './supervisor';

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
