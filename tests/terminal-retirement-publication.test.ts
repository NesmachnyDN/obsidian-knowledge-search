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
