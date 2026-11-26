import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NewMaterialTracker, type LifecycleContext, type BaselineInventory } from '../plugin/src/ai/new-material-tracker';
import { BoundedVaultReader, type DescriptorLifecycleProof } from '../plugin/src/standalone/source';
import { BOUNDS, hash } from '../plugin/src/standalone/contracts';

function context(rootId=hash('root')):LifecycleContext {
  return {rootId,scopeId:hash('scope'),rulesRevision:hash('rules'),host:{},session:{}};
}
function proof(c:LifecycleContext,path:string,version='1',identity=path):DescriptorLifecycleProof {
  return {version:{rootId:c.rootId,sourceId:path,sha256:hash(version),versionId:hash(path+version)},stableIdentity:hash(identity)};
}
function fixture() {
  const c=context(),tracker=new NewMaterialTracker<object>(),owner={},second={};
  assert.equal(tracker.openLifecycle(c),true);
  const a=proof(c,'a.md'),b=proof(c,'b.md');
  const inventory:BaselineInventory<object>={complete:true,candidates:[{owner,proof:a},{owner:second,proof:b}]};
  return {c,tracker,owner,second,a,b,inventory};
}
test('exact baseline is explicit, atomic, order independent, owner-bound and once per epoch',()=>{
  const {c,tracker,owner,second,a,b,inventory}=fixture();
  assert.equal(tracker.lifecycleState(c,owner,a),'unresolved');
  const preview=tracker.previewInitialBaseline(c,inventory,100,100)!;
  assert.ok(preview);
  assert.ok(Object.isFrozen(preview.candidates[0]!.proof.version));
  assert.equal(tracker.confirmInitialBaseline(c,{...preview},inventory,101),false);
  assert.equal(tracker.confirmInitialBaseline(c,preview,{complete:true,candidates:[...inventory.candidates].reverse()},101),true);
  assert.equal(tracker.lifecycleState(c,owner,a),'existing');
  assert.equal(tracker.lifecycleState(c,second,b),'existing');
  assert.equal(tracker.lifecycleState(c,{},a),'unresolved');
  assert.equal(tracker.confirmInitialBaseline(c,preview,inventory,101),false);
  assert.equal(tracker.previewInitialBaseline(c,{complete:true,candidates:[{owner:{},proof:proof(c,'other.md')}]},102,100),null);
  tracker.clear();
  assert.equal(tracker.lifecycleState(c,owner,a),'unresolved');
  assert.equal(tracker.openLifecycle(c),false);
  const restarted=new NewMaterialTracker<object>();
  assert.equal(restarted.openLifecycle(c),true);
  assert.equal(restarted.lifecycleState(c,owner,a),'unresolved');
  assert.equal(restarted.confirmInitialBaseline(c,preview,inventory,101),false);
});
test('baseline denies incomplete, malformed, duplicate, foreign, changed, expired and replayed candidates without partial admission',()=>{
  const {c,tracker,owner,a,inventory}=fixture();
  assert.equal(tracker.previewInitialBaseline(c,{...inventory,complete:false},0,100),null);
  assert.equal(tracker.previewInitialBaseline(c,{complete:true,candidates:[...inventory.candidates,inventory.candidates[0]!] },0,100),null);
  assert.equal(tracker.previewInitialBaseline(c,{complete:true,candidates:[{owner,proof:proof(context(hash('foreign')),'a.md')}]},0,100),null);
  assert.equal(tracker.previewInitialBaseline(c,{complete:true,candidates:[null as never]},0,100),null);
  for(const changed of [
    {context:{...c,scopeId:hash('other scope')},inventory,now:1},
    {context:{...c,host:{}},inventory,now:1},
    {context:{...c,session:{}},inventory,now:1},
    {context:{...c,rulesRevision:hash('other rules')},inventory,now:1},
    {context:c,inventory:{complete:true,candidates:[{owner,proof:proof(c,'a.md','2')},inventory.candidates[1]!]},now:1},
    {context:c,inventory:{complete:true,candidates:[inventory.candidates[0]!]},now:1},
    {context:c,inventory:{complete:true,candidates:[{owner:{},proof:a},inventory.candidates[1]!]},now:1},
    {context:c,inventory,now:100},
    {context:c,inventory,now:-1},
  ]){
    const p=tracker.previewInitialBaseline(c,inventory,0,100)!;
    assert.ok(p);
    assert.equal(tracker.confirmInitialBaseline(changed.context,p,changed.inventory,changed.now),false);
    assert.equal(tracker.confirmInitialBaseline(c,p,inventory,1),false);
    assert.equal(tracker.lifecycleState(c,owner,a),'unresolved');
  }
});
test('rules and native events revoke pending baseline, known new/ambiguous paths cannot enter it',()=>{
  const {c,tracker,owner,a,inventory}=fixture();
  const p=tracker.previewInitialBaseline(c,inventory,0,100)!;
  assert.equal(tracker.reviseRules(c,hash('new rules')),true);
  const next={...c,rulesRevision:hash('new rules')};
  assert.equal(tracker.confirmInitialBaseline(c,p,inventory,1),false);
  const p2=tracker.previewInitialBaseline(next,inventory,0,100)!;
  assert.equal(tracker.observeCreate(next,owner,{kind:'create',sequence:1},a),'verified-new');
  assert.equal(tracker.confirmInitialBaseline(next,p2,inventory,1),false);
  assert.equal(tracker.previewInitialBaseline(next,inventory,0,100),null);
  assert.equal(tracker.retire(next,{kind:'uncertain',sequence:2},'a.md','file'),true);
  assert.equal(tracker.lifecycleState(next,owner,a),'unresolved');
  assert.equal(tracker.previewInitialBaseline(next,inventory,0,100),null);
});
test('event gap or replay seals the epoch and source bound is fail closed',()=>{
  const {c,tracker,owner,a}=fixture();
  assert.equal(tracker.observeCreate(c,owner,{kind:'create',sequence:1},a),'verified-new');
  assert.equal(tracker.advance(c,owner,{kind:'modify',sequence:3},a,proof(c,'a.md','2')),'unresolved');
  assert.equal(tracker.lifecycleState(c,owner,a),'unresolved');
  const f=fixture();
  assert.equal(f.tracker.observeCreate(f.c,f.owner,{kind:'create',sequence:1},f.a),'verified-new');
  assert.equal(f.tracker.observeCreate(f.c,f.owner,{kind:'create',sequence:1},f.a),'unresolved');
  assert.equal(f.tracker.lifecycleState(f.c,f.owner,f.a),'unresolved');
  const g=fixture();
  for(let i=0;i<BOUNDS.sources;i++){
    assert.equal(g.tracker.observeCreate(g.c,{}, {kind:'create',sequence:i+1},proof(g.c,i+'.md')),'verified-new');
  }
  assert.equal(g.tracker.observeCreate(g.c,{}, {kind:'create',sequence:BOUNDS.sources+1},proof(g.c,'overflow.md')),'unresolved');
  assert.equal(g.tracker.previewInitialBaseline(g.c,g.inventory,0,100),null);
});
test('actual descriptor proof detects same-byte replacement, and preserves verified edits and rename',async()=>{
  const root=await mkdtemp(join(tmpdir(),'oks-lifecycle-proof-'));
  try{
    await writeFile(join(root,'a.md'),'original');
    const reader=await BoundedVaultReader.open(root,()=>['a.md']);
    const c=context(reader.rootId),owner={},tracker=new NewMaterialTracker<object>();
    assert.equal(tracker.openLifecycle(c),true);
    const a=await reader.readLifecycleProof('a.md');
    assert.deepEqual(a.version,await reader.readVersionProof('a.md'));
    assert.ok(Object.isFrozen(a)&&Object.isFrozen(a.version));
    assert.equal(tracker.observeCreate(c,owner,{kind:'create',sequence:1},a),'verified-new');
    await writeFile(join(root,'a.md'),'modified');
    const b=await reader.readLifecycleProof('a.md');
    assert.equal(a.stableIdentity,b.stableIdentity);
    assert.equal(tracker.lifecycleState(c,owner,b),'unresolved');
    assert.equal(tracker.advance(c,owner,{kind:'modify',sequence:2},a,b),'verified-new');
    await rename(join(root,'a.md'),join(root,'b.md'));
    const moved=await reader.readLifecycleProof('b.md');
    assert.equal(moved.stableIdentity,b.stableIdentity);
    assert.equal(tracker.advance(c,owner,{kind:'rename',sequence:3},b,moved),'verified-new');
    assert.equal(tracker.lifecycleState(c,owner,b),'unresolved');
    await writeFile(join(root,'replacement.md'),'modified');
    await rename(join(root,'replacement.md'),join(root,'b.md'));
    const replaced=await reader.readLifecycleProof('b.md');
    assert.equal(moved.version.sha256,replaced.version.sha256);
    assert.notEqual(moved.stableIdentity,replaced.stableIdentity);
    assert.equal(tracker.advance(c,owner,{kind:'modify',sequence:4},moved,replaced),'unresolved');
    assert.equal(tracker.lifecycleState(c,owner,moved),'unresolved');
    assert.equal(tracker.lifecycleState(c,owner,replaced),'unresolved');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('collision, wrong owner and stale prior retire exact authority; delete and new create are distinct',()=>{
  const {c,tracker,owner,second,a,b}=fixture();
  assert.equal(tracker.observeCreate(c,owner,{kind:'create',sequence:1},a),'verified-new');
  assert.equal(tracker.observeCreate(c,second,{kind:'create',sequence:2},b),'verified-new');
  assert.equal(tracker.advance(c,owner,{kind:'rename',sequence:3},a,proof(c,'b.md','1','a.md')),'unresolved');
  assert.equal(tracker.lifecycleState(c,owner,a),'unresolved');
  assert.equal(tracker.lifecycleState(c,second,b),'unresolved');
  assert.equal(tracker.retire(c,{kind:'delete',sequence:4},'a.md','file'),true);
  const next=proof(c,'a.md','2','new object');
  assert.equal(tracker.observeCreate(c,owner,{kind:'create',sequence:5},next),'verified-new');
  assert.equal(tracker.advance(c,second,{kind:'modify',sequence:6},next,proof(c,'a.md','3','new object')),'unresolved');
  assert.equal(tracker.lifecycleState(c,owner,next),'unresolved');
});
test('admitted existing successors require exact prior; caller mutation cannot rewrite admitted proof',()=>{
  const {c,tracker,owner,a,inventory}=fixture();
  const p=tracker.previewInitialBaseline(c,inventory,0,100)!;
  assert.equal(tracker.confirmInitialBaseline(c,p,inventory,1),true);
  const next=proof(c,'a.md','2');
  assert.equal(tracker.advance(c,owner,{kind:'modify',sequence:1},a,next),'existing');
  assert.equal(tracker.lifecycleState(c,owner,a),'unresolved');
  assert.equal(tracker.lifecycleState(c,owner,next),'existing');
  (next.version as {sha256:string}).sha256=hash('mutated');
  assert.equal(tracker.lifecycleState(c,owner,next),'unresolved');
  assert.equal(tracker.lifecycleState(c,owner,proof(c,'a.md','2')),'existing');
  assert.equal(tracker.advance(c,owner,{kind:'modify',sequence:2},a,proof(c,'a.md','3')),'unresolved');
  assert.equal(tracker.lifecycleState(c,owner,proof(c,'a.md','2')),'unresolved');
});
test('folder deletion or uncertainty seals descendants even for a Markdown-suffixed directory',()=>{
  for(const kind of ['delete','uncertain'] as const)for(const target of ['file','folder'] as const){
    const {c,tracker,owner,second}=fixture();
    const a=proof(c,'folder.md/a.md'),b=proof(c,'folder.md/nested/b.md');
    assert.equal(tracker.observeCreate(c,owner,{kind:'create',sequence:1},a),'verified-new');
    assert.equal(tracker.observeCreate(c,second,{kind:'create',sequence:2},b),'verified-new');
    assert.equal(tracker.retire(c,{kind,sequence:3},'folder.md',target),false);
    assert.equal(tracker.lifecycleState(c,owner,a),'unresolved');
    assert.equal(tracker.lifecycleState(c,second,b),'unresolved');
    assert.equal(tracker.previewInitialBaseline(c,{complete:true,candidates:[{owner,proof:a}]},0,100),null);
  }
  // An explicit folder event also fences inventory before any descendant is observed.
  const {c,tracker,owner}=fixture();
  assert.equal(tracker.retire(c,{kind:'delete',sequence:1},'folder.md','folder'),false);
  assert.equal(tracker.observeCreate(c,owner,{kind:'create',sequence:2},proof(c,'folder.md/a.md')),'unresolved');
});

test('descriptor lifecycle proof rejects unsupported nonpositive birth time before identity derivation',async()=>{
  // Deterministic fault injection into this isolated reader instance only.
  // This is a unit failure-path test, not a claim about a real filesystem.
  const root=await mkdtemp(join(tmpdir(),'oks-lifecycle-birth-negative-'));
  try{
    const reader=await BoundedVaultReader.open(root,()=>[]);
    for(const birthtimeNs of [0n,-1n]){
      Object.defineProperty(reader,'readOriginal',{configurable:true,value:async()=>({info:{birthtimeNs}})});
      await assert.rejects(reader.readLifecycleProof('a.md'),{code:'LIFECYCLE_IDENTITY_UNSUPPORTED'});
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
