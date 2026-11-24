import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
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
function generation(rootId:string,config=cfg,declared=space){
  const hits=['a.md','b.md'].map(p=>evidence(rootId,p));
  const batch={spaceId:embeddingSpaceId(config,declared),purpose:'document' as const,
    vectors:[Array.from({length:declared.dimension},(_,i)=>i===0?1:0),
      Array.from({length:declared.dimension},(_,i)=>i===1?1:0)]};
  return {hits,batch,value:buildApiDenseGeneration(rootId,config,declared,lexicalId,hits,[{batch,evidence:hits}])};
}
test('D2 full selected-set coverage and space checks reject omission, duplication, purpose and dimension',()=>{
  const rootId=hash('root'),{hits,batch}=generation(rootId);
  const build=(b:typeof batch,e:EvidenceHit[]=hits)=>buildApiDenseGeneration(rootId,cfg,space,lexicalId,hits,[{batch:b,evidence:e}]);
  assert.throws(()=>build({...batch,vectors:[[1,0,0]]},[hits[0]!]));
  assert.throws(()=>build(batch,[hits[0]!,hits[0]!]));
  assert.throws(()=>build({...batch,spaceId:hash('other')}));
  assert.throws(()=>build({...batch,vectors:[[1,0],[0,1,0]]}));
  assert.throws(()=>build(batch,[{...hits[0]!,indexGenerationId:hash('other')},hits[1]!]));
  assert.throws(()=>buildApiDenseGeneration(rootId,cfg,space,lexicalId,hits,[{batch:{...batch,purpose:'query'},evidence:hits}]));
});
test('D2 atomic single CURRENT legacy -> API -> changed model, no old model files and cold recovery',async()=>{
  await temporary(async(vault,root)=>{
    const store=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    await store.publish(legacyEntry,legacy,async()=>{},sig());
    const old=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    const first=generation(root.id).value;
    await store.publishApi(first,async()=>{},sig());
    assert.equal(store.snapshot(),null);assert.throws(()=>old.snapshot());
    assert.deepEqual(await store.snapshotApi(first.spaceId,lexicalId),first);
    await assert.rejects(store.publish(legacyEntry,legacy,async()=>{},sig()));
    await assert.rejects(store.snapshotApi(hash('different'),lexicalId));
    await assert.rejects(store.snapshotApi(first.spaceId,hash('different')));
    const secondSpace={...space,revision:'v2',dimension:4};
    const secondCfg={...cfg,identity:{model:space.model,revision:'v2'}};
    const second=generation(root.id,secondCfg,secondSpace).value;
    const canceled=new AbortController();let checks=0;
    await assert.rejects(store.publishApi(second,async()=>{if(++checks===3)canceled.abort()},canceled.signal));
    assert.deepEqual(await store.snapshotApi(first.spaceId,lexicalId),first);
    assert.equal((await readdir(store.path)).filter(n=>n.endsWith('.json')).length,1);
    await store.publishApi(second,async()=>{},sig());
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
    const g=generation(root.id).value;
    let entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
    const job=store.publishApi(g,async()=>{entered();await blocked;},sig());
    await ready;
    try{await assert.rejects(competing.publishApi(g,async()=>{},sig()));}
    finally{release();}
    await job;
    assert.equal(await store.snapshotApi(g.spaceId,lexicalId).then(x=>x?.entries.length),2);
    store.revoke('a.md');assert.equal(await store.snapshotApi(g.spaceId,lexicalId),null);
    await writeFile(join(vault,'a.md'),'changed');
    const recovered=await AdvancedRetrievalStore.open(root,'oks-synthetic-evidence');
    await assert.rejects(recovered.snapshotApi(g.spaceId,lexicalId));
    await assert.rejects(recovered.publishApi(g,async()=>{},sig()));
    await writeFile(join(vault,'a.md'),raw);
    await writeFile(join(recovered.path,'CURRENT'),'{}\n',{mode:0o600});
    await assert.rejects(recovered.snapshotApi(g.spaceId,lexicalId));
    await assert.rejects(recovered.publishApi(g,async()=>{},sig()));
  });
});
