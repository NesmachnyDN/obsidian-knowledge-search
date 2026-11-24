import { Setting, getLanguage } from 'obsidian';
import { translateSettings } from './settings-i18n';

const t = (source: string): string => translateSettings(source, getLanguage());

// Scope all overrides to OKS. Settings can live in a separate Electron document.
const layout = `
.oks-settings-layout [hidden] { display: none !important; }
.oks-settings-layout.oks-settings-surface { padding-inline: clamp(8px, 2vw, 32px) !important; }
.oks-settings-layout .setting-item {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-inline: clamp(8px, 2vw, 16px);
  min-width: 0;
}
.oks-settings-layout .setting-item-info {
  flex: 1 1 12rem;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  overflow-wrap: anywhere;
}
.oks-settings-layout .setting-item-name,
.oks-settings-layout .setting-item-description {
  white-space: normal;
  overflow-wrap: anywhere;
  text-overflow: clip;
}
.oks-settings-layout .setting-item-control {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  gap: 8px;
}
.oks-settings-layout .setting-item-control > * {
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
.oks-settings-layout button {
  white-space: normal;
  overflow-wrap: anywhere;
  height: auto;
  min-height: var(--input-height);
  max-width: 100%;
  text-align: center;
}
.oks-settings-layout select,
.oks-settings-layout input { max-width: 100%; min-width: 0; }
/* The host's invisible dropdown measurement clone must not extend scroll geometry. */
.oks-settings-layout .dropdown.is-measuring {
  position: fixed !important;
  left: 0 !important;
  top: 0 !important;
  visibility: hidden !important;
  pointer-events: none;
}
.oks-settings-layout p, .oks-settings-layout h2,
.oks-settings-layout h3 { overflow-wrap: anywhere; }
`;

export function applySettingsLayout(root: HTMLElement, surface = false): void {
  root.classList.add('oks-settings-layout');
  if (surface) root.classList.add('oks-settings-surface');
  root.createEl('style', { text: layout });
}

/** Use only the Settings document; never the global main-window document. */
export function restoreSettingsFocus(root: HTMLElement, key: string): void {
  const target = [...root.querySelectorAll<HTMLElement>('[data-oks-focus]')]
    .find(el => el.dataset.oksFocus === key);
  target?.focus();
}

export function settingsDisclosure(parent: HTMLElement, openEditors: Set<string>,
  key: string, title: string, openLabel: string, onOpen: () => void):
  { form: HTMLElement; open: () => void } {
  // The opener must precede the form in DOM order. Native Tab enters it next.
  const row = new Setting(parent).setName(t(title));
  const form = parent.createEl('div');
  form.id = 'oks-settings-editor-' + key;
  let opener: HTMLButtonElement;
  const setOpen = (open: boolean): void => {
    if (open) { openEditors.add(key); onOpen(); }
    else openEditors.delete(key);
    form.hidden = !open;
    opener.setAttribute('aria-expanded', String(open));
    opener.textContent = t(open ? 'Close editor' : openLabel);
  };
  row.addButton(button => {
    opener = button.buttonEl;
    opener.dataset.oksFocus = key;
    opener.setAttribute('aria-controls', form.id);
    setOpen(openEditors.has(key));
    button.onClick(() => setOpen(form.hidden === true));
  });
  return { form, open: () => { setOpen(true); opener.focus(); } };
}
