import { BOUNDS, hash, validPath, type ParsedBlock, type SourceLocator, type SourceVersion } from './contracts';
import { frontmatter, unambiguousPropertyLines, valueOf } from './markdown-parse';
import { graphText } from './graph-mapping';

export type GraphAnchor = Readonly<{ sourceId: string; sourceSha256: string; blockId: string; locator: Readonly<SourceLocator> }>;
export type AuthoredValue = Readonly<{ value: string; anchors: readonly GraphAnchor[] }>;
export type PropertyRead = { state: 'missing' } | { state: 'unsupported' } | { state: 'ok'; values: AuthoredValue[] };
export type Coverage = Record<string, number>;
export const bump = (coverage: Coverage, reason: string, n = 1): void => { coverage[reason] = (coverage[reason] ?? 0) + n; };
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/u;

function anchor(doc: SourceVersion, block: ParsedBlock): GraphAnchor | null {
  const loc = block.locator;
  if (block.sourceId !== doc.sourceId || block.sourceSha256 !== doc.sha256 || loc.sourceVersion !== doc.sha256
    || loc.blockOrder !== block.order || loc.byteEnd > BOUNDS.fileBytes || loc.byteEnd <= loc.byteStart
    || loc.byteEnd - loc.byteStart !== Buffer.byteLength(block.originalText)
    || loc.charEnd - loc.charStart !== [...block.originalText].length
    || loc.lineStart !== block.order + 1 || loc.lineEnd !== loc.lineStart
    || block.blockId !== hash(JSON.stringify([doc.sourceId, doc.sha256, block.order, loc.byteStart, loc.byteEnd]))) return null;
  return { sourceId: doc.sourceId, sourceSha256: doc.sha256, blockId: block.blockId, locator: {...loc} };
}

/** Canonical typed Properties are authoritative only within the parser's
 * supported original grammar. A malformed catalog is not a unique-ID proof. */
export function completeMetadata(doc: SourceVersion): boolean {
  if (doc.extractionStatus !== 'ok' && doc.extractionStatus !== 'partial' && doc.extractionStatus !== 'empty') return false;
  if (doc.diagnostics.some(x => x === 'invalid-front-matter' || x === 'unterminated-front-matter')) return false;
  const first = doc.blocks[0]?.originalText ?? '';
  const firstNonempty = doc.blocks.find(b => b.originalText.trim() !== '')?.originalText.trim() ?? '';
  if (first !== '---') return !/^(?:---|\.\.\.|%)/.test(firstNonempty) && doc.properties.length === 0;
  const end = doc.blocks.findIndex((b,i) => i > 0 && b.originalText === '---');
  if (end < 1) return false;
  const lines = doc.blocks.slice(1, end).map(b => b.originalText);
  const parsed = frontmatter(lines);
  return parsed.valid && unambiguousPropertyLines(lines)
    && JSON.stringify(parsed.properties) === JSON.stringify(doc.properties);
}

export function readProperty(doc: SourceVersion, key: string | undefined, scalarOnly = false): PropertyRead {
  if (key === undefined) return { state: 'missing' };
  const p = doc.properties.find(x => x.key === key);
  if (!p) return { state: 'missing' };
  const values = p.valueType === 'string' && graphText(p.value, 1024) ? [p.value]
    : !scalarOnly && p.valueType === 'list' && Array.isArray(p.value) && p.value.every(v => graphText(v, 1024)) ? p.value as string[]
      : null;
  if (!values) return { state: 'unsupported' };
  const indexes = doc.blocks.flatMap((b,i) => b.kind === 'property' && b.originalText.startsWith(key + ':') ? [i] : []);
  if (indexes.length !== 1) return { state: 'unsupported' };
  const i = indexes[0]!, first = doc.blocks[i]!, firstAnchor = anchor(doc, first);
  if (!firstAnchor) return { state: 'unsupported' };
  const raw = first.originalText.slice(key.length + 1).trim();
  if (p.valueType === 'list' && !raw) {
    const items = doc.blocks.slice(i + 1, i + 1 + values.length);
    const next = doc.blocks[i + 1 + values.length];
    if (items.length !== values.length || items.some(b => b.kind !== 'property' || !/^ {2,}- /.test(b.originalText))
      || (next?.kind === 'property' && /^ {2,}- /.test(next.originalText))) return { state: 'unsupported' };
    // The aggregate list loses individual scalar types. Reuse the canonical
    // interpreter on each authored line: an unquoted date is not an identifier.
    if (items.some((b,j) => {
      try { const item = valueOf(b.originalText.replace(/^ {2,}- /,''));
        return item.valueType !== 'string' || item.value !== values[j]; }
      catch { return true; }
    })) return { state: 'unsupported' };
    const itemAnchors = items.map(b => anchor(doc,b));
    if (itemAnchors.some(a => !a)) return { state: 'unsupported' };
    return { state: 'ok', values: values.map((value,j) => ({ value, anchors: [firstAnchor,itemAnchors[j]!] })) };
  }
  if (p.valueType === 'list' && !raw.startsWith('[')) return { state: 'unsupported' };
  return { state: 'ok', values: values.map(value => ({ value, anchors: [firstAnchor] })) };
}

/** Only canonical exact paths or unambiguous basename/alias tokens, never
 * fragments, embeds, URLs, traversal or relative-resolution guesses. */
export function wikiTarget(raw: string): string | null {
  const match = /^\[\[([^\[\]|#\\]+)(?:\|([^\[\]|#\\]+))?\]\]$/u.exec(raw);
  if (!match || !graphText(match[1],1024) || (match[2] !== undefined && (!graphText(match[2],1024) || CONTROL.test(match[2])))) return null;
  const value = match[1]!;
  if (!validPath(value) && !validPath(value + '.md')) return null;
  if (/[<>"!?*%]/u.test(value)) return null;
  return value;
}
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Deliberately conservative supported Markdown subset. Unsupported multiline
 * markup could conceal links on later lines, so the entire navigation-only
 * part of that document is marked unsupported instead of guessing. */
export async function navigationValues(doc: SourceVersion, coverage: Coverage, checkpoint: () => Promise<void>,
  check: () => void): Promise<AuthoredValue[]> {
  check();
  if (doc.diagnostics.includes('unterminated-front-matter')) { bump(coverage,'unsupported-navigation-document'); return []; }
  const result: AuthoredValue[] = [];
  let fence: string | null = null, uncertain = false;
  for (const b of doc.blocks) {
    await checkpoint(); check();
    if (b.kind === 'property') continue;
    const line = b.originalText, marker = FENCE.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
      if (b.wikiLinks.length) bump(coverage,'unsupported-navigation-markup',b.wikiLinks.length);
      continue;
    }
    if (marker) {
      if (marker[1]![0] === '`' && marker[2]!.includes('`')) uncertain = true;
      fence = marker[1]!;
      if (b.wikiLinks.length) bump(coverage,'unsupported-navigation-markup',b.wikiLinks.length);
      continue;
    }
    // No HTML/comments, blockquote/list-container nesting or multiline code
    // guesses. Balanced single-line code also excludes that entire line.
    if (/[<>]|%%|\]\(/.test(line) || /^\s*>|^(?: {4}|\t)|^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) uncertain = true;
    if (line.includes('`')) {
      const runs = line.match(/`+/g) ?? [];
      let opening: string | null = null;
      for (const run of runs) { if (opening === null) opening = run; else if (opening === run) opening = null; }
      if (opening !== null) uncertain = true;
      if (b.wikiLinks.length) bump(coverage,'unsupported-navigation-markup',b.wikiLinks.length);
      continue;
    }
    for (const match of line.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const at = match.index, raw = match[0]!;
      if (at > 0 && /[!\\\[]/.test(line[at-1]!) || line[at+raw.length] === ']') { bump(coverage,'unsupported-link'); continue; }
      const value = wikiTarget(raw), a = anchor(doc,b);
      if (!value || !a) { bump(coverage,'unsupported-link'); continue; }
      result.push({ value, anchors: [a] });
    }
    if (line.includes('[[') && !b.wikiLinks.length) bump(coverage,'unsupported-link');
  }
  check();
  if (uncertain || fence) { bump(coverage,'unsupported-navigation-document'); return []; }
  return result;
}
