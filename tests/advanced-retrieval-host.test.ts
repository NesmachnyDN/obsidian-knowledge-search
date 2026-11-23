/** Actual-model offline integration; explicit opt-in, synthetic Vault and private XDG. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {mkdtemp,mkdir,copyFile,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {AdvancedIngestionManager} from '../plugin/src/advanced/manager';
import {AdvancedRetrievalManager} from '../plugin/src/advanced/retrieval-manager';
import {AdvancedRetrievalStore} from '../plugin/src/advanced/retrieval-storage';
import {trustedVaultRoot} from '../plugin/src/advanced/source';
import {ModelError} from '../plugin/src/advanced/model-protocol';
import type {IngestionConfig} from '../plugin/src/search/settings';
import {rankAdvanced, type RetrievalRequest, type RetrievalResponse} from '../plugin/src/advanced/retrieval';
const enabled=process.env.OKS_05D_REAL_MODEL==='1';
const python=process.env.OKS_05C_PYTHON??'';
const snapshot=process.env.OKS_05C_TOKENIZER_SNAPSHOT??'';
const tessdata=process.env.OKS_05C_TESSDATA??'';
const cfg=(pdfMode:IngestionConfig['pdfMode']='text'):IngestionConfig=>({
  enabled:true,interpreter:python,entry:resolve('engine/advanced_ingest.py'),
  tokenizerSnapshot:snapshot,tessdataPath:tessdata,artifactsPath:'',pdfMode,
});
const query=(requestedMode:RetrievalRequest['requestedMode'],text='REQ-DR-17'):RetrievalRequest=>({
  requestedMode,query:text,limit:5,
});
const text1='---\nteam: storage\nactive: true\n---\n# Федеративное хранилище\nREQ-DR-17: Архив документов использует S3.\n';
const text2='---\nteam: search\nactive: false\n---\n# Search capability\nREQ-EN-44: Vector evidence search uses local BGE-M3.\n';
const k=5;
function metrics(rows:RetrievalResponse[],expected:string[]):{recall:number;mrr:number;ndcg:number;hitRate:number}{
  const ranks=rows.map((r,i)=>r.hits.findIndex(h=>h.sourceId===expected[i])+1);
  return {recall:ranks.filter(rank=>rank>0&&rank<=k).length/expected.length,
    mrr:ranks.reduce((s,rank)=>s+(rank?1/rank:0),0)/ranks.length,
    ndcg:ranks.reduce((s,rank)=>s+(rank?1/Math.log2(rank+1):0),0)/ranks.length,
    hitRate:ranks.filter(rank=>rank===1).length/ranks.length};
}

test('05D actual CPU BGE-M3 through real Node→cgroup→Python→Node, v3 source, durable index, negative queries and stale refusal',
  {skip:!enabled?'requires explicit local model and offline cgroup admission':undefined,timeout:540000},async()=>{
    assert.ok(python&&snapshot&&tessdata,'explicit trusted local artifacts required');
    const dir=await mkdtemp(join(tmpdir(),'oks05d-host-'));
    const root=join(dir,'vault'),xdg=join(dir,'xdg'),pluginId='oks-synthetic-evidence';
    await mkdir(root,{mode:0o700});await mkdir(xdg,{mode:0o700});
    const originalXdg=process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME=xdg;
    const ingestion=new AdvancedIngestionManager(),retrieval=new AdvancedRetrievalManager(ingestion);
    try{
      await writeFile(join(root,'ru.md'),text1,{mode:0o600});
      await writeFile(join(root,'en.md'),text2,{mode:0o600});
      const files=[['ru.md','text'],['en.md','text']] as const;
      for(const [path,mode] of files){
        const result=await ingestion.ingest(cfg(mode),root,pluginId,path,()=>true);
        assert.equal(result.status,'ok');
        console.log('05D_EXTRACT',path,result.chunks.length);
        const lex=await retrieval.search(cfg(),root,pluginId,query('lexical','REQ-DR-17'),()=>true);
        assert.equal(lex.status,'ok');
      }
      // Model-backed, independent indexing per source, never hash vectors.
      for(const [path] of files){
        const started=performance.now();
        await retrieval.index(cfg(),root,pluginId,path,()=>true);
        console.log('05D_REAL_INDEX',path,'ms',Math.round(performance.now()-started),retrieval.snapshot());
        if(path==='ru.md'){
          // en.md is already ingested, but has no vectors yet. This is the
          // production incremental-indexing acceptance case from B4.
          const scoped=await retrieval.search(cfg(),root,pluginId,
            {...query('hybrid','REQ-DR-17'),scope:['ru.md']},()=>true);
          assert.equal(scoped.status,'ok',scoped.error??'unexpected scoped retrieval failure');
          assert.equal(scoped.executedMode,'hybrid');
          assert.ok(scoped.hits.length>0&&scoped.hits.every(h=>h.sourceId==='ru.md'));
          const empty=await retrieval.search(cfg(),root,pluginId,
            {...query('hybrid','REQ-DR-17'),scope:['absent.md']},()=>true);
          assert.equal(empty.status,'ok',empty.error??'unexpected empty-scope retrieval failure');
          assert.equal(empty.executedMode,'hybrid');
          assert.equal(empty.hits.length,0);
          console.log('OKS05D_REAL_INCREMENTAL_SCOPE_PASS: unindexed source excluded; empty hybrid scope returns zero hits');
        }
      }
      const requests=[query('lexical','REQ-DR-17'),query('dense','Документный архив на S3'),
        query('hybrid','REQ-DR-17'),query('hybrid','REQ-EN-44')];
      const results:RetrievalResponse[]=[];
      for(const q of requests){
        const t=performance.now();
        const r=await retrieval.search(cfg(),root,pluginId,q,()=>true);
        assert.equal(r.status,'ok',r.error??'unexpected retrieval failure');
        assert.equal(r.executedMode,q.requestedMode);
        assert.ok(r.hits.length>0);
        assert.ok(r.hits.every(h=>h.sourceLocators.length>0&&h.originalExcerpt&&h.sourceSha256));
        results.push(r);
        console.log('05D_REAL_RETRIEVAL',q.requestedMode,q.query,'ms',Math.round(performance.now()-t),
          'hits',r.hits.map(h=>[h.sourceId,h.lexicalRank,h.denseRank,h.rrfScore]));
      }
      const expected=['ru.md','ru.md','ru.md','en.md'];
      console.log('05D_RETRIEVAL_METRICS',JSON.stringify(metrics(results,expected)));
      assert.ok(results[0]!.hits[0]!.originalExcerpt.includes('REQ-DR-17'));
      assert.ok(results[2]!.hits.some(h=>h.lexicalRank!==null&&h.denseRank!==null));
      const neg=await retrieval.search(cfg(),root,pluginId,query('lexical','NEVER-FOUND-999'),()=>true);
      assert.equal(neg.status,'ok');assert.equal(neg.hits.length,0);
      const filtered=await retrieval.search(cfg(),root,pluginId,{...query('lexical','REQ-DR-17'),
        predicates:[{key:'active',valueType:'boolean',value:true,operator:'eq'}]},()=>true);
      assert.equal(filtered.hits[0]?.sourceId,'ru.md');
      const identity=await trustedVaultRoot(root);
      const recovered=await AdvancedRetrievalStore.open(identity,pluginId);
      assert.equal(recovered.snapshot()?.entries.length,2);
      // Frozen bilingual paired evaluation. Both legs rank the SAME source
      // universe with real query vectors from one independently admitted model
      // batch; synthetic/mock vectors must never enter this benchmark.
      const frozen=[
        {query:'REQ-DR-17',sourceId:'ru.md',exact:true},
        {query:'REQ-EN-44',sourceId:'en.md',exact:true},
        {query:'Где хранятся файлы в объектном архиве?',sourceId:'ru.md',exact:false},
        {query:'How does local embedding search work?',sourceId:'en.md',exact:false},
      ] as const;
      const batch=await ingestion.runner.embed(cfg(),frozen.map(x=>x.query));
      const universe=(await ingestion.verifiedAll(()=>true)).documents.map(response=>({response}));
      const fixedGeneration=recovered.snapshot();
      assert.ok(fixedGeneration);
      for(const mode of ['lexical','dense','hybrid'] as const){
        const scored:RetrievalResponse[]=frozen.map((item,i)=>rankAdvanced({documents:universe,
          generation:fixedGeneration, queryVector:mode==='lexical'?null:batch.vectors[i]!,
          request:query(mode,item.query)}));
        assert.ok(scored.every(x=>x.status==='ok'&&x.executedMode===mode));
        const scores=metrics(scored,frozen.map(x=>x.sourceId));
        const exactIdHitRate=scored.slice(0,2).filter((x,i)=>x.hits[0]?.sourceId===frozen[i]!.sourceId).length/2;
        console.log('OKS05D_FROZEN_MODE_METRICS',mode,JSON.stringify({...scores,exactIdHitRate,
          queries:frozen.length,k,exactQueries:2}));
      }
      await writeFile(join(root,'ru.md'),text1+'\n# changed\n');
      const denied=await retrieval.search(cfg(),root,pluginId,query('hybrid','REQ-DR-17'),()=>true);
      assert.equal(denied.hits.some(h=>h.sourceId==='ru.md'),false,
        'mutated source must never produce an evidence hit');
      if(denied.status!=='failed'){
        assert.equal(denied.executedMode,'hybrid');
        assert.equal(denied.legs.lexical.status,'ready');
        assert.equal(denied.legs.dense.status,'ready');
      }else{
        assert.equal(denied.executedMode,'none');
        assert.equal(denied.hits.length,0);
      }
      await assert.rejects(retrieval.verifyHit(results[2]!.hits[0]!,
        results[2]!.hits[0]!.sourceId,()=>true));
      // Real in-flight mutation: start the actual model worker, then modify the
      // remaining document while the query is computing BGE-M3 embeddings.
      const running=retrieval.search(cfg(),root,pluginId,query('hybrid','REQ-EN-44'),()=>true);
      const start=Date.now();
      while(!ingestion.runner.busy&&Date.now()-start<8000)
        await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(ingestion.runner.busy,true,'actual real-model worker must be active');
      await writeFile(join(root,'en.md'),text2+'\n# midflight mutation\n');
      const mutated=await running;
      assert.equal(mutated.status,'failed','mutated source must fail live search');
      assert.equal(mutated.executedMode,'none');
      assert.equal(mutated.hits.length,0);
      assert.equal(mutated.error,'SOURCE_STALE');
      await retrieval.stop();
      const corrupted=await AdvancedRetrievalStore.open(identity,pluginId);
      await writeFile(join(corrupted.path,'CURRENT'),'{}\n',{mode:0o600});
      await assert.rejects(AdvancedRetrievalStore.open(identity,pluginId));
      console.log('OKS05D_REAL_CGROUP_PASS: real weights, two source versions, 3 modes, recovery, stale, corruption');
    }finally{
      await retrieval.dispose().catch(()=>{});
      await ingestion.dispose().catch(()=>{});
      if(originalXdg===undefined)delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME=originalXdg;
      await rm(dir,{recursive:true,force:true});
    }
  });
