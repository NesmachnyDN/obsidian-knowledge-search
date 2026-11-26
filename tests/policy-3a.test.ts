import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {hash} from '../plugin/src/standalone/contracts';
import {BoundedVaultReader} from '../plugin/src/standalone/source';
import {GenerationStore} from '../plugin/src/standalone/storage';
import {StandaloneEngine} from '../plugin/src/standalone/engine';
import {WorkerMarkdownParser} from '../plugin/src/standalone/worker';
import {syntheticNodeWorkerPort} from './helpers/browser-worker-port';
import {SearchController,uiRequest} from '../plugin/src/search/controller';
import {verifySpan} from '../plugin/src/search/navigation';
import {GenerationPolicyHost,RerankPolicyHost,ProcessingPolicyHost,type GenerationPolicyHostState} from '../plugin/src/ai/generation-policy-host';
import {GenerationPolicyGate,generationPolicyPayload,policyOriginals,uniquePolicySources,type GenerationPolicyInput} from '../plugin/src/ai/generation-policy';
import {configDigest,projectDisclosure} from '../plugin/src/ai/disclosure';
import {NEW_MATERIAL_RULE_CONFIG_VERSION,type NewMaterialRuleConfig} from '../plugin/src/ai/new-material-policy';
import type {ProviderConfig,EmbeddingSpace} from '../plugin/src/ai/contracts';
import {RerankRuntimeProfiles} from '../plugin/src/ai/rerank-profile';
import type {PolicyEnvelope} from '../plugin/src/ai/processing-policy';
import {embeddingPolicyPayload,resolveEmbeddingPolicyScope,type EmbeddingPolicyInput,type EmbeddingPolicyScope} from '../plugin/src/ai/embedding-policy';
import {embeddingSpaceId} from '../plugin/src/ai/embedding-space';
import {EvidenceEmbedder,type EmbeddingApproval} from '../plugin/src/ai/embedding-evidence';
import type {EvidenceHit} from '../plugin/src/standalone/contracts';
import type {GenerationCredentialAuthority,GenerationCredentialStamp} from '../plugin/src/ai/generation-credential';

const request={requestId:'synthetic-turn',query:'REQ-42',limit:5};
const raw=(marker?:string,body='REQ-42: original synthetic evidence.')=>marker===undefined?body:
  `---\nllm_processing: ${marker}\n---\n${body}`;
const selector=(...sourceIds:string[])=>({mode:'selected',kind:'files',sourceIds});
const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:1',
  identity:{model:'synthetic-generator',revision:'fixture-v1'},limits:{timeoutMs:5000,maxInputBytes:8192,maxCandidates:10,maxOutputTokens:64,maxConcurrent:1}};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(notes:Record<string,string>,use:(f:{
  engine:StandaloneEngine;reader:BoundedVaultReader;root:string;config:ProviderConfig;host:GenerationPolicyHost;
  controller:SearchController;state:(patch:Partial<GenerationPolicyHostState>)=>void;
  lifecycle:(value:'existing'|'verified-new'|'unresolved')=>void;requests:unknown[];
  authorization:readonly string[];
  onResponse:(callback:()=>void)=>void;
})=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'oks-policy-3a-synthetic-'));
  const requests:unknown[]=[];
  const authorization:string[]=[];
  let beforeResponse=()=>{};
  const server=createServer((req:IncomingMessage,res:ServerResponse)=>{
    let wire='';req.on('data',chunk=>wire+=String(chunk));req.on('end',()=>{
      authorization.push(typeof req.headers.authorization==='string'?req.headers.authorization:'');
      const payload=JSON.parse(wire);
      if(req.url==='/v1/embeddings'){
        requests.push(payload);beforeResponse();
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({model:payload.model,data:payload.input.map((_:unknown,index:number)=>({object:'embedding',index,embedding:[1,0,0]}))}));return;
      }
      if(req.url==='/v1/rerank'){
        requests.push(payload);beforeResponse();
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({model:payload.model,results:payload.documents.map((_:unknown,index:number)=>({index,relevance_score:1/(index+1)}))}));return;
      }
      const content=JSON.parse(payload.messages[1].content);
      requests.push(content);beforeResponse();
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({model:'synthetic-generator@fixture-v1',usage:{completion_tokens:8},choices:[{index:0,finish_reason:'stop',
        message:{role:'assistant',content:JSON.stringify({claims:[{kind:'quotation',text:content.passages[0].text,citationIds:[0]}]})}}]}));
    });
  });
  let engine:StandaloneEngine|undefined,controller:SearchController|undefined;
  try{
    for(const [path,content] of Object.entries(notes)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),content);}
    const reader=await BoundedVaultReader.open(root,()=>Object.keys(notes));
    const store=await GenerationStore.open(join(root,'index'),reader.rootId);
    engine=new StandaloneEngine(reader,store,new WorkerMarkdownParser(join(process.cwd(),'.test-build','standalone-worker.js'),syntheticNodeWorkerPort));
    await engine.start();await engine.whenIdle();
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string')throw Error('FIXTURE_ADDRESS');
    const cfg={...config,origin:'http://127.0.0.1:'+address.port};
    let lifecycle:'existing'|'verified-new'|'unresolved'='verified-new';
    let state:GenerationPolicyHostState={config:cfg,profile:{profileId:'synthetic-profile',admissionId:'synthetic-review',
      role:'generation',configDigest:configDigest('generation',cfg),adapter:'synthetic-adapter',classification:'external'},
      adapter:'synthetic-adapter',policyRevision:'p1',configRevision:'c1',restrictions:[],materials:[],complete:true};
    const host=new GenerationPolicyHost(()=>true,()=>engine,input=>({...state,
      materials:policyOriginals(input).map(source=>({lifecycle:{state:lifecycle,sourceId:source.sourceId,
        sha256:source.sourceSha256,rootId:reader.rootId},provenance:null}))}));
    const rerankHost=new RerankPolicyHost(()=>true,()=>engine,input=>({...state,
      materials:policyOriginals(input).map(source=>({lifecycle:{state:lifecycle,sourceId:source.sourceId,
        sha256:source.sourceSha256,rootId:reader.rootId},provenance:null}))}));
    const port={config:()=>cfg,scopeId:()=>reader.rootId,verify:async(hit:import('../plugin/src/standalone/contracts').EvidenceHit)=>{verifySpan(hit,await reader.read(hit.sourceId));}};
    controller=new SearchController(async()=>{},undefined,undefined,port,port,undefined,undefined,host,rerankHost);
    controller.attach(engine);
    await use({engine,reader,root,config:cfg,host,controller,state:patch=>{state={...state,...patch};},
      lifecycle:value=>{lifecycle=value;},requests,authorization,onResponse:callback=>{beforeResponse=callback;}});
  }finally{
    controller?.dispose();await engine?.close();server.closeAllConnections();
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
  }
}
function policyInput(f:{reader:BoundedVaultReader;config:ProviderConfig},notes:Record<string,string>,paths:string[],passages=paths):GenerationPolicyInput{
  const sources=passages.map(sourceId=>({sourceId,sourceSha256:hash(notes[sourceId]!),excerptDigest:hash('synthetic')}));
  return {role:'generation',config:f.config,scopeId:f.reader.rootId,ownerId:'fixture-owner',hostId:'fixture-host',credentialEpoch:1,
    deadlineUnixMs:Date.now()+5000,payloadDigest:hash('fixture-payload'),scopeBinding:hash(JSON.stringify(paths)),
    scopeSources:paths.map(sourceId=>({sourceId,sourceSha256:hash(notes[sourceId]!)})),sources};
}
test('POLICY.3a real bundled worker, exact original metadata, marking and admitted profile',async()=>{
  const notes={'a.md':raw(),'b.md':raw('external'),'private.md':raw('private'),
    'invalid.md':raw('null'),'ambiguous.md':raw('external\nllm_processing: private')};
  await fixture(notes,async f=>{
    const gate=new GenerationPolicyGate();
    const evaluate=(paths:string[],passages=paths)=>{
      const i=policyInput(f,notes,paths,passages);
      return gate.evaluate(f.host,i,{signal:new AbortController().signal,deadlineUnixMs:i.deadlineUnixMs},()=>true);
    };
    await evaluate(['a.md','b.md'],['a.md','a.md','b.md']);
    for(const path of ['private.md','invalid.md','ambiguous.md'])await assert.rejects(evaluate([path]),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(evaluate(['a.md','private.md'],['a.md']),{message:'DISCLOSURE_DENIED'});
    const profile={profileId:'internal',admissionId:'synthetic-review',role:'generation' as const,
      configDigest:configDigest('generation',f.config),adapter:'synthetic-adapter',classification:'trusted-internal' as const};
    f.state({profile});await evaluate(['private.md','invalid.md']);
    await assert.rejects(evaluate(['ambiguous.md']),{message:'DISCLOSURE_DENIED'});
    f.state({restrictions:[{scope:'all',sourceId:'private.md'}]});await assert.rejects(evaluate(['private.md']),{message:'DISCLOSURE_DENIED'});
    f.state({restrictions:[],profile:{...profile,classification:'external'}});
    const rules:NewMaterialRuleConfig={version:NEW_MATERIAL_RULE_CONFIG_VERSION,defaultAction:'set-private',rules:[]};
    f.state({rules});await assert.rejects(evaluate(['b.md']),{message:'DISCLOSURE_DENIED'});
    f.lifecycle('unresolved');await assert.rejects(evaluate(['a.md']),{message:'DISCLOSURE_DENIED'});
    f.lifecycle('existing');await evaluate(['a.md']);
    f.lifecycle('verified-new');f.state({rules:{...rules,defaultAction:'leave-absent',rules:[
      {id:'import',action:'set-external',when:{importChannel:'trusted-channel'}}]}});
    await assert.rejects(evaluate(['a.md']),{message:'DISCLOSURE_DENIED'});
    f.state({rules:undefined,profile:null});await assert.rejects(evaluate(['a.md']),{message:'DISCLOSURE_DENIED'});
    f.state({profile:{...profile,classification:'external',configDigest:hash('foreign')}});await assert.rejects(evaluate(['a.md']),{message:'DISCLOSURE_DENIED'});
    assert.equal(f.requests.length,0);
  });
});
test('POLICY.3a retained chat sends policy-eligible originals, not note attestations; mixed scope denies all',async()=>{
  const notes={'a.md':raw('external'),'private.md':raw('private','Unrelated private material.')};
  await fixture(notes,async f=>{
    const c=f.controller,session=c.openRetainedChatSession();
    const prepare=async(scope:unknown)=>{
      const turn=c.startRetainedChatTurn(session,scope,request);
      assert.equal((await turn.result).ok,true);
      const stamp=await c.bindRetainedGenerationCredential(session,turn.owner,'synthetic-token');
      let draft=c.createRetainedChatClassificationDraft(session,turn.owner,stamp);
      assert.equal(draft.evidence[0]!.classification,'unknown');
      await assert.rejects(c.prepareRetainedChatGeneration(session,turn.owner,draft),{message:'DISCLOSURE_DENIED'});
      draft=c.attestRetainedChatClassification(session,turn.owner,draft,draft.question.id,'synthetic');
      assert.throws(()=>c.attestRetainedChatClassification(session,turn.owner,draft,draft.evidence[0]!.id,'public'),{message:'DISCLOSURE_DENIED'});
      return {turn,draft};
    };
    let {turn,draft}=await prepare(selector('a.md'));
    const preview=await c.prepareRetainedChatGeneration(session,turn.owner,draft);
    assert.ok(preview.policy);assert.equal(preview.evidence[0]!.classification,'unknown');
    assert.equal((await c.confirmRetainedChatGeneration(session,turn.owner,structuredClone(preview))).ok,false);
    const confirmed=await c.confirmRetainedChatGeneration(session,turn.owner,preview);
    assert.equal(confirmed.ok,true);assert.equal(f.requests.length,1);
    assert.deepEqual(f.requests[0],{question:request.query,passages:[{id:0,text:'REQ-42: original synthetic evidence.'}]});
    assert.equal((await c.confirmRetainedChatGeneration(session,turn.owner,preview)).ok,false);
    ({turn,draft}=await prepare({mode:'vault-wide'}));
    await assert.rejects(c.prepareRetainedChatGeneration(session,turn.owner,draft),{message:'DISCLOSURE_DENIED'});
    assert.equal(f.requests.length,1);
  });
});
test('POLICY.3a revalidation denies changed marking policy before dispatch and during publication',async()=>{
  await fixture({'a.md':raw()},async f=>{
    const c=f.controller;
    assert.equal((await c.search(uiRequest(request.query,3))).ok,true);
    let preview=await c.prepareGenerationWithPolicy('synthetic-token');
    f.state({policyRevision:'p2'});
    await assert.rejects(c.generationConfirmed(preview,'synthetic'),{message:'CANCELLED'});
    assert.equal(f.requests.length,0);
    preview=await c.prepareGenerationWithPolicy('synthetic-token');
    f.onResponse(()=>f.state({policyRevision:'p3'}));
    await c.generationConfirmed(preview,'synthetic');
    assert.equal(f.requests.length,1);assert.equal(c.snapshot().generation?.phase,'error');
    assert.equal(c.snapshot().generation?.hits.length,0);
  });
});
test('POLICY.3a cancellation retains physical gate and rejects foreign/repeated source versions',async()=>{
  const i={role:'generation' as const,config,scopeId:hash('root'),scopeBinding:hash('scope'),ownerId:'owner',hostId:'host',credentialEpoch:1,
    deadlineUnixMs:Date.now()+5000,payloadDigest:hash('payload'),scopeSources:[{sourceId:'a.md',sourceSha256:hash('a')}],
    sources:[{sourceId:'a.md',sourceSha256:hash('a'),excerptDigest:hash('x')}]};
  const gate=new GenerationPolicyGate(),abort=new AbortController();let release!:(e:PolicyEnvelope)=>void,entered!:()=>void;
  const hold=new Promise<PolicyEnvelope>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const port={current:()=>false,evaluate:async()=>{entered();return hold;}};
  const first=gate.evaluate(port,i,{signal:abort.signal,deadlineUnixMs:i.deadlineUnixMs},()=>true);
  const rejected=assert.rejects(first,{message:'CANCELLED'});
  await started;abort.abort();await rejected;assert.equal(gate.busy,true);
  await assert.rejects(gate.evaluate(port,i,{signal:new AbortController().signal,deadlineUnixMs:i.deadlineUnixMs},()=>true),{message:'BUSY'});
  release({policyVersion:'oks-policy-1b',allowed:false,reason:'cancelled',bindingDigest:null,rootId:i.scopeId,sourceVersions:[]});await flush();
  assert.equal(gate.busy,false);
  assert.throws(()=>uniquePolicySources([i.sources[0]!,{sourceId:'a.md',sourceSha256:hash('b')}]),{message:'DISCLOSURE_DENIED'});
  assert.throws(()=>policyOriginals({...i,sources:[{...i.sources[0]!,sourceId:'foreign.md'}]}),{message:'DISCLOSURE_DENIED'});
});
test('POLICY.3a exact grant never projects unknown note text without the trusted renewed policy',()=>{
  const query={text:'synthetic question',classification:'synthetic' as const};
  const candidates=[{text:'synthetic original',classification:'unknown' as const,sourceId:'a.md',sourceSha256:hash('a')}];
  const scopeId=hash('root'),deadlineUnixMs=Date.now()+5000;
  const binding={bindingDigest:hash('binding'),scopeBinding:hash('scope'),deadlineUnixMs,
    payloadDigest:generationPolicyPayload(query.text,candidates),
    sourceDigest:hash(JSON.stringify(candidates.map(c=>[c.sourceId,c.sourceSha256,hash(c.text)])))};
  const grant={version:1 as const,role:'generation' as const,configDigest:configDigest('generation',config),scopeId,
    expiresUnixMs:deadlineUnixMs,queryDigest:hash(query.text),queryClassification:query.classification,
    notePolicyBinding:binding,sources:candidates.map(c=>({sourceId:c.sourceId,sourceSha256:c.sourceSha256,classification:c.classification,excerptDigest:hash(c.text)}))};
  const signal=new AbortController().signal;
  assert.throws(()=>projectDisclosure('generation',config,scopeId,query,candidates,grant,signal),{message:'DISCLOSURE_DENIED'});
  assert.throws(()=>projectDisclosure('generation',config,scopeId,{...query,classification:'unknown'},candidates,grant,signal,Date.now(),binding),{message:'DISCLOSURE_DENIED'});
  assert.throws(()=>projectDisclosure('generation',config,scopeId,query,[{...candidates[0]!,text:'changed'}],grant,signal,Date.now(),binding),{message:'DISCLOSURE_DENIED'});
  assert.deepEqual(projectDisclosure('generation',config,scopeId,query,candidates,grant,signal,Date.now(),binding),
    {query:query.text,passages:[{id:0,text:candidates[0]!.text}]});
});

test('POLICY.3a shared retirement and terminal sealing preserve physical preview ownership',async()=>{
  for(const terminal of [false,true]){
    let release!:(value:PolicyEnvelope)=>void,entered!:()=>void,signal:AbortSignal|undefined;
    const hold=new Promise<PolicyEnvelope>(r=>release=r),started=new Promise<void>(r=>entered=r);
    await fixture({'a.md':raw()},async f=>{
      const port={current:()=>false,evaluate:async(_input:GenerationPolicyInput,context:import('../plugin/src/ai/contracts').CallContext)=>{
        signal=context.signal;entered();return hold;}};
      const c=new SearchController(async()=>{},undefined,undefined,undefined,
        {config:()=>f.config,scopeId:()=>f.reader.rootId,verify:async hit=>{verifySpan(hit,await f.reader.read(hit.sourceId));}},undefined,undefined,port);
      c.attach(f.engine);
      try{
        assert.equal((await c.search(uiRequest(request.query,3))).ok,true);
        const preview=c.prepareGenerationWithPolicy('synthetic-token');
        const rejected=assert.rejects(preview,{message:'CANCELLED'});
        await started;
        assert.equal(c.evidenceOperationStatus('generation').phase,'busy');
        signal!.addEventListener('abort',()=>{
          assert.equal(c.snapshot().generation?.phase==='results',false);
          void assert.rejects(c.prepareGenerationWithPolicy('another'),{message:'BUSY'});
        });
        if(terminal){c.sealTerminal();assert.equal(signal!.aborted,false);c.dispose();}
        else c.cancelGeneration();
        await rejected;assert.equal(signal!.aborted,true);
        await assert.rejects(c.prepareGenerationWithPolicy('another'),{message:'BUSY'});
        release({policyVersion:'oks-policy-1b',allowed:false,reason:'cancelled',bindingDigest:null,rootId:f.reader.rootId,sourceVersions:[]});
        await flush();
        assert.equal(f.requests.length,0);
      }finally{release({policyVersion:'oks-policy-1b',allowed:false,reason:'cancelled',bindingDigest:null,rootId:f.reader.rootId,sourceVersions:[]});c.dispose();}
    });
  }
});
test('POLICY.3a canonical worker remains reserved after logical original-read cancellation',async()=>{
  const notes={'a.md':raw()};
  await fixture(notes,async f=>{
    const original=f.reader.read.bind(f.reader);
    let release!:()=>void,entered!:()=>void;
    const hold=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
    const abort=new AbortController(),i=policyInput(f,notes,['a.md']);
    f.reader.read=async path=>{entered();await hold;return original(path);};
    try{
      const gate=new GenerationPolicyGate();
      const first=gate.evaluate(f.host,i,{signal:abort.signal,deadlineUnixMs:i.deadlineUnixMs},()=>true);
      const rejected=assert.rejects(first,{message:'CANCELLED'});
      await started;abort.abort();await rejected;await flush();
      await assert.rejects(f.engine.previewPolicyMetadata('a.md',()=>true),{message:'PARSER_BUSY'});
      release();await f.engine.whenIdle();
      // Engine idleness precedes settlement of the host gate wrapper.
      await gate.drain();
      f.reader.read=original;
      const proof=await f.engine.previewPolicyMetadata('a.md',()=>true);
      assert.equal(proof.state,'absent');
    }finally{release();f.reader.read=original;}
  });
});

test('POLICY.3b rerank canonical originals, exact role and shared credential authority',async()=>{
  await fixture({'a.md':raw('external','REQ-42 public needle.'),'b.md':raw('private','REQ-42 private needle.')},async f=>{
    const c=f.controller;
    const profile={profileId:'rerank-fixture',admissionId:'synthetic-review',role:'reranking' as const,
      configDigest:configDigest('reranking',f.config),adapter:'synthetic-adapter',classification:'external' as const};
    f.state({profile});
    const registry=(c as unknown as {rerankProfiles:RerankRuntimeProfiles}).rerankProfiles;
    registry.installSyntheticFixture(f.config,f.reader.rootId,'policy-rerank-fixture');
    assert.equal((await c.search(uiRequest('REQ-42',5))).ok,true);
    assert.throws(()=>c.prepareRerank(),{message:'NOT_READY'});
    await assert.rejects(c.prepareRerankWithPolicy('synthetic-token'),{message:'DISCLOSURE_DENIED'});
    assert.equal(f.requests.length,0);
    assert.equal((await c.search(uiRequest('public',5))).ok,true);
    const prepare=()=>c.prepareRerankWithPolicy('synthetic-token');
    const first=await prepare();assert.ok(first.policy);assert.equal(first.role,'reranking');
    await assert.rejects(c.rerankConfirmed(first,'synthetic','other-token'),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(c.prepareGenerationWithPolicy('other-token'),{message:'BUSY'});
    await assert.rejects(c.generationConfirmed(first,'synthetic'),{message:'DISCLOSURE_DENIED'});
    const foreign=c.createGenerationViewOwner();
    await assert.rejects(c.rerankConfirmedWithPolicy(first,'synthetic',foreign),{message:'DISCLOSURE_DENIED'});
    await c.rerankConfirmedWithPolicy(first,'synthetic');
    assert.equal(c.snapshot().rerank?.phase,'results',JSON.stringify(c.snapshot().rerank));
    assert.deepEqual(f.requests,[{model:'synthetic-generator@fixture-v1',query:'public',
      documents:['REQ-42 public needle.'],top_n:1,max_tokens_per_query:0,max_tokens_per_doc:0}]);
    assert.deepEqual(f.authorization,['Bearer synthetic-token']);
    await assert.rejects(c.rerankConfirmedWithPolicy(first,'synthetic'),{message:'DISCLOSURE_DENIED'});
    const wrongRole=await prepare();
    f.state({profile:{...profile,role:'generation'}});
    await assert.rejects(c.rerankConfirmedWithPolicy(wrongRole,'synthetic'),{message:'CANCELLED'});
    assert.equal(f.requests.length,1);
    f.state({profile});
    const cancelled=await prepare();c.cancelRerank();
    await assert.rejects(c.rerankConfirmedWithPolicy(cancelled,'synthetic'),{message:'DISCLOSURE_DENIED'});
    const revoked=await prepare();f.state({policyRevision:'p2'});
    await assert.rejects(c.rerankConfirmedWithPolicy(revoked,'synthetic'),{message:'CANCELLED'});
    assert.equal(f.requests.length,1);
    const publication=await prepare();f.onResponse(()=>f.state({policyRevision:'p3'}));
    await c.rerankConfirmedWithPolicy(publication,'synthetic');
    assert.equal(c.snapshot().rerank?.phase,'error');assert.equal(f.requests.length,2);
  });
});

test('POLICY.3b synchronous preview guard revokes changed policy ports and bindings before publication',async()=>{
  await fixture({'a.md':raw('external')},async f=>{
    const c=f.controller;
    const rerankProfile={profileId:'rerank-fixture',admissionId:'synthetic-review',role:'reranking' as const,
      configDigest:configDigest('reranking',f.config),adapter:'synthetic-adapter',classification:'external' as const};
    (c as unknown as {rerankProfiles:RerankRuntimeProfiles}).rerankProfiles.installSyntheticFixture(f.config,f.reader.rootId,'policy-rerank-fixture');
    assert.equal((await c.search(uiRequest('REQ-42',5))).ok,true);
    for(const role of ['generation','reranking'] as const){
      f.state({profile:role==='generation'?{profileId:'generation-fixture',admissionId:'synthetic-review',role,
        configDigest:configDigest(role,f.config),adapter:'synthetic-adapter',classification:'external'}:rerankProfile,policyRevision:'p1',restrictions:[],rules:undefined});
      const prepare=role==='generation'?()=>c.prepareGenerationWithPolicy('synthetic-token'):()=>c.prepareRerankWithPolicy('synthetic-token');
      const confirm=(preview:Parameters<SearchController['generationConfirmed']>[0])=>role==='generation'
        ?c.generationConfirmed(preview,'synthetic'):c.rerankConfirmedWithPolicy(preview,'synthetic');
      const before=f.requests.length;
      const profile=role==='generation'?{profileId:'generation-fixture',admissionId:'synthetic-review',role,
        configDigest:configDigest(role,f.config),adapter:'synthetic-adapter',classification:'external' as const}:rerankProfile;
      const baseline={profile,policyRevision:'p1',restrictions:[],rules:undefined};
      const internals=c as unknown as {
        prepared:Record<string,{credential:{owner:object;configuration:string;stamp:GenerationCredentialStamp}}>;
        generationCredential:GenerationCredentialAuthority;
        generationPolicyPort:GenerationPolicyHost;
        rerankPolicyPort:RerankPolicyHost;
      };
      const assertRevoked=async(preview:Awaited<ReturnType<typeof prepare>>,mutate:()=>void)=>{
        const credential=internals.prepared[role]!.credential;
        assert.equal(internals.generationCredential.current(credential.owner,credential.configuration,credential.stamp),true);
        mutate();
        // Reproduce the reviewer's read boundary before attempting confirmation.
        assert.equal(c.isEvidencePreviewCurrent(role,preview.sequence),false);
        assert.deepEqual(c.evidenceOperationStatus(role),{phase:'failed',error:'CANCELLED'});
        assert.equal(internals.generationCredential.current(credential.owner,credential.configuration,credential.stamp),false);
        await assert.rejects(confirm(preview),{message:'DISCLOSURE_DENIED'});
        assert.equal(f.requests.length,before);
      };
      for(const patch of ([{policyRevision:'p2'},{profile:{...profile,profileId:'replacement'}},
        {restrictions:[{scope:'all' as const,sourceId:'a.md'}]},
        {rules:{version:NEW_MATERIAL_RULE_CONFIG_VERSION,defaultAction:'set-private' as const,rules:[]}}] satisfies Partial<GenerationPolicyHostState>[])){
        f.state(baseline);
        await assertRevoked(await prepare(),()=>f.state(patch));
      }
      f.state(baseline);
      const key=role==='generation'?'generationPolicyPort':'rerankPolicyPort';
      const ports=c as unknown as Record<string,unknown>;
      const selected=ports[key] as {current:Function;evaluate:Function};
      await assertRevoked(await prepare(),()=>{ports[key]={current:selected.current.bind(selected),evaluate:selected.evaluate.bind(selected)};});
      ports[key]=selected;
      const revokePreview=await prepare();
      const credential=internals.prepared[role]!.credential;
      await assertRevoked(revokePreview,()=>internals.generationCredential.revoke(credential.owner));
      // An observer changing policy must not leave an authoritative credential
      // for a subsequent observer, even if the latter does not poll first.
      let first=false,second=false;
      const off1=c.subscribeEvidence(()=>{
        if(!first&&c.evidenceOperationStatus(role).phase==='permission-required'){
          first=true;f.state({policyRevision:'observer-change'});
        }
      });
      const off2=c.subscribeEvidence(()=>{
        if(first)second=internals.prepared[role]===undefined;
      });
      try{await assert.rejects(prepare(),{message:'CANCELLED'});assert.equal(first,true);assert.equal(second,true);}
      finally{off1();off2();}
      f.state(baseline);
      const old=await prepare(),replacement=await prepare();
      await assert.rejects(confirm(old),{message:'DISCLOSURE_DENIED'});
      await assert.rejects(confirm(replacement),{message:'DISCLOSURE_DENIED'});
      assert.equal(f.requests.length,before);
      // A fresh exact binding recovers; a forged foreign credential stamp
      // never consumes that recovered capability or reaches the transport.
      const preview=await prepare();
      const foreign={...preview,credentialStamp:{...preview.credentialStamp!,hostId:'foreign-host'}};
      await assert.rejects(confirm(foreign),{message:'DISCLOSURE_DENIED'});
      assert.equal(f.requests.length,before);
      await confirm(preview);
      assert.equal(f.requests.length,role==='generation'?1:2);
    }
    assert.deepEqual(f.authorization,['Bearer synthetic-token','Bearer synthetic-token']);
  });
});
test('POLICY.3b prospective credentials exclude other roles and retained chat through dispatch and cancellation',async()=>{
  await fixture({'a.md':raw('external')},async f=>{
    const c=f.controller;
    const profile=(role:'generation'|'reranking')=>({profileId:role+'-fixture',admissionId:'synthetic-review',role,
      configDigest:configDigest(role,f.config),adapter:'synthetic-adapter',classification:'external' as const});
    (c as unknown as {rerankProfiles:RerankRuntimeProfiles}).rerankProfiles.installSyntheticFixture(f.config,f.reader.rootId,'policy-rerank-fixture');
    assert.equal((await c.search(uiRequest('REQ-42',5))).ok,true);
    const session=c.openRetainedChatSession();
    const retained=()=>c.startRetainedChatTurn(session,selector('a.md'),request);
    f.state({profile:profile('generation')});
    const g=await c.prepareGenerationWithPolicy('generation-token');
    await assert.rejects(c.prepareRerankWithPolicy('rerank-token'),{message:'BUSY'});
    assert.equal((await retained().result).ok,false);
    let competing:Promise<unknown>|undefined;
    f.onResponse(()=>{competing=assert.rejects(c.prepareRerankWithPolicy('rerank-token'),{message:'BUSY'});});
    await c.generationConfirmed(g,'synthetic');await competing;assert.ok(competing);
    f.onResponse(()=>{});
    f.state({profile:profile('reranking')});
    const r=await c.prepareRerankWithPolicy('rerank-token');
    assert.deepEqual(await retained().result,{apiVersion:1,ok:false,error:'BUSY'});
    c.cancelRerank();await assert.rejects(c.rerankConfirmedWithPolicy(r,'synthetic'),{message:'DISCLOSURE_DENIED'});
    f.state({profile:profile('generation')});
    const turn=retained();assert.equal((await turn.result).ok,true);
    const stamp=await c.bindRetainedGenerationCredential(session,turn.owner,'retained-token');
    await assert.rejects(c.prepareRerankWithPolicy('rerank-token'),{message:'BUSY'});
    let draft=c.createRetainedChatClassificationDraft(session,turn.owner,stamp);
    draft=c.attestRetainedChatClassification(session,turn.owner,draft,draft.question.id,'synthetic');
    const preview=await c.prepareRetainedChatGeneration(session,turn.owner,draft);
    await assert.rejects(c.prepareRerankWithPolicy('rerank-token'),{message:'BUSY'});
    c.cancelRetainedChatTurn(session,turn.owner);
    assert.equal((await c.confirmRetainedChatGeneration(session,turn.owner,preview)).ok,false);
    f.state({profile:profile('reranking')});
    const fresh=await c.prepareRerankWithPolicy('rerank-token');
    f.onResponse(()=>{competing=assert.rejects(c.prepareGenerationWithPolicy('generation-token'),{message:'BUSY'});});
    await c.rerankConfirmedWithPolicy(fresh,'synthetic');await competing;
    assert.deepEqual(f.authorization,['Bearer generation-token','Bearer rerank-token']);
    c.closeRetainedChatSession(session);
  });
});
test('POLICY.3b rerank pending canonical read cannot be replaced after logical cancellation',async()=>{
  await fixture({'a.md':raw('external')},async f=>{
    const c=f.controller;
    f.state({profile:{profileId:'rerank-fixture',admissionId:'synthetic-review',role:'reranking',
      configDigest:configDigest('reranking',f.config),adapter:'synthetic-adapter',classification:'external'}});
    (c as unknown as {rerankProfiles:RerankRuntimeProfiles}).rerankProfiles.installSyntheticFixture(f.config,f.reader.rootId,'policy-rerank-fixture');
    assert.equal((await c.search(uiRequest('REQ-42',5))).ok,true);
    const original=f.reader.read.bind(f.reader);
    let release!:()=>void,entered!:()=>void;
    const hold=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
    f.reader.read=async path=>{entered();await hold;return original(path);};
    try{
      const pending=c.prepareRerankWithPolicy('synthetic-token');
      const rejected=assert.rejects(pending,{message:'CANCELLED'});
      await started;c.cancelRerank();await rejected;
      await assert.rejects(c.prepareRerankWithPolicy('synthetic-token'),{message:'BUSY'});
      release();await f.engine.whenIdle();
      await (f.controller as unknown as {generationPolicyGate:GenerationPolicyGate}).generationPolicyGate.drain();
      f.reader.read=original;
      const next=await c.prepareRerankWithPolicy('synthetic-token');
      await c.rerankConfirmedWithPolicy(next,'synthetic');
      assert.equal(c.snapshot().rerank?.phase,'results',JSON.stringify(c.snapshot().rerank));
      assert.equal(f.requests.length,1);
    }finally{release();f.reader.read=original;}
  });
});

test('POLICY.3b changed original, missing role admission and configured marking fail closed',async()=>{
  await fixture({'a.md':raw('external')},async f=>{
    const c=f.controller;
    const profile={profileId:'rerank-fixture',admissionId:'synthetic-review',role:'reranking' as const,
      configDigest:configDigest('reranking',f.config),adapter:'synthetic-adapter',classification:'external' as const};
    const registry=(c as unknown as {rerankProfiles:RerankRuntimeProfiles}).rerankProfiles;
    assert.equal((await c.search(uiRequest('REQ-42',5))).ok,true);
    f.state({profile});
    await assert.rejects(c.prepareRerankWithPolicy('synthetic-token'),{message:'NOT_READY'});
    registry.installSyntheticFixture(f.config,f.reader.rootId,'policy-rerank-fixture');
    f.state({profile:null});
    await assert.rejects(c.prepareRerankWithPolicy('synthetic-token'),{message:'DISCLOSURE_DENIED'});
    f.state({profile,rules:{version:NEW_MATERIAL_RULE_CONFIG_VERSION,defaultAction:'set-private',rules:[]}});
    await assert.rejects(c.prepareRerankWithPolicy('synthetic-token'),{message:'DISCLOSURE_DENIED'});
    f.state({rules:undefined});
    const preview=await c.prepareRerankWithPolicy('synthetic-token');
    await writeFile(join(f.root,'a.md'),raw('private'));
    await c.rerankConfirmedWithPolicy(preview,'synthetic');
    assert.equal(c.snapshot().rerank?.phase,'error');assert.equal(f.requests.length,0);
  });
});


test('POLICY.3c1 shared policy gate binds embedding purpose, space, complete originals and free text',async()=>{
  const notes:Record<string,string>={'a.md':raw(undefined,'REQ-42: first synthetic paragraph.\n\nREQ-42: second synthetic paragraph.'),'b.md':raw('external'),'private.md':raw('private'),
    'invalid.md':raw('null'),'ambiguous.md':raw('external\nllm_processing: private')};
  await fixture(notes,async f=>{
    const space:EmbeddingSpace={...f.config.identity,dimension:3,normalization:'unit-l2',
      serializationId:'utf8-verbatim-v1',queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
    const spaceId=embeddingSpaceId(f.config,space),scopeId=f.reader.rootId;
    const profile={profileId:'synthetic-embedding',admissionId:'synthetic-review',role:'embedding' as const,
      configDigest:configDigest('embedding',f.config),adapter:'synthetic-adapter',classification:'external' as const};
    let admitted=true,policyRevision='p1',resolved:EmbeddingPolicyScope|null=null;
    const host=new ProcessingPolicyHost<'embedding'>(()=>true,()=>f.engine,()=>({config:f.config,
      profile:admitted?profile:null,adapter:'synthetic-adapter',policyRevision,configRevision:'c1',
      restrictions:[],materials:[],complete:true}),'embedding',()=>resolved);
    const gate=new GenerationPolicyGate(),abort=new AbortController();
    const corpus=await f.engine.captureDenseCorpus(['a.md','b.md'],8,abort.signal);
    const makeInput=(purpose:'query'|'document',paths:string[],hits:readonly EvidenceHit[]):EmbeddingPolicyInput=>{
      const sources=hits.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,excerptDigest:hash(hit.originalExcerpt)}));
      const query=purpose==='query'?'synthetic query':'synthetic batch';
      return {role:'embedding',config:f.config,scopeId,ownerId:'fixture-owner',hostId:'fixture-host',credentialEpoch:1,
        deadlineUnixMs:Date.now()+5000,scopeBinding:resolved!.scopeBinding,
        scopeSources:paths.map(sourceId=>({sourceId,sourceSha256:hash(notes[sourceId]!)})),sources,
        embedding:{purpose,space,spaceId,query,queryClassification:'synthetic'},
        payloadDigest:embeddingPolicyPayload(purpose,spaceId,query,'synthetic',sources)};
    };
    const evaluate=(i:EmbeddingPolicyInput,signal=abort.signal)=>gate.evaluate(host,i,{signal,deadlineUnixMs:i.deadlineUnixMs},()=>true);
    assert.equal(corpus.evidence.filter(h=>h.sourceId==='a.md').length,2);
    const docScope=resolveEmbeddingPolicyScope(corpus,'document',corpus.evidence);
    const queryScope=resolveEmbeddingPolicyScope(corpus,'query',[]);
    resolved=docScope;const document=makeInput('document',['a.md','b.md'],corpus.evidence);
    const docBinding=await evaluate(document);
    resolved=queryScope;const query=makeInput('query',['a.md','b.md'],[]);
    const queryBinding=await evaluate(query);
    assert.notEqual(docBinding.bindingDigest,queryBinding.bindingDigest);
    await assert.rejects(f.engine.captureDenseCorpus(['a.md','ambiguous.md'],8,abort.signal),{message:'EVIDENCE_INCOMPLETE'});
    for(const path of ['private.md','invalid.md']){
      const mixed=await f.engine.captureDenseCorpus(['a.md',path],8,abort.signal);
      const planned=mixed.evidence.filter(h=>h.sourceId==='a.md');
      resolved=resolveEmbeddingPolicyScope(mixed,'document',planned);
      await assert.rejects(evaluate(makeInput('document',['a.md',path],planned)),{message:'DISCLOSURE_DENIED'});
      await assert.rejects(evaluate(makeInput('document',['a.md'],planned)),{message:'DISCLOSURE_DENIED'});
      resolved=resolveEmbeddingPolicyScope(mixed,'query',[]);
      await assert.rejects(evaluate(makeInput('query',['a.md',path],[])),{message:'DISCLOSURE_DENIED'});
      await assert.rejects(evaluate(makeInput('query',['a.md'],[])),{message:'DISCLOSURE_DENIED'});
    }
    resolved=queryScope;
    admitted=false;await assert.rejects(evaluate(query),{message:'DISCLOSURE_DENIED'});admitted=true;
    await assert.rejects(evaluate({...query,embedding:{...query.embedding,spaceId:hash('foreign')}}),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(evaluate({...query,embedding:{...query.embedding,purpose:'document'}}),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(evaluate({...query,embedding:{...query.embedding,queryClassification:'public'}}),{message:'DISCLOSURE_DENIED'});
    const approve=async(i:EmbeddingPolicyInput,hits:readonly EvidenceHit[])=>{
      const binding=await evaluate(i);
      const value:EmbeddingApproval={config:f.config,space,purpose:i.embedding.purpose,scopeId,
        query:{text:i.embedding.query,classification:i.embedding.queryClassification},
        candidates:hits.map(hit=>({hit,classification:'unknown'})),
        grant:{version:1,role:'embedding',purpose:i.embedding.purpose,spaceId,configDigest:profile.configDigest,scopeId,
          expiresUnixMs:i.deadlineUnixMs,queryDigest:hash(i.embedding.query),queryClassification:i.embedding.queryClassification,
          notePolicyBinding:binding,sources:i.sources.map(s=>({...s,classification:'unknown'}))}};
      return value;
    };
    const embedder=new EvidenceEmbedder();
    const run=(i:EmbeddingPolicyInput,value:EmbeddingApproval,check=()=>evaluate(i),signal=abort.signal)=>
      embedder.run(value,'synthetic-token',{signal,deadlineUnixMs:i.deadlineUnixMs},corpus.verify,corpus.current,check);
    resolved=docScope;
    await assert.rejects(evaluate(makeInput('document',['a.md','b.md'],corpus.evidence.filter(h=>h.sourceId==='a.md'))),{message:'DISCLOSURE_DENIED'});
    let value=await approve(document,corpus.evidence);
    await assert.rejects(run(document,value,()=>evaluate({...document,credentialEpoch:2})),{message:'DISCLOSURE_DENIED'});
    for(const patch of [{ownerId:'foreign-owner'},{hostId:'foreign-host'}])
      await assert.rejects(run(document,value,()=>evaluate({...document,...patch})),{message:'DISCLOSURE_DENIED'});
    await assert.rejects(run(document,value,()=>Promise.resolve(queryBinding)),{message:'DISCLOSURE_DENIED'});
    assert.equal(f.requests.length,0);
    const result=await run(document,value);
    assert.equal(result.batch.vectors.length,corpus.evidence.length);
    assert.deepEqual(f.requests[0],{model:'synthetic-generator@fixture-v1',input:corpus.evidence.map(h=>h.originalExcerpt),encoding_format:'float'});
    resolved=queryScope;value=await approve(query,[]);
    const during=new AbortController();
    await assert.rejects(run(query,value,async()=>{const binding=await evaluate(query);during.abort();return binding;},during.signal),{message:'CANCELLED'});
    assert.equal(f.requests.length,1);
    await run(query,value);
    assert.deepEqual(f.requests[1],{model:'synthetic-generator@fixture-v1',input:['synthetic query'],encoding_format:'float'});
    assert.deepEqual(f.authorization,['Bearer synthetic-token','Bearer synthetic-token']);
    policyRevision='p2';
    await assert.rejects(run(query,value),{message:'DISCLOSURE_DENIED'});
    assert.equal(f.requests.length,2);
    value=await approve(query,[]);
    f.onResponse(()=>{policyRevision='p3';});
    await assert.rejects(run(query,value),{message:'DISCLOSURE_DENIED'});
    assert.equal(f.requests.length,3);
    f.onResponse(()=>{});
    const cancelled=new AbortController();cancelled.abort();
    value=await approve(query,[]);
    await assert.rejects(run(query,value,()=>evaluate(query),cancelled.signal),{message:'CANCELLED'});
    assert.equal(f.requests.length,3);
  });
});

test('POLICY.3d2 completed local-only lineage is not a grant; fresh history rejects policy drift and missed source edits',async()=>{
  await fixture({'a.md':raw('external'),'b.md':raw('external','Unrelated synthetic material.')},async f=>{
    const c=f.controller,session=c.openRetainedChatSession();
    const complete=async()=>{
      const turn=c.startRetainedChatTurn(session,{mode:'vault-wide'},request);
      assert.equal((await turn.result).ok,true);
      const stamp=await c.bindRetainedGenerationCredential(session,turn.owner,'synthetic-token');
      let draft=c.createRetainedChatClassificationDraft(session,turn.owner,stamp);
      draft=c.attestRetainedChatClassification(session,turn.owner,draft,draft.question.id,'synthetic');
      const preview=await c.prepareRetainedChatGeneration(session,turn.owner,draft);
      assert.equal((await c.confirmRetainedChatGeneration(session,turn.owner,preview)).ok,true);
      const verified=await c.readVerifiedRetainedChatHistory(session);
      assert.equal(verified.ok,true);
      if(!verified.ok)throw Error('fixture');
      const completed=verified.value.at(-1)!;
      assert.equal(completed.lineage.use,'local-only');
      assert.equal(completed.lineage.policyBindingDigest,preview.policy!.bindingDigest);
      assert.equal(completed.lineage.payloadDigest,preview.policy!.payloadDigest);
      assert.equal(completed.lineage.sourceDigest,preview.policy!.sourceDigest);
      assert.equal(completed.lineage.questions[0]!.digest,hash(request.query));
      assert.equal(completed.lineage.questions[0]!.classification,'synthetic');
      assert.deepEqual(completed.lineage.selector,{mode:'vault-wide'});
      assert.equal('question' in c.readRetainedChatHistory(session)[0]!,false);
      const serialized=JSON.stringify(completed);
      assert.equal(serialized.includes('synthetic-token'),false);
      for(const field of ['credentialStamp','credentialEpoch','deadlineUnixMs','expiresUnixMs','grant'])
        assert.equal(serialized.includes('"'+field+'"'),false);
      return completed.id;
    };
    const first=await complete();
    assert.equal(f.requests.length,1);
    f.state({policyRevision:'p2'});
    const stale=c.startRetainedChatTurn(session,{mode:'vault-wide'},request,[first]);
    assert.equal((await stale.result).ok,false);
    assert.deepEqual(c.readRetainedChatHistory(session),[]);
    assert.equal(f.requests.length,1);
    await complete();
    f.state({policyRevision:'p3'});
    assert.deepEqual(await c.readVerifiedRetainedChatHistory(session),{apiVersion:1,ok:false,error:'SOURCE_STALE'});
    assert.deepEqual(c.readRetainedChatHistory(session),[]);
    assert.equal(f.requests.length,2);
    await complete();
    // Change a non-cited member without a source event or rebuilt index.
    await writeFile(join(f.root,'b.md'),raw('private','Unrelated synthetic material.'));
    assert.equal((await c.readVerifiedRetainedChatHistory(session)).ok,false);
    assert.deepEqual(c.readRetainedChatHistory(session),[]);
    assert.equal(f.requests.length,3);
  });
});
