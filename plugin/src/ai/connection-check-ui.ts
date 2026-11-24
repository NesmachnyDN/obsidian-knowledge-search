import { Setting, getLanguage, type ButtonComponent } from 'obsidian';
import type { AiRole, ProviderFailureCode } from './contracts';
import { ConnectionCheckSession } from './connection-check';
import { pilotConfig } from './loopback-json';
import { providerDraft, type ProviderDraft } from '../search/settings-draft';
import { translateSettings, formatSettings } from '../search/settings-i18n';

const t = (source: string): string => translateSettings(source, getLanguage());
const f = (source: string, values: Record<string, string | number>): string =>
  formatSettings(source, values, getLanguage());

function failureText(error: ProviderFailureCode): string {
  const messages: Partial<Record<ProviderFailureCode, string>> = {
    CONFIG_INVALID: 'Check the connection settings and embedding dimension.',
    ENDPOINT_DENIED: 'This endpoint is not supported by the local HTTP adapter.',
    UNAUTHENTICATED: 'Authentication failed. Check the bearer token.',
    FORBIDDEN: 'Access denied. Check provider permissions.',
    RATE_LIMITED: 'Provider rate limit reached.',
    QUOTA_EXCEEDED: 'A provider operation is already running or quota is exhausted.',
    TIMEOUT: 'Provider did not respond within the configured timeout.',
    NETWORK: 'Connection failed. Check the API address and whether the service is running.',
    SERVER_ERROR: 'Provider returned a server error.',
    MODEL_MISMATCH: 'Provider returned a different model or revision.',
    INVALID_RESPONSE: 'Provider response is incompatible with the selected role or dimension.',
    LIMIT_EXCEEDED: 'The test exceeds the configured input or response limits.',
    CANCELLED: 'Connection check cancelled.',
  };
  return t(messages[error] ?? 'Connection check unavailable.');
}

/** Transient UI only. No token or test outcome reaches the preference model. */
export function renderConnectionCheck(form: HTMLElement, role: AiRole, draft: ProviderDraft, roleTitle: string):
  { reset: () => void; dispose: () => void } {
  const session = new ConnectionCheckSession();
  let version = 0, disposed = false, running = false;
  let token: HTMLInputElement | undefined, dimension: HTMLInputElement | undefined;
  let button: ButtonComponent;
  // Invalid/incomplete drafts remain editable and get a validation error on Check.
  // Canonical but unsupported origins are disabled before accepting a credential.
  const unsupportedOrigin = (): boolean => {
    const parsed = providerDraft(draft);
    if (!parsed.ok) return false;
    try { pilotConfig(parsed.value); return false; }
    catch { return true; }
  };
  const supported = (): boolean => draft.transport === 'local' && role !== 'reranking' && !unsupportedOrigin();
  const dimensionRow = role !== 'embedding' ? undefined : new Setting(form)
    .setName(t('Expected embedding dimension'))
    .setDesc(t('Required by the local adapter (1–4096); this test value is not saved.'))
    .addText(text => {
      dimension = text.inputEl;
      dimension.type = 'number'; dimension.min = '1'; dimension.max = '4096';
      dimension.setAttribute('aria-label', roleTitle + ' ' + t('Expected embedding dimension'));
      text.onChange(() => reset());
    });
  const tokenRow = role === 'reranking' ? undefined : new Setting(form)
    .setName(t('One-check bearer token')).setDesc(t('Used only for this test and never saved.'))
    .addText(text => {
      token = text.inputEl;
      token.type = 'password'; token.autocomplete = 'off';
      token.setAttribute('aria-label', roleTitle + ' ' + t('One-check bearer token'));
      text.onChange(() => reset(false));
    });
  const status = form.createEl('p');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.dataset.oksConnectionCheck = role;
  const row = new Setting(form).setName(t('Connection check'));
  row.addButton(component => {
    button = component;
    button.setButtonText(t('Check'));
    button.buttonEl.setAttribute('aria-label', roleTitle + ' ' + t('Check'));
    button.onClick(async () => {
      if (disposed || running || form.hidden || !form.isConnected || !supported()) return;
      const parsed = providerDraft(draft);
      if (!parsed.ok) { status.textContent = t(parsed.message); return; }
      const raw = dimension?.value ?? '';
      const expected = role === 'embedding' && /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : undefined;
      if (role === 'embedding' && (expected === undefined || expected > 4096)) {
        status.textContent = t('Enter an expected embedding dimension from 1 to 4096.'); return;
      }
      const secret = token?.value ?? '';
      if (token) token.value = '';
      if (!secret) { status.textContent = failureText('UNAUTHENTICATED'); return; }
      const current = ++version;
      running = true; button.setDisabled(true);
      status.textContent = t('Checking connection…');
      const result = await session.run(role, parsed.value, secret, expected);
      if (disposed || version !== current || form.hidden || !form.isConnected) return;
      running = false; button.setDisabled(!supported());
      if (!result) { status.textContent = failureText('CANCELLED'); return; }
      status.textContent = result.ok
        ? result.dimension === undefined
          ? f('Check passed ({ms} ms). No search or disclosure authorization granted.', {ms: result.elapsedMs})
          : f('Check passed ({ms} ms); vector dimension: {dimension}. No index compatibility verified.', {
            ms: result.elapsedMs, dimension: result.dimension})
        : f('Check failed ({ms} ms): {reason} ({code})', {
          ms: result.elapsedMs, reason: failureText(result.error), code: result.error});
    });
  });
  function reset(clearSecret = true): void {
    ++version; running = false; session.cancel();
    if (clearSecret && token) token.value = '';
    status.textContent = '';
    const enabled = supported() && !disposed;
    if (tokenRow) tokenRow.settingEl.hidden = !enabled;
    if (dimensionRow) dimensionRow.settingEl.hidden = !enabled;
    row.setDesc(t(draft.transport === 'cloud' ? 'Cloud connection checks require a supported cloud adapter.' :
      role === 'reranking' ? 'Reranker check unavailable until the actual runtime profile is accepted.' :
      unsupportedOrigin() ? 'This endpoint is not supported by the local HTTP adapter.' :
        'Runs one synthetic request using the draft. No Vault content, saving or indexing. Provider charges may apply.'));
    button.setDisabled(!enabled);
  }
  reset();
  return { reset, dispose: () => { disposed = true; reset(); session.dispose(); if (dimension) dimension.value = ''; } };
}
