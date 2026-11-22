import { readFile, writeFile, mkdir, mkdtemp, copyFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { BoundedVaultReader, privateIndexPath } from '../../plugin/src/standalone/source';
import { StandaloneEngine } from '../../plugin/src/standalone/engine';
import { WorkerMarkdownParser } from '../../plugin/src/standalone/worker';
import { syntheticNodeWorkerPort } from '../../tests/helpers/browser-worker-port';
import { GenerationStore } from '../../plugin/src/standalone/storage';
import { hash, PROTOCOL } from '../../plugin/src/standalone/contracts';

type Label = { path: string; line: number; grade: number };
type Query = { id: string; query: string; exact: boolean; unanswerable: boolean; labels: Label[] };
const manifest: {sources: {path:string;sha256:string}[]} =
  JSON.parse(await readFile('benchmarks/corpus/v1/manifest.json','utf8'));
const reference = JSON.parse(await readFile('benchmarks/retrieval/results.json', 'utf8'));
const sandbox = await mkdtemp(join(tmpdir(), 'oks-04a-benchmark-'));
const tmp = join(sandbox, 'vault');
await mkdir(tmp);
const previousXdg = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = join(sandbox, 'xdg');
const percentile = (values: number[], f: number): number =>
  values.slice().sort((a,b)=>a-b)[Math.max(0, Math.ceil(values.length*f)-1)] ?? 0;
function evaluate(ranked: {path:string;line:number}[], labels: Label[], k: number) {
  const grades = ranked.slice(0,k).map(r =>
    labels.find(l=>l.path===r.path && l.line===r.line)?.grade ?? 0);
  const dcg = (values: number[]) => values.reduce((s,g,i)=>s+(2**g-1)/Math.log2(i+2),0);
  const ideal = dcg(labels.map(l=>l.grade).sort((a,b)=>b-a).slice(0,k));
  return {
    recall: grades.filter(g=>g>0).length/labels.filter(l=>l.grade>0).length,
    precision: grades.filter(g=>g>0).length/k,
    ndcg: ideal ? dcg(grades)/ideal : 0,
    mrr: grades.findIndex(g=>g>0) < 0 ? 0 : 1/(grades.findIndex(g=>g>0)+1),
    exactDirectHit: grades.includes(2) ? 1 : 0,
  };
}
async function run() {
  const paths: string[] = [];
  for (const item of manifest.sources) {
    const raw = await readFile(join('benchmarks/corpus/v1/sources', item.path));
    if (hash(raw)!==item.sha256) throw new Error('FROZEN_SOURCE_CHANGED');
    await copyFile(join('benchmarks/corpus/v1/sources',item.path),join(tmp,item.path));
    paths.push(item.path);
  }
  const reader=await BoundedVaultReader.open(tmp,()=>paths);
  const cache=privateIndexPath(tmp,reader.rootId,'oks-synthetic-evidence');
  if (cache.startsWith(tmp+'/')) throw new Error('INDEX_CACHE_WITHIN_VAULT');
  const store=await GenerationStore.open(cache,reader.rootId);
  const engine=new StandaloneEngine(reader,store,
    new WorkerMarkdownParser(join(process.cwd(),'.test-build','standalone-worker.js'),
      syntheticNodeWorkerPort));
  const lag=monitorEventLoopDelay({resolution:10});
  lag.enable();
  try {
    const begin=performance.now();
    await engine.start(); await engine.whenIdle();
    const buildMs=performance.now()-begin;
    if (engine.status().status!=='ready') throw new Error('INDEX_BUILD_FAILED');
    const generation=await store.load();
    const indexedSourceCount=engine.status().sources, indexedRecordCount=engine.status().records;
    const latencies:number[]=[];
    const splitMetrics:Record<string, unknown>={};
    let invalidSourceLocators=0,failedQueries=0,staleEvidenceCount=0,exactIdQueries=0,exactIdDirectHits=0;
    for(const split of ['tuning','held_out']) {
      const queries: Query[]=JSON.parse(await readFile('benchmarks/corpus/v1/'+split+'.json','utf8'));
      const metrics:ReturnType<typeof evaluate>[]=[];
      let unanswerableWithHits=0;
      for(const query of queries) {
        const start=performance.now();
        const result=await engine.search({protocolVersion:PROTOCOL,requestId:query.id,
          query:query.query,requestedMode:'lexical',limit:10});
        latencies.push(performance.now()-start);
        if(result.status==='failed'||result.executedMode!=='lexical')failedQueries++;
        staleEvidenceCount+=result.staleSourceCount;
        const ranked:{path:string;line:number}[]=[];
        for(const hit of result.hits) {
          const loc=hit.sourceLocators[0]!;
          const bytes=await readFile(join(tmp,hit.sourceId));
          if(hash(bytes)!==hit.sourceSha256 ||
             bytes.subarray(loc.byteStart,loc.byteEnd).toString('utf8')!==hit.originalExcerpt ||
             bytes.subarray(0,loc.byteStart).toString().split(/\r\n|\r|\n/).length!==loc.lineStart)
            invalidSourceLocators++;
          ranked.push({path:hit.sourceId,line:loc.lineStart});
        }
        if(query.unanswerable) {if(ranked.length)unanswerableWithHits++;continue;}
        const values=evaluate(ranked,query.labels,10);
        metrics.push(values);
        if(query.exact){exactIdQueries++;exactIdDirectHits+=values.exactDirectHit;}
      }
      const mean=(key:keyof ReturnType<typeof evaluate>)=>metrics.reduce((s,m)=>s+m[key],0)/metrics.length;
      const python=reference.split_metrics[split].lexical.summary.span['10'];
      splitMetrics[split]={
        native:{queries:queries.length,positive:metrics.length,unanswerableWithHits,
          recallAt10:mean('recall'),precisionAt10:mean('precision'),
          ndcgAt10:mean('ndcg'),mrrAt10:mean('mrr')},
        pythonLexical:{recallAt10:python.recall,precisionAt10:python.precision,
          ndcgAt10:python.ndcg,mrrAt10:python.mrr,exactDirectHit:python.exact_direct_hit},
      };
    }
    const modified='boreal-storage.md';
    const before=await readFile(join(tmp,modified),'utf8');
    await writeFile(join(tmp,modified),before+'\nREQ-OKS-04A: incremental synthetic.\n');
    const stale=await engine.search({protocolVersion:PROTOCOL,requestId:'stale',
      query:'REQ-BOR-21',requestedMode:'lexical',limit:10});
    const staleHits=stale.hits.filter(h=>h.sourceId===modified).length;
    const t=performance.now();
    engine.changed(modified); await engine.whenIdle();
    const incrementalMs=performance.now()-t;
    const next=await engine.search({protocolVersion:PROTOCOL,requestId:'updated',
      query:'REQ-OKS-04A',requestedMode:'lexical',limit:10});
    const updatedHit=next.hits.some(h=>h.originalExcerpt.includes('REQ-OKS-04A'));
    const indexBytes=(await stat(join(store.dir,'gen-'+engine.status().generationId+'.json'))).size;
    const report={
      schemaVersion:'oks-04a-benchmark-v1', corpus:'synthetic-v1',
      pythonReference:'03B lexical; frozen tuning and held-out judgments',
      sourceCount:manifest.sources.length,indexedSourceCount,indexedRecordCount,
      generationSchema:generation.generation?.schemaVersion,
      indexLocation:'host-private-data-directory-outside-vault',
      buildMs,incrementalMs,indexBytes,
      processHeapUsedBytes:process.memoryUsage().heapUsed,
      processRssBytes:process.memoryUsage().rss,
      eventLoopDelayMaxMs:lag.max/1e6,
      queryP50Ms:percentile(latencies,0.5),queryP95Ms:percentile(latencies,0.95),
      queryMaxMs:Math.max(...latencies),queryCount:latencies.length,
      exactIdQueries,exactIdDirectHits,invalidSourceLocators,
      staleEvidenceCount:staleEvidenceCount+staleHits,
      staleSuppressionCount:stale.staleSourceCount,updatedHit,failedQueries,
      splitMetrics,
      limitations:['Synthetic filesystem API integration; not actual Obsidian UI/CLI smoke',
        'Lexical OR/identifier rank differs from FTS5 BM25; comparison is directional',
        'Process heap includes Node benchmark harness; not isolated core RSS',
        'Standalone has no model, dense/hybrid, OCR or binary document parser'],
    };
    await writeFile('benchmarks/standalone/results.json',JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
    if(invalidSourceLocators||staleHits||!updatedHit||failedQueries||indexedSourceCount!==21)
      process.exitCode=1;
  } finally { lag.disable(); await engine.close(); }
}
try { await run(); } finally {
  await rm(sandbox,{recursive:true,force:true});
  if(previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME=previousXdg;
}
