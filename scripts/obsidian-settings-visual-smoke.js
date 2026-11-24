// Pixel/layout acceptance in real Obsidian only, isolated generated Vault, no provider calls.
(async () => {
  const assert = (ok, tag) => { if (!ok) throw Error('VISUAL_' + tag); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (fn, tag) => {
    const end = Date.now() + 5000;
    while (!fn()) { assert(Date.now() < end, tag); await sleep(50); }
  };
  const tmp = process.env.tmp;
  assert(tmp && app.vault.adapter.getBasePath() === tmp + '/vault', 'SYNTHETIC_ONLY');
  const p = app.plugins.plugins['oks-synthetic-evidence'];
  assert(p?.standalone?.status().status === 'ready', 'READY');
  const fs = require('node:fs'), remote = require('@electron/remote');
  const initial = structuredClone(p.settings);
  const captures = [];
  assert(initial.presentationMode === 'basic' && Object.values(initial.ai).every(x=>x.state==='disabled'), 'CLEAN_START');
  app.setting.open(); await sleep(400); app.setting.openTabById(p.manifest.id); await sleep(400);
  const root = () => app.setting.activeTab.containerEl;
  const doc = root().ownerDocument;
  root().dataset.oksVisualMarker = 'synthetic47';
  let win;
  for (const candidate of remote.BrowserWindow.getAllWindows()) {
    if (await candidate.webContents.executeJavaScript("!!document.querySelector('[data-oks-visual-marker=synthetic47]')").catch(()=>false)) {
      win = candidate; break;
    }
  }
  assert(win, 'SETTINGS_WINDOW');
  win.show(); win.focus();
  const row = (name, area=root()) => [...area.querySelectorAll('.setting-item')]
    .find(el=>el.querySelector('.setting-item-name')?.textContent?.trim()===name);
  const role = name => [...root().querySelectorAll('.oks-settings-role')].find(el=>el.getAttribute('aria-label').startsWith(name));
  const visible = el => !!el && el.getClientRects().length > 0 && doc.defaultView.getComputedStyle(el).display !== 'none';
  const button = (r, name) => {
    const b = [...r.querySelectorAll('button')].find(el=>el.textContent===name);
    assert(b && visible(b) && !b.disabled,'BUTTON_'+name); return b;
  };
  const press = (r,name) => button(r,name).click();
  const edit = (r,value,type='input') => {
    const el = r.querySelector(type==='change'?'select:not([aria-hidden=true])':'input');
    assert(visible(el),'INPUT');
    el.value=value; el.dispatchEvent(new doc.defaultView.Event(type,{bubbles:true})); return el;
  };
  const capture = async (name,target) => {
    if(target) target.scrollIntoView({block:'center',inline:'nearest'});
    await sleep(150);
    const png=(await win.webContents.capturePage()).toPNG();
    assert(png.length>10000,'EMPTY_'+name);
    fs.writeFileSync(tmp+'/visual/'+name+'.png',png);
    captures.push({name,bytes:png.length,zoom:win.webContents.getZoomFactor(),width:doc.defaultView.innerWidth,height:doc.defaultView.innerHeight});
  };
  const fit = tag => {
    const rr=root().getBoundingClientRect();
    const clipped=[...root().querySelectorAll('button,input,select,[role=checkbox]')]
      .filter(e=>visible(e)&&e.getAttribute('aria-hidden')!=='true')
      .map(e=>({name:e.getAttribute('aria-label')||e.textContent,rect:e.getBoundingClientRect()}))
      .filter(e=>e.rect.left<rr.left-2||e.rect.right>rr.right+2);
    assert(!clipped.length,tag+'_CLIPPED_'+JSON.stringify(clipped.map(e=>e.name)));
    if(root().scrollWidth>root().clientWidth+2){
      const overflow=[...root().querySelectorAll('*')].filter(visible).map(e=>({
        cls:String(e.className).slice(0,80),tag:e.tagName,width:e.clientWidth,scroll:e.scrollWidth,
        left:Math.round(e.getBoundingClientRect().left),right:Math.round(e.getBoundingClientRect().right),
        display:doc.defaultView.getComputedStyle(e).display,text:e.textContent.trim().slice(0,48)
      })).filter(e=>e.right>rr.right+2||e.scroll>e.width+10).slice(0,24);
      throw Error('VISUAL_'+tag+'_OVERFLOW_'+root().scrollWidth+'_'+root().clientWidth+'_'+JSON.stringify(overflow));
    }
    return {width:root().clientWidth,scroll:root().scrollWidth};
  };
  const nativeKey = async(keyCode,modifiers=[])=>{
    win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
    win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});
    await sleep(100);
  };
  const chooseMode = async value => {
    edit(row('Settings view'),value,'change');
    await wait(()=>p.settings.presentationMode===value,'MODE_SAVE');
  };
  const originalBounds = win.getBounds(), originalZoom = win.webContents.getZoomFactor();
  const wasDark = doc.body.classList.contains('theme-dark');
  const theme = dark => {doc.body.classList.toggle('theme-dark',dark);doc.body.classList.toggle('theme-light',!dark);};
  const result={};
  try {
    theme(false); win.setSize(900,700); win.webContents.setZoomFactor(1); await sleep(300);
    await capture('basic-clean',row('Settings view'));
    let r=role('Semantic search');
    press(row('Connection',r),'Configure');
    edit(row('API origin',r),'http://127.0.0.1:8765');
    edit(row('Model ID',r),'synthetic-embedding'); edit(row('Model revision',r),'v1');
    await capture('local-draft',row('Draft preferences',r));
    press(row('Draft preferences',r),'Save connection');
    await wait(()=>p.settings.ai.embedding.state==='configured','AI_SAVE');
    assert(doc.activeElement?.dataset.oksFocus==='ai-embedding','SAVE_FOCUS');
    await capture('basic-configured',row('Optional AI capabilities'));
    r=role('Improve result ranking');
    const opener=button(row('Connection',r),'Configure');
    opener.focus(); await nativeKey('Space');
    assert(opener.getAttribute('aria-expanded')==='true','KEYBOARD_OPEN');
    const form=doc.getElementById(opener.getAttribute('aria-controls'));
    await nativeKey('Tab');
    assert(form.contains(doc.activeElement)&&doc.activeElement.matches(':focus-visible'),'TAB_ENTERS_EDITOR');
    await capture('keyboard-focus',doc.activeElement);
    await nativeKey('Tab',['shift']);
    assert(doc.activeElement===opener,'SHIFT_TAB_RETURNS');
    edit(row('Connection type',r),'cloud','change');
    edit(row('API origin',r),'https://api.example.com');
    edit(row('Model ID',r),'synthetic-reranker');edit(row('Model revision',r),'v1');
    await capture('cloud-draft',row('API origin',r));
    result.normal=fit('NORMAL');
    // Long-label stress: temporary synthetic translations, no localization implementation claim.
    const actions=row('Draft preferences',r);
    const title=actions.querySelector('.setting-item-name'), buttons=[...actions.querySelectorAll('button')];
    const original=[title.textContent,...buttons.map(b=>b.textContent)];
    try {
      title.textContent='Настройки подключения и проверка конфигурации выбранной модели';
      ['Сохранить параметры подключения','Отменить изменения черновика','Отключить эту возможность']
        .forEach((v,i)=>buttons[i].textContent=v);
      await capture('long-labels',actions); result.long=fit('LONG_LABELS');
    } finally { title.textContent=original[0];buttons.forEach((b,i)=>b.textContent=original[i+1]); }
    for(const [width,zoom,name] of [[760,1,'narrow-100'],[900,2,'default-200'],[760,2,'narrow-200']]){
      win.setSize(width,700);win.webContents.setZoomFactor(zoom);await sleep(300);
      await capture(name,actions);result[name]=fit(name);
    }
    win.webContents.setZoomFactor(1);win.setSize(900,700);await sleep(250);
    press(actions,'Cancel draft');
    assert(doc.activeElement?.dataset.oksFocus==='ai-reranking','CANCEL_FOCUS');
    r=role('Evidence-based answers');press(row('Connection',r),'Configure');
    edit(row('API origin',r),'http://localhost:8765');edit(row('Model ID',r),'synthetic-llm');
    edit(row('Model revision',r),'v1');press(row('Draft preferences',r),'Save connection');
    await capture('invalid-provider',row('Draft preferences',r));press(row('Draft preferences',r),'Cancel draft');
    edit(row('Results per search'),'25');
    const saveData=p.saveData.bind(p); p.saveData=async()=>{throw Error('synthetic-write-refusal')};
    try{press(row('Results draft'),'Save');await wait(()=>root().textContent.includes('unsaved draft is retained'),'SAVE_ERROR');
      await capture('failed-save',row('Results draft'));
    }finally{p.saveData=saveData;}
    assert(row('Results per search').querySelector('input').value==='25','FAILED_SAVE_DRAFT');
    press(row('Results draft'),'Cancel');
    press(row('Processing setup'),'Configure documents');
    assert(!visible(row('PDF processing mode'))&&!visible(row('Local OCR language assets')),'DISABLED_PATHS');
    row('Enable local document ingestion after Save').querySelector('.checkbox-container').click();
    for(const mode of ['text','ocr','structured','structured-ocr']){
      edit(row('PDF processing mode'),mode,'change');
      assert(visible(row('Local OCR language assets'))===mode.includes('ocr'),'OCR_'+mode);
      assert(visible(row('Pinned structured extraction artifacts'))===mode.includes('structured'),'STRUCTURE_'+mode);
      await capture('pdf-'+mode,row('Document setup draft'));
    }
    press(row('Document setup draft'),'Cancel');
    const before=p.standalone.status().generationId;
    await chooseMode('expert');theme(true);
    await capture('expert-dark',row('Backend setup'));
    r=role('Semantic search');press(row('Connection',r),'Configure');
    await capture('expert-limits',row('Timeout (ms, 100–30000)',r));press(row('Draft preferences',r),'Cancel draft');
    press(row('Backend setup'),'Configure local backend');
    assert(!visible(row('Backend profile')),'BACKEND_HIDDEN');press(row('Backend draft'),'Cancel');
    press(row('Probe setup'),'Configure probe');
    assert(!visible(row('Trusted Python executable')),'PROBE_HIDDEN');press(row('Probe draft'),'Cancel');
    await chooseMode('basic');theme(false);
    assert(p.standalone.status().generationId===before,'MODE_GENERATION');
    await capture('maintenance',row('Manual index operations'));result.maintenance=fit('MAINTENANCE');
    row('Enable offline search').querySelector('.checkbox-container').click();
    await wait(()=>!p.settings.enabled,'DISABLED');
    press(row('Delete derived offline index'),'Clear derived files');
    const modal=[...doc.querySelectorAll('.modal')].find(e=>e.textContent.includes('Confirm derived-index cleanup'));
    assert(modal,'PURGE_MODAL'); await capture('cleanup-confirm',modal);
    press(modal,'Cancel');
    row('Enable offline search').querySelector('.checkbox-container').click();
    await wait(()=>p.standalone?.status().status==='ready','RE_ENABLED');
    fs.writeFileSync(tmp+'/visual/results.json',JSON.stringify({captures,geometry:result},null,2)+'\n');
  } finally {
    theme(wasDark);win.webContents.setZoomFactor(originalZoom);win.setBounds(originalBounds);
    await p.updateSettings(initial);
    await wait(()=>p.standalone?.status().status==='ready','RESTORE_READY');
    app.setting.close();
  }
  return 'OBSIDIAN_SETTINGS_VISUAL_PASS: '+JSON.stringify({captures:captures.length,geometry:result});
})()
