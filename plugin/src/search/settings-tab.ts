import type { AdvancedHealth, AdvancedConfig } from '../advanced/health';
import type { IngestionStatus } from '../advanced/manager';
import type { RetrievalStatus } from '../advanced/retrieval-manager';
import type { ProbeConfig } from '../controller';
import { Modal, PluginSettingTab, Setting, Notice, type App, type Plugin } from 'obsidian';
import { renderProviderSettings, refreshProviderOperationStatus, type AiDrafts, type OperationStatusReader } from '../ai/settings-ui';
import { applySettingsLayout, restoreSettingsFocus, settingsDisclosure } from './settings-layout';
import { advancedDraft, ingestionDraft, needsOcr, needsStructure, probeDraft, topKDraft } from './settings-draft';
import type { IngestionConfig, SearchSettings } from './settings';
import type { SearchStatus } from './status';

type BasicResponse = { requestedMode: string; executedMode: string; status: string };
const heading = (root: HTMLElement, name: string): HTMLElement => {
  const section = root.createEl('section');
  section.setAttribute('aria-label', name);
  section.createEl('h3', { text: name });
  return section;
};
const alert = (root: HTMLElement): HTMLElement => {
  const error = root.createEl('p');
  error.setAttribute('role', 'alert');
  error.setAttribute('aria-live', 'polite');
  return error;
};

/** A task-based view over the one authoritative versioned SearchSettings model. */
export class SearchSettingsTab extends PluginSettingTab {
  private topKInput?: string;
  private advancedInput?: AdvancedConfig;
  private ingestionInput?: IngestionConfig;
  private probeInput?: ProbeConfig;
  private readonly aiInputs: AiDrafts = {};
  private readonly openEditors = new Set<string>();

  constructor(app: App, plugin: Plugin, private readonly current: () => SearchSettings,
    private readonly patchSettings: (change: (s: SearchSettings) => void) => Promise<void>,
    private readonly purge: () => Promise<number>,
    private readonly health: () => AdvancedHealth, private readonly checkHealth: () => Promise<void>,
    private readonly ingestionStatus?: () => IngestionStatus,
    private readonly ingestActive?: () => Promise<void>,
    private readonly retrievalStatus?: () => RetrievalStatus,
    private readonly indexActive?: () => Promise<void>,
    private readonly openAdvanced?: () => void,
    private readonly cancelAdvanced?: () => Promise<void>,
    private readonly rebuildActive?: () => Promise<void>,
    private readonly searchStatus?: () => SearchStatus,
    private readonly lastBasic?: () => BasicResponse | undefined,
    private readonly aiOperationStatus?: OperationStatusReader) { super(app, plugin); }

  private async commit(change: (s: SearchSettings) => void, error: HTMLElement): Promise<boolean> {
    try {
      await this.patchSettings(change);
      error.textContent = '';
      return true;
    } catch {
      // No full redraw after failure; preserve the exact draft, focus and committed state.
      error.textContent = 'Could not save. The unsaved draft is retained; retry or cancel.';
      return false;
    }
  }

  private showOverview(root: HTMLElement): void {
    const section = heading(root, 'Overview');
    const s = this.searchStatus?.();
    new Setting(section).setName('Offline Markdown search')
      .setDesc(s ? `Status: ${s.status}; ${s.enabled ? 'enabled' : 'disabled'}; ${s.paused ? 'paused' : 'not paused'}; ` +
        `error: ${s.error ?? 'none'}.` : 'State not yet available. No AI service is required.');
    const roles = this.current().ai;
    const active = (Object.keys(roles) as (keyof typeof roles)[])
      .filter(role => roles[role].state !== 'disabled');
    new Setting(section).setName('Optional AI capabilities')
      .setDesc(active.length ? active.map(role => `${role}: ${roles[role].state === 'configured' ?
        'configured, not verified' : 'invalid / unavailable'}`).join('; ') +
        '. Configuration is not execution authorization.' :
        'All optional AI roles are disabled. Basic search works without an API.');
    section.createEl('p', { text: 'Basic search works offline with no Python, API key, model or download. ' +
      'Other formats and AI operations require their own independently accepted capability.' });
  }

  private showSearch(root: HTMLElement): void {
    const section = heading(root, 'Search & scope');
    for (const [key, name, explanation] of [
      ['enabled', 'Enable offline search', 'Disable to stop indexing and clear results. Original notes remain untouched.'],
      ['paused', 'Pause indexing', 'Resume to reconcile source changes. Evidence is always verified.'],
      ['propertiesEnabled', 'Enable typed Properties filters', 'Explicit typed filtering in the search view.'],
    ] as const) {
      const status = alert(section);
      new Setting(section).setName(name).setDesc(explanation)
        .addToggle(toggle => { toggle.toggleEl.setAttribute('aria-label', name);
          toggle.toggleEl.dataset.oksFocus = key;
          return toggle.setValue(this.current()[key]).onChange(async value => {
          if (!(await this.commit(settings => { settings[key] = value; }, status)))
            toggle.setValue(this.current()[key]);
          else this.display(key);
        }); });
    }
    this.topKInput ??= String(this.current().topK);
    const error = alert(section);
    new Setting(section).setName('Results per search')
      .setDesc('Whole number between 1 and 50. Applied only when Save is selected.')
      .addText(text => {
        text.inputEl.type = 'number';
        text.inputEl.setAttribute('aria-label', 'Results per search');
        text.inputEl.dataset.oksFocus = 'top-k';
        text.inputEl.min = '1'; text.inputEl.max = '50';
        text.setValue(this.topKInput!).onChange(value => { this.topKInput = value; error.textContent = ''; });
      });
    new Setting(section).setName('Results draft')
      .addButton(button => button.setButtonText('Save').onClick(async () => {
        const result = topKDraft(this.topKInput!);
        if (!result.ok) { error.textContent = result.message; return; }
        if (await this.commit(settings => { settings.topK = result.value; }, error)) {
          this.topKInput = undefined; this.display('top-k');
        }
      }))
      .addButton(button => button.setButtonText('Cancel').onClick(() => {
        this.topKInput = undefined; this.display('top-k');
      }));
  }

  private showDocuments(root: HTMLElement): void {
    const section = heading(root, 'Documents');
    new Setting(section).setName('Local document processing (optional)')
      .setDesc('Markdown search never depends on Python, OCR or structured extraction. ' +
        'PDF/DOCX/OCR readiness is not claimed by turning on a preference.');
    const ingest = this.ingestionStatus?.();
    new Setting(section).setName('Last processing state')
      .setDesc(`${ingest?.status ?? 'disabled'}; format: ${ingest?.lastFormat ?? 'none'}; ` +
        `error: ${ingest?.error ?? 'none'}. Not proof of search readiness.`);
    const draft = this.ingestionInput ?? structuredClone(this.current().ingestion);
    const { form: editor } = settingsDisclosure(section, this.openEditors, 'documents',
      'Processing setup', 'Configure documents', () => { this.ingestionInput = draft; });
    const fields: Partial<Record<keyof IngestionConfig, HTMLElement>> = {};
    new Setting(editor).setName('Enable local document ingestion after Save')
      .addToggle(toggle => {
        toggle.toggleEl.setAttribute('aria-label', 'Enable local document ingestion after Save');
        return toggle.setValue(draft.enabled).onChange(value => {
          draft.enabled = value; this.ingestionInput = draft; syncFields();
        });
      });
    const mode = new Setting(editor).setName('PDF processing mode')
      .setDesc('Explicit mode; no hidden OCR or structural fallback.')
      .addDropdown(dropdown => { dropdown.selectEl.setAttribute('aria-label', 'PDF processing mode'); return dropdown
        .addOption('text', 'Native text PDF')
        .addOption('ocr', 'OCR (RU/EN Tesseract)')
        .addOption('structured', 'Structured layout and tables')
        .addOption('structured-ocr', 'Structured + OCR')
        .setValue(draft.pdfMode).onChange(value => {
          draft.pdfMode = value as IngestionConfig['pdfMode'];
          this.ingestionInput = draft; syncFields();
        }); });
    fields.pdfMode = mode.settingEl;
    for (const [key, title] of [
      ['interpreter', 'Trusted local Python interpreter'],
      ['entry', 'Ingestion script (advanced_ingest.py)'],
      ['tokenizerSnapshot', 'Pinned tokenizer snapshot'],
      ['tessdataPath', 'Local OCR language assets'],
      ['artifactsPath', 'Pinned structured extraction artifacts'],
    ] as const) {
      const row = new Setting(editor).setName(title)
        .addText(text => { text.inputEl.setAttribute('aria-label', title); return text.setValue(draft[key]).onChange(value => {
          draft[key] = value; this.ingestionInput = draft;
        }); });
      fields[key] = row.settingEl;
    }
    function syncFields(): void {
      for (const [key, row] of Object.entries(fields) as [keyof IngestionConfig, HTMLElement][]) {
        row.hidden = !draft.enabled || (key === 'tessdataPath' && !needsOcr(draft.pdfMode)) ||
          (key === 'artifactsPath' && !needsStructure(draft.pdfMode));
      }
    }
    syncFields();
    const error = alert(editor);
    new Setting(editor).setName('Document setup draft')
      .addButton(button => button.setButtonText('Save setup').onClick(async () => {
        const result = ingestionDraft(draft);
        if (!result.ok) { error.textContent = result.message; return; }
        if (await this.commit(settings => { settings.ingestion = result.value; }, error)) {
          this.ingestionInput = undefined; this.openEditors.delete('documents'); this.display('documents');
        }
      }))
      .addButton(button => button.setButtonText('Cancel').onClick(() => {
        this.ingestionInput = undefined; this.openEditors.delete('documents'); this.display('documents');
      }));
    if (this.ingestActive) {
      const result = alert(section);
      new Setting(section).setName('Process active source')
        .setDesc('Manual operation on the selected source only; no bulk indexing.')
        .addButton(button => button.setButtonText('Ingest active document')
          .setDisabled(!this.current().ingestion.enabled).onClick(async () => {
            try { await this.ingestActive?.(); this.display(); }
            catch { result.textContent = 'Ingestion refused or failed. Check diagnostics.'; }
          }));
    }
  }

  private showIndex(root: HTMLElement): void {
    const section = heading(root, 'Index & maintenance');
    const basic = this.searchStatus?.();
    new Setting(section).setName('Offline index')
      .setDesc(basic ? `Status: ${basic.status}; indexed sources: ${basic.sources}; records: ${basic.records}; ` +
        `busy: ${basic.busy ? 'yes' : 'no'}; warning: ${basic.maintenanceWarning ?? 'none'}; ` +
        `error: ${basic.error ?? 'none'}. Counts are not an estimate of total Vault coverage.` :
        'Index state not available.');
    const last = this.lastBasic?.();
    new Setting(section).setName('Last verified basic search')
      .setDesc(last ? `Requested: ${last.requestedMode}; executed: ${last.executedMode}; result: ${last.status}.` :
        'No current search response. Requested and executed modes appear in search results.');
    const retrieval = this.retrievalStatus?.();
    new Setting(section).setName('Optional model-backed index')
      .setDesc(retrieval ? `State: ${retrieval.status}; lexical: ${retrieval.lexical}; dense: ${retrieval.dense}; ` +
        `indexed sources: ${retrieval.indexedSources}; chunks: ${retrieval.indexedChunks}; ` +
        `error: ${retrieval.error ?? 'none'}. Never inferred from provider preferences.` :
        'Unavailable / not verified. Existing dense generations are model-specific.');
    if (this.indexActive && this.rebuildActive && this.cancelAdvanced) {
      const error = alert(section);
      const action = async (task: () => Promise<void>): Promise<void> => {
        try { await task(); this.display(); }
        catch { error.textContent = 'Index operation failed or was refused. Check diagnostics.'; }
      };
      new Setting(section).setName('Manual index operations')
        .setDesc('Only the active source. Rebuild may be needed after an embedding-space change; ' +
          'never automatic. Verified previous generations remain protected by storage contracts.')
        .addButton(button => button.setButtonText('Index active source')
          .setDisabled(!this.current().ingestion.enabled)
          .onClick(() => action(this.indexActive!)))
        .addButton(button => button.setButtonText('Rebuild active source')
          .setDisabled(!this.current().ingestion.enabled)
          .onClick(() => action(this.rebuildActive!)))
        .addButton(button => button.setButtonText('Cancel current operation')
          .onClick(() => action(this.cancelAdvanced!)));
    }
    if (this.openAdvanced) new Setting(section).setName('Advanced search')
      .setDesc('Open separately; no fallback is reported as a successful AI search.')
      .addButton(button => button.setButtonText('Open advanced search')
        .setDisabled(!this.current().ingestion.enabled).onClick(() => this.openAdvanced?.()));
    this.showPurge(section);
    new Setting(section).setName('Refresh status')
      .setDesc('Manually reread existing state; does not trigger indexing or network access.')
      .addButton(button => {
        button.buttonEl.dataset.oksFocus = 'refresh';
        return button.setButtonText('Refresh').onClick(() => this.refreshReadOnly());
      });
  }

  private showPurge(section: HTMLElement): void {
    const purge = this.purge;
    new Setting(section).setName('Delete derived offline index')
      .setDesc('Only when offline indexing is disabled. Removes recognized host-private index files, never notes.')
      .addButton(button => button.setButtonText('Clear derived files').setWarning()
        .setDisabled(this.current().enabled).onClick(() => {
          const confirm = new class extends Modal {
            onOpen(): void {
              applySettingsLayout(this.contentEl);
              this.contentEl.createEl('h3', { text: 'Confirm derived-index cleanup' });
              this.contentEl.createEl('p', { text: 'Only recognized host-private index files will be deleted. ' +
                'Original Vault notes will not be touched. Indexing must remain disabled.' });
              new Setting(this.contentEl)
                .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
                .addButton(b => b.setButtonText('Delete derived files').setWarning().onClick(async () => {
                  try {
                    const count = await purge();
                    new Notice(`OKS: cleared ${count} derived files.`);
                  } catch { new Notice('OKS: cleanup refused or failed.'); }
                  this.close();
                }));
            }
          }(this.app);
          confirm.open();
        }));
  }

  private showExpert(root: HTMLElement): void {
    const section = heading(root, 'Advanced diagnostics');
    const health = this.health();
    new Setting(section).setName('Health-only local backend')
      .setDesc(`State: ${health.status}; profile: ${health.profile}; error: ${health.error ?? 'none'}. ` +
        'Health readiness never implies AI, OCR or document readiness.')
      .addButton(button => button.setButtonText('Recheck health')
        .setDisabled(!this.current().advanced.enabled).onClick(async () => {
          try { await this.checkHealth(); this.display(); }
          catch { new Notice('OKS: health check failed.'); }
        }));
    const draft = this.advancedInput ?? structuredClone(this.current().advanced);
    const { form: editor } = settingsDisclosure(section, this.openEditors, 'backend',
      'Backend setup', 'Configure local backend', () => { this.advancedInput = draft; });
    const fields: HTMLElement[] = [];
    new Setting(editor).setName('Enable trusted local health backend after Save')
      .addToggle(toggle => { toggle.toggleEl.setAttribute('aria-label', 'Enable trusted local health backend after Save');
        return toggle.setValue(draft.enabled).onChange(value => {
        draft.enabled = value; this.advancedInput = draft;
        fields.forEach(row => { row.hidden = !draft.enabled; });
      }); });
    fields.push(new Setting(editor).setName('Backend profile').addDropdown(dropdown => {
      dropdown.selectEl.setAttribute('aria-label', 'Backend profile');
      return dropdown.addOption('none', 'None').addOption('local-stdio','Trusted local stdio')
        .setValue(draft.profile).onChange(value => {
          draft.profile = value as AdvancedConfig['profile']; this.advancedInput = draft;
        });
    }).settingEl);
    for (const [key, name] of [
      ['interpreter', 'Trusted absolute Python executable'],
      ['entry', 'Trusted absolute health entry'],
    ] as const) {
      fields.push(new Setting(editor).setName(name).addText(text => {
        text.inputEl.setAttribute('aria-label', name);
        return text.setValue(draft[key]).onChange(value => { draft[key] = value; this.advancedInput = draft; });
      }).settingEl);
    }
    fields.forEach(row => { row.hidden = !draft.enabled; });
    const error = alert(editor);
    new Setting(editor).setName('Backend draft')
      .addButton(button => button.setButtonText('Save setup').onClick(async () => {
        const result = advancedDraft(draft);
        if (!result.ok) { error.textContent = result.message; return; }
        if (await this.commit(settings => { settings.advanced = result.value; }, error)) {
          this.advancedInput = undefined; this.openEditors.delete('backend'); this.display('backend');
        }
      }))
      .addButton(button => button.setButtonText('Cancel').onClick(() => {
        this.advancedInput = undefined; this.openEditors.delete('backend'); this.display('backend');
      }));

    const legacy = heading(section, 'Legacy synthetic probe (diagnostic only)');
    new Setting(legacy).setName('Synthetic fixtures only')
      .setDesc('Not part of basic search. This tool does not run automatically.');
    const probe = this.probeInput ?? structuredClone(this.current().probe);
    const { form: probeForm } = settingsDisclosure(legacy, this.openEditors, 'probe',
      'Probe setup', 'Configure probe', () => { this.probeInput = probe; });
    const paths: HTMLElement[] = [];
    new Setting(probeForm).setName('Enable manual synthetic probe')
      .addToggle(toggle => { toggle.toggleEl.setAttribute('aria-label', 'Enable manual synthetic probe');
        return toggle.setValue(probe.fixtureMode).onChange(value => {
        probe.fixtureMode = value; this.probeInput = probe;
        paths.forEach(row => { row.hidden = !value; });
      }); });
    for (const [key, name] of [
      ['interpreter', 'Trusted Python executable'], ['entry', 'Trusted synthetic probe entry'],
    ] as const) paths.push(new Setting(probeForm).setName(name).addText(text => {
      text.inputEl.setAttribute('aria-label', name);
      return text.setValue(probe[key]).onChange(value => { probe[key] = value; this.probeInput = probe; });
    }).settingEl);
    paths.forEach(row => { row.hidden = !probe.fixtureMode; });
    const probeError = alert(probeForm);
    new Setting(probeForm).setName('Probe draft')
      .addButton(button => button.setButtonText('Save setup').onClick(async () => {
        const result = probeDraft(probe);
        if (!result.ok) { probeError.textContent = result.message; return; }
        if (await this.commit(settings => { settings.probe = result.value; }, probeError)) {
          this.probeInput = undefined; this.openEditors.delete('probe'); this.display('probe');
        }
      }))
      .addButton(button => button.setButtonText('Cancel').onClick(() => {
        this.probeInput = undefined; this.openEditors.delete('probe'); this.display('probe');
      }));
  }

  /** Refresh only operational rows; never replace an editor that owns an unsaved draft. */
  private refreshReadOnly(): void {
    const root = this.containerEl;
    const restoreRefresh = (root.ownerDocument.activeElement as HTMLElement | null)?.dataset.oksFocus === 'refresh';
    const redraw = (label: string, render: () => void): void => {
      const old = [...root.children].find(child =>
        child.getAttribute('aria-label') === label);
      if (!old) return;
      const following = old.nextSibling;
      old.remove();
      render();
      const fresh = root.lastElementChild;
      if (fresh && following) root.insertBefore(fresh, following);
    };
    redraw('Overview', () => this.showOverview(root));
    redraw('Index & maintenance', () => this.showIndex(root));
    refreshProviderOperationStatus(root, this.aiOperationStatus);
    if (restoreRefresh) restoreSettingsFocus(root, 'refresh');
  }

  display(focusKey?: string): void {
    const root = this.containerEl;
    root.replaceChildren();
    applySettingsLayout(root, true);
    root.createEl('h2', { text: 'Obsidian Knowledge Search' });
    const expert = this.current().presentationMode === 'expert';
    const modeError = alert(root);
    new Setting(root).setName('Settings view')
      .setDesc('Basic/Expert changes the presentation only, not providers, permissions or index activity.')
      .addDropdown(dropdown => { dropdown.selectEl.setAttribute('aria-label', 'Settings view'); dropdown.selectEl.dataset.oksFocus = 'view'; return dropdown.addOption('basic','Basic')
        .addOption('expert','Expert').setValue(expert ? 'expert' : 'basic')
        .onChange(async value => {
          if (await this.commit(settings => {
            settings.presentationMode = value as SearchSettings['presentationMode'];
          }, modeError)) this.display('view');
          else dropdown.setValue(this.current().presentationMode);
        }); });
    this.showOverview(root);
    this.showSearch(root);
    const ai = heading(root, 'AI capabilities (optional)');
    ai.createEl('p', { text: 'Configure each task independently. Preferences are not readiness or ' +
      'permission to disclose content. Credentials are never entered or saved here.' });
    renderProviderSettings(ai, this.app, this.current().ai, this.aiInputs, this.openEditors, expert,
      (role, preference) => this.patchSettings(settings => { settings.ai[role] = preference; }),
      focusKey => this.display(focusKey), this.aiOperationStatus);
    this.showDocuments(root);
    this.showIndex(root);
    if (expert) this.showExpert(root);
    if (focusKey) restoreSettingsFocus(root, focusKey);
  }
}
