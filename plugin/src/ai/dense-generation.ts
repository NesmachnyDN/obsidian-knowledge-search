/** API dense manifest for the existing single CURRENT store. Derived data only. */
import { canonical, sha } from '../advanced/protocol';
import { hash, isDigest, isRecord, validPath, BOUNDS, type EvidenceHit, type SourceLocator } from '../standalone/contracts';
import { ProviderFailure, type ProviderConfig, type EmbeddingSpace } from './contracts';
import { checkedVector, embeddingSpaceId, validateEmbeddingSpace } from './embedding-space';
import { readVerifiedDocumentBatch,type VerifiedEmbeddingResult } from './embedding-evidence';

export const MAX_API_VECTORS = 256;
export type ApiDenseEntry = {
  sourcePath: string; sourceSha256: string; excerptSha256: string;
  locator: SourceLocator; vector: number[];
};
export type ApiDenseGeneration = {
  schemaVersion: 2; rootId: string; lexicalGenerationId: string;
  origin: string; space: EmbeddingSpace; spaceId: string;
  generationId: string; entries: ApiDenseEntry[];
};
const built=new WeakMap<ApiDenseGeneration,ApiDenseGeneration>();
export function readBuiltApiDenseGeneration(value:ApiDenseGeneration):ApiDenseGeneration {
  const original=built.get(value);
  if(!original||canonical(value)!==canonical(original))throw new ProviderFailure('DISCLOSURE_DENIED');
  return structuredClone(original);
}
const fail = (): never => { throw new ProviderFailure('INVALID_RESPONSE'); };
const exact = (v: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const ordinal = (n: unknown, max: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;
function validLocator(v: unknown, version: string): v is SourceLocator {
  if(!isRecord(v)||!exact(v,['locatorKind','sourceVersion','blockOrder','byteStart','byteEnd','charStart','charEnd','lineStart','lineEnd'])
    ||v.locatorKind!=='markdown'||v.sourceVersion!==version
    ||!ordinal(v.blockOrder,BOUNDS.blocksPerSource)
    ||!ordinal(v.byteStart,BOUNDS.fileBytes)||!ordinal(v.byteEnd,BOUNDS.fileBytes)||v.byteEnd<=v.byteStart
    ||!ordinal(v.charStart,BOUNDS.fileBytes)||!ordinal(v.charEnd,BOUNDS.fileBytes)||v.charEnd<=v.charStart
    ||!ordinal(v.lineStart,BOUNDS.fileBytes)||!ordinal(v.lineEnd,BOUNDS.fileBytes)||v.lineEnd<v.lineStart)return false;
  return true;
}
export const apiDenseEntryKey = (e: Omit<ApiDenseEntry,'vector'>): string =>
  canonical([e.sourcePath,e.sourceSha256,e.locator,e.excerptSha256]);
function identity(hit:EvidenceHit,lexicalGenerationId:string):Omit<ApiDenseEntry,'vector'> {
  if(hit.indexGenerationId!==lexicalGenerationId||hit.retrievalMode!=='lexical'
    ||!validPath(hit.sourceId)||!isDigest(hit.sourceSha256)||typeof hit.originalExcerpt!=='string'
    ||!hit.originalExcerpt.length||!Array.isArray(hit.sourceLocators)||hit.sourceLocators.length!==1
    ||!validLocator(hit.sourceLocators[0],hit.sourceSha256))return fail();
  return {sourcePath:hit.sourceId,sourceSha256:hit.sourceSha256,excerptSha256:hash(hit.originalExcerpt),
    locator:structuredClone(hit.sourceLocators[0])};
}
export const apiDenseEvidenceKey = (hit:EvidenceHit,lexicalGenerationId:string):string =>
  apiDenseEntryKey(identity(hit,lexicalGenerationId));
const digest = (v:Omit<ApiDenseGeneration,'generationId'>):string=>sha(canonical(v));
/** Revalidate the nonsecret persisted space without persisting operational limits. */
function configFor(origin:string,space:EmbeddingSpace):ProviderConfig {
  return {state:'configured',transport:'local',origin,identity:{model:space.model,revision:space.revision},
    limits:{timeoutMs:100,maxInputBytes:1,maxCandidates:1,maxOutputTokens:1,maxConcurrent:1}};
}
export function validateApiDenseGeneration(value:unknown,rootId:string):asserts value is ApiDenseGeneration {
  if(!isRecord(value)||!exact(value,['schemaVersion','rootId','lexicalGenerationId','origin','space','spaceId','generationId','entries'])
    ||value.schemaVersion!==2||value.rootId!==rootId||!isDigest(rootId)||!isDigest(value.lexicalGenerationId)
    ||typeof value.origin!=='string'||!isRecord(value.space)||!isDigest(value.spaceId)||!isDigest(value.generationId)
    ||!Array.isArray(value.entries)||!value.entries.length||value.entries.length>MAX_API_VECTORS)fail();
  const g=value as ApiDenseGeneration;
  const cfg=configFor(g.origin,g.space);
  const space=validateEmbeddingSpace(cfg,g.space);
  if(embeddingSpaceId(cfg,space)!==g.spaceId)fail();
  let prior='';const versions=new Map<string,string>();
  for(const e of g.entries){
    if(!isRecord(e)||!exact(e,['sourcePath','sourceSha256','excerptSha256','locator','vector'])
      ||!validPath(e.sourcePath)||!isDigest(e.sourceSha256)||!isDigest(e.excerptSha256)
      ||!validLocator(e.locator,e.sourceSha256))fail();
    const k=apiDenseEntryKey(e);
    if(k<=prior||versions.has(e.sourcePath)&&versions.get(e.sourcePath)!==e.sourceSha256)fail();
    prior=k;versions.set(e.sourcePath,e.sourceSha256);checkedVector(e.vector,space);
  }
  const {generationId,...base}=g;
  if(digest(base)!==generationId)fail();
}
/** Complete replacement of the explicitly selected evidence set, not whole-Vault coverage. */
export function buildApiDenseGeneration(rootId:string,config:ProviderConfig,declared:EmbeddingSpace,
  lexicalGenerationId:string,expected:readonly EvidenceHit[],batches:readonly VerifiedEmbeddingResult[]):ApiDenseGeneration {
  const space=validateEmbeddingSpace(config,declared),spaceId=embeddingSpaceId(config,space);
  if(!isDigest(rootId)||!isDigest(lexicalGenerationId)||!expected.length||expected.length>MAX_API_VECTORS
    ||!batches.length||batches.length>MAX_API_VECTORS)fail();
  const wanted=new Map(expected.map(h=>{const e=identity(h,lexicalGenerationId);return [apiDenseEntryKey(e),e]}));
  if(wanted.size!==expected.length)fail();
  const entries:ApiDenseEntry[]=[];
  for(const result of batches){
    const {batch,evidence}=readVerifiedDocumentBatch(result,rootId);
    if(batch.purpose!=='document'||batch.spaceId!==spaceId||!evidence.length||evidence.length>8
      ||batch.vectors.length!==evidence.length)fail();
    for(let i=0;i<evidence.length;i++){
      const e=identity(evidence[i]!,lexicalGenerationId),k=apiDenseEntryKey(e);
      if(!wanted.delete(k))fail();
      entries.push({...e,vector:checkedVector(batch.vectors[i],space)});
    }
  }
  if(wanted.size)fail();
  entries.sort((a,b)=>apiDenseEntryKey(a)<apiDenseEntryKey(b)?-1:apiDenseEntryKey(a)>apiDenseEntryKey(b)?1:0);
  const base={schemaVersion:2 as const,rootId,lexicalGenerationId,origin:config.origin,space,spaceId,entries};
  const generation={...base,generationId:digest(base)};
  validateApiDenseGeneration(generation,rootId);
  built.set(generation,structuredClone(generation));
  return generation;
}
