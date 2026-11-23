code=(async()=>{
  const fail=(ok,code)=>{if(!ok)throw Error('ADVANCED_HOST_'+code)};
  const p=app.plugins.plugins["oks-synthetic-evidence"];
  fail(!!p && !!p.standalone,'BASELINE_MISSING');
  const status=await p.api.request({apiVersion:1,operation:'status'});
  fail(status.ok && status.value.advancedTransport.status==='disabled','DEFAULT_NOT_DISABLED');
  fail(status.value.capabilityReadiness.dense==='unavailable' && status.value.capabilityReadiness.hybrid==='unavailable','FALSE_CAPABILITY');
  const python=process.env.OKS_ADVANCED_PYTHON,entry=process.env.OKS_ADVANCED_ENTRY;
  fail(typeof python==='string'&&typeof entry==='string','ENV_MISSING');
  await p.patchSettings(s=>{s.advanced={enabled:true,profile:'local-stdio',interpreter:python,entry};});
  const health=p.advancedHealth.snapshot(),pid=p.advancedHealth.pid;
  fail(health.status==='ready'&&health.transportOnly===true&&typeof pid==='number',
    'HEALTH_'+JSON.stringify({status:health.status,error:health.error,hasPid:typeof pid==='number'}));
  const request={protocolVersion:2,requestId:'advanced-host',query:'REQ-OKS-SMOKE',requestedMode:'lexical',limit:5};
  const lexical=await p.api.request({apiVersion:1,operation:'search',request});
  fail(lexical.ok && lexical.value.status==='ok' && lexical.value.hits.length===1,'STANDALONE_REGRESSION');
  const hybrid=await p.api.request({apiVersion:1,operation:'search',request:{...request,requestedMode:'hybrid'}});
  fail(hybrid.ok && hybrid.value.status==='failed'&&hybrid.value.executedMode==='none'&&hybrid.value.error==='CAPABILITY_UNAVAILABLE'&&hybrid.value.hits.length===0,'SILENT_HYBRID');
  const api=await p.api.request({apiVersion:1,operation:'status'});
  fail(api.ok&&api.value.advancedTransport.status==='ready'&&api.value.capabilityReadiness.dense==='unavailable','API_TRUTH');
  const safe=await p.api.request({apiVersion:1,operation:'diagnostics'});
  fail(safe.ok && !safe.value.includes(python) && !safe.value.includes(entry),'PATH_LEAK');
  await p.patchSettings(s=>{s.advanced.enabled=false;});
  fail(p.advancedHealth.snapshot().status==='disabled'&&!p.advancedHealth.pid,'DISABLE');
  fail(p.standalone.status().status==='ready','STANDALONE_AFTER_DISABLE');
  // Restore the original UI/command navigation invariant after the negative hybrid request.
  const restored=await p.api.request({apiVersion:1,operation:'search',request});
  fail(restored.ok&&restored.value.status==='ok'&&restored.value.hits.length===1,'NAVIGATION_RESTORED');
  return 'OBSIDIAN_ADVANCED_HEALTH_PASS: default=disabled optIn=local-stdio version=2 health=ready privacy=metadata-only dense=unavailable hybrid=unavailable disable=pass standalonePreserved=true';
})()
