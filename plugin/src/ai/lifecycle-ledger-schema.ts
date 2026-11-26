/** Strict, bounded persistence evidence; not processing or lifecycle authority. */
import { BOUNDS, isDigest, isRecord, validPath } from '../standalone/contracts';
import type { DescriptorLifecycleProof } from '../standalone/source';
import { ledgerUnavailable as bad } from './lifecycle-lock';

export type LedgerEntry=Readonly<
  {sourceId:string;state:'verified-new'|'existing';origin:'native-create'|'baseline';originVersionId:string;proof:DescriptorLifecycleProof}
  |{sourceId:string;state:'deleted'|'ambiguous'}
>;
export type LedgerSnapshot=Readonly<{
  schemaVersion:1;rootId:string;epoch:string;revision:number;previous:string|null;
  baselineAdmitted:boolean;entries:readonly LedgerEntry[];
}>;
export type LedgerAnchor=Readonly<{
  schemaVersion:1;rootId:string;epoch:string;revision:number;snapshotSha256:string;
}>;
export const MAX_LEDGER_BYTES=1024*1024;
const keys=(value:unknown,names:string):value is Record<string,unknown>=>
  isRecord(value)&&Object.keys(value).sort().join('|')===names;
const revision=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function validEntry(value:unknown,rootId:string,baseline:boolean):value is LedgerEntry{
  if(!isRecord(value)||!validPath(value.sourceId))return false;
  if(value.state==='deleted'||value.state==='ambiguous')return keys(value,'sourceId|state');
  if(!keys(value,'origin|originVersionId|proof|sourceId|state')||!isDigest(value.originVersionId)
    ||!((value.state==='existing'&&value.origin==='baseline'&&baseline)
      ||(value.state==='verified-new'&&value.origin==='native-create')))return false;
  const p=value.proof;
  return keys(p,'stableIdentity|version')&&isDigest(p.stableIdentity)
    &&keys(p.version,'rootId|sha256|sourceId|versionId')
    &&p.version.rootId===rootId&&p.version.sourceId===value.sourceId
    &&isDigest(p.version.sha256)&&isDigest(p.version.versionId);
}
export function validateLedgerSnapshot(value:unknown,rootId:string):asserts value is LedgerSnapshot{
  if(!keys(value,'baselineAdmitted|entries|epoch|previous|revision|rootId|schemaVersion')
    ||value.schemaVersion!==1||value.rootId!==rootId||!isDigest(rootId)||!isDigest(value.epoch)
    ||!revision(value.revision)||typeof value.baselineAdmitted!=='boolean'
    ||(value.revision===0?value.previous!==null||value.baselineAdmitted||!Array.isArray(value.entries)||value.entries.length!==0
      :!isDigest(value.previous))
    ||!Array.isArray(value.entries)||value.entries.length>BOUNDS.sources)return bad();
  let prior='';
  for(const entry of value.entries){
    if(!validEntry(entry,rootId,value.baselineAdmitted)||entry.sourceId<=prior)return bad();
    prior=entry.sourceId;
  }
}
export function validateLedgerAnchor(value:unknown,rootId:string):asserts value is LedgerAnchor{
  if(!keys(value,'epoch|revision|rootId|schemaVersion|snapshotSha256')||value.schemaVersion!==1
    ||value.rootId!==rootId||!isDigest(rootId)||!isDigest(value.epoch)||!revision(value.revision)
    ||!isDigest(value.snapshotSha256))return bad();
}
export function immutableLedgerSnapshot(value:LedgerSnapshot):LedgerSnapshot{
  return Object.freeze({...value,entries:Object.freeze(value.entries.map(entry=>{
    if(!('proof' in entry))return Object.freeze({...entry});
    return Object.freeze({...entry,proof:Object.freeze({stableIdentity:entry.proof.stableIdentity,
      version:Object.freeze({...entry.proof.version})})});
  }))});
}
