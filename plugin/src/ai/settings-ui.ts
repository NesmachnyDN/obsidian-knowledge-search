import { Modal, Notice, Setting, type App } from 'obsidian';
import { preferenceStatus } from './config';
import { AI_ROLES, type AiRole, type ProviderConfig, type ProviderPreference,
  type ProviderPreferences } from './contracts';
import { embeddingSpaceChanged, newProviderDraft, providerDraft,
  type ProviderDraft } from '../search/settings-draft';

export type AiDrafts = Partial<Record<AiRole, ProviderDraft>>;
const titles: Record<AiRole, string> = {
  embedding: 'Semantic search · embeddings',
  reranking: 'Improve result ranking · reranking',
  generation: 'Evidence-based answers · LLM',
};

/** A preference is never proof of readiness, a consent grant, or an API call. */
export function renderProviderSettings(root: HTMLElement, app: App, preferences: ProviderPreferences,
  drafts: AiDrafts, expert: boolean,
  save: (role: AiRole, preference: ProviderPreference) => Promise<void>,
  refresh: () => void): void {
  for (const role of AI_ROLES) {
    const pref = preferences[role];
    const known = preferenceStatus(role, pref);
    const section = root.createEl('section');
    section.className = 'oks-settings-role';
    section.setAttribute('aria-label', titles[role]);
    const heading = section.createEl('h3', { text: titles[role] });
    heading.tabIndex = -1;
    const headline = pref.state === 'disabled' ? 'Disabled · Not configured' :
      pref.state === 'invalid' ? 'Unavailable · Invalid saved preferences' :
        'Configured / not verified · Permission required for each disclosed operation';
    new Setting(section).setName('Provider state')
      .setDesc(headline + (known.error ? ' (' + known.error + ')' : '') +
        '. No connection is tested or content transmitted from Settings.');
    const draft = drafts[role] ?? newProviderDraft(pref);
    const form = section.createEl('div');
    form.hidden = !drafts[role];
    form.setAttribute('aria-label', titles[role] + ' editor');
    new Setting(section).setName('Connection')
      .addButton(button => button.setButtonText(drafts[role] ? 'Close editor' : 'Configure')
        .onClick(() => {
          if (form.hidden) { drafts[role] = draft; form.hidden = false; button.setButtonText('Close editor'); }
          else { form.hidden = true; button.setButtonText('Configure'); }
        }));
    const localHelp = form.createEl('p', { text:
      'Local means literal 127.0.0.1 or [::1]; it is not automatically trusted or ready.' });
    const cloudHelp = form.createEl('p', { text:
      'Cloud remains unauthorised without separate source-scoped approval. Saving an origin does not permit data egress.' });
    const showTransport = (): void => {
      localHelp.hidden = draft.transport !== 'local';
      cloudHelp.hidden = draft.transport !== 'cloud';
    };
    new Setting(form).setName('Connection type')
      .addDropdown(dropdown => { dropdown.selectEl.setAttribute('aria-label', titles[role] + ' connection type'); return dropdown.addOption('local', 'Local API (loopback)')
        .addOption('cloud', 'Cloud HTTPS (authorization required)')
        .setValue(draft.transport).onChange(value => {
          draft.transport = value as ProviderDraft['transport']; drafts[role] = draft; showTransport();
        }); });
    showTransport();
    for (const [key, title, help] of [
      ['origin', 'API origin', 'Origin only; no path, token, query or credentials.'],
      ['model', 'Model ID', 'Exact server model identity; no inferred default.'],
      ['revision', 'Model revision', 'Explicit revision; do not guess a model version.'],
    ] as const) {
      new Setting(form).setName(title).setDesc(help)
        .addText(text => { text.inputEl.setAttribute('aria-label', titles[role] + ' ' + title);
          return text.setValue(draft[key]).setPlaceholder(key === 'origin' ?
          'http://127.0.0.1:8765' : 'Required')
          .onChange(value => { draft[key] = value; drafts[role] = draft; }); });
    }
    if (expert) {
      for (const [key, title] of [
        ['timeoutMs','Timeout (ms, 100–30000)'],
        ['maxInputBytes','Maximum input (bytes, 1–65536)'],
        ['maxCandidates','Maximum candidates (1–50)'],
        ['maxOutputTokens','Maximum output tokens (1–4096)'],
      ] as const) {
        new Setting(form).setName(title).addText(text => {
          text.inputEl.type = 'number';
          text.inputEl.setAttribute('aria-label', titles[role] + ' ' + title);
          text.setValue(draft[key]).onChange(value => { draft[key] = value; drafts[role] = draft; });
        });
      }
    }
    if (role === 'embedding') {
      form.createEl('p', { text: 'Changing the embedding connection/model identity changes the ' +
        'embedding space. Existing dense generations remain bound to their original space; ' +
        'a separately authorized, staged rebuild is required. No automatic indexing occurs.' });
    } else {
      form.createEl('p', { text: 'Changing this role does not rebuild or replace the dense index.' });
    }
    const error = form.createEl('p'); error.setAttribute('role', 'alert');
    error.setAttribute('aria-live', 'polite');
    const persist = async (next: ProviderConfig): Promise<void> => {
      try {
        await save(role, next);
        delete drafts[role];
        refresh();
      } catch {
        error.textContent = 'Settings could not be saved. Your unsaved draft is retained.';
      }
    };
    new Setting(form).setName('Draft preferences')
      .addButton(button => button.setButtonText('Save connection')
        .onClick(async () => {
          const result = providerDraft(draft);
          if (!result.ok) { error.textContent = result.message; return; }
          error.textContent = '';
          if (role === 'embedding' && embeddingSpaceChanged(pref, result.value)) {
            const next = result.value;
            const confirm = new class extends Modal {
              onOpen(): void {
                this.contentEl.createEl('h3', { text: 'Embedding space change' });
                this.contentEl.createEl('p', { text:
                  'The existing dense generation is not compatible with a new model identity. ' +
                  'No automatic rebuild will run. Preserve the previous verified generation ' +
                  'until an explicit, staged rebuild is accepted.' });
                new Setting(this.contentEl)
                  .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
                  .addButton(b => b.setButtonText('Save preferences only').onClick(async () => {
                    this.close(); await persist(next);
                  }));
              }
            }(app);
            confirm.open();
          } else await persist(result.value);
        }))
      .addButton(button => button.setButtonText('Cancel draft').onClick(() => {
        delete drafts[role]; refresh();
      }))
      .addButton(button => button.setButtonText('Disable role').setWarning().onClick(async () => {
        try { await save(role, { state: 'disabled' }); delete drafts[role]; refresh(); }
        catch { error.textContent = 'Disable failed. Saved settings were not changed.'; }
      }));
    if (pref.state === 'configured') {
      new Setting(section).setName('Active assignment')
        .setDesc(pref.transport === 'cloud' ? 'Cloud / not authorized' :
          'Local API / not verified')
        .addButton(b => b.setButtonText('Details').onClick(() => {
          drafts[role] = draft; form.hidden = false;
        }));
    }
  }
}
