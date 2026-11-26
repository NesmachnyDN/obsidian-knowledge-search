import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hash,makeGeneration,type EvidenceHit} from '../plugin/src/standalone/contracts';
import {parseMarkdown} from '../plugin/src/standalone/markdown';
import {validateGraphMapping,type GraphMapping} from '../plugin/src/standalone/graph-mapping';
import {deriveGraphProjection} from '../plugin/src/standalone/graph-projection';
import {scopeGraph} from '../plugin/src/standalone/graph-lifecycle';
import {parseGraphQuery,planGraphExpansion,type GraphQuery} from '../plugin/src/standalone/graph-expansion';
const root=hash('graph-expansion-fixture');
const raw=(id:string,extra='',body='Synthetic architecture source.')=>'---\nid: '+id+'\n'+extra+'---\n'+body+'\n';
const mapping=validateGraphMapping({schemaVersion:'oks-06b-mapping-v1',businessIdKey:'id',rules:[
  {relationId:'depends',propertyKey:'depends',direction:'author-to-target',targetEncoding:'business-id'},
  {relationId:'implements',propertyKey:'implements',direction:'author-to-target',targetEncoding:'business-id'},
  {relationId:'supplies',propertyKey:'supplier',direction:'target-to-author',targetEncoding:'business-id'}
]}) as GraphMapping;
const request=(overrides:Record<string,unknown>={},expansion:Record<string,unknown>={}):GraphQuery=>parseGraphQuery({
  requestId:'synthetic-graph',query:'REQ-FIXTURE',limit:10,matchMode:'terms',scope:{mode:'vault-wide'},
  expansion:{depth:2,direction:'outgoing',fanOut:16,maxExpanded:32,...expansion},...overrides
});
async function fixture(files:Record<string,string>,q=request()){
  const docs=Object.entries(files).map(([path,text])=>parseMarkdown(path,Buffer.from(text),root));
  const gen=makeGeneration(root,docs),projection=await deriveGraphProjection(gen,mapping);
  assert.ok(!('code' in projection));
  const graph=scopeGraph(gen,mapping,projection,q.scope);
  const seed=(sourceId:string,rank=1):EvidenceHit=>{
    const doc=gen.documents.find(d=>d.sourceId===sourceId)!;
    const block=doc.blocks.find(b=>b.originalText.startsWith('Synthetic architecture'))!;
    return {sourceId,sourceSha256:doc.sha256,originalExcerpt:block.originalText,sourceLocators:[{...block.locator}],
      rank,lexicalRank:rank,retrievalMode:'lexical',indexGenerationId:gen.generationId,score:1,
      headings:[],wikiLinks:[],properties:structuredClone(doc.properties)};
  };
  return {graph,seed};
}
const base={
  'a.md':raw('A','depends: ["C","B","B"]\nimplements: E\n','Synthetic architecture source. [[f]]'),
  'b.md':raw('B','depends: D\n'), 'c.md':raw('C','depends: D\n'),
  'd.md':raw('D','depends: A\n'), 'e.md':raw('E'), 'f.md':raw('F'),
  'g.md':raw('G','supplier: A\n'),
};
test('06B.3a explicit strict requests, canonical relation IDs and no editor-range expansion',()=>{
  const good=request({}, {relationIds:['implements','depends']});
  assert.deepEqual(good.expansion.relationIds,['depends','implements']);
  assert.ok(Object.isFrozen(good.expansion.relationIds));
  for(const e of [{depth:3},{depth:1.5},{depth:'1'},{direction:'implicit'},{fanOut:0},{fanOut:17},{maxExpanded:33},
    {relationIds:[]},{relationIds:['depends','depends']},{relationIds:[1]},{extra:true}]){
    assert.throws(()=>request({},e),/GRAPH_REQUEST_INVALID/);
  }
  for(const o of [{query:''},{query:' '},{query:'x'.repeat(513)},{limit:0},{limit:51},{unknown:true},{scope:{mode:'vault-wide',extra:true}}]){
    assert.throws(()=>request(o),/GRAPH_REQUEST_INVALID/);
  }
  assert.throws(()=>request({scope:{mode:'selected',kind:'editor-selection',range:{sourceId:'a.md',sourceSha256:hash('a'),
    byteStart:0,byteEnd:1,charStart:0,charEnd:1}}}),/GRAPH_SCOPE_UNSUPPORTED/);
});
test('06B.3a deterministic directed shortest paths, duplicate edges, cycles and navigation exclusion',async()=>{
  const q=request({}, {relationIds:['depends']});
  const {graph,seed}=await fixture(base,q);
  const plan=planGraphExpansion(graph,[seed('a.md')],q,mapping);
  const first=graph.edges.filter(e=>e.from==='a.md'&&e.relationId==='depends').sort((a,b)=>a.edgeId.localeCompare(b.edgeId))[0]!;
  const other=first.to==='b.md'?'c.md':'b.md';
  assert.deepEqual(plan.expanded.map(c=>[c.sourceId,c.path.length]),[[first.to,1],[other,1],['d.md',2]]);
  const d=plan.expanded[2]!;
  assert.deepEqual(d.path.map(p=>[p.edge.from,p.edge.to,p.traversal]),[['a.md',first.to,'forward'],[first.to,'d.md','forward']]);
  assert.equal(d.seedLexicalRank,1);assert.equal(d.seedSourceId,'a.md');
  assert.ok(d.path.every(p=>p.edge.kind==='relation'&&p.edge.anchors.length>0));
  const reversed=structuredClone(graph);Object.assign(reversed,{edges:[...graph.edges].reverse()});
  assert.deepEqual(planGraphExpansion(reversed,[seed('a.md')],q,mapping),plan);
  assert.ok(Object.isFrozen(plan.expanded[0]!.path[0]!.edge.anchors));
  assert.equal(plan.omittedByTopK,0);
});
test('06B.3a incoming/reverse and author direction, multiple lexical seeds retain original ranks',async()=>{
  const q=request({}, {direction:'incoming',relationIds:['depends']});
  const {graph,seed}=await fixture(base,q);
  const plan=planGraphExpansion(graph,[seed('d.md'),seed('a.md',2)],q,mapping);
  assert.deepEqual(plan.expanded.map(c=>[c.sourceId,c.seedLexicalRank]).sort(),[['b.md',1],['c.md',1]]);
  assert.ok(plan.expanded.every(c=>c.path[0]!.traversal==='reverse'));
  const forward=request({}, {depth:1,relationIds:['supplies']});
  const f=planGraphExpansion(graph,[seed('a.md')],forward,mapping);
  assert.equal(f.expanded[0]!.sourceId,'g.md');
  assert.equal(f.expanded[0]!.path[0]!.edge.author,'g.md');
  assert.throws(()=>planGraphExpansion(graph,[seed('a.md')],request({}, {relationIds:['unknown']}),mapping),/GRAPH_REQUEST_INVALID/);
});
test('06B.3a depth zero, explicit Top-K omissions, fan-out and candidate overflow fail closed',async()=>{
  const {graph,seed}=await fixture(base);
  const q=request({limit:2},{relationIds:['depends']});
  const plan=planGraphExpansion(graph,[seed('a.md')],q,mapping);
  assert.equal(plan.expanded.length,3);assert.equal(plan.omittedByTopK,2);assert.equal(plan.lexicalCount,1);
  assert.equal(planGraphExpansion(graph,[seed('a.md')],request({}, {depth:0}),mapping).expanded.length,0);
  assert.throws(()=>planGraphExpansion(graph,[seed('a.md')],request({}, {fanOut:1,relationIds:['depends']}),mapping),/GRAPH_LIMIT/);
  assert.throws(()=>planGraphExpansion(graph,[seed('a.md')],request({}, {maxExpanded:2,relationIds:['depends']}),mapping),/GRAPH_LIMIT/);
  assert.equal(planGraphExpansion(graph,[],q,mapping).expanded.length,0);
  assert.throws(()=>planGraphExpansion(graph,[seed('a.md')],q,mapping,()=>false),/GRAPH_CANCELLED/);
});
test('06B.3a graph plan rejects foreign scopes, seeds, versions and author anchors',async()=>{
  const q=request({scope:{mode:'selected',kind:'files',sourceIds:['a.md','b.md']}});
  const {graph,seed}=await fixture(base,q);
  const p=planGraphExpansion(graph,[seed('a.md')],q,mapping);
  assert.deepEqual(p.expanded.map(c=>c.sourceId),['b.md']);
  assert.ok(!JSON.stringify(p).includes('c.md'));
  assert.throws(()=>planGraphExpansion(graph,[seed('c.md')],q,mapping),/GRAPH_EVIDENCE_INVALID/);
  assert.throws(()=>planGraphExpansion(graph,[seed('a.md')],request(),mapping),/GRAPH_EVIDENCE_INVALID/);
  assert.throws(()=>planGraphExpansion(graph,[{...seed('a.md'),indexGenerationId:hash('foreign')}],q,mapping),/GRAPH_EVIDENCE_INVALID/);
  assert.throws(()=>planGraphExpansion({...graph,mappingId:hash('foreign')},[seed('a.md')],q,mapping),/GRAPH_EVIDENCE_INVALID/);
  const edge=graph.edges[0]!;
  for(const bad of [{...edge,author:'c.md'},{...edge,targetSha256:hash('stale')},
    {...edge,anchors:[{...edge.anchors[0]!,sourceId:'c.md'}]}, {...edge,author:edge.to,authorSha256:edge.targetSha256,
      anchors:[{...edge.anchors[0]!,sourceId:edge.to,sourceSha256:edge.targetSha256,
        locator:{...edge.anchors[0]!.locator,sourceVersion:edge.targetSha256}}]}]){
    assert.throws(()=>planGraphExpansion({...graph,edges:[bad]},[seed('a.md')],q,mapping),/GRAPH_EVIDENCE_INVALID/);
  }
  assert.throws(()=>planGraphExpansion(graph,[{...seed('a.md'),rank:2}],q,mapping),/GRAPH_EVIDENCE_INVALID/);
});

test('06B.3a rejects malformed locator shapes, offsets, source/block lineage and missing status as typed errors',async()=>{
  const q=request(),{graph,seed}=await fixture(base,q);
  const edge=graph.edges[0]!,anchor=edge.anchors[0]!,hit=seed('a.md'),loc=hit.sourceLocators[0]!;
  for(const bad of [null,undefined,{}, {...loc,byteStart:-1},{...loc,byteEnd:loc.byteStart},
    {...loc,lineStart:0},{...loc,lineEnd:loc.lineStart+1},{...loc,blockOrder:999999},{...loc,charEnd:65537},{...loc,extra:true}]){
    assert.throws(()=>planGraphExpansion(graph,[{...hit,sourceLocators:[bad]} as unknown as EvidenceHit],q,mapping),/GRAPH_EVIDENCE_INVALID/);
    const malformed={...edge,anchors:[{...anchor,locator:bad}]};
    assert.throws(()=>planGraphExpansion({...graph,edges:[malformed]} as typeof graph,[hit],q,mapping),/GRAPH_EVIDENCE_INVALID/);
  }
  for(const bad of [{...edge,anchors:undefined},{...edge,anchors:[null]},{...edge,status:undefined},
    {...edge,anchors:[{...anchor,blockId:hash('forged')}]}]){
    assert.throws(()=>planGraphExpansion({...graph,edges:[bad]} as typeof graph,[hit],q,mapping),/GRAPH_EVIDENCE_INVALID/);
  }
  assert.throws(()=>planGraphExpansion(graph,[{...hit,originalExcerpt:hit.originalExcerpt+'x'}],q,mapping),/GRAPH_EVIDENCE_INVALID/);
});
test('06B.3a edge ID, not destination ID, resolves equal-depth paths; seed rank takes precedence',async()=>{
  const q=request({}, {relationIds:['depends']}),{graph,seed}=await fixture(base,q);
  const ids=graph.edges.map((e,i)=>({...e,edgeId:(e.from==='a.md'&&e.to==='c.md'?'1':e.from==='a.md'&&e.to==='b.md'?'e':'f')+i.toString(16).padStart(63,'0')}));
  const altered={...graph,edges:ids};
  const p=planGraphExpansion(altered,[seed('a.md')],q,mapping);
  assert.deepEqual(p.expanded.map(c=>c.sourceId),['c.md','b.md','d.md']);
  assert.equal(p.expanded[2]!.path[0]!.edge.to,'c.md');
  const ranked=planGraphExpansion(altered,[seed('b.md'),seed('c.md',2)],q,mapping);
  assert.equal(ranked.expanded.find(c=>c.sourceId==='d.md')!.seedSourceId,'b.md');
});
test('06B.3a duplicate lexical-source hits do not inflate unique Top-K omission count',async()=>{
  const q=request({limit:4},{relationIds:['depends']}),{graph,seed}=await fixture(base,q);
  const p=planGraphExpansion(graph,[seed('a.md'),seed('a.md',2)],q,mapping);
  assert.equal(p.lexicalHitCount,2);assert.equal(p.lexicalCount,1);
  assert.equal(p.uniqueCandidateCount,4);assert.equal(p.omittedByTopK,0);
  assert.ok(p.expanded.every(c=>c.seedLexicalRank===1));
});
