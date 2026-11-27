import {hash,isRecord,StandaloneError,validVaultRelativePath} from './contracts';

export const HARD_SEARCH_SCOPE_VERSION='oks-hard-search-scope-v1';
export type HardSearchScopeConfig=Readonly<{version:typeof HARD_SEARCH_SCOPE_VERSION;
  excludedFolders:readonly string[];excludedFiles:readonly string[]}>;
export type HardSearchScope=Readonly<{revision:string;hasExclusions:boolean;allows(path:unknown):boolean}>;
export type RevocableHardSearchScope=HardSearchScope&Readonly<{current():boolean}>;
const MAX_ENTRIES=64,MAX_CONFIG_BYTES=32768;
/** Canonical vault-relative path, independent of file format. No host paths; wildcard characters are literal, not patterns. */
export function validHardScopePath(value:unknown):value is string{
  return typeof value==='string'&&value.length<=1024&&Buffer.byteLength(value)<=1024
    &&Buffer.from(value,'utf8').toString('utf8')===value&&!/[\r\n]/.test(value)
    &&validVaultRelativePath(value);
}
function paths(value:unknown):string[]|null{
  if(!Array.isArray(value)||value.length>MAX_ENTRIES||![...value].every(validHardScopePath)||new Set(value).size!==value.length)return null;
  return [...value].sort();
}
export function defaultHardSearchScope():HardSearchScopeConfig{
  return {version:HARD_SEARCH_SCOPE_VERSION,excludedFolders:[],excludedFiles:[]};
}
/** Local search fence only, never provider admission or source authenticity proof. */
export function captureHardSearchScope(value:unknown):HardSearchScope{
  if(!isRecord(value)||Object.keys(value).length!==3||!['version','excludedFolders','excludedFiles'].every(k=>Object.hasOwn(value,k))
    ||value.version!==HARD_SEARCH_SCOPE_VERSION)throw new StandaloneError('SEARCH_SCOPE_INVALID');
  const folders=paths(value.excludedFolders),files=paths(value.excludedFiles);
  if(!folders||!files||folders.length+files.length>MAX_ENTRIES||Buffer.byteLength(JSON.stringify([folders,files]))>MAX_CONFIG_BYTES)
    throw new StandaloneError('SEARCH_SCOPE_INVALID');
  const revision=hash(JSON.stringify([HARD_SEARCH_SCOPE_VERSION,folders,files]));
  return Object.freeze({revision,hasExclusions:folders.length+files.length>0,allows(path:unknown):boolean{
    return validHardScopePath(path)&&!files.includes(path)&&!folders.some(folder=>path===folder||path.startsWith(folder+'/'));
  }});
}
