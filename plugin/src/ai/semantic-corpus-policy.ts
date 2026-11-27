import { BOUNDS, hash, isDigest, isRecord, matches, validPath, validProperty, type Predicate, type TypedProperty } from '../standalone/contracts';
import type { PolicyMetadataProof } from '../standalone/shared';
import type { StandaloneEngine } from '../standalone/engine';

/** Local policy resolution only; never a source, scope, provider or disclosure grant. */
export const CORPUS_POLICY_VERSION='oks-corpus-policy-v1';
export type CorpusMode='full'|'note_only'|'attachments_only'|'none';
type When=Readonly<{
  folderSegments?:readonly string[];noteType?:string;tags?:readonly string[];
  fileTypes?:readonly string[];purpose?:string;collection?:string;properties?:readonly Predicate[];
}>;
export type CorpusConfig=Readonly<{version:typeof CORPUS_POLICY_VERSION;defaultMode:CorpusMode;
  exclusions:readonly Readonly<{id:string;when:When}>[]}>;
type Original=Readonly<{sourceId:string;sha256:string;rootId:string}>;
export type CorpusReason='default'|'property'|'hard-exclusion'|'invalid-config'|'source-mismatch'
  |'metadata-unresolved'|'invalid-property'|'rule-input-unresolved'|'source-unavailable';
export type CorpusNoteDecision=Readonly<{
  ruleRevision:string|null;sourceBinding:string|null;requestedMode:CorpusMode|null;effectiveMode:CorpusMode;
  noteEligible:boolean;attachmentIntent:boolean;attachmentEligible:false;
  attachmentReason:'excluded'|'ownership-unavailable';reason:CorpusReason;
  matchedRuleIds:readonly string[];complete:boolean;
}>;
const modes:readonly CorpusMode[]=['full','note_only','attachments_only','none'];
const mode=(v:unknown):v is CorpusMode=>typeof v==='string'&&modes.includes(v as CorpusMode);
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>isRecord(v)
  &&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const boundedString=(v:unknown,max=256):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&Buffer.byteLength(v)<=max
  &&Buffer.from(v,'utf8').toString('utf8')===v&&!/[\0\r\n]/.test(v);
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&v.length<=BOUNDS.predicates
  &&[...v].every(x=>boundedString(x))&&new Set(v).size===v.length;
/** Bound each scalar before encoding and the cumulative collection before copying. */
function scalarSize(v:unknown,remaining:number):number{
  if(typeof v==='string'){
    if(v.length>remaining||Buffer.byteLength(v)>remaining||Buffer.from(v,'utf8').toString('utf8')!==v||v.includes('\0'))return -1;
  }else if(v!==null&&typeof v!=='boolean'&&!(typeof v==='number'&&Number.isFinite(v)&&!Object.is(v,-0)))return -1;
  return Buffer.byteLength(JSON.stringify(v));
}
function typedSize(v:unknown,predicate:boolean,remaining:number):number{
  if(remaining<0||!exact(v,predicate?['key','valueType','value','operator']:['key','valueType','value'])
    ||!validProperty(v,predicate)||!boundedString(v.key,BOUNDS.propertyBytes))return -1;
  let size=Buffer.byteLength(JSON.stringify(v.key))+64;
  const values=Array.isArray(v.value)?v.value:[v.value];
  if(values.length>BOUNDS.listItems)return -1;
  for(const item of values){
    const n=scalarSize(item,remaining-size);
    if(n<0)return -1;
    size+=n+1;
    if(size>remaining)return -1;
  }
  return size<=remaining?size:-1;
}
function boundedTyped(values:unknown,predicate:boolean,maxCount:number,maxBytes:number):boolean{
  if(!Array.isArray(values)||values.length>maxCount)return false;
  let remaining=maxBytes;
  for(const value of values){
    const size=typedSize(value,predicate,remaining);
    if(size<0)return false;
    remaining-=size;
  }
  return true;
}
const copyPredicate=(p:Predicate):Predicate=>({key:p.key,valueType:p.valueType,operator:p.operator,
  value:Array.isArray(p.value)?[...p.value]:p.value});
function captureConfig(input:unknown):CorpusConfig|null{
  if(!exact(input,['version','defaultMode','exclusions'])||input.version!==CORPUS_POLICY_VERSION
    ||!mode(input.defaultMode)||!Array.isArray(input.exclusions)||input.exclusions.length>BOUNDS.predicates)return null;
  const exclusions: {id:string;when:When}[]=[],ids=new Set<string>();
  let bytes=128;
  for(const entry of input.exclusions){
    if(!exact(entry,['id','when'])||!boundedString(entry.id)||ids.has(entry.id)||!isRecord(entry.when))return null;
    const w=entry.when,keys=Object.keys(w);
    if(!keys.length||keys.some(k=>!['folderSegments','noteType','tags','fileTypes','purpose','collection','properties'].includes(k)))return null;
    for(const key of ['folderSegments','tags','fileTypes'] as const)if(Object.hasOwn(w,key)&&!strings(w[key]))return null;
    for(const key of ['noteType','purpose','collection'] as const)if(Object.hasOwn(w,key)&&!boundedString(w[key]))return null;
    const folders=w.folderSegments as string[]|undefined,types=w.fileTypes as string[]|undefined;
    if(folders?.some(x=>/[\\/:]/.test(x)||x.startsWith('.'))||types?.some(x=>!/^[a-z0-9]+$/.test(x)))return null;
    if(Object.hasOwn(w,'properties')&&(!Array.isArray(w.properties)||w.properties.length<1
      ||!boundedTyped(w.properties,true,BOUNDS.predicates,32768-bytes)))return null;
    const when:When={...(folders?{folderSegments:[...folders]}:{}),
      ...(typeof w.noteType==='string'?{noteType:w.noteType}:{}),...(w.tags?{tags:[...w.tags as string[]]}:{}),
      ...(types?{fileTypes:[...types]}:{}),...(typeof w.purpose==='string'?{purpose:w.purpose}:{}),
      ...(typeof w.collection==='string'?{collection:w.collection}:{}),
      ...(w.properties?{properties:(w.properties as Predicate[]).map(copyPredicate)}:{})};
    bytes+=Buffer.byteLength(JSON.stringify([entry.id,when]));
    if(bytes>32768)return null;
    ids.add(entry.id);exclusions.push({id:entry.id,when});
  }
  return {version:CORPUS_POLICY_VERSION,defaultMode:input.defaultMode,exclusions};
}
export function defaultCorpusConfig():CorpusConfig{return {version:CORPUS_POLICY_VERSION,defaultMode:'note_only',exclusions:[]};}
const original=(v:unknown):v is Original=>exact(v,['sourceId','sha256','rootId'])
  &&validPath(v.sourceId)&&isDigest(v.sha256)&&isDigest(v.rootId);
function decision(revision:string|null,reason:CorpusReason,requested:CorpusMode|null=null,effective:CorpusMode='none',
  complete=false,matched:readonly string[]=[],sourceBinding:string|null=null):CorpusNoteDecision{
  const attachmentIntent=requested==='full'||requested==='attachments_only';
  return Object.freeze({ruleRevision:revision,sourceBinding,requestedMode:requested,effectiveMode:effective,
    noteEligible:complete&&(effective==='full'||effective==='note_only'),attachmentIntent,attachmentEligible:false,
    attachmentReason:effective==='full'||effective==='attachments_only'?'ownership-unavailable':'excluded',
    reason,matchedRuleIds:Object.freeze([...matched]),complete});
}
type Match='yes'|'no'|'unknown';
function ruleMatch(when:When,path:string,properties:TypedProperty[]):Match{
  const results:Match[]=[];
  if(when.folderSegments)results.push(when.folderSegments.every(x=>path.split('/').slice(0,-1).includes(x))?'yes':'no');
  if(when.fileTypes)results.push(when.fileTypes.includes(path.slice(path.lastIndexOf('.')+1).toLowerCase())?'yes':'no');
  for(const [key,wanted] of [['type',when.noteType],['purpose',when.purpose],['collection',when.collection]] as const){
    if(wanted===undefined)continue;
    const p=properties.find(x=>x.key===key);
    results.push(!p?'no':p.valueType!=='string'?'unknown':p.value===wanted?'yes':'no');
  }
  if(when.tags){
    const p=properties.find(x=>x.key==='tags');
    results.push(!p?'no':p.valueType!=='list'||!Array.isArray(p.value)||!p.value.every(x=>typeof x==='string')
      ?'unknown':when.tags.every(x=>(p.value as string[]).includes(x))?'yes':'no');
  }
  for(const predicate of when.properties??[])results.push(matches(properties,[predicate])?'yes':'no');
  return results.includes('no')?'no':results.includes('unknown')?'unknown':'yes';
}
function resolve(config:CorpusConfig,expected:Original,proof:unknown):CorpusNoteDecision{
  const revision=hash(JSON.stringify([CORPUS_POLICY_VERSION,config]));
  if(!exact(proof,['sourceId','sha256','scopeId','state','properties'])||proof.sourceId!==expected.sourceId
    ||proof.sha256!==expected.sha256||proof.scopeId!==expected.rootId)return decision(revision,'source-mismatch');
  if(typeof proof.state!=='string'||!['absent','external','private','invalid'].includes(proof.state)
    ||!Array.isArray(proof.properties)||!boundedTyped(proof.properties,false,BOUNDS.propertiesPerSource,BOUNDS.fileBytes*8)
    ||new Set(proof.properties.map(p=>p.key)).size!==proof.properties.length)return decision(revision,'metadata-unresolved');
  const properties=proof.properties as TypedProperty[];
  // A complete canonical proof may carry a valid or invalid processing marker;
  // neither controls corpus mode. Reject contradictory proof metadata.
  const processing=properties.find(x=>x.key==='llm_processing');
  const state=!processing?'absent':processing.valueType==='string'&&processing.value==='external'?'external':
    processing.valueType==='string'&&processing.value==='private'?'private':'invalid';
  if(state!==proof.state)return decision(revision,'metadata-unresolved');
  // Do not turn a case-confusable corpus control into verified absence.
  if(properties.some(p=>p.key!=='ai_indexing'&&p.key.toLowerCase()==='ai_indexing'))return decision(revision,'metadata-unresolved');
  const marker=properties.find(x=>x.key==='ai_indexing');
  if(marker&&(marker.valueType!=='string'||!mode(marker.value)))return decision(revision,'invalid-property');
  const requested=marker?marker.value as CorpusMode:config.defaultMode;
  const sourceBinding=hash(JSON.stringify([CORPUS_POLICY_VERSION,'original',expected.rootId,expected.sourceId,expected.sha256]));
  const evaluations=config.exclusions.map(r=>({id:r.id,result:ruleMatch(r.when,expected.sourceId,properties)}));
  const excluded=evaluations.filter(x=>x.result==='yes').map(x=>x.id);
  if(excluded.length)return decision(revision,'hard-exclusion',requested,'none',true,excluded,sourceBinding);
  if(evaluations.some(x=>x.result==='unknown'))return decision(revision,'rule-input-unresolved',requested,'none',false,[],sourceBinding);
  return decision(revision,marker?'property':'default',requested,requested,true,[],sourceBinding);
}
/** Only the trusted host supplies a current canonical metadata proof. */
export function resolveCorpusNote(config:unknown,expected:unknown,proof:PolicyMetadataProof):CorpusNoteDecision{
  try{
    const captured=captureConfig(config);
    if(!captured)return decision(null,'invalid-config');
    if(!original(expected))return decision(null,'source-mismatch');
    return resolve(captured,expected,proof);
  }catch{return decision(null,'metadata-unresolved');}
}
/** Read-only point-in-time local preview using the existing canonical worker and
 * physical slot. Never persist or reuse this result as authorization. */
export async function previewCorpusNote(engine:Pick<StandaloneEngine,'previewPolicyMetadata'>,config:unknown,
  expected:unknown,current:()=>boolean):Promise<CorpusNoteDecision>{
  try{
    const captured=captureConfig(config);
    if(!captured)return decision(null,'invalid-config');
    if(!original(expected))return decision(null,'source-mismatch');
    const source={sourceId:expected.sourceId,sha256:expected.sha256,rootId:expected.rootId};
    const revision=hash(JSON.stringify([CORPUS_POLICY_VERSION,captured]));
    if(!current())return decision(revision,'source-unavailable');
    const proof=await engine.previewPolicyMetadata(source.sourceId,current);
    if(!current())return decision(revision,'source-unavailable');
    return resolve(captured,source,proof);
  }catch{return decision(null,'source-unavailable');}
}
