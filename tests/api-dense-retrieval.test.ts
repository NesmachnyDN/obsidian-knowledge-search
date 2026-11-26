import {ApiDenseHost} from '../plugin/src/ai/dense-host';
import {GenerationCredentialAuthority} from '../plugin/src/ai/generation-credential';
import {GenerationPolicyGate,type GenerationPolicyBinding} from '../plugin/src/ai/generation-policy';
import {resolveEmbeddingPolicyScope,embeddingPolicyPayload,INDEX_PURPOSE_TEXT,type EmbeddingPolicyScope,type EmbeddingPolicyInput} from '../plugin/src/ai/embedding-policy';
import {ProcessingPolicyHost} from '../plugin/src/ai/generation-policy-host';
import {SearchController,uiRequest} from '../plugin/src/search/controller';
import {DenseUiController} from '../plugin/src/ai/dense-ui-controller';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiDenseSearch,type ApiRetrievalInput,type ApiRetrievalPort} from '../plugin/src/ai/dense-retrieval';
import {ApiDenseIndexManager,type DenseIndexPort} from '../plugin/src/ai/dense-index-manager';
import {EvidenceEmbedder,type EmbeddingApproval} from '../plugin/src/ai/embedding-evidence';
import {buildApiDenseGeneration,validateApiDenseGeneration,assertDensePolicyReuse} from '../plugin/src/ai/dense-generation';
import {canonical,sha} from '../plugin/src/advanced/protocol';
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
  engine:StandaloneEngine;config:ProviderConfig;
  makeApproval:(purpose:'query'|'document',query:string,evidence:readonly EvidenceHit[],
    config?:ProviderConfig,space?:EmbeddingSpace)=>EmbeddingApproval;
  onRequest:(hook:()=>void)=>void;
  wireRequests:()=>readonly {bytes:number;texts:string[]}[];

};
async function fixture(run:(f:Fixture)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'oks-d3-')),vault=join(dir,'vault'),xdg=join(dir,'xdg');
  const prior=process.env.XDG_DATA_HOME;
  await mkdir(vault,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
  let calls=0,lexicalCalls=0,denied=false,rateLimited=false,requestHook=()=>{};
  const wireRequests:{bytes:number;texts:string[]}[]=[];
  const server=createServer((req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      calls++;requestHook();
      assert.equal(req.url,'/v1/embeddings');assert.equal(req.headers.authorization,'Bearer '+token);
      const payload=JSON.parse(body) as {model:string;input:string[];encoding_format:string};
      assert.deepEqual(Object.keys(payload).sort(),['encoding_format','input','model']);
      wireRequests.push({bytes:Buffer.byteLength(body),texts:payload.input});
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
    const approval=(purpose:'query'|'document',query:string,evidence:readonly EvidenceHit[],
      cfg=config,sp=space):EmbeddingApproval=>({
      purpose,config:cfg,space:sp,scopeId:root.id,query:{text:query,classification:'synthetic'},
      candidates:evidence.map(hit=>({hit,classification:'synthetic'})),
      grant:{version:1,role:'embedding',purpose,spaceId:embeddingSpaceId(cfg,sp),
        configDigest:configDigest('embedding',cfg),scopeId:root.id,expiresUnixMs:Date.now()+10000,
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
      deny:()=>{denied=true;},rateLimit:()=>{rateLimited=true;},vault,engine:lexicalEngine,config,
      makeApproval:approval,onRequest:hook=>{requestHook=hook;},wireRequests:()=>wireRequests});
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

const indexPort=(f:Fixture):DenseIndexPort=>({
  current:f.port.current,allowed:f.port.allowed,
  authorize:input=>f.makeApproval('document',input.query,input.evidence,input.config,input.space),
});
test('D4 authoritative selection is complete and independent of query/Top-K; typed evidence and monotonic lease',async()=>{
  await fixture(async f=>{
    await writeFile(join(f.vault,'a.md'),'---\nversion: 1\n---\nalpha\nother words\n!\n');
    f.engine.changed('a.md');await f.engine.whenIdle();
    const lease=await f.engine.captureDenseCorpus(['b.md','a.md'],256,context().signal);
    assert.equal(lease.lexicalGenerationId,f.engine.status().generationId);
    assert.deepEqual(lease.evidence.map(h=>h.originalExcerpt),['alpha','other words','!','common beta archive']);
    assert.deepEqual(lease.evidence[0]?.properties,[{key:'version',valueType:'number',value:1}]);
    await lease.verify(lease.evidence[0]!);
    for(const paths of [[],['a.md','a.md'],['missing.md'],['../a.md']]){
      await assert.rejects(f.engine.captureDenseCorpus(paths,256,context().signal),/INVALID_REQUEST/);
    }
    await assert.rejects(f.engine.captureDenseCorpus(['a.md'],2,context().signal),/INDEX_LIMIT/);
    assert.equal(lease.current(),true);
    f.engine.changed('a.md');await f.engine.whenIdle();
    assert.equal(lease.current(),false);
    await assert.rejects(lease.verify(lease.evidence[0]!),/SOURCE_STALE/);
  });
});
test('D4 complete explicit rebuild changes model space atomically through existing CURRENT and supports D3',async()=>{
  await fixture(async f=>{
    const cfg={...f.config,identity:{...f.config.identity,revision:'v2'},
      limits:{...f.config.limits,maxCandidates:1}};
    const sp={...space,revision:'v2'},before=f.calls();
    const manager=new ApiDenseIndexManager(f.engine,f.store);
    const r=await manager.rebuild({paths:['b.md','a.md'],config:cfg,space:sp},token,context(),indexPort(f));
    assert.equal(r.status,'ok');assert.equal(r.count,2);assert.equal(f.calls(),before+2);
    const input=f.input('alpha','hybrid'),newId=embeddingSpaceId(cfg,sp);
    await assert.rejects(f.store.snapshotApi(embeddingSpaceId(f.config,space),input.lexicalGenerationId));
    const g=await f.store.snapshotApi(newId,input.lexicalGenerationId);
    assert.equal(g?.generationId,r.generationId);assert.equal(g?.entries.length,2);
    const lease=await f.engine.captureDenseCorpus(['a.md','b.md'],256,context().signal);
    const result=await search(f,{...input,evidence:lease.evidence,approval:f.makeApproval('query','alpha',[],cfg,sp)});
    assert.equal(result.executedMode,'hybrid');
    assert.deepEqual(ids(result),['a.md','b.md']);
  });
});
test('D4 batch limits and mismatched grants fail before egress; prior committed index remains',async()=>{
  await fixture(async f=>{
    const manager=new ApiDenseIndexManager(f.engine,f.store),port=indexPort(f);
    const input={paths:['a.md','b.md'],config:f.config,space},before=f.calls();
    const prior=await f.store.snapshotApi(embeddingSpaceId(f.config,space),f.input('alpha','dense').lexicalGenerationId);
    assert.equal((await manager.rebuild(input,token,context(),{...port,allowed:()=>false})).error,'DISCLOSURE_DENIED');
    const tiny={...f.config,limits:{...f.config.limits,maxInputBytes:32}};
    assert.equal((await manager.rebuild({...input,config:tiny},token,context(),port)).error,'LIMIT_EXCEEDED');
    assert.equal((await manager.rebuild(input,token,context(),{...port,authorize:i=>{
      const a=port.authorize(i);return {...a,candidates:a.candidates.slice(0,1)};
    }})).error,'DISCLOSURE_DENIED');
    assert.equal((await manager.rebuild(input,token,context(),{...port,authorize:i=>{
      const a=port.authorize(i);return {...a,grant:{...a.grant,sources:[...a.grant.sources,a.grant.sources[0]!]}};
    }})).error,'DISCLOSURE_DENIED');
    assert.equal(f.calls(),before);
    const abort=new AbortController();abort.abort();
    assert.equal((await manager.rebuild(input,token,{...context(),signal:abort.signal},port)).error,'CANCELLED');
    const same=await f.store.snapshotApi(embeddingSpaceId(f.config,space),prior!.lexicalGenerationId);
    assert.equal(same?.generationId,prior?.generationId);
  });
});
test('D4 failed second batch never promotes partial replacement; ordinary lexical remains independent',async()=>{
  await fixture(async f=>{
    const prior=await f.store.snapshotApi(embeddingSpaceId(f.config,space),f.input('alpha','dense').lexicalGenerationId);
    const config={...f.config,identity:{...f.config.identity,revision:'v2'},
      limits:{...f.config.limits,maxCandidates:1}},sp={...space,revision:'v2'};
    const before=f.calls();
    f.onRequest(()=>{if(f.calls()===before+2)f.rateLimit();});
    const result=await new ApiDenseIndexManager(f.engine,f.store).rebuild(
      {paths:['a.md','b.md'],config,space:sp},token,context(),indexPort(f));
    assert.equal(result.error,'RATE_LIMITED');assert.equal(f.calls(),before+2);
    const after=await f.store.snapshotApi(embeddingSpaceId(f.config,space),prior!.lexicalGenerationId);
    assert.equal(after?.generationId,prior?.generationId);
    assert.equal((await f.port.lexical({...request('alpha','hybrid'),requestedMode:'lexical'})).status,'ok');
  });
});
test('D4 generation event during HTTP invalidates replacement even if source bytes unchanged',async()=>{
  await fixture(async f=>{
    const prior=await f.store.snapshotApi(embeddingSpaceId(f.config,space),f.input('alpha','dense').lexicalGenerationId);
    const config={...f.config,identity:{...f.config.identity,revision:'v2'}},sp={...space,revision:'v2'};
    f.onRequest(()=>f.engine.changed('a.md'));
    const r=await new ApiDenseIndexManager(f.engine,f.store).rebuild(
      {paths:['a.md','b.md'],config,space:sp},token,context(),indexPort(f));
    assert.equal(r.status,'failed');await f.engine.whenIdle();
    assert.equal((await f.store.snapshotApi(embeddingSpaceId(f.config,space),prior!.lexicalGenerationId))?.generationId,
      prior?.generationId);
  });
});
test('D4 missed source change rejects capture before disclosure and does not replace CURRENT',async()=>{
  await fixture(async f=>{
    const before=f.calls(),input={paths:['a.md','b.md'],config:f.config,space};
    await writeFile(join(f.vault,'a.md'),'changed without an event');
    const r=await new ApiDenseIndexManager(f.engine,f.store).rebuild(input,token,context(),indexPort(f));
    assert.equal(r.error,'SOURCE_STALE');assert.equal(f.calls(),before);
    await assert.rejects(f.store.snapshotApi(embeddingSpaceId(f.config,space),f.input('alpha','dense').lexicalGenerationId));
  });
});
test('D4 concurrent rebuild denied and missed byte change during provider call suppresses publication',async()=>{
  await fixture(async f=>{
    const manager=new ApiDenseIndexManager(f.engine,f.store),input={paths:['a.md','b.md'],config:f.config,space};
    let concurrent:ReturnType<typeof manager.rebuild>|undefined;
    const port=indexPort(f);
    f.onRequest(()=>{writeFileSync(join(f.vault,'a.md'),'changed during call');});
    const r=await manager.rebuild(input,token,context(),{...port,authorize:i=>{
      concurrent=manager.rebuild(input,token,context(),port);return port.authorize(i);
    }});
    assert.equal((await concurrent)?.error,'QUOTA_EXCEEDED');assert.equal(r.status,'failed');
    await assert.rejects(f.store.snapshotApi(embeddingSpaceId(f.config,space),f.input('alpha','dense').lexicalGenerationId));
  });
});

test('D4 oversized later serialized batch rejects entire plan with zero HTTP and unchanged CURRENT',async()=>{
  await fixture(async f=>{
    const pointer=join(f.store.path,'CURRENT'),prior=await readFile(pointer);
    const large='x'+'\u0001'.repeat(25000);
    await writeFile(join(f.vault,'b.md'),large+'\n');
    f.engine.changed('b.md');await f.engine.whenIdle();
    const lease=await f.engine.captureDenseCorpus(['a.md','b.md'],256,context().signal);
    assert.deepEqual(lease.evidence.map(h=>h.originalExcerpt),['common alpha storage',large]);
    const config={...f.config,limits:{...f.config.limits,maxInputBytes:65536,maxCandidates:1}};
    const before=f.calls();let grants=0;const port=indexPort(f);
    const result=await new ApiDenseIndexManager(f.engine,f.store).rebuild(
      {paths:['a.md','b.md'],config,space},token,context(),{...port,current:()=>true,
        authorize:i=>{grants++;return port.authorize(i);}});
    assert.equal(result.error,'LIMIT_EXCEEDED');assert.equal(f.calls(),before);
    assert.equal(grants,0);assert.deepEqual(await readFile(pointer),prior);
  });
});
test('D4 exact wire boundary accepted and split without truncating original evidence',async()=>{
  await fixture(async f=>{
    const wire=(texts:string[])=>Buffer.byteLength(JSON.stringify({
      model:'fixture@v1',input:texts,encoding_format:'float'}));
    const limit=128*1024,room=limit-wire(['x']);
    const boundary='x'+'\u0001'.repeat(Math.floor(room/6))+'y'.repeat(room%6);
    const second='common beta archive';
    assert.equal(wire([boundary]),limit);assert.ok(wire([boundary,second])>limit);
    await writeFile(join(f.vault,'a.md'),boundary+'\n');
    f.engine.changed('a.md');await f.engine.whenIdle();
    const lease=await f.engine.captureDenseCorpus(['a.md','b.md'],256,context().signal);
    assert.deepEqual(lease.evidence.map(h=>h.originalExcerpt),[boundary,second]);
    const config={...f.config,limits:{...f.config.limits,maxInputBytes:65536}};
    const before=f.calls();
    const result=await new ApiDenseIndexManager(f.engine,f.store).rebuild(
      {paths:['a.md','b.md'],config,space},token,context(),{...indexPort(f),current:()=>true});
    assert.equal(result.status,'ok',result.error ?? 'expected successful rebuild');assert.equal(result.count,2);
    assert.deepEqual(f.wireRequests().slice(before),[
      {bytes:limit,texts:[boundary]},{bytes:wire([second]),texts:[second]}]);
    const published=await f.store.snapshotApi(embeddingSpaceId(config,space),f.engine.status().generationId!);
    assert.equal(published?.generationId,result.generationId);assert.equal(published?.entries.length,2);
  });
});

async function metadataFixture(f:Fixture){
  await writeFile(join(f.vault,'a.md'),'---\nversion: 1\ntags: ["approved"]\n---\ncommon alpha [[Target|alias]]\nsecond evidence #inline\n');
  await writeFile(join(f.vault,'b.md'),'---\nversion: 2\n---\ncommon beta #other [[Target]]\n');
  f.engine.reconcile();await f.engine.whenIdle();
  const lease=await f.engine.captureDenseCorpus(['a.md','b.md'],256,context().signal);
  const rebuilt=await new ApiDenseIndexManager(f.engine,f.store).rebuild(
    {paths:['a.md','b.md'],config:f.config,space},token,context(),{...indexPort(f),current:lease.current});
  assert.equal(rebuilt.status,'ok',rebuilt.error??'expected rebuild');
  const port:ApiRetrievalPort={...f.port,current:lease.current,metadataPaths:lease.metadataPaths};
  const input=(query:string,mode:'dense'|'hybrid',overrides:Partial<SearchRequest>={}):ApiRetrievalInput=>({
    request:request(query,mode,overrides),lexicalGenerationId:lease.lexicalGenerationId,
    evidence:lease.evidence,approval:f.makeApproval('query',query,[])});
  return {lease,port,input};
}
test('D5 authoritative metadata eligibility precedes rank; body evidence, combined scope and typed Properties',async()=>{
  await fixture(async f=>{
    const {lease,port,input}=await metadataFixture(f);
    const before=f.calls();
    const tag=await search(f,input('common','dense',{metadata:{tag:'#APPROVED'},limit:1}),port);
    assert.equal(tag.status,'ok');assert.deepEqual(ids(tag),['a.md']);
    const both=await search(f,input('common','hybrid',{metadata:{tag:'approved',linkTarget:'Target'}}),port);
    assert.equal(both.executedMode,'hybrid');assert.ok(both.hits.length>0);
    assert.ok(both.hits.every(h=>h.evidence.sourceId==='a.md'&&lease.evidence.some(e=>
      e.originalExcerpt===h.evidence.originalExcerpt&&e.sourceId===h.evidence.sourceId)));
    assert.ok(both.hits.some(h=>h.evidence.originalExcerpt==='common alpha [[Target|alias]]'));
    const inline=await search(f,input('common','dense',{metadata:{tag:'inline'}}),port);
    assert.equal(inline.status,'ok');assert.ok(inline.hits.length>0);
    assert.ok(inline.hits.every(h=>h.evidence.sourceId==='a.md'));
    const typed=await search(f,input('common','hybrid',{metadata:{linkTarget:'Target'},
      predicates:[{key:'version',valueType:'number',value:2,operator:'eq'}]}),port);
    assert.equal(typed.status,'ok');assert.ok(typed.hits.length>0);
    assert.ok(typed.hits.every(h=>h.evidence.sourceId==='b.md'));
    for(const overrides of [{metadata:{linkTarget:'Hidden'}},{metadata:{linkTarget:'target'}},{metadata:{linkTarget:'alias'}},
      {metadata:{tag:'approved'},scope:['b.md']}]){
      const none=await search(f,input('common','hybrid',overrides),port);
      assert.equal(none.status,'ok');assert.deepEqual(none.hits,[]);
      assert.equal(none.legs.lexical.status,'ready');assert.equal(none.legs.dense.candidateCount,0);
    }
    assert.deepEqual(f.wireRequests().slice(before).map(r=>r.texts),Array.from({length:8},()=>['common']));
  });
});
test('D5 missing, foreign, duplicate and revoked metadata eligibility fail closed before HTTP',async()=>{
  await fixture(async f=>{
    const {lease,port,input}=await metadataFixture(f);
    const query=input('common','hybrid',{metadata:{tag:'approved'}}),before=f.calls();
    const otherLease=await f.engine.captureDenseCorpus(['a.md'],256,context().signal);
    for(const denied of [{...port,metadataPaths:undefined},{...port,metadataPaths:()=>['missing.md']},
      {...port,metadataPaths:()=>['a.md','a.md']},
      {...port,metadataPaths:(req:SearchRequest,_id:string,paths:readonly string[])=>lease.metadataPaths(req,hash('foreign'),paths)},
      {...port,metadataPaths:otherLease.metadataPaths}]){
      const failed=await search(f,query,denied);
      assert.equal(failed.executedMode,'none');assert.deepEqual(failed.hits,[]);
    }
    const revoked=await search(f,query,{...port,metadataPaths:(req,id,selected)=>{
      const paths=lease.metadataPaths(req,id,selected);f.engine.changed('a.md');return paths;
    }});
    assert.equal(revoked.error,'CANCELLED');assert.equal(f.calls(),before);
    await f.engine.whenIdle();assert.equal(lease.current(),false);
  });
});
test('D5 metadata-only remains lexical, with original frontmatter anchor; AI revocation during query suppresses hits',async()=>{
  await fixture(async f=>{
    const {port,input}=await metadataFixture(f);
    const before=f.calls();
    const metadataOnly=input('','dense',{metadata:{tag:'approved'}});
    assert.equal((await search(f,metadataOnly,port)).error,'CONFIG_INVALID');
    assert.equal(f.calls(),before);
    const lexical=await f.engine.search({...metadataOnly.request,requestedMode:'lexical'});
    assert.equal(lexical.status,'ok');assert.deepEqual(lexical.hits.map(h=>h.originalExcerpt),['tags: ["approved"]']);
    f.onRequest(()=>f.engine.changed('a.md'));
    const result=await search(f,input('common','hybrid',{metadata:{tag:'approved'}}),port);
    assert.equal(result.executedMode,'none');assert.deepEqual(result.hits,[]);
    assert.equal(f.calls(),before+1);await f.engine.whenIdle();
  });
});

test('D5 fenced code remains excluded by lexical metadata and partial sources remain ineligible for dense indexing',async()=>{
  await fixture(async f=>{
    await writeFile(join(f.vault,'b.md'),'common beta\n~~~\n#secret [[Hidden]]\n~~~\n');
    f.engine.reconcile();await f.engine.whenIdle();
    const before=f.calls();
    const hidden=await f.engine.search({...request('common','hybrid',{metadata:{tag:'secret',linkTarget:'Hidden'}}),requestedMode:'lexical'});
    assert.equal(hidden.status,'ok');assert.deepEqual(hidden.hits,[]);
    await assert.rejects(f.engine.captureDenseCorpus(['b.md'],256,context().signal),/EVIDENCE_INCOMPLETE/);
    const result=await new ApiDenseIndexManager(f.engine,f.store).rebuild(
      {paths:['a.md','b.md'],config:f.config,space},token,context(),{...indexPort(f),current:()=>true});
    assert.equal(result.status,'failed');assert.equal(f.calls(),before);
  });
});

function denseHost(f:Fixture,now=Date.now,admitStorage=async()=>{}){
  let enabled=true, allowed=true, config:import('../plugin/src/ai/contracts').ProviderPreference=f.config;
  const host=new ApiDenseHost(f.engine,f.vault, f.input('common','hybrid').approval.scopeId,
    'oks-synthetic-evidence',{config:()=>config,enabled:()=>enabled,allowedPath:()=>allowed,admitStorage},now);
  const rebuild={kind:'rebuild' as const,paths:['a.md','b.md'],space};
  const query={kind:'search' as const,paths:['a.md','b.md'],space,
    request:request('common','hybrid',{predicates:[{key:'version',valueType:'number',value:2,operator:'eq'}]})};
  return {host,rebuild,query,setEnabled:(v:boolean)=>{enabled=v;},setAllowed:(v:boolean)=>{allowed=v;},
    setConfig:(v:typeof config)=>{config=v;}};
}
test('D6 trusted host prepares without HTTP and consumes exact one-time consent; rebuild then query-only hybrid',async()=>{
  await fixture(async f=>{
    const {host,rebuild,query}=denseHost(f);
    try{
      const before=f.calls(),p=await host.prepare(rebuild);
      assert.equal(f.calls(),before);assert.equal(p.evidence.length,2);
      assert.ok(!JSON.stringify(p).includes(token));
      const bad=structuredClone(p);bad.evidence[0]!.originalExcerpt='modified';
      await assert.rejects(host.confirm(bad,'synthetic',token),/DISCLOSURE_DENIED/);
      await assert.rejects(host.confirm(p,'synthetic',token),/DISCLOSURE_DENIED/);
      assert.equal(f.calls(),before);
      const consent=await host.prepare(rebuild);
      const built=await host.confirm(consent,'synthetic',token);
      assert.equal(built.status,'ok');
      assert.deepEqual(f.wireRequests().slice(before).flatMap(row=>row.texts),
        consent.evidence.map(hit=>hit.originalExcerpt));
      await assert.rejects(host.confirm(consent,'synthetic',token),/DISCLOSURE_DENIED/);
      const next=f.calls(),q=await host.prepare(query);
      assert.equal(f.calls(),next);
      const result=await host.confirm(q,'synthetic',token);
      assert.ok('executedMode' in result);assert.equal(result.executedMode,'hybrid');
      assert.ok(result.hits.length>0);assert.ok(result.hits.every(hit=>hit.evidence.sourceId==='b.md'));
      assert.deepEqual(f.wireRequests().slice(next).map(row=>row.texts),[['common']]);
    }finally{await host.close();}
  });
});
test('D6 revoked/expired/config-changed or unclassified consent cannot disclose; basic remains usable',async()=>{
  await fixture(async f=>{
    let tick=Date.now();
    const {host,rebuild,query,setEnabled,setAllowed,setConfig}=denseHost(f,()=>tick);
    try{
      const before=f.calls();
      const p=await host.prepare(rebuild);tick+=300001;
      await assert.rejects(host.confirm(p,'synthetic',token),/CANCELLED/);
      tick=Date.now();
      const q=await host.prepare(query);host.invalidate('a.md');
      await assert.rejects(host.confirm(q,'synthetic',token),/DISCLOSURE_DENIED/);
      const changed=await host.prepare(rebuild);setConfig({...f.config,limits:{...f.config.limits,timeoutMs:2000}});
      await assert.rejects(host.confirm(changed,'public',token),/CANCELLED/);
      setConfig(f.config);
      const denied=await host.prepare(rebuild);setAllowed(false);
      await assert.rejects(host.confirm(denied,'synthetic',token),/CANCELLED/);
      setAllowed(true);
      const unclassified=await host.prepare(rebuild);
      await assert.rejects(host.confirm(unclassified,'unknown' as never,token),/DISCLOSURE_DENIED/);
      setEnabled(false);await assert.rejects(host.prepare(query),/DISABLED/);setEnabled(true);
      setConfig({...f.config,transport:'cloud',origin:'https://example.org'});
      await assert.rejects(host.prepare(query),/ENDPOINT_DENIED/);
      assert.equal(f.calls(),before);
      const lexical=await f.engine.search({...query.request,requestedMode:'lexical'});
      assert.equal(lexical.executedMode,'lexical');assert.equal(lexical.status,'ok');
      await host.close();await assert.rejects(host.prepare(query),/DISABLED/);
    }finally{await host.close();}
  });
});
test('D6 metadata-filtered query and source mutation during HTTP suppress stale result; new preview required',async()=>{
  await fixture(async f=>{
    const {host,rebuild,query}=denseHost(f);
    try{
      await metadataFixture(f);
      const p=await host.prepare(rebuild);
      assert.equal((await host.confirm(p,'synthetic',token)).status,'ok');
      const req={...query,request:request('common','hybrid',{metadata:{tag:'approved'}})};
      const good=await host.confirm(await host.prepare(req),'synthetic',token);
      assert.ok('hits' in good);assert.equal(good.executedMode,'hybrid');
      assert.ok(good.hits.length>0&&good.hits.every(h=>h.evidence.sourceId==='a.md'));
      const pending=await host.prepare(req),before=f.calls();
      f.onRequest(()=>{host.invalidate('a.md');f.engine.changed('a.md');});
      const cancelled=await host.confirm(pending,'synthetic',token);
      assert.equal(cancelled.status,'failed');
      assert.ok('hits' in cancelled);assert.deepEqual(cancelled.hits,[]);
      assert.equal(f.calls(),before+1);
      await assert.rejects(host.confirm(pending,'synthetic',token),/DISCLOSURE_DENIED/);
      await f.engine.whenIdle();
      const lexical=await f.engine.search({...req.request,requestedMode:'lexical'});
      assert.equal(lexical.status,'ok');
    }finally{await host.close();}
  });
});
test('D6 exact corpus mismatch fails before query disclosure; foreign host preview cannot replay',async()=>{
  await fixture(async f=>{
    const first=denseHost(f),second=denseHost(f);
    try{
      const p=await first.host.prepare(first.rebuild);
      await assert.rejects(second.host.confirm(p,'synthetic',token),/DISCLOSURE_DENIED/);
      assert.equal((await first.host.confirm(p,'synthetic',token)).status,'ok');
      const before=f.calls();
      const one=await first.host.prepare({...first.query,paths:['a.md']});
      const result=await first.host.confirm(one,'synthetic',token);
      assert.equal(result.status,'failed');
      assert.equal(f.calls(),before);
      const stale=await first.host.prepare(first.query);
      await first.host.close();
      const fresh=await second.host.prepare(second.query);
      assert.notEqual(fresh.nonce,stale.nonce);
      await assert.rejects(second.host.confirm(stale,'synthetic',token),/DISCLOSURE_DENIED/);
      assert.equal(f.calls(),before);
    }finally{await first.host.close();await second.host.close();}
  });
});

test('D6 storage admission refuses failed prior writer shutdown and cancellation during admission',async()=>{
  await fixture(async f=>{
    const before=f.calls();
    const blocked=denseHost(f,Date.now,async()=>{throw new Error('prior writer failed');});
    try{
      await assert.rejects(blocked.host.confirm(await blocked.host.prepare(blocked.rebuild),'synthetic',token),/NOT_READY/);
      assert.equal(f.calls(),before);
    }finally{await blocked.host.close();}
    let release!:()=>void;
    const waiting=denseHost(f,Date.now,()=>new Promise<void>(resolve=>{release=resolve;}));
    try{
      const pending=waiting.host.confirm(await waiting.host.prepare(waiting.rebuild),'synthetic',token);
      waiting.host.invalidate();release();
      await assert.rejects(pending,/CANCELLED/);assert.equal(f.calls(),before);
    }finally{await waiting.host.close();}
  });
});


test('POLICY.3c2/3d1 dense host exact preflight, shared role slot, revocation and durable lineage',async()=>{
  await fixture(async f=>{
    let config={...f.config,limits:{...f.config.limits,maxCandidates:1}};
    const rootId=f.input('common','hybrid').approval.scopeId;
    const credential=new GenerationCredentialAuthority(),gate=new GenerationPolicyGate();
    let revision='p1',selected=true,admitted=true;
    let holdPolicy:Promise<void>|undefined,enteredPolicy:(()=>void)|undefined;
    let host!:ApiDenseHost;
    const policy=new ProcessingPolicyHost<'embedding'>(()=>selected,()=>f.engine,()=>({
      config,profile:admitted?{profileId:'synthetic-embedding',admissionId:'fixture',role:'embedding',
        configDigest:configDigest('embedding',config),adapter:'synthetic-adapter',classification:'external'}:null,
      adapter:'synthetic-adapter',policyRevision:revision,configRevision:'c1',restrictions:[],materials:[],complete:true
    }),'embedding',input=>host.resolvedPolicyScope(input));
    const wrapped={current:policy.current.bind(policy),evaluate:async(...args:Parameters<typeof policy.evaluate>)=>{
      if(holdPolicy){enteredPolicy?.();await holdPolicy;}
      return policy.evaluate(...args);
    }};
    const policyPort={selected:()=>selected,policy:wrapped,credentials:credential,gate,admit:()=>search.embeddingAdmissionAvailable()};
    const evidencePort={config:()=>config,scopeId:()=>rootId,
      verify:async(hit:EvidenceHit)=>{verifySpan(hit,await readFile(join(f.vault,hit.sourceId)));}};
    const search=new SearchController(async()=>{},undefined,undefined,evidencePort,evidencePort,undefined,undefined,
      undefined,undefined,credential,gate);
    search.attach(f.engine);
    const openHost=()=>new ApiDenseHost(f.engine,f.vault,rootId,'oks-synthetic-evidence',
      {config:()=>config,enabled:()=>true,allowedPath:()=>true,admitStorage:async()=>{}},Date.now,
      policyPort);
    host=openHost();
    const ui=new DenseUiController({host:()=>host,revokeNavigation:()=>{},navigate:async()=>{}});
    const owner=Symbol(),rebuild={kind:'rebuild' as const,paths:['a.md','b.md'],space};
    const query={kind:'search' as const,paths:['a.md','b.md'],space,request:request('common','hybrid')};
    const prepare=(op:typeof rebuild|typeof query=rebuild)=>host.prepareWithCredential(op,'synthetic',token);
    try{
      assert.equal((await search.search(uiRequest('common',1))).ok,true);
      const before=f.calls(),pointer=join(f.store.path,'CURRENT'),priorPointer=await readFile(pointer);
      const old=await host.confirm(await prepare(query),'synthetic','');
      assert.equal(old.error,'DISCLOSURE_DENIED');assert.equal(f.calls(),before);
      assert.deepEqual(await readFile(pointer),priorPointer);
      await assert.rejects(host.prepare(rebuild),{message:'NOT_READY'});
      admitted=false;await assert.rejects(prepare(),{message:'DISCLOSURE_DENIED'});admitted=true;
      assert.equal(credential.exclusiveBusy,false);assert.equal(f.calls(),before);
      const g=search.prepareGeneration(token);
      await assert.rejects(prepare(),{message:'BUSY'});search.cancelGeneration();
      assert.equal(f.calls(),before);assert.ok(g.credentialStamp);
      let p=await prepare();
      assert.equal(p.policyBindings?.length,2);assert.equal(credential.exclusiveBusy,true);
      assert.equal(f.calls(),before);assert.ok(!JSON.stringify(p).includes(token));
      assert.throws(()=>search.prepareGeneration(token),{message:'BUSY'});
      assert.throws(()=>search.prepareRerank(),{message:'BUSY'});
      const session=search.openRetainedChatSession();
      const scoped=search.startRetainedChatTurn(session,{mode:'selected',kind:'files',sourceIds:['a.md']},
        {requestId:'scope',query:'common',limit:5,matchMode:'terms'});
      assert.deepEqual(await scoped.result,{apiVersion:1,ok:false,error:'BUSY'});
      search.closeRetainedChatSession(session);
      await assert.rejects(host.confirm(p,'synthetic','replacement-token'),{message:'DISCLOSURE_DENIED'});
      assert.equal(credential.exclusiveBusy,false);
      p=await prepare();revision='p2';
      assert.equal(host.isPreviewCurrent(p),false);assert.equal(credential.exclusiveBusy,false);
      await assert.rejects(host.confirm(p,'synthetic',''),{message:'DISCLOSURE_DENIED'});assert.equal(f.calls(),before);
      await ui.prepare(owner,rebuild,undefined,{classification:'synthetic',token});
      const state=ui.snapshot(owner);assert.equal(state.phase,'preview');
      revision='p3';assert.equal(ui.snapshot(owner).phase,'idle');assert.equal(credential.exclusiveBusy,false);
      let entered!:()=>void,release!:()=>void;
      holdPolicy=new Promise<void>(resolve=>release=resolve);
      const started=new Promise<void>(resolve=>entered=resolve);enteredPolicy=entered;
      const pending=prepare();const cancelled=assert.rejects(pending,{message:'CANCELLED'});
      await started;host.invalidate();await cancelled;
      assert.equal(credential.exclusiveBusy,true);assert.equal(gate.busy,true);
      assert.throws(()=>search.prepareGeneration(token),{message:'BUSY'});
      assert.throws(()=>search.prepareRerank(),{message:'BUSY'});
      await assert.rejects(prepare(),{message:'BUSY'});
      release();await gate.drain();holdPolicy=undefined;enteredPolicy=undefined;
      assert.equal(credential.exclusiveBusy,false);assert.equal(f.calls(),before);
      p=await prepare();policyPort.policy={...wrapped};
      assert.equal(host.isPreviewCurrent(p),false);assert.equal(credential.exclusiveBusy,false);
      policyPort.policy=wrapped;
      let changed=false,seen=false,staleObserved=false;
      const unsubscribe1=ui.subscribe(()=>{
        if(!changed&&ui.snapshot(owner).phase==='preview'){changed=true;revision='observer-revocation';}
      });
      const unsubscribe2=ui.subscribe(()=>{if(changed){seen=true;staleObserved ||= credential.exclusiveBusy;}});
      await ui.prepare(owner,rebuild,undefined,{classification:'synthetic',token});
      unsubscribe1();unsubscribe2();assert.equal(changed,true);assert.equal(seen,true);assert.equal(staleObserved,false);
      assert.equal(ui.snapshot(owner).phase,'idle');assert.equal(f.calls(),before);
      p=await prepare();const built=await host.confirm(p,'synthetic','');
      assert.equal(built.status,'ok');assert.equal(f.calls(),before+2);assert.equal(credential.exclusiveBusy,false);
      assert.equal(host.isResultCurrent(built),true);
      assert.deepEqual(f.wireRequests().slice(-2).map(x=>x.texts),[['common alpha storage'],['common beta archive']]);
      // POLICY.3d1: recover the same single CURRENT in a fresh store and host.
      const root=await trustedVaultRoot(f.vault),reopened=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
      const snapshot=await reopened.snapshotApi(embeddingSpaceId(config,space),f.engine.status().generationId!);
      assert.ok(snapshot?.schemaVersion===3);
      assert.equal(snapshot.lineage.kind,'verified-originals-v1');
      assert.equal(snapshot.lineage.reuse,'local-retrieval-only');assert.equal(snapshot.lineage.batches.length,2);
      assert.equal(snapshot.lineage.batches.every(b=>b.configDigest===configDigest('embedding',config)),true);
      assert.equal('generationId' in built&&snapshot.generationId===built.generationId,true);
      const manifest=JSON.stringify(snapshot);
      for(const secret of [token,'credentialEpoch','hostId','deadlineUnixMs','expiresUnixMs','common alpha storage'])
        assert.equal(manifest.includes(secret),false);
      const lease=await f.engine.captureDenseCorpus(rebuild.paths,256,context().signal);
      const rehash=(g:typeof snapshot)=>{const {generationId:_,...base}=g;return {...base,generationId:sha(canonical(base))};};
      for(const batches of [snapshot.lineage.batches.slice(0,1),
        [snapshot.lineage.batches[0]!,snapshot.lineage.batches[0]!],
        snapshot.lineage.batches.map((b,i)=>i?{...b,payloadDigest:hash('substituted')}:b)]){
        const forged=rehash({...snapshot,lineage:{...snapshot.lineage,batches}});
        assert.throws(()=>validateApiDenseGeneration(forged,rootId));
      }
      const reversed=rehash({...snapshot,lineage:{...snapshot.lineage,batches:[...snapshot.lineage.batches].reverse()}});
      assert.throws(()=>assertDensePolicyReuse(reversed,config,lease.evidence,true),{message:'DISCLOSURE_DENIED'});
      const foreign=rehash({...snapshot,lineage:{...snapshot.lineage,batches:snapshot.lineage.batches.map(b=>({...b,scopeBinding:hash('foreign')}))}});
      assert.throws(()=>assertDensePolicyReuse(foreign,config,lease.evidence,true),{message:'DISCLOSURE_DENIED'});
      const currentPointer=await readFile(pointer);
      await assert.rejects(reopened.publishApi(structuredClone(snapshot),async()=>{},context().signal,()=>true),{message:'DISCLOSURE_DENIED'});
      assert.deepEqual(await readFile(pointer),currentPointer);
      await host.close();host=openHost();revision='reopened-policy';
      const wireBefore=f.calls();
      selected=false;
      const legacy=await host.confirm(await host.prepare(query),'synthetic',token);
      assert.equal(legacy.error,'DISCLOSURE_DENIED');assert.equal(f.calls(),wireBefore);
      selected=true;
      const originalConfig=config;
      config={...config,limits:{...config.limits,timeoutMs:config.limits.timeoutMs+1}};
      const changedConfig=await host.confirm(await prepare(query),'synthetic','');
      assert.equal(changedConfig.error,'DISCLOSURE_DENIED');assert.equal(f.calls(),wireBefore);
      assert.deepEqual(await readFile(pointer),currentPointer);
      config=originalConfig;
      p=await prepare(query);const retrieved=await host.confirm(p,'synthetic','');
      assert.equal(retrieved.status,'ok');assert.deepEqual(f.wireRequests().at(-1)?.texts,['common']);
      const prior=f.calls();
      p=await prepare();f.onRequest(()=>{revision='p4';});
      const failed=await host.confirm(p,'synthetic','');
      assert.equal(failed.status,'failed');assert.equal(f.calls(),prior+1);f.onRequest(()=>{});
      assert.equal(credential.exclusiveBusy,false);
      p=await prepare();selected=false;assert.equal(host.isPreviewCurrent(p),false);selected=true;
      assert.equal(credential.exclusiveBusy,false);
      await writeFile(join(f.vault,'b.md'),'---\nllm_processing: private\n---\ncommon beta archive\n');
      f.engine.reconcile();await f.engine.whenIdle();
      const noWire=f.calls();
      await assert.rejects(prepare(),{message:'DISCLOSURE_DENIED'});
      await assert.rejects(prepare(query),{message:'DISCLOSURE_DENIED'});
      assert.equal(f.calls(),noWire);assert.equal(credential.exclusiveBusy,false);
    }finally{ui.dispose();await host.close();search.dispose();}
  });
});


test('POLICY.3d1 exact current approved plan owns persisted derivative provenance; mixed and substituted batches cannot publish',async()=>{
  await fixture(async f=>{
    const lease=await f.engine.captureDenseCorpus(['a.md','b.md'],256,context().signal);
    const cfg=f.config,spaceId=embeddingSpaceId(cfg,space),digest=configDigest('embedding',cfg);
    let scope:EmbeddingPolicyScope|null=null;
    const host=new ProcessingPolicyHost<'embedding'>(()=>true,()=>f.engine,()=>({
      config:cfg,profile:{profileId:'fixture',admissionId:'review',role:'embedding',configDigest:digest,
        adapter:'fixture',classification:'external'},adapter:'fixture',policyRevision:'p1',configRevision:'c1',
      restrictions:[],materials:[],complete:true
    }),'embedding',()=>scope);
    const gate=new GenerationPolicyGate(),embedder=new EvidenceEmbedder();
    const approved:GenerationPolicyBinding[]=[],results:Awaited<ReturnType<EvidenceEmbedder['run']>>[]=[];
    for(const hit of lease.evidence){
      scope=resolveEmbeddingPolicyScope(lease,'document',[hit]);
      const i:EmbeddingPolicyInput={role:'embedding',config:cfg,scopeId:lease.rootId,ownerId:'fixture-owner',hostId:'fixture-host',
        credentialEpoch:1,deadlineUnixMs:Date.now()+5000,scopeBinding:scope.scopeBinding,
        scopeSources:scope.scopeSources,sources:scope.sources,embedding:{purpose:'document',space,spaceId,
          query:INDEX_PURPOSE_TEXT,queryClassification:'synthetic'},
        payloadDigest:embeddingPolicyPayload('document',spaceId,INDEX_PURPOSE_TEXT,'synthetic',scope.sources)};
      const ctx={signal:context().signal,deadlineUnixMs:i.deadlineUnixMs};
      const evaluate=()=>gate.evaluate(host,i,ctx,lease.current);
      const binding=await evaluate();
      const legacy=f.makeApproval('document',INDEX_PURPOSE_TEXT,[hit]);
      const policy:EmbeddingApproval={...legacy,candidates:legacy.candidates.map(c=>({...c,classification:'unknown'})),
        grant:{...legacy.grant,expiresUnixMs:i.deadlineUnixMs,notePolicyBinding:binding,
          sources:legacy.grant.sources.map(x=>({...x,classification:'unknown'}))}};
      results.push(await embedder.run(policy,token,ctx,lease.verify,lease.current,evaluate));approved.push(binding);
    }
    const build=(batches:typeof results,plan?:readonly GenerationPolicyBinding[])=>
      buildApiDenseGeneration(lease.rootId,cfg,space,lease.lexicalGenerationId,lease.evidence,batches,plan);
    const built=build(results,approved);
    assert.equal(built.schemaVersion,3);
    assert.throws(()=>build(results)); // no implicit policy-plan authority
    assert.throws(()=>build(results,[...approved].reverse()));
    assert.throws(()=>build(results,[approved[0]!,{...approved[1]!,bindingDigest:hash('foreign operation')}]));
    const legacy=await embedder.run(f.makeApproval('document',INDEX_PURPOSE_TEXT,[lease.evidence[1]!]),token,context(),lease.verify,lease.current);
    assert.throws(()=>build([results[0]!,legacy],approved));
    assert.throws(()=>build([results[0]!,legacy]));
    assert.throws(()=>build([structuredClone(results[0]!),results[1]!],approved),{message:'DISCLOSURE_DENIED'});
    const pointer=join(f.store.path,'CURRENT'),before=await readFile(pointer);
    await assert.rejects(f.store.publishApi(structuredClone(built),async()=>{},context().signal,lease.current),{message:'DISCLOSURE_DENIED'});
    assert.deepEqual(await readFile(pointer),before);
  });
});
