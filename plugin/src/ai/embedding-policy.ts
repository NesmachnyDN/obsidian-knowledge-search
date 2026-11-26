import { hash,type EvidenceHit } from '../standalone/contracts';
import type { SelectedCorpus } from '../standalone/engine';
import { ProviderFailure } from './contracts';
import { canonical } from '../advanced/protocol';
import type { EmbeddingSpace } from './contracts';
import type { ProcessingPolicyInput } from './generation-policy';
import type { EmbeddingPurpose } from './loopback-embedding';

export const INDEX_PURPOSE_TEXT='selected corpus indexing';
export function embeddingScopeBinding(rootId:string,lexicalGenerationId:string,evidence:readonly EvidenceHit[],
  purpose:EmbeddingPurpose,batch:readonly EvidenceHit[]):string {
  return hash(canonical(['oks-embedding-scope-v1',purpose,rootId,lexicalGenerationId,evidence,batch]));
}
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


/** Trusted dense host resolves this from its pinned corpus and planned batch,
 * never from the policy input, preview, grant or provider response. */
export type EmbeddingPolicyScope=Readonly<{
  purpose:EmbeddingPurpose;scopeId:string;scopeBinding:string;
  scopeSources:EmbeddingPolicyInput['scopeSources'];sources:EmbeddingPolicyInput['sources'];
  current():boolean;
}>;
export function resolveEmbeddingPolicyScope(lease:SelectedCorpus,purpose:EmbeddingPurpose,
  batch:readonly EvidenceHit[]):EmbeddingPolicyScope {
  if(!lease.current()||!lease.evidence.length||!['query','document'].includes(purpose)
    ||(purpose==='query'?batch.length!==0:batch.length===0))throw new ProviderFailure('DISCLOSURE_DENIED');
  const originals=new Map<string,string>(),available=new Set<string>();
  for(const hit of lease.evidence){
    if(hit.indexGenerationId!==lease.lexicalGenerationId||
      originals.has(hit.sourceId)&&originals.get(hit.sourceId)!==hit.sourceSha256)
      throw new ProviderFailure('DISCLOSURE_DENIED');
    originals.set(hit.sourceId,hit.sourceSha256);
    const key=canonical(hit);
    if(available.has(key))throw new ProviderFailure('DISCLOSURE_DENIED');
    available.add(key);
  }
  for(const hit of batch)if(!available.delete(canonical(hit)))throw new ProviderFailure('DISCLOSURE_DENIED');
  const scopeSources=Object.freeze([...originals].map(([sourceId,sourceSha256])=>Object.freeze({sourceId,sourceSha256})));
  const sources=Object.freeze(batch.map(hit=>Object.freeze({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,
    excerptDigest:hash(hit.originalExcerpt)})));
  const scopeBinding=embeddingScopeBinding(lease.rootId,lease.lexicalGenerationId,lease.evidence,purpose,batch);
  if(!lease.current())throw new ProviderFailure('CANCELLED');
  return Object.freeze({purpose,scopeId:lease.rootId,scopeBinding,scopeSources,sources,current:()=>lease.current()});
}
export function matchesEmbeddingPolicyScope(input:ProcessingPolicyInput<'embedding'>,scope:EmbeddingPolicyScope|null):boolean {
  return !!scope&&scope.current()&&input.role==='embedding'&&input.embedding?.purpose===scope.purpose
    &&input.scopeId===scope.scopeId&&input.scopeBinding===scope.scopeBinding
    &&canonical(input.scopeSources)===canonical(scope.scopeSources)&&canonical(input.sources)===canonical(scope.sources)
    &&scope.current();
}
