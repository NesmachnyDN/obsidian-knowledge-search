import {test} from 'node:test';
import assert from 'node:assert/strict';
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
  l=captureNativeExclusions(f.host,supported,()=>{assert.equal(l.scope.current(),false);throw Error('observer failure');});
  callback();callback();assert.equal(l.scope.current(),false);l.dispose();l.dispose();assert.equal(f.subscriptions(),0);
  const g=hostFixture();
  const subscribe=g.vault.on;g.vault.on=(event,listener)=>{const ref=subscribe(event,listener);listener();return ref;};
  assert.throws(()=>g.capture(),/SEARCH_SCOPE_INVALID/);assert.equal(g.subscriptions(),0);
});
