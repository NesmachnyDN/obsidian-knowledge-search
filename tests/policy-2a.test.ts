import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../plugin/src/standalone/contracts';
import { parsePolicyMetadata } from '../plugin/src/standalone/markdown-parse';
import { decideNewMaterialMarking, NEW_MATERIAL_RULE_CONFIG_VERSION, type NewMaterialPolicyInput } from '../plugin/src/ai/new-material-policy';

const root=hash('synthetic-root');
const raw=(front:string='')=>Buffer.from(front?`---\n${front}\n---\n# synthetic`:'# synthetic');
function input(sourceId='inbox/project/note.md',bytes=raw(),overrides:Partial<NewMaterialPolicyInput>={}):NewMaterialPolicyInput{
  const sha=hash(bytes),proof=parsePolicyMetadata(sourceId,bytes,root,sha);
  return {sourceId,sha256:sha,rootId:root,proof,lifecycle:{state:'verified-new',sourceId,sha256:sha,rootId:root},provenance:null,...overrides};
}
const config=(rules:unknown[]=[],defaultAction:'leave-absent'|'set-external'|'set-private'='leave-absent')=>({version:NEW_MATERIAL_RULE_CONFIG_VERSION,defaultAction,rules});

test('POLICY.2a uses current original typed worker-compatible metadata and exact segment matching',()=>{
  const bytes=raw('type: invoice\ntemplate: import\ntags: ["finance", "inbox"]\namount: 7');
  const value=input('archive/inbox/report.md',bytes);
  const c=config([{id:'typed',action:'set-external',when:{folderSegments:['inbox'],type:'invoice',template:'import',tags:['finance'],properties:[{key:'amount',valueType:'number',value:7,operator:'eq'}]}}]);
  const result=decideNewMaterialMarking(c,value);
  assert.equal(result.action,'set-external');assert.equal(result.reason,'rule');assert.equal(result.matchedRuleId,'typed');
  assert.equal(decideNewMaterialMarking(config([{id:'prefix',action:'set-external',when:{folderSegments:['inbox-old']}}]),value).action,'leave-absent');
  assert.equal(decideNewMaterialMarking(config([{id:'wrong-type',action:'set-external',when:{properties:[{key:'amount',valueType:'string',value:'7',operator:'eq'}]}}]),value).action,'leave-absent');
});
test('POLICY.2a consumes the bundled browser worker proof for synthetic original bytes',async()=>{
  const {WorkerMarkdownParser}=await import('../plugin/src/standalone/worker');
  const {syntheticNodeWorkerPort}=await import('./helpers/browser-worker-port');
  const {join}=await import('node:path');
  const sourceId='inbox/worker.md',bytes=raw('type: invoice\ntags: ["finance"]'),sha=hash(bytes);
  const worker=new WorkerMarkdownParser(join(process.cwd(),'.test-build','standalone-worker.js'),syntheticNodeWorkerPort);
  try {
    const proof=await worker.policyMetadata(sourceId,bytes,root);
    const result=decideNewMaterialMarking(config([{id:'worker',action:'set-external',when:{type:'invoice',tags:['finance']}}]),
      {sourceId,sha256:sha,rootId:root,proof,lifecycle:{state:'verified-new',sourceId,sha256:sha,rootId:root},provenance:null});
    assert.equal(result.action,'set-external');assert.deepEqual(proof.properties,[
      {key:'type',valueType:'string',value:'invoice'},{key:'tags',valueType:'list',value:['finance']}]);
  } finally { await worker.close(); }
});
test('POLICY.2a validates every rule and resolves private precedence before ordered external matches',()=>{
  const value=input();
  const c=config([
    {id:'first-external',action:'set-external',when:{folderSegments:['inbox']}},
    {id:'later-private',action:'set-private',when:{folderSegments:['project']}},
  ],'set-external');
  const result=decideNewMaterialMarking(c,value);assert.equal(result.action,'set-private');assert.equal(result.matchedRuleId,'later-private');
  assert.equal(decideNewMaterialMarking(config([
    {id:'missing-external',action:'set-external',when:{type:'invoice'}},
    {id:'confirmed-private',action:'set-private',when:{folderSegments:['project']}},
  ]),value).matchedRuleId,'confirmed-private');
  const invalid=config([{id:'valid',action:'set-external',when:{folderSegments:['inbox']}},{id:'bad',action:'set-external',when:{unknown:'x'}}] as unknown[],'set-external');
  assert.equal(decideNewMaterialMarking(invalid,value).reason,'invalid-config');
  assert.equal(decideNewMaterialMarking(config([{id:'missing',action:'set-external',when:{type:'invoice'}}],'set-external'),value).reason,'required-input-unresolved');
});
test('POLICY.2a accepts import channel only from matching verified provenance',()=>{
  const value=input();const c=config([{id:'channel',action:'set-external',when:{importChannel:'scanner'}}],'set-private');
  assert.equal(decideNewMaterialMarking(c,value).reason,'required-input-unresolved');
  const trusted={channelId:'scanner',digest:hash('trusted'),sourceId:value.sourceId,sha256:value.sha256,rootId:root};
  assert.equal(decideNewMaterialMarking(c,{...value,provenance:trusted}).action,'set-external');
  assert.equal(decideNewMaterialMarking(c,{...value,provenance:{...trusted,sourceId:'other.md'}}).reason,'provenance-unresolved');
});
test('POLICY.2a preserves explicit private, distinguishes existing and unresolved lifecycles, and binds versions',()=>{
  const privateValue=input('inbox/private.md',raw('llm_processing: private'));
  assert.equal(decideNewMaterialMarking(config([], 'set-external'),privateValue).reason,'explicit-private');
  const existing=input();assert.equal(decideNewMaterialMarking(config([], 'set-external'),{...existing,lifecycle:{...existing.lifecycle,state:'existing'}}).reason,'existing-material');
  assert.equal(decideNewMaterialMarking(config([], 'set-external'),{...existing,lifecycle:{...existing.lifecycle,sha256:hash('other')}}).reason,'lifecycle-unresolved');
  assert.equal(decideNewMaterialMarking(config([], 'set-external'),{...existing,proof:{...existing.proof,sha256:hash('other')}}).reason,'source-mismatch');
  assert.equal(decideNewMaterialMarking(config([], 'set-external'),input('inbox/malformed.md',Buffer.from('---\nllm_processing: external'))).reason,'metadata-unresolved');
});
test('POLICY.2a revision and decisions are stable, immutable, and make no outbound or write call',()=>{
  const value=input();const c=config([{id:'a',action:'set-external',when:{folderSegments:['inbox']}}]);
  const one=decideNewMaterialMarking(c,value),two=decideNewMaterialMarking(structuredClone(c),structuredClone(value));
  assert.equal(one.ruleRevision,two.ruleRevision);assert.deepEqual(one,two);assert.ok(Object.isFrozen(one));assert.throws(()=>{(one as {action:string}).action='set-private';});
  assert.equal(one.complete,true);assert.equal(one.externalBlocked,true);
});

test('POLICY.2a explicit external cannot bypass private rules or unresolved inputs; dry run is not consent',()=>{
  const value=input('inbox/new.md',raw('llm_processing: external'));
  const rules=config([{id:'private',action:'set-private',when:{folderSegments:['inbox']}}]);
  assert.equal(decideNewMaterialMarking(rules,value).action,'set-private');
  assert.equal(decideNewMaterialMarking(rules,value).externalBlocked,true);
  assert.equal(decideNewMaterialMarking(config([{id:'unknown',action:'set-private',when:{importChannel:'trusted'}}]),value).complete,false);
  assert.equal(decideNewMaterialMarking(config(),value).externalBlocked,false);
  const absent=input();assert.equal(decideNewMaterialMarking(config(),absent).externalBlocked,false);
  assert.equal(decideNewMaterialMarking(config([], 'set-external'),absent).externalBlocked,true);
  assert.equal(decideNewMaterialMarking(config(),{...value,proof:{...value.proof,state:'absent'}}).externalBlocked,true);
  assert.equal(decideNewMaterialMarking(config(),{...value,proof:{...value.proof,state:'absent'}}).complete,false);
});
test('POLICY.2a invalid rule shape, oversized values, missing input and spoofed channel fail closed',()=>{
  const value=input('inbox/new.md',raw('importChannel: trusted'));
  assert.equal(decideNewMaterialMarking(config([{id:'channel',action:'set-external',when:{importChannel:'trusted'}}]),value).complete,false);
  for(const when of [{folderSegments:['inbox/project']},{properties:[{key:'x',valueType:'string',value:'x'.repeat(4097),operator:'eq'}]},
    {properties:[{key:'x',valueType:'number',value:-0,operator:'eq'}]},{properties:[{key:'x',valueType:'string',value:'a',operator:'eq',extra:true}]}]){
    const result=decideNewMaterialMarking(config([{id:'invalid',action:'set-external',when}]),value);
    assert.equal(result.reason,'invalid-config');assert.equal(result.externalBlocked,true);
  }
});
