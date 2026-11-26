/** Internal host-owned API dense operation/consent boundary (D6).
 * No persistent consent, provider calls at startup, or public machine API. */
import { randomUUID } from 'node:crypto';
import { canonical } from '../advanced/protocol';
import { AdvancedRetrievalStore } from '../advanced/retrieval-storage';
import { trustedVaultRoot } from '../advanced/source';
import { BOUNDS, hash, isRecord, validPath, validateRequest, type EvidenceHit, type SearchRequest } from '../standalone/contracts';
import type { SelectedCorpus, StandaloneEngine } from '../standalone/engine';
import { ProviderFailure, type EmbeddingSpace, type ProviderConfig, type ProviderPreference } from './contracts';
import { configDigest } from './disclosure';
import { MAX_API_VECTORS } from './dense-generation';
import { ApiDenseIndexManager, INDEX_PURPOSE_TEXT, planDenseBatches, type DenseIndexGrantInput, type DenseIndexResult } from './dense-index-manager';
import { ApiDenseSearch, type ApiRetrievalResult } from './dense-retrieval';
import type { EmbeddingApproval } from './embedding-evidence';
import { embeddingSpaceId, validateEmbeddingSpace } from './embedding-space';
import { pilotConfig } from './loopback-json';
import { GenerationCredentialAuthority, type GenerationCredentialStamp } from './generation-credential';
import { GenerationPolicyGate, type GenerationPolicyBinding, type ProcessingPolicyInput, type ProcessingPolicyPort } from './generation-policy';
import { embeddingPolicyPayload, resolveEmbeddingPolicyScope,type EmbeddingPolicyScope } from './embedding-policy';
import { bindActiveDeadline,remainingOperationMs } from './active-deadline';
import type { CallContext } from './contracts';
import { sameGenerationPolicy } from './generation-policy';

export type DenseRequest = { paths: readonly string[]; space: EmbeddingSpace } &
  ({kind:'rebuild'} | {kind:'search';request:SearchRequest&{requestedMode:'dense'|'hybrid'}});
export type DensePreview = { nonce:string; scopeId:string; lexicalGenerationId:string;
  expiresUnixMs:number; config:ProviderConfig; operation:DenseRequest; evidence:readonly EvidenceHit[];
  credentialStamp?:GenerationCredentialStamp; policyBindings?:readonly GenerationPolicyBinding[]; policyClassification?:Classification };
export type MachineFence = {digest:string;expiresUnixMs:number};
type Classification = 'synthetic'|'public';
type PolicyEntry={input:ProcessingPolicyInput<'embedding'>;scope:EmbeddingPolicyScope;binding?:GenerationPolicyBinding};
type PolicyAttempt={owner:object;ownerId:string;classification:Classification;configuration:string;stamp:GenerationCredentialStamp;
  port:ProcessingPolicyPort<'embedding'>; entries:Map<string,PolicyEntry>; retired:boolean;inFlight:boolean;completed:boolean;
  timer?:ReturnType<typeof setTimeout>;context?:CallContext;current?:()=>boolean;result?:DenseIndexResult|ApiRetrievalResult;resultFence?:()=>boolean};
type Binding = { preview:DensePreview; lease:SelectedCorpus; abort:AbortController; current():boolean; policy?:PolicyAttempt };
type DenseRetirement = {store?:AdvancedRetrievalStore;abort?:AbortController};
type HostPort = { config():ProviderPreference; enabled():boolean; allowedPath(path:string):boolean; admitStorage():Promise<void> };
export type DensePolicyPort=Readonly<{selected():boolean; policy:ProcessingPolicyPort<'embedding'>; credentials:GenerationCredentialAuthority;gate:GenerationPolicyGate;admit():boolean}>;
const fail = (code:ConstructorParameters<typeof ProviderFailure>[0]):never => { throw new ProviderFailure(code); };

export class ApiDenseHost {
  private revision=0;
  private disposed=false;
  private active?:Promise<unknown>;
  private abort?:AbortController;
  private prepared?:Binding;
  // Source-event retry reuses the same immutable path array supplied by the
  // caller's ledger. Keep the original store/abort even if a late operation
  // settled or the host detached its store. Weak keys do not extend lifetimes.
  private readonly sourceRetirements=new WeakMap<readonly string[],DenseRetirement>();
  private sharedRetirement?:DenseRetirement;
  private store?:AdvancedRetrievalStore;
  private indexer?:ApiDenseIndexManager;
  private searcher?:ApiDenseSearch;
  constructor(private readonly engine:StandaloneEngine,private readonly rootPath:string,
    private readonly rootId:string,private readonly pluginId:string,private readonly port:HostPort,
    private readonly now=Date.now,private readonly policyPort?:DensePolicyPort) {}
  private attempt?:PolicyAttempt;
  private readingPolicy=false;
  policySelected():boolean {return !!this.policyPort?.selected();}
  /** The trusted host resolves scope from its own pinned plan, not the caller. */
  resolvedPolicyScope(input:ProcessingPolicyInput<'embedding'>):EmbeddingPolicyScope|null{
    const attempt=this.attempt;
    if(!attempt||attempt.retired||!this.policySelected()||attempt.port!==this.policyPort?.policy
      ||input.hostId!==attempt.stamp.hostId||input.credentialEpoch!==attempt.stamp.epoch
      ||input.ownerId!==attempt.ownerId)return null;
    for(const entry of attempt.entries.values())if(entry.input.scopeBinding===input.scopeBinding
      &&canonical(entry.input)===canonical(input)&&entry.scope.current())return entry.scope;
    return null;
  }
  private releaseAttempt(attempt:PolicyAttempt):void{
    if(attempt.inFlight)return;
    this.policyPort?.credentials.releaseExclusive(attempt.owner);
    if(attempt.retired&&this.attempt===attempt)this.attempt=undefined;
  }
  private settleAttempt(attempt:PolicyAttempt,release:boolean):void{
    const finish=()=>{attempt.inFlight=false;if(release||attempt.retired)this.releaseAttempt(attempt);};
    const gate=this.policyPort!.gate;
    if(gate.busy)void gate.drain().then(finish);else finish();
  }
  private retireAttempt(attempt:PolicyAttempt|undefined):void{
    if(!attempt)return;
    attempt.retired=true;
    if(attempt.timer!==undefined)clearTimeout(attempt.timer);
    attempt.timer=undefined;
    this.policyPort?.credentials.revoke(attempt.owner);
    this.releaseAttempt(attempt);
  }
  private liveAttempt(attempt:PolicyAttempt,credential=true):boolean{
    try{
      if(this.attempt!==attempt||attempt.retired||!this.policySelected()
        ||attempt.port!==this.policyPort?.policy||!attempt.current?.()
        ||!attempt.context||remainingOperationMs(attempt.context)<=0)return false;
      return !credential||this.policyPort!.credentials.current(attempt.owner,attempt.configuration,attempt.stamp);
    }catch{return false;}
  }
  private currentPolicy(attempt:PolicyAttempt,credential=true):boolean{
    if(this.readingPolicy)return false;
    this.readingPolicy=true;
    try{
      if(!this.liveAttempt(attempt,credential)||!attempt.entries.size)return false;
      for(const entry of attempt.entries.values()){
        if(!entry.binding||!entry.scope.current()||!attempt.port.current(entry.input,entry.binding)
          ||!this.liveAttempt(attempt,credential))return false;
      }
      return true;
    }catch{return false;}finally{this.readingPolicy=false;}
  }
  isPreviewCurrent(preview:DensePreview):boolean{
    const pending=this.prepared;
    if(!pending||canonical(preview)!==canonical(pending.preview))return false;
    if(pending.current())return true;
    this.invalidate();return false;
  }
  isPolicyOperationCurrent():boolean{
    const attempt=this.attempt;
    if(!attempt||attempt.completed)return false;
    if(this.currentPolicy(attempt))return true;
    this.invalidate();return false;
  }
  isResultCurrent(result:DenseIndexResult|ApiRetrievalResult):boolean{
    const attempt=this.attempt;
    if(!attempt?.completed||!attempt.result||canonical(result)!==canonical(attempt.result))return false;
    if(this.currentPolicy(attempt,false)&&attempt.resultFence?.())return true;
    this.invalidate();return false;
  }

  invalidate(path?:string):void { this.invalidateSources(path===undefined?[]:[path]); }
  invalidateSources(paths:readonly string[]):void {
    ++this.revision;
    this.prepared=undefined;
    this.retireAttempt(this.attempt);
    // Both sides of a rename are revoked before an abort listener can run.
    // Try every path before aborting the pinned operation. The enclosing
    // source transaction retains this batch on failure; revocation is idempotent.
    const owner=paths.length?this.sourceRetirements.get(paths)??{store:this.store,abort:this.abort}:
      this.sharedRetirement??{store:this.store,abort:this.abort};
    if(paths.length)this.sourceRetirements.set(paths,owner);else this.sharedRetirement=owner;
    const {store,abort}=owner;
    let failed=false, fault:unknown;
    for(const path of paths) {
      try { store?.revoke(path); }
      catch(error) { if(!failed) fault=error; failed=true; }
    }
    try { abort?.abort(); }
    catch(error) { if(!failed) fault=error; failed=true; }
    if(failed) throw fault;
    if(paths.length)this.sourceRetirements.delete(paths);else this.sharedRetirement=undefined;
  }
  async close():Promise<void> {
    this.disposed=true;
    try {this.invalidate();}
    finally {
      // Even if physical abort threw, wait for the bounded operation to
      // settle. The rejected close still denies ownership transfer.
      await this.active?.catch(()=>{});
      if(this.attempt?.inFlight)await this.policyPort?.gate.drain();
      this.store=undefined;this.indexer=undefined;this.searcher=undefined;
    }
  }
  private config():ProviderConfig {
    if(this.disposed||!this.port.enabled())return fail('DISABLED');
    const config=this.port.config();
    if(config.state==='disabled')return fail('DISABLED');
    if(config.state!=='configured')return fail('CONFIG_INVALID');
    return pilotConfig(config);
  }
  async prepare(input:DenseRequest,fence?:MachineFence):Promise<DensePreview> {
    if(this.policySelected())return fail('NOT_READY');
    if(this.active||this.attempt?.inFlight)return fail('QUOTA_EXCEEDED');
    this.invalidate();
    return this.prepareExact(input,fence);
  }
  /** The policy-selected route obtains one transient token before preview but
   * never treats it as consent; the normal confirm step remains mandatory. */
  async prepareWithCredential(input:DenseRequest,classification:Classification,token:string,fence?:MachineFence):Promise<DensePreview> {
    const policy=this.policyPort;
    if(fence||!policy?.selected()||!['synthetic','public'].includes(classification))return fail('NOT_READY');
    if(this.active||this.attempt?.inFlight||policy.gate.busy)return fail('BUSY');
    this.invalidate();
    if(!policy.admit()||this.active||policy.gate.busy)return fail('BUSY');
    const config=this.config(),owner={},ownerId=randomUUID(),configuration=configDigest('embedding',config);
    if(!policy.admit()||!policy.selected()||this.active)return fail('BUSY');
    const credential=policy.credentials.beginExclusive(owner,configuration);
    let stamp:GenerationCredentialStamp;
    try {stamp=policy.credentials.complete(credential,token);}
    catch(error){policy.credentials.releaseExclusive(owner);throw error;}
    const attempt:PolicyAttempt={owner,ownerId,classification,configuration,stamp,port:policy.policy,
      entries:new Map(),retired:false,inFlight:true,completed:false};
    this.attempt=attempt;
    try{
      const preview=await this.prepareExact(input,undefined,attempt);
      await policy.gate.drain();
      if(!this.isPreviewCurrent(preview))return fail('CANCELLED');
      return preview;
    }
    catch(error){this.retireAttempt(attempt);throw error;}
    finally{
      this.settleAttempt(attempt,false);
    }
  }
  private policyKey(purpose:'query'|'document',batch:readonly EvidenceHit[]):string {
    return hash(canonical([purpose,batch]));
  }
  private planPolicy(lease:SelectedCorpus,config:ProviderConfig,space:EmbeddingSpace,purpose:'query'|'document',
    query:string,batch:readonly EvidenceHit[],attempt:PolicyAttempt,expiresUnixMs:number):void{
    const scope=resolveEmbeddingPolicyScope(lease,purpose,batch),sources=scope.sources,spaceId=embeddingSpaceId(config,space);
    const input:ProcessingPolicyInput<'embedding'>={role:'embedding',config,scopeId:scope.scopeId,ownerId:attempt.ownerId,
      hostId:attempt.stamp.hostId,credentialEpoch:attempt.stamp.epoch,deadlineUnixMs:expiresUnixMs,payloadDigest:embeddingPolicyPayload(
        purpose,spaceId,query,attempt.classification,sources),scopeBinding:scope.scopeBinding,
      scopeSources:scope.scopeSources,sources,embedding:{purpose,space,spaceId,query,queryClassification:attempt.classification}};
    const key=this.policyKey(purpose,batch);
    if(attempt.entries.has(key))return fail('DISCLOSURE_DENIED');
    attempt.entries.set(key,{input,scope});
  }
  private async evaluatePolicy(attempt:PolicyAttempt,entry:PolicyEntry,renew=false):Promise<GenerationPolicyBinding>{
    if(!this.liveAttempt(attempt)||!attempt.context)return fail('CANCELLED');
    const binding=await this.policyPort!.gate.evaluate(attempt.port,entry.input,
      {signal:attempt.context.signal,deadlineUnixMs:entry.input.deadlineUnixMs},()=>this.liveAttempt(attempt)
        &&(!renew||this.currentPolicy(attempt)));
    if(!this.liveAttempt(attempt))return fail('CANCELLED');
    if(renew){if(!sameGenerationPolicy(entry.binding,binding))return fail('DISCLOSURE_DENIED');}
    else entry.binding=binding;
    return binding;
  }
  private async prepareExact(input:DenseRequest,fence?:MachineFence,policyAttempt?:PolicyAttempt):Promise<DensePreview> {
    if(this.active)return fail('QUOTA_EXCEEDED');
    const config=this.config();
    if(fence&&(configDigest('embedding',config)!==fence.digest||fence.expiresUnixMs<=this.now()))
      return fail('CANCELLED');
    if(!isRecord(input)||!['rebuild','search'].includes(input.kind)
      ||Object.keys(input).some(key=>!['kind','paths','space',...(input.kind==='search'?['request']:[])].includes(key))
      ||!Array.isArray(input.paths)||!input.paths.length||input.paths.length>BOUNDS.sources
      ||input.paths.some(path=>!validPath(path))||new Set(input.paths).size!==input.paths.length)
      return fail('CONFIG_INVALID');
    const operation=structuredClone(input);
    operation.space=validateEmbeddingSpace(config,operation.space);
    if(operation.kind==='search'){
      try{validateRequest(operation.request);}catch{return fail('CONFIG_INVALID');}
      if(!['dense','hybrid'].includes(operation.request.requestedMode)||!operation.request.query.trim()
        ||operation.request.requestedMode==='dense'&&operation.request.matchMode==='literal')
        return fail('CONFIG_INVALID');
    }else if(operation.kind!=='rebuild')return fail('CONFIG_INVALID');
    const revision=this.revision,abort=new AbortController(),expiresUnixMs=Math.min(this.now()+(policyAttempt?30000:300000),fence?.expiresUnixMs??Infinity);
    this.abort=abort;
    const digest=configDigest('embedding',config);
    if(policyAttempt&&policyAttempt.configuration!==digest)return fail('CANCELLED');
    let revoked=false;
    const current=():boolean=>{
      try{
        if(this.disposed||abort.signal.aborted||revision!==this.revision||this.now()>=expiresUnixMs
          ||this.policySelected()!==!!policyAttempt
          ||configDigest('embedding',this.config())!==digest
          ||!operation.paths.every(path=>this.port.allowedPath(path)))revoked=true;
      }catch{revoked=true;}
      return !revoked;
    };
    if(policyAttempt){
      policyAttempt.context=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:expiresUnixMs},30000);
      policyAttempt.current=current;
      policyAttempt.timer=setTimeout(()=>{if(this.attempt===policyAttempt){try{this.invalidate();}catch{console.warn('DENSE_POLICY_RETIREMENT_FAILED');}}},Math.max(0,expiresUnixMs-this.now()));
    }
    const execute=async()=>{
      if(!current())return fail('DISCLOSURE_DENIED');
      const lease=await this.engine.captureDenseCorpus(operation.paths,MAX_API_VECTORS,abort.signal);
      if(!current()||!lease.current()||lease.rootId!==this.rootId)return fail('SOURCE_STALE');
      // All document batches are deterministically planned and policy-checked
      // before disclosure is shown, so confirm can never narrow a denied plan.
      if(policyAttempt){
        const plans=operation.kind==='rebuild'?planDenseBatches(lease.evidence,config):[[] as EvidenceHit[]];
        for(const batch of plans)this.planPolicy(lease,config,operation.space,operation.kind==='rebuild'?'document':'query',
          operation.kind==='rebuild'?INDEX_PURPOSE_TEXT:operation.request.query,batch,policyAttempt,expiresUnixMs);
        for(const entry of policyAttempt.entries.values())await this.evaluatePolicy(policyAttempt,entry);
        if(!this.currentPolicy(policyAttempt))return fail('CANCELLED');
      }
      if(!current()||!lease.current())return fail('CANCELLED');
      const preview:DensePreview={nonce:randomUUID(),scopeId:lease.rootId,
        lexicalGenerationId:lease.lexicalGenerationId,expiresUnixMs,config,operation,evidence:structuredClone(lease.evidence)};
      if(policyAttempt){
        preview.credentialStamp=policyAttempt.stamp;
        preview.policyBindings=[...policyAttempt.entries.values()].map(entry=>entry.binding!);
        preview.policyClassification=policyAttempt.classification;
      }
      this.prepared={preview,lease,abort,current:()=>current()&&lease.current()
        &&(!policyAttempt||this.currentPolicy(policyAttempt)),policy:policyAttempt};
      return structuredClone(preview);
    };
    const job=policyAttempt?Promise.resolve().then(execute):execute();
    this.active=job;
    try{return await job;}
    finally{if(this.active===job)this.active=undefined;}
  }
  /** Reuse the authoritative corpus and store verification at deferred result delivery.
   * No new disclosure, provider operation or independent source parser. */
  async verifyMachineResult(operation:Extract<DenseRequest,{kind:'search'}>,fence:MachineFence,
    result:ApiRetrievalResult,signal:AbortSignal):Promise<()=>boolean> {
    if(this.policySelected()||this.active||!this.store)return fail('NOT_READY');
    const revision=this.revision,store=this.store,abort=new AbortController();
    const cancel=()=>abort.abort();
    signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted)cancel();
    const current=()=>!this.disposed&&!abort.signal.aborted&&revision===this.revision
      &&this.now()<fence.expiresUnixMs&&this.store===store
      &&configDigest('embedding',this.config())===fence.digest
      &&operation.paths.every(path=>this.port.allowedPath(path));
    const check=()=>{if(!current())fail('SOURCE_STALE');};
    this.abort=abort;
    const job=(async()=>{
      check();
      const config=this.config(),spaceId=embeddingSpaceId(config,operation.space);
      const lease=await this.engine.captureDenseCorpus(operation.paths,MAX_API_VECTORS,abort.signal);
      check();
      if(!lease.current()||lease.rootId!==this.rootId||lease.lexicalGenerationId!==result.lexicalGenerationId)
        return fail('SOURCE_STALE');
      const snapshot=await store.snapshotApi(spaceId,lease.lexicalGenerationId,abort.signal);
      check();
      if(!snapshot||snapshot.schemaVersion!==2||snapshot.generationId!==result.indexGenerationId||!lease.current()
        ||!store.isApiSnapshotCurrent(snapshot))return fail('SOURCE_STALE');
      return ()=>current()&&!signal.aborted&&lease.current()&&store.isApiSnapshotCurrent(snapshot);
    })();
    this.active=job;
    try{const verify=await job;if(!verify())return fail('SOURCE_STALE');return verify;}
    catch{return fail('SOURCE_STALE');}
    finally{
      signal.removeEventListener('abort',cancel);
      if(this.active===job)this.active=undefined;
      if(this.abort===abort)this.abort=undefined;
    }
  }
  async confirm(preview:DensePreview,classification:Classification,token:string):Promise<DenseIndexResult|ApiRetrievalResult> {
    if(this.active)return fail('QUOTA_EXCEEDED');
    const binding=this.prepared;this.prepared=undefined;
    if(!binding)return fail('DISCLOSURE_DENIED');
    const {preview:approved,lease,abort,current,policy:policyAttempt}=binding;
    try{
      if(!['synthetic','public'].includes(classification)||canonical(approved)!==canonical(preview)
        ||policyAttempt&&(classification!==policyAttempt.classification||token!==''))return fail('DISCLOSURE_DENIED');
      if(!current())return fail('CANCELLED');
    }catch(error){this.retireAttempt(policyAttempt);throw error;}
    if(policyAttempt)policyAttempt.inFlight=true;
    const {config,operation,scopeId,expiresUnixMs}=approved,space=operation.space;
    const exact=new Set(lease.evidence.map(hit=>canonical(hit)));
    const allowed=(hit:EvidenceHit):boolean=>current()&&this.port.allowedPath(hit.sourceId)&&exact.has(canonical(hit));
    const grant=(purpose:'query'|'document',query:string,evidence:readonly EvidenceHit[]):EmbeddingApproval=>{
      if(!current()||!evidence.every(allowed))return fail('DISCLOSURE_DENIED');
      const notePolicyBinding=policyAttempt?.entries.get(this.policyKey(purpose,evidence))?.binding;
      if(policyAttempt&&!notePolicyBinding)return fail('DISCLOSURE_DENIED');
      return {purpose,config,space,scopeId,query:{text:query,classification},
        candidates:evidence.map(hit=>({hit,classification:policyAttempt?'unknown':classification})),
        grant:{version:1,role:'embedding',purpose,spaceId:embeddingSpaceId(config,space),
          configDigest:configDigest('embedding',config),scopeId,expiresUnixMs,
          queryDigest:hash(query),queryClassification:classification,
          sources:evidence.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,
            excerptDigest:hash(hit.originalExcerpt),classification:policyAttempt?'unknown':classification})),
          ...(notePolicyBinding?{notePolicyBinding}:{})}};
    };
    const execute=async()=>{
      if(policyAttempt&&!current())return fail('CANCELLED');
      try{await this.port.admitStorage();}catch{return fail('NOT_READY');}
      if(!current())return fail('CANCELLED');
      const root=await trustedVaultRoot(this.rootPath);
      if(root.id!==scopeId||!current())return fail('SOURCE_STALE');
      const store=this.store??await AdvancedRetrievalStore.open(root,this.pluginId);
      if(!current())return fail('CANCELLED');
      this.store=store;
      this.indexer??=new ApiDenseIndexManager(this.engine,store);
      this.searcher??=new ApiDenseSearch(store);
      if(!current())return fail('CANCELLED');
      const context={signal:abort.signal,deadlineUnixMs:expiresUnixMs};
      const exactToken=policyAttempt?this.policyPort?.credentials.secret(policyAttempt.owner,policyAttempt.configuration,policyAttempt.stamp):token;
      if(!exactToken)return fail('CANCELLED');
      const policyCheck=(purpose:'query'|'document',query:string,evidence:readonly EvidenceHit[],approval:EmbeddingApproval)=>async()=>{
        if(!policyAttempt||approval.grant.notePolicyBinding===undefined)return fail('DISCLOSURE_DENIED');
        const entry=policyAttempt.entries.get(this.policyKey(purpose,evidence));
        if(!entry||entry.input.embedding?.query!==query||!sameGenerationPolicy(entry.binding,approval.grant.notePolicyBinding))
          return fail('DISCLOSURE_DENIED');
        const renewed=await this.evaluatePolicy(policyAttempt,entry,true);
        if(!sameGenerationPolicy(renewed,approval.grant.notePolicyBinding))return fail('DISCLOSURE_DENIED');
        return renewed;
      };
      if(operation.kind==='rebuild'){
        const authorize=(input:DenseIndexGrantInput):EmbeddingApproval=>{
          if(input.scopeId!==scopeId||input.query!==INDEX_PURPOSE_TEXT
            ||configDigest('embedding',input.config)!==configDigest('embedding',config)
            ||embeddingSpaceId(input.config,input.space)!==embeddingSpaceId(config,space))
            return fail('DISCLOSURE_DENIED');
          return grant('document',input.query,input.evidence);
        };
        return this.indexer.rebuild(
          {paths:operation.paths,config,space},exactToken,context,{current,allowed,authorize,
            ...(policyAttempt?{authorizePlan:async inputs=>{
              if(canonical(inputs.map(i=>this.policyKey('document',i.evidence)))!==canonical([...policyAttempt.entries.keys()]))return fail('DISCLOSURE_DENIED');
              return inputs.map(authorize);
            },policyCheck:approval=>policyCheck('document',INDEX_PURPOSE_TEXT,approval.candidates.map(x=>x.hit),approval),publicationFence:(fence:()=>boolean)=>{policyAttempt.resultFence=fence;}}:{})});
      }
      return this.searcher.run({request:operation.request,lexicalGenerationId:lease.lexicalGenerationId,
        evidence:lease.evidence,approval:grant('query',operation.request.query,[])},exactToken,context,
        {current,allowed,lexical:req=>this.engine.search(req),metadataPaths:lease.metadataPaths,
          ...(policyAttempt?{policyCheck:approval=>policyCheck('query',operation.request.query,[],approval),publicationFence:(fence:()=>boolean)=>{policyAttempt.resultFence=fence;}}:{})});
    };
    const job=policyAttempt?Promise.resolve().then(execute):execute();
    this.active=job;
    try{
      const result=await job;
      if(policyAttempt&&result.status==='ok'){
        if(!current()||!policyAttempt.resultFence?.())return fail('CANCELLED');
        policyAttempt.result=structuredClone(result);policyAttempt.completed=true;
      }
      return result;
    }finally{
      if(policyAttempt){
        this.policyPort!.credentials.revoke(policyAttempt.owner);
        if(!policyAttempt.completed)this.retireAttempt(policyAttempt);
        this.settleAttempt(policyAttempt,true);
      }
      if(this.active===job)this.active=undefined;if(this.abort===abort)this.abort=undefined;
    }
  }
}
