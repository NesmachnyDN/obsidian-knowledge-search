import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableLifecycleLedger } from '../plugin/src/ai/lifecycle-ledger';
import { NewMaterialTracker, type LifecycleContext } from '../plugin/src/ai/new-material-tracker';
import { BoundedVaultReader } from '../plugin/src/standalone/source';
import { hash } from '../plugin/src/standalone/contracts';

const pluginId='oks-2e3d2b-test';
async function fixture(action:(f:{root:string;tracker:NewMaterialTracker<object>;context:LifecycleContext;reader:BoundedVaultReader;
  ledger:DurableLifecycleLedger;owners:Map<string,object>;host:(extra?:Partial<{current:()=>boolean;now:()=>number;signal:AbortSignal}>)=>{
    signal:AbortSignal;current:()=>boolean;monotonicNow:()=>number;resolveNativeOwner:(path:string)=>object|null}})=>Promise<void>) {
  const base=await mkdtemp(join(tmpdir(),'oks-2e3d2b-')),root=join(base,'vault'),xdg=join(base,'xdg');
  const prior=process.env.XDG_DATA_HOME;let ledger:DurableLifecycleLedger|undefined;
  try {
    await mkdir(root,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
    await writeFile(join(root,'a.md'),'synthetic a');await writeFile(join(root,'b.md'),'synthetic b');
    const reader=await BoundedVaultReader.open(root,()=>['a.md','b.md']);
    const host={},session={},context={rootId:reader.rootId,scopeId:hash('scope'),rulesRevision:hash('rules'),host,session};
    const tracker=new NewMaterialTracker<object>();assert.equal(tracker.openLifecycle(context),true);
    const owners=new Map<string,object>([['a.md',{}],['b.md',{}]]);
    ledger=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},pluginId);
    const makeHost=(extra:Partial<{current:()=>boolean;now:()=>number;signal:AbortSignal}>={})=>({signal:extra.signal??new AbortController().signal,current:extra.current??(()=>true),
      monotonicNow:extra.now??(()=>10),resolveNativeOwner:(path:string)=>owners.get(path)??null});
    await action({root,tracker,context,reader,ledger,owners,host:makeHost});
  } finally {
    await ledger?.close();if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(base,{recursive:true,force:true});
  }
}

async function preview(f:{tracker:NewMaterialTracker<object>;context:LifecycleContext;reader:BoundedVaultReader;owners:Map<string,object>}) {
  const inventory=await f.reader.completeMarkdownInventory();
  return f.tracker.previewInitialBaseline(f.context,{complete:true,candidates:inventory.sources.map(proof=>
    ({owner:f.owners.get(proof.version.sourceId)!,proof}))},0,100)!;
}

test('POLICY.2e3d.2b admits only exact preview once, durably, then live after fresh proof',async()=>{
  await fixture(async f=>{
    const p=await preview(f),ok=await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host());
    assert.equal(ok,'admitted');
    const evidence=f.tracker.exportCommittedLifecycleEvidence(f.context)!;
    assert.equal(evidence.baselineAdmitted,true);assert.equal(evidence.entries.length,2);
    assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host()),'denied');
    await f.ledger.close();const reopened=await DurableLifecycleLedger.open({path:f.root,rootId:f.context.rootId},pluginId);
    assert.equal((await reopened.read())?.snapshot.baselineAdmitted,true);await reopened.close();
  });
});

test('POLICY.2e3d.2b seals on cancellation, expiry, owner substitution and stale preview without live state',async()=>{
  await fixture(async f=>{
    const aborted=new AbortController();aborted.abort();
    const p=await preview(f);
    assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host({signal:aborted.signal})),'denied');
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
  });
  await fixture(async f=>{
    const p=await preview(f);f.owners.set('a.md',{});
    assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host()),'denied');
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
  });
  await fixture(async f=>{
    const p=await preview(f);
    assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host({now:()=>100})),'denied');
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
  });
  await fixture(async f=>{
    const p=await preview(f);let calls=0;
    const host=f.host({current:()=>++calls<4});
    assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,host),'denied');
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
  });
});

test('POLICY.2e3d.2b consumes a preview before asynchronous admission and rejects a reentrant replay',async()=>{
  await fixture(async f=>{
    const p=await preview(f);
    const first=f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host());
    const second=f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host());
    assert.equal(await second,'denied');assert.equal(await first,'denied');
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
  });
});

test('durable admission blocks all live classification during staged revalidation and drains lock on close',async t=>{
  await fixture(async f=>{
    const empty=await f.ledger.initializeEmptyEpoch(),p=await preview(f);
    let release!:()=>void,entered!:()=>void,calls=0;
    const suspended=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
    const original=f.reader.completeMarkdownInventory.bind(f.reader);
    t.mock.method(f.reader,'completeMarkdownInventory',async(signal?:AbortSignal)=>{
      if(++calls===2){entered();await suspended;}
      return original(signal);
    });
    const admission=f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host());
    try{
      await ready;
      assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
      assert.equal(f.tracker.lifecycleState(f.context,p.candidates[0]!.owner,p.candidates[0]!.proof),'unresolved');
      const closing=f.ledger.close();
      await assert.rejects(DurableLifecycleLedger.open({path:f.root,rootId:f.context.rootId},pluginId));
      release();assert.equal(await admission,'denied');await closing;
      const reopened=await DurableLifecycleLedger.open({path:f.root,rootId:f.context.rootId},pluginId);
      try{assert.deepEqual(await reopened.read(),empty);}finally{await reopened.close();}
    }finally{release();await admission;}
  });
});

test('durable admission distinguishes pre-switch cancellation and post-switch revocation',async t=>{
  for(const phase of ['before','after'] as const)await fixture(async f=>{
    const empty=await f.ledger.initializeEmptyEpoch(),p=await preview(f),abort=new AbortController();
    const fs=require('node:fs') as typeof import('node:fs');
    const originalRename=fs.renameSync;
    const originalInventory=f.reader.completeMarkdownInventory.bind(f.reader);let calls=0;
    const inventoryMock=t.mock.method(f.reader,'completeMarkdownInventory',async(signal?:AbortSignal)=>{
      const result=await originalInventory(signal);
      if(phase==='before'&&++calls===2)abort.abort();
      return result;
    });
    const renameMock=t.mock.method(fs,'renameSync',((from:import('node:fs').PathLike,to:import('node:fs').PathLike)=>{
      originalRename(from,to);if(phase==='after')abort.abort();
    }) as typeof fs.renameSync);
    try{
      assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host({signal:abort.signal})),
        phase==='before'?'denied':'committed-not-live');
      assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
    }finally{inventoryMock.mock.restore();renameMock.mock.restore();}
    await f.ledger.close();
    const reopened=await DurableLifecycleLedger.open({path:f.root,rootId:f.context.rootId},pluginId);
    try{
      const loaded=await reopened.read();
      if(phase==='before')assert.deepEqual(loaded,empty);
      else assert.equal(loaded?.snapshot.baselineAdmitted,true);
    }finally{await reopened.close();}
  });
});

test('uncertain anchor publication seals authority and never claims rollback',async t=>{
  for(const switched of [false,true])await fixture(async f=>{
    const empty=await f.ledger.initializeEmptyEpoch(),p=await preview(f);
    const fs=require('node:fs') as typeof import('node:fs'),rename=fs.renameSync;
    const mock=t.mock.method(fs,'renameSync',((from:import('node:fs').PathLike,to:import('node:fs').PathLike)=>{
      if(switched)rename(from,to);
      throw Error('synthetic interrupted publication');
    }) as typeof fs.renameSync);
    try{
      assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host()),'uncertain-publication');
      assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
    }finally{mock.mock.restore();}
    await assert.rejects(f.ledger.read());await f.ledger.close();
    const reopened=await DurableLifecycleLedger.open({path:f.root,rootId:f.context.rootId},pluginId);
    try{
      const loaded=await reopened.read();
      if(switched)assert.equal(loaded?.snapshot.baselineAdmitted,true);
      else assert.deepEqual(loaded,empty);
    }finally{await reopened.close();}
  });
});

test('stale or substituted full inventory and changed owner after staging deny baseline',async t=>{
  for(const kind of ['source','owner','rule','event','legacy','clock','retire'] as const)await fixture(async f=>{
    const empty=await f.ledger.initializeEmptyEpoch(),p=await preview(f);
    const original=f.reader.completeMarkdownInventory.bind(f.reader);let calls=0,now=10;
    t.mock.method(f.reader,'completeMarkdownInventory',async(signal?:AbortSignal)=>{
      const result=await original(signal);
      if(++calls===2){
        if(kind==='source'){
          // Change before the complete re-observation returns.
          await writeFile(join(f.root,'a.md'),'changed source');
          return original(signal);
        }
        if(kind==='owner')f.owners.set('a.md',{});
        if(kind==='rule')f.tracker.reviseRules(f.context,hash('new-rules'));
        if(kind==='event')f.tracker.observeCreate(f.context,p.candidates[0]!.owner,{sequence:1,kind:'create'},p.candidates[0]!.proof);
        if(kind==='legacy')f.tracker.created('new.md',{});
        if(kind==='clock')now=9;
        if(kind==='retire')f.tracker.retireExactLifecycle();
      }
      return result;
    });
    assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host({now:()=>now})),'denied',kind);
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
    await f.ledger.close();
    const reopened=await DurableLifecycleLedger.open({path:f.root,rootId:f.context.rootId},pluginId);
    try{assert.deepEqual(await reopened.read(),empty);}finally{await reopened.close();}
  });
});

test('post-commit fresh proof is required and epoch signal revokes published live authority',async t=>{
  await fixture(async f=>{
    await f.ledger.initializeEmptyEpoch();const p=await preview(f);
    const original=f.reader.completeMarkdownInventory.bind(f.reader);let calls=0;
    t.mock.method(f.reader,'completeMarkdownInventory',async(signal?:AbortSignal)=>{
      if(++calls===3)await writeFile(join(f.root,'b.md'),'changed after commit');
      return original(signal);
    });
    assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host()),'committed-not-live');
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
    assert.equal((await f.ledger.read())?.snapshot.baselineAdmitted,true);
  });
  await fixture(async f=>{
    const p=await preview(f),abort=new AbortController();
    assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host({signal:abort.signal})),'admitted');
    abort.abort();
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
    assert.equal((await f.ledger.read())?.snapshot.baselineAdmitted,true);
  });
});

test('wrong ledger root cannot initialize a different vault and nonpristine provenance cannot rebaseline',async()=>{
  await fixture(async f=>{
    const other=join(f.root,'other');await mkdir(other,{mode:0o700});
    const reader=await BoundedVaultReader.open(other,()=>[]);
    const ledger=await DurableLifecycleLedger.open({path:other,rootId:reader.rootId},pluginId);
    try{
      const p=await preview(f);
      assert.equal(await f.tracker.admitInitialBaseline(f.context,p,ledger,f.reader,f.host()),'denied');
      assert.equal(await ledger.read(),null);
    }finally{await ledger.close();}
  });
  await fixture(async f=>{
    const p=await preview(f);
    f.tracker.created('b.md',f.owners.get('b.md')!);
    assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host()),'denied');
    assert.equal(await f.ledger.read(),null);
  });
});


test('fresh epoch creation is itself guarded and a partial preview cannot initialize storage',async t=>{
  await fixture(async f=>{
    const inventory=await f.reader.completeMarkdownInventory(),proof=inventory.sources[0]!;
    const p=f.tracker.previewInitialBaseline(f.context,{complete:true,candidates:[{proof,owner:f.owners.get(proof.version.sourceId)!}]},0,100)!;
    assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host()),'denied');
    assert.equal(await f.ledger.read(),null);
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
  });
  await fixture(async f=>{
    const p=await preview(f),abort=new AbortController();let calls=0;
    const original=f.reader.completeMarkdownInventory.bind(f.reader);
    t.mock.method(f.reader,'completeMarkdownInventory',async(signal?:AbortSignal)=>{
      const inventory=await original(signal);
      if(++calls===3)abort.abort();
      return inventory;
    });
    assert.equal(await f.tracker.admitInitialBaseline(f.context,p,f.ledger,f.reader,f.host({signal:abort.signal})),'denied');
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
    await f.ledger.close();
    // A staged initial snapshot without a committed CURRENT is not fresh.
    // Preserve the established fail-closed recovery rule; never auto-rebaseline.
    await assert.rejects(DurableLifecycleLedger.open({path:f.root,rootId:f.context.rootId},pluginId),{code:'LIFECYCLE_LEDGER_UNAVAILABLE'});
  });
});
