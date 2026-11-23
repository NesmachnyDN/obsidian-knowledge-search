/** Deterministic 05D ranking over immutable canonical v3 chunks (not duplicate source models). */
import { terms } from '../standalone/markdown';
import { matches, validProperty, type Predicate } from '../standalone/contracts';
import type { IngestChunk, IngestLocator, IngestResponse, IngestSource } from './protocol';
import type { RetrievalGeneration } from './retrieval-storage';
import { ModelError, verifyVector } from './model-protocol';
import { canonical, sha } from './protocol';

export type SearchMode='lexical'|'dense'|'hybrid';
export type RetrievalRequest={ query:string;requestedMode:SearchMode;limit:number;
  scope?:string[];predicates?:Predicate[] };
export type RetrievalLeg={status:'ready'|'unavailable'|'failed'|'not-ready';error:string|null;
  candidateCount:number};
export type AdvancedEvidenceHit={
  sourceId:string;vaultRelativeReference:string;sourceSha256:string;
  originalExcerpt:string;sourceLocators:IngestLocator[];rank:number;
  retrievalMode:SearchMode;lexicalRank:number|null;lexicalScore:number|null;
  denseRank:number|null;denseSimilarity:number|null;rrfScore:number|null;
  indexGenerationId:string;chunkId:string;sourceStatus:'ok'|'partial';diagnostics:string[];
};
export type RetrievalResponse={
  protocolVersion:4;status:'ok'|'degraded'|'failed';requestedMode:SearchMode;
  executedMode:SearchMode|'none';error:string|null;indexGenerationId:string|null;
  hits:AdvancedEvidenceHit[];legs:{lexical:RetrievalLeg;dense:RetrievalLeg};
  staleSourceCount:number;
};
export type RetrievalDocument={response:IngestResponse};
const cmp=(a:string,b:string):number=>a<b?-1:a>b?1:0;
const TOP_LIMIT=50;
export const RRF_K=60;
type Candidate={source:IngestSource;chunk:IngestChunk;key:string;vector:number[]|null;lexText:string};
const fail=(mode:SearchMode,error:string,lex:RetrievalLeg,dense:RetrievalLeg):RetrievalResponse=>({
  protocolVersion:4,status:'failed',requestedMode:mode,executedMode:'none',error,
  indexGenerationId:null,hits:[],legs:{lexical:lex,dense},staleSourceCount:0,
});
const leg=(status:RetrievalLeg['status']='unavailable',error:string|null=null,
  candidateCount=0):RetrievalLeg=>({status,error,candidateCount});
export function validateAdvancedQuery(v:unknown):asserts v is RetrievalRequest {
  if(!v||typeof v!=='object'||Array.isArray(v))throw new ModelError('QUERY_INVALID');
  const q=v as RetrievalRequest;
  if(Object.keys(q).some(x=>!['query','requestedMode','limit','scope','predicates'].includes(x))
      ||typeof q.query!=='string'||!q.query.trim()||q.query.includes('\0')
      ||Buffer.byteLength(q.query)>512||!['lexical','dense','hybrid'].includes(q.requestedMode)
      ||!Number.isSafeInteger(q.limit)||q.limit<1||q.limit>TOP_LIMIT
      ||q.scope!==undefined&&(!Array.isArray(q.scope)||q.scope.length>32
        ||q.scope.some(s=>typeof s!=='string'||s.length>1024||s.startsWith('/')||s.includes('..')))
      ||q.predicates!==undefined&&(!Array.isArray(q.predicates)||q.predicates.length>32
        ||q.predicates.some(p=>!validProperty(p,true))))
    throw new ModelError('QUERY_INVALID');
}
/** Exact same rank fusion semantics as the 03B reference: k=60, key-order ties. */
export function rrf(lexical:readonly string[],dense:readonly string[],k=RRF_K):
  Array<{key:string;lexicalRank:number|null;denseRank:number|null;score:number}>{
  if(!Number.isSafeInteger(k)||k<1||new Set(lexical).size!==lexical.length
     ||new Set(dense).size!==dense.length)throw new ModelError('FUSION_INVALID');
  const lr=new Map(lexical.map((id,i)=>[id,i+1]));
  const dr=new Map(dense.map((id,i)=>[id,i+1]));
  return [...new Set([...lexical,...dense])].map(key=>{
    const lexicalRank=lr.get(key)??null,denseRank=dr.get(key)??null;
    return {key,lexicalRank,denseRank,score:
      (lexicalRank===null?0:1/(k+lexicalRank))+(denseRank===null?0:1/(k+denseRank))};
  }).sort((a,b)=>b.score-a.score||cmp(a.key,b.key));
}
const sourceExcerpt=(candidate:Candidate,query=''):{text:string;locator:IngestLocator;diagnostics:string[]}|null=>{
  const {chunk,source}=candidate;
  const options:{text:string;locator:IngestLocator;diagnostics:string[]}[]=[];
  for(let index=0;index<chunk.sourceSlices.length;index++){
    const slice=chunk.sourceSlices[index]!,block=source.blocks[slice.blockOrder];
    const loc=chunk.sourceLocators[index];
    if(!block||!loc||loc.sourceVersion!==source.sha256)continue;
    // Table serialization is a generated representation; only original native
    // cells with their real native anchors may be shown as evidence.
    if(block.textNature==='table-cell-serialization'){
      for(const cell of block.cells){
        if(cell.originalText&&cell.locator.locatorKind==='native'
            &&cell.locator.nativeItemRef&&!cell.locator.diagnostics.includes('native-text-not-verbatim'))
          options.push({text:cell.originalText,locator:cell.locator,
            diagnostics:['table-cell-native-evidence']});
      }
      continue;
    }
    if(loc.locatorKind==='unavailable'||loc.diagnostics.includes('native-subspan-unverified')
        ||loc.diagnostics.includes('native-text-not-verbatim'))continue;
    const text=Array.from(block.originalText).slice(slice.charStart,slice.charEnd).join('');
    if(text.trim()&&(loc.locatorKind==='markdown'||loc.locatorKind==='native'))
      options.push({text,locator:loc,diagnostics:[]});
  }
  if(!options.length)return null;
  const queryTerms=terms(query);
  const compound=query.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:[._/-][\p{L}\p{N}]+)+/gu)??[];
  return options.sort((a,b)=>{
    const score=(text:string)=>{
      const candidateTerms=terms(text);
      return queryTerms.filter(term=>candidateTerms.includes(term)).length
        +8*compound.filter(term=>candidateTerms.includes(term)).length;
    };
    return score(b.text)-score(a.text);
  })[0]!;
};
const lexicalScore=(candidate:Candidate,queryTerms:string[],mandatory:string[]):number|null=>{
  const docTerms=terms(candidate.lexText);
  if(mandatory.some(id=>!docTerms.includes(id)))return null;
  const common=queryTerms.filter(t=>docTerms.includes(t));
  if(!common.length)return null;
  return common.reduce((n,t)=>n+(/[._/-]/.test(t)?8:2),0)+common.length/queryTerms.length;
};
export type RankedOptions={documents:RetrievalDocument[];generation:RetrievalGeneration|null;
  queryVector:number[]|null;request:RetrievalRequest;staleCount?:number};
export function rankAdvanced(input:RankedOptions):RetrievalResponse{
  const {documents,generation,queryVector,request}=input;
  validateAdvancedQuery(request);
  const mode=request.requestedMode;
  const wantsDense=mode!=='lexical',wantsLex=mode!=='dense';
  const lexLeg=leg(wantsLex?'ready':'unavailable');
  const denseLeg=leg(wantsDense?'not-ready':'unavailable');
  if(wantsDense&&(!generation||!queryVector))return fail(mode,'CAPABILITY_UNAVAILABLE',lexLeg,denseLeg);
  if(queryVector)verifyVector(queryVector);
  const scope=request.scope?new Set(request.scope):null;
  const records:Candidate[]=[];
  const indexed=new Map(generation?.entries.map(e=>[e.sourcePath,e])??[]);
  const seenSource=new Set<string>(),seenChunk=new Set<string>();
  for(const document of documents){
    const source=document.response.source;
    if(!source||!['ok','partial'].includes(document.response.status))continue;
    if(seenSource.has(source.sourceId))return fail(mode,'INDEX_DUPLICATE',lexLeg,denseLeg);
    seenSource.add(source.sourceId);
    if(scope&&!scope.has(source.vaultRelativePath))continue;
    if(!matches(source.properties as Parameters<typeof matches>[0],request.predicates??[]))continue;
    const stored=indexed.get(source.vaultRelativePath);
    if(wantsDense&&(!stored||stored.sourceSha256!==source.sha256
        ||stored.ingestGenerationId!==document.response.generationId
        ||stored.profileId!==source.profileId
        ||stored.chunkIds.length!==document.response.chunks.length))
      return fail(mode,'INDEX_INCOMPATIBLE',lexLeg,denseLeg);
    for(const [i,chunk] of document.response.chunks.entries()){
      if(chunk.sourceId!==source.sourceId||chunk.sourceSha256!==source.sha256
          ||seenChunk.has(chunk.chunkId))return fail(mode,'INDEX_INCOMPATIBLE',lexLeg,denseLeg);
      seenChunk.add(chunk.chunkId);
      if(wantsDense&&stored!.chunkIds[i]!==chunk.chunkId)
        return fail(mode,'INDEX_INCOMPATIBLE',lexLeg,denseLeg);
      const blocks=chunk.sourceSlices.map(s=>source.blocks[s.blockOrder]).filter(x=>x!==undefined);
      const lexText=blocks.map(b=>b.textNature==='table-cell-serialization'
        ?b.cells.map(c=>c.originalText).join(' '):b.originalText).join(' ')
        +' '+blocks.map(b=>b.headings.join(' ')).join(' ');
      const candidate:Candidate={source,chunk,key:chunk.chunkId,
        vector:wantsDense?stored!.vectors[i]!:null,lexText};
      if(sourceExcerpt(candidate))records.push(candidate);
    }
  }
  if(wantsDense){
    if(records.length===0||!generation||generation.entries.length!==documents.length
        ||generation.entries.some(e=>!seenSource.has(e.sourcePath)))
      return fail(mode,'INDEX_INCOMPATIBLE',lexLeg,denseLeg);
    for(const record of records)if(!record.vector)return fail(mode,'INDEX_INCOMPATIBLE',lexLeg,denseLeg);
  }
  if(records.length>256)return fail(mode,'INDEX_LIMIT',lexLeg,denseLeg);
  let lexical:{key:string;score:number}[]=[];
  if(wantsLex){
    try{
      const queryTerms=terms(request.query), mandatory=request.query.toLowerCase()
        .match(/[\p{L}\p{N}]+(?:[._/-][\p{L}\p{N}]+)+/gu)??[];
      lexical=records.flatMap(r=>{
        const score=lexicalScore(r,queryTerms,mandatory);
        return score===null?[]:[{key:r.key,score}];
      }).sort((a,b)=>b.score-a.score||cmp(a.key,b.key));
      lexLeg.candidateCount=lexical.length;
    }catch{return fail(mode,'LEG_FAILED',leg('failed','LEXICAL_FAILED'),denseLeg);}
  }
  let dense:{key:string;score:number}[]=[];
  if(wantsDense){
    try{
      dense=records.map(r=>{
        const vector=r.vector!;
        verifyVector(vector);
        let sum=0;
        for(let i=0;i<vector.length;i++)sum+=vector[i]!*queryVector![i]!;
        if(!Number.isFinite(sum))throw new ModelError('VECTOR_INVALID');
        return {key:r.key,score:sum};
      }).sort((a,b)=>b.score-a.score||cmp(a.key,b.key));
      denseLeg.status='ready';denseLeg.candidateCount=dense.length;
    }catch{return fail(mode,'LEG_FAILED',lexLeg,leg('failed','DENSE_FAILED'));}
  }
  const lexMap=new Map(lexical.map((v,i)=>[v.key,{rank:i+1,score:v.score}]));
  const denseMap=new Map(dense.map((v,i)=>[v.key,{rank:i+1,score:v.score}]));
  const order=mode==='hybrid'?rrf(lexical.map(x=>x.key),dense.map(x=>x.key))
    :mode==='lexical'?lexical.map((x,i)=>({key:x.key,lexicalRank:i+1,denseRank:null,score:0}))
    :dense.map((x,i)=>({key:x.key,lexicalRank:null,denseRank:i+1,score:0}));
  const byKey=new Map(records.map(x=>[x.key,x]));
  const genId=(wantsDense?generation?.generationId:null)??sha(canonical({schemaVersion:1,mode:'lexical',sources:
    documents.map(d=>[d.response.source?.sourceId,d.response.source?.sha256,d.response.generationId]).sort()}));
  const hits:AdvancedEvidenceHit[]=[];
  for(const item of order){
    if(hits.length===request.limit)break;
    const candidate=byKey.get(item.key);
    if(!candidate)continue;
    const original=sourceExcerpt(candidate,request.query);
    if(!original)continue;
    hits.push({sourceId:candidate.source.sourceId,
      vaultRelativeReference:candidate.source.vaultRelativePath,sourceSha256:candidate.source.sha256,
      originalExcerpt:original.text,sourceLocators:[original.locator],rank:hits.length+1,
      retrievalMode:mode,lexicalRank:lexMap.get(item.key)?.rank??null,
      lexicalScore:lexMap.get(item.key)?.score??null,denseRank:denseMap.get(item.key)?.rank??null,
      denseSimilarity:denseMap.get(item.key)?.score??null,rrfScore:mode==='hybrid'?item.score:null,
      indexGenerationId:genId,chunkId:item.key,
      sourceStatus:candidate.source.extractionStatus as 'ok'|'partial',
      diagnostics:original.diagnostics});
  }
  return {protocolVersion:4,status:input.staleCount?'degraded':'ok',requestedMode:mode,
    executedMode:mode,error:null,indexGenerationId:genId,hits,
    legs:{lexical:lexLeg,dense:denseLeg},staleSourceCount:input.staleCount??0};
}
