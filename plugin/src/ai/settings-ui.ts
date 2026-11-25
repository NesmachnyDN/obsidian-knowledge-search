import { Modal, Setting, getLanguage, type App } from 'obsidian';
import { preferenceStatus } from './config';
import { renderConnectionCheck } from './connection-check-ui';
import { translateSettings, formatSettings } from '../search/settings-i18n';
import { applySettingsLayout, settingsDisclosure } from '../search/settings-layout';
import { AI_ROLES, type AiRole, type ProviderConfig, type ProviderPreference,
  type ProviderPreferences, type AiOperationStatus } from './contracts';
import { embeddingSpaceChanged, newProviderDraft, providerDraft,
  type ProviderDraft } from '../search/settings-draft';

const t = (source: string): string => translateSettings(source, getLanguage());
const f = (source: string, values: Record<string, string | number>): string =>
  formatSettings(source, values, getLanguage());

export type AiDrafts = Partial<Record<AiRole, ProviderDraft>>;
const titles: Record<AiRole, string> = {
  embedding: 'Semantic search · embeddings',
  reranking: 'Improve result ranking · reranking',
  generation: 'Evidence-based answers · LLM',
};

export type OperationStatusReader = (role: AiRole) => AiOperationStatus;
function operationText(status?: AiOperationStatus): string {
  if (!status || status.phase === 'idle') return t('No current verified operation. Authorization is required for the next operation.');
  if (status.phase === 'permission-required') return t('Permission required: review and authorize the exact operation in Search.');
  if (status.phase === 'busy') return t('Busy: preparing or executing the explicit operation.');
  if (status.phase === 'complete') return t('Completed: the last authorized operation succeeded. This is not a standing readiness or consent grant.');
  return f('Failed or cancelled: {error}. Offline search remains separate.', {error: status.error ?? 'NOT_READY'});
}
export function refreshProviderOperationStatus(root: HTMLElement, status?: OperationStatusReader): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-oks-operation]')) {
    const role = el.dataset.oksOperation as AiRole;
    if (AI_ROLES.includes(role)) el.textContent = operationText(status?.(role));
  }
}

/** A preference is never proof of readiness, a consent grant, or an API call. */
export function renderProviderSettings(root: HTMLElement, app: App, preferences: ProviderPreferences,
  drafts: AiDrafts, openEditors: Set<string>, expert: boolean,
  save: (role: AiRole, preference: ProviderPreference) => Promise<void>,
  refresh: (focusKey: string) => void, operationStatus?: OperationStatusReader): () => void {
  const disposers: (() => void)[] = [];
  for (const role of AI_ROLES) {
    const pref = preferences[role];
    const known = preferenceStatus(role, pref);
    const section = root.createEl('section');
    section.className = 'oks-settings-role';
    section.setAttribute('aria-label', t(titles[role]));
    const heading = section.createEl('h3', { text: t(titles[role]) });
    heading.tabIndex = -1;
    const headline = pref.state === 'disabled' ? 'Disabled · Not configured' :
      pref.state === 'invalid' ? 'Unavailable · Invalid saved preferences' :
        'Configured / not verified · Permission required for each disclosed operation';
    new Setting(section).setName(t('Provider state'))
      .setDesc(t(headline) + (known.error ? ' (' + known.error + ')' : '') +
        t('. Only an explicit connection check sends synthetic test data.'));
    const operation = new Setting(section).setName(t('Current AI operation'))
      .setDesc(operationText(operationStatus?.(role)));
    operation.descEl.dataset.oksOperation = role;
    const draft = drafts[role] ?? newProviderDraft(pref);
    const key = 'ai-' + role;
    let resetCheck = (): void => {};
    const disclosure = settingsDisclosure(section, openEditors, key, 'Connection', 'Configure',
      () => { drafts[role] = draft; }, () => resetCheck());
    const form = disclosure.form;
    form.setAttribute('aria-label', t(titles[role]) + ' ' + t('editor'));
    const finish = (): void => {
      resetCheck(); delete drafts[role]; openEditors.delete(key); refresh(key);
    };
    const localHelp = form.createEl('p', { text:
      t('Local means literal 127.0.0.1 or [::1]; it is not automatically trusted or ready.') });
    const cloudHelp = form.createEl('p', { text:
      t('Cloud remains unauthorised without separate source-scoped approval. Saving an origin does not permit data egress.') });
    const showTransport = (): void => {
      localHelp.hidden = draft.transport !== 'local';
      cloudHelp.hidden = draft.transport !== 'cloud';
    };
    new Setting(form).setName(t('Connection type'))
      .addDropdown(dropdown => { dropdown.selectEl.setAttribute('aria-label', t(titles[role]) + ' ' + t('connection type')); return dropdown.addOption('local', t('Local API (loopback)'))
        .addOption('cloud', t('Cloud HTTPS (authorization required)'))
        .setValue(draft.transport).onChange(value => {
          draft.transport = value as ProviderDraft['transport']; drafts[role] = draft; showTransport(); resetCheck();
        }); });
    showTransport();
    for (const [key, title, help] of [
      ['origin', 'API origin', 'Origin only; no path, token, query or credentials.'],
      ['model', 'Model ID', 'Exact server model identity; no inferred default.'],
      ['revision', 'Model revision', 'Explicit revision; do not guess a model version.'],
    ] as const) {
      new Setting(form).setName(t(title)).setDesc(t(help))
        .addText(text => { text.inputEl.setAttribute('aria-label', t(titles[role]) + ' ' + t(title));
          return text.setValue(draft[key]).setPlaceholder(key === 'origin' ?
          'http://127.0.0.1:8765' : t('Required'))
          .onChange(value => { draft[key] = value; drafts[role] = draft; resetCheck(); }); });
    }
    if (expert) {
      for (const [key, title] of [
        ['timeoutMs','Timeout (ms, 100–30000)'],
        ['maxInputBytes','Maximum input (bytes, 1–65536)'],
        ['maxCandidates','Maximum candidates (1–50)'],
        ['maxOutputTokens','Maximum output tokens (1–4096)'],
      ] as const) {
        new Setting(form).setName(t(title)).addText(text => {
          text.inputEl.type = 'number';
          text.inputEl.setAttribute('aria-label', t(titles[role]) + ' ' + t(title));
          text.setValue(draft[key]).onChange(value => { draft[key] = value; drafts[role] = draft; resetCheck(); });
        });
      }
    }
    if (role === 'embedding') {
      form.createEl('p', { text: t('Changing the embedding connection/model identity changes the embedding space. Existing dense generations remain bound to their original space; a separately authorized, staged rebuild is required. No automatic indexing occurs.') });
    } else {
      form.createEl('p', { text: t('Changing this role does not rebuild or replace the dense index.') });
    }
    const connection = renderConnectionCheck(form, role, draft, t(titles[role]));
    resetCheck = connection.reset;
    disposers.push(connection.dispose);
    const error = form.createEl('p'); error.setAttribute('role', 'alert');
    error.setAttribute('aria-live', 'polite');
    const persist = async (next: ProviderConfig): Promise<void> => {
      try {
        await save(role, next);
        finish();
      } catch {
        error.textContent = t('Settings could not be saved. Your unsaved draft is retained.');
      }
    };
    new Setting(form).setName(t('Draft preferences'))
      .addButton(button => button.setButtonText(t('Save connection'))
        .onClick(async () => {
          resetCheck();
          const result = providerDraft(draft);
          if (!result.ok) { error.textContent = t(result.message); return; }
          error.textContent = '';
          if (role === 'embedding' && embeddingSpaceChanged(pref, result.value)) {
            const next = result.value;
            const confirm = new class extends Modal {
              onOpen(): void {
                applySettingsLayout(this.contentEl);
                this.contentEl.createEl('h3', { text: t('Embedding space change') });
                this.contentEl.createEl('p', { text:
                  t('The existing dense generation is not compatible with a new model identity. No automatic rebuild will run. Preserve the previous verified generation until an explicit, staged rebuild is accepted.') });
                new Setting(this.contentEl)
                  .addButton(b => b.setButtonText(t('Cancel')).onClick(() => this.close()))
                  .addButton(b => b.setButtonText(t('Save preferences only')).onClick(async () => {
                    this.close(); await persist(next);
                  }));
              }
            }(app);
            confirm.open();
          } else await persist(result.value);
        }))
      .addButton(button => button.setButtonText(t('Cancel draft')).onClick(() => {
        finish();
      }))
      .addButton(button => button.setButtonText(t('Disable role')).setWarning().onClick(async () => {
        resetCheck();
        try { await save(role, { state: 'disabled' }); finish(); }
        catch { error.textContent = t('Disable failed. Saved settings were not changed.'); }
      }));
    if (pref.state === 'configured') {
      new Setting(section).setName(t('Active assignment'))
        .setDesc(t(pref.transport === 'cloud' ? 'Cloud / not authorized' :
          'Local API / not verified'))
        .addButton(b => b.setButtonText(t('Details')).onClick(() => {
          disclosure.open();
        }));
    }
  }
  return () => { for (const dispose of disposers) dispose(); };
}
