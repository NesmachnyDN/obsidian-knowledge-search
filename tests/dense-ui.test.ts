import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DenseUiController} from '../plugin/src/ai/dense-ui-controller';
import {denseUiRequest} from '../plugin/src/ai/dense-ui';
import {uiRequest} from '../plugin/src/search/controller';
import {ProviderFailure,type ProviderConfig} from '../plugin/src/ai/contracts';
import type {DensePreview,DenseRequest} from '../plugin/src/ai/dense-host';
import type {ApiRetrievalResult} from '../plugin/src/ai/dense-retrieval';
import {hash,type EvidenceHit} from '../plugin/src/standalone/contracts';
import {parseMarkdown} from '../plugin/src/standalone/markdown';

const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:18765',
  identity:{model:'fixture',revision:'v1'},limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}};
const req=denseUiRequest('search','a.md',3,config,'dense',uiRequest('alpha',5,[],'terms'));
const source=parseMarkdown('a.md',Buffer.from('alpha storage\n'),hash('root'));
const hit:EvidenceHit={sourceId:'a.md',sourceSha256:source.sha256,originalExcerpt:source.blocks[0]!.originalText,
  sourceLocators:[source.blocks[0]!.locator],rank:1,lexicalRank:1,retrievalMode:'lexical',
  indexGenerationId:hash('lexical'),score:1,headings:[],wikiLinks:[],properties:[]};
const result:ApiRetrievalResult={version:1,requestedMode:'dense',executedMode:'dense',status:'ok',error:null,
  indexGenerationId:hash('dense'),lexicalGenerationId:hash('lexical'),
  hits:[{evidence:hit,rank:1,denseRank:1,denseSimilarity:1,lexicalRank:null,lexicalScore:null,rrfScore:null}],
  legs:{dense:{status:'ready',candidateCount:1},lexical:{status:'unavailable',candidateCount:0}}};
const preview=(operation:DenseRequest=req,expiresUnixMs=Date.now()+5000):DensePreview=>({
  nonce:'fixture-preview',scopeId:hash('root'),lexicalGenerationId:hash('lexical'),expiresUnixMs,config,
  operation,evidence:[hit]});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function fixture(){
  let sends=0,revocations=0,navigations=0,navRevocations=0;
  const host={prepare:async(input:DenseRequest)=>preview(input),
    confirm:async(_p:DensePreview,_classification:'synthetic'|'public',_token:string)=>{sends++;return result;},
    invalidate:()=>{revocations++;}};
  const port={host:()=>host,revokeNavigation:()=>{navRevocations++;},navigate:async(_hit:EvidenceHit)=>{navigations++;}};
  const controller=new DenseUiController(port);
  return {host,port,controller,counts:()=>({sends,revocations,navigations,navRevocations})};
}
test('D7 exact selected corpus, explicit mode/space and original typed filters; no inferred defaults',()=>{
  const r=denseUiRequest('search','a.md\nfolder/b.md',3,config,'hybrid',
    uiRequest('alpha',10,[{key:'version',valueType:'number',operator:'eq',value:1}],'literal',{tag:'fixture'}));
  assert.equal(r.kind,'search');
  if(r.kind==='search'){
    assert.deepEqual(r.request.scope,['a.md','folder/b.md']);assert.equal(r.request.requestedMode,'hybrid');
    assert.deepEqual(r.request.metadata,{tag:'fixture'});assert.equal(r.request.matchMode,'literal');
    assert.equal(r.request.predicates?.[0]?.value,1);
  }
  for(const paths of ['','a.md\na.md','../a.md','a.md\n','/a.md','a.md\n\nb.md','folder\\a.md'])
    assert.throws(()=>denseUiRequest('rebuild',paths,3,config,'dense'));
  for(const dimension of [0,4097,NaN,1.5])assert.throws(()=>denseUiRequest('rebuild','a.md',dimension,config,'dense'));
  assert.throws(()=>denseUiRequest('search','a.md',3,config,'dense',uiRequest('alpha',5,[],'literal')));
  assert.throws(()=>denseUiRequest('search','a.md',3,config,'hybrid',uiRequest('',5,[],'terms',{tag:'fixture'})));
  assert.throws(()=>denseUiRequest('rebuild','a.md',3,{state:'disabled'},'dense'));
  assert.throws(()=>denseUiRequest('rebuild','a.md',3,{...config,transport:'cloud',origin:'https://api.example.com'},'dense'));
});
test('D7 preview is owner-bound, detached, one-shot; wrong owner/nonce cannot send or navigate',async()=>{
  const f=fixture(),a=Symbol(),b=Symbol();
  try{
    await f.controller.prepare(a,req);
    assert.equal(f.counts().sends,0);
    const s=f.controller.snapshot(a);assert.equal(s.phase,'preview');
    if(s.phase!=='preview')throw Error('preview');
    s.preview.operation.paths=['foreign.md'];
    assert.equal(f.controller.snapshot(b).phase,'idle');
    await f.controller.confirm(b,s.preview.nonce,'synthetic','fixture');
    await f.controller.confirm(a,'foreign','synthetic','fixture');
    assert.equal(f.counts().sends,0);
    await f.controller.confirm(a,s.preview.nonce,'synthetic','fixture');
    await f.controller.confirm(a,s.preview.nonce,'synthetic','fixture');
    assert.equal(f.counts().sends,1);
    assert.equal(f.controller.snapshot(a).phase,'complete');
    assert.equal(await f.controller.open(b,0,hit),false);
    assert.equal(await f.controller.open(a,0,{...hit,originalExcerpt:'forged'}),false);
    assert.equal(await f.controller.open(a,0,hit),true);
    f.controller.cancel(a);assert.equal(await f.controller.open(a,0,hit),false);
    assert.equal(f.counts().navigations,1);
  }finally{f.controller.dispose();}
});
test('D7 pending preview and confirm are suppressed after cancellation, host replacement and other-view supersession',async()=>{
  for(const phase of ['prepare','confirm'] as const){
    for(const revoke of ['cancel','replace','other-view','dispose'] as const){
      const f=fixture(),a=Symbol(),b=Symbol(),pending=deferred<DensePreview>(),reply=deferred<ApiRetrievalResult>();
      try{
        if(phase==='prepare')f.host.prepare=()=>pending.promise;
        else f.host.confirm=()=>reply.promise;
        let work=f.controller.prepare(a,req);
        if(phase==='confirm'){await work;work=f.controller.confirm(a,'fixture-preview','public','fixture');}
        if(revoke==='cancel')f.controller.cancel(a);
        if(revoke==='replace'){f.port.host=()=>({...f.host});f.controller.invalidate();}
        if(revoke==='other-view'){f.host.prepare=async()=>preview();await f.controller.prepare(b,req);}
        if(revoke==='dispose')f.controller.dispose();
        pending.resolve(preview());reply.resolve(result);await work;
        assert.equal(f.controller.snapshot(a).phase,'idle',phase+':'+revoke);
        assert.equal(await f.controller.open(a,0,hit),false);
      }finally{f.controller.dispose();}
    }
  }
});
test('D7 expiry and provider failures never paint lexical success; asynchronous navigation is revoked',async()=>{
  const f=fixture(),a=Symbol();
  try{
    f.host.prepare=async()=>preview(req,Date.now()-1);
    await f.controller.prepare(a,req);assert.deepEqual(f.controller.snapshot(a),{phase:'error',error:'CANCELLED'});
    await f.controller.confirm(a,'fixture-preview','synthetic','fixture');assert.equal(f.counts().sends,0);
    f.host.prepare=async()=>preview();
    f.host.confirm=async()=>{throw new ProviderFailure('RATE_LIMITED');};
    await f.controller.prepare(a,req);await f.controller.confirm(a,'fixture-preview','synthetic','fixture');
    assert.deepEqual(f.controller.snapshot(a),{phase:'error',error:'RATE_LIMITED'});
    f.host.confirm=async()=>result;
    await f.controller.prepare(a,req);await f.controller.confirm(a,'fixture-preview','synthetic','fixture');
    const pending=deferred<void>();f.port.navigate=()=>pending.promise;
    const opened=f.controller.open(a,0,hit);const before=f.counts().navRevocations;
    f.controller.cancel(a);pending.resolve();assert.equal(await opened,false);
    assert.equal(f.counts().navRevocations,before+1);
  }finally{f.controller.dispose();}
});
