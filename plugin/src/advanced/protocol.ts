/** OKS-05C production ingestion v3. Not health v2 or Standalone search API v1. */
import { createHash } from 'node:crypto';
import { isDigest, validProperty } from '../standalone/contracts';

export const INGEST_VERSION = 3 as const;
export const MAX_REQUEST = 8192;
export const MAX_RESPONSE = 8 * 1024 * 1024;
export type IngestStatus = 'ok' | 'partial' | 'empty' | 'failed' | 'unsupported';
export type IngestProfile =
  'oks-advanced-markdown-v1' | 'docling-docx-2.151.1' |
  'docling-native-pdf-2.151.1' | 'tesseract-cli-5.3.4-eng-rus' |
  'docling-heron-tableformer-fast-2.151.1' |
  'docling-heron-tableformer-fast-tesseract-2.151.1';
export type IngestRequest = {
  protocolVersion: typeof INGEST_VERSION; requestId: string; operation: 'ingest';
  rootPath: string; sourcePath: string; scopeId: string; expectedSha256: string;
  profileId: IngestProfile; deadlineUnixMs: number; tokenizerSnapshot: string;
  tessdataPath: string | null; artifactsPath: string | null;
};
export type NativeLocation = { page: number; bbox: number[]; coordinateOrigin: string;
  charStart: number | null; charEnd: number | null };
export type IngestLocator = {
  locatorKind: 'markdown' | 'native' | 'unavailable';
  sourceVersion: string; blockOrder: number;
  byteStart: number | null; byteEnd: number | null;
  charStart: number | null; charEnd: number | null;
  lineStart: number | null; lineEnd: number | null;
  nativeItemRef: string | null; nativeRepresentation: string | null; contentLayer: string | null;
  locations: NativeLocation[]; table: number | null; row: number | null;
  diagnostics: string[];
  rowRange?: number[] | null; colRange?: number[] | null;
  cellBBox?: number[] | null; cellCoordinateOrigin?: string | null;
};
export type IngestBlock = {
  sourceId: string; sourceSha256: string; blockId: string; order: number; kind: string;
  originalText: string; headings: string[]; wikiLinks: string[]; clause: string | null;
  textNature: 'verbatim' | 'table-cell-serialization'; locator: IngestLocator;
  cells: { column: number; originalText: string; locator: IngestLocator }[];
};
export type IngestSource = {
  sourceId: string; vaultRelativePath: string; sha256: string;
  sourceType: 'markdown' | 'pdf' | 'docx'; scopeId: string; profileId: IngestProfile;
  extractionStatus: IngestStatus; properties: {key: string; valueType: string; value: unknown}[];
  wikiLinks: string[]; diagnostics: string[]; pageCount: number | null; blocks: IngestBlock[];
};
export type IngestChunk = {
  chunkId: string; sourceId: string; sourceSha256: string; profileId: IngestProfile;
  sourceSlices: {blockOrder: number; charStart: number; charEnd: number}[];
  sourceLocators: IngestLocator[]; originalText: string; contextualText: string;
  chunkPolicyId: 'structure'; serializationId: string; tokenizerFingerprint: string;
  effectiveTokenCount: number; diagnostics: string[];
};
export type IngestResponse = {
  protocolVersion: typeof INGEST_VERSION; requestId: string; operation: 'ingest';
  status: IngestStatus; source: IngestSource | null; chunks: IngestChunk[];
  generationId: string | null; diagnostics: string[]; error: string | null;
};
export class IngestError extends Error {
  constructor(readonly code: 'ADVANCED_PROTOCOL_INVALID' | 'SOURCE_STALE' | 'SOURCE_REJECTED' |
    'ADVANCED_RESOURCE_REFUSED' | 'ADVANCED_TIMEOUT' | 'ADVANCED_CANCELLED' |
    'ADVANCED_EXIT' | 'ADVANCED_UNAVAILABLE' | 'ADVANCED_BUSY' |
    'INDEX_PUBLICATION_UNCERTAIN') { super(code); }
}
function bad(): never { throw new IngestError('ADVANCED_PROTOCOL_INVALID'); }
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  record(v) && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const fields = (v: unknown, keys: string[], optional: string[] = []): v is Record<string, unknown> =>
  record(v) && keys.every(k => Object.hasOwn(v,k)) &&
  Object.keys(v).every(k => keys.includes(k) || optional.includes(k));
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const str = (v: unknown, limit = 4096): v is string =>
  typeof v === 'string' && Buffer.byteLength(v) <= limit && !v.includes('\0');
const strs = (v: unknown, max: number, size = 4096): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every(s => str(s, size));
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const validNativeBox = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length===4
    && v.every(x=>num(x) && x>=0 && x<=2000)
    // Docling BOTTOMLEFT uses top>bottom; never assume ascending Y.
    && v[0]<=v[2];
const maybe = (v: unknown, pred: (x: unknown) => boolean): boolean => v === null || pred(v);
// Array.sort() uses UTF-16 code units; the v3 protocol sorts Unicode code
// points, including keys beyond the BMP. Never normalize text or coerce it.
const scalarString = (v: string): boolean => {
  for (let i = 0; i < v.length; i++) {
    const unit = v.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = v.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
};
const compareCodepoints = (left: string, right: string): number => {
  const a=Array.from(left), b=Array.from(right);
  for (let i=0; i<Math.min(a.length,b.length); i++) {
    const diff=a[i]!.codePointAt(0)!-b[i]!.codePointAt(0)!;
    if (diff!==0) return diff;
  }
  return a.length-b.length;
};
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort(compareCodepoints).map(k => {
    if (!scalarString(k) || value[k] === undefined) bad();
    return JSON.stringify(k) + ':' + canonical(value[k]);
  }).join(',') + '}';
  if (typeof value === 'number' && !Number.isFinite(value)) bad();
  if (typeof value === 'string' && !scalarString(value)) bad();
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') bad();
  return serialized;
};
export const sha = (v: Uint8Array | string): string =>
  createHash('sha256').update(v).digest('hex');
export const canonicalFrame = (value: unknown, limit: number): Buffer => {
  const bytes = Buffer.from(canonical(value) + '\n', 'utf8');
  if (bytes.byteLength > limit) bad();
  return bytes;
};
export function decodeFrame(data: Buffer, limit: number): unknown {
  if (data.byteLength > limit || data.byteLength < 2 || data[0] === 0xef
      || data[data.length - 1] !== 10 || data.subarray(0, -1).includes(10)) bad();
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, -1));
    value = JSON.parse(text);
  } catch { bad(); }
  if (!record(value) || !canonicalFrame(value,limit).equals(data)) bad();
  return value;
}
export function validRelative(path: unknown): path is string {
  return str(path,1024) && path.length > 0 && !path.startsWith('/')
    && !path.includes('\\') && path.split('/').every(x => x.length > 0 && x !== '.' && x !== '..'
      && !x.startsWith('.') && !x.includes(':'));
}
export function validRequest(v: unknown): asserts v is IngestRequest {
  if (!exact(v,['protocolVersion','requestId','operation','rootPath','sourcePath',
    'scopeId','expectedSha256','profileId','deadlineUnixMs','tokenizerSnapshot',
    'tessdataPath','artifactsPath']) || v.protocolVersion !== INGEST_VERSION
    || v.operation !== 'ingest' || !/^[0-9a-f]{48}$/.test(String(v.requestId))
    || !validRelative(v.sourcePath) || !isDigest(v.scopeId) || !isDigest(v.expectedSha256)
    || !uint(v.deadlineUnixMs) || v.deadlineUnixMs >= Number.MAX_SAFE_INTEGER
    || !['oks-advanced-markdown-v1','docling-docx-2.151.1','docling-native-pdf-2.151.1',
        'tesseract-cli-5.3.4-eng-rus','docling-heron-tableformer-fast-2.151.1',
        'docling-heron-tableformer-fast-tesseract-2.151.1'].includes(String(v.profileId))) bad();
  for (const key of ['rootPath','tokenizerSnapshot','tessdataPath','artifactsPath'] as const) {
    const value = v[key];
    if (value === null && (key === 'tessdataPath' || key === 'artifactsPath')) continue;
    if (!str(value) || !value.startsWith('/') || value === '/'
      || value.includes('\\') || value.split('/').slice(1).some(p => p === '.' || p === '..')) bad();
  }
  const suffix = v.profileId === 'oks-advanced-markdown-v1' ? '.md'
    : v.profileId === 'docling-docx-2.151.1' ? '.docx' : '.pdf';
  if (!v.sourcePath.toLowerCase().endsWith(suffix)) bad();
}
function validLocator(v: unknown, sha256: string, order: number, sourceType: string): v is IngestLocator {
  if (!fields(v,['locatorKind','sourceVersion','blockOrder','byteStart','byteEnd','charStart','charEnd',
    'lineStart','lineEnd','nativeItemRef','nativeRepresentation','contentLayer',
    'locations','table','row','diagnostics'],['rowRange','colRange','cellBBox','cellCoordinateOrigin'])
    || v.sourceVersion !== sha256 || v.blockOrder !== order
    || !['markdown','native','unavailable'].includes(String(v.locatorKind))
    || !maybe(v.table,uint) || !maybe(v.row,uint) || !strs(v.diagnostics,64,128)
    || !Array.isArray(v.locations) || v.locations.length > 32) return false;
  if (!v.locations.every(location =>
    exact(location,['page','bbox','coordinateOrigin','charStart','charEnd'])
    && uint(location.page) && location.page > 0 && validNativeBox(location.bbox)
    && ['TOPLEFT','BOTTOMLEFT'].includes(String(location.coordinateOrigin))
    && maybe(location.charStart,uint) && maybe(location.charEnd,uint)
    && (location.charStart === null && location.charEnd === null ||
        uint(location.charStart) && uint(location.charEnd) && location.charEnd >= location.charStart))) return false;
  if (v.locatorKind === 'markdown') {
    return sourceType === 'markdown' && [v.byteStart,v.byteEnd,v.charStart,v.charEnd].every(uint)
      && [v.lineStart,v.lineEnd].every(x=>uint(x) && x>0)
      && (v.byteEnd as number) >= (v.byteStart as number)
      && (v.charEnd as number) >= (v.charStart as number)
      && v.nativeItemRef === null && v.nativeRepresentation === null && v.contentLayer === null
      && v.locations.length === 0;
  }
  if ([v.byteStart,v.byteEnd,v.lineStart,v.lineEnd,v.charStart,v.charEnd].some(x=>x !== null)
      || sourceType === 'markdown') return false;
  if (v.locatorKind === 'native' && (!str(v.nativeItemRef,512) || !v.nativeItemRef
      || !str(v.nativeRepresentation,128) || !str(v.contentLayer,128))) return false;
  if (v.locatorKind === 'unavailable' && v.nativeItemRef !== null) return false;
  for (const key of ['rowRange','colRange'] as const) {
    const span=v[key];
    if (span !== undefined && span !== null &&
        (!Array.isArray(span) || span.length !== 2 || !span.every(uint)
         || span[1]! <= span[0]!)) return false;
  }
  const bbox=v.cellBBox;
  const origin=v.cellCoordinateOrigin;
  if (bbox !== undefined && bbox !== null) {
    if (v.locatorKind!=='native' || !validNativeBox(bbox)
      || (origin!=='TOPLEFT' && origin!=='BOTTOMLEFT')
      || !v.rowRange || !v.colRange) return false;
  } else if (origin !== undefined && origin !== null) return false;
  if (v.locatorKind!=='native' && (v.rowRange || v.colRange || bbox || origin)) return false;
  return true;
}
function validateBlock(block: unknown, index: number, source: IngestSource): void {
  if (!exact(block,['sourceId','sourceSha256','blockId','order','kind','originalText','headings',
      'wikiLinks','clause','textNature','locator','cells'])
      || block.sourceId !== source.sourceId || block.sourceSha256 !== source.sha256
      || block.order !== index || !isDigest(block.blockId) || !str(block.kind,128)
      || !str(block.originalText,1024*1024) || !strs(block.headings,64,4096)
      || !strs(block.wikiLinks,512,1024) || !maybe(block.clause,x=>str(x,128))
      || !['verbatim','table-cell-serialization'].includes(String(block.textNature))
      || !validLocator(block.locator,source.sha256,index,source.sourceType)
      || !Array.isArray(block.cells) || block.cells.length > 2048) bad();
  if (!block.cells.every(cell => fields(cell,['column','originalText','locator'])
    && Object.keys(cell).length === 3 && uint(cell.column) && cell.column > 0
    && str(cell.originalText,65536) && validLocator(cell.locator,source.sha256,index,source.sourceType))) bad();
  if (block.textNature === 'table-cell-serialization' && !block.cells.length) bad();
  if (source.sourceType === 'pdf' && block.originalText.length && block.locator.locatorKind === 'native'
      && block.locator.locations.length === 0 &&
      !block.locator.diagnostics.includes('native-page-location-missing')) bad();
}
export function validateReply(v: unknown, req: IngestRequest): asserts v is IngestResponse {
  validRequest(req);
  if (!exact(v,['protocolVersion','requestId','operation','status','source',
    'chunks','generationId','diagnostics','error'])
    || v.protocolVersion !== INGEST_VERSION || v.operation !== 'ingest'
    || v.requestId !== req.requestId
    || !['ok','partial','empty','failed','unsupported'].includes(String(v.status))
    || !strs(v.diagnostics,128,128) || !maybe(v.error,x=>str(x,128))
    || !Array.isArray(v.chunks) || v.chunks.length > 10000
    || !maybe(v.generationId,isDigest)) bad();
  if (v.source === null) {
    if (v.chunks.length || v.generationId !== null || !['failed','unsupported'].includes(String(v.status))) bad();
    return;
  }
  const s = v.source;
  if (!exact(s,['sourceId','vaultRelativePath','sha256','sourceType','scopeId','profileId',
        'extractionStatus','properties','wikiLinks','diagnostics','pageCount','blocks'])
    || s.sourceId !== req.sourcePath || s.vaultRelativePath !== req.sourcePath
    || s.sha256 !== req.expectedSha256 || s.scopeId !== req.scopeId
    || s.profileId !== req.profileId || !['markdown','pdf','docx'].includes(String(s.sourceType))
    || s.sourceType !== (req.profileId === 'oks-advanced-markdown-v1' ? 'markdown'
      : req.profileId === 'docling-docx-2.151.1' ? 'docx' : 'pdf')
    || s.extractionStatus !== v.status || !strs(s.wikiLinks,8192,1024)
    || !strs(s.diagnostics,256,128) || !maybe(s.pageCount,x=>uint(x) && x>0)
    || !Array.isArray(s.properties) || s.properties.length > 64
    || !s.properties.every(x=>validProperty(x) && record(x) && Object.keys(x).length===3)
    || !Array.isArray(s.blocks) || s.blocks.length > 8192) bad();
  const source = s as IngestSource;
  source.blocks.forEach((block,index) => validateBlock(block,index,source));
  if (v.status !== 'ok' && v.status !== 'partial') {
    if (v.chunks.length || v.generationId !== null) bad();
  }
  if (v.status === 'ok' && source.blocks.some(block => block.locator.locatorKind === 'unavailable'
      && block.originalText.trim())) bad();
  const ids = new Set<string>();
  for (const chunk of v.chunks) {
    if (!exact(chunk,['chunkId','sourceId','sourceSha256','profileId','sourceSlices',
      'sourceLocators','originalText','contextualText','chunkPolicyId','serializationId',
      'tokenizerFingerprint','effectiveTokenCount','diagnostics'])
      || !isDigest(chunk.chunkId) || ids.has(chunk.chunkId)
      || chunk.sourceId !== source.sourceId || chunk.sourceSha256 !== source.sha256
      || chunk.profileId !== source.profileId || chunk.chunkPolicyId !== 'structure'
      || !str(chunk.serializationId,128) || !isDigest(chunk.tokenizerFingerprint)
      || !uint(chunk.effectiveTokenCount) || chunk.effectiveTokenCount > 384
      || !strs(chunk.diagnostics,128,128)
      || !str(chunk.originalText,1024*1024) || !str(chunk.contextualText,1024*1024)
      || !Array.isArray(chunk.sourceSlices) || chunk.sourceSlices.length === 0
      || !Array.isArray(chunk.sourceLocators)
      || chunk.sourceLocators.length !== chunk.sourceSlices.length) bad();
    ids.add(chunk.chunkId);
    const pieces: string[] = [];
    chunk.sourceSlices.forEach((slice,index)=>{
      if (!exact(slice,['blockOrder','charStart','charEnd']) || !uint(slice.blockOrder)
        || !uint(slice.charStart) || !uint(slice.charEnd)
        || slice.charEnd <= slice.charStart) bad();
      const block = source.blocks[slice.blockOrder];
      if (!block || slice.charEnd > Array.from(block.originalText).length) bad();
      pieces.push(Array.from(block.originalText).slice(slice.charStart,slice.charEnd).join(''));
      if (!validLocator((chunk.sourceLocators as unknown[])[index],source.sha256,slice.blockOrder,source.sourceType)) bad();
    });
    if (pieces.join('\n') !== chunk.originalText
      || !chunk.contextualText.includes(chunk.originalText)) bad();
  }
  const identity = v.status === 'ok' || v.status === 'partial'
    ? sha(canonical([INGEST_VERSION, source.scopeId, source.sha256, source.profileId,
        v.chunks.map(chunk => chunk.chunkId)])) : null;
  if (v.generationId !== identity) bad();
}
export function parseIngestFrame(buffer: Buffer, req: IngestRequest): IngestResponse {
  const frame = decodeFrame(buffer,MAX_RESPONSE);
  validateReply(frame,req);
  return frame;
}
