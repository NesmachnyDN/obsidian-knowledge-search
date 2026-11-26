import { BOUNDS, hash, isDigest, validPath, validProperty, matches as matchesProperties, type Predicate, type TypedProperty } from '../standalone/contracts';
import type { PolicyMetadataProof, PolicyRuleProperty } from '../standalone/shared';

/** POLICY.2a local dry-run substrate. It does not write a note or authorize processing. */
export const NEW_MATERIAL_POLICY_VERSION='oks-policy-2a';
export const NEW_MATERIAL_RULE_CONFIG_VERSION='oks-policy-2a-rules-v1';
export type MarkAction='leave-absent'|'set-external'|'set-private';
export type NewMaterialReason='existing-material'|'explicit-private'|'already-marked'|'metadata-unresolved'
  |'lifecycle-unresolved'|'source-mismatch'|'provenance-unresolved'|'required-input-unresolved'
  |'default'|'rule'|'invalid-config';
export type RuleWhen=Readonly<{folderSegments?:readonly string[];importChannel?:string;type?:string;template?:string;
  tags?:readonly string[];properties?:readonly Predicate[]}>;
export type NewMaterialRule=Readonly<{id:string;action:'set-external'|'set-private';when:RuleWhen}>;
export type NewMaterialRuleConfig=Readonly<{version:typeof NEW_MATERIAL_RULE_CONFIG_VERSION;
  defaultAction:MarkAction;rules:readonly NewMaterialRule[]}>;
/** This is supplied by a trusted import adapter. A frontmatter property is never provenance. */
export type TrustedImportProvenance=Readonly<{channelId:string;digest:string;sourceId:string;sha256:string;rootId:string}>;
export type MaterialLifecycle=Readonly<{state:'existing'|'verified-new';sourceId:string;sha256:string;rootId:string}>;
export type NewMaterialPolicyInput=Readonly<{sourceId:string;sha256:string;rootId:string;proof:PolicyMetadataProof;
  lifecycle:MaterialLifecycle;provenance:TrustedImportProvenance|null}>;
export type NewMaterialDecision=Readonly<{policyVersion:typeof NEW_MATERIAL_POLICY_VERSION;ruleRevision:string|null;
  action:MarkAction;reason:NewMaterialReason;matchedRuleId:string|null;sourceId:string;sha256:string;rootId:string;
  provenanceDigest:string|null;complete:boolean;externalBlocked:boolean}>;

const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=256
  &&Buffer.from(value,'utf8').toString('utf8')===value&&!/[\0\r\n]/.test(value);
const exact=(value:object,keys:readonly string[]):boolean=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const frozen=<T>(value:T):T=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value as Record<string,unknown>))frozen(child);Object.freeze(value);}return value;};
const propertyValueBound=(v:unknown):boolean=>Array.isArray(v)?v.length<=BOUNDS.listItems&&v.every(x=>!Array.isArray(x)&&propertyValueBound(x)):
  typeof v==='string'?Buffer.byteLength(v)<=4096&&Buffer.from(v,'utf8').toString('utf8')===v&&!v.includes('\0'):v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)&&!Object.is(v,-0);
const propertyShape=(p:unknown,predicate=false):boolean=>!!p&&typeof p==='object'&&!Array.isArray(p)&&
  exact(p,predicate?['key','valueType','value','operator']:['key','valueType','value'])&&validProperty(p,predicate)&&
  identifier(p.key)&&propertyValueBound(p.value);
function validProperties(properties:unknown):properties is readonly PolicyRuleProperty[]{
  return Array.isArray(properties)&&properties.length<=BOUNDS.propertiesPerSource&&properties.every(property=>propertyShape(property))
    &&new Set(properties.map(property=>property.key)).size===properties.length;
}
function validWhen(value:unknown):value is RuleWhen{
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length
    ||Object.keys(value).some(key=>!['folderSegments','importChannel','type','template','tags','properties'].includes(key)))return false;
  const when=value as RuleWhen;
  const strings=(items:unknown)=>Array.isArray(items)&&items.length>0&&items.length<=BOUNDS.predicates
    &&items.every(identifier)&&new Set(items).size===items.length;
  return (when.folderSegments===undefined||strings(when.folderSegments)&&when.folderSegments.every(x=>!/[\\/:]/.test(x)&&!x.startsWith('.')))&&(when.importChannel===undefined||identifier(when.importChannel))
    &&(when.type===undefined||identifier(when.type))&&(when.template===undefined||identifier(when.template))
    &&(when.tags===undefined||strings(when.tags))&&(when.properties===undefined||Array.isArray(when.properties)
      &&when.properties.length>0&&when.properties.length<=BOUNDS.predicates&&when.properties.every(predicate=>propertyShape(predicate,true)));
}
export function validNewMaterialRuleConfig(config:unknown):config is NewMaterialRuleConfig{
  if(!config||typeof config!=='object'||Array.isArray(config)||!exact(config,['version','defaultAction','rules']))return false;
  const candidate=config as NewMaterialRuleConfig;
  return candidate.version===NEW_MATERIAL_RULE_CONFIG_VERSION&&['leave-absent','set-external','set-private'].includes(candidate.defaultAction)
    &&Array.isArray(candidate.rules)&&candidate.rules.length<=BOUNDS.predicates&&candidate.rules.every(rule=>!!rule&&typeof rule==='object'
      &&exact(rule,['id','action','when'])&&identifier(rule.id)&&['set-external','set-private'].includes(rule.action)&&validWhen(rule.when))
    &&new Set(candidate.rules.map(rule=>rule.id)).size===candidate.rules.length;
}
function ruleRevision(config:NewMaterialRuleConfig):string{
  return hash(JSON.stringify({version:config.version,defaultAction:config.defaultAction,rules:config.rules.map(rule=>({id:rule.id,action:rule.action,when:{
    folderSegments:rule.when.folderSegments?[...rule.when.folderSegments]:undefined,importChannel:rule.when.importChannel,
    type:rule.when.type,template:rule.when.template,tags:rule.when.tags?[...rule.when.tags]:undefined,
    properties:rule.when.properties?.map(predicate=>({key:predicate.key,valueType:predicate.valueType,value:predicate.value,operator:predicate.operator})),
  }}))}));
}
function inputValid(input:NewMaterialPolicyInput):boolean{
  if(!input||!input.proof||!validProperties(input.proof.properties))return false;
  const marker=input.proof.properties.find(p=>p.key==='llm_processing');
  const expected=!marker?'absent':marker.valueType==='string'&&marker.value==='external'?'external':
    marker.valueType==='string'&&marker.value==='private'?'private':'invalid';
  if(input.proof.state==='unresolved'?input.proof.properties.length!==0:input.proof.state!==expected)return false;
  return validPath(input.sourceId)&&isDigest(input.sha256)&&isDigest(input.rootId)&&input.proof.sourceId===input.sourceId
    &&input.proof.sha256===input.sha256&&input.proof.scopeId===input.rootId&&['absent','external','private','invalid','unresolved'].includes(input.proof.state)
    &&validProperties(input.proof.properties)&&!!input.lifecycle&&exact(input.lifecycle,['state','sourceId','sha256','rootId'])
    &&['existing','verified-new'].includes(input.lifecycle.state)&&validPath(input.lifecycle.sourceId)&&isDigest(input.lifecycle.sha256)
    &&isDigest(input.lifecycle.rootId)&&(input.provenance===null||!!input.provenance&&exact(input.provenance,['channelId','digest','sourceId','sha256','rootId'])
      &&identifier(input.provenance.channelId)&&isDigest(input.provenance.digest)&&validPath(input.provenance.sourceId)
      &&isDigest(input.provenance.sha256)&&isDigest(input.provenance.rootId));
}
type Match='match'|'no-match'|'unresolved';
function property(properties:readonly PolicyRuleProperty[],key:string):PolicyRuleProperty|undefined{return properties.find(candidate=>candidate.key===key);}
function exactString(properties:readonly PolicyRuleProperty[],key:string,wanted:string):Match{
  const found=property(properties,key);if(!found)return 'unresolved';
  return found.valueType==='string'&&found.value===wanted?'match':'no-match';
}
function predicateMatch(properties:readonly PolicyRuleProperty[],predicate:Predicate):Match{
  const found=property(properties,predicate.key);if(!found)return 'unresolved';
  const typed:TypedProperty={key:found.key,valueType:found.valueType,value:Array.isArray(found.value)?[...found.value]:found.value as TypedProperty['value']};
  return matchesProperties([typed],[predicate])?'match':'no-match';
}
function matches(rule:NewMaterialRule,input:NewMaterialPolicyInput):Match{
  const when=rule.when,properties=input.proof.properties;
  if(when.folderSegments&&!when.folderSegments.every(segment=>input.sourceId.split('/').slice(0,-1).includes(segment)))return 'no-match';
  if(when.importChannel){if(!input.provenance)return 'unresolved';if(input.provenance.channelId!==when.importChannel)return 'no-match';}
  for(const [key,value] of [['type',when.type],['template',when.template]] as const){if(value){const result=exactString(properties,key,value);if(result!=='match')return result;}}
  if(when.tags){const tags=property(properties,'tags');if(!tags)return 'unresolved';const values=tags.value;
    if(tags.valueType!=='list'||!Array.isArray(values)||!when.tags.every(tag=>values.includes(tag)))return 'no-match';}
  for(const predicate of when.properties??[]){const result=predicateMatch(properties,predicate);if(result!=='match')return result;}
  return 'match';
}
/** Deterministic recommendation only. The caller must not treat this as a grant or a write instruction. */
export function decideNewMaterialMarking(config:unknown,input:NewMaterialPolicyInput):NewMaterialDecision{
  const base={policyVersion:NEW_MATERIAL_POLICY_VERSION,sourceId:input?.sourceId,sha256:input?.sha256,rootId:input?.rootId,
    provenanceDigest:input?.provenance?.digest??null} as const;
  const decision=(ruleRevision:string|null,action:MarkAction,reason:NewMaterialReason,matchedRuleId:string|null,complete=false,externalBlocked=true)=>
    frozen({...base,ruleRevision,action,reason,matchedRuleId,complete,externalBlocked});
  try {
    if(!validNewMaterialRuleConfig(config))return decision(null,'leave-absent','invalid-config',null);
    const revision=ruleRevision(config);
    if(!inputValid(input))return decision(revision,'leave-absent','source-mismatch',null);
    if(input.lifecycle.sourceId!==input.sourceId||input.lifecycle.sha256!==input.sha256||input.lifecycle.rootId!==input.rootId)
      return decision(revision,'leave-absent','lifecycle-unresolved',null);
    if(input.provenance&&(input.provenance.sourceId!==input.sourceId||input.provenance.sha256!==input.sha256||input.provenance.rootId!==input.rootId))
      return decision(revision,'leave-absent','provenance-unresolved',null);
    if(input.proof.state==='private')return decision(revision,'leave-absent','explicit-private',null,true);
    if(input.proof.state!=='absent'&&input.proof.state!=='external')return decision(revision,'leave-absent','metadata-unresolved',null);
    if(input.lifecycle.state==='existing')return decision(revision,'leave-absent','existing-material',null,true,false);
    const results=config.rules.map(rule=>({rule,result:matches(rule,input)}));
    const restrictive=results.find(result=>result.result==='match'&&result.rule.action==='set-private');
    if(restrictive)return decision(revision,'set-private','rule',restrictive.rule.id,true);
    if(results.some(result=>result.result==='unresolved'))return decision(revision,'leave-absent','required-input-unresolved',null);
    const permissive=results.find(result=>result.result==='match');
    const action=permissive?'set-external':config.defaultAction;
    if(input.proof.state==='external'&&action!=='set-private')return decision(revision,'leave-absent','already-marked',permissive?.rule.id??null,true,false);
    // A proposed mutation cannot become external eligibility until an authorized
    // writer commits and the host rereads the exact resulting original version.
    return decision(revision,action,permissive?'rule':'default',permissive?.rule.id??null,true,action!=='leave-absent');
  }catch{return decision(null,'leave-absent','invalid-config',null);}
}
