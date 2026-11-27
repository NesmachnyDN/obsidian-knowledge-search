import { BOUNDS, isDigest, validPath, validProperty, matches as matchesProperties, type Predicate, type TypedProperty } from '../standalone/contracts';
import type { PolicyMetadataProof, PolicyRuleProperty } from '../standalone/shared';

/** Shared bounded rule primitives. They are pure and do not establish provenance. */
export type PolicyRuleWhen=Readonly<{folderSegments?:readonly string[];origin?:string;type?:string;template?:string;
  tags?:readonly string[];properties?:readonly Predicate[]}>;
export type RuleMatchInput=Readonly<{sourceId:string;properties:readonly PolicyRuleProperty[];originId?:string}>;
export type RuleMatch='match'|'no-match'|'unresolved';

export const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=256
  &&Buffer.from(value,'utf8').toString('utf8')===value&&!/[\0\r\n]/.test(value);
export const exact=(value:object,keys:readonly string[]):boolean=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const frozen=<T>(value:T):T=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value as Record<string,unknown>))frozen(child);Object.freeze(value);}return value;};
const propertyValueBound=(v:unknown):boolean=>Array.isArray(v)?v.length<=BOUNDS.listItems&&v.every(x=>!Array.isArray(x)&&propertyValueBound(x)):
  typeof v==='string'?Buffer.byteLength(v)<=4096&&Buffer.from(v,'utf8').toString('utf8')===v&&!v.includes('\0'):v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)&&!Object.is(v,-0);
const propertyShape=(p:unknown,predicate=false):boolean=>!!p&&typeof p==='object'&&!Array.isArray(p)&&
  exact(p,predicate?['key','valueType','value','operator']:['key','valueType','value'])&&validProperty(p,predicate)&&identifier(p.key)&&propertyValueBound(p.value);
export function validPolicyProperties(properties:unknown):properties is readonly PolicyRuleProperty[]{
  return Array.isArray(properties)&&properties.length<=BOUNDS.propertiesPerSource&&properties.every(property=>propertyShape(property))
    &&new Set(properties.map(property=>property.key)).size===properties.length;
}
/** Checks proof structure and exact original identity; not a freshness or provenance authority. */
export function validPolicyMetadata(proof:PolicyMetadataProof,sourceId:string,sha256:string,rootId:string,exactShape=false):boolean{
  if(!proof||exactShape&&!exact(proof,['sourceId','sha256','scopeId','state','properties'])||!validPolicyProperties(proof.properties))return false;
  const marker=proof.properties.find(p=>p.key==='llm_processing');
  const expected=!marker?'absent':marker.valueType==='string'&&marker.value==='external'?'external':
    marker.valueType==='string'&&marker.value==='private'?'private':'invalid';
  return validPath(sourceId)&&isDigest(sha256)&&isDigest(rootId)&&proof.sourceId===sourceId&&proof.sha256===sha256&&proof.scopeId===rootId
    &&['absent','external','private','invalid','unresolved'].includes(proof.state)&&(proof.state==='unresolved'?proof.properties.length===0:proof.state===expected);
}
export function validPolicyRuleWhen(value:unknown):value is PolicyRuleWhen{
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length
    ||Object.keys(value).some(key=>!['folderSegments','origin','type','template','tags','properties'].includes(key)))return false;
  const when=value as PolicyRuleWhen;
  const strings=(items:unknown)=>Array.isArray(items)&&items.length>0&&items.length<=BOUNDS.predicates&&items.every(identifier)&&new Set(items).size===items.length;
  return (when.folderSegments===undefined||strings(when.folderSegments)&&when.folderSegments.every(x=>!/[\\/:]/.test(x)&&!x.startsWith('.')))
    &&(when.origin===undefined||identifier(when.origin))&&(when.type===undefined||identifier(when.type))&&(when.template===undefined||identifier(when.template))
    &&(when.tags===undefined||strings(when.tags))&&(when.properties===undefined||Array.isArray(when.properties)
      &&when.properties.length>0&&when.properties.length<=BOUNDS.predicates&&when.properties.every(predicate=>propertyShape(predicate,true)));
}
const property=(properties:readonly PolicyRuleProperty[],key:string):PolicyRuleProperty|undefined=>properties.find(candidate=>candidate.key===key);
const exactString=(properties:readonly PolicyRuleProperty[],key:string,wanted:string):RuleMatch=>{const found=property(properties,key);if(!found)return 'unresolved';return found.valueType==='string'&&found.value===wanted?'match':'no-match';};
const predicateMatch=(properties:readonly PolicyRuleProperty[],predicate:Predicate):RuleMatch=>{const found=property(properties,predicate.key);if(!found)return 'unresolved';const typed:TypedProperty={key:found.key,valueType:found.valueType,value:Array.isArray(found.value)?[...found.value]:found.value as TypedProperty['value']};return matchesProperties([typed],[predicate])?'match':'no-match';};
export function matchPolicyRule(when:PolicyRuleWhen,input:RuleMatchInput):RuleMatch{
  const properties=input.properties;
  if(when.folderSegments&&!when.folderSegments.every(segment=>input.sourceId.split('/').slice(0,-1).includes(segment)))return 'no-match';
  if(when.origin){if(!input.originId)return 'unresolved';if(input.originId!==when.origin)return 'no-match';}
  for(const [key,value] of [['type',when.type],['template',when.template]] as const){if(value){const result=exactString(properties,key,value);if(result!=='match')return result;}}
  if(when.tags){const tags=property(properties,'tags');if(!tags)return 'unresolved';const values=tags.value;if(tags.valueType!=='list'||!Array.isArray(values)||!when.tags.every(tag=>values.includes(tag)))return 'no-match';}
  for(const predicate of when.properties??[]){const result=predicateMatch(properties,predicate);if(result!=='match')return result;}
  return 'match';
}
