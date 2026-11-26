import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BoundedVaultReader, privateIndexPath, type DescriptorLifecycleProof } from '../plugin/src/standalone/source';
import { BOUNDS, hash } from '../plugin/src/standalone/contracts';
import { DurableLifecycleLedger } from '../plugin/src/ai/lifecycle-ledger';
import { NewMaterialTracker, type LifecycleContext } from '../plugin/src/ai/new-material-tracker';
import type { LedgerEntry } from '../plugin/src/ai/lifecycle-ledger-schema';

const pluginId='oks-restore-test';
type Fixture={root:string;reader:BoundedVaultReader;ledger:DurableLifecycleLedger;context:LifecycleContext;
  owner:object;anchor:string;reopen:()=>Promise<void>;commit:(entries:readonly LedgerEntry[],baseline?:boolean)=>Promise<void>};
async function fixture(action:(f:Fixture)=>Promise<void>){
  const base=await mkdtemp(join(tmpdir(),'oks-restore-')),previous=process.env.XDG_DATA_HOME;
  const stores:DurableLifecycleLedger[]=[];
  try{
    const root=join(base,'vault'),xdg=join(base,'xdg');
    await mkdir(root,{mode:0o700});await mkdir(xdg,{mode:0o700});
    process.env.XDG_DATA_HOME=xdg;await writeFile(join(root,'a.md'),'synthetic');
    const reader=await BoundedVaultReader.open(root,()=>['a.md']);
    const open=async()=>{const store=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},pluginId);
      stores.push(store);return store;};
    let ledger=await open();
    const context:LifecycleContext={rootId:reader.rootId,scopeId:hash('scope'),rulesRevision:hash('rules'),host:{},session:{}};
    const owner={},anchor=join(dirname(privateIndexPath(root,reader.rootId,pluginId)),'lifecycle-authority','CURRENT');
    await action({root,reader,context,owner,anchor,get ledger(){return ledger;},
      reopen:async()=>{await ledger.close();ledger=await open();},
      commit:async(entries,baseline=entries.some(e=>e.state==='existing'))=>{
        const initial=await ledger.initializeEmptyEpoch();
        await ledger.commit(initial.anchor.snapshotSha256,baseline,[...entries].sort((a,b)=>a.sourceId<b.sourceId?-1:1));
      }});
  }finally{await Promise.all(stores.map(s=>s.close()));
    if(previous===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=previous;
    await rm(base,{recursive:true,force:true});}
}
function active(proof:DescriptorLifecycleProof,state:'existing'|'verified-new'='existing'):LedgerEntry{
  return {sourceId:proof.version.sourceId,state,origin:state==='existing'?'baseline':'native-create',originVersionId:proof.version.versionId,proof};
}
function tracker(context:LifecycleContext){const value=new NewMaterialTracker<object>();assert.equal(value.openLifecycle(context),true);return value;}
const host=(f:Fixture)=>({current:()=>true,resolveNativeOwner:(path:string)=>path==='a.md'?f.owner:null});
const inventory=(owner:object,proof:DescriptorLifecycleProof)=>({complete:true,candidates:[{owner,proof}]});

test('restore authenticates a reopened ledger, exact current original and current native owner; origin survives subsequent verified transition',async()=>{
  for(const state of ['existing','verified-new'] as const)await fixture(async f=>{
    const proof=await f.reader.readLifecycleProof('a.md');await f.commit([active(proof,state)]);await f.reopen();
    const value=tracker(f.context),currentOwner={},h={current:()=>true,resolveNativeOwner:()=>currentOwner};
    assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,h),true);
    assert.equal(value.lifecycleState(f.context,currentOwner,proof),state);
    assert.equal(value.lifecycleState(f.context,f.owner,proof),'unresolved');
    assert.equal(value.previewInitialBaseline(f.context,inventory(currentOwner,proof),0,100),null);
    const evidence=value.exportCommittedLifecycleEvidence(f.context)!;
    assert.equal(evidence.baselineAdmitted,state==='existing');assert.deepEqual(evidence.entries,[active(proof,state)]);
    assert.ok(Object.isFrozen(evidence.entries)&&Object.isFrozen(evidence.entries[0]));
    assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,h),false);
    await writeFile(join(f.root,'a.md'),'edited');const next=await f.reader.readLifecycleProof('a.md');
    assert.equal(value.lifecycleState(f.context,currentOwner,next),'unresolved');
    assert.equal(value.advance(f.context,currentOwner,{kind:'modify',sequence:1},proof,next),state);
    const advanced=value.exportCommittedLifecycleEvidence(f.context)!.entries[0]!;
    assert.deepEqual(advanced,{...active(proof,state),proof:next});
  });
});

test('edited, moved, missing and same-byte replaced originals cannot restore; retain baseline flag and tombstone',async()=>{
  for(const change of ['edit','move','missing','replacement'] as const)await fixture(async f=>{
    const proof=await f.reader.readLifecycleProof('a.md');await f.commit([active(proof)]);
    if(change==='edit')await writeFile(join(f.root,'a.md'),'edited');
    if(change==='move')await rename(join(f.root,'a.md'),join(f.root,'moved.md'));
    if(change==='missing')await unlink(join(f.root,'a.md'));
    if(change==='replacement'){
      await writeFile(join(f.root,'replacement.md'),'synthetic');
      await rename(join(f.root,'replacement.md'),join(f.root,'a.md'));
      const replaced=await f.reader.readLifecycleProof('a.md');
      assert.equal(replaced.version.sha256,proof.version.sha256);assert.notEqual(replaced.stableIdentity,proof.stableIdentity);
    }
    await f.reopen();const value=tracker(f.context);
    assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,host(f)),true);
    assert.equal(value.lifecycleState(f.context,f.owner,proof),'unresolved');
    assert.deepEqual(value.exportCommittedLifecycleEvidence(f.context),{baselineAdmitted:true,entries:[{sourceId:'a.md',state:'ambiguous'}]});
    assert.equal(value.previewInitialBaseline(f.context,inventory(f.owner,proof),0,100),null);
  });
});

test('unknown, substituted or late-changed native owner denies exact recovery',async()=>{
  for(const phase of ['unknown','after-read','before-publish'] as const)await fixture(async f=>{
    const proof=await f.reader.readLifecycleProof('a.md');await f.commit([active(proof,'verified-new')]);await f.reopen();
    const value=tracker(f.context);let calls=0;const changed={};
    const resolveNativeOwner=()=>{calls++;return phase==='unknown'?null:
      phase==='after-read'&&calls>=2||phase==='before-publish'&&calls>=3?changed:f.owner;};
    assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,{current:()=>true,resolveNativeOwner}),true);
    assert.equal(value.lifecycleState(f.context,f.owner,proof),'unresolved');
    assert.equal(value.lifecycleState(f.context,changed,proof),'unresolved');
    assert.deepEqual(value.exportCommittedLifecycleEvidence(f.context)?.entries,[{sourceId:'a.md',state:'ambiguous'}]);
    assert.equal(value.previewInitialBaseline(f.context,inventory(f.owner,proof),0,100),null);
  });
});

test('duplicate ownership denies both records even when one already fails version check; preserve prior tombstones',async()=>{
  for(const stale of [false,true])await fixture(async f=>{
    await writeFile(join(f.root,'b.md'),'other');
    const a=await f.reader.readLifecycleProof('a.md'),b=await f.reader.readLifecycleProof('b.md');
    await f.commit([active(a),active(b),{sourceId:'gone.md',state:'deleted'},{sourceId:'unknown.md',state:'ambiguous'}]);
    if(stale)await writeFile(join(f.root,'a.md'),'changed');
    await f.reopen();const value=tracker(f.context);
    assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,{current:()=>true,resolveNativeOwner:()=>f.owner}),true);
    assert.equal(value.lifecycleState(f.context,f.owner,a),'unresolved');
    assert.equal(value.lifecycleState(f.context,f.owner,b),'unresolved');
    assert.deepEqual(value.exportCommittedLifecycleEvidence(f.context)?.entries,[
      {sourceId:'a.md',state:'ambiguous'},{sourceId:'b.md',state:'ambiguous'},
      {sourceId:'gone.md',state:'deleted'},{sourceId:'unknown.md',state:'ambiguous'},
    ]);
  });
});

test('missing, corrupt or missing-after-commit anchor, foreign reader/ledger and structural lookalikes fail closed',async()=>{
  for(const failure of ['empty','corrupt','missing','foreign-reader','foreign-ledger','forged'] as const)await fixture(async f=>{
    const proof=await f.reader.readLifecycleProof('a.md');
    if(failure!=='empty')await f.commit([active(proof)]);
    if(failure==='corrupt')await writeFile(f.anchor,'invalid',{mode:0o600});
    if(failure==='missing')await unlink(f.anchor);
    const value=tracker(f.context);
    let reader=f.reader,ledger=f.ledger,foreign:DurableLifecycleLedger|undefined;
    try{
      if(failure==='foreign-reader'||failure==='foreign-ledger'){
        const path=join(f.root,'other');await mkdir(path,{mode:0o700});
        const other=await BoundedVaultReader.open(path,()=>[]);
        if(failure==='foreign-reader')reader=other;
        else {foreign=await DurableLifecycleLedger.open({path,rootId:other.rootId},pluginId);
          await foreign.initializeEmptyEpoch();ledger=foreign;}
      }
      if(failure==='forged')ledger={read:async()=>await f.ledger.read()} as never;
      assert.equal(await value.restoreCommittedLifecycle(f.context,ledger,reader,host(f)),false);
      assert.equal(value.lifecycleState(f.context,f.owner,proof),'unresolved');
      assert.equal(value.exportCommittedLifecycleEvidence(f.context),null);
      assert.equal(value.previewInitialBaseline(f.context,inventory(f.owner,proof),0,100),null);
      assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,host(f)),false);
    }finally{await foreign?.close();}
  });
});

test('initialized empty epoch restores without automatic baseline; baseline flag stays one-shot',async()=>{
  await fixture(async f=>{
    await f.ledger.initializeEmptyEpoch();await f.reopen();const value=tracker(f.context);
    const proof=await f.reader.readLifecycleProof('a.md');
    assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,host(f)),true);
    assert.equal(value.lifecycleState(f.context,f.owner,proof),'unresolved');
    assert.deepEqual(value.exportCommittedLifecycleEvidence(f.context),{baselineAdmitted:false,entries:[]});
    const i=inventory(f.owner,proof),preview=value.previewInitialBaseline(f.context,i,0,100)!;
    assert.ok(preview);assert.equal(value.confirmInitialBaseline(f.context,preview,i,1),true);
    assert.equal(value.previewInitialBaseline(f.context,i,2,100),null);
  });
});

test('interruptions seal restoration, prevent partial publication and forbid baseline/retry',async()=>{
  for(const interrupt of ['event','rules','clear','fence','legacy','anchor','closed'] as const)await fixture(async f=>{
    await writeFile(join(f.root,'b.md'),'other');
    const proof=await f.reader.readLifecycleProof('a.md'),b=await f.reader.readLifecycleProof('b.md');
    await f.commit([active(proof),active(b)]);await f.reopen();
    const value=tracker(f.context),original=f.reader.readLifecycleProof.bind(f.reader);let live=true;
    const ownerB={},h={current:()=>live,resolveNativeOwner:(path:string)=>path==='a.md'?f.owner:ownerB};
    Object.defineProperty(f.reader,'readLifecycleProof',{configurable:true,value:async(path:string)=>{
      assert.equal(value.lifecycleState(f.context,f.owner,proof),'unresolved');
      assert.equal(value.previewInitialBaseline(f.context,inventory(f.owner,proof),0,100),null);
      assert.equal(value.exportCommittedLifecycleEvidence(f.context),null);
      if(path==='b.md'){
        if(interrupt==='event')assert.equal(value.observeCreate(f.context,ownerB,{kind:'create',sequence:1},b),'unresolved');
        if(interrupt==='rules')value.reviseRules(f.context,hash('changed-rules'));
        if(interrupt==='clear')value.clear();
        if(interrupt==='fence')live=false;
        if(interrupt==='legacy')value.changed('a.md',f.owner);
        if(interrupt==='anchor'){const old=(await f.ledger.read())!;await f.ledger.commit(old.anchor.snapshotSha256,true,old.snapshot.entries);}
        if(interrupt==='closed')await f.ledger.close();
      }
      return original(path);
    }});
    assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,h),false);
    assert.equal(value.lifecycleState(f.context,f.owner,proof),'unresolved');
    assert.equal(value.lifecycleState(f.context,ownerB,b),'unresolved');
    assert.equal(value.exportCommittedLifecycleEvidence(f.context),null);
    assert.equal(value.previewInitialBaseline(f.context,inventory(f.owner,proof),0,100),null);
    assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,host(f)),false);
  });
});

test('restore refuses already used exact or legacy tracker and legacy mutation revokes restored exact evidence',async()=>{
  await fixture(async f=>{
    const proof=await f.reader.readLifecycleProof('a.md');await f.commit([active(proof)]);
    for(const use of ['preview','rule','event','legacy'] as const){
      const value=tracker(f.context);
      if(use==='preview')assert.ok(value.previewInitialBaseline(f.context,inventory(f.owner,proof),0,100));
      if(use==='rule')value.reviseRules(f.context,f.context.rulesRevision);
      if(use==='event')value.observeCreate(f.context,f.owner,{kind:'create',sequence:1},proof);
      if(use==='legacy'){value.created('a.md',f.owner);value.invalidate('a.md');}
      assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,host(f)),false);
      assert.equal(value.lifecycleState(f.context,f.owner,proof),'unresolved');
      assert.equal(value.exportCommittedLifecycleEvidence(f.context),null);
    }
    const value=tracker(f.context);assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,host(f)),true);
    value.changed('a.md',f.owner);
    assert.equal(value.lifecycleState(f.context,f.owner,proof),'unresolved');
    assert.equal(value.exportCommittedLifecycleEvidence(f.context),null);
  });
});

test('bounded committed tombstone inventory is retained without resolving owners or silently evicting records',async()=>{
  await fixture(async f=>{
    const records=Array.from({length:BOUNDS.sources},(_,i):LedgerEntry=>({sourceId:'t'+String(i).padStart(4,'0')+'.md',state:'ambiguous'}));
    await f.commit(records,false);await f.reopen();const value=tracker(f.context);
    assert.equal(await value.restoreCommittedLifecycle(f.context,f.ledger,f.reader,{current:()=>true,
      resolveNativeOwner:()=>{throw Error('tombstone must not resolve owner');}}),true);
    assert.deepEqual(value.exportCommittedLifecycleEvidence(f.context)?.entries,records);
  });
});
