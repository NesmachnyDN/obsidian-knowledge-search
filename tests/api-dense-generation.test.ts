import {test} from 'node:test';
import {createServer} from 'node:http';
import {EvidenceEmbedder,type EmbeddingApproval} from '../plugin/src/ai/embedding-evidence';
import {configDigest} from '../plugin/src/ai/disclosure';
import {verifySpan} from '../plugin/src/search/navigation';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {AdvancedRetrievalStore,type IndexedSource} from '../plugin/src/advanced/retrieval-storage';
import {trustedVaultRoot} from '../plugin/src/advanced/source';
import {CHUNK_TOKENIZER_FINGERPRINT,type ModelIdentity} from '../plugin/src/advanced/model-protocol';
import {buildApiDenseGeneration} from '../plugin/src/ai/dense-generation';
import {embeddingSpaceId} from '../plugin/src/ai/embedding-space';
import type {ProviderConfig,EmbeddingSpace} from '../plugin/src/ai/contracts';
import {parseMarkdown} from '../plugin/src/standalone/markdown';
import {hash,type EvidenceHit} from '../plugin/src/standalone/contracts';

const legacy:ModelIdentity={...JSON.parse(readFileSync('benchmarks/embedding/results.json','utf8')).identity,
  effective_max_tokens:384,runtime_tokenizer_parity_verified:true};
const legacyEntry:IndexedSource={sourcePath:'legacy.md',sourceSha256:hash('legacy'),ingestGenerationId:hash('ingest'),
  profileId:'oks-advanced-markdown-v1',tokenizerFingerprint:CHUNK_TOKENIZER_FINGERPRINT,
  chunkIds:[hash('legacy chunk')],vectors:[Array.from({length:1024},(_,i)=>i===0?1:0)]};
const space:EmbeddingSpace={model:'fixture',revision:'v1',dimension:3,normalization:'unit-l2',
  serializationId:'utf8-verbatim-v1',queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
const cfg:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:10001',
  identity:{model:space.model,revision:space.revision},
  limits:{timeoutMs:1500,maxInputBytes:4096,maxCandidates:8,maxOutputTokens:32,maxConcurrent:1}};
const lexicalId=hash('lexical generation');
const raw=Buffer.from('# Synthetic\nREQ-D2: private synthetic excerpt\n');
function evidence(rootId:string,path:string):EvidenceHit {
  const doc=parseMarkdown(path,raw,rootId),block=doc.blocks[1]!;
  return {sourceId:doc.sourceId,sourceSha256:doc.sha256,originalExcerpt:block.originalText,
    sourceLocators:[block.locator],rank:1,lexicalRank:1,retrievalMode:'lexical',
    indexGenerationId:lexicalId,score:1,headings:[],wikiLinks:[],properties:[]};
}
const sig=()=>new AbortController().signal;
async function temporary(run:(vault:string,root:Awaited<ReturnType<typeof trustedVaultRoot>>)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'oks-api-dense-'));
  const vault=join(dir,'vault'),xdg=join(dir,'xdg'),prior=process.env.XDG_DATA_HOME;
  await mkdir(vault,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
  try{
    for(const file of ['a.md','b.md'])await writeFile(join(vault,file),raw);
    await run(vault,await trustedVaultRoot(vault));
  }finally{
    if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(dir,{recursive:true,force:true});
  }
}
async function generation(rootId:string,config=cfg,declared=space){
  const hits=['a.md','b.md'].map(p=>evidence(rootId,p));
  const server=createServer((req,res)=>{
    let body='';req.on('data',x=>body+=x);req.on('end',()=>{
      const input=JSON.parse(body) as {model:string;input:string[]};
      const data=input.input.map((_,index)=>({object:'embedding',index,
        embedding:Array.from({length:declared.dimension},(_,i)=>i===index?1:0)}));
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({model:input.model,data}));
    });
  });
  await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
  try{
    const address=server.address();if(!address||typeof address==='string')throw Error('FIXTURE_ADDRESS');
    const local={...config,origin:'http://127.0.0.1:'+address.port};
    const query={text:'Approved synthetic batch',classification:'synthetic' as const};
    const grant={version:1 as const,role:'embedding' as const,purpose:'document' as const,
      spaceId:embeddingSpaceId(local,declared),configDigest:configDigest('embedding',local),
      scopeId:rootId,expiresUnixMs:Date.now()+10000,queryDigest:hash(query.text),queryClassification:query.classification,
      sources:hits.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,
        excerptDigest:hash(hit.originalExcerpt),classification:'synthetic' as const}))};
    const approval:EmbeddingApproval={config:local,space:declared,purpose:'document',scopeId:rootId,query,
      candidates:hits.map(hit=>({hit,classification:'synthetic'})),grant};
    const result=await new EvidenceEmbedder().run(approval,'synthetic-token',
      {signal:sig(),deadlineUnixMs:Date.now()+3000},async hit=>{verifySpan(hit,raw);},()=>true);
    return {hits,result,config:local,value:buildApiDenseGeneration(rootId,local,declared,lexicalId,hits,[result])};
  }finally{
    server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));
  }
}
test('D2 complete coverage and issued ordinal provenance reject fabricated, swapped, mutated and cross-scope batches',async()=>{
  const rootId=hash('root'),{hits,result,config}=await generation(rootId);
  const build=(expected:EvidenceHit[]=hits,rows=[result],root=rootId)=>
    buildApiDenseGeneration(root,config,space,lexicalId,expected,rows);
  assert.throws(()=>build([hits[0]!]));
  assert.throws(()=>build([hits[0]!,hits[0]!]));
  assert.throws(()=>build(hits,[result,result]));
  assert.throws(()=>build(hits,[{...result,evidence:[...result.evidence].reverse()}]));
  assert.throws(()=>build(hits,[structuredClone(result)]));
  assert.throws(()=>build(hits,[result],hash('foreign scope')));
  assert.throws(()=>build([{...hits[0]!,indexGenerationId:hash('other')},hits[1]!]));
  const valid=build();
  assert.deepEqual(valid.entries.map(x=>[x.sourcePath,x.vector]),[['a.md',[1,0,0]],['b.md',[0,1,0]]]);
  result.batch.vectors.reverse();
  assert.throws(()=>build());
  const other=await generation(rootId,{...cfg,identity:{model:space.model,revision:'v2'}},{...space,revision:'v2'});
  assert.throws(()=>build(hits,[other.result]));
});
test('D2 atomic single CURRENT legacy -> API -> changed model, no old model files and cold recovery',async()=>{
  await temporary(async(vault,root)=>{
    const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    await store.publish(legacyEntry,legacy,async()=>{},sig());
    const old=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const first=(await generation(root.id)).value;
    await assert.rejects(store.publishApi(structuredClone(first),async()=>{},sig(),()=>true));
    await store.publishApi(first,async()=>{},sig(),()=>true);
    assert.equal(store.snapshot(),null);assert.throws(()=>old.snapshot());
    assert.deepEqual(await store.snapshotApi(first.spaceId,lexicalId),first);
    await assert.rejects(store.publish(legacyEntry,legacy,async()=>{},sig()));
    await assert.rejects(store.snapshotApi(hash('different'),lexicalId));
    await assert.rejects(store.snapshotApi(first.spaceId,hash('different')));
    const secondSpace={...space,revision:'v2',dimension:4};
    const secondCfg={...cfg,identity:{model:space.model,revision:'v2'}};
    const second=(await generation(root.id,secondCfg,secondSpace)).value;
    const canceled=new AbortController();let checks=0;
    await assert.rejects(store.publishApi(second,async()=>{if(++checks===3)canceled.abort()},canceled.signal,()=>true));
    assert.deepEqual(await store.snapshotApi(first.spaceId,lexicalId),first);
    assert.equal((await readdir(store.path)).filter(n=>n.endsWith('.json')).length,1);
    await store.publishApi(second,async()=>{},sig(),()=>true);
    const cold=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    assert.deepEqual(await cold.snapshotApi(second.spaceId,lexicalId),second);
    const names=await readdir(cold.path);
    assert.equal(names.length,2);
    const payload=await readFile(join(cold.path,names.find(n=>n.endsWith('.json'))!),'utf8');
    assert.ok(!payload.includes('private synthetic excerpt'));
    assert.deepEqual((await readdir(vault)).sort(),['a.md','b.md']);
    await assert.rejects(cold.snapshotApi(first.spaceId,lexicalId));
    // Explicit experimental rebuild may replace API, never mix formats.
    await cold.publish(legacyEntry,legacy,async()=>{},sig(),true);
    assert.equal(await cold.snapshotApi(second.spaceId,lexicalId),null);
    assert.equal(cold.snapshot()?.schemaVersion,1);
  });
});
test('D2 stale source, revoke, concurrent writer and forged pointer fail closed',async()=>{
  await temporary(async(vault,root)=>{
    const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const competing=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const g=(await generation(root.id)).value;
    let entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
    const job=store.publishApi(g,async()=>{entered();await blocked;},sig(),()=>true);
    await ready;
    try{await assert.rejects(competing.publishApi(g,async()=>{},sig(),()=>true));}
    finally{release();}
    await job;
    assert.equal(await store.snapshotApi(g.spaceId,lexicalId).then(x=>x?.entries.length),2);
    store.revoke('a.md');assert.equal(await store.snapshotApi(g.spaceId,lexicalId),null);
    await writeFile(join(vault,'a.md'),'changed');
    const recovered=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    assert.equal(await recovered.snapshotApi(g.spaceId,lexicalId),null);
    await assert.rejects(recovered.publishApi(g,async()=>{},sig(),()=>true));
    await writeFile(join(vault,'a.md'),raw);
    await recovered.publishApi(g,async()=>{},sig(),()=>true);
    assert.deepEqual(await recovered.snapshotApi(g.spaceId,lexicalId),g);
    await writeFile(join(recovered.path,'CURRENT'),'{}\n',{mode:0o600});
    await assert.rejects(recovered.snapshotApi(g.spaceId,lexicalId));
    await assert.rejects(recovered.publishApi(g,async()=>{},sig(),()=>true));
  });
});

test('D2 B1: sibling event during final guard cancels first publication even without byte changes',async()=>{
  await temporary(async(vault,root)=>{
    const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const sibling=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const g=(await generation(root.id)).value;
    let checks=0;
    await assert.rejects(store.publishApi(g,async()=>{
      if(++checks===3)sibling.revoke('a.md');
    },sig(),()=>true),{message:'MODEL_CANCELLED'});
    assert.equal(checks,3);
    assert.deepEqual(await readdir(store.path),[]);
    assert.equal(await store.snapshotApi(g.spaceId,lexicalId),null);
    await store.publishApi(g,async()=>{},sig(),()=>true);
    assert.deepEqual(await store.snapshotApi(g.spaceId,lexicalId),g);
  });
});
test('D2 B1: final caller check mutating source without event cannot publish or replace CURRENT',async()=>{
  await temporary(async(vault,root)=>{
    const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const g=(await generation(root.id)).value;
    let checks=0;
    await assert.rejects(store.publishApi(g,async()=>{
      if(++checks===3)await writeFile(join(vault,'a.md'),'changed');
    },sig(),()=>true));
    assert.equal(checks,3);
    assert.deepEqual(await readdir(store.path),[]);
    await writeFile(join(vault,'a.md'),raw);
    await store.publishApi(g,async()=>{},sig(),()=>true);
    const previous=await readFile(join(store.path,'CURRENT'));
    const replacement=(await generation(root.id)).value;
    checks=0;
    await assert.rejects(store.publishApi(replacement,async()=>{
      if(++checks===3)await writeFile(join(vault,'a.md'),'changed again');
    },sig(),()=>true));
    assert.equal(checks,3);
    assert.deepEqual(await readFile(join(store.path,'CURRENT')),previous);
    assert.equal((await readdir(store.path)).length,2);
    await assert.rejects(store.snapshotApi(g.spaceId,lexicalId));
  });
});

test('D2 B1: sibling event during replacement preserves CURRENT and suppresses affected old generation',async()=>{
  await temporary(async(vault,root)=>{
    const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const first=(await generation(root.id)).value;
    await store.publishApi(first,async()=>{},sig(),()=>true);
    const sibling=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const prior=await readFile(join(store.path,'CURRENT'));
    const next=(await generation(root.id)).value;
    let checks=0;
    await assert.rejects(store.publishApi(next,async()=>{
      if(++checks===3)sibling.revoke('a.md');
    },sig(),()=>true),{message:'MODEL_CANCELLED'});
    assert.equal(checks,3);
    assert.deepEqual(await readFile(join(store.path,'CURRENT')),prior);
    assert.equal((await readdir(store.path)).length,2);
    assert.equal(await store.snapshotApi(first.spaceId,lexicalId),null);
    assert.equal(await sibling.snapshotApi(first.spaceId,lexicalId),null);
    await store.publishApi(next,async()=>{},sig(),()=>true);
    assert.deepEqual(await store.snapshotApi(next.spaceId,lexicalId),next);
  });
});
test('D2 B2: API revocation survives same-process reopen before bytes change and obsolete-instance events',async()=>{
  await temporary(async(vault,root)=>{
    const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const g=(await generation(root.id)).value;
    await store.publishApi(g,async()=>{},sig(),()=>true);
    const sibling=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    store.revoke('a.md');
    assert.equal(await store.snapshotApi(g.spaceId,lexicalId),null);
    assert.equal(await sibling.snapshotApi(g.spaceId,lexicalId),null);
    const reopened=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    assert.equal(await reopened.snapshotApi(g.spaceId,lexicalId),null);
    await reopened.publishApi(g,async()=>{},sig(),()=>true);
    assert.deepEqual(await reopened.snapshotApi(g.spaceId,lexicalId),g);
    sibling.revoke('b.md');
    assert.equal(await reopened.snapshotApi(g.spaceId,lexicalId),null);
  });
});
test('D2 B3: legacy shared revocation filters all instances, reopen and incremental publication',async()=>{
  await temporary(async(vault,root)=>{
    const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    await store.publish(legacyEntry,legacy,async()=>{},sig());
    await store.publish({...legacyEntry,sourcePath:'folder/b.md'},legacy,async()=>{},sig());
    const sibling=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    store.revoke('folder');
    const visible=store.snapshot();
    assert.deepEqual(visible?.entries.map(e=>e.sourcePath),['legacy.md']);
    assert.deepEqual(sibling.snapshot(),visible);
    const reopened=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    assert.deepEqual(reopened.snapshot(),visible);
    await reopened.publish({...legacyEntry,sourcePath:'new.md'},legacy,async()=>{},sig());
    assert.deepEqual(reopened.snapshot()?.entries.map(e=>e.sourcePath),['legacy.md','new.md']);
    assert.throws(()=>sibling.snapshot());
  });
});

test('D2 B1/B2: event at CURRENT rename leaves publication uncertain and reopened index unavailable',async(t)=>{
  await temporary(async(vault,root)=>{
    const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const first=(await generation(root.id)).value;
    await store.publishApi(first,async()=>{},sig(),()=>true);
    const sibling=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const next=(await generation(root.id)).value;
    // Intercept only the actual rename completion, not production logic.
    const fs=createRequire(join(process.cwd(),'package.json'))('node:fs/promises') as typeof import('node:fs/promises');
    const renameOriginal=fs.rename;
    let injected=false;
    t.mock.method(fs,'rename',async(from:Parameters<typeof fs.rename>[0],to:Parameters<typeof fs.rename>[1])=>{
      await renameOriginal(from,to);
      if(!injected&&String(to).endsWith('/CURRENT')){
        injected=true;
        assert.equal(await sibling.snapshotApi(first.spaceId,lexicalId),null);
        sibling.revoke('a.md');
      }
    });
    await assert.rejects(store.publishApi(next,async()=>{},sig(),()=>true));
    assert.ok(injected);
    assert.throws(()=>store.snapshot());
    const reopened=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    assert.equal(await reopened.snapshotApi(next.spaceId,lexicalId),null);
    await reopened.publishApi(next,async()=>{},sig(),()=>true);
    assert.deepEqual(await reopened.snapshotApi(next.spaceId,lexicalId),next);
    assert.equal((await readdir(reopened.path)).length,2);
  });
});

for(const replace of [false,true]){
  test('D2 B4: caller invalidation at CURRENT rename blocks '+(replace?'replacement':'initial publication'),async(t)=>{
    await temporary(async(vault,root)=>{
      const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
      if(replace)await store.publishApi((await generation(root.id)).value,async()=>{},sig(),()=>true);
      const sibling=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
      const next=(await generation(root.id)).value;
      const fs=createRequire(join(process.cwd(),'package.json'))('node:fs/promises') as typeof import('node:fs/promises');
      const original=fs.rename;
      let current=true,checkedAfterSwitch=false;
      t.mock.method(fs,'rename',async(from:Parameters<typeof fs.rename>[0],to:Parameters<typeof fs.rename>[1])=>{
        await original(from,to);
        if(current&&String(to).endsWith('/CURRENT')){
          current=false;
          assert.equal(await sibling.snapshotApi(next.spaceId,lexicalId),null);
        }
      });
      // Keep the synchronous fence true to independently test the repeated
      // async guard, even if the caller fails to send an abort or source event.
      const check=async()=>{if(!current){checkedAfterSwitch=true;throw Error('CALLER_GENERATION_STALE');}};
      await assert.rejects(store.publishApi(next,check,sig(),()=>true));
      assert.equal(current,false);
      assert.ok(checkedAfterSwitch);
      assert.throws(()=>store.snapshot());
      const reopened=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
      assert.equal(await reopened.snapshotApi(next.spaceId,lexicalId),null);
      await reopened.publishApi(next,async()=>{},sig(),()=>true);
      assert.deepEqual(await reopened.snapshotApi(next.spaceId,lexicalId),next);
      assert.equal((await readdir(reopened.path)).length,2);
    });
  });
}
test('D2 B4: synchronous caller fence closes the last async verification window',async()=>{
  await temporary(async(vault,root)=>{
    const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const next=(await generation(root.id)).value;
    let current=true,checks=0;
    // All async checks report success, but the final check's await boundary
    // can observe a concurrent external-generation invalidation.
    await assert.rejects(store.publishApi(next,async()=>{
      if(++checks===5)current=false;
    },sig(),()=>current),{message:'MODEL_CANCELLED'});
    assert.equal(checks,5);
    const reopened=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    assert.equal(await reopened.snapshotApi(next.spaceId,lexicalId),null);
    await reopened.publishApi(next,async()=>{},sig(),()=>true);
    assert.deepEqual(await reopened.snapshotApi(next.spaceId,lexicalId),next);
  });
});
