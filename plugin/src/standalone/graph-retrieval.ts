/** Internal local-only result. This is deliberately not an AI EvidenceHit
 * envelope. Paths describe authored claims, never confirmed semantic facts. */
import { StandaloneError, hash, type EvidenceHit, type IndexGeneration, type ParsedBlock, type SourceLocator } from './contracts';
import { freezeScope, type ScopeSnapshot } from './chat-scope';
import { planGraphExpansion, type GraphQuery, type GraphPathStep } from './graph-expansion';
import type { GraphMapping } from './graph-mapping';
import type { ScopedGraphSnapshot } from './graph-lifecycle';
import type { SourceProvider } from './source';
import { verifySpan } from '../search/navigation';
import { bindActiveDeadline, expireActiveDeadline, remainingOperationMs } from '../ai/active-deadline';
import { ProviderFailure } from '../ai/contracts';

export type GraphExcerpt = Readonly<{
  sourceId:string;sourceSha256:string;blockId:string;excerpt:string;locator:Readonly<SourceLocator>;
}>;
export type VerifiedGraphStep = Readonly<GraphPathStep & {anchorEvidence:readonly GraphExcerpt[]}>;
export type LocalGraphCandidate = Readonly<GraphExcerpt & {
  kind:'lexical'|'expanded';rank:number;lexicalRank:number|null;seedSourceId:string;seedLexicalRank:number;
  path:readonly VerifiedGraphStep[];
}>;
export type LocalGraphResult = Readonly<{
  requestedMode:'graph';executedMode:'graph';requestId:string;rootId:string;generationId:string;
  mappingId:string;projectionId:string;scope:Readonly<ScopeSnapshot>;
  expansion:GraphQuery['expansion'];projectionCoverage:ScopedGraphSnapshot['coverage'];
  lexicalHitCount:number;lexicalCount:number;uniqueCandidateCount:number;omittedByTopK:number;
  contextBytes:number;candidates:readonly LocalGraphCandidate[];
}>;

/** Host-only, exact-result lease. Never serialized or supplied by callers. */
export type LocalGraphLease = Readonly<{
  current():boolean; read():Promise<LocalGraphResult>; verify():Promise<void>;
}>;

/** Catalog authentication rehashes every original, including identity
 * competitors. Bind every retained excerpt back to the authenticated parse. */
export function verifyRetainedGraph(gen:IndexGeneration, snapshot:ScopedGraphSnapshot,result:LocalGraphResult):void {
  if(result.rootId!==gen.rootId||result.generationId!==gen.generationId||result.mappingId!==snapshot.mappingId
    ||result.projectionId!==snapshot.scopedProjectionId||JSON.stringify(result.scope)!==JSON.stringify(snapshot.scope))
    throw new StandaloneError('GRAPH_SOURCE_STALE');
  const docs=new Map(gen.documents.map(d=>[d.sourceId,d]));
  const allowed=new Map(snapshot.scope.sources.map(s=>[s.sourceId,s.sourceSha256]));
  const evidence=(item:GraphExcerpt):void=>{
    const block=docs.get(item.sourceId)?.blocks[item.locator.blockOrder];
    if(!block||allowed.get(item.sourceId)!==item.sourceSha256||block.sourceId!==item.sourceId
      ||block.sourceSha256!==item.sourceSha256||block.blockId!==item.blockId||block.originalText!==item.excerpt
      ||JSON.stringify(block.locator)!==JSON.stringify(item.locator))
      throw new StandaloneError('GRAPH_EVIDENCE_INVALID');
  };
  for(const candidate of result.candidates){
    evidence(candidate);
    for(const step of candidate.path)for(const anchor of step.anchorEvidence)evidence(anchor);
  }
}

const GRAPH_TIMEOUT_MS=30_000;
export type GraphDeadline=Readonly<{check():void;wait<T>(physical:Promise<T>):Promise<T>}>;
const deadlineError=(error:unknown):StandaloneError=>new StandaloneError(error instanceof ProviderFailure
  &&error.code==='CANCELLED'?'GRAPH_CANCELLED':'GRAPH_TIMEOUT');

/** A single host-local budget. Logical cancellation never releases the
 * engine's physical slot; its owner must drain the original promise. */
export function graphDeadline(signal:AbortSignal):GraphDeadline {
  const context=(()=>{
    try{return bindActiveDeadline({signal,deadlineUnixMs:Date.now()+GRAPH_TIMEOUT_MS},GRAPH_TIMEOUT_MS);}
    catch(error){throw deadlineError(error);}
  })();
  const remaining=():number=>{
    try{return remainingOperationMs(context);}catch(error){throw deadlineError(error);}
  };
  const check=()=>{remaining();};
  const wait=<T>(physical:Promise<T>):Promise<T>=>new Promise<T>((resolve,reject)=>{
    let settled=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const finish=(fn:()=>void)=>{
      if(settled)return;settled=true;
      if(timer!==undefined)clearTimeout(timer);
      signal.removeEventListener('abort',abort);
      fn();
    };
    const abort=()=>finish(()=>{try{check();reject(new StandaloneError('GRAPH_CANCELLED'));}catch(e){reject(e);}});
    // Always observe the physical promise, even if admission already expired.
    void physical.then(value=>finish(()=>{try{check();resolve(value);}catch(e){reject(e);}}),
      error=>finish(()=>{try{check();reject(error);}catch(e){reject(e);}}));
    signal.addEventListener('abort',abort,{once:true});
    try{
      timer=setTimeout(()=>{expireActiveDeadline(context);finish(()=>reject(new StandaloneError('GRAPH_TIMEOUT')));},remaining());
      if(signal.aborted)abort();
    }catch(error){finish(()=>reject(error));}
  });
  return Object.freeze({check,wait});
}

/** Materialize only host-authenticated plan candidates. Retain the actual
 * winning lexical excerpt, not an unrelated first line. Expanded candidates
 * use the first nonblank non-property canonical block. */
export async function materializeGraph(gen:IndexGeneration, graph:ScopedGraphSnapshot, mapping:GraphMapping,
  query:GraphQuery, seeds:readonly EvidenceHit[], provider:SourceProvider, check:()=>void):Promise<LocalGraphResult> {
  check();
  const plan=planGraphExpansion(graph,seeds,query,mapping,()=>{check();return true;});
  const docs=new Map(gen.documents.map(d=>[d.sourceId,d]));
  const allowed=new Map(graph.scope.sources.map(s=>[s.sourceId,s.sourceSha256]));
  const bytesBySource=new Map<string,Uint8Array>();
  let contextBytes=0;
  const evidence=async(sourceId:string,sourceSha256:string,block:ParsedBlock|undefined):Promise<GraphExcerpt>=>{
    check();
    if(!block)throw new StandaloneError('GRAPH_EVIDENCE_MISSING');
    const loc=block.locator;
    if(allowed.get(sourceId)!==sourceSha256||block.sourceId!==sourceId||block.sourceSha256!==sourceSha256
      ||block.blockId!==hash(JSON.stringify([sourceId,sourceSha256,block.order,loc.byteStart,loc.byteEnd])))
      throw new StandaloneError('GRAPH_EVIDENCE_INVALID');
    let bytes=bytesBySource.get(sourceId);
    if(!bytes){bytes=await provider.read(sourceId);check();if(hash(bytes)!==sourceSha256)throw new StandaloneError('GRAPH_SOURCE_STALE');bytesBySource.set(sourceId,bytes);}
    const hit:EvidenceHit={sourceId,sourceSha256,originalExcerpt:block.originalText,sourceLocators:[{...loc}],
      rank:1,lexicalRank:1,retrievalMode:'lexical',indexGenerationId:gen.generationId,score:0,headings:[],wikiLinks:[],properties:[]};
    try{verifySpan(hit,bytes);}catch{throw new StandaloneError('GRAPH_EVIDENCE_INVALID');}
    contextBytes+=Buffer.byteLength(block.originalText,'utf8');
    if(contextBytes>16*1024)throw new StandaloneError('GRAPH_LIMIT');
    return {sourceId,sourceSha256,blockId:block.blockId,excerpt:block.originalText,locator:{...loc}};
  };
  const candidates:LocalGraphCandidate[]=[];
  const seen=new Set<string>();
  for(const seed of seeds){
    if(seen.has(seed.sourceId))continue;
    seen.add(seed.sourceId);
    const loc=seed.sourceLocators[0]!, block=docs.get(seed.sourceId)?.blocks[loc.blockOrder];
    if(!block||JSON.stringify(block.locator)!==JSON.stringify(loc)||block.originalText!==seed.originalExcerpt)
      throw new StandaloneError('GRAPH_EVIDENCE_INVALID');
    candidates.push({...await evidence(seed.sourceId,seed.sourceSha256,block),kind:'lexical',rank:candidates.length+1,
      lexicalRank:seed.lexicalRank,seedSourceId:seed.sourceId,seedLexicalRank:seed.lexicalRank,path:[]});
  }
  for(const expanded of plan.expanded){
    if(candidates.length>=query.limit)break;
    const doc=docs.get(expanded.sourceId);
    const block=doc?.blocks.find(b=>b.kind!=='blank'&&b.kind!=='property'&&b.originalText.trim()!=='');
    const path:VerifiedGraphStep[]=[];
    for(const step of expanded.path){
      const anchorEvidence:GraphExcerpt[]=[];
      for(const anchor of step.edge.anchors){
        const authored=docs.get(anchor.sourceId)?.blocks[anchor.locator.blockOrder];
        if(!authored||authored.blockId!==anchor.blockId||JSON.stringify(authored.locator)!==JSON.stringify(anchor.locator))
          throw new StandaloneError('GRAPH_EVIDENCE_INVALID');
        anchorEvidence.push(await evidence(anchor.sourceId,anchor.sourceSha256,authored));
      }
      path.push({...step,anchorEvidence});
    }
    candidates.push({...await evidence(expanded.sourceId,expanded.sourceSha256,block),kind:'expanded',rank:candidates.length+1,
      lexicalRank:null,seedSourceId:expanded.seedSourceId,seedLexicalRank:expanded.seedLexicalRank,path});
  }
  check();
  if(candidates.length!==plan.uniqueCandidateCount-plan.omittedByTopK)throw new StandaloneError('GRAPH_EVIDENCE_INVALID');
  return freezeScope({requestedMode:'graph',executedMode:'graph',requestId:query.requestId,rootId:gen.rootId,
    generationId:gen.generationId,mappingId:graph.mappingId,projectionId:graph.scopedProjectionId,scope:graph.scope,
    expansion:query.expansion,projectionCoverage:graph.coverage,
    lexicalHitCount:plan.lexicalHitCount,lexicalCount:plan.lexicalCount,uniqueCandidateCount:plan.uniqueCandidateCount,
    omittedByTopK:plan.omittedByTopK,contextBytes,candidates});
}
