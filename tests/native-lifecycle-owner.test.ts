import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BoundedVaultReader, privateIndexPath } from '../plugin/src/standalone/source';
import { BOUNDS, hash } from '../plugin/src/standalone/contracts';
import { DurableLifecycleLedger } from '../plugin/src/ai/lifecycle-ledger';
import { NewMaterialTracker, type LifecycleContext } from '../plugin/src/ai/new-material-tracker';
import { NativeLifecycleOwner } from '../plugin/src/ai/native-lifecycle-owner';

test('native owner restores only committed evidence, synchronously retires on event, and drains its ledger', async () => {
  const base=await mkdtemp(join(tmpdir(),'oks-native-owner-'));
  const prior=process.env.XDG_DATA_HOME;
  try {
    const root=join(base,'vault'),xdg=join(base,'xdg');
    await mkdir(root,{mode:0o700}); await mkdir(xdg,{mode:0o700});
    process.env.XDG_DATA_HOME=xdg;
    await writeFile(join(root,'a.md'),'synthetic lifecycle source');
    const reader=await BoundedVaultReader.open(root,()=>['a.md']);
    const proof=await reader.readLifecycleProof('a.md');
    const ledger=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},'oks-native-owner-test');
    const initial=await ledger.initializeEmptyEpoch();
    await ledger.commit(initial.anchor.snapshotSha256,true,[{sourceId:'a.md',state:'existing',origin:'baseline',originVersionId:proof.version.versionId,proof}]);
    await ledger.close();

    const file={},tracker=new NewMaterialTracker<object>(),owner=new NativeLifecycleOwner(tracker);
    const context:LifecycleContext={rootId:reader.rootId,scopeId:reader.rootId,rulesRevision:hash('rules'),host:{},session:{}};
    await owner.start({context,reader,rootPath:root,pluginId:'oks-native-owner-test',current:()=>true,
      resolveNativeOwner:path=>path==='a.md'?file:null});
    assert.equal(owner.exactAuthorityActive(),true);
    assert.equal(tracker.lifecycleState(context,file,proof),'existing');
    owner.retire();
    assert.equal(owner.exactAuthorityActive(),false);
    assert.equal(tracker.lifecycleState(context,file,proof),'unresolved');
    await owner.close();

    const reopened=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},'oks-native-owner-test');
    assert.equal((await reopened.read())?.snapshot.entries.length,1);
    await reopened.close();
  } finally {
    if(prior===undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME=prior;
    await rm(base,{recursive:true,force:true});
  }
});

test('native owner does not initialize an empty ledger or fall back to lifecycle authority', async () => {
  const base=await mkdtemp(join(tmpdir(),'oks-native-empty-'));
  const prior=process.env.XDG_DATA_HOME;
  try {
    const root=join(base,'vault'),xdg=join(base,'xdg');
    await mkdir(root,{mode:0o700}); await mkdir(xdg,{mode:0o700});
    process.env.XDG_DATA_HOME=xdg;
    const reader=await BoundedVaultReader.open(root,()=>[]);
    const tracker=new NewMaterialTracker<object>(),owner=new NativeLifecycleOwner(tracker);
    const context:LifecycleContext={rootId:reader.rootId,scopeId:reader.rootId,rulesRevision:hash('rules'),host:{},session:{}};
    await owner.start({context,reader,rootPath:root,pluginId:'oks-native-empty-test',current:()=>true,resolveNativeOwner:()=>null});
    assert.equal(owner.exactAuthorityActive(),false);
    assert.equal((await owner.observeCommittedLifecycle([{sourceId:'a.md',expectedSha256:hash('a')}])).ok,false);
    await owner.close();
    const ledger=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},'oks-native-empty-test');
    assert.equal(await ledger.read(),null);
    await ledger.close();
  } finally {
    if(prior===undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME=prior;
    await rm(base,{recursive:true,force:true});
  }
});


test('native owner retires an in-flight restore permanently; concurrent closes share its physical drain', {timeout:5000}, async()=>{
  const base=await mkdtemp(join(tmpdir(),'oks-native-cancel-'));
  const prior=process.env.XDG_DATA_HOME;
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;const reading=new Promise<void>(resolve=>{entered=resolve;});
  let owner:NativeLifecycleOwner<object>|undefined;
  try{
    const root=join(base,'vault'),xdg=join(base,'xdg');
    await mkdir(root,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
    await writeFile(join(root,'a.md'),'synthetic');
    const reader=await BoundedVaultReader.open(root,()=>['a.md']);const proof=await reader.readLifecycleProof('a.md');
    const seed=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},'oks-native-cancel');
    try{const initial=await seed.initializeEmptyEpoch();await seed.commit(initial.anchor.snapshotSha256,true,[{sourceId:'a.md',state:'existing',origin:'baseline',originVersionId:proof.version.versionId,proof}]);}finally{await seed.close();}
    const tracker=new NewMaterialTracker<object>(),file={};owner=new NativeLifecycleOwner(tracker);
    const context:LifecycleContext={rootId:reader.rootId,scopeId:reader.rootId,rulesRevision:hash('rules'),host:{},session:{}};
    const read=reader.readLifecycleProof.bind(reader);
    reader.readLifecycleProof=async path=>{entered();await gate;return read(path);};
    const startup=owner.start({context,reader,rootPath:root,pluginId:'oks-native-cancel',current:()=>true,resolveNativeOwner:()=>file});
    await reading;owner.retire();const close=owner.close();assert.equal(owner.close(),close);
    assert.equal(tracker.lifecycleState(context,file,proof),'unresolved');
    let drained=false;void close.then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
    release();await startup;await close;assert.equal(owner.exactAuthorityActive(),false);
    assert.equal(tracker.lifecycleState(context,file,proof),'unresolved');
    const reopened=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},'oks-native-cancel');await reopened.close();
  }finally{release();await owner?.close();if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;await rm(base,{recursive:true,force:true});}
});

test('native owner does not admit a same-byte replacement or resurrect after a transient native fence loss',async()=>{
  const base=await mkdtemp(join(tmpdir(),'oks-native-replace-'));const prior=process.env.XDG_DATA_HOME;
  let owner:NativeLifecycleOwner<object>|undefined;
  try{
    const root=join(base,'vault'),xdg=join(base,'xdg');await mkdir(root,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
    await writeFile(join(root,'a.md'),'synthetic');const reader=await BoundedVaultReader.open(root,()=>['a.md']);const proof=await reader.readLifecycleProof('a.md');
    const seed=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},'oks-native-replace');
    try{const initial=await seed.initializeEmptyEpoch();await seed.commit(initial.anchor.snapshotSha256,true,[{sourceId:'a.md',state:'existing',origin:'baseline',originVersionId:proof.version.versionId,proof}]);}finally{await seed.close();}
    await writeFile(join(root,'replacement.md'),'synthetic');await rename(join(root,'replacement.md'),join(root,'a.md'));
    const replaced=await reader.readLifecycleProof('a.md');assert.equal(replaced.version.sha256,proof.version.sha256);assert.notEqual(replaced.version.versionId,proof.version.versionId);
    const tracker=new NewMaterialTracker<object>(),file={};owner=new NativeLifecycleOwner(tracker);
    const context:LifecycleContext={rootId:reader.rootId,scopeId:reader.rootId,rulesRevision:hash('rules'),host:{},session:{}};
    let current=true;await owner.start({context,reader,rootPath:root,pluginId:'oks-native-replace',current:()=>current,resolveNativeOwner:()=>file});
    assert.equal(owner.exactAuthorityActive(),true);assert.equal(tracker.lifecycleState(context,file,replaced),'unresolved');
    current=false;assert.equal(owner.exactAuthorityActive(),false);current=true;assert.equal(owner.exactAuthorityActive(),false);
    await owner.close();
  }finally{await owner?.close();if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;await rm(base,{recursive:true,force:true});}
});

test('native owner returns only fresh immutable admitted evidence and denies stale or replacement versions',async()=>{
  const base=await mkdtemp(join(tmpdir(),'oks-native-observe-'));const prior=process.env.XDG_DATA_HOME;
  let owner:NativeLifecycleOwner<object>|undefined;
  try{
    const root=join(base,'vault'),xdg=join(base,'xdg');await mkdir(root,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
    await writeFile(join(root,'a.md'),'a');await writeFile(join(root,'b.md'),'b');
    const reader=await BoundedVaultReader.open(root,()=>['a.md','b.md']);const a=await reader.readLifecycleProof('a.md'),b=await reader.readLifecycleProof('b.md');
    const seed=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},'oks-native-observe');
    try{const initial=await seed.initializeEmptyEpoch();await seed.commit(initial.anchor.snapshotSha256,true,[
      {sourceId:'a.md',state:'existing',origin:'baseline',originVersionId:a.version.versionId,proof:a},
      {sourceId:'b.md',state:'existing',origin:'baseline',originVersionId:b.version.versionId,proof:b},
    ]);}finally{await seed.close();}
    const tracker=new NewMaterialTracker<object>(),aOwner={},bOwner={};owner=new NativeLifecycleOwner(tracker);
    const context:LifecycleContext={rootId:reader.rootId,scopeId:reader.rootId,rulesRevision:hash('rules'),host:{},session:{}};
    await owner.start({context,reader,rootPath:root,pluginId:'oks-native-observe',current:()=>true,
      resolveNativeOwner:path=>path==='a.md'?aOwner:path==='b.md'?bOwner:null});
    const request=[{sourceId:'a.md',expectedSha256:a.version.sha256},{sourceId:'b.md',expectedSha256:b.version.sha256}];
    const pending=owner.observeCommittedLifecycle(request);request[0]!.expectedSha256=hash('mutated');
    const result=await pending;
    assert.equal(result.ok,true);if(result.ok){assert.equal(Object.isFrozen(result.observations),true);assert.equal(result.observations.length,2);
      assert.deepEqual(result.observations.map(x=>[x.sourceId,x.state,x.origin,x.originVersionId]),
        [['a.md','existing','baseline',a.version.versionId],['b.md','existing','baseline',b.version.versionId]]);
      assert.equal(result.observations[0]!.proof.version.versionId,a.version.versionId);
      assert.ok(Object.isFrozen(result.observations[0]!.proof.version));}
    assert.equal((await owner.observeCommittedLifecycle([{sourceId:'b.md',expectedSha256:b.version.sha256},{sourceId:'a.md',expectedSha256:a.version.sha256}])).ok,false);
    assert.equal((await owner.observeCommittedLifecycle([{sourceId:'a.md',expectedSha256:'0'.repeat(64)}])).ok,false);
    for(const invalid of [[],[null],[{sourceId:'../a.md',expectedSha256:a.version.sha256}],
      [{sourceId:'a.md',expectedSha256:a.version.sha256},{sourceId:'a.md',expectedSha256:a.version.sha256}],
      [{sourceId:'z.md',expectedSha256:hash('z')}],Array(BOUNDS.sources+1).fill({sourceId:'a.md',expectedSha256:a.version.sha256})])
      assert.equal((await owner.observeCommittedLifecycle(invalid as never)).ok,false);
    await writeFile(join(root,'replacement.md'),'a');await rename(join(root,'replacement.md'),join(root,'a.md'));
    assert.equal((await owner.observeCommittedLifecycle([{sourceId:'a.md',expectedSha256:a.version.sha256}])).ok,false);
    assert.equal(owner.exactAuthorityActive(),true);await owner.close();
  }finally{await owner?.close();if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;await rm(base,{recursive:true,force:true});}
});

test('native observation reserves the owner slot and close drains its physical read', {timeout:5000},async()=>{
  const base=await mkdtemp(join(tmpdir(),'oks-native-observe-drain-'));const prior=process.env.XDG_DATA_HOME;
  let owner:NativeLifecycleOwner<object>|undefined;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;const reading=new Promise<void>(resolve=>{entered=resolve;});
  try{
    const root=join(base,'vault'),xdg=join(base,'xdg');await mkdir(root,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
    await writeFile(join(root,'a.md'),'a');const reader=await BoundedVaultReader.open(root,()=>['a.md']);const proof=await reader.readLifecycleProof('a.md');
    const seed=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},'oks-native-observe-drain');
    try{const initial=await seed.initializeEmptyEpoch();await seed.commit(initial.anchor.snapshotSha256,true,[{sourceId:'a.md',state:'existing',origin:'baseline',originVersionId:proof.version.versionId,proof}]);}finally{await seed.close();}
    const tracker=new NewMaterialTracker<object>(),file={};owner=new NativeLifecycleOwner(tracker);
    const context:LifecycleContext={rootId:reader.rootId,scopeId:reader.rootId,rulesRevision:hash('rules'),host:{},session:{}};
    await owner.start({context,reader,rootPath:root,pluginId:'oks-native-observe-drain',current:()=>true,resolveNativeOwner:()=>file});
    const read=reader.readLifecycleProof.bind(reader);let delayed=true;reader.readLifecycleProof=async path=>{if(delayed){delayed=false;entered();await gate;}return read(path);};
    const observing=owner.observeCommittedLifecycle([{sourceId:'a.md',expectedSha256:proof.version.sha256}]);await reading;
    assert.equal((await owner.observeCommittedLifecycle([{sourceId:'a.md',expectedSha256:proof.version.sha256}])).ok,false);
    const close=owner.close();let drained=false;void close.then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
    release();assert.equal((await observing).ok,false);await close;
  }finally{release();await owner?.close();if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;await rm(base,{recursive:true,force:true});}
});

for(const fault of ['accessor-reentry','host-reentry','owner','host','ledger','missing','ambiguous','deleted'] as const)
test('native observation denies '+fault+' without partial publication',async()=>{
  const base=await mkdtemp(join(tmpdir(),'oks-native-observe-fault-')),prior=process.env.XDG_DATA_HOME;
  const root=join(base,'vault'),xdg=join(base,'xdg'),pluginId='oks-native-observe-fault';
  let owner:NativeLifecycleOwner<object>|undefined;
  try{
    await mkdir(root,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
    await writeFile(join(root,'a.md'),'a');await writeFile(join(root,'b.md'),'b');
    const reader=await BoundedVaultReader.open(root,()=>['a.md','b.md']);
    const a=await reader.readLifecycleProof('a.md'),b=await reader.readLifecycleProof('b.md');
    const seed=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},pluginId);
    try{
      const initial=await seed.initializeEmptyEpoch();
      await seed.commit(initial.anchor.snapshotSha256,true,[
        {sourceId:'a.md',state:'existing',origin:'baseline',originVersionId:a.version.versionId,proof:a},
        fault==='ambiguous'||fault==='deleted'?{sourceId:'b.md',state:fault}:
          {sourceId:'b.md',state:'verified-new',origin:'native-create',originVersionId:b.version.versionId,proof:b},
      ]);
    }finally{await seed.close();}
    const tracker=new NewMaterialTracker<object>(),aOwner={},bOwner={};owner=new NativeLifecycleOwner(tracker);
    const context:LifecycleContext={rootId:reader.rootId,scopeId:reader.rootId,rulesRevision:hash('rules'),host:{},session:{}};
    const request=[{sourceId:'a.md',expectedSha256:a.version.sha256},{sourceId:'b.md',expectedSha256:b.version.sha256}];
    let live=true,actualB=bOwner,reenter=false,nested:ReturnType<typeof owner.observeCommittedLifecycle>|undefined;
    await owner.start({context,reader,rootPath:root,pluginId,current:()=>{
      if(reenter){reenter=false;nested=owner!.observeCommittedLifecycle(request);}
      return live;
    },resolveNativeOwner:path=>path==='a.md'?aOwner:path==='b.md'?actualB:null});
    assert.equal(owner.exactAuthorityActive(),true);
    if(fault==='owner')actualB={};
    if(fault==='host')live=false;
    if(fault==='ledger')await writeFile(join(dirname(privateIndexPath(root,reader.rootId,pluginId)),'lifecycle-authority','CURRENT'),'tampered',{mode:0o600});
    if(fault==='missing')await rm(join(root,'b.md'));
    if(fault==='host-reentry')reenter=true;
    const input=fault==='accessor-reentry'?[{get sourceId(){nested=owner!.observeCommittedLifecycle(request);return 'a.md';},expectedSha256:a.version.sha256},request[1]!]:request;
    const result=await owner.observeCommittedLifecycle(input);
    assert.equal(result.ok,false);assert.equal('observations' in result,false);
    if(nested)assert.equal((await nested).ok,false);
    if(fault==='accessor-reentry'||fault==='host-reentry'||fault==='ledger'||fault==='host')assert.equal(owner.exactAuthorityActive(),false);
    await owner.close();
    if(fault!=='ledger'){
      const reopened=await DurableLifecycleLedger.open({path:root,rootId:reader.rootId},pluginId);
      try{const state=await reopened.read();assert.equal(state?.snapshot.revision,1);assert.equal(state?.snapshot.entries.length,2);}
      finally{await reopened.close();}
    }
  }finally{await owner?.close();if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;await rm(base,{recursive:true,force:true});}
});
