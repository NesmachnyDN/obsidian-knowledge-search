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
  assert.deepEqual(plan.expanded.map(c=>[c.sourceId,c.path.length]),[['b.md',1],['c.md',1],['d.md',2]]);
  const d=plan.expanded[2]!;
  assert.deepEqual(d.path.map(p=>[p.edge.from,p.edge.to,p.traversal]),[['a.md','b.md','forward'],['b.md','d.md','forward']]);
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
  assert.deepEqual(plan.expanded.map(c=>[c.sourceId,c.seedLexicalRank]),[['b.md',1],['c.md',1]]);
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
