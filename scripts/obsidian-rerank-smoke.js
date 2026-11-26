// Actual packaged SearchView in a disposable Obsidian Vault; isolated protocol fixture.
(async()=>{
  const p=app.plugins.plugins['oks-synthetic-evidence'];
  const assert=(condition,code)=>{if(!condition)throw new Error('RERANK_HOST_'+code);};
  const wait=async(fn,code)=>{const deadline=Date.now()+7000;while(!fn()){
    assert(Date.now()<deadline,code);await new Promise(r=>setTimeout(r,30));}};
  const old=p.settings;
  const count=()=>Number(require('node:fs').readFileSync(require('node:path').join(app.vault.adapter.getBasePath(),'..','rerank-ready.rerank-count'),'utf8'));
  const operation=()=>p.searchController.evidenceOperationStatus('reranking');
  const root=()=>app.workspace.getLeavesOfType('oks-standalone-search')[0]?.view.contentEl;
  const el=selector=>{const item=root()?.querySelector(selector);assert(item,'ELEMENT');return item;};
  const click=selector=>el(selector).click();
  const set=(selector,value,event='input')=>{const input=el(selector);input.value=value;input.dispatchEvent(new Event(event,{bubbles:true}));};
  const query=async()=>{set('.oks-query','REQ-OKS-RERANK');click('.oks-submit');
    await wait(()=>p.searchController.snapshot().phase==='results','SEARCH');};
  const confirm=token=>{
    click('.oks-rerank-prepare');
    assert(operation().phase==='permission-required','SETTINGS_PERMISSION');
    assert(el('.oks-rerank-confirm').disabled,'DEFAULT_DENY');
    assert(el('.oks-rerank-query-preview').textContent==='REQ-OKS-RERANK','QUERY_PREVIEW');
    assert(root().querySelectorAll('.oks-rerank-excerpt-preview').length===2,'EXCERPT_PREVIEW');
    set('.oks-rerank-classification','synthetic','change');
    set('.oks-rerank-token',token);
    assert(el('.oks-rerank-confirm').disabled,'REQUIRE_EXPLICIT_CHECK');
    const check=el('.oks-rerank-confirm-check');check.checked=true;check.dispatchEvent(new Event('change',{bubbles:true}));
    assert(!el('.oks-rerank-confirm').disabled,'CONSENT');
    click('.oks-rerank-confirm');
    assert(operation().phase==='busy','SETTINGS_BUSY');
    assert(!root().querySelector('.oks-rerank-token'),'TOKEN_REMOVED');
  };
  const a=await app.vault.create('rerank-a.md','REQ-OKS-RERANK: alpha\n');
  const b=await app.vault.create('rerank-b.md','REQ-OKS-RERANK: beta\n');
  try {
    await new Promise(r=>setTimeout(r,250));await p.standalone.whenIdle();await p.openSearch();await query();
    click('.oks-rerank-prepare');assert(el('.oks-rerank-message').textContent.includes('DISABLED'),'DISABLED');
    await p.updateSettings({...p.settings,ai:{...p.settings.ai,reranking:{state:'configured',transport:'local',
      origin:'http://127.0.0.1:18765',identity:{model:'synthetic-reranker',revision:'fixture-v1'},
      limits:{timeoutMs:3000,maxInputBytes:4096,maxCandidates:2,maxOutputTokens:32,maxConcurrent:1}},
      generation:{state:'configured',transport:'local',origin:'http://127.0.0.1:18765',
        identity:{model:'synthetic-generator',revision:'fixture-v1'},
        limits:{timeoutMs:3000,maxInputBytes:4096,maxCandidates:2,maxOutputTokens:128,maxConcurrent:1}}}});
    await query();
    // Configuration alone is not permission to verify or call a model.
    const initial=count();
    click('.oks-rerank-prepare');assert(el('.oks-rerank-message').textContent.includes('NOT_READY'),'ALIAS_ONLY_DENIED');
    assert(count()===initial,'ALIAS_ONLY_ZERO_HTTP');
    const host=p.searchController;
    host.rerankProfiles.installSyntheticFixture(p.settings.ai.reranking,host.rerankPort.scopeId(),'isolated-obsidian-fixture');
    const lexical=p.searchController.snapshot().response.hits;
    assert(lexical.length===2,'LEXICAL_CANDIDATES');
    // Last callback mutates on the old wave's third pass. The real view must
    // receive the fourth snapshot synchronously, before polling or any timer.
    const genCount=()=>Number(require('node:fs').readFileSync(require('node:path').join(app.vault.adapter.getBasePath(),'..','rerank-ready.generation-count'),'utf8'));
    const genInitial=genCount();
    click('.oks-generation-prepare');set('.oks-generation-token','fixture-success');const genToken=el('.oks-generation-token');click('.oks-generation-bind');
    set('.oks-generation-classification','synthetic','change');
    const genCheck=el('.oks-generation-confirm-check');
    genCheck.checked=true;genCheck.dispatchEvent(new Event('change',{bubbles:true}));
    assert(!el('.oks-generation-confirm').disabled,'WAVE_ARMED');
    click('.oks-rerank-prepare');
    let step=0,depth=0,maxDepth=0;
    const off=host.subscribeEvidence(()=>{
      depth++;maxDepth=Math.max(maxDepth,depth);
      try {
        if(step===0){step++;host.prepareRerank();}
        else if(step===1){step++;host.cancelRerank();}
        else if(step===2){step++;host.cancelGeneration();}
      } finally {depth--;}
    });
    try {host.cancelRerank();} finally {off();}
    assert(step===3&&maxDepth===1,'WAVE_FINITE_NONREENTRANT');
    assert(el('.oks-generation-message').textContent==='Local generation: CANCELLED','WAVE_FINAL_UI');
    assert(genToken.value===''&&!root().querySelector('.oks-generation-token'),'WAVE_TOKEN_CLEARED');
    assert(host.evidenceOperationStatus('generation').error==='CANCELLED'&&operation().error==='CANCELLED','WAVE_FINAL_AUTHORITY');
    assert(count()===initial&&genCount()===genInitial,'WAVE_ZERO_HTTP');
    await query();
    // Accelerate only the pending-preview timer in this disposable host, not HTTP deadlines.
    const originalSetTimeout=globalThis.setTimeout;
    let expiryTimer=0;
    try {
      globalThis.setTimeout=(fn,ms,...args)=>{
        if(ms===300000){expiryTimer++;return originalSetTimeout(fn,50,...args);}
        return originalSetTimeout(fn,ms,...args);
      };
      click('.oks-rerank-prepare');
      assert(operation().phase==='permission-required','EXPIRY_PENDING');
      set('.oks-rerank-token','fixture-success');
      const pendingToken=el('.oks-rerank-token');
      await wait(()=>operation().error==='CANCELLED','EXPIRY_TIMER');
      assert(expiryTimer===1&&!root().querySelector('.oks-rerank-token')&&pendingToken.value==='','EXPIRY_TOKEN_CLEARED');
      assert(JSON.stringify(p.searchController.snapshot().response.hits)===JSON.stringify(lexical),'EXPIRY_LEXICAL_UNCHANGED');
    } finally {globalThis.setTimeout=originalSetTimeout;}
    // Observe expiration before the scheduled callback, then roll wall time back.
    click('.oks-rerank-prepare');
    set('.oks-rerank-token','fixture-success');
    set('.oks-rerank-classification','synthetic','change');
    const staleCheck=el('.oks-rerank-confirm-check');staleCheck.checked=true;staleCheck.dispatchEvent(new Event('change',{bubbles:true}));
    const staleButton=el('.oks-rerank-confirm'),staleToken=el('.oks-rerank-token');
    assert(!staleButton.disabled,'LATE_PREVIEW_ARMED');
    const originalNow=Date.now,wall=originalNow();
    try {
      Date.now=()=>wall+300001;
      assert(operation().error==='CANCELLED','POLL_EXPIRY');
      Date.now=()=>wall-1000;
      assert(operation().error==='CANCELLED','NO_REVIVAL');
    } finally {Date.now=originalNow;}
    await Promise.resolve();
    assert(!root().querySelector('.oks-rerank-token')&&staleToken.value==='','POLL_EXPIRY_TOKEN_CLEARED');
    staleButton.click();
    assert(operation().error==='CANCELLED','DETACHED_CONFIRM_DENIED');
    assert(JSON.stringify(p.searchController.snapshot().response.hits)===JSON.stringify(lexical),'POLL_EXPIRY_LEXICAL_UNCHANGED');
    // Replacing the identical profile invalidates the exact armed preview without restoring it.
    click('.oks-rerank-prepare');set('.oks-rerank-classification','synthetic','change');set('.oks-rerank-token','fixture-success');
    const armedCheck=el('.oks-rerank-confirm-check');armedCheck.checked=true;armedCheck.dispatchEvent(new Event('change',{bubbles:true}));
    const armedButton=el('.oks-rerank-confirm'),armedToken=el('.oks-rerank-token');
    host.rerankProfiles.installSyntheticFixture(p.settings.ai.reranking,host.rerankPort.scopeId(),'isolated-obsidian-fixture');
    await Promise.resolve();
    assert(armedToken.value===''&&!root().querySelector('.oks-rerank-token'),'PROFILE_CHANGE_CLEARS_TOKEN');
    armedButton.click();assert(count()===initial,'RETIRED_PREVIEW_ZERO_HTTP');
    confirm('fixture-success');
    await wait(()=>p.searchController.snapshot().rerank?.phase==='results','RESULTS');
    const result=p.searchController.snapshot();
    assert(operation().phase==='complete'&&operation().error===null,'SETTINGS_COMPLETE');
    assert(count()===initial+1&&el('.oks-rerank-message').textContent.includes('synthetic fixture'),'FIXTURE_ONLY_RESULT');
    assert(JSON.stringify(result.response.hits)===JSON.stringify(lexical),'LEXICAL_UNCHANGED');
    assert(JSON.stringify(result.rerank.hits.map(x=>x.evidence))===JSON.stringify([lexical[1],lexical[0]]),'EVIDENCE_REORDER');
    assert(root().querySelectorAll('.oks-rerank-results li').length===2,'RENDERED');
    confirm('fixture-deny');await wait(()=>p.searchController.snapshot().rerank?.phase==='error','AUTH_ERROR');
    assert(p.searchController.snapshot().rerank.error==='UNAUTHENTICATED','TYPED_ERROR');
    assert(operation().phase==='failed'&&operation().error==='UNAUTHENTICATED','SETTINGS_ERROR');
    assert(root().querySelectorAll('.oks-results li').length===2&&!root().querySelectorAll('.oks-rerank-results li').length,'NO_FALLBACK');
    confirm('fixture-delay');click('.oks-rerank-cancel');await wait(()=>p.searchController.snapshot().rerank?.error==='CANCELLED','CANCEL');
    await new Promise(r=>setTimeout(r,1400));
    assert(p.searchController.snapshot().rerank?.error==='CANCELLED','NO_LATE_RESULT');
    confirm('fixture-delay');await app.vault.modify(a,'REQ-OKS-RERANK: changed\n');
    await wait(()=>!p.searchController.snapshot().response,'MUTATION_INVALIDATES');
    await new Promise(r=>setTimeout(r,1400));assert(!p.searchController.snapshot().rerank,'STALE_SUPPRESSED');
    assert(!JSON.stringify(p.settings).includes('fixture-success'),'TOKEN_NOT_PERSISTED');
    const originalConfig=p.settings.ai.reranking;
    const beforeRestore=count();
    await p.updateSettings({...p.settings,ai:{...p.settings.ai,reranking:{...originalConfig,identity:{...originalConfig.identity,revision:'changed'}}}});
    await p.updateSettings({...p.settings,ai:{...p.settings.ai,reranking:originalConfig}});
    await query();click('.oks-rerank-prepare');
    assert(operation().error==='NOT_READY'&&count()===beforeRestore,'CONFIG_RESTORE_NOT_ADMITTED');
    return 'OBSIDIAN_RERANK_FIXTURE_PASS: explicit consent local HTTP original evidence reorder auth cancel stale suppression lexical independence finite wave final UI token cleanup zero unauthorized HTTP; mock only';
  } finally {
    await app.vault.delete(a);await app.vault.delete(b);await p.updateSettings(old);
    await new Promise(r=>setTimeout(r,250));await p.standalone.whenIdle();await p.openSearch();
    set('.oks-query','REQ-OKS-SMOKE');click('.oks-submit');
    await wait(()=>p.searchController.snapshot().phase==='results','RESTORE_SEARCH');
  }
})()
