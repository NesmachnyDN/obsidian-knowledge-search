import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { LoopbackRerankTransport, servedAlias } from '../plugin/src/ai/loopback-rerank';
import { EvidenceReranker, type RerankApproval } from '../plugin/src/ai/rerank-evidence';
import { type ProviderConfig } from '../plugin/src/ai/contracts';
import { configDigest } from '../plugin/src/ai/disclosure';
import { hash, type EvidenceHit } from '../plugin/src/standalone/contracts';
import { parseMarkdown } from '../plugin/src/standalone/markdown';
import { verifySpan } from '../plugin/src/search/navigation';

const token = randomBytes(24).toString('hex');
const configAt = (port: number): ProviderConfig => ({ state:'configured', transport:'local',
  origin:'http://127.0.0.1:'+port, identity:{model:'synthetic-reranker',revision:'fixture-v1'},
  limits:{timeoutMs:2000,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1} });
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
    const result=await new LoopbackRerankTransport().rerank(cfg,input,token,context());
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
    await assert.rejects(t.rerank(cfg,input,'',context()),{message:'UNAUTHENTICATED'});
    await assert.rejects(t.rerank(cfg,input,'bad\r\nheader',context()),{message:'UNAUTHENTICATED'});
    await assert.rejects(t.rerank({...cfg,limits:{...cfg.limits,maxInputBytes:5}},
      {query:'я',passages:[{id:0,text:'яя'}]},token,context()),{message:'LIMIT_EXCEEDED'});
    await assert.rejects(t.rerank(cfg,{query:'x',passages:[{id:2,text:'x'}]},token,context()),{message:'INVALID_RESPONSE'});
    const abort=new AbortController();abort.abort();
    await assert.rejects(t.rerank(cfg,input,token,context(abort.signal)),{message:'CANCELLED'});
    await assert.rejects(t.rerank(cfg,input,token,{...context(),deadlineUnixMs:0}),{message:'TIMEOUT'});
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
    for(const [, , code] of cases) await assert.rejects(t.rerank(cfg,input,token,context()),{message:code});
    await assert.rejects(t.rerank(cfg,input,token,context()),{message:'INVALID_RESPONSE'});
    await assert.rejects(t.rerank(cfg,input,token,context()),{message:'LIMIT_EXCEEDED'});
    await assert.rejects(t.rerank(cfg,input,token,context()),{message:'NETWORK'});
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
    const first=t.rerank(cfg,input,token,context(abort.signal));
    await received;
    await assert.rejects(t.rerank(cfg,input,token,context()),{message:'QUOTA_EXCEEDED'});
    abort.abort();await assert.rejects(first,{message:'CANCELLED'});
    received=new Promise<void>(r=>{entered=r;});
    await assert.rejects(t.rerank({...cfg,limits:{...cfg.limits,timeoutMs:100}},input,token,context()),{message:'TIMEOUT'});
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
function approval(cfg:ProviderConfig):RerankApproval {
  return {config:cfg,scopeId,query:{text:input.query,classification:'synthetic'},
    candidates:hits.map(hit=>({hit,classification:'synthetic'})),grant:{
      version:1,role:'reranking',configDigest:configDigest('reranking',cfg),scopeId,
      expiresUnixMs:Date.now()+10000,queryDigest:hash(input.query),queryClassification:'synthetic',
      sources:hits.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,
        excerptDigest:hash(hit.originalExcerpt),classification:'synthetic'}))}};
}
test('verified source-backed evidence survives reorder; grant and fresh source required before and after transport',async()=>{
  let calls=0;let verifyCount=0;let staleAfter=false;let current=true;
  await fixture(async cfg=>{
    const r=new EvidenceReranker();const a=approval(cfg);
    const verify=async(hit:EvidenceHit)=>{verifyCount++;const i=hits.findIndex(h=>h.sourceId===hit.sourceId);
      verifySpan(hit,staleAfter&&calls>1?Buffer.from('changed'):bytes[i]!);};
    const result=await r.run(a,token,context(),verify,()=>current);
    assert.deepEqual(result,[{evidence:hits[1],rerankRank:1,rerankScore:0.9},
      {evidence:hits[0],rerankRank:2,rerankScore:0.2}]);
    assert.equal(verifyCount,4);assert.equal(calls,1);
    await assert.rejects(r.run({...a,config:{...cfg,identity:{...cfg.identity,revision:'changed'}}},token,context(),verify,()=>current),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(r.run({...a,candidates:[{hit:hits[0]!,classification:'unknown'}]},token,context(),verify,()=>current),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(r.run(a,token,context(),async()=>{throw Error('private source')},()=>current),{message:'SOURCE_STALE'});
    assert.equal(calls,1);
    staleAfter=true;
    await assert.rejects(r.run(a,token,context(),verify,()=>current),{message:'SOURCE_STALE'});
    assert.equal(calls,2);
    current=false;
    await assert.rejects(r.run(a,token,context(),verify,()=>current),{message:'CANCELLED'});
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
    const tamper=controller.prepareRerank();
    await assert.rejects(controller.rerankConfirmed({...tamper,query:'changed'},'synthetic',token),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(controller.rerankConfirmed(tamper,'synthetic',token),{message:'DISCLOSURE_DENIED'});
    const changed=controller.prepareRerank();preference={...cfg,identity:{...cfg.identity,revision:'changed'}};
    await assert.rejects(controller.rerankConfirmed(changed,'synthetic',token),{message:'CANCELLED'});
    assert.equal(calls,0);
    preference=cfg;
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
    await assert.rejects(reranker.run(approval(short),token,context(),()=>stalled.promise,()=>true),{message:'TIMEOUT'});
    assert.equal(calls,0);
    assert.equal((await reranker.run(approval(cfg),token,context(),verify,()=>true)).length,2);
    stalled.reject(Error('late private failure'));
    let entered!:()=>void;const entry=new Promise<void>(r=>{entered=r;});
    const cancelled=defer();const abort=new AbortController();
    const pending=reranker.run(approval(cfg),token,context(abort.signal),()=>{entered();return cancelled.promise;},()=>true);
    await entry;abort.abort();await assert.rejects(pending,{message:'CANCELLED'});
    assert.equal(calls,1);
    assert.equal((await reranker.run(approval(cfg),token,context(),verify,()=>true)).length,2);
    cancelled.resolve();
    let count=0;const post=defer();
    await assert.rejects(reranker.run(approval(short),token,context(),async hit=>{
      if(++count>2)return post.promise;await verify(hit);
    },()=>true),{message:'TIMEOUT'});
    assert.equal(calls,3);
    assert.equal((await reranker.run(approval(cfg),token,context(),verify,()=>true)).length,2);
    post.reject(Error('late after HTTP'));
    let after!:()=>void;const afterEntry=new Promise<void>(r=>{after=r;});const afterDeferred=defer();
    const afterAbort=new AbortController();count=0;
    const afterPending=reranker.run(approval(cfg),token,context(afterAbort.signal),async hit=>{
      if(++count>2){after();return afterDeferred.promise;}await verify(hit);
    },()=>true);
    await afterEntry;afterAbort.abort();await assert.rejects(afterPending,{message:'CANCELLED'});
    assert.equal((await reranker.run(approval(cfg),token,context(),verify,()=>true)).length,2);
    afterDeferred.resolve();assert.equal(calls,6);
  },(req,res)=>{calls++;requestBody(req,body=>reply(res,good(body.model)));});
});
test('abandoned verifier budget is bounded; late settlement permits recovery',async()=>{
  await fixture(async cfg=>{
    const reranker=new EvidenceReranker();
    const short={...cfg,limits:{...cfg.limits,timeoutMs:100}};
    const resolvers:Array<()=>void>=[];
    const stall=()=>new Promise<void>(r=>resolvers.push(r));
    for(let i=0;i<2;i++)await assert.rejects(reranker.run(approval(short),token,context(),stall,()=>true),{message:'TIMEOUT'});
    await assert.rejects(reranker.run(approval(short),token,context(),stall,()=>true),{message:'QUOTA_EXCEEDED'});
    assert.equal(resolvers.length,2);resolvers.forEach(r=>r());await Promise.resolve();await Promise.resolve();
    const result=await reranker.run(approval(cfg),token,context(),async hit=>{
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
