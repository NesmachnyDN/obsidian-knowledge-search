import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../plugin/src/standalone/contracts';
import { parsePolicyMetadata } from '../plugin/src/standalone/markdown-parse';
import { EligibilityEvaluator, type PolicySnapshot, type TrustedProfile } from '../plugin/src/ai/processing-policy';
import { configDigest } from '../plugin/src/ai/disclosure';
import type { ProviderConfig } from '../plugin/src/ai/contracts';
import type { SourceProvider } from '../plugin/src/standalone/source';
import type { PolicyMetadataParser } from '../plugin/src/standalone/worker';

class MemoryReader implements SourceProvider {
  readonly rootId=hash('fixture-root');
  reads=0;
  constructor(readonly notes:Map<string,string>, readonly onRead?:(path:string,count:number)=>void){}
  async list(){return [...this.notes.keys()];}
  async versionHints(){return [];}
  async read(path:string){this.onRead?.(path,++this.reads);const value=this.notes.get(path);
    if(value===undefined)throw Error('missing');return Buffer.from(value);}
}
const parser:PolicyMetadataParser={policyMetadata:async (path,bytes,root)=>parsePolicyMetadata(path,bytes,root,hash(bytes))};
const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:9999',identity:{model:'fixture',revision:'r1'},
  limits:{timeoutMs:30000,maxInputBytes:65536,maxCandidates:50,maxOutputTokens:1024,maxConcurrent:1}};
const profile=(overrides:Partial<TrustedProfile>={}):TrustedProfile=>({profileId:'fixture-profile',admissionId:'fixture-review',role:'generation',
  configDigest:configDigest('generation',config),adapter:'fixture-adapter',classification:'external',...overrides});
const note=(name:string,raw:string)=>({sourceId:name,expectedSha256:hash(raw),ownerIds:[name],kind:'original' as const});
const snapshot=(raw:string,extra:Partial<PolicySnapshot>={}):PolicySnapshot=>({subjects:[note('note.md',raw)],profile:profile(),role:'generation',config,
  adapter:'fixture-adapter',ownerId:'turn-1',hostId:'host-1',scopeId:hash('scope'),policyRevision:'p1',configRevision:'c1',credentialEpoch:1,
  deadlineUnixMs:Date.now()+30000,payloadDigest:hash('synthetic payload'),restrictions:[],evaluationComplete:true,...extra});
async function evaluate(raw:string,extra:Partial<PolicySnapshot>={},reader?:MemoryReader,signal=new AbortController().signal){
  const s=snapshot(raw,extra);return new EligibilityEvaluator(reader??new MemoryReader(new Map([['note.md',raw]])),parser,{snapshot:()=>s,current:()=>true}).evaluate(signal);
}
const front=(value:string)=>`---\nllm_processing: ${value}\n---\n# synthetic`;

test('POLICY.1b exact scalar semantics, absent and malformed are distinct',async()=>{
  for(const raw of ['# absent',front('external'),front('"external"'),front("'external'"),'---\r\ntitle: Архитектура\r\n---\r\n# note'])
    assert.equal((await evaluate(raw)).reason,'eligible',raw);
  for(const value of ['private','External','" external"','"external "','null','["external"]','1','true','']){
    const r=await evaluate(front(value));assert.equal(r.allowed,false,value);
    assert.equal(r.reason,value==='private'?'private':'invalid-property',value);
    const i=await evaluate(front(value),{profile:profile({classification:'trusted-internal'})});assert.equal(i.allowed,true,value);
  }
});
test('POLICY.1b incomplete original metadata never becomes absent',async()=>{
  for(const raw of ['---\nllm_processing: external\nllm_processing: private\n---\n# duplicate',
    '---\n"llm_processing": private\n---\n# quoted key','--- # alternate\nllm_processing: private\n---\n# note',
    '\n---\nllm_processing: private\n---\n# leading line','%YAML 1.2\n---\nllm_processing: private\n---\n# directive',
    '---\nllm_processing: external\n# unterminated','---\nother: #comment\n---\n# malformed',
    '\ufeff---\nllm_processing: private\n---\n# bom']){
    const r=await evaluate(raw);assert.equal(r.allowed,false,raw);
    assert.equal((await evaluate(raw,{profile:profile({classification:'trusted-internal'})})).allowed,false,raw);
  }
});
test('POLICY.1b exact trusted admission, no loopback inference or config/role/adapter mismatch',async()=>{
  const raw=front('private');assert.equal((await evaluate(raw,{profile:null})).reason,'profile-unadmitted');
  assert.equal((await evaluate(raw)).reason,'private');
  assert.equal((await evaluate(raw,{profile:profile({classification:'trusted-internal'})})).allowed,true);
  for(const p of [profile({role:'reranking'}),profile({adapter:'foreign'}),profile({configDigest:hash('foreign')})])
    assert.equal((await evaluate(raw,{profile:p})).reason,'profile-mismatch');
  assert.equal((await evaluate(raw,{config:{...config,identity:{...config.identity,revision:'r2'}}})).reason,'profile-mismatch');
});
test('POLICY.1b restrictive rule precedence, known derivative lineage, unknown ownership denied',async()=>{
  const raw=front('external'),priv=front('private');
  assert.equal((await evaluate(raw,{restrictions:[{scope:'external',ownerId:'note.md'}]})).reason,'restricted');
  assert.equal((await evaluate(raw,{profile:profile({classification:'trusted-internal'}),restrictions:[{scope:'all'}]})).reason,'restricted');
  const derivative={sourceId:'derived-1',expectedSha256:hash('derived'),kind:'derivative' as const,ownerIds:['note.md','other.md'],parentSourceIds:['note.md','other.md']};
  const sources=[note('note.md',raw),note('other.md',priv),derivative];
  const reader=new MemoryReader(new Map([['note.md',raw],['other.md',priv]]));
  assert.equal((await evaluate(raw,{subjects:sources},reader)).reason,'private');
  assert.equal((await evaluate(raw,{subjects:sources,profile:profile({classification:'trusted-internal'})},reader)).allowed,true);
  assert.equal((await evaluate(raw,{subjects:[sources[0]!,derivative]},reader)).reason,'lineage-unresolved');
  assert.equal((await evaluate(raw,{subjects:[{...sources[0]!,kind:'attachment'}]},reader)).reason,'ownership-unresolved');
  assert.equal((await evaluate(raw,{evaluationComplete:false},reader)).allowed,false);
});
test('POLICY.1b stale originals, cancellation, mutation and changed authority fail closed',async()=>{
  const raw=front('external');let reader:MemoryReader;
  reader=new MemoryReader(new Map([['note.md',raw]]),(path,n)=>{if(n===2)reader.notes.set(path,front('private'));});
  assert.equal((await evaluate(raw,{},reader)).reason,'source-stale');
  let s=snapshot(raw);reader=new MemoryReader(new Map([['note.md',raw]]),()=>{s={...s,policyRevision:'p2'};});
  assert.equal((await new EligibilityEvaluator(reader,parser,{snapshot:()=>s,current:()=>true}).evaluate(new AbortController().signal)).reason,'authority-changed');
  const abort=new AbortController();reader=new MemoryReader(new Map([['note.md',raw]]),()=>abort.abort());
  assert.equal((await evaluate(raw,{},reader,abort.signal)).reason,'cancelled');
  assert.equal((await evaluate(raw,{deadlineUnixMs:Date.now()-1})).allowed,false);
  assert.equal((await evaluate(raw,{subjects:[note('note.md',raw),note('note.md',raw)]})).allowed,false);
});
test('POLICY.1b decision envelope immutable, binds exact scope, credential, payload and profile',async()=>{
  const raw=front('external'),s=snapshot(raw),r=new MemoryReader(new Map([['note.md',raw]]));let current=s;
  const evaluator=new EligibilityEvaluator(r,parser,{snapshot:()=>current,current:()=>true});const sig=new AbortController().signal;
  const result=await evaluator.evaluate(sig);assert.equal(result.allowed,true);assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.sourceVersions[0]));
  assert.throws(()=>{(result as unknown as {allowed:boolean}).allowed=false;});
  assert.equal((await evaluator.evaluate(sig)).bindingDigest,result.bindingDigest);
  for(const change of [{credentialEpoch:2},{payloadDigest:hash('other')},{scopeId:hash('other')},{profile:profile({admissionId:'other'})}]){
    current={...s,...change};assert.notEqual((await evaluator.evaluate(sig)).bindingDigest,result.bindingDigest);
  }
});

test('POLICY.1b existing worker carries version-bound compact proof, lexical parse stays unchanged',async()=>{
  const {WorkerMarkdownParser}=await import('../plugin/src/standalone/worker');
  const {syntheticNodeWorkerPort}=await import('./helpers/browser-worker-port');
  const {join}=await import('node:path');
  const worker=new WorkerMarkdownParser(join(process.cwd(),'.test-build','standalone-worker.js'),syntheticNodeWorkerPort);
  try {
    const raw=front('private'),bytes=Buffer.from(raw),root=hash('fixture-root'),s=snapshot(raw);
    const pending=worker.policyMetadata('note.md',bytes,root);
    await assert.rejects(worker.policyMetadata('note.md',bytes,root),/PARSER_BUSY/);
    const proof=await pending;
    assert.deepEqual(proof,{sourceId:'note.md',sha256:hash(raw),scopeId:root,state:'private'});
    assert.ok(Object.isFrozen(proof));
    const doc=await worker.parse('note.md',bytes,root);
    assert.equal(doc.properties[0]?.value,'private');assert.equal(doc.sha256,hash(raw));
    const r=await new EligibilityEvaluator(new MemoryReader(new Map([['note.md',raw]])),worker,
      {snapshot:()=>s,current:()=>true}).evaluate(new AbortController().signal);
    assert.equal(r.reason,'private');
    const s2=await worker.policyMetadata('note.md',Buffer.from('---\nllm_processing: private\nllm_processing: external\n---'),root);
    assert.equal(s2.state,'unresolved');
  }finally{await worker.close();}
});

test('POLICY.1b all originals are reread, foreign proof and incomplete authority fail closed',async()=>{
  const raw=front('external'),other='# other';
  const notes=new Map([['note.md',raw],['other.md',other]]);
  const s=snapshot(raw,{subjects:[note('note.md',raw),note('other.md',other)]});
  const r=new MemoryReader(notes,(path,n)=>{if(path==='other.md'&&n===2)notes.set('note.md',front('private'));});
  const host={snapshot:()=>s,current:()=>true};
  assert.equal((await new EligibilityEvaluator(r,parser,host).evaluate(new AbortController().signal)).reason,'source-stale');
  const reader=new MemoryReader(new Map([['note.md',raw],['other.md',other]]));
  const foreign:PolicyMetadataParser={policyMetadata:async(path,bytes,root)=>({...parsePolicyMetadata(path,bytes,root,hash(bytes)),scopeId:hash('foreign')})};
  assert.equal((await new EligibilityEvaluator(reader,foreign,host).evaluate(new AbortController().signal)).reason,'source-stale');
  for(const invalid of [{...s,evaluationComplete:false},{...s,credentialEpoch:0},{...s,unexpected:true}]){
    assert.equal((await new EligibilityEvaluator(reader,parser,{snapshot:()=>invalid,current:()=>true}).evaluate(new AbortController().signal)).allowed,false);
  }
});
