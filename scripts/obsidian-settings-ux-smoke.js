// Real Obsidian Settings acceptance, synthetic Vault and loopback-only test API.
(async () => {
  const p = app.plugins.plugins['oks-synthetic-evidence'];
  const assert = (condition, label) => { if (!condition) throw new Error('UX_ACCEPTANCE_' + label); };
  const wait = async (predicate, label) => {
    const until = Date.now() + 6000;
    while (!predicate()) {
      assert(Date.now() < until, label);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  };
  assert(p && p.standalone?.status().status === 'ready', 'OFFLINE_READY');
  assert(p.settings.presentationMode === 'basic', 'DEFAULT_BASIC');
  assert(Object.values(p.settings.ai).every(pref => pref.state === 'disabled'), 'AI_DEFAULT_OFF');
  assert(!p.settings.ingestion.enabled && !p.settings.advanced.enabled, 'BACKENDS_DEFAULT_OFF');
  const tmp = process.env.tmp;
  assert(tmp && app.vault.adapter.getBasePath() === tmp + '/vault', 'SYNTHETIC_ONLY');
  const initialSettings = structuredClone(p.settings);
  const generation = p.standalone.status().generationId, engine = p.standalone;
  const req = {protocolVersion:2,requestId:'ux-synthetic',query:'REQ-OKS-SMOKE',
    requestedMode:'lexical',limit:5};
  const offline = async () => {
    const r = await p.api.request({apiVersion:1,operation:'search',request:req});
    return r.ok && r.value.status === 'ok' && r.value.hits.length === 1;
  };
  assert(await offline(), 'BASIC_QUERY');
  assert(app.setting?.open && app.setting?.openTabById, 'SETTINGS_EXISTS');
  app.setting.open(); await new Promise(r => setTimeout(r,350));
  app.setting.openTabById(p.manifest.id); await new Promise(r => setTimeout(r,350));
  const root = () => app.setting.activeTab.containerEl;
  let doc = root().ownerDocument;
  const row = (name,area=root()) => [...area.querySelectorAll('.setting-item')]
    .find(el => el.querySelector('.setting-item-name')?.textContent?.trim() === name);
  const press = (target,name) => {
    assert(target,'MISSING_BUTTON_ROW_'+name);
    const b = [...target.querySelectorAll('button')].find(btn => btn.textContent === name);
    assert(b, 'MISSING_BUTTON_'+name); b.click(); return b;
  };
  const edit = (target,value) => {
    const el = target?.querySelector('input');
    assert(el,'MISSING_INPUT'); el.value=value;
    el.dispatchEvent(new doc.defaultView.Event('input',{bubbles:true})); return el;
  };
  const choose = (target,value) => {
    const el = target?.querySelector('select');
    assert(el, 'MISSING_SELECT'); el.value=value;
    el.dispatchEvent(new doc.defaultView.Event('change',{bubbles:true})); return el;
  };
  const visible = el => !!el && el.getClientRects().length > 0 &&
    doc.defaultView.getComputedStyle(el).display !== 'none';
  const section = label => [...root().querySelectorAll('section')]
    .find(el=>el.getAttribute('aria-label')===label);
  assert(row('Settings view') && section('Overview') && section('Search & scope') &&
    section('AI capabilities (optional)') && section('Documents') && section('Index & maintenance'),
    'TASK_SECTIONS');
  assert(!section('Advanced diagnostics'), 'BASIC_HIDES_EXPERT');
  const summary = () => row('Optional local capabilities').textContent;
  const apiIndex = () => row('API dense index (selected Markdown corpus)');
  const legacyIndex = () => row('Legacy local BGE-M3 index (documents)');
  const legacyActions = () => row('Legacy document index operations');
  assert(summary().includes('Health-only backend: disabled') &&
    summary().includes('legacy synthetic probe: disabled'), 'LOCAL_DEFAULT_DISABLED');
  assert(apiIndex().textContent.includes('Provider disabled') &&
    legacyIndex().textContent.includes('This is not the API dense index'), 'DISTINCT_INDEX_STATES');
  assert(apiIndex().querySelectorAll('button').length === 0 &&
    legacyActions().querySelectorAll('button')[0].disabled &&
    legacyActions().querySelectorAll('button')[1].disabled, 'NO_SETTINGS_API_REBUILD');
  // Multi-character editing does not redraw the DOM or persist invalid partial values.
  const results = row('Results per search');
  const top = results.querySelector('input');
  top.focus();
  const beforeTop = p.settings.topK;
  const beforeEl = top;
  edit(results, '51');
  press(row('Refresh status'), 'Refresh');
  assert(doc.activeElement === beforeEl && row('Results per search').querySelector('input') === beforeEl,
    'FOCUS_PRESERVED_ON_UNRELATED_STATUS_REFRESH');
  press(row('Results draft'), 'Save');
  await new Promise(r=>setTimeout(r,80));
  assert(p.settings.topK === beforeTop, 'INVALID_NOT_PERSISTED');
  assert(section('Search & scope').textContent.includes('whole number'), 'INLINE_TOPK_ERROR');
  // Force a synthetic storage refusal; the edited draft must survive unchanged.
  edit(row('Results per search'), '25');
  const originalSave = p.saveData.bind(p);
  p.saveData = async () => { throw new Error('synthetic-save-refusal'); };
  try {
    press(row('Results draft'), 'Save');
    await wait(()=>section('Search & scope').textContent.includes('unsaved draft'), 'FAILED_SAVE_INLINE');
    assert(p.settings.topK === beforeTop, 'FAILED_SAVE_COMMITTED');
    assert(row('Results per search').querySelector('input').value === '25', 'FAILED_SAVE_DRAFT');
  } finally { p.saveData = originalSave; }
  press(row('Results draft'), 'Save');
  await wait(()=>p.settings.topK===25, 'ATOMIC_TOPK_SAVE');
  assert(p.standalone===engine, 'NO_RESTART_FOR_TOPK');
  // Document setup is reachable but disabled until complete; mode-dependent paths.
  press(row('Processing setup'), 'Configure documents');
  const docToggle = row('Enable local document ingestion after Save').querySelector('.checkbox-container');
  assert(docToggle, 'INGESTION_DRAFT_TOGGLE');
  assert(!visible(row('PDF processing mode')) && !visible(row('Trusted local Python interpreter')) &&
    !visible(row('Local OCR language assets')) && !visible(row('Pinned structured extraction artifacts')),
    'PDF_HIDDEN_WHEN_OFF');
  docToggle.click();
  assert(visible(row('PDF processing mode')) && !visible(row('Local OCR language assets')) &&
    !visible(row('Pinned structured extraction artifacts')), 'TEXT_ONLY_FIELDS');
  choose(row('PDF processing mode'), 'ocr');
  assert(visible(row('Local OCR language assets')) && !visible(row('Pinned structured extraction artifacts')),
    'OCR_ONLY_FIELDS');
  choose(row('PDF processing mode'), 'structured');
  assert(!visible(row('Local OCR language assets')) && visible(row('Pinned structured extraction artifacts')),
    'STRUCTURED_ONLY_FIELDS');
  choose(row('PDF processing mode'), 'structured-ocr');
  assert(visible(row('Local OCR language assets')) && visible(row('Pinned structured extraction artifacts')),
    'STRUCTURED_OCR_FIELDS');
  press(row('Document setup draft'), 'Save setup');
  await new Promise(r=>setTimeout(r,80));
  assert(!p.settings.ingestion.enabled &&
    section('Documents').textContent.includes('absolute trusted local path'), 'INVALID_INGESTION_ATOMIC');
  press(row('Document setup draft'), 'Cancel');
  assert(doc.activeElement?.dataset.oksFocus === 'documents', 'DOCUMENT_CANCEL_FOCUS');
  assert(!p.settings.ingestion.enabled && p.standalone===engine, 'CANCEL_INGESTION');
  // Independent role cards, invalid endpoint/model and no leak from role draft.
  const card = role => [...root().querySelectorAll('.oks-settings-role')]
    .find(el=>el.getAttribute('aria-label')?.startsWith({
      embedding:'Semantic search',reranking:'Improve result ranking',generation:'Evidence-based answers'}[role]));
  const cardRow = (role,name) => row(name,card(role));
  assert(card('embedding') && card('reranking') && card('generation'), 'ROLE_CARDS');
  let checkEvidence = 'not-run';
  // Actual native editor connection checks: only run with the no-route host gate.
  if (process.env.OKS_HOST_NO_ROUTE === '1') {
    const http = require('node:http');
    let calls = 0, cancelled = 0;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', x => chunks.push(x));
      req.on('end', () => {
        calls++;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const finish = (code, value) => {
          res.writeHead(code, {'content-type':'application/json'});
          res.end(JSON.stringify(value));
        };
        if (req.headers.authorization === 'Bearer synthetic-check-slow') {
          const timer = setTimeout(() => finish(200, {model:'synthetic-check@v1',
            data:[{object:'embedding',index:0,embedding:[1,0,0]}]}), 1000);
          res.on('close', () => { clearTimeout(timer); cancelled++; });
          return;
        }
        if (req.headers.authorization !== 'Bearer synthetic-check-token') return finish(401,{});
        if (body.model !== 'synthetic-check@v1') return finish(400,{});
        if (req.url === '/v1/embeddings' && JSON.stringify(body.input) === JSON.stringify(['OKS connection check']))
          return finish(200,{model:body.model,data:[{object:'embedding',index:0,embedding:[1,0,0]}]});
        if (req.url === '/v1/chat/completions' &&
            JSON.parse(body.messages[1].content).passages[0].text === 'The color is blue.')
          return finish(200,{model:body.model,usage:{completion_tokens:8},choices:[{index:0,finish_reason:'stop',
            message:{role:'assistant',content:JSON.stringify({claims:[{kind:'quotation',text:'blue',citationIds:[0]}]})}}]});
        return finish(400,{});
      });
    });
    await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
    try {
      const checkOrigin = 'http://127.0.0.1:' + server.address().port;
      const baseline = JSON.stringify(p.settings);
      const status = role => card(role).querySelector('[data-oks-connection-check]');
      const fill = role => {
        edit(cardRow(role,'API origin'),checkOrigin);
        edit(cardRow(role,'Model ID'),'synthetic-check');
        edit(cardRow(role,'Model revision'),'v1');
      };
      const check = role => press(cardRow(role,'Connection check'),'Check');
      const credential = (role, value) => edit(cardRow(role,'One-check bearer token'),value);
      press(cardRow('embedding','Connection'),'Configure'); fill('embedding');
      edit(cardRow('embedding','Expected embedding dimension'),'3');
      assert(calls===0,'CHECK_NO_AUTO_IO');
      const tokenEl=credential('embedding','synthetic-check-token');
      assert(tokenEl.type==='password','CHECK_MASKED_TOKEN');
      const first=check('embedding');
      assert(first.disabled,'CHECK_BUSY');
      first.click();
      await wait(()=>status('embedding').textContent.includes('Check passed'),'CHECK_EMBEDDING_SUCCESS');
      assert(calls===1 && tokenEl.value==='' && status('embedding').textContent.includes('dimension: 3'),
        'CHECK_ONE_REQUEST_AND_CLEAR_TOKEN');
      credential('embedding','synthetic-wrong');check('embedding');
      await wait(()=>status('embedding').textContent.includes('UNAUTHENTICATED'),'CHECK_TYPED_AUTH_FAILURE');
      assert(calls===2 && tokenEl.value==='','CHECK_FAILED_TOKEN_CLEARED');
      credential('embedding','synthetic-check-slow');check('embedding');
      await wait(()=>calls===3,'CHECK_SLOW_REQUEST');
      press(cardRow('embedding','Connection'),'Close editor');
      await wait(()=>cancelled===1,'CHECK_CLOSE_ABORTS');
      assert(status('embedding').textContent==='' && tokenEl.value==='','CHECK_CLOSE_FENCE');
      press(cardRow('embedding','Connection'),'Configure');
      credential('embedding','synthetic-check-slow');check('embedding');
      await wait(()=>calls===4,'CHECK_EDIT_REQUEST');
      edit(cardRow('embedding','Model revision'),'v2');
      await wait(()=>cancelled===2,'CHECK_EDIT_ABORTS');
      assert(status('embedding').textContent==='' && tokenEl.value==='','CHECK_EDIT_FENCE');
      edit(cardRow('embedding','Model revision'),'v1');
      edit(cardRow('embedding','API origin'),'https://127.0.0.1:8765');
      assert(cardRow('embedding','Connection check').querySelector('button').disabled &&
        !visible(cardRow('embedding','One-check bearer token')) &&
        cardRow('embedding','Connection check').textContent.includes('not supported'),'CHECK_UNSUPPORTED_LOCAL_ORIGIN');
      choose(cardRow('embedding','Connection type'),'cloud');
      assert(cardRow('embedding','Connection check').querySelector('button').disabled &&
        !visible(cardRow('embedding','One-check bearer token')) && calls===4,'CHECK_CLOUD_BLOCKED');
      press(cardRow('embedding','Draft preferences'),'Cancel draft');
      press(cardRow('reranking','Connection'),'Configure');
      assert(cardRow('reranking','Connection check').querySelector('button').disabled &&
        cardRow('reranking','Connection check').textContent.includes('actual runtime profile'),'CHECK_RERANK_BLOCKED');
      press(cardRow('reranking','Draft preferences'),'Cancel draft');
      press(cardRow('generation','Connection'),'Configure');fill('generation');
      credential('generation','synthetic-check-token');check('generation');
      await wait(()=>status('generation').textContent.includes('Check passed'),'CHECK_GENERATION_SUCCESS');
      assert(calls===5 && JSON.stringify(p.settings)===baseline && p.standalone===engine &&
        p.standalone.status().generationId===generation,'CHECK_NO_SAVE_INDEX_OR_GRANT');
      credential('generation','synthetic-check-slow');check('generation');
      await wait(()=>calls===6,'CHECK_HIDE_REQUEST');
      app.setting.close();
      await wait(()=>cancelled===3,'CHECK_HIDE_ABORTS');
      app.setting.open(); await new Promise(r=>setTimeout(r,300));
      app.setting.openTabById(p.manifest.id); await new Promise(r=>setTimeout(r,300));
      doc = root().ownerDocument;
      assert(!status('generation').textContent && JSON.stringify(p.settings)===baseline,'CHECK_HIDE_FENCE');
      press(cardRow('generation','Draft preferences'),'Cancel draft');
      checkEvidence='embedding-generation-auth-duplicate-close-edit-hide-no-save-no-index';
    } finally {
      server.closeAllConnections();
      await new Promise(resolve=>server.close(resolve));
    }
  }
  const opener = cardRow('embedding','Connection').querySelector('button');
  assert(!visible(cardRow('embedding','API origin')), 'DISABLED_EDITOR_NOT_RENDERED');
  press(cardRow('embedding','Connection'), 'Configure');
  assert(opener.getAttribute('aria-expanded') === 'true' &&
    !!(opener.compareDocumentPosition(cardRow('embedding','Connection type')) &
      doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING), 'DISCLOSURE_DOM_ORDER');
  assert(visible(cardRow('embedding','API origin')), 'OPEN_EDITOR_RENDERED');
  edit(cardRow('embedding','API origin'), 'http://localhost:8765');
  edit(cardRow('embedding','Model ID'), 'synthetic-embedding');
  edit(cardRow('embedding','Model revision'), 'v1');
  press(cardRow('embedding','Draft preferences'), 'Save connection');
  assert(p.settings.ai.embedding.state === 'disabled', 'INVALID_ENDPOINT_NO_SAVE');
  assert(card('embedding').textContent.includes('canonical loopback'), 'INLINE_PROVIDER_ERROR');
  edit(cardRow('embedding','API origin'), 'http://127.0.0.1:8765');
  press(cardRow('embedding','Draft preferences'), 'Save connection');
  await wait(()=>p.settings.ai.embedding.state === 'configured','AI_ATOMIC_SAVE');
  assert(p.settings.ai.reranking.state === 'disabled' &&
    p.settings.ai.generation.state === 'disabled', 'AI_ROLE_INDEPENDENCE');
  assert(card('embedding').textContent.includes('not verified'), 'AI_NOT_READY');
  assert(doc.activeElement?.dataset.oksFocus === 'ai-embedding', 'AI_SAVE_FOCUS');
  assert(await offline(), 'BASIC_AFTER_CONFIG');
  assert(apiIndex().textContent.includes('Local provider configured; not verified') &&
    apiIndex().textContent.includes('Prepare explicit dense index rebuild') &&
    apiIndex().textContent.includes('Index readiness and coverage are not verified') &&
    !apiIndex().textContent.includes('indexed sources:') &&
    legacyActions().textContent.includes('These actions do not rebuild the API dense index') &&
    legacyActions().querySelectorAll('button')[1].disabled, 'CONFIGURED_API_NOT_LEGACY_REBUILD');
  press(cardRow('reranking','Connection'), 'Configure');
  choose(cardRow('reranking','Connection type'), 'cloud');
  assert(card('reranking').textContent.includes('Cloud remains unauthorised'), 'CLOUD_EGRESS_BOUNDARY');
  edit(cardRow('reranking','API origin'), 'https://api.example.com');
  edit(cardRow('reranking','Model ID'), 'synthetic-reranker');
  edit(cardRow('reranking','Model revision'), 'v1');
  assert(p.settings.ai.reranking.state === 'disabled', 'UNSAVED_CLOUD_NO_ENABLE');
  press(cardRow('reranking','Draft preferences'), 'Cancel draft');
  assert(p.settings.ai.reranking.state === 'disabled', 'CLOUD_CANCELLED');
  assert(doc.activeElement?.dataset.oksFocus === 'ai-reranking', 'AI_CANCEL_FOCUS');
  // Expert mode must not revoke search, index generation, grants, or providers.
  choose(row('Settings view'), 'expert');
  await wait(()=>p.settings.presentationMode==='expert','EXPERT_SWITCH');
  assert(p.standalone===engine && p.standalone.status().generationId===generation,
    'VIEW_ONLY_NO_INDEX_CHANGE');
  assert(p.settings.ai.embedding.state==='configured' && section('Advanced diagnostics'),
    'EXPERT_RETAINS_CAPABILITIES');
  assert(row('Backend setup') && row('Probe setup'), 'EXPERT_SECTIONS');
  press(row('Backend setup'), 'Configure local backend');
  assert(!visible(row('Backend profile')) && !visible(row('Trusted absolute Python executable')),
    'BACKEND_DISABLED_HIDES_PATHS');
  press(row('Backend draft'),'Cancel');
  assert(doc.activeElement?.dataset.oksFocus === 'backend', 'BACKEND_CANCEL_FOCUS');
  press(row('Probe setup'), 'Configure probe');
  assert(!visible(row('Trusted Python executable')) && !visible(row('Trusted synthetic probe entry')),
    'PROBE_DISABLED_HIDES_PATHS');
  press(row('Probe draft'),'Cancel');
  assert(doc.activeElement?.dataset.oksFocus === 'probe', 'PROBE_CANCEL_FOCUS');
  assert(await offline(), 'BASIC_IN_EXPERT');
  choose(row('Settings view'),'basic');
  await wait(()=>p.settings.presentationMode==='basic','BASIC_ROUNDTRIP');
  assert(!section('Advanced diagnostics') && p.settings.ai.embedding.state==='configured',
    'BASIC_HIDES_ONLY');
  // Accessible native controls and theme variables; presence is not a contrast audit.
  assert(root().querySelectorAll('input').length>0 && root().querySelectorAll('select').length>0,
    'NATIVE_CONTROLS');
  const namedControls = [...root().querySelectorAll('input, select, .checkbox-container')]
    .filter(el => el.getAttribute('aria-hidden') !== 'true' && el.getAttribute('tabindex') !== '-1');
  const unnamed = namedControls.filter(el => !el.getAttribute('aria-label')?.trim());
  assert(unnamed.length===0, 'ACCESSIBLE_CONTROL_NAMES_' + unnamed.map(el=>el.outerHTML.slice(0,140)).join('|'));
  assert([...root().querySelectorAll('button')].every(b=>b.textContent?.trim()),
    'BUTTON_TEXT_LABELS');
  const theme = doc.defaultView.getComputedStyle(root()).getPropertyValue('--text-normal');
  assert(typeof theme==='string', 'THEME_VARIABLES');
  assert(root().textContent.includes('sources:') && root().textContent.includes('not an estimate'),
    'HONEST_INDEX_STATUS');
  // Exercise a migrated v5 configuration with explicit historical opt-ins.
  // Missing paths are under the disposable host directory: no worker can start.
  const {presentationMode: _mode, ...v5} = structuredClone(p.settings);
  v5.version = 5;
  v5.advanced = {enabled:true,profile:'local-stdio',interpreter:tmp+'/missing-python',entry:tmp+'/missing-health'};
  v5.probe = {fixtureMode:true,interpreter:tmp+'/missing-python',entry:tmp+'/missing-probe'};
  await p.updateSettings(v5);
  app.setting.activeTab.display();
  assert(p.settings.version === 6 && p.settings.presentationMode === 'basic', 'V5_MIGRATION');
  assert(p.advancedHealth.snapshot().status === 'failed', 'SYNTHETIC_HEALTH_FAILURE');
  const localSummary = () => summary().includes('Health-only backend: enabled; transport state: failed') &&
    summary().includes('legacy synthetic probe: enabled for manual use; not a running-state indicator') &&
    !summary().includes(tmp);
  assert(localSummary() && !section('Advanced diagnostics'), 'MIGRATED_ACTIVE_SUMMARY');
  choose(row('Settings view'),'expert');
  await wait(()=>p.settings.presentationMode==='expert','MIGRATED_EXPERT');
  assert(localSummary() && section('Advanced diagnostics'), 'MIGRATED_EXPERT_SUMMARY');
  choose(row('Settings view'),'basic');
  await wait(()=>p.settings.presentationMode==='basic','MIGRATED_BASIC');
  assert(localSummary() && !section('Advanced diagnostics') &&
    p.settings.advanced.enabled && p.settings.probe.fixtureMode &&
    p.standalone===engine && p.standalone.status().generationId===generation, 'MIGRATED_ROUNDTRIP');
  assert(await offline(), 'MIGRATED_OFFLINE');
  // Cloud remains unavailable and malformed embedding preference stays isolated.
  const configured = structuredClone(p.settings.ai.embedding);
  await p.patchSettings(s=>{s.ai.embedding={...configured,transport:'cloud',origin:'https://api.example.com'};});
  app.setting.activeTab.display();
  assert(apiIndex().textContent.includes('cloud execution is not supported'), 'CLOUD_API_INDEX_UNAVAILABLE');
  await p.patchSettings(s=>{s.ai.embedding={state:'invalid'};});
  app.setting.activeTab.display();
  assert(apiIndex().textContent.includes('invalid saved provider preferences'), 'INVALID_API_INDEX_UNAVAILABLE');
  assert(await offline(), 'INVALID_API_OFFLINE');
  const beforeReloadMode = p.settings.presentationMode;
  // Leave subsequent optional-role fixture tests the exact clean starting configuration.
  await p.updateSettings(initialSettings);
  assert(Object.values(p.settings.ai).every(pref => pref.state === 'disabled'), 'FIXTURE_RESTORE');
  app.setting.close();
  return 'OBSIDIAN_SETTINGS_UX_PASS: clean Basic, task sections, draft/invalid save, failed save ' +
    'preservation, conditional OCR/structured paths, independent AI roles, cloud boundary, Basic/Expert ' +
    'operational equivalence, migrated enabled local summary, separate API/legacy index paths, native controls, offline evidence; mode=' + beforeReloadMode + '; connectionChecks=' + checkEvidence;
})()
