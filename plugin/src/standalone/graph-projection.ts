/** Pure, private graph derivation over one immutable lexical generation.
 * Neither an input generation digest nor this projection grants publication,
 * original-source authority, scope, or disclosure. Those require 06B.2b. */
import { BOUNDS, hash, isDigest, validPath, validateGeneration, type IndexGeneration, type SourceVersion } from './contracts';
import { compare, graphMappingId, graphText, isGraphFailure, validateGraphMapping,
  type GraphDirection, type GraphFailure, type TargetEncoding } from './graph-mapping';
import { bump, completeMetadata, navigationValues, readProperty, wikiTarget,
  type Coverage, type GraphAnchor, type PropertyRead } from './graph-source';

export { validateGraphMapping, graphMappingId } from './graph-mapping';
export type { GraphMapping, GraphFailure } from './graph-mapping';
const ALGORITHM_VERSION = 'oks-06b-projection-v1' as const;
const MAX_EDGES = 8192;
const MAX_BYTES = 4 * 1024 * 1024;

export type GraphEdge = Readonly<{
  edgeId: string; kind: 'relation' | 'navigation'; relationId: string | null;
  from: string; to: string; author: string; authorSha256: string; sourceSha256: string; targetSha256: string;
  anchors: readonly GraphAnchor[]; status: { declared: string | null; truth: 'unverified' };
}>;
export type GraphProjection = Readonly<{
  schemaVersion: 1; algorithm: typeof ALGORITHM_VERSION; rootId: string; lexicalGenerationId: string;
  mappingId: string; sourceVersionSet: readonly { sourceId: string; sha256: string }[];
  nodes: readonly { sourceId: string; sourceSha256: string; cardType: string | null; declaredStatus: string | null }[];
  edges: readonly GraphEdge[]; coverage: Readonly<Coverage>; projectionId: string;
}>;
export type ProjectionOptions = Readonly<{ cancelled?: () => boolean; yieldJob?: () => Promise<void> }>;
type Identity = { doc: SourceVersion; type: string | null; status: string | null; complete: boolean; eligible: boolean };
type Lookup = Map<string, Identity | 'ambiguous'>;
function add(to: Lookup, value: string, item: Identity): void {
  const prior = to.get(value);
  to.set(value, prior === undefined || prior === item ? item : 'ambiguous');
}
function single(p: PropertyRead): string | null { return p.state === 'ok' ? p.values[0]?.value ?? null : null; }
function hasType(identity: Identity, allowed: readonly string[] | undefined): boolean {
  return !allowed || (identity.type !== null && allowed.includes(identity.type));
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value),'utf8');
class ProjectionError extends Error {
  constructor(readonly code: GraphFailure['code']) { super(code); }
}

/** Cooperative bounded work. The caller must pin the generation and later
 * authenticate all originals; this helper never exposes data to UI or provider. */
export async function deriveGraphProjection(generation: IndexGeneration, input: unknown,
  options: ProjectionOptions = {}): Promise<GraphProjection | GraphFailure> {
  const mapping = validateGraphMapping(input);
  if (isGraphFailure(mapping)) return mapping;
  let work = 0;
  const check = () => { if (options.cancelled?.()) throw new ProjectionError('GRAPH_CANCELLED'); };
  const checkpoint = async () => {
    check();
    if (++work % 256 === 0) { await (options.yieldJob ?? (() => new Promise<void>(r => setTimeout(r,0))))(); check(); }
  };
  try {
    check();
    if (!isDigest(generation.rootId)) return { code:'GRAPH_GENERATION_INVALID' };
    try { validateGeneration(generation,generation.rootId); }
    catch { return { code:'GRAPH_GENERATION_INVALID' }; }
    if (bytes(generation) > BOUNDS.generationBytes) return { code:'GRAPH_LIMIT' };
    const docs = [...generation.documents].sort((a,b) => compare(a.sourceId,b.sourceId));
    const coverage: Coverage = {};
    const identities: Identity[] = [], paths: Lookup = new Map(), business: Lookup = new Map(), wiki: Lookup = new Map();
    let identityComplete = true, aliasComplete = true;
    for (const doc of docs) {
      await checkpoint(); check();
      const complete = completeMetadata(doc);
      const eligible = ['ok','partial','empty'].includes(doc.extractionStatus);
      const type = complete ? single(readProperty(doc,mapping.cardTypeKey,true)) : null;
      const status = complete ? single(readProperty(doc,mapping.statusKey,true)) : null;
      const item: Identity = { doc, complete, eligible, type, status: status && mapping.statusValues?.includes(status) ? status : null };
      identities.push(item); add(paths,doc.sourceId,item);
      const base = doc.sourceId.split('/').at(-1)!;
      for (const token of [doc.sourceId,doc.sourceId.slice(0,-3),base,base.slice(0,-3)]) add(wiki,token,item);
      if (!complete) {
        bump(coverage,'malformed-properties');
        if (mapping.businessIdKey) identityComplete = false;
        if (mapping.aliasKeys?.length) aliasComplete = false;
        continue;
      }
      const id = readProperty(doc,mapping.businessIdKey,true);
      if (id.state === 'unsupported') { identityComplete = false; bump(coverage,'unsupported-identity'); }
      else if (id.state === 'ok' && id.values[0]) {
        const v = id.values[0].value;
        if (!graphText(v)) { identityComplete = false; bump(coverage,'unsupported-identity'); }
        else add(business,v,item);
      }
      for (const key of mapping.aliasKeys ?? []) {
        await checkpoint(); check();
        const p = readProperty(doc,key);
        if (p.state === 'unsupported' || p.state === 'ok' && p.values.some(v => !graphText(v.value))) {
          aliasComplete = false; bump(coverage,'unsupported-alias'); continue;
        }
        if (p.state === 'ok') for (const v of p.values) { add(wiki,v.value,item); add(business,v.value,item); }
      }
    }
    if (!identityComplete || !aliasComplete) bump(coverage,'incomplete-identity-catalog');
    const resolve = (raw:string,encoding:TargetEncoding,parsedWiki=false): Identity | null => {
      const key = encoding === 'wiki-link' && !parsedWiki ? wikiTarget(raw) : raw;
      if (!key || encoding === 'path' && !validPath(key)) { bump(coverage,'unsupported-link'); return null; }
      if (encoding === 'business-id' && (!identityComplete || !aliasComplete) || encoding === 'wiki-link' && !aliasComplete) {
        bump(coverage,'incomplete-target-resolution'); return null;
      }
      const item = (encoding === 'path' ? paths : encoding === 'business-id' ? business : wiki).get(key);
      if (item === 'ambiguous') { bump(coverage,'ambiguous-target'); return null; }
      if (!item) { bump(coverage,'unresolved-target'); return null; }
      if (!item.eligible) { bump(coverage,'unsupported-target'); return null; }
      return item;
    };
    const edges: GraphEdge[] = [];
    const nodes = identities.map(({doc,type,status}) => ({sourceId:doc.sourceId,sourceSha256:doc.sha256,cardType:type,declaredStatus:status}));
    const sourceVersionSet = docs.map(d => ({sourceId:d.sourceId,sha256:d.sha256}));
    let edgeBytes = bytes(nodes) + bytes(sourceVersionSet);
    const addEdge = (kind:GraphEdge['kind'],relationId:string|null,author:Identity,target:Identity,
      direction:GraphDirection,anchors:readonly GraphAnchor[],ordinal:number) => {
      const [from,to] = direction === 'author-to-target' ? [author.doc,target.doc] : [target.doc,author.doc];
      const edge: GraphEdge = { edgeId:hash('oks-06b-edge\0' + JSON.stringify([kind,relationId,from.sourceId,from.sha256,
        to.sourceId,to.sha256,author.doc.sourceId,author.doc.sha256,anchors.map(a => a.blockId),ordinal])),
        kind,relationId,from:from.sourceId,to:to.sourceId,author:author.doc.sourceId,authorSha256:author.doc.sha256,
        sourceSha256:from.sha256,targetSha256:to.sha256,anchors,status:{declared:author.status,truth:'unverified'} };
      edgeBytes += bytes(edge)+1;
      if (edges.length >= MAX_EDGES || edgeBytes > MAX_BYTES) throw new ProjectionError('GRAPH_LIMIT');
      edges.push(edge);
    };
    for (const author of identities) {
      await checkpoint(); check();
      if (!author.eligible) { bump(coverage,'unsupported-source'); continue; }
      if (author.complete) for (const rule of mapping.rules) {
        await checkpoint(); check();
        const p = readProperty(author.doc,rule.propertyKey);
        if (p.state === 'missing') continue;
        if (p.state === 'unsupported') { bump(coverage,'unsupported-property'); continue; }
        const authorTypes = rule.direction === 'author-to-target' ? rule.sourceTypes : rule.targetTypes;
        const targetTypes = rule.direction === 'author-to-target' ? rule.targetTypes : rule.sourceTypes;
        if (!hasType(author,authorTypes)) { bump(coverage,'author-type-rejected'); continue; }
        const valid = (v:string):boolean => rule.targetEncoding === 'path' ? validPath(v)
          : rule.targetEncoding === 'wiki-link' ? wikiTarget(v) !== null : graphText(v);
        if (p.values.some(v => !valid(v.value))) { bump(coverage,'unsupported-property-target'); continue; }
        for (const [ordinal,v] of p.values.entries()) {
          await checkpoint(); check();
          const target = resolve(v.value,rule.targetEncoding);
          if (!target) continue;
          if (!hasType(target,targetTypes)) { bump(coverage,'target-type-rejected'); continue; }
          addEdge('relation',rule.relationId,author,target,rule.direction,v.anchors,ordinal);
        }
      }
      const navigation = await navigationValues(author.doc,coverage,checkpoint,check); check();
      for (const [ordinal,v] of navigation.entries()) {
        await checkpoint(); check();
        const target = resolve(v.value,'wiki-link',true);
        if (target) addEdge('navigation',null,author,target,'author-to-target',v.anchors,ordinal);
      }
    }
    check();
    edges.sort((a,b) => compare(a.edgeId,b.edgeId));
    const base = {schemaVersion:1 as const,algorithm:ALGORITHM_VERSION,rootId:generation.rootId,
      lexicalGenerationId:generation.generationId,mappingId:graphMappingId(mapping),sourceVersionSet,nodes,edges,
      coverage:Object.fromEntries(Object.entries(coverage).sort(([a],[b]) => compare(a,b)))};
    check();
    const result = {...base,projectionId:hash('oks-06b-projection\0'+JSON.stringify(base))};
    if (bytes(result) > MAX_BYTES) return {code:'GRAPH_LIMIT'};
    check();
    return freeze(result);
  } catch (error) {
    if (error instanceof ProjectionError) return {code:error.code};
    // A rejected cooperative yield is also a settlement boundary.
    if (options.cancelled?.()) return {code:'GRAPH_CANCELLED'};
    throw error; // programming errors are not silently mapped to a budget result
  }
}
