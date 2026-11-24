import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, mkdir, link, open, rename, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash } from '../plugin/src/standalone/contracts';
import { readArtifact, readOpenedArtifact } from '../benchmarks/rerank/artifact';
import { loadInputs, loadJudgments, loadCandidates } from '../benchmarks/rerank/corpus';
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
test('frozen artifacts reject symlinks, nonregular files, oversized bytes, digest drift and races',async()=>{
  const root=await mkdtemp(join(tmpdir(),'oks-artifact-'));
  const path=join(root,'sources.jsonl');
  try {
    await writeFile(path,'synthetic');
    assert.equal((await readArtifact(root,'sources.jsonl',hash('synthetic'))).toString(),'synthetic');
    await assert.rejects(readArtifact(root,'sources.jsonl',hash('other')),/CORPUS_DIGEST_MISMATCH/);
    await assert.rejects(readArtifact(root,'../sources.jsonl'),/CORPUS_FILE_INVALID/);
    await symlink(path,join(root,'requests.jsonl'));
    await assert.rejects(readArtifact(root,'requests.jsonl'));
    await mkdir(join(root,'judgments.jsonl'));
    await assert.rejects(readArtifact(root,'judgments.jsonl'),/CORPUS_FILE_INVALID/);
    execFileSync('mkfifo',[join(root,'candidates.jsonl')],{timeout:1000});
    await assert.rejects(readArtifact(root,'candidates.jsonl'),/CORPUS_FILE_INVALID/);
    await link(path,join(root,'manifest.json'));
    await assert.rejects(readArtifact(root,'sources.jsonl'),/CORPUS_FILE_INVALID/);
    await rm(join(root,'manifest.json'));
    await writeFile(join(root,'manifest.json'),Buffer.alloc(2*1024*1024+1));
    await assert.rejects(readArtifact(root,'manifest.json'),/CORPUS_FILE_INVALID/);
    await symlink(root,join(root,'alias'));
    await assert.rejects(readArtifact(join(root,'alias'),'sources.jsonl'));
    const old=await open(path,'r');
    try {
      await rename(path,join(root,'replaced'));
      await writeFile(path,'replacement');
      await assert.rejects(readOpenedArtifact(old,path),/CORPUS_FILE_CHANGED/);
    } finally {await old.close();}
    const growing=await open(path,'r');
    try {
      const read=growing.read.bind(growing);
      let first=true;
      // Deterministically grow the actual file after fstat and before the first read.
      Object.defineProperty(growing,'read',{value:async(buffer:Buffer,offset:number,length:number,position:number)=>{
        if(first){first=false;await appendFile(path,Buffer.alloc(2*1024*1024));}
        return read(buffer,offset,length,position);
      }});
      await assert.rejects(readOpenedArtifact(growing,path),/CORPUS_FILE_LIMIT/);
    } finally {await growing.close();}
  } finally {await rm(root,{recursive:true,force:true});}
});
test('actual Standalone capture matches frozen candidate manifest; verified synthetic rerank only',async()=>{
  const inputs=await loadInputs();
  const {captured,trials}=await capture(inputs.sources,inputs.queries,async(captured,host)=>{
    assert.equal(serializeCandidates(captured.map(c=>c.frozen)),
      await loadCandidates(inputs.candidateSha256));
    assert.equal(captured.length,120);
    const held=captured.filter(c=>c.input.split==='held_out');
    assert.ok(held.filter(c=>c.hits.length===50).length>=20);
    const exact=held.filter(c=>c.input.id.endsWith('-1'));
    assert.equal(exact.length,15);
    assert.ok(exact.every(c=>c.hits.length>1));
    assert.ok(exact.filter(c=>c.hits.length>10).length>=6);
    assert.ok(captured.filter(c=>c.input.id.endsWith('-5')).every(c=>c.hits.length>0));
    assert.equal(new Set(inputs.queries.flatMap(q=>q.predicates??[]).map(p=>p.valueType)).size,5);
    assert.ok(captured.some(c=>c.hits.length===0));
    return {captured,trials:await fixtureTrials(captured,host)};
  });
  assert.equal(trials.length,72);
  assert.ok(trials.some(t=>t.status==='no-candidates'));
  assert.ok(trials.some(t=>t.status==='succeeded'));
  assert.ok(trials.every(t=>t.apiMs===null&&t.tokens===null&&t.cost===null));
  const judgments=await loadJudgments(inputs.sources,inputs.queries,inputs.judgmentSha256);
  const report=summarize(captured,judgments,trials);
  assert.equal(report.baseline.find(x=>x.split==='held_out'&&x.n===50&&x.k===10)?.positive,75);
  assert.equal(report.fixture.length,4);
});
