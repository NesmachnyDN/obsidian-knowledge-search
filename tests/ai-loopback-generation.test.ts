import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {bindActiveDeadline} from '../plugin/src/ai/active-deadline';
import {LoopbackGenerationTransport} from '../plugin/src/ai/loopback-generation';
import {EvidenceGenerator} from '../plugin/src/ai/generation-evidence';
import {type ProviderConfig} from '../plugin/src/ai/contracts';
import {type EvidenceApproval} from '../plugin/src/ai/verified-evidence';
import {configDigest} from '../plugin/src/ai/disclosure';
import {hash,type EvidenceHit} from '../plugin/src/standalone/contracts';
import {parseMarkdown} from '../plugin/src/standalone/markdown';
import {verifySpan} from '../plugin/src/search/navigation';

const token='synthetic-token';
const input={query:'REQ-42',passages:[{id:0,text:'REQ-42: original evidence'},{id:1,text:'REQ-42: second evidence'}]};
const model='synthetic-generator@fixture-v1';
const context=(signal=new AbortController().signal)=>({signal,deadlineUnixMs:Date.now()+3000});
const good=(claims:unknown= [{kind:'quotation',text:'original evidence',citationIds:[0]},
  {kind:'inference',text:'The requirements may be related.',citationIds:[0,1]}])=>({
  model,usage:{completion_tokens:25},choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({claims})}}]});
function reply(res:ServerResponse,value:unknown,status=200) {
  res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));
}
async function fixture(run:(cfg:ProviderConfig)=>Promise<void>,handler:(req:IncomingMessage,res:ServerResponse)=>void) {
  const server=createServer(handler);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const address=server.address();if(!address||typeof address==='string')throw Error('FIXTURE_ADDRESS');
    await run({state:'configured',transport:'local',origin:'http://127.0.0.1:'+address.port,
      identity:{model:'synthetic-generator',revision:'fixture-v1'},
      limits:{timeoutMs:1500,maxInputBytes:4096,maxCandidates:3,maxOutputTokens:32,maxConcurrent:1}});
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }
}
test('generation uses actual loopback chat-completions request, structured output and ordinal-only evidence',async()=>{
  let body:Record<string,unknown>|undefined;
  await fixture(async cfg=>{
    const result=await new LoopbackGenerationTransport().generate(cfg,input,token,context());
    assert.deepEqual(result,[{kind:'quotation',text:'original evidence',citationIds:[0]},
      {kind:'inference',text:'The requirements may be related.',citationIds:[0,1]}]);
    assert.equal(body?.model,model);assert.equal(body?.stream,false);assert.equal(body?.max_tokens,32);
    assert.equal(Object.hasOwn(body!,'tools'),false);
    assert.deepEqual(JSON.parse((body!.messages as {content:string}[])[1]!.content),
      {question:input.query,passages:input.passages});
    assert.equal((body!.response_format as {type:string}).type,'json_schema');
  },(req,res)=>{
    assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer '+token);
    let wire='';req.on('data',chunk=>{wire+=String(chunk);});req.on('end',()=>{body=JSON.parse(wire);reply(res,good());});
  });
});
test('reject fabricated quote, unknown/duplicate/empty citations, wrong model, truncation, tools, token excess',async()=>{
  const cases:[unknown,string][]=[
    [good([{kind:'quotation',text:'invented',citationIds:[0]}]),'INVALID_RESPONSE'],
    [good([{kind:'quotation',text:'original evidence',citationIds:[0,1]}]),'INVALID_RESPONSE'],
    [good([{kind:'inference',text:'x',citationIds:[2]}]),'INVALID_RESPONSE'],
    [good([{kind:'inference',text:'x',citationIds:[0,0]}]),'INVALID_RESPONSE'],
    [good([{kind:'inference',text:'x',citationIds:[]}]),'INVALID_RESPONSE'],
    [good([{kind:'inference',text:'x',citationIds:[0],path:'fake'}]),'INVALID_RESPONSE'],
    [{...good(),model:'wrong'},'MODEL_MISMATCH'],
    [{...good(),usage:{completion_tokens:33}},'INVALID_RESPONSE'],
    [{...good(),choices:[{...good().choices[0],finish_reason:'length'}]},'INVALID_RESPONSE'],
    [{...good(),choices:[{...good().choices[0],message:{...good().choices[0]!.message,tool_calls:[]}}]},'INVALID_RESPONSE'],
    [{...good(),choices:[{...good().choices[0],message:{role:'assistant',content:'not json'}}]},'INVALID_RESPONSE'],
  ];
  let count=0;
  await fixture(async cfg=>{
    const t=new LoopbackGenerationTransport();
    for(const [,message] of cases)await assert.rejects(t.generate(cfg,input,token,context()),{message});
    assert.deepEqual(await t.generate(cfg,input,token,context()),[]);
  },(req,res)=>{req.resume();reply(res,cases[count++]?.[0]??good([]));});
});
const scopeId=hash('synthetic-generation-scope');
const bytes=input.passages.map(p=>Buffer.from('# Synthetic\n'+p.text+'\n'));
const hits:EvidenceHit[]=bytes.map((raw,i)=>{
  const doc=parseMarkdown('fixture-'+i+'.md',raw,scopeId);const block=doc.blocks[1]!;
  return {sourceId:doc.sourceId,sourceSha256:doc.sha256,originalExcerpt:block.originalText,
    sourceLocators:[block.locator],rank:i+1,lexicalRank:i+1,retrievalMode:'lexical',
    indexGenerationId:hash('generation'),score:2-i,headings:[],wikiLinks:[],properties:[]};
});
function approve(config:ProviderConfig):EvidenceApproval {
  return {config,scopeId,query:{text:input.query,classification:'synthetic'},
    candidates:hits.map(hit=>({hit,classification:'synthetic'})),grant:{
      version:1,role:'generation',configDigest:configDigest('generation',config),scopeId,
      expiresUnixMs:Date.now()+10000,queryDigest:hash(input.query),queryClassification:'synthetic',
      sources:hits.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,
        excerptDigest:hash(hit.originalExcerpt),classification:'synthetic'}))}};
}
test('generation uses exact role-specific grant, original citations and pre/post verification',async()=>{
  let calls=0,checks=0,stale=false,current=true;
  await fixture(async cfg=>{
    const gen=new EvidenceGenerator(),a=approve(cfg);
    const verify=async(hit:EvidenceHit)=>{checks++;const i=hits.findIndex(h=>h.sourceId===hit.sourceId);
      verifySpan(hit,stale&&calls>1?Buffer.from('modified'):bytes[i]!);};
    const claims=await gen.run(a,token,context(),verify,()=>current);
    assert.deepEqual(claims.map(c=>c.citations),[[hits[0]],[hits[0],hits[1]]]);assert.equal(checks,4);
    await assert.rejects(gen.run({...a,grant:{...a.grant,role:'reranking'}},token,context(),verify,()=>current),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(gen.run({...a,candidates:[{hit:hits[0]!,classification:'unknown'}]},token,context(),verify,()=>current),{message:'DISCLOSURE_DENIED'});
    assert.equal(calls,1);
    stale=true;await assert.rejects(gen.run(a,token,context(),verify,()=>current),{message:'SOURCE_STALE'});
    assert.equal(calls,2);current=false;
    await assert.rejects(gen.run(a,token,context(),verify,()=>current),{message:'CANCELLED'});
    assert.equal(calls,2);
  },(req,res)=>{calls++;req.resume();reply(res,good());});
});
test('generation endpoint denial, authorization, rate limit, abort and no fallback',async()=>{
  let calls=0;
  let received!:()=>void;const waiting=new Promise<void>(r=>{received=r;});
  await fixture(async cfg=>{
    const gen=new LoopbackGenerationTransport();
    await assert.rejects(gen.generate({...cfg,transport:'cloud',origin:'https://api.example.com'},input,token,context()),{message:'ENDPOINT_DENIED'});
    await assert.rejects(gen.generate(cfg,input,'',context()),{message:'UNAUTHENTICATED'});
    await assert.rejects(gen.generate(cfg,input,token,context()),{message:'FORBIDDEN'});
    await assert.rejects(gen.generate(cfg,input,token,context()),{message:'RATE_LIMITED'});
    const abort=new AbortController();
    const pending=gen.generate(cfg,input,token,context(abort.signal));
    await waiting;
    await assert.rejects(gen.generate(cfg,input,token,context()),{message:'QUOTA_EXCEEDED'});
    abort.abort();await assert.rejects(pending,{message:'CANCELLED'});
    assert.equal(calls,3);
  },(req,res)=>{req.resume();calls++;if(calls===1)reply(res,{},403);else if(calls===2)reply(res,{},429);else received();});
});

import {SearchController,uiRequest} from '../plugin/src/search/controller';
import type {SearchResponse} from '../plugin/src/standalone/contracts';
test('generation controller uses independent roles, one-shot preview, no lexical mutation, revoke on lifecycle',async()=>{
  let calls=0;
  await fixture(async cfg=>{
    const response:SearchResponse={protocolVersion:2,requestId:'ui',requestedMode:'lexical',
      executedMode:'lexical',status:'ok',indexGenerationId:hash('generation'),hits,
      capabilityReadiness:{lexical:'ready',dense:'unavailable'},error:null,staleSourceCount:0};
    const port={config:()=>cfg,scopeId:()=>scopeId,verify:async(hit:EvidenceHit)=>{
      verifySpan(hit,bytes[hits.findIndex(h=>h.sourceId===hit.sourceId)]!);
    }};
    const controller=new SearchController(async()=>{},undefined,undefined,
      {...port,config:()=>({state:'disabled' as const})},port);
    controller.attach({search:async()=>response,status:()=>({status:'ready',generationId:hash('generation'),
      sources:2,records:2,busy:false,error:null,maintenanceWarning:null}),
      cancel:()=>true,resume:()=>{},rebuild:()=>{}});
    await controller.search(uiRequest(input.query,2));
    assert.throws(()=>controller.prepareRerank(),{message:'DISABLED'});
    const earlier=controller.prepareGeneration(), newer=controller.prepareGeneration();
    await assert.rejects(controller.generationConfirmed(earlier,'synthetic',token),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(controller.generationConfirmed(newer,'synthetic',token),{message:'DISCLOSURE_DENIED'});
    const preview=controller.prepareGeneration();
    await assert.rejects(controller.generationConfirmed({...preview,role:'reranking'},'synthetic',token),{message:'DISCLOSURE_DENIED'});
    assert.equal(calls,0);
    const approved=controller.prepareGeneration();
    await controller.generationConfirmed(approved,'synthetic',token);
    assert.equal(controller.snapshot().generation?.phase,'results');
    assert.deepEqual(controller.snapshot().generation?.hits.map(x=>x.citations),[[hits[0]],[hits[0],hits[1]]]);
    assert.deepEqual(controller.snapshot().response,response);
    assert.equal(controller.snapshot().rerank,undefined);
    await assert.rejects(controller.generationConfirmed(approved,'synthetic',token),{message:'DISCLOSURE_DENIED'});
    const next=controller.prepareGeneration();controller.invalidate();
    await assert.rejects(controller.generationConfirmed(next,'synthetic',token),{message:'DISCLOSURE_DENIED'});
    assert.equal(controller.snapshot().generation,undefined);
    assert.equal(calls,1);
    controller.dispose();
  },(req,res)=>{calls++;req.resume();reply(res,good());});
});

test('B-R2-ERR-01: shared generation transport preserves timeout on late socket error',async t=>{
  let wall=Date.now(),mono=performance.now(),boot=os.uptime(),calls=0;
  await fixture(async cfg=>{
    t.mock.method(Date,'now',()=>wall);
    t.mock.method(performance,'now',()=>mono);
    t.mock.method(os,'uptime',()=>boot);
    try {
      const budget=bindActiveDeadline({signal:new AbortController().signal,
        deadlineUnixMs:wall+cfg.limits.timeoutMs},cfg.limits.timeoutMs);
      await assert.rejects(new LoopbackGenerationTransport().generate(cfg,input,token,budget),{message:'TIMEOUT'});
      assert.equal(calls,1);
    } finally {t.mock.restoreAll();}
  },(req,_res)=>{
    calls++;req.resume();req.on('end',()=>{mono+=2000;wall+=2000;req.socket.destroy();});
  });
});
