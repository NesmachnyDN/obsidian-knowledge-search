import type { AdvancedHealth } from '../advanced/health';
import type { IngestionStatus } from '../advanced/manager';
import { Modal, PluginSettingTab, Setting, Notice, type App, type Plugin } from 'obsidian';
import type { SearchSettings } from './settings';
export class SearchSettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private readonly current: () => SearchSettings,
    private readonly patchSettings: (change: (s: SearchSettings) => void) => Promise<void>,
    private readonly purge: () => Promise<number>,
    private readonly health: () => AdvancedHealth, private readonly checkHealth: () => Promise<void>,
    private readonly ingestionStatus?: () => IngestionStatus,
    private readonly ingestActive?: () => Promise<void>) { super(app, plugin); }
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
    new Setting(root).setName('Advanced local backend (explicit opt-in)')
      .setDesc('Health-only local Python stdio, no document transfer. Dense/hybrid remain unavailable.')
      .addToggle(t => t.setValue(this.current().advanced.enabled)
        .onChange(v => save(s => { s.advanced.enabled = v; })));
    new Setting(root).setName('Advanced profile')
      .setDesc('Optional external local backend. Never required by Standalone.')
      .addDropdown(d => d.addOption('none','None').addOption('local-stdio','Local stdio (trusted)')
        .setValue(this.current().advanced.profile)
        .onChange(v => save(s => { s.advanced.profile = v as 'none' | 'local-stdio'; })));
    for (const [key, name] of [['interpreter','Trusted local Python executable (absolute)'],
      ['entry','Trusted advanced health entry (absolute)']] as const)
      new Setting(root).setName(name).addText(t => t.setValue(this.current().advanced[key])
        .onChange(v => save(s => { s.advanced[key] = v; })));
    const h = this.health();
    new Setting(root).setName('Advanced transport status')
      .setDesc(`Health-only: ${h.status}${h.error ? ' (' + h.error + ')' : ''}. Never implies dense/hybrid readiness.`)
      .addButton(b => b.setButtonText('Recheck health')
        .setDisabled(!this.current().advanced.enabled)
        .onClick(async () => { await this.checkHealth(); this.display(); }));
    new Setting(root).setName('Advanced document ingestion (separate opt-in)')
      .setDesc('Local-only; manual active-file ingestion. Uses a verified resource-limited cgroup unit. Configure trusted paths first. Does not enable dense/hybrid search.')
      .addToggle(t=>t.setValue(this.current().ingestion.enabled)
        .onChange(v=>save(s=>{s.ingestion.enabled=v;})));
    for(const [key,name] of [
      ['interpreter','Ingestion Python interpreter (trusted absolute file)'],
      ['entry','Ingestion backend script (advanced_ingest.py)'],
      ['tokenizerSnapshot','Pinned local tokenizer snapshot directory'],
      ['tessdataPath','Local RU/EN OCR tessdata directory'],
      ['artifactsPath','Pinned local structured PDF artifacts directory'],
    ] as const)
      new Setting(root).setName(name).addText(t=>t.setValue(this.current().ingestion[key])
        .onChange(v=>save(s=>{s.ingestion[key]=v;})));
    new Setting(root).setName('PDF extraction mode')
      .setDesc('Text-only PDF exposes layout/table limitations; OCR and structured models are explicit, never fallback.')
      .addDropdown(d=>d.addOption('text','Native text')
        .addOption('ocr','Scanned PDF (RU/EN Tesseract)')
        .addOption('structured','Structured layout/table')
        .addOption('structured-ocr','Structured + OCR')
        .setValue(this.current().ingestion.pdfMode)
        .onChange(v=>save(s=>{s.ingestion.pdfMode=v as SearchSettings['ingestion']['pdfMode'];})));
    const ing=this.ingestionStatus?.();
    const item=new Setting(root).setName('Advanced ingestion result')
      .setDesc('Ingestion: '+(ing?.status??'disabled')+(ing?.error?' ('+ing.error+')':'')+
        '. Status is not retrieval/model readiness. Evidence requires fresh source verification.');
    if(this.ingestActive) item.addButton(b=>b.setButtonText('Ingest active document')
      .setDisabled(!this.current().ingestion.enabled)
      .onClick(async()=>{try{await this.ingestActive?.();}catch{new Notice('OKS: Advanced ingestion failed.');}this.display();}));
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
