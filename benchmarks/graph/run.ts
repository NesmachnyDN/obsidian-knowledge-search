/** Local synthetic acceptance only. Frozen labels are not derived from engine output. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { BoundedVaultReader, privateIndexPath, type SourceProvider } from '../../plugin/src/standalone/source';
import { StandaloneEngine } from '../../plugin/src/standalone/engine';
import { WorkerMarkdownParser } from '../../plugin/src/standalone/worker';
import { syntheticNodeWorkerPort } from '../../tests/helpers/browser-worker-port';
import { GenerationStore } from '../../plugin/src/standalone/storage';
import { hash, PROTOCOL, StandaloneError, type SourceLocator } from '../../plugin/src/standalone/contracts';
import { deriveGraphProjection, type GraphEdge } from '../../plugin/src/standalone/graph-projection';
import type { GraphExpansion } from '../../plugin/src/standalone/graph-expansion';
import type { LocalGraphResult } from '../../plugin/src/standalone/graph-retrieval';
import type { ScopeSelector } from '../../plugin/src/standalone/chat-scope';

type EdgeLabel={kind:string;relationId:string|null;author:string;from:string;to:string;anchors:string[]};
type StepLabel=Omit<EdgeLabel,'anchors'|'kind'>&{traversal:string};
type PathLabel={source:string;steps:StepLabel[]};
type Query={id:string;language:'ru'|'en';category:'graph-required'|'ordinary';query:string;seed:string;
  labels:Record<string,number>;expectedPaths:PathLabel[];expansion:GraphExpansion};
type Corpus={mapping:unknown;heldOut:Query[];basePaths:string[];baseEdgeCount:number;
  expectedEdges:EdgeLabel[];files:Record<string,string>;expectedCoverage:Record<string,number>};
const raw=await readFile('benchmarks/graph/v1/corpus.json');
const manifest=JSON.parse(await readFile('benchmarks/graph/v1/manifest.json','utf8'));
assert.equal(hash(raw),manifest.corpusSha256,'FROZEN_CORPUS_CHANGED');
const corpus=JSON.parse(raw.toString('utf8')) as Corpus;
assert.deepEqual(corpus.heldOut.map(q=>q.id),manifest.heldOut);
const count=Number(process.argv[2]);
assert.ok(count===128||count===512);
const output=process.argv[3]; assert.ok(output);
const paths=count===128?[...corpus.basePaths]:Object.keys(corpus.files).sort();
assert.equal(paths.length,count);
for(const [path,source] of Object.entries(corpus.files))assert.equal(hash(source),manifest.sourceSha256[path]);
assert.equal(Object.keys(corpus.files).length,512);
assert.equal(corpus.heldOut.length,40);
const percentile=(values:number[],f:number)=>values.slice().sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*f)-1)]??0;
const unique=(paths:readonly string[])=>[...new Set(paths)].slice(0,10);
function quality(ranked:string[],q:Query){
  const grades=ranked.map(p=>q.labels[p]??0);
  const dcg=(items:number[])=>items.reduce((n,g,i)=>n+(2**g-1)/Math.log2(i+2),0);
  const ideal=Object.values(q.labels).sort((a,b)=>b-a).slice(0,10);
  const first=grades.findIndex(g=>g>0);
  return {recall:grades.filter(g=>g>0).length/ideal.length,ndcg:dcg(grades)/dcg(ideal),mrr:first<0?0:1/(first+1),
    exact:ranked.includes(q.seed)};
}
const countMatches=(actual:readonly string[],expected:readonly string[])=>{
  const remaining=[...expected];let matched=0;
  for(const a of actual){const i=remaining.indexOf(a);if(i>=0){matched++;remaining.splice(i,1);}}
  return {matched,actual:actual.length,expected:expected.length,precision:actual.length?matched/actual.length:1,
    recall:expected.length?matched/expected.length:1};
};
const stepKey=(s:StepLabel)=>JSON.stringify([s.author,s.from,s.to,s.relationId,s.traversal]);
const pathKey=(p:PathLabel)=>JSON.stringify([p.source,p.steps.map(stepKey)]);
const edgeKey=(e:EdgeLabel)=>JSON.stringify([e.kind,e.relationId,e.author,e.from,e.to,e.anchors]);
let locatorCount=0,invalidLocators=0;
function original(path:string,sha:string,loc:Readonly<SourceLocator>,excerpt?:string):string{
  locatorCount++;
  const text=corpus.files[path]??'',bytes=Buffer.from(text),prefix=bytes.subarray(0,loc.byteStart).toString('utf8');
  const part=bytes.subarray(loc.byteStart,loc.byteEnd).toString('utf8');
  if(!paths.includes(path)||hash(bytes)!==sha||loc.sourceVersion!==sha||loc.byteStart<0||loc.byteEnd>bytes.length
    ||loc.byteEnd<=loc.byteStart||loc.charStart!==[...prefix].length||loc.charEnd!==[...prefix+part].length
    ||loc.lineStart!==prefix.split(/\r\n|\r|\n/).length||loc.lineEnd!==loc.lineStart
    ||loc.blockOrder!==loc.lineStart-1||text.split(/\r\n|\r|\n/)[loc.lineStart-1]!==part
    ||(excerpt!==undefined&&excerpt!==part))invalidLocators++;
  return part;
}
function edgeLabel(e:GraphEdge):EdgeLabel{
  assert.equal(e.status.truth,'unverified');
  return {kind:e.kind,relationId:e.relationId,author:e.author,from:e.from,to:e.to,
    anchors:e.anchors.map(a=>original(a.sourceId,a.sourceSha256,a.locator))};
}
const sandbox=await mkdtemp(join(tmpdir(),'oks-06b4-'));
const root=join(sandbox,'vault');await mkdir(root);
const previous=process.env.XDG_DATA_HOME;process.env.XDG_DATA_HOME=join(sandbox,'xdg');
const lag=monitorEventLoopDelay({resolution:10});lag.enable();
let engine:StandaloneEngine|undefined;
try{
  for(const p of paths)await writeFile(join(root,p),corpus.files[p]!);
  const reader=await BoundedVaultReader.open(root,()=>paths);
  const io={readCalls:0,readBytes:0,readMs:0,listCalls:0,hintCalls:0,hintMs:0};
  const provider:SourceProvider={rootId:reader.rootId,
    list:async()=>{io.listCalls++;return reader.list();},
    versionHints:async p=>{io.hintCalls++;const start=performance.now();try{return await reader.versionHints(p);}finally{io.hintMs+=performance.now()-start;}},
    read:async p=>{io.readCalls++;const start=performance.now();try{const b=await reader.read(p);io.readBytes+=b.length;return b;}finally{io.readMs+=performance.now()-start;}}};
  const store=await GenerationStore.open(privateIndexPath(root,reader.rootId,'oks-synthetic-evidence'),reader.rootId);
  const makeEngine=()=>new StandaloneEngine(provider,store,new WorkerMarkdownParser(join(process.cwd(),'.test-build','standalone-worker.js'),syntheticNodeWorkerPort));
  engine=makeEngine();let now=performance.now();await engine.start();await engine.whenIdle();const buildMs=performance.now()-now;
  assert.equal(engine.status().status,'ready');assert.equal(engine.status().sources,count);
  const gen=(await store.load()).generation;assert.ok(gen);
  const indexBytes=(await stat(join(store.dir,'gen-'+gen.generationId+'.json'))).size;
  const beforeRss=process.memoryUsage().rss,beforePeak=process.resourceUsage().maxRSS*1024;
  let sampledPeak=beforeRss;const sample=()=>{sampledPeak=Math.max(sampledPeak,process.memoryUsage().rss);};
  const timer=setInterval(sample,5);
  const cpuStart=process.cpuUsage();const ioStart={...io};
  let result:Record<string,unknown>;
  try{
    const projectionMs:number[]=[];let projectionBytes=0,edgeReport:ReturnType<typeof countMatches>|undefined;
    const expected=corpus.expectedEdges.slice(0,count===128?corpus.baseEdgeCount:undefined).map(edgeKey);
    for(let i=0;i<5;i++){
      now=performance.now();const p=await deriveGraphProjection(gen,corpus.mapping);projectionMs.push(performance.now()-now);
      assert.ok(!('code' in p),JSON.stringify(p));projectionBytes=Buffer.byteLength(JSON.stringify(p));
      assert.deepEqual(p.coverage,corpus.expectedCoverage);
      edgeReport=countMatches(p.edges.map(edgeLabel).map(edgeKey),expected);assert.equal(edgeReport.precision,1);assert.equal(edgeReport.recall,1);sample();
    }
    engine.configureGraph(corpus.mapping);
    const signal=new AbortController().signal,scope={mode:'vault-wide'} as const;
    const q0=corpus.heldOut[0]!;
    const graphRequest=(q:Query,selected:ScopeSelector=scope)=>({requestId:q.id,query:q.query,limit:10,matchMode:'literal',scope:selected,expansion:q.expansion});
    now=performance.now();const cold=await engine.retrieveLocalGraph(graphRequest(q0),signal);const coldMs=performance.now()-now;
    assert.ok(cold.candidates.length>0);sample();
    const rows=[];
    for(const [i,q] of corpus.heldOut.entries()){
      const lexical=async()=>{
        const t=performance.now(),r=await engine!.search({protocolVersion:PROTOCOL,requestId:q.id,query:q.query,requestedMode:'lexical',matchMode:'literal',limit:10});
        const ms=performance.now()-t;assert.equal(r.status,'ok');assert.equal(r.executedMode,'lexical');assert.equal(r.staleSourceCount,0);
        for(const h of r.hits)original(h.sourceId,h.sourceSha256,h.sourceLocators[0]!,h.originalExcerpt);
        return {ranked:unique(r.hits.map(h=>h.sourceId)),ms};
      };
      const graph=async()=>{
        const t=performance.now(),r=await engine!.retrieveLocalGraph(graphRequest(q),signal),ms=performance.now()-t;
        assert.equal(r.executedMode,'graph');assert.equal(r.omittedByTopK,0);
        for(const c of r.candidates){original(c.sourceId,c.sourceSha256,c.locator,c.excerpt);
          for(const p of c.path)for(const a of p.anchorEvidence)original(a.sourceId,a.sourceSha256,a.locator,a.excerpt);}
        const actual=r.candidates.filter(c=>c.kind==='expanded').map(c=>pathKey({source:c.sourceId,
          steps:c.path.map(s=>({author:s.edge.author,from:s.edge.from,to:s.edge.to,relationId:s.edge.relationId,traversal:s.traversal}))}));
        return {ranked:r.candidates.map(c=>c.sourceId),ms,paths:countMatches(actual,q.expectedPaths.map(pathKey))};
      };
      const a=i%2?await graph():await lexical(),b=i%2?await lexical():await graph();
      const l=i%2?b:a,g=(i%2?a:b) as Awaited<ReturnType<typeof graph>>;
      rows.push({id:q.id,language:q.language,category:q.category,lexical:{...quality(l.ranked,q),...l},
        graph:{...quality(g.ranked,q),...g},addedMs:g.ms-l.ms});sample();
    }
    const summarize=(category:Query['category'])=>{
      const subset=rows.filter(r=>r.category===category);
      const mean=(mode:'lexical'|'graph',metric:'recall'|'ndcg'|'mrr')=>subset.reduce((n,r)=>n+r[mode][metric],0)/subset.length;
      const lexical={recall:mean('lexical','recall'),ndcg:mean('lexical','ndcg'),mrr:mean('lexical','mrr')};
      const graph={recall:mean('graph','recall'),ndcg:mean('graph','ndcg'),mrr:mean('graph','mrr')};
      return {count:subset.length,lexical,graph,delta:{recall:graph.recall-lexical.recall,ndcg:graph.ndcg-lexical.ndcg,mrr:graph.mrr-lexical.mrr}};
    };
    const required=summarize('graph-required'),ordinary=summarize('ordinary');
    const addedP95Ms=percentile(rows.map(r=>r.addedMs),.95);
    const projectionP95Ms=percentile(projectionMs,.95);
    const rssPeakDelta=Math.max(0,sampledPeak-beforeRss,process.resourceUsage().maxRSS*1024-beforePeak);
    const cpu=process.cpuUsage(cpuStart);
    const graphDiskBytes=(await stat(join(store.dir,'gen-'+gen.generationId+'.json'))).size-indexBytes;
    const eventLoopP95Ms=lag.percentile(95)/1e6;
    const allExact=rows.every(r=>r.lexical.exact&&r.graph.exact);
    const pathsExact=rows.every(r=>r.graph.paths.precision===1&&r.graph.paths.recall===1);
    const lifecycle:Record<string,boolean>={};
    const narrow:ScopeSelector={mode:'selected',kind:'files',sourceIds:[q0.seed]};
    const narrowResult=await engine.retrieveLocalGraph(graphRequest(q0,narrow),signal);
    lifecycle.narrow=narrowResult.candidates.length===1&&narrowResult.candidates[0]?.sourceId===q0.seed;
    const negRequest=(query:string)=>({requestId:'neg',query,limit:10,matchMode:'literal',scope,expansion:{depth:2,direction:'both',fanOut:16,maxExpanded:32}});
    const negative=await engine.retrieveLocalGraph(negRequest('Synthetic ambiguous.'),signal);
    lifecycle.ambiguous=negative.candidates.length===1;
    const cycle=await engine.retrieveLocalGraph(negRequest('Synthetic cycle A.'),signal);
    lifecycle.cycle=cycle.candidates.length===2&&cycle.candidates[1]?.path.length===1&&cycle.candidates[1]?.path[0]?.edge.kind==='relation';
    const local=await engine.retrieveLocalGraph(negRequest('Synthetic local only.'),signal);
    lifecycle.privateLocal=local.candidates.some(c=>c.sourceId==='neg-private.md');
    const lease=engine.captureLocalGraph(graphRequest(q0,narrow),signal);await lease.read();
    const competitor='neg-duplicate-a.md';
    await writeFile(join(root,competitor),'---\nid: ID-00-B\n---\nSynthetic collision.\n');
    await assert.rejects(lease.verify(),(e:unknown)=>e instanceof StandaloneError&&e.code==='GRAPH_SOURCE_STALE');
    lifecycle.silentEdit=!lease.current();await engine.whenIdle();
    await writeFile(join(root,competitor),corpus.files[competitor]!);engine.changed(competitor);await engine.whenIdle();
    const lease2=engine.captureLocalGraph(graphRequest(q0),signal);await lease2.read();
    const renamed='neg-duplicate-a-renamed.md';await rename(join(root,competitor),join(root,renamed));paths.splice(paths.indexOf(competitor),1,renamed);
    engine.changed(competitor);engine.changed(renamed);lifecycle.rename=!lease2.current();await engine.whenIdle();
    await rename(join(root,renamed),join(root,competitor));paths.splice(paths.indexOf(renamed),1,competitor);
    engine.changed(renamed);engine.changed(competitor);await engine.whenIdle();
    const lease3=engine.captureLocalGraph(graphRequest(q0),signal);await lease3.read();
    await rm(join(root,competitor));paths.splice(paths.indexOf(competitor),1);engine.changed(competitor);
    lifecycle.delete=!lease3.current();await engine.whenIdle();
    await writeFile(join(root,competitor),corpus.files[competitor]!);paths.push(competitor);engine.changed(competitor);await engine.whenIdle();
    const abort=new AbortController();abort.abort();
    await assert.rejects(engine.retrieveLocalGraph(graphRequest(q0),abort.signal));lifecycle.cancel=true;
    engine.configureGraph(null);
    await assert.rejects(engine.retrieveLocalGraph(graphRequest(q0),signal),(e:unknown)=>e instanceof StandaloneError&&e.code==='GRAPH_DISABLED');
    const rollback=await engine.search({protocolVersion:PROTOCOL,requestId:'rollback',query:q0.query,requestedMode:'lexical',matchMode:'literal',limit:10});
    lifecycle.rollback=rollback.status==='ok'&&rollback.hits.some(h=>h.sourceId===q0.seed);
    await engine.close();engine=makeEngine();now=performance.now();await engine.start();await engine.whenIdle();const restartMs=performance.now()-now;
    engine.configureGraph(corpus.mapping);const restarted=await engine.retrieveLocalGraph(graphRequest(q0),signal);
    lifecycle.restart=restarted.candidates.map(c=>c.sourceId).join()===cold.candidates.map(c=>c.sourceId).join();
    const gates={requiredRecall:required.delta.recall>=.10,requiredNdcg:required.delta.ndcg>=0,
      ordinaryNdcg:ordinary.delta.ndcg>=-.02,ordinaryMrr:ordinary.delta.mrr>=-.02,exactId:allExact,
      paths:pathsExact,edges:edgeReport?.precision===1&&edgeReport?.recall===1,locators:invalidLocators===0,
      lifecycle:Object.values(lifecycle).every(Boolean),projectionBytes:projectionBytes<=4*1024*1024,
      rss:rssPeakDelta<=64*1024*1024,projectionP95:projectionP95Ms<=500,
      addedP95:count!==128||addedP95Ms<=250,nodeEventLoopP95:eventLoopP95Ms<=50,graphDisk:graphDiskBytes===0};
    result={schema:'oks-06b4-results-v1',corpusSha256:manifest.corpusSha256,count,queryCount:rows.length,
      required,ordinary,rows,edgeReport,locatorCount,invalidLocators,lifecycle,gates,
      resources:{buildMs,coldMs,restartMs,projectionMs,projectionP95Ms,projectionBytes,addedP95Ms,
        lexicalP95Ms:percentile(rows.map(r=>r.lexical.ms),.95),graphP95Ms:percentile(rows.map(r=>r.graph.ms),.95),
        rssPeakDelta,beforeRss,sampledPeak,beforePeak,cpuUserMs:cpu.user/1000,cpuSystemMs:cpu.system/1000,indexBytes,graphDiskBytes,
        eventLoopP95Ms,io:Object.fromEntries(Object.entries(io).map(([k,v])=>[k,v-ioStart[k as keyof typeof ioStart]]))},
      providerProfiles:'NOT RUN: no provider admitted; deterministic local graph only',providerRequests:0,
      limitations:['Node worker-backed filesystem integration, not actual UI responsiveness','Exact identifier synthetic corpus; not semantic quality or production representativeness','No independent graph-to-AI profile admitted']};
  }finally{clearInterval(timer);}
  await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({count,required:result.required,ordinary:result.ordinary,gates:result.gates,resources:result.resources},null,2));
  if(!Object.values(result.gates as Record<string,boolean>).every(Boolean))process.exitCode=2;
}finally{
  lag.disable();await engine?.close();await rm(sandbox,{recursive:true,force:true});
  if(previous===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=previous;
}
