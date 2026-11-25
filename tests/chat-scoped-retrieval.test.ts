import {test} from 'node:test';
import assert from 'node:assert/strict';
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
    const preview=c.prepareGeneration();
    assert.deepEqual(await c.startScopedChatRetrieval(selector,request).result,error('BUSY'));
    assert.equal(c.snapshot().response?.hits.length,1);
    c.cancelGeneration();
    const turn=c.startScopedChatRetrieval(selector,request);
    assert.throws(()=>c.prepareGeneration(),{message:'BUSY'});
    await assert.rejects(c.generationConfirmed(preview,'synthetic','unused'),{message:'BUSY'});
    gate.resolve(lease());assert.equal((await turn.result).ok,true);
    assert.equal(c.prepareGeneration().role,'generation');
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
    assert.throws(()=>c.prepareGeneration(),{message:'BUSY'});
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
