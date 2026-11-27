import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SearchController,uiRequest} from '../plugin/src/search/controller';
import {hash,type SearchResponse} from '../plugin/src/standalone/contracts';
import type {EngineState} from '../plugin/src/standalone/engine';
import type {LocalGraphLease} from '../plugin/src/standalone/graph-retrieval';

const deferred=()=>{let resolve!:()=>void,reject!:(error:Error)=>void;
  const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const state=():EngineState=>({status:'ready',generationId:hash('source-revision'),sources:0,records:0,
  busy:false,error:null,maintenanceWarning:null});
const result=():SearchResponse=>({protocolVersion:2,requestId:'synthetic',requestedMode:'lexical',executedMode:'lexical',
  status:'ok',indexGenerationId:hash('source-revision'),hits:[],capabilityReadiness:{lexical:'ready',dense:'unavailable'},
  error:null,staleSourceCount:0});
function fixture(hook?:()=>void,graph?:(_input:unknown,signal:AbortSignal)=>LocalGraphLease){
  let reads=0;
  const c=new SearchController(async()=>{},undefined,undefined,undefined,undefined,hook);
  c.attach({search:async()=>{reads++;return result();},status:state,cancel:()=>true,resume:()=>{},rebuild:()=>{},
    ...(graph?{captureLocalGraph:graph}:{})});
  return {c,reads:()=>reads};
}
const graphRequest={requestId:'synthetic',query:'synthetic',limit:1,scope:{mode:'vault-wide'},
  expansion:{depth:0,direction:'outgoing',fanOut:1,maxExpanded:1}};
function capture(c:SearchController){
  const value=c.captureSourceAuthority();assert.ok(value);assert.equal(value.retired,false);
  assert.equal(value.revision,c.sourceAuthorityRevision());return value;
}
test('source seal is stable and read-only through ordinary lexical revisions',async()=>{
  const {c,reads}=fixture();
  try{
    const old=capture(c);assert.ok(Object.isFrozen(old));
    assert.equal(Reflect.set(old,'retired',true),false);
    assert.equal(capture(c),old);
    assert.equal((await c.search(uiRequest('synthetic',1))).ok,true);assert.equal(reads(),1);
    c.invalidate();assert.equal(capture(c),old);assert.equal(old.retired,false);
  }finally{c.dispose();}
});
test('source and nested retirement seal before callbacks, preserve obligations and deny reentrant search',async()=>{
  const {c,reads}=fixture();const old=capture(c);
  const seen:string[]=[],checks:boolean[]=[],pending:ReturnType<typeof c.search>[]=[];
  const observe=(label:string)=>{seen.push(label);checks.push(old.retired&&!c.sourceAuthorityCurrent(old.revision)
    &&c.captureSourceAuthority()===null);};
  try{
    c.invalidateSource([()=>{observe('first');pending.push(c.search(uiRequest('denied',1)));
      c.invalidateSource([()=>observe('nested')]);},()=>observe('second')]);
    assert.deepEqual(seen,['first','second','nested']);assert.ok(checks.every(Boolean));
    assert.equal((await pending[0]!).ok,false);assert.equal(reads(),0);
    const fresh=capture(c);assert.notEqual(fresh,old);assert.ok(fresh.revision>old.revision);assert.equal(old.retired,true);
    assert.equal((await c.search(uiRequest('fresh',1))).ok,true);assert.equal(reads(),1);
    c.invalidateSource([]);assert.equal(fresh.retired,true);assert.notEqual(capture(c),fresh);
  }finally{c.dispose();}
});
for(const fail of [false,true])test('settings transition seals before host callbacks, including failure: '+fail,()=>{
  let armed=false;let observe=()=>{};
  const {c}=fixture(()=>{if(armed){observe();if(fail)throw Error('synthetic');}});
  const old=capture(c);const seen:boolean[]=[];
  observe=()=>seen.push(old.retired&&!c.sourceAuthorityCurrent(old.revision)&&c.captureSourceAuthority()===null);
  try{
    armed=true;
    if(fail)assert.throws(()=>c.beginRuntimeSettingsChange(undefined,false),/synthetic/);
    else c.beginRuntimeSettingsChange({invalidate:observe},false);
    assert.ok(seen.length>0&&seen.every(Boolean));assert.equal(c.captureSourceAuthority(),null);
    c.endRuntimeSettingsChange();
    if(fail){assert.equal(c.captureSourceAuthority(),null);armed=false;c.invalidate();}
    const fresh=capture(c);assert.ok(fresh.revision>old.revision);assert.equal(old.retired,true);
  }finally{armed=false;c.dispose();}
});
for(const fail of [false,true])test('source drain cannot revive old seal, including rejection: '+fail,async()=>{
  const {c,reads}=fixture();const gate=deferred();const old=capture(c);
  try{
    c.trackSourceDrain(gate.promise);assert.equal(old.retired,true);assert.equal(c.captureSourceAuthority(),null);
    assert.equal((await c.search(uiRequest('denied',1))).ok,false);assert.equal(reads(),0);
    if(fail)gate.reject(Error('synthetic drain'));else gate.resolve();
    await gate.promise.catch(()=>{});await tick();
    assert.equal(old.retired,true);assert.equal(c.sourceAuthorityCurrent(old.revision),false);
    if(fail){assert.equal(c.captureSourceAuthority(),null);assert.equal(c.control('rebuild').ok,false);}
    else {assert.ok(capture(c).revision>old.revision);assert.equal((await c.search(uiRequest('fresh',1))).ok,true);assert.equal(reads(),1);}
  }finally{gate.resolve();c.dispose();}
});
test('first source drain within an ordinary graph-abort wave advances the existing source revision',async()=>{
  const read=deferred(),drain=deferred();let callback=()=>{};let calls=0;
  const {c,reads}=fixture(undefined,(_input,signal)=>{
    signal.addEventListener('abort',()=>{calls++;callback();},{once:true});
    return {current:()=>!signal.aborted,read:async()=>{await read.promise;throw Error('synthetic retired graph');},verify:async()=>{}};
  });
  const old=capture(c),oldRevision=c.sourceAuthorityRevision();const seen:boolean[]=[];
  let nested:ReturnType<typeof c.search>|undefined;
  try{
    const graph=c.graphSearch(graphRequest);
    callback=()=>{c.trackSourceDrain(drain.promise);
      seen.push(old.retired,!c.sourceAuthorityCurrent(oldRevision),c.captureSourceAuthority()===null);
      nested=c.search(uiRequest('denied',1));};
    c.invalidate();assert.equal(calls,1);assert.deepEqual(seen,[true,true,true]);
    assert.equal((await graph).ok,false);assert.ok(nested);assert.equal((await nested).ok,false);assert.equal(reads(),0);
    drain.resolve();await drain.promise;await tick();
    assert.equal(c.sourceAuthorityCurrent(oldRevision),false);assert.equal(old.retired,true);
    assert.ok(capture(c).revision>oldRevision);
  }finally{read.resolve();drain.resolve();c.dispose();}
});
test('source retirement failure retains original obligation, recovery issues a new seal',()=>{
  const {c}=fixture();const old=capture(c);let attempts=0,fail=true;const observed:boolean[]=[];
  try{
    c.invalidateSource([()=>{attempts++;observed.push(old.retired&&c.captureSourceAuthority()===null);if(fail)throw Error('synthetic');}]);
    assert.equal(c.captureSourceAuthority(),null);assert.equal(c.control('rebuild').ok,false);
    fail=false;assert.equal(c.control('rebuild').ok,true);assert.equal(attempts,3);
    assert.deepEqual(observed,[true,true,true]);assert.ok(capture(c).revision>old.revision);assert.equal(old.retired,true);
  }finally{fail=false;c.dispose();}
});
test('bounded source obligation overflow is terminal-only and never revives source seal',()=>{
  const {c}=fixture();const old=capture(c);let attempted=0;
  try{
    c.invalidateSource(Array.from({length:4097},()=>()=>{attempted++;}));
    assert.equal(attempted,4096);assert.equal(old.retired,true);
    assert.equal(c.captureSourceAuthority(),null);assert.equal(c.control('rebuild').ok,false);
  }finally{c.dispose();}
});
test('terminal logical seal introduces no abort callback; physical teardown sees retirement',async()=>{
  const read=deferred();const seen:boolean[]=[];let callback=()=>{};
  const {c}=fixture(undefined,(_input,signal)=>{
    signal.addEventListener('abort',()=>callback(),{once:true});
    return {current:()=>!signal.aborted,read:async()=>{await read.promise;throw Error('synthetic retired graph');},verify:async()=>{}};
  });
  const old=capture(c);
  try{
    const graph=c.graphSearch(graphRequest);
    callback=()=>seen.push(old.retired&&c.captureSourceAuthority()===null);
    c.sealTerminal();assert.equal(old.retired,true);assert.equal(c.captureSourceAuthority(),null);assert.deepEqual(seen,[]);
    c.dispose();c.dispose();assert.deepEqual(seen,[true]);assert.equal((await graph).ok,false);
  }finally{read.resolve();c.dispose();}
});

// Keep this regression independent of the new capture API so the previous
// production module reproduces the underlying revision resurrection itself.
test('nested drain retires legacy numeric source authority permanently',async()=>{
  const read=deferred(),drain=deferred();let callback=()=>{};
  const {c}=fixture(undefined,(_input,signal)=>{
    signal.addEventListener('abort',()=>callback(),{once:true});
    return {current:()=>!signal.aborted,read:async()=>{await read.promise;throw Error('synthetic retired graph');},verify:async()=>{}};
  });
  const revision=c.sourceAuthorityRevision();const seen:boolean[]=[];
  try{
    const graph=c.graphSearch(graphRequest);
    callback=()=>{c.trackSourceDrain(drain.promise);seen.push(c.sourceAuthorityCurrent(revision));};
    c.invalidate();assert.equal((await graph).ok,false);assert.deepEqual(seen,[false]);
    drain.resolve();await drain.promise;await tick();
    assert.equal(c.sourceAuthorityCurrent(revision),false,'retired numeric authority must not revive');
    assert.ok(c.sourceAuthorityCurrent(c.sourceAuthorityRevision()));
  }finally{read.resolve();drain.resolve();c.dispose();}
});
test('evidence-only retirement recovery fences the old source revision before its retry callback',async()=>{
  const read=deferred(),seen:boolean[]=[];let calls=0;
  const {c}=fixture(undefined,(_input,signal)=>({
    current:()=>!signal.aborted,read:async()=>{await read.promise;throw Error('synthetic retired graph');},verify:async()=>{},
  }));
  const old=capture(c);
  try{
    const graph=c.graphSearch(graphRequest);
    // Instrument the existing concrete owner, not a separate retirement ledger.
    const {abort}=(c as unknown as {graphOperation:{abort:AbortController}}).graphOperation;
    const original=abort.abort.bind(abort);
    abort.abort=()=>{calls++;if(calls===1)throw Error('synthetic abort failure');
      seen.push(old.retired&&!c.sourceAuthorityCurrent(old.revision)&&c.captureSourceAuthority()===null);original();};
    c.invalidate();assert.equal((await graph).ok,false);assert.equal(calls,1);
    assert.equal(c.captureSourceAuthority(),null);
    assert.equal(c.control('rebuild').ok,true);assert.equal(calls,2);assert.deepEqual(seen,[true]);
    assert.ok(capture(c).revision>old.revision);assert.equal(old.retired,true);
  }finally{read.resolve();c.dispose();}
});
