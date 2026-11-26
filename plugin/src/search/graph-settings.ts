import { isRecord } from '../standalone/contracts';
import { validateGraphMapping, type GraphMapping } from '../standalone/graph-mapping';

export type GraphPreference =
  | { state: 'disabled' | 'invalid' }
  | { state: 'configured'; mapping: GraphMapping };

/** Malformed optional graph configuration never enables graph or disables Basic. */
export function parseGraphPreference(input: unknown): GraphPreference {
  if (!isRecord(input)) return {state:'invalid'};
  if ((input.state==='disabled'||input.state==='invalid') && Object.keys(input).length===1)
    return {state:input.state};
  if (input.state==='configured' && Object.keys(input).length===2 && Object.hasOwn(input,'mapping')) {
    const mapping=validateGraphMapping(input.mapping);
    if (!('code' in mapping)) return {state:'configured',mapping};
  }
  return {state:'invalid'};
}
export function configuredGraph(preference:GraphPreference|undefined):GraphMapping|null {
  return preference?.state==='configured'?preference.mapping:null;
}
export function parseGraphDraft(raw:string):GraphMapping|null {
  if (Buffer.byteLength(raw,'utf8')>16*1024) return null;
  try {
    const mapping=validateGraphMapping(JSON.parse(raw));
    return 'code' in mapping?null:mapping;
  } catch {return null;}
}
