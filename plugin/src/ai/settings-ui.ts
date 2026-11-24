import { Notice, Setting } from 'obsidian';
import { parsePreference, preferenceStatus } from './config';
import { AI_ROLES, type AiRole, type ProviderPreference, type ProviderPreferences } from './contracts';

/** Preferences only. No network, secret fields, consent issuance or model activation. */
export function renderProviderSettings(root: HTMLElement, preferences: ProviderPreferences,
  save: (role: AiRole, preference: ProviderPreference) => Promise<void>): void {
  for (const role of AI_ROLES) {
    const current = preferences[role];
    const status = preferenceStatus(role, current);
    let transport = current.state === 'configured' ? current.transport : 'local';
    let origin = current.state === 'configured' ? current.origin : '';
    let model = current.state === 'configured' ? current.identity.model : '';
    let revision = current.state === 'configured' ? current.identity.revision : '';
    const limits = current.state === 'configured' ? current.limits :
      { timeoutMs: 10000, maxInputBytes: 16384, maxCandidates: 20, maxOutputTokens: 1024, maxConcurrent: 1 };
    new Setting(root).setName('AI provider: ' + role)
      .setDesc(status.state + (status.error ? ' (' + status.error + ')' : '') +
        '. Preferences only; no requests are sent. Do not enter secrets.');
    new Setting(root).setName(role + ' transport').addDropdown(d => d
      .addOption('local', 'Literal loopback').addOption('cloud', 'HTTPS cloud (not authorized)')
      .setValue(transport).onChange(v => { transport = v as typeof transport; }));
    new Setting(root).setName(role + ' origin (no path or credentials)')
      .addText(t => t.setValue(origin).onChange(v => { origin = v; }));
    new Setting(root).setName(role + ' model ID')
      .addText(t => t.setValue(model).onChange(v => { model = v; }));
    new Setting(root).setName(role + ' model revision')
      .addText(t => t.setValue(revision).onChange(v => { revision = v; }));
    new Setting(root).setName(role + ' preferences')
      .addButton(b => b.setButtonText('Save preferences').onClick(async () => {
        const parsed = parsePreference({ state:'configured', transport, origin, identity:{model, revision}, limits });
        if (parsed.state !== 'configured') { new Notice('OKS: invalid AI provider preferences.'); return; }
        await save(role, parsed);
      }))
      .addButton(b => b.setButtonText('Disable').onClick(() => save(role, {state:'disabled'})));
  }
}
