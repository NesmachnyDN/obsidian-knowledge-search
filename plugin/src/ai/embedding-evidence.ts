import type { EvidenceHit } from '../standalone/contracts';
import { ProviderFailure,type CallContext,type EmbeddingSpace } from './contracts';
import { type DisclosureGrant } from './disclosure';
import { VerifiedEvidenceOperation,type EvidenceApproval } from './verified-evidence';
import { embeddingSpaceId,validateEmbeddingSpace } from './embedding-space';
import type { GenerationPolicyBinding } from './generation-policy';
import { LoopbackEmbeddingTransport,type EmbeddingPurpose,type EmbeddingBatch,MAX_EMBEDDING_BATCH } from './loopback-embedding';
export type EmbeddingApproval=Omit<EvidenceApproval,'grant'>&{
  space:EmbeddingSpace;purpose:EmbeddingPurpose;
  grant:DisclosureGrant&{role:'embedding';spaceId:string;purpose:EmbeddingPurpose};
};
export type VerifiedEmbeddingResult={batch:EmbeddingBatch;evidence:readonly EvidenceHit[]};
/** In-process provenance capability. Neither wire JSON nor caller-assembled
 * evidence/vector pairs may be promoted to a dense document generation. */
const issued=new WeakMap<VerifiedEmbeddingResult,{scopeId:string;value:VerifiedEmbeddingResult}>();
export function readVerifiedDocumentBatch(result:VerifiedEmbeddingResult,scopeId:string):VerifiedEmbeddingResult {
  const binding=issued.get(result);
  if(!binding||binding.scopeId!==scopeId||binding.value.batch.purpose!=='document'
    ||JSON.stringify(result)!==JSON.stringify(binding.value))throw new ProviderFailure('DISCLOSURE_DENIED');
  return structuredClone(binding.value);
}
/** Trusted host-issued exact purpose/space grant. This adapter is not wired
 * into production UI or persisted indexing until the subsequent migration. */
export class EvidenceEmbedder {
  private readonly operation=new VerifiedEvidenceOperation();
  private readonly transport=new LoopbackEmbeddingTransport();
  async run(value:EmbeddingApproval,token:string,context:CallContext,
    verify:(hit:EvidenceHit)=>Promise<void>,current:()=>boolean,policyCheck?:()=>Promise<GenerationPolicyBinding>):Promise<VerifiedEmbeddingResult> {
    const snapshot=structuredClone(value);
    const space=validateEmbeddingSpace(snapshot.config,snapshot.space);
    const id=embeddingSpaceId(snapshot.config,space);
    if(!snapshot.grant||snapshot.grant.role!=='embedding'||snapshot.grant.spaceId!==id
      ||snapshot.grant.purpose!==snapshot.purpose||!['query','document'].includes(snapshot.purpose))
      throw new ProviderFailure('DISCLOSURE_DENIED');
    const policy=snapshot.grant.notePolicyBinding;
    if(!!policy!==!!policyCheck||policy&&(!policy.embedding||policy.embedding.purpose!==snapshot.purpose
      ||policy.embedding.spaceId!==id||policy.embedding.scopeId!==snapshot.scopeId))
      throw new ProviderFailure('DISCLOSURE_DENIED');
    if(snapshot.purpose==='document'&&snapshot.candidates.length>MAX_EMBEDDING_BATCH)
      throw new ProviderFailure('LIMIT_EXCEEDED');
    const {result,evidence}=await this.operation.run('embedding',snapshot,context,verify,current,
      (config,input,call)=>this.transport.embed(config,space,snapshot.purpose,input,token,call),
      snapshot.purpose==='query',policyCheck);
    const verified={batch:result,evidence};
    issued.set(verified,{scopeId:snapshot.scopeId,value:structuredClone(verified)});
    return verified;
  }
}
