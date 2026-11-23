/** 05D pure ranking/contract tests. Artificial unit vectors below are NEVER model acceptance. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonical, sha, type IngestResponse} from '../plugin/src/advanced/protocol';
import {rankAdvanced,rrf,validateAdvancedQuery} from '../plugin/src/advanced/retrieval';
import {validateRetrievalGeneration,generationDigest, type IndexedSource,
  type RetrievalGeneration} from '../plugin/src/advanced/retrieval-storage';
import {parseModelFrame,modelRequest,verifyVector,verifyIdentity,ModelError,
  CHUNK_TOKENIZER_FINGERPRINT, type ModelIdentity, type ModelRequest} from '../plugin/src/advanced/model-protocol';
import {readFileSync as fsRead} from 'node:fs';
const fixtures=JSON.parse(fsRead('contracts/fixtures/advanced-ingestion-v1.json','utf8')) as {cases:{response:IngestResponse}[]};
const source=structuredClone(fixtures.cases[0]!.response);
const modelData=JSON.parse(readFileSync('benchmarks/embedding/results.json','utf8'));
const id:ModelIdentity={...modelData.identity,effective_max_tokens:384,
  runtime_tokenizer_parity_verified:true};
const vector=(x=0)=>Array.from({length:1024},(_,i)=>i===x?1:0);
const build=(responses:IngestResponse[]= [source]):RetrievalGeneration=>{
  const entries:IndexedSource[]=responses.map(d=>({sourcePath:d.source!.sourceId,
    sourceSha256:d.source!.sha256,ingestGenerationId:d.generationId!,profileId:d.source!.profileId,
    tokenizerFingerprint:CHUNK_TOKENIZER_FINGERPRINT,
    chunkIds:d.chunks.map(c=>c.chunkId),vectors:d.chunks.map((_,i)=>vector(i))}));
  const base={schemaVersion:1 as const,rootId:responses[0]!.source!.scopeId,model:id,
    entries:entries.sort((a,b)=>a.sourcePath.localeCompare(b.sourcePath))};
  return {...base,generationId:generationDigest(base)};
};
const docs=[{response:source}];
const req=(mode:'lexical'|'dense'|'hybrid',query='REQ-X-1')=>({query,requestedMode:mode,limit:10});

test('real v3 source/chunk reuse: exact technical ID, typed Properties, Unicode and source locators',()=>{
  const lex=rankAdvanced({documents:docs,generation:null,queryVector:null,request:req('lexical')});
  assert.equal(lex.status,'ok');assert.equal(lex.executedMode,'lexical');
  assert.equal(lex.legs.lexical.status,'ready');assert.ok(lex.hits.length>0);
  assert.match(lex.hits[0]!.originalExcerpt,/REQ-X-1/);
  assert.equal(lex.hits[0]!.sourceSha256,source.source!.sha256);
  assert.equal(lex.hits[0]!.sourceLocators[0]!.locatorKind,'markdown');
  assert.equal(lex.hits[0]!.denseRank,null);
  const filtered=rankAdvanced({documents:docs,generation:null,queryVector:null,
    request:{...req('lexical'),predicates:[{key:'active',valueType:'boolean',value:true,operator:'eq'}]}});
  assert.ok(filtered.hits.length>0);
});

test('strict typed mismatch, scope denial and absent hits, without fabricated excerpt',()=>{
  assert.throws(()=>rankAdvanced({documents:docs,generation:null,queryVector:null,
    request:{...req('lexical'),predicates:[{key:'active',valueType:'boolean',value:1,operator:'eq'}] as never}}));
  const scope=rankAdvanced({documents:docs,generation:null,queryVector:null,
    request:{...req('lexical'),scope:['not-indexed.md']}});
  assert.equal(scope.status,'ok');assert.equal(scope.hits.length,0);
  const neg=rankAdvanced({documents:docs,generation:null,queryVector:null,
    request:req('lexical','NOT-FOUND-404')});
  assert.equal(neg.status,'ok');assert.equal(neg.hits.length,0);
  const partial=rankAdvanced({documents:docs,generation:null,queryVector:null,
    request:req('lexical'),staleCount:1});
  assert.equal(partial.status,'degraded');assert.equal(partial.staleSourceCount,1);
});

test('missing BGE-M3 leg: dense and hybrid fail closed without lexical fallback',()=>{
  for(const mode of ['dense','hybrid'] as const){
    const response=rankAdvanced({documents:docs,generation:null,queryVector:null,request:req(mode)});
    assert.equal(response.status,'failed');assert.equal(response.executedMode,'none');
    assert.equal(response.error,'CAPABILITY_UNAVAILABLE');assert.deepEqual(response.hits,[]);
  }
});

test('pinned generation, normalized vectors, all three deterministic modes and RRF ties',()=>{
  verifyIdentity(id);
  const gen=build();validateRetrievalGeneration(gen,source.source!.scopeId);
  const query=vector(2);
  const dense=rankAdvanced({documents:docs,generation:gen,queryVector:query,request:req('dense')});
  const hybrid=rankAdvanced({documents:docs,generation:gen,queryVector:query,request:req('hybrid')});
  assert.equal(dense.status,'ok');assert.equal(dense.executedMode,'dense');
  assert.equal(hybrid.status,'ok');assert.equal(hybrid.executedMode,'hybrid');
  assert.equal(hybrid.legs.lexical.status,'ready');assert.equal(hybrid.legs.dense.status,'ready');
  assert.ok(hybrid.hits.some(h=>h.lexicalRank!==null&&h.denseRank!==null));
  assert.deepEqual(hybrid,rankAdvanced({documents:docs,generation:gen,queryVector:query,
    request:req('hybrid')}));
  assert.equal(hybrid.hits[0]!.indexGenerationId,gen.generationId);
  assert.deepEqual(rrf(['b','a'],['a','c']),[
    {key:'a',lexicalRank:2,denseRank:1,score:1/62+1/61},
    {key:'b',lexicalRank:1,denseRank:null,score:1/61},
    {key:'c',lexicalRank:null,denseRank:2,score:1/62}]);
  assert.throws(()=>rrf(['x','x'],[]));
});

test('incompatible generation/source, forged vectors and corrupt manifests are rejected',()=>{
  const gen=build();
  const changed=structuredClone(source);changed.source!.sha256='f'.repeat(64);
  const incompatible=rankAdvanced({documents:[{response:changed}],generation:gen,
    queryVector:vector(0),request:req('hybrid')});
  assert.equal(incompatible.error,'INDEX_INCOMPATIBLE');assert.equal(incompatible.executedMode,'none');
  assert.throws(()=>verifyVector(new Array(1024).fill(NaN)));
  assert.throws(()=>verifyVector(new Array(512).fill(0)));
  assert.throws(()=>verifyIdentity({...id,weights_sha256:'f'.repeat(64)}));
  assert.throws(()=>validateRetrievalGeneration({...gen,generationId:'a'.repeat(64)},source.source!.scopeId));
  assert.throws(()=>validateRetrievalGeneration({...gen,entries:[{...gen.entries[0]!,
    vectors:[...[vector(0)],NaN] as never}]},source.source!.scopeId));
});

test('v4 model envelope rejects forged identity, dimensions and mismatched request IDs',()=>{
  const request:ModelRequest={protocolVersion:4,requestId:'a'.repeat(48),operation:'embed',
    deadlineUnixMs:1000,modelSnapshot:'/trusted/snapshot',maxTokens:384,texts:['Русский текст']};
  assert.ok(modelRequest(request).length>0);
  const frame=(value:unknown)=>Buffer.from(canonical(value)+'\n');
  const ok={protocolVersion:4,requestId:request.requestId,operation:'embed',status:'ok',
    error:null,identity:id,vectors:[vector(3)],diagnostics:[]};
  assert.deepEqual(parseModelFrame(frame(ok),request).vectors,[vector(3)]);
  const failed={...ok,status:'failed',error:'MODEL_UNAVAILABLE',identity:null,vectors:[]};
  assert.equal(parseModelFrame(frame(failed),request).status,'failed');
  for(const bad of [{...ok,identity:{...id,revision:'other'}},
    {...ok,vectors:[[...vector(0).slice(0,-1)]]},{...ok,requestId:'b'.repeat(48)},
    {...ok,status:'ok',error:'MODEL_UNAVAILABLE'}])
    assert.throws(()=>parseModelFrame(frame(bad),request));
  assert.throws(()=>modelRequest({...request,maxTokens:513}));
  assert.throws(()=>modelRequest({...request,texts:[]}));
  assert.throws(()=>modelRequest({...request,modelSnapshot:'/tmp/../unsafe'}));
});
