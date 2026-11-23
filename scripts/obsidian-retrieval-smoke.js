code=(async()=>{
  // All source documents are disposable synthetic files prepared by the host harness.
  const fail=(ok,code)=>{if(!ok)throw Error('OKS05D_HOST_'+code);};
  const p=app.plugins.plugins['oks-synthetic-evidence'];
  fail(!!p?.advancedRetrieval&&p.standalone?.status().status==='ready','PLUGIN_NOT_READY');
  fail(p.settings.ingestion.enabled===false,'NOT_DEFAULT_OFF');
  fail(p.advancedRetrieval.snapshot().dense==='unavailable','FALSE_INITIAL_DENSE');
  const python=process.env.OKS_05C_PYTHON;
  const snapshot=process.env.OKS_05C_TOKENIZER_SNAPSHOT;
  const tessdata=process.env.OKS_05C_TESSDATA;
  const entry=process.env.OKS_05C_ENTRY;
  fail([python,snapshot,tessdata,entry].every(x=>typeof x==='string'&&x.startsWith('/')),
    'LOCAL_ARTIFACTS_MISSING');
  await p.patchSettings(s=>{s.ingestion={
    enabled:true,interpreter:python,entry,tokenizerSnapshot:snapshot,
    tessdataPath:tessdata,artifactsPath:'',pdfMode:'text'
  };});
  const paths=['first.md','policy.pdf','policy.docx','scan.pdf'];
  const shapes=[];
  for(const path of paths){
    if(path==='scan.pdf')await p.patchSettings(s=>{s.ingestion.pdfMode='ocr';});
    const file=app.vault.getAbstractFileByPath(path);
    fail(!!file&&file.path===path,'NOT_TFILE_'+path);
    const ingested=await p.ingestAdvancedPath(path);
    fail(!!ingested.source&&ingested.chunks.length>0
      &&(ingested.status==='ok'||ingested.status==='partial'),'INGEST_'+path);
    await p.indexAdvancedPath(path);
    fail(p.advancedRetrieval.snapshot().indexedSources===shapes.length+1,'INDEX_'+path);
    shapes.push([path,ingested.status,ingested.chunks.length]);
  }
  const before=p.advancedRetrieval.snapshot();
  fail(before.indexedSources===paths.length&&before.indexedChunks>=paths.length,'INDEX_NOT_PUBLISHED');
  const lexical=await p.searchAdvanced({query:'REQ-OKS-SMOKE',requestedMode:'lexical',limit:5});
  fail(lexical.status==='ok'&&lexical.executedMode==='lexical'
    &&lexical.hits.some(h=>h.sourceId==='first.md'),'LEXICAL_FAILED');
  const dense=await p.searchAdvanced({query:'local evidence storage',requestedMode:'dense',limit:5});
  fail(dense.status==='ok'&&dense.executedMode==='dense'&&dense.legs.dense.status==='ready'
    &&dense.hits.length>0&&dense.hits.every(h=>h.denseSimilarity!==null),'DENSE_NOT_MODEL_BACKED');
  const hybrid=await p.searchAdvanced({query:'REQ-OKS-SMOKE',requestedMode:'hybrid',limit:5});
  fail(hybrid.status==='ok'&&hybrid.executedMode==='hybrid'
    &&hybrid.legs.lexical.status==='ready'&&hybrid.legs.dense.status==='ready'
    &&hybrid.hits.some(h=>h.lexicalRank!==null&&h.denseRank!==null&&h.rrfScore>0),'HYBRID_FAILED');
  fail(hybrid.hits.every(h=>h.sourceLocators.length>0&&h.originalExcerpt&&h.sourceSha256
    &&h.indexGenerationId===hybrid.indexGenerationId),'FABRICATED_EVIDENCE');
  const hit=hybrid.hits.find(h=>h.sourceId==='first.md');
  fail(!!hit,'MISSING_MARKDOWN_HIT');
  await p.openAdvancedHit(hit);
  const selected=app.workspace.getMostRecentLeaf()?.view?.editor?.getSelection();
  fail(typeof selected==='string'&&selected.includes('REQ-OKS-SMOKE'),'SOURCE_NAVIGATION');
  const latest=app.vault.getAbstractFileByPath('first.md');
  const old=await app.vault.read(latest);
  await app.vault.modify(latest,old+'\n# Source changed\n');
  await p.standalone.whenIdle();
  const stale=await p.searchAdvanced({query:'REQ-OKS-SMOKE',requestedMode:'hybrid',limit:5});
  // Source events revoke the changed source immediately. Verified unaffected
  // documents may remain searchable, possibly with a degraded status; that is
  // not a stale hit and must not be mistaken for a hybrid fallback.
  fail(stale.hits.every(h=>h.sourceId!=='first.md')
    &&(stale.status==='failed'&&stale.executedMode==='none'&&stale.hits.length===0
      ||['ok','degraded'].includes(stale.status)&&stale.executedMode==='hybrid'
        &&stale.legs.lexical.status==='ready'&&stale.legs.dense.status==='ready'),
    'STALE_SOURCE_VISIBLE_'+JSON.stringify({status:stale.status,error:stale.error,
      mode:stale.executedMode,paths:stale.hits.map(h=>h.sourceId)}));
  await p.patchSettings(s=>{s.ingestion.enabled=false;});
  fail(p.standalone.status().status==='ready'&&p.advancedRetrieval.snapshot().status==='disabled'
    &&p.advancedIngestion.snapshot().status==='disabled','DISABLE_REGRESSION');
  return 'OBSIDIAN_ADVANCED_RETRIEVAL_PASS: '+JSON.stringify({shapes,
    indexed:before.indexedSources,vectorHits:dense.hits.length,rrfHits:hybrid.hits.length,
    modelReady:hybrid.legs.dense.status,stale:'rejected',navigation:'verified',
    noRoute:true,standalone:'ready',disabled:true});
})()
