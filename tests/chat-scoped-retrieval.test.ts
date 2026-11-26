import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {SearchController,uiRequest} from '../plugin/src/search/controller';
import {hash,type EvidenceHit,type SearchResponse,type SearchRequest} from '../plugin/src/standalone/contracts';
import {type ChatScopeLease} from '../plugin/src/standalone/engine';
import {parseMarkdown} from '../plugin/src/standalone/markdown';
import {type ProviderConfig} from '../plugin/src/ai/contracts';

const generation=hash('chat-scoped-retrieval'),root=hash('synthetic-root');
const selector={mode:'vault-wide'} as const;
const request={requestId:'turn',query:'synthetic',limit:1};
const doc=parseMarkdown('fixture.md',Buffer.from('synthetic evidence\n'),root);
const block=doc.blocks[0]!;
const hit:EvidenceHit={sourceId:doc.sourceId,sourceSha256:doc.sha256,originalExcerpt:block.originalText,
  sourceLocators:[block.locator],rank:1,lexicalRank:1,retrievalMode:'lexical',indexGenerationId:generation,
  score:1,headings:[],wikiLinks:[],properties:[]};
const response=(requestId='turn'):SearchResponse=>({protocolVersion:2,requestId,requestedMode:'lexical',executedMode:'lexical',
  status:'ok',error:null,indexGenerationId:generation,hits:[structuredClone(hit)],staleSourceCount:0,
  capabilityReadiness:{lexical:'ready',dense:'unavailable'}});
const status=()=>({status:'ready' as const,generationId:generation,sources:1,records:1,busy:false,error:null,maintenanceWarning:null});
const deferred=<T>()=>{let resolve!: (value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const error=(code:string)=>({apiVersion:1,ok:false,error:code});
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const lease=(patch:Partial<ChatScopeLease>={}):ChatScopeLease=>({
  snapshot:{selector,rootId:root,generationId:generation,sources:[{sourceId:doc.sourceId,sourceSha256:doc.sha256}],
    coverage:{eligible:1,excluded:0,partial:0,unsupported:'unknown'}},
  current:()=>true,verify:async()=>{},search:async req=>response(req.requestId),...patch});
const engine=(captureChatScope?:(value:unknown,signal:AbortSignal)=>Promise<ChatScopeLease>)=>({
  search:async(req:SearchRequest)=>response(req.requestId),status,cancel:()=>true,resume:()=>{},rebuild:()=>{},captureChatScope});
const reply=(res:ServerResponse,value:unknown)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
async function generationFixture(run:(config:ProviderConfig)=>Promise<void>,handler:(req:IncomingMessage,res:ServerResponse)=>void):Promise<void>{
  const server=createServer(handler);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const address=server.address();if(!address||typeof address==='string')throw Error('FIXTURE_ADDRESS');
    await run({state:'configured',transport:'local',origin:`http://127.0.0.1:${address.port}`,
      identity:{model:'synthetic-generator',revision:'fixture-v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1}});
  } finally {server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
const generated=(claims:unknown)=>({model:'synthetic-generator@fixture-v1',usage:{completion_tokens:4},choices:[{index:0,finish_reason:'stop',
  message:{role:'assistant',content:JSON.stringify({claims})}}]});

test('06H.2-A2b1: admission validates before capture, preserves one physical slot and exact cancel capability',async()=>{
  const c=new SearchController(async()=>{});
  try {
    c.attach(engine());
    assert.deepEqual(await c.startScopedChatRetrieval(selector,request).result,error('CAPABILITY_UNAVAILABLE'));
    const capture=deferred<ChatScopeLease>();let calls=0,signal:AbortSignal|undefined;
    c.attach(engine(async(_value,s)=>{calls++;signal=s;return capture.promise;}));
    assert.deepEqual(await c.startScopedChatRetrieval({mode:'selected',kind:'files',sourceIds:[{}]},request).result,error('SCOPE_INVALID'));
    assert.deepEqual(await c.startScopedChatRetrieval(selector,{...request,scope:['fixture.md']}).result,error('INVALID_REQUEST'));
    const first=c.startScopedChatRetrieval(selector,request);
    const blocked=c.startScopedChatRetrieval(selector,request);
    assert.deepEqual(await blocked.result,error('BUSY'));blocked.cancel();
    assert.equal(signal?.aborted,false);
    first.cancel();
    assert.deepEqual(await first.result,error('CANCELLED'));assert.equal(signal?.aborted,true);
    assert.deepEqual(await c.startScopedChatRetrieval(selector,request).result,error('BUSY'));
    capture.resolve(lease());await flush();
    const next=c.startScopedChatRetrieval(selector,request);first.cancel();
    assert.equal((await next.result).ok,true);assert.equal(calls,2);
  } finally {c.dispose();}
});

test('06H.2-A2b1: basic search supersedes chat immediately, drain does not block offline search',async()=>{
  const c=new SearchController(async()=>{}),capture=deferred<ChatScopeLease>();
  try {
    c.attach(engine(async()=>capture.promise));
    const turn=c.startScopedChatRetrieval(selector,request);
    const ordinary=await c.search(uiRequest('ordinary',1));
    assert.equal(ordinary.ok,true);
    assert.deepEqual(await turn.result,error('SUPERSEDED'));
    assert.deepEqual(await c.startScopedChatRetrieval(selector,request).result,error('BUSY'));
    capture.resolve(lease());await flush();
    assert.equal(c.snapshot().response?.hits.length,1);
    assert.equal((await c.startScopedChatRetrieval(selector,request).result).ok,true);
  } finally {c.dispose();}
});

test('06H.2-A2b1: capture/search/verify retirement and terminal seal precede abort callbacks',async()=>{
  for(const boundary of ['capture','search','verify'] as const){
    const c=new SearchController(async()=>{}),gate=deferred<void>(),entered=deferred<void>();
    let signal:AbortSignal|undefined,reentered:ReturnType<SearchController['startScopedChatRetrieval']>|undefined;
    const hold=async(name:typeof boundary)=>{if(name===boundary){entered.resolve();await gate.promise;}};
    try {
      c.attach(engine(async(_value,s)=>{signal=s;s.addEventListener('abort',()=>{reentered=c.startScopedChatRetrieval(selector,request);});
        await hold('capture');return lease({search:async()=>{await hold('search');return response();},verify:async()=>hold('verify')});}));
      const turn=c.startScopedChatRetrieval(selector,request);await entered.promise;
      c.sealTerminal();
      assert.equal(signal?.aborted,false);assert.deepEqual(await turn.result,error('SUPERSEDED'));
      c.dispose();assert.equal(signal?.aborted,true);assert.deepEqual(await reentered?.result,error('DISABLED'));
      gate.resolve();await flush();
    } finally {gate.resolve();c.dispose();}
  }
});

test('06H.2-A2b1: generation preview and chat are mutually exclusive without consuming foreign consent',async()=>{
  const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
    identity:{model:'synthetic',revision:'v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1}};
  const c=new SearchController(async()=>{},undefined,undefined,undefined,{config:()=>config,scopeId:()=>root,verify:async()=>{}});
  const gate=deferred<ChatScopeLease>();
  try{
    c.attach(engine(async()=>gate.promise));await c.search(uiRequest('synthetic',1));
    const preview=c.prepareGeneration('fixture');
    assert.deepEqual(await c.startScopedChatRetrieval(selector,request).result,error('BUSY'));
    assert.equal(c.snapshot().response?.hits.length,1);
    c.cancelGeneration();
    const turn=c.startScopedChatRetrieval(selector,request);
    assert.throws(()=>c.prepareGeneration('fixture'),{message:'BUSY'});
    await assert.rejects(c.generationConfirmed(preview,'synthetic'),{message:'BUSY'});
    gate.resolve(lease());assert.equal((await turn.result).ok,true);
    assert.equal(c.prepareGeneration('fixture').role,'generation');
  }finally{gate.resolve(lease());c.dispose();}
});

test('06H.2-A2b1: settings/source drift and elapsed deadlines fail closed',async t=>{
  const cfg:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
    identity:{model:'synthetic',revision:'v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1}};
  const gate=deferred<ChatScopeLease>(),c=new SearchController(async()=>{},undefined,undefined,undefined,
    {config:()=>cfg,scopeId:()=>root,verify:async()=>{}});
  try{
    c.attach(engine(async()=>gate.promise));
    const turn=c.startScopedChatRetrieval(selector,request);
    cfg.identity.revision='v2';gate.resolve(lease());
    assert.deepEqual(await turn.result,error('SCOPE_CHANGED'));
    const pending=deferred<ChatScopeLease>();c.attach(engine(async()=>pending.promise));
    const start=Date.now();t.mock.method(Date,'now',()=>start);
    const expired=c.startScopedChatRetrieval(selector,request);
    t.mock.method(Date,'now',()=>start+31000);
    pending.resolve(lease());assert.deepEqual(await expired.result,error('TIMEOUT'));
  }finally{c.dispose();}
});

test('06H.2-A2b1: failed physical abort latches existing retirement fault until explicit rebuild',async t=>{
  const c=new SearchController(async()=>{}),capture=deferred<ChatScopeLease>();
  let signal:AbortSignal|undefined;
  try{
    c.attach(engine(async(_value,s)=>{signal=s;return capture.promise;}));
    const turn=c.startScopedChatRetrieval(selector,request);
    const abort=t.mock.method(AbortController.prototype,'abort',()=>{throw new Error('synthetic fault');});
    turn.cancel();
    assert.deepEqual(await turn.result,error('CANCELLED'));assert.equal(signal?.aborted,false);
    assert.equal((await c.search(uiRequest('synthetic',1))).ok,false);
    assert.equal((await c.startScopedChatRetrieval(selector,request).result).ok,false);
    abort.mock.restore();
    assert.equal(c.control('rebuild').ok,true);
    assert.equal(signal?.aborted,true);
    assert.deepEqual(await c.startScopedChatRetrieval(selector,request).result,error('BUSY'));
    capture.resolve(lease());await flush();
    assert.equal((await c.search(uiRequest('synthetic',1))).ok,true);
  }finally{capture.resolve(lease());c.dispose();}
});

test('06H.2-A2b1: reserve ownership before config and engine callbacks can reenter',async()=>{
  let nested:ReturnType<SearchController['startScopedChatRetrieval']>|undefined;
  let c:SearchController;
  const config=()=>{nested=c.startScopedChatRetrieval(selector,request);return {state:'disabled' as const};};
  c=new SearchController(async()=>{},undefined,undefined,undefined,{config,scopeId:()=>root,verify:async()=>{}});
  try{
    c.attach(engine(async()=>lease()));
    assert.equal((await c.startScopedChatRetrieval(selector,request).result).ok,true);
    assert.deepEqual(await nested?.result,error('BUSY'));
    const capture=deferred<ChatScopeLease>();
    c.attach(engine(async()=>capture.promise));
    const turn=c.startScopedChatRetrieval(selector,request);
    c.beginRuntimeSettingsChange(undefined,false);
    assert.deepEqual(await turn.result,error('SUPERSEDED'));
    c.endRuntimeSettingsChange();
    assert.deepEqual(await c.startScopedChatRetrieval(selector,request).result,error('BUSY'));
    capture.resolve(lease());await flush();
  }finally{c.dispose();}
});

test('06H.2-A2b1: source invalidation retires all three held boundaries before physical abort and drain',async()=>{
  for(const boundary of ['capture','search','verify'] as const){
    const c=new SearchController(async()=>{}),gate=deferred<void>(),entered=deferred<void>();
    let signal:AbortSignal|undefined,calls=0,revokedAtAbort=false,sourceRetired=false;
    let nested:ReturnType<SearchController['startScopedChatRetrieval']>|undefined;
    const initial=c.sourceAuthorityRevision();
    const hold=async(name:typeof boundary)=>{if(name===boundary){entered.resolve();await gate.promise;}};
    try{
      c.attach(engine(async(_value,s)=>{
        calls++;signal=s;
        s.addEventListener('abort',()=>{
          revokedAtAbort=!c.sourceAuthorityCurrent(initial);
          nested=c.startScopedChatRetrieval(selector,request);
        });
        await hold('capture');
        return lease({search:async()=>{await hold('search');return response();},verify:async()=>hold('verify')});
      }));
      const turn=c.startScopedChatRetrieval(selector,request);await entered.promise;
      c.invalidateSource([()=>{sourceRetired=true;}]);
      assert.equal(c.sourceAuthorityCurrent(initial),false);
      assert.deepEqual(await turn.result,error('SUPERSEDED'));
      assert.equal(signal?.aborted,true);assert.equal(revokedAtAbort,true);assert.equal(sourceRetired,true);
      assert.equal((await nested?.result)?.ok,false);
      assert.deepEqual(await c.startScopedChatRetrieval(selector,request).result,error('BUSY'));
      assert.equal(calls,1);gate.resolve();await flush();
      assert.deepEqual(await turn.result,error('SUPERSEDED'));
      assert.equal(c.snapshot().response,null);
      assert.equal((await c.startScopedChatRetrieval(selector,request).result).ok,true);
      assert.equal(calls,2);
    }finally{gate.resolve();c.dispose();}
  }
});

test('06H.2-A2b2a: retained owner keeps shared admission and detached evidence after retrieval',async()=>{
  const c=new SearchController(async()=>{}),other=new SearchController(async()=>{});
  let verifies=0, captures=0;
  try{
    c.attach(engine(async()=>{captures++;return lease({verify:async()=>{verifies++;}});}));
    other.attach(engine(async()=>lease()));
    const session=c.openRetainedChatSession(),second=c.openRetainedChatSession(),foreign=other.openRetainedChatSession();
    const first=c.startRetainedChatTurn(session,selector,request);
    const result=await first.result;
    assert.equal(result.ok,true);
    if(!result.ok)throw Error('expected verified response');
    result.value.hits[0]!.originalExcerpt='mutated detached response';
    assert.deepEqual(await c.startRetainedChatTurn(second,selector,request).result,error('BUSY'));
    assert.deepEqual(await c.startScopedChatRetrieval(selector,request).result,error('BUSY'));
    assert.deepEqual(await c.startRetainedChatTurn(foreign,selector,request).result,error('SUPERSEDED'));
    assert.deepEqual(await other.readRetainedChatTurn(session,first.owner),error('SUPERSEDED'));
    assert.deepEqual(await c.readRetainedChatTurn(second,first.owner),error('SUPERSEDED'));
    assert.deepEqual(await c.readRetainedChatTurn(session,structuredClone(first.owner)),error('SUPERSEDED'));
    c.cancelRetainedChatTurn(second,first.owner);
    assert.throws(()=>c.prepareGeneration('fixture'),{message:'BUSY'});
    const view=await c.readRetainedChatTurn(session,first.owner);
    assert.equal(view.ok,true);
    if(!view.ok)throw Error('expected verified view');
    assert.equal(view.value.response.hits[0]!.originalExcerpt,hit.originalExcerpt);
    assert.equal(view.value.scope.coverage.eligible,1);
    view.value.scope.sources.length=0;
    const again=await c.readRetainedChatTurn(session,first.owner);
    assert.equal(again.ok&&again.value.scope.sources.length,1);
    assert.equal(verifies,3);assert.equal(captures,1);
    c.cancelRetainedChatTurn(session,first.owner);
    assert.deepEqual(await c.readRetainedChatTurn(session,first.owner),error('SUPERSEDED'));
    const next=c.startRetainedChatTurn(session,selector,request);
    c.cancelRetainedChatTurn(session,first.owner);
    assert.equal((await next.result).ok,true);
    c.closeRetainedChatSession(session);
    assert.deepEqual(await c.readRetainedChatTurn(session,next.owner),error('SUPERSEDED'));
    assert.deepEqual(await c.startRetainedChatTurn(session,selector,request).result,error('SUPERSEDED'));
    assert.equal((await c.startRetainedChatTurn(second,selector,request).result).ok,true);
  }finally{c.dispose();other.dispose();}
});

test('06H.2-A2b2a: owner retirement fences reentrant callbacks and retains physical verification drain',async()=>{
  const c=new SearchController(async()=>{}),entered=deferred<void>(),gate=deferred<void>();
  const session=c.openRetainedChatSession(),nextSession=c.openRetainedChatSession();
  let checks=0,signal:AbortSignal|undefined;
  let reentry:ReturnType<SearchController['startRetainedChatTurn']>|undefined;
  try{
    c.attach(engine(async(_selector,s)=>{
      signal=s;
      s.addEventListener('abort',()=>{reentry=c.startRetainedChatTurn(nextSession,selector,request);});
      return lease({verify:async()=>{if(++checks===2){entered.resolve();await gate.promise;}}});
    }));
    const turn=c.startRetainedChatTurn(session,selector,request);assert.equal((await turn.result).ok,true);
    const reading=c.readRetainedChatTurn(session,turn.owner);await entered.promise;
    assert.deepEqual(await c.readRetainedChatTurn(session,turn.owner),error('BUSY'));
    c.cancelRetainedChatTurn(session,turn.owner);
    assert.deepEqual(await reading,error('CANCELLED'));
    assert.equal(signal?.aborted,true);
    assert.deepEqual(await reentry?.result,error('BUSY'));
    assert.deepEqual(await c.startRetainedChatTurn(nextSession,selector,request).result,error('BUSY'));
    assert.equal((await c.search(uiRequest('ordinary',1))).ok,true);
    gate.resolve();await flush();
    assert.equal((await c.startRetainedChatTurn(nextSession,selector,request).result).ok,true);
  }finally{gate.resolve();c.dispose();}
});

test('06H.2-A2b2a: drift, elapsed deadline and terminal sealing retire retained rights',async t=>{
  const cfg:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
    identity:{model:'synthetic',revision:'v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1}};
  let verifies=0,networkVerifies=0,signal:AbortSignal|undefined;
  const c=new SearchController(async()=>{},undefined,undefined,undefined,
    {config:()=>cfg,scopeId:()=>root,verify:async()=>{networkVerifies++;}});
  try{
    c.attach(engine(async(_selector,s)=>{signal=s;return lease({verify:async()=>{verifies++;}});}));
    const session=c.openRetainedChatSession();
    const first=c.startRetainedChatTurn(session,selector,request);assert.equal((await first.result).ok,true);
    cfg.identity.revision='v2';
    assert.deepEqual(await c.readRetainedChatTurn(session,first.owner),error('SCOPE_CHANGED'));
    assert.equal(verifies,1);assert.equal(signal?.aborted,true);
    const second=c.startRetainedChatTurn(session,selector,request);assert.equal((await second.result).ok,true);
    c.invalidateSource([]);
    assert.deepEqual(await c.readRetainedChatTurn(session,second.owner),error('SUPERSEDED'));
    const third=c.startRetainedChatTurn(session,selector,request);assert.equal((await third.result).ok,true);
    c.attach(engine(async()=>lease()));
    assert.deepEqual(await c.readRetainedChatTurn(session,third.owner),error('SUPERSEDED'));
    const start=Date.now();t.mock.method(Date,'now',()=>start);
    const fourth=c.startRetainedChatTurn(session,selector,request);assert.equal((await fourth.result).ok,true);
    t.mock.method(Date,'now',()=>start+31000);
    assert.deepEqual(await c.readRetainedChatTurn(session,fourth.owner),error('TIMEOUT'));
    t.mock.restoreAll();
    const fifth=c.startRetainedChatTurn(session,selector,request);assert.equal((await fifth.result).ok,true);
    c.sealTerminal();
    assert.deepEqual(await c.readRetainedChatTurn(session,fifth.owner),error('SUPERSEDED'));
    assert.deepEqual(await c.startRetainedChatTurn(session,selector,request).result,error('DISABLED'));
    assert.throws(()=>c.openRetainedChatSession(),{message:'DISABLED'});
    assert.equal(networkVerifies,0);
  }finally{c.dispose();}
});

test('06H.2-A2b2a: sessions bounded and failed retirement blocks fresh admission',async t=>{
  const c=new SearchController(async()=>{});let signal:AbortSignal|undefined;
  try{
    c.attach(engine(async(_selector,s)=>{signal=s;return lease();}));
    const sessions=Array.from({length:4},()=>c.openRetainedChatSession());
    assert.throws(()=>c.openRetainedChatSession(),{message:'LIMIT_EXCEEDED'});
    c.closeRetainedChatSession(sessions[3]!);
    const other=c.openRetainedChatSession();
    const turn=c.startRetainedChatTurn(sessions[0]!,selector,request);assert.equal((await turn.result).ok,true);
    const abort=t.mock.method(AbortController.prototype,'abort',()=>{throw Error('synthetic fault');});
    c.cancelRetainedChatTurn(sessions[0]!,turn.owner);
    assert.equal(signal?.aborted,false);
    assert.deepEqual(await c.readRetainedChatTurn(sessions[0]!,turn.owner),error('SUPERSEDED'));
    assert.equal((await c.startRetainedChatTurn(other,selector,request).result).ok,false);
    abort.mock.restore();
    assert.equal(c.control('rebuild').ok,true);
    assert.equal(signal?.aborted,true);
    assert.equal((await c.startRetainedChatTurn(other,selector,request).result).ok,true);
  }finally{c.dispose();}
});

test('06H.2-A2b2b1: credential epochs are host-local, replace same input and revoke on clear/retirement',async()=>{
  const cfg:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
    identity:{model:'synthetic',revision:'v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1}};
  const port={config:()=>cfg,scopeId:()=>root,verify:async()=>{throw Error('unexpected generation');}};
  const c=new SearchController(async()=>{},undefined,undefined,undefined,port),other=new SearchController(async()=>{},undefined,undefined,undefined,port);
  try{
    c.attach(engine(async()=>lease()));other.attach(engine(async()=>lease()));
    const session=c.openRetainedChatSession(),foreign=other.openRetainedChatSession();
    const turn=c.startRetainedChatTurn(session,selector,request),second=other.startRetainedChatTurn(foreign,selector,request);
    assert.equal((await turn.result).ok,true);assert.equal((await second.result).ok,true);
    const authority=(c as unknown as {generationCredential:import('../plugin/src/ai/generation-credential').GenerationCredentialAuthority}).generationCredential;
    const binding=(await import('../plugin/src/ai/disclosure')).configDigest('generation',cfg);
    const a=await c.bindRetainedGenerationCredential(session,turn.owner,'synthetic-token');
    const b=await c.bindRetainedGenerationCredential(session,turn.owner,'synthetic-token');
    assert.equal(a.hostId,b.hostId);assert.ok(b.epoch>a.epoch);
    assert.equal(authority.current(turn.owner,binding,a),false);
    assert.equal(authority.current(turn.owner,binding,b),true);
    assert.equal(authority.current({},binding,b),false);
    assert.equal(authority.current(turn.owner,'wrong',b),false);
    const x=await other.bindRetainedGenerationCredential(foreign,second.owner,'synthetic-token');
    assert.notEqual(x.hostId,a.hostId);
    assert.deepEqual(Object.keys(a).sort(),['epoch','hostId']);
    await assert.rejects(c.bindRetainedGenerationCredential(foreign,turn.owner,'synthetic-token'),{message:'CANCELLED'});
    await assert.rejects(c.bindRetainedGenerationCredential(session,{},'synthetic-token'),{message:'CANCELLED'});
    await assert.rejects(c.bindRetainedGenerationCredential(session,turn.owner,'bad\n'),{message:'UNAUTHENTICATED'});
    c.clearRetainedGenerationCredential(session,turn.owner);
    const d=await c.bindRetainedGenerationCredential(session,turn.owner,'different-token');
    assert.ok(d.epoch>b.epoch);
    assert.equal(authority.current(turn.owner,binding,d),true);
    assert.equal(JSON.stringify(authority).includes('different-token'),false);
    assert.equal(JSON.stringify(c.snapshot()).includes('different-token'),false);
    assert.throws(()=>c.prepareGeneration('fixture'),{message:'BUSY'});
    c.cancelRetainedChatTurn(session,turn.owner);
    assert.equal(authority.current(turn.owner,binding,d),false);
    await assert.rejects(c.bindRetainedGenerationCredential(session,turn.owner,'synthetic-token'),{message:'CANCELLED'});
    assert.equal((await c.search(uiRequest('offline',1))).ok,true);
  }finally{c.dispose();other.dispose();}
});

test('06H.2-A2b2b1: outstanding resolver is logically revoked before abort, late results never bind',async()=>{
  const cfg:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
    identity:{model:'synthetic',revision:'v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1}};
  for(const action of ['clear','replace','source','unload','config'] as const){
    const pending=deferred<string|null>();let signal:AbortSignal|undefined,calls=0;
    const c=new SearchController(async()=>{},undefined,undefined,undefined,
      {config:()=>cfg,scopeId:()=>root,verify:async()=>{throw Error('unexpected generation');}},undefined,
      {resolve:async(role,config,s)=>{assert.equal(role,'generation');assert.equal(config.identity.revision,cfg.identity.revision);calls++;signal=s;return pending.promise;}});
    try{
      c.attach(engine(async()=>lease()));
      const session=c.openRetainedChatSession(),turn=c.startRetainedChatTurn(session,selector,request);
      assert.equal((await turn.result).ok,true);
      const work=c.resolveRetainedGenerationCredential(session,turn.owner);
      const rejected=assert.rejects(work,{message:'CANCELLED'});
      assert.equal(calls,1);
      if(action==='clear')c.clearRetainedGenerationCredential(session,turn.owner);
      if(action==='replace')await assert.rejects(c.bindRetainedGenerationCredential(session,turn.owner,'new-token'),{message:'BUSY'});
      if(action==='source')c.invalidateSource([]);
      if(action==='unload')c.dispose();
      if(action==='config')cfg.identity.revision='v2';
      if(action!=='config'){await rejected;assert.equal(signal?.aborted,true);}
      pending.resolve('late-token');await rejected;await flush();
      await assert.rejects(c.bindRetainedGenerationCredential(session,turn.owner,'new-token'),{message:'CANCELLED'});
      assert.equal(JSON.stringify(c.snapshot()).includes('late-token'),false);
      if(action!=='unload')assert.equal((await c.search(uiRequest('offline',1))).ok,true);
    }finally{pending.resolve(null);cfg.identity.revision='v1';c.dispose();}
  }
});

test('06H.2-A2b2b1: trusted resolver success, absent resolver and expiry fail closed',async t=>{
  const cfg:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
    identity:{model:'synthetic',revision:'v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1}};
  const port={config:()=>cfg,scopeId:()=>root,verify:async()=>{}};
  const pending=deferred<string|null>();let calls=0;
  const c=new SearchController(async()=>{},undefined,undefined,undefined,port,undefined,
    {resolve:async()=>++calls===1?'resolved-token':pending.promise});
  const other=new SearchController(async()=>{},undefined,undefined,undefined,port);
  try{
    c.attach(engine(async()=>lease()));other.attach(engine(async()=>lease()));
    const session=c.openRetainedChatSession(),turn=c.startRetainedChatTurn(session,selector,request);
    const foreign=other.openRetainedChatSession(),otherTurn=other.startRetainedChatTurn(foreign,selector,request);
    assert.equal((await turn.result).ok,true);assert.equal((await otherTurn.result).ok,true);
    await assert.rejects(other.resolveRetainedGenerationCredential(foreign,otherTurn.owner),{message:'NOT_READY'});
    const stamp=await c.resolveRetainedGenerationCredential(session,turn.owner);
    assert.equal(typeof stamp.epoch,'number');assert.equal(JSON.stringify(c.snapshot()).includes('resolved-token'),false);
    const start=Date.now();t.mock.method(Date,'now',()=>start);
    const work=c.resolveRetainedGenerationCredential(session,turn.owner);
    const rejected=assert.rejects(work,{message:'TIMEOUT'});
    t.mock.method(Date,'now',()=>start+31000);pending.resolve('expired-token');await rejected;
    assert.equal(JSON.stringify(c.snapshot()).includes('expired-token'),false);
  }finally{pending.resolve(null);c.dispose();other.dispose();}
});

test('06H.2-A2b2b1: exact attempt completion, terminal seal and overflow arithmetic',async()=>{
  const {GenerationCredentialAuthority,nextCredentialEpoch}=await import('../plugin/src/ai/generation-credential');
  const authority=new GenerationCredentialAuthority(),owner={},other={};
  const first=authority.begin(owner,'config'),second=authority.begin(owner,'config');
  assert.throws(()=>authority.complete(first,'synthetic'),{message:'CANCELLED'});
  const stamp=authority.complete(second,'synthetic');
  authority.revoke(other);assert.equal(authority.current(owner,'config',stamp),true);
  assert.throws(()=>authority.complete(second,'synthetic'),{message:'CANCELLED'});
  authority.seal();assert.equal(authority.current(owner,'config',stamp),false);
  assert.throws(()=>authority.begin(owner,'config'),{message:'NOT_READY'});
  assert.equal(nextCredentialEpoch(Number.MAX_SAFE_INTEGER-1),Number.MAX_SAFE_INTEGER);
  for(const epoch of [Number.MAX_SAFE_INTEGER,Infinity,-1,0.5])assert.throws(()=>nextCredentialEpoch(epoch),{message:'NOT_READY'});
});

test('06H.2-A2b2b1: resolver reentry cannot bind or admit a second turn before drain',async()=>{
  const cfg:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
    identity:{model:'synthetic',revision:'v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1}};
  const pending=deferred<string|null>();
  let c:SearchController,session:object,owner:object,reentered:Promise<unknown>|undefined;
  let admitted:ReturnType<SearchController['startRetainedChatTurn']>|undefined;
  c=new SearchController(async()=>{},undefined,undefined,undefined,{config:()=>cfg,scopeId:()=>root,verify:async()=>{}},undefined,
    {resolve:async(_role,_config,signal)=>{
      signal.addEventListener('abort',()=>{
        reentered=assert.rejects(c.bindRetainedGenerationCredential(session,owner,'reentrant'),{message:'CANCELLED'});
        admitted=c.startRetainedChatTurn(session,selector,request);
      });
      return pending.promise;
    }});
  try{
    c.attach(engine(async()=>lease()));session=c.openRetainedChatSession();
    const turn=c.startRetainedChatTurn(session,selector,request);owner=turn.owner;
    assert.equal((await turn.result).ok,true);
    const rejected=assert.rejects(c.resolveRetainedGenerationCredential(session,owner),{message:'CANCELLED'});
    c.clearRetainedGenerationCredential(session,owner);
    await rejected;await reentered;
    assert.deepEqual(await admitted?.result,error('BUSY'));
    assert.deepEqual(await c.startRetainedChatTurn(session,selector,request).result,error('BUSY'));
    pending.resolve('late');await flush();
    assert.equal((await c.startRetainedChatTurn(session,selector,request).result).ok,true);
  }finally{pending.resolve(null);c.dispose();}
});

test('06H.2-A2b2b1: every changed resolver configuration/scope invalidates the old epoch before commit',async()=>{
  for(const field of ['model','revision','origin','scope','limits'] as const){
    const cfg:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
      identity:{model:'synthetic',revision:'v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1}};
    const pending=deferred<string|null>();let scope=root,signal:AbortSignal|undefined;
    const c=new SearchController(async()=>{},undefined,undefined,undefined,
      {config:()=>cfg,scopeId:()=>scope,verify:async()=>{}},undefined,
      {resolve:async(_role,_cfg,s)=>{signal=s;return pending.promise;}});
    try{
      c.attach(engine(async()=>lease()));
      const session=c.openRetainedChatSession(),turn=c.startRetainedChatTurn(session,selector,request);
      assert.equal((await turn.result).ok,true);
      const stamp=await c.bindRetainedGenerationCredential(session,turn.owner,'previous');
      const authority=(c as unknown as {generationCredential:import('../plugin/src/ai/generation-credential').GenerationCredentialAuthority}).generationCredential;
      const digest=(await import('../plugin/src/ai/disclosure')).configDigest('generation',cfg);
      const result=assert.rejects(c.resolveRetainedGenerationCredential(session,turn.owner),{message:'CANCELLED'});
      assert.equal(authority.current(turn.owner,digest,stamp),false);
      if(field==='model')cfg.identity.model='changed';
      if(field==='revision')cfg.identity.revision='v2';
      if(field==='origin')cfg.origin='http://127.0.0.1:2';
      if(field==='scope')scope=hash('different-root');
      if(field==='limits')cfg.limits.maxOutputTokens=64;
      pending.resolve('late-token');await result;await flush();
      assert.equal(signal?.aborted,true);
      await assert.rejects(c.bindRetainedGenerationCredential(session,turn.owner,'new-token'),{message:'CANCELLED'});
      assert.equal(authority.current(turn.owner,digest,stamp),false);
    }finally{pending.resolve(null);c.dispose();}
  }
});

test('06H.2-A2b2c: retained chat sends only separately attested exact question and evidence once',async()=>{
  let calls=0,authorization='',received:unknown;
  await generationFixture(async cfg=>{
    const port={config:()=>cfg,scopeId:()=>root,verify:async(candidate:EvidenceHit)=>assert.deepEqual(candidate,hit)};
    const c=new SearchController(async()=>{},undefined,undefined,undefined,port);
    try {
      c.attach(engine(async()=>lease()));const session=c.openRetainedChatSession();
      const turn=c.startRetainedChatTurn(session,selector,request);assert.equal((await turn.result).ok,true);
      const stamp=await c.bindRetainedGenerationCredential(session,turn.owner,'synthetic-token');
      let draft=c.createRetainedChatClassificationDraft(session,turn.owner,stamp);
      assert.equal(draft.question.classification,'unknown');assert.equal(draft.evidence[0]!.classification,'unknown');
      await assert.rejects(c.prepareRetainedChatGeneration(session,turn.owner,draft),{message:'DISCLOSURE_DENIED'});
      draft=c.attestRetainedChatClassification(session,turn.owner,draft,draft.question.id,'synthetic');
      draft=c.attestRetainedChatClassification(session,turn.owner,draft,draft.evidence[0]!.id,'public');
      const preview=await c.prepareRetainedChatGeneration(session,turn.owner,draft);
      const result=await c.confirmRetainedChatGeneration(session,turn.owner,preview);
      assert.equal(result.ok,true);assert.equal(calls,1);assert.equal(authorization,'Bearer synthetic-token');
      assert.deepEqual(received,{question:'synthetic',passages:[{id:0,text:hit.originalExcerpt}]});
      assert.deepEqual(await c.readRetainedChatTurn(session,turn.owner),error('SUPERSEDED'));
      assert.deepEqual(await c.confirmRetainedChatGeneration(session,turn.owner,preview),error('DISCLOSURE_DENIED'));
    } finally {c.dispose();}
  },(req,res)=>{calls++;authorization=String(req.headers.authorization);let body='';req.on('data',chunk=>body+=String(chunk));req.on('end',()=>{
    received=JSON.parse((JSON.parse(body).messages[1] as {content:string}).content);reply(res,generated([{kind:'quotation',text:hit.originalExcerpt,citationIds:[0]}]));
  });});
});

test('06H.2-A2b2c: forged/replayed, restrictive, cross-session and replaced credentials cannot dispatch',async()=>{
  let calls=0;
  await generationFixture(async cfg=>{
    const port={config:()=>cfg,scopeId:()=>root,verify:async()=>{throw Error('no verification without consent');}};
    const c=new SearchController(async()=>{},undefined,undefined,undefined,port),other=new SearchController(async()=>{},undefined,undefined,undefined,port);
    try {
      c.attach(engine(async()=>lease()));other.attach(engine(async()=>lease()));
      const session=c.openRetainedChatSession(),turn=c.startRetainedChatTurn(session,selector,request);assert.equal((await turn.result).ok,true);
      const foreign=other.openRetainedChatSession(),foreignTurn=other.startRetainedChatTurn(foreign,selector,request);assert.equal((await foreignTurn.result).ok,true);
      const stamp=await c.bindRetainedGenerationCredential(session,turn.owner,'one');
      const draft=c.createRetainedChatClassificationDraft(session,turn.owner,stamp);
      assert.throws(()=>c.attestRetainedChatClassification(session,turn.owner,structuredClone(draft),draft.question.id,'synthetic'),{message:'DISCLOSURE_DENIED'});
      assert.throws(()=>other.createRetainedChatClassificationDraft(foreign,foreignTurn.owner,stamp),{message:'CANCELLED'});
      const replacement=await c.bindRetainedGenerationCredential(session,turn.owner,'two');
      assert.throws(()=>c.attestRetainedChatClassification(session,turn.owner,draft,draft.question.id,'synthetic'),{message:'DISCLOSURE_DENIED'});
      const next=c.createRetainedChatClassificationDraft(session,turn.owner,replacement);
      const allowed=c.attestRetainedChatClassification(session,turn.owner,next,next.question.id,'public');
      assert.throws(()=>c.attestRetainedChatClassification(session,turn.owner,allowed,allowed.question.id,'blocked'),{message:'DISCLOSURE_DENIED'});
      assert.deepEqual(await c.readRetainedChatTurn(session,turn.owner),error('SUPERSEDED'));
      c.clearRetainedGenerationCredential(session,turn.owner);
      await assert.rejects(c.prepareRetainedChatGeneration(session,turn.owner,next),{message:'DISCLOSURE_DENIED'});
      assert.equal(calls,0);
    } finally {c.dispose();other.dispose();}
  },(req,res)=>{calls++;req.resume();reply(res,generated([]));});
});

test('06H.2-A2b2c: source/config drift and reentrant cancellation retire draft and preview before dispatch',async()=>{
  const cfg:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',identity:{model:'synthetic',revision:'v1'},
    limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1}};
  const c=new SearchController(async()=>{},undefined,undefined,undefined,{config:()=>cfg,scopeId:()=>root,verify:async()=>{}});
  try {
    c.attach(engine(async()=>lease()));const session=c.openRetainedChatSession(),turn=c.startRetainedChatTurn(session,selector,request);
    assert.equal((await turn.result).ok,true);const stamp=await c.bindRetainedGenerationCredential(session,turn.owner,'fixture');
    let draft=c.createRetainedChatClassificationDraft(session,turn.owner,stamp);
    draft=c.attestRetainedChatClassification(session,turn.owner,draft,draft.question.id,'synthetic');
    draft=c.attestRetainedChatClassification(session,turn.owner,draft,draft.evidence[0]!.id,'public');
    const preview=await c.prepareRetainedChatGeneration(session,turn.owner,draft);
    c.cancelRetainedChatTurn(session,turn.owner);
    assert.deepEqual(await c.confirmRetainedChatGeneration(session,turn.owner,preview),error('DISCLOSURE_DENIED'));
    const next=c.startRetainedChatTurn(session,selector,request);assert.equal((await next.result).ok,true);
    const nextStamp=await c.bindRetainedGenerationCredential(session,next.owner,'fixture');
    const stale=c.createRetainedChatClassificationDraft(session,next.owner,nextStamp);
    cfg.identity.revision='v2';
    assert.throws(()=>c.attestRetainedChatClassification(session,next.owner,stale,stale.question.id,'synthetic'),{message:'CANCELLED'});
    assert.deepEqual(await c.readRetainedChatTurn(session,next.owner),error('SUPERSEDED'));
  } finally {c.dispose();}
});

test('06H.2-A2b2c: empty claims are insufficient evidence and citation/provider failures retire without fallback',async()=>{
  for(const outcome of ['empty','citation','server'] as const){
    let calls=0;
    await generationFixture(async cfg=>{
      const c=new SearchController(async()=>{},undefined,undefined,undefined,{config:()=>cfg,scopeId:()=>root,verify:async()=>{}});
      try {
        c.attach(engine(async()=>lease()));const session=c.openRetainedChatSession(),turn=c.startRetainedChatTurn(session,selector,request);
        assert.equal((await turn.result).ok,true);const stamp=await c.bindRetainedGenerationCredential(session,turn.owner,'fixture');
        let draft=c.createRetainedChatClassificationDraft(session,turn.owner,stamp);
        draft=c.attestRetainedChatClassification(session,turn.owner,draft,draft.question.id,'synthetic');
        draft=c.attestRetainedChatClassification(session,turn.owner,draft,draft.evidence[0]!.id,'synthetic');
        const result=await c.confirmRetainedChatGeneration(session,turn.owner,await c.prepareRetainedChatGeneration(session,turn.owner,draft));
        assert.deepEqual(result,error(outcome==='empty'?'INSUFFICIENT_EVIDENCE':outcome==='citation'?'INVALID_RESPONSE':'SERVER_ERROR'));
        assert.equal(calls,1);assert.deepEqual(await c.readRetainedChatTurn(session,turn.owner),error('SUPERSEDED'));
      } finally {c.dispose();}
    },(req,res)=>{calls++;req.resume();if(outcome==='server'){res.writeHead(500);res.end();}
      else reply(res,generated(outcome==='empty'?[]:[{kind:'inference',text:'bad citation',citationIds:[9]}]));});
  }
});

test('06H.2-A2b2c: cancelled preview and dispatch verification keep physical admission until drain',async()=>{
  for(const phase of ['preview','dispatch'] as const){
    let calls=0;
    await generationFixture(async cfg=>{
      const held=deferred<void>(),entered=deferred<void>();let block=false;
      const c=new SearchController(async()=>{},undefined,undefined,undefined,{
        config:()=>cfg,scopeId:()=>root,verify:async()=>{if(block){entered.resolve();await held.promise;}}
      });
      try {
        c.attach(engine(async()=>lease()));const session=c.openRetainedChatSession(),turn=c.startRetainedChatTurn(session,selector,request);
        assert.equal((await turn.result).ok,true);
        const stamp=await c.bindRetainedGenerationCredential(session,turn.owner,'fixture');
        let draft=c.createRetainedChatClassificationDraft(session,turn.owner,stamp);
        draft=c.attestRetainedChatClassification(session,turn.owner,draft,draft.question.id,'public');
        draft=c.attestRetainedChatClassification(session,turn.owner,draft,draft.evidence[0]!.id,'synthetic');
        let outcome:Promise<unknown>;
        if(phase==='preview'){
          block=true;
          outcome=assert.rejects(c.prepareRetainedChatGeneration(session,turn.owner,draft),{message:'CANCELLED'});
        }else{
          const preview=await c.prepareRetainedChatGeneration(session,turn.owner,draft);
          block=true;
          outcome=c.confirmRetainedChatGeneration(session,turn.owner,preview).then(result=>assert.deepEqual(result,error('CANCELLED')));
        }
        await entered.promise;
        c.clearRetainedGenerationCredential(session,turn.owner);
        await outcome;
        assert.equal(calls,0);
        assert.deepEqual(await c.startRetainedChatTurn(session,selector,request).result,error('BUSY'));
        held.resolve();await flush();
        assert.equal((await c.startRetainedChatTurn(session,selector,request).result).ok,true);
      }finally{held.resolve();c.dispose();}
    },(req,res)=>{calls++;req.resume();reply(res,generated([]));});
  }
});

test('06H.2-A2b2c: no matching evidence and restrictive change after preview cannot dispatch',async()=>{
  let calls=0;
  await generationFixture(async cfg=>{
    const c=new SearchController(async()=>{},undefined,undefined,undefined,{config:()=>cfg,scopeId:()=>root,verify:async()=>{}});
    try{
      let empty=true;
      c.attach(engine(async()=>lease({search:async req=>({...response(req.requestId),hits:empty?[]:[structuredClone(hit)]})})));
      const session=c.openRetainedChatSession(),turn=c.startRetainedChatTurn(session,selector,request);
      assert.equal((await turn.result).ok,true);
      const stamp=await c.bindRetainedGenerationCredential(session,turn.owner,'fixture');
      assert.throws(()=>c.createRetainedChatClassificationDraft(session,turn.owner,stamp),{message:'INSUFFICIENT_EVIDENCE'});
      assert.equal(calls,0);
      empty=false;
      const next=c.startRetainedChatTurn(session,selector,request);assert.equal((await next.result).ok,true);
      const nextStamp=await c.bindRetainedGenerationCredential(session,next.owner,'fixture');
      let draft=c.createRetainedChatClassificationDraft(session,next.owner,nextStamp);
      draft=c.attestRetainedChatClassification(session,next.owner,draft,draft.question.id,'public');
      draft=c.attestRetainedChatClassification(session,next.owner,draft,draft.evidence[0]!.id,'synthetic');
      const preview=await c.prepareRetainedChatGeneration(session,next.owner,draft);
      assert.equal(preview.config.origin,cfg.origin);assert.equal(preview.scopeId,root);
      assert.equal(preview.inputBytes,Buffer.byteLength(request.query)+Buffer.byteLength(hit.originalExcerpt));
      assert.throws(()=>c.attestRetainedChatClassification(session,next.owner,draft,draft.question.id,'confidential'),{message:'DISCLOSURE_DENIED'});
      assert.deepEqual(await c.confirmRetainedChatGeneration(session,next.owner,preview),error('DISCLOSURE_DENIED'));
      assert.equal(calls,0);
    }finally{c.dispose();}
  },(req,res)=>{calls++;req.resume();reply(res,generated([]));});
});
