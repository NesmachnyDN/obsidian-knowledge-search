// Real Obsidian Settings acceptance, synthetic Vault only. No APIs/egress are invoked.
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
  const doc = root().ownerDocument;
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
  const section = label => [...root().querySelectorAll('section')]
    .find(el=>el.getAttribute('aria-label')===label);
  assert(row('Settings view') && section('Overview') && section('Search & scope') &&
    section('AI capabilities (optional)') && section('Documents') && section('Index & maintenance'),
    'TASK_SECTIONS');
  assert(!section('Advanced diagnostics'), 'BASIC_HIDES_EXPERT');
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
  assert(row('PDF processing mode').hidden, 'PDF_HIDDEN_WHEN_OFF');
  docToggle.click();
  assert(!row('PDF processing mode').hidden && row('Local OCR language assets').hidden &&
    row('Pinned structured extraction artifacts').hidden, 'TEXT_ONLY_FIELDS');
  choose(row('PDF processing mode'), 'ocr');
  assert(!row('Local OCR language assets').hidden && row('Pinned structured extraction artifacts').hidden,
    'OCR_ONLY_FIELDS');
  choose(row('PDF processing mode'), 'structured');
  assert(row('Local OCR language assets').hidden && !row('Pinned structured extraction artifacts').hidden,
    'STRUCTURED_ONLY_FIELDS');
  choose(row('PDF processing mode'), 'structured-ocr');
  assert(!row('Local OCR language assets').hidden && !row('Pinned structured extraction artifacts').hidden,
    'STRUCTURED_OCR_FIELDS');
  press(row('Document setup draft'), 'Save setup');
  await new Promise(r=>setTimeout(r,80));
  assert(!p.settings.ingestion.enabled &&
    section('Documents').textContent.includes('absolute trusted local path'), 'INVALID_INGESTION_ATOMIC');
  press(row('Document setup draft'), 'Cancel');
  assert(!p.settings.ingestion.enabled && p.standalone===engine, 'CANCEL_INGESTION');
  // Independent role cards, invalid endpoint/model and no leak from role draft.
  const card = role => [...root().querySelectorAll('.oks-settings-role')]
    .find(el=>el.getAttribute('aria-label')?.startsWith({
      embedding:'Semantic search',reranking:'Improve result ranking',generation:'Evidence-based answers'}[role]));
  const cardRow = (role,name) => row(name,card(role));
  assert(card('embedding') && card('reranking') && card('generation'), 'ROLE_CARDS');
  press(cardRow('embedding','Connection'), 'Configure');
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
  assert(await offline(), 'BASIC_AFTER_CONFIG');
  press(cardRow('reranking','Connection'), 'Configure');
  choose(cardRow('reranking','Connection type'), 'cloud');
  assert(card('reranking').textContent.includes('Cloud remains unauthorised'), 'CLOUD_EGRESS_BOUNDARY');
  edit(cardRow('reranking','API origin'), 'https://api.example.com');
  edit(cardRow('reranking','Model ID'), 'synthetic-reranker');
  edit(cardRow('reranking','Model revision'), 'v1');
  assert(p.settings.ai.reranking.state === 'disabled', 'UNSAVED_CLOUD_NO_ENABLE');
  press(cardRow('reranking','Draft preferences'), 'Cancel draft');
  assert(p.settings.ai.reranking.state === 'disabled', 'CLOUD_CANCELLED');
  // Expert mode must not revoke search, index generation, grants, or providers.
  choose(row('Settings view'), 'expert');
  await wait(()=>p.settings.presentationMode==='expert','EXPERT_SWITCH');
  assert(p.standalone===engine && p.standalone.status().generationId===generation,
    'VIEW_ONLY_NO_INDEX_CHANGE');
  assert(p.settings.ai.embedding.state==='configured' && section('Advanced diagnostics'),
    'EXPERT_RETAINS_CAPABILITIES');
  assert(row('Backend setup') && row('Probe setup'), 'EXPERT_SECTIONS');
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
  const beforeReloadMode = p.settings.presentationMode;
  app.setting.close();
  return 'OBSIDIAN_SETTINGS_UX_PASS: clean Basic, task sections, draft/invalid save, failed save ' +
    'preservation, conditional OCR/structured paths, independent AI roles, cloud boundary, Basic/Expert ' +
    'operational equivalence, native controls, offline evidence; mode=' + beforeReloadMode;
})()
