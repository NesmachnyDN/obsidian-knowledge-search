// Actual packaged SearchView in a disposable Obsidian Vault; isolated protocol fixture.
(async()=>{
  const p=app.plugins.plugins['oks-synthetic-evidence'];
  const assert=(condition,code)=>{if(!condition)throw new Error('GENERATION_HOST_'+code);};
  const wait=async(fn,code)=>{const deadline=Date.now()+7000;while(!fn()){
    assert(Date.now()<deadline,code);await new Promise(r=>setTimeout(r,30));}};
  const old=p.settings;
  const operation=()=>p.searchController.evidenceOperationStatus('generation');
  const root=()=>app.workspace.getLeavesOfType('oks-standalone-search')[0]?.view.contentEl;
  const el=selector=>{const item=root()?.querySelector(selector);assert(item,'ELEMENT_'+selector);return item;};
  const click=selector=>el(selector).click();
  const set=(selector,value,event='input')=>{const input=el(selector);input.value=value;input.dispatchEvent(new Event(event,{bubbles:true}));};
  const query=async()=>{set('.oks-query','REQ-OKS-GENERATION');click('.oks-submit');
    await wait(()=>p.searchController.snapshot().phase==='results','SEARCH');};
  const confirm=token=>{
    click('.oks-generation-prepare');
    set('.oks-generation-token',token);const inputToken=el('.oks-generation-token');click('.oks-generation-bind');
    assert(inputToken.value===''&&!root().querySelector('.oks-generation-token'),'TOKEN_BOUND_AND_CLEARED');
    assert(operation().phase==='permission-required','SETTINGS_PERMISSION');
    assert(el('.oks-generation-confirm').disabled,'DEFAULT_DENY');
    assert(el('.oks-generation-query-preview').textContent==='REQ-OKS-GENERATION','QUERY_PREVIEW');
    assert(root().querySelectorAll('.oks-generation-excerpt-preview').length===2,'EXCERPT_PREVIEW');
    set('.oks-generation-classification','synthetic','change');
    assert(el('.oks-generation-confirm').disabled,'REQUIRE_EXPLICIT_CHECK');
    const check=el('.oks-generation-confirm-check');check.checked=true;check.dispatchEvent(new Event('change',{bubbles:true}));
    assert(!el('.oks-generation-confirm').disabled,'CONSENT');
    click('.oks-generation-confirm');
    assert(operation().phase==='busy','SETTINGS_BUSY');
    assert(!root().querySelector('.oks-generation-token'),'TOKEN_REMOVED');
  };
  const a=await app.vault.create('generation-a.md','REQ-OKS-GENERATION: alpha\n');
  const b=await app.vault.create('generation-b.md','REQ-OKS-GENERATION: beta\n');
  try {
    await new Promise(r=>setTimeout(r,250));await p.standalone.whenIdle();await p.openSearch();await query();
    click('.oks-generation-prepare');set('.oks-generation-token','fixture-success');click('.oks-generation-bind');assert(el('.oks-generation-message').textContent.includes('DISABLED'),'DISABLED');
    await p.updateSettings({...p.settings,ai:{...p.settings.ai,generation:{state:'configured',transport:'local',
      origin:'http://127.0.0.1:18765',identity:{model:'synthetic-generator',revision:'fixture-v1'},
      limits:{timeoutMs:3000,maxInputBytes:4096,maxCandidates:2,maxOutputTokens:128,maxConcurrent:1}}}});
    await query();
    const lexical=p.searchController.snapshot().response.hits;
    assert(lexical.length===2,'LEXICAL_CANDIDATES');
    // Observe expiration before the scheduled callback, then roll wall time back.
    click('.oks-generation-prepare');
    set('.oks-generation-token','fixture-success');const staleToken=el('.oks-generation-token');click('.oks-generation-bind');
    set('.oks-generation-classification','synthetic','change');
    const staleCheck=el('.oks-generation-confirm-check');staleCheck.checked=true;staleCheck.dispatchEvent(new Event('change',{bubbles:true}));
    const staleButton=el('.oks-generation-confirm');
    assert(!staleButton.disabled,'LATE_PREVIEW_ARMED');
    const originalNow=Date.now,wall=originalNow();
    try {
      Date.now=()=>wall+300001;
      assert(operation().error==='CANCELLED','POLL_EXPIRY');
      Date.now=()=>wall-1000;
      assert(operation().error==='CANCELLED','NO_REVIVAL');
    } finally {Date.now=originalNow;}
    await Promise.resolve();
    assert(!root().querySelector('.oks-generation-token')&&staleToken.value==='','POLL_EXPIRY_TOKEN_CLEARED');
    staleButton.click();
    assert(operation().error==='CANCELLED','DETACHED_CONFIRM_DENIED');
    assert(JSON.stringify(p.searchController.snapshot().response.hits)===JSON.stringify(lexical),'POLL_EXPIRY_LEXICAL_UNCHANGED');
    confirm('fixture-success');
    await wait(()=>p.searchController.snapshot().generation?.phase==='results','RESULTS');
    const result=p.searchController.snapshot();
    assert(operation().phase==='complete'&&operation().error===null,'SETTINGS_COMPLETE');
    assert(JSON.stringify(result.response.hits)===JSON.stringify(lexical),'LEXICAL_UNCHANGED');
    assert(JSON.stringify(result.generation.hits.map(x=>x.citations))===JSON.stringify([[lexical[0]],lexical]),'CITATIONS');
    assert(root().querySelectorAll('.oks-generation-results li').length===2,'RENDERED');
    assert(root().querySelector('.oks-generation-kind').textContent==='Verified literal quotation','QUOTE_LABEL');
    assert(root().querySelectorAll('.oks-generation-kind')[1].textContent==='Unverified model inference','INFERENCE_LABEL');
    assert(!root().querySelector('.oks-generation-results img'),'TEXT_ONLY');
    assert(root().querySelectorAll('.oks-generation-open').length===3,'CITATION_BUTTONS');
    confirm('fixture-bad-citation');await wait(()=>p.searchController.snapshot().generation?.phase==='error','CITATION_ERROR');
    assert(p.searchController.snapshot().generation.error==='INVALID_RESPONSE','BAD_CITATION');
    assert(!root().querySelectorAll('.oks-generation-results li').length,'NO_INVALID_CLAIMS');
    confirm('fixture-deny');await wait(()=>p.searchController.snapshot().generation?.phase==='error','AUTH_ERROR');
    assert(p.searchController.snapshot().generation.error==='UNAUTHENTICATED','TYPED_ERROR');
    assert(operation().phase==='failed'&&operation().error==='UNAUTHENTICATED','SETTINGS_ERROR');
    assert(root().querySelectorAll('.oks-results li').length===2&&!root().querySelectorAll('.oks-generation-results li').length,'NO_FALLBACK');
    confirm('fixture-delay');click('.oks-generation-cancel');await wait(()=>p.searchController.snapshot().generation?.error==='CANCELLED','CANCEL');
    await new Promise(r=>setTimeout(r,1400));
    assert(p.searchController.snapshot().generation?.error==='CANCELLED','NO_LATE_RESULT');
    confirm('fixture-delay');await app.vault.modify(a,'REQ-OKS-GENERATION: changed\n');
    await wait(()=>!p.searchController.snapshot().response,'MUTATION_INVALIDATES');
    await new Promise(r=>setTimeout(r,1400));assert(!p.searchController.snapshot().generation,'STALE_SUPPRESSED');
    assert(!JSON.stringify(p.settings).includes('fixture-success'),'TOKEN_NOT_PERSISTED');
    return 'OBSIDIAN_GENERATION_FIXTURE_PASS: explicit consent local HTTP literal quotes unverified inferences verified citations auth cancel stale suppression lexical independence; mock only';
  } finally {
    await app.vault.delete(a);await app.vault.delete(b);await p.updateSettings(old);
    await new Promise(r=>setTimeout(r,250));await p.standalone.whenIdle();await p.openSearch();
    set('.oks-query','REQ-OKS-SMOKE');click('.oks-submit');
    await wait(()=>p.searchController.snapshot().phase==='results','RESTORE_SEARCH');
  }
})()
