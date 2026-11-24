code=(async()=>{
  const fail=(ok,code)=>{if(!ok)throw Error('OKS05C_HOST_'+code);};
  const p=app.plugins.plugins["oks-synthetic-evidence"];
  fail(!!p && !!p.standalone && p.standalone.status().status==='ready','STANDALONE_NOT_READY');
  fail(p.settings.version===5 && !p.settings.ingestion.enabled,'NOT_DEFAULT_OFF');
  fail(p.advancedIngestion.snapshot().status==='disabled','ADVANCED_STARTED_BY_DEFAULT');
  const python=process.env.OKS_05C_PYTHON;
  const snapshot=process.env.OKS_05C_TOKENIZER_SNAPSHOT;
  const tessdata=process.env.OKS_05C_TESSDATA;
  const entry=process.env.OKS_05C_ENTRY;
  fail([python,snapshot,tessdata,entry].every(x=>typeof x==='string'&&x.startsWith('/')),
    'EXPLICIT_LOCAL_ASSETS_NOT_CONFIGURED');
  await p.patchSettings(s=>{s.ingestion={
    enabled:true,interpreter:python,entry,
    tokenizerSnapshot:snapshot,tessdataPath:tessdata,artifactsPath:'',pdfMode:'text'
  };});
  const scenarios=[
    {path:'first.md',expect:'ok',pdfMode:'text',kind:'markdown'},
    {path:'policy.pdf',expect:'partial',pdfMode:'text',kind:'pdf'},
    {path:'policy.docx',expect:'partial',pdfMode:'text',kind:'docx'},
    {path:'scan.pdf',expect:'partial',pdfMode:'ocr',kind:'pdf'},
  ];
  const checks=[];
  for(const scenario of scenarios) {
    if(p.settings.ingestion.pdfMode!==scenario.pdfMode)
      await p.patchSettings(s=>{s.ingestion.pdfMode=scenario.pdfMode;});
    const item=app.vault.getAbstractFileByPath(scenario.path);
    fail(!!item && item.path===scenario.path,'NOT_AN_OBSIDIAN_TFILE_'+scenario.path);
    const r=await p.ingestAdvancedPath(scenario.path);
    fail(r.status===scenario.expect && r.source?.sourceType===scenario.kind,
      'FORMAT_'+scenario.path+'_'+r.status);
    fail(r.chunks.length>0 && r.source?.blocks.length>0 && !!r.generationId,
      'NO_CHUNKS_OR_GEN_'+scenario.path);
    fail(r.chunks.every(x=>x.sourceSha256===r.source.sha256 && x.originalText!==null &&
      x.contextualText!==null && x.sourceLocators.length===x.sourceSlices.length),
      'CONTEXT_AS_EVIDENCE_'+scenario.path);
    fail(r.source.blocks.every(x=>x.locator.sourceVersion===r.source.sha256 &&
      x.sourceSha256===r.source.sha256),
      'PROVENANCE_'+scenario.path);
    if(scenario.kind!=='markdown'){
      fail(r.source.blocks.every(x=>x.locator.byteStart===null && x.locator.byteEnd===null),
        'FABRICATED_BINARY_OFFSETS_'+scenario.path);
    }else{
      fail(r.source.blocks.some(x=>x.locator.locatorKind==='markdown' &&
        Number.isInteger(x.locator.byteStart)),'MARKDOWN_LOCATORS');
      fail(r.source.properties.every(x=>typeof x.valueType==='string'),'TYPED_PROPERTIES');
    }
    if(scenario.kind==='pdf'){
      fail(r.source.blocks.some(x=>x.locator.locations.some(l=>Number.isInteger(l.page) && l.page>=1)),
        'PDF_PAGE_LOCATORS_'+scenario.path);
    }
    if(scenario.kind==='docx'){
      fail(r.source.blocks.some(x=>x.kind==='table_row' && x.cells.length>0),
        'DOCX_TABLE_CELL_PROVENANCE');
    }
    if(scenario.path==='scan.pdf'){
      const text=r.source.blocks.map(x=>x.originalText).join(' ');
      fail(/[А-Яа-я]/.test(text)&&/[A-Za-z]/.test(text),'OCR_RU_EN_NOT_REAL');
    }
    const verified=await p.verifiedAdvancedResult(scenario.path);
    fail(verified?.generationId===r.generationId,'VERIFIED_EVIDENCE_FAIL_'+scenario.path);
    fail(p.advancedIngestion.snapshot().searchReady===false,'FALSE_RETRIEVAL_READY');
    checks.push(scenario.path+':'+r.status+':'+r.source.blocks.length);
  }
  const lexical=await p.api.request({apiVersion:1,operation:'search',
    request:{protocolVersion:2,requestId:'host05c',query:'REQ-OKS-SMOKE',
      requestedMode:'lexical',limit:5}});
  fail(lexical.ok && lexical.value.status==='ok'&&lexical.value.hits.length===1,
    'STANDALONE_DAMAGED');
  for(const mode of ['dense','hybrid']){
    const response=await p.api.request({apiVersion:1,operation:'search',
      request:{protocolVersion:2,requestId:'host05c-'+mode,query:'REQ-OKS-SMOKE',
        requestedMode:mode,limit:5}});
    fail(response.ok && response.value.status==='failed' &&
      response.value.executedMode==='none' && response.value.error==='CAPABILITY_UNAVAILABLE',
      'FALSE_MODEL_'+mode);
  }
  const file=app.vault.getAbstractFileByPath('first.md');
  const unchanged=await app.vault.read(file);
  await app.vault.modify(file,unchanged+'\n# Synthetic changed\n');
  fail(await p.verifiedAdvancedResult('first.md')===null,'STALE_EVIDENCE');
  const renamed=await p.verifiedAdvancedResult('policy.pdf');
  fail(renamed?.status==='partial','UNRELATED_SOURCE_DAMAGED');
  await app.vault.modify(file,unchanged);
  await p.standalone.whenIdle();
  await p.patchSettings(s=>{s.ingestion.enabled=false;});
  fail(p.advancedIngestion.snapshot().status==='disabled' &&
    !p.advancedIngestion.runner.busy,'DISABLE_PROCESS_TREE');
  fail(p.standalone.status().status==='ready','STANDALONE_AFTER_DISABLE');
  return 'OBSIDIAN_ADVANCED_INGESTION_PASS: '+checks.join(' ')+' source_stale=refused dense=unavailable hybrid=unavailable optin=manual disable=pass';
})()
