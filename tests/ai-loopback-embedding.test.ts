import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {LoopbackEmbeddingTransport} from '../plugin/src/ai/loopback-embedding';
import {EvidenceEmbedder,type EmbeddingApproval} from '../plugin/src/ai/embedding-evidence';
import {embeddingSpaceId} from '../plugin/src/ai/embedding-space';
import type {EmbeddingSpace,ProviderConfig} from '../plugin/src/ai/contracts';
import {configDigest} from '../plugin/src/ai/disclosure';
import {hash,type EvidenceHit} from '../plugin/src/standalone/contracts';
import {parseMarkdown} from '../plugin/src/standalone/markdown';
import {verifySpan} from '../plugin/src/search/navigation';

const token='synthetic-embedding-token',model='synthetic-embedding@fixture-v1';
const space:EmbeddingSpace={model:'synthetic-embedding',revision:'fixture-v1',dimension:3,
  normalization:'unit-l2',serializationId:'utf8-verbatim-v1',queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
const context=(signal=new AbortController().signal)=>({signal,deadlineUnixMs:Date.now()+3000});
const query={query:'REQ-42',passages:[]};
const documents={query:'approved document batch',passages:[{id:0,text:'REQ-42: alpha'},{id:1,text:'REQ-42: beta'}]};
const item=(index:number,embedding:unknown)=>({object:'embedding',index,embedding});
const good=(count=2)=>({model,data:count===1?[item(0,[1,0,0])]:[item(1,[0,1,0]),item(0,[1,0,0])]});
function reply(res:ServerResponse,value:unknown,status=200){
  res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));
}
function body(req:IncomingMessage,done:(x:Record<string,unknown>)=>void){
  const chunks:Buffer[]=[];req.on('data',(x:Buffer)=>chunks.push(x));req.on('end',()=>done(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
}
async function fixture(run:(cfg:ProviderConfig)=>Promise<void>,handler:(req:IncomingMessage,res:ServerResponse)=>void){
  const server=createServer(handler);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{
    const address=server.address();if(!address||typeof address==='string')throw Error('FIXTURE_ADDRESS');
    await run({state:'configured',transport:'local',origin:'http://127.0.0.1:'+address.port,
      identity:{model:space.model,revision:space.revision},
      limits:{timeoutMs:1500,maxInputBytes:4096,maxCandidates:20,maxOutputTokens:32,maxConcurrent:1}});
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
}
test('authenticated query/document float embeddings preserve ordinal order and space identity',async()=>{
  let calls=0;
  await fixture(async cfg=>{
    const transport=new LoopbackEmbeddingTransport();
    const q=await transport.embed(cfg,space,'query',query,token,context());
    const docs=await transport.embed(cfg,space,'document',documents,token,context());
    assert.deepEqual(q,{spaceId:embeddingSpaceId(cfg,space),purpose:'query',vectors:[[1,0,0]]});
    assert.deepEqual(docs,{spaceId:q.spaceId,purpose:'document',vectors:[[1,0,0],[0,1,0]]});
    assert.notEqual(embeddingSpaceId(cfg,{...space,dimension:4}),q.spaceId);
    assert.notEqual(embeddingSpaceId({...cfg,origin:'http://127.0.0.1:9'},space),q.spaceId);
    assert.equal(calls,2);
  },(req,res)=>{
    assert.equal(req.url,'/v1/embeddings');assert.equal(req.headers.authorization,'Bearer '+token);
    body(req,x=>{calls++;assert.deepEqual(x,{model,input:calls===1?[query.query]:documents.passages.map(d=>d.text),encoding_format:'float'});reply(res,good(calls===1?1:2));});
  });
});
test('embedding rejects malformed dimensions, ordinals, non-unit and wrong model outputs',async()=>{
  const cases:[unknown,string][]=[
    [{...good(),model:'different'},'MODEL_MISMATCH'],
    [{model,data:[item(0,[1,0]),item(1,[0,1,0])]},'INVALID_RESPONSE'],
    [{model,data:[item(0,[0,0,0]),item(1,[0,1,0])]},'INVALID_RESPONSE'],
    [{model,data:[item(0,[2,0,0]),item(1,[0,1,0])]},'INVALID_RESPONSE'],
    [{model,data:[item(0,['1',0,0]),item(1,[0,1,0])]},'INVALID_RESPONSE'],
    [{model,data:[item(0,[1,0,0]),item(0,[0,1,0])]},'INVALID_RESPONSE'],
    [{model,data:[item(0,[1,0,0]),item(2,[0,1,0])]},'INVALID_RESPONSE'],
    [{model,data:[item(0,[1,0,0])]},'INVALID_RESPONSE'],
  ];
  let count=0;
  await fixture(async cfg=>{
    const t=new LoopbackEmbeddingTransport();
    for(const [,message] of cases)await assert.rejects(t.embed(cfg,space,'document',documents,token,context()),{message});
    assert.equal((await t.embed(cfg,space,'document',documents,token,context())).vectors.length,2);
  },(req,res)=>{req.resume();reply(res,cases[count++]?.[0]??good());});
});
test('invalid role payload, model profile, auth and concurrency fail before/without fallback',async()=>{
  let calls=0;
  let entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});
  await fixture(async cfg=>{
    const t=new LoopbackEmbeddingTransport();
    await assert.rejects(t.embed(cfg,{...space,queryInstructionId:'other'},'query',query,token,context()),{message:'MODEL_MISMATCH'});
    await assert.rejects(t.embed({...cfg,transport:'cloud',origin:'https://api.example.com'},space,'query',query,token,context()),{message:'ENDPOINT_DENIED'});
    await assert.rejects(t.embed(cfg,space,'query',documents,token,context()),{message:'LIMIT_EXCEEDED'});
    await assert.rejects(t.embed(cfg,space,'document',{...documents,passages:Array.from({length:9},(_,id)=>({id,text:'x'}))},token,context()),{message:'LIMIT_EXCEEDED'});
    await assert.rejects(t.embed(cfg,space,'query',query,'',context()),{message:'UNAUTHENTICATED'});
    await assert.rejects(t.embed(cfg,space,'query',query,token,context()),{message:'RATE_LIMITED'});
    const abort=new AbortController();
    const pending=t.embed(cfg,space,'query',query,token,context(abort.signal));await waiting;
    await assert.rejects(t.embed(cfg,space,'query',query,token,context()),{message:'QUOTA_EXCEEDED'});
    abort.abort();await assert.rejects(pending,{message:'CANCELLED'});
    assert.equal(calls,2);
  },(req,res)=>{req.resume();calls++;if(calls===1)reply(res,{},429);else entered();});
});
const scopeId=hash('synthetic-embedding-scope');
const bytes=documents.passages.map(p=>Buffer.from('# Synthetic\n'+p.text+'\n'));
const hits:EvidenceHit[]=bytes.map((raw,i)=>{
  const doc=parseMarkdown('fixture-'+i+'.md',raw,scopeId);const block=doc.blocks[1]!;
  return {sourceId:doc.sourceId,sourceSha256:doc.sha256,originalExcerpt:block.originalText,sourceLocators:[block.locator],
    rank:i+1,lexicalRank:i+1,retrievalMode:'lexical',indexGenerationId:hash('generation'),score:2-i,headings:[],wikiLinks:[],properties:[]};
});
function approve(config:ProviderConfig,purpose:'query'|'document'):EmbeddingApproval{
  const candidates=purpose==='query'?[]:hits.map(hit=>({hit,classification:'synthetic' as const}));
  const text=purpose==='query'?query.query:documents.query;
  return {config,space,purpose,scopeId,query:{text,classification:'synthetic'},candidates,
    grant:{version:1,role:'embedding',purpose,spaceId:embeddingSpaceId(config,space),configDigest:configDigest('embedding',config),
      scopeId,expiresUnixMs:Date.now()+10000,queryDigest:hash(text),queryClassification:'synthetic',
      sources:candidates.map(({hit})=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,excerptDigest:hash(hit.originalExcerpt),classification:'synthetic'}))}};
}
test('embedding grant binds purpose and space; document source freshness before and after; query only sends query',async()=>{
  let calls=0,checks=0,stale=false;
  await fixture(async cfg=>{
    const e=new EvidenceEmbedder(),q=approve(cfg,'query'),docs=approve(cfg,'document');
    const verify=async(hit:EvidenceHit)=>{checks++;const i=hits.findIndex(h=>h.sourceId===hit.sourceId);
      verifySpan(hit,stale&&calls>2?Buffer.from('changed'):bytes[i]!);};
    await assert.rejects(e.run({...q,grant:{...q.grant,purpose:'document'}},token,context(),verify,()=>true),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(e.run({...q,space:{...space,dimension:4}},token,context(),verify,()=>true),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(e.run({...docs,candidates:[{hit:hits[0]!,classification:'unknown'}]},token,context(),verify,()=>true),{message:'DISCLOSURE_DENIED'});
    assert.equal(calls,0);
    assert.deepEqual((await e.run(q,token,context(),verify,()=>true)).evidence,[]);
    assert.equal(checks,0);
    assert.deepEqual((await e.run(docs,token,context(),verify,()=>true)).evidence,hits);
    assert.equal(checks,4);
    stale=true;await assert.rejects(e.run(docs,token,context(),verify,()=>true),{message:'SOURCE_STALE'});
    assert.equal(calls,3);
    await assert.rejects(e.run(q,token,context(),verify,()=>false),{message:'CANCELLED'});
    assert.equal(calls,3);
  },(req,res)=>{calls++;body(req,x=>{assert.deepEqual(x.input,calls===1?[query.query]:documents.passages.map(d=>d.text));reply(res,good(calls===1?1:2));});});
});
