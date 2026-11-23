import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { propertyInput, uiRequest, type SearchController } from './controller';
import type { SearchSettings } from './settings';
import { diagnostics } from './status';
import { textElement } from './render';

export const SEARCH_VIEW = 'oks-standalone-search';
export class SearchView extends ItemView {
  private unsubscribe?: () => void;
  private timer?: number;
  private disposed = true;
  constructor(leaf: WorkspaceLeaf, private readonly controller: SearchController,
    private readonly settings: () => SearchSettings,
    private readonly control: (action: 'pause' | 'cancel' | 'resume' | 'rebuild') => Promise<void>) { super(leaf); }
  getViewType(): string { return SEARCH_VIEW; }
  getDisplayText(): string { return 'OKS Standalone search'; }
  async onOpen(): Promise<void> {
    this.cleanup(); this.disposed = false;
    const root = this.contentEl; root.replaceChildren(); root.addClass('oks-search');
    const doc = root.ownerDocument;
    const add = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string, cls?: string): HTMLElementTagNameMap[K] => {
      const el = textElement(doc, tag, text, cls); root.appendChild(el); return el;
    };
    add('h2', 'Standalone Markdown search');
    const status = add('pre', '', 'oks-status'); status.setAttribute('aria-live', 'polite');
    const input = add('input', '', 'oks-query'); input.type = 'search';
    input.placeholder = 'Query (maximum 512 UTF-8 bytes)'; input.setAttribute('aria-label', 'Search query');
    const topK = add('input', '', 'oks-topk'); topK.type = 'number'; topK.min = '1'; topK.max = '50';
    topK.value = String(this.settings().topK); topK.setAttribute('aria-label', 'Top K');
    const filters = add('fieldset', '');
    filters.appendChild(textElement(doc, 'legend', 'Optional typed Property filter'));
    const enabled = doc.createElement('input'); enabled.type = 'checkbox'; enabled.className = 'oks-filter-enabled';
    enabled.setAttribute('aria-label', 'Apply Property filter'); filters.appendChild(enabled);
    const key = doc.createElement('input'); key.className = 'oks-filter-key'; key.placeholder = 'Property key'; filters.appendChild(key);
    const type = doc.createElement('select'); type.className = 'oks-filter-type'; type.setAttribute('aria-label', 'Property type');
    for (const t of ['string','number','boolean','date','null','list']) { const o = textElement(doc, 'option', t); o.value = t; type.appendChild(o); }
    filters.appendChild(type);
    const op = doc.createElement('select'); op.className = 'oks-filter-op'; op.setAttribute('aria-label', 'Property operator');
    for (const t of ['eq','contains']) { const o = textElement(doc, 'option', t); o.value = t; op.appendChild(o); } filters.appendChild(op);
    const value = doc.createElement('input'); value.className = 'oks-filter-value';
    value.placeholder = 'Literal string/date; JSON for other types'; value.setAttribute('aria-label', 'Property value'); filters.appendChild(value);
    const button = (label: string, cls: string, action: () => void): HTMLButtonElement => {
      const el = add('button', label, cls); el.onclick = () => { if (!this.disposed) action(); }; return el;
    };
    const search = async (): Promise<void> => {
      if (!input.value.trim()) { this.controller.invalidate(); return; }
      try {
        const predicates = enabled.checked && this.settings().propertiesEnabled
          ? [propertyInput(key.value, type.value, op.value, value.value)] : [];
        const result = await this.controller.search(uiRequest(input.value, Number(topK.value), predicates));
        if (!this.disposed && !result.ok && result.error !== 'SUPERSEDED') this.controller.message(result.error);
      } catch { if (!this.disposed) this.controller.message('INVALID_REQUEST'); }
    };
    button('Search', 'oks-submit', () => { void search(); });
    input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void search(); } };
    // Editing the query invalidates an earlier asynchronous response before another submit.
    input.oninput = () => this.controller.invalidate();
    for (const action of ['pause','resume','cancel','rebuild'] as const)
      button(action[0]!.toUpperCase() + action.slice(1), `oks-${action}`, () => { void this.control(action); });
    const exportArea = add('textarea', '', 'oks-diagnostics'); exportArea.readOnly = true; exportArea.hidden = true;
    exportArea.setAttribute('aria-label', 'Safe diagnostic export');
    button('Export safe diagnostics', 'oks-export', () => {
      exportArea.hidden = false; exportArea.value = diagnostics(this.controller.status()); exportArea.select();
    });
    const message = add('p', '', 'oks-message'); message.setAttribute('aria-live', 'polite');
    const results = add('ol', '', 'oks-results');
    const renderStatus = (): void => {
      if (this.disposed) return;
      const s = this.controller.status();
      status.textContent = `Lexical: ${s.capabilityReadiness.lexical} | Dense: unavailable | Hybrid: unavailable\n`
        + `Generation: ${s.generationId ?? 'none'}\nSources: ${s.sources} | Records: ${s.records} | Busy: ${s.busy} | Paused: ${s.paused}\n`
        + `Status: ${s.error ?? 'none'} | Maintenance: ${s.maintenanceWarning ?? 'none'}`;
      filters.disabled = !this.settings().propertiesEnabled;
    };
    const render = (): void => {
      if (this.disposed) return;
      renderStatus(); const state = this.controller.snapshot(); message.textContent = state.message; results.replaceChildren();
      state.response?.hits.forEach((hit, index) => {
        const row = textElement(doc, 'li', '');
        row.appendChild(textElement(doc, 'pre', hit.originalExcerpt));
        const open = textElement(doc, 'button', `${hit.sourceId}:${hit.sourceLocators[0]?.lineStart ?? '?'} — verify and open`, 'oks-open-source');
        open.onclick = () => { if (!this.disposed) void this.controller.open(index, hit); };
        row.appendChild(open); results.appendChild(row);
      });
    };
    this.unsubscribe = this.controller.subscribe(render);
    this.timer = root.ownerDocument.defaultView!.setInterval(renderStatus, 500);
    render(); input.focus();
  }
  private cleanup(): void {
    this.disposed = true; this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.timer !== undefined) this.contentEl.ownerDocument.defaultView!.clearInterval(this.timer);
    this.timer = undefined; this.contentEl.replaceChildren();
  }
  async onClose(): Promise<void> { this.cleanup(); }
}
