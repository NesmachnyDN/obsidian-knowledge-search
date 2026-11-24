// Packaged production ItemView, synthetic local protocol fixture only.
(async()=>{
  const p=app.plugins.plugins['oks-synthetic-evidence'];
  const assert=(condition,code)=>{if(!condition)throw new Error('DENSE_HOST_'+code);};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const wait=async(fn,code)=>{const deadline=Date.now()+7000;while(!fn()){
    assert(Date.now()<deadline,code);await sleep(30);}};
  const old=p.settings;
  const operation=()=>p.denseUi.operationStatus();
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
    assert(operation().phase==='permission-required','SETTINGS_PERMISSION');
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
    assert(operation().phase==='busy','SETTINGS_BUSY');
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
    assert(operation().phase==='complete'&&operation().error===null,'SETTINGS_COMPLETE');
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
      assert(operation().phase==='failed'&&operation().error===code,'SETTINGS_ERROR_'+code);
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
    // Actual CLI eval calls the production machine API; human confirmation is
    // simulated only by driving the same real ItemView controls as D7.
    const machine=(operation,fields={})=>p.denseApi.request({apiVersion:1,operation,...fields});
    const request={protocolVersion:2,requestId:'machine-fixture',query:'REQ-OKS-DENSE',
      requestedMode:'hybrid',matchMode:'terms',scope:['dense-a.md','dense-b.md'],limit:1,
      metadata:{tag:'fixture-a',linkTarget:'target'}};
    const space={...cfg.identity,dimension:2,normalization:'unit-l2',serializationId:'utf8-verbatim-v1',
      queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
    const stage=async()=>{
      const staged=await machine('submit',{request,space});assert(staged.ok,'MACHINE_SUBMIT');
      return staged.value.operationId;
    };
    const read=(operation,operationId)=>machine(operation,{operationId});
    const review=async()=>{
      click('.oks-dense-machine-review');
      await wait(()=>!!root().querySelector('.oks-dense-confirm'),'MACHINE_PREVIEW');
      assert(el('.oks-dense-query-preview').textContent===request.query
        &&el('.oks-dense-path-preview').textContent===request.scope.join('\n'),'MACHINE_EXACT');
      assert(el('.oks-dense-preview').textContent.includes('Machine-initiated')
        &&el('.oks-dense-confirm').disabled,'MACHINE_EXPLICIT');
    };
    const beforeMachine=count(),id=await stage();
    const metadata=await read('status',id);
    assert(metadata.ok&&metadata.value.phase==='pending'&&!JSON.stringify(metadata).includes('dense-a.md')
      &&!JSON.stringify(metadata).includes(request.query)&&!JSON.stringify(metadata).includes(id),'MACHINE_STATUS');
    assert(!(await machine('submit',{request,space})).ok
      &&!(await read('status','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).ok
      &&!(await read('result',id)).ok
      &&!(await machine('submit',{request,space,token:'fixture-success'})).ok
      &&count()===beforeMachine,'MACHINE_NO_EGRESS');
    await review();assert(count()===beforeMachine,'MACHINE_PREVIEW_NO_EGRESS');
    approve('fixture-success');
    await wait(()=>message().includes('executed hybrid')&&message().endsWith('ok'),'MACHINE_COMPLETE');
    const response=await read('result',id);
    assert(response.ok&&response.value.status==='ok'&&response.value.executedMode==='hybrid'
      &&response.value.hits.length===1&&response.value.hits[0].evidence.sourceId==='dense-a.md'
      &&count()===beforeMachine+1,'MACHINE_VERIFIED_RESULT');
    assert(!(await read('result',id)).ok,'MACHINE_REPLAY');
    const cancelId=await stage();await review();
    assert((await read('cancel',cancelId)).ok&&!root().querySelector('.oks-dense-token')
      &&!(await read('result',cancelId)).ok&&count()===beforeMachine+1,'MACHINE_CANCEL');
    // LIFE-07/08: actual packaged authority hook, pending machine consent and
    // real ItemView token cleanup. Assertions run outside observer delivery.
    const authorityId=await stage();await review();set('.oks-dense-token','fixture-unconfirmed');
    const authorityBefore=count(),delivered=[];let nestedSubmit,manualPrepare,thrown=0;
    const bad=p.denseMachine.subscribe(()=>{thrown++;throw Error('synthetic observer');});
    const reentry=p.denseMachine.subscribe(()=>{
      nestedSubmit??=machine('submit',{request,space});
      manualPrepare??=p.denseUi.prepare(Symbol('nested-fixture'),{kind:'search',paths:request.scope,space,request});
    });
    const lifecycle=p.searchController.subscribe(()=>delivered.push({
      pending:p.denseMachine.pending(),phase:p.denseUi.operationStatus().phase}));
    try{
      const lexical=await p.searchController.search({protocolVersion:2,requestId:'authority-fixture',
        query:'REQ-OKS-DENSE',requestedMode:'lexical',limit:1});
      assert(lexical.ok&&lexical.value.status==='ok','AUTHORITY_LEXICAL');
      const nested=await nestedSubmit;await manualPrepare;
      assert(nested&&!nested.ok&&nested.error==='NOT_READY'&&thrown===1,'AUTHORITY_REENTRY_EXCEPTION');
      assert(delivered.length>0&&delivered.every(s=>!s.pending&&s.phase==='idle'),'AUTHORITY_FINAL');
      assert(!(await read('status',authorityId)).ok&&!root().querySelector('.oks-dense-token')
        &&count()===authorityBefore,'AUTHORITY_TOKEN_NO_EGRESS');
    }finally{bad();reentry();lifecycle();}
    const errorId=await stage();await review();approve('fixture-rate');
    await wait(()=>message().includes('RATE_LIMITED'),'MACHINE_RATE');
    const denied=await read('result',errorId);
    assert(denied.ok&&denied.value.error==='RATE_LIMITED'&&denied.value.executedMode==='none'
      &&denied.value.hits.length===0,'MACHINE_NO_FALLBACK');
    const staleId=await stage();await review();approve('fixture-success');
    await wait(()=>message().includes('executed hybrid')&&message().endsWith('ok'),'MACHINE_STALE_READY');
    // Mutate a non-hit source through the disposable filesystem without waiting
    // for Obsidian events; delivery must fail even if an event has not arrived.
    const fs=require('node:fs'),path=require('node:path').join(app.vault.adapter.getBasePath(),'dense-b.md');
    const original=fs.readFileSync(path,'utf8'),beforeStale=count();
    fs.writeFileSync(path,original+'\nSynthetic mutation.\n');
    const stale=await read('result',staleId);
    assert(!stale.ok&&['INVALID_OPERATION','SOURCE_STALE'].includes(stale.error)
      &&count()===beforeStale,'MACHINE_NON_HIT_STALE');
    await app.vault.modify(b,original);await sleep(350);await p.standalone.whenIdle();
    await prepare('rebuild');approve('fixture-success');
    await wait(()=>message().includes('rebuild: ok'),'MACHINE_RESTORE_INDEX');
    await prepare();const beforeMutation=count();approve('fixture-delay');
    await wait(()=>count()>beforeMutation,'MUTATION_HTTP_STARTED');
    await app.vault.modify(a,'REQ-OKS-DENSE: changed\n');await sleep(1500);await p.standalone.whenIdle();
    assert(resultCount()===0&&!message().includes('executed hybrid'),'MUTATION_LATE_RESULT');
    set('.oks-tag','');set('.oks-link-target','');click('.oks-submit');
    await wait(()=>p.searchController.snapshot().phase==='results','LEXICAL_INDEPENDENCE');
    assert(p.searchController.snapshot().response.executedMode==='lexical','LEXICAL_MODE');
    assert(!JSON.stringify(p.settings).includes('fixture-success'),'TOKEN_NOT_PERSISTED');
    return 'OBSIDIAN_DENSE_FIXTURE_PASS: actual UI explicit one-shot consent exact corpus/space no pre-consent HTTP rebuild dense hybrid metadata navigation errors cancellation freshness lexical independence; D8 CLI machine staged consent, ownership, one-shot fresh result, cancellation, typed error, non-hit stale rejection, atomic shared authority reentry/exception and token cleanup; synthetic only';
  }finally{
    await app.vault.delete(a);await app.vault.delete(b);await p.updateSettings(old);
    await sleep(250);await p.standalone.whenIdle();await p.openSearch();
    set('.oks-query','REQ-OKS-SMOKE');click('.oks-submit');
    await wait(()=>p.searchController.snapshot().phase==='results','RESTORE_SEARCH');
  }
})()
