import { BOUNDS, SCHEMA, StandaloneError } from './shared';
import type { ParsedBlock, Scalar, SourceVersion, TypedProperty } from './contracts';

// Preserve technical identifiers as a whole and also their useful components.
// No stemming, generated context, model vectors or query-language evaluation.
const TOKEN = /[\p{L}\p{N}]+(?:[._/-][\p{L}\p{N}]+)*/gu;
export function terms(text: string): string[] {
  const matches = text.toLowerCase().match(TOKEN) ?? [];
  const result = new Set<string>();
  for (const item of matches) {
    result.add(item);
    for (const part of item.split(/[._/-]/)) if (part) result.add(part);
    if (result.size > BOUNDS.indexedTermsPerBlock) throw new StandaloneError('INDEX_LIMIT');
  }
  return [...result];
}

function parseScalar(raw: string): Scalar {
  const v = raw.trim();
  if (!v || v === 'null' || v === '~') return null;
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)) {
    const number = Number(v);
    if (!Number.isFinite(number)) throw new StandaloneError('PROPERTY_INCOMPATIBLE');
    return number;
  }
  if (v.startsWith('"')) {
    const parsed: unknown = JSON.parse(v);
    if (typeof parsed !== 'string') throw new StandaloneError('PROPERTY_INCOMPATIBLE');
    return parsed;
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    return v.slice(1, -1).replace(/''/g, "'");
  if (/[\[\]{}&*!]|\0/.test(v) || v.startsWith('>') || v.startsWith('|')
      || v.includes('# ') || v.includes(': ')) throw new StandaloneError('PROPERTY_INCOMPATIBLE');
  return v;
}
function typeOf(value: Scalar): TypedProperty['valueType'] {
  if (value === null) return 'null';
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value)
    ? 'date' : 'string';
  return typeof value === 'number' ? 'number' : 'boolean';
}
function valueOf(raw: string): { value: Scalar | Scalar[]; valueType: TypedProperty['valueType'] } {
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) throw new StandaloneError('PROPERTY_INCOMPATIBLE');
    // Only explicit JSON-style inline lists; YAML aliases/maps are forbidden.
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v) || v.length > BOUNDS.listItems || v.some(x =>
      x !== null && typeof x !== 'string' && typeof x !== 'boolean' && !(typeof x === 'number' && Number.isFinite(x)))) {
      throw new StandaloneError('PROPERTY_INCOMPATIBLE');
    }
    return { value: v as Scalar[], valueType: 'list' };
  }
  const value = parseScalar(raw);
  // Quoted YAML text is always a string, including ISO dates and 'null'.
  return { value, valueType: raw.startsWith('"') || raw.startsWith("'") ? 'string' : typeOf(value) };
}
function frontmatter(lines: string[]): { properties: TypedProperty[]; valid: boolean } {
  const result: TypedProperty[] = [];
  const keys = new Set<string>();
  try {
    for (let i = 0; i < lines.length; i++) {
      const match = /^([A-Za-z_][\w-]*):(?:[ \t]*(.*))?$/.exec(lines[i]!);
      if (!match) throw new StandaloneError('PROPERTY_INCOMPATIBLE');
      const key = match[1]!, raw = (match[2] ?? '').trim();
      if (new TextEncoder().encode(key).length > BOUNDS.propertyBytes || keys.has(key))
        throw new StandaloneError('PROPERTY_INCOMPATIBLE');
      keys.add(key);
      if (keys.size > BOUNDS.propertiesPerSource) throw new StandaloneError('PROPERTY_INCOMPATIBLE');
      if (!raw && i + 1 < lines.length && /^ {2,}- /.test(lines[i+1]!)) {
        const list: Scalar[] = [];
        while (i + 1 < lines.length && /^ {2,}- /.test(lines[i+1]!)) {
          const item = lines[++i]!.replace(/^ {2,}- /, '');
          const parsed = valueOf(item);
          if (parsed.valueType === 'list' || parsed.valueType === 'date' && item.startsWith('"'))
            throw new StandaloneError('PROPERTY_INCOMPATIBLE');
          list.push(parsed.value as Scalar);
          if (list.length > BOUNDS.listItems) throw new StandaloneError('PROPERTY_INCOMPATIBLE');
        }
        result.push({ key, valueType: 'list', value: list });
      } else {
        result.push({ key, ...valueOf(raw) });
      }
    }
    return { properties: result, valid: true };
  } catch {
    return { properties: [], valid: false };
  }
}
type Line = { text: string; start: number; end: number; charStart: number; charEnd: number; number: number };
function physicalLines(raw: Uint8Array): Line[] {
  let contents: string;
  try { contents = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { throw new StandaloneError('INVALID_UTF8'); }
  if (contents.startsWith('\ufeff') || contents.includes('\0')) throw new StandaloneError('INVALID_UTF8');
  const lines: Line[] = [];
  let offset = 0, chars = 0;
  // Delimiters are excluded from line evidence, included in subsequent offsets.
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  for (const match of contents.matchAll(pattern)) {
    const full = match[0]!;
    if (!full) break;
    const delimiter = full.endsWith('\r\n') ? 2 : /[\r\n]$/.test(full) ? 1 : 0;
    const text = full.slice(0, full.length - delimiter);
    if (lines.length >= BOUNDS.blocksPerSource) throw new StandaloneError('SOURCE_LIMIT');
    const bytes = new TextEncoder().encode(text).length;
    const charCount = [...text].length;
    lines.push({ text, start: offset, end: offset + bytes,
      charStart: chars, charEnd: chars + charCount, number: lines.length + 1 });
    offset += new TextEncoder().encode(full).length;
    chars += [...full].length;
  }
  if (offset !== raw.byteLength) throw new StandaloneError('INVALID_UTF8');
  return lines;
}
const HEADING = /^(#{1,6})[ \t]+(.+)$/;
const CLAUSE = /^(REQ-[A-Za-z0-9-]+|[0-9]+(?:\.[0-9]+)+):/;
const LIST = /^\s*(?:[-+*]|\d+[.)])\s+/;
const TABLE = /^\|.*\|$/;
const SEPARATOR = /^\s*:?-{3,}:?\s*$/;
const LINKS = /\[\[([^\]\n]+)\]\]/g;
export function parseWithDigest(path: string, data: Uint8Array, rootId: string, sha: string): SourceVersion {
  if (data.byteLength > BOUNDS.fileBytes) throw new StandaloneError('SOURCE_LIMIT');
  const lines = physicalLines(data);
  const hasFront = lines[0]?.text === '---';
  const closing = hasFront ? lines.findIndex((line, i) => i > 0 && line.text === '---') : -1;
  const metadata = hasFront && closing > 0
    ? frontmatter(lines.slice(1, closing).map(l => l.text))
    : { properties: [], valid: !hasFront };
  const diagnostics: string[] = [];
  if (!metadata.valid) diagnostics.push(closing < 0 ? 'unterminated-front-matter' : 'invalid-front-matter');
  const blocks: ParsedBlock[] = [];
  const headings: { level: number; title: string }[] = [];
  const allLinks: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const inFront = hasFront && closing >= 0 && line.number <= closing + 1;
    let kind = !line.text.trim() ? 'blank' : inFront ? 'property' : 'paragraph';
    if (kind === 'paragraph') {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
      if (fence !== null) {
        if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length
            && !marker[2]!.trim()) fence = null;
      } else if (marker) {
        fence = marker[1]!;
        diagnostics.push('fenced-content-literal');
      } else if (/^(    |\t)/.test(line.text)) {
        diagnostics.push('unsupported-markup-literal');
      } else {
        const heading = HEADING.exec(line.text);
        const clause = CLAUSE.exec(line.text);
        if (heading) {
          const level = heading[1]!.length;
          while (headings.length && headings[headings.length-1]!.level >= level) headings.pop();
          headings.push({ level, title: heading[2]! });
          kind = 'heading';
        } else if (clause) kind = 'clause';
        else if (TABLE.test(line.text.trim())) {
          kind = line.text.split('|').slice(1,-1).every(cell => SEPARATOR.test(cell))
            ? 'table_separator' : 'table_row';
        } else if (LIST.test(line.text)) kind = 'list_item';
        else if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line.text)) diagnostics.push('unsupported-setext-heading');
      }
    }
    const links = [...line.text.matchAll(LINKS)].map(m => m[1]!);
    if (links.length > BOUNDS.wikiLinksPerBlock || allLinks.length + links.length > BOUNDS.wikiLinksPerSource)
      throw new StandaloneError('SOURCE_LIMIT');
    if (!inFront) allLinks.push(...links);
    const locator = { locatorKind: 'markdown' as const, sourceVersion: sha, blockOrder: blocks.length,
      byteStart: line.start, byteEnd: line.end, charStart: line.charStart, charEnd: line.charEnd,
      lineStart: line.number, lineEnd: line.number };
    blocks.push({ sourceId: path, sourceSha256: sha,
      blockId: '', // main thread adds SHA-256 identity after worker parsing
      order: blocks.length, kind, originalText: line.text,
      headings: headings.map(h => h.title), wikiLinks: links, locator,
      terms: ['blank','table_separator','property'].includes(kind) ? []
        : terms(headings.map(h => h.title).join(' ') + ' ' + line.text),
    });
  }
  if (fence) diagnostics.push('unterminated-fence');
  const extractionStatus = diagnostics.length ? 'partial' : lines.some(l => l.text.trim()) ? 'ok' : 'empty';
  return {
    sourceId: path, vaultRelativePath: path, sha256: sha, sourceType: 'markdown',
    scopeId: rootId, profileId: SCHEMA, extractionStatus,
    properties: metadata.properties, wikiLinks: [...new Set(allLinks)],
    diagnostics: [...new Set(diagnostics)].sort(), blocks,
  };
}
