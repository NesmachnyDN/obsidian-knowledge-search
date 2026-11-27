import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hash} from 'node:crypto';
import {configDigest} from '../plugin/src/ai/disclosure';
import type {ProviderConfig,CallContext} from '../plugin/src/ai/contracts';
import {bindActiveDeadline,captureCallContext,expireActiveDeadline} from '../plugin/src/ai/active-deadline';
import type {PolicySnapshot,PolicyHost} from '../plugin/src/ai/processing-policy';
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

// Existing cases use a stable synthetic host authority; terminal revocation
// tests below explicitly invalidate a real token rather than faking currency.
function preview(engine:StandaloneEngine,path:string,current:()=>boolean,proof=false){
  return engine.previewPolicyMetadata(path,current,proof,new AbortController().signal);
}
function evaluate(engine:StandaloneEngine,host:PolicyHost,context:CallContext){
  return engine.evaluateProcessingPolicy({...host,authority:new AbortController().signal},context);
}

const request={protocolVersion:PROTOCOL,requestId:'synthetic-scope',query:'unique',requestedMode:'lexical',limit:10} as const;
async function fixture(files:Record<string,string>={'one.md':'# unique one.md','two.md':'# unique two.md'}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'oks-engine-scope-')));
  const paths=Object.keys(files).sort();
  for(const path of paths)await writeFile(join(root,path),files[path]!);
  let raw: string[]|null=null;let configHook=()=>{};
  const callbacks=new Set<()=>void>();
  const metadata={userIgnoreFilters:null as object[]|null,isUserIgnored:(path:string)=>raw?.includes(path)??false};
  const vault={getConfig:()=>{configHook();return raw;},on:(_event:string,callback:()=>void)=>{callbacks.add(callback);return callback;},offref:(ref:unknown)=>{callbacks.delete(ref as ()=>void);}};
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
    return {engine,reader,store,parser,parses:()=>parses,onParse:(cb:()=>void)=>{onParse=cb;},previews:()=>previews,onPreview:(cb:()=>void)=>{onPreview=cb;}};
  };
  return {open,change,onConfigRead:(cb:()=>void)=>{configHook=cb;},write:(path:string,text:string)=>writeFile(join(root,path),text),cleanup:async()=>{for(const e of engines)await e.close();for(const l of leases)l.dispose();await rm(root,{recursive:true,force:true});}};
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
    await assert.rejects(preview(engine,'one.md',()=>true),/SOURCE_CHANGED/);
    await engine.whenIdle();assert.equal(reads,1);assert.equal(previews(),stage==='read'?0:1);
    await assert.rejects(preview(engine,'two.md',()=>true),/SEARCH_SCOPE_INVALID/);
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
      await assert.rejects(preview(engine,'one.md',()=>true,proof),/SOURCE_CHANGED/);
    }else{
      const deadlineUnixMs=Date.now()+5000;
      const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
        identity:{model:'synthetic',revision:'fixture'},limits:{timeoutMs:5000,maxInputBytes:8192,maxCandidates:10,maxOutputTokens:64,maxConcurrent:1}};
      const snapshot:PolicySnapshot={subjects:[{kind:'original',sourceId:'one.md',expectedSha256:hash('# unique one.md'),ownerIds:['one.md']}],
        profile:{profileId:'fixture',admissionId:'fixture-review',role:'generation',configDigest:configDigest('generation',config),
          adapter:'fixture',classification:'trusted-internal'},role:'generation',config,adapter:'fixture',
        ownerId:'fixture-owner',hostId:'fixture-host',scopeId:reader.rootId,policyRevision:'p1',configRevision:'c1',
        credentialEpoch:1,deadlineUnixMs,payloadDigest:hash('fixture'),restrictions:[],evaluationComplete:true};
      await assert.rejects(evaluate(engine,{snapshot:()=>snapshot,current:()=>true,requireOriginalProof:true},
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
  localSettlement:Promise<unknown>|null;work:Promise<void>|null;all:boolean;pending:Set<string>;yieldJob:()=>Promise<void>;scopeCurrent():boolean;
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
    const pending=route==='preview'?preview(engine,'one.md',()=>true):
      evaluate(engine,{snapshot:()=>snapshot,current:()=>true},{signal:abort.signal,deadlineUnixMs});
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
          nested=assert.rejects(evaluate(engine,host,context),/BUSY/);
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
      const pending=evaluate(engine,host,context),physical=owner.localRead;assert.ok(physical);
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

// The final callback runs after physical drain but before logical publication.
// Exercise both routes with the actual native lease, not a mocked owner guard.
for(const route of ['policy','preview'] as const)
for(const mode of ['allow','deny','throw','revoke','microtask-revoke','nested-revoke','microtask-throw','reenter','microtask-reenter','cancel','microtask-cancel','revision','microtask-revision','deadline'] as const)
test('local policy terminal '+route+' '+mode,async t=>{
  const f=await fixture();try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    engine.configureGraph({schemaVersion:'oks-06b-mapping-v1',rules:[]});
    await engine.captureGraphScope({mode:'vault-wide'},new AbortController().signal).read();
    const owner=ownerState(engine),abort=new AbortController(),deadlineUnixMs=Date.now()+5000;
    const context={signal:abort.signal,deadlineUnixMs};
    if(route==='preview'&&mode==='deadline')t.mock.timers.enable({apis:['setTimeout']});
    const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
      identity:{model:'synthetic',revision:'fixture'},limits:{timeoutMs:5000,maxInputBytes:8192,maxCandidates:10,maxOutputTokens:64,maxConcurrent:1}};
    const snapshot:PolicySnapshot={subjects:[{kind:'original',sourceId:'one.md',expectedSha256:hash('# unique one.md'),ownerIds:['one.md']}],
      profile:{profileId:'fixture',admissionId:'fixture-review',role:'generation',configDigest:configDigest('generation',config),
        adapter:'fixture',classification:'trusted-internal'},role:'generation',config,adapter:'fixture',
      ownerId:'fixture-owner',hostId:'fixture-host',scopeId:reader.rootId,policyRevision:'p1',configRevision:'c1',
      credentialEpoch:1,deadlineUnixMs,payloadDigest:hash('fixture'),restrictions:[],evaluationComplete:true};
    const ordinary={snapshot:()=>snapshot,current:()=>true};
    let finalCalls=0,revoked=false,lateReads=0;
    const read=reader.read.bind(reader);
    reader.read=async path=>{if(revoked)lateReads++;return read(path);};
    const revoke=()=>{revoked=true;f.change(['one.md']);};
    const nested:Promise<void>[]=[];
    const current=()=>{
      if(owner.localRead!==null)return true;
      finalCalls++;
      if(mode==='revoke')revoke();
      if(mode==='microtask-revoke'||mode==='microtask-throw')queueMicrotask(revoke);
      if(mode==='nested-revoke')queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(revoke)));
      if(mode==='throw'||mode==='microtask-throw')throw Error('synthetic final failure');
      const reenter=()=>{
        nested.push(assert.rejects(evaluate(engine,ordinary,context),/BUSY/));
        nested.push(assert.rejects(preview(engine,'one.md',()=>true),/PARSER_BUSY/));
        nested.push(assert.rejects(engine.captureGraphScope({mode:'vault-wide'},abort.signal).read(),/GRAPH_BUSY/));
        // Attach rejection handlers immediately; assertions are awaited below.
        for(const p of nested)void p.catch(()=>{});
      };
      if(mode==='reenter')reenter();
      if(mode==='microtask-reenter')queueMicrotask(reenter);
      const cancel=()=>{if(route==='policy')abort.abort();else engine.cancel();};
      if(mode==='cancel')cancel();
      if(mode==='microtask-cancel')queueMicrotask(cancel);
      if(mode==='revision')engine.changed('one.md');
      if(mode==='microtask-revision')queueMicrotask(()=>engine.changed('one.md'));
      if(mode==='deadline'){
        if(route==='policy')t.mock.method(Date,'now',()=>deadlineUnixMs+1);
        else t.mock.timers.tick(5001);
      }
      return mode!=='deny';
    };
    const pending=route==='policy'?evaluate(engine,{...ordinary,current},context):
      preview(engine,'one.md',current);
    if(mode==='allow'||mode==='reenter'||mode==='microtask-reenter'){
      const value=await pending;
      if('allowed' in value)assert.equal(value.allowed,true);else assert.equal(value.sourceId,'one.md');
    }else{
      const expected=mode==='throw'?/synthetic final failure/:mode==='deadline'?/TIMEOUT/:
        route==='policy'?/CANCELLED/:/SOURCE_CHANGED/;
      await assert.rejects(pending,expected);
    }
    const retired=mode==='revoke'||mode==='microtask-revoke'||mode==='nested-revoke'||mode==='microtask-throw';
    assert.equal(finalCalls,1);assert.equal(revoked,retired);
    assert.equal(owner.scopeRetired,retired);assert.equal(owner.generation===null,retired);
    if(retired)assert.equal(owner.graphCache,null);
    assert.equal(owner.localRead,null);assert.equal(lateReads,0);
    await Promise.all(nested);
    assert.equal(previews(),1);
  }finally{t.mock.restoreAll();t.mock.timers.reset();await f.cleanup();}
});

// A waiter arriving directly from the logical terminal rejection must also
// observe reconciliation queued during the last callback, not a false idle gap.
test('local policy terminal whenIdle waits for queued reconciliation',async()=>{
  const f=await fixture();let release=()=>{};try{
    const {engine,reader}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),list=reader.list.bind(reader);
    let entered=false,finished=false,idle=false;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let finalCalls=0;
    const pending=preview(engine,'one.md',()=>{
      if(owner.localRead===null){
        finalCalls++;
        reader.list=async()=>{entered=true;await gate;finished=true;return list();};
        engine.changed('one.md');
      }
      return true;
    });
    try{await pending;assert.fail('revision invalidates preview');}
    catch(error){assert.match(String(error),/SOURCE_CHANGED/);}
    const waiting=engine.whenIdle().then(()=>{idle=true;});
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(finalCalls,1);assert.equal(entered,true);assert.equal(finished,false);
    assert.equal(idle,false,'idle must include reconciliation queued at publication');
    release();await waiting;assert.equal(finished,true);
  }finally{release();await f.cleanup();}
});


// Publication and idle cuts exercise independent host authority and actual
// native callbacks, not only the engine's own revision.
function terminalPolicyFixture(rootId:string,deadlineUnixMs:number):PolicySnapshot{
  const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
    identity:{model:'synthetic',revision:'fixture'},limits:{timeoutMs:5000,maxInputBytes:8192,maxCandidates:10,maxOutputTokens:64,maxConcurrent:1}};
  return {subjects:[{kind:'original',sourceId:'one.md',expectedSha256:hash('# unique one.md'),ownerIds:['one.md']}],
    profile:{profileId:'fixture',admissionId:'fixture-review',role:'generation',configDigest:configDigest('generation',config),
      adapter:'fixture',classification:'trusted-internal'},role:'generation',config,adapter:'fixture',
    ownerId:'fixture-owner',hostId:'fixture-host',scopeId:rootId,policyRevision:'p1',configRevision:'c1',
    credentialEpoch:1,deadlineUnixMs,payloadDigest:hash('fixture'),restrictions:[],evaluationComplete:true};
}
for(const route of ['policy','preview'] as const)
for(const mode of ['host-revoke','host-nested-revoke','native-cancel','native-change','native-close','native-abort','native-host-revoke','native-scope-revoke','native-missed-change'] as const)
test('publication cut '+route+' '+mode,async()=>{
  const f=await fixture();try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),authority=new AbortController(),abort=new AbortController();
    const context={signal:abort.signal,deadlineUnixMs:Date.now()+5000};
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    let hostLive=true,armed=false,fired=false,held=false,late=0,closing:Promise<void>|undefined;
    const read=reader.read.bind(reader);reader.read=async path=>{if(fired)late++;return read(path);};
    const invalidate=()=>{
      if(fired)return;fired=true;held=owner.localSettlement!==null;
      if(mode.startsWith('host-')){hostLive=false;authority.abort();}
      else if(mode==='native-cancel')engine.cancel();
      else if(mode==='native-change')engine.changed('one.md');
      else if(mode==='native-close')closing=engine.close();
      else if(mode==='native-abort'){abort.abort();authority.abort();}
      else if(mode==='native-host-revoke')authority.abort();
      else f.change(['one.md'],mode!=='native-missed-change');
    };
    const current=()=>{
      if(owner.localRead===null&&!armed){
        armed=true;
        if(mode==='host-revoke')queueMicrotask(invalidate);
        else if(mode==='host-nested-revoke')queueMicrotask(()=>queueMicrotask(invalidate));
        else queueMicrotask(()=>f.onConfigRead(()=>{
          // Identify the final native observation by its semantic phase.
          // Prior HEAD reached it inside the deadline assertion; the
          // remediated engine has one explicit publication observation.
          const stack=new Error().stack??'';
          if(stack.includes('observePublication')||
            (route==='policy'?stack.includes('assertPublicationDeadline'):stack.includes('confirm')))invalidate();
        }));
      }
      return hostLive;
    };
    const pending=route==='policy'?engine.evaluateProcessingPolicy({snapshot:()=>snapshot,current,authority:authority.signal},context):
      engine.previewPolicyMetadata('one.md',current,false,authority.signal);
    await assert.rejects(pending,route==='policy'?/CANCELLED/:/SOURCE_CHANGED/);
    assert.equal(armed,true);assert.equal(fired,true);assert.equal(held,true);
    assert.equal(previews(),1);
    // changed() legitimately starts new reconciliation after settlement; that
    // is not a continuation of the revoked policy/preview operation.
    if(mode!=='native-change')assert.equal(late,0);
    if(mode==='native-scope-revoke'||mode==='native-missed-change'){assert.equal(owner.scopeRetired,true);assert.equal(owner.generation,null);}
    await closing;
  }finally{await f.cleanup();}
});

test('idle cut observes native callback admitted work before returning',async()=>{
  const f=await fixture();let release=()=>{};try{
    const {engine,reader}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),list=reader.list.bind(reader);
    let entered=false,finished=false,idle=false,fired=false,calls=0;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    reader.list=async()=>{entered=true;await gate;finished=true;return list();};
    f.onConfigRead(()=>{
      if(++calls!==2||fired)return;
      fired=true;engine.changed('one.md');
    });
    const waiting=engine.whenIdle().then(()=>{idle=true;});
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(fired,true);assert.equal(entered,true);assert.equal(finished,false);
    assert.ok(owner.work);assert.equal(idle,false,'idle must include already-admitted reconciliation');
    release();await waiting;assert.equal(finished,true);
  }finally{release();await f.cleanup();}
});


// A callback-only host can no longer accidentally acquire a native-scoped
// policy capability; an untrusted imitation of an AbortSignal also denies.
for(const route of ['policy','preview'] as const)
for(const mode of ['missing','aborted','fake','source-seal'] as const)
test('revocable policy admission rejects '+route+' '+mode,async()=>{
  const f=await fixture();try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    const abort=new AbortController();abort.abort();
    const authority=mode==='missing'?undefined:mode==='aborted'?abort.signal:mode==='fake'?({aborted:false} as AbortSignal):
      (reader.hardSearchScope as RevocableHardSearchScope).retirementSignal;
    let calls=0,reads=0;
    const original=reader.read.bind(reader);reader.read=async path=>{reads++;return original(path);};
    const context={signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000};
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    const current=()=>{calls++;return true;};
    const pending=route==='policy'?engine.evaluateProcessingPolicy({snapshot:()=>{calls++;return snapshot;},current,authority},context):
      engine.previewPolicyMetadata('one.md',current,false,authority);
    await assert.rejects(pending,route==='policy'?/CANCELLED/:/SOURCE_CHANGED/);
    assert.equal(calls,0);assert.equal(reads,0);assert.equal(previews(),0);
    const owner=ownerState(engine);assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
    assert.ok(owner.generation);assert.equal(owner.scopeRetired,false);
  }finally{await f.cleanup();}
});

for(const route of ['policy','preview'] as const)
test('publication native observation holds both route admissions '+route,async()=>{
  const f=await fixture();try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    engine.configureGraph({schemaVersion:'oks-06b-mapping-v1',rules:[]});
    const owner=ownerState(engine),authority=new AbortController();
    const context={signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000};
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    let armed=false,observed=false;const nested:Promise<void>[]=[];
    const current=()=>{
      if(owner.localRead===null&&!armed){
        armed=true;
        queueMicrotask(()=>f.onConfigRead(()=>{
          if(observed||!(new Error().stack??'').includes('observePublication'))return;
          observed=true;assert.ok(owner.localSettlement);
          nested.push(assert.rejects(evaluate(engine,{snapshot:()=>snapshot,current:()=>true},context),/BUSY/));
          nested.push(assert.rejects(preview(engine,'one.md',()=>true),/PARSER_BUSY/));
          nested.push(assert.rejects(engine.captureGraphScope({mode:'vault-wide'},context.signal).read(),/GRAPH_BUSY/));
          for(const item of nested)void item.catch(()=>{});
        }));
      }
      return true;
    };
    const pending=route==='policy'?engine.evaluateProcessingPolicy({snapshot:()=>snapshot,current,authority:authority.signal},context):
      engine.previewPolicyMetadata('one.md',current,false,authority.signal);
    const result=await pending;
    assert.equal('allowed' in result?result.allowed:result.sourceId==='one.md',true);
    assert.equal(observed,true);assert.equal(nested.length,3);await Promise.all(nested);
    assert.equal(previews(),1);assert.equal(owner.localSettlement,null);assert.equal(owner.localRead,null);
  }finally{await f.cleanup();}
});

test('native retirement queued by the last getter is after direct publication and fences next consumer observation',async()=>{
  const f=await fixture();try{
    const {engine,reader}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),authority=new AbortController();
    let armed=false,queued=false,revoked=false;
    const current=()=>{
      if(owner.localRead===null&&!armed){
        armed=true;queueMicrotask(()=>f.onConfigRead(()=>{
          if(queued||!(new Error().stack??'').includes('observePublication'))return;
          queued=true;queueMicrotask(()=>{revoked=true;f.change(['one.md']);});
        }));
      }
      return true;
    };
    const proof=await engine.previewPolicyMetadata('one.md',current,false,authority.signal);
    assert.equal(proof.sourceId,'one.md');assert.equal(queued,true);assert.equal(revoked,true);
    // Revocation executed after the callback-free resolve, but before this
    // consumer reaction. Consumer revalidation must deny immediately.
    assert.equal((reader.hardSearchScope as RevocableHardSearchScope).retirementSignal.aborted,true);
    assert.equal(engine.status().generationId,null);assert.equal(owner.scopeRetired,true);
    await denied(engine);
  }finally{await f.cleanup();}
});


for(const route of ['policy','preview'] as const)
test('host seal revoked at physical read settlement '+route,async t=>{
  const f=await fixture();try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),authority=new AbortController();
    const context={signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000};
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    let watched:Uint8Array|undefined,reads=0,lateHashes=0;
    const originalUpdate=Hash.prototype.update;
    t.mock.method(Hash.prototype,'update',function(this:Hash,...args:unknown[]){
      if(authority.signal.aborted&&args[0]===watched)lateHashes++;
      return Reflect.apply(originalUpdate,this,args);
    });
    const read=reader.read.bind(reader);
    reader.read=async path=>{reads++;watched=await read(path);authority.abort();return watched;};
    const pending=route==='policy'?engine.evaluateProcessingPolicy({snapshot:()=>snapshot,current:()=>true,authority:authority.signal},context):
      engine.previewPolicyMetadata('one.md',()=>true,false,authority.signal);
    await assert.rejects(pending,route==='policy'?/CANCELLED/:/SOURCE_CHANGED/);
    await engine.processingPolicyDrain();
    assert.equal(authority.signal.aborted,true);assert.ok(watched);assert.equal(reads,1);
    assert.equal(lateHashes,0);assert.equal(previews(),0);
    // Host-only invalidation never retires the independent source owner.
    assert.equal(owner.scopeRetired,false);assert.ok(owner.generation);
  }finally{await f.cleanup();}
});

// B-12: a typed denial is still source-bearing evidence, not an exemption
// from the existing authority at the final direct publication cut.
for(const reason of ['source-stale','private','marking-denied','restricted'] as const)
for(const retire of [true,false])test('denied policy publication '+reason+' retired='+retire,async()=>{
  const text=reason==='private'?'---\nllm_processing: private\n---\n# unique one.md':'# unique one.md';
  const f=await fixture({'one.md':text});try{
    const {engine,reader}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),authority=new AbortController();
    const context={signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000};
    const base=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    const snapshot:PolicySnapshot={...base,subjects:[{...base.subjects[0]!,expectedSha256:hash(text)}],
      profile:{...base.profile!,classification:'external'},
      restrictions:reason==='restricted'?[{scope:'all'}]:[]};
    let reads=0,observed=false,held=false;
    const read=reader.read.bind(reader);
    reader.read=async path=>{
      reads++;const bytes=await read(path);
      return reason==='source-stale'&&reads===2?Buffer.from('changed synthetic bytes'):bytes;
    };
    f.onConfigRead(()=>{
      if(observed||!(new Error().stack??'').includes('observePublication'))return;
      observed=true;held=owner.localSettlement!==null;
      if(retire)authority.abort();
    });
    const result=engine.evaluateProcessingPolicy({snapshot:()=>snapshot,current:()=>!authority.signal.aborted,
      marking:()=>reason!=='marking-denied',authority:authority.signal},context);
    if(retire)await assert.rejects(result,/CANCELLED/);
    else{
      const envelope=await result;
      assert.equal(envelope.allowed,false);assert.equal(envelope.reason,reason);
      assert.equal(envelope.rootId,reader.rootId);assert.ok(envelope.bindingDigest);
      assert.equal(envelope.sourceVersions.length,reason==='restricted'?0:1);
    }
    assert.equal(observed,true);assert.equal(held,true);
    assert.equal(owner.scopeRetired,false);assert.ok(owner.generation);
    await engine.processingPolicyDrain();assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
  }finally{await f.cleanup();}
});

// B-13: accessors run before policy admission. A reentrant operation may
// claim the existing slot first; the outer operation must not overwrite it.
for(const accessor of ['authority','signal','deadlineUnixMs','requireOriginalProof','marking'] as const)
for(const held of [true,false])test('policy admission reentry '+accessor+' held='+held,async()=>{
  const f=await fixture();let release=()=>{};try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),authority=new AbortController();
    const context={signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000};
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    const read=reader.read.bind(reader);let entered=false,finished=false,idle=false;
    const gate=new Promise<void>(r=>{release=r;});
    reader.read=async path=>{
      if(path==='two.md'){entered=true;if(held)await gate;finished=true;}
      return read(path);
    };
    let nested:Promise<unknown>|undefined,claimed:Promise<unknown>|null=null;
    const reenter=()=>{
      if(nested)return;
      nested=preview(engine,'two.md',()=>true);void nested.catch(()=>{});
      claimed=owner.localRead;
    };
    const host:PolicyHost={snapshot:()=>snapshot,current:()=>true,authority:authority.signal};
    if(accessor==='signal')Object.defineProperty(context,'signal',{get:()=>{reenter();return new AbortController().signal;}});
    else if(accessor==='deadlineUnixMs')Object.defineProperty(context,'deadlineUnixMs',{get:()=>{reenter();return snapshot.deadlineUnixMs;}});
    else Object.defineProperty(host,accessor,{get:()=>{reenter();return accessor==='authority'?authority.signal:undefined;}});
    const outer=engine.evaluateProcessingPolicy(host,context);void outer.catch(()=>{});
    await assert.rejects(outer,/BUSY/);
    assert.ok(nested);assert.ok(claimed);
    if(held){
      const waiting=engine.whenIdle().then(()=>{idle=true;});
      await new Promise<void>(r=>setImmediate(r));
      assert.equal(entered,true);assert.equal(finished,false);assert.equal(idle,false);
      assert.equal(owner.localRead,claimed);
      release();await waiting;
    }
    const proof=await nested;assert.ok(proof);
    assert.equal(previews(),1);assert.equal(finished,true);
    await engine.whenIdle();assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
  }finally{release();await f.cleanup();}
});

for(const outerRoute of ['policy','preview'] as const)
for(const innerRoute of ['policy','preview','graph'] as const)
test('parser accessor admission '+outerRoute+' versus '+innerRoute,{timeout:5000},async()=>{
  const f=await fixture();let release=()=>{};try{
    const {engine,reader,parser,previews}=await f.open();await engine.start();await engine.whenIdle();
    engine.configureGraph({schemaVersion:'oks-06b-mapping-v1',rules:[]});
    const owner=ownerState(engine),context={signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000};
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    const graph=engine.captureGraphScope({mode:'vault-wide'},context.signal);
    const host={snapshot:()=>snapshot,current:()=>true,authority:new AbortController().signal};
    const gate=new Promise<void>(r=>{release=r;});
    const read=reader.read.bind(reader);let entered=false,idle=false,enter=()=>{};
    const started=new Promise<void>(r=>{enter=r;});
    reader.read=async path=>{entered=true;enter();await gate;return read(path);};
    const invoke=(route:typeof innerRoute)=>route==='policy'?engine.evaluateProcessingPolicy(host,context):
      route==='preview'?preview(engine,'two.md',()=>true):graph.read();
    const method=parser.policyMetadata;
    let fired=false,nested:Promise<unknown>|undefined,claimed:Promise<unknown>|null=null;
    Object.defineProperty(parser,'policyMetadata',{get:()=>{
      if(!fired){fired=true;nested=invoke(innerRoute);void nested.catch(()=>{});claimed=owner.localRead;}
      return method;
    }});
    const outer=invoke(outerRoute);await assert.rejects(outer,outerRoute==='policy'?/BUSY/:/PARSER_BUSY/);
    assert.ok(nested);assert.ok(claimed);
    const waiting=engine.whenIdle().then(()=>{idle=true;});
    // A real graph read performs asynchronous catalog I/O before reaching
    // this gate. Wait for the observable dispatch, not a fixed microtask/
    // event-loop count that can expire under full-suite filesystem load.
    await Promise.race([started,nested.then(()=>{throw Error('expected gated read before completion');})]);
    assert.equal(entered,true);assert.equal(idle,false);assert.equal(owner.localRead,claimed);
    release();await nested;await waiting;
    assert.equal(previews(),innerRoute==='graph'?0:1);
    assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
  }finally{release();await f.cleanup();}
});

for(const mode of ['throw','pause','revision','close','host-revoke','source-revoke'] as const)
test('policy accessor invalidation '+mode,async()=>{
  const f=await fixture();try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    const context={signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000};
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    const authority=new AbortController();let closing:Promise<void>|undefined;
    const host={snapshot:()=>snapshot,current:()=>!authority.signal.aborted,get authority(){
      if(mode==='throw')throw Error('synthetic getter failure');
      if(mode==='pause')engine.cancel();
      if(mode==='revision')engine.changed('one.md');
      if(mode==='close')closing=engine.close();
      if(mode==='host-revoke')authority.abort();
      if(mode==='source-revoke')f.change(['one.md']);
      return authority.signal;
    }};
    await assert.rejects(engine.evaluateProcessingPolicy(host,context),
      mode==='throw'?/CONFIG_INVALID/:/BUSY|CANCELLED/);
    await closing;await engine.whenIdle();assert.equal(previews(),0);
    const owner=ownerState(engine);assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
    if(mode==='source-revoke')assert.equal(owner.scopeRetired,true);
    if(mode==='throw'||mode==='host-revoke')assert.equal((await preview(engine,'one.md',()=>true)).sourceId,'one.md');
  }finally{await f.cleanup();}
});

test('throwing accessor cannot release a nested physical reservation',async()=>{
  const f=await fixture();let release=()=>{};try{
    const {engine,reader}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),context={signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000};
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    const gate=new Promise<void>(r=>{release=r;});
    const read=reader.read.bind(reader);let entered=false,idle=false,nested:Promise<unknown>|undefined;
    reader.read=async path=>{entered=true;await gate;return read(path);};
    const host:PolicyHost={snapshot:()=>snapshot,current:()=>true,get authority():AbortSignal{
      nested=preview(engine,'two.md',()=>true);void nested.catch(()=>{});
      throw Error('synthetic getter failure');
    }};
    await assert.rejects(engine.evaluateProcessingPolicy(host,context),/CONFIG_INVALID/);
    assert.ok(nested);assert.ok(owner.localRead);
    const waiting=engine.whenIdle().then(()=>{idle=true;});
    await new Promise<void>(r=>setImmediate(r));
    assert.equal(entered,true);assert.equal(idle,false);assert.ok(owner.localRead);
    release();await nested;await waiting;assert.equal(owner.localRead,null);
  }finally{release();await f.cleanup();}
});

test('bound context capture retains identity and terminal budget',async()=>{
  const context=bindActiveDeadline({signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000},5000);
  assert.equal(captureCallContext(context),context);
  expireActiveDeadline(context);
  assert.throws(()=>bindActiveDeadline(captureCallContext(context),5000),/TIMEOUT/);
  const mutable={signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000};
  const captured=captureCallContext(mutable);
  assert.notEqual(captured,mutable);assert.equal(captured.signal,mutable.signal);
  assert.equal(captured.deadlineUnixMs,mutable.deadlineUnixMs);assert.ok(Object.isFrozen(captured));
});

test('ordinary denied envelope does not outlive original publication deadline',async t=>{
  const f=await fixture();try{
    const {engine,reader}=await f.open();await engine.start();await engine.whenIdle();
    const context={signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000};
    const snapshot={...terminalPolicyFixture(reader.rootId,context.deadlineUnixMs),restrictions:[{scope:'all' as const}]};
    let observed=false;
    f.onConfigRead(()=>{
      if(observed||!(new Error().stack??'').includes('observePublication'))return;
      observed=true;t.mock.method(Date,'now',()=>context.deadlineUnixMs+1);
    });
    await assert.rejects(evaluate(engine,{snapshot:()=>snapshot,current:()=>true},context),/TIMEOUT/);
    assert.equal(observed,true);
  }finally{t.mock.restoreAll();await f.cleanup();}
});


// B-14: the incoming elapsed budget exists independently of a policy digest.
for(const reason of ['source-unresolved','profile-unadmitted','authority-changed'] as const)
for(const stage of ['live','expired','callback-expiry','publication-expiry','cancelled'] as const)
test('early bound policy denial '+reason+' '+stage,async()=>{
  const f=await fixture();try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),abort=new AbortController(),authority=new AbortController();
    const context=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+5000},5000);
    const snapshot={...terminalPolicyFixture(reader.rootId,context.deadlineUnixMs),profile:null};
    let currents=0,snapshots=0,reads=0,observed=false;
    const read=reader.read.bind(reader);reader.read=async path=>{reads++;return read(path);};
    if(stage==='expired')expireActiveDeadline(context);
    if(stage==='cancelled')abort.abort();
    f.onConfigRead(()=>{
      if(stage==='publication-expiry'&&!observed&&(new Error().stack??'').includes('observePublication')){
        observed=true;assert.ok(owner.localSettlement);expireActiveDeadline(context);
      }
    });
    const pending=engine.evaluateProcessingPolicy({
      authority:authority.signal,
      current:()=>{
        currents++;
        if(stage==='callback-expiry'&&reason==='authority-changed')expireActiveDeadline(context);
        return reason!=='authority-changed';
      },
      snapshot:()=>{
        snapshots++;
        if(stage==='callback-expiry')expireActiveDeadline(context);
        return reason==='source-unresolved'?null:snapshot;
      }
    },context);
    if(stage==='publication-expiry'){
      await assert.rejects(pending,/TIMEOUT/);assert.equal(observed,true);
    }else{
      const envelope=await pending;
      assert.equal(envelope.allowed,false);assert.equal(envelope.bindingDigest,null);
      assert.equal(envelope.reason,stage==='expired'||stage==='callback-expiry'?'timeout':stage==='cancelled'?'cancelled':reason);
    }
    await engine.processingPolicyDrain();
    assert.equal(currents,stage==='expired'||stage==='cancelled'?0:1);
    assert.equal(snapshots,stage==='expired'||stage==='cancelled'||reason==='authority-changed'?0:1);
    assert.equal(reads,0);assert.equal(previews(),0);
    assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
  }finally{await f.cleanup();}
});

// B-15: a final callback cannot replace an already-terminal operation budget.
for(const route of ['policy','preview'] as const)
for(const stage of ['live','timeout','cancel','timeout-then-cancel','cancel-then-timeout','timeout-source-revoke','timeout-host-revoke'] as const)
for(const behavior of ['true','false','throw'] as const){
  if(route==='preview'&&stage.includes('cancel'))continue;
  test('B-15 terminal classification '+route+' '+stage+' '+behavior,async t=>{
    const f=await fixture();try{
      const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
      const owner=ownerState(engine),abort=new AbortController(),authority=new AbortController();
      const context=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+5000},5000);
      const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
      if(route==='preview'&&stage.startsWith('timeout'))t.mock.timers.enable({apis:['setTimeout']});
      let finalCalls=0;
      const expire=()=>{if(route==='policy')expireActiveDeadline(context);else t.mock.timers.tick(5001);};
      const current=()=>{
        if(owner.localRead!==null)return true;
        assert.ok(owner.localSettlement);finalCalls++;
        if(stage.startsWith('timeout'))expire();
        if(stage.includes('cancel'))abort.abort();
        if(stage==='cancel-then-timeout')expire();
        if(stage==='timeout-source-revoke')f.change(['one.md']);
        if(stage==='timeout-host-revoke')authority.abort();
        if(behavior==='throw')throw Error('synthetic final failure');
        return behavior==='true';
      };
      const pending=route==='policy'?engine.evaluateProcessingPolicy({snapshot:()=>snapshot,current,authority:authority.signal},context):
        engine.previewPolicyMetadata('one.md',current,false,authority.signal);
      const revoked=stage.endsWith('revoke');
      const denied=route==='policy'?/CANCELLED/:/SOURCE_CHANGED/;
      const expected=revoked?denied:stage.startsWith('timeout')?/TIMEOUT/:stage.startsWith('cancel')?denied:
        behavior==='throw'?/synthetic final failure/:behavior==='false'?denied:null;
      if(expected)await assert.rejects(pending,expected);
      else assert.ok(await pending);
      await engine.processingPolicyDrain();await engine.whenIdle();
      assert.equal(finalCalls,1);assert.equal(previews(),1);
      assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
      assert.equal(owner.scopeRetired,stage==='timeout-source-revoke');
    }finally{t.mock.restoreAll();t.mock.timers.reset();await f.cleanup();}
  });
}

// A terminal logical denial is immutable across late physical success/error,
// but the original physical reservation and owner observation survive it.
for(const route of ['policy','preview'] as const)
for(const stage of ['timeout','cancel'] as const)
for(const late of ['return','throw'] as const){
  if(route==='preview'&&stage==='cancel')continue;
  test('B-15 terminal late physical '+route+' '+stage+' '+late,async t=>{
    const f=await fixture();let release=()=>{};try{
      const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
      const owner=ownerState(engine),abort=new AbortController(),authority=new AbortController();
      const context=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+5000},5000);
      const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
      const read=reader.read.bind(reader);
      let entered=()=>{},reads=0,idle=false;
      const started=new Promise<void>(r=>{entered=r;});
      const gate=new Promise<void>(r=>{release=r;});
      reader.read=async path=>{reads++;entered();await gate;
        if(late==='throw')throw Error('synthetic late read failure');
        return read(path);
      };
      t.mock.timers.enable({apis:['setTimeout']});
      const host={snapshot:()=>snapshot,current:()=>true,authority:authority.signal};
      const pending=route==='policy'?engine.evaluateProcessingPolicy(host,context):
        engine.previewPolicyMetadata('one.md',()=>true,false,authority.signal);
      const settled=route==='preview'?assert.rejects(pending,/PARSER_TIMEOUT/):pending.then(value=>{
        assert.ok('allowed' in value);assert.equal(value.allowed,false);assert.equal(value.reason,stage==='timeout'?'timeout':'cancelled');
      });
      await started;const claimed=owner.localRead;assert.ok(claimed);
      if(stage==='timeout')t.mock.timers.tick(5001);else abort.abort();
      await settled;
      assert.equal(owner.localRead,claimed);assert.equal(owner.localSettlement,null);
      await assert.rejects(engine.evaluateProcessingPolicy(host,context),/BUSY/);
      await assert.rejects(preview(engine,'two.md',()=>true),/PARSER_BUSY/);
      const waiting=engine.whenIdle().then(()=>{idle=true;});
      await new Promise<void>(r=>setImmediate(r));assert.equal(idle,false);
      // Retirement is still observed after an already published denial.
      f.change(['one.md'],false);
      release();await waiting;
      assert.equal(owner.scopeRetired,true);
      assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
      assert.equal(reads,1);assert.equal(previews(),0);
    }finally{release();t.mock.timers.reset();await f.cleanup();}
  });
}

for(const callback of ['current','snapshot'] as const)
for(const stage of ['unbound','bound-live','bound-timeout','bound-cancel'] as const)
test('B-15 admission callback exception '+callback+' '+stage,async()=>{
  const f=await fixture();try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),abort=new AbortController();
    const raw={signal:abort.signal,deadlineUnixMs:Date.now()+5000};
    const context=stage==='unbound'?raw:bindActiveDeadline(raw,5000);
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    let calls=0;
    const failure=():never=>{
      calls++;
      if(stage==='bound-timeout')expireActiveDeadline(context);
      if(stage==='bound-cancel')abort.abort();
      throw Error('synthetic admission failure');
    };
    const envelope=await evaluate(engine,{
      snapshot:()=>callback==='snapshot'?failure():snapshot,
      current:()=>callback==='current'?failure():true
    },context);
    assert.equal(envelope.allowed,false);
    assert.equal(envelope.reason,stage==='bound-timeout'?'timeout':stage==='bound-cancel'?'cancelled':'source-unresolved');
    assert.equal(calls,1);assert.equal(previews(),0);
    await engine.processingPolicyDrain();
    assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
  }finally{await f.cleanup();}
});

// B-16: exceptional admission precedes evaluator/slot creation but still
// has the original bound budget. Use observable typed codes, not regexes.
for(const accessor of ['authority','requireOriginalProof','marking','parser'] as const)
for(const stage of ['unbound','live','expired','cancelled','expire-throw','cancel-throw','expire-cancel','cancel-expire'] as const)
test('B-16 exceptional policy admission '+accessor+' '+stage,async()=>{
  const f=await fixture();try{
    const {engine,reader,parser,previews}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),abort=new AbortController(),authority=new AbortController();
    const raw={signal:abort.signal,deadlineUnixMs:Date.now()+5000};
    const context=stage==='unbound'?raw:bindActiveDeadline(raw,5000);
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    let calls=0,reads=0,callbacks=0;
    const read=reader.read.bind(reader);reader.read=async path=>{reads++;return read(path);};
    if(stage==='expired')expireActiveDeadline(context);
    if(stage==='cancelled')abort.abort();
    const fail=()=>{
      calls++;
      if(stage==='expire-throw'||stage==='expire-cancel')expireActiveDeadline(context);
      if(stage==='cancel-throw'||stage==='expire-cancel'||stage==='cancel-expire')abort.abort();
      if(stage==='cancel-expire')expireActiveDeadline(context);
      throw Error('synthetic admission accessor');
    };
    const host:PolicyHost={authority:authority.signal,current:()=>{callbacks++;return true;},snapshot:()=>{callbacks++;return snapshot;}};
    Object.defineProperty(accessor==='parser'?parser:host,accessor==='parser'?'policyMetadata':accessor,{get:fail});
    const expected=stage==='unbound'||stage==='live'?'CONFIG_INVALID':stage.startsWith('expire')?'TIMEOUT':'CANCELLED';
    await assert.rejects(engine.evaluateProcessingPolicy(host,context),{code:expected});
    assert.equal(calls,1);assert.equal(callbacks,0);assert.equal(reads,0);assert.equal(previews(),0);
    assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
    assert.equal(owner.scopeRetired,false);assert.equal(authority.signal.aborted,false);
  }finally{await f.cleanup();}
});

for(const route of ['policy','preview'] as const)
for(const mode of ['ordinary','host-revoke','source-revoke','pause','revision','close'] as const)
test('B-16 exceptional admission lifecycle '+route+' '+mode,async()=>{
  const f=await fixture();try{
    const {engine,reader,parser,previews}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),authority=new AbortController();
    const context=bindActiveDeadline({signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000},5000);
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    const method=parser.policyMetadata;let calls=0,closing:Promise<void>|undefined;
    Object.defineProperty(parser,'policyMetadata',{configurable:true,get:()=>{
      calls++;
      if(route==='policy'&&mode!=='ordinary')expireActiveDeadline(context);
      if(mode==='host-revoke')authority.abort();
      if(mode==='source-revoke')f.change(['one.md'],false);
      if(mode==='pause')engine.cancel();
      if(mode==='revision')engine.changed('one.md');
      if(mode==='close')closing=engine.close();
      throw Error('synthetic parser accessor');
    }});
    const result=route==='policy'?engine.evaluateProcessingPolicy({authority:authority.signal,snapshot:()=>snapshot,current:()=>true},context):
      engine.previewPolicyMetadata('one.md',()=>true,false,authority.signal);
    const expected=route==='policy'?(mode==='ordinary'?'CONFIG_INVALID':'CANCELLED'):
      mode==='ordinary'?'PARSER_BUSY':mode==='source-revoke'?'SEARCH_SCOPE_INVALID':'SOURCE_CHANGED';
    await assert.rejects(result,{code:expected});
    assert.equal(calls,1);assert.equal(previews(),0);
    assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
    assert.equal(owner.scopeRetired,mode==='source-revoke');
    Object.defineProperty(parser,'policyMetadata',{value:method});
    await closing;await engine.whenIdle();
  }finally{await f.cleanup();}
});

for(const stage of ['expire','cancel'] as const)
test('B-16 terminal exceptional admission preserves competing physical drain '+stage,async()=>{
  const f=await fixture();let release=()=>{};try{
    const {engine,reader,previews}=await f.open();await engine.start();await engine.whenIdle();
    const owner=ownerState(engine),abort=new AbortController(),authority=new AbortController();
    const context=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+5000},5000);
    const snapshot=terminalPolicyFixture(reader.rootId,context.deadlineUnixMs);
    let nested:Promise<unknown>|undefined,claimed:Promise<unknown>|null=null,entered=false,idle=false;
    const gate=new Promise<void>(r=>{release=r;});
    const read=reader.read.bind(reader);reader.read=async path=>{entered=true;await gate;return read(path);};
    const host:PolicyHost={authority:authority.signal,current:()=>true,snapshot:()=>snapshot,get marking():never{
      nested=preview(engine,'two.md',()=>true);void nested.catch(()=>{});claimed=owner.localRead;
      if(stage==='expire')expireActiveDeadline(context);else abort.abort();
      throw Error('synthetic reentrant accessor');
    }};
    const outer=engine.evaluateProcessingPolicy(host,context);
    await assert.rejects(outer,{code:stage==='expire'?'TIMEOUT':'CANCELLED'});
    assert.ok(nested);assert.ok(claimed);assert.equal(owner.localRead,claimed);
    const waiting=engine.whenIdle().then(()=>{idle=true;});
    await new Promise<void>(r=>setImmediate(r));assert.equal(entered,true);assert.equal(idle,false);
    await assert.rejects(engine.evaluateProcessingPolicy(host,context),{code:'BUSY'});
    assert.equal(owner.localRead,claimed);
    release();await nested;await waiting;
    assert.equal(previews(),1);assert.equal(owner.localRead,null);assert.equal(owner.localSettlement,null);
  }finally{release();await f.cleanup();}
});
