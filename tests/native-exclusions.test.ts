import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BoundedVaultReader} from '../plugin/src/standalone/source';
import {captureNativeExclusions,type NativeExclusionPlatform} from '../plugin/src/search/native-exclusions';
import {captureHardSearchScope,HARD_SEARCH_SCOPE_VERSION} from '../plugin/src/standalone/hard-search-scope';

const supported:NativeExclusionPlatform={version:'1.15.1',desktop:true,linux:true};
function hostFixture(raw:unknown=null){
  let rules=raw,subscribers=new Set<()=>void>(),calls:string[]=[],retired=0;
  let result:(path:string)=>unknown=path=>path==='Control/one.md'||path==='exact.md-more.md'||path.endsWith('.pdf');
  const vault={
    getConfig:(key:string):unknown=>{assert.equal(key,'userIgnoreFilters');return rules;},
    on:(event:string,callback:()=>void):unknown=>{assert.equal(event,'config-changed');subscribers.add(callback);return callback;},
    offref:(ref:unknown)=>{subscribers.delete(ref as ()=>void);},
  };
  const compiled=():object[]|null=>Array.isArray(rules)?rules.map(()=>({})): null;
  const metadata={
    userIgnoreFilters:compiled(),
    isUserIgnored:(path:string):unknown=>{calls.push(path);return result(path);},
  };
  const host={vault,metadataCache:metadata};
  const notify=()=>{for(const callback of [...subscribers])callback();};
  return {host,vault,metadata,calls,notify,
    update:(next:unknown,emit=true)=>{rules=next;metadata.userIgnoreFilters=compiled();if(emit)notify();},
    raw:(next:unknown)=>{rules=next;},
    behavior:(next:(path:string)=>unknown)=>{result=next;},
    count:()=>retired,subscriptions:()=>subscribers.size,
    capture:(platform=supported,base?:ReturnType<typeof captureHardSearchScope>)=>captureNativeExclusions(host,platform,()=>{retired++;},base),
  };
}
test('native matching is delegated; exact scope narrows rather than overrides native rules',()=>{
  const f=hostFixture(['Control/','/\\.pdf$/','exact.md']);
  const base=captureHardSearchScope({version:HARD_SEARCH_SCOPE_VERSION,excludedFolders:['other'],excludedFiles:[]});
  const l=f.capture(supported,base);
  assert.equal(l.scope.hasExclusions,true);
  assert.equal(l.scope.allows('Control/one.md'),false);
  assert.equal(l.scope.allows('Control-old/visible.md'),true);
  assert.equal(l.scope.allows('exact.md-more.md'),false);
  assert.equal(l.scope.allows('doc.pdf'),false);
  assert.equal(l.scope.allows('other/visible.md'),false);
  assert.equal(l.scope.allows('../foreign.md'),false);
  assert.deepEqual(f.calls,['Control/one.md','Control-old/visible.md','exact.md-more.md','doc.pdf']);
  assert.ok(Object.isFrozen(l.scope)&&Object.isFrozen(l));
  l.dispose();assert.equal(f.subscriptions(),0);assert.equal(l.scope.current(),false);
});
test('verified native default absence and explicit empty are revocable, not unconditional allow',()=>{
  for(const raw of [null,[]]){
    const f=hostFixture(raw);f.behavior(()=>false);
    const l=f.capture();
    assert.equal(l.scope.hasExclusions,false);assert.equal(l.scope.current(),true);
    assert.equal(l.scope.allows('note.md'),true);
    f.update(['note.md']);f.update(raw);
    assert.equal(l.scope.current(),false);assert.equal(l.scope.allows('note.md'),false);
    assert.equal(f.count(),1);
    const fresh=f.capture();assert.notEqual(fresh.scope.revision,l.scope.revision);
    assert.equal(fresh.scope.allows('note.md'),true);
    l.dispose();fresh.dispose();assert.equal(f.subscriptions(),0);
  }
});
test('unsupported hosts and malformed or unobservable configuration fail closed',()=>{
  for(const platform of [{...supported,version:'1.15.2'},{...supported,desktop:false},{...supported,linux:false}]){
    const f=hostFixture();assert.throws(()=>f.capture(platform),/SEARCH_SCOPE_INVALID/);assert.equal(f.subscriptions(),0);
  }
  for(const raw of [{},'note.md',[42],Array(2),['bad\nrule'],['\ud800'],['a'.repeat(1025)],Array(257).fill('a'),Array(64).fill('x'.repeat(1024))]){
    const f=hostFixture(raw);
    assert.throws(()=>f.capture(),/SEARCH_SCOPE_INVALID/);assert.equal(f.subscriptions(),0);
  }
  const f=hostFixture();
  f.metadata.userIgnoreFilters=[{}];
  assert.throws(()=>f.capture(),/SEARCH_SCOPE_INVALID/);
  const malformed=hostFixture(['note.md']);
  malformed.metadata.userIgnoreFilters=[];
  assert.throws(()=>malformed.capture(),/SEARCH_SCOPE_INVALID/);
  const sparse=hostFixture(['note.md']);sparse.metadata.userIgnoreFilters=Array(1);
  assert.throws(()=>sparse.capture(),/SEARCH_SCOPE_INVALID/);assert.equal(sparse.subscriptions(),0);
  const unknown=hostFixture();unknown.raw(undefined);assert.throws(()=>unknown.capture(),/SEARCH_SCOPE_INVALID/);
  const missing=hostFixture();Object.assign(missing.vault,{getConfig:undefined});
  assert.throws(()=>missing.capture(),/SEARCH_SCOPE_INVALID/);
  const getter=hostFixture();Object.defineProperty(getter.host,'vault',{get(){throw Error('private input');}});
  assert.throws(()=>getter.capture(),{message:'SEARCH_SCOPE_INVALID'});
  const throwing=hostFixture();throwing.vault.getConfig=()=>{throw Error('private input');};
  assert.throws(()=>throwing.capture(),{message:'SEARCH_SCOPE_INVALID'});assert.equal(throwing.subscriptions(),0);
});
test('missed native configuration change and matcher or host substitution seal earlier leases',()=>{
  for(const mutate of [
    (f:ReturnType<typeof hostFixture>)=>f.raw(['different.md']),
    (f:ReturnType<typeof hostFixture>)=>f.update(['note.md'],false),
    (f:ReturnType<typeof hostFixture>)=>{f.metadata.userIgnoreFilters![0]={};},
    (f:ReturnType<typeof hostFixture>)=>{f.metadata.isUserIgnored=()=>false;},
    (f:ReturnType<typeof hostFixture>)=>{f.host.vault={...f.vault};},
    (f:ReturnType<typeof hostFixture>)=>{f.host.metadataCache={...f.metadata};},
    (f:ReturnType<typeof hostFixture>)=>{f.vault.getConfig=()=>['note.md'];},
  ]){
    const f=hostFixture(['note.md']);const l=f.capture();
    mutate(f);assert.equal(l.scope.current(),false);assert.equal(l.scope.allows('note.md'),false);assert.equal(f.count(),1);
    assert.equal(f.calls.length,0);l.dispose();
  }
});
test('reentrant native change, invalid matcher return and exceptions permanently deny',()=>{
  for(const behavior of [(f:ReturnType<typeof hostFixture>)=>{f.notify();return false;},
    ()=>undefined,()=>{throw Error('private value');}]){
    const f=hostFixture(['note.md']);const l=f.capture();
    f.behavior(()=>behavior(f));assert.equal(l.scope.allows('note.md'),false);
    assert.equal(l.scope.current(),false);assert.equal(f.count(),1);
    l.dispose();
  }
});
test('subscription precedes capture and retirement callback sees the seal; disposal is idempotent',()=>{
  const f=hostFixture();
  let callback:()=>void=()=>{};
  const on=f.vault.on;
  f.vault.on=(event,listener)=>{callback=listener;return on(event,listener);};
  let l:ReturnType<typeof captureNativeExclusions>;
  const observations:boolean[]=[];
  l=captureNativeExclusions(f.host,supported,()=>{observations.push(l.scope.current());throw Error('observer failure');});
  callback();callback();assert.deepEqual(observations,[false]);assert.equal(l.scope.current(),false);l.dispose();l.dispose();assert.equal(f.subscriptions(),0);
  const direct=hostFixture();let notifications=0;
  let d:ReturnType<typeof captureNativeExclusions>;
  d=captureNativeExclusions(direct.host,supported,()=>{
    assert.equal(d.scope.current(),false);notifications++;d.dispose();
  });
  d.dispose();d.dispose();direct.notify();
  assert.equal(notifications,1);assert.equal(direct.subscriptions(),0);
  const g=hostFixture();
  const subscribe=g.vault.on;g.vault.on=(event,listener)=>{const ref=subscribe(event,listener);listener();return ref;};
  assert.throws(()=>g.capture(),/SEARCH_SCOPE_INVALID/);assert.equal(g.subscriptions(),0);
});

test('revocable reader uses the native matcher even for empty configuration and preserves descriptor proofs',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'oks-native-reader-')));
  try{
    await writeFile(join(root,'note.md'),'# synthetic');
    await writeFile(join(root,'other.md'),'# sibling');
    for(const raw of [null,[],['note.md']]){
      const f=hostFixture(raw);f.behavior(path=>raw!==null&&raw.length>0&&path==='note.md');
      const l=f.capture();
      try{
        const r=await BoundedVaultReader.openWithScope(root,()=>['note.md','other.md'],l.scope);
        assert.equal(r.hardSearchScope,l.scope);
        assert.deepEqual(await r.list(),raw?.length?['other.md']:['note.md','other.md']);
        const allowed=await r.readVerifiedOriginal('other.md');
        assert.equal(Buffer.from(allowed.bytes).toString(),'# sibling');
        assert.equal(allowed.proof.version.sourceId,'other.md');
        assert.equal((await r.versionHints(['other.md'])).length,1);
        if(raw?.length){
          await assert.rejects(r.read('note.md'),/SEARCH_SCOPE_RESTRICTED/);
          await assert.rejects(r.readVersionProof('note.md'),/SEARCH_SCOPE_RESTRICTED/);
          await assert.rejects(r.readLifecycleProof('note.md'),/SEARCH_SCOPE_RESTRICTED/);
          await assert.rejects(r.versionHints(['note.md']),/SEARCH_SCOPE_RESTRICTED/);
        }
        await assert.rejects(r.completeMarkdownInventory(),/SEARCH_SCOPE_RESTRICTED/);
        f.update(['other.md']);f.update(raw);
        for(const operation of [()=>r.list(),()=>r.versionHints([]),()=>r.read('other.md'),
          ()=>r.readVerifiedOriginal('other.md'),()=>r.readVersionProof('other.md'),()=>r.readLifecycleProof('other.md'),
          ()=>r.completeMarkdownInventory(),()=>BoundedVaultReader.openWithScope(root,()=>[],l.scope)])
          await assert.rejects(operation(),/SEARCH_SCOPE_INVALID/);
      }finally{l.dispose();}
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('native reader never returns partial enumeration or stale asynchronous read and hint results',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'oks-native-race-')));
  try{
    await writeFile(join(root,'note.md'),'# synthetic');
    for(const kind of ['enumeration','empty-enumeration','matcher','missed','read','hints','descriptor','proof','in-flight-read','post-read'] as const){
      const f=hostFixture([]);f.behavior(()=>false);
      const l=f.capture();
      try{
        const r=await BoundedVaultReader.openWithScope(root,()=>{
          if(kind==='enumeration'||kind==='empty-enumeration')f.notify();
          return kind==='empty-enumeration'?[]:['note.md'];
        },l.scope);
        if(kind==='matcher')f.behavior(()=>{f.notify();return false;});
        if(kind==='missed')f.raw(['changed.md']);
        // Third match happens in the descriptor path after root validation,
        // before any content is returned (and even empty scope is checked).
        if(kind==='descriptor'||kind==='proof'||kind==='in-flight-read'||kind==='post-read'){
          let calls=0;
          f.behavior(()=>{
            calls++;
            if(calls===3&&(kind==='descriptor'||kind==='proof'))f.notify();
            if(calls===3&&kind==='in-flight-read')queueMicrotask(f.notify);
            if(calls===5&&kind==='post-read')queueMicrotask(f.notify);
            return false;
          });
        }
        const pending=kind==='read'||kind==='descriptor'||kind==='in-flight-read'||kind==='post-read'?r.read('note.md')
          :kind==='proof'?r.readVerifiedOriginal('note.md')
          :kind==='hints'?r.versionHints(['note.md']):r.list();
        if(kind==='read'||kind==='hints')f.notify();
        await assert.rejects(pending,/SEARCH_SCOPE_INVALID/);
        assert.equal(l.scope.current(),false);
      }finally{l.dispose();}
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
