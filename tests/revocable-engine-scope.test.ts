import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BoundedVaultReader} from '../plugin/src/standalone/source';
import {StandaloneEngine} from '../plugin/src/standalone/engine';
import {GenerationStore} from '../plugin/src/standalone/storage';
import {parseMarkdown} from '../plugin/src/standalone/markdown';
import {parsePolicyMetadata} from '../plugin/src/standalone/markdown-parse';
import {hash,PROTOCOL,StandaloneError} from '../plugin/src/standalone/contracts';
import {captureNativeExclusions} from '../plugin/src/search/native-exclusions';
import {authenticateGraphCatalog} from '../plugin/src/standalone/graph-lifecycle';
import type {RevocableHardSearchScope} from '../plugin/src/standalone/hard-search-scope';

const request={protocolVersion:PROTOCOL,requestId:'synthetic-scope',query:'unique',requestedMode:'lexical',limit:10} as const;
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'oks-engine-scope-')));
  const paths=['one.md','two.md'];
  for(const path of paths)await writeFile(join(root,path),'# unique '+path);
  let raw: string[]|null=null;
  const callbacks=new Set<()=>void>();
  const metadata={userIgnoreFilters:null as object[]|null,isUserIgnored:(path:string)=>raw?.includes(path)??false};
  const vault={getConfig:()=>raw,on:(_event:string,callback:()=>void)=>{callbacks.add(callback);return callback;},offref:(ref:unknown)=>{callbacks.delete(ref as ()=>void);}};
  const capture=()=>captureNativeExclusions({vault,metadataCache:metadata},{version:'1.15.1',desktop:true,linux:true},()=>{});
  const change=(next:string[]|null,emit=true)=>{raw=next;metadata.userIgnoreFilters=raw?.map(()=>({}))??null;if(emit)for(const cb of [...callbacks])cb();};
  const storePath=join(root,'.obsidian/plugins/oks-synthetic-evidence/index');
  const engines:StandaloneEngine[]=[],leases:ReturnType<typeof capture>[]=[];
  const open=async()=>{
    const lease=capture();leases.push(lease);
    const reader=await BoundedVaultReader.openWithScope(root,()=>paths,lease.scope);
    const store=await GenerationStore.open(storePath,reader.rootId);
    let parses=0,previews=0;let onParse=()=>{},onPreview=()=>{};
    const parser={parse:async(path:string,bytes:Uint8Array,id:string)=>{parses++;onParse();return parseMarkdown(path,bytes,id);},
      policyMetadata:async(path:string,bytes:Uint8Array,id:string)=>{previews++;onPreview();return parsePolicyMetadata(path,bytes,id,hash(bytes));},close:async()=>{}};
    const engine=new StandaloneEngine(reader,store,parser);
    engines.push(engine);
    return {engine,reader,store,parses:()=>parses,onParse:(cb:()=>void)=>{onParse=cb;},previews:()=>previews,onPreview:(cb:()=>void)=>{onPreview=cb;}};
  };
  return {open,change,cleanup:async()=>{for(const e of engines)await e.close();for(const l of leases)l.dispose();await rm(root,{recursive:true,force:true});}};
}
async function denied(engine:StandaloneEngine){
  assert.equal(engine.status().generationId,null);
  assert.equal(engine.status().sources,0);
  assert.equal(engine.status().records,0);
  assert.equal(engine.status().error,'SEARCH_SCOPE_INVALID');
  for(const query of ['unique','nonexistent']){
    const response=await engine.search({...request,query});
    assert.equal(response.status,'failed');assert.equal(response.error,'SEARCH_SCOPE_INVALID');
    assert.equal(response.indexGenerationId,null);assert.deepEqual(response.hits,[]);
  }
}

test('empty native scope retirement fences already captured engine leases and stays retired after settings revert',async()=>{
  const f=await fixture();try{
    const {engine}=await f.open();await engine.start();await engine.whenIdle();
    assert.equal((await engine.search(request)).hits.length,2);
    const signal=new AbortController().signal;
    const dense=await engine.captureDenseCorpus(['one.md'],10,signal);
    const chat=await engine.captureChatScope({mode:'vault-wide'},signal);
    engine.configureGraph({schemaVersion:'oks-06b-mapping-v1',rules:[]});
    const graph=engine.captureGraphScope({mode:'vault-wide'},signal);
    assert.ok(dense.current()&&chat.current()&&graph.current());
    f.change(['one.md'],false);
    assert.equal(dense.current(),false);assert.equal(chat.current(),false);assert.equal(graph.current(),false);
    await denied(engine);f.change(null);engine.rebuild();await engine.whenIdle();await denied(engine);
    await assert.rejects(chat.verify(),/SCOPE_CHANGED/);
    await assert.rejects(dense.verify(dense.evidence[0]!),/SOURCE_STALE/);
  }finally{await f.cleanup();}
});

test('revocation during authenticated store load does not admit restored generation',async()=>{
  const f=await fixture();try{
    const first=await f.open();await first.engine.start();await first.engine.whenIdle();await first.engine.close();
    const {engine,store}=await f.open();const load=store.load.bind(store);
    store.load=async()=>{const result=await load();assert.ok(result.generation);f.change(['one.md']);return result;};
    await assert.rejects(engine.start(),/SEARCH_SCOPE_INVALID/);await denied(engine);
  }finally{await f.cleanup();}
});

for(const stage of ['read','parse','before-rename','after-rename','after-commit'] as const)test('revocation during '+stage+' cannot admit or publish old engine evidence',async()=>{
  const f=await fixture();try{
    const {engine,reader,store,parses,onParse}=await f.open();
    const retire=()=>f.change(['one.md']);
    const observations:(string|null)[]=[];
    if(stage==='read'){
      const read=reader.read.bind(reader);reader.read=async path=>{const bytes=await read(path);retire();return bytes;};
    }else if(stage==='parse')onParse(retire);
    else{
      const commit=store.commit.bind(store);
      store.commit=async(gen,begin,published)=>{
        const outcome=await commit(gen,()=>{if(stage==='before-rename')retire();begin?.();},actual=>{
          if(stage==='after-rename')retire();published?.(actual);
          if(stage==='after-rename')observations.push(engine.status().generationId);
        });
        if(stage==='after-commit')retire();return outcome;
      };
    }
    await engine.start();await engine.whenIdle();await denied(engine);
    assert.equal(parses(),stage==='read'?0:stage==='parse'?1:2);
    if(stage==='after-rename')assert.deepEqual(observations,[null]);
    const recovered=await store.load();
    if(stage==='after-rename'||stage==='after-commit')assert.ok(recovered.generation);
    else assert.equal(recovered.generation,null);
    await engine.close();
    const fresh=await f.open();await fresh.engine.start();await fresh.engine.whenIdle();
    assert.deepEqual((await fresh.engine.search(request)).hits.map(hit=>hit.sourceId),['two.md']);
  }finally{await f.cleanup();}
});

test('revocation after last candidate read denies cached hits and an in-flight zero-hit query',async()=>{
  const f=await fixture();try{
    const {engine,reader}=await f.open();await engine.start();await engine.whenIdle();
    const read=reader.read.bind(reader);reader.read=async path=>{const bytes=await read(path);f.change(['one.md']);return bytes;};
    const result=await engine.search(request);assert.equal(result.error,'SEARCH_SCOPE_INVALID');assert.deepEqual(result.hits,[]);await denied(engine);
    f.change(null);await engine.close();
    const fresh=await f.open();await fresh.engine.start();await fresh.engine.whenIdle();
    const hints=fresh.reader.versionHints.bind(fresh.reader);fresh.reader.versionHints=async paths=>{const value=await hints(paths);f.change(['two.md']);return value;};
    const empty=await fresh.engine.search({...request,query:'nonexistent'});assert.equal(empty.error,'SEARCH_SCOPE_INVALID');assert.equal(empty.indexGenerationId,null);await denied(fresh.engine);
  }finally{await f.cleanup();}
});

for(const stage of ['read','parser'] as const)test('revoked policy preview cannot return proof or continue physical reads after '+stage,async()=>{
  const f=await fixture();try{
    const {engine,reader,previews,onPreview}=await f.open();await engine.start();await engine.whenIdle();
    const original=reader.read.bind(reader);let reads=0;
    reader.read=async path=>{reads++;const bytes=await original(path);if(stage==='read')f.change(['one.md']);return bytes;};
    if(stage==='parser')onPreview(()=>f.change(['one.md']));
    await assert.rejects(engine.previewPolicyMetadata('one.md',()=>true),/SOURCE_CHANGED/);
    await engine.whenIdle();assert.equal(reads,1);assert.equal(previews(),stage==='read'?0:1);
    await assert.rejects(engine.previewPolicyMetadata('two.md',()=>true),/SEARCH_SCOPE_INVALID/);
    await denied(engine);
  }finally{await f.cleanup();}
});

test('exceptional recovery settlement still reports scope retirement and never schedules parser work',async()=>{
  const f=await fixture();try{
    const {engine,store,parses}=await f.open();store.load=async()=>{f.change(['one.md']);throw Error('synthetic I/O failure');};
    await assert.rejects(engine.start(),/SEARCH_SCOPE_INVALID/);await engine.whenIdle();assert.equal(parses(),0);await denied(engine);
  }finally{await f.cleanup();}
});

for(const stage of ['initial-read','candidate-read','final-list','final-read'] as const)
test('selected range stops reader dispatch and suppresses evidence on revocation at '+stage,async()=>{
  const f=await fixture();try{
    const {engine,reader,parses}=await f.open();await engine.start();await engine.whenIdle();
    const raw='# unique one.md';
    const range={sourceId:'one.md',sourceSha256:hash(raw),byteStart:0,byteEnd:raw.length,charStart:0,charEnd:raw.length};
    const selected={...request,scope:['one.md'],range};
    assert.equal((await engine.search(selected)).hits.length,1);
    let lists=0,reads=0,late=0,retired=false;
    const before=parses(),list=reader.list.bind(reader),read=reader.read.bind(reader);
    const retire=()=>{retired=true;f.change(['one.md']);};
    reader.list=async()=>{if(retired)late++;const value=await list();if(++lists===2&&stage==='final-list')retire();return value;};
    reader.read=async path=>{
      if(retired)late++;
      const bytes=await read(path);reads++;
      if((stage==='initial-read'&&reads===1)||(stage==='candidate-read'&&reads===2)||(stage==='final-read'&&reads===2))retire();
      return bytes;
    };
    const response=await engine.search({...selected,query:stage.startsWith('final-')?'nonexistent':'unique'});
    assert.equal(retired,true);assert.equal(response.status,'failed');
    assert.equal(response.error,'SEARCH_SCOPE_INVALID');assert.equal(response.indexGenerationId,null);
    assert.deepEqual(response.hits,[]);assert.equal(late,0,'post-revocation reader dispatch');
    assert.equal(reads,stage==='initial-read'||stage==='final-list'?1:2);
    assert.equal(parses(),before);await denied(engine);
  }finally{await f.cleanup();}
});


for(const stage of ['initial-membership','final-membership'] as const)
test('graph catalog does not dispatch hints after membership revocation at '+stage,async()=>{
  const f=await fixture();try{
    const {engine,reader,store}=await f.open();await engine.start();await engine.whenIdle();
    const {generation}=await store.load();assert.ok(generation);
    const scope=reader.hardSearchScope as RevocableHardSearchScope;
    const list=reader.list.bind(reader),hints=reader.versionHints.bind(reader);
    let lists=0,hintCalls=0,late=0,arm=false,retired=false;
    reader.list=async()=>{const value=await list();if(++lists===(stage==='initial-membership'?1:2))arm=true;return value;};
    reader.versionHints=async paths=>{hintCalls++;if(retired)late++;return hints(paths);};
    const check=()=>{
      if(!scope.current())throw new StandaloneError('SEARCH_SCOPE_INVALID');
      if(arm){arm=false;queueMicrotask(()=>{retired=true;f.change(['one.md']);});}
    };
    const parser={parse:async()=>{throw Error('UNEXPECTED_REPARSE');},close:async()=>{}};
    await assert.rejects(authenticateGraphCatalog(generation,reader,parser,false,check,async()=>{}),/SEARCH_SCOPE_INVALID/);
    assert.equal(retired,true);assert.equal(late,0,'post-revocation hints dispatch');
    assert.equal(hintCalls,stage==='initial-membership'?0:1);await denied(engine);
  }finally{await f.cleanup();}
});
