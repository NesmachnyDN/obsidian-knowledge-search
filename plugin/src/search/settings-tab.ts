import { defaultMarkingRules, validNewMaterialRuleConfig, MAX_RULE_CONFIG_BYTES, type NewMaterialRuleConfig, type MarkAction, type NewMaterialDecision } from '../ai/new-material-policy';
import type { AdvancedHealth, AdvancedConfig } from '../advanced/health';
import type { IngestionStatus } from '../advanced/manager';
import type { RetrievalStatus } from '../advanced/retrieval-manager';
import type { ProbeConfig } from '../controller';
import { Modal, PluginSettingTab, Setting, Notice, getLanguage, type App, type Plugin } from 'obsidian';
import { renderProviderSettings, refreshProviderOperationStatus, type AiDrafts, type OperationStatusReader } from '../ai/settings-ui';
import { translateSettings, formatSettings, localizeSettingsState, type SettingsDisplayState } from './settings-i18n';
import { applySettingsLayout, restoreSettingsFocus, settingsDisclosure } from './settings-layout';
import { advancedDraft, ingestionDraft, needsOcr, needsStructure, probeDraft, topKDraft } from './settings-draft';
import type { IngestionConfig, SearchSettings } from './settings';
import { configuredGraph, parseGraphDraft } from './graph-settings';
import type { SearchResponse } from '../standalone/contracts';
import type { SearchStatus } from './status';

const t = (source: string): string => translateSettings(source, getLanguage());
const f = (source: string, values: Record<string, string | number>): string =>
  formatSettings(source, values, getLanguage());
const st = (state?: SettingsDisplayState): string => localizeSettingsState(state, getLanguage());

type BasicResponse = Pick<SearchResponse, 'requestedMode' | 'executedMode' | 'status'>;
const heading = (root: HTMLElement, name: string): HTMLElement => {
  const section = root.createEl('section');
  section.setAttribute('aria-label', t(name));
  section.createEl('h3', { text: t(name) });
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
  private markingDraft?: {defaultAction:MarkAction;rules:string};
  private markingViewEpoch=0;
  private graphDraft?: string;
  private advancedInput?: AdvancedConfig;
  private ingestionInput?: IngestionConfig;
  private probeInput?: ProbeConfig;
  private readonly aiInputs: AiDrafts = {};
  private readonly openEditors = new Set<string>();
  private releaseProviderChecks?: () => void;

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
    private readonly aiOperationStatus?: OperationStatusReader,
    private readonly previewMarking?: (config:NewMaterialRuleConfig)=>Promise<NewMaterialDecision>) {
    super(app, plugin);
    plugin.register(() => this.hide());
  }

  hide(): void {
    this.markingViewEpoch++;
    this.releaseProviderChecks?.();
    this.releaseProviderChecks = undefined;
  }

  private async commit(change: (s: SearchSettings) => void, error: HTMLElement): Promise<boolean> {
    try {
      await this.patchSettings(change);
      error.textContent = '';
      return true;
    } catch {
      // No full redraw after failure; preserve the exact draft, focus and committed state.
      error.textContent = t('Could not save. The unsaved draft is retained; retry or cancel.');
      return false;
    }
  }

  private showOverview(root: HTMLElement): void {
    const section = heading(root, 'Overview');
    const s = this.searchStatus?.();
    new Setting(section).setName(t('Offline Markdown search'))
      .setDesc(s ? f('Status: {status}; {enabled}; {paused}; error: {error}.', {
        status: st(s.status), enabled: t(s.enabled ? 'enabled' : 'disabled'),
        paused: t(s.paused ? 'paused' : 'not paused'), error: s.error ?? t('none'),
      }) : t('State not yet available. No AI service is required.'));
    const roles = this.current().ai;
    const active = (Object.keys(roles) as (keyof typeof roles)[])
      .filter(role => roles[role].state !== 'disabled');
    new Setting(section).setName(t('Optional AI capabilities'))
      .setDesc(active.length ? active.map(role => f('{role}: {status}', {
        role: t(role), status: t(roles[role].state === 'configured' ?
          'configured, not verified' : 'invalid / unavailable'),
      })).join('; ') + '. ' + t('Configuration is not execution authorization.') :
        t('All optional AI roles are disabled. Basic search works without an API.'));
    const settings = this.current();
    const health = this.health();
    const ingestion = this.ingestionStatus?.();
    new Setting(section).setName(t('Optional local capabilities'))
      .setDesc(f('Health-only backend: {backend}; document ingestion: {ingestion}; legacy synthetic probe: {probe}. Health and processing state do not imply AI readiness. Backend and probe setup: Expert.', {
        backend: settings.advanced.enabled ?
          f('enabled; transport state: {status}', {status: st(health.status)}) +
          (health.error ? ' (' + health.error + ')' : '') : t('disabled'),
        ingestion: settings.ingestion.enabled ?
          f('enabled; processing state: {status}', {status: st(ingestion?.status ?? 'unavailable')}) : t('disabled'),
        probe: settings.probe.fixtureMode ?
          t('enabled for manual use; not a running-state indicator') : t('disabled'),
      }));
    section.createEl('p', { text: t('Basic search works offline with no Python, API key, model or download. Other formats and AI operations require their own independently accepted capability.') });
  }

  private showSearch(root: HTMLElement): void {
    const section = heading(root, 'Search & scope');
    for (const [key, name, explanation] of [
      ['enabled', 'Enable offline search', 'Disable to stop indexing and clear results. Original notes remain untouched.'],
      ['paused', 'Pause indexing', 'Resume to reconcile source changes. Evidence is always verified.'],
      ['propertiesEnabled', 'Enable typed Properties filters', 'Explicit typed filtering in the search view.'],
    ] as const) {
      const status = alert(section);
      new Setting(section).setName(t(name)).setDesc(t(explanation))
        .addToggle(toggle => { toggle.toggleEl.setAttribute('aria-label', t(name));
          toggle.toggleEl.dataset.oksFocus = key;
          return toggle.setValue(this.current()[key]).onChange(async value => {
          if (!(await this.commit(settings => { settings[key] = value; }, status)))
            toggle.setValue(this.current()[key]);
          else this.display(key);
        }); });
    }
    this.topKInput ??= String(this.current().topK);
    const error = alert(section);
    new Setting(section).setName(t('Results per search'))
      .setDesc(t('Whole number between 1 and 50. Applied only when Save is selected.'))
      .addText(text => {
        text.inputEl.type = 'number';
        text.inputEl.setAttribute('aria-label', t('Results per search'));
        text.inputEl.dataset.oksFocus = 'top-k';
        text.inputEl.min = '1'; text.inputEl.max = '50';
        text.setValue(this.topKInput!).onChange(value => { this.topKInput = value; error.textContent = ''; });
      });
    new Setting(section).setName(t('Results draft'))
      .addButton(button => button.setButtonText(t('Save')).onClick(async () => {
        const result = topKDraft(this.topKInput!);
        if (!result.ok) { error.textContent = t(result.message); return; }
        if (await this.commit(settings => { settings.topK = result.value; }, error)) {
          this.topKInput = undefined; this.display('top-k');
        }
      }))
      .addButton(button => button.setButtonText(t('Cancel')).onClick(() => {
        this.topKInput = undefined; this.display('top-k');
      }));
  }

  private showDocuments(root: HTMLElement): void {
    const section = heading(root, 'Documents');
    new Setting(section).setName(t('Local document processing (optional)'))
      .setDesc(t('Markdown search never depends on Python, OCR or structured extraction. PDF/DOCX/OCR readiness is not claimed by turning on a preference.'));
    const ingest = this.ingestionStatus?.();
    new Setting(section).setName(t('Last processing state'))
      .setDesc(f('{status}; format: {format}; error: {error}. Not proof of search readiness.', {
        status: st(ingest?.status ?? 'disabled'), format: ingest?.lastFormat ?? t('none'),
        error: ingest?.error ?? t('none'),
      }));
    const draft = this.ingestionInput ?? structuredClone(this.current().ingestion);
    const { form: editor } = settingsDisclosure(section, this.openEditors, 'documents',
      'Processing setup', 'Configure documents', () => { this.ingestionInput = draft; });
    const fields: Partial<Record<keyof IngestionConfig, HTMLElement>> = {};
    new Setting(editor).setName(t('Enable local document ingestion after Save'))
      .addToggle(toggle => {
        toggle.toggleEl.setAttribute('aria-label', t('Enable local document ingestion after Save'));
        return toggle.setValue(draft.enabled).onChange(value => {
          draft.enabled = value; this.ingestionInput = draft; syncFields();
        });
      });
    const mode = new Setting(editor).setName(t('PDF processing mode'))
      .setDesc(t('Explicit mode; no hidden OCR or structural fallback.'))
      .addDropdown(dropdown => { dropdown.selectEl.setAttribute('aria-label', t('PDF processing mode')); return dropdown
        .addOption('text', t('Native text PDF'))
        .addOption('ocr', t('OCR (RU/EN Tesseract)'))
        .addOption('structured', t('Structured layout and tables'))
        .addOption('structured-ocr', t('Structured + OCR'))
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
      const row = new Setting(editor).setName(t(title))
        .addText(text => { text.inputEl.setAttribute('aria-label', t(title)); return text.setValue(draft[key]).onChange(value => {
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
    new Setting(editor).setName(t('Document setup draft'))
      .addButton(button => button.setButtonText(t('Save setup')).onClick(async () => {
        const result = ingestionDraft(draft);
        if (!result.ok) { error.textContent = t(result.message); return; }
        if (await this.commit(settings => { settings.ingestion = result.value; }, error)) {
          this.ingestionInput = undefined; this.openEditors.delete('documents'); this.display('documents');
        }
      }))
      .addButton(button => button.setButtonText(t('Cancel')).onClick(() => {
        this.ingestionInput = undefined; this.openEditors.delete('documents'); this.display('documents');
      }));
    if (this.ingestActive) {
      const result = alert(section);
      new Setting(section).setName(t('Process active source'))
        .setDesc(t('Manual operation on the selected source only; no bulk indexing.'))
        .addButton(button => button.setButtonText(t('Ingest active document'))
          .setDisabled(!this.current().ingestion.enabled).onClick(async () => {
            try { await this.ingestActive?.(); this.display(); }
            catch { result.textContent = t('Ingestion refused or failed. Check diagnostics.'); }
          }));
    }
  }

  private showIndex(root: HTMLElement): void {
    const section = heading(root, 'Index & maintenance');
    const basic = this.searchStatus?.();
    new Setting(section).setName(t('Offline index'))
      .setDesc(basic ? f('Status: {status}; indexed sources: {sources}; records: {records}; busy: {busy}; warning: {warning}; error: {error}. Counts are not an estimate of total Vault coverage.', {
        status: st(basic.status), sources: basic.sources, records: basic.records,
        busy: t(basic.busy ? 'yes' : 'no'), warning: basic.maintenanceWarning ?? t('none'),
        error: basic.error ?? t('none'),
      }) : t('Index state not available.'));
    const last = this.lastBasic?.();
    new Setting(section).setName(t('Last verified basic search'))
      .setDesc(last ? f('Requested: {requested}; executed: {executed}; result: {result}.', {
        requested: st(last.requestedMode), executed: st(last.executedMode), result: st(last.status),
      }) : t('No current search response. Requested and executed modes appear in search results.'));
    const embedding = this.current().ai.embedding;
    const apiState = embedding.state === 'disabled' ? 'Provider disabled.' :
      embedding.state === 'invalid' ? 'Unavailable: invalid saved provider preferences.' :
        embedding.state === 'configured' && embedding.transport === 'cloud' ? 'Unavailable: cloud execution is not supported by the current local API pilot.' :
          'Local provider configured; not verified by preferences.';
    new Setting(section).setName(t('API dense index (selected Markdown corpus)'))
      .setDesc(t(apiState) + ' ' + t('Index readiness and coverage are not verified in Settings. Use Open Standalone search → Optional local API dense / hybrid search → Prepare explicit dense index rebuild. Select exact corpus paths and vector dimension, then authorize the operation. No automatic rebuild.'));
    const retrieval = this.retrievalStatus?.();
    new Setting(section).setName(t('Legacy local BGE-M3 index (documents)'))
      .setDesc(retrieval ? f('State: {status}; lexical: {lexical}; dense: {dense}; indexed sources: {sources}; chunks: {chunks}; error: {error}. This is not the API dense index.', {
        status: st(retrieval.status), lexical: st(retrieval.lexical), dense: st(retrieval.dense),
        sources: retrieval.indexedSources, chunks: retrieval.indexedChunks,
        error: retrieval.error ?? t('none'),
      }) : t('Unavailable / not verified. This is not the API dense index.'));
    if (this.indexActive && this.rebuildActive && this.cancelAdvanced) {
      const error = alert(section);
      const action = async (task: () => Promise<void>): Promise<void> => {
        try { await task(); this.display(); }
        catch { error.textContent = t('Index operation failed or was refused. Check diagnostics.'); }
      };
      new Setting(section).setName(t('Legacy document index operations'))
        .setDesc(t('Local BGE-M3, active document only. These actions do not rebuild the API dense index. Verified previous generations remain protected by storage contracts.'))
        .addButton(button => button.setButtonText(t('Index legacy source'))
          .setDisabled(!this.current().ingestion.enabled)
          .onClick(() => action(this.indexActive!)))
        .addButton(button => button.setButtonText(t('Rebuild legacy source'))
          .setDisabled(!this.current().ingestion.enabled)
          .onClick(() => action(this.rebuildActive!)))
        .addButton(button => button.setButtonText(t('Cancel legacy operation'))
          .onClick(() => action(this.cancelAdvanced!)));
    }
    if (this.openAdvanced) new Setting(section).setName(t('Legacy document search'))
      .setDesc(t('Local BGE-M3 document search, separate from the API dense / hybrid search in Standalone.'))
      .addButton(button => button.setButtonText(t('Open legacy search'))
        .setDisabled(!this.current().ingestion.enabled).onClick(() => this.openAdvanced?.()));
    this.showPurge(section);
    new Setting(section).setName(t('Refresh status'))
      .setDesc(t('Manually reread existing state; does not trigger indexing or network access.'))
      .addButton(button => {
        button.buttonEl.dataset.oksFocus = 'refresh';
        return button.setButtonText(t('Refresh')).onClick(() => this.refreshReadOnly());
      });
  }

  private showPurge(section: HTMLElement): void {
    const purge = this.purge;
    new Setting(section).setName(t('Delete derived offline index'))
      .setDesc(t('Only when offline indexing is disabled. Removes recognized host-private index files, never notes.'))
      .addButton(button => button.setButtonText(t('Clear derived files')).setWarning()
        .setDisabled(this.current().enabled).onClick(() => {
          const confirm = new class extends Modal {
            onOpen(): void {
              applySettingsLayout(this.contentEl);
              this.contentEl.createEl('h3', { text: t('Confirm derived-index cleanup') });
              this.contentEl.createEl('p', { text: t('Only recognized host-private index files will be deleted. Original Vault notes will not be touched. Indexing must remain disabled.') });
              new Setting(this.contentEl)
                .addButton(b => b.setButtonText(t('Cancel')).onClick(() => this.close()))
                .addButton(b => b.setButtonText(t('Delete derived files')).setWarning().onClick(async () => {
                  try {
                    const count = await purge();
                    new Notice(f('OKS: cleared {count} derived files.', {count}));
                  } catch { new Notice(t('OKS: cleanup refused or failed.')); }
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
    new Setting(section).setName(t('Health-only local backend'))
      .setDesc(f('State: {status}; profile: {profile}; error: {error}. Health readiness never implies AI, OCR or document readiness.', {
        status: st(health.status), profile: st(health.profile), error: health.error ?? t('none'),
      }))
      .addButton(button => button.setButtonText(t('Recheck health'))
        .setDisabled(!this.current().advanced.enabled).onClick(async () => {
          try { await this.checkHealth(); this.display(); }
          catch { new Notice(t('OKS: health check failed.')); }
        }));
    const draft = this.advancedInput ?? structuredClone(this.current().advanced);
    const { form: editor } = settingsDisclosure(section, this.openEditors, 'backend',
      'Backend setup', 'Configure local backend', () => { this.advancedInput = draft; });
    const fields: HTMLElement[] = [];
    new Setting(editor).setName(t('Enable trusted local health backend after Save'))
      .addToggle(toggle => { toggle.toggleEl.setAttribute('aria-label', t('Enable trusted local health backend after Save'));
        return toggle.setValue(draft.enabled).onChange(value => {
        draft.enabled = value; this.advancedInput = draft;
        fields.forEach(row => { row.hidden = !draft.enabled; });
      }); });
    fields.push(new Setting(editor).setName(t('Backend profile')).addDropdown(dropdown => {
      dropdown.selectEl.setAttribute('aria-label', t('Backend profile'));
      return dropdown.addOption('none', t('None')).addOption('local-stdio',t('Trusted local stdio'))
        .setValue(draft.profile).onChange(value => {
          draft.profile = value as AdvancedConfig['profile']; this.advancedInput = draft;
        });
    }).settingEl);
    for (const [key, name] of [
      ['interpreter', 'Trusted absolute Python executable'],
      ['entry', 'Trusted absolute health entry'],
    ] as const) {
      fields.push(new Setting(editor).setName(t(name)).addText(text => {
        text.inputEl.setAttribute('aria-label', t(name));
        return text.setValue(draft[key]).onChange(value => { draft[key] = value; this.advancedInput = draft; });
      }).settingEl);
    }
    fields.forEach(row => { row.hidden = !draft.enabled; });
    const error = alert(editor);
    new Setting(editor).setName(t('Backend draft'))
      .addButton(button => button.setButtonText(t('Save setup')).onClick(async () => {
        const result = advancedDraft(draft);
        if (!result.ok) { error.textContent = t(result.message); return; }
        if (await this.commit(settings => { settings.advanced = result.value; }, error)) {
          this.advancedInput = undefined; this.openEditors.delete('backend'); this.display('backend');
        }
      }))
      .addButton(button => button.setButtonText(t('Cancel')).onClick(() => {
        this.advancedInput = undefined; this.openEditors.delete('backend'); this.display('backend');
      }));

    const legacy = heading(section, 'Legacy synthetic probe (diagnostic only)');
    new Setting(legacy).setName(t('Synthetic fixtures only'))
      .setDesc(t('Not part of basic search. This tool does not run automatically.'));
    const probe = this.probeInput ?? structuredClone(this.current().probe);
    const { form: probeForm } = settingsDisclosure(legacy, this.openEditors, 'probe',
      'Probe setup', 'Configure probe', () => { this.probeInput = probe; });
    const paths: HTMLElement[] = [];
    new Setting(probeForm).setName(t('Enable manual synthetic probe'))
      .addToggle(toggle => { toggle.toggleEl.setAttribute('aria-label', t('Enable manual synthetic probe'));
        return toggle.setValue(probe.fixtureMode).onChange(value => {
        probe.fixtureMode = value; this.probeInput = probe;
        paths.forEach(row => { row.hidden = !value; });
      }); });
    for (const [key, name] of [
      ['interpreter', 'Trusted Python executable'], ['entry', 'Trusted synthetic probe entry'],
    ] as const) paths.push(new Setting(probeForm).setName(t(name)).addText(text => {
      text.inputEl.setAttribute('aria-label', t(name));
      return text.setValue(probe[key]).onChange(value => { probe[key] = value; this.probeInput = probe; });
    }).settingEl);
    paths.forEach(row => { row.hidden = !probe.fixtureMode; });
    const probeError = alert(probeForm);
    new Setting(probeForm).setName(t('Probe draft'))
      .addButton(button => button.setButtonText(t('Save setup')).onClick(async () => {
        const result = probeDraft(probe);
        if (!result.ok) { probeError.textContent = t(result.message); return; }
        if (await this.commit(settings => { settings.probe = result.value; }, probeError)) {
          this.probeInput = undefined; this.openEditors.delete('probe'); this.display('probe');
        }
      }))
      .addButton(button => button.setButtonText(t('Cancel')).onClick(() => {
        this.probeInput = undefined; this.openEditors.delete('probe'); this.display('probe');
      }));
  }

  /** Refresh only operational rows; never replace an editor that owns an unsaved draft. */
  private refreshReadOnly(): void {
    const root = this.containerEl;
    const restoreRefresh = (root.ownerDocument.activeElement as HTMLElement | null)?.dataset.oksFocus === 'refresh';
    const redraw = (label: string, render: () => void): void => {
      const old = [...root.children].find(child =>
        child.getAttribute('aria-label') === t(label));
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

  private showMarkingRules(root:HTMLElement):void {
    const section=heading(root,'New-material processing rules');
    section.createEl('p',{text:t('Local dry run only. No note writes or provider authorization. Unknown lifecycle or provenance blocks external processing.')});
    const saved=this.current().markingRules??defaultMarkingRules();
    const draft=this.markingDraft??={defaultAction:saved.defaultAction,rules:JSON.stringify(saved.rules,null,2)};
    const error=alert(section),result=section.createEl('p');
    result.setAttribute('aria-live','polite');
    const epoch=this.markingViewEpoch;
    let draftRevision=0;
    const changed=()=>{draftRevision++;result.textContent='';};
    const parsed=():NewMaterialRuleConfig|null=>{
      try {
        if(Buffer.byteLength(draft.rules)>MAX_RULE_CONFIG_BYTES)return null;
        const value={...defaultMarkingRules(),defaultAction:draft.defaultAction,rules:JSON.parse(draft.rules)};
        return validNewMaterialRuleConfig(value)?value:null;
      }catch{return null;}
    };
    new Setting(section).setName(t('Default marking action')).addDropdown(dropdown=>{
      dropdown.selectEl.setAttribute('aria-label',t('Default marking action'));
      return dropdown.addOption('leave-absent',t('Leave absent')).addOption('set-external',t('Set external'))
        .addOption('set-private',t('Set private')).setValue(draft.defaultAction).onChange(value=>{draft.defaultAction=value as MarkAction;changed();});
    });
    new Setting(section).setName(t('Ordered rules (JSON)')).setDesc(t('Conditions: folderSegments, importChannel, type, template, tags, properties. Private overrides external.'))
      .addTextArea(text=>{
        text.inputEl.setAttribute('aria-label',t('Ordered rules (JSON)'));
        text.inputEl.rows=8;text.inputEl.maxLength=MAX_RULE_CONFIG_BYTES;
        return text.setValue(draft.rules).onChange(value=>{draft.rules=value;changed();});
      });
    new Setting(section).setName(t('Local rule actions'))
      .addButton(button=>button.setButtonText(t('Preview active note')).onClick(async()=>{
        const config=parsed();if(!config||!this.previewMarking){error.textContent=t('Invalid or unavailable marking rules.');return;}
        const revision=++draftRevision;error.textContent='';result.textContent=t('Checking local original…');
        try{
          const decision=await this.previewMarking(config);
          if(this.markingViewEpoch!==epoch||draftRevision!==revision)return;
          result.textContent=f('Action: {action}; reason: {reason}; marking gate blocked: {blocked}.',{
            action:t(decision.action==='set-private'?'Set private':decision.action==='set-external'?'Set external':'Leave absent'),
            reason:getLanguage().toLowerCase().startsWith('ru')?t('marking-reason-'+decision.reason):decision.reason,blocked:t(decision.externalBlocked?'yes':'no')});
        }catch{if(this.markingViewEpoch===epoch&&draftRevision===revision)result.textContent=t('Local preview unavailable.');}
      }))
      .addButton(button=>button.setButtonText(t('Save')).onClick(async()=>{
        const config=parsed();if(!config){error.textContent=t('Invalid or unavailable marking rules.');return;}
        if(this.markingViewEpoch!==epoch)return;
        const revision=++draftRevision;result.textContent='';
        if(await this.commit(settings=>{settings.markingRules=structuredClone(config);},error)
          &&this.markingViewEpoch===epoch&&draftRevision===revision){this.markingDraft=undefined;this.display();}
      }))
      .addButton(button=>button.setButtonText(t('Cancel')).onClick(()=>{if(this.markingViewEpoch!==epoch)return;this.markingDraft=undefined;this.display();}));
  }

  private showGraphSettings(root:HTMLElement):void {
    const section=heading(root,'Local knowledge graph');
    const pref=this.current().graph;
    new Setting(section).setName(t('Graph mapping state'))
      .setDesc(t(pref?.state==='configured'?'Graph mapping configured; readiness not verified.':
        pref?.state==='invalid'?'Invalid graph mapping; graph disabled.':'Graph disabled.'));
    const mapping=configuredGraph(pref);
    this.graphDraft ??= JSON.stringify(mapping??{schemaVersion:'oks-06b-mapping-v1',rules:[]});
    const error=alert(section), epoch=this.markingViewEpoch;
    let revision=0, saving=false;
    new Setting(section).setName(t('Graph mapping (JSON)'))
      .setDesc(t('Explicit local typed relations; no source changes, AI calls or automatic expansion.'))
      .addTextArea(text=>{
        text.inputEl.setAttribute('aria-label',t('Graph mapping (JSON)'));
        text.inputEl.rows=8;text.inputEl.maxLength=16*1024;
        return text.setValue(this.graphDraft!).onChange(value=>{
          this.graphDraft=value;revision++;error.textContent='';
        });
      });
    new Setting(section).setName(t('Graph mapping actions'))
      .addButton(button=>button.setButtonText(t('Save mapping')).onClick(async()=>{
        if(saving||this.markingViewEpoch!==epoch)return;
        const value=parseGraphDraft(this.graphDraft??'');
        if(!value){error.textContent=t('Invalid graph mapping.');return;}
        const started=revision;saving=true;
        try {
          if(await this.commit(s=>{s.graph={state:'configured',mapping:value};},error)
            &&this.markingViewEpoch===epoch&&started===revision){this.graphDraft=undefined;this.display();}
        }finally{saving=false;}
      }))
      .addButton(button=>button.setButtonText(t('Disable graph')).onClick(async()=>{
        if(saving||this.markingViewEpoch!==epoch)return;
        const started=revision;saving=true;
        try{
          if(await this.commit(s=>{s.graph={state:'disabled'};},error)
            &&this.markingViewEpoch===epoch&&started===revision){this.graphDraft=undefined;this.display();}
        }finally{saving=false;}
      }))
      .addButton(button=>button.setButtonText(t('Cancel')).onClick(()=>{
        if(saving||this.markingViewEpoch!==epoch)return;
        this.graphDraft=undefined;this.display();
      }));
  }

  display(focusKey?: string): void {
    this.hide();
    const root = this.containerEl;
    root.replaceChildren();
    applySettingsLayout(root, true);
    root.createEl('h2', { text: 'Obsidian Knowledge Search' });
    const expert = this.current().presentationMode === 'expert';
    const modeError = alert(root);
    new Setting(root).setName(t('Settings view'))
      .setDesc(t('Basic/Expert changes the presentation only, not providers, permissions or index activity.'))
      .addDropdown(dropdown => { dropdown.selectEl.setAttribute('aria-label', t('Settings view')); dropdown.selectEl.dataset.oksFocus = 'view'; return dropdown.addOption('basic',t('Basic'))
        .addOption('expert',t('Expert')).setValue(expert ? 'expert' : 'basic')
        .onChange(async value => {
          if (await this.commit(settings => {
            settings.presentationMode = value as SearchSettings['presentationMode'];
          }, modeError)) this.display('view');
          else dropdown.setValue(this.current().presentationMode);
        }); });
    this.showOverview(root);
    this.showSearch(root);
    const ai = heading(root, 'AI capabilities (optional)');
    ai.createEl('p', { text: t('Configure each task independently. Preferences are not readiness or permission to disclose content. Connection-check credentials are temporary and never saved.') });
    this.releaseProviderChecks = renderProviderSettings(ai, this.app, this.current().ai, this.aiInputs, this.openEditors, expert,
      (role, preference) => this.patchSettings(settings => { settings.ai[role] = preference; }),
      focusKey => this.display(focusKey), this.aiOperationStatus);
    this.showMarkingRules(root);
    this.showDocuments(root);
    this.showIndex(root);
    if (expert) { this.showGraphSettings(root); this.showExpert(root); }
    if (focusKey) restoreSettingsFocus(root, focusKey);
  }
}
