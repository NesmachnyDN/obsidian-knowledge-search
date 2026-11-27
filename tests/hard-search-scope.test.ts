import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureHardSearchScope,defaultHardSearchScope,HARD_SEARCH_SCOPE_VERSION} from '../plugin/src/standalone/hard-search-scope';
import {BoundedVaultReader} from '../plugin/src/standalone/source';
import {StandaloneEngine} from '../plugin/src/standalone/engine';
import {GenerationStore} from '../plugin/src/standalone/storage';
import {parseMarkdown} from '../plugin/src/standalone/markdown';
import {PROTOCOL} from '../plugin/src/standalone/contracts';
const config=(excludedFolders:string[]=[],excludedFiles:string[]=[])=>({version:HARD_SEARCH_SCOPE_VERSION,excludedFolders,excludedFiles});

test('hard scope exact rooted folder and file rules are immutable, order independent and format neutral',()=>{
  const raw=config(['nested/control','private'],['public/report.pdf','one.md']);
  const scope=captureHardSearchScope(raw),reversed=captureHardSearchScope(config([...raw.excludedFolders].reverse(),[...raw.excludedFiles].reverse()));
  assert.equal(scope.revision,reversed.revision);raw.excludedFolders.length=0;raw.excludedFiles.length=0;
  for(const path of ['private','private/note.md','nested/control/file.docx','public/report.pdf','one.md'])assert.equal(scope.allows(path),false,path);
  for(const path of ['private-old/note.md','not/private/note.md','nested/control-old/note.md','public/report2.pdf','other/one.md','root.md','русский/заметка.md'])assert.equal(scope.allows(path),true,path);
  const literal=captureHardSearchScope(config(['a*'],['q?.md']));
  assert.equal(literal.allows('a*/x.md'),false);assert.equal(literal.allows('abc/x.md'),true);
  assert.equal(literal.allows('q?.md'),false);assert.equal(literal.allows('qa.md'),true);
  const long='a'.repeat(1021)+'.md';assert.equal(scope.allows(long),true);
  assert.equal(captureHardSearchScope(config([], [long])).allows(long),false);
  assert.equal(scope.hasExclusions,true);assert.ok(Object.isFrozen(scope));assert.equal(captureHardSearchScope(defaultHardSearchScope()).hasExclusions,false);
});
test('hard scope rejects malformed, absolute, traversal, ambiguous and oversized configurations',()=>{
  for(const path of ['', '/absolute','../escape','x/../y','x//y','x/','x\\y','x:y','.hidden','x\nname','x\0name','\ud800','a'.repeat(1025)]){
    assert.throws(()=>captureHardSearchScope(config([path])),/SEARCH_SCOPE_INVALID/);
    assert.equal(captureHardSearchScope(defaultHardSearchScope()).allows(path),false);
  }
  for(const bad of [null,{},config(['same','same']),config(Array.from({length:65},(_,i)=>'p'+i)),{...config(),extra:true},{...config(),excludedFiles:[null]}])assert.throws(()=>captureHardSearchScope(bad),/SEARCH_SCOPE_INVALID/);
});
test('scoped standalone reader excludes direct source proofs, hints and enumeration without widening historical inventory',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'oks-hard-scope-')),root=await realpath(directory);
  try{
    const paths=['control/private.md','control-old/visible.md','blocked.md','visible.md'];
    for(const folder of ['control','control-old'])await mkdir(join(root,folder));
    for(const path of paths)await writeFile(join(root,path),'# synthetic '+path);
    const invalid=await BoundedVaultReader.open(root,()=>[...paths,'bad\nname.md'],config(['control']));
    await assert.rejects(invalid.list(),/SOURCE_REJECTED/);
    const scoped=await BoundedVaultReader.open(root,()=>paths,config(['control'],['blocked.md']));
    assert.deepEqual(await scoped.list(),['control-old/visible.md','visible.md']);
    for(const path of ['control/private.md','blocked.md']){
      await assert.rejects(scoped.read(path),/SEARCH_SCOPE_RESTRICTED/);
      await assert.rejects(scoped.readVersionProof(path),/SEARCH_SCOPE_RESTRICTED/);
      await assert.rejects(scoped.readLifecycleProof(path),/SEARCH_SCOPE_RESTRICTED/);
      await assert.rejects(scoped.versionHints([path]),/SEARCH_SCOPE_RESTRICTED/);
    }
    await assert.rejects(scoped.completeMarkdownInventory(),/SEARCH_SCOPE_RESTRICTED/);
    assert.equal(Buffer.from(await scoped.read('control-old/visible.md')).toString(),'# synthetic control-old/visible.md');
    const unscoped=await BoundedVaultReader.open(root,()=>paths);
    assert.deepEqual(await unscoped.list(),[...paths].sort());
    assert.equal((await unscoped.completeMarkdownInventory()).sources.length,4);
    assert.equal((await unscoped.readVersionProof('blocked.md')).sourceId,'blocked.md');
    const empty=await BoundedVaultReader.open(root,()=>paths,defaultHardSearchScope());
    assert.deepEqual(await empty.list(),await unscoped.list());
    assert.equal((await empty.completeMarkdownInventory()).sources.length,4);
  }finally{await rm(directory,{recursive:true,force:true});}
});


for(const recovered of [false,true])test('restricted engine never exposes incompatible '+(recovered?'rollback':'CURRENT')+' before scoped publication',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'oks-scope-recovery-')),root=await realpath(directory);
  const paths=['control/private.md','control-old/visible.md','blocked.md'];
  const storeDir=join(root,'.obsidian/plugins/oks-synthetic-evidence/index');
  const parser=()=>({parse:async(path:string,bytes:Uint8Array,rootId:string)=>parseMarkdown(path,bytes,rootId),close:async()=>{}});
  const request={protocolVersion:PROTOCOL,requestId:'synthetic-scope',query:'unique',requestedMode:'lexical',limit:10} as const;
  const signal=new AbortController().signal;
  let engine:StandaloneEngine|undefined;
  let unblock:(()=>void)|undefined;
  try{
    for(const folder of ['control','control-old'])await mkdir(join(root,folder));
    for(const path of paths)await writeFile(join(root,path),'# unique '+path);
    const unscoped=await BoundedVaultReader.open(root,()=>paths);
    engine=new StandaloneEngine(unscoped,await GenerationStore.open(storeDir,unscoped.rootId),parser());
    await engine.start();await engine.whenIdle();
    assert.equal((await engine.search(request)).hits.length,3);
    const first=engine.status().generationId;
    // Create a durable authenticated predecessor with excluded documents.
    await writeFile(join(root,'control/private.md'),'# unique updated');
    engine.reconcile();await engine.whenIdle();
    assert.notEqual(engine.status().generationId,first);
    await engine.close();engine=undefined;
    if(recovered)await writeFile(join(storeDir,'CURRENT'),'{broken-pointer');

    const scoped=await BoundedVaultReader.open(root,()=>paths,config(['control'],['blocked.md']));
    let entered!:()=>void;
    const gateEntered=new Promise<void>(resolve=>{entered=resolve;});
    const gate=new Promise<void>(resolve=>{unblock=resolve;});
    engine=new StandaloneEngine(scoped,await GenerationStore.open(storeDir,scoped.rootId),parser(),async()=>{entered();await gate;});
    engine.configureGraph({schemaVersion:'oks-06b-mapping-v1',rules:[]});
    await engine.start();
    await gateEntered;
    assert.equal(engine.status().status,'initializing');
    assert.equal(engine.status().generationId,null);
    assert.equal(engine.status().sources,0);
    assert.equal(engine.status().records,0);
    const during=await engine.search(request);
    assert.equal(during.status,'failed');
    assert.equal(during.indexGenerationId,null);
    assert.deepEqual(during.hits,[]);
    await assert.rejects(engine.captureDenseCorpus(['control/private.md'],10,signal),/SOURCE_STALE/);
    await assert.rejects(engine.captureChatScope({mode:'vault-wide'},signal),/SCOPE_CHANGED/);
    assert.throws(()=>engine!.captureGraphScope({mode:'vault-wide'},signal),/GRAPH_UNAVAILABLE/);
    assert.equal(engine.cancel(),true);
    unblock!();unblock=undefined;
    await engine.whenIdle();
    assert.equal(engine.status().generationId,null);
    assert.deepEqual((await engine.search(request)).hits,[]);
    await engine.close();engine=undefined;

    // A canceled transition may leave the old pointer on disk. A fresh scoped
    // owner must apply the same admission fence before accepting a generation.
    engine=new StandaloneEngine(scoped,await GenerationStore.open(storeDir,scoped.rootId),parser());
    await engine.start();
    assert.equal(engine.status().generationId,null);
    await engine.whenIdle();
    assert.equal(engine.status().status,'ready');
    assert.equal(engine.status().sources,1);
    const allowed=await engine.search(request);
    assert.equal(allowed.status,'ok');
    assert.deepEqual(allowed.hits.map(hit=>hit.sourceId),['control-old/visible.md']);
    assert.deepEqual((await engine.search({...request,scope:['control/private.md']})).hits,[]);
    await assert.rejects(engine.captureDenseCorpus(['blocked.md'],10,signal),/INVALID_REQUEST/);
    await assert.rejects(engine.captureChatScope({mode:'selected',kind:'active-note',sourceId:'control/private.md'},signal),/SCOPE_CHANGED/);
    const lease=await engine.captureChatScope({mode:'vault-wide'},signal);
    assert.deepEqual(lease.snapshot.sources.map(source=>source.sourceId),['control-old/visible.md']);
    await engine.close();engine=undefined;
    // A new scoped CURRENT is safe to restore. Its old rollback is not.
    engine=new StandaloneEngine(scoped,await GenerationStore.open(storeDir,scoped.rootId),parser());
    await engine.start();await engine.whenIdle();
    assert.equal(engine.status().sources,1);
    assert.deepEqual((await engine.search(request)).hits.map(hit=>hit.sourceId),['control-old/visible.md']);
    await engine.close();engine=undefined;
    // Damage the newly scoped CURRENT: an authenticated wider rollback must
    // still not become visible. Exercise the actual persisted recovery path.
    await writeFile(join(storeDir,'CURRENT'),'{broken-scoped-pointer');
    const recoveredStore=await GenerationStore.open(storeDir,scoped.rootId);
    const rollback=await recoveredStore.load();
    assert.equal(rollback.recovered,true);
    assert.ok(rollback.generation?.documents.some(doc=>doc.sourceId==='blocked.md'));
    let enteredAgain!:()=>void;
    const secondEntered=new Promise<void>(resolve=>{enteredAgain=resolve;});
    const secondGate=new Promise<void>(resolve=>{unblock=resolve;});
    engine=new StandaloneEngine(scoped,await GenerationStore.open(storeDir,scoped.rootId),parser(),async()=>{enteredAgain();await secondGate;});
    await engine.start();await secondEntered;
    assert.equal(engine.status().generationId,null);
    assert.deepEqual((await engine.search(request)).hits,[]);
    unblock!();unblock=undefined;
    await engine.whenIdle();
    assert.equal(engine.status().sources,1);
    assert.deepEqual((await engine.search(request)).hits.map(hit=>hit.sourceId),['control-old/visible.md']);
  }finally{unblock?.();await engine?.close();await rm(directory,{recursive:true,force:true});}
});


test('restricted engine denies a candidate with an excluded source ID even before store publication',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'oks-scope-candidate-')),root=await realpath(directory);
  let engine:StandaloneEngine|undefined;
  try{
    await writeFile(join(root,'visible.md'),'# unique visible');
    const scoped=await BoundedVaultReader.open(root,()=>['visible.md'],config([],['blocked.md']));
    const store=await GenerationStore.open(join(root,'.obsidian/plugins/oks-synthetic-evidence/index'),scoped.rootId);
    engine=new StandaloneEngine(scoped,store,{parse:async(_path,bytes,rootId)=>parseMarkdown('blocked.md',bytes,rootId),close:async()=>{}});
    await engine.start();await engine.whenIdle();
    assert.equal(engine.status().generationId,null);
    assert.equal(engine.status().error,'SEARCH_SCOPE_RESTRICTED');
    assert.equal((await store.load()).generation,null);
  }finally{await engine?.close();await rm(directory,{recursive:true,force:true});}
});
