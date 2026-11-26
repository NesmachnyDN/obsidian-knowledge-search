import { BOUNDS, hash, StandaloneError, type SearchResponse } from '../standalone/contracts';
import { freezeScope, parseScopeSelector, type ScopeSelector } from '../standalone/chat-scope';
import { mapEditorRange, type EditorPosition } from '../standalone/selection-range';
import { propertyInput } from './controller';

export function manualChatScope(kind:string, value:string, propertyType:string, operator:string,
  propertyValue:string, tag:string, linkTarget:string):ScopeSelector {
  if(kind==='vault-wide')return {mode:'vault-wide'};
  if(kind==='files')return parseScopeSelector({mode:'selected',kind,sourceIds:value.split(/\r?\n/).filter(v=>v.length>0)});
  if(kind==='folder')return parseScopeSelector({mode:'selected',kind,path:value});
  if(kind==='properties') {
    const predicates=value.trim()?[propertyInput(value.trim(),propertyType,operator,propertyValue)]:[];
    const metadata={...(tag.trim()?{tag:tag.trim()}:{}),...(linkTarget.trim()?{linkTarget:linkTarget.trim()}: {})};
    return parseScopeSelector({mode:'selected',kind,predicates,...(Object.keys(metadata).length?{metadata}:{})});
  }
  throw new StandaloneError('SCOPE_INVALID');
}
export function appliedChatScope(response:SearchResponse|null, generationId:string|null):ScopeSelector {
  if(!response||response.status!=='ok'||response.executedMode!=='lexical'||!generationId
    ||response.indexGenerationId!==generationId||response.staleSourceCount!==0||!response.hits.length)
    throw new StandaloneError('SCOPE_CHANGED');
  const versions=new Map<string,string>();
  for(const hit of response.hits) {
    if(hit.indexGenerationId!==generationId||versions.has(hit.sourceId)&&versions.get(hit.sourceId)!==hit.sourceSha256)
      throw new StandaloneError('SCOPE_CHANGED');
    versions.set(hit.sourceId,hit.sourceSha256);
  }
  return freezeScope(parseScopeSelector({mode:'selected',kind:'applied-results',
    sources:[...versions].map(([sourceId,sourceSha256])=>({sourceId,sourceSha256}))}));
}
/** The host pins editor/file identity around the read. This pure boundary rejects
 * an unsaved or unrepresentable buffer and never carries buffer text into the scope. */
export function editorChatScope(kind:'active-note'|'editor-selection',sourceId:string,editorText:string,
  raw:Uint8Array,selection?:{anchor:EditorPosition;head:EditorPosition}):ScopeSelector {
  if(raw.byteLength>BOUNDS.fileBytes||Buffer.byteLength(editorText)>BOUNDS.fileBytes)throw new StandaloneError('SOURCE_LIMIT');
  let original:string;
  try {original=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);}
  catch {throw new StandaloneError('INVALID_UTF8');}
  if(original.startsWith('\ufeff')||original.includes('\0'))throw new StandaloneError('INVALID_UTF8');
  const normalize=(text:string)=>text.replace(/\r\n|\r/g,'\n');
  if(normalize(original)!==normalize(editorText))throw new StandaloneError('SOURCE_STALE');
  if(kind==='active-note')return freezeScope(parseScopeSelector({mode:'selected',kind,sourceId}));
  if(!selection)throw new StandaloneError('SCOPE_INVALID');
  return freezeScope(parseScopeSelector({mode:'selected',kind,range:mapEditorRange({
    sourceId,sourceSha256:hash(raw),editorText,...selection},raw)}));
}
