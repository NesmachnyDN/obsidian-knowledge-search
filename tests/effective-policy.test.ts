import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../plugin/src/standalone/contracts';
import { parsePolicyMetadata } from '../plugin/src/standalone/markdown-parse';
import { decideEffectivePolicy, defaultEffectivePolicyConfig, EFFECTIVE_POLICY_CONFIG_VERSION, type EffectivePolicyInput } from '../plugin/src/ai/effective-policy';

const root=hash('synthetic-effective-root');
const raw=(front='')=>Buffer.from(front?`---\n${front}\n---\n# synthetic`:'# synthetic');
function input(sourceId='arbitrary/project/note.md',bytes=raw(),overrides:Partial<EffectivePolicyInput>={}):EffectivePolicyInput{const sha256=hash(bytes);return {sourceId,sha256,rootId:root,proof:parsePolicyMetadata(sourceId,bytes,root,sha256),origin:null,...overrides};}
const config=(rules:unknown[]=[],verifiedAbsent:'eligible'|'denied'='denied')=>({version:EFFECTIVE_POLICY_CONFIG_VERSION,verifiedAbsent,rules});

test('P0.1 evaluates typed path, property, tag and type rules without lifecycle inputs',()=>{
  const value=input('elsewhere/inbox/a.md',raw('type: invoice\ntags: ["finance"]\namount: 7'));
  const result=decideEffectivePolicy(config([{id:'typed',decision:'eligible',when:{folderSegments:['inbox'],type:'invoice',tags:['finance'],properties:[{key:'amount',valueType:'number',value:7,operator:'eq'}]}}]),value);
  assert.equal(result.decision,'eligible');assert.equal(result.matchedRuleId,'typed');assert.equal(result.reason,'eligible-absent');
  assert.equal(decideEffectivePolicy(config([{id:'wrong',decision:'eligible',when:{properties:[{key:'amount',valueType:'string',value:'7',operator:'eq'}]}}]),value).decision,'denied');
});
test('P0.1 exact metadata states, explicit defaults and restrictive precedence fail closed',()=>{
  assert.deepEqual(defaultEffectivePolicyConfig(),config());
  assert.equal(decideEffectivePolicy(config(),input()).reason,'default-denied');
  assert.equal(decideEffectivePolicy(config([],'eligible'),input()).decision,'eligible');
  assert.equal(decideEffectivePolicy(config(),input('n.md',raw('llm_processing: external'))).decision,'eligible');
  assert.equal(decideEffectivePolicy(config([],'eligible'),input('n.md',raw('llm_processing: private'))).reason,'explicit-private');
  const value=input('inbox/n.md',raw('llm_processing: external'));
  const rules=[{id:'allow',decision:'eligible',when:{folderSegments:['inbox']}},{id:'deny',decision:'denied',when:{folderSegments:['inbox']}}];
  assert.equal(decideEffectivePolicy(config(rules),value).matchedRuleId,'deny');
  assert.equal(decideEffectivePolicy(config(),{...value,proof:{...value.proof,state:'unresolved',properties:[]}}).reason,'metadata-unresolved');
});
test('P0.1 validates current proof, source binding, origins and separate schema',()=>{
  const value=input('inbox/n.md');
  assert.equal(decideEffectivePolicy({version:'oks-policy-2a-rules-v1',defaultAction:'set-external',rules:[]},value).reason,'invalid-config');
  assert.equal(decideEffectivePolicy(config(),{...value,proof:{...value.proof,sha256:hash('other')}}).reason,'source-mismatch');
  const rule=config([{id:'origin',decision:'eligible',when:{origin:'manual'}}]);
  assert.equal(decideEffectivePolicy(rule,value).reason,'required-input-unresolved');
  const origin={originId:'manual',digest:hash('origin'),sourceId:value.sourceId,sha256:value.sha256,rootId:root};
  assert.equal(decideEffectivePolicy(rule,{...value,origin}).decision,'eligible');
  assert.equal(decideEffectivePolicy(rule,{...value,origin:{...origin,sourceId:'other.md'}}).reason,'origin-unresolved');
  assert.equal(decideEffectivePolicy(config([{id:'bad',decision:'eligible',when:{unknown:'x'}}]),value).reason,'invalid-config');
});
test('P0.1 decision and revision are stable, immutable and side-effect free',()=>{
  const value=input();const one=decideEffectivePolicy(config([{id:'a',decision:'eligible',when:{folderSegments:['project']}}]),value),two=decideEffectivePolicy(config([{id:'a',decision:'eligible',when:{folderSegments:['project']}}]),structuredClone(value));
  assert.deepEqual(one,two);assert.ok(Object.isFrozen(one));assert.throws(()=>{(one as {decision:string}).decision='denied';});
});

test('P0.1 rejects malformed and contradictory proofs, including duplicates, changed source and root',()=>{
  const value=input();const allow=config([],'eligible');
  for(const candidate of [input('n.md',Buffer.from('---\nllm_processing: external')),input('n.md',raw('llm_processing: external\nllm_processing: private')),input('n.md',raw('llm_processing: EXTERNAL')),input('n.md',raw('LLM_PROCESSING: private')),{...value,proof:{...value.proof,state:'external'}},{...value,rootId:hash('another-root')},{...value,sourceId:'other.md'}])assert.equal(decideEffectivePolicy(allow,candidate as EffectivePolicyInput).decision,'denied');
  const known=input('n.md',raw('type: invoice'));
  assert.equal(decideEffectivePolicy(config([{id:'origin',decision:'eligible',when:{origin:'manual'}}],'eligible'),known).decision,'denied');
  assert.equal(decideEffectivePolicy(config([{id:'dup',decision:'eligible',when:{type:'invoice'}},{id:'dup',decision:'denied',when:{type:'invoice'}}]),known).decision,'denied');
  assert.equal(decideEffectivePolicy(config([{id:'x',decision:'eligible',when:{type:'invoice'}}]),known).decision,'eligible');
  assert.equal(decideEffectivePolicy(config([{id:'x',decision:'denied',when:{type:'invoice'}}]),known).decision,'denied');
});
