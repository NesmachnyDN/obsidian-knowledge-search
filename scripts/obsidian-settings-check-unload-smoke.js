// Invoked twice around a real CLI plugin reload. Only an isolated synthetic Vault
// with no route and its fixed local fixture are allowed.
(async () => {
  const assert = (condition, code) => { if (!condition) throw Error('CHECK_UNLOAD_' + code); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (predicate, code) => {
    const end = Date.now() + 6000;
    while (!predicate()) { assert(Date.now() < end, code); await sleep(30); }
  };
  const id = 'oks-synthetic-evidence', p = app.plugins.plugins[id];
  assert(process.env.OKS_HOST_NO_ROUTE === '1' && process.env.tmp &&
    app.vault.adapter.getBasePath() === process.env.tmp + '/vault', 'ISOLATED_SYNTHETIC_ONLY');
  const previous = globalThis.__oksCheckUnloadFixture;
  if (previous) {
    try {
      await wait(() => previous.cancelled === 1, 'SOCKET_NOT_CANCELLED');
      assert(p && p !== previous.plugin, 'PLUGIN_NOT_REPLACED');
      assert(previous.status.textContent === '' && previous.token.value === '' &&
        previous.button.disabled, 'STALE_RESULT_OR_SECRET');
      await sleep(100);
      assert(previous.status.textContent === '' && previous.calls === 1 &&
        JSON.stringify(p.settings) === previous.settings, 'LATE_RESULT_OR_MUTATION');
      return 'OBSIDIAN_SETTINGS_CHECK_UNLOAD_PASS: actual CLI plugin reload aborts active HTTP check, clears token and stale result, preferences unchanged';
    } finally {
      previous.server.closeAllConnections();
      await new Promise(r => previous.server.close(r));
      delete globalThis.__oksCheckUnloadFixture;
      app.setting.close();
    }
  }
  assert(p && p.settings.ai.generation.state === 'disabled', 'CLEAN_ROLE_REQUIRED');
  const http = require('node:http');
  const fixture = {plugin:p, settings:JSON.stringify(p.settings), calls:0, cancelled:0};
  const server = fixture.server = http.createServer((req,res) => {
    req.resume();
    req.on('end', () => {
      assert(req.url === '/v1/chat/completions' &&
        req.headers.authorization === 'Bearer synthetic-unload-token', 'EXACT_REQUEST');
      fixture.calls++;
      res.on('close', () => { if (!res.writableEnded) fixture.cancelled++; });
      // Hold the response until the actual reload cancels this socket.
    });
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  try {
    app.setting.open(); await sleep(300);
    app.setting.openTabById(id); await sleep(300);
    const root = app.setting.activeTab.containerEl;
    const area = [...root.querySelectorAll('.oks-settings-role')]
      .find(el => el.getAttribute('aria-label')?.startsWith('Evidence-based answers'));
    assert(area, 'ROLE_NOT_FOUND');
    const row = name => [...area.querySelectorAll('.setting-item')]
      .find(el => el.querySelector('.setting-item-name')?.textContent?.trim() === name);
    const edit = (name,value) => {
      const el = row(name)?.querySelector('input');
      assert(el, 'INPUT_MISSING');
      el.value = value; el.dispatchEvent(new root.ownerDocument.defaultView.Event('input',{bubbles:true}));
      return el;
    };
    row('Connection').querySelector('button').click();
    edit('API origin','http://127.0.0.1:'+server.address().port);
    edit('Model ID','synthetic-check');
    edit('Model revision','v1');
    fixture.token = edit('One-check bearer token','synthetic-unload-token');
    fixture.status = area.querySelector('[data-oks-connection-check]');
    fixture.button = row('Connection check').querySelector('button');
    fixture.button.click();
    await wait(() => fixture.calls === 1, 'REQUEST_NOT_STARTED');
    assert(fixture.button.disabled && fixture.status.textContent.includes('Checking') &&
      fixture.token.value === '', 'NOT_ACTIVE_OR_SECRET_RETAINED');
    globalThis.__oksCheckUnloadFixture = fixture;
    return 'OBSIDIAN_SETTINGS_CHECK_UNLOAD_READY: active isolated synthetic HTTP request';
  } catch (error) {
    server.closeAllConnections(); await new Promise(r => server.close(r)); throw error;
  }
})()
