import { hash } from '../standalone/contracts';
import type { EmbeddingSpace } from './contracts';
import type { ProcessingPolicyInput } from './generation-policy';
import type { EmbeddingPurpose } from './loopback-embedding';

export type EmbeddingPolicyDetails=Readonly<{purpose:EmbeddingPurpose;space:EmbeddingSpace;spaceId:string;
  query:string;queryClassification:'synthetic'|'public'}>;
export type EmbeddingPolicyInput=ProcessingPolicyInput<'embedding'>&Readonly<{embedding:EmbeddingPolicyDetails}>;
export type EmbeddingPolicyBindingDetails=Readonly<{purpose:EmbeddingPurpose;spaceId:string;scopeId:string;
  queryClassification:'synthetic'|'public'}>;
export function embeddingPolicyPayload(purpose:EmbeddingPurpose,spaceId:string,query:string,classification:'synthetic'|'public',
  sources:readonly {sourceId:string;sourceSha256:string;excerptDigest:string}[]):string {
  return hash(JSON.stringify(['oks-embedding-policy-v1',purpose,spaceId,query,classification,
    sources.map(x=>[x.sourceId,x.sourceSha256,x.excerptDigest])]));
}
