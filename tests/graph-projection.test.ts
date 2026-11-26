import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOUNDS, hash, makeGeneration } from '../plugin/src/standalone/contracts';
import { parseMarkdown } from '../plugin/src/standalone/markdown';
import { deriveGraphProjection, validateGraphMapping, graphMappingId, type GraphProjection } from '../plugin/src/standalone/graph-projection';

const root = hash('graph-root');
const doc = (path:string, raw:string) => parseMarkdown(path, Buffer.from(raw), root);
const generation = (docs: ReturnType<typeof doc>[]) => makeGeneration(root, docs);
const mapping = { schemaVersion:'oks-06b-mapping-v1', cardTypeKey:'kind', businessIdKey:'id', aliasKeys:['aliases'], statusKey:'status', statusValues:['draft'], rules:[
  {relationId:'depends-on',propertyKey:'depends',direction:'author-to-target',targetEncoding:'business-id',sourceTypes:['card'],targetTypes:['card']},
  {relationId:'path-link',propertyKey:'path',direction:'target-to-author',targetEncoding:'path'},
] } as const;
const card = (id:string, extra='') => '---\nkind: card\nid: '+id+'\n'+extra+'---\n';
const projection = async (docs:ReturnType<typeof doc>[], config:unknown=mapping):Promise<GraphProjection> => {
  const r = await deriveGraphProjection(generation(docs),config);
  assert.ok(!('code' in r),JSON.stringify(r)); return r;
};

test('06B.2a exact typed directions, source-version anchors and author-declared status', async () => {
  const a = doc('a.md',card('A','status: draft\ndepends:\n  - B\n  - C\npath: c.md\n')+'[[b|Beta]]\n[[c#fragment]] ![[c]] `[[c]]`\n');
  const b = doc('b.md',card('B')), c = doc('c.md',card('C','status: truth\n'));
  const r = await projection([c,a,b]);
  assert.deepEqual(r.edges.filter(e=>e.kind==='relation').map(e=>[e.relationId,e.from,e.to,e.anchors.map(a=>a.locator.lineStart)]).sort(), [
    ['depends-on','a.md','b.md',[5,6]],['depends-on','a.md','c.md',[5,7]],['path-link','c.md','a.md',[8]],
  ].sort());
  assert.equal(r.edges.filter(e=>e.kind==='navigation').length,1);
  assert.equal(r.edges.find(e=>e.kind==='navigation')!.to,'b.md');
  for (const e of r.edges) {
    assert.equal(e.author,'a.md'); assert.equal(e.authorSha256,a.sha256);
    assert.equal(e.status.declared,'draft'); assert.equal(e.status.truth,'unverified');
    for (const anchor of e.anchors) {
      const block = a.blocks[anchor.locator.blockOrder]!;
      assert.equal(anchor.blockId,block.blockId);
      assert.deepEqual(anchor.locator,block.locator);
      assert.equal(anchor.sourceSha256,a.sha256);
    }
  }
  assert.equal(r.nodes.find(n=>n.sourceId==='c.md')!.declaredStatus,null);
  assert.ok(r.coverage['unsupported-navigation-markup']);
  assert.ok(!JSON.stringify(r).includes('originalText'));
  assert.ok(Object.isFrozen(r.edges[0]!.anchors[0]!.locator));
  assert.ok(!Object.isFrozen(a.blocks[0]!.locator));
});

test('06B.2a validates exact mapping shapes, typed keys, canonical order and limits', () => {
  const one=validateGraphMapping(mapping), two=validateGraphMapping({...mapping,rules:[...mapping.rules].reverse()});
  assert.ok(!('code' in one)&&!('code' in two)); assert.equal(graphMappingId(one),graphMappingId(two));
  const rejects = [
    {...mapping,extra:true},
    {...mapping,rules:[{...mapping.rules[0],direction:['author-to-target']}]},
    {...mapping,rules:[{...mapping.rules[0],propertyKey:'a: invalid'}]},
    {...mapping,rules:[{...mapping.rules[0],targetEncoding:'id'}]},
    {...mapping,rules:[mapping.rules[0],mapping.rules[0]]},
    {...mapping,rules:Array.from({length:33},(_,i)=>({...mapping.rules[0],relationId:String(i)}))},
    {...mapping,cardTypeKey:undefined},
    {...mapping,statusKey:undefined},
    {...mapping,statusValues:Array.from({length:65},(_,i)=>String(i))},
    {...mapping,rules:[{...mapping.rules[0],sourceTypes:Array.from({length:64},(_,i)=>String(i)),targetTypes:['extra']}]},
    {...mapping,rules:Array.from({length:32},(_,i)=>({...mapping.rules[0],relationId:String(i),sourceTypes:Array.from({length:16},(_,j)=>String(j).padStart(128,'x'))}))},
  ];
  for (const invalid of rejects) assert.deepEqual(validateGraphMapping(invalid),{code:'GRAPH_MAPPING_INVALID'});
  assert.ok(Object.isFrozen(one.rules[0]!.sourceTypes));
});

test('06B.2a identity ambiguity includes aliases and basename collisions across complete catalog', async () => {
  const a=doc('a.md',card('A','depends: B\n')+'[[b]]\n'), b=doc('b.md',card('B'));
  const c=doc('other/b.md',card('C','aliases: B\n'));
  const collision=await projection([a,b,c]);
  assert.equal(collision.edges.length,0);
  assert.equal(collision.coverage['ambiguous-target'],2);
  const clean=await projection([a,b]);
  assert.equal(clean.edges.length,2);
  assert.notEqual(clean.projectionId,collision.projectionId);
  const moved=await projection([a,doc('moved.md',card('B'))]);
  assert.equal(moved.edges.length,1);
  assert.equal(moved.edges[0]!.to,'moved.md');
  assert.equal(moved.coverage['unresolved-target'],1);
  const repeated=await projection([a,doc('b.md',card('B','aliases: ["B","B"]\n'))]);
  assert.equal(repeated.edges.length,2);
});

test('06B.2a malformed identity catalog fails closed, exact path only, mixed values no partial rule', async () => {
  const b=doc('b.md',card('B'));
  const a=doc('a.md',card('A','depends: ["B",7]\npath: ["b.md","../b.md"]\n'));
  const r=await projection([a,b]);
  assert.equal(r.edges.length,0);
  assert.equal(r.coverage['unsupported-property'],1);
  assert.equal(r.coverage['unsupported-property-target'],1);
  const malformed=doc('malformed.md','---\nid: B\nid: C\n---\n');
  const incomplete=await projection([doc('a.md',card('A','depends: B\npath: b.md\n')+'[[b]]\n'),b,malformed]);
  assert.equal(incomplete.edges.length,1);
  assert.equal(incomplete.edges[0]!.relationId,'path-link');
  assert.equal(incomplete.coverage['incomplete-target-resolution'],2);
  const unsuffixed=await projection([doc('a.md',card('A','path: b\n')),b]);
  assert.equal(unsuffixed.edges.length,0);
  assert.equal(unsuffixed.coverage['unsupported-property-target'],1);
});

test('06B.2a reverse rule constraints apply to directed source/target and list-item anchor includes key', async () => {
  const a=doc('a.md','---\nkind: consumer\nid: A\npath:\n  - b.md\n---\n');
  const b=doc('b.md','---\nkind: supplier\nid: B\n---\n');
  const r=await projection([a,b],{...mapping,rules:[{...mapping.rules[1],sourceTypes:['supplier'],targetTypes:['consumer']}]});
  assert.equal(r.edges.length,1);
  assert.equal(r.edges[0]!.from,'b.md'); assert.equal(r.edges[0]!.to,'a.md');
  assert.deepEqual(r.edges[0]!.anchors.map(x=>x.locator.lineStart),[4,5]);
  const wrong=await projection([a,b],{...mapping,rules:[{...mapping.rules[1],sourceTypes:['consumer']}]});
  assert.equal(wrong.edges.length,0);
  assert.equal(wrong.coverage['target-type-rejected'],1);
});

test('06B.2a wiki resolution rejects unsafe targets, embeds, escapes, fragments and ambiguous literal markup', async () => {
  const b=doc('b.md',card('B','aliases: ["https://external","../b","b alias"]\n'));
  const a=doc('a.md',card('A')+'[[b alias|Display]]\n![[b]] \\[[b]] [[b#section]] [[../b]] [[https://external]]\n```md\n[[b]]\n```\n`[[b]]`\n');
  const r=await projection([a,b]);
  assert.equal(r.edges.length,1); assert.equal(r.edges[0]!.kind,'navigation'); assert.equal(r.edges[0]!.to,'b.md');
  assert.equal(r.coverage['unsupported-link'],5);
  for (const raw of ['<!--\n[[b]]\n-->\n','%%\n[[b]]\n%%\n','    [[b]]\n','> ```\n[[b]]\n','`open\n[[b]]\n','- ```\n[[b]]\n']) {
    const excluded=await projection([doc('a.md',card('A')+raw),b]);
    assert.equal(excluded.edges.length,0);
    assert.ok(excluded.coverage['unsupported-navigation-document']);
  }
});

test('06B.2a deterministic generation/mapping identity and fail closed on forged generation', async () => {
  const a=doc('a.md',card('A','depends: B\n')), b=doc('b.md',card('B'));
  const one=await projection([a,b]),two=await projection([b,a],{...mapping,rules:[...mapping.rules].reverse()});
  assert.equal(one.projectionId,two.projectionId);
  assert.notEqual(one.projectionId,(await projection([a,b],{...mapping,statusValues:['confirmed']})).projectionId);
  assert.deepEqual(await deriveGraphProjection({...generation([a,b]),generationId:hash('forged')},mapping),{code:'GRAPH_GENERATION_INVALID'});
  assert.deepEqual(await deriveGraphProjection(generation([a,a]),mapping),{code:'GRAPH_GENERATION_INVALID'});
});

test('06B.2a cooperative cancellation includes zero-edge workload, edge/size caps do not truncate', async () => {
  assert.deepEqual(await deriveGraphProjection(generation([]),mapping,{cancelled:()=>true}),{code:'GRAPH_CANCELLED'});
  const body=Array.from({length:512},(_,i)=>'plain '+i).join('\n');
  let stopped=false, yields=0;
  const cancelled=await deriveGraphProjection(generation([doc('a.md',body)]),mapping,{
    cancelled:()=>stopped,yieldJob:async()=>{yields++; await new Promise<void>(r=>setTimeout(r,0)); stopped=true;}
  });
  assert.deepEqual(cancelled,{code:'GRAPH_CANCELLED'}); assert.equal(yields,1);
  const many=Array.from({length:40},(_,i)=>doc('source-'+i+'.md',Array.from({length:256},()=> '[[b]]').join('\n')));
  assert.deepEqual(await deriveGraphProjection(generation([...many,doc('b.md','body')]),mapping,{yieldJob:async()=>{}}),{code:'GRAPH_LIMIT'});
  assert.ok(BOUNDS.sources>=many.length);
});

test('06B.2a unquoted multiline dates and inconsistent typed metadata do not become identities or relations', async () => {
  const b=doc('b.md',card('"2026-01-01"'));
  const invalid=await projection([doc('a.md',card('A','depends:\n  - 2026-01-01\n')),b]);
  assert.equal(invalid.edges.length,0); assert.equal(invalid.coverage['unsupported-property'],1);
  const valid=await projection([doc('a.md',card('A','depends:\n  - "2026-01-01"\n')),b]);
  assert.equal(valid.edges.length,1);
  const forged=doc('a.md',card('A','depends: B\n'));
  forged.properties.find(p=>p.key==='depends')!.value='2026-01-01';
  const inconsistent=await projection([forged,b]);
  assert.equal(inconsistent.edges.length,0); assert.equal(inconsistent.coverage['malformed-properties'],1);
});
