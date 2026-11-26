import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedVaultReader } from '../plugin/src/standalone/source';
import { hash } from '../plugin/src/standalone/contracts';
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
