import { Modal, PluginSettingTab, Setting, Notice, type App, type Plugin } from 'obsidian';
import type { SearchSettings } from './settings';
export class SearchSettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private readonly current: () => SearchSettings,
    private readonly patchSettings: (change: (s: SearchSettings) => void) => Promise<void>,
    private readonly purge: () => Promise<number>) { super(app, plugin); }
  display(): void {
    const root = this.containerEl; root.replaceChildren();
    const save = async (change: (s: SearchSettings) => void): Promise<void> => {
      try { await this.patchSettings(change); }
      catch { new Notice('OKS: settings could not be saved.'); }
      // Reflect the committed state, including the derived-purge button guard.
      this.display();
    };
    for (const [key, name, desc] of [
      ['enabled','Enable Standalone indexing and search','Offline Markdown lexical search. Disabling stops the worker and clears results.'],
      ['paused','Pause indexing','Sources are always freshly verified before evidence is returned or opened. Resume reconciles changes.'],
      ['propertiesEnabled','Allow typed Property filters','Opt in to the filter controls in the search view. No automatic coercion.'],
    ] as const) new Setting(root).setName(name).setDesc(desc).addToggle(t =>
      t.setValue(this.current()[key]).onChange(v => save(s => { s[key] = v; })));
    new Setting(root).setName('Default Top K (1–50)').addText(t => t.setValue(String(this.current().topK))
      .onChange(v => save(s => { s.topK = Number(v); })));
    new Setting(root).setName('Advanced backend configuration (inactive)')
      .setDesc('Configuration only. Always disabled in this version; no connection, runtime, model or network activity.')
      .addDropdown(d => d.addOption('none','None').addOption('local-stdio','Future local stdio profile')
        .setValue(this.current().advanced.profile).onChange(v => save(s => { s.advanced.profile = v as 'none' | 'local-stdio'; })));
    const purge = this.purge;
    new Setting(root).setName('Clear derived Standalone index')
      .setDesc('Only while indexing is disabled. Removes recognized private index files, never notes. Rebuild after re-enabling.')
      .addButton(button => button.setButtonText('Clear derived index')
        .setDisabled(this.current().enabled)
        .onClick(() => {
          const confirm = new class extends Modal {
            onOpen(): void {
              this.contentEl.createEl('h3', { text: 'Confirm derived index cleanup' });
              this.contentEl.createEl('p', { text: 'Only recognized host-private index files will be deleted. Original Vault notes remain unchanged. Indexing must remain disabled.' });
              new Setting(this.contentEl)
                .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
                .addButton(b => b.setButtonText('Delete derived files').setWarning().onClick(async () => {
                  try { const count = await purge(); new Notice(`OKS: cleared ${count} derived files.`); }
                  catch { new Notice('OKS: cleanup refused; check that indexing is disabled and cache contains only recognized files.'); }
                  this.close();
                }));
            }
          }(this.app);
          confirm.open();
        }));
    new Setting(root).setName('Legacy manual synthetic probe')
      .setDesc('Separate historical diagnostic. Never needed or started by Standalone. Disposable fixtures only.')
      .addToggle(t => t.setValue(this.current().probe.fixtureMode).onChange(v => save(s => { s.probe.fixtureMode = v; })));
    for (const [key, name] of [['interpreter','Trusted legacy Python interpreter'], ['entry','Trusted legacy probe entry']] as const)
      new Setting(root).setName(name).addText(t => t.setValue(this.current().probe[key])
        .onChange(v => save(s => { s.probe[key] = v; })));
  }
}
