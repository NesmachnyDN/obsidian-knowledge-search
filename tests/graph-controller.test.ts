import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchController, StandaloneApi, uiRequest } from '../plugin/src/search/controller';
import { hash, StandaloneError, type EvidenceHit } from '../plugin/src/standalone/contracts';
import type { EngineState } from '../plugin/src/standalone/engine';
import type { LocalGraphLease, LocalGraphResult } from '../plugin/src/standalone/graph-retrieval';

const state=():EngineState=>({status:'ready',generationId:hash('graph-controller-generation'),sources:1,records:1,busy:false,error:null,maintenanceWarning:null});
const graph=(requestId='synthetic-graph'):LocalGraphResult=>Object.freeze({requestedMode:'graph',executedMode:'graph',requestId,
  rootId:hash('graph-controller-root'),generationId:hash('graph-controller-generation'),mappingId:hash('graph-controller-mapping'),
  projectionId:hash('graph-controller-projection'),scope:Object.freeze({selector:{mode:'vault-wide' as const},rootId:hash('graph-controller-root'),
    generationId:hash('graph-controller-generation'),sources:[{sourceId:'a.md',sourceSha256:hash('a')}],coverage:{eligible:1,excluded:0,partial:0,unsupported:'unknown' as const}}),
  expansion:Object.freeze({depth:0,direction:'outgoing',fanOut:1,maxExpanded:1,relationIds:undefined}),projectionCoverage:{},
  lexicalHitCount:1,lexicalCount:1,uniqueCandidateCount:1,omittedByTopK:0,contextBytes:9,candidates:Object.freeze([Object.freeze({
    sourceId:'a.md',sourceSha256:hash('a'),blockId:hash('block'),excerpt:'synthetic',
    locator:Object.freeze({locatorKind:'markdown' as const,sourceVersion:hash('a'),byteStart:0,byteEnd:9,charStart:0,charEnd:9,lineStart:1,lineEnd:1,blockOrder:0}),
    kind:'lexical' as const,rank:1,lexicalRank:1,seedSourceId:'a.md',seedLexicalRank:1,path:Object.freeze([]),
  })])});
const lexical=()=>({protocolVersion:2 as const,requestId:'lexical',requestedMode:'lexical' as const,executedMode:'lexical' as const,
  status:'ok' as const,indexGenerationId:hash('lexical'),hits:[] as EvidenceHit[],capabilityReadiness:{lexical:'ready' as const,dense:'unavailable' as const},error:null,staleSourceCount:0});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};

const request=(requestId='synthetic-graph')=>({requestId,query:'synthetic',limit:5,scope:{mode:'vault-wide'},
  expansion:{depth:0,direction:'outgoing',fanOut:1,maxExpanded:1}});
const base=()=>({search:async()=>lexical(),status:state,cancel:()=>true,resume:()=>{},rebuild:()=>{}});
function host(read:(id:string,signal:AbortSignal)=>Promise<LocalGraphResult>=async id=>graph(id),
  verify:()=>Promise<void>=async()=>{}){
  return {...base(),captureLocalGraph:(input:unknown,signal:AbortSignal):LocalGraphLease=>({
    current:()=>!signal.aborted,read:()=>read((input as {requestId:string}).requestId,signal),verify,
  })};
}
test('06B.3c1 explicit API graph-only immutable publication; lexical and AI stay isolated',async()=>{
  const controller=new SearchController(async()=>{}),api=new StandaloneApi(controller);
  controller.attach(host());await controller.search(uiRequest('lexical',1));
  assert.deepEqual(await api.request({apiVersion:1,operation:'graph-search',request:{synthetic:true}}),
    {apiVersion:1,ok:false,error:'GRAPH_REQUEST_INVALID'});
  assert.ok(controller.snapshot().response);
  const result=await api.request({apiVersion:1,operation:'graph-search',request:request()});
  assert.ok(result.ok,JSON.stringify(result));const view=result.value as LocalGraphResult;
  assert.equal(view.executedMode,'graph');assert.ok(Object.isFrozen(view.candidates[0]!.locator));
  assert.equal(controller.graphSnapshot(),view);
  assert.equal(controller.snapshot().response,null);
  assert.equal(controller.evidenceOperationStatus('generation').phase,'idle');
  assert.throws(()=>controller.prepareRerank());
  assert.equal((await api.request({apiVersion:1,operation:'search',request:uiRequest('lexical',1)})).ok,true);
  assert.equal(controller.graphSnapshot(),null);assert.equal(controller.graphResultCurrent(view),false);
});
test('06B.3c1 superseding graph seals old result before abort callback and late completion',async()=>{
  const first=deferred<LocalGraphResult>();let calls=0,aborts=0;
  const controller=new SearchController(async()=>{});
  controller.attach(host(async(id,signal)=>{
    calls++;if(id==='old'){signal.addEventListener('abort',()=>{aborts++;assert.equal(controller.graphSnapshot(),null);});return first.promise;}
    return graph(id);
  }));
  const old=controller.graphSearch(request('old')),fresh=controller.graphSearch(request('fresh'));
  assert.deepEqual(await old,{apiVersion:1,ok:false,error:'SUPERSEDED'});
  const freshResult=await fresh;assert.ok(freshResult.ok,JSON.stringify(freshResult));
  first.resolve(graph('old'));await Promise.resolve();
  assert.equal(calls,2);assert.equal(aborts,1);assert.equal(controller.graphSnapshot()?.requestId,'fresh');
});
test('06B.3c1 reentrant lifecycle subscriber supersedes before graph dispatch and publication',async()=>{
  let reads=0;
  const controller=new SearchController(async()=>{});
  controller.attach(host(async id=>{reads++;return graph(id);}));
  let once=true;const unsubscribe=controller.subscribe(()=>{if(once){once=false;controller.invalidate();}});
  assert.deepEqual(await controller.graphSearch(request()),{apiVersion:1,ok:false,error:'SUPERSEDED'});
  assert.equal(reads,0);unsubscribe();
  let retireOnResult=true;const off=controller.subscribe(()=>{if(retireOnResult&&controller.graphSnapshot()){
    retireOnResult=false;controller.invalidate();
  }});
  assert.deepEqual(await controller.graphSearch(request()),{apiVersion:1,ok:false,error:'SUPERSEDED'});
  assert.equal(controller.graphSnapshot(),null);off();
});
test('06B.3c1 navigation selects only exact current view; stale, clone, and invalid indexes denied',async()=>{
  let checks=0;const opened:EvidenceHit[]=[];
  const controller=new SearchController(async(hit,authority)=>{authority?.current();await authority?.verify();opened.push(hit);authority?.current();});
  controller.attach(host(undefined,async()=>{checks++;}));
  const retrieved=await controller.graphSearch(request());assert.ok(retrieved.ok,JSON.stringify(retrieved));
  const view=retrieved.value;
  assert.equal((await controller.openGraphEvidence(view,0)).ok,true);
  assert.equal(opened.length,1);assert.equal(opened[0]!.originalExcerpt,'synthetic');assert.equal(checks,1);
  for(const invalid of [-1,1,0.1])assert.equal((await controller.openGraphEvidence(view,invalid)).ok,false);
  assert.equal((await controller.openGraphEvidence(structuredClone(view),0)).ok,false);
  assert.equal((await controller.openGraphEvidence(view,0,0,0)).ok,false);
  const later=await controller.graphSearch(request());assert.ok(later.ok);
  assert.equal((await controller.openGraphEvidence(view,0)).ok,false);
  controller.invalidate();assert.equal((await controller.openGraphEvidence(later.value,0)).ok,false);
});
test('06B.3c1 stale verification vetoes navigation and retires view; no automatic fallback',async()=>{
  let selected=false;
  const controller=new SearchController(async(_hit,authority)=>{await authority?.verify();selected=true;});
  controller.attach(host(undefined,async()=>{throw new StandaloneError('GRAPH_SOURCE_STALE');}));
  const result=await controller.graphSearch(request());assert.ok(result.ok);
  assert.equal((await controller.openGraphEvidence(result.value,0)).ok,false);
  assert.equal(selected,false);assert.equal(controller.graphSnapshot(),null);
  assert.equal(controller.snapshot().response,null);
});
test('06B.3c1 failure codes, unsupported engine, pause and terminal seal fail closed',async()=>{
  const controller=new SearchController(async()=>{}),api=new StandaloneApi(controller);
  controller.attach(base());assert.equal((await controller.graphSearch(request())).ok,false);
  controller.attach(host(async()=>{throw new StandaloneError('GRAPH_DISABLED');}));
  assert.deepEqual(await controller.graphSearch(request()),{apiVersion:1,ok:false,error:'GRAPH_DISABLED'});
  assert.equal(controller.graphSnapshot(),null);
  assert.deepEqual(await api.request({apiVersion:1,operation:'graph-search',request:request(),extra:true}),
    {apiVersion:1,ok:false,error:'INVALID_REQUEST'});
  controller.configure(true,true);assert.deepEqual(await controller.graphSearch(request()),{apiVersion:1,ok:false,error:'PAUSED'});
  controller.configure(true,false);controller.attach(host());const result=await controller.graphSearch(request());assert.ok(result.ok);
  controller.sealTerminal();assert.equal(controller.graphSnapshot(),null);controller.dispose();
  assert.deepEqual(await controller.graphSearch(request()),{apiVersion:1,ok:false,error:'DISABLED'});
});

test('06B.3c2 closing exact graph presentation retires only its own operation',async()=>{
  const controller=new SearchController(async()=>{});
  controller.attach(host());
  const owner={}, other={};
  const first=await controller.graphSearch(request(),owner);assert.ok(first.ok);
  controller.retireGraphPresentation(other);assert.equal(controller.graphSnapshot(),first.value);
  controller.retireGraphPresentation(owner);assert.equal(controller.graphSnapshot(),null);
  const api=await controller.graphSearch(request());assert.ok(api.ok);
  controller.retireGraphPresentation(owner);assert.equal(controller.graphSnapshot(),api.value);
  const pending=deferred<LocalGraphResult>();
  controller.attach(host(async()=>pending.promise));
  const work=controller.graphSearch(request('close'),owner);
  controller.retireGraphPresentation(owner);
  assert.deepEqual(await work,{apiVersion:1,ok:false,error:'SUPERSEDED'});
  pending.resolve(graph('close'));await Promise.resolve();
  assert.equal(controller.graphSnapshot(),null);
});
