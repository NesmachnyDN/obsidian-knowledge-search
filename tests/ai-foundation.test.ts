import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, parseSettings } from '../plugin/src/search/settings';
import { parsePreference, preferenceStatus, validOrigin } from '../plugin/src/ai/config';
import { configDigest, projectDisclosure, type Candidate, type DisclosureGrant } from '../plugin/src/ai/disclosure';
import { type ProviderConfig } from '../plugin/src/ai/contracts';
import { hash } from '../plugin/src/standalone/contracts';

const config: ProviderConfig = {state:'configured', transport:'local', origin:'http://127.0.0.1:8765',
  identity:{model:'synthetic-reranker',revision:'v1'},
  limits:{timeoutMs:1000,maxInputBytes:128,maxCandidates:2,maxOutputTokens:32,maxConcurrent:1}};
const scope = hash('synthetic-scope');
const query = {text:'REQ-01',classification:'synthetic' as const};
const candidate: Candidate = {text:'REQ-01: sample',classification:'synthetic',sourceId:'private-id',sourceSha256:hash('source')};
const grant: DisclosureGrant = {version:1,role:'reranking',configDigest:configDigest('reranking',config),
  scopeId:scope,expiresUnixMs:2000,queryDigest:hash(query.text),queryClassification:'synthetic',
  sources:[{sourceId:candidate.sourceId,sourceSha256:candidate.sourceSha256,
    excerptDigest:hash(candidate.text),classification:'synthetic'}]};
const signal = new AbortController().signal;
test('settings v4 migration and isolated role validation preserve Standalone', () => {
  const {ai:_, ...old}=defaultSettings();
  const migrated = parseSettings({...old,version:4});
  assert.deepEqual(migrated.ai, defaultSettings().ai);
  assert.equal(migrated.enabled,true);
  const mixed=parseSettings({...defaultSettings(),ai:{embedding:{state:'configured',secret:'never-persist'},
    reranking:config,generation:{state:'disabled'}}});
  assert.equal(mixed.enabled,true);
  assert.equal(mixed.ai.embedding.state,'invalid');
  assert.deepEqual(mixed.ai.reranking,config);
  assert.equal(mixed.ai.generation.state,'disabled');
  assert.equal(preferenceStatus('reranking',mixed.ai.reranking).error,'NOT_READY');
  assert.equal(preferenceStatus('embedding',mixed.ai.embedding).error,'CONFIG_INVALID');
  assert.ok(!JSON.stringify(mixed).includes('never-persist'));
  assert.equal(parseSettings({...defaultSettings(),ai:null}).enabled,true);
});
test('origin-only canonical endpoints and exact bounded non-secret fields', () => {
  for(const origin of ['http://localhost:8765','http://127.1:8765','http://127.0.0.1:8765/',
    'http://user:pass@127.0.0.1:8765','http://127.0.0.1:8765?token=x','http://192.168.0.1:8765',
    'http://127.0.0.1:8765#x','http://127.0.0.1:8765/v1'])
    assert.equal(validOrigin(origin,'local'),false,origin);
  assert.equal(validOrigin('http://[::1]:8765','local'),true);
  assert.equal(validOrigin('https://api.example.com','cloud'),true);
  for(const origin of ['http://api.example.com','https://127.0.0.1','https://api.example.com:8443','https://a.internal'])
    assert.equal(validOrigin(origin,'cloud'),false,origin);
  for(const invalid of [{...config,apiKey:'secret'},{...config,limits:{...config.limits,maxConcurrent:2}},
    {...config,identity:{...config.identity,revision:''}},{...config,limits:{...config.limits,timeoutMs:999999}}])
    assert.equal(parsePreference(invalid).state,'invalid');
});
test('exact role, model, scope, query, source bytes and classification grant; minimal payload', () => {
  const project=(g:DisclosureGrant|null=grant,c:Candidate[]= [candidate]) =>
    projectDisclosure('reranking',config,scope,query,c,g,signal,1000);
  assert.deepEqual(project(),{query:'REQ-01',passages:[{id:0,text:'REQ-01: sample'}]});
  for(const g of [null,{...grant,role:'generation' as const},{...grant,scopeId:hash('other')},
    {...grant,configDigest:hash('other')},{...grant,queryDigest:hash('other')},
    {...grant,expiresUnixMs:1000},{...grant,expiresUnixMs:999999},{...grant,sources:[]}])
    assert.throws(()=>project(g),{message:'DISCLOSURE_DENIED'});
  for(const c of [{...candidate,classification:'unknown' as const},{...candidate,classification:'confidential' as const},
    {...candidate,sourceSha256:hash('changed')},{...candidate,text:'changed'},{...candidate,sourceId:'other'}])
    assert.throws(()=>project(grant,[c]),{message:'DISCLOSURE_DENIED'});
  assert.throws(()=>project(grant,[candidate,candidate,candidate]),{message:'LIMIT_EXCEEDED'});
  assert.throws(()=>projectDisclosure('embedding',config,scope,query,[candidate],grant,signal,1000),{message:'DISCLOSURE_DENIED'});
  assert.throws(()=>project(grant,[{...candidate,text:'x'.repeat(129)}]),{message:'LIMIT_EXCEEDED'});
  assert.throws(()=>project(grant,[{...candidate,text:'\ud800'}]),{message:'LIMIT_EXCEEDED'});
  assert.throws(()=>projectDisclosure('reranking',config,scope,{...query,classification:'unknown'},
    [candidate],grant,signal,1000),{message:'DISCLOSURE_DENIED'});
  assert.throws(()=>projectDisclosure('reranking',config,scope,{...query,text:'x'.repeat(129)},
    [candidate],grant,signal,1000),{message:'LIMIT_EXCEEDED'});
  const abort=new AbortController();abort.abort();
  assert.throws(()=>projectDisclosure('reranking',config,scope,query,[candidate],grant,abort.signal,1000),{message:'CANCELLED'});
});
