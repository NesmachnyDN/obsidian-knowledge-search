import { BOUNDS, hash, isDigest, StandaloneError, validPath, type EvidenceHit } from '../standalone/contracts';
import type { SourceProvider } from '../standalone/source';

export type Position = { line: number; ch: number };
export type VerifiedSpan = { text: string; from: Position; to: Position };
/** Pure validation of original raw bytes, Unicode codepoints and physical lines. */
export function verifySpan(hit: EvidenceHit, bytes: Uint8Array): VerifiedSpan {
  const reject = (): never => { throw new StandaloneError('NAVIGATION_REJECTED'); };
  if (!validPath(hit.sourceId) || !isDigest(hit.sourceSha256) || bytes.length > BOUNDS.fileBytes
    || hash(bytes) !== hit.sourceSha256 || !Array.isArray(hit.sourceLocators) || hit.sourceLocators.length !== 1
    || typeof hit.originalExcerpt !== 'string') return reject();
  const loc = hit.sourceLocators[0]!;
  if (!loc || loc.locatorKind !== 'markdown' || loc.sourceVersion !== hit.sourceSha256
    || !['byteStart','byteEnd','charStart','charEnd','lineStart','lineEnd','blockOrder'].every(k =>
      Number.isSafeInteger(loc[k as keyof typeof loc]) && Number(loc[k as keyof typeof loc]) >= 0)
    || loc.byteEnd <= loc.byteStart || loc.byteEnd > bytes.length || loc.charEnd <= loc.charStart
    || loc.lineStart < 1 || loc.lineEnd !== loc.lineStart) return reject();
  try {
    const decode = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
    const text = decode(bytes), prefix = decode(bytes.subarray(0, loc.byteStart));
    const excerpt = decode(bytes.subarray(loc.byteStart, loc.byteEnd));
    const lines = text.split(/\r\n|\r|\n/);
    if (excerpt !== hit.originalExcerpt || [...prefix].length !== loc.charStart
      || [...excerpt].length !== loc.charEnd - loc.charStart || /[\r\n]/.test(excerpt)
      || prefix.split(/\r\n|\r|\n/).length !== loc.lineStart
      || lines[loc.lineStart - 1] !== excerpt || (prefix !== '' && !/[\r\n]$/.test(prefix))) return reject();
    return { text, from: { line: loc.lineStart - 1, ch: 0 }, to: { line: loc.lineEnd - 1, ch: excerpt.length } };
  } catch { return reject(); }
}
export interface NavigationPort<File> {
  exact(path: string): File | null;
  open(file: File, guard: () => void): Promise<{ text(): string; select(from: Position, to: Position, guard: () => void): void }>;
}
export class SourceNavigator<File> {
  private revision = 0;
  private disposed = false;
  constructor(private readonly provider: Pick<SourceProvider, 'read'>, private readonly port: NavigationPort<File>) {}
  invalidate(): void { this.revision++; }
  dispose(): void { this.disposed = true; this.invalidate(); }
  async open(hit: EvidenceHit): Promise<void> {
    // Snapshot caller-owned evidence before crossing an asynchronous boundary.
    const value = structuredClone(hit);
    const revision = ++this.revision;
    const file = validPath(value.sourceId) ? this.port.exact(value.sourceId) : null;
    const current = (): boolean => !this.disposed && revision === this.revision;
    const guard = (): void => {
      if (!file || !current() || this.port.exact(value.sourceId) !== file || !current())
        throw new StandaloneError('NAVIGATION_REJECTED');
    };
    const read = async (): Promise<VerifiedSpan> => {
      guard();
      const bytes = await this.provider.read(value.sourceId);
      guard();
      return verifySpan(value, bytes);
    };
    await read(); guard();
    // Fresh read immediately before open; no async action between guard and open.
    await read(); guard();
    const editor = await this.port.open(file!, guard); guard();
    const span = await read(); guard();
    // Obsidian editors normalize line endings. Unsaved edits still revoke selection.
    if (editor.text().replace(/\r\n|\r/g, '\n') !== span.text.replace(/\r\n|\r/g, '\n'))
      throw new StandaloneError('NAVIGATION_REJECTED');
    guard();
    editor.select(span.from, span.to, guard);
  }
}
