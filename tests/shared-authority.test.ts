import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DenseMachine} from '../plugin/src/ai/dense-machine';
import {DenseUiController} from '../plugin/src/ai/dense-ui-controller';
import {denseUiRequest} from '../plugin/src/ai/dense-ui';
import {SearchController,uiRequest} from '../plugin/src/search/controller';
import type {ProviderConfig} from '../plugin/src/ai/contracts';
import type {DenseRequest,DensePreview,MachineFence} from '../plugin/src/ai/dense-host';
import type {ApiRetrievalResult} from '../plugin/src/ai/dense-retrieval';
import {hash,type SearchResponse,type EvidenceHit} from '../plugin/src/standalone/contracts';
import {parseMarkdown} from '../plugin/src/standalone/markdown';
import type {EngineState} from '../plugin/src/standalone/engine';

const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:18765',
  identity:{model:'fixture',revision:'v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}};
const operation=denseUiRequest('search','a.md',3,config,'hybrid',uiRequest('alpha',5,[],'terms'));
if(operation.kind!=='search')throw Error('fixture');
const submit=()=>({apiVersion:1,operation:'submit',request:structuredClone(operation.request),space:structuredClone(operation.space)});
const generationId=hash('lexical');
const doc=parseMarkdown('a.md',Buffer.from('alpha fixture\n'),hash('root'));
const hit:EvidenceHit={sourceId:'a.md',sourceSha256:doc.sha256,originalExcerpt:doc.blocks[0]!.originalText,
  sourceLocators:[doc.blocks[0]!.locator],rank:1,lexicalRank:1,retrievalMode:'lexical',
  indexGenerationId:generationId,score:1,headings:[],wikiLinks:[],properties:[]};
const response=(requestId='ui'):SearchResponse=>({protocolVersion:2,requestId,requestedMode:'lexical',
  executedMode:'lexical',status:'ok',indexGenerationId:generationId,hits:[hit],
  capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0});
const result:ApiRetrievalResult={version:1,requestedMode:'hybrid',executedMode:'hybrid',status:'ok',error:null,
  indexGenerationId:'dense-generation',lexicalGenerationId:generationId,hits:[],
  legs:{dense:{status:'ready',candidateCount:2},lexical:{status:'ready',candidateCount:1}}};
const err=(error:string)=>({apiVersion:1,ok:false,error});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
async function watchdog<T>(work:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('WATCHDOG')),1000);})]);}
  finally{clearTimeout(timer);}
}
function fixture(){
  let reads=0,sends=0,verifies=0,revokes=0,controls=0;
  const dispatched:string[]=[];
  const host={
    prepare:async(input:DenseRequest,fence?:MachineFence):Promise<DensePreview>=>{
      reads++;return {nonce:'fixture-preview',scopeId:hash('root'),lexicalGenerationId:generationId,
        expiresUnixMs:fence?.expiresUnixMs??Date.now()+300000,config,operation:input,evidence:[]};
    },
    confirm:async()=>{sends++;return structuredClone(result);},
    invalidate:()=>{revokes++;},
    verifyMachineResult:async()=>{verifies++;return ()=>true;},
  };
  let c:SearchController;
  const navigation=deferred<void>();
  const ui=new DenseUiController({host:()=>host,sharedFence:()=>c?.sharedAuthorityTransition()??false,
    revokeNavigation:()=>{},navigate:async()=>{}});
  const machine=new DenseMachine(ui,{host:()=>host,preference:()=>config});
  // Exact production shared hook: both owners commit before either observer channel.
  c=new SearchController(()=>navigation.promise,undefined,undefined,undefined,undefined,
    ()=>ui.authority.revoke(()=>{machine.invalidate();ui.invalidate();}));
  const state=():EngineState=>({status:'ready',generationId,sources:1,records:1,busy:false,error:null,maintenanceWarning:null});
  const engine={search:async(r:{query:string})=>{dispatched.push(r.query);return response(r.query);},
    status:state,cancel:()=>{controls++;return true;},resume:()=>{controls++;},rebuild:()=>{controls++;}};
  c.attach(engine);
  const owner=Symbol('owner');
  const request=(name:string,id:string)=>machine.request({apiVersion:1,operation:name,operationId:id});
  const stage=async()=>{const r=await machine.request(submit());if(!r.ok||!r.value||!('operationId' in r.value))throw Error('stage');return r.value.operationId;};
  return {c,ui,machine,host,owner,engine,navigation,stage,request,dispatched,
    counts:()=>({reads,sends,verifies,revokes,controls}),
    close:()=>{c.dispose();machine.dispose();ui.dispose();}};
}

test('LIFE-07: D8, manual and lifecycle callbacks cannot reacquire revoked authority; fresh admission recovers',async()=>{
  const f=fixture();
  try{
    const id=await f.stage();let nested:ReturnType<DenseMachine['request']>|undefined;
    let manual:Promise<void>|undefined, lifecycle:ReturnType<DenseMachine['request']>|undefined;
    const observed:boolean[]=[];
    f.machine.subscribe(()=>{nested??=f.machine.request(submit());manual??=f.ui.prepare(f.owner,operation);});
    f.c.subscribe(()=>{observed.push(f.machine.pending());lifecycle??=f.machine.request(submit());});
    f.c.invalidate();
    assert.deepEqual(await nested,err('NOT_READY'));await manual;
    assert.deepEqual(await lifecycle,err('NOT_READY'));
    assert.deepEqual(observed,[false]);assert.equal(f.ui.occupied(),false);
    assert.deepEqual(await f.request('status',id),err('INVALID_OPERATION'));
    assert.equal(f.counts().reads,0);assert.equal(f.counts().sends,0);
    assert.notEqual(await f.stage(),id);assert.equal(f.machine.pending(),true);
  }finally{f.close();}
});

test('LIFE-08: exceptions in both dense channels do not interrupt atomic revoke or lexical result',async()=>{
  const f=fixture();
  try{
    await f.stage();await f.machine.review(f.owner);
    const seen:string[]=[];let thrown=0;
    const bad=()=>{thrown++;throw Error('synthetic observer exception');};
    f.machine.subscribe(bad);f.ui.subscribe(bad);
    f.machine.subscribe(()=>seen.push('machine:'+f.ui.snapshot(f.owner).phase));
    f.ui.subscribe(()=>seen.push('ui:'+String(f.machine.owns(f.owner))));
    const phases:string[]=[];f.c.subscribe(()=>phases.push(f.c.snapshot().phase));
    assert.equal((await watchdog(f.c.search(uiRequest('fresh',1)))).ok,true);
    assert.deepEqual(phases,['searching','results']);assert.deepEqual(f.dispatched,['fresh']);
    assert.equal(f.machine.pending(),false);assert.equal(f.ui.occupied(),false);
    assert.ok(seen.includes('machine:idle')&&seen.includes('ui:false'));
    assert.equal(thrown,1);assert.equal(f.counts().sends,0);
    f.machine.subscribe(bad);await f.stage();f.c.invalidate();assert.equal(thrown,1);
  }finally{f.close();}
});

test('LIFE-07/08: nested latest searches and control from authority hook cannot dispatch stale work',async()=>{
  const f=fixture();
  try{
    await f.stage();let one:ReturnType<SearchController['search']>|undefined,two:typeof one;
    let control:ReturnType<SearchController['control']>|undefined;
    f.machine.subscribe(()=>{if(!one){one=f.c.search(uiRequest('nested-1',1));two=f.c.search(uiRequest('nested-2',1));control=f.c.control('rebuild');}});
    const outer=f.c.search(uiRequest('outer',1));
    assert.deepEqual(await watchdog(outer),err('SUPERSEDED'));
    assert.deepEqual(await watchdog(one!),err('SUPERSEDED'));
    assert.equal((await watchdog(two!)).ok,true);
    assert.deepEqual(control,err('SUPERSEDED'));assert.equal(f.counts().controls,0);
    assert.deepEqual(f.dispatched,['nested-2']);assert.equal(f.c.snapshot().response?.requestId,'nested-2');
  }finally{f.close();}
});

test('LIFE-08: throwing callback during result publication cannot strand active or queued lexical jobs',async()=>{
  const f=fixture(),gate=deferred<SearchResponse>();
  try{
    f.c.attach({...f.engine,search:async input=>{const r=input as {query:string};f.dispatched.push(r.query);return r.query==='outer'?gate.promise:response(r.query);}});
    const outer=f.c.search(uiRequest('outer',1));
    await f.stage();
    let nested:ReturnType<SearchController['search']>|undefined;
    f.machine.subscribe(()=>{throw Error('synthetic result-publication exception');});
    f.machine.subscribe(()=>{nested??=f.c.search(uiRequest('latest',1));});
    gate.resolve(response('outer'));
    assert.deepEqual(await watchdog(outer),err('SUPERSEDED'));
    assert.equal((await watchdog(nested!)).ok,true);
    assert.deepEqual(f.dispatched,['outer','latest']);assert.equal(f.c.snapshot().response?.requestId,'latest');
  }finally{f.close();}
});

for(const action of ['dispose','detach'] as const)test('LIFE-07/08: '+action+' during shared revocation settles pending search and retires dense ownership',async()=>{
  const f=fixture();
  try{
    await f.stage();const phases:string[]=[];
    f.machine.subscribe(()=>{f.c[action]();});
    f.c.subscribe(()=>phases.push(f.c.snapshot().phase));
    assert.deepEqual(await watchdog(f.c.search(uiRequest('outer',1))),err('SUPERSEDED'));
    assert.deepEqual(f.dispatched,[]);assert.equal(f.ui.occupied(),false);
    assert.equal(f.machine.pending(),false);assert.equal(phases.at(-1),'idle');
    if(action==='dispose')assert.deepEqual(await f.machine.request(submit()),err('NOT_READY'));
  }finally{f.close();}
});

test('D7: reentrant publication cancellation prevents prepare/confirm from entering host',async()=>{
  const f=fixture();
  try{
    let unsub=f.ui.subscribe(()=>{if(f.ui.operationStatus().phase==='busy')f.c.invalidate();});
    await f.ui.prepare(f.owner,operation);assert.equal(f.counts().reads,0);assert.equal(f.ui.occupied(),false);unsub();
    await f.ui.prepare(f.owner,operation);assert.equal(f.ui.snapshot(f.owner).phase,'preview');
    unsub=f.ui.subscribe(()=>{if(f.ui.operationStatus().phase==='busy')f.c.invalidate();});
    await f.ui.confirm(f.owner,'fixture-preview','synthetic','fixture-token');
    assert.equal(f.counts().sends,0);assert.equal(f.ui.occupied(),false);unsub();
  }finally{f.close();}
});

test('D8: superseded submit and result publication never report stale success',async()=>{
  const f=fixture();
  try{
    let unsub=f.machine.subscribe(()=>{if(f.machine.pending())f.c.invalidate();});
    assert.deepEqual(await f.machine.request(submit()),err('INVALID_OPERATION'));unsub();
    const id=await f.stage();await f.machine.review(f.owner);
    await f.ui.confirm(f.owner,'fixture-preview','synthetic','fixture-token');
    unsub=f.machine.subscribe(()=>{f.c.invalidate();});
    assert.deepEqual(await watchdog(f.request('result',id)),err('SOURCE_STALE'));unsub();
    assert.equal(f.counts().verifies,1);assert.equal(f.ui.occupied(),false);await f.stage();
  }finally{f.close();}
});

test('D8: UI disposal revokes even an unowned pending machine slot and final snapshot reaches earlier observers',async()=>{
  const f=fixture();
  try{
    await f.stage();const seen:boolean[]=[];
    f.machine.subscribe(()=>seen.push(f.machine.pending()));
    f.machine.subscribe(()=>{if(f.machine.pending())f.ui.dispose();});
    // First revoke old slot, then create a new one to trigger nested disposal.
    f.machine.invalidate();assert.deepEqual(await f.machine.request(submit()),err('INVALID_OPERATION'));
    assert.equal(seen.at(-1),false);assert.equal(f.machine.pending(),false);
    assert.deepEqual(await f.machine.request(submit()),err('NOT_READY'));
  }finally{f.close();}
});

test('Dense shared observers: bounded registration churn, no recursive delivery, recovery next wave',async()=>{
  const f=fixture();
  try{
    let deliveries=0,depth=0,maxDepth=0;const healthy:boolean[]=[];
    const churn=()=>{depth++;maxDepth=Math.max(maxDepth,depth);deliveries++;
      f.machine.subscribe(()=>{deliveries++;});depth--;};
    f.machine.subscribe(churn);f.machine.subscribe(()=>healthy.push(f.machine.pending()));
    const id=await f.stage();assert.equal(f.machine.pending(),true);
    assert.equal(maxDepth,1);assert.ok(deliveries<=1200);assert.equal(healthy.at(-1),true);
    f.c.invalidate();assert.equal(healthy.at(-1),false);
    assert.deepEqual(await f.request('status',id),err('INVALID_OPERATION'));
  }finally{f.close();}
});

test('LIFE-06 adjacent: engine replacement supersedes active lexical search; stale navigation success is rejected',async()=>{
  const f=fixture(),gate=deferred<SearchResponse>();
  try{
    f.c.attach({...f.engine,search:()=>gate.promise});
    const old=f.c.search(uiRequest('old',1));f.c.attach(f.engine);gate.resolve(response('old'));
    assert.deepEqual(await watchdog(old),err('SUPERSEDED'));
    assert.equal((await f.c.search(uiRequest('fresh',1))).ok,true);
    const nav=f.c.open(0);await f.c.search(uiRequest('new',1));f.navigation.resolve();
    assert.deepEqual(await watchdog(nav),err('SUPERSEDED'));
    assert.equal(f.c.snapshot().response?.requestId,'new');
  }finally{f.close();}
});

test('LIFE-07/08: real preview and D8 timer handles retire together on shared invalidation',async t=>{
  const f=fixture(),live=new Set<ReturnType<typeof setTimeout>>();
  const set=globalThis.setTimeout,clear=globalThis.clearTimeout;
  t.mock.method(globalThis,'setTimeout',((fn:()=>void,ms:number)=>{
    const handle=set(fn,ms);live.add(handle);return handle;
  }) as typeof setTimeout);
  t.mock.method(globalThis,'clearTimeout',((handle:ReturnType<typeof setTimeout>)=>{
    live.delete(handle);clear(handle);
  }) as typeof clearTimeout);
  try{
    await f.stage();await f.machine.review(f.owner);
    assert.equal(live.size,2);
    f.machine.subscribe(()=>{void f.machine.request(submit());void f.ui.prepare(f.owner,operation);});
    f.c.invalidate();
    assert.equal(live.size,0);assert.equal(f.ui.occupied(),false);assert.equal(f.machine.pending(),false);
    await f.stage();assert.equal(live.size,1);f.c.dispose();assert.equal(live.size,0);
  }finally{f.close();for(const handle of live)clear(handle);t.mock.restoreAll();}
});

test('LIFE-09: failed trusted shared hook settles latest queued search, denies admission, publishes error and recovers',async()=>{
  let fault=false,dispatches=0;
  const phases:string[]=[];
  const c=new SearchController(async()=>{},undefined,undefined,undefined,undefined,()=>{
    if(fault)throw Error('synthetic trusted hook failure');
  });
  c.attach({search:async()=>{dispatches++;return response();},
    status:()=>({status:'ready',generationId,sources:1,records:1,busy:false,error:null,maintenanceWarning:null}),
    cancel:()=>true,resume:()=>{},rebuild:()=>{}});
  c.subscribe(()=>phases.push(c.snapshot().phase));
  try{
    fault=true;
    assert.deepEqual(await watchdog(c.search(uiRequest('denied',1))),err('INTERNAL_FAILURE'));
    assert.equal(dispatches,0);assert.equal(c.sharedAuthorityTransition(),true);
    assert.equal(c.snapshot().phase,'error');assert.deepEqual(phases,['error']);
    assert.equal((await c.open(0)).ok,false);
    assert.throws(()=>c.prepareGeneration(),{message:'NOT_READY'});
    fault=false;
    assert.equal((await watchdog(c.search(uiRequest('recovered',1)))).ok,true);
    assert.equal(dispatches,1);assert.equal(c.sharedAuthorityTransition(),false);
    assert.deepEqual(phases,['error','searching','results']);
  }finally{c.dispose();}
});

test('LIFE-09: trusted dense retirement fault clears D8 and UI owners before publication; bounded retry and recovery',async()=>{
  const f=fixture();
  try{
    const id=await f.stage();await f.machine.review(f.owner);
    const original=f.host.invalidate;
    let fail=true,attempts=0,observed=0;
    f.host.invalidate=()=>{attempts++;if(fail)throw Error('synthetic retirement fault');original();};
    f.ui.subscribe(()=>{observed++;try{f.ui.invalidate();}catch{/* fault must not publish another wave */}});
    const phases:string[]=[];f.c.subscribe(()=>phases.push(f.c.snapshot().phase));
    assert.deepEqual(await watchdog(f.c.search(uiRequest('denied',1))),err('INTERNAL_FAILURE'));
    assert.equal(f.ui.occupied(),false);assert.equal(f.machine.owns(f.owner),false);
    assert.equal(f.ui.authority.admissionClosed(),true);
    assert.deepEqual(await f.request('status',id),err('INVALID_OPERATION'));
    assert.deepEqual(await f.machine.request(submit()),err('NOT_READY'));
    assert.equal(f.dispatched.length,0);assert.ok(attempts<=2);assert.ok(observed<=1);
    assert.deepEqual(phases,['error']);
    fail=false;
    assert.equal((await watchdog(f.c.search(uiRequest('recovered',1)))).ok,true);
    assert.equal(f.ui.authority.admissionClosed(),false);
    assert.notEqual(await f.stage(),id);
  }finally{f.close();}
});

test('LIFE-09: failed trusted revocation at result publication does not strand active job or newer queued search',async()=>{
  let failOnResult=true,dispatches=0;
  let c:SearchController;
  c=new SearchController(async()=>{},undefined,undefined,undefined,undefined,()=>{
    if(failOnResult&&c.snapshot().phase==='results'){failOnResult=false;throw Error('synthetic result hook failure');}
  });
  c.attach({search:async()=>{dispatches++;return response();},
    status:()=>({status:'ready',generationId,sources:1,records:1,busy:false,error:null,maintenanceWarning:null}),
    cancel:()=>true,resume:()=>{},rebuild:()=>{}});
  let next:ReturnType<SearchController['search']>|undefined;
  c.subscribe(()=>{if(c.snapshot().phase==='error'&&!next)next=c.search(uiRequest('recovered',1));});
  try{
    assert.deepEqual(await watchdog(c.search(uiRequest('old',1))),err('SUPERSEDED'));
    assert.ok(next);
    assert.equal((await watchdog(next)).ok,true);
    assert.equal(dispatches,2);assert.equal(c.snapshot().phase,'results');
  }finally{c.dispose();}
});
