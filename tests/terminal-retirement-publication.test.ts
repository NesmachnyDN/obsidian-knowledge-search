import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SearchController,uiRequest} from '../plugin/src/search/controller';
import {bindActiveDeadline} from '../plugin/src/ai/active-deadline';
import type {CallContext} from '../plugin/src/ai/contracts';
import {hash,type SearchResponse} from '../plugin/src/standalone/contracts';
import type {ChatScopeLease,EngineState} from '../plugin/src/standalone/engine';
import type {LocalGraphResult} from '../plugin/src/standalone/graph-retrieval';

const generation=hash('terminal-fixture'),root=hash('synthetic-root'),version=hash('a');
const scope={mode:'vault-wide'} as const;
const request={requestId:'synthetic',query:'synthetic',limit:1,scope,
  expansion:{depth:0 as const,direction:'outgoing' as const,fanOut:1,maxExpanded:1}};
const graph:LocalGraphResult={requestedMode:'graph',executedMode:'graph',requestId:request.requestId,
  rootId:root,generationId:generation,mappingId:hash('mapping'),projectionId:hash('projection'),
  scope:{selector:scope,rootId:root,generationId:generation,sources:[{sourceId:'a.md',sourceSha256:version}],
    coverage:{eligible:1,excluded:0,partial:0,unsupported:'unknown'}},
  expansion:{...request.expansion,direction:'outgoing',relationIds:undefined},projectionCoverage:{},
  lexicalHitCount:1,lexicalCount:1,uniqueCandidateCount:1,omittedByTopK:0,contextBytes:1,
  candidates:[{sourceId:'a.md',sourceSha256:version,blockId:hash('block'),excerpt:'a',
    locator:{locatorKind:'markdown',sourceVersion:version,byteStart:0,byteEnd:1,charStart:0,charEnd:1,lineStart:1,lineEnd:1,blockOrder:0},
    kind:'lexical',rank:1,lexicalRank:1,seedSourceId:'a.md',seedLexicalRank:1,path:[]}]};
const state=():EngineState=>({status:'ready',generationId:generation,sources:1,records:1,busy:false,error:null,maintenanceWarning:null});
const response=():SearchResponse=>({protocolVersion:2,requestId:'synthetic',requestedMode:'lexical',executedMode:'lexical',status:'ok',
  indexGenerationId:generation,hits:[],capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0});
function gate(){let resolve!:()=>void,reject!:(error:Error)=>void;
  const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(callback:()=>void,hook:()=>void,navigation=false){
  const read=gate();let dispatches=0;
  const c=new SearchController(async()=>{throw Error('synthetic navigation failure');},undefined,undefined,undefined,undefined,hook);
  c.attach({status:state,search:async()=>{dispatches++;return response();},cancel:()=>true,resume:()=>{},rebuild:()=>{},
    captureLocalGraph:(_input,signal)=>{
      signal.addEventListener('abort',callback,{once:true});
      return {current:()=>!signal.aborted,read:async()=>{if(navigation)return graph;
        await read.promise;throw Error('synthetic graph failure');},verify:async()=>{}};
    },
    captureChatScope:async(_input,signal):Promise<ChatScopeLease>=>{
      signal.addEventListener('abort',callback,{once:true});
      await read.promise;throw Error('synthetic scoped completion');
    }});
  return {c,read,dispatches:()=>dispatches};
}

for(const route of ['graph','navigation','scoped','reset','source','settings'] as const)
for(const sourceEvent of ['none','resolve','reject'] as const)
test('B-02 terminal publication after '+route+' retirement, physical source drain '+sourceEvent,async()=>{
  let callback=()=>{},hook=()=>{},armed=false;
  const f=fixture(()=>callback(),()=>hook(),route==='navigation'),c=f.c,physical=gate();
  const old=c.captureSourceAuthority()!,events:string[]=[],checks:boolean[]=[],replies:ReturnType<typeof c.search>[]=[];
  const observe=(label:string)=>{
    events.push(label);checks.push(old.retired&&c.captureSourceAuthority()===null&&!c.sourceAuthorityCurrent(c.sourceAuthorityRevision()));
  };
  const off=c.subscribe(()=>{if(armed){observe('observer');c.dispose();}});
  try{
    const retire=()=>{
      events.push('abort-enter');
      if(sourceEvent!=='none'){
        c.invalidateSource([]);c.invalidateSource([()=>events.push('unexpected source callback')]);
        c.trackSourceDrain(physical.promise);
      }
      c.dispose();observe('abort-return');replies.push(c.search(uiRequest('denied',1)));c.dispose();
    };
    hook=()=>{if(armed){observe('hook');c.dispose();}};
    if(route==='navigation'){
      const retrieved=await c.graphSearch(request);assert.ok(retrieved.ok);
      callback=retire;armed=true;
      assert.equal((await c.openGraphEvidence(retrieved.value,0)).ok,false);
    }else if(route==='scoped'){
      const turn=c.startScopedChatRetrieval(scope,{requestId:'synthetic',query:'synthetic',limit:1});
      callback=retire;armed=true;turn.cancel();assert.equal((await turn.result).ok,false);
    }else{
      const pending=c.graphSearch(request);callback=retire;armed=true;
      if(route==='graph')f.read.resolve();
      else if(route==='reset')c.invalidate();
      else if(route==='source')c.invalidateSource([]);
      else c.beginRuntimeSettingsChange(undefined,false);
      assert.equal((await pending).ok,false);
    }
    assert.deepEqual(events,['abort-enter','abort-return','hook','observer']);
    assert.ok(checks.every(Boolean));assert.deepEqual(await Promise.all(replies).then(items=>items.map(item=>item.ok)),[false]);
    assert.equal(f.dispatches(),0);
    c.dispose();f.read.resolve();
    if(sourceEvent==='reject')physical.reject(Error('synthetic late drain rejection'));else physical.resolve();
    await physical.promise.catch(()=>{});await tick();c.dispose();
    assert.deepEqual(events,['abort-enter','abort-return','hook','observer']);
    assert.equal(c.captureSourceAuthority(),null);
  }finally{armed=false;off();physical.resolve();f.read.resolve();c.dispose();}
});

for(const role of ['generation','reranking'] as const)
for(const nestedSource of [false,true])
test('B-02 terminal publication waits for role-local '+role+' callback, source='+nestedSource,()=>{
  let armed=false;const events:string[]=[],f=fixture(()=>{},()=>{if(armed)events.push('hook');}),c=f.c;
  const old=c.captureSourceAuthority()!,abort=new AbortController();
  const context=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+10000},10000);
  const internals=c as unknown as {revision:number;activeEvidence:Partial<Record<typeof role,{abort:AbortController;context:CallContext;revision:number}>>};
  internals.activeEvidence[role]={abort,context,revision:internals.revision};
  const off=c.subscribe(()=>{if(armed)events.push('observer');});
  try{
    abort.signal.addEventListener('abort',()=>{
      events.push('abort-enter');
      if(nestedSource)c.invalidateSource([]);
      c.dispose();events.push('abort-return');
    },{once:true});
    armed=true;
    if(role==='generation')c.cancelGeneration();else c.cancelRerank();
    // A real source event completes its separate nonterminal publication.
    const expected=nestedSource?['abort-enter','hook','observer','abort-return','hook','observer']:
      ['abort-enter','abort-return','hook','observer'];
    assert.deepEqual(events,expected);assert.equal(old.retired,true);assert.equal(c.captureSourceAuthority(),null);
    c.dispose();assert.deepEqual(events,expected);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});

for(const fail of [false,true])
test('B-02 terminal reentry into an executing shared hook joins it once, failure='+fail,()=>{
  let hook=()=>{},armed=false;const events:string[]=[],f=fixture(()=>{},()=>hook()),c=f.c;
  const old=c.captureSourceAuthority()!;
  const off=c.subscribe(()=>{if(armed)events.push('observer');});
  try{
    hook=()=>{if(armed){events.push('hook-enter');c.dispose();events.push('hook-return');if(fail)throw Error('synthetic hook failure');}};
    armed=true;c.invalidate();c.dispose();
    assert.deepEqual(events,['hook-enter','hook-return','observer']);assert.equal(old.retired,true);assert.equal(c.captureSourceAuthority(),null);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});

test('B-02 seal alone during retirement does not publish; later dispose completes once',async()=>{
  let callback=()=>{},armed=false;const events:string[]=[],f=fixture(()=>callback(),()=>{if(armed)events.push('hook');}),c=f.c;
  const old=c.captureSourceAuthority()!,off=c.subscribe(()=>{if(armed)events.push('observer');});
  try{
    const pending=c.graphSearch(request);callback=()=>{events.push('abort');c.sealTerminal();};
    armed=true;c.invalidate();assert.equal((await pending).ok,false);
    assert.deepEqual(events,['abort']);assert.equal(old.retired,true);
    c.dispose();c.dispose();assert.deepEqual(events,['abort','hook','observer']);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});

test('B-02 terminal disposal from a lifecycle observer completes before final observers',()=>{
  let armed=false,once=true;const events:string[]=[],f=fixture(()=>{},()=>{if(armed)events.push('hook');}),c=f.c;
  const old=c.captureSourceAuthority()!;
  const off=c.subscribe(()=>{if(armed){if(once){once=false;events.push('observer-enter');c.dispose();events.push('observer-return');}
    else events.push('final-observer');}});
  try{
    armed=true;c.invalidate();c.dispose();
    assert.deepEqual(events,['hook','observer-enter','hook','observer-return','final-observer']);
    assert.equal(old.retired,true);assert.equal(c.captureSourceAuthority(),null);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});

test('B-02 terminal observer queued inside role-local source callback survives the outer notification wave',()=>{
  let armed=false,once=true;const events:string[]=[],f=fixture(()=>{},()=>{if(armed)events.push('hook');}),c=f.c;
  const abort=new AbortController(),context=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+10000},10000);
  const internals=c as unknown as {revision:number;activeEvidence:{generation?:{abort:AbortController;context:CallContext;revision:number}}};
  internals.activeEvidence.generation={abort,context,revision:internals.revision};
  const off=c.subscribe(()=>{if(armed){if(once){once=false;events.push('observer-enter');c.dispose();events.push('observer-return');}
    else events.push('final-observer');}});
  try{
    abort.signal.addEventListener('abort',()=>{events.push('abort-enter');c.invalidateSource([]);events.push('abort-return');},{once:true});
    armed=true;c.cancelGeneration();c.dispose();
    assert.deepEqual(events,['abort-enter','hook','observer-enter','observer-return','abort-return','hook','final-observer']);
    assert.equal(c.captureSourceAuthority(),null);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});

test('B-02 seal-only failure in shared hook cannot consume the later physical terminal publication',()=>{
  let hook=()=>{},armed=false;const events:string[]=[],f=fixture(()=>{},()=>hook()),c=f.c;
  const off=c.subscribe(()=>{if(armed)events.push('observer');});
  try{
    hook=()=>{events.push('hook-seal');c.sealTerminal();throw Error('synthetic hook failure');};
    armed=true;c.invalidate();assert.deepEqual(events,['hook-seal']);
    hook=()=>events.push('hook');c.dispose();c.dispose();
    assert.deepEqual(events,['hook-seal','hook','observer']);assert.equal(c.captureSourceAuthority(),null);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});

test('B-02 terminal publication attempts a pinned failed host obligation without reopening admission',()=>{
  let armed=false,once=true;const events:string[]=[],f=fixture(()=>{},()=>{if(armed)events.push('hook');}),c=f.c;
  const off=c.subscribe(()=>{if(armed){if(once){once=false;events.push('observer-enter');c.dispose();events.push('observer-return');}
    else events.push('final-observer');}});
  try{
    armed=true;
    assert.throws(()=>c.beginRuntimeSettingsChange({invalidate:()=>{events.push('target');throw Error('synthetic pinned target failure');}},false));
    c.dispose();
    assert.deepEqual(events,['hook','target','observer-enter','hook','target','observer-return','final-observer']);
    assert.equal(c.captureSourceAuthority(),null);assert.equal(c.sourceAuthorityCurrent(c.sourceAuthorityRevision()),false);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});

for(const role of ['generation','reranking'] as const)
for(const fail of [false,true])test('B-04 source saturation retains and drains concrete '+role+' owner, throw='+fail,async t=>{
  let armed=false,attempted=0,abortCalls=0;
  const events:string[]=[],f=fixture(()=>{},()=>{if(armed)events.push('hook');}),c=f.c;
  const old=c.captureSourceAuthority()!,abort=new AbortController(),physical=gate();
  const context=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+10000},10000);
  const internals=c as unknown as {revision:number;activeEvidence:Partial<Record<typeof role,{abort:AbortController;context:CallContext;revision:number}>>};
  internals.activeEvidence[role]={abort,context,revision:internals.revision};
  const real=abort.abort.bind(abort);
  abort.abort=()=>{abortCalls++;real();if(fail)throw Error('synthetic late abort failure');};
  const off=c.subscribe(()=>{if(armed)events.push('observer');});
  t.mock.method(console,'warn',()=>{});
  try{
    abort.signal.addEventListener('abort',()=>{
      events.push('abort-enter');c.trackSourceDrain(physical.promise);c.dispose();c.dispose();events.push('abort-return');
    },{once:true});
    armed=true;
    c.invalidateSource(Array.from({length:4096},()=>()=>{attempted++;throw Error('synthetic source failure');}));
    assert.equal(attempted,4096);assert.equal(abort.signal.aborted,true);assert.equal(abortCalls,1);
    assert.deepEqual(events,['abort-enter','abort-return','hook','observer']);
    assert.equal(old.retired,true);assert.equal(c.captureSourceAuthority(),null);
    assert.equal(c.sourceAuthorityCurrent(c.sourceAuthorityRevision()),false);
    c.dispose();if(fail)physical.reject(Error('synthetic late source failure'));else physical.resolve();
    await physical.promise.catch(()=>{});await tick();c.dispose();
    assert.deepEqual(events,['abort-enter','abort-return','hook','observer']);assert.equal(abortCalls,1);
  }finally{armed=false;off();physical.resolve();f.read.resolve();c.dispose();}
});

for(const role of ['generation','reranking'] as const)
test('B-04 role-local retirement retains ownership at full source capacity: '+role,async t=>{
  let armed=false,attempted=0,abortCalls=0;
  const events:string[]=[],f=fixture(()=>{},()=>{if(armed)events.push('hook');}),c=f.c;
  const old=c.captureSourceAuthority()!,abort=new AbortController();
  const context=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+10000},10000);
  const internals=c as unknown as {revision:number;activeEvidence:Partial<Record<typeof role,{abort:AbortController;context:CallContext;revision:number}>>};
  const off=c.subscribe(()=>{if(armed)events.push('observer');});
  t.mock.method(console,'warn',()=>{});
  try{
    c.invalidateSource(Array.from({length:4096},()=>()=>{attempted++;throw Error('synthetic source failure');}));
    assert.equal(attempted,4096);assert.equal(old.retired,true);
    // Model an already owned role whose abort has not been registered yet.
    // No new public role admission is permitted under the source fault.
    internals.activeEvidence[role]={abort,context,revision:internals.revision};
    const real=abort.abort.bind(abort);abort.abort=()=>{abortCalls++;real();};
    abort.signal.addEventListener('abort',()=>{
      events.push('abort-enter');c.dispose();c.dispose();events.push('abort-return');
    },{once:true});
    armed=true;
    if(role==='generation')c.cancelGeneration();else c.cancelRerank();
    assert.deepEqual(events,['abort-enter','abort-return','hook','observer']);
    assert.equal(abortCalls,1);assert.equal(c.captureSourceAuthority(),null);
    assert.equal(c.sourceAuthorityCurrent(c.sourceAuthorityRevision()),false);
    c.dispose();await tick();assert.equal(abortCalls,1);
    assert.deepEqual(events,['abort-enter','abort-return','hook','observer']);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});

for(const role of ['generation','reranking'] as const)
test('B-04 full source wave cannot displace either nested role owner: '+role,async t=>{
  let armed=false,attempted=0;
  const events:string[]=[],f=fixture(()=>{},()=>{if(armed)events.push('hook');}),c=f.c;
  const other=role==='generation'?'reranking':'generation';
  const internals=c as unknown as {revision:number;activeEvidence:Partial<Record<typeof role,{abort:AbortController;context:CallContext;revision:number}>>};
  const calls={generation:0,reranking:0};
  const make=(key:typeof role)=>{
    const abort=new AbortController(),real=abort.abort.bind(abort);
    abort.abort=()=>{calls[key]++;real();};
    internals.activeEvidence[key]={abort,context:bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+10000},10000),revision:internals.revision};
    return abort;
  };
  const old=c.captureSourceAuthority()!,outer=make(role),inner=make(other);
  const off=c.subscribe(()=>{if(armed)events.push('observer');});
  t.mock.method(console,'warn',()=>{});
  try{
    outer.signal.addEventListener('abort',()=>{
      events.push('outer-enter');
      c.invalidateSource(Array.from({length:4096},()=>()=>{attempted++;throw Error('synthetic source failure');}));
      events.push('outer-return');
    },{once:true});
    inner.signal.addEventListener('abort',()=>{
      events.push('inner-enter');c.dispose();c.dispose();events.push('inner-return');
    },{once:true});
    armed=true;
    if(role==='generation')c.cancelGeneration();else c.cancelRerank();
    assert.equal(attempted,4096);assert.deepEqual(calls,{generation:1,reranking:1});
    assert.deepEqual(events,['outer-enter','inner-enter','inner-return','outer-return','hook','observer']);
    assert.equal(old.retired,true);assert.equal(c.captureSourceAuthority(),null);
    c.dispose();await tick();assert.deepEqual(calls,{generation:1,reranking:1});
    assert.equal(events.length,6);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});

for(const route of ['graph','scoped'] as const)
test('B-04 full source queue preserves '+route+' physical retirement after logical cancellation',async t=>{
  let callback=()=>{},armed=false,attempted=0;
  const events:string[]=[],f=fixture(()=>callback(),()=>{if(armed)events.push('hook');}),c=f.c;
  const old=c.captureSourceAuthority()!,off=c.subscribe(()=>{if(armed)events.push('observer');});
  t.mock.method(console,'warn',()=>{});
  try{
    const pending=route==='graph'?c.graphSearch(request):c.startScopedChatRetrieval(scope,{requestId:'synthetic',query:'synthetic',limit:1}).result;
    callback=()=>{events.push('abort-enter');c.dispose();events.push('abort-return');};
    armed=true;
    c.invalidateSource(Array.from({length:4096},()=>()=>{attempted++;throw Error('synthetic source failure');}));
    assert.equal(attempted,4096);assert.equal((await pending).ok,false);
    assert.deepEqual(events,['abort-enter','abort-return','hook','observer']);
    assert.equal(old.retired,true);assert.equal(c.captureSourceAuthority(),null);
    f.read.resolve();await tick();c.dispose();
    assert.deepEqual(events,['abort-enter','abort-return','hook','observer']);
    assert.equal(f.dispatches(),0);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});

for(const overflow of [false,true])test('B-04 source capacity is independently recoverable until actual overflow: '+overflow,async t=>{
  let callback=()=>{},attempted=0,fail=true,aborts=0;
  const f=fixture(()=>callback(),()=>{}),c=f.c,old=c.captureSourceAuthority()!;
  t.mock.method(console,'warn',()=>{});
  try{
    const pending=c.graphSearch(request);
    callback=()=>{aborts++;};
    c.invalidateSource(Array.from({length:4096+Number(overflow)},()=>()=>{attempted++;if(fail)throw Error('synthetic source failure');}));
    assert.equal(attempted,4096);assert.equal(aborts,1);assert.equal((await pending).ok,false);
    assert.equal(old.retired,true);assert.equal(c.captureSourceAuthority(),null);
    f.read.resolve();await tick();fail=false;
    const recovery=c.control('rebuild');
    assert.equal(recovery.ok,!overflow);
    if(overflow){assert.equal(attempted,4096);assert.equal(c.captureSourceAuthority(),null);}
    else{assert.equal(attempted,8192);assert.ok(c.captureSourceAuthority()!.revision>old.revision);}
    assert.equal(aborts,1);assert.equal(old.retired,true);
  }finally{f.read.resolve();c.dispose();}
});

test('B-04 completed concrete owner cannot consume source wave budget through repeated resets',async()=>{
  let armed=false,sourceCalls=0,abortCalls=0;
  const events:string[]=[],f=fixture(()=>{},()=>{if(armed)events.push('hook');}),c=f.c;
  const abort=new AbortController(),real=abort.abort.bind(abort);
  abort.abort=()=>{abortCalls++;real();};
  const internals=c as unknown as {revision:number;activeEvidence:{generation?:{abort:AbortController;context:CallContext;revision:number}}};
  internals.activeEvidence.generation={abort,context:bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+10000},10000),revision:internals.revision};
  abort.signal.addEventListener('abort',()=>events.push('abort'),{once:true});
  const off=c.subscribe(()=>{if(armed)events.push('observer');});
  const advance=()=>{
    sourceCalls++;
    if(sourceCalls===4096){c.dispose();return;}
    c.invalidate();c.invalidateSource([advance]);
  };
  try{
    armed=true;
    c.invalidateSource([()=>{sourceCalls++;c.invalidateSource([advance]);}]);
    assert.equal(sourceCalls,4096);assert.equal(abortCalls,1);
    assert.deepEqual(events,['abort','hook','observer']);assert.equal(c.captureSourceAuthority(),null);
    c.dispose();await tick();assert.equal(abortCalls,1);assert.equal(events.length,3);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});


test('B-04 failed concrete pin remains retryable after native signal retirement',async t=>{
  let callback=()=>{},abortCalls=0,callbacks=0;
  const f=fixture(()=>callback(),()=>{}),c=f.c,old=c.captureSourceAuthority()!;
  t.mock.method(console,'warn',()=>{});
  try{
    const pending=c.graphSearch(request);
    callback=()=>{callbacks++;};
    const {abort}=(c as unknown as {graphOperation:{abort:AbortController}}).graphOperation;
    const real=abort.abort.bind(abort);
    abort.abort=()=>{abortCalls++;real();if(abortCalls===1)throw Error('synthetic completion failure');};
    c.invalidate();assert.equal((await pending).ok,false);
    assert.equal(abort.signal.aborted,true);assert.equal(abortCalls,1);assert.equal(callbacks,1);
    assert.equal(c.captureSourceAuthority(),null);
    assert.equal(c.control('rebuild').ok,true);assert.equal(abortCalls,2);assert.equal(callbacks,1);
    assert.ok(c.captureSourceAuthority()!.revision>old.revision);assert.equal(old.retired,true);
    f.read.resolve();await tick();
  }finally{f.read.resolve();c.dispose();}
});

/** B-05: nested ordinary work owns publication even without source promotion. */
for(const route of ['graph','navigation','scoped'] as const)
for(const action of ['invalidate','basic','basic-source','source-basic'] as const)
test('completion protocol settles '+route+' / '+action,async()=>{
  let armed=false, callback=()=>{};
  const events:string[]=[],checks:boolean[]=[], replies:ReturnType<SearchController['search']>[]=[];
  const f=fixture(()=>callback(),()=>{if(armed){events.push('hook');checks.push(!c.sourceAuthorityCurrent(c.sourceAuthorityRevision()));}},route==='navigation'),c=f.c;
  const seal=c.captureSourceAuthority()!,revision=c.sourceAuthorityRevision();
  let dispatchAtReturn=-1;
  const off=c.subscribe(()=>{if(armed){events.push('observer');checks.push(!c.sourceAuthorityCurrent(c.sourceAuthorityRevision()));}});
  const basic=()=>{replies.push(c.search(uiRequest('nested',1)));};
  callback=()=>{
    events.push('abort-enter');
    if(action==='invalidate')c.invalidate();
    else if(action==='basic')basic();
    else if(action==='basic-source'){basic();c.invalidateSource([()=>events.push('source')]);}
    else{c.invalidateSource([()=>events.push('source')]);basic();}
    dispatchAtReturn=f.dispatches();events.push('abort-return');
  };
  try{
    if(route==='navigation'){
      const retrieved=await c.graphSearch(request);assert.ok(retrieved.ok);
      armed=true;assert.equal((await c.openGraphEvidence(retrieved.value,0)).ok,false);
    }else if(route==='graph'){
      const pending=c.graphSearch(request);armed=true;f.read.resolve();
      assert.equal((await pending).ok,false);
    }else{
      const turn=c.startScopedChatRetrieval(scope,{requestId:'synthetic',query:'synthetic',limit:1});
      armed=true;turn.cancel();assert.equal((await turn.result).ok,false);f.read.resolve();
    }
    await tick();await tick();
    const source=action.includes('source');
    assert.equal(dispatchAtReturn,0,'no dispatch while a retirement owner is running');
    assert.equal(c.sourceAuthorityCurrent(c.sourceAuthorityRevision()),true,'no stranded publication fence');
    assert.ok(checks.length>0&&checks.every(Boolean));
    const expected=['abort-enter','abort-return',...(source?['source']:[]),'hook','observer'];
    if(action==='basic')expected.push('hook','observer');
    assert.deepEqual(events,expected);
    assert.equal(f.dispatches(),action==='basic'?1:0);
    assert.deepEqual(await Promise.all(replies).then(items=>items.map(item=>item.ok)),
      action==='invalidate'?[]:[action==='basic']);
    assert.equal(seal.retired,source);
    assert.equal(c.sourceAuthorityRevision()===revision,!source);
    assert.equal(c.captureSourceAuthority()===seal,!source);
  }finally{armed=false;off();f.read.resolve();c.dispose();await Promise.all(replies);}
});

/** A source failure may not silently hide a standalone retirement fault. */
for(const route of ['graph','scoped'] as const)
test('completion protocol publishes standalone '+route+' retirement failure and recovery',async t=>{
  let armed=false,aborts=0,fail=true;const events:string[]=[];
  const f=fixture(()=>{},()=>{if(armed)events.push('hook');}),c=f.c;
  const off=c.subscribe(()=>{if(armed)events.push('observer');});
  t.mock.method(console,'warn',()=>{});
  type Slot={abort:AbortController};
  const internal=c as unknown as {graphOperation?:Slot;scopedRetrieval?:Slot};
  try{
    const graphTurn=route==='graph'?c.graphSearch(request):undefined;
    const scopedTurn=route==='scoped'?c.startScopedChatRetrieval(scope,{requestId:'synthetic',query:'synthetic',limit:1}):undefined;
    const owner=(internal.graphOperation??internal.scopedRetrieval)!.abort,real=owner.abort.bind(owner);
    owner.abort=()=>{aborts++;events.push('abort');if(fail)throw Error('synthetic fault');real();};
    armed=true;
    if(scopedTurn)scopedTurn.cancel();else f.read.resolve();
    assert.equal((await (graphTurn??scopedTurn!.result)).ok,false);
    assert.deepEqual(events,['abort','hook','observer']);
    assert.equal(c.captureSourceAuthority(),null);
    assert.equal(c.snapshot().message,'INTERNAL_FAILURE');
    assert.equal((await c.search(uiRequest('denied',1))).ok,false);
    f.read.resolve();await tick();fail=false;
    assert.equal(c.control('rebuild').ok,true);assert.equal(aborts,2);
    assert.ok(c.captureSourceAuthority());assert.equal(owner.signal.aborted,true);
  }finally{armed=false;off();fail=false;f.read.resolve();c.dispose();}
});

/** Artificial boundary state, not a claim that eight detached role pins are
 * reachable through public operations. Test the admission invariant itself. */
test('concrete reservation counts detached owners and does not spend source capacity',async t=>{
  const f=fixture(()=>{},()=>{}),c=f.c;
  type Pin={kind:'role';role:'reranking';revision:number;owner:AbortController;run:()=>void;attempted:boolean;failed:boolean};
  const internal=c as unknown as {retirement:{obligations:Pin[]};revision:number};
  const counts=Array<number>(8).fill(0);
  t.mock.method(console,'warn',()=>{});
  try{
    for(let i=0;i<8;i++){
      const owner=new AbortController();
      internal.retirement.obligations.push({kind:'role',role:'reranking',revision:internal.revision,owner,
        run:()=>{counts[i]=counts[i]!+1;owner.abort();},attempted:true,failed:true});
    }
    const graphTurn=c.graphSearch(request);
    let graphSettled=false;void graphTurn.then(()=>{graphSettled=true;});
    await tick();assert.equal(graphSettled,true,'capacity denial must settle without invoking the gated graph');
    assert.equal((await graphTurn).ok,false);
    const scopedTurn=c.startScopedChatRetrieval(scope,{requestId:'synthetic',query:'synthetic',limit:1});
    let scopedSettled=false;void scopedTurn.result.then(()=>{scopedSettled=true;});
    await tick();assert.equal(scopedSettled,true,'capacity denial must settle without invoking the gated scope');
    assert.equal((await scopedTurn.result).ok,false);
    assert.equal((await c.search(uiRequest('independent',1))).ok,true);
    assert.deepEqual(counts,Array(8).fill(0));
    // Successful independent source work never retries failed role-local pins.
    let sources=0;c.invalidateSource(Array.from({length:4096},()=>()=>{sources++;}));
    assert.equal(sources,4096);assert.deepEqual(counts,Array(8).fill(0));
    c.dispose();c.dispose();assert.deepEqual(counts,Array(8).fill(1));
  }finally{f.read.resolve();c.dispose();}
});

test('defensive concrete transfer overflow retains every already owned abort',async t=>{
  let aborted=0;const f=fixture(()=>{aborted++;},()=>{}),c=f.c;
  type Pin={kind:'role';role:'reranking';revision:number;owner:AbortController;run:()=>void;attempted:boolean;failed:boolean};
  const internal=c as unknown as {retirement:{obligations:Pin[]};revision:number};
  const counts=Array<number>(8).fill(0);
  t.mock.method(console,'warn',()=>{});
  try{
    const pending=c.graphSearch(request);
    // Deliberately violate the admission invariant with synthetic injection.
    // The fallback must fail closed but not discard the ninth existing owner.
    for(let i=0;i<8;i++){
      const owner=new AbortController();
      internal.retirement.obligations.push({kind:'role',role:'reranking',revision:internal.revision,owner,
        run:()=>{counts[i]=counts[i]!+1;owner.abort();},attempted:true,failed:true});
    }
    c.invalidate();assert.equal((await pending).ok,false);
    assert.equal(aborted,1);assert.equal(c.captureSourceAuthority(),null);
    assert.equal(c.control('rebuild').ok,false);
    c.dispose();c.dispose();
    assert.equal(aborted,1);assert.deepEqual(counts,Array(8).fill(1));
  }finally{f.read.resolve();c.dispose();}
});

// B-07 original independent negative and positive controls; same fixture and transitions.
for(const route of ['graph','scoped'] as const)
test('review: seal-only during failed physical retirement preserves obligation for later dispose: '+route,async t=>{
 const events:string[]=[];let armed=false;const f=fixture(()=>{},()=>{if(armed)events.push('hook');}),c=f.c;
 const off=c.subscribe(()=>{if(armed)events.push('observer');});
 t.mock.method(console,'warn',()=>{});
 const internal=c as unknown as {graphOperation?:{abort:AbortController};scopedRetrieval?:{abort:AbortController};retirement:{obligations:{owner?:AbortController}[]}};
 try {
 const g=route==='graph'?c.graphSearch(request):undefined;
 const s=route==='scoped'?c.startScopedChatRetrieval(scope,{requestId:'synthetic',query:'synthetic',limit:1}):undefined;
 const owner=(internal.graphOperation??internal.scopedRetrieval)!.abort, real=owner.abort.bind(owner);let attempts=0;
 owner.abort=()=>{attempts++;events.push('abort');if(attempts===1){c.sealTerminal();throw Error('synthetic retirement failure');}real();};
 armed=true;if(s)s.cancel();else f.read.resolve();await (g??s!.result);f.read.resolve();await tick();
 assert.deepEqual(events,['abort']);
 const retained=internal.retirement.obligations.some(p=>p.owner===owner);assert.equal(retained,true);
 c.dispose();c.dispose();
 assert.equal(internal.retirement.obligations.some(p=>p.owner===owner),false);
 assert.equal(attempts,2);assert.equal(owner.signal.aborted,true);assert.deepEqual(events,['abort','abort','hook','observer']);
 }finally{armed=false;off();f.read.resolve();c.dispose();}
});

for(const fail of [false,true])
test('review: role callback -> ordinary hook -> terminal dispose -> completion, hook failure='+fail,t=>{
 let armed=false, hook=()=>{};const events:string[]=[],f=fixture(()=>{},()=>hook()),c=f.c;
 const owner=new AbortController(), context=bindActiveDeadline({signal:owner.signal,deadlineUnixMs:Date.now()+10000},10000);
 const internal=c as unknown as {revision:number;activeEvidence:{reranking?:{abort:AbortController;context:CallContext;revision:number}}};
 internal.activeEvidence.reranking={abort:owner,context,revision:internal.revision};
 const off=c.subscribe(()=>{if(armed)events.push('observer');});t.mock.method(console,'warn',()=>{});
 try {
 hook=()=>{if(armed){events.push('hook-enter');c.dispose();events.push('hook-return');if(fail)throw Error('synthetic hook failure');}};
 owner.signal.addEventListener('abort',()=>{events.push('role-enter');c.invalidate();events.push('role-return');},{once:true});
 armed=true;c.cancelRerank();c.dispose();
 assert.deepEqual(events,['role-enter','hook-enter','hook-return','role-return','observer']);
 assert.equal(c.captureSourceAuthority(),null);
 }finally{armed=false;off();f.read.resolve();c.dispose();}
});

// A role-less cancellation pin can still cover an unproved graph/scoped
// lease or navigation dependency. Keep the existing conservative admission
// barrier only on failed retirement, not on ordinary independent drain.
for(const route of ['graph','scoped'] as const)
for(const fail of [false,true])
test('P0.2 paired graph/scoped cancellation barrier '+route+'/'+fail,async t=>{
  const f=fixture(()=>{},()=>{}),c=f.c;
  type Pin={owner?:AbortController;failed?:boolean};
  const i=c as unknown as {graphOperation?:{abort:AbortController};scopedRetrieval?:{abort:AbortController};
    retirement:{obligations:Pin[]}};
  let fault=fail,attempts=0;
  t.mock.method(console,'warn',()=>{});
  try{
    const g=route==='graph'?c.graphSearch(request):undefined;
    const s=route==='scoped'?c.startScopedChatRetrieval(scope,{requestId:'synthetic',query:'synthetic',limit:1}):undefined;
    const owner=(i.graphOperation??i.scopedRetrieval)!.abort,real=owner.abort.bind(owner);
    owner.abort=()=>{attempts++;if(fault)throw Error('synthetic unproved cancellation');real();};
    const basic=await c.search(uiRequest('current',1));
    assert.equal((await (g??s!.result)).ok,false);
    assert.equal(c.graphSnapshot(),null);
    assert.equal(basic.ok,!fail);
    assert.equal(f.dispatches(),fail?0:1);
    assert.equal(attempts,1);
    const pin=i.retirement.obligations.find(p=>p.owner===owner);
    if(fail){
      assert.ok(pin?.failed);
      assert.equal(c.captureSourceAuthority(),null);
      assert.equal((await c.search(uiRequest('denied',1))).ok,false);
      assert.equal(attempts,1);
      assert.equal(f.dispatches(),0);
      fault=false;assert.equal(c.control('rebuild').ok,true);assert.equal(attempts,2);
      assert.ok(!i.retirement.obligations.includes(pin));
      assert.ok(c.captureSourceAuthority());
      assert.equal((await c.search(uiRequest('current',1))).ok,true);
    }else{
      assert.equal(pin,undefined);assert.ok(c.captureSourceAuthority());
    }
    // Both paths retain the scoped physical slot independently of the pin.
    if(route==='scoped')assert.equal(i.scopedRetrieval?.abort,owner);
    f.read.resolve();await tick();
    if(route==='scoped')assert.equal(i.scopedRetrieval,undefined);
    assert.equal(f.dispatches(),1);
  }finally{fault=false;f.read.resolve();c.dispose();}
});

for(const route of ['graph','scoped'] as const)
for(const afterSignal of [false,true])
test('P0.2 terminal failed '+route+' survives late physical rejection / '+afterSignal,async t=>{
  const events:string[]=[],diagnostics:string[]=[];
  let armed=false,attempts=0;
  const f=fixture(()=>{},()=>{if(armed)events.push('hook');}),c=f.c;
  const off=c.subscribe(()=>{if(armed){events.push('observer');c.dispose();}});
  type Pin={owner?:AbortController;failed?:boolean;running?:boolean};
  const i=c as unknown as {graphOperation?:{abort:AbortController};scopedRetrieval?:{abort:AbortController};
    retirement:{obligations:Pin[]};concreteOwners():Set<AbortController>};
  t.mock.method(console,'warn',(message:unknown)=>{diagnostics.push(String(message));});
  try{
    const g=route==='graph'?c.graphSearch(request):undefined;
    const s=route==='scoped'?c.startScopedChatRetrieval(scope,{requestId:'synthetic',query:'synthetic',limit:1}):undefined;
    const owner=(i.graphOperation??i.scopedRetrieval)!.abort,real=owner.abort.bind(owner);
    owner.abort=()=>{attempts++;events.push('abort');if(afterSignal)real();throw Error('synthetic failure');};
    armed=true;c.dispose();c.dispose();
    assert.equal((await (g??s!.result)).ok,false);
    const pin=i.retirement.obligations.find(p=>p.owner===owner);
    assert.ok(pin?.failed);assert.equal(pin.running,false);
    assert.equal(owner.signal.aborted,afterSignal);
    assert.ok(i.concreteOwners().has(owner));
    assert.equal(diagnostics.filter(x=>x==='SEARCH_TERMINAL_RETIREMENT_FAILED').length,1);
    if(route==='scoped')assert.equal(i.scopedRetrieval?.abort,owner);
    f.read.reject(Error('synthetic late read rejection'));await tick();
    c.dispose();assert.equal(attempts,1);assert.deepEqual(events,['abort','hook','observer']);
    assert.ok(i.retirement.obligations.includes(pin));assert.ok(i.concreteOwners().has(owner));
    assert.equal(diagnostics.filter(x=>x==='SEARCH_TERMINAL_RETIREMENT_FAILED').length,1);
    if(route==='scoped')assert.equal(i.scopedRetrieval,undefined);
    assert.equal((await c.search(uiRequest('denied',1))).ok,false);assert.equal(f.dispatches(),0);
  }finally{armed=false;off();f.read.resolve();c.dispose();}
});
