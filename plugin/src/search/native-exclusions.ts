import {randomUUID} from 'node:crypto';
import {hash,StandaloneError} from '../standalone/contracts';
import {validHardScopePath,type HardSearchScope} from '../standalone/hard-search-scope';

/** Compatibility is deliberately restricted to the measured host release.
 * This boundary is the only consumer of the undocumented native methods. */
export const NATIVE_EXCLUSION_COMPAT_VERSION='1.15.1';
const MAX_RULES=256,MAX_RULE_BYTES=32768;
type NativeVault={
  getConfig(key:string):unknown;
  on(event:'config-changed',callback:()=>void):unknown;
  offref(ref:unknown):void;
};
type NativeMetadata={
  isUserIgnored(path:string):unknown;
  userIgnoreFilters:unknown;
};
export type NativeExclusionHost=Readonly<{vault:unknown;metadataCache:unknown}>;
export type NativeExclusionPlatform=Readonly<{version:string;desktop:boolean;linux:boolean}>;
export type NativeExclusionLease=Readonly<{
  scope:HardSearchScope&Readonly<{current():boolean}>;
  dispose():void;
}>;
const invalid=():StandaloneError=>new StandaloneError('SEARCH_SCOPE_INVALID');
const object=(value:unknown):value is object=>value!==null&&typeof value==='object';

function snapshotRules(vault:NativeVault,get:NativeVault['getConfig']):{serialized:string;count:number}{
  const raw=get.call(vault,'userIgnoreFilters');
  if(raw===null)return {serialized:'default',count:0};
  if(!Array.isArray(raw)||raw.length>MAX_RULES)throw invalid();
  const values=[...raw];
  if(!values.every(value=>typeof value==='string'&&value.length<=1024
    &&Buffer.byteLength(value)<=1024&&Buffer.from(value,'utf8').toString('utf8')===value
    &&!/[\0\r\n]/.test(value)))throw invalid();
  const serialized=JSON.stringify(values);
  if(Buffer.byteLength(serialized)>MAX_RULE_BYTES)throw invalid();
  return {serialized,count:values.length};
}

/** The live native matcher is usable only under a revocable captured revision.
 * Even an empty native scope must be checked for currency by its owner. */
export function captureNativeExclusions(host:NativeExclusionHost,platform:NativeExclusionPlatform,
  onRetired:()=>void,base?:HardSearchScope):NativeExclusionLease{
  const native=(()=>{
    try{
      const vault=host.vault,metadata=host.metadataCache;
      if(platform.version!==NATIVE_EXCLUSION_COMPAT_VERSION||platform.desktop!==true||platform.linux!==true
        ||!object(vault)||!object(metadata))throw invalid();
      const v=vault as NativeVault,m=metadata as NativeMetadata;
      const get=v.getConfig,match=m.isUserIgnored,on=v.on,off=v.offref;
      if(typeof get!=='function'||typeof match!=='function'||typeof on!=='function'||typeof off!=='function')throw invalid();
      return {vault:v,metadata:m,get,match,on,off};
    }catch{throw invalid();}
  })();
  const {vault,metadata,get,match,on,off}=native;
  let retired=false,disposed=false,ref:unknown;
  const retire=():void=>{
    if(retired)return;
    retired=true;
    // The logical seal precedes any possibly reentrant host callback.
    try{onRetired();}catch{/* The seal still holds if the observer fails. */}
  };
  const dispose=():void=>{
    retired=true;
    if(disposed)return;
    disposed=true;
    if(ref!==undefined&&ref!==null){try{off.call(vault,ref);}catch{throw invalid();}}
  };
  try{
    ref=on.call(vault,'config-changed',retire);
    if(ref===undefined||ref===null||retired)throw invalid();
    const rules=snapshotRules(vault,get);
    const filters=metadata.userIgnoreFilters;
    // The observed native default uses null for both the getter and
    // compiled filters; explicit empty uses two empty arrays.
    const nativeDefault=rules.serialized==='default';
    if(nativeDefault?filters!==null:(!Array.isArray(filters)||filters.length!==rules.count
      ||!filters.every(object)))throw invalid();
    const entries=Array.isArray(filters)?[...filters]:[];
    const revision=hash(JSON.stringify(['oks-native-exclusion-v1',platform.version,randomUUID(),
      rules.serialized,base?.revision??null]));
    const current=():boolean=>{
      if(retired)return false;
      try{
        if(host.vault!==vault||host.metadataCache!==metadata||vault.getConfig!==get
          ||vault.on!==on||vault.offref!==off||metadata.isUserIgnored!==match)throw invalid();
        const next=snapshotRules(vault,get);
        if(host.vault===vault&&host.metadataCache===metadata
          &&vault.getConfig===get&&vault.on===on&&vault.offref===off&&metadata.isUserIgnored===match
          &&metadata.userIgnoreFilters===filters
          &&(nativeDefault?filters===null:Array.isArray(filters)&&filters.length===entries.length
            &&entries.every((entry,i)=>filters[i]===entry))
          &&next.serialized===rules.serialized&&!retired)return true;
      }catch{/* Unknown native state is never permission. */}
      retire();
      return false;
    };
    const scope=Object.freeze({
      revision,hasExclusions:rules.count>0||base?.hasExclusions===true,current,
      allows(path:unknown):boolean{
        if(!validHardScopePath(path)||!current())return false;
        try{
          if(base&&!base.allows(path))return false;
          const excluded=match.call(metadata,path);
          if(typeof excluded!=='boolean')throw invalid();
          return current()&&excluded===false;
        }catch{
          retire();
          return false;
        }
      },
    });
    if(!current())throw invalid();
    return Object.freeze({scope,dispose});
  }catch{
    try{dispose();}catch{/* An invalid capture remains sealed. */}
    throw invalid();
  }
}
