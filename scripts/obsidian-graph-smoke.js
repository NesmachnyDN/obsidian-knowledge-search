// Actual Obsidian settings and internal graph scope, on disposable sources only.
(async()=>{
  const p=app.plugins.plugins['oks-synthetic-evidence'];
  const assert=(condition,label)=>{if(!condition)throw new Error('GRAPH_HOST_'+label);};
  const wait=async(predicate,label)=>{
    const until=Date.now()+6000;
    while(!predicate()){assert(Date.now()<until,label);await new Promise(r=>setTimeout(r,40));}
  };
  const tick=()=>new Promise(r=>setTimeout(r,400));
  assert(process.env.tmp && app.vault.adapter.getBasePath()===process.env.tmp+'/vault','SYNTHETIC_ONLY');
  assert(p && Object.values(p.settings.ai).every(pref=>pref.state==='disabled'),'AI_OFF');
  await p.standalone.whenIdle();
  const engine=p.standalone,signal=new AbortController().signal,all={mode:'vault-wide'};
  const selected=sourceIds=>({mode:'selected',kind:'files',sourceIds});
  const disabled=()=>{
    try{engine.captureGraphScope(all,signal);return false;}catch(e){return e.code==='GRAPH_DISABLED';}
  };
  const read=async(scope)=>await engine.captureGraphScope(scope,signal).read();
  const initial=globalThis.__oksGraphSmoke;
  const ru={'Settings view':'Режим отображения настроек','Graph mapping (JSON)':'Конфигурация графа (JSON)',
    'Graph mapping actions':'Действия с конфигурацией графа','Save mapping':'Сохранить конфигурацию',
    'Disable graph':'Отключить граф','Cancel':'Отмена','Invalid graph mapping.':'Некорректная конфигурация графа.'};
  const label=(actual,name)=>actual===name||actual===ru[name];
  const row=name=>[...(app.setting.activeTab?.containerEl?.querySelectorAll('.setting-item')??[])]
    .find(el=>label(el.querySelector('.setting-item-name')?.textContent?.trim(),name));
  const requireRow=name=>{
    const found=row(name);assert(found,'MISSING_ROW_'+name);return found;
  };
  const open=async()=>{app.setting.open();await tick();app.setting.openTabById(p.manifest.id);
    await wait(()=>!!row('Settings view'),'SETTINGS_OPEN');};
  const editMapping=value=>edit(requireRow('Graph mapping (JSON)').querySelector('textarea'),value);
  const press=(name)=>{
    const b=[...requireRow('Graph mapping actions').querySelectorAll('button')].find(el=>label(el.textContent,name));
    assert(b,'BUTTON_'+name);b.click();
  };
  const edit=(el,value,event='input')=>{
    assert(el,'INPUT');el.value=value;
    el.dispatchEvent(new el.ownerDocument.defaultView.Event(event,{bubbles:true}));
  };
  const graphMapping={schemaVersion:'oks-06b-mapping-v1',businessIdKey:'id',rules:[
    {relationId:'depends-on',propertyKey:'depends',direction:'author-to-target',targetEncoding:'business-id'}
  ]};
  const graphFiles=['graph-a.md','graph-b.md'];
  const expectEdge=async()=>{
    const s=await read(selected(graphFiles));
    assert(s.nodes.length===2&&s.edges.length===1&&s.coverage==='not-disclosed','SCOPED_EDGE');
    const e=s.edges[0];
    assert(e.kind==='relation'&&e.from==='graph-a.md'&&e.to==='graph-b.md'&&e.relationId==='depends-on'
      &&e.anchors.length===1&&e.anchors[0].locator.lineStart===3&&e.anchors[0].sourceSha256===e.authorSha256,'PROVENANCE');
    const raw=await app.vault.read(app.vault.getAbstractFileByPath('graph-a.md'));
    const loc=e.anchors[0].locator;
    assert(Buffer.from(raw).subarray(loc.byteStart,loc.byteEnd).toString()==='depends: B','ORIGINAL_ANCHOR');
    return s;
  };
  if(!initial){
    assert(disabled(),'DEFAULT_DISABLED');
    const original=structuredClone(p.settings);
    await app.vault.create(graphFiles[0],'---\nid: A\ndepends: B\n---\nSynthetic source A.\n');
    await app.vault.create(graphFiles[1],'---\nid: B\n---\nSynthetic source B.\n');
    await tick();await engine.whenIdle();
    await open();
    edit(requireRow('Settings view').querySelector('select'),'expert','change');
    await wait(()=>p.settings.presentationMode==='expert'&&!!row('Graph mapping (JSON)'),'EXPERT');
    editMapping('{"broken":');
    press('Save mapping');await tick();
    assert(disabled()&&['Invalid graph mapping.',ru['Invalid graph mapping.']].some(x=>app.setting.activeTab.containerEl.textContent.includes(x)),'INVALID_DRAFT');
    press('Cancel');await tick();
    editMapping(JSON.stringify(graphMapping));
    press('Save mapping');
    await wait(()=>p.settings.graph?.state==='configured'&&!p.denseSettingsChanging&&!!row('Graph mapping (JSON)'),'SAVE');
    assert((await p.loadData()).graph.state==='configured','DURABLE_SAVE');
    const s=await expectEdge();
    const narrow=await read(selected([graphFiles[0]]));
    assert(narrow.nodes.length===1&&narrow.edges.length===0&&!JSON.stringify(narrow).includes('graph-b.md'),'EXCLUSION');
    const lease=engine.captureGraphScope(selected(graphFiles),signal);
    await lease.read();
    // The host itself changes the source; the prior lease must retire.
    await app.vault.modify(app.vault.getAbstractFileByPath(graphFiles[1]),'---\nid: C\n---\nSynthetic source B.\n');
    await tick();await engine.whenIdle();
    assert(!lease.current(),'STALE_REVOCATION');
    assert((await read(selected(graphFiles))).edges.length===0,'STALE_EDGE_REMOVED');
    await app.vault.modify(app.vault.getAbstractFileByPath(graphFiles[1]),'---\nid: B\n---\nSynthetic source B.\n');
    await tick();await engine.whenIdle();await expectEdge();
    const previous=engine.captureGraphScope(selected(graphFiles),signal);await previous.read();
    editMapping(JSON.stringify({...graphMapping,rules:[]}));
    press('Save mapping');
    await wait(()=>p.settings.graph?.mapping?.rules.length===0&&!p.denseSettingsChanging&&!!row('Graph mapping (JSON)'),'EDIT');
    assert(!previous.current()&&(await read(selected(graphFiles))).edges.length===0,'MAPPING_REVOCATION');
    editMapping(JSON.stringify(graphMapping));
    press('Save mapping');await wait(()=>p.settings.graph?.mapping?.rules.length===1&&!p.denseSettingsChanging,'RESTORE_MAPPING');
    const reloadLease=engine.captureGraphScope(selected(graphFiles),signal);await reloadLease.read();
    globalThis.__oksGraphSmoke={original,lease:reloadLease,mappingId:s.mappingId};
    app.setting.close();
    return 'OBSIDIAN_GRAPH_HOST_BEFORE_RELOAD_PASS: explicit settings save, typed original anchor, narrow scope, invalid draft, source and mapping revocation';
  }
  try{
    assert(!initial.lease.current(),'OLD_LEASE_RETIRED');
    assert(p.settings.graph?.state==='configured','PERSISTED_CONFIGURATION');
    const s=await expectEdge();assert(s.mappingId===initial.mappingId,'MAPPING_ID_RESTART');
    const lease=engine.captureGraphScope(selected(graphFiles),signal);await lease.read();
    await open();await wait(()=>!!row('Graph mapping (JSON)'),'RELOAD_SETTINGS');
    press('Disable graph');
    await wait(()=>p.settings.graph?.state==='disabled'&&!p.denseSettingsChanging,'DISABLE');
    assert(!lease.current()&&disabled(),'DISABLED_REVOCATION');
    assert((await p.loadData()).graph.state==='disabled','DISABLED_PERSISTED');
    return 'OBSIDIAN_GRAPH_HOST_PASS: offline real settings, CLI scope lease, durable reload, original anchors, explicit disable';
  }finally{
    await p.updateSettings(initial.original);app.setting.close();
    for(const path of graphFiles){const file=app.vault.getAbstractFileByPath(path);if(file)await app.vault.delete(file);}
    await tick();await engine.whenIdle();delete globalThis.__oksGraphSmoke;
    await p.openSearch();
  }
})()
