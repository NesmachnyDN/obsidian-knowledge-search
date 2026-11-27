import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, unlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BoundedVaultReader, privateIndexPath } from '../plugin/src/standalone/source';
import { hash } from '../plugin/src/standalone/contracts';
import { DurableLifecycleLedger } from '../plugin/src/ai/lifecycle-ledger';
import { NewMaterialTracker } from '../plugin/src/ai/new-material-tracker';
import { NativeLifecycleOwner } from '../plugin/src/ai/native-lifecycle-owner';

const pluginId='oks-native-baseline-test';
type Setup='fresh'|'uninitialized'|'corrupted'|'ambiguous'|'locked'|'nonpristine';
async function fixture(setup:Setup,action:(f:{root:string;reader:BoundedVaultReader;tracker:NewMaterialTracker<object>;
  owner:NativeLifecycleOwner<object>;context:{rootId:string;scopeId:string;rulesRevision:string;host:object;session:object};
  owners:Map<string,object>;open:()=>Promise<DurableLifecycleLedger>;invalidate:()=>void})=>Promise<void>,empty=false,legacy=false){
  const base=await mkdtemp(join(tmpdir(),'oks-native-baseline-')),root=join(base,'vault'),xdg=join(base,'xdg');
  const prior=process.env.XDG_DATA_HOME;let seed:DurableLifecycleLedger|undefined,owner:NativeLifecycleOwner<object>|undefined;
  try{
    await mkdir(root,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
    if(!empty)await writeFile(join(root,'a.md'),'synthetic original');
    const owners=new Map<string,object>(empty?[]:[['a.md',{}]]);
    const reader=await BoundedVaultReader.open(root,()=>[...owners.keys()]);
    const context={rootId:reader.rootId,scopeId:reader.rootId,rulesRevision:hash('rules'),host:{},session:{}};
    const tracker=new NewMaterialTracker<object>();owner=new NativeLifecycleOwner(tracker);
    const open=()=>DurableLifecycleLedger.open({path:root,rootId:reader.rootId},pluginId);
    if(setup!=='fresh'){
      seed=await open();const initial=await seed.initializeEmptyEpoch();
      if(setup==='nonpristine'){
        const proof=await reader.readLifecycleProof('a.md');
        await seed.commit(initial.anchor.snapshotSha256,false,[{sourceId:'a.md',state:'verified-new',origin:'native-create',originVersionId:proof.version.versionId,proof}]);
      }
      if(setup!=='locked')await seed.close();
      const parent=dirname(privateIndexPath(root,reader.rootId,pluginId));
      if(setup==='corrupted')await writeFile(join(parent,'lifecycle-authority','CURRENT'),'invalid committed anchor',{mode:0o600});
      if(setup==='ambiguous')await unlink(join(parent,'lifecycle-authority','CURRENT'));
    }
    if(legacy)tracker.created('a.md',owners.get('a.md')!);
    let current=true;
    await owner.start({context,reader,rootPath:root,pluginId,current:()=>current,resolveNativeOwner:path=>owners.get(path)??null});
    await action({root,reader,tracker,owner,context,owners,open,invalidate:()=>{current=false;}});
  }finally{
    await owner?.close();await seed?.close();if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(base,{recursive:true,force:true});
  }
}

for(const setup of ['fresh','uninitialized'] as const)test('native baseline '+setup+' readiness is local only; explicit preview and confirmation admit durably',async()=>{
  await fixture(setup,async f=>{
    assert.equal(f.owner.readiness(),setup);assert.equal(f.owner.exactAuthorityActive(),false);
    const proof=await f.reader.readLifecycleProof('a.md'),file=f.owners.get('a.md')!;
    assert.equal(f.tracker.lifecycleState(f.context,file,proof),'unresolved');
    await assert.rejects(f.open(),{code:'LIFECYCLE_LEDGER_UNAVAILABLE'});
    const result=await f.owner.prepareBaselinePreview();assert.ok(result.ok);
    const view=result.preview;assert.deepEqual(view.paths,['a.md']);assert.equal(view.count,1);assert.ok(Object.isFrozen(view.paths));
    assert.ok(f.owner.baselinePreviewRemainingMs(view)>0);assert.equal(f.owner.exactAuthorityActive(),false);
    assert.equal(f.tracker.lifecycleState(f.context,file,proof),'unresolved');
    assert.deepEqual(await f.owner.confirmBaselinePreview({...view}),{outcome:'denied',reason:'stale'});
    assert.deepEqual(await f.owner.confirmBaselinePreview(view),{outcome:'admitted'});
    assert.equal(f.owner.readiness(),'admitted');assert.equal(f.owner.exactAuthorityActive(),true);
    assert.equal(f.tracker.lifecycleState(f.context,file,proof),'existing');
    assert.equal((await f.owner.confirmBaselinePreview(view)).outcome,'denied');
    await f.owner.close();const ledger=await f.open();
    try{const state=await ledger.read();assert.equal(state?.snapshot.baselineAdmitted,true);assert.equal(state?.snapshot.entries.length,1);}
    finally{await ledger.close();}
  });
});

test('native baseline fresh open and preview alone never initialize; explicit cancellation consumes token',async()=>{
  await fixture('fresh',async f=>{
    const result=await f.owner.prepareBaselinePreview();assert.ok(result.ok);
    assert.deepEqual(f.owner.cancelBaselinePreviewOutcome(result.preview),{outcome:'cancelled'});
    assert.deepEqual(f.owner.cancelBaselinePreviewOutcome(result.preview),{outcome:'denied',reason:'retired'});
    assert.equal(f.owner.cancelBaselinePreview(result.preview),false);
    assert.equal((await f.owner.confirmBaselinePreview(result.preview)).outcome,'denied');
    await f.owner.close();const ledger=await f.open();try{assert.equal(await ledger.read(),null);}finally{await ledger.close();}
  });
});

test('native baseline exposes typed expiry, retirement and stale denial without a replacement baseline',async()=>{
  await fixture('fresh',async f=>{
    const expired=await f.owner.prepareBaselinePreview(1);assert.ok(expired.ok);await delay(15);
    assert.deepEqual(await f.owner.confirmBaselinePreview(expired.preview),{outcome:'denied',reason:'expired'});
    assert.equal((await f.owner.prepareBaselinePreview()).ok,false);
  });
  await fixture('fresh',async f=>{
    const view=await f.owner.prepareBaselinePreview();assert.ok(view.ok);f.invalidate();
    assert.deepEqual(await f.owner.confirmBaselinePreview(view.preview),{outcome:'denied',reason:'retired'});
    assert.deepEqual(f.owner.cancelBaselinePreviewOutcome(view.preview),{outcome:'denied',reason:'retired'});
  });
});

test('native baseline accepts an explicitly confirmed empty complete inventory, not an automatic baseline',async()=>{
  await fixture('fresh',async f=>{
    const result=await f.owner.prepareBaselinePreview();assert.ok(result.ok);assert.deepEqual(result.preview.paths,[]);
    assert.equal(f.owner.exactAuthorityActive(),false);assert.equal((await f.owner.confirmBaselinePreview(result.preview)).outcome,'admitted');
    await f.owner.close();const ledger=await f.open();try{const loaded=await ledger.read();assert.equal(loaded?.snapshot.baselineAdmitted,true);assert.deepEqual(loaded?.snapshot.entries,[]);}finally{await ledger.close();}
  },true);
});

for(const setup of ['corrupted','ambiguous','locked','nonpristine'] as const)test('native baseline denies '+setup+' rather than rebaseline',async()=>{
  await fixture(setup,async f=>{
    assert.equal(f.owner.readiness(),setup==='locked'?'unavailable':setup==='nonpristine'?'restored':setup);
    assert.equal((await f.owner.prepareBaselinePreview()).ok,false);
    assert.equal(f.owner.exactAuthorityActive(),setup==='nonpristine');
  });
});

test('native baseline pending-new pilot provenance is not erased by startup readiness',async()=>{
  await fixture('fresh',async f=>{
    assert.equal(f.owner.readiness(),'unavailable');assert.equal((await f.owner.prepareBaselinePreview()).ok,false);
    assert.equal(f.tracker.state('a.md',f.owners.get('a.md')!),'verified-new');
    const ledger=await f.open();try{assert.equal(await ledger.read(),null);}finally{await ledger.close();}
  },false,true);
});

test('native baseline expiry, owner substitution, source change and lost host fence deny confirmation',async()=>{
  for(const kind of ['expiry','owner','source','host'] as const)await fixture('fresh',async f=>{
    const result=await f.owner.prepareBaselinePreview(kind==='expiry'?1:60000);assert.ok(result.ok);
    if(kind==='expiry')await delay(15);
    if(kind==='owner')f.owners.set('a.md',{});
    if(kind==='source')await writeFile(join(f.root,'a.md'),'changed after preview');
    if(kind==='host')f.invalidate();
    const confirmation=await f.owner.confirmBaselinePreview(result.preview);assert.equal(confirmation.outcome,'denied',kind);
    if(kind==='expiry')assert.equal(confirmation.reason,'expired');
    assert.equal(f.owner.exactAuthorityActive(),false);
    await f.owner.close();const ledger=await f.open();try{assert.equal(await ledger.read(),null);}finally{await ledger.close();}
  });
});

test('native baseline cancellation during confirmation drains owner operation and exclusive lock',async()=>{
  await fixture('uninitialized',async f=>{
    const result=await f.owner.prepareBaselinePreview();assert.ok(result.ok);
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
    const original=f.reader.completeMarkdownInventory.bind(f.reader);let calls=0;
    f.reader.completeMarkdownInventory=async signal=>{if(++calls===2){entered();await gate;}return original(signal);};
    const pending=f.owner.confirmBaselinePreview(result.preview);
    try{
      await ready;assert.deepEqual(f.owner.cancelBaselinePreviewOutcome(result.preview),{outcome:'cancel-requested'});assert.equal(f.owner.exactAuthorityActive(),false);
      const closing=f.owner.close();assert.equal(f.owner.close(),closing);await assert.rejects(f.open(),{code:'LIFECYCLE_LEDGER_UNAVAILABLE'});
      release();assert.equal((await pending).outcome,'denied');await closing;
      const ledger=await f.open();try{assert.equal((await ledger.read())?.snapshot.baselineAdmitted,false);}finally{await ledger.close();}
    }finally{release();await pending;}
  });
});

test('native baseline overlapping preview or confirmation cannot acquire authority',async()=>{
  await fixture('fresh',async f=>{
    const first=f.owner.prepareBaselinePreview(),second=f.owner.prepareBaselinePreview();
    assert.equal((await second).ok,false);assert.equal((await first).ok,false);assert.equal(f.owner.exactAuthorityActive(),false);
    await f.owner.close();const ledger=await f.open();try{assert.equal(await ledger.read(),null);}finally{await ledger.close();}
  });
  await fixture('fresh',async f=>{
    const result=await f.owner.prepareBaselinePreview();assert.ok(result.ok);
    const first=f.owner.confirmBaselinePreview(result.preview),second=f.owner.confirmBaselinePreview(result.preview);
    assert.equal((await second).outcome,'denied');assert.equal((await first).outcome,'denied');assert.equal(f.owner.exactAuthorityActive(),false);
    await f.owner.close();const ledger=await f.open();try{assert.equal(await ledger.read(),null);}finally{await ledger.close();}
  });
});

test('owner serializes canonical create, modify, rename and delete into the real ledger',async()=>{
  await fixture('fresh',async f=>{
    const baseline=await f.owner.prepareBaselinePreview();assert.ok(baseline.ok);
    assert.deepEqual(await f.owner.confirmBaselinePreview(baseline.preview),{outcome:'admitted'});
    const a=f.owners.get('a.md')!;
    await writeFile(join(f.root,'a.md'),'modified synthetic original');
    assert.deepEqual(await f.owner.admitLiveTransition({event:{sequence:1,kind:'modify'},owner:a,sourceId:'a.md',current:()=>true}),{outcome:'admitted'});
    await rename(join(f.root,'a.md'),join(f.root,'b.md'));f.owners.delete('a.md');f.owners.set('b.md',a);
    assert.deepEqual(await f.owner.admitLiveTransition({event:{sequence:2,kind:'rename'},owner:a,sourceId:'a.md',destinationId:'b.md',current:()=>true}),{outcome:'admitted'});
    const c={};await writeFile(join(f.root,'c.md'),'created synthetic original');f.owners.set('c.md',c);
    assert.deepEqual(await f.owner.admitLiveTransition({event:{sequence:3,kind:'create'},owner:c,sourceId:'c.md',current:()=>true}),{outcome:'admitted'});
    await unlink(join(f.root,'c.md'));f.owners.delete('c.md');
    assert.deepEqual(await f.owner.admitLiveTransition({event:{sequence:4,kind:'delete'},owner:c,sourceId:'c.md',current:()=>true}),{outcome:'admitted'});
    assert.equal(f.owner.exactAuthorityActive(),true);
    await f.owner.close();const ledger=await f.open();try{
      const loaded=await ledger.read();assert.equal(loaded?.snapshot.revision,5);
      assert.deepEqual(loaded?.snapshot.entries.map(entry=>[entry.sourceId,entry.state]),[['a.md','deleted'],['b.md','existing'],['c.md','deleted']]);
    }finally{await ledger.close();}
  });
});

test('owner denies stale or incomplete live transition evidence and physically retires',async()=>{
  for(const kind of ['replay','owner','unrelated'] as const)await fixture('fresh',async f=>{
    const baseline=await f.owner.prepareBaselinePreview();assert.ok(baseline.ok);assert.equal((await f.owner.confirmBaselinePreview(baseline.preview)).outcome,'admitted');
    const a=f.owners.get('a.md')!;await writeFile(join(f.root,'a.md'),'changed');
    if(kind==='owner')f.owners.set('a.md',{});
    if(kind==='unrelated'){await writeFile(join(f.root,'missed.md'),'missed');f.owners.set('missed.md',{});}
    const event={sequence:kind==='replay'?2:1,kind:'modify' as const};
    assert.equal((await f.owner.admitLiveTransition({event,owner:a,sourceId:'a.md',current:()=>true})).outcome,'denied',kind);
    assert.equal(f.owner.exactAuthorityActive(),false);assert.equal(f.owner.readiness(),'retired');
    await f.owner.close();const ledger=await f.open();try{assert.equal((await ledger.read())?.snapshot.revision,1);}finally{await ledger.close();}
  });
});

test('live transition disables classification and export while durable publication is pending',async()=>{
  await fixture('fresh',async f=>{
    const baseline=await f.owner.prepareBaselinePreview();assert.ok(baseline.ok);assert.equal((await f.owner.confirmBaselinePreview(baseline.preview)).outcome,'admitted');
    const a=f.owners.get('a.md')!,before=await f.reader.readLifecycleProof('a.md');await writeFile(join(f.root,'a.md'),'changed');
    const original=f.reader.completeMarkdownInventory.bind(f.reader);let calls=0,release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
    f.reader.completeMarkdownInventory=async signal=>{if(++calls===2){entered();await gate;}return original(signal);};
    const pending=f.owner.admitLiveTransition({event:{sequence:1,kind:'modify'},owner:a,sourceId:'a.md',current:()=>true});
    try{
      assert.equal(f.owner.exactAuthorityActive(),false);
      assert.equal(f.tracker.lifecycleState(f.context,a,before),'unresolved');
      assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
      await waiting;assert.equal(f.owner.exactAuthorityActive(),false);
      assert.equal(f.tracker.lifecycleState(f.context,a,before),'unresolved');assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
      release();assert.equal((await pending).outcome,'admitted');
    }finally{release();await pending;}
  });
});


test('live transition captures mutable input before any host callback or async boundary',async()=>{
  await fixture('fresh',async f=>{
    const baseline=await f.owner.prepareBaselinePreview();assert.ok(baseline.ok);
    assert.equal((await f.owner.confirmBaselinePreview(baseline.preview)).outcome,'admitted');
    const a=f.owners.get('a.md')!;await writeFile(join(f.root,'a.md'),'changed');
    const input={event:{sequence:1,kind:'modify' as const},owner:a,sourceId:'a.md',current:()=>true};
    const pending=f.owner.admitLiveTransition(input);input.event.sequence=2;input.sourceId='unknown.md';input.current=()=>false;
    assert.equal((await pending).outcome,'admitted');
    await f.owner.close();const ledger=await f.open();try{assert.equal((await ledger.read())?.snapshot.revision,2);}finally{await ledger.close();}
  });
});

test('live transition reserves tracker authority before accessing caller getters and proxies',async()=>{
  await fixture('fresh',async f=>{
    const baseline=await f.owner.prepareBaselinePreview();assert.ok(baseline.ok);
    assert.equal((await f.owner.confirmBaselinePreview(baseline.preview)).outcome,'admitted');
    const a=f.owners.get('a.md')!,before=await f.reader.readLifecycleProof('a.md');
    assert.equal(f.tracker.lifecycleState(f.context,a,before),'existing');
    await writeFile(join(f.root,'a.md'),'changed');
    let eventReads=0,sequenceReads=0;
    const suspended=()=>{
      assert.equal(f.tracker.durableAuthorityActive(f.context),false);
      assert.equal(f.tracker.lifecycleState(f.context,a,before),'unresolved');
      assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
    };
    const event=new Proxy({sequence:1,kind:'modify' as const},{get(target,key,receiver){
      suspended();if(key==='sequence')sequenceReads++;return Reflect.get(target,key,receiver);
    }});
    const result=await f.owner.admitLiveTransition({
      get event(){eventReads++;suspended();return event;},owner:a,sourceId:'a.md',current:()=>true,
    });
    assert.equal(result.outcome,'admitted');assert.equal(eventReads,1);assert.equal(sequenceReads,1);
    assert.equal(f.tracker.lifecycleState(f.context,a,await f.reader.readLifecycleProof('a.md')),'existing');
    await f.owner.close();const ledger=await f.open();try{assert.equal((await ledger.read())?.snapshot.revision,2);}finally{await ledger.close();}
  });
});

test('live transition throwing or reentrant accessor denies and drains without publication',async()=>{
  for(const kind of ['throw','retire','overlap'] as const)await fixture('fresh',async f=>{
    const baseline=await f.owner.prepareBaselinePreview();assert.ok(baseline.ok);
    assert.equal((await f.owner.confirmBaselinePreview(baseline.preview)).outcome,'admitted');
    const a=f.owners.get('a.md')!,before=await f.reader.readLifecycleProof('a.md');
    await writeFile(join(f.root,'a.md'),'changed');
    const event={sequence:1,kind:'modify' as const},input={event,owner:a,sourceId:'a.md',current:()=>true};
    let nested:ReturnType<typeof f.owner.admitLiveTransition>|undefined;
    let observed=false;
    const result=await f.owner.admitLiveTransition({...input,get event(){
      observed=f.tracker.lifecycleState(f.context,a,before)==='unresolved'
        &&f.tracker.exportCommittedLifecycleEvidence(f.context)===null&&!f.tracker.durableAuthorityActive(f.context);
      if(kind==='throw')throw new Error('synthetic accessor failure');
      if(kind==='retire')f.tracker.retireExactLifecycle();
      if(kind==='overlap')nested=f.owner.admitLiveTransition(input);
      return event;
    }});
    assert.equal(observed,true,kind);assert.equal(result.outcome,'denied',kind);
    if(nested)assert.equal((await nested).outcome,'denied');
    assert.equal(f.owner.exactAuthorityActive(),false);
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
    await f.owner.close();const ledger=await f.open();try{assert.equal((await ledger.read())?.snapshot.revision,1);}finally{await ledger.close();}
  });
});

test('durable authority cannot advance via unguarded or legacy tracker calls',async()=>{
  for(const kind of ['advance','legacy','rules'] as const)await fixture('fresh',async f=>{
    const baseline=await f.owner.prepareBaselinePreview();assert.ok(baseline.ok);
    assert.equal((await f.owner.confirmBaselinePreview(baseline.preview)).outcome,'admitted');
    const a=f.owners.get('a.md')!,prior=await f.reader.readLifecycleProof('a.md');
    await writeFile(join(f.root,'a.md'),'changed');const next=await f.reader.readLifecycleProof('a.md');
    if(kind==='advance')assert.equal(f.tracker.advance(f.context,a,{kind:'modify',sequence:1},prior,next),'unresolved');
    if(kind==='legacy'){f.tracker.created('a.md',a);assert.equal(f.tracker.state('a.md',a),'unresolved');}
    if(kind==='rules')assert.equal(f.tracker.reviseRules(f.context,hash('new-rules')),false);
    assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
    assert.equal(f.tracker.lifecycleState(f.context,a,next),'unresolved');
    await f.owner.close();const ledger=await f.open();try{assert.equal((await ledger.read())?.snapshot.revision,1);}finally{await ledger.close();}
  });
});

test('overlapping live transition retires before publication and drains physical lock',async()=>{
  await fixture('fresh',async f=>{
    const baseline=await f.owner.prepareBaselinePreview();assert.ok(baseline.ok);
    assert.equal((await f.owner.confirmBaselinePreview(baseline.preview)).outcome,'admitted');
    const a=f.owners.get('a.md')!;await writeFile(join(f.root,'a.md'),'changed');
    const original=f.reader.completeMarkdownInventory.bind(f.reader);let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
    f.reader.completeMarkdownInventory=async signal=>{entered();await gate;return original(signal);};
    const event={event:{sequence:1,kind:'modify' as const},owner:a,sourceId:'a.md',current:()=>true};
    const pending=f.owner.admitLiveTransition(event);
    try{
      await waiting;assert.equal((await f.owner.admitLiveTransition(event)).outcome,'denied');
      assert.equal(f.owner.exactAuthorityActive(),false);await assert.rejects(f.open(),{code:'LIFECYCLE_LEDGER_UNAVAILABLE'});
      release();assert.equal((await pending).outcome,'denied');
    }finally{release();await pending;}
    await f.owner.close();const ledger=await f.open();try{assert.equal((await ledger.read())?.snapshot.revision,1);}finally{await ledger.close();}
  });
});


test('live transition cancellation before CURRENT denies; after CURRENT is committed-not-live',async()=>{
  for(const phase of ['before','after'] as const)await fixture('fresh',async f=>{
    const baseline=await f.owner.prepareBaselinePreview();assert.ok(baseline.ok);
    assert.equal((await f.owner.confirmBaselinePreview(baseline.preview)).outcome,'admitted');
    const a=f.owners.get('a.md')!;await writeFile(join(f.root,'a.md'),'changed');
    const original=f.reader.completeMarkdownInventory.bind(f.reader);let calls=0;
    f.reader.completeMarkdownInventory=async signal=>{if(++calls===(phase==='before'?2:3))f.owner.retire();return original(signal);};
    const result=await f.owner.admitLiveTransition({event:{sequence:1,kind:'modify'},owner:a,sourceId:'a.md',current:()=>true});
    assert.equal(result.outcome,phase==='before'?'denied':'committed-not-live');
    assert.equal(f.owner.exactAuthorityActive(),false);assert.equal(f.tracker.exportCommittedLifecycleEvidence(f.context),null);
    await f.owner.close();const ledger=await f.open();try{assert.equal((await ledger.read())?.snapshot.revision,phase==='before'?1:2);}finally{await ledger.close();}
  });
});

test('verified-new origin and unrelated records survive same-byte rename and durable reopen',async()=>{
  await fixture('fresh',async f=>{
    const baseline=await f.owner.prepareBaselinePreview();assert.ok(baseline.ok);
    assert.equal((await f.owner.confirmBaselinePreview(baseline.preview)).outcome,'admitted');
    const existing=f.tracker.exportCommittedLifecycleEvidence(f.context)!.entries[0]!;
    const b={};await writeFile(join(f.root,'b.md'),'new synthetic');f.owners.set('b.md',b);
    assert.equal((await f.owner.admitLiveTransition({event:{sequence:1,kind:'create'},owner:b,sourceId:'b.md',current:()=>true})).outcome,'admitted');
    const prior=await f.reader.readLifecycleProof('b.md');
    await rename(join(f.root,'b.md'),join(f.root,'c.md'));f.owners.delete('b.md');f.owners.set('c.md',b);
    const next=await f.reader.readLifecycleProof('c.md');assert.equal(next.version.sha256,prior.version.sha256);
    assert.equal((await f.owner.admitLiveTransition({event:{sequence:2,kind:'rename'},owner:b,sourceId:'b.md',destinationId:'c.md',current:()=>true})).outcome,'admitted');
    assert.equal(f.tracker.lifecycleState(f.context,b,next),'verified-new');
    const entries=f.tracker.exportCommittedLifecycleEvidence(f.context)!.entries;
    assert.deepEqual(entries,[existing,{sourceId:'b.md',state:'deleted'},{sourceId:'c.md',state:'verified-new',origin:'native-create',originVersionId:prior.version.versionId,proof:next}]);
    await f.owner.close();const ledger=await f.open();try{
      assert.deepEqual((await ledger.read())?.snapshot.entries,entries);
      const tracker=new NewMaterialTracker<object>(),context={...f.context,session:{}};
      assert.equal(tracker.openLifecycle(context),true);
      assert.equal(await tracker.restoreCommittedLifecycle(context,ledger,f.reader,{signal:new AbortController().signal,current:()=>true,resolveNativeOwner:path=>f.owners.get(path)??null}),true);
      assert.equal(tracker.lifecycleState(context,b,next),'verified-new');assert.deepEqual(tracker.exportCommittedLifecycleEvidence(context)?.entries,entries);
    }finally{await ledger.close();}
  });
});

test('same-byte replacement and occupied rename targets retire without durable change',async()=>{
  for(const kind of ['replacement','collision'] as const)await fixture('fresh',async f=>{
    const baseline=await f.owner.prepareBaselinePreview();assert.ok(baseline.ok);
    assert.equal((await f.owner.confirmBaselinePreview(baseline.preview)).outcome,'admitted');
    const a=f.owners.get('a.md')!;let revision=1;
    if(kind==='replacement'){
      await writeFile(join(f.root,'replacement.md'),'synthetic original');await rename(join(f.root,'replacement.md'),join(f.root,'a.md'));
      assert.equal((await f.owner.admitLiveTransition({event:{sequence:1,kind:'modify'},owner:a,sourceId:'a.md',current:()=>true})).outcome,'denied');
    }else{
      const b={};await writeFile(join(f.root,'b.md'),'other');f.owners.set('b.md',b);
      assert.equal((await f.owner.admitLiveTransition({event:{sequence:1,kind:'create'},owner:b,sourceId:'b.md',current:()=>true})).outcome,'admitted');revision++;
      await rename(join(f.root,'a.md'),join(f.root,'b.md'));f.owners.delete('a.md');f.owners.set('b.md',a);
      assert.equal((await f.owner.admitLiveTransition({event:{sequence:2,kind:'rename'},owner:a,sourceId:'a.md',destinationId:'b.md',current:()=>true})).outcome,'denied');
    }
    await f.owner.close();const ledger=await f.open();try{assert.equal((await ledger.read())?.snapshot.revision,revision);}finally{await ledger.close();}
  });
});
