import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {hash,isDigest} from '../plugin/src/standalone/contracts';
import {BoundedVaultReader,privateIndexPath} from '../plugin/src/standalone/source';
import {GenerationStore} from '../plugin/src/standalone/storage';
import {StandaloneEngine} from '../plugin/src/standalone/engine';
import {WorkerMarkdownParser} from '../plugin/src/standalone/worker';
import {syntheticNodeWorkerPort} from './helpers/browser-worker-port';
import {DurableLifecycleLedger} from '../plugin/src/ai/lifecycle-ledger';
import {NewMaterialTracker,type LifecycleObservation} from '../plugin/src/ai/new-material-tracker';
import {NativeLifecycleOwner} from '../plugin/src/ai/native-lifecycle-owner';
import {ProcessingPolicyHost,type FreshLifecycleObserver,type GenerationPolicyHostState} from '../plugin/src/ai/generation-policy-host';
import {GenerationPolicyGate,generationPolicyPayload,policyOriginals,sameGenerationPolicy,type ProcessingPolicyInput} from '../plugin/src/ai/generation-policy';
import {NEW_MATERIAL_RULE_CONFIG_VERSION,type NewMaterialRuleConfig} from '../plugin/src/ai/new-material-policy';
import {embeddingPolicyPayload,resolveEmbeddingPolicyScope} from '../plugin/src/ai/embedding-policy';
import {embeddingSpaceId} from '../plugin/src/ai/embedding-space';
import {VerifiedEvidenceOperation,type EvidenceApproval} from '../plugin/src/ai/verified-evidence';
import {configDigest} from '../plugin/src/ai/disclosure';
import {verifySpan} from '../plugin/src/search/navigation';
import type {AiRole,ProviderConfig,EmbeddingSpace} from '../plugin/src/ai/contracts';

const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
  identity:{model:'synthetic-fixture',revision:'fixture-v1'},limits:{timeoutMs:10000,maxInputBytes:8192,maxCandidates:10,maxOutputTokens:64,maxConcurrent:1}};
const rules:NewMaterialRuleConfig={version:NEW_MATERIAL_RULE_CONFIG_VERSION,defaultAction:'set-private',rules:[]};
const paths=['z.md','A.md','b.md'];
const body=(path:string)=>'REQ-42: synthetic fixture '+path;
const pluginId='oks-policy-fresh-fixture';

async function fixture(role:AiRole,use:(f:{
  root:string;reader:BoundedVaultReader;owner:NativeLifecycleOwner<object>;
  host:ProcessingPolicyHost<AiRole>;gate:GenerationPolicyGate;input:ProcessingPolicyInput<AiRole>;
  approval:(binding:Awaited<ReturnType<GenerationPolicyGate['evaluate']>>)=>EvidenceApproval;
  evaluate:(signal?:AbortSignal)=>ReturnType<GenerationPolicyGate['evaluate']>;
  observeCount:()=>number;requests:readonly (readonly string[])[];
  alter:(fn:(value:readonly LifecycleObservation[],n:number)=>readonly LifecycleObservation[]|null|Promise<readonly LifecycleObservation[]|null>)=>void;
  state:(patch:Partial<GenerationPolicyHostState>)=>void;
  revision:(value:string)=>void;
})=>Promise<void>,purpose:'query'|'document'='document'){
  const base=await mkdtemp(join(tmpdir(),'oks-policy-fresh-')),prior=process.env.XDG_DATA_HOME;
  const root=join(base,'vault'),xdg=join(base,'xdg');
  let owner:NativeLifecycleOwner<object>|undefined,engine:StandaloneEngine|undefined;
  try{
    await mkdir(root,{mode:0o700});await mkdir(xdg,{mode:0o700});process.env.XDG_DATA_HOME=xdg;
    for(const path of paths)await writeFile(join(root,path),body(path));
    const reader=await BoundedVaultReader.open(root,()=>paths),scopeId=reader.rootId;
    const proofs=await Promise.all([...paths].sort().map(path=>reader.readLifecycleProof(path)));
    const ledger=await DurableLifecycleLedger.open({path:root,rootId:scopeId},pluginId);
    try{
      const initial=await ledger.initializeEmptyEpoch();
      await ledger.commit(initial.anchor.snapshotSha256,true,proofs.map(proof=>({sourceId:proof.version.sourceId,
        state:'existing',origin:'baseline',originVersionId:proof.version.versionId,proof})));
    }finally{await ledger.close();}
    const files=new Map(paths.map(path=>[path,{}]));
    owner=new NativeLifecycleOwner(new NewMaterialTracker<object>());
    await owner.start({context:{rootId:scopeId,scopeId,rulesRevision:hash(JSON.stringify(rules)),host:{},session:{}},
      reader,rootPath:root,pluginId,current:()=>true,resolveNativeOwner:path=>files.get(path)??null});
    assert.equal(owner.exactAuthorityActive(),true);
    const store=await GenerationStore.open(join(base,'index'),scopeId);
    engine=new StandaloneEngine(reader,store,new WorkerMarkdownParser(join(process.cwd(),'.test-build','standalone-worker.js'),syntheticNodeWorkerPort));
    await engine.start();await engine.whenIdle();
    const corpus=await engine.captureDenseCorpus(paths,8,new AbortController().signal);
    const hit=corpus.evidence.find(x=>x.sourceId==='z.md')!;
    assert.ok(hit);
    const queryOnly=role==='embedding'&&purpose==='query';
    const resolved=resolveEmbeddingPolicyScope(corpus,purpose,queryOnly?[]:[hit]);
    const query='synthetic query';
    const sources=queryOnly?[]:[{sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,excerptDigest:hash(hit.originalExcerpt)}];
    const space:EmbeddingSpace={...config.identity,dimension:3,normalization:'unit-l2',serializationId:'utf8-verbatim-v1',
      queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
    const spaceId=embeddingSpaceId(config,space);
    const input:ProcessingPolicyInput<AiRole>={role,config,scopeId,ownerId:'fixture-owner',hostId:'fixture-host',credentialEpoch:1,
      deadlineUnixMs:Date.now()+10000,scopeBinding:role==='embedding'?resolved.scopeBinding:hash(JSON.stringify(paths)),
      scopeSources:role==='embedding'?resolved.scopeSources:paths.map(sourceId=>({sourceId,sourceSha256:hash(body(sourceId))})),sources,
      payloadDigest:role==='embedding'?embeddingPolicyPayload(purpose,spaceId,query,'synthetic',sources):
        generationPolicyPayload(query,[{sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,text:hit.originalExcerpt}],role),
      ...(role==='embedding'?{embedding:{purpose,space,spaceId,query,queryClassification:'synthetic' as const}}:{})};
    let value:GenerationPolicyHostState={config,profile:{profileId:'synthetic-profile',admissionId:'synthetic-review',
      role,configDigest:configDigest(role,config),adapter:'synthetic-adapter',classification:'external'},
      adapter:'synthetic-adapter',policyRevision:'p1',configRevision:'c1',restrictions:[],rules,materials:[],complete:true};
    let epoch=hash('owner-1'),calls=0;
    const requests:string[][]=[];
    let alter=(v:readonly LifecycleObservation[],_n:number):readonly LifecycleObservation[]|null|Promise<readonly LifecycleObservation[]|null>=>v;
    const revision=(scope:string)=>scope===scopeId&&['admitted','restored'].includes(owner!.readiness())?epoch:null;
    const observer:FreshLifecycleObserver={revision,observe:async(scope,expected,items,signal)=>{
      calls++;requests.push(items.map(x=>x.sourceId));
      if(signal.aborted||revision(scope)!==expected)return null;
      const result=await owner!.observeCommittedLifecycle(items);
      return result.ok?alter(result.observations,calls):null;
    }};
    const host=new ProcessingPolicyHost<AiRole>(()=>true,()=>engine,i=>({...value,
      materials:policyOriginals(i).map(source=>({lifecycle:{state:'unresolved',sourceId:source.sourceId,sha256:source.sourceSha256,rootId:scopeId},provenance:null}))}),
      role,()=>resolved,observer);
    const gate=new GenerationPolicyGate();
    const evaluate=(signal=new AbortController().signal)=>gate.evaluate(host,input,{signal,deadlineUnixMs:input.deadlineUnixMs},()=>true);
    const approval=(binding:Awaited<ReturnType<GenerationPolicyGate['evaluate']>>):EvidenceApproval=>({config,scopeId,
      query:{text:query,classification:'synthetic'},candidates:queryOnly?[]:[{hit,classification:'unknown'}],
      grant:{version:1,role,configDigest:configDigest(role,config),scopeId,expiresUnixMs:input.deadlineUnixMs,
        queryDigest:hash(query),queryClassification:'synthetic',notePolicyBinding:binding,
        sources:sources.map(s=>({...s,classification:'unknown'}))}});
    await use({root,reader,owner,host,gate,input,approval,evaluate,observeCount:()=>calls,requests,
      alter:fn=>{alter=fn;},state:patch=>{value={...value,...patch};},revision:v=>{epoch=v;}});
  }finally{
    await engine?.close();await owner?.close();
    if(prior===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=prior;
    await rm(base,{recursive:true,force:true});
  }
}

for(const role of ['generation','reranking','embedding'] as const){
  test('fresh lifecycle '+role+' binds complete originals and rejects same-byte replacement before dispatch',async()=>{
    await fixture(role,async f=>{
      const binding=await f.evaluate();
      assert.ok(isDigest(binding.lifecycleDigest));assert.equal(f.observeCount(),2);
      assert.deepEqual(f.requests,[['A.md','b.md','z.md'],['A.md','b.md','z.md']]);
      assert.equal(f.host.current(f.input,binding),true);
      assert.equal(f.host.current(f.input,{...binding,lifecycleDigest:hash('forged')}),false);
      const {lifecycleDigest:_,...missing}=binding;
      assert.equal(f.host.current(f.input,missing),false);
      assert.equal(sameGenerationPolicy(binding,{...binding,lifecycleDigest:hash('forged')}),false);
      f.alter(v=>{assert.equal(f.host.current(f.input,binding),true);return v;});
      assert.equal(sameGenerationPolicy(binding,await f.evaluate()),true);
      let wire=0;
      const operation=new VerifiedEvidenceOperation(),signal=new AbortController().signal;
      const run=()=>operation.run(role,f.approval(binding),{signal,deadlineUnixMs:f.input.deadlineUnixMs},
        async hit=>{verifySpan(hit,await f.reader.read(hit.sourceId));},()=>f.host.current(f.input,binding),
        async()=>{wire++;return 'synthetic-response';},false,()=>f.evaluate(signal));
      await run();assert.equal(wire,1);
      // Replace a non-candidate original without changing any bytes or delivering a native event.
      await writeFile(join(f.root,'replacement.md'),body('b.md'));await rename(join(f.root,'replacement.md'),join(f.root,'b.md'));
      assert.equal(f.host.current(f.input,binding),true); // structural, not physical freshness
      await assert.rejects(run());assert.equal(wire,1);
    });
  });
}

test('fresh lifecycle denies malformed evidence, changed owner revision and changed rules, without fallback',async()=>{
  await fixture('generation',async f=>{
    const first=await f.evaluate();
    for(const mutate of [
      (v:readonly LifecycleObservation[])=>v.slice(1),
      (v:readonly LifecycleObservation[])=>[v[1]!,v[0]!,v[2]!],
      (v:readonly LifecycleObservation[])=>[{...v[0]!,origin:'native-create' as const},...v.slice(1)],
      (v:readonly LifecycleObservation[])=>[{...v[0]!,proof:{...v[0]!.proof,stableIdentity:'not-a-digest'}},...v.slice(1)],
      (v:readonly LifecycleObservation[])=>[{...v[0]!,proof:{...v[0]!.proof,version:{...v[0]!.proof.version,rootId:hash('foreign')}}},...v.slice(1)],
      (_v:readonly LifecycleObservation[])=>null
    ]){f.alter(mutate);await assert.rejects(f.evaluate());}
    const count=f.observeCount();
    f.alter((v,n)=>n===count+2?[{...v[0]!,proof:{...v[0]!.proof,version:{...v[0]!.proof.version,versionId:hash('changed-version')}}},...v.slice(1)]:v);
    await assert.rejects(f.evaluate());assert.equal(f.observeCount(),count+2);
    f.alter(v=>v);
    f.revision(hash('new-owner'));assert.equal(f.host.current(f.input,first),false);
    const second=await f.evaluate();assert.notEqual(first.lifecycleDigest,second.lifecycleDigest);
    f.alter(v=>{f.state({policyRevision:'p2'});return v;});await assert.rejects(f.evaluate());
    f.alter(v=>v);const third=await f.evaluate();
    // Change the rules deterministically on the next observation.
    f.alter(v=>{f.state({rules:{...rules,defaultAction:'leave-absent'}});return v;});
    await assert.rejects(f.evaluate());assert.equal(f.host.current(f.input,third),false);
  });
});

test('fresh lifecycle skips missing admission, rules-absent and trusted internal evaluations',async()=>{
  await fixture('generation',async f=>{
    f.alter(()=>null);
    f.state({profile:null});await assert.rejects(f.evaluate(),{message:'DISCLOSURE_DENIED'});
    assert.equal(f.observeCount(),0);
    const profile={profileId:'fixture',admissionId:'review',role:'generation' as const,
      configDigest:configDigest('generation',config),adapter:'synthetic-adapter',classification:'trusted-internal' as const};
    f.state({profile});assert.equal((await f.evaluate()).lifecycleDigest,undefined);
    f.state({profile:{...profile,classification:'external'},rules:undefined});
    assert.equal((await f.evaluate()).lifecycleDigest,undefined);assert.equal(f.observeCount(),0);
    f.state({rules});await assert.rejects(f.evaluate());assert.equal(f.observeCount(),1);
  });
});

test('fresh lifecycle cancellation keeps the physical slot reserved until owner read settles',async()=>{
  await fixture('generation',async f=>{
    let release!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
    const read=f.reader.readLifecycleProof.bind(f.reader);
    f.reader.readLifecycleProof=async path=>{entered();await hold;return read(path);};
    const abort=new AbortController();
    try{
      const pending=f.evaluate(abort.signal);await waiting;abort.abort();
      await assert.rejects(pending,{message:'CANCELLED'});assert.equal(f.gate.busy,true);
      await assert.rejects(f.evaluate(),{message:'BUSY'});
    }finally{release();await f.gate.drain();f.reader.readLifecycleProof=read;}
    assert.equal(f.gate.busy,false);assert.ok((await f.evaluate()).lifecycleDigest);
  });
});

test('fresh lifecycle rejects owner retirement or ledger loss before publication',async()=>{
  await fixture('generation',async f=>{
    f.alter(v=>{f.owner.retire();return v;});
    await assert.rejects(f.evaluate());
    assert.equal(f.owner.exactAuthorityActive(),false);
  });
  await fixture('generation',async f=>{
    f.alter(async(v,n)=>{
      if(n===1)await writeFile(join(dirname(privateIndexPath(f.root,f.reader.rootId,pluginId)),'lifecycle-authority','CURRENT'),'tampered',{mode:0o600});
      return v;
    });
    await assert.rejects(f.evaluate());assert.equal(f.observeCount(),2);
  });
});


test('fresh embedding query observes complete originals with no candidate passages',async()=>{
  await fixture('embedding',async f=>{
    const binding=await f.evaluate();assert.ok(binding.lifecycleDigest);assert.equal(binding.embedding?.purpose,'query');
    assert.deepEqual(f.requests,[['A.md','b.md','z.md'],['A.md','b.md','z.md']]);
    let wire=0;
    const signal=new AbortController().signal,operation=new VerifiedEvidenceOperation();
    const run=()=>operation.run('embedding',f.approval(binding),{signal,deadlineUnixMs:f.input.deadlineUnixMs},
      async()=>{assert.fail('query-only should have no candidates');},()=>f.host.current(f.input,binding),
      async(_config,input)=>{assert.deepEqual(input.passages,[]);wire++;return 'synthetic-response';},true,()=>f.evaluate(signal));
    await run();assert.equal(wire,1);
    await writeFile(join(f.root,'replacement.md'),body('A.md'));await rename(join(f.root,'replacement.md'),join(f.root,'A.md'));
    await assert.rejects(run());assert.equal(wire,1);
  },'query');
});

test('fresh lifecycle rejects post-response policy drift before publication',async()=>{
  await fixture('generation',async f=>{
    const binding=await f.evaluate(),signal=new AbortController().signal;
    let wire=0;
    await assert.rejects(new VerifiedEvidenceOperation().run('generation',f.approval(binding),
      {signal,deadlineUnixMs:f.input.deadlineUnixMs},async hit=>{verifySpan(hit,await f.reader.read(hit.sourceId));},
      ()=>f.host.current(f.input,binding),async()=>{wire++;f.revision(hash('retired'));return 'synthetic-response';},
      false,()=>f.evaluate(signal)));
    assert.equal(wire,1);
  });
});
