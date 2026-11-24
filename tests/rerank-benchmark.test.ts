import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadInputs, loadJudgments } from '../benchmarks/rerank/corpus';
import { capture, assertParity } from '../benchmarks/rerank/capture';
import { ordered, score, pairedBootstrap, percentile } from '../benchmarks/rerank/metrics';
import { serializeCandidates } from '../benchmarks/rerank/manifest';
import { fixtureTrials } from '../benchmarks/rerank/fixture';
import { summarize } from '../benchmarks/rerank/report';
import type { Candidate, Judgment } from '../benchmarks/rerank/types';

const c=(id:string,line:number,rank:number):Candidate=>({id,path:'synthetic.md',sourceSha256:'a'.repeat(64),
  excerptSha256:'b'.repeat(64),originalRank:rank,locator:{locatorKind:'markdown',sourceVersion:'a'.repeat(64),
    blockOrder:line-1,byteStart:line-1,byteEnd:line,charStart:line-1,charEnd:line,lineStart:line,lineEnd:line}});
test('metrics fixed K, graded ranking, exact ID, document dedup, failure and deterministic paired bootstrap',()=>{
  const a=c('a',1,1), b=c('b',2,2), irrelevant=c('z',3,3);
  const judgment:Judgment={id:'q',exact:true,unanswerable:false,category:'exact-id',labels:[
    {path:a.path,line:1,grade:2,sourceSha256:a.sourceSha256},
    {path:a.path,line:2,grade:1,sourceSha256:a.sourceSha256}]};
  const result=score([irrelevant,b,a],judgment,5);
  assert.equal(result.span.recall,1);assert.equal(result.span.precision,0.4);
  assert.equal(result.span.mrr,0.5);assert.equal(result.span.exactDirectHit,1);
  assert.ok(result.span.ndcg>0&&result.span.ndcg<1);
  assert.equal(result.document.recall,1);assert.equal(result.document.precision,0.2);
  assert.deepEqual(score([],judgment,10).span,{recall:0,precision:0,ndcg:0,mrr:0,exactDirectHit:0});
  assert.throws(()=>score([a,a],judgment,10));
  assert.throws(()=>score([a],{...judgment,unanswerable:true},10));
  assert.throws(()=>ordered(['a','a'],[a,b]));assert.throws(()=>ordered(['a'],[a,b]));
  assert.throws(()=>ordered(['a','x'],[a,b]));assert.deepEqual(ordered(['b','a'],[a,b]),[b,a]);
  assert.throws(()=>assertParity([a,b],[b,a]));
  assert.throws(()=>assertParity([a,a],[a,a]));
  assert.deepEqual(pairedBootstrap([0.1,0.1]),{mean:0.1,lower:0.1,upper:0.1,count:10000,seed:601});
  assert.deepEqual(pairedBootstrap([-0.1,0.2,0.3]),pairedBootstrap([-0.1,0.2,0.3]));
  assert.equal(percentile([],0.95),null);assert.equal(percentile([1,4,2,3],0.95),4);
});
test('actual Standalone capture matches frozen candidate manifest; verified synthetic rerank only',async()=>{
  const inputs=await loadInputs();
  const {captured,trials}=await capture(inputs.sources,inputs.queries,async(captured,host)=>{
    assert.equal(serializeCandidates(captured.map(c=>c.frozen)),
      await readFile('benchmarks/rerank/corpus/candidates.jsonl','utf8'));
    assert.equal(captured.length,120);
    assert.ok(captured.some(c=>c.hits.length===50));
    assert.ok(captured.some(c=>c.hits.length===0));
    return {captured,trials:await fixtureTrials(captured,host)};
  });
  assert.equal(trials.length,72);
  assert.ok(trials.some(t=>t.status==='no-candidates'));
  assert.ok(trials.some(t=>t.status==='succeeded'));
  assert.ok(trials.every(t=>t.apiMs===null&&t.tokens===null&&t.cost===null));
  const judgments=await loadJudgments(inputs.sources,inputs.queries);
  const report=summarize(captured,judgments,trials);
  assert.equal(report.baseline.find(x=>x.split==='held_out'&&x.n===50&&x.k===10)?.positive,75);
  assert.equal(report.fixture.length,4);
});
