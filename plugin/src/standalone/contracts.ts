import { createHash } from 'node:crypto';
import { BOUNDS, SCHEMA, PROTOCOL, StandaloneError } from './shared';
export { BOUNDS, SCHEMA, PROTOCOL, StandaloneError } from './shared';

export type ExtractionStatus = 'ok' | 'partial' | 'empty' | 'failed' | 'unsupported';
export type PropertyType = 'string' | 'number' | 'boolean' | 'date' | 'null' | 'list';
export type Scalar = string | number | boolean | null;
export type TypedProperty = { key: string; valueType: PropertyType; value: Scalar | Scalar[] };
export type Predicate = { key: string; valueType: PropertyType; value: Scalar | Scalar[]; operator: 'eq' | 'contains' };
export type SourceLocator = {
  locatorKind: 'markdown'; sourceVersion: string; blockOrder: number;
  byteStart: number; byteEnd: number; charStart: number; charEnd: number;
  lineStart: number; lineEnd: number;
};
export type ParsedBlock = {
  sourceId: string; sourceSha256: string; blockId: string; order: number;
  kind: string; originalText: string; headings: string[];
  wikiLinks: string[]; locator: SourceLocator; terms: string[];
};
export type SourceVersion = {
  sourceId: string; vaultRelativePath: string; sha256: string; sourceType: 'markdown';
  scopeId: string; extractionStatus: ExtractionStatus; profileId: typeof SCHEMA;
  properties: TypedProperty[]; wikiLinks: string[]; diagnostics: string[];
  blocks: ParsedBlock[];
};
export type IndexGeneration = {
  schemaVersion: typeof SCHEMA; rootId: string; generationId: string; publishedAt: string;
  sourceVersionSet: { sourceId: string; sha256: string }[];
  lexicalIndexId: typeof SCHEMA; readiness: 'ready'; documents: SourceVersion[];
};
export type SearchRequest = {
  protocolVersion: typeof PROTOCOL; requestId: string; query: string;
  requestedMode: 'lexical' | 'dense' | 'hybrid'; scope?: string[];
  limit: number; predicates?: Predicate[];
};
export type EvidenceHit = {
  sourceId: string; sourceSha256: string; originalExcerpt: string;
  sourceLocators: SourceLocator[]; rank: number; lexicalRank: number;
  retrievalMode: 'lexical'; indexGenerationId: string; score: number;
  headings: string[]; wikiLinks: string[]; properties: TypedProperty[];
};
export type SearchResponse = {
  protocolVersion: typeof PROTOCOL; requestId: string; requestedMode: SearchRequest['requestedMode'];
  executedMode: 'lexical' | 'none'; status: 'ok' | 'degraded' | 'failed';
  indexGenerationId: string | null; hits: EvidenceHit[];
  capabilityReadiness: { lexical: 'ready' | 'degraded' | 'unavailable' | 'failed'; dense: 'unavailable' };
  error: string | null; staleSourceCount: number;
};
export const hash = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
export const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function validPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && Buffer.byteLength(path) <= 1024
    && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/')
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'
      && !segment.startsWith('.') && !segment.includes(':'))
    && path.toLowerCase().endsWith('.md');
}
function scalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value + 'T');
}
export function validProperty(value: unknown, predicate = false): value is TypedProperty | Predicate {
  if (!isRecord(value) || typeof value.key !== 'string' || !value.key
      || Buffer.byteLength(value.key, 'utf8') > BOUNDS.propertyBytes
      || !['string', 'number', 'boolean', 'date', 'null', 'list'].includes(String(value.valueType))) return false;
  if (predicate && !['eq', 'contains'].includes(String(value.operator))) return false;
  if (!predicate && 'operator' in value) return false;
  const v = value.value;
  if (value.valueType === 'list') {
    if (predicate && value.operator === 'contains') return scalar(v);
    return Array.isArray(v) && v.length <= BOUNDS.listItems && v.every(scalar);
  }
  if (predicate && value.operator === 'contains') return false;
  return (value.valueType === 'null' && v === null)
    || (value.valueType === 'string' && typeof v === 'string')
    || (value.valueType === 'boolean' && typeof v === 'boolean')
    || (value.valueType === 'number' && typeof v === 'number' && Number.isFinite(v))
    || (value.valueType === 'date' && typeof v === 'string' && validDate(v));
}
export function validateRequest(value: unknown): asserts value is SearchRequest {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL
      || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.requestId)
      || typeof value.query !== 'string' || !value.query.trim()
      || Buffer.byteLength(value.query, 'utf8') > BOUNDS.queryBytes || value.query.includes('\0')
      || !Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > BOUNDS.limit
      || !['lexical', 'dense', 'hybrid'].includes(String(value.requestedMode))
      || (value.scope !== undefined && (!Array.isArray(value.scope)
        || value.scope.length > BOUNDS.sources || !value.scope.every(validPath)))
      || (value.predicates !== undefined && (!Array.isArray(value.predicates)
        || value.predicates.length > BOUNDS.predicates
        || !value.predicates.every(p => validProperty(p, true))))) {
    throw new StandaloneError('INVALID_REQUEST');
  }
  if (Object.keys(value).some(key => !['protocolVersion','requestId','query','requestedMode','scope','limit','predicates'].includes(key))) {
    throw new StandaloneError('INVALID_REQUEST');
  }
}
export function matches(properties: TypedProperty[], predicates: Predicate[]): boolean {
  return predicates.every(p => {
    const found = properties.find(a => a.key === p.key);
    if (!found || found.valueType !== p.valueType) return false;
    if (p.operator === 'contains') return Array.isArray(found.value)
      && found.value.some(item => typeof item === typeof p.value && Object.is(item, p.value));
    if (Array.isArray(found.value) && Array.isArray(p.value)) {
      const wanted = p.value;
      return found.value.length === wanted.length
        && found.value.every((item, index) => typeof item === typeof wanted[index] && Object.is(item, wanted[index]));
    }
    return Object.is(found.value, p.value);
  });
}
export function generationId(rootId: string, documents: SourceVersion[]): string {
  return hash(JSON.stringify({ schemaVersion: SCHEMA, rootId, documents }));
}
export function makeGeneration(rootId: string, documents: SourceVersion[]): IndexGeneration {
  // Match BoundedVaultReader.list() code-unit ordering. Locale collation can
  // disagree for valid mixed-case/Unicode filenames and cause false source drift.
  const sorted = [...documents].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
  return {
    schemaVersion: SCHEMA, rootId, generationId: generationId(rootId, sorted),
    publishedAt: new Date().toISOString(),
    sourceVersionSet: sorted.map(d => ({ sourceId: d.sourceId, sha256: d.sha256 })),
    lexicalIndexId: SCHEMA, readiness: 'ready', documents: sorted,
  };
}
export function validateGeneration(value: unknown, rootId: string): asserts value is IndexGeneration {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA || value.lexicalIndexId !== SCHEMA
      || value.rootId !== rootId || value.readiness !== 'ready' || !isDigest(value.generationId)
      || typeof value.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.publishedAt)
      || Number.isNaN(Date.parse(value.publishedAt)) || new Date(value.publishedAt).toISOString() !== value.publishedAt
      || !Array.isArray(value.documents) || value.documents.length > BOUNDS.sources
      || !Array.isArray(value.sourceVersionSet) || value.sourceVersionSet.length !== value.documents.length) {
    throw new StandaloneError('INDEX_INCOMPATIBLE');
  }
  const docs = value.documents as unknown[];
  let count = 0;
  const paths = new Set<string>();
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i], entry = value.sourceVersionSet[i];
    if (!isRecord(doc) || !isRecord(entry)
        || !validPath(doc.sourceId) || doc.vaultRelativePath !== doc.sourceId || paths.has(doc.sourceId)
        || doc.sourceType !== 'markdown' || doc.scopeId !== rootId || doc.profileId !== SCHEMA
        || !isDigest(doc.sha256) || !['ok','partial','empty','failed','unsupported'].includes(String(doc.extractionStatus))
        || !Array.isArray(doc.properties) || doc.properties.length > BOUNDS.propertiesPerSource
        || !doc.properties.every(p => validProperty(p))
        || !Array.isArray(doc.wikiLinks) || doc.wikiLinks.length > BOUNDS.wikiLinksPerSource
        || !doc.wikiLinks.every(x => typeof x === 'string')
        || !Array.isArray(doc.diagnostics) || !doc.diagnostics.every(x => typeof x === 'string')
        || !Array.isArray(doc.blocks) || doc.blocks.length > BOUNDS.blocksPerSource
        || entry.sourceId !== doc.sourceId || entry.sha256 !== doc.sha256) {
      throw new StandaloneError('INDEX_INCOMPATIBLE');
    }
    paths.add(doc.sourceId);
    const blocks = doc.blocks as unknown[];
    count += blocks.length;
    if (count > BOUNDS.blocks) throw new StandaloneError('INDEX_INCOMPATIBLE');
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[j];
      if (!isRecord(block) || block.order !== j || block.sourceId !== doc.sourceId || block.sourceSha256 !== doc.sha256
          || !isDigest(block.blockId) || typeof block.kind !== 'string'
          || typeof block.originalText !== 'string' || !Array.isArray(block.headings)
          || !block.headings.every(x => typeof x === 'string')
          || !Array.isArray(block.wikiLinks) || block.wikiLinks.length > BOUNDS.wikiLinksPerBlock
          || !block.wikiLinks.every(x => typeof x === 'string')
          || !Array.isArray(block.terms) || block.terms.length > BOUNDS.indexedTermsPerBlock
          || !block.terms.every(x => typeof x === 'string')
          || !isRecord(block.locator) || block.locator.locatorKind !== 'markdown'
          || block.locator.sourceVersion !== doc.sha256 || block.locator.blockOrder !== j
          || !['byteStart','byteEnd','charStart','charEnd','lineStart','lineEnd'].every(k =>
            Number.isSafeInteger((block.locator as Record<string, unknown>)[k])
            && ((block.locator as Record<string, unknown>)[k] as number) >= 0)
          || (block.locator.byteEnd as number) < (block.locator.byteStart as number)
          || (block.locator.charEnd as number) < (block.locator.charStart as number)
          || (block.locator.lineStart as number) < 1) throw new StandaloneError('INDEX_INCOMPATIBLE');
    }
  }
  if (generationId(rootId, docs as SourceVersion[]) !== value.generationId)
    throw new StandaloneError('INDEX_INCOMPATIBLE');
}
