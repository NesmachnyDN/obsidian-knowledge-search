// Packaged production ItemView, synthetic local protocol fixture only.
(async()=>{
  const p=app.plugins.plugins['oks-synthetic-evidence'];
  const assert=(condition,code)=>{if(!condition)throw new Error('DENSE_HOST_'+code);};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const wait=async(fn,code)=>{const deadline=Date.now()+7000;while(!fn()){
    assert(Date.now()<deadline,code);await sleep(30);}};
  const old=p.settings;
  const root=()=>app.workspace.getLeavesOfType('oks-standalone-search')[0]?.view.contentEl;
  const el=selector=>{const item=root()?.querySelector(selector);assert(item,'ELEMENT_'+selector);return item;};
  const click=selector=>el(selector).click();
  const set=(selector,value,event='input')=>{const input=el(selector);input.value=value;input.dispatchEvent(new Event(event,{bubbles:true}));};
  const count=()=>Number(require('node:fs').readFileSync(require('node:path').join(app.vault.adapter.getBasePath(),'..','rerank-ready.count'),'utf8'));
  const message=()=>el('.oks-dense-message').textContent;
  const resultCount=()=>root().querySelectorAll('.oks-dense-results li').length;
  const prepare=async(kind='search')=>{
    const before=count();click(kind==='rebuild'?'.oks-dense-rebuild':'.oks-dense-prepare');
    await wait(()=>!!root().querySelector('.oks-dense-confirm'),'PREVIEW');
    assert(count()===before,'NO_HTTP_BEFORE_CONSENT');
    assert(el('.oks-dense-confirm').disabled,'DEFAULT_DENY');
    assert(el('.oks-dense-path-preview').textContent==='dense-a.md\ndense-b.md','EXACT_CORPUS');
    assert(el('.oks-dense-space-preview').textContent.includes('"dimension": 2'),'SPACE');
    assert(el('.oks-dense-excerpt-preview').textContent.includes('REQ-OKS-DENSE: alpha [[target|alias]]')
      &&el('.oks-dense-excerpt-preview').textContent.includes('REQ-OKS-DENSE: beta'),'ALL_EVIDENCE');
    if(kind==='search')assert(el('.oks-dense-query-preview').textContent==='REQ-OKS-DENSE','QUERY');
  };
  const approve=token=>{
    set('.oks-dense-classification','synthetic','change');set('.oks-dense-token',token);
    assert(el('.oks-dense-confirm').disabled,'REQUIRE_CHECK');
    const check=el('.oks-dense-confirm-check');check.checked=true;check.dispatchEvent(new Event('change',{bubbles:true}));
    const button=el('.oks-dense-confirm');assert(!button.disabled,'CONSENT');
    button.click();assert(!root().querySelector('.oks-dense-token'),'TOKEN_REMOVED');
    return button;
  };
  const run=async(token='fixture-success',kind='search')=>{
    await prepare(kind);approve(token);
  };
  const a=await app.vault.create('dense-a.md','---\ntags: fixture-a\nstatus: active\n---\nREQ-OKS-DENSE: alpha [[target|alias]]\n');
  const b=await app.vault.create('dense-b.md','---\ntags: fixture-b\nstatus: archived\n---\nREQ-OKS-DENSE: beta\n');
  try{
    await sleep(250);await p.standalone.whenIdle();await p.openSearch();
    set('.oks-dense-paths','dense-a.md\ndense-b.md');set('.oks-dense-dimension','2');
    set('.oks-dense-mode','dense','change');set('.oks-match-mode','terms','change');set('.oks-query','REQ-OKS-DENSE');
    set('.oks-tag','');set('.oks-link-target','');
    const check=el('.oks-filter-enabled');check.checked=false;check.dispatchEvent(new Event('change',{bubbles:true}));
    click('.oks-dense-rebuild');assert(message().includes('DISABLED'),'DISABLED');
    const cfg={state:'configured',transport:'local',origin:'http://127.0.0.1:18765',
      identity:{model:'synthetic-embedding',revision:'fixture-v1'},
      limits:{timeoutMs:800,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}};
    await p.updateSettings({...p.settings,ai:{...p.settings.ai,embedding:cfg}});
    const initial=count();
    await run();await wait(()=>message().includes('NOT_READY'),'MISSING_INDEX');
    assert(count()===initial&&resultCount()===0,'MISSING_INDEX_NO_EGRESS');
    await prepare('rebuild');
    const replay=approve('fixture-success');replay.click();
    await wait(()=>message().includes('rebuild: ok'),'REBUILD');
    assert(count()===initial+1,'ONE_BATCH_ONCE');
    await run();await wait(()=>message().includes('executed dense')&&message().endsWith('ok'),'DENSE');
    assert(resultCount()===2&&el('.oks-dense-results li').textContent.includes('alpha'),'RANK');
    click('.oks-dense-open');
    await wait(()=>app.workspace.getMostRecentLeaf()?.view?.editor?.getSelection()?.includes('REQ-OKS-DENSE: alpha'),'NAVIGATION');
    await p.openSearch();
    set('.oks-dense-mode','hybrid','change');set('.oks-tag','fixture-a');set('.oks-link-target','target');
    await run();await wait(()=>message().includes('executed hybrid')&&message().endsWith('ok'),'HYBRID');
    assert(resultCount()===1&&message().includes('lexical ready (1)')&&message().includes('dense ready (1)'),'METADATA_BEFORE_RANK');
    for(const [token,code] of [['fixture-rate','RATE_LIMITED'],['fixture-invalid','INVALID_RESPONSE'],['fixture-deny','UNAUTHENTICATED'],['fixture-delay','TIMEOUT']]){
      await run(token);await wait(()=>message().includes(code),'ERROR_'+code);
      assert(message().includes('executed none')&&resultCount()===0,'NO_FALLBACK_'+code);
    }
    await prepare();const preCancel=count();set('.oks-query','REQ-OKS-DENSE ');assert(!root().querySelector('.oks-dense-token')&&count()===preCancel,'INPUT_REVOCATION');
    set('.oks-query','REQ-OKS-DENSE');
    await prepare();await p.updateSettings({...p.settings,ai:{...p.settings.ai,embedding:{...cfg,identity:{model:cfg.identity.model,revision:'fixture-v2'}}}});
    assert(!root().querySelector('.oks-dense-token')&&count()===preCancel,'SETTINGS_REVOCATION');
    await run();await wait(()=>message().includes('SOURCE_STALE'),'SPACE_MISMATCH');
    assert(count()===preCancel,'SPACE_MISMATCH_NO_EGRESS');
    await p.updateSettings({...p.settings,ai:{...p.settings.ai,embedding:cfg}});
    await prepare();const beforeCancel=count();approve('fixture-delay');
    await wait(()=>count()>beforeCancel,'HTTP_STARTED');click('.oks-dense-cancel');await sleep(1500);
    assert(resultCount()===0&&!message().includes('executed hybrid'),'CANCEL_LATE_RESULT');
    await prepare();const beforeMutation=count();approve('fixture-delay');
    await wait(()=>count()>beforeMutation,'MUTATION_HTTP_STARTED');
    await app.vault.modify(a,'REQ-OKS-DENSE: changed\n');await sleep(1500);await p.standalone.whenIdle();
    assert(resultCount()===0&&!message().includes('executed hybrid'),'MUTATION_LATE_RESULT');
    set('.oks-tag','');set('.oks-link-target','');click('.oks-submit');
    await wait(()=>p.searchController.snapshot().phase==='results','LEXICAL_INDEPENDENCE');
    assert(p.searchController.snapshot().response.executedMode==='lexical','LEXICAL_MODE');
    assert(!JSON.stringify(p.settings).includes('fixture-success'),'TOKEN_NOT_PERSISTED');
    return 'OBSIDIAN_DENSE_FIXTURE_PASS: actual UI explicit one-shot consent exact corpus/space no pre-consent HTTP rebuild dense hybrid metadata navigation errors cancellation freshness lexical independence; synthetic only';
  }finally{
    await app.vault.delete(a);await app.vault.delete(b);await p.updateSettings(old);
    await sleep(250);await p.standalone.whenIdle();await p.openSearch();
    set('.oks-query','REQ-OKS-SMOKE');click('.oks-submit');
    await wait(()=>p.searchController.snapshot().phase==='results','RESTORE_SEARCH');
  }
})()
