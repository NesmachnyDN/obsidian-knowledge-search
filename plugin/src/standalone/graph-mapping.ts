import { BOUNDS, hash, isRecord } from './contracts';

const MAPPING_VERSION = 'oks-06b-mapping-v1' as const;
const MAX_MAPPING_BYTES = 16 * 1024;
const MAX_RULES = 32;
const MAX_VALUES = 64;

export type GraphDirection = 'author-to-target' | 'target-to-author';
export type TargetEncoding = 'path' | 'business-id' | 'wiki-link';
export type GraphRule = Readonly<{
  relationId: string; propertyKey: string; direction: GraphDirection; targetEncoding: TargetEncoding;
  sourceTypes?: readonly string[]; targetTypes?: readonly string[];
}>;
export type GraphMapping = Readonly<{
  schemaVersion: typeof MAPPING_VERSION; cardTypeKey?: string; businessIdKey?: string;
  aliasKeys?: readonly string[]; statusKey?: string; statusValues?: readonly string[];
  rules: readonly GraphRule[];
}>;
export type GraphFailure = Readonly<{ code: 'GRAPH_MAPPING_INVALID' | 'GRAPH_GENERATION_INVALID'
  | 'GRAPH_CANCELLED' | 'GRAPH_LIMIT' }>;

export const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const graphText = (v: unknown, max: number = BOUNDS.propertyBytes): v is string =>
  typeof v === 'string' && v.length > 0 && v.trim() === v && Buffer.byteLength(v, 'utf8') <= max
  && !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(v);
const propertyKey = (v: unknown): v is string => graphText(v) && /^[A-Za-z_][\w-]*$/.test(v);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).every(k => keys.includes(k));
const stringList = (v: unknown, valid = graphText): v is string[] =>
  Array.isArray(v) && v.length <= MAX_VALUES && Array.from(v).every(x => valid(x)) && new Set(v).size === v.length;
const invalid = (): GraphFailure => ({ code: 'GRAPH_MAPPING_INVALID' });

/** Input is a JSON settings value; no coercion or unrecognized fields. Canonicalize
 * only after shape/count validation so invalid nested inputs cannot inflate work. */
export function validateGraphMapping(value: unknown): GraphMapping | GraphFailure {
  if (!exact(value, ['schemaVersion','cardTypeKey','businessIdKey','aliasKeys','statusKey','statusValues','rules'])
    || value.schemaVersion !== MAPPING_VERSION || !Array.isArray(value.rules) || value.rules.length > MAX_RULES)
    return invalid();
  for (const key of ['cardTypeKey','businessIdKey','statusKey'] as const)
    if (value[key] !== undefined && !propertyKey(value[key])) return invalid();
  if (value.aliasKeys !== undefined && !stringList(value.aliasKeys, propertyKey)) return invalid();
  if (value.statusValues !== undefined && (!value.statusKey || !stringList(value.statusValues))) return invalid();
  const ids = new Set<string>(), types = new Set<string>(), rules: GraphRule[] = [];
  for (const rule of value.rules) {
    if (!exact(rule, ['relationId','propertyKey','direction','targetEncoding','sourceTypes','targetTypes'])
      || !graphText(rule.relationId) || !propertyKey(rule.propertyKey) || ids.has(rule.relationId)
      || (rule.direction !== 'author-to-target' && rule.direction !== 'target-to-author')
      || (rule.targetEncoding !== 'path' && rule.targetEncoding !== 'business-id' && rule.targetEncoding !== 'wiki-link')
      || (rule.sourceTypes !== undefined && (!value.cardTypeKey || !stringList(rule.sourceTypes)))
      || (rule.targetTypes !== undefined && (!value.cardTypeKey || !stringList(rule.targetTypes)))
      || (rule.targetEncoding === 'business-id' && !value.businessIdKey && !(value.aliasKeys as string[] | undefined)?.length))
      return invalid();
    ids.add(rule.relationId);
    const sourceTypes = rule.sourceTypes as string[] | undefined, targetTypes = rule.targetTypes as string[] | undefined;
    for (const type of [...sourceTypes ?? [], ...targetTypes ?? []]) types.add(type);
    rules.push(Object.freeze({ relationId: rule.relationId, propertyKey: rule.propertyKey, direction: rule.direction,
      targetEncoding: rule.targetEncoding,
      ...(sourceTypes ? { sourceTypes: Object.freeze([...sourceTypes].sort(compare)) } : {}),
      ...(targetTypes ? { targetTypes: Object.freeze([...targetTypes].sort(compare)) } : {}) }));
  }
  if (types.size > MAX_VALUES) return invalid();
  const result: GraphMapping = Object.freeze({ schemaVersion: MAPPING_VERSION,
    ...(value.cardTypeKey ? { cardTypeKey: value.cardTypeKey as string } : {}),
    ...(value.businessIdKey ? { businessIdKey: value.businessIdKey as string } : {}),
    ...(value.aliasKeys ? { aliasKeys: Object.freeze([...(value.aliasKeys as string[])].sort(compare)) } : {}),
    ...(value.statusKey ? { statusKey: value.statusKey as string } : {}),
    ...(value.statusValues ? { statusValues: Object.freeze([...(value.statusValues as string[])].sort(compare)) } : {}),
    rules: Object.freeze(rules.sort((a, b) => compare(a.relationId, b.relationId))) });
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_MAPPING_BYTES) return invalid();
  return result;
}
export const isGraphFailure = (value: GraphMapping | GraphFailure): value is GraphFailure => 'code' in value;
/** Called only with a canonical validated mapping. */
export const graphMappingId = (mapping: GraphMapping): string => hash('oks-06b-mapping\0' + JSON.stringify(mapping));
