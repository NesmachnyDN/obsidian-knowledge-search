// RU UI acceptance in a disposable Obsidian host; fixed synthetic loopback check only.
(async () => {
  const fail = code => { throw new Error('L10N_RU_' + code); };
  const assert = (condition, code) => { if (!condition) fail(code); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const p = app.plugins.plugins['oks-synthetic-evidence'];
  const tmp = process.env.tmp;
  assert(p && tmp && app.vault.adapter.getBasePath() === tmp + '/vault', 'SYNTHETIC_ONLY');
  const wait = async (predicate, code) => {
    const deadline = Date.now() + 6000;
    while (!predicate()) { assert(Date.now() < deadline, code); await sleep(40); }
  };
  const original = structuredClone(p.settings);
  const controller = p.standalone;
  const generation = controller.status().generationId;
  app.setting.open();
  await sleep(400);
  app.setting.openTabById(p.manifest.id);
  await sleep(400);
  const root = () => app.setting.activeTab.containerEl;
  const doc = root().ownerDocument;
  const heading = name => [...root().querySelectorAll('h3')].some(el => el.textContent === name);
  const row = (name, scope = root()) => [...scope.querySelectorAll('.setting-item')]
    .find(el => el.querySelector('.setting-item-name')?.textContent?.trim() === name);
  const card = name => [...root().querySelectorAll('.oks-settings-role')]
    .find(el => el.getAttribute('aria-label')?.startsWith(name));
  const press = (area, title) => {
    assert(area, 'ROW_MISSING_' + title);
    const b = [...area.querySelectorAll('button')].find(el => el.textContent === title);
    assert(b, 'BUTTON_MISSING_' + title);
    b.click();
  };
  const input = (area, value) => {
    const el = area?.querySelector('input');
    assert(el, 'INPUT_MISSING');
    el.value = value;
    el.dispatchEvent(new doc.defaultView.Event('input', {bubbles: true}));
  };
  try {
    assert(heading('Обзор') && heading('Поиск и область поиска') &&
      heading('Возможности ИИ (необязательно)') && heading('Документы') &&
      heading('Индекс и обслуживание'), 'HEADINGS');
    assert(row('Включить автономный поиск') && row('Результатов на запрос') &&
      row('Режим отображения настроек'), 'BASIC_LABELS');
    assert(row('Результатов на запрос').querySelector('input').getAttribute('aria-label') ===
      'Результатов на запрос', 'A11Y');
    assert(card('Семантический поиск') && card('Улучшение ранжирования') &&
      card('Ответы по источникам'), 'AI_ROLES');
    assert(row('Текущее назначение', card('Семантический поиск')) === undefined,
      'DISABLED_ROLE_NOT_ASSIGNED');
    assert(row('Текущее состояние обработки') === undefined, 'NO_FABRICATED_READY');
    press(row('Подключение', card('Семантический поиск')), 'Настроить');
    const embedding = card('Семантический поиск');
    assert(row('Базовый адрес API', embedding) && row('Идентификатор модели', embedding) &&
      row('Ревизия модели', embedding), 'AI_FIELDS');
    assert(embedding.textContent.includes('Локальным считается только адрес'), 'LOCAL_WARNING');
    assert(row('Проверка подключения',embedding).querySelector('button').textContent==='Проверка',
      'CHECK_RU_BUTTON');
    let checkEvidence = 'not-run';
    if (process.env.OKS_HOST_NO_ROUTE === '1') {
      const http=require('node:http');
      let calls=0;
      const server=http.createServer((req,res)=>{
        const chunks=[];
        req.on('data',x=>chunks.push(x));
        req.on('end',()=>{
          calls++;
          const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const ok=req.url==='/v1/embeddings' && req.headers.authorization==='Bearer synthetic-check-token' &&
            body.model==='synthetic-check@v1' && body.input[0]==='OKS connection check';
          res.writeHead(ok?200:400,{'content-type':'application/json'});
          res.end(JSON.stringify(ok?{model:body.model,data:[{object:'embedding',index:0,embedding:[1,0,0]}]}:{}));
        });
      });
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      try {
        input(row('Базовый адрес API',embedding),'http://127.0.0.1:'+server.address().port);
        input(row('Идентификатор модели',embedding),'synthetic-check');
        input(row('Ревизия модели',embedding),'v1');
        input(row('Ожидаемая размерность эмбеддинга',embedding),'3');
        input(row('Bearer-токен для одной проверки',embedding),'synthetic-check-token');
        press(row('Проверка подключения',embedding),'Проверка');
        const result=embedding.querySelector('[data-oks-connection-check]');
        await wait(()=>result.textContent.includes('Проверка выполнена успешно'),'CHECK_RU_SUCCESS');
        assert(calls===1 && row('Bearer-токен для одной проверки',embedding).querySelector('input').value==='' &&
          p.settings.ai.embedding.state==='disabled','CHECK_RU_NO_SAVE');
        checkEvidence='localized-embedding-success-no-save';
      } finally {
        server.closeAllConnections();
        await new Promise(resolve=>server.close(resolve));
      }
    }
    input(row('Базовый адрес API', embedding), 'http://localhost:8765');
    input(row('Идентификатор модели', embedding), 'synthetic-model');
    input(row('Ревизия модели', embedding), 'v1');
    press(row('Черновик параметров', embedding), 'Сохранить подключение');
    assert(embedding.textContent.includes('канонический локальный адрес'), 'VALIDATION_TRANSLATED');
    assert(p.settings.ai.embedding.state === 'disabled', 'INVALID_NOT_COMMITTED');
    press(row('Черновик параметров', embedding), 'Отменить изменения');
    const result = row('Изменение числа результатов');
    input(row('Результатов на запрос'), '51');
    press(result, 'Сохранить');
    assert(root().textContent.includes('Введите целое число от 1 до 50'), 'TOPK_TRANSLATED');
    press(result, 'Отмена');
    const mode = row('Режим отображения настроек').querySelector('select');
    assert([...mode.options].some(o => o.value === 'basic' && o.textContent === 'Основной') &&
      [...mode.options].some(o => o.value === 'expert' && o.textContent === 'Экспертный'),
      'INTERNAL_IDS_STABLE');
    assert(row('Удалить производный автономный индекс').querySelector('button').disabled,
      'PURGE_GUARD');
    assert(JSON.stringify(p.settings) === JSON.stringify(original) &&
      p.standalone === controller && controller.status().generationId === generation,
      'NO_OPERATIONAL_MUTATION');
    const req = {protocolVersion: 2, requestId: 'l10n-synthetic', query: 'REQ-OKS-SMOKE',
      requestedMode: 'lexical', limit: 5};
    const offline = await p.api.request({apiVersion: 1, operation: 'search', request: req});
    assert(offline.ok && offline.value.status === 'ok' && offline.value.hits.length === 1,
      'OFFLINE_UNCHANGED');
    let images = 0;
    if (process.env.OKS_06UX_L10N_RU_VISUAL === '1') {
      const fs = require('node:fs');
      const remote = require('@electron/remote');
      root().dataset.oksLocaleMarker = 'synthetic-l10n-ru';
      let win;
      for (const candidate of remote.BrowserWindow.getAllWindows()) {
        if (await candidate.webContents.executeJavaScript(
          "!!document.querySelector('[data-oks-locale-marker=synthetic-l10n-ru]')").catch(() => false)) {
          win = candidate; break;
        }
      }
      assert(win, 'SETTINGS_WINDOW');
      const oldBounds = win.getBounds(), oldZoom = win.webContents.getZoomFactor();
      const visible = el => !!el.getClientRects().length &&
        el.getAttribute('aria-hidden') !== 'true' &&
        doc.defaultView.getComputedStyle(el).display !== 'none' &&
        doc.defaultView.getComputedStyle(el).visibility !== 'hidden';
      try {
        win.show(); win.focus();
        for (const [width, zoom, name] of [[900, 1, 'ru-basic-900'],
          [760, 1, 'ru-basic-760'], [760, 2, 'ru-basic-760-200pct']]) {
          win.setSize(width, 700);
          win.webContents.setZoomFactor(zoom);
          await sleep(220);
          const area = root().getBoundingClientRect();
          const clipped = [...root().querySelectorAll('button,input,select')]
            .filter(visible).filter(el => {
              const rect = el.getBoundingClientRect();
              return rect.left < area.left - 2 || rect.right > area.right + 2;
            });
          assert(!clipped.length && root().scrollWidth <= root().clientWidth + 2,
            'VISUAL_OVERFLOW_' + name + '_' + JSON.stringify({
              root: {client: root().clientWidth, scroll: root().scrollWidth, left: area.left, right: area.right},
              clipped: clipped.map(el => ({name: el.getAttribute('aria-label') || el.textContent,
                left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right})).slice(0, 7),
            }));
          const png = (await win.webContents.capturePage()).toPNG();
          assert(png.length > 10000, 'SCREENSHOT_EMPTY_' + name);
          fs.mkdirSync(tmp + '/l10n-visual', {recursive: true, mode: 0o700});
          fs.writeFileSync(tmp + '/l10n-visual/' + name + '.png', png);
          images++;
        }
      } finally {
        win.webContents.setZoomFactor(oldZoom);
        win.setBounds(oldBounds);
      }
    }
    // The API smoke alone does not update the UI controller's last response.
    // Perform an actual ItemView search, then inspect the rendered status.
    app.setting.close();
    await p.openSearch();
    const view = app.workspace.getLeavesOfType('oks-standalone-search')[0]?.view;
    const query = view?.contentEl.querySelector('.oks-query');
    const submit = view?.contentEl.querySelector('.oks-submit');
    assert(query && submit, 'SEARCH_CONTROLS');
    query.value = 'REQ-OKS-SMOKE';
    query.dispatchEvent(new Event('input', {bubbles: true}));
    submit.click();
    await wait(() => p.searchController.snapshot().phase === 'results', 'UI_SEARCH');
    const response = p.searchController.snapshot().response;
    assert(response?.status === 'ok' && response.hits.length === 1 &&
      response.hits[0].sourceId === 'first.md', 'UI_SEARCH_EVIDENCE');
    app.setting.open();
    await sleep(350);
    app.setting.openTabById(p.manifest.id);
    await sleep(350);
    const description = name => row(name)?.querySelector('.setting-item-description')?.textContent;
    assert(description('Последний проверенный базовый поиск') ===
      'Запрошено: лексический; выполнено: лексический; результат: успешно.', 'SUCCESS_STATUS_TRANSLATED');
    const pause = () => row('Приостановить индексацию')?.querySelector('[data-oks-focus=paused]');
    assert(pause(), 'PAUSE_CONTROL');
    pause().click();
    await wait(() => p.settings.paused && p.searchController.status().status === 'degraded' &&
      description('Автономный поиск по Markdown')?.includes('ограниченная работоспособность'), 'DEGRADED_STATUS_TRANSLATED');
    assert(description('Автономный индекс')?.includes('ограниченная работоспособность'), 'DEGRADED_INDEX_TRANSLATED');
    pause().click();
    await wait(() => !p.settings.paused, 'RESUME');
    await controller.whenIdle();
    assert(JSON.stringify(p.settings) === JSON.stringify(original) && controller.status().status === 'ready',
      'RESTORED_SETTINGS_AND_READY');
    return 'OBSIDIAN_SETTINGS_RU_PASS: localized headings, editor, buttons, validation, a11y, provider isolation, stable ids, offline search, success/degraded summaries, restored preferences, screenshots=' + images + '; connectionChecks=' + checkEvidence;
  } finally {
    app.setting.close();
  }
})()
