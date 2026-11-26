/** API dense manifest for the existing single CURRENT store. Derived data only. */
import { canonical, sha } from '../advanced/protocol';
import { hash, isDigest, isRecord, validPath, BOUNDS, type EvidenceHit, type SourceLocator } from '../standalone/contracts';
import { ProviderFailure, type ProviderConfig, type EmbeddingSpace } from './contracts';
import { checkedVector, embeddingSpaceId, validateEmbeddingSpace } from './embedding-space';
import { readVerifiedDocumentBatch,type VerifiedEmbeddingResult,type DocumentPolicyProvenance } from './embedding-evidence';
import {configDigest} from './disclosure';
import {embeddingPolicyPayload,embeddingScopeBinding,INDEX_PURPOSE_TEXT} from './embedding-policy';
import {generationPolicySourceDigest,type GenerationPolicyBinding} from './generation-policy';

export const MAX_API_VECTORS = 256;
export type ApiDenseEntry = {
  sourcePath: string; sourceSha256: string; excerptSha256: string;
  locator: SourceLocator; vector: number[];
};
type DenseGenerationBase = {
  rootId:string;lexicalGenerationId:string;origin:string;space:EmbeddingSpace;spaceId:string;
  generationId:string;entries:ApiDenseEntry[];
};
export type DensePolicyBatch=DocumentPolicyProvenance&{entryIds:readonly string[]};
export type DensePolicyLineage=Readonly<{
  kind:'verified-originals-v1';reuse:'local-retrieval-only';batches:readonly DensePolicyBatch[];
}>;
export type ApiDenseGeneration=DenseGenerationBase&(
  {schemaVersion:2}|{schemaVersion:3;lineage:DensePolicyLineage});
export function isApiDenseGeneration(value:{schemaVersion:unknown}|null|undefined):value is ApiDenseGeneration {
  return value?.schemaVersion===2||value?.schemaVersion===3;
}
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
const digest = (v:object):string=>sha(canonical(v));
/** Revalidate the nonsecret persisted space without persisting operational limits. */
function configFor(origin:string,space:EmbeddingSpace):ProviderConfig {
  return {state:'configured',transport:'local',origin,identity:{model:space.model,revision:space.revision},
    limits:{timeoutMs:100,maxInputBytes:1,maxCandidates:1,maxOutputTokens:1,maxConcurrent:1}};
}
export function validateApiDenseGeneration(value:unknown,rootId:string):asserts value is ApiDenseGeneration {
  if(!isRecord(value)||!exact(value,['schemaVersion','rootId','lexicalGenerationId','origin','space','spaceId','generationId','entries',
      ...(value.schemaVersion===3?['lineage']:[])])
    ||![2,3].includes(value.schemaVersion as number)||value.rootId!==rootId||!isDigest(rootId)||!isDigest(value.lexicalGenerationId)
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
  if(g.schemaVersion===3)validateLineage(g);
  const {generationId,...base}=g;
  if(digest(base)!==generationId)fail();
}
const entryId=(entry:Omit<ApiDenseEntry,'vector'>):string=>hash(apiDenseEntryKey(entry));
const sourcesOf=(entries:readonly Pick<ApiDenseEntry,'sourcePath'|'sourceSha256'|'excerptSha256'>[])=>entries.map(e=>({
  sourceId:e.sourcePath,sourceSha256:e.sourceSha256,excerptDigest:e.excerptSha256}));
function validProof(proof:unknown):proof is DensePolicyBatch {
  return isRecord(proof)&&exact(proof,['configDigest','bindingDigest','scopeBinding','payloadDigest','sourceDigest','queryClassification','entryIds'])
    &&[proof.configDigest,proof.bindingDigest,proof.scopeBinding,proof.payloadDigest,proof.sourceDigest].every(isDigest)
    &&(proof.queryClassification==='synthetic'||proof.queryClassification==='public')
    &&Array.isArray(proof.entryIds)&&proof.entryIds.length>0&&proof.entryIds.length<=8
    &&proof.entryIds.every(isDigest)&&new Set(proof.entryIds).size===proof.entryIds.length;
}
function validateLineage(g:Extract<ApiDenseGeneration,{schemaVersion:3}>):void {
  const lineage=g.lineage;
  if(!isRecord(lineage)||!exact(lineage,['kind','reuse','batches'])||lineage.kind!=='verified-originals-v1'
    ||lineage.reuse!=='local-retrieval-only'||!Array.isArray(lineage.batches)
    ||!lineage.batches.length||lineage.batches.length>g.entries.length)return fail();
  const remaining=new Map(g.entries.map(e=>[entryId(e),e]));
  let configuration:string|undefined,classification:DocumentPolicyProvenance['queryClassification']|undefined;
  for(const proof of lineage.batches){
    if(!validProof(proof)||configuration&&configuration!==proof.configDigest
      ||classification&&classification!==proof.queryClassification)return fail();
    configuration=proof.configDigest;classification=proof.queryClassification;
    const entries:ApiDenseEntry[]=[];
    for(const id of proof.entryIds){
      const entry=remaining.get(id);if(!entry)return fail();
      remaining.delete(id);entries.push(entry);
    }
    const sources=sourcesOf(entries);
    if(proof.sourceDigest!==generationPolicySourceDigest({role:'embedding',sources})
      ||proof.payloadDigest!==embeddingPolicyPayload('document',g.spaceId,INDEX_PURPOSE_TEXT,proof.queryClassification,sources))return fail();
  }
  if(remaining.size)return fail();
}
/** Historical proof is never an authorization. Exact originals are supplied by
 * the current corpus and separately evaluated by the live query policy. */
export function assertDensePolicyReuse(g:ApiDenseGeneration,config:ProviderConfig,
  evidence:readonly EvidenceHit[],policySelected:boolean):void {
  if(!policySelected){if(g.schemaVersion!==2)throw new ProviderFailure('DISCLOSURE_DENIED');return;}
  if(g.schemaVersion!==3)throw new ProviderFailure('DISCLOSURE_DENIED');
  validateLineage(g);
  const expected=new Map(evidence.map(hit=>[entryId(identity(hit,g.lexicalGenerationId)),hit]));
  if(expected.size!==g.entries.length||expected.size!==evidence.length) return fail();
  const ordered:string[]=[];
  for(const proof of g.lineage.batches){
    if(proof.configDigest!==configDigest('embedding',config))throw new ProviderFailure('DISCLOSURE_DENIED');
    const batch=proof.entryIds.map(id=>{const hit=expected.get(id);if(!hit)return fail();ordered.push(id);return hit;});
    if(proof.scopeBinding!==embeddingScopeBinding(g.rootId,g.lexicalGenerationId,evidence,'document',batch))
      throw new ProviderFailure('DISCLOSURE_DENIED');
  }
  // A complete and ordered plan, not an unordered bag of valid vectors.
  if(canonical(ordered)!==canonical([...expected.keys()]))throw new ProviderFailure('DISCLOSURE_DENIED');
}
/** Complete replacement of the explicitly selected evidence set, not whole-Vault coverage. */
export function buildApiDenseGeneration(rootId:string,config:ProviderConfig,declared:EmbeddingSpace,
  lexicalGenerationId:string,expected:readonly EvidenceHit[],batches:readonly VerifiedEmbeddingResult[],
  expectedPolicy?:readonly GenerationPolicyBinding[]):ApiDenseGeneration {
  const space=validateEmbeddingSpace(config,declared),spaceId=embeddingSpaceId(config,space);
  if(!isDigest(rootId)||!isDigest(lexicalGenerationId)||!expected.length||expected.length>MAX_API_VECTORS
    ||!batches.length||batches.length>MAX_API_VECTORS
    ||expectedPolicy&&expectedPolicy.length!==batches.length)fail();
  const wanted=new Map(expected.map(h=>{const e=identity(h,lexicalGenerationId);return [apiDenseEntryKey(e),e]}));
  if(wanted.size!==expected.length)fail();
  const entries:ApiDenseEntry[]=[],proofs:DensePolicyBatch[]=[];
  let policyMode:boolean|undefined;
  for(const [batchId,result] of batches.entries()){
    const {batch,evidence,policyProvenance}=readVerifiedDocumentBatch(result,rootId);
    const policy=!!policyProvenance;
    if(policy!==!!expectedPolicy||policyMode!==undefined&&policyMode!==policy)return fail();
    policyMode=policy;
    if(batch.purpose!=='document'||batch.spaceId!==spaceId||!evidence.length||evidence.length>8
      ||batch.vectors.length!==evidence.length)fail();
    if(policyProvenance){
      const ids=evidence.map(hit=>entryId(identity(hit,lexicalGenerationId)));
      const approved=expectedPolicy?.[batchId];
      if(!approved?.embedding||approved.embedding.purpose!=='document'||approved.embedding.scopeId!==rootId
        ||approved.embedding.spaceId!==spaceId||approved.embedding.queryClassification!==policyProvenance.queryClassification
        ||approved.bindingDigest!==policyProvenance.bindingDigest||approved.payloadDigest!==policyProvenance.payloadDigest
        ||approved.sourceDigest!==policyProvenance.sourceDigest||approved.scopeBinding!==policyProvenance.scopeBinding
        ||policyProvenance.configDigest!==configDigest('embedding',config)
        ||policyProvenance.scopeBinding!==embeddingScopeBinding(rootId,lexicalGenerationId,expected,'document',evidence))return fail();
      proofs.push({...policyProvenance,entryIds:ids});
    }
    for(let i=0;i<evidence.length;i++){
      const e=identity(evidence[i]!,lexicalGenerationId),k=apiDenseEntryKey(e);
      if(!wanted.delete(k))fail();
      entries.push({...e,vector:checkedVector(batch.vectors[i],space)});
    }
  }
  if(wanted.size)fail();
  entries.sort((a,b)=>apiDenseEntryKey(a)<apiDenseEntryKey(b)?-1:apiDenseEntryKey(a)>apiDenseEntryKey(b)?1:0);
  const common={rootId,lexicalGenerationId,origin:config.origin,space,spaceId,entries};
  const base=policyMode?{...common,schemaVersion:3 as const,lineage:{
    kind:'verified-originals-v1' as const,reuse:'local-retrieval-only' as const,batches:proofs}}
    :{...common,schemaVersion:2 as const};
  const generation:ApiDenseGeneration={...base,generationId:digest(base)};
  validateApiDenseGeneration(generation,rootId);
  assertDensePolicyReuse(generation,config,expected,!!policyMode);
  built.set(generation,structuredClone(generation));
  return generation;
}
