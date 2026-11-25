import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DenseMachine} from '../plugin/src/ai/dense-machine';
import {DenseUiController} from '../plugin/src/ai/dense-ui-controller';
import {denseUiRequest} from '../plugin/src/ai/dense-ui';
import {uiRequest} from '../plugin/src/search/controller';
import {ProviderFailure,type ProviderConfig} from '../plugin/src/ai/contracts';
import type {DenseRequest,DensePreview,MachineFence} from '../plugin/src/ai/dense-host';
import type {ApiRetrievalResult} from '../plugin/src/ai/dense-retrieval';

const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:18765',
  identity:{model:'fixture',revision:'v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}};
const operation=denseUiRequest('search','a.md\nb.md',3,config,'hybrid',
  uiRequest('alpha',5,[{key:'version',valueType:'number',operator:'eq',value:1}],'terms',{tag:'fixture'}));
if(operation.kind!=='search')throw Error('fixture');
const submit=()=>({apiVersion:1,operation:'submit',request:structuredClone(operation.request),space:structuredClone(operation.space)});
const result:ApiRetrievalResult={version:1,requestedMode:'hybrid',executedMode:'hybrid',status:'ok',error:null,
  indexGenerationId:'dense-generation',lexicalGenerationId:'lexical-generation',hits:[],
  legs:{dense:{status:'ready',candidateCount:2},lexical:{status:'ready',candidateCount:1}}};
function fixture(){
  let pref=config,now=Date.now(),sends=0,verifies=0;
  const host={
    prepare:async(input:DenseRequest,fence?:MachineFence):Promise<DensePreview>=>({
      nonce:'fixture-preview',scopeId:'fixture-root',lexicalGenerationId:'lexical-generation',
      expiresUnixMs:fence?.expiresUnixMs??now+300000,config:pref,operation:input,evidence:[]}),
    confirm:async()=>{sends++;return structuredClone(result);},
    invalidate:()=>{},
    verifyMachineResult:async(_operation:unknown,_fence:unknown,_result:unknown,_signal:AbortSignal)=>{
      verifies++;return ()=>true;
    },
  };
  const ui=new DenseUiController({host:()=>host,revokeNavigation:()=>{},navigate:async()=>{}});
  const machine=new DenseMachine(ui,{host:()=>host,preference:()=>pref},()=>now);
  const owner=Symbol('fixture'),request=(name:string,id:string)=>machine.request({apiVersion:1,operation:name,operationId:id});
  const stage=async()=>{const r=await machine.request(submit());
    if(!r.ok||!r.value||!('operationId' in r.value))throw Error('submit');return r.value.operationId;};
  const review=async()=>{await machine.review(owner);const s=ui.snapshot(owner);
    if(s.phase!=='preview')throw Error('preview');return s.preview;};
  const complete=async()=>{const p=await review();await ui.confirm(owner,p.nonce,'synthetic','fixture-token');};
  return {host,ui,machine,owner,stage,review,complete,request,counts:()=>({sends,verifies}),
    advance:(ms:number)=>{now+=ms;},change:()=>{pref={...pref,identity:{...pref.identity,revision:'v2'}};},
    close:()=>{machine.dispose();ui.dispose();}};
}
const err=(error:string)=>({apiVersion:1,ok:false,error});
test('D8 rejects malformed, oversized, cyclic and unexpected machine envelopes before any prepare',async()=>{
  const f=fixture();
  try{
    const cyclic:any=submit();cyclic.request.cycle=cyclic;
    const accessor=submit();Object.defineProperty(accessor.request,'query',{get(){throw Error('secret');}});
    for(const input of [null,[],{...submit(),token:'fixture'}, {...submit(),request:{...operation.request,scope:[]}},
      {...submit(),request:{...operation.request,scope:['a.md','a.md']}},
      {...submit(),request:{...operation.request,scope:['../escape.md']}},
      {...submit(),request:{...operation.request,matchMode:['terms']}},
      {...submit(),request:{...operation.request,query:'я'.repeat(257)}},
      {...submit(),request:{...operation.request,limit:51}},
      {...submit(),request:{...operation.request,predicates:[{key:'x',valueType:'string',operator:'eq',value:'a',extra:true}]}},
      {...submit(),request:{...operation.request,scope:Array.from({length:40},(_,i)=>'a'.repeat(500)+i+'.md')}},
      {...submit(),request:{...operation.request,predicates:[{key:'x',valueType:'list',operator:'eq',value:Array(2)}]}},
      {...submit(),space:{...operation.space,extra:true}},cyclic,accessor])
      assert.equal((await f.machine.request(input)).ok,false);
    assert.deepEqual(await f.machine.request({...submit(),apiVersion:2}),err('UNSUPPORTED_VERSION'));
    assert.deepEqual(await f.machine.request({apiVersion:1,operation:'rebuild'}),err('UNSUPPORTED_OPERATION'));
    assert.deepEqual(await f.machine.request({apiVersion:1,operation:'confirm'}),err('UNSUPPORTED_OPERATION'));
    assert.deepEqual(f.counts(),{sends:0,verifies:0});
  }finally{f.close();}
});
test('D8 stages detached exact request, no consent or capability disclosure, one-shot result',async()=>{
  const f=fixture();
  try{
    const input=submit(),r=await f.machine.request(input);
    if(!r.ok||!r.value||!('operationId' in r.value))throw Error('stage');
    const id=r.value.operationId;input.request.query='tampered';input.request.scope!.push('foreign.md');
    assert.deepEqual(await f.machine.request(submit()),err('BUSY'));
    assert.deepEqual(await f.request('status','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),err('INVALID_OPERATION'));
    assert.deepEqual(await f.request('result',id),err('NOT_READY'));
    const meta=JSON.stringify(await f.request('status',id));
    for(const value of ['alpha','a.md','fixture-token',id,'scopeId','sourceSha256','properties','preview'])assert(!meta.includes(value));
    const p=await f.review();
    assert.deepEqual(p.operation,operation);assert.equal(p.expiresUnixMs,r.value.expiresUnixMs);
    assert.equal(f.counts().sends,0);
    await f.ui.confirm(Symbol(),p.nonce,'synthetic','fixture-token');assert.equal(f.counts().sends,0);
    await f.ui.confirm(f.owner,p.nonce,'synthetic','fixture-token');assert.equal(f.counts().sends,1);
    const out=await f.request('result',id);
    assert.deepEqual(out,{apiVersion:1,ok:true,value:result});
    assert.equal(f.counts().verifies,1);
    assert.deepEqual(await f.request('result',id),err('INVALID_OPERATION'));
    assert.equal(f.ui.snapshot(f.owner).phase,'idle');
  }finally{f.close();}
});
test('D8 manual ownership, exact expiry, settings changes, view close and cancellation revoke work',async()=>{
  const f=fixture();
  try{
    await f.ui.prepare(Symbol('manual'),operation);
    assert.deepEqual(await f.machine.request(submit()),err('BUSY'));f.ui.invalidate();
    let id=await f.stage();f.advance(300001);
    assert.deepEqual(await f.request('status',id),err('INVALID_OPERATION'));
    id=await f.stage();await f.review();f.machine.cancelView(f.owner);
    assert.deepEqual(await f.request('result',id),err('INVALID_OPERATION'));
    id=await f.stage();await f.review();await f.request('cancel',id);
    assert.equal(f.ui.snapshot(f.owner).phase,'idle');
    id=await f.stage();f.change();
    assert.deepEqual(await f.request('result',id),err('INVALID_OPERATION'));
    assert.equal(f.counts().sends,0);
  }finally{f.close();}
});
test('D8 concurrent read, cancellation while verifying, stale fence and typed provider failure',async()=>{
  const f=fixture();
  try{
    let id=await f.stage();await f.complete();
    let release!:(v:()=>boolean)=>void;
    f.host.verifyMachineResult=async()=>new Promise(r=>{release=r;});
    const read=f.request('result',id);
    assert.deepEqual(await f.request('result',id),err('BUSY'));
    await f.request('cancel',id);
    assert.deepEqual(await f.machine.request(submit()),err('BUSY'));
    assert.deepEqual(await read,err('SOURCE_STALE'));
    assert.deepEqual(await f.machine.request(submit()),err('BUSY'));
    release(()=>true);await new Promise<void>(resolve=>setImmediate(resolve));
    id=await f.stage();await f.complete();
    f.host.verifyMachineResult=async()=>()=>false;
    assert.deepEqual(await f.request('result',id),err('SOURCE_STALE'));
    assert.deepEqual(await f.request('result',id),err('INVALID_OPERATION'));
    id=await f.stage();
    f.host.confirm=async()=>{throw new ProviderFailure('RATE_LIMITED');};
    await f.complete();assert.deepEqual(await f.request('result',id),err('RATE_LIMITED'));
  }finally{f.close();}
});

for(const phase of ['pending','owned','reading'] as const)
test('systemic D8 failed abort retains physical owner and settles caller: '+phase,async()=>{
  const f=fixture();
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const start=new Promise<void>(resolve=>{entered=resolve;});
  let fault=true,attempts=0;
  try{
    const id=await f.stage();
    if(phase==='owned')await f.review();
    if(phase==='reading')await f.complete();
    f.host.verifyMachineResult=async()=>{entered();await gate;return ()=>true;};
    const {slot}=f.machine as unknown as {slot:{abort:AbortController}};
    const owner=slot.abort,original=owner.abort.bind(owner);
    owner.abort=()=>{
      attempts++;
      assert.equal(f.machine.pending(),false);
      assert.equal(f.machine.owns(f.owner),false);
      assert.equal(f.ui.authority.admissionClosed(),true);
      if(fault)throw Error('synthetic physical abort failure');
      original();
    };
    const result=phase==='reading'?f.request('result',id):undefined;
    if(result)await start;
    assert.throws(()=>f.machine.invalidate(),/synthetic physical abort failure/);
    assert.equal(attempts,1);
    assert.deepEqual(await f.request('status',id),err('INVALID_OPERATION'));
    assert.deepEqual(await f.machine.request(submit()),err('NOT_READY'));
    if(result){
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{assert.deepEqual(await Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('WATCHDOG')),1000);})]),err('SOURCE_STALE'));}
      finally{clearTimeout(timer);}
    }
    assert.throws(()=>f.machine.invalidate(),/synthetic physical abort failure/);
    assert.equal(attempts,2);
    fault=false;f.machine.invalidate();assert.equal(attempts,3);
    if(result)assert.deepEqual(await f.machine.request(submit()),err('BUSY'));
    release();await gate;await new Promise(resolve=>setImmediate(resolve));
    assert.notEqual(await f.stage(),id);
  }finally{fault=false;release();f.close();}
});
