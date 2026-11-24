import type { EvidenceHit } from '../standalone/contracts';
import { ProviderFailure,type CallContext,type EmbeddingSpace } from './contracts';
import { type DisclosureGrant } from './disclosure';
import { VerifiedEvidenceOperation,type EvidenceApproval } from './verified-evidence';
import { embeddingSpaceId,validateEmbeddingSpace } from './embedding-space';
import { LoopbackEmbeddingTransport,type EmbeddingPurpose,type EmbeddingBatch,MAX_EMBEDDING_BATCH } from './loopback-embedding';
export type EmbeddingApproval=Omit<EvidenceApproval,'grant'>&{
  space:EmbeddingSpace;purpose:EmbeddingPurpose;
  grant:DisclosureGrant&{role:'embedding';spaceId:string;purpose:EmbeddingPurpose};
};
/** Trusted host-issued exact purpose/space grant. This adapter is not wired
 * into production UI or persisted indexing until the subsequent migration. */
export class EvidenceEmbedder {
  private readonly operation=new VerifiedEvidenceOperation();
  private readonly transport=new LoopbackEmbeddingTransport();
  async run(value:EmbeddingApproval,token:string,context:CallContext,
    verify:(hit:EvidenceHit)=>Promise<void>,current:()=>boolean):Promise<{batch:EmbeddingBatch;evidence:readonly EvidenceHit[]}> {
    const snapshot=structuredClone(value);
    const space=validateEmbeddingSpace(snapshot.config,snapshot.space);
    const id=embeddingSpaceId(snapshot.config,space);
    if(!snapshot.grant||snapshot.grant.role!=='embedding'||snapshot.grant.spaceId!==id
      ||snapshot.grant.purpose!==snapshot.purpose||!['query','document'].includes(snapshot.purpose))
      throw new ProviderFailure('DISCLOSURE_DENIED');
    if(snapshot.purpose==='document'&&snapshot.candidates.length>MAX_EMBEDDING_BATCH)
      throw new ProviderFailure('LIMIT_EXCEEDED');
    const {result,evidence}=await this.operation.run('embedding',snapshot,context,verify,current,
      (config,input,call)=>this.transport.embed(config,space,snapshot.purpose,input,token,call),
      snapshot.purpose==='query');
    return {batch:result,evidence};
  }
}
