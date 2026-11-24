/** Internal selected-corpus API retrieval. The public lexical v2 API is unchanged. */
import { BOUNDS, matches, validateRequest, type EvidenceHit, type SearchRequest, type SearchResponse } from '../standalone/contracts';
import { rrf } from '../advanced/retrieval';
import type { AdvancedRetrievalStore } from '../advanced/retrieval-storage';
import { ProviderFailure, type CallContext, type ProviderFailureCode } from './contracts';
import { EvidenceEmbedder, type EmbeddingApproval } from './embedding-evidence';
import { checkedVector, embeddingSpaceId, validateEmbeddingSpace } from './embedding-space';
import { MAX_API_VECTORS, apiDenseEntryKey, apiDenseEvidenceKey, type ApiDenseGeneration } from './dense-generation';

type Mode='dense'|'hybrid';
type Leg={status:'ready'|'unavailable'|'not-run'|'failed';candidateCount:number};
export type ApiRankedHit={evidence:EvidenceHit;rank:number;denseRank:number|null;
  denseSimilarity:number|null;lexicalRank:number|null;lexicalScore:number|null;rrfScore:number|null};
export type ApiRetrievalResult={version:1;requestedMode:Mode;executedMode:Mode|'none';
  status:'ok'|'failed';error:ProviderFailureCode|null;indexGenerationId:string|null;
  lexicalGenerationId:string|null;hits:ApiRankedHit[];legs:{dense:Leg;lexical:Leg}};
export type ApiRetrievalInput={request:SearchRequest&{requestedMode:Mode};
  lexicalGenerationId:string;evidence:readonly EvidenceHit[];approval:EmbeddingApproval};
export type ApiRetrievalPort={
  /** Trusted generation/scope/authorization operation fence, monotonic. */
  current():boolean;
  allowed(hit:EvidenceHit):boolean;
  /** Existing lexical engine, not a provider-produced ranking. */
  lexical(request:SearchRequest):Promise<SearchResponse>;
  /** Trusted D4 corpus lease; required only for a metadata-filtered text query. */
  metadataPaths?(request:SearchRequest,lexicalGenerationId:string,selectedPaths:readonly string[]):readonly string[];
};
const fail=(code:ProviderFailureCode):never=>{throw new ProviderFailure(code);};
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
const leg=(status:Leg['status'],candidateCount=0):Leg=>({status,candidateCount});
function failed(mode:Mode,code:ProviderFailureCode,denseStarted=false,lexicalStarted=false):ApiRetrievalResult{
  return {version:1,requestedMode:mode,executedMode:'none',status:'failed',error:code,
    indexGenerationId:null,lexicalGenerationId:null,hits:[],
    legs:{dense:leg(denseStarted?'failed':'not-run'),
      lexical:leg(mode==='hybrid'?(lexicalStarted?'failed':'not-run'):'unavailable')}};
}
function cosine(a:number[],b:number[]):number{
  let dot=0;
  for(let i=0;i<a.length;i++)dot+=a[i]!*b[i]!;
  return Math.max(-1,Math.min(1,dot/(Math.hypot(...a)*Math.hypot(...b))));
}
function selected(g:ApiDenseGeneration,hits:readonly EvidenceHit[]):Map<string,EvidenceHit>{
  const map=new Map<string,EvidenceHit>();
  for(const hit of hits){
    const id=apiDenseEvidenceKey(hit,g.lexicalGenerationId);
    if(map.has(id))fail('INVALID_RESPONSE');
    map.set(id,hit);
  }
  if(map.size!==g.entries.length||g.entries.some(e=>!map.has(apiDenseEntryKey(e))))fail('NOT_READY');
  return map;
}
export class ApiDenseSearch {
  private busy=false;
  // A cancelled filesystem/lexical operation may settle late. Do not start
  // another search until that single bounded operation has drained.
  private pending=false;
  private readonly embedder=new EvidenceEmbedder();
  constructor(private readonly store:AdvancedRetrievalStore){}
  private bounded<T>(task:()=>Promise<T>,context:CallContext):Promise<T>{
    if(context.signal.aborted)return Promise.reject(new ProviderFailure('CANCELLED'));
    const remaining=context.deadlineUnixMs-Date.now();
    if(remaining<=0)return Promise.reject(new ProviderFailure('TIMEOUT'));
    if(this.pending)return Promise.reject(new ProviderFailure('QUOTA_EXCEEDED'));
    this.pending=true;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error:unknown,value?:T)=>{
        if(settled)return;
        settled=true;clearTimeout(timer);context.signal.removeEventListener('abort',cancel);
        if(error)reject(error);else resolve(value!);
      };
      const cancel=()=>finish(new ProviderFailure('CANCELLED'));
      const timer=setTimeout(()=>finish(new ProviderFailure('TIMEOUT')),remaining);
      context.signal.addEventListener('abort',cancel,{once:true});
      Promise.resolve().then(()=>{
        if(context.signal.aborted)throw new ProviderFailure('CANCELLED');
        return task();
      }).then(value=>{this.pending=false;finish(null,value);},
        error=>{this.pending=false;finish(error??new ProviderFailure('NOT_READY'));});
      if(context.signal.aborted)cancel();
    });
  }
  async run(input:ApiRetrievalInput,token:string,context:CallContext,port:ApiRetrievalPort):Promise<ApiRetrievalResult>{
    const mode=input.request.requestedMode;
    if(this.busy||this.pending)return failed(mode,'QUOTA_EXCEEDED');
    this.busy=true;let denseStarted=false,lexicalStarted=false;
    try{
      try{validateRequest(input.request);}catch{return fail('CONFIG_INVALID');}
      if(!['dense','hybrid'].includes(mode)||!input.request.query.trim()
        ||mode==='dense'&&input.request.matchMode==='literal'
        ||!Number.isSafeInteger(context.deadlineUnixMs)
        ||!Array.isArray(input.evidence)||input.evidence.length<1||input.evidence.length>MAX_API_VECTORS
        ||input.approval.purpose!=='query'||input.approval.query.text!==input.request.query)
        return fail('CONFIG_INVALID');
      const value=structuredClone(input),req=value.request;
      context={signal:context.signal,deadlineUnixMs:Math.min(context.deadlineUnixMs,Date.now()+300000)};
      const check=()=>{
        if(context.signal.aborted||!port.current())fail('CANCELLED');
        if(Date.now()>=context.deadlineUnixMs)fail('TIMEOUT');
        if(value.evidence.some(hit=>!port.allowed(hit)))fail('DISCLOSURE_DENIED');
      };
      check();
      const space=validateEmbeddingSpace(value.approval.config,value.approval.space);
      const spaceId=embeddingSpaceId(value.approval.config,space);
      const read=async()=>{
        try{
          return await this.bounded(()=>this.store.snapshotApi(spaceId,value.lexicalGenerationId,context.signal),context);
        }catch(error){
          check();if(error instanceof ProviderFailure)throw error;return fail('SOURCE_STALE');
        }
      };
      denseStarted=true;
      const generation=await read();
      check();
      if(!generation||!this.store.isApiSnapshotCurrent(generation))return fail('NOT_READY');
      if(generation.rootId!==value.approval.scopeId)return fail('DISCLOSURE_DENIED');
      const map=selected(generation,value.evidence);
      const scope=req.scope?new Set(req.scope):null;
      let metadata:Set<string>|null=null;
      if(req.metadata){
        if(!port.metadataPaths)return fail('NOT_READY');
        const selectedPaths=new Set([...map.values()].map(hit=>hit.sourceId));
        const paths=port.metadataPaths(structuredClone(req),value.lexicalGenerationId,[...selectedPaths]);
        check();
        if(!Array.isArray(paths)||paths.length>selectedPaths.size
          ||new Set(paths).size!==paths.length||paths.some(path=>!selectedPaths.has(path)))
          return fail('NOT_READY');
        metadata=new Set(paths);
      }
      const eligible=new Map([...map].filter(([,h])=>(!scope||scope.has(h.sourceId))
        &&(!metadata||metadata.has(h.sourceId))&&matches(h.properties,req.predicates??[])));
      const current=()=>port.current()&&this.store.isApiSnapshotCurrent(generation)
        &&value.evidence.every(hit=>port.allowed(hit));
      const {batch}=await this.embedder.run(value.approval,token,context,async()=>{},current);
      check();
      if(!this.store.isApiSnapshotCurrent(generation))return fail('SOURCE_STALE');
      if(batch.spaceId!==spaceId||batch.purpose!=='query'||batch.vectors.length!==1)return fail('MODEL_MISMATCH');
      const query=checkedVector(batch.vectors[0],space);
      const dense=generation.entries.map(e=>({key:apiDenseEntryKey(e),score:cosine(e.vector,query)}))
        .filter(e=>eligible.has(e.key)).sort((a,b)=>b.score-a.score||cmp(a.key,b.key)).slice(0,BOUNDS.limit);
      const lexical=new Map<string,{rank:number;score:number}>();
      if(mode==='hybrid'){
        const scope=[...new Set([...eligible.values()].map(h=>h.sourceId))];
        lexicalStarted=true;
        const response=await this.bounded(()=>port.lexical({...req,requestedMode:'lexical',scope,limit:BOUNDS.limit}),context);
        check();
        if(response.requestId!==req.requestId||response.requestedMode!=='lexical'
          ||response.executedMode!=='lexical'||response.status!=='ok'
          ||response.capabilityReadiness.lexical!=='ready'||response.indexGenerationId!==value.lexicalGenerationId
          ||response.hits.length>BOUNDS.limit)return fail('NOT_READY');
        for(const [i,hit] of response.hits.entries()){
          const key=apiDenseEvidenceKey(hit,value.lexicalGenerationId);
          if(!eligible.has(key)||lexical.has(key)||hit.rank!==i+1||hit.lexicalRank!==i+1
            ||!Number.isFinite(hit.score))return fail('NOT_READY');
          lexical.set(key,{rank:i+1,score:hit.score});
        }
      }
      const ranks=new Map(dense.map((x,i)=>[x.key,{rank:i+1,score:x.score}]));
      const order=mode==='hybrid'?rrf([...lexical.keys()],dense.map(x=>x.key)):dense;
      const hits=order.slice(0,req.limit).map((x,i):ApiRankedHit=>({
        evidence:eligible.get(x.key)!,rank:i+1,denseRank:ranks.get(x.key)?.rank??null,
        denseSimilarity:ranks.get(x.key)?.score??null,lexicalRank:lexical.get(x.key)?.rank??null,
        lexicalScore:lexical.get(x.key)?.score??null,rrfScore:mode==='hybrid'?x.score:null}));
      const verified=await read();
      check();
      if(!verified||verified.generationId!==generation.generationId
        ||!this.store.isApiSnapshotCurrent(generation)||!this.store.isApiSnapshotCurrent(verified))
        return fail('SOURCE_STALE');
      return {version:1,requestedMode:mode,executedMode:mode,status:'ok',error:null,
        indexGenerationId:generation.generationId,lexicalGenerationId:value.lexicalGenerationId,hits,
        legs:{dense:leg('ready',dense.length),lexical:leg(mode==='hybrid'?'ready':'unavailable',lexical.size)}};
    }catch(error){
      return failed(mode,error instanceof ProviderFailure?error.code:'NOT_READY',denseStarted,lexicalStarted);
    }finally{this.busy=false;}
  }
}
