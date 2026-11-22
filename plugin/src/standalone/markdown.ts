import { hash, type SourceVersion } from './contracts';
import { parseWithDigest } from './markdown-parse';
export { terms } from './markdown-parse';

// Independent Node/reference entry for direct conformance fixtures. Product
// indexing calls parseWithDigest ONLY inside the browser Web Worker.
export function parseMarkdown(path: string, data: Uint8Array, rootId: string): SourceVersion {
  const doc = parseWithDigest(path, data, rootId, hash(data));
  for (const block of doc.blocks) {
    const loc = block.locator;
    block.blockId = hash(JSON.stringify([path, doc.sha256, block.order, loc.byteStart, loc.byteEnd]));
  }
  return doc;
}
