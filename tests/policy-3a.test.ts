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
import {GenerationPolicyHost,type GenerationPolicyHostState} from '../plugin/src/ai/generation-policy-host';
import {GenerationPolicyGate,generationPolicyPayload,policyOriginals,uniquePolicySources,type GenerationPolicyInput} from '../plugin/src/ai/generation-policy';
import {configDigest,projectDisclosure} from '../plugin/src/ai/disclosure';
import {NEW_MATERIAL_RULE_CONFIG_VERSION,type NewMaterialRuleConfig} from '../plugin/src/ai/new-material-policy';
import type {ProviderConfig} from '../plugin/src/ai/contracts';
import type {PolicyEnvelope} from '../plugin/src/ai/processing-policy';

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
  onResponse:(callback:()=>void)=>void;
})=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'oks-policy-3a-synthetic-'));
  const requests:unknown[]=[];
  let beforeResponse=()=>{};
  const server=createServer((req:IncomingMessage,res:ServerResponse)=>{
    let wire='';req.on('data',chunk=>wire+=String(chunk));req.on('end',()=>{
      const payload=JSON.parse(wire);
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
    controller=new SearchController(async()=>{},undefined,undefined,undefined,
      {config:()=>cfg,scopeId:()=>reader.rootId,verify:async hit=>{verifySpan(hit,await reader.read(hit.sourceId));}},undefined,undefined,host);
    controller.attach(engine);
    await use({engine,reader,root,config:cfg,host,controller,state:patch=>{state={...state,...patch};},
      lifecycle:value=>{lifecycle=value;},requests,onResponse:callback=>{beforeResponse=callback;}});
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
      f.reader.read=original;
      const proof=await f.engine.previewPolicyMetadata('a.md',()=>true);
      assert.equal(proof.state,'absent');
    }finally{release();f.reader.read=original;}
  });
});
