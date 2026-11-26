/** Explicit selected-corpus rebuild. No provider or background work at startup. */
import type { EvidenceHit } from '../standalone/contracts';
import { StandaloneError } from '../standalone/contracts';
import type { StandaloneEngine } from '../standalone/engine';
import type { AdvancedRetrievalStore } from '../advanced/retrieval-storage';
import { canonical } from '../advanced/protocol';
import { ProviderFailure, type ProviderFailureCode, type ProviderConfig, type EmbeddingSpace, type CallContext } from './contracts';
import { configDigest,projectDisclosure } from './disclosure';
import { pilotConfig } from './loopback-json';
import { preflightDocumentEmbedding } from './loopback-embedding';
import { embeddingSpaceId, validateEmbeddingSpace } from './embedding-space';
import { EvidenceEmbedder, type EmbeddingApproval, type VerifiedEmbeddingResult } from './embedding-evidence';
import { MAX_API_VECTORS, buildApiDenseGeneration } from './dense-generation';
import type { GenerationPolicyBinding } from './generation-policy';

import {INDEX_PURPOSE_TEXT} from './embedding-policy';
export {INDEX_PURPOSE_TEXT} from './embedding-policy';
export type DenseIndexRequest={paths:readonly string[];config:ProviderConfig;space:EmbeddingSpace};
export type DenseIndexGrantInput={scopeId:string;config:ProviderConfig;space:EmbeddingSpace;
  query:string;evidence:readonly EvidenceHit[]};
export type DenseIndexPort={
  /** Trusted host permission fence: once false, remains false for this operation. */
  current():boolean;
  /** Side-effect-free policy predicate over authoritative original evidence. */
  allowed(hit:EvidenceHit):boolean;
  authorize(input:DenseIndexGrantInput):EmbeddingApproval;
  /** Policy mode authorizes the complete immutable batch plan before the
   * first transport dispatch.  Legacy pilot callers deliberately omit this. */
  authorizePlan?(inputs:readonly DenseIndexGrantInput[]):Promise<readonly EmbeddingApproval[]>;
  publicationFence?(current:()=>boolean):void;
  policyCheck?(approval:EmbeddingApproval):()=>Promise<GenerationPolicyBinding>;
};
export type DenseIndexResult={status:'ok'|'failed';error:ProviderFailureCode|null;
  generationId:string|null;count:number};
const fail=(code:ProviderFailureCode):never=>{throw new ProviderFailure(code);};
const failed=(error:ProviderFailureCode):DenseIndexResult=>({status:'failed',error,generationId:null,count:0});
function errorCode(error:unknown):ProviderFailureCode{
  if(error instanceof ProviderFailure)return error.code;
  if(error instanceof StandaloneError){
    if(error.code==='CANCELLED')return 'CANCELLED';
    if(error.code==='INDEX_LIMIT')return 'LIMIT_EXCEEDED';
    if(error.code==='INVALID_REQUEST')return 'CONFIG_INVALID';
    if(error.code==='SOURCE_STALE'||error.code==='NAVIGATION_REJECTED')return 'SOURCE_STALE';
  }
  return 'NOT_READY';
}
export function planDenseBatches(evidence:readonly EvidenceHit[],config:ProviderConfig):EvidenceHit[][]{
  const result:EvidenceHit[][]=[];
  let batch:EvidenceHit[]=[];
  const preflight=(hits:readonly EvidenceHit[])=>preflightDocumentEmbedding(config,{
    query:INDEX_PURPOSE_TEXT,passages:hits.map((hit,id)=>({id,text:hit.originalExcerpt})),
  });
  for(const hit of evidence){
    // Atomic evidence must fit on its own; reject the entire plan before egress.
    preflight([hit]);
    if(batch.length){
      try{preflight([...batch,hit]);}
      catch(error){
        if(!(error instanceof ProviderFailure)||error.code!=='LIMIT_EXCEEDED')throw error;
        result.push(batch);batch=[];
      }
    }
    batch.push(hit);
  }
  if(batch.length)result.push(batch);
  return result;
}
export class ApiDenseIndexManager{
  private busy=false;
  private readonly embedder=new EvidenceEmbedder();
  constructor(private readonly engine:StandaloneEngine,private readonly store:AdvancedRetrievalStore){}
  async rebuild(input:DenseIndexRequest,token:string,context:CallContext,port:DenseIndexPort):Promise<DenseIndexResult>{
    if(this.busy)return failed('QUOTA_EXCEEDED');
    this.busy=true;
    try{
      if(!Number.isSafeInteger(context.deadlineUnixMs))return fail('CONFIG_INVALID');
      context={signal:context.signal,deadlineUnixMs:Math.min(context.deadlineUnixMs,Date.now()+300000)};
      const request=structuredClone(input),config=pilotConfig(request.config);
      const space=validateEmbeddingSpace(config,request.space),spaceId=embeddingSpaceId(config,space);
      const check=()=>{
        if(context.signal.aborted||!port.current())fail('CANCELLED');
        if(Date.now()>=context.deadlineUnixMs)fail('TIMEOUT');
      };
      check();
      const corpus=await this.engine.captureDenseCorpus(request.paths,MAX_API_VECTORS,context.signal);
      const current=()=>!context.signal.aborted&&Date.now()<context.deadlineUnixMs&&port.current()
        &&corpus.current()&&corpus.evidence.every(hit=>port.allowed(hit));
      const guard=()=>{
        check();
        if(!corpus.current())fail('SOURCE_STALE');
        if(!corpus.evidence.every(hit=>port.allowed(hit)))fail('DISCLOSURE_DENIED');
      };
      guard();
      // Plan every batch first, including the reserved grant-purpose text.
      const planned=planDenseBatches(corpus.evidence,config),results:VerifiedEmbeddingResult[]=[];
      const inputs=planned.map(evidence=>({scopeId:corpus.rootId,config,space,query:INDEX_PURPOSE_TEXT,evidence}));
      if(!!port.authorizePlan!==!!port.policyCheck)return fail('DISCLOSURE_DENIED');
      const grants=port.authorizePlan?await port.authorizePlan(structuredClone(inputs)):undefined;
      if(port.authorizePlan&&(!Array.isArray(grants)||grants.length!==planned.length))return fail('DISCLOSURE_DENIED');
      const validate=(approval:EmbeddingApproval,batch:readonly EvidenceHit[]):EmbeddingApproval=>{
        if(!approval||approval.purpose!=='document'||approval.scopeId!==corpus.rootId
          ||approval.query.text!==INDEX_PURPOSE_TEXT||approval.grant?.sources.length!==batch.length
          ||approval.grant.purpose!=='document'||approval.grant.spaceId!==spaceId
          ||!!approval.grant.notePolicyBinding!==!!port.authorizePlan
          ||configDigest('embedding',approval.config)!==configDigest('embedding',config)
          ||embeddingSpaceId(approval.config,approval.space)!==spaceId
          ||canonical(approval.candidates.map(row=>row.hit))!==canonical(batch))
          return fail('DISCLOSURE_DENIED');
        if(port.authorizePlan)projectDisclosure('embedding',config,corpus.rootId,approval.query,
          approval.candidates.map(({hit,classification})=>({text:hit.originalExcerpt,sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,classification})),
          approval.grant,context.signal,Date.now(),approval.grant.notePolicyBinding);
        return structuredClone(approval);
      };
      // All policy grants must match the entire plan before any batch can send.
      const approved=grants?Array.from(grants,(grant,i)=>validate(grant,planned[i]!)):undefined;
      guard();
      for(const [batchId,batch] of planned.entries()){
        guard();
        const approval=approved?approved[batchId]!:validate(port.authorize(structuredClone(inputs[batchId]!)),batch);
        guard();
        results.push(await this.embedder.run(approval,token,context,corpus.verify,current,port.policyCheck?.(approval)));
        guard();
      }
      const generation=buildApiDenseGeneration(corpus.rootId,config,space,corpus.lexicalGenerationId,
        corpus.evidence,results,approved?.map(a=>a.grant.notePolicyBinding!));
      await this.store.publishApi(generation,async()=>{guard();},context.signal,current);
      guard();
      if(port.publicationFence){
        const snapshot=await this.store.snapshotApi(spaceId,corpus.lexicalGenerationId,context.signal);
        guard();
        if(!snapshot||snapshot.generationId!==generation.generationId||!this.store.isApiSnapshotCurrent(snapshot))return fail('SOURCE_STALE');
        port.publicationFence(()=>this.store.isApiSnapshotCurrent(snapshot));
        guard();
      }
      return {status:'ok',error:null,generationId:generation.generationId,count:corpus.evidence.length};
    }catch(error){return failed(errorCode(error));}
    finally{this.busy=false;}
  }
}
