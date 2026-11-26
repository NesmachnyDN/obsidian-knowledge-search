import { BOUNDS, hash, isDigest, validPath } from '../standalone/contracts';
import { ProviderFailure, type AiRole, type CallContext, type ProviderConfig } from './contracts';
import { bindActiveDeadline, remainingOperationMs, deadlineFailure, expireActiveDeadline } from './active-deadline';
import type { PolicyEnvelope } from './processing-policy';
import { embeddingSpaceId,validateEmbeddingSpace } from './embedding-space';
import { embeddingPolicyPayload,type EmbeddingPolicyDetails,type EmbeddingPolicyBindingDetails } from './embedding-policy';

/** Trusted host port; a caller cannot submit a profile, verdict or credential. */
export type ProcessingPolicyInput<R extends AiRole = Extract<AiRole,'generation'|'reranking'>> = Readonly<{
  role: R; config: ProviderConfig; scopeId: string; ownerId: string;
  hostId: string; credentialEpoch: number; deadlineUnixMs: number;
  payloadDigest: string; scopeBinding:string;
  scopeSources:readonly Readonly<{sourceId:string;sourceSha256:string}>[];
  sources: readonly Readonly<{sourceId:string; sourceSha256:string; excerptDigest:string}>[];
  embedding?:EmbeddingPolicyDetails;
}>;
export type GenerationPolicyInput = ProcessingPolicyInput<'generation'>;
export type RerankPolicyInput = ProcessingPolicyInput<'reranking'>;
export type ProcessingPolicyPort<R extends AiRole = Extract<AiRole,'generation'|'reranking'>> = Readonly<{
  selected?():boolean;
  current(input:ProcessingPolicyInput<R>,binding:GenerationPolicyBinding):boolean;
  evaluate(input:ProcessingPolicyInput<R>,context:CallContext,current:()=>boolean):Promise<PolicyEnvelope>;
}>;
// Historical inspection is local-only: no epoch, owner, deadline, grant or transport.
export type GenerationHistoryScope = Pick<GenerationPolicyInput,'role'|'config'|'scopeId'|'scopeBinding'|'scopeSources'|'sources'>;
export type GenerationPolicyPort = ProcessingPolicyPort<'generation'> & Readonly<{
  historyRevision?(scope:GenerationHistoryScope):string|null;
}>;
export type RerankPolicyPort = ProcessingPolicyPort<'reranking'>;
export type GenerationPolicyBinding = Readonly<{
  bindingDigest:string; payloadDigest:string; sourceDigest:string; scopeBinding:string; deadlineUnixMs:number;
  embedding?:EmbeddingPolicyBindingDetails;
}>;
export function processingPolicyInput<R extends AiRole>(input:ProcessingPolicyInput<R>):ProcessingPolicyInput<R> {
  if(!['generation','reranking','embedding'].includes(input.role)||!isDigest(input.scopeId)||!isDigest(input.payloadDigest)||!isDigest(input.scopeBinding)
    ||!input.ownerId||!input.hostId||!Number.isSafeInteger(input.credentialEpoch)||input.credentialEpoch<1
    ||!Number.isSafeInteger(input.deadlineUnixMs)||input.deadlineUnixMs<1
    ||!Array.isArray(input.sources)||input.sources.length>BOUNDS.limit
    ||(!input.sources.length&&!(input.role==='embedding'&&input.embedding?.purpose==='query'))
    ||input.sources.some(x=>!validPath(x.sourceId)||!isDigest(x.sourceSha256)||!isDigest(x.excerptDigest)))
    throw new ProviderFailure('DISCLOSURE_DENIED');
  if(!Array.isArray(input.scopeSources)||!input.scopeSources.length||input.scopeSources.length>BOUNDS.sources
    ||input.scopeSources.some(x=>!validPath(x.sourceId)||!isDigest(x.sourceSha256)))throw new ProviderFailure('DISCLOSURE_DENIED');
  let embedding:EmbeddingPolicyDetails|undefined;
  if(input.role==='embedding'){
    const e=input.embedding;
    if(!e||!['query','document'].includes(e.purpose)||!isDigest(e.spaceId)
      ||typeof e.query!=='string'||!e.query||!['synthetic','public'].includes(e.queryClassification)
      ||(e.purpose==='query'?input.sources.length!==0:input.sources.length===0)
      ||embeddingSpaceId(input.config,validateEmbeddingSpace(input.config,e.space))!==e.spaceId
      ||embeddingPolicyPayload(e.purpose,e.spaceId,e.query,e.queryClassification,input.sources)!==input.payloadDigest)
      throw new ProviderFailure('DISCLOSURE_DENIED');
    embedding=Object.freeze({...e,space:Object.freeze(validateEmbeddingSpace(input.config,e.space))});
  }else if(input.embedding!==undefined)throw new ProviderFailure('DISCLOSURE_DENIED');
  policyOriginals(input); // repeated passages allowed, conflicting versions never allowed
  const config=structuredClone(input.config);
  Object.freeze(config.identity);Object.freeze(config.limits);Object.freeze(config);
  return Object.freeze({...input,...(embedding?{embedding}:{}),config,scopeSources:Object.freeze(input.scopeSources.map(x=>Object.freeze({...x}))),sources:Object.freeze(input.sources.map(x=>Object.freeze({...x})))}) as ProcessingPolicyInput<R>;
}
export function generationPolicyInput(input:GenerationPolicyInput):GenerationPolicyInput {
  if(input.role!=='generation')throw new ProviderFailure('DISCLOSURE_DENIED');return processingPolicyInput(input);
}
export function rerankPolicyInput(input:RerankPolicyInput):RerankPolicyInput {
  if(input.role!=='reranking')throw new ProviderFailure('DISCLOSURE_DENIED');return processingPolicyInput(input);
}
export function policyOriginals(input:Pick<ProcessingPolicyInput,'sources'|'scopeSources'>):readonly {sourceId:string;sourceSha256:string}[] {
  const originals=new Map<string,string>();
  for(const source of input.scopeSources){
    if(originals.has(source.sourceId))throw new ProviderFailure('DISCLOSURE_DENIED');
    originals.set(source.sourceId,source.sourceSha256);
  }
  for(const source of input.sources)
    if(originals.get(source.sourceId)!==source.sourceSha256)throw new ProviderFailure('DISCLOSURE_DENIED');
  return [...originals].map(([sourceId,sourceSha256])=>({sourceId,sourceSha256}));
}
export function uniquePolicySources(sources:readonly {sourceId:string;sourceSha256:string}[]):readonly {sourceId:string;sourceSha256:string}[]{
  const originals=new Map<string,string>();
  for(const source of sources){
    if(originals.has(source.sourceId)&&originals.get(source.sourceId)!==source.sourceSha256)
      throw new ProviderFailure('DISCLOSURE_DENIED');
    originals.set(source.sourceId,source.sourceSha256);
  }
  return [...originals].map(([sourceId,sourceSha256])=>({sourceId,sourceSha256}));
}
export function generationPolicyPayload(query:string,candidates:readonly {sourceId:string;sourceSha256:string;text:string}[],role:'generation'|'reranking'='generation'):string {
  const ordered=[query,candidates.map(x=>[x.sourceId,x.sourceSha256,hash(x.text)])];
  return hash(JSON.stringify(role==='generation'?ordered:[role,...ordered]));
}
export function generationPolicySourceDigest(input:{role:AiRole;sources:readonly {sourceId:string;sourceSha256:string;excerptDigest:string}[]}):string {
  const ordered=input.sources.map(x=>[x.sourceId,x.sourceSha256,x.excerptDigest]);
  return hash(JSON.stringify(input.role==='generation'?ordered:[input.role,ordered]));
}
export function sameGenerationPolicy(a:GenerationPolicyBinding|undefined,b:GenerationPolicyBinding|undefined):boolean {
  return !!a&&!!b&&a.bindingDigest===b.bindingDigest&&a.payloadDigest===b.payloadDigest
    &&a.sourceDigest===b.sourceDigest&&a.scopeBinding===b.scopeBinding&&a.deadlineUnixMs===b.deadlineUnixMs
    &&(a.embedding===undefined&&b.embedding===undefined||!!a.embedding&&!!b.embedding
      &&a.embedding.purpose===b.embedding.purpose&&a.embedding.spaceId===b.embedding.spaceId
      &&a.embedding.scopeId===b.embedding.scopeId&&a.embedding.queryClassification===b.embedding.queryClassification);
}
/** One physical dependency slot per controller, even after logical timeout.
 * No capability or policy decision can be minted here. */
export class GenerationPolicyGate {
  private pending=false;
  private physicalDrain:Promise<void>=Promise.resolve();
  drain():Promise<void>{return this.physicalDrain;}
  get busy():boolean{return this.pending;}
  async evaluate<R extends AiRole>(port:ProcessingPolicyPort<R>,input:ProcessingPolicyInput<R>,context:CallContext,current:()=>boolean):Promise<GenerationPolicyBinding> {
    if(this.pending)throw new ProviderFailure('BUSY');
    const exact=processingPolicyInput(input), originals=policyOriginals(exact);
    if(context.deadlineUnixMs!==exact.deadlineUnixMs)throw new ProviderFailure('DISCLOSURE_DENIED');
    context=bindActiveDeadline(context,30000,exact.deadlineUnixMs);
    const check=()=>{remainingOperationMs(context);if(!current())throw new ProviderFailure('CANCELLED');remainingOperationMs(context);};
    const remaining=remainingOperationMs(context);
    this.pending=true;
    let drained!:()=>void;this.physicalDrain=new Promise<void>(resolve=>{drained=resolve;});
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(result?:PolicyEnvelope,error?:unknown)=>{
        if(settled)return;
        settled=true;clearTimeout(timer);context.signal.removeEventListener('abort',cancel);
        try{
          const failure=deadlineFailure(context);if(failure)throw failure;
          if(error!==undefined)throw error;
          check();
          if(!result?.allowed||result.reason!=='eligible'||!isDigest(result.bindingDigest)||result.policyVersion!=='oks-policy-1b'
            ||result.rootId!==exact.scopeId||result.sourceVersions.length!==originals.length
            ||result.sourceVersions.some((x,i)=>x.sourceId!==originals[i]!.sourceId||x.sha256!==originals[i]!.sourceSha256
              ||x.metadataState==='unresolved'))throw new ProviderFailure('DISCLOSURE_DENIED');
          const binding=Object.freeze({bindingDigest:result.bindingDigest,payloadDigest:exact.payloadDigest,
            sourceDigest:generationPolicySourceDigest(exact),scopeBinding:exact.scopeBinding,deadlineUnixMs:exact.deadlineUnixMs,
            ...(exact.embedding?{embedding:Object.freeze({purpose:exact.embedding.purpose,spaceId:exact.embedding.spaceId,
              scopeId:exact.scopeId,queryClassification:exact.embedding.queryClassification})}:{})});
          if(!port.current(exact,binding))throw new ProviderFailure('CANCELLED');
          check();resolve(binding);
        }catch(error){reject(error instanceof ProviderFailure?error:new ProviderFailure('DISCLOSURE_DENIED'));}
      };
      const cancel=()=>finish(undefined,new ProviderFailure('CANCELLED'));
      const timer=setTimeout(()=>{expireActiveDeadline(context);finish(undefined,new ProviderFailure('TIMEOUT'));},remaining);
      context.signal.addEventListener('abort',cancel,{once:true});
      Promise.resolve().then(()=>{check();return port.evaluate(exact,context,current);})
        .then(value=>{finish(value);this.pending=false;drained();},error=>{finish(undefined,error??new ProviderFailure('DISCLOSURE_DENIED'));this.pending=false;drained();});
      if(context.signal.aborted)cancel();
    });
  }
}
