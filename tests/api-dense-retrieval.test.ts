import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiDenseSearch,type ApiRetrievalInput,type ApiRetrievalPort} from '../plugin/src/ai/dense-retrieval';
import {EvidenceEmbedder,type EmbeddingApproval} from '../plugin/src/ai/embedding-evidence';
import {buildApiDenseGeneration} from '../plugin/src/ai/dense-generation';
import {embeddingSpaceId} from '../plugin/src/ai/embedding-space';
import {configDigest} from '../plugin/src/ai/disclosure';
import type {EmbeddingSpace,ProviderConfig} from '../plugin/src/ai/contracts';
import {AdvancedRetrievalStore} from '../plugin/src/advanced/retrieval-storage';
import {trustedVaultRoot} from '../plugin/src/advanced/source';
import {BoundedVaultReader,privateIndexPath} from '../plugin/src/standalone/source';
import {GenerationStore} from '../plugin/src/standalone/storage';
import {StandaloneEngine} from '../plugin/src/standalone/engine';
import {WorkerMarkdownParser} from '../plugin/src/standalone/worker';
import {syntheticNodeWorkerPort} from './helpers/browser-worker-port';
import {hash,PROTOCOL,type EvidenceHit,type SearchRequest} from '../plugin/src/standalone/contracts';
import {verifySpan} from '../plugin/src/search/navigation';

const space:EmbeddingSpace={model:'fixture',revision:'v1',dimension:3,normalization:'unit-l2',
  serializationId:'utf8-verbatim-v1',queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
const token='synthetic-token';
const context=()=>({signal:new AbortController().signal,deadlineUnixMs:Date.now()+5000});
const request=(query:string,requestedMode:'dense'|'hybrid',overrides:Partial<SearchRequest>={}):
  SearchRequest&{requestedMode:'dense'|'hybrid'}=>({...overrides,protocolVersion:PROTOCOL,requestId:'synthetic-d3',
    query,requestedMode,limit:overrides.limit??10});
type Fixture={
  input:(query:string,mode:'dense'|'hybrid',overrides?:Partial<SearchRequest>)=>ApiRetrievalInput;
  port:ApiRetrievalPort;service:ApiDenseSearch;store:AdvancedRetrievalStore;
  sibling:AdvancedRetrievalStore;calls:()=>number;lexicalCalls:()=>number;
  deny:()=>void;rateLimit:()=>void;vault:string;
};
async function fixture(run:(f:Fixture)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'oks-d3-')),vault=join(dir,'vault'),xdg=join(dir,'xdg');
  const prior=process.env.XDG_DATA_HOME;
  await mkdir(vault,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
  let calls=0,lexicalCalls=0,denied=false,rateLimited=false;
  const server=createServer((req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      calls++;
      assert.equal(req.url,'/v1/embeddings');assert.equal(req.headers.authorization,'Bearer '+token);
      const payload=JSON.parse(body) as {model:string;input:string[];encoding_format:string};
      assert.deepEqual(Object.keys(payload).sort(),['encoding_format','input','model']);
      if(rateLimited){res.writeHead(429);res.end();return;}
      const data=payload.input.map((_,i)=>({object:'embedding',index:i,
        embedding:payload.input.length===1?[0,1,0]:i===0?[1,0,0]:[0,1,0]}));
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:payload.model,data}));
    });
  });
  let engine:StandaloneEngine|undefined;
  try{
    await writeFile(join(vault,'a.md'),'---\nversion: 1\n---\ncommon alpha storage\n');
    await writeFile(join(vault,'b.md'),'---\nversion: 2\n---\ncommon beta archive\n');
    await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
    const addr=server.address();if(!addr||typeof addr==='string')throw Error('FIXTURE_ADDRESS');
    const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:'+addr.port,
      identity:{model:space.model,revision:space.revision},
      limits:{timeoutMs:1500,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}};
    const root=await trustedVaultRoot(vault),reader=await BoundedVaultReader.open(vault,()=>['a.md','b.md']);
    assert.equal(root.id,reader.rootId);
    const ls=await GenerationStore.open(privateIndexPath(vault,reader.rootId,'oks-synthetic-evidence'),reader.rootId);
    const lexicalEngine=new StandaloneEngine(reader,ls,new WorkerMarkdownParser(
      join(process.cwd(),'.test-build','standalone-worker.js'),syntheticNodeWorkerPort));
    engine=lexicalEngine;await engine.start();await engine.whenIdle();
    const initial=await engine.search({...request('common','hybrid'),requestedMode:'lexical'});
    assert.equal(initial.status,'ok');assert.equal(initial.hits.length,2);
    const hits=initial.hits,lexicalGenerationId=initial.indexGenerationId!;
    const approval=(purpose:'query'|'document',query:string,evidence:EvidenceHit[]):EmbeddingApproval=>({
      purpose,config,space,scopeId:root.id,query:{text:query,classification:'synthetic'},
      candidates:evidence.map(hit=>({hit,classification:'synthetic'})),
      grant:{version:1,role:'embedding',purpose,spaceId:embeddingSpaceId(config,space),
        configDigest:configDigest('embedding',config),scopeId:root.id,expiresUnixMs:Date.now()+10000,
        queryDigest:hash(query),queryClassification:'synthetic',sources:evidence.map(hit=>({
          sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,excerptDigest:hash(hit.originalExcerpt),classification:'synthetic'}))}});
    const current=()=>lexicalEngine.status().generationId===lexicalGenerationId&&!denied;
    const batch=await new EvidenceEmbedder().run(approval('document','selected corpus',hits),token,context(),
      async hit=>{verifySpan(hit,await reader.read(hit.sourceId));},current);
    const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const generation=buildApiDenseGeneration(root.id,config,space,lexicalGenerationId,hits,[batch]);
    await store.publishApi(generation,async()=>{},context().signal,current);
    const sibling=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const service=new ApiDenseSearch(store);
    const port:ApiRetrievalPort={current,allowed:()=>!denied,lexical:async req=>{
      lexicalCalls++;return lexicalEngine.search(req);
    }};
    await run({input:(query,mode,overrides)=>({request:request(query,mode,overrides),
      lexicalGenerationId,evidence:structuredClone(hits),approval:approval('query',query,[])}),
      port,service,store,sibling,calls:()=>calls,lexicalCalls:()=>lexicalCalls,
      deny:()=>{denied=true;},rateLimit:()=>{rateLimited=true;},vault});
  }finally{
    await engine?.close();
    server.closeAllConnections();
    if(server.listening)await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));
    if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(dir,{recursive:true,force:true});
  }
}
const search=(f:Fixture,input:ApiRetrievalInput,port=f.port)=>f.service.run(input,token,context(),port);
const ids=(r:Awaited<ReturnType<ApiDenseSearch['run']>>)=>r.hits.map(h=>h.evidence.sourceId);
test('D3 real lexical engine plus HTTP query vectors: dense independent, hybrid RRF and zero lexical hits',async()=>{
  await fixture(async f=>{
    const dense=await search(f,f.input('unrelated concept','dense'));
    assert.equal(dense.executedMode,'dense');assert.deepEqual(ids(dense),['b.md','a.md']);
    assert.equal(dense.hits[0]?.denseSimilarity,1);assert.equal(dense.hits[0]?.lexicalRank,null);
    assert.equal(f.lexicalCalls(),0);assert.equal(dense.legs.lexical.status,'unavailable');
    const hybrid=await search(f,f.input('alpha','hybrid'));
    assert.equal(hybrid.executedMode,'hybrid');assert.deepEqual(ids(hybrid),['a.md','b.md']);
    assert.equal(hybrid.hits[0]?.rrfScore,1/61+1/62);
    assert.equal(hybrid.hits[1]?.denseRank,1);assert.equal(hybrid.hits[0]?.evidence.originalExcerpt,'common alpha storage');
    const tied=await search(f,f.input('common','hybrid'));
    assert.deepEqual(ids(tied),['a.md','b.md']);
    const empty=await search(f,f.input('unrelated concept','hybrid'));
    assert.equal(empty.executedMode,'hybrid');assert.equal(empty.legs.lexical.status,'ready');
    assert.equal(empty.legs.lexical.candidateCount,0);assert.deepEqual(ids(empty),['b.md','a.md']);
    assert.equal(f.calls(),5);assert.equal(f.lexicalCalls(),3);
  });
});
test('D3 exact scope and typed Properties before rank and Top-K',async()=>{
  await fixture(async f=>{
    const scoped=await search(f,f.input('common','hybrid',{scope:['a.md'],limit:1}));
    assert.deepEqual(ids(scoped),['a.md']);assert.equal(scoped.legs.dense.candidateCount,1);
    const typed=await search(f,f.input('common','hybrid',{predicates:[{key:'version',valueType:'number',value:2,operator:'eq'}]}));
    assert.deepEqual(ids(typed),['b.md']);
    const mismatch=await search(f,f.input('common','hybrid',{predicates:[{key:'version',valueType:'string',value:'2',operator:'eq'}]}));
    assert.equal(mismatch.status,'ok');assert.deepEqual(ids(mismatch),[]);
    assert.equal(mismatch.legs.lexical.status,'ready');
  });
});
test('D3 mismatched evidence coverage, query, generation, space and permission deny before egress',async()=>{
  await fixture(async f=>{
    const valid=f.input('alpha','dense'),before=f.calls();
    const missing={...valid,evidence:valid.evidence.slice(0,1)};
    assert.equal((await search(f,missing)).executedMode,'none');
    const forged={...valid,evidence:valid.evidence.map((h,i)=>i?{...h,originalExcerpt:'forged'}:h)};
    assert.equal((await search(f,forged)).executedMode,'none');
    assert.equal((await search(f,{...valid,lexicalGenerationId:hash('other')})).executedMode,'none');
    assert.equal((await search(f,{...valid,approval:{...valid.approval,space:{...space,dimension:4}}})).executedMode,'none');
    assert.equal((await search(f,{...valid,request:{...valid.request,query:'other'}})).executedMode,'none');
    assert.equal((await search(f,valid,{...f.port,allowed:()=>false})).error,'DISCLOSURE_DENIED');
    const unsupported=f.input('alpha','dense',{matchMode:'literal'});
    assert.equal((await search(f,unsupported)).error,'CONFIG_INVALID');
    assert.equal(f.calls(),before);
  });
});
test('D3 no fallback on provider failure or degraded/foreign lexical leg',async()=>{
  await fixture(async f=>{
    const input=f.input('alpha','hybrid');
    const degraded=await search(f,input,{...f.port,lexical:async req=>({...await f.port.lexical(req),status:'degraded'})});
    assert.equal(degraded.executedMode,'none');assert.deepEqual(degraded.hits,[]);
    const foreign=await search(f,input,{...f.port,lexical:async req=>({...await f.port.lexical(req),indexGenerationId:hash('wrong')})});
    assert.equal(foreign.executedMode,'none');
    const before=f.lexicalCalls();f.rateLimit();
    const failed=await search(f,input);
    assert.equal(failed.error,'RATE_LIMITED');assert.equal(failed.executedMode,'none');
    assert.equal(failed.legs.lexical.status,'not-run');
    assert.equal(f.lexicalCalls(),before);
  });
});
test('D3 sibling invalidation and missed source event during lexical leg suppress all results',async()=>{
  await fixture(async f=>{
    const input=f.input('common','hybrid');
    const failed=await search(f,input,{...f.port,lexical:async req=>{
      const r=await f.port.lexical(req);f.sibling.revoke('a.md');return r;
    }});
    assert.equal(failed.executedMode,'none');assert.deepEqual(failed.hits,[]);
  });
  await fixture(async f=>{
    const input=f.input('common','hybrid');
    const failed=await search(f,input,{...f.port,lexical:async req=>{
      const r=await f.port.lexical(req);await writeFile(join(f.vault,'a.md'),'changed');return r;
    }});
    assert.equal(failed.executedMode,'none');assert.deepEqual(failed.hits,[]);
  });
});
test('D3 synchronous snapshot lease closes final async boundary; caller cancel and busy fail closed',async(t)=>{
  await fixture(async f=>{
    const original=f.store.snapshotApi.bind(f.store);
    let reads=0;
    t.mock.method(f.store,'snapshotApi',async(...args:Parameters<typeof original>)=>{
      const g=await original(...args);if(++reads===2)f.sibling.revoke('a.md');return g;
    });
    const result=await search(f,f.input('alpha','dense'));
    assert.equal(reads,2);assert.equal(result.executedMode,'none');assert.deepEqual(result.hits,[]);
  });
  await fixture(async f=>{
    const input=f.input('common','hybrid');
    let entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
    const job=search(f,input,{...f.port,lexical:async req=>{entered();await blocked;return f.port.lexical(req);}});
    await ready;
    try{
      assert.equal((await search(f,input)).error,'QUOTA_EXCEEDED');f.deny();
    }finally{release();}
    assert.equal((await job).executedMode,'none');
    const abort=new AbortController();abort.abort();
    assert.equal((await f.service.run(input,token,{...context(),signal:abort.signal},f.port)).error,'CANCELLED');
  });
});

test('D3 aborted lexical operation returns promptly and blocks new searches until late task drains',async()=>{
  await fixture(async f=>{
    const input=f.input('common','hybrid'),abort=new AbortController();
    let entered!:()=>void,release!:()=>void,drained!:()=>void;
    const ready=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
    const finished=new Promise<void>(r=>drained=r);
    const job=f.service.run(input,token,{...context(),signal:abort.signal},{...f.port,lexical:async req=>{
      entered();await blocked;
      try{return await f.port.lexical(req);}finally{drained();}
    }});
    await ready;
    try{
      abort.abort();
      const result=await job;
      assert.equal(result.error,'CANCELLED');assert.equal(result.executedMode,'none');
      assert.equal((await search(f,input)).error,'QUOTA_EXCEEDED');
    }finally{release();await finished;}
    await new Promise<void>(r=>setImmediate(r));
    assert.equal((await search(f,input)).executedMode,'hybrid');
  });
});
