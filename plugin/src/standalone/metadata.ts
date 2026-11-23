/** Bounded, local, source-authored tag and wiki-link metadata predicates.
 * No Obsidian link graph inference, network requests or derived text in evidence.
 */
import type { ParsedBlock, Predicate, SourceVersion, SearchMetadata } from './contracts';

const norm = (value: string): string => value.toLowerCase();
const tagValue = (value: string): string => norm(value.replace(/^#/, ''));
const TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Only inspect Markdown lines outside fenced code and parsed frontmatter. */
function bodyBlocks(doc: SourceVersion): ParsedBlock[] {
  const result: ParsedBlock[] = [];
  let fence: string | null = null;
  for (const block of doc.blocks) {
    const marker = FENCE.exec(block.originalText);
    if (fence !== null) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length
        && !block.originalText.slice(marker[0].length).trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]!; continue; }
    if (block.kind !== 'property' && block.kind !== 'blank') result.push(block);
  }
  return result;
}
function propertyAnchor(doc: SourceVersion, key: string): ParsedBlock | null {
  return doc.blocks.find(block => block.kind === 'property'
    && block.originalText.startsWith(key + ':')) ?? null;
}
function frontmatterTag(doc: SourceVersion, wanted: string): ParsedBlock | null {
  const field = doc.properties.find(p => p.key === 'tags');
  if (!field) return null;
  const values = field.valueType === 'list' && Array.isArray(field.value)
    ? field.value : field.valueType === 'string' && typeof field.value === 'string'
      ? [field.value] : [];
  return values.some(value => typeof value === 'string' && tagValue(value) === wanted)
    ? propertyAnchor(doc, 'tags') : null;
}
function inlineTag(block: ParsedBlock, wanted: string): boolean {
  // Reset regexp state by using matchAll; headings such as "# Heading" are not tags.
  return [...block.originalText.matchAll(TAG)].some(match => tagValue(match[1]!) === wanted);
}
function linkTarget(block: ParsedBlock, wanted: string): boolean {
  return block.wikiLinks.some(raw => raw.split('|', 1)[0]!.trim() === wanted);
}

/** Return a *real source line* for metadata-only navigation, or null when filters miss.
 * For nonempty text queries the return value is only used as a metadata predicate.
 */
export function metadataAnchor(doc: SourceVersion,
  metadata: SearchMetadata | undefined, predicates: readonly Predicate[]): ParsedBlock | null {
  const blocks = bodyBlocks(doc);
  let tag: ParsedBlock | null = null;
  let link: ParsedBlock | null = null;
  if (metadata?.tag !== undefined) {
    const wanted = tagValue(metadata.tag);
    tag = blocks.find(block => inlineTag(block, wanted)) ?? frontmatterTag(doc, wanted);
    if (!tag) return null;
  }
  if (metadata?.linkTarget !== undefined) {
    const wanted = metadata.linkTarget;
    link = blocks.find(block => linkTarget(block, wanted)) ?? null;
    if (!link) return null;
  }
  if (link) return link;
  if (tag) return tag;
  // Metadata-only typed Property queries must cite a concrete frontmatter line.
  for (const predicate of predicates) {
    const anchor = propertyAnchor(doc, predicate.key);
    if (anchor) return anchor;
  }
  return null;
}
