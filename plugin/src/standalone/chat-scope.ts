import { BOUNDS, PROTOCOL, StandaloneError, isDigest, isRecord, matches, validPath, validRange, validateRequest,
  type OriginalRange, type Predicate, type SearchMetadata, type SearchRequest, type SourceVersion } from './contracts';
import { metadataAnchor } from './metadata';

export type ScopeSource = {sourceId:string;sourceSha256:string};
export type ScopeSelector =
  | {mode:'vault-wide'}
  | {mode:'selected';kind:'active-note';sourceId:string}
  | {mode:'selected';kind:'editor-selection';range:OriginalRange}
  | {mode:'selected';kind:'files';sourceIds:string[]}
  | {mode:'selected';kind:'folder';path:string}
  | {mode:'selected';kind:'applied-results';sources:ScopeSource[]}
  | {mode:'selected';kind:'properties';predicates:Predicate[];metadata?:SearchMetadata};
export type ScopeCoverage = {eligible:number;excluded:number;partial:number;unsupported:'unknown'};
export type ScopeSnapshot = {
  selector:ScopeSelector;rootId:string;generationId:string;sources:ScopeSource[];coverage:ScopeCoverage;
};
export type ScopedSearch = Pick<SearchRequest,'requestId'|'query'|'limit'|'matchMode'>;
const invalid = ():never => {throw new StandaloneError('SCOPE_INVALID');};
const keys = (obj:Record<string,unknown>, allowed:string[]):boolean => Object.keys(obj).every(k=>allowed.includes(k));
function sourceRef(value:unknown):value is ScopeSource {
  return isRecord(value) && keys(value,['sourceId','sourceSha256'])
    && validPath(value.sourceId) && isDigest(value.sourceSha256);
}
/** Strict host-side selector parsing. No selector is a disclosure grant. */
export function parseScopeSelector(input:unknown):ScopeSelector {
  if (!isRecord(input)) return invalid();
  if (input.mode==='vault-wide' && keys(input,['mode'])) return {mode:'vault-wide'};
  if (input.mode!=='selected') return invalid();
  const base=['mode','kind'];
  switch(input.kind){
    case 'active-note':
      if(keys(input,[...base,'sourceId'])&&validPath(input.sourceId))return {mode:'selected',kind:input.kind,sourceId:input.sourceId};
      break;
    case 'editor-selection':
      if(keys(input,[...base,'range'])&&validRange(input.range))return structuredClone(input) as ScopeSelector;
      break;
    case 'files':
      if(keys(input,[...base,'sourceIds'])&&Array.isArray(input.sourceIds)&&input.sourceIds.length<=BOUNDS.sources
        &&Array.from(input.sourceIds).every(validPath)&&new Set(input.sourceIds).size===input.sourceIds.length)
        return {mode:'selected',kind:input.kind,sourceIds:[...input.sourceIds]};
      break;
    case 'folder':
      if(keys(input,[...base,'path'])&&typeof input.path==='string'&&validPath(input.path+'/x.md'))
        return {mode:'selected',kind:input.kind,path:input.path};
      break;
    case 'applied-results':
      if(keys(input,[...base,'sources'])&&Array.isArray(input.sources)&&input.sources.length<=BOUNDS.sources
        &&Array.from(input.sources).every(sourceRef)&&new Set(input.sources.map(s=>s.sourceId)).size===input.sources.length)
        return {mode:'selected',kind:input.kind,sources:structuredClone(input.sources)};
      break;
    case 'properties': {
      if(!keys(input,[...base,'predicates','metadata'])||!Array.isArray(input.predicates)
        ||(!input.predicates.length&&input.metadata===undefined)) break;
      try{
        validateRequest({protocolVersion:PROTOCOL,requestId:'scope',query:'scope',requestedMode:'lexical',limit:1,
          predicates:input.predicates,metadata:input.metadata});
        if(Array.from(input.predicates).some(p=>!isRecord(p)||!keys(p,['key','valueType','value','operator'])
          ||typeof p.valueType!=='string'||typeof p.operator!=='string'
          ||(Array.isArray(p.value)&&Array.from(p.value).some(v=>v===undefined)))
          ||Buffer.byteLength(JSON.stringify([input.predicates,input.metadata]))>16384)return invalid();
        return structuredClone(input) as ScopeSelector;
      }catch{return invalid();}
    }
  }
  return invalid();
}
const eligible = (doc:SourceVersion):boolean => doc.extractionStatus==='ok'||doc.extractionStatus==='partial';
/** Resolve against the single canonical parsed generation, not filesystem guesses. */
export function resolveScope(selector:ScopeSelector, docs:readonly SourceVersion[]):{sources:ScopeSource[];coverage:ScopeCoverage} {
  let selected:readonly SourceVersion[]=docs;
  let explicit:ScopeSource[]|null=null;
  if(selector.mode==='selected'){
    switch(selector.kind){
      case 'active-note': selected=docs.filter(d=>d.sourceId===selector.sourceId);if(!selected.length)throw new StandaloneError('SCOPE_CHANGED');break;
      case 'editor-selection': explicit=[selector.range];break;
      case 'files': {
        const ids=new Set(selector.sourceIds);
        selected=docs.filter(d=>ids.has(d.sourceId));
        if(selected.length!==ids.size)throw new StandaloneError('SCOPE_CHANGED');
        break;
      }
      case 'folder': selected=docs.filter(d=>d.sourceId.startsWith(selector.path+'/'));break;
      case 'applied-results': explicit=selector.sources;break;
      case 'properties': selected=docs.filter(d=>matches(d.properties,selector.predicates)
        &&(!selector.metadata||metadataAnchor(d,selector.metadata,selector.predicates)!==null));break;
    }
    if(explicit){
      const versions=new Map(explicit.map(s=>[s.sourceId,s.sourceSha256]));
      selected=docs.filter(d=>versions.get(d.sourceId)===d.sha256);
      if(selected.length!==versions.size)throw new StandaloneError('SCOPE_CHANGED');
    }
    if(['active-note','editor-selection','files','applied-results'].includes(selector.kind)
      &&selected.some(d=>!eligible(d)))throw new StandaloneError('SCOPE_UNSUPPORTED');
  }
  const allowed=selected.filter(eligible);
  if(!allowed.length)throw new StandaloneError('SCOPE_EMPTY');
  return {sources:allowed.map(d=>({sourceId:d.sourceId,sourceSha256:d.sha256})),
    coverage:{eligible:allowed.length,excluded:selected.length-allowed.length,
      partial:allowed.filter(d=>d.extractionStatus==='partial').length,unsupported:'unknown'}};
}
/** The selector is bounded and structured; freeze all nested snapshot records. */
export function freezeScope<T>(value:T):T {
  if(value!==null&&typeof value==='object'){
    for(const child of Object.values(value))freezeScope(child);
    Object.freeze(value);
  }
  return value;
}
