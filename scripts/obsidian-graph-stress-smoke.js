// Evaluated by supported CLI ONLY in a disposable no-route Obsidian profile.
(async()=>{
  const p=app.plugins.plugins['oks-synthetic-evidence'];
  const assert=(ok,code)=>{if(!ok)throw new Error('GRAPH_STRESS_'+code);};
  const wait=async(predicate,code,ms=15000)=>{
    const end=Date.now()+ms;
    while(!predicate()){assert(Date.now()<end,code);await new Promise(r=>setTimeout(r,30));}
  };
  const tick=()=>new Promise(r=>setTimeout(r,300));
  assert(process.env.tmp&&app.vault.adapter.getBasePath()===process.env.tmp+'/vault','SYNTHETIC_ONLY');
  assert(p&&Object.values(p.settings.ai).every(x=>x.state==='disabled'),'AI_DISABLED');
  const fs=require('node:fs'),crypto=require('node:crypto');
  const hash=raw=>crypto.createHash('sha256').update(raw).digest('hex');
  const manifest=JSON.parse(fs.readFileSync(process.env.tmp+'/graph-manifest.json','utf8'));
  const raw=fs.readFileSync(process.env.tmp+'/graph-corpus.json');
  assert(hash(raw)===manifest.corpusSha256,'FROZEN_HASH');
  const corpus=JSON.parse(raw.toString('utf8')),names=Object.keys(corpus.files).sort();
  assert(names.length===512&&names.every(n=>/^(case-\d\d-[abc]|neg-[a-z-]+|stress-\d\d\d)\.md$/.test(n)
    &&hash(corpus.files[n])===manifest.sourceSha256[n]),'FROZEN_SOURCES');
  const settings=structuredClone(p.settings);
  const originals=await Promise.all(app.vault.getMarkdownFiles().map(async f=>[f.path,await app.vault.read(f)]));
  assert(originals.length===3&&originals.map(x=>x[0]).sort().join() === 'first.md,second.md,third.md','BASE_FIXTURES');
  const removeAll=async()=>{for(const file of app.vault.getMarkdownFiles())await app.vault.delete(file);};
  const ready=async count=>{
    await wait(()=>p.standalone?.status().status==='ready'&&p.standalone.status().sources===count,'READY_'+count,45000);
    await p.standalone.whenIdle();assert(p.standalone.status().status==='ready','INDEX_READY');
  };
  try{
    await p.updateSettings({...settings,enabled:false});await removeAll();
    for(const name of names)await app.vault.create(name,corpus.files[name]);
    await tick();
    assert(app.vault.getMarkdownFiles().length===512,'VAULT_COUNT');
    await p.updateSettings({...settings,enabled:true,paused:false,graph:{state:'configured',mapping:corpus.mapping}});
    await ready(512);await p.openSearch();
    const root=()=>app.workspace.getLeavesOfType('oks-standalone-search')[0]?.view.contentEl;
    const el=selector=>{const node=root()?.querySelector(selector);assert(node,'ELEMENT_'+selector);return node;};
    await wait(()=>!!root()?.querySelector('.oks-graph-panel')&&!el('.oks-graph-panel').hidden,'PANEL');
    const q=corpus.heldOut[0];
    const edit=(selector,value,event='input')=>{const node=el(selector);node.value=value;
      node.dispatchEvent(new node.ownerDocument.defaultView.Event(event,{bubbles:true}));};
    edit('.oks-query',q.query);edit('.oks-graph-depth','1','change');edit('.oks-graph-relation','depends','change');
    let last=performance.now();const delays=[];
    const timer=setInterval(()=>{const now=performance.now();delays.push(Math.max(0,now-last-10));last=now;},10);
    const t=performance.now();
    try{
      el('.oks-graph-submit').click();
      await wait(()=>el('.oks-graph-results').children.length===2,'COLD_GRAPH_UI',30000);
    }finally{clearInterval(timer);}
    const coldUiMs=performance.now()-t;
    delays.sort((a,b)=>a-b);assert(delays.length>=10,'EVENT_LOOP_SAMPLES');
    const uiEventLoopP95Ms=delays[Math.ceil(delays.length*.95)-1],uiEventLoopMaxMs=delays.at(-1);
    assert(el('.oks-graph-results').textContent.includes('depends: ID-00-B'),'UI_AUTHORED_ANCHOR');
    const request={requestId:q.id,query:q.query,limit:10,matchMode:'literal',scope:{mode:'selected',kind:'files',sourceIds:[q.seed]},
      expansion:q.expansion};
    const result=await p.api.request({apiVersion:1,operation:'graph-search',request});
    assert(result.ok&&result.value.candidates.length===1&&result.value.candidates[0].sourceId===q.seed,'SCOPED_CLI');
    await wait(()=>el('.oks-graph-results').children.length===0,'UI_RETIRE');
    assert(uiEventLoopP95Ms<=50,'UI_DELAY_'+uiEventLoopP95Ms);
    return 'OBSIDIAN_GRAPH_STRESS_PASS: '+JSON.stringify({sources:512,corpusSha256:manifest.corpusSha256,coldUiMs,
      uiEventLoopP95Ms,uiEventLoopMaxMs,samples:delays.length,scope:'selected-files',providerRequests:0});
  }finally{
    await p.updateSettings({...settings,enabled:false});await removeAll();
    for(const [path,source] of originals)await app.vault.create(path,source);
    await tick();await p.updateSettings(settings);await ready(3);await p.openSearch();
  }
})()
