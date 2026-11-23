/** Durable 05D store adversarial tests. Mock unit vectors are NOT model-backed evidence. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm,readdir,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {readFileSync} from 'node:fs';
import {AdvancedRetrievalStore, type IndexedSource} from '../plugin/src/advanced/retrieval-storage';
import {AdvancedGenerationStore} from '../plugin/src/advanced/storage';
import {trustedVaultRoot} from '../plugin/src/advanced/source';
import {CHUNK_TOKENIZER_FINGERPRINT,ModelError,type ModelIdentity} from '../plugin/src/advanced/model-protocol';
const identity:ModelIdentity={...JSON.parse(readFileSync('benchmarks/embedding/results.json','utf8')).identity,
  effective_max_tokens:384,runtime_tokenizer_parity_verified:true};
const vector=()=>Array.from({length:1024},(_,i)=>i===0?1:0);
const entry=(path:string):IndexedSource=>({sourcePath:path,sourceSha256:'a'.repeat(64),
  ingestGenerationId:'b'.repeat(64),profileId:'oks-advanced-markdown-v1',
  tokenizerFingerprint:CHUNK_TOKENIZER_FINGERPRINT,
  chunkIds:['c'.repeat(64)],vectors:[vector()]});

test('v4 retrieval store: bounded atomic publish, real cold open, rejected corrupted pointer, no index inside Vault',async()=>{
  const root=await mkdtemp(join(tmpdir(),'oks05d-store-'));
  const vault=join(root,'vault'),xdg=join(root,'xdg'),prior=process.env.XDG_DATA_HOME;
  await mkdir(vault,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
  try{
    const trusted=await trustedVaultRoot(vault);
    const store=await AdvancedRetrievalStore.open(trusted,'oks-synthetic-evidence');
    assert.equal(store.snapshot(),null);
    const result=await store.publish(entry('a.md'),identity,async()=>{},new AbortController().signal);
    assert.equal(result.entries.length,1);
    const loaded=await AdvancedRetrievalStore.open(trusted,'oks-synthetic-evidence');
    assert.deepEqual(loaded.snapshot(),result);
    assert.ok(!store.path.startsWith(vault+'/'));
    const canceled=new AbortController();canceled.abort();
    await assert.rejects(store.publish(entry('b.md'),identity,async()=>{},canceled.signal),
      (e:unknown)=>e instanceof ModelError && e.code==='MODEL_CANCELLED');
    assert.equal((await AdvancedRetrievalStore.open(trusted,'oks-synthetic-evidence')).snapshot()?.entries.length,1);
    await assert.rejects(store.publish(entry('b.md'),{...identity,torch_version:'0.0.0'},
      async()=>{},new AbortController().signal));
    await writeFile(join(store.path,'CURRENT'),'{}\n',{mode:0o600});
    await assert.rejects(AdvancedRetrievalStore.open(trusted,'oks-synthetic-evidence'));
  }finally{
    if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(root,{recursive:true,force:true});
  }
});

test('05D remediation B1: cancellation during FINAL async guard forbids CURRENT and ready evidence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'oks05d-last-guard-'));
  const vault=join(root,'vault'),xdg=join(root,'xdg'),prior=process.env.XDG_DATA_HOME;
  await mkdir(vault,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
  try{
    const identityRoot=await trustedVaultRoot(vault);
    const store=await AdvancedRetrievalStore.open(identityRoot,'oks-synthetic-evidence');
    let checks=0;
    const abort=new AbortController();
    await assert.rejects(store.publish(entry('cancel.md'),identity,async()=>{
      if(++checks===3)abort.abort();
    },abort.signal),(e:unknown)=>e instanceof ModelError&&e.code==='MODEL_CANCELLED');
    assert.equal(checks,3,'abort must occur after the last awaited validation');
    assert.equal(store.snapshot(),null,'memory must not publish a canceled version');
    assert.ok(!(await readdir(store.path)).includes('CURRENT'),'durable pointer must not publish');
    const reopened=await AdvancedRetrievalStore.open(identityRoot,'oks-synthetic-evidence');
    assert.equal(reopened.snapshot(),null);
    const valid=await reopened.publish(entry('retry.md'),identity,async()=>{},
      new AbortController().signal);
    assert.equal(valid.entries.length,1);
  }finally{
    if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(root,{recursive:true,force:true});
  }
});

test('05D remediation B3: XDG ancestor symlinks and later swaps cannot write derived data into Vault',async()=>{
  const root=await mkdtemp(join(tmpdir(),'oks05d-ancestor-'));
  const vault=join(root,'vault'),xdg=join(root,'xdg'),prior=process.env.XDG_DATA_HOME;
  await mkdir(vault,{mode:0o700});
  process.env.XDG_DATA_HOME=xdg;
  try{
    const identityRoot=await trustedVaultRoot(vault);
    await symlink(vault,xdg,'dir');
    await assert.rejects(AdvancedRetrievalStore.open(identityRoot,'oks-synthetic-evidence'));
    await assert.rejects(AdvancedGenerationStore.open(identityRoot,'oks-synthetic-evidence'));
    assert.deepEqual(await readdir(vault),[], 'no derived directory created inside source Vault');
    await rm(xdg);
    await mkdir(xdg,{mode:0o700});
    const store=await AdvancedRetrievalStore.open(identityRoot,'oks-synthetic-evidence');
    await rename(xdg,join(root,'xdg-safe'));
    await symlink(vault,xdg,'dir');
    await assert.rejects(store.publish(entry('a.md'),identity,async()=>{},
      new AbortController().signal));
    assert.deepEqual(await readdir(vault),[],
      'ancestor substitution after a verified open must not redirect writes');
  }finally{
    if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(root,{recursive:true,force:true});
  }
});

test('v4 first publication cancellation leaves only recoverable derived orphans, never ready evidence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'oks05d-first-cancel-'));
  const vault=join(root,'vault'),xdg=join(root,'xdg'),prior=process.env.XDG_DATA_HOME;
  await mkdir(vault,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
  try{
    const identityRoot=await trustedVaultRoot(vault),pluginId='oks-synthetic-evidence';
    const store=await AdvancedRetrievalStore.open(identityRoot,pluginId);
    let checks=0;
    const cancelled=new AbortController();
    await assert.rejects(store.publish(entry('a.md'),identity,async()=>{
      if(++checks===2)cancelled.abort();
    },cancelled.signal),(e:unknown)=>e instanceof ModelError&&e.code==='MODEL_CANCELLED');
    assert.equal(checks,2);
    assert.equal(store.snapshot(),null,'canceled first commit must never become searchable');
    const orphanNames=await readdir(store.path);
    assert.equal(orphanNames.some(n=>n==='CURRENT'),false);
    assert.ok(orphanNames.some(n=>n.endsWith('.json')),'test must exercise crash-after-generation-rename');
    // Opening after power loss must authenticate and discard *only* derived orphan
    // bytes. It must not treat them as a published model index.
    const recovered=await AdvancedRetrievalStore.open(identityRoot,pluginId);
    assert.equal(recovered.snapshot(),null);
    assert.deepEqual(await readdir(recovered.path),[]);
    const after=await recovered.publish(entry('a.md'),identity,async()=>{},
      new AbortController().signal);
    assert.equal(after.entries.length,1);
    assert.deepEqual((await AdvancedRetrievalStore.open(identityRoot,pluginId)).snapshot(),after);
  }finally{
    if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(root,{recursive:true,force:true});
  }
});

test('v4 no-CURRENT recovery rejects forged or foreign orphan generations and symlinked stages',async()=>{
  const root=await mkdtemp(join(tmpdir(),'oks05d-forged-orphan-'));
  const vault=join(root,'vault'),xdg=join(root,'xdg'),prior=process.env.XDG_DATA_HOME;
  await mkdir(vault,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
  try{
    const trusted=await trustedVaultRoot(vault),pluginId='oks-synthetic-evidence';
    const store=await AdvancedRetrievalStore.open(trusted,pluginId);
    await store.publish(entry('a.md'),identity,async()=>{},new AbortController().signal);
    const names=await readdir(store.path);
    const generationName=names.find(n=>n.endsWith('.json'))!;
    // Removing CURRENT never makes evidence ready: only authenticated derived
    // generations can be discarded and a fresh model generation must be built.
    await rm(join(store.path,'CURRENT'));
    await writeFile(join(store.path,generationName),'forged',{mode:0o600});
    await assert.rejects(AdvancedRetrievalStore.open(trusted,pluginId));
    assert.ok((await readdir(store.path)).includes(generationName));
    await rm(join(store.path,generationName));
    const stage='.stage-01234567-89ab-4def-8abc-0123456789ab';
    await symlink('/etc/hosts',join(store.path,stage));
    await assert.rejects(AdvancedRetrievalStore.open(trusted,pluginId));
    assert.equal((await readdir(store.path)).includes(stage),true);
  }finally{
    if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(root,{recursive:true,force:true});
  }
});

test('v4 staged-file crash is recoverable; symlinked CURRENT and native folder revocation are fail-closed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'oks05d-crash-'));
  const vault=join(root,'vault'),xdg=join(root,'xdg'),prior=process.env.XDG_DATA_HOME;
  await mkdir(vault,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
  try{
    const trusted=await trustedVaultRoot(vault),pluginId='oks-synthetic-evidence';
    const store=await AdvancedRetrievalStore.open(trusted,pluginId);
    await store.publish(entry('a/file.md'),identity,async()=>{},new AbortController().signal);
    const original=store.snapshot();assert.ok(original);
    // Simulate a crash after writing an incomplete private staging file but
    // before the NEXT pointer was published. Authenticated previous CURRENT wins.
    await writeFile(join(store.path,'.stage-01234567-89ab-4def-8abc-0123456789ab'),'partial',{mode:0o600});
    const recovered=await AdvancedRetrievalStore.open(trusted,pluginId);
    assert.deepEqual(recovered.snapshot(),original);
    recovered.revoke('a');
    assert.equal(recovered.snapshot()?.entries.length,0);
    const path=join(store.path,'CURRENT');
    const untouched=await readFile(path);
    assert.ok(untouched.length>20);
    await rm(path);
    await symlink('/etc/hosts',path);
    await assert.rejects(AdvancedRetrievalStore.open(trusted,pluginId));
  }finally{
    if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(root,{recursive:true,force:true});
  }
});
