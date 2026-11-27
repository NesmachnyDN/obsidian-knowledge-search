import { BOUNDS, hash, isDigest, validPath, type Predicate } from '../standalone/contracts';
import type { PolicyMetadataProof } from '../standalone/shared';
import { exact, frozen, identifier, matchPolicyRule, validPolicyMetadata, validPolicyRuleWhen, type PolicyRuleWhen } from './policy-rules';

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
export type MaterialLifecycle=Readonly<{state:'existing'|'verified-new'|'unresolved';sourceId:string;sha256:string;rootId:string}>;
export type NewMaterialPolicyInput=Readonly<{sourceId:string;sha256:string;rootId:string;proof:PolicyMetadataProof;
  lifecycle:MaterialLifecycle;provenance:TrustedImportProvenance|null}>;
export type NewMaterialDecision=Readonly<{policyVersion:typeof NEW_MATERIAL_POLICY_VERSION;ruleRevision:string|null;
  action:MarkAction;reason:NewMaterialReason;matchedRuleId:string|null;sourceId:string;sha256:string;rootId:string;
  provenanceDigest:string|null;complete:boolean;externalBlocked:boolean}>;

function validWhen(value:unknown):value is RuleWhen{
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length
    ||Object.keys(value).some(key=>!['folderSegments','importChannel','type','template','tags','properties'].includes(key)))return false;
  const {importChannel,...shared}=value as RuleWhen;
  return validPolicyRuleWhen({...shared,...(Object.hasOwn(value,'importChannel')?{origin:importChannel}:{})} as PolicyRuleWhen);
}
export const MAX_RULE_CONFIG_BYTES=32768;
export function defaultMarkingRules():NewMaterialRuleConfig{return {version:NEW_MATERIAL_RULE_CONFIG_VERSION,defaultAction:'leave-absent',rules:[]};}
export function validNewMaterialRuleConfig(config:unknown):config is NewMaterialRuleConfig{
  if(!config||typeof config!=='object'||Array.isArray(config)||!exact(config,['version','defaultAction','rules']))return false;
  const candidate=config as NewMaterialRuleConfig;
  return candidate.version===NEW_MATERIAL_RULE_CONFIG_VERSION&&['leave-absent','set-external','set-private'].includes(candidate.defaultAction)
    &&Array.isArray(candidate.rules)&&candidate.rules.length<=BOUNDS.predicates&&candidate.rules.every(rule=>!!rule&&typeof rule==='object'
      &&exact(rule,['id','action','when'])&&identifier(rule.id)&&['set-external','set-private'].includes(rule.action)&&validWhen(rule.when))
    &&new Set(candidate.rules.map(rule=>rule.id)).size===candidate.rules.length
    &&Buffer.byteLength(JSON.stringify(candidate))<=MAX_RULE_CONFIG_BYTES;
}
function ruleRevision(config:NewMaterialRuleConfig):string{
  return hash(JSON.stringify({version:config.version,defaultAction:config.defaultAction,rules:config.rules.map(rule=>({id:rule.id,action:rule.action,when:{
    folderSegments:rule.when.folderSegments?[...rule.when.folderSegments]:undefined,importChannel:rule.when.importChannel,
    type:rule.when.type,template:rule.when.template,tags:rule.when.tags?[...rule.when.tags]:undefined,
    properties:rule.when.properties?.map(predicate=>({key:predicate.key,valueType:predicate.valueType,value:predicate.value,operator:predicate.operator})),
  }}))}));
}
function inputValid(input:NewMaterialPolicyInput):boolean{
  if(!input||!validPolicyMetadata(input.proof,input.sourceId,input.sha256,input.rootId))return false;
  return !!input.lifecycle&&exact(input.lifecycle,['state','sourceId','sha256','rootId'])
    &&['existing','verified-new','unresolved'].includes(input.lifecycle.state)&&validPath(input.lifecycle.sourceId)&&isDigest(input.lifecycle.sha256)
    &&isDigest(input.lifecycle.rootId)&&(input.provenance===null||!!input.provenance&&exact(input.provenance,['channelId','digest','sourceId','sha256','rootId'])
      &&identifier(input.provenance.channelId)&&isDigest(input.provenance.digest)&&validPath(input.provenance.sourceId)
      &&isDigest(input.provenance.sha256)&&isDigest(input.provenance.rootId));
}
function matches(rule:NewMaterialRule,input:NewMaterialPolicyInput){const {importChannel,...when}=rule.when;return matchPolicyRule({...when,origin:importChannel},{sourceId:input.sourceId,properties:input.proof.properties,originId:input.provenance?.channelId});}
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
    if(input.lifecycle.state==='unresolved')return decision(revision,'leave-absent','lifecycle-unresolved',null);
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
