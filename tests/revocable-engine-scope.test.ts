import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hash} from 'node:crypto';
import {configDigest} from '../plugin/src/ai/disclosure';
import type {ProviderConfig} from '../plugin/src/ai/contracts';
import type {PolicySnapshot} from '../plugin/src/ai/processing-policy';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BoundedVaultReader} from '../plugin/src/standalone/source';
import {StandaloneEngine} from '../plugin/src/standalone/engine';
import {GenerationStore} from '../plugin/src/standalone/storage';
import {parseMarkdown} from '../plugin/src/standalone/markdown';
import {parsePolicyMetadata} from '../plugin/src/standalone/markdown-parse';
import {hash,PROTOCOL,StandaloneError} from '../plugin/src/standalone/contracts';
import {captureNativeExclusions} from '../plugin/src/search/native-exclusions';
import {authenticateGraphCatalog} from '../plugin/src/standalone/graph-lifecycle';
import {materializeGraph} from '../plugin/src/standalone/graph-retrieval';
import {deriveGraphProjection} from '../plugin/src/standalone/graph-projection';
import {parseGraphQuery} from '../plugin/src/standalone/graph-expansion';
import {validateGraphMapping} from '../plugin/src/standalone/graph-mapping';
import type {RevocableHardSearchScope} from '../plugin/src/standalone/hard-search-scope';

const request={protocolVersion:PROTOCOL,requestId:'synthetic-scope',query:'unique',requestedMode:'lexical',limit:10} as const;
async function fixture(files:Record<string,string>={'one.md':'# unique one.md','two.md':'# unique two.md'}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'oks-engine-scope-')));
  const paths=Object.keys(files).sort();
  for(const path of paths)await writeFile(join(root,path),files[path]!);
  let raw: string[]|null=null;
  const callbacks=new Set<()=>void>();
  const metadata={userIgnoreFilters:null as object[]|null,isUserIgnored:(path:string)=>raw?.includes(path)??false};
  const vault={getConfig:()=>raw,on:(_event:string,callback:()=>void)=>{callbacks.add(callback);return callback;},offref:(ref:unknown)=>{callbacks.delete(ref as ()=>void);}};
  const capture=()=>captureNativeExclusions({vault,metadataCache:metadata},{version:'1.15.1',desktop:true,linux:true},()=>{});
  const change=(next:string[]|null,emit=true)=>{raw=next;metadata.userIgnoreFilters=raw?.map(()=>({}))??null;if(emit)for(const cb of [...callbacks])cb();};
  const storePath=join(root,'.obsidian/plugins/oks-synthetic-evidence/index');
  const engines:StandaloneEngine[]=[],leases:ReturnType<typeof capture>[]=[];
  const open=async()=>{
    const lease=capture();leases.push(lease);
    const reader=await BoundedVaultReader.openWithScope(root,()=>paths,lease.scope);
    const store=await GenerationStore.open(storePath,reader.rootId);
    let parses=0,previews=0;let onParse=()=>{},onPreview=()=>{};
    const parser={parse:async(path:string,bytes:Uint8Array,id:string)=>{parses++;onParse();return parseMarkdown(path,bytes,id);},
      policyMetadata:async(path:string,bytes:Uint8Array,id:string)=>{previews++;onPreview();return parsePolicyMetadata(path,bytes,id,hash(bytes));},close:async()=>{}};
    const engine=new StandaloneEngine(reader,store,parser);
    engines.push(engine);
    return {engine,reader,store,parses:()=>parses,onParse:(cb:()=>void)=>{onParse=cb;},previews:()=>previews,onPreview:(cb:()=>void)=>{onPreview=cb;}};
  };
  return {open,change,write:(path:string,text:string)=>writeFile(join(root,path),text),cleanup:async()=>{for(const e of engines)await e.close();for(const l of leases)l.dispose();await rm(root,{recursive:true,force:true});}};
}
async function denied(engine:StandaloneEngine){
  assert.equal(engine.status().generationId,null);
  assert.equal(engine.status().sources,0);
  assert.equal(engine.status().records,0);
  assert.equal(engine.status().error,'SEARCH_SCOPE_INVALID');
  for(const query of ['unique','nonexistent']){
    const response=await engine.search({...request,query});
    assert.equal(response.status,'failed');assert.equal(response.error,'SEARCH_SCOPE_INVALID');
    assert.equal(response.indexGenerationId,null);assert.deepEqual(response.hits,[]);
  }
}

test('empty native scope retirement fences already captured engine leases and stays retired after settings revert',async()=>{
  const f=await fixture();try{
    const {engine}=await f.open();await engine.start();await engine.whenIdle();
    assert.equal((await engine.search(request)).hits.length,2);
    const signal=new AbortController().signal;
    const dense=await engine.captureDenseCorpus(['one.md'],10,signal);
    const chat=await engine.captureChatScope({mode:'vault-wide'},signal);
    engine.configureGraph({schemaVersion:'oks-06b-mapping-v1',rules:[]});
    const graph=engine.captureGraphScope({mode:'vault-wide'},signal);
    assert.ok(dense.current()&&chat.current()&&graph.current());
    f.change(['one.md'],false);
    assert.equal(dense.current(),false);assert.equal(chat.current(),false);assert.equal(graph.current(),false);
    await denied(engine);f.change(null);engine.rebuild();await engine.whenIdle();await denied(engine);
    await assert.rejects(chat.verify(),/SCOPE_CHANGED/);
    await assert.rejects(dense.verify(dense.evidence[0]!),/SOURCE_STALE/);
  }finally{await f.cleanup();}
});

test('revocation during authenticated store load does not admit restored generation',async()=>{
  const f=await fixture();try{
    const first=await f.open();await first.engine.start();await first.engine.whenIdle();await first.engine.close();
    const {engine,store}=await f.open();const load=store.load.bind(store);
    store.load=async()=>{const result=await load();assert.ok(result.generation);f.change(['one.md']);return result;};
    await assert.rejects(engine.start(),/SEARCH_SCOPE_INVALID/);await denied(engine);
  }finally{await f.cleanup();}
});

for(const stage of ['read','parse','before-rename','after-rename','after-commit'] as const)test('revocation during '+stage+' cannot admit or publish old engine evidence',async()=>{
  const f=await fixture();try{
    const {engine,reader,store,parses,onParse}=await f.open();
    const retire=()=>f.change(['one.md']);
    const observations:(string|null)[]=[];
    if(stage==='read'){
      const read=reader.read.bind(reader);reader.read=async path=>{const bytes=await read(path);retire();return bytes;};
    }else if(stage==='parse')onParse(retire);
    else{
      const commit=store.commit.bind(store);
      store.commit=async(gen,begin,published)=>{
        const outcome=await commit(gen,()=>{if(stage==='before-rename')retire();begin?.();},actual=>{
          if(stage==='after-rename')retire();published?.(actual);
          if(stage==='after-rename')observations.push(engine.status().generationId);
        });
        if(stage==='after-commit')retire();return outcome;
      };
    }
    await engine.start();await engine.whenIdle();await denied(engine);
    assert.equal(parses(),stage==='read'?0:stage==='parse'?1:2);
    if(stage==='after-rename')assert.deepEqual(observations,[null]);
    const recovered=await store.load();
    if(stage==='after-rename'||stage==='after-commit')assert.ok(recovered.generation);
    else assert.equal(recovered.generation,null);
    await engine.close();
    const fresh=await f.open();await fresh.engine.start();await fresh.engine.whenIdle();
    assert.deepEqual((await fresh.engine.search(request)).hits.map(hit=>hit.sourceId),['two.md']);
  }finally{await f.cleanup();}
});

test('revocation after last candidate read denies cached hits and an in-flight zero-hit query',async()=>{
  const f=await fixture();try{
    const {engine,reader}=await f.open();await engine.start();await engine.whenIdle();
    const read=reader.read.bind(reader);reader.read=async path=>{const bytes=await read(path);f.change(['one.md']);return bytes;};
    const result=await engine.search(request);assert.equal(result.error,'SEARCH_SCOPE_INVALID');assert.deepEqual(result.hits,[]);await denied(engine);
    f.change(null);await engine.close();
    const fresh=await f.open();await fresh.engine.start();await fresh.engine.whenIdle();
    const hints=fresh.reader.versionHints.bind(fresh.reader);fresh.reader.versionHints=async paths=>{const value=await hints(paths);f.change(['two.md']);return value;};
    const empty=await fresh.engine.search({...request,query:'nonexistent'});assert.equal(empty.error,'SEARCH_SCOPE_INVALID');assert.equal(empty.indexGenerationId,null);await denied(fresh.engine);
  }finally{await f.cleanup();}
});

for(const stage of ['read','parser'] as const)test('revoked policy preview cannot return proof or continue physical reads after '+stage,async()=>{
  const f=await fixture();try{
    const {engine,reader,previews,onPreview}=await f.open();await engine.start();await engine.whenIdle();
    const original=reader.read.bind(reader);let reads=0;
    reader.read=async path=>{reads++;const bytes=await original(path);if(stage==='read')f.change(['one.md']);return bytes;};
    if(stage==='parser')onPreview(()=>f.change(['one.md']));
    await assert.rejects(engine.previewPolicyMetadata('one.md',()=>true),/SOURCE_CHANGED/);
    await engine.whenIdle();assert.equal(reads,1);assert.equal(previews(),stage==='read'?0:1);
    await assert.rejects(engine.previewPolicyMetadata('two.md',()=>true),/SEARCH_SCOPE_INVALID/);
    await denied(engine);
  }finally{await f.cleanup();}
});

test('exceptional recovery settlement still reports scope retirement and never schedules parser work',async()=>{
  const f=await fixture();try{
    const {engine,store,parses}=await f.open();store.load=async()=>{f.change(['one.md']);throw Error('synthetic I/O failure');};
    await assert.rejects(engine.start(),/SEARCH_SCOPE_INVALID/);await engine.whenIdle();assert.equal(parses(),0);await denied(engine);
  }finally{await f.cleanup();}
});

for(const stage of ['initial-read','candidate-read','final-list','final-read'] as const)
test('selected range stops reader dispatch and suppresses evidence on revocation at '+stage,async()=>{
  const f=await fixture();try{
    const {engine,reader,parses}=await f.open();await engine.start();await engine.whenIdle();
    const raw='# unique one.md';
    const range={sourceId:'one.md',sourceSha256:hash(raw),byteStart:0,byteEnd:raw.length,charStart:0,charEnd:raw.length};
    const selected={...request,scope:['one.md'],range};
    assert.equal((await engine.search(selected)).hits.length,1);
    let lists=0,reads=0,late=0,retired=false;
    const before=parses(),list=reader.list.bind(reader),read=reader.read.bind(reader);
    const retire=()=>{retired=true;f.change(['one.md']);};
    reader.list=async()=>{if(retired)late++;const value=await list();if(++lists===2&&stage==='final-list')retire();return value;};
    reader.read=async path=>{
      if(retired)late++;
      const bytes=await read(path);reads++;
      if((stage==='initial-read'&&reads===1)||(stage==='candidate-read'&&reads===2)||(stage==='final-read'&&reads===2))retire();
      return bytes;
    };
    const response=await engine.search({...selected,query:stage.startsWith('final-')?'nonexistent':'unique'});
    assert.equal(retired,true);assert.equal(response.status,'failed');
    assert.equal(response.error,'SEARCH_SCOPE_INVALID');assert.equal(response.indexGenerationId,null);
    assert.deepEqual(response.hits,[]);assert.equal(late,0,'post-revocation reader dispatch');
    assert.equal(reads,stage==='initial-read'||stage==='final-list'?1:2);
    assert.equal(parses(),before);await denied(engine);
  }finally{await f.cleanup();}
});


for(const stage of ['initial-membership','final-membership'] as const)
test('graph catalog does not dispatch hints after membership revocation at '+stage,async()=>{
  const f=await fixture();try{
    const {engine,reader,store}=await f.open();await engine.start();await engine.whenIdle();
    const {generation}=await store.load();assert.ok(generation);
    const scope=reader.hardSearchScope as RevocableHardSearchScope;
    const list=reader.list.bind(reader),hints=reader.versionHints.bind(reader);
    let lists=0,hintCalls=0,late=0,arm=false,retired=false;
    reader.list=async()=>{const value=await list();if(++lists===(stage==='initial-membership'?1:2))arm=true;return value;};
    reader.versionHints=async paths=>{hintCalls++;if(retired)late++;return hints(paths);};
    const check=()=>{
      if(!scope.current())throw new StandaloneError('SEARCH_SCOPE_INVALID');
      if(arm){arm=false;queueMicrotask(()=>{retired=true;f.change(['one.md']);});}
    };
    const parser={parse:async()=>{throw Error('UNEXPECTED_REPARSE');},close:async()=>{}};
    await assert.rejects(authenticateGraphCatalog(generation,reader,parser,false,check,async()=>{}),/SEARCH_SCOPE_INVALID/);
    assert.equal(retired,true);assert.equal(late,0,'post-revocation hints dispatch');
    assert.equal(hintCalls,stage==='initial-membership'?0:1);await denied(engine);
  }finally{await f.cleanup();}
});

/** Observe the exact returned byte object; don't count unrelated authority hashes. */
for(const stage of ['generation','dense','preview-renewal','preview-proof-initial','preview-proof-renewal',
  'policy-proof-initial','policy-proof-renewal','dense-exception','preview-exception','policy-exception'] as const)
test('revoked settlement discards bytes before processing: '+stage,async t=>{
  const f=await fixture();try{
    const {engine,reader,store,parses,previews}=await f.open();
    if(stage!=='generation'){await engine.start();await engine.whenIdle();}
    const dense=stage.startsWith('dense')?await engine.captureDenseCorpus(['one.md'],10,new AbortController().signal):null;
    const beforeParses=parses(),beforePreviews=previews();
    const proof=stage.includes('proof')||stage==='policy-exception',exception=stage.endsWith('exception');
    const target=stage==='generation'?3:stage.includes('renewal')?2:1;
    let watched:Uint8Array|undefined,revoked=false,reads=0,late=0,byteHashes=0;
    const originalUpdate=Hash.prototype.update;
    t.mock.method(Hash.prototype,'update',function(this:Hash,...args:unknown[]){
      if(revoked&&args[0]===watched)byteHashes++;
      return Reflect.apply(originalUpdate,this,args);
    });
    const read=reader.read.bind(reader),verified=reader.readVerifiedOriginal.bind(reader);
    const list=reader.list.bind(reader),hints=reader.versionHints.bind(reader);
    const settle=(bytes:Uint8Array)=>{
      if(++reads!==target)return;
      watched=bytes;revoked=true;f.change(['one.md']);
      if(exception)throw Error('synthetic read settlement failure');
    };
    reader.read=async path=>{if(revoked)late++;const bytes=await read(path);settle(bytes);return bytes;};
    reader.readVerifiedOriginal=async path=>{if(revoked)late++;const value=await verified(path);settle(value.bytes);return value;};
    reader.list=async()=>{if(revoked)late++;return list();};
    reader.versionHints=async paths=>{if(revoked)late++;return hints(paths);};
    if(stage==='generation'){
      await engine.start();await engine.whenIdle();
      assert.equal((await store.load()).generation,null);
    }else if(dense){
      await assert.rejects(dense.verify(dense.evidence[0]!),/SOURCE_STALE/);
      assert.equal(dense.current(),false);
    }else if(stage.startsWith('preview')){
      await assert.rejects(engine.previewPolicyMetadata('one.md',()=>true,proof),/SOURCE_CHANGED/);
    }else{
      const deadlineUnixMs=Date.now()+5000;
      const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
        identity:{model:'synthetic',revision:'fixture'},limits:{timeoutMs:5000,maxInputBytes:8192,maxCandidates:10,maxOutputTokens:64,maxConcurrent:1}};
      const snapshot:PolicySnapshot={subjects:[{kind:'original',sourceId:'one.md',expectedSha256:hash('# unique one.md'),ownerIds:['one.md']}],
        profile:{profileId:'fixture',admissionId:'fixture-review',role:'generation',configDigest:configDigest('generation',config),
          adapter:'fixture',classification:'trusted-internal'},role:'generation',config,adapter:'fixture',
        ownerId:'fixture-owner',hostId:'fixture-host',scopeId:reader.rootId,policyRevision:'p1',configRevision:'c1',
        credentialEpoch:1,deadlineUnixMs,payloadDigest:hash('fixture'),restrictions:[],evaluationComplete:true};
      await assert.rejects(engine.evaluateProcessingPolicy({snapshot:()=>snapshot,current:()=>true,requireOriginalProof:true},
        {signal:new AbortController().signal,deadlineUnixMs}),/CANCELLED/);
    }
    await engine.whenIdle();assert.equal(revoked,true);assert.ok(watched);
    assert.equal(reads,target);assert.equal(late,0);
    assert.equal(parses()-beforeParses,stage==='generation'?2:0);
    assert.equal(previews()-beforePreviews,stage.includes('renewal')?1:0);
    assert.equal(byteHashes,0,'post-revocation processing of returned bytes');
    await denied(engine);
  }finally{await f.cleanup();}
});

// Inspect owner state before status()/current() can repair the missing fence.
const ownerState=(engine:StandaloneEngine)=>engine as unknown as {
  scopeRetired:boolean;generation:unknown;graphCache:unknown;localRead:Promise<unknown>|null;
  work:Promise<void>|null;all:boolean;pending:Set<string>;yieldJob:()=>Promise<void>;scopeCurrent():boolean;
};
const graphRequest={requestId:'synthetic-graph',query:'unique',limit:10,scope:{mode:'vault-wide'},
  expansion:{depth:0,direction:'outgoing',fanOut:16,maxExpanded:32}};
for(const route of ['chat-capture','chat-verify','chat-search','graph-read','local-graph-read','local-graph-verify'] as const)
for(const revoke of [true,false])test('owner settlement '+route+' revoked='+revoke,async t=>{
  const f=await fixture();try{
    const {engine,reader,parses}=await f.open();await engine.start();await engine.whenIdle();
    const signal=new AbortController().signal;
    engine.configureGraph({schemaVersion:'oks-06b-mapping-v1',rules:[]});
    const chat=route.startsWith('chat')&&route!=='chat-capture'?await engine.captureChatScope({mode:'vault-wide'},signal):null;
    const graph=route==='graph-read'?engine.captureGraphScope({mode:'vault-wide'},signal):null;
    const local=route.startsWith('local')?engine.captureLocalGraph(graphRequest,signal):null;
    if(route==='local-graph-verify')await local!.read();
    const before=parses(),read=reader.read.bind(reader),list=reader.list.bind(reader),hints=reader.versionHints.bind(reader);
    let reads=0,late=0,hashes=0,revoked=false,watched:Uint8Array|undefined;
    const originalUpdate=Hash.prototype.update;
    t.mock.method(Hash.prototype,'update',function(this:Hash,...args:unknown[]){
      if(revoked&&args[0]===watched)hashes++;return Reflect.apply(originalUpdate,this,args);
    });
    const failure=Error('synthetic read rejection');
    reader.read=async path=>{if(revoked)late++;reads++;watched=await read(path);
      if(revoke){revoked=true;f.change(['one.md']);}throw failure;};
    reader.list=async()=>{if(revoked)late++;return list();};
    reader.versionHints=async paths=>{if(revoked)late++;return hints(paths);};
    const result=route==='chat-capture'?engine.captureChatScope({mode:'vault-wide'},signal):
      route==='chat-verify'?chat!.verify():route==='chat-search'?chat!.search({requestId:'synthetic-chat',query:'unique',limit:10}):
      route==='graph-read'?graph!.read():route==='local-graph-read'?local!.read():local!.verify();
    const expected=route.startsWith('chat')?/SCOPE_CHANGED/:revoke?/GRAPH_SOURCE_STALE/:failure;
    await assert.rejects(result,expected);
    assert.equal(reads,1);assert.equal(revoked,revoke);assert.equal(late,0);assert.equal(hashes,0);assert.equal(parses(),before);
    assert.equal(ownerState(engine).scopeRetired,revoke);
    assert.equal(ownerState(engine).generation===null,revoke);
    if(revoke){assert.equal(ownerState(engine).graphCache,null);await denied(engine);}
    else{
      reader.read=read;assert.equal((await engine.search(request)).status,'ok');
      // A locally retired lease still observes subsequent owner revocation.
      const lease=chat??graph??local;
      if(lease){assert.equal(lease.current(),false);f.change(['one.md']);assert.equal(lease.current(),false);
        assert.equal(ownerState(engine).scopeRetired,true);assert.equal(ownerState(engine).generation,null);}
    }
  }finally{await f.cleanup();}
});

for(const terminal of ['abort','timeout'] as const)
for(const timing of ['before-terminal','after-terminal'] as const)test('graph '+terminal+' owner retirement '+timing,async t=>{
  const f=await fixture();let release=()=>{};try{
    const {engine,reader}=await f.open();await engine.start();await engine.whenIdle();
    engine.configureGraph({schemaVersion:'oks-06b-mapping-v1',rules:[]});
    const abort=new AbortController(),read=reader.read.bind(reader);
    let enter=()=>{},reads=0;const entered=new Promise<void>(r=>{enter=r;});
    const held=new Promise<void>(r=>{release=r;});
    reader.read=async path=>{reads++;const bytes=await read(path);enter();await held;return bytes;};
    if(terminal==='timeout')t.mock.timers.enable({apis:['setTimeout']});
    const pending=engine.retrieveLocalGraph(graphRequest,abort.signal);
    const rejected=assert.rejects(pending,timing==='before-terminal'&&terminal==='timeout'?/GRAPH_SOURCE_STALE/:terminal==='abort'?/GRAPH_CANCELLED/:/GRAPH_TIMEOUT/);
    await entered;
    if(timing==='before-terminal')f.change(['one.md']);
    if(terminal==='abort')abort.abort();else t.mock.timers.tick(30001);
    await rejected;
    assert.ok(ownerState(engine).localRead,'logical denial must not release physical slot');
    if(timing==='before-terminal')assert.equal(ownerState(engine).scopeRetired,true);
    else{assert.equal(ownerState(engine).scopeRetired,false);f.change(['one.md']);}
    release();await engine.whenIdle();
    assert.equal(ownerState(engine).localRead,null);
    assert.equal(ownerState(engine).scopeRetired,true);assert.equal(ownerState(engine).generation,null);
    assert.equal(reads,1);await denied(engine);
  }finally{t.mock.timers.reset();release();await f.cleanup();}
});

for(const route of ['preview','policy'] as const)
for(const timing of ['before-terminal','after-terminal'] as const)test(route+' owner retirement '+timing,async t=>{
  const f=await fixture();let release=()=>{};try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    const abort=new AbortController(),read=reader.read.bind(reader),deadlineUnixMs=Date.now()+5000;
    const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
      identity:{model:'synthetic',revision:'fixture'},limits:{timeoutMs:5000,maxInputBytes:8192,maxCandidates:10,maxOutputTokens:64,maxConcurrent:1}};
    const snapshot:PolicySnapshot={subjects:[{kind:'original',sourceId:'one.md',expectedSha256:hash('# unique one.md'),ownerIds:['one.md']}],
      profile:{profileId:'fixture',admissionId:'fixture-review',role:'generation',configDigest:configDigest('generation',config),
        adapter:'fixture',classification:'trusted-internal'},role:'generation',config,adapter:'fixture',
      ownerId:'fixture-owner',hostId:'fixture-host',scopeId:reader.rootId,policyRevision:'p1',configRevision:'c1',
      credentialEpoch:1,deadlineUnixMs,payloadDigest:hash('fixture'),restrictions:[],evaluationComplete:true};
    let enter=()=>{},reads=0;const entered=new Promise<void>(r=>{enter=r;});
    const held=new Promise<void>(r=>{release=r;});
    reader.read=async path=>{reads++;const bytes=await read(path);enter();await held;return bytes;};
    if(route==='preview')t.mock.timers.enable({apis:['setTimeout']});
    const pending=route==='preview'?engine.previewPolicyMetadata('one.md',()=>true):
      engine.evaluateProcessingPolicy({snapshot:()=>snapshot,current:()=>true},{signal:abort.signal,deadlineUnixMs});
    const settled=route==='preview'?assert.rejects(pending,timing==='before-terminal'?/SOURCE_CHANGED/:/PARSER_TIMEOUT/):
      timing==='before-terminal'?assert.rejects(pending,/CANCELLED/):pending.then(value=>{
        assert.ok('allowed' in value);assert.equal(value.allowed,false);assert.equal(value.reason,'cancelled');
      });
    await entered;if(timing==='before-terminal')f.change(['one.md']);
    if(route==='preview')t.mock.timers.tick(5001);else abort.abort();
    await settled;
    assert.ok(ownerState(engine).localRead,'logical denial must not release physical slot');
    if(timing==='before-terminal')assert.equal(ownerState(engine).scopeRetired,true);
    else{assert.equal(ownerState(engine).scopeRetired,false);f.change(['one.md']);}
    release();await engine.whenIdle();
    assert.equal(ownerState(engine).localRead,null);
    assert.equal(ownerState(engine).scopeRetired,true);assert.equal(ownerState(engine).generation,null);
    assert.equal(reads,1);assert.equal(previews(),0);await denied(engine);
  }finally{t.mock.timers.reset();release();await f.cleanup();}
});

for(const stage of ['lexical','anchor','expanded'] as const)test('graph nested evidence settlement '+stage,async t=>{
  const f=await fixture({'one.md':'---\nid: A\ndepends: B\n---\n# unique one',
    'two.md':'---\nid: B\n---\n# unique two'});try{
    const {engine,reader,store}=await f.open();await engine.start();await engine.whenIdle();
    const mapping=validateGraphMapping({schemaVersion:'oks-06b-mapping-v1',businessIdKey:'id',rules:[
      {relationId:'depends',propertyKey:'depends',direction:'author-to-target',targetEncoding:'business-id'}]});
    assert.ok(!('code' in mapping));engine.configureGraph(mapping);
    const graph=await engine.captureGraphScope({mode:'vault-wide'},new AbortController().signal).read();
    const {generation}=await store.load();assert.ok(generation);
    const seeds=(await engine.search({...request,scope:['one.md']})).hits;assert.equal(seeds.length,1);
    const query=parseGraphQuery({...graphRequest,expansion:{...graphRequest.expansion,depth:1}});
    const read=reader.read.bind(reader),watched=new Map<Uint8Array,string>(),counts=new Map<string,number>();
    let revoked=false,armed=false,late=0,lateAssembly=0;
    reader.read=async path=>{if(revoked)late++;const bytes=await read(path);watched.set(bytes,path);return bytes;};
    const originalUpdate=Hash.prototype.update;
    t.mock.method(Hash.prototype,'update',function(this:Hash,...args:unknown[]){
      const path=watched.get(args[0] as Uint8Array);
      if(path){const n=(counts.get(path)??0)+1;counts.set(path,n);
        if(!armed&&((stage==='lexical'&&path==='one.md'&&n===2)||(stage==='anchor'&&path==='one.md'&&n===3)||
          (stage==='expanded'&&path==='two.md'&&n===2))){armed=true;queueMicrotask(()=>{revoked=true;f.change(['one.md']);});}}
      return Reflect.apply(originalUpdate,this,args);
    });
    const originalPush=Array.prototype.push;
    Array.prototype.push=function(this:unknown[],...items:unknown[]){
      if(revoked)for(const item of items)if(item&&typeof item==='object'&&'excerpt' in item&&'locator' in item&&'sourceId' in item)lateAssembly++;
      return Reflect.apply(originalPush,this,items);
    };
    const check=()=>{if(!(reader.hardSearchScope as RevocableHardSearchScope).current())throw new StandaloneError('SEARCH_SCOPE_INVALID');};
    try{await assert.rejects(materializeGraph(generation,graph,mapping,query,seeds,reader,check),/SEARCH_SCOPE_INVALID/);}
    finally{Array.prototype.push=originalPush;}
    assert.equal(armed,true);assert.equal(revoked,true);assert.equal(late,0);assert.equal(lateAssembly,0);
    await denied(engine);
  }finally{await f.cleanup();}
});

// One-shot admission is independent of the lifetime of the engine owner.
for(const stage of ['read-again','verify-before-read','verify-after-failed-read','verify-again'] as const)
for(const revoke of [true,false])test('local graph repeated admission '+stage+' revoked='+revoke,async()=>{
  const f=await fixture();try{
    const {engine,reader,parses}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine);
    engine.configureGraph({schemaVersion:'oks-06b-mapping-v1',rules:[]});
    const lease=engine.captureLocalGraph(graphRequest,new AbortController().signal);
    const original=reader.read.bind(reader),failure=Error('ordinary synthetic read failure');
    if(stage==='read-again'||stage==='verify-again'){
      await lease.read();assert.ok(owner.graphCache);
      if(stage==='verify-again')await lease.verify();
    }else if(stage==='verify-after-failed-read'){
      reader.read=async()=>{throw failure;};
      await assert.rejects(lease.read(),failure);reader.read=original;
    }
    assert.ok(owner.generation);assert.equal(owner.scopeRetired,false);
    let dispatches=0;
    reader.read=async path=>{dispatches++;return original(path);};
    const list=reader.list.bind(reader),hints=reader.versionHints.bind(reader);
    reader.list=async()=>{dispatches++;return list();};
    reader.versionHints=async paths=>{dispatches++;return hints(paths);};
    const before=parses();
    if(revoke)f.change(['one.md']);
    const result=stage==='read-again'?lease.read():lease.verify();
    if(stage==='verify-again'&&!revoke){await result;assert.ok(dispatches>0);}
    else{await assert.rejects(result,/GRAPH_SOURCE_STALE/);assert.equal(dispatches,0);}
    assert.equal(owner.scopeRetired,revoke);
    assert.equal(owner.generation===null,revoke);
    if(revoke)assert.equal(owner.graphCache,null);
    assert.equal(parses(),before);
  }finally{await f.cleanup();}
});

// Await the actual captured work promise, not status/current/whenIdle, so
// a missing finalizer cannot be concealed by a subsequent public observation.
for(const stage of ['unchanged','parsed','final-versions'] as const)
for(const mode of ['cancel-revoke','revoke-cancel','cancel-only','dirty-revoke','yield-reject','revoke-only','close-revoke','dirty-only'] as const)
test('reconciliation physical yield '+stage+' '+mode,async()=>{
  const f=await fixture();let release=()=>{};try{
    const {engine,reader,parses}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine);
    const before=owner.generation;assert.ok(before);
    let enter=()=>{},yields=0,dispatches=0;
    const entered=new Promise<void>(r=>{enter=r;});
    const held=new Promise<void>(r=>{release=r;});
    const target=stage==='final-versions'?3:1;
    const read=reader.read.bind(reader),list=reader.list.bind(reader),hints=reader.versionHints.bind(reader);
    if(stage==='parsed')await f.write('one.md','# unique changed');
    reader.read=async path=>{dispatches++;return read(path);};
    reader.list=async()=>{dispatches++;return list();};
    reader.versionHints=async paths=>{dispatches++;return hints(paths);};
    const beforeParses=parses();
    owner.yieldJob=async()=>{
      if(++yields!==target)return;
      enter();await held;
      if(mode==='yield-reject')throw Error('synthetic cooperative yield failure');
    };
    engine.reconcile();await entered;
    const physical=owner.work;assert.ok(physical);
    assert.equal(parses()-beforeParses,stage==='parsed'?1:0);
    let closing:Promise<void>|undefined;
    if(mode==='dirty-revoke'||mode==='dirty-only'){engine.changed('two.md');assert.ok(owner.pending.size);}
    else if(mode==='revoke-cancel'){f.change(['one.md']);assert.equal(engine.cancel(),true);}
    else if(mode==='close-revoke')closing=engine.close();
    else if(mode==='cancel-only'||mode==='cancel-revoke')assert.equal(engine.cancel(),true);
    if(['cancel-revoke','dirty-revoke','yield-reject','revoke-only','close-revoke'].includes(mode))f.change(['one.md']);
    const dispatchBefore=dispatches,parseBefore=parses();
    assert.equal(owner.work,physical);
    release();await physical;
    const revoked=mode!=='cancel-only'&&mode!=='dirty-only';
    assert.equal(owner.scopeRetired,revoked);
    if(mode==='dirty-only'){
      await engine.whenIdle();
      assert.equal(engine.status().status,'ready');
      assert.ok(dispatches>dispatchBefore,'dirty obligations must be reconciled');
      assert.equal(owner.pending.size,0);assert.equal(owner.all,false);
      return;
    }
    assert.equal(owner.generation,revoked?null:before);
    assert.equal(owner.graphCache,null);assert.equal(owner.work,null);
    assert.equal(owner.pending.size,0);assert.equal(owner.all,false);
    assert.equal(dispatches,dispatchBefore);assert.equal(parses(),parseBefore);
    if(closing){await closing;assert.throws(()=>engine.resume(),/LIFECYCLE_INVALID/);}
    else if(revoked){engine.resume();assert.equal(owner.work,null);assert.equal(owner.generation,null);}
    else{engine.resume();await engine.whenIdle();assert.equal(engine.status().status,'ready');}
  }finally{release();await f.cleanup();}
});

test('projection observes native revocation at every nested microtask continuation',async t=>{
  const f=await fixture({'one.md':'---\nid: A\naliases: ["Alpha"]\ndepends: B\n---\n# unique one\n[[two]]',
    'two.md':'---\nid: B\naliases: ["Beta"]\n---\n# unique two\n[[Alpha]]'});
  try{
    const first=await f.open();await first.engine.start();await first.engine.whenIdle();
    const {generation}=await first.store.load();assert.ok(generation);
    const mapping={schemaVersion:'oks-06b-mapping-v1',businessIdKey:'id',aliasKeys:['aliases'],rules:[
      {relationId:'depends',propertyKey:'depends',direction:'author-to-target',targetEncoding:'business-id'}]};
    let checks=0;
    const normal=await deriveGraphProjection(generation,mapping,{cancelled:()=>{checks++;return false;}});
    assert.ok(!('code' in normal));assert.ok(normal.edges.some(e=>e.kind==='relation'));
    assert.ok(normal.edges.some(e=>e.kind==='navigation'));assert.ok(checks>10);
    // Queue revocation after every possible observation (including observations
    // in the nested navigation helper). Only a projection already completely
    // assembled and frozen before revocation may have completed normally.
    const count=checks;
    for(let at=1;at<=count;at++){
      f.change(null);
      const {engine}=await f.open();await engine.start();await engine.whenIdle();
      const owner=ownerState(engine),copy=structuredClone(generation);
      let observed=0,revoked=false,late=0,completedBeforeRevocation=false;
      for(const doc of copy.documents){
        for(const key of ['properties','blocks','sourceId','sha256'] as const){
          const value=doc[key];
          Object.defineProperty(doc,key,{enumerable:true,configurable:true,get(){if(revoked)late++;return value;}});
        }
      }
      const push=Array.prototype.push,update=Hash.prototype.update,freeze=Object.freeze;
      Array.prototype.push=function(this:unknown[],...items:unknown[]){
        if(revoked)for(const item of items)if(item&&typeof item==='object'&&
          (('doc' in item&&'eligible' in item)||('anchors' in item&&('edgeId' in item||'value' in item))))late++;
        return Reflect.apply(push,this,items);
      };
      Hash.prototype.update=function(this:Hash,...args:unknown[]){
        if(revoked)late++;
        return Reflect.apply(update,this,args);
      } as typeof Hash.prototype.update;
      Object.freeze=function<T>(value:T):Readonly<T>{
        if(value&&typeof value==='object'&&'projectionId' in value){
          if(revoked)late++;else completedBeforeRevocation=true;
        }
        return freeze(value);
      } as typeof Object.freeze;
      try{
        const result=await deriveGraphProjection(copy,mapping,{cancelled:()=>{
          const live=owner.scopeCurrent();
          if(++observed===at)queueMicrotask(()=>{revoked=true;f.change(['one.md']);});
          return !live;
        }});
        assert.equal(revoked,true,'revocation must occur at checkpoint '+at);
        assert.equal(late,0,'post-revocation processing at checkpoint '+at);
        if('code' in result){assert.equal(result.code,'GRAPH_CANCELLED');assert.equal(owner.scopeRetired,true);}
        else assert.equal(completedBeforeRevocation,true,'projection completed after revocation');
      }finally{
        Array.prototype.push=push;Hash.prototype.update=update;Object.freeze=freeze;
      }
      await engine.close();
    }
  }finally{await f.cleanup();}
});

for(const mode of ['resolve','reject'] as const)test('projection observes revocation at physical cooperative yield '+mode,async()=>{
  const f=await fixture({'one.md':Array.from({length:300},(_,i)=>'unique '+i).join('\n'),'two.md':'# unique two'});
  try{
    const {engine,store}=await f.open();await engine.start();await engine.whenIdle();
    const {generation}=await store.load();assert.ok(generation);
    const owner=ownerState(engine);let yields=0;
    const result=await deriveGraphProjection(generation,{schemaVersion:'oks-06b-mapping-v1',rules:[]},{
      cancelled:()=>!owner.scopeCurrent(),yieldJob:async()=>{
        yields++;f.change(['one.md']);if(mode==='reject')throw Error('synthetic yield rejection');
      }});
    assert.equal(yields,1);assert.deepEqual(result,{code:'GRAPH_CANCELLED'});
    assert.equal(owner.scopeRetired,true);assert.equal(owner.generation,null);
  }finally{await f.cleanup();}
});

// Host callbacks may re-enter the native exclusion authority synchronously,
// including from a post-read continuation. A denied envelope is not a license
// to validate, hash or copy the returned metadata after owner retirement.
for(const stage of ['initial-snapshot','post-read-snapshot','snapshot-throw','current-revoke',
  'marking-allow-revoke','marking-deny-revoke','marking-throw-revoke',
  'snapshot-allow','snapshot-null','snapshot-error','current-deny',
  'marking-allow','marking-deny','marking-error','snapshot-reentrant'] as const)
test('processing policy callback fence '+stage,async t=>{
  const f=await fixture();try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    engine.configureGraph({schemaVersion:'oks-06b-mapping-v1',rules:[]});
    await engine.captureGraphScope({mode:'vault-wide'},new AbortController().signal).read();
    const owner=ownerState(engine);assert.ok(owner.generation);assert.ok(owner.graphCache);
    const deadlineUnixMs=Date.now()+5000,context={signal:new AbortController().signal,deadlineUnixMs};
    const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
      identity:{model:'synthetic',revision:'fixture'},limits:{timeoutMs:5000,maxInputBytes:8192,maxCandidates:10,maxOutputTokens:64,maxConcurrent:1}};
    const snapshot:PolicySnapshot={subjects:[{kind:'original',sourceId:'one.md',expectedSha256:hash('# unique one.md'),ownerIds:['one.md']}],
      profile:{profileId:'fixture',admissionId:'fixture-review',role:'generation',configDigest:configDigest('generation',config),
        adapter:'fixture',classification:stage.startsWith('marking')?'external':'trusted-internal'},
      role:'generation',config,adapter:'fixture',ownerId:'fixture-callback-owner',hostId:'fixture-host',scopeId:reader.rootId,
      policyRevision:'p1',configRevision:'c1',credentialEpoch:1,deadlineUnixMs,payloadDigest:hash('fixture'),restrictions:[],evaluationComplete:true};
    let revoked=false,armed=stage!=='post-read-snapshot',reads=0,lateDispatch=0,lateMetadata=0,lateHashes=0,lateCopies=0,markings=0,snapshots=0;
    const revoke=()=>{revoked=true;f.change(['one.md']);};
    const originalRead=reader.read.bind(reader);
    reader.read=async path=>{if(revoked)lateDispatch++;reads++;const bytes=await originalRead(path);if(stage==='post-read-snapshot')armed=true;return bytes;};
    const originalUpdate=Hash.prototype.update;
    t.mock.method(Hash.prototype,'update',function(this:Hash,...args:unknown[]){
      if(revoked&&typeof args[0]==='string'&&args[0].includes('fixture-callback-owner'))lateHashes++;
      return Reflect.apply(originalUpdate,this,args);
    });
    const wrapped={...snapshot,get subjects(){if(revoked)lateMetadata++;return snapshot.subjects;}};
    const originalMap=Array.prototype.map;
    Array.prototype.map=function(this:unknown[],...args:unknown[]){
      if(revoked&&this.some(x=>x&&typeof x==='object'&&'metadataState' in x&&'sourceId' in x))lateCopies++;
      return Reflect.apply(originalMap,this,args);
    };
    let nested:Promise<void>|undefined;
    const host={
      snapshot:()=>{
        snapshots++;
        if(armed&&(stage==='initial-snapshot'||stage==='post-read-snapshot'||stage==='snapshot-throw')){
          armed=false;revoke();if(stage==='snapshot-throw')throw Error('synthetic snapshot error');
        }
        if(stage==='snapshot-null')return null;
        if(stage==='snapshot-error')throw Error('synthetic snapshot error');
        if(stage==='snapshot-reentrant'&&!nested){
          nested=assert.rejects(engine.evaluateProcessingPolicy(host,context),/BUSY/);
          assert.ok(owner.localRead,'reserve before entering host callback');
        }
        return wrapped;
      },
      current:()=>{if(stage==='current-revoke'&&!revoked)revoke();return stage!=='current-deny';},
      marking:()=>{
        markings++;
        if(stage.endsWith('-revoke'))revoke();
        if(stage==='marking-error'||stage==='marking-throw-revoke')throw Error('synthetic marking error');
        return stage!=='marking-deny'&&stage!=='marking-deny-revoke';
      }
    };
    const expectRevoked=['initial-snapshot','post-read-snapshot','snapshot-throw','current-revoke','marking-allow-revoke','marking-deny-revoke','marking-throw-revoke'].includes(stage);
    try{
      const pending=engine.evaluateProcessingPolicy(host,context),physical=owner.localRead;assert.ok(physical);
      if(expectRevoked)await assert.rejects(pending,/CANCELLED/);
      else{
        const result=await pending;
        const expected=stage==='snapshot-null'||stage==='snapshot-error'||stage==='marking-error'?'source-unresolved':
          stage==='current-deny'?'authority-changed':stage==='marking-deny'?'marking-denied':'eligible';
        assert.equal(result.reason,expected);assert.equal(result.allowed,expected==='eligible');
      }
      await physical.catch(()=>{});await nested;
      assert.equal(revoked,expectRevoked);
      assert.equal(owner.scopeRetired,expectRevoked);
      assert.equal(owner.generation===null,expectRevoked);assert.equal(owner.graphCache===null,expectRevoked);
      assert.equal(owner.localRead,null);
      assert.equal(lateDispatch,0);assert.equal(lateMetadata,0);assert.equal(lateHashes,0);assert.equal(lateCopies,0);
      if(expectRevoked){
        assert.equal(reads,stage.startsWith('marking')||stage==='post-read-snapshot'?1:0);
        assert.equal(previews(),stage.startsWith('marking')?1:0);
      }
      assert.equal(markings,stage.startsWith('marking')?1:0);
      if(stage==='current-revoke'||stage==='current-deny')assert.equal(snapshots,0);
    }finally{Array.prototype.map=originalMap;}
  }finally{await f.cleanup();}
});
