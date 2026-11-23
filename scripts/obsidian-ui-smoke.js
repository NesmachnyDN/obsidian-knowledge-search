// Evaluated ONLY in the disposable real Obsidian profile by obsidian-host-smoke.sh.
// No mocks: interact with mounted ItemView DOM, real Vault, editor and worker.
(async () => {
  const p = app.plugins.plugins['oks-synthetic-evidence'];
  const assert = (condition, code) => { if (!condition) throw new Error(`UI_SMOKE_${code}`); };
  const wait = async (predicate, code) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { assert(Date.now() < deadline, code); await new Promise(r => setTimeout(r, 30)); }
  };
  const root = () => app.workspace.getLeavesOfType('oks-standalone-search')[0]?.view.contentEl;
  const element = selector => { const el = root()?.querySelector(selector); assert(el, 'ELEMENT'); return el; };
  const set = (selector, value) => { const el = element(selector); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const click = selector => element(selector).click();
  const settle = async () => { await new Promise(r => setTimeout(r, 200)); await p.standalone.whenIdle(); };
  const query = async text => {
    set('.oks-query', text); click('.oks-submit');
    await wait(() => ['results','error'].includes(p.searchController.snapshot().phase), 'SEARCH_TIMEOUT');
  };
  assert(root()?.isConnected, 'VIEW_NOT_MOUNTED');
  assert(root().getBoundingClientRect().width > 0, 'VIEW_NOT_VISIBLE');
  assert(element('.oks-status').textContent.includes('Hybrid: unavailable'), 'READINESS');
  const filename = 'UI-Пример.MD';
  const raw = '---\r\nstatus: active\r\ncount: 7\r\n---\r\n# Привет 🚀\r\nREQ-UI-42: café 😀 <img src=x onerror=alert(1)>\r\n';
  const file = await app.vault.create(filename, raw); await settle();
  await p.updateSettings({ ...p.settings, propertiesEnabled: true });
  await wait(() => !element('fieldset').disabled, 'FILTER_DISABLED');
  await query('req-ui-42');
  assert(element('.oks-results').children.length === 1, 'LEXICAL');
  assert(element('.oks-results pre').textContent.includes('<img'), 'LITERAL_TEXT');
  assert(element('.oks-results').querySelector('img') === null, 'HTML_RENDERED');
  const hit = p.searchController.snapshot().response.hits[0];
  assert(hit.sourceId === filename && hit.sourceLocators[0].lineStart === 6, 'UNICODE_LOCATOR');
  click('.oks-open-source');
  await wait(() => app.workspace.getMostRecentLeaf()?.view?.editor?.getSelection() === hit.originalExcerpt, 'OPEN_SELECTION');
  assert(app.workspace.getMostRecentLeaf().view.file === file, 'EXACT_TFILE');
  await p.openSearch();
  element('.oks-filter-enabled').checked = true;
  set('.oks-filter-key','count'); set('.oks-filter-type','number'); set('.oks-filter-value','7');
  await query('REQ-UI-42'); assert(element('.oks-results').children.length === 1, 'TYPED_NUMBER');
  set('.oks-filter-type','string'); await query('REQ-UI-42');
  assert(element('.oks-results').children.length === 0, 'TYPED_NO_COERCION');
  set('.oks-filter-type','number'); set('.oks-filter-value','"7"'); await query('REQ-UI-42');
  assert(element('.oks-message').textContent === 'INVALID_REQUEST', 'INVALID_FILTER');
  element('.oks-filter-enabled').checked = false;
  await query('😀'.repeat(129)); assert(element('.oks-message').textContent === 'INVALID_REQUEST', 'OVERSIZE');
  await query('REQ-UI-42');
  const oldButton = element('.oks-open-source');
  await app.vault.modify(file, raw + 'Changed after search.\r\n');
  await wait(() => element('.oks-results').children.length === 0, 'STALE_ROWS');
  oldButton.click(); assert(p.searchController.snapshot().response === null, 'STALE_CLICK');
  let rejected = false; try { await p.navigator.open(hit); } catch { rejected = true; }
  assert(rejected, 'STALE_HASH'); await settle();
  await query('REQ-UI-42'); const renamedHit = p.searchController.snapshot().response.hits[0];
  await app.vault.rename(file,'UI-Renamed.md'); await settle();
  rejected = false; try { await p.navigator.open(renamedHit); } catch { rejected = true; }
  assert(rejected, 'RENAMED');
  await query('REQ-UI-42'); const deletedHit = p.searchController.snapshot().response.hits[0];
  await app.vault.delete(file); await settle();
  rejected = false; try { await p.navigator.open(deletedHit); } catch { rejected = true; }
  assert(rejected, 'DELETED');
  click('.oks-pause'); await wait(() => p.settings.paused, 'PAUSE');
  assert(p.searchController.status().paused, 'PAUSE_STATUS');
  click('.oks-resume'); await wait(() => !p.settings.paused, 'RESUME'); await settle();
  click('.oks-cancel'); await wait(() => p.settings.paused, 'CANCEL');
  click('.oks-rebuild'); await wait(() => !p.settings.paused, 'REBUILD'); await settle();
  const request = { protocolVersion: 2, requestId: 'host-api', query: 'REQ-OKS-SMOKE', requestedMode: 'lexical', limit: 5 };
  const api = await p.api.request({ apiVersion: 1, operation: 'search', request });
  assert(api.ok && api.value.hits.length === 1, 'API_SEARCH');
  const bad = await p.api.request({ apiVersion: 99, operation: 'status' });
  assert(!bad.ok && bad.error === 'API_VERSION_UNSUPPORTED', 'API_VERSION');
  const dense = await p.api.request({ apiVersion: 1, operation: 'search', request: { ...request, requestedMode: 'dense' } });
  assert(dense.ok && dense.value.status === 'failed' && dense.value.error === 'CAPABILITY_UNAVAILABLE' && dense.value.hits.length === 0, 'DENSE_TRUTH');
  click('.oks-export');
  const diagnostic = element('.oks-diagnostics').value;
  assert(!diagnostic.includes('REQ-') && !diagnostic.includes('sourceId') && !diagnostic.includes('properties') && !diagnostic.includes('.md'), 'DIAGNOSTICS');
  // Exercise actual Obsidian Settings UI, not only direct plugin methods.
  const parser = p.standalone.parser;
  assert(app.setting?.open && app.setting?.openTabById, 'SETTINGS_DIALOG_API');
  app.setting.open();
  await new Promise(r => setTimeout(r, 450));
  app.setting.openTabById(p.manifest.id);
  await new Promise(r => setTimeout(r, 250));
  // Obsidian may own the settings DOM in a different Document than CLI eval.
  const settingDoc = app.setting.activeTab.containerEl.ownerDocument;
  const settingRow = name => [...app.setting.activeTab.containerEl.querySelectorAll('.setting-item')]
    .find(el => el.querySelector('.setting-item-name')?.textContent?.trim() === name);
  await wait(() => settingRow('Enable Standalone indexing and search'), 'SETTINGS_VISIBLE');
  const toggleSetting = name => {
    const row = settingRow(name); assert(row, 'SETTINGS_ROW');
    const toggle = row.querySelector('.checkbox-container'); assert(toggle, 'SETTINGS_TOGGLE');
    toggle.click();
  };
  toggleSetting('Enable Standalone indexing and search');
  await wait(() => !p.settings.enabled && !p.standalone && parser.stopped, 'SETTINGS_DISABLE');
  const disabled = await p.api.request({ apiVersion: 1, operation: 'search', request });
  assert(!disabled.ok && disabled.error === 'DISABLED', 'DISABLED_SEARCH');
  await wait(() => settingRow('Clear derived Standalone index')?.querySelector('button')?.disabled === false,
    'PURGE_BUTTON_REFRESH');
  settingRow('Clear derived Standalone index').querySelector('button').click();
  const modal = () => [...settingDoc.querySelectorAll('.modal-container, .modal')]
    .find(el => el.textContent?.includes('Confirm derived index cleanup'));
  await wait(() => modal(), 'PURGE_CONFIRM_MODAL');
  const confirm = [...modal().querySelectorAll('button')].find(el => el.textContent?.includes('Delete derived files'));
  assert(confirm, 'PURGE_CONFIRM_BUTTON'); confirm.click();
  await wait(() => !modal(), 'PURGE_CONFIRM_CLOSED');
  const remaining = await p.purgeIndex();
  assert(remaining === 0, 'PURGE_VIA_REAL_SETTINGS');
  assert(app.vault.getAbstractFileByPath('first.md') !== null, 'PURGE_NOTES_PRESERVED');
  toggleSetting('Enable Standalone indexing and search');
  await wait(() => p.settings.enabled && p.standalone, 'SETTINGS_ENABLE');
  await settle();
  app.setting.close(); await p.openSearch();
  assert(p.standalone.parser !== parser && p.standalone.status().status === 'ready', 'REENABLE');
  // Leave a real result for the shell's supported CLI command navigation check.
  await query('REQ-OKS-SMOKE');
  assert(element('.oks-results').children.length === 1, 'COMMAND_RESULT');
  // Actual end-to-end UI latency includes DOM events, engine and row rendering.
  const uiLatency = []; let maxDelay = 0; let lastTick = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now(); maxDelay = Math.max(maxDelay, Math.max(0, now - lastTick - 20)); lastTick = now;
  }, 20);
  try {
    for (let i = 0; i < 9; i++) {
      const started = performance.now(); await query('REQ-OKS-SMOKE');
      assert(element('.oks-results').children.length === 1, 'UI_LATENCY_RESULT');
      uiLatency.push(performance.now() - started);
    }
  } finally { clearInterval(ticker); }
  const values = uiLatency.sort((a, b) => a - b);
  return `OBSIDIAN_UI_SMOKE_PASS: mounted text-only lexical typed-filter unicode-crlf exact-navigation stale-click stale-hash rename delete pause resume cancel rebuild real-settings-dialog purge api disabled-worker diagnostics uiP50Ms=${values[4].toFixed(2)} uiP95Ms=${values[8].toFixed(2)} uiEventLoopDelayMaxMs=${maxDelay.toFixed(2)}`;
})()
