/** Durable 05D store adversarial tests. Mock unit vectors are NOT model-backed evidence. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {readFileSync} from 'node:fs';
import {AdvancedRetrievalStore, type IndexedSource} from '../plugin/src/advanced/retrieval-storage';
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
