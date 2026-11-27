import { BOUNDS, hash, isDigest, validPath } from '../standalone/contracts';
import type { PolicyMetadataProof } from '../standalone/shared';
import { exact, frozen, identifier, matchPolicyRule, validPolicyMetadata, validPolicyRuleWhen, type PolicyRuleWhen } from './policy-rules';

/** P0.1 read-only decision substrate. It neither verifies freshness nor grants processing. */
export const EFFECTIVE_POLICY_VERSION='oks-effective-policy-1';
export const EFFECTIVE_POLICY_CONFIG_VERSION='oks-effective-policy-config-v1';
export type EffectiveDecision='eligible'|'denied';
export type EffectivePolicyReason='eligible-external'|'eligible-absent'|'explicit-private'|'rule-denied'|'default-denied'
  |'metadata-unresolved'|'source-mismatch'|'origin-unresolved'|'required-input-unresolved'|'invalid-config';
export type EffectiveRuleWhen=PolicyRuleWhen;
export type EffectivePolicyRule=Readonly<{id:string;decision:EffectiveDecision;when:EffectiveRuleWhen}>;
/** This schema is deliberately distinct from historical marking-rule settings. */
export type EffectivePolicyConfig=Readonly<{version:typeof EFFECTIVE_POLICY_CONFIG_VERSION;verifiedAbsent:EffectiveDecision;rules:readonly EffectivePolicyRule[]}>;
/** Origin is trusted only when the host binds it to this exact current original. */
export type VerifiedOrigin=Readonly<{originId:string;digest:string;sourceId:string;sha256:string;rootId:string}>;
export type EffectivePolicyInput=Readonly<{sourceId:string;sha256:string;rootId:string;proof:PolicyMetadataProof;origin:VerifiedOrigin|null}>;
export type EffectivePolicyDecision=Readonly<{policyVersion:typeof EFFECTIVE_POLICY_VERSION;ruleRevision:string|null;decision:EffectiveDecision;
  reason:EffectivePolicyReason;matchedRuleId:string|null;sourceId:string|undefined;sha256:string|undefined;rootId:string|undefined;complete:boolean}>;

export const MAX_EFFECTIVE_POLICY_CONFIG_BYTES=32768;
export function defaultEffectivePolicyConfig():EffectivePolicyConfig{return {version:EFFECTIVE_POLICY_CONFIG_VERSION,verifiedAbsent:'denied',rules:[]};}
export function validEffectivePolicyConfig(value:unknown):value is EffectivePolicyConfig{
  if(!value||typeof value!=='object'||Array.isArray(value)||!exact(value,['version','verifiedAbsent','rules']))return false;
  const config=value as EffectivePolicyConfig;
  return config.version===EFFECTIVE_POLICY_CONFIG_VERSION&&['eligible','denied'].includes(config.verifiedAbsent)
    &&Array.isArray(config.rules)&&config.rules.length<=BOUNDS.predicates&&config.rules.every(rule=>!!rule&&typeof rule==='object'
      &&exact(rule,['id','decision','when'])&&identifier(rule.id)&&['eligible','denied'].includes(rule.decision)&&validPolicyRuleWhen(rule.when))
    &&new Set(config.rules.map(rule=>rule.id)).size===config.rules.length&&Buffer.byteLength(JSON.stringify(config))<=MAX_EFFECTIVE_POLICY_CONFIG_BYTES;
}
function revision(config:EffectivePolicyConfig):string{return hash(JSON.stringify(config));}
function inputValid(input:EffectivePolicyInput):boolean{
  return !!input&&validPolicyMetadata(input.proof,input.sourceId,input.sha256,input.rootId,true)
    &&(input.origin===null||!!input.origin&&exact(input.origin,['originId','digest','sourceId','sha256','rootId'])&&identifier(input.origin.originId)
      &&isDigest(input.origin.digest)&&validPath(input.origin.sourceId)&&isDigest(input.origin.sha256)&&isDigest(input.origin.rootId));
}
/** Deterministic current-proof interpretation only; caller-owned authority remains mandatory. */
export function decideEffectivePolicy(config:unknown,input:EffectivePolicyInput):EffectivePolicyDecision{
  const base={policyVersion:EFFECTIVE_POLICY_VERSION,sourceId:input?.sourceId,sha256:input?.sha256,rootId:input?.rootId} as const;
  const decision=(ruleRevision:string|null,value:EffectiveDecision,reason:EffectivePolicyReason,matchedRuleId:string|null,complete=false)=>frozen({...base,ruleRevision,decision:value,reason,matchedRuleId,complete});
  try{
    if(!validEffectivePolicyConfig(config))return decision(null,'denied','invalid-config',null);
    const ruleRevision=revision(config);
    if(!inputValid(input))return decision(ruleRevision,'denied','source-mismatch',null);
    if(input.origin&&(input.origin.sourceId!==input.sourceId||input.origin.sha256!==input.sha256||input.origin.rootId!==input.rootId))return decision(ruleRevision,'denied','origin-unresolved',null);
    if(input.proof.properties.some(p=>p.key!=='llm_processing'&&p.key.toLowerCase()==='llm_processing'))return decision(ruleRevision,'denied','metadata-unresolved',null);
    if(input.proof.state==='private')return decision(ruleRevision,'denied','explicit-private',null,true);
    if(input.proof.state!=='absent'&&input.proof.state!=='external')return decision(ruleRevision,'denied','metadata-unresolved',null);
    const matches=config.rules.map(rule=>({rule,result:matchPolicyRule(rule.when,{sourceId:input.sourceId,properties:input.proof.properties,originId:input.origin?.originId})}));
    const restrictive=matches.find(x=>x.result==='match'&&x.rule.decision==='denied');
    if(restrictive)return decision(ruleRevision,'denied','rule-denied',restrictive.rule.id,true);
    if(matches.some(x=>x.result==='unresolved'))return decision(ruleRevision,'denied','required-input-unresolved',null);
    const permissive=matches.find(x=>x.result==='match'&&x.rule.decision==='eligible');
    if(input.proof.state==='external')return decision(ruleRevision,'eligible','eligible-external',permissive?.rule.id??null,true);
    if(permissive)return decision(ruleRevision,'eligible','eligible-absent',permissive.rule.id,true);
    return config.verifiedAbsent==='eligible'?decision(ruleRevision,'eligible','eligible-absent',null,true):decision(ruleRevision,'denied','default-denied',null,true);
  }catch{return decision(null,'denied','invalid-config',null);}
}
