import { StandaloneError, hash, BOUNDS, type IndexGeneration } from './contracts';
import { freezeScope, resolveScope, type ScopeSelector, type ScopeSnapshot } from './chat-scope';
import { graphMappingId, type GraphMapping } from './graph-mapping';
import { deriveGraphProjection, type GraphProjection } from './graph-projection';
import type { SourceProvider } from './source';
import type { MarkdownParser } from './worker';

export type ScopedGraphSnapshot = Readonly<{
  scope: Readonly<ScopeSnapshot>;
  mappingId: string;
  nodes: GraphProjection['nodes'];
  edges: GraphProjection['edges'];
  coverage: GraphProjection['coverage'] | 'not-disclosed';
  scopedProjectionId: string;
}>;
/** Internal read lease; not a disclosure grant. Check current before consuming
 * any previously returned snapshot and perform a fresh read for each use. */
export type GraphScopeLease = Readonly<{
  current(): boolean;
  read(): Promise<ScopedGraphSnapshot>;
}>;

/** Reuse the canonical worker for the first build: a locally consistent
 * serialized index digest is not proof that its parse matches original bytes.
 * The existing source provider enforces the vault boundary and byte cap. */
export async function authenticateGraphCatalog(gen: IndexGeneration, provider: SourceProvider,
  parser: MarkdownParser, reparse: boolean, check: () => void, yieldJob: () => Promise<void>): Promise<void> {
  const membership = async () => {
    check();
    const paths = await provider.list(); check();
    if (provider.rootId !== gen.rootId || paths.length !== gen.documents.length
      || paths.some((p,i) => p !== gen.documents[i]?.sourceId))
      throw new StandaloneError('GRAPH_SOURCE_STALE');
    return paths;
  };
  const paths = await membership();
  const hints = await provider.versionHints(paths); check();
  for (const doc of gen.documents) {
    const bytes = await provider.read(doc.sourceId); check();
    if (bytes.byteLength > BOUNDS.fileBytes || hash(bytes) !== doc.sha256)
      throw new StandaloneError('GRAPH_SOURCE_STALE');
    if (reparse) {
      const parsed = await parser.parse(doc.sourceId,bytes,gen.rootId); check();
      if (JSON.stringify(parsed) !== JSON.stringify(doc))
        throw new StandaloneError('GRAPH_INDEX_UNAUTHENTICATED');
    }
    await yieldJob(); check();
  }
  const after = await membership();
  const afterHints = await provider.versionHints(after); check();
  if (hints.length !== paths.length || afterHints.length !== hints.length
    || hints.some((h,i) => h !== afterHints[i])) throw new StandaloneError('GRAPH_SOURCE_STALE');
}

export async function buildAuthenticatedGraph(gen: IndexGeneration, mapping: GraphMapping,
  provider: SourceProvider, parser: MarkdownParser, current: () => boolean,
  check: () => void, yieldJob: () => Promise<void>): Promise<GraphProjection> {
  await authenticateGraphCatalog(gen,provider,parser,true,check,yieldJob);
  check();
  const graph = await deriveGraphProjection(gen,mapping,{cancelled:()=>!current(),yieldJob});
  check();
  if ('code' in graph) throw new StandaloneError(graph.code);
  await authenticateGraphCatalog(gen,provider,parser,false,check,yieldJob);
  check(); return graph;
}

/** Scope is resolved only against the pinned, authenticated generation.
 * Never return the global catalog, its projection identity, or counts that
 * describe excluded sources to a narrower selection. */
export function scopeGraph(gen: IndexGeneration, mapping: GraphMapping, graph: GraphProjection,
  selector: ScopeSelector): ScopedGraphSnapshot {
  const {sources,coverage} = resolveScope(selector,gen.documents);
  const scope = {selector,rootId:gen.rootId,generationId:gen.generationId,sources,coverage};
  const allowed = new Map(sources.map(s=>[s.sourceId,s.sourceSha256]));
  const nodes = graph.nodes.filter(n=>allowed.get(n.sourceId)===n.sourceSha256);
  const edges = graph.edges.filter(e=>allowed.get(e.from)===e.sourceSha256
    && allowed.get(e.to)===e.targetSha256 && allowed.get(e.author)===e.authorSha256
    && e.anchors.every(a=>allowed.get(a.sourceId)===a.sourceSha256));
  const result = {scope,mappingId:graphMappingId(mapping),nodes,edges,
    coverage: selector.mode==='vault-wide' && sources.length===gen.documents.length
      ? graph.coverage : 'not-disclosed' as const};
  return freezeScope({...result,scopedProjectionId:hash(JSON.stringify(result))});
}
