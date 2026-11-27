import { BOUNDS, hash, isDigest, validPath } from '../standalone/contracts';
import { remainingOperationMs } from './active-deadline';
import type { PolicyMetadataProof } from '../standalone/shared';
import type { StandaloneEngine } from '../standalone/engine';
import { ProviderFailure, type CallContext, type ProviderConfig } from './contracts';
import { configDigest } from './disclosure';
import { policyOriginals, type ProcessingPolicyInput, type ProcessingPolicyPort, type GenerationHistoryScope, type GenerationPolicyPort, type RerankPolicyPort, type GenerationPolicyBinding } from './generation-policy';
import type { AiRole } from './contracts';
import { matchesEmbeddingPolicyScope,type EmbeddingPolicyScope } from './embedding-policy';
import { POLICY_VERSION, type PolicySnapshot, type TrustedProfile, type Restriction, type PolicyEnvelope } from './processing-policy';
import { decideNewMaterialMarking, validNewMaterialRuleConfig, type MaterialLifecycle, type TrustedImportProvenance,
  type NewMaterialRuleConfig } from './new-material-policy';
import { decideEffectivePolicy, validEffectivePolicyConfig, type EffectivePolicyConfig, type VerifiedOrigin } from './effective-policy';
import type { LifecycleObservation } from './new-material-tracker';

type PolicyStateInput<R extends AiRole> = Pick<ProcessingPolicyInput<R>,'role'|'config'|'scopeId'|'scopeBinding'|'scopeSources'|'sources'|'embedding'>;
type PolicyEngine=Pick<StandaloneEngine,'evaluateProcessingPolicy'>&Partial<Pick<StandaloneEngine,'processingPolicyDrain'>>;
export type PolicyMaterial=Readonly<{lifecycle:MaterialLifecycle;provenance:TrustedImportProvenance|null}>;
/** A host-private read of admitted lifecycle evidence. It cannot return a grant. */
export type FreshLifecycleObserver=Readonly<{
  /** Structural identity of the current native owner; not a fresh read. */
  revision(scopeId:string):string|null;
  observe(scopeId:string,revision:string,requests:readonly Readonly<{sourceId:string;expectedSha256:string}>[],
    signal:AbortSignal):Promise<readonly LifecycleObservation[]|null>;
}>;
export type GenerationPolicyHostState=Readonly<{
  config:ProviderConfig;profile:TrustedProfile|null;adapter:string;policyRevision:string;configRevision:string;
  restrictions:readonly Restriction[];rules?:NewMaterialRuleConfig;materials:readonly PolicyMaterial[];complete:boolean;
  /** Omitted is the historical marking authority, retained byte-for-byte. */
  mode?:'effective';
  /** Read-only current-original decisions; intentionally incompatible with marking rules. */
  effective?:Readonly<{config:EffectivePolicyConfig;origins:readonly (VerifiedOrigin|null)[]}>;
}>;
/** Trusted native adapter. No credential, network, grant or second parser.
 * A profile must come from independently admitted host authority, never a note,
 * endpoint convention, UI label, or this module. */
export class ProcessingPolicyHost<R extends AiRole> implements ProcessingPolicyPort<R>{
  constructor(readonly selected:()=>boolean,
    private readonly engine:()=>PolicyEngine|undefined,
    private readonly state:(input:PolicyStateInput<R>)=>GenerationPolicyHostState|null,
    private readonly role:R,
    private readonly resolvedEmbeddingScope?:(input:ProcessingPolicyInput<'embedding'>)=>EmbeddingPolicyScope|null,
    private readonly lifecycleObserver?:FreshLifecycleObserver){}
  private readState(input:ProcessingPolicyInput<R>):GenerationPolicyHostState|null{
    if(input.role!==this.role)return null;
    if(this.role==='embedding'&&!matchesEmbeddingPolicyScope(input as ProcessingPolicyInput<'embedding'>,this.resolvedEmbeddingScope?.(input as ProcessingPolicyInput<'embedding'>)??null))return null;
    const value=this.readPolicyState(input);
    if(this.role==='embedding'&&!matchesEmbeddingPolicyScope(input as ProcessingPolicyInput<'embedding'>,this.resolvedEmbeddingScope?.(input as ProcessingPolicyInput<'embedding'>)??null))return null;
    return value;
  }
  protected readPolicyState(input:PolicyStateInput<R>):GenerationPolicyHostState|null{
    if(input.role!==this.role)return null;
    const originals=policyOriginals(input),value=this.state(input);
    if(!value||!value.complete||configDigest(this.role,value.config)!==configDigest(this.role,input.config)
      ||!Array.isArray(value.materials)||value.materials.length>originals.length
      ||value.rules!==undefined&&!validNewMaterialRuleConfig(value.rules))return null;
    const effective=value.mode==='effective';
    if((value.mode!==undefined&&!effective)||(effective!==(value.effective!==undefined))
      ||(effective&&(value.rules!==undefined||value.materials.length!==0
        ||!value.effective||!validEffectivePolicyConfig(value.effective.config)||!Array.isArray(value.effective.origins)||value.effective.origins.length!==originals.length
        ||value.effective!.origins.some((origin,i)=>origin!==null&&(!origin||origin.sourceId!==originals[i]!.sourceId
          ||origin.sha256!==originals[i]!.sourceSha256||origin.rootId!==input.scopeId)))))return null;
    if(value.rules!==undefined&&(value.materials.length!==originals.length||originals.some((x,i)=>{
      const m=value.materials[i]?.lifecycle;
      return !m||m.sourceId!==x.sourceId||m.sha256!==x.sourceSha256||m.rootId!==input.scopeId;
    })))return null;
    return structuredClone(value);
  }
  private snapshot(input:ProcessingPolicyInput<R>,value:GenerationPolicyHostState,revision?:string):PolicySnapshot{
    return {subjects:policyOriginals(input).map(x=>({sourceId:x.sourceId,expectedSha256:x.sourceSha256,kind:'original',ownerIds:[x.sourceId]})),
      profile:value.profile,role:this.role,config:input.config,adapter:value.adapter,ownerId:input.ownerId,hostId:input.hostId,
      scopeId:input.scopeId,policyRevision:hash(JSON.stringify([value.policyRevision,input.scopeBinding,value.rules??null,value.materials,
        ...(value.mode==='effective'?[value.mode,value.effective]:[]),...(revision===undefined?[]:[revision])])),
      configRevision:value.configRevision,credentialEpoch:input.credentialEpoch,deadlineUnixMs:input.deadlineUnixMs,
      payloadDigest:input.payloadDigest,restrictions:value.restrictions,evaluationComplete:true};
  }
  /** Only external admitted profiles with marking rules need fresh lifecycle evidence. */
  protected observationRevision(scopeId:string,value:GenerationPolicyHostState):string|null|undefined{
    if(value.mode==='effective')return undefined;
    if(!this.lifecycleObserver||value.rules===undefined||value.profile?.classification!=='external')return undefined;
    const revision=this.lifecycleObserver.revision(scopeId);
    return isDigest(revision)?revision:null;
  }
  private structuralDigest(input:ProcessingPolicyInput<R>,value:GenerationPolicyHostState,revision?:string):string{
    return hash(JSON.stringify([POLICY_VERSION,input.scopeId,this.snapshot(input,value,revision)]));
  }
  private boundDigest(structural:string,lifecycle?:string):string{
    return lifecycle===undefined?structural:hash(JSON.stringify(['oks-policy-2e3e3c-binding-v1',structural,lifecycle]));
  }
  private async freshEvidence(input:ProcessingPolicyInput<R>,revision:string,context:CallContext,live:()=>boolean):
    Promise<{materials:ReadonlyMap<string,PolicyMaterial>;digest:string}|null>{
    const originals=policyOriginals(input);
    if(!originals.length||originals.length>BOUNDS.sources||originals.some(x=>!validPath(x.sourceId)||!isDigest(x.sourceSha256)))return null;
    // The durable tracker uses exact JS string ordering, not locale collation.
    const requests=Object.freeze([...originals].sort((a,b)=>a.sourceId<b.sourceId?-1:a.sourceId>b.sourceId?1:0)
      .map(x=>Object.freeze({sourceId:x.sourceId,expectedSha256:x.sourceSha256})));
    try{
      if(!live())return null;
      const observations=await this.lifecycleObserver!.observe(input.scopeId,revision,requests,context.signal);
      if(!live()||!Array.isArray(observations)||observations.length!==requests.length)return null;
      const materials=new Map<string,PolicyMaterial>(),proofs:string[][]=[];
      for(let i=0;i<requests.length;i++){
        const x=observations[i],r=requests[i]!,v=x?.proof?.version;
        if(!x||!v||x.sourceId!==r.sourceId||x.sha256!==r.expectedSha256
          ||!((x.state==='existing'&&x.origin==='baseline')||(x.state==='verified-new'&&x.origin==='native-create'))
          ||v.rootId!==input.scopeId||v.sourceId!==x.sourceId||v.sha256!==x.sha256
          ||!isDigest(v.versionId)||!isDigest(x.proof.stableIdentity)||!isDigest(x.originVersionId))return null;
        materials.set(x.sourceId,{lifecycle:{state:x.state,sourceId:x.sourceId,sha256:x.sha256,rootId:input.scopeId},provenance:null});
        proofs.push([x.sourceId,x.sha256,x.state,x.origin,x.originVersionId,v.versionId,x.proof.stableIdentity]);
      }
      if(!live())return null;
      return {materials,digest:hash(JSON.stringify(['oks-policy-2e3e3c-lifecycle-v1',input.scopeId,revision,proofs]))};
    }catch{return null;}
  }
  current(input:ProcessingPolicyInput<R>,binding:GenerationPolicyBinding):boolean{
    try{
      const engine=this.engine();if(!engine||!this.selected())return false;
      const value=this.readState(input);if(!value)return false;
      const revision=this.observationRevision(input.scopeId,value);
      if(revision===null||(revision===undefined?binding.lifecycleDigest!==undefined:!isDigest(binding.lifecycleDigest)))return false;
      // Structural validity only; renewal performs the fresh physical read.
      return this.engine()===engine&&this.selected()
        &&this.boundDigest(this.structuralDigest(input,value,revision),binding.lifecycleDigest)===binding.bindingDigest;
    }catch{return false;}
  }
  async evaluate(input:ProcessingPolicyInput<R>,context:CallContext,current:()=>boolean):Promise<PolicyEnvelope>{
    const engine=this.engine();
    if(!engine||!this.selected()||!current())throw new ProviderFailure('NOT_READY');
    const active=()=>{try{return remainingOperationMs(context)>0&&current()&&this.selected()
      &&this.engine()===engine&&current()&&remainingOperationMs(context)>0;}catch{return false;}};
    if(!active())throw new ProviderFailure('CANCELLED');
    const initial=this.readState(input);
    if(!initial)throw new ProviderFailure('DISCLOSURE_DENIED');
    const revision=this.observationRevision(input.scopeId,initial);
    if(revision===null)throw new ProviderFailure('DISCLOSURE_DENIED');
    const structural=this.structuralDigest(input,initial,revision);
    const state=():GenerationPolicyHostState|null=>{
      if(!active())return null;
      const value=this.readState(input);
      if(!value||this.observationRevision(input.scopeId,value)!==revision
        ||this.structuralDigest(input,value,revision)!==structural||!active())return null;
      return value;
    };
    const live=()=>!!state();
    const first=revision===undefined?undefined:await this.freshEvidence(input,revision,context,live);
    if(first===null||!live())throw new ProviderFailure('CANCELLED');
    const snapshot=():PolicySnapshot|null=>{
      const value=state();return value?this.snapshot(input,value,revision):null;
    };
    const marking=(proof:PolicyMetadataProof):boolean=>{
      const value=state();if(!value)return false;
      if(value.rules===undefined)return true;
      // Installed fresh observer must never fall back to legacy material evidence.
      const material=first===undefined?value.materials.find(x=>x.lifecycle.sourceId===proof.sourceId):first.materials.get(proof.sourceId);
      if(!material)return false;
      const result=decideNewMaterialMarking(value.rules,{sourceId:proof.sourceId,sha256:proof.sha256,rootId:proof.scopeId,
        proof,lifecycle:material.lifecycle,provenance:material.provenance});
      return result.complete&&!result.externalBlocked;
    };
    const effective=(proof:PolicyMetadataProof):boolean=>{
      const value=state();if(!value||value.mode!=='effective'||!value.effective)return false;
      const source=policyOriginals(input).findIndex(x=>x.sourceId===proof.sourceId&&x.sourceSha256===proof.sha256);
      if(source<0)return false;
      const decision=decideEffectivePolicy(value.effective.config,{sourceId:proof.sourceId,sha256:proof.sha256,
        rootId:input.scopeId,proof,origin:value.effective.origins[source]??null});
      return decision.complete&&decision.decision==='eligible';
    };
    const evaluation=engine.evaluateProcessingPolicy({snapshot,current:live,
      marking:initial.mode==='effective'?effective:marking},context);
    const physical=engine.processingPolicyDrain?.();
    let envelope:PolicyEnvelope;
    try{envelope=await evaluation;}finally{await physical;}
    if(!envelope.allowed)return envelope;
    if(!live()||envelope.bindingDigest!==structural)throw new ProviderFailure('CANCELLED');
    if(revision===undefined)return envelope;
    const renewed=await this.freshEvidence(input,revision,context,live);
    if(!renewed||renewed.digest!==first?.digest||!live())throw new ProviderFailure('CANCELLED');
    return Object.freeze({...envelope,bindingDigest:this.boundDigest(structural,renewed.digest),lifecycleDigest:renewed.digest});
  }
}
export class GenerationPolicyHost extends ProcessingPolicyHost<'generation'> implements GenerationPolicyPort {
  constructor(selected:()=>boolean,engine:()=>PolicyEngine|undefined,
    state:(input:GenerationHistoryScope)=>GenerationPolicyHostState|null,lifecycleObserver?:FreshLifecycleObserver){
    // State is resolved from the complete verified scope, not the current
    // candidate subset or an operation's credential/consent envelope.
    super(selected,engine,input=>state({...input,sources:[]}), 'generation',undefined,lifecycleObserver);
  }
  historyRevision(scope:GenerationHistoryScope):string|null{
    try{
      if(!this.selected())return null;
      const value=this.readPolicyState(scope);
      if(!value||!this.selected())return null;
      const revision=this.observationRevision(scope.scopeId,value);
      return revision===null?null:hash(JSON.stringify([POLICY_VERSION,scope.scopeId,scope.scopeBinding,
        policyOriginals(scope),value,...(revision===undefined?[]:[revision])]));
    }catch{return null;}
  }
}
export class RerankPolicyHost extends ProcessingPolicyHost<'reranking'> implements RerankPolicyPort {
  constructor(selected:()=>boolean,engine:()=>PolicyEngine|undefined,
    state:(input:PolicyStateInput<'reranking'>)=>GenerationPolicyHostState|null,lifecycleObserver?:FreshLifecycleObserver){super(selected,engine,state,'reranking',undefined,lifecycleObserver);}
}
