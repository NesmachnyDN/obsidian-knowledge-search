import { hash } from '../standalone/contracts';
import type { PolicyMetadataProof } from '../standalone/shared';
import type { StandaloneEngine } from '../standalone/engine';
import { ProviderFailure, type CallContext, type ProviderConfig } from './contracts';
import { configDigest } from './disclosure';
import { policyOriginals, type ProcessingPolicyInput, type ProcessingPolicyPort, type GenerationPolicyInput, type GenerationPolicyPort, type RerankPolicyInput, type RerankPolicyPort, type GenerationPolicyBinding } from './generation-policy';
import type { AiRole } from './contracts';
import { POLICY_VERSION, type PolicySnapshot, type TrustedProfile, type Restriction, type PolicyEnvelope } from './processing-policy';
import { decideNewMaterialMarking, validNewMaterialRuleConfig, type MaterialLifecycle, type TrustedImportProvenance,
  type NewMaterialRuleConfig } from './new-material-policy';

export type PolicyMaterial=Readonly<{lifecycle:MaterialLifecycle;provenance:TrustedImportProvenance|null}>;
export type GenerationPolicyHostState=Readonly<{
  config:ProviderConfig;profile:TrustedProfile|null;adapter:string;policyRevision:string;configRevision:string;
  restrictions:readonly Restriction[];rules?:NewMaterialRuleConfig;materials:readonly PolicyMaterial[];complete:boolean;
}>;
/** Trusted native adapter. No credential, network, grant or second parser.
 * A profile must come from independently admitted host authority, never a note,
 * endpoint convention, UI label, or this module. */
export class ProcessingPolicyHost<R extends AiRole> implements ProcessingPolicyPort<R>{
  constructor(readonly selected:()=>boolean,
    private readonly engine:()=>Pick<StandaloneEngine,'evaluateProcessingPolicy'>|undefined,
    private readonly state:(input:ProcessingPolicyInput<R>)=>GenerationPolicyHostState|null,
    private readonly role:R){}
  private readState(input:ProcessingPolicyInput<R>):GenerationPolicyHostState|null{
    if(input.role!==this.role)return null;
    const originals=policyOriginals(input),value=this.state(input);
    if(!value||!value.complete||configDigest(this.role,value.config)!==configDigest(this.role,input.config)
      ||!Array.isArray(value.materials)||value.materials.length>originals.length
      ||value.rules!==undefined&&!validNewMaterialRuleConfig(value.rules))return null;
    if(value.rules!==undefined&&(value.materials.length!==originals.length||originals.some((x,i)=>{
      const m=value.materials[i]?.lifecycle;
      return !m||m.sourceId!==x.sourceId||m.sha256!==x.sourceSha256||m.rootId!==input.scopeId;
    })))return null;
    return structuredClone(value);
  }
  private snapshot(input:ProcessingPolicyInput<R>,value:GenerationPolicyHostState):PolicySnapshot{
    return {subjects:policyOriginals(input).map(x=>({sourceId:x.sourceId,expectedSha256:x.sourceSha256,kind:'original',ownerIds:[x.sourceId]})),
      profile:value.profile,role:this.role,config:input.config,adapter:value.adapter,ownerId:input.ownerId,hostId:input.hostId,
      scopeId:input.scopeId,policyRevision:hash(JSON.stringify([value.policyRevision,input.scopeBinding,value.rules??null,value.materials])),
      configRevision:value.configRevision,credentialEpoch:input.credentialEpoch,deadlineUnixMs:input.deadlineUnixMs,
      payloadDigest:input.payloadDigest,restrictions:value.restrictions,evaluationComplete:true};
  }
  current(input:ProcessingPolicyInput<R>,binding:GenerationPolicyBinding):boolean{
    try{
      const engine=this.engine();if(!engine||!this.selected())return false;
      const value=this.readState(input);
      return !!value&&this.engine()===engine&&this.selected()
        &&hash(JSON.stringify([POLICY_VERSION,input.scopeId,this.snapshot(input,value)]))===binding.bindingDigest;
    }catch{return false;}
  }
  async evaluate(input:ProcessingPolicyInput<R>,context:CallContext,current:()=>boolean):Promise<PolicyEnvelope>{
    const engine=this.engine();
    if(!engine||!this.selected()||!current())throw new ProviderFailure('NOT_READY');
    const live=()=>current()&&this.selected()&&this.engine()===engine&&current();
    const state=():GenerationPolicyHostState|null=>live()?this.readState(input):null;
    const snapshot=():PolicySnapshot|null=>{
      const value=state();return value&&live()?this.snapshot(input,value):null;
    };
    const marking=(proof:PolicyMetadataProof):boolean=>{
      const value=state();if(!value)return false;
      if(value.rules===undefined)return true;
      const material=value.materials.find(x=>x.lifecycle.sourceId===proof.sourceId);
      if(!material)return false;
      const result=decideNewMaterialMarking(value.rules,{sourceId:proof.sourceId,sha256:proof.sha256,rootId:proof.scopeId,
        proof,lifecycle:material.lifecycle,provenance:material.provenance});
      return result.complete&&!result.externalBlocked;
    };
    const envelope=await engine.evaluateProcessingPolicy({snapshot,current:live,marking},context);
    if(envelope.allowed){
      const value=snapshot();
      if(!value||!live()||hash(JSON.stringify([POLICY_VERSION,input.scopeId,value]))!==envelope.bindingDigest)
        throw new ProviderFailure('CANCELLED');
    }
    return envelope;
  }
}
export class GenerationPolicyHost extends ProcessingPolicyHost<'generation'> implements GenerationPolicyPort {
  constructor(selected:()=>boolean,engine:()=>Pick<StandaloneEngine,'evaluateProcessingPolicy'>|undefined,
    state:(input:GenerationPolicyInput)=>GenerationPolicyHostState|null){super(selected,engine,state,'generation');}
}
export class RerankPolicyHost extends ProcessingPolicyHost<'reranking'> implements RerankPolicyPort {
  constructor(selected:()=>boolean,engine:()=>Pick<StandaloneEngine,'evaluateProcessingPolicy'>|undefined,
    state:(input:RerankPolicyInput)=>GenerationPolicyHostState|null){super(selected,engine,state,'reranking');}
}
