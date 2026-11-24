import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { LoopbackRerankTransport, servedAlias } from '../plugin/src/ai/loopback-rerank';
import { EvidenceReranker, type RerankApproval } from '../plugin/src/ai/rerank-evidence';
import { RerankRuntimeProfiles, type RerankAdmission, syntheticRuntimeProfile, parseRerankRuntimeProfile,
  rerankProfileDigest, assertRerankAdmission, FIXTURE_PROFILE_TTL_MS } from '../plugin/src/ai/rerank-profile';
import { bindActiveDeadline, remainingOperationMs, expireActiveDeadline } from '../plugin/src/ai/active-deadline';
import { ProviderFailure, type ProviderConfig } from '../plugin/src/ai/contracts';
import { configDigest } from '../plugin/src/ai/disclosure';
import { hash, type EvidenceHit } from '../plugin/src/standalone/contracts';
import { parseMarkdown } from '../plugin/src/standalone/markdown';
import { verifySpan } from '../plugin/src/search/navigation';

const token = randomBytes(24).toString('hex');
const configAt = (port: number): ProviderConfig => ({ state:'configured', transport:'local',
  origin:'http://127.0.0.1:'+port, identity:{model:'synthetic-reranker',revision:'fixture-v1'},
  limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1} });
const fixtureAdmission=(cfg:ProviderConfig)=>new RerankRuntimeProfiles().installSyntheticFixture(cfg,hash('synthetic-scope'),'node-rerank-fixture');
const transportFixture=(transport:LoopbackRerankTransport, cfg:ProviderConfig, input:Parameters<LoopbackRerankTransport['rerank']>[1], token:string, context:Parameters<LoopbackRerankTransport['rerank']>[3]) =>
  transport.rerank(cfg,input,token,context,fixtureAdmission(cfg));
const input = {query:'REQ-42',passages:[{id:0,text:'REQ-42: first synthetic'},{id:1,text:'REQ-42: second synthetic'}]};
const context = (signal = new AbortController().signal) => ({signal,deadlineUnixMs:Date.now()+4000});
const reply = (res:ServerResponse, value:unknown, status=200):void => {
  res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));
};
async function fixture(run:(cfg:ProviderConfig)=>Promise<void>,
  handle:(req:IncomingMessage,res:ServerResponse)=>void):Promise<void> {
  const server=createServer(handle);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try { const address=server.address();if (!address||typeof address==='string') throw Error('FIXTURE_ADDRESS');
    await run(configAt(address.port));
  } finally { server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
}
function requestBody(req:IncomingMessage, callback:(value:Record<string,unknown>)=>void):void {
  const chunks:Buffer[]=[]; req.on('data',(chunk:Buffer)=>chunks.push(chunk));
  req.on('end',()=>callback(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
}
const good = (model:unknown) => ({model,results:[{index:1,relevance_score:0.9},{index:0,relevance_score:0.2}]});
test('real authenticated loopback request uses exact revision alias, minimal body and stable ordinal mapping', async()=>{
  let requests=0;
  await fixture(async cfg=>{
    const result=await transportFixture(new LoopbackRerankTransport(),cfg,input,token,context());
    assert.deepEqual(result,[{id:1,score:0.9},{id:0,score:0.2}]);
    assert.equal(requests,1);
  },(req,res)=>{
    requests++;
    assert.equal(req.method,'POST');assert.equal(req.url,'/v1/rerank');
    assert.equal(req.headers.authorization,'Bearer '+token);
    requestBody(req,body=>{
      assert.deepEqual(body,{model:'synthetic-reranker@fixture-v1',query:input.query,
        documents:input.passages.map(x=>x.text),top_n:2,max_tokens_per_query:0,max_tokens_per_doc:0});
      reply(res,good(body.model));
    });
  });
});
test('endpoint, credential and exact UTF-8 byte limits reject before any socket request',async()=>{
  let count=0;
  await fixture(async cfg=>{
    const t=new LoopbackRerankTransport();
    await assert.rejects(t.rerank({...cfg,transport:'cloud',origin:'https://api.example.com'},input,token,context()),{message:'ENDPOINT_DENIED'});
    await assert.rejects(transportFixture(t,cfg,input,'',context()),{message:'UNAUTHENTICATED'});
    await assert.rejects(transportFixture(t,cfg,input,'bad\r\nheader',context()),{message:'UNAUTHENTICATED'});
    await assert.rejects(transportFixture(t,{...cfg,limits:{...cfg.limits,maxInputBytes:5}},
      {query:'я',passages:[{id:0,text:'яя'}]},token,context()),{message:'LIMIT_EXCEEDED'});
    await assert.rejects(transportFixture(t,cfg,{query:'x',passages:[{id:2,text:'x'}]},token,context()),{message:'INVALID_RESPONSE'});
    const abort=new AbortController();abort.abort();
    await assert.rejects(transportFixture(t,cfg,input,token,context(abort.signal)),{message:'CANCELLED'});
    await assert.rejects(transportFixture(t,cfg,input,token,{...context(),deadlineUnixMs:0}),{message:'TIMEOUT'});
    assert.equal(count,0);
  },(_req,res)=>{count++;reply(res,{});});
});
test('response errors are typed; redirect, model mismatch, duplicate/partial/out-of-range scores and malformed JSON rejected',async()=>{
  const cases: Array<[number,unknown,string]> = [
    [401,{},'UNAUTHENTICATED'],[403,{},'FORBIDDEN'],[429,{},'RATE_LIMITED'],
    [503,{},'SERVER_ERROR'],[302,{},'ENDPOINT_DENIED'],
    [200,good('wrong-model'),'MODEL_MISMATCH'],
    [200,{model:'synthetic-reranker@fixture-v1',results:[{index:0,relevance_score:0.2}]},'INVALID_RESPONSE'],
    [200,{model:'synthetic-reranker@fixture-v1',results:[{index:0,relevance_score:0.2},{index:0,relevance_score:1}]},'INVALID_RESPONSE'],
    [200,{model:'synthetic-reranker@fixture-v1',results:[{index:0,relevance_score:0.2},{index:2,relevance_score:1}]},'INVALID_RESPONSE'],
    [200,{model:'synthetic-reranker@fixture-v1',results:[{index:0,relevance_score:0.2},{index:1,relevance_score:'bad'}]},'INVALID_RESPONSE'],
  ];
  let calls=0;
  await fixture(async cfg=>{
    const t=new LoopbackRerankTransport();
    for(const [, , code] of cases) await assert.rejects(transportFixture(t,cfg,input,token,context()),{message:code});
    await assert.rejects(transportFixture(t,cfg,input,token,context()),{message:'INVALID_RESPONSE'});
    await assert.rejects(transportFixture(t,cfg,input,token,context()),{message:'LIMIT_EXCEEDED'});
    await assert.rejects(transportFixture(t,cfg,input,token,context()),{message:'NETWORK'});
    assert.equal(calls,cases.length+3);
  },(req,res)=>{req.resume();const row=cases[calls++];
    if(row){if(row[0]===302)res.setHeader('location','https://example.invalid/forbidden');reply(res,row[1],row[0]);}
    else if(calls===cases.length+1){res.writeHead(200,{'content-type':'application/json'});res.end('{bad');}
    else if(calls===cases.length+2){res.writeHead(200,{'content-type':'application/json'});res.write('x'.repeat(65537));res.end();}
    else req.socket.destroy();
  });
});
test('deadline, abort and single in-flight admission do not silently fall back',async()=>{
  let entered!:()=>void;let received=new Promise<void>(r=>{entered=r;});
  await fixture(async cfg=>{
    const t=new LoopbackRerankTransport();const abort=new AbortController();
    const first=transportFixture(t,cfg,input,token,context(abort.signal));
    await received;
    await assert.rejects(transportFixture(t,cfg,input,token,context()),{message:'QUOTA_EXCEEDED'});
    abort.abort();await assert.rejects(first,{message:'CANCELLED'});
    received=new Promise<void>(r=>{entered=r;});
    await assert.rejects(transportFixture(t,{...cfg,limits:{...cfg.limits,timeoutMs:100}},input,token,context()),{message:'TIMEOUT'});
  },(req,_res)=>{req.resume();entered();});
});
const scopeId=hash('synthetic-scope');
const bytes=input.passages.map(x=>Buffer.from('# Synthetic\n'+x.text+'\n'));
const hits:EvidenceHit[]=bytes.map((raw,i)=>{
  const doc=parseMarkdown('synthetic-'+i+'.md',raw,scopeId);const block=doc.blocks[1]!;
  return {sourceId:doc.sourceId,sourceSha256:doc.sha256,originalExcerpt:block.originalText,
    sourceLocators:[block.locator],rank:i+1,lexicalRank:i+1,retrievalMode:'lexical',
    indexGenerationId:hash('generation'),score:2-i,headings:[],wikiLinks:[],properties:[]};
});
type FixtureApproval=RerankApproval & {admission:RerankAdmission};
function approval(cfg:ProviderConfig):FixtureApproval {
  const admission=fixtureAdmission(cfg);
  return {admission,config:cfg,scopeId,query:{text:input.query,classification:'synthetic'},
    candidates:hits.map(hit=>({hit,classification:'synthetic'})),grant:{
      version:1,role:'reranking',configDigest:configDigest('reranking',cfg),scopeId,runtimeProfileBinding:admission.bindingDigest,
      expiresUnixMs:Date.now()+10000,queryDigest:hash(input.query),queryClassification:'synthetic',
      sources:hits.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,
        excerptDigest:hash(hit.originalExcerpt),classification:'synthetic'}))}};
}
function runFixture(r:EvidenceReranker, approval:FixtureApproval, ...args: [string, Parameters<EvidenceReranker['run']>[2], Parameters<EvidenceReranker['run']>[3], Parameters<EvidenceReranker['run']>[4]]) {
  const {admission,...value}=approval;
  return r.run(value,...args,admission);
}
const profileRegistry=(c:SearchController)=>(c as unknown as {rerankProfiles:RerankRuntimeProfiles}).rerankProfiles;
const installFixture=(c:SearchController,cfg:ProviderConfig)=>profileRegistry(c).installSyntheticFixture(cfg,scopeId,'node-controller-fixture');

test('verified source-backed evidence survives reorder; grant and fresh source required before and after transport',async()=>{
  let calls=0;let verifyCount=0;let staleAfter=false;let current=true;
  await fixture(async cfg=>{
    const r=new EvidenceReranker();const a=approval(cfg);
    const verify=async(hit:EvidenceHit)=>{verifyCount++;const i=hits.findIndex(h=>h.sourceId===hit.sourceId);
      verifySpan(hit,staleAfter&&calls>1?Buffer.from('changed'):bytes[i]!);};
    const result=await runFixture(r,a,token,context(),verify,()=>current);
    assert.deepEqual(result,[{evidence:hits[1],rerankRank:1,rerankScore:0.9},
      {evidence:hits[0],rerankRank:2,rerankScore:0.2}]);
    assert.equal(verifyCount,4);assert.equal(calls,1);
    await assert.rejects(runFixture(r,{...a,config:{...cfg,identity:{...cfg.identity,revision:'changed'}}},token,context(),verify,()=>current),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(runFixture(r,{...a,candidates:[{hit:hits[0]!,classification:'unknown'}]},token,context(),verify,()=>current),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(runFixture(r,a,token,context(),async()=>{throw Error('private source')},()=>current),{message:'SOURCE_STALE'});
    assert.equal(calls,1);
    staleAfter=true;
    await assert.rejects(runFixture(r,a,token,context(),verify,()=>current),{message:'SOURCE_STALE'});
    assert.equal(calls,2);
    current=false;
    await assert.rejects(runFixture(r,a,token,context(),verify,()=>current),{message:'CANCELLED'});
    assert.equal(calls,2);
  },(req,res)=>{calls++;requestBody(req,body=>{
    assert.equal(Object.hasOwn(body,'sourceId'),false);assert.equal(Object.hasOwn(body,'grant'),false);
    reply(res,good(body.model));
  });});
});

import { SearchController, uiRequest, EVIDENCE_PREVIEW_TTL_MS } from '../plugin/src/search/controller';
import type { ProviderPreference } from '../plugin/src/ai/contracts';
import type { SearchResponse } from '../plugin/src/standalone/contracts';

test('SearchController: independent config, exact one-shot consent, original lexical response, lifecycle invalidation',async()=>{
  let calls=0;let entered!:()=>void;let waiting=new Promise<void>(r=>{entered=r;});
  await fixture(async cfg=>{
    let preference:ProviderPreference={state:'disabled'};
    const response:SearchResponse={protocolVersion:2,requestId:'ui',requestedMode:'lexical',
      executedMode:'lexical',status:'ok',indexGenerationId:hash('generation'),hits,
      capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0};
    const controller=new SearchController(async()=>{},undefined,undefined,{
      config:()=>preference,scopeId:()=>scopeId,
      verify:async hit=>{verifySpan(hit,bytes[hits.findIndex(h=>h.sourceId===hit.sourceId)]!);},
    });
    controller.attach({search:async()=>response,status:()=>({status:'ready',generationId:hash('generation'),
      sources:2,records:2,busy:false,error:null,maintenanceWarning:null}),
      cancel:()=>true,resume:()=>{},rebuild:()=>{}});
    await controller.search(uiRequest(input.query,2));
    assert.throws(()=>controller.prepareRerank(),{message:'DISABLED'});
    preference=cfg;
    installFixture(controller,cfg);
    const tamper=controller.prepareRerank();
    await assert.rejects(controller.rerankConfirmed({...tamper,query:'changed'},'synthetic',token),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(controller.rerankConfirmed(tamper,'synthetic',token),{message:'DISCLOSURE_DENIED'});
    const changed=controller.prepareRerank();preference={...cfg,identity:{...cfg.identity,revision:'changed'}};
    await assert.rejects(controller.rerankConfirmed(changed,'synthetic',token),{message:'CANCELLED'});
    assert.equal(calls,0);
    preference=cfg;
    assert.throws(()=>controller.prepareRerank(),{message:'NOT_READY'});
    installFixture(controller,cfg);
    const valid=controller.prepareRerank();await controller.rerankConfirmed(valid,'synthetic',token);
    const state=controller.snapshot();assert.equal(state.rerank?.phase,'results');
    assert.deepEqual(state.response,response);assert.deepEqual(state.rerank?.hits.map(x=>x.evidence),[hits[1],hits[0]]);
    await assert.rejects(controller.rerankConfirmed(valid,'synthetic',token),{message:'DISCLOSURE_DENIED'});
    const next=controller.prepareRerank();waiting=new Promise<void>(r=>{entered=r;});
    const inFlight=controller.rerankConfirmed(next,'synthetic',token);
    await waiting;controller.invalidate();await inFlight;
    assert.equal(controller.snapshot().response,null);assert.equal(controller.snapshot().rerank,undefined);
    assert.equal(calls,2);
    controller.dispose();
  },(req,res)=>{calls++;requestBody(req,body=>{entered();if(calls===1)reply(res,good(body.model));});});
});

test('verification deadline/cancellation before and after HTTP release admission; late rejections suppressed',async()=>{
  let calls=0;
  await fixture(async cfg=>{
    const reranker=new EvidenceReranker();
    const verify=async(hit:EvidenceHit)=>{verifySpan(hit,bytes[hits.findIndex(h=>h.sourceId===hit.sourceId)]!);};
    const defer=()=>{let resolve!:()=>void;let reject!:(error:Error)=>void;
      const promise=new Promise<void>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
    const short={...cfg,limits:{...cfg.limits,timeoutMs:100}};
    const stalled=defer();
    await assert.rejects(runFixture(reranker,approval(short),token,context(),()=>stalled.promise,()=>true),{message:'TIMEOUT'});
    assert.equal(calls,0);
    assert.equal((await runFixture(reranker,approval(cfg),token,context(),verify,()=>true)).length,2);
    stalled.reject(Error('late private failure'));
    let entered!:()=>void;const entry=new Promise<void>(r=>{entered=r;});
    const cancelled=defer();const abort=new AbortController();
    const pending=runFixture(reranker,approval(cfg),token,context(abort.signal),()=>{entered();return cancelled.promise;},()=>true);
    await entry;abort.abort();await assert.rejects(pending,{message:'CANCELLED'});
    assert.equal(calls,1);
    assert.equal((await runFixture(reranker,approval(cfg),token,context(),verify,()=>true)).length,2);
    cancelled.resolve();
    let count=0;const post=defer();
    await assert.rejects(runFixture(reranker,approval(short),token,context(),async hit=>{
      if(++count>2)return post.promise;await verify(hit);
    },()=>true),{message:'TIMEOUT'});
    assert.equal(calls,3);
    assert.equal((await runFixture(reranker,approval(cfg),token,context(),verify,()=>true)).length,2);
    post.reject(Error('late after HTTP'));
    let after!:()=>void;const afterEntry=new Promise<void>(r=>{after=r;});const afterDeferred=defer();
    const afterAbort=new AbortController();count=0;
    const afterPending=runFixture(reranker,approval(cfg),token,context(afterAbort.signal),async hit=>{
      if(++count>2){after();return afterDeferred.promise;}await verify(hit);
    },()=>true);
    await afterEntry;afterAbort.abort();await assert.rejects(afterPending,{message:'CANCELLED'});
    assert.equal((await runFixture(reranker,approval(cfg),token,context(),verify,()=>true)).length,2);
    afterDeferred.resolve();assert.equal(calls,6);
  },(req,res)=>{calls++;requestBody(req,body=>reply(res,good(body.model)));});
});
test('abandoned verifier budget is bounded; late settlement permits recovery',async()=>{
  await fixture(async cfg=>{
    const reranker=new EvidenceReranker();
    const short={...cfg,limits:{...cfg.limits,timeoutMs:100}};
    const resolvers:Array<()=>void>=[];
    const stall=()=>new Promise<void>(r=>resolvers.push(r));
    for(let i=0;i<2;i++)await assert.rejects(runFixture(reranker,approval(short),token,context(),stall,()=>true),{message:'TIMEOUT'});
    await assert.rejects(runFixture(reranker,approval(short),token,context(),stall,()=>true),{message:'QUOTA_EXCEEDED'});
    assert.equal(resolvers.length,2);resolvers.forEach(r=>r());await Promise.resolve();await Promise.resolve();
    const result=await runFixture(reranker,approval(cfg),token,context(),async hit=>{
      verifySpan(hit,bytes[hits.findIndex(h=>h.sourceId===hit.sourceId)]!);
    },()=>true);assert.equal(result.length,2);
  },(req,res)=>requestBody(req,body=>reply(res,good(body.model))));
});


test('pending evidence previews expire independently, reject late or altered consent, and release timers',async t=>{
  let calls=0, verifies=0;
  await fixture(async cfg=>{
    const response:SearchResponse={protocolVersion:2,requestId:'ui',requestedMode:'lexical',
      executedMode:'lexical',status:'ok',indexGenerationId:hash('generation'),hits,
      capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0};
    const port={config:()=>cfg,scopeId:()=>scopeId,verify:async()=>{verifies++;}};
    const c=new SearchController(async()=>{},undefined,undefined,port,port);
    c.attach({search:async()=>response,status:()=>({status:'ready',generationId:hash('generation'),
      sources:2,records:2,busy:false,error:null,maintenanceWarning:null}),
      cancel:()=>true,resume:()=>{},rebuild:()=>{}});
    t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
    try {
      installFixture(c,cfg);
      await c.search(uiRequest(input.query,2));
      let lifecycleEvents=0,evidenceEvents=0;
      c.subscribe(()=>{lifecycleEvents++;});c.subscribeEvidence(()=>{evidenceEvents++;});
      const first=c.prepareRerank();
      assert.equal(first.expiresUnixMs,1000+EVIDENCE_PREVIEW_TTL_MS);
      t.mock.timers.tick(1000);
      const gen=c.prepareGeneration();
      t.mock.timers.tick(EVIDENCE_PREVIEW_TTL_MS-1001);
      assert.equal(c.isEvidencePreviewCurrent('reranking',first.sequence),true);
      assert.equal(c.evidenceOperationStatus('reranking').phase,'permission-required');
      t.mock.timers.tick(1);
      assert.deepEqual(c.evidenceOperationStatus('reranking'),{phase:'failed',error:'CANCELLED'});
      assert.equal(c.isEvidencePreviewCurrent('reranking',first.sequence),false);
      assert.equal(c.isEvidencePreviewCurrent('generation',gen.sequence),true);
      assert.deepEqual(c.snapshot().response,response);
      await assert.rejects(c.rerankConfirmed(first,'synthetic',token),{message:'DISCLOSURE_DENIED'});
      // The active request deadline has not started; a modified expiry cannot renew consent.
      const altered=c.prepareRerank();
      await assert.rejects(c.rerankConfirmed({...altered,expiresUnixMs:altered.expiresUnixMs+1},'synthetic',token),
        {message:'DISCLOSURE_DENIED'});
      assert.equal(c.isEvidencePreviewCurrent('reranking',altered.sequence),false);
      const old=c.prepareRerank();
      t.mock.timers.tick(1);
      const replacement=c.prepareRerank();
      t.mock.timers.tick(EVIDENCE_PREVIEW_TTL_MS-1);
      assert.equal(c.isEvidencePreviewCurrent('reranking',old.sequence),false);
      assert.equal(c.isEvidencePreviewCurrent('reranking',replacement.sequence),true);
      assert.equal(c.evidenceOperationStatus('generation').phase,'failed');
      // Move wall time without delivering timers: confirmation must still fail closed.
      t.mock.timers.setTime(replacement.expiresUnixMs);
      assert.deepEqual(c.evidenceOperationStatus('reranking'),{phase:'failed',error:'CANCELLED'});
      await assert.rejects(c.rerankConfirmed(replacement,'synthetic',token),{message:'DISCLOSURE_DENIED'});
      assert.equal(c.snapshot().rerank?.error,'CANCELLED');
      const cancelled=c.prepareRerank(); c.cancelRerank();
      const invalidated=c.prepareGeneration();
      assert.equal(lifecycleEvents,0);assert.ok(evidenceEvents>0);
      c.invalidate();assert.equal(lifecycleEvents,1);
      await assert.rejects(c.rerankConfirmed(cancelled,'synthetic',token),{message:'DISCLOSURE_DENIED'});
      await assert.rejects(c.generationConfirmed(invalidated,'synthetic',token),{message:'DISCLOSURE_DENIED'});
      await c.search(uiRequest(input.query,2));
      const disposed=c.prepareGeneration();c.dispose();
      t.mock.timers.tick(EVIDENCE_PREVIEW_TTL_MS+1);
      assert.equal(c.evidenceOperationStatus('generation').phase,'idle');
      await assert.rejects(c.generationConfirmed(disposed,'synthetic',token),{message:'DISCLOSURE_DENIED'});
      assert.equal(verifies,0);assert.equal(calls,0);
    } finally { c.dispose();t.mock.timers.reset(); }
  },(req,res)=>{calls++;req.resume();reply(res,{},400);});
});


for (const role of ['reranking','generation'] as const) {
  test(role+' pending consent cannot revive after expiry, clock rollback or suspended execution',async t=>{
    let calls=0, verifies=0;
    await fixture(async cfg=>{
      const response:SearchResponse={protocolVersion:2,requestId:'ui',requestedMode:'lexical',
        executedMode:'lexical',status:'ok',indexGenerationId:hash('generation'),hits,
        capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0};
      const port={config:()=>cfg,scopeId:()=>scopeId,verify:async()=>{verifies++;}};
      const c=new SearchController(async()=>{},undefined,undefined,port,port);
      c.attach({search:async()=>response,status:()=>({status:'ready',generationId:hash('generation'),
        sources:2,records:2,busy:false,error:null,maintenanceWarning:null}),
        cancel:()=>true,resume:()=>{},rebuild:()=>{}});
      const prepare=()=>role==='reranking'?c.prepareRerank():c.prepareGeneration();
      const confirm=(p:ReturnType<typeof prepare>)=>role==='reranking'
        ?c.rerankConfirmed(p,'synthetic',token):c.generationConfirmed(p,'synthetic',token);
      let wall=Date.now(), mono=1000, boot=1000, events=0, lifecycle=0, reading=false;
      t.mock.method(Date,'now',()=>wall);
      t.mock.method(performance,'now',()=>mono);
      t.mock.method(os,'uptime',()=>boot);
      c.subscribe(()=>{lifecycle++;});
      c.subscribeEvidence(()=>{assert.equal(reading,false,'reentrant expiry notification');events++;});
      const read=()=>{reading=true;try{return c.evidenceOperationStatus(role);}finally{reading=false;}};
      const denied=async(p:ReturnType<typeof prepare>)=>{
        await assert.rejects(confirm(p),{message:'DISCLOSURE_DENIED'});
        assert.equal(calls,0);assert.equal(verifies,0);
        assert.deepEqual(read(),{phase:'failed',error:'CANCELLED'});
      };
      try {
        installFixture(c,cfg);
        await c.search(uiRequest(input.query,2));
        const first=prepare(), eventCount=events;
        // Forward wall correction is conservatively terminal even before elapsed TTL.
        wall=first.expiresUnixMs;
        assert.deepEqual(read(),{phase:'failed',error:'CANCELLED'});
        assert.equal(events,eventCount,'expiry must not notify synchronously from polling');
        wall-=EVIDENCE_PREVIEW_TTL_MS;
        assert.deepEqual(read(),{phase:'failed',error:'CANCELLED'});
        await denied(first);await denied(first);
        assert.equal(events,eventCount+1,'expiry publishes once');
        // Delayed timer and no prior polling; wall rollback cannot extend elapsed TTL.
        const late=prepare();mono+=EVIDENCE_PREVIEW_TTL_MS;wall-=100;
        await denied(late);
        // Simulate OS suspend: uptime advances while renderer monotonic and wall clocks do not.
        const suspended=prepare();boot+=EVIDENCE_PREVIEW_TTL_MS/1000;
        await denied(suspended);
        // Render-style current check must also be terminal, without reentrant listeners.
        const rendered=prepare();mono+=EVIDENCE_PREVIEW_TTL_MS;
        reading=true;
        try {assert.equal(c.isEvidencePreviewCurrent(role,rendered.sequence),false);}
        finally{reading=false;}
        await denied(rendered);
        // A deferred notification from a retired grant must not publish stale state.
        const retired=prepare();mono+=EVIDENCE_PREVIEW_TTL_MS;
        assert.deepEqual(read(),{phase:'failed',error:'CANCELLED'});
        const valid=prepare(), afterPrepare=events;
        await Promise.resolve();
        assert.equal(events,afterPrepare,'obsolete expiry notification discarded');
        assert.equal(read().phase,'permission-required');
        assert.equal(c.isEvidencePreviewCurrent(role,valid.sequence),true);
        // Still valid immediately before the monotonic deadline.
        mono+=EVIDENCE_PREVIEW_TTL_MS-1;
        assert.equal(read().phase,'permission-required');
        await confirm(valid);
        assert.equal(read().phase,'complete');assert.equal(calls,1);assert.equal(verifies,4);
        assert.equal(lifecycle,2);assert.deepEqual(c.snapshot().response,response);
      } finally {c.dispose();t.mock.restoreAll();}
    },(req,res)=>{calls++;requestBody(req,body=>reply(res,role==='reranking'?good(body.model):
      {model:body.model,usage:{completion_tokens:4},choices:[{index:0,finish_reason:'stop',
        message:{role:'assistant',content:JSON.stringify({claims:[{kind:'quotation',text:'REQ-42',citationIds:[0]}]})}}]}));});
  });
}

test('R2: strict canonical declarations are not evidence or execution capabilities',()=>{
  const cfg=configAt(18765);
  const declared=syntheticRuntimeProfile(cfg,'isolated-fixture');
  assert.equal(rerankProfileDigest(declared,cfg),rerankProfileDigest(
    Object.fromEntries(Object.entries(declared).reverse()),cfg));
  assert.ok(Object.isFrozen(declared));
  assert.equal(declared.maxPairTokens,null);
  assert.equal(declared.artifactSha256,null);
  assert.equal(declared.tokenizer,null);
  const {model: _model,...missing}=declared;
  const invalid=[missing,{...declared,extra:true},{...declared,version:2},{...declared,role:'embedding'},
    {...declared,origin:'http://127.0.0.1:9'},{...declared,configDigest:hash('wrong-config')},
    {...declared,revision:'wrong-revision'},{...declared,model:'fixture-other'},
    {...declared,runtime:'unverified'},{...declared,runtimeVersion:'2'},
    {...declared,adapter:'other'},{...declared,schemaVersion:2},{...declared,scoring:'ascending'},
    {...declared,truncation:'reject'},{...declared,maxPairTokens:10},{...declared,maxCandidates:999},
    {...declared,fixtureId:'x'.repeat(129)},{...declared,fixtureId:'\u0000'},
    {...declared,artifactSha256:hash('forged artifact')},{...declared,tokenizer:'fake'},
    {...declared,pairTemplateSha256:hash('forged template')},null,[],Object.create(declared)];
  for(const value of invalid) assert.throws(()=>parseRerankRuntimeProfile(value,cfg),ProviderFailure);
  assert.throws(()=>parseRerankRuntimeProfile({...declared,[Symbol('unknown')]:1},cfg),ProviderFailure);
  const getter=Object.defineProperty({...declared},'model',{get(){throw Error('must not invoke getter');}});
  assert.throws(()=>parseRerankRuntimeProfile(getter,cfg),{message:'CONFIG_INVALID'});
  const actualConfig={...cfg,identity:{model:'Qwen/Qwen3-Reranker-0.6B',revision:'unverified-revision'}};
  // Attacker-supplied declarations, NOT real evidence, even when structurally valid.
  const forgedActual={...declared,kind:'actual',model:actualConfig.identity.model,revision:actualConfig.identity.revision,
    configDigest:configDigest('reranking',actualConfig),runtime:'claimed-runtime',runtimeVersion:'1',
    artifactSha256:hash('forged artifact'),tokenizer:'claimed-tokenizer',tokenizerRevision:'claimed-revision',
    pairTemplateSha256:hash('forged template'),instructionSha256:hash('forged instruction'),
    maxPairTokens:8192,truncation:'reject',fixtureId:null};
  const actual=parseRerankRuntimeProfile(forgedActual,actualConfig);
  assert.equal(actual.kind,'actual');
  for(const change of [{artifactSha256:null},{tokenizer:null},{tokenizerRevision:null},
    {pairTemplateSha256:null},{instructionSha256:null},{maxPairTokens:null},{maxPairTokens:0},
    {maxPairTokens:1_000_001},{truncation:'unknown'},{runtimeVersion:''}])
    assert.throws(()=>parseRerankRuntimeProfile({...forgedActual,...change},actualConfig),ProviderFailure);
  const registry=new RerankRuntimeProfiles();
  assert.throws(()=>registry.installSyntheticFixture(actualConfig,scopeId,'not-a-fixture'),{message:'CONFIG_INVALID'});
  assert.throws(()=>registry.current(actualConfig,scopeId),{message:'NOT_READY'});
  assert.throws(()=>assertRerankAdmission({profile:actual,profileDigest:rerankProfileDigest(actual,actualConfig),
    bindingDigest:hash('forged grant'),scopeId},actualConfig,scopeId),{message:'NOT_READY'});
});

test('R2: missing, copied, forged, incompatible, revoked admissions and grant/classification tampering are zero-read zero-HTTP',async()=>{
  let calls=0, verifies=0;
  await fixture(async cfg=>{
    const registry=new RerankRuntimeProfiles();
    const lease=registry.installSyntheticFixture(cfg,scopeId,'admission-fixture');
    const {admission:_unused,...a}=approval(cfg);
    a.grant.runtimeProfileBinding=lease.bindingDigest;
    const reranker=new EvidenceReranker(), transport=new LoopbackRerankTransport();
    const verify=async()=>{verifies++;};
    const run=(value:RerankApproval,admission?:RerankAdmission)=>reranker.run(value,token,context(),verify,()=>true,admission);
    await assert.rejects(run(a),{message:'NOT_READY'});
    await assert.rejects(run(a,structuredClone(lease)),{message:'NOT_READY'});
    await assert.rejects(transport.rerank(cfg,input,token,context()),{message:'NOT_READY'});
    await assert.rejects(transport.rerank(cfg,input,token,context(),{...lease}),{message:'NOT_READY'});
    await assert.rejects(run({...a,config:{...cfg,origin:'http://127.0.0.1:9'}},lease),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(run({...a,config:{...cfg,limits:{...cfg.limits,maxCandidates:2}}},lease),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(run({...a,scopeId:hash('wrong scope')},lease),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(run({...a,grant:{...a.grant,role:'generation'}},lease),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(run({...a,grant:{...a.grant,runtimeProfileBinding:undefined}},lease),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(run({...a,query:{...a.query,classification:'public'},
      grant:{...a.grant,queryClassification:'public'}},lease),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(run({...a,candidates:a.candidates.map(c=>({...c,classification:'public'})),
      grant:{...a.grant,sources:a.grant.sources.map(c=>({...c,classification:'public'}))}},lease),{message:'DISCLOSURE_DENIED'});
    const replacement=registry.installSyntheticFixture(cfg,scopeId,'admission-fixture');
    assert.equal(replacement.profileDigest,lease.profileDigest);
    assert.notEqual(replacement.bindingDigest,lease.bindingDigest);
    await assert.rejects(run(a,lease),{message:'CANCELLED'});
    await assert.rejects(run(a,replacement),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(transport.rerank(cfg,input,token,context(),lease),{message:'CANCELLED'});
    assert.equal(calls,0);assert.equal(verifies,0);
    registry.revoke();
    await assert.rejects(run({...a,grant:{...a.grant,runtimeProfileBinding:replacement.bindingDigest}},replacement),{message:'CANCELLED'});
    assert.equal(calls,0);assert.equal(verifies,0);
  },(req,res)=>{calls++;req.resume();reply(res,{});});
});

test('R2: fixture capability expiry is terminal under clock rollback, delayed observation and suspended execution',async t=>{
  let calls=0, verifies=0;
  await fixture(async cfg=>{
    let wall=Date.now(), mono=1000, boot=1000;
    t.mock.method(Date,'now',()=>wall);t.mock.method(performance,'now',()=>mono);t.mock.method(os,'uptime',()=>boot);
    try {
      const registry=new RerankRuntimeProfiles(), reranker=new EvidenceReranker();
      for(const advance of [
        ()=>{wall+=FIXTURE_PROFILE_TTL_MS;},
        ()=>{mono+=FIXTURE_PROFILE_TTL_MS;wall-=100;},
        ()=>{boot+=FIXTURE_PROFILE_TTL_MS/1000;},
      ]) {
        const lease=registry.installSyntheticFixture(cfg,scopeId,'clock-fixture');
        const {admission:_unused,...a}=approval(cfg);
        a.grant.runtimeProfileBinding=lease.bindingDigest;
        const previous=[wall,mono,boot] as const;
        advance();
        const verify=async()=>{verifies++;};
        await assert.rejects(reranker.run(a,token,context(),verify,()=>true,lease),{message:'CANCELLED'});
        [wall,mono,boot]=previous;
        await assert.rejects(reranker.run(a,token,context(),verify,()=>true,lease),{message:'CANCELLED'});
        assert.throws(()=>registry.current(cfg,scopeId),{message:'NOT_READY'});
      }
      assert.equal(calls,0);assert.equal(verifies,0);
    } finally {t.mock.restoreAll();}
  },(req,res)=>{calls++;req.resume();reply(res,{});});
});

test('R2: controller binds exact profile, revokes one-shot consent and guards every async boundary',async()=>{
  let calls=0, verifies=0, verifyHook:()=>Promise<void>=async()=>{};
  let enteredHttp:()=>void=()=>{}, releaseHttp:()=>void=()=>{};
  let delayHttp=false;
  await fixture(async cfg=>{
    const response:SearchResponse={protocolVersion:2,requestId:'ui',requestedMode:'lexical',
      executedMode:'lexical',status:'ok',indexGenerationId:hash('generation'),hits,
      capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0};
    const port={config:()=>cfg,scopeId:()=>scopeId,verify:async()=>{verifies++;await verifyHook();}};
    const c=new SearchController(async()=>{},undefined,undefined,port,port);
    c.attach({search:async()=>response,status:()=>({status:'ready',generationId:hash('generation'),
      sources:2,records:2,busy:false,error:null,maintenanceWarning:null}),
      cancel:()=>true,resume:()=>{},rebuild:()=>{}});
    try {
      await c.search(uiRequest(input.query,2));
      assert.throws(()=>c.prepareRerank(),{message:'NOT_READY'});
      assert.deepEqual(c.evidenceOperationStatus('reranking'),{phase:'failed',error:'NOT_READY'});
      assert.equal(verifies,0);assert.equal(calls,0);
      const registry=profileRegistry(c), first=installFixture(c,cfg);
      const generation=c.prepareGeneration();
      const preview=c.prepareRerank();
      assert.equal(preview.runtimeProfileDigest,first.profileDigest);
      assert.equal(preview.runtimeProfileBinding,first.bindingDigest);
      await assert.rejects(c.rerankConfirmed({...preview,runtimeProfileDigest:hash('forged')},'synthetic',token),
        {message:'DISCLOSURE_DENIED'});
      await assert.rejects(c.rerankConfirmed(preview,'synthetic',token),{message:'DISCLOSURE_DENIED'});
      const pending=c.prepareRerank();
      installFixture(c,cfg);
      assert.equal(c.isEvidencePreviewCurrent('reranking',pending.sequence),false);
      await assert.rejects(c.rerankConfirmed(pending,'synthetic',token),{message:'DISCLOSURE_DENIED'});
      const publicAttempt=c.prepareRerank();
      await assert.rejects(c.rerankConfirmed(publicAttempt,'public',token),{message:'DISCLOSURE_DENIED'});
      assert.equal(verifies,0);assert.equal(calls,0);
      // Revoke before the scheduled verification callback actually enters the source reader.
      const before=c.rerankConfirmed(c.prepareRerank(),'synthetic',token);
      registry.revoke();await before;
      assert.equal(verifies,0);assert.equal(calls,0);
      assert.equal(c.snapshot().rerank?.error,'CANCELLED');
      assert.throws(()=>c.prepareRerank(),{message:'NOT_READY'});
      installFixture(c,cfg);
      // Revoke during an unresolved source verification. Cancellation must not wait for its settlement.
      let enterVerify!:()=>void, finishVerify!:()=>void;
      const verifying=new Promise<void>(r=>{enterVerify=r;});
      verifyHook=()=>new Promise<void>(r=>{finishVerify=r;enterVerify();});
      const during=c.rerankConfirmed(c.prepareRerank(),'synthetic',token);
      await verifying;
      installFixture(c,cfg);
      await during;finishVerify();await Promise.resolve();await Promise.resolve();
      assert.equal(verifies,1);assert.equal(calls,0);assert.equal(c.snapshot().rerank?.error,'CANCELLED');
      verifyHook=async()=>{};
      // Revoke during HTTP and suppress a late response, including same-profile reinstallation.
      delayHttp=true;
      const requesting=new Promise<void>(r=>{enteredHttp=r;});
      const inFlight=c.rerankConfirmed(c.prepareRerank(),'synthetic',token);
      await requesting;installFixture(c,cfg);await inFlight;releaseHttp();
      assert.equal(calls,1);assert.equal(verifies,3);
      assert.equal(c.snapshot().rerank?.error,'CANCELLED');
      assert.equal(c.snapshot().rerank?.hits.length,0);
      assert.equal(c.isEvidencePreviewCurrent('generation',generation.sequence),true);
      assert.deepEqual(c.snapshot().response,response);
      // Revoke during the post-response source read; no result publication.
      delayHttp=false;
      let enterPost!:()=>void, finishPost!:()=>void;
      const post=new Promise<void>(r=>{enterPost=r;});
      let localReads=0;
      verifyHook=async()=>{if(++localReads>2)await new Promise<void>(r=>{finishPost=r;enterPost();});};
      const postFlight=c.rerankConfirmed(c.prepareRerank(),'synthetic',token);
      await post;registry.revoke();await postFlight;finishPost();await Promise.resolve();await Promise.resolve();
      assert.equal(calls,2);assert.equal(c.snapshot().rerank?.error,'CANCELLED');
      assert.equal(c.snapshot().rerank?.hits.length,0);
      // A new explicitly issued profile AND fresh consent are required for recovery.
      verifyHook=async()=>{};
      installFixture(c,cfg);
      const fresh=c.prepareRerank();await c.rerankConfirmed(fresh,'synthetic',token);
      assert.equal(calls,3);assert.equal(c.snapshot().rerank?.phase,'results');
      await assert.rejects(c.rerankConfirmed(fresh,'synthetic',token),{message:'DISCLOSURE_DENIED'});
      registry.revoke();assert.equal(c.snapshot().rerank?.error,'CANCELLED');
      assert.equal(c.isEvidencePreviewCurrent('generation',generation.sequence),true);
      assert.deepEqual(c.snapshot().response,response);
    } finally {c.dispose();}
  },(req,res)=>{calls++;requestBody(req,body=>{
    if(delayHttp){releaseHttp=()=>reply(res,good(body.model));enteredHttp();}
    else reply(res,good(body.model));
  });});
});


test('B-R2-DEADLINE-01: one immutable effective budget, terminal expiry and rollback',t=>{
  let wall=10000,mono=2000,boot=1000;
  t.mock.method(Date,'now',()=>wall);t.mock.method(performance,'now',()=>mono);t.mock.method(os,'uptime',()=>boot);
  try {
    const raw={signal:new AbortController().signal,deadlineUnixMs:15000};
    for(const [max,grant,expected] of [[3000,12000,12000],[1000,15000,11000],[10000,20000,15000]]) {
      const bound=bindActiveDeadline(raw,max!,grant!);
      assert.ok(Object.isFrozen(bound));assert.equal(bound.deadlineUnixMs,expected);
      assert.equal(bindActiveDeadline(bound,max!,grant!),bound);
      assert.equal(remainingOperationMs(bound),expected!-wall);
    }
    const expired=bindActiveDeadline(raw,3000,12000);
    wall=12000;
    assert.throws(()=>remainingOperationMs(expired),{message:'TIMEOUT'});
    wall=10000;mono=2000;boot=1000;
    assert.throws(()=>remainingOperationMs(expired),{message:'TIMEOUT'});
    for (const advance of [()=>{mono+=2000;wall-=1000;},()=>{boot+=2;},()=>{mono-=1;}]) {
      const b=bindActiveDeadline(raw,2000);const before=[wall,mono,boot] as const;
      advance();assert.throws(()=>remainingOperationMs(b),{message:'TIMEOUT'});
      [wall,mono,boot]=before;assert.throws(()=>remainingOperationMs(b),{message:'TIMEOUT'});
    }
    const rewind=bindActiveDeadline(raw,2000);
    mono+=500;assert.equal(remainingOperationMs(rewind),1500);
    mono-=100;assert.throws(()=>remainingOperationMs(rewind),{message:'TIMEOUT'});
    mono+=100;assert.throws(()=>remainingOperationMs(rewind),{message:'TIMEOUT'});
    const abort=new AbortController(),c=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:15000},1000);
    abort.abort();assert.throws(()=>remainingOperationMs(c),{message:'CANCELLED'});
  } finally {t.mock.restoreAll();}
});

test('B-R2-DEADLINE-01: deadline crossed after final verified projection rejects worker return',async t=>{
  await fixture(async cfg=>{
    let wall=Date.now(),checks=0,reads=0;
    const deadline=wall+1000;
    t.mock.method(Date,'now',()=>wall);
    try {
      const a=approval(cfg);
      a.candidates=a.candidates.slice(0,1);a.grant.sources=a.grant.sources.slice(0,1);
      a.grant.expiresUnixMs=deadline;
      await assert.rejects(runFixture(new EvidenceReranker(),a,token,{signal:new AbortController().signal,deadlineUnixMs:deadline},
        async()=>{reads++;},()=>{
          if(++checks===10)queueMicrotask(()=>{wall=deadline;});
          return true;
        }),{message:'TIMEOUT'});
      assert.equal(reads,2);assert.equal(wall,deadline);
    } finally {t.mock.restoreAll();}
  },(req,res)=>requestBody(req,body=>reply(res,{model:body.model,results:[{index:0,relevance_score:1}]})));
});

for (const boundary of [4,6]) test('B-R2-DEADLINE-01: controller cannot publish expired rerank, boundary '+boundary,async t=>{
  let calls=0,reads=0,afterReads=0;
  await fixture(async cfg=>{
    let wall=Date.now();
    const deadline=wall+cfg.limits.timeoutMs;
    t.mock.method(Date,'now',()=>wall);
    const response:SearchResponse={protocolVersion:2,requestId:'ui',requestedMode:'lexical',
      executedMode:'lexical',status:'ok',indexGenerationId:hash('generation'),hits:hits.slice(0,1),
      capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0};
    const port={config:()=>{
      if(reads===2 && ++afterReads===boundary)queueMicrotask(()=>{wall=deadline;});
      return cfg;
    },scopeId:()=>scopeId,verify:async()=>{reads++;}};
    const c=new SearchController(async()=>{},undefined,undefined,port,port);
    c.attach({search:async()=>response,status:()=>({status:'ready',generationId:hash('generation'),
      sources:1,records:1,busy:false,error:null,maintenanceWarning:null}),
      cancel:()=>true,resume:()=>{},rebuild:()=>{}});
    try {
      await c.search(uiRequest(input.query,1));installFixture(c,cfg);
      const generation=c.prepareGeneration();
      const preview=c.prepareRerank();
      await c.rerankConfirmed(preview,'synthetic',token);
      assert.equal(wall,deadline);assert.equal(calls,1);assert.equal(reads,2);
      assert.deepEqual(c.snapshot().rerank,{phase:'error',error:'TIMEOUT',hits:[]});
      assert.deepEqual(c.snapshot().response,response);
      assert.equal(c.isEvidencePreviewCurrent('generation',generation.sequence),true);
      wall=deadline-cfg.limits.timeoutMs;
      await assert.rejects(c.rerankConfirmed(preview,'synthetic',token),{message:'DISCLOSURE_DENIED'});
      assert.equal(calls,1);
    } finally {c.dispose();t.mock.restoreAll();}
  },(req,res)=>{calls++;requestBody(req,body=>reply(res,{model:body.model,results:[{index:0,relevance_score:1}]}));});
});

test('B-R2-DEADLINE-01: expiry before queued verification and during verification is zero HTTP',async t=>{
  let calls=0,reads=0;
  await fixture(async cfg=>{
    let wall=Date.now(),mono=1000,boot=1000;
    t.mock.method(Date,'now',()=>wall);t.mock.method(performance,'now',()=>mono);t.mock.method(os,'uptime',()=>boot);
    try {
      const r=new EvidenceReranker(),a=approval(cfg);
      a.grant.expiresUnixMs=wall+500;
      const call=()=>({signal:new AbortController().signal,deadlineUnixMs:wall+2000});
      const pending=runFixture(r,a,token,call(),async()=>{reads++;},()=>true);
      mono+=500;wall-=100;
      await assert.rejects(pending,{message:'TIMEOUT'});
      assert.equal(reads,0);assert.equal(calls,0);
      const b=approval(cfg);b.grant.expiresUnixMs=wall+500;
      const during=runFixture(r,b,token,call(),async()=>{reads++;boot+=1;},()=>true);
      await assert.rejects(during,{message:'TIMEOUT'});
      assert.equal(reads,1);assert.equal(calls,0);
    } finally {t.mock.restoreAll();}
  },(req,res)=>{calls++;req.resume();reply(res,{});});
});


test('B-R2-DEADLINE-01: response after elapsed deadline cannot succeed even with delayed timer and wall rollback',async t=>{
  let calls=0,reads=0,wall=Date.now(),mono=1000,boot=1000;
  await fixture(async cfg=>{
    t.mock.method(Date,'now',()=>wall);t.mock.method(performance,'now',()=>mono);t.mock.method(os,'uptime',()=>boot);
    try {
      const a=approval(cfg);a.grant.expiresUnixMs=wall+500;
      await assert.rejects(runFixture(new EvidenceReranker(),a,token,context(),async()=>{reads++;},()=>true),{message:'TIMEOUT'});
      assert.equal(reads,a.candidates.length);assert.equal(calls,1);
    } finally {t.mock.restoreAll();}
  },(req,res)=>{calls++;requestBody(req,body=>{
    // The response callback runs before the real timer. Elapsed time, not timer delivery, is authoritative.
    mono+=500;wall-=100;reply(res,good(body.model));
  });});
});

test('B-R2-TERM-01: observed monotonic expiry survives later abort and time rollback',t=>{
  let wall=100_000,mono=3000,boot=900;
  t.mock.method(Date,'now',()=>wall);
  t.mock.method(performance,'now',()=>mono);
  t.mock.method(os,'uptime',()=>boot);
  try {
    const abort=new AbortController();
    const active=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:wall+10_000},1000);
    mono+=1000;
    assert.throws(()=>remainingOperationMs(active),{message:'TIMEOUT'});
    abort.abort();wall-=5000;mono-=1000;
    assert.throws(()=>remainingOperationMs(active),{message:'TIMEOUT'});
    const secondAbort=new AbortController();
    const second=bindActiveDeadline({signal:secondAbort.signal,deadlineUnixMs:wall+5000},1000);
    expireActiveDeadline(second);
    secondAbort.abort();
    assert.throws(()=>remainingOperationMs(second),{message:'TIMEOUT'});
    const thirdAbort=new AbortController();
    const third=bindActiveDeadline({signal:thirdAbort.signal,deadlineUnixMs:wall+5000},1000);
    thirdAbort.abort();boot+=2;
    assert.throws(()=>remainingOperationMs(third),{message:'CANCELLED'});
  } finally {t.mock.restoreAll();}
});

test('B-R2-ERR-01: late socket disconnect preserves elapsed timeout, not NETWORK',async t=>{
  let wall=Date.now(),mono=performance.now(),boot=os.uptime(),calls=0;
  await fixture(async cfg=>{
    t.mock.method(Date,'now',()=>wall);
    t.mock.method(performance,'now',()=>mono);
    t.mock.method(os,'uptime',()=>boot);
    try {
      await assert.rejects(transportFixture(new LoopbackRerankTransport(),cfg,input,token,
        {signal:new AbortController().signal,deadlineUnixMs:wall+cfg.limits.timeoutMs}),{message:'TIMEOUT'});
      assert.equal(calls,1);
    } finally {t.mock.restoreAll();}
  },(req,_res)=>{
    calls++;req.resume();req.on('end',()=>{
      mono+=3000;wall+=3000;
      req.socket.destroy();
    });
  });
});

// Controller-level terminal reason must be stable at every observable boundary,
// including the synchronous cancellation notification before the worker settles.
for (const [role, action] of [
  ['reranking','cancel'], ['generation','cancel'],
  ['reranking','revoke'], ['reranking','replace'],
] as const) for (const expired of [true,false]) {
  test('B-R2-TERM-02: '+role+' '+action+' '+(expired?'after expiry':'before expiry'),async t=>{
    let calls=0,reads=0,entered!:()=>void,release!:()=>void,stall=true;
    const entry=new Promise<void>(r=>{entered=r;});
    await fixture(async cfg=>{
      let wall=Date.now(),mono=1000,boot=1000;
      t.mock.method(Date,'now',()=>wall);
      t.mock.method(performance,'now',()=>mono);
      t.mock.method(os,'uptime',()=>boot);
      const response:SearchResponse={protocolVersion:2,requestId:'ui',requestedMode:'lexical',
        executedMode:'lexical',status:'ok',indexGenerationId:hash('generation'),hits:hits.slice(0,1),
        capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0};
      const port={config:()=>cfg,scopeId:()=>scopeId,verify:async()=>{
        reads++;if(stall)await new Promise<void>(r=>{release=r;entered();});
      }};
      const c=new SearchController(async()=>{},undefined,undefined,port,port);
      c.attach({search:async()=>response,status:()=>({status:'ready',generationId:hash('generation'),
        sources:1,records:1,busy:false,error:null,maintenanceWarning:null}),
        cancel:()=>true,resume:()=>{},rebuild:()=>{}});
      const prepare=()=>role==='reranking'?c.prepareRerank():c.prepareGeneration();
      const confirm=(p:ReturnType<typeof prepare>)=>role==='reranking'
        ?c.rerankConfirmed(p,'synthetic',token):c.generationConfirmed(p,'synthetic',token);
      const cancel=()=>role==='reranking'?c.cancelRerank():c.cancelGeneration();
      const other=role==='reranking'?'generation':'reranking';
      const expected=expired?'TIMEOUT':'CANCELLED';
      const observed:string[]=[];
      let lifecycle=0;
      try {
        await c.search(uiRequest(input.query,1));installFixture(c,cfg);
        const otherPreview=other==='generation'?c.prepareGeneration():c.prepareRerank();
        const pending=confirm(prepare());await entry;
        c.subscribe(()=>{lifecycle++;});
        const unsubscribe=c.subscribeEvidence(()=>{
          const status=c.evidenceOperationStatus(role);
          if(status.error)observed.push(status.error);
        });
        if(expired)mono+=cfg.limits.timeoutMs+1;
        if(action==='revoke')c.revokeRerankProfile();
        else if(action==='replace')installFixture(c,cfg);
        else cancel();
        assert.deepEqual(c.evidenceOperationStatus(role),{phase:'failed',error:expected});
        // No timer delivery or worker continuation is needed to publish the
        // correct cause. Repeated cancellation must not change it.
        if(!expired)mono+=cfg.limits.timeoutMs+1;
        wall-=100;cancel();
        assert.deepEqual(c.evidenceOperationStatus(role),{phase:'failed',error:expected});
        await pending;release();await Promise.resolve();await Promise.resolve();
        cancel();
        assert.deepEqual(c.evidenceOperationStatus(role),{phase:'failed',error:expected});
        assert.ok(observed.length>0);assert.ok(observed.every(x=>x===expected),JSON.stringify(observed));
        assert.equal(calls,0);assert.equal(reads,1);assert.equal(lifecycle,0);
        assert.equal(c.isEvidencePreviewCurrent(other,otherPreview.sequence),true);
        assert.deepEqual(c.snapshot().response,response);
        unsubscribe();
        if(action==='revoke')installFixture(c,cfg);
        // A distinct new preview can be cancelled; its reason is not inherited.
        if(expired){prepare();cancel();assert.equal(c.evidenceOperationStatus(role).error,'CANCELLED');}
        stall=false;await confirm(prepare());
        assert.deepEqual(c.evidenceOperationStatus(role),{phase:'complete',error:null});
        assert.equal(calls,1);assert.equal(reads,3);
        assert.equal(c.isEvidencePreviewCurrent(other,otherPreview.sequence),true);
        assert.deepEqual(c.snapshot().response,response);
      } finally {c.dispose();t.mock.restoreAll();}
    },(req,res)=>{calls++;requestBody(req,body=>reply(res,role==='reranking'
      ?{model:body.model,results:[{index:0,relevance_score:1}]}
      :{model:body.model,usage:{completion_tokens:4},choices:[{index:0,finish_reason:'stop',
        message:{role:'assistant',content:JSON.stringify({claims:[{kind:'quotation',text:'REQ-42',citationIds:[0]}]})}}]}));});
  });
}

// Exercise the actual controller, both roles and real synthetic loopback. The
// earlier listener must see a cross-role change made by a later listener.
for (const role of ['reranking','generation'] as const) {
  for (const action of ['cancel','cross-role','revoke','replace','configure','invalidate','dispose','search'] as const) {
    for (const expired of [false,true]) test(`B-R2-TERM-03: ${role} ${action} ${expired?'TIMEOUT':'CANCELLED'} reentrant`,async t=>{
      let calls=0,reads=0,entered!:()=>void,release!:()=>void,stall=true;
      const entry=new Promise<void>(r=>{entered=r;});
      await fixture(async cfg=>{
        let mono=1000;
        t.mock.method(performance,'now',()=>mono);
        const response:SearchResponse={protocolVersion:2,requestId:'ui',requestedMode:'lexical',
          executedMode:'lexical',status:'ok',indexGenerationId:hash('generation'),hits:hits.slice(0,1),
          capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0};
        const port={config:()=>cfg,scopeId:()=>scopeId,verify:async()=>{
          reads++;if(stall)await new Promise<void>(r=>{release=r;entered();});
        }};
        const c=new SearchController(async()=>{},undefined,undefined,port,port);
        c.attach({search:async()=>response,status:()=>({status:'ready',generationId:hash('generation'),
          sources:1,records:1,busy:false,error:null,maintenanceWarning:null}),cancel:()=>true,resume:()=>{},rebuild:()=>{}});
        const other=role==='reranking'?'generation':'reranking';
        const prepare=(r=role)=>r==='reranking'?c.prepareRerank():c.prepareGeneration();
        const cancel=(r=role)=>r==='reranking'?c.cancelRerank():c.cancelGeneration();
        const confirm=(p:ReturnType<typeof prepare>)=>p.role==='reranking'
          ?c.rerankConfirmed(p,'synthetic',token):c.generationConfirmed(p,'synthetic',token);
        const internal=c as unknown as {activeEvidence:Record<string,unknown>;previewTimers:Record<string,unknown>;prepared:Record<string,unknown>};
        const cause=expired?'TIMEOUT':'CANCELLED';
        const shared=['configure','invalidate','dispose','search'].includes(action);
        let depth=0,maxDepth=0,notifications=0,lifecycle=0,acted=false;
        let nextSearch:Promise<unknown>|undefined;
        const otherSeen:string[]=[];
        try {
          await c.search(uiRequest(input.query,1));installFixture(c,cfg);
          const otherPreview=prepare(other), preview=prepare(), op=confirm(preview);await entry;
          c.subscribe(()=>{lifecycle++;});
          const unsubFirst=c.subscribeEvidence(()=>{otherSeen.push(c.evidenceOperationStatus(other).phase);});
          const unsub=c.subscribeEvidence(()=>{
            depth++;maxDepth=Math.max(maxDepth,depth);notifications++;
            try {
              if(c.evidenceOperationStatus(role).error!==cause)return;
              cancel(); // unconditional terminal cleanup, including repeated notifications
              if(acted && action!=='revoke' && action!=='replace')return;
              acted=true;
              switch(action){
                case 'cross-role':cancel(other);break;
                case 'revoke':c.revokeRerankProfile();break;
                case 'replace':installFixture(c,cfg);break;
                case 'configure':c.configure(true,false);break;
                case 'invalidate':c.invalidate();break;
                case 'dispose':c.dispose();break;
                case 'search':nextSearch=c.search(uiRequest(input.query,1));break;
              }
            } finally {depth--;}
          });
          if(expired)mono+=cfg.limits.timeoutMs+1;
          cancel();
          assert.equal(acted,true);assert.equal(maxDepth,1);
          if(!shared)assert.equal(c.evidenceOperationStatus(role).error,cause);
          if(!expired)mono+=cfg.limits.timeoutMs+1;
          await op;release();await nextSearch;await Promise.resolve();await Promise.resolve();
          assert.equal(calls,0);assert.equal(reads,1);assert.equal(maxDepth,1);
          assert.equal(internal.activeEvidence[role],undefined);
          assert.equal(internal.previewTimers[role],undefined);assert.equal(internal.prepared[role],undefined);
          if(shared){
            assert.equal(c.snapshot().rerank,undefined);assert.equal(c.snapshot().generation,undefined);
            assert.equal(internal.previewTimers[other],undefined);assert.equal(internal.prepared[other],undefined);
            assert.ok(lifecycle>0);assert.equal(notifications,1,'old revision must not publish after shared invalidation');
          } else {
            cancel();await Promise.resolve();await Promise.resolve();
            assert.equal(c.evidenceOperationStatus(role).error,cause);
            assert.equal(lifecycle,0);assert.equal(maxDepth,1);assert.ok(notifications<=5);
            const otherCancelled=action==='cross-role'||role==='generation'&&(action==='revoke'||action==='replace');
            assert.equal(c.isEvidencePreviewCurrent(other,otherPreview.sequence),!otherCancelled);
            if(otherCancelled){assert.ok(otherSeen.includes('failed'));assert.equal(internal.previewTimers[other],undefined);}
            assert.deepEqual(c.snapshot().response,response);
          }
          unsub();unsubFirst();
          await assert.rejects(confirm(preview),{message:'DISCLOSURE_DENIED'});
          if(action==='dispose')return;
          if(shared && action!=='search')await c.search(uiRequest(input.query,1));
          installFixture(c,cfg);stall=false;
          const fresh=prepare();await confirm(fresh);
          assert.equal(c.evidenceOperationStatus(role).phase,'complete');assert.equal(calls,1);
          await assert.rejects(confirm(fresh),{message:'DISCLOSURE_DENIED'});
          // Completion is retired BEFORE its observer runs. Cleanup from that
          // observer may cancel results but may not recursively notify itself.
          let completed=false;
          const finish=c.subscribeEvidence(()=>{
            depth++;maxDepth=Math.max(maxDepth,depth);
            try {
              if(c.evidenceOperationStatus(role).phase==='complete'){
                assert.equal(internal.activeEvidence[role],undefined);completed=true;cancel();
              }else if(c.evidenceOperationStatus(role).error==='CANCELLED')cancel();
            }finally{depth--;}
          });
          await confirm(prepare());finish();
          assert.equal(completed,true);assert.equal(maxDepth,1);assert.equal(c.evidenceOperationStatus(role).error,'CANCELLED');
          assert.equal(calls,2);assert.equal(internal.activeEvidence[role],undefined);assert.equal(internal.previewTimers[role],undefined);
        } finally {c.dispose();t.mock.restoreAll();}
      },(req,res)=>{calls++;requestBody(req,body=>reply(res,role==='reranking'
        ?{model:body.model,results:[{index:0,relevance_score:1}]}
        :{model:body.model,usage:{completion_tokens:4},choices:[{index:0,finish_reason:'stop',
          message:{role:'assistant',content:JSON.stringify({claims:[{kind:'quotation',text:'REQ-42',citationIds:[0]}]})}}]}));});
    });
  }
}

for(const first of ['reranking','generation'] as const) test(`B-R2-TERM-03: ${first} cross-role active cancellation`,async t=>{
  let calls=0,reads=0,entered!:()=>void;
  const releases:(()=>void)[]=[];
  const entry=new Promise<void>(r=>{entered=r;});
  await fixture(async cfg=>{
    let mono=1000;t.mock.method(performance,'now',()=>mono);
    const response:SearchResponse={protocolVersion:2,requestId:'ui',requestedMode:'lexical',
      executedMode:'lexical',status:'ok',indexGenerationId:hash('generation'),hits:hits.slice(0,1),
      capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0};
    const port={config:()=>cfg,scopeId:()=>scopeId,verify:()=>new Promise<void>(r=>{
      releases.push(r);if(++reads===2)entered();
    })};
    const c=new SearchController(async()=>{},undefined,undefined,port,port);
    c.attach({search:async()=>response,status:()=>({status:'ready',generationId:hash('generation'),
      sources:1,records:1,busy:false,error:null,maintenanceWarning:null}),cancel:()=>true,resume:()=>{},rebuild:()=>{}});
    const second=first==='reranking'?'generation':'reranking';
    const cancel=(role:typeof first|typeof second)=>role==='reranking'?c.cancelRerank():c.cancelGeneration();
    const start=(role:typeof first|typeof second)=>role==='reranking'
      ?c.rerankConfirmed(c.prepareRerank(),'synthetic',token):c.generationConfirmed(c.prepareGeneration(),'synthetic',token);
    try {
      await c.search(uiRequest(input.query,1));installFixture(c,cfg);
      const a=start(first);mono+=1000;const b=start(second);await entry;
      mono+=1001; // first elapsed, second still within its own deadline
      let nesting=0,maxNesting=0,count=0;const seen:string[]=[];
      c.subscribeEvidence(()=>seen.push(String(c.evidenceOperationStatus(second).error)));
      c.subscribeEvidence(()=>{
        nesting++;maxNesting=Math.max(maxNesting,nesting);count++;
        try{if(c.evidenceOperationStatus(first).error==='TIMEOUT'){cancel(first);cancel(second);}}
        finally{nesting--;}
      });
      cancel(first);
      assert.equal(c.evidenceOperationStatus(first).error,'TIMEOUT');
      assert.equal(c.evidenceOperationStatus(second).error,'CANCELLED');
      assert.deepEqual(seen,['null','CANCELLED']);
      mono+=cfg.limits.timeoutMs;await Promise.all([a,b]);releases.forEach(r=>r());await Promise.resolve();
      assert.equal(c.evidenceOperationStatus(first).error,'TIMEOUT');
      assert.equal(c.evidenceOperationStatus(second).error,'CANCELLED');
      assert.equal(maxNesting,1);assert.equal(count,4);assert.equal(calls,0);assert.equal(reads,2);
      assert.deepEqual(c.snapshot().response,response);
    } finally{c.dispose();t.mock.restoreAll();}
  },(req,res)=>{calls++;req.resume();reply(res,{});});
});

// B-R2-TERM-04: no server is opened; admission failures must precede reads/HTTP.
async function observerController() {
  let reads=0;
  const cfg=configAt(1);
  const port={config:()=>cfg,scopeId:()=>scopeId,verify:async()=>{reads++;}};
  const c=new SearchController(async()=>{},undefined,undefined,port,port);
  const response:SearchResponse={protocolVersion:2,requestId:'ui',requestedMode:'lexical',
    executedMode:'lexical',status:'ok',indexGenerationId:hash('generation'),hits:hits.slice(0,1),
    capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0};
  c.attach({search:async()=>response,status:()=>({status:'ready',generationId:hash('generation'),
    sources:1,records:1,busy:false,error:null,maintenanceWarning:null}),cancel:()=>true,resume:()=>{},rebuild:()=>{}});
  await c.search(uiRequest(input.query,1));installFixture(c,cfg);
  return {c,cfg,reads:()=>reads};
}
for(const last of [false,true]) for(const steps of [6,15]) {
  test(`B-R2-TERM-04 finite ${steps} mutation deliveries, mutator ${last?'last':'first'}`,async t=>{
    const {c,reads}=await observerController();
    const warnings:unknown[][]=[];t.mock.method(console,'warn',(...args:unknown[])=>warnings.push(args));
    let remaining=steps,depth=0,maxDepth=0;
    const seen:string[][]=[[],[],[]];
    const snapshot=()=>JSON.stringify([c.evidenceOperationStatus('reranking'),c.evidenceOperationStatus('generation')]);
    const mutator=()=>{
      depth++;maxDepth=Math.max(maxDepth,depth);
      try {if(remaining-->0){
        const role=remaining%2?'reranking':'generation';
        if(c.evidenceOperationStatus(role).phase==='permission-required') {
          if(role==='reranking')c.cancelRerank();else c.cancelGeneration();
        } else if(role==='reranking')c.prepareRerank();else c.prepareGeneration();
      }}finally{depth--;}
    };
    try {
      c.prepareRerank();
      if(!last)c.subscribeEvidence(mutator);
      for(const observations of seen)c.subscribeEvidence(()=>observations.push(snapshot()));
      if(last)c.subscribeEvidence(mutator);
      c.cancelRerank();
      assert.ok(remaining<0);assert.equal(maxDepth,1);assert.deepEqual(warnings,[]);
      for(const observations of seen)assert.equal(observations.at(-1),snapshot());
      assert.equal(reads(),0);
    }finally{c.dispose();}
  });
}
test('B-R2-TERM-04 storm quarantine survives re-add; healthy observers converge and recover',async t=>{
  const {c,reads}=await observerController();
  const warnings:unknown[][]=[];t.mock.method(console,'warn',(...args:unknown[])=>warnings.push(args));
  let deliveries=0,healthy=0,last='',remove=()=>{};
  const storm=()=>{
    deliveries++;remove();remove=c.subscribeEvidence(storm);
    if(c.evidenceOperationStatus('generation').phase==='permission-required')c.cancelGeneration();else c.prepareGeneration();
  };
  try {
    c.prepareRerank();
    c.subscribeEvidence(()=>{healthy++;last=JSON.stringify(c.snapshot());});
    remove=c.subscribeEvidence(storm);
    c.cancelRerank();
    assert.equal(deliveries,16);assert.ok(healthy<=18);assert.equal(last,JSON.stringify(c.snapshot()));
    assert.deepEqual(warnings,[['SEARCH_OBSERVER_QUARANTINED','mutation-budget']]);
    c.subscribeEvidence(storm);c.subscribe(storm);
    assert.equal(warnings.length,3);
    const before=healthy;c.prepareRerank();c.cancelRerank();
    assert.ok(healthy>before);assert.equal(deliveries,16);assert.equal(last,JSON.stringify(c.snapshot()));
    assert.equal(reads(),0);
  }finally{c.dispose();}
});
test('B-R2-TERM-04 fresh callback registration churn is bounded and explicitly rejected',async t=>{
  const {c}=await observerController();
  const warnings:unknown[][]=[];t.mock.method(console,'warn',(...args:unknown[])=>warnings.push(args));
  let delivered=0,seen='',remove=()=>{};
  const add=()=>{remove();remove=c.subscribeEvidence(()=>{delivered++;add();});};
  try {
    c.prepareRerank();c.subscribeEvidence(()=>{seen=JSON.stringify(c.snapshot());});add();
    c.cancelRerank();
    assert.equal(delivered,33);
    assert.deepEqual(warnings,[['SEARCH_OBSERVER_REJECTED','registration-budget']]);
    assert.equal(seen,JSON.stringify(c.snapshot()));
  }finally{c.dispose();}
});
test('B-R2-TERM-04 exceptions do not swallow final state or poison subsequent waves',async t=>{
  const {c}=await observerController();
  const warnings:unknown[][]=[];t.mock.method(console,'warn',(...args:unknown[])=>warnings.push(args));
  let seen='',throws=0;
  try {
    c.prepareRerank();c.prepareGeneration();
    c.subscribeEvidence(()=>{seen=JSON.stringify(c.snapshot());});
    c.subscribeEvidence(()=>{throws++;c.cancelGeneration();throw Error('private text must not be logged');});
    c.cancelRerank();
    assert.equal(seen,JSON.stringify(c.snapshot()));assert.equal(throws,1);
    assert.deepEqual(warnings,[['SEARCH_OBSERVER_QUARANTINED','exception']]);
    c.prepareGeneration();assert.equal(seen,JSON.stringify(c.snapshot()));assert.equal(throws,1);
  }finally{c.dispose();}
});
for(const action of ['configure','invalidate','dispose'] as const) {
  test(`B-R2-TERM-04 dual-channel callback ${action} is nonrecursive and supersedes evidence`,async()=>{
    const {c}=await observerController();
    let depth=0,maxDepth=0,acted=false,lateEvidence=0,lifecycle=0;
    const observer=()=>{depth++;maxDepth=Math.max(maxDepth,depth);try{
      if(!acted){acted=true;if(action==='configure')c.configure(true,false);else c[action]();}
    }finally{depth--;}};
    try {
      c.prepareRerank();c.subscribe(observer);c.subscribe(()=>lifecycle++);
      c.subscribeEvidence(observer);c.subscribeEvidence(()=>lateEvidence++);
      c.cancelRerank();await Promise.resolve();
      assert.equal(maxDepth,1);assert.equal(lateEvidence,0);assert.equal(lifecycle,1);
      assert.equal(c.snapshot().rerank,undefined);
    }finally{c.dispose();}
  });
}
test('B-R2-TERM-04 removal, late addition, deferred expiry and stale grant cleanup',async t=>{
  const {c,cfg,reads}=await observerController();
  let mono=1000;t.mock.method(performance,'now',()=>mono);installFixture(c,cfg);
  let last='',removed=0,added=0,once=false;
  try {
    const stale=c.prepareRerank();c.prepareGeneration();
    c.subscribeEvidence(()=>{last=JSON.stringify(c.snapshot());});
    let unsubscribe=()=>{};
    c.subscribeEvidence(()=>{if(!once){once=true;unsubscribe();c.subscribeEvidence(()=>added++);mono+=EVIDENCE_PREVIEW_TTL_MS+1;c.snapshot();}});
    unsubscribe=c.subscribeEvidence(()=>removed++);
    c.cancelRerank();
    assert.equal(removed,0);assert.ok(added>0);assert.equal(last,JSON.stringify(c.snapshot()));
    const before=added;await Promise.resolve();assert.equal(added,before);
    await assert.rejects(c.rerankConfirmed(stale,'synthetic',token),{message:'DISCLOSURE_DENIED'});
    assert.equal(reads(),0);
    installFixture(c,cfg);c.prepareRerank();mono+=EVIDENCE_PREVIEW_TTL_MS+1;
    c.snapshot();const prior=added;await Promise.resolve();assert.ok(added>prior);
    assert.equal(last,JSON.stringify(c.snapshot()));
    const internal=c as unknown as {previewTimers:Record<string,unknown>;prepared:Record<string,unknown>};
    assert.deepEqual(internal.previewTimers,{});assert.deepEqual(internal.prepared,{});
  }finally{c.dispose();}
});
