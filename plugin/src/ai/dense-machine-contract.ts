import { parseSearch } from '../search/controller';
import { BOUNDS, isRecord } from '../standalone/contracts';
import { ProviderFailure, type ProviderFailureCode, type ProviderPreference } from './contracts';
import { configDigest } from './disclosure';
import type { DenseRequest } from './dense-host';
import { validateEmbeddingSpace } from './embedding-space';
import { pilotConfig } from './loopback-json';

export type MachineError = ProviderFailureCode | 'INVALID_REQUEST' | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_OPERATION' | 'BUSY' | 'INVALID_OPERATION';
export class MachineFailure extends Error {
  constructor(readonly code:MachineError){super(code);}
}
const invalid=():never=>{throw new MachineFailure('INVALID_REQUEST');};
type SearchOperation=Extract<DenseRequest,{kind:'search'}>;
export type MachineCommand=
  {operation:'submit';input:SearchOperation;digest:string} |
  {operation:'status'|'cancel'|'result';operationId:string};

/** Traverse only small JSON-like data; reject accessors, cycles, sparse arrays,
 * custom prototypes and non-data properties before invoking shared parsers.
 * Budget encoded bytes incrementally rather than serializing unknown objects. */
function boundedData(input:unknown):unknown {
  let remaining=16384;
  const seen=new Set<object>();
  const spend=(n:number)=>{remaining-=n;if(remaining<0)invalid();};
  const string=(s:string)=>{
    if(s.length>remaining||Buffer.byteLength(s)>remaining)invalid();
    spend(Buffer.byteLength(JSON.stringify(s)));
  };
  const copy=(value:unknown,depth:number):unknown=>{
    if(depth>5)invalid();
    if(typeof value==='string'){string(value);return value;}
    if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)){
      spend(JSON.stringify(value).length);return value;
    }
    if(typeof value!=='object'||value===null||seen.has(value))return invalid();
    seen.add(value);spend(2);
    if(Array.isArray(value)){
      if(value.length>BOUNDS.sources||Object.getPrototypeOf(value)!==Array.prototype)return invalid();
      if(Reflect.ownKeys(value).length!==value.length+1)return invalid();
      const result:unknown[]=[];
      for(let i=0;i<value.length;i++){
        const desc=Object.getOwnPropertyDescriptor(value,String(i));
        if(!desc||!('value' in desc)||!desc.enumerable)return invalid();
        if(i)spend(1);result.push(copy(desc.value,depth+1));
      }
      seen.delete(value);return result;
    }
    if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)return invalid();
    const result:Record<string,unknown>={};
    const keys=Reflect.ownKeys(value);
    if(keys.length>10)return invalid();
    for(const [i,key] of keys.entries()){
      if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key))return invalid();
      const desc=Object.getOwnPropertyDescriptor(value,key);
      if(!desc||!('value' in desc)||!desc.enumerable)return invalid();
      if(i)spend(1);string(key);spend(1);result[key]=copy(desc.value,depth+1);
    }
    seen.delete(value);return result;
  };
  return copy(input,0);
}
function exact(value:Record<string,unknown>,keys:string[]):void {
  if(Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))invalid();
}
export function parseMachine(input:unknown,preference:()=>ProviderPreference):MachineCommand {
  const envelope=boundedData(input);
  if(!isRecord(envelope)||typeof envelope.apiVersion!=='number'||!Number.isSafeInteger(envelope.apiVersion)
    ||typeof envelope.operation!=='string')return invalid();
  if(envelope.apiVersion!==1)throw new MachineFailure('UNSUPPORTED_VERSION');
  switch(envelope.operation){
    case 'submit': {
      exact(envelope,['apiVersion','operation','request','space']);
      const request=parseSearch(envelope.request);
      if((request.requestedMode!=='dense'&&request.requestedMode!=='hybrid')||!request.query.trim()
        ||request.matchMode!==undefined&&typeof request.matchMode!=='string'
        ||request.requestedMode==='dense'&&request.matchMode==='literal'
        ||!request.scope?.length||new Set(request.scope).size!==request.scope.length)return invalid();
      const p=preference();
      if(p.state!=='configured')throw new ProviderFailure(p.state==='disabled'?'DISABLED':'CONFIG_INVALID');
      const config=pilotConfig(p),space=validateEmbeddingSpace(config,envelope.space);
      return {operation:'submit',input:{kind:'search',paths:request.scope,space,
        request:{...request,requestedMode:request.requestedMode}},digest:configDigest('embedding',config)};
    }
    case 'status':case 'cancel':case 'result':
      exact(envelope,['apiVersion','operation','operationId']);
      if(typeof envelope.operationId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(envelope.operationId))return invalid();
      return {operation:envelope.operation,operationId:envelope.operationId};
    case 'rebuild':
      exact(envelope,['apiVersion','operation']);
      throw new MachineFailure('UNSUPPORTED_OPERATION');
    default:throw new MachineFailure('UNSUPPORTED_OPERATION');
  }
}
