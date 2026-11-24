// Real Obsidian native General > Language selector; no getLanguage stubbing and no production Vault.
(async () => {
  const p = app.plugins.plugins['oks-synthetic-evidence'];
  const action = globalThis.__oksNativeLanguageAction;
  const assert = (ok, reason) => { if (!ok) throw Error('NATIVE_LANGUAGE_' + reason); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (predicate, reason) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert(Date.now() < deadline, reason);
      await sleep(40);
    }
  };
  assert(p && process.env.tmp && app.vault.adapter.getBasePath() === process.env.tmp + '/vault',
    'SYNTHETIC_ONLY');
  assert(p.standalone?.status().status === 'ready' && p.standalone.status().sources === 2,
    'OFFLINE_SEARCH_READY');
  // Capture one non-default persisted baseline, shared by every subsequent
  // phase including the new processes. This is a synthetic-only file.
  const fs = require('node:fs');
  const baselinePath = process.env.tmp + '/native-language-baseline.json';
  if (action === 'seed') {
    await p.patchSettings(settings => { settings.topK = 17; settings.propertiesEnabled = true; });
    assert(p.settings.topK === 17 && p.settings.propertiesEnabled, 'SEED_PREFERENCES');
    const saved = JSON.stringify(p.settings);
    assert(JSON.stringify(await p.loadData()) === saved, 'SEED_DISK');
    fs.writeFileSync(baselinePath, saved, { flag: 'wx', mode: 0o600 });
    return 'OBSIDIAN_NATIVE_LANGUAGE_PASS: seeded non-default persistent preferences';
  }
  const baseline = fs.readFileSync(baselinePath, 'utf8');
  assert(JSON.stringify(p.settings) === baseline &&
    JSON.stringify(await p.loadData()) === baseline, 'CROSS_RESTART_PREFERENCES');
  const generation = p.standalone.status().generationId;
  app.setting.open();
  await sleep(350);
  const nativeSelect = () => {
    app.setting.openTabById('about');
    const selects = [...app.setting.activeTab.containerEl.querySelectorAll('select')];
    const selector = selects.find(el => ['en', 'ru'].every(id =>
      [...el.options].some(option => option.value === id)));
    assert(selector, 'NATIVE_SELECTOR_MISSING');
    return selector;
  };
  try {
    const select = nativeSelect();
    const current = action === 'verify-ru' || action === 'set-en' ? 'ru' : 'en';
    assert(select.value === current, 'HOST_LOCALE_'+action+'_'+select.value);
    if (action === 'set-ru' || action === 'set-en') {
      const next = action === 'set-ru' ? 'ru' : 'en';
      // Drive a real browser keyboard event through the Electron window.
      // Directly dispatched Event('change') is not treated as a host language selection.
      const remote = require('@electron/remote');
      // Obsidian may host the Settings DOM in a different Electron window from
      // the CLI eval context. Select the exact webContents holding this control.
      select.dataset.oksLanguageTest = 'synthetic-native-language-selector';
      let hostWindow;
      for (const window of remote.BrowserWindow.getAllWindows()) {
        const matches = await window.webContents.executeJavaScript(
          '!!document.querySelector("[data-oks-language-test=synthetic-native-language-selector]")'
        ).catch(() => false);
        if (matches) { hostWindow = window; break; }
      }
      assert(hostWindow, 'SETTINGS_WINDOW_NOT_FOUND');
      const nextIndex = [...select.options].findIndex(opt => opt.value === next);
      assert(nextIndex > 0, 'LANGUAGE_INDEX');
      select.selectedIndex = nextIndex - 1;
      hostWindow.show(); hostWindow.focus(); select.focus();
      await sleep(120);
      const debuggerApi = hostWindow.webContents.debugger;
      try {
        debuggerApi.attach('1.3');
        await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
          type:'keyDown', code:'ArrowDown', key:'ArrowDown',
          windowsVirtualKeyCode:40, nativeVirtualKeyCode:40,
        });
        await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
          type:'keyUp', code:'ArrowDown', key:'ArrowDown',
          windowsVirtualKeyCode:40, nativeVirtualKeyCode:40,
        });
      } catch(error) {
        throw Error('NATIVE_LANGUAGE_KEYBOARD_INPUT_' + String(error));
      } finally {
        if (debuggerApi.isAttached()) debuggerApi.detach();
      }
      await sleep(800);
      assert(JSON.stringify(p.settings) === baseline &&
        p.standalone.status().generationId === generation, 'CHANGE_HAS_NO_PLUGIN_SIDE_EFFECT');
      const relaunch = select.closest('.setting-item')?.querySelector('button.mod-cta');
      assert(relaunch && relaunch.getClientRects().length > 0 && !relaunch.disabled &&
        select.value === next, 'NATIVE_RELAUNCH_REQUIRED');
      // Use the native host's Apply/Relaunch action. A plain process kill does
      // not commit the pending language choice. Let the CLI response finish.
      const rectangle = relaunch.getBoundingClientRect();
      const clickAt = {x: rectangle.left + rectangle.width / 2, y: rectangle.top + rectangle.height / 2};
      setTimeout(async () => {
        // The Apply/Relaunch action needs an actual host input event, not HTMLElement.click().
        try {
          const debug = hostWindow.webContents.debugger;
          debug.attach('1.3');
          await debug.sendCommand('Input.dispatchMouseEvent',
            {type:'mouseMoved',...clickAt,button:'none'});
          await debug.sendCommand('Input.dispatchMouseEvent',
            {type:'mousePressed',...clickAt,button:'left',clickCount:1});
          await debug.sendCommand('Input.dispatchMouseEvent',
            {type:'mouseReleased',...clickAt,button:'left',clickCount:1});
          if (debug.isAttached()) debug.detach();
        } catch {
          // Relaunch may close the browser while the input command is completing.
        }
      }, 900);
      return 'OBSIDIAN_NATIVE_LANGUAGE_PASS: selected ' + next + ' using native General tab; relaunch input scheduled';
    }
    assert(action === 'verify-en' || action === 'verify-ru', 'UNEXPECTED_ACTION');
    app.setting.openTabById(p.manifest.id);
    await sleep(350);
    const root = () => app.setting.activeTab.containerEl;
    const name = label => [...root().querySelectorAll('.setting-item')]
      .find(row => row.querySelector('.setting-item-name')?.textContent?.trim() === label);
    const heads = () => [...root().querySelectorAll('h3')].map(el => el.textContent);
    const ru = current === 'ru';
    const basicHeading = ru ? 'Обзор' : 'Overview';
    const expertHeading = ru ? 'Расширенная диагностика' : 'Advanced diagnostics';
    const selectName = ru ? 'Режим отображения настроек' : 'Settings view';
    const roleName = ru ? 'Семантический поиск · эмбеддинги' : 'Semantic search · embeddings';
    const connection = ru ? 'Подключение' : 'Connection';
    const configure = ru ? 'Настроить' : 'Configure';
    const cancel = ru ? 'Отменить изменения' : 'Cancel draft';
    const editorTitle = ru ? 'Базовый адрес API' : 'API origin';
    assert(heads().includes(basicHeading) && name(selectName), 'BASIC_TRANSLATION');
    assert(!heads().includes(ru ? 'Overview' : 'Обзор'), 'NO_WRONG_LANGUAGE_HEADING');
    const role = () => [...root().querySelectorAll('.oks-settings-role')]
      .find(el => el.getAttribute('aria-label') === roleName);
    assert(role(), 'ROLE_TRANSLATION');
    const roleRow = label => [...role().querySelectorAll('.setting-item')]
      .find(row => row.querySelector('.setting-item-name')?.textContent?.trim() === label);
    const button = (row, text) => [...row.querySelectorAll('button')].find(el => el.textContent === text);
    assert(button(roleRow(connection), configure), 'OPEN_EDITOR_BUTTON_TRANSLATION');
    button(roleRow(connection), configure).click();
    assert(roleRow(editorTitle) && roleRow(editorTitle).querySelector('input')?.getAttribute('aria-label')?.includes(editorTitle),
      'EDITOR_ACCESSIBLE_TRANSLATION');
    assert([...role().querySelectorAll('button')].some(el => el.textContent === cancel), 'CANCEL_EDITOR_TRANSLATION');
    button(roleRow(ru ? 'Черновик параметров' : 'Draft preferences'), cancel).click();
    const mode = name(selectName).querySelector('select');
    mode.value = 'expert';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => p.settings.presentationMode === 'expert' && heads().includes(expertHeading), 'EXPERT_TRANSLATION');
    assert(name(ru ? 'Настройки локального сервиса' : 'Backend setup') &&
      name(ru ? 'Настройки теста' : 'Probe setup'), 'EXPERT_SECTIONS');
    assert(role(), 'EXPERT_ROLE_TRANSLATION');
    const back = name(selectName).querySelector('select');
    back.value = 'basic';
    back.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => p.settings.presentationMode === 'basic' && heads().includes(basicHeading) &&
      !heads().includes(expertHeading), 'BASIC_ROUNDTRIP');
    assert(JSON.stringify(p.settings) === baseline && JSON.stringify(await p.loadData()) === baseline &&
      p.standalone.status().generationId === generation, 'NO_PERSISTED_CONFIGURATION_CHANGE');
    return 'OBSIDIAN_NATIVE_LANGUAGE_PASS: ' + current +
      ' native locale, Basic and Expert labels, AI editor and ARIA, no configuration/index change';
  } finally {
    if (action !== 'set-ru' && action !== 'set-en') app.setting.close();
  }
})()
