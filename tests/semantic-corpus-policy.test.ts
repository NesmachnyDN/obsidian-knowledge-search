import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash,BOUNDS} from '../plugin/src/standalone/contracts';
import {parsePolicyMetadata} from '../plugin/src/standalone/markdown-parse';
import {BoundedVaultReader} from '../plugin/src/standalone/source';
import {GenerationStore} from '../plugin/src/standalone/storage';
import {StandaloneEngine} from '../plugin/src/standalone/engine';
import {WorkerMarkdownParser} from '../plugin/src/standalone/worker';
import {syntheticNodeWorkerPort} from './helpers/browser-worker-port';
import {CORPUS_POLICY_VERSION,defaultCorpusConfig,previewCorpusNote,resolveCorpusNote,type CorpusMode} from '../plugin/src/ai/semantic-corpus-policy';
const rootId=hash('synthetic-root');
const config=(exclusions:unknown[]=[],defaultMode:CorpusMode='note_only')=>({version:CORPUS_POLICY_VERSION,defaultMode,exclusions});
const note=(front:string)=>Buffer.from(front?'---\n'+front+'\n---\n# synthetic note':'# synthetic note');
function resolve(front:string,c:unknown=defaultCorpusConfig(),sourceId='project/inbox/note.md'){
  const bytes=note(front),sha256=hash(bytes),proof=parsePolicyMetadata(sourceId,bytes,rootId,sha256);
  return resolveCorpusNote(c,{sourceId,sha256,rootId},proof);
}
test('AC-18.1 note policy resolves all exact modes, defaults and quoted values without admitting attachments',()=>{
  for(const [mode,eligible,attachments] of [['full',true,true],['note_only',true,false],['attachments_only',false,true],['none',false,false]] as const){
    for(const raw of [mode,'"'+mode+'"',"'"+mode+"'"]){
      const d=resolve('ai_indexing: '+raw);
      assert.equal(d.requestedMode,mode);assert.equal(d.effectiveMode,mode);assert.equal(d.noteEligible,eligible);
      assert.equal(d.attachmentIntent,attachments);assert.equal(d.attachmentEligible,false);
      assert.equal(d.attachmentReason,attachments?'ownership-unavailable':'excluded');assert.equal(d.complete,true);
    }
    const d=resolve('',config([],mode));assert.equal(d.effectiveMode,mode);assert.equal(d.reason,'default');
  }
  assert.equal(resolve('').effectiveMode,'note_only');
});
test('AC-18.1 malformed, duplicate, ambiguous and non-scalar corpus metadata never becomes absence',()=>{
  for(const front of ['ai_indexing: Full','ai_indexing: " full"','ai_indexing: "full "','ai_indexing: null','ai_indexing:','ai_indexing: true',
    'ai_indexing: 2','ai_indexing: ["full"]','ai_indexing: full\nai_indexing: none','AI_INDEXING: none','ai_indexing: full\nAI_INDEXING: none','"ai_indexing": none','other: &anchor full',
    'ai_indexing: full\nbad yaml']){
    const d=resolve(front,config([],'full'));assert.equal(d.noteEligible,false,front);assert.equal(d.complete,false,front);
    assert.equal(d.attachmentEligible,false);
  }
  for(const raw of ['---\nai_indexing: full','\n---\nai_indexing: full\n---','\ufeff---\nai_indexing: full\n---']){
    const bytes=Buffer.from(raw),sha256=hash(bytes),sourceId='a.md';
    try{assert.equal(resolveCorpusNote(config([],'full'),{sourceId,sha256,rootId},parsePolicyMetadata(sourceId,bytes,rootId,sha256)).noteEligible,false);}
    catch(error){assert.match(String(error),/INVALID_UTF8/);}
  }
});
test('AC-18.1 corpus policy does not infer confidentiality from indexing or vice versa',()=>{
  assert.equal(resolve('llm_processing: private\nai_indexing: full').noteEligible,true);
  assert.equal(resolve('llm_processing: external\nai_indexing: none').noteEligible,false);
  assert.equal(resolve('llm_processing: private').effectiveMode,'note_only');
  assert.equal(resolve('llm_processing: invalid\nai_indexing: full').noteEligible,true);
});
test('AC-18.1 deterministic hard exclusions use exact folders, extension, typed Properties, tags, purpose and collection',()=>{
  const front='ai_indexing: full\ntype: report\ntags: ["raw","finance"]\npurpose: audit\ncollection: archive\ncount: 7';
  const rules=[{id:'folder',when:{folderSegments:['inbox']}},{id:'compound',when:{noteType:'report',tags:['raw','finance'],fileTypes:['md'],
    purpose:'audit',collection:'archive',properties:[{key:'count',valueType:'number',operator:'eq',value:7}]}},
    {id:'prefix',when:{folderSegments:['in']}},{id:'wrong-type',when:{properties:[{key:'count',valueType:'string',operator:'eq',value:'7'}]}}];
  const d=resolve(front,config(rules));assert.equal(d.reason,'hard-exclusion');assert.deepEqual(d.matchedRuleIds,['folder','compound']);
  assert.equal(d.requestedMode,'full');assert.equal(d.effectiveMode,'none');assert.equal(d.attachmentIntent,true);
  assert.equal(d.noteEligible,false);assert.equal(d.attachmentEligible,false);
  assert.equal(resolve(front,config([rules[2],rules[3]])).noteEligible,true);
  assert.equal(resolve(front,config([{id:'file',when:{fileTypes:['pdf']}}])).noteEligible,true);
  assert.equal(resolve('ai_indexing: none',config([{id:'other',when:{folderSegments:['other']}}],'full')).noteEligible,false);
});
test('AC-18.1 missing verified properties are nonmatches; ambiguous selector semantics deny unless a false conjunct resolves',()=>{
  const rules=config([{id:'tag',when:{tags:['raw']}}],'full');
  assert.equal(resolve('',rules).noteEligible,true);
  assert.equal(resolve('tags: raw',rules).reason,'rule-input-unresolved');
  assert.equal(resolve('tags: raw',config([{id:'tag',when:{tags:['raw'],folderSegments:['other']}}],'full')).noteEligible,true);
  assert.equal(resolve('type: [\"report\"]',config([{id:'type',when:{noteType:'report'}}])).noteEligible,false);
});
test('AC-18.1 strict bounded configuration, stable immutable revisions and no unknown fields',()=>{
  for(const c of [null,config([{id:'x',when:{}}]),config([{id:'x',when:{unknown:'x'}}]),config([{id:'x',when:{folderSegments:['a/b']}}]),
    config([{id:'x',when:{fileTypes:['.md']}}]),config([{id:'x',when:{tags:['a','a']}}]),config([{id:'x',when:{noteType:'a'}},{id:'x',when:{noteType:'b'}}]),
    config(Array.from({length:BOUNDS.predicates+1},(_,i)=>({id:String(i),when:{noteType:'a'}}))),
    config([{id:'x',when:{properties:[{key:'n',valueType:'number',operator:'eq',value:7,extra:true}]}}]),{...config(),extra:true}]){
    assert.equal(resolve('ai_indexing: full',c).reason,'invalid-config');
  }
  const a=resolve('',config([{id:'one',when:{folderSegments:['else'],noteType:'a'}}]));
  const b=resolve('',config([{id:'one',when:{noteType:'a',folderSegments:['else']}}]));
  assert.deepEqual(a,b);assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen(a.matchedRuleIds));
  assert.notEqual(a.ruleRevision,resolve('',config([],'full')).ruleRevision);
  assert.notEqual(a.sourceBinding,resolve('ai_indexing: full',config()).sourceBinding);
  assert.notEqual(a.sourceBinding,resolve('',config(),'other.md').sourceBinding);
  assert.notEqual(a.ruleRevision,resolve('',config([{id:'one',when:{noteType:'b',folderSegments:['else']}}])).ruleRevision);
});
test('AC-18.1 exact source binding and strict canonical proof shape',()=>{
  const sourceId='a.md',bytes=note('ai_indexing: full'),sha256=hash(bytes),expected={sourceId,sha256,rootId};
  const proof=parsePolicyMetadata(sourceId,bytes,rootId,sha256);
  for(const modified of [{...proof,sourceId:'b.md'},{...proof,scopeId:hash('other')},{...proof,sha256:hash('other')},
    {...proof,state:'unresolved' as const},{...proof,state:'private' as const},{...proof,properties:[...proof.properties,...proof.properties]}]){
    assert.equal(resolveCorpusNote(config(),expected,modified).noteEligible,false);
  }
  assert.equal(resolveCorpusNote(config(),{...expected,sourceId:'../a.md'},proof).noteEligible,false);
});
test('AC-18.1 exact-original preview shares actual canonical worker; stale/cancelled/missing reads deny',async()=>{
  const base=await mkdtemp(join(tmpdir(),'oks-corpus-fixture-'));let engine:StandaloneEngine|undefined;
  try{
    const root=join(base,'vault'),sourceId='a.md',path=join(root,sourceId),bytes=note('ai_indexing: full\nllm_processing: private');
    await mkdir(root);await writeFile(path,bytes);
    const reader=await BoundedVaultReader.open(root,()=>[sourceId]),store=await GenerationStore.open(join(base,'index'),reader.rootId);
    engine=new StandaloneEngine(reader,store,new WorkerMarkdownParser(join(process.cwd(),'.test-build','standalone-worker.js'),syntheticNodeWorkerPort));
    await engine.start();await engine.whenIdle();
    const expected={sourceId,sha256:hash(bytes),rootId:reader.rootId};
    const result=await previewCorpusNote(engine,config(),expected,()=>true);
    assert.equal(result.noteEligible,true);assert.equal(result.attachmentEligible,false);
    assert.equal((await previewCorpusNote(engine,config(),{...expected,sha256:hash('stale')},()=>true)).reason,'source-mismatch');
    assert.equal((await previewCorpusNote(engine,config(),expected,()=>false)).noteEligible,false);
    await writeFile(path,note('ai_indexing: none'));assert.equal((await previewCorpusNote(engine,config(),expected,()=>true)).noteEligible,false);
    await unlink(path);assert.equal((await previewCorpusNote(engine,config(),expected,()=>true)).noteEligible,false);
  }finally{await engine?.close();await rm(base,{recursive:true,force:true});}
});
test('AC-18.1 preview captures configuration before async observation and rechecks authority',async()=>{
  const sourceId='a.md',bytes=note(''),sha256=hash(bytes),expected={sourceId,sha256,rootId};
  const c=config([],'note_only');let live=true;
  const engine={previewPolicyMetadata:async()=>{
    c.defaultMode='full';expected.sha256=hash('changed');
    return parsePolicyMetadata(sourceId,bytes,rootId,sha256);
  }};
  const result=await previewCorpusNote(engine,c,expected,()=>live);
  assert.equal(result.effectiveMode,'note_only');assert.equal(result.noteEligible,true);
  const revoked={previewPolicyMetadata:async()=>{live=false;return parsePolicyMetadata(sourceId,bytes,rootId,sha256);}};
  assert.equal((await previewCorpusNote(revoked,c,{sourceId,sha256,rootId},()=>live)).noteEligible,false);
});

test('AC-18.1 aggregate typed values and sparse malformed selectors cannot exceed bounded validation',()=>{
  const large=Array(BOUNDS.listItems).fill('x'.repeat(1024));
  const oversized=config([{id:'too-big',when:{properties:[{key:'tags',valueType:'list',operator:'eq',value:large}]}}]);
  assert.equal(resolve('ai_indexing: full',oversized).reason,'invalid-config');
  assert.equal(resolve('',config([{id:'hole',when:{tags:new Array(1)}}])).reason,'invalid-config');
  const sourceId='a.md',bytes=note(''),sha256=hash(bytes),proof=parsePolicyMetadata(sourceId,bytes,rootId,sha256);
  const props=Array.from({length:BOUNDS.propertiesPerSource},(_,i)=>({key:'p'+i,valueType:'list' as const,value:large}));
  assert.equal(resolveCorpusNote(config(),{sourceId,sha256,rootId},{...proof,properties:props}).noteEligible,false);
});
