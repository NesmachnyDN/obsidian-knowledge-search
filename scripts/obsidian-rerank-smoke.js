// Actual packaged SearchView in a disposable Obsidian Vault; isolated protocol fixture.
(async()=>{
  const p=app.plugins.plugins['oks-synthetic-evidence'];
  const assert=(condition,code)=>{if(!condition)throw new Error('RERANK_HOST_'+code);};
  const wait=async(fn,code)=>{const deadline=Date.now()+7000;while(!fn()){
    assert(Date.now()<deadline,code);await new Promise(r=>setTimeout(r,30));}};
  const old=p.settings;
  const root=()=>app.workspace.getLeavesOfType('oks-standalone-search')[0]?.view.contentEl;
  const el=selector=>{const item=root()?.querySelector(selector);assert(item,'ELEMENT');return item;};
  const click=selector=>el(selector).click();
  const set=(selector,value,event='input')=>{const input=el(selector);input.value=value;input.dispatchEvent(new Event(event,{bubbles:true}));};
  const query=async()=>{set('.oks-query','REQ-OKS-RERANK');click('.oks-submit');
    await wait(()=>p.searchController.snapshot().phase==='results','SEARCH');};
  const confirm=token=>{
    click('.oks-rerank-prepare');
    assert(el('.oks-rerank-confirm').disabled,'DEFAULT_DENY');
    assert(el('.oks-rerank-query-preview').textContent==='REQ-OKS-RERANK','QUERY_PREVIEW');
    assert(root().querySelectorAll('.oks-rerank-excerpt-preview').length===2,'EXCERPT_PREVIEW');
    set('.oks-rerank-classification','synthetic','change');
    set('.oks-rerank-token',token);
    assert(el('.oks-rerank-confirm').disabled,'REQUIRE_EXPLICIT_CHECK');
    const check=el('.oks-rerank-confirm-check');check.checked=true;check.dispatchEvent(new Event('change',{bubbles:true}));
    assert(!el('.oks-rerank-confirm').disabled,'CONSENT');
    click('.oks-rerank-confirm');
    assert(!root().querySelector('.oks-rerank-token'),'TOKEN_REMOVED');
  };
  const a=await app.vault.create('rerank-a.md','REQ-OKS-RERANK: alpha\n');
  const b=await app.vault.create('rerank-b.md','REQ-OKS-RERANK: beta\n');
  try {
    await new Promise(r=>setTimeout(r,250));await p.standalone.whenIdle();await p.openSearch();await query();
    click('.oks-rerank-prepare');assert(el('.oks-rerank-message').textContent.includes('DISABLED'),'DISABLED');
    await p.updateSettings({...p.settings,ai:{...p.settings.ai,reranking:{state:'configured',transport:'local',
      origin:'http://127.0.0.1:18765',identity:{model:'synthetic-reranker',revision:'fixture-v1'},
      limits:{timeoutMs:3000,maxInputBytes:4096,maxCandidates:2,maxOutputTokens:32,maxConcurrent:1}}}});
    await query();
    const lexical=p.searchController.snapshot().response.hits;
    assert(lexical.length===2,'LEXICAL_CANDIDATES');
    confirm('fixture-success');
    await wait(()=>p.searchController.snapshot().rerank?.phase==='results','RESULTS');
    const result=p.searchController.snapshot();
    assert(JSON.stringify(result.response.hits)===JSON.stringify(lexical),'LEXICAL_UNCHANGED');
    assert(JSON.stringify(result.rerank.hits.map(x=>x.evidence))===JSON.stringify([lexical[1],lexical[0]]),'EVIDENCE_REORDER');
    assert(root().querySelectorAll('.oks-rerank-results li').length===2,'RENDERED');
    confirm('fixture-deny');await wait(()=>p.searchController.snapshot().rerank?.phase==='error','AUTH_ERROR');
    assert(p.searchController.snapshot().rerank.error==='UNAUTHENTICATED','TYPED_ERROR');
    assert(root().querySelectorAll('.oks-results li').length===2&&!root().querySelectorAll('.oks-rerank-results li').length,'NO_FALLBACK');
    confirm('fixture-delay');click('.oks-rerank-cancel');await wait(()=>p.searchController.snapshot().rerank?.error==='CANCELLED','CANCEL');
    await new Promise(r=>setTimeout(r,1400));
    assert(p.searchController.snapshot().rerank?.error==='CANCELLED','NO_LATE_RESULT');
    confirm('fixture-delay');await app.vault.modify(a,'REQ-OKS-RERANK: changed\n');
    await wait(()=>!p.searchController.snapshot().response,'MUTATION_INVALIDATES');
    await new Promise(r=>setTimeout(r,1400));assert(!p.searchController.snapshot().rerank,'STALE_SUPPRESSED');
    assert(!JSON.stringify(p.settings).includes('fixture-success'),'TOKEN_NOT_PERSISTED');
    return 'OBSIDIAN_RERANK_FIXTURE_PASS: explicit consent local HTTP original evidence reorder auth cancel stale suppression lexical independence; mock only';
  } finally {
    await app.vault.delete(a);await app.vault.delete(b);await p.updateSettings(old);
    await new Promise(r=>setTimeout(r,250));await p.standalone.whenIdle();await p.openSearch();
    set('.oks-query','REQ-OKS-SMOKE');click('.oks-submit');
    await wait(()=>p.searchController.snapshot().phase==='results','RESTORE_SEARCH');
  }
})()
