import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, unlink, chmod, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { BoundedVaultReader, privateIndexPath } from '../plugin/src/standalone/source';
import { BOUNDS, hash } from '../plugin/src/standalone/contracts';
import { DurableLifecycleLedger } from '../plugin/src/ai/lifecycle-ledger';
import { canonical } from '../plugin/src/advanced/protocol';
import type { LedgerEntry } from '../plugin/src/ai/lifecycle-ledger-schema';

const pluginId='oks-ledger-test',error={code:'LIFECYCLE_LEDGER_UNAVAILABLE'};
async function fixture(action:(f:{root:{path:string;rootId:string};anchor:string;data:string;
    open:()=>Promise<DurableLifecycleLedger>;entry:(name?:string)=>Promise<LedgerEntry>})=>Promise<void>){
  const base=await mkdtemp(join(tmpdir(),'oks-ledger-')),prior=process.env.XDG_DATA_HOME;
  const path=join(base,'vault'),xdg=join(base,'xdg');
  const stores:DurableLifecycleLedger[]=[];
  try{
    await mkdir(path,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
    await writeFile(join(path,'a.md'),'synthetic');
    const reader=await BoundedVaultReader.open(path,()=>['a.md']);
    const root={path,rootId:reader.rootId},parent=dirname(privateIndexPath(path,root.rootId,pluginId));
    await action({root,anchor:join(parent,'lifecycle-authority'),data:join(parent,'lifecycle-ledger'),
      open:async()=>{const store=await DurableLifecycleLedger.open(root,pluginId);stores.push(store);return store;},
      entry:async(name='a.md')=>{
        const proof=await reader.readLifecycleProof(name);
        return {sourceId:name,state:'verified-new',origin:'native-create',originVersionId:proof.version.versionId,proof};
      }});
  }finally{
    await Promise.all(stores.map(s=>s.close()));
    if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(base,{recursive:true,force:true});
  }
}
test('durable ledger is explicit, exact, immutable, bounded and exclusive across reopen',async()=>{
  await fixture(async f=>{
    const a=await f.open();assert.equal(await a.read(),null);
    await assert.rejects(f.open(),error);
    const first=await a.initializeEmptyEpoch();assert.equal(first.snapshot.revision,0);
    const entry=await f.entry();
    const pending=a.commit(first.anchor.snapshotSha256,false,[entry]);
    (entry as {originVersionId:string}).originVersionId=hash('mutated after invocation');
    const second=await pending;
    assert.equal(second.snapshot.revision,1);assert.equal(second.snapshot.previous,first.anchor.snapshotSha256);
    assert.notEqual((second.snapshot.entries[0] as {originVersionId:string}).originVersionId,hash('mutated after invocation'));
    assert.ok(Object.isFrozen(second.snapshot.entries[0]));
    assert.equal((await readdir(f.data)).length,1);
    await a.close();await assert.rejects(a.read(),error);
    const b=await f.open();assert.deepEqual(await b.read(),second);
    await assert.rejects(b.commit(first.anchor.snapshotSha256,false,[]),error);
    await assert.rejects(b.read(),error);
    await b.close();const c=await f.open();assert.deepEqual(await c.read(),second);
    await assert.rejects(c.initializeEmptyEpoch(),error);
  });
});
test('stale/replayed or tampered snapshot never replaces trusted current anchor',async()=>{
  await fixture(async f=>{
    const a=await f.open(),first=await a.initializeEmptyEpoch();
    const oldBytes=await readFile(join(f.data,first.anchor.snapshotSha256+'.json'));
    const second=await a.commit(first.anchor.snapshotSha256,false,[await f.entry()]);
    const current=join(f.data,second.anchor.snapshotSha256+'.json');
    const currentBytes=await readFile(current);
    await writeFile(current,oldBytes,{mode:0o600});
    await assert.rejects(a.read(),error);await a.close();await assert.rejects(f.open(),error);
    await writeFile(current,currentBytes,{mode:0o600});
    const b=await f.open();assert.deepEqual(await b.read(),second);await b.close();
    await unlink(current);await writeFile(join(f.data,first.anchor.snapshotSha256+'.json'),oldBytes,{mode:0o600});
    await assert.rejects(f.open(),error);
  });
});
test('valid anchor recovers only its current snapshot and discards bounded orphan/staged artifacts',async()=>{
  await fixture(async f=>{
    const a=await f.open(),first=await a.initializeEmptyEpoch();
    const old=await readFile(join(f.data,first.anchor.snapshotSha256+'.json'));
    const second=await a.commit(first.anchor.snapshotSha256,false,[await f.entry()]);
    await a.close();
    await writeFile(join(f.data,first.anchor.snapshotSha256+'.json'),old,{mode:0o600});
    await writeFile(join(f.anchor,'.stage-00000000-0000-0000-0000-000000000001'),'partial',{mode:0o600});
    const b=await f.open();assert.deepEqual(await b.read(),second);
    assert.deepEqual(await readdir(f.data),[second.anchor.snapshotSha256+'.json']);
    assert.deepEqual((await readdir(f.anchor)).sort(),['CURRENT','LOCK']);
    await b.close();await unlink(join(f.anchor,'CURRENT'));
    await assert.rejects(f.open(),error);
  });
});
test('strict schema rejects foreign root, duplicate/unsorted/oversize records and unsupported provenance',async()=>{
  await fixture(async f=>{
    const a=await f.open(),first=await a.initializeEmptyEpoch(),entry=await f.entry();
    const digest=first.anchor.snapshotSha256;
    const invalid:readonly LedgerEntry[][]=[
      [entry,entry],
      [{sourceId:'z.md',state:'deleted'},{sourceId:'a.md',state:'deleted'}],
      Array.from({length:BOUNDS.sources+1},(_,i)=>({sourceId:i+'.md',state:'deleted'})),
      [{...entry,origin:'import'} as never],
      [{...entry,state:'existing',origin:'baseline'} as never],
      [{...entry,proof:{...(entry as {proof:object}).proof,version:{rootId:hash('foreign'),sourceId:'a.md',sha256:hash('x'),versionId:hash('y')}}} as never],
    ];
    for(const entries of invalid)await assert.rejects(a.commit(digest,false,entries),error);
    assert.deepEqual(await a.read(),first);
    await a.close();
    // Even a self-consistent snapshot/anchor with wrong root is rejected.
    const foreign={...first.snapshot,rootId:hash('foreign')},bytes=Buffer.from(canonical(foreign)),sha=hash(bytes);
    await writeFile(join(f.data,sha+'.json'),bytes,{mode:0o600});
    await writeFile(join(f.anchor,'CURRENT'),canonical({...first.anchor,rootId:hash('foreign'),snapshotSha256:sha}),{mode:0o600});
    await assert.rejects(f.open(),error);
  });
});
test('unsafe links, permissions, lock replacement and unexpected artifacts deny',async()=>{
  await fixture(async f=>{
    const a=await f.open(),first=await a.initializeEmptyEpoch();await a.close();
    const file=join(f.data,first.anchor.snapshotSha256+'.json');
    await chmod(file,0o644);await assert.rejects(f.open(),error);await chmod(file,0o600);
    const alias=join(f.data,hash('alias')+'.json');
    await link(file,alias);await assert.rejects(f.open(),error);await unlink(alias);
    await symlink(file,alias);await assert.rejects(f.open(),error);await unlink(alias);
    await writeFile(join(f.data,'unexpected'),'x',{mode:0o600});await assert.rejects(f.open(),error);await unlink(join(f.data,'unexpected'));
    const b=await f.open();
    await rename(join(f.anchor,'LOCK'),join(f.anchor,'old-lock'));
    await writeFile(join(f.anchor,'LOCK'),'',{mode:0o600});
    await assert.rejects(b.read(),error);await b.close();await assert.rejects(f.open(),error);
  });
});
test('kernel lock held by independent process is released by process death, not a stale timestamp',async()=>{
  await fixture(async f=>{
    const a=await f.open();await a.initializeEmptyEpoch();await a.close();
    let child:ChildProcess|undefined;
    try{
      child=spawn(process.execPath,['-e',`
        const fs=require('node:fs'),cp=require('node:child_process');
        const fd=fs.openSync(process.argv[1],'r+');
        const r=cp.spawnSync('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',fd]});
        if(r.status!==0)process.exit(2);process.stdout.write('locked\\n');setInterval(()=>{},1000);
      `,join(f.anchor,'LOCK')],{stdio:['ignore','pipe','ignore'],env:{PATH:'/usr/bin:/bin'}});
      const ready=Promise.race([once(child.stdout!,'data'),once(child,'exit').then(()=>{throw Error('lock child exited');})]);
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('lock child timeout')),3000);})]);}
      finally{clearTimeout(timer);}
      await assert.rejects(f.open(),error);
      const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;
      const b=await f.open();assert.ok(await b.read());
    }finally{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
  });
});
test('close drains current operation before releasing lock; root replacement denies',async()=>{
  await fixture(async f=>{
    const a=await f.open(),first=await a.initializeEmptyEpoch(),entry=await f.entry();
    const pending=a.commit(first.anchor.snapshotSha256,false,[entry]);
    const closing=a.close();await assert.rejects(a.read(),error);
    await pending;await closing;
    const b=await f.open();assert.equal((await b.read())?.snapshot.revision,1);
    await rename(f.root.path,f.root.path+'-moved');await mkdir(f.root.path,{mode:0o700});
    await assert.rejects(b.read(),error);await b.close();await assert.rejects(f.open(),error);
  });
});
test('publication interruption before or after atomic anchor switch recovers exactly the committed revision',async t=>{
  const fs=require('node:fs/promises') as typeof import('node:fs/promises');
  const original=fs.rename;
  for(const switched of [false,true]){
    await fixture(async f=>{
      const a=await f.open(),first=await a.initializeEmptyEpoch(),entry=await f.entry();
      let injected=false;
      const mock=t.mock.method(fs,'rename',async(from:Parameters<typeof fs.rename>[0],to:Parameters<typeof fs.rename>[1])=>{
        if(!String(to).endsWith('/CURRENT'))return original(from,to);
        if(switched)await original(from,to);
        injected=true;throw Error('synthetic interruption');
      });
      try{
        await assert.rejects(a.commit(first.anchor.snapshotSha256,false,[entry]),error);
        assert.ok(injected);
        await assert.rejects(a.read(),error);
      }finally{mock.mock.restore();}
      await a.close();
      const b=await f.open(),loaded=await b.read();
      assert.equal(loaded?.snapshot.revision,switched?1:0);
      assert.deepEqual(loaded?.snapshot.entries,switched?[entry]:[]);
      assert.equal((await readdir(f.data)).length,1);
      assert.deepEqual((await readdir(f.anchor)).sort(),['CURRENT','LOCK']);
    });
  }
});
test('unsafe ancestor, missing/corrupt anchor and artifact overflow deny recovery',async()=>{
  await fixture(async f=>{
    const a=await f.open(),first=await a.initializeEmptyEpoch();await a.close();
    const parent=dirname(f.anchor);
    const info=await import('node:fs/promises').then(fs=>fs.stat(parent));
    await chmod(parent,0o777);
    await assert.rejects(f.open(),error);
    await chmod(parent,info.mode&0o777);
    const anchor=join(f.anchor,'CURRENT'),bytes=await readFile(anchor);
    await writeFile(anchor,Buffer.concat([bytes,Buffer.from('\n')]));
    await assert.rejects(f.open(),error);
    await writeFile(anchor,bytes);
    for(let i=0;i<8;i++)await writeFile(join(f.data,hash('orphan'+i)+'.json'),'partial',{mode:0o600});
    await assert.rejects(f.open(),error);
    for(let i=0;i<8;i++)await unlink(join(f.data,hash('orphan'+i)+'.json'));
    const b=await f.open();assert.deepEqual(await b.read(),first);
  });
});

/** POLICY.2e3d.2a: synthetic guarded durable publication, not host admission. */
function baseline(entry:LedgerEntry):LedgerEntry{
  if(!('proof' in entry))throw Error('expected synthetic original');
  return {...entry,state:'existing',origin:'baseline',originVersionId:entry.proof.version.versionId};
}
function baselineGuard(signal=new AbortController().signal){
  return {signal,revalidate:async()=>true,current:()=>true};
}
test('guarded initial baseline publishes captured exact records once and reopens',async()=>{
  await fixture(async f=>{
    const a=await f.open(),first=await a.initializeEmptyEpoch();
    const original=baseline(await f.entry());if(!('proof' in original))throw Error('expected proof');
    const expected=original,entry={...original,proof:{...original.proof,version:{...original.proof.version}}},
      entries=[entry],guard=baselineGuard();
    const pending=a.commitInitialBaseline(first.anchor.snapshotSha256,entries,guard);
    entries.length=0;
    (entry.proof.version as {versionId:string}).versionId=hash('mutated nested proof after invocation');
    guard.current=()=>false;
    const committed=await pending;
    assert.equal(committed.snapshot.baselineAdmitted,true);
    assert.deepEqual(committed.snapshot.entries,[expected]);
    assert.ok(Object.isFrozen(committed.snapshot.entries[0]));
    await assert.rejects(a.commitInitialBaseline(committed.anchor.snapshotSha256,[],baselineGuard()),error);
    await a.close();const b=await f.open();assert.deepEqual(await b.read(),committed);
  });
});
test('guarded baseline denies nonpristine history, stale CAS and nonbaseline records',async()=>{
  await fixture(async f=>{
    const a=await f.open(),first=await a.initializeEmptyEpoch(),entry=await f.entry();
    for(const entries of [[entry],[{sourceId:'a.md',state:'deleted'} as const],
      [{...baseline(entry),originVersionId:hash('wrong origin')} as LedgerEntry]]){
      await assert.rejects(a.commitInitialBaseline(first.anchor.snapshotSha256,entries,baselineGuard()),error);
    }
    assert.deepEqual(await a.read(),first);
    await assert.rejects(a.commitInitialBaseline(hash('stale'),[],baselineGuard()),error);
    await a.close();
    const b=await f.open(),next=await b.commit(first.anchor.snapshotSha256,false,[entry]);
    await assert.rejects(b.commitInitialBaseline(next.anchor.snapshotSha256,[],baselineGuard()),error);
    await b.close();const c=await f.open();assert.deepEqual(await c.read(),next);
  });
});
test('guarded baseline denies uncommitted initialization and preaborted confirmation',async()=>{
  await fixture(async f=>{
    const a=await f.open();
    await assert.rejects(a.commitInitialBaseline(hash('missing'),[],baselineGuard()),error);
    await a.close();
    const b=await f.open();assert.equal(await b.read(),null);
    const first=await b.initializeEmptyEpoch();
    const abort=new AbortController();abort.abort();
    await assert.rejects(b.commitInitialBaseline(first.anchor.snapshotSha256,[],baselineGuard(abort.signal)),error);
    await b.close();const c=await f.open();assert.deepEqual(await c.read(),first);
  });
});
test('guarded baseline denial after staging never promotes candidate on reopen',async()=>{
  for(const kind of ['revalidate-false','revalidate-throw','abort','owner-false','owner-throw','owner-abort','owner-close']){
    await fixture(async f=>{
      const a=await f.open(),first=await a.initializeEmptyEpoch(),abort=new AbortController();
      const entry=baseline(await f.entry());let calls=0,revalidated=false;
      const guard={signal:abort.signal,revalidate:async()=>{
        revalidated=true;
        assert.ok((await readdir(f.anchor)).some(n=>n.startsWith('.stage-')));
        if(kind==='revalidate-throw')throw Error('synthetic invalidation');
        if(kind==='abort')abort.abort();
        return kind!=='revalidate-false';
      },current:()=>{
        calls++;
        if(revalidated&&calls>=4){
          if(kind==='owner-false')return false;
          if(kind==='owner-throw')throw Error('synthetic owner lost');
          if(kind==='owner-abort')abort.abort();
          if(kind==='owner-close')void a.close();
        }
        return true;
      }};
      await assert.rejects(a.commitInitialBaseline(first.anchor.snapshotSha256,[entry],guard),error,kind);
      assert.ok(revalidated);
      assert.equal((await readFile(join(f.anchor,'CURRENT'),'utf8')),canonical(first.anchor));
      await a.close();const b=await f.open();assert.deepEqual(await b.read(),first);
      assert.deepEqual(await readdir(f.data),[first.anchor.snapshotSha256+'.json']);
    });
  }
});
test('guarded baseline close during revalidation retains exclusive lock until operation drains',async()=>{
  await fixture(async f=>{
    const a=await f.open(),first=await a.initializeEmptyEpoch(),entry=baseline(await f.entry());
    let ready!:()=>void,release!:(ok:boolean)=>void;
    const entered=new Promise<void>(r=>{ready=r;});
    const suspended=new Promise<boolean>(r=>{release=r;});
    const pending=a.commitInitialBaseline(first.anchor.snapshotSha256,[entry],
      {...baselineGuard(),revalidate:()=>{ready();return suspended;}});
    try{
      await entered;
      const closing=a.close();
      await assert.rejects(f.open(),error);
      await assert.rejects(a.read(),error);
      release(true);
      await assert.rejects(pending,error);
      await closing;
      const b=await f.open();assert.deepEqual(await b.read(),first);
    }finally{release(false);await pending.catch(()=>{});}
  });
});
test('guarded baseline cancellation after synchronous anchor switch is after commit point',async t=>{
  const fs=require('node:fs') as typeof import('node:fs');
  await fixture(async f=>{
    const a=await f.open(),first=await a.initializeEmptyEpoch(),entry=baseline(await f.entry());
    const abort=new AbortController(),original=fs.renameSync;
    const mock=t.mock.method(fs,'renameSync',((from:import('node:fs').PathLike,to:import('node:fs').PathLike)=>{
      original(from,to);abort.abort();
    }) as typeof fs.renameSync);
    let committed;
    try{committed=await a.commitInitialBaseline(first.anchor.snapshotSha256,[entry],baselineGuard(abort.signal));}
    finally{mock.mock.restore();}
    assert.equal(abort.signal.aborted,true);
    assert.equal(committed.snapshot.baselineAdmitted,true);
    await a.close();const b=await f.open();assert.deepEqual(await b.read(),committed);
  });
});
test('guarded baseline interrupted at anchor switch recovers only trusted current revision',async t=>{
  const fs=require('node:fs') as typeof import('node:fs');
  for(const switched of [false,true]){
    await fixture(async f=>{
      const a=await f.open(),first=await a.initializeEmptyEpoch(),entry=baseline(await f.entry());
      const original=fs.renameSync;
      const mock=t.mock.method(fs,'renameSync',((from:import('node:fs').PathLike,to:import('node:fs').PathLike)=>{
        if(switched)original(from,to);
        throw Error('synthetic publication interruption');
      }) as typeof fs.renameSync);
      try{await assert.rejects(a.commitInitialBaseline(first.anchor.snapshotSha256,[entry],baselineGuard()),error);}
      finally{mock.mock.restore();}
      await assert.rejects(a.read(),error);await a.close();
      const b=await f.open(),recovered=await b.read();
      if(switched){
        assert.equal(recovered?.snapshot.baselineAdmitted,true);
        assert.deepEqual(recovered?.snapshot.entries,[entry]);
      }else assert.deepEqual(recovered,first);
    });
  }
});
