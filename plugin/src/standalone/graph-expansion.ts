import { BOUNDS, StandaloneError, hash, isDigest, isRecord, validPath, validateRequest, type EvidenceHit, type SourceLocator } from './contracts';
import { freezeScope, parseScopeSelector, type ScopeSelector, type ScopedSearch } from './chat-scope';
import { compare, graphMappingId, graphText, type GraphMapping } from './graph-mapping';
import type { ScopedGraphSnapshot } from './graph-lifecycle';
import type { GraphEdge } from './graph-projection';

export type GraphExpansion = Readonly<{
  depth:0|1|2; direction:'outgoing'|'incoming'|'both';
  relationIds?:readonly string[]; fanOut:number; maxExpanded:number;
}>;
export type GraphQuery = Readonly<ScopedSearch & {scope:ScopeSelector; expansion:GraphExpansion}>;
export type GraphPathStep = Readonly<{edge:GraphEdge; traversal:'forward'|'reverse'}>;
export type ExpandedCandidate = Readonly<{
  sourceId:string;sourceSha256:string;seedSourceId:string;seedLexicalRank:number;
  path:readonly GraphPathStep[];
}>;
export type GraphExpansionPlan = Readonly<{
  lexicalHitCount:number;lexicalCount:number;uniqueCandidateCount:number;expanded:readonly ExpandedCandidate[];omittedByTopK:number;
}>;
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>
  isRecord(v)&&Object.keys(v).every(k=>keys.includes(k));
const integer=(v:unknown,min:number,max:number):v is number=>
  typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const invalid=():never=>{throw new StandaloneError('GRAPH_REQUEST_INVALID');};

/** Explicit opt-in only. The existing lexical parser remains authoritative for
 * query and Top-K; the graph cannot broaden the original selector. */
export function parseGraphQuery(input:unknown):GraphQuery {
  if(!exact(input,['requestId','query','limit','matchMode','scope','expansion'])
    || typeof input.query!=='string'||!input.query.trim()
    || (input.matchMode!==undefined&&input.matchMode!=='terms'&&input.matchMode!=='literal'))return invalid();
  const e=input.expansion;
  if(!exact(e,['depth','direction','relationIds','fanOut','maxExpanded'])
    ||!integer(e.depth,0,2)||(e.direction!=='outgoing'&&e.direction!=='incoming'&&e.direction!=='both')
    ||!integer(e.fanOut,1,16)||!integer(e.maxExpanded,1,32)
    ||(e.relationIds!==undefined&&(!Array.isArray(e.relationIds)||!e.relationIds.length||e.relationIds.length>32
      ||!Array.from(e.relationIds).every(v=>graphText(v))||new Set(e.relationIds).size!==e.relationIds.length)))return invalid();
  try{
    validateRequest({protocolVersion:2,requestedMode:'lexical',requestId:input.requestId,query:input.query,
      limit:input.limit,matchMode:input.matchMode});
    const scope=parseScopeSelector(input.scope);
    if(scope.mode==='selected'&&scope.kind==='editor-selection')throw new StandaloneError('GRAPH_SCOPE_UNSUPPORTED');
    const q:GraphQuery={requestId:input.requestId as string,query:input.query,limit:input.limit as number,
      ...(input.matchMode?{matchMode:input.matchMode}:{}),scope,expansion:{depth:e.depth as 0|1|2,direction:e.direction,
      fanOut:e.fanOut,maxExpanded:e.maxExpanded,...(e.relationIds?{relationIds:[...e.relationIds].sort(compare)}:{})}};
    return freezeScope(q);
  }catch(error){if(error instanceof StandaloneError&&error.code==='GRAPH_SCOPE_UNSUPPORTED')throw error;return invalid();}
}
type QueueEntry=ExpandedCandidate;
type Neighbor={sourceId:string; step:GraphPathStep};
const stale=():never=>{throw new StandaloneError('GRAPH_EVIDENCE_INVALID');};
const locatorKeys=['locatorKind','sourceVersion','blockOrder','byteStart','byteEnd','charStart','charEnd','lineStart','lineEnd'];
function locator(v:unknown,version:string):v is SourceLocator {
  if(!exact(v,locatorKeys)||Object.keys(v).length!==locatorKeys.length
    ||v.locatorKind!=='markdown'||v.sourceVersion!==version
    ||!integer(v.blockOrder,0,BOUNDS.blocksPerSource-1)
    ||!integer(v.byteStart,0,BOUNDS.fileBytes)||!integer(v.byteEnd,0,BOUNDS.fileBytes)
    ||!integer(v.charStart,0,BOUNDS.fileBytes)||!integer(v.charEnd,0,BOUNDS.fileBytes)
    ||v.byteStart>=v.byteEnd||v.charStart>=v.charEnd
    ||v.charStart>v.byteStart||v.charEnd-v.charStart>v.byteEnd-v.byteStart
    ||v.lineStart!==v.blockOrder+1||v.lineEnd!==v.lineStart)return false;
  return true;
}
function validAnchor(v:unknown,author:string,version:string):boolean {
  return exact(v,['sourceId','sourceSha256','blockId','locator'])
    &&v.sourceId===author&&v.sourceSha256===version&&locator(v.locator,version)
    &&v.blockId===hash(JSON.stringify([author,version,v.locator.blockOrder,v.locator.byteStart,v.locator.byteEnd]));
}
function validSeed(seed:EvidenceHit,version:string):boolean {
  if(!Array.isArray(seed.sourceLocators)||seed.sourceLocators.length!==1
    ||!locator(seed.sourceLocators[0],version)||typeof seed.originalExcerpt!=='string'
    ||/[\r\n]/.test(seed.originalExcerpt))return false;
  const l=seed.sourceLocators[0];
  return Buffer.byteLength(seed.originalExcerpt,'utf8')===l.byteEnd-l.byteStart
    &&[...seed.originalExcerpt].length===l.charEnd-l.charStart;
}

/** Pure traversal, not a proof or disclosure grant. A host must authenticate
 * the snapshot, seed evidence, all path constituents and expanded excerpts
 * before publishing a separate graph result. */
export function planGraphExpansion(graph:ScopedGraphSnapshot, seeds:readonly EvidenceHit[],
  request:GraphQuery, mapping:GraphMapping, current:()=>boolean=()=>true):GraphExpansionPlan {
  const check=()=>{if(!current())throw new StandaloneError('GRAPH_CANCELLED');};
  check();
  const q=parseGraphQuery(request), options=q.expansion;
  if(JSON.stringify(q.scope)!==JSON.stringify(graph.scope.selector)
    ||!isDigest(graph.scope.rootId)||!isDigest(graph.scope.generationId)||graph.mappingId!==graphMappingId(mapping)||graph.scope.sources.length>BOUNDS.sources
    ||graph.nodes.length>BOUNDS.sources||graph.edges.length>8192||seeds.length>q.limit)return stale();
  const rules=new Map(mapping.rules.map(r=>[r.relationId,r]));
  if(options.relationIds?.some(id=>!rules.has(id)))return invalid();
  const enabled=new Set(options.relationIds??rules.keys());
  const versions=new Map(graph.scope.sources.map(s=>[s.sourceId,s.sourceSha256]));
  if(versions.size!==graph.scope.sources.length||graph.scope.sources.some(s=>!validPath(s.sourceId)||!isDigest(s.sourceSha256))||graph.nodes.length!==versions.size
    ||new Set(graph.nodes.map(n=>n.sourceId)).size!==graph.nodes.length
    ||graph.nodes.some(n=>versions.get(n.sourceId)!==n.sourceSha256||!isDigest(n.sourceSha256)))return stale();
  const adjacency=new Map<string,Neighbor[]>();
  const add=(source:string,dest:string,edge:GraphEdge,traversal:GraphPathStep['traversal'])=>{
    const row=adjacency.get(source)??[];
    row.push({sourceId:dest,step:{edge,traversal}});adjacency.set(source,row);
  };
  const edgeIds=new Set<string>();
  for(const e of graph.edges){
    check();
    if(!isRecord(e)||!isDigest(e.edgeId)||edgeIds.has(e.edgeId)||!versions.has(e.from)||!versions.has(e.to)||!versions.has(e.author)||versions.get(e.from)!==e.sourceSha256||versions.get(e.to)!==e.targetSha256
      ||versions.get(e.author)!==e.authorSha256||!Array.isArray(e.anchors)||!e.anchors.length||e.anchors.length>2
      ||!e.anchors.every(a=>validAnchor(a,e.author,e.authorSha256)))return stale();
    if(!isRecord(e.status)||e.status.truth!=='unverified'||(e.status.declared!==null&&!graphText(e.status.declared)))return stale();
    edgeIds.add(e.edgeId);
    if(e.kind==='navigation'){if(e.relationId!==null||e.author!==e.from)return stale();continue;}
    if(e.kind!=='relation'||!e.relationId)return stale();
    const rule=rules.get(e.relationId);
    if(!rule||e.author!==(rule.direction==='author-to-target'?e.from:e.to))return stale();
    if(!enabled.has(e.relationId))continue;
    if(options.direction!=='incoming')add(e.from,e.to,e,'forward');
    if(options.direction!=='outgoing')add(e.to,e.from,e,'reverse');
  }
  for(const row of adjacency.values())row.sort((a,b)=>compare(a.step.edge.edgeId,b.step.edge.edgeId)
    ||compare(a.step.traversal,b.step.traversal)||compare(a.sourceId,b.sourceId));
  const seen=new Set<string>(), queue:QueueEntry[]=[];
  for(const [index,seed] of seeds.entries()){
    if(!isRecord(seed)||seed.retrievalMode!=='lexical'||seed.indexGenerationId!==graph.scope.generationId
      ||seed.rank!==index+1||seed.lexicalRank!==index+1||!versions.has(seed.sourceId)||versions.get(seed.sourceId)!==seed.sourceSha256
      ||!isDigest(seed.sourceSha256)||!validSeed(seed,seed.sourceSha256))return stale();
    if(seen.has(seed.sourceId))continue;
    seen.add(seed.sourceId);
    queue.push({sourceId:seed.sourceId,sourceSha256:seed.sourceSha256,seedSourceId:seed.sourceId,
      seedLexicalRank:seed.lexicalRank,path:[]});
  }
  const lexicalCount=queue.length;
  const expanded:ExpandedCandidate[]=[];
  for(let i=0;i<queue.length;i++){
    check();const entry=queue[i]!;
    if(entry.path.length>=options.depth)continue;
    const neighbors=new Map<string,Neighbor>();
    for(const n of adjacency.get(entry.sourceId)??[]){
      if(!seen.has(n.sourceId)&&!neighbors.has(n.sourceId))neighbors.set(n.sourceId,n);
    }
    if(neighbors.size>options.fanOut)throw new StandaloneError('GRAPH_LIMIT');
    for(const n of neighbors.values()){
      check();
      if(expanded.length>=options.maxExpanded)throw new StandaloneError('GRAPH_LIMIT');
      const next:ExpandedCandidate={sourceId:n.sourceId,sourceSha256:versions.get(n.sourceId)!,
        seedSourceId:entry.seedSourceId,seedLexicalRank:entry.seedLexicalRank,path:[...entry.path,n.step]};
      seen.add(n.sourceId);expanded.push(next);queue.push(next);
    }
  }
  check();
  // Top-K is explicit ranking selection, not an exceeded traversal budget.
  // Keep every bounded expanded candidate in the private plan so the host can
  // report coverage and never silently pretend a truncated traversal succeeded.
  const uniqueCandidateCount=lexicalCount+expanded.length;
  return freezeScope({lexicalHitCount:seeds.length,lexicalCount,uniqueCandidateCount,expanded:structuredClone(expanded),
    omittedByTopK:Math.max(0,uniqueCandidateCount-q.limit)});
}
