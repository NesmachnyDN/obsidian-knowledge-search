import { BOUNDS, hash, isDigest, isRecord, validPath, validRange, StandaloneError,
  type OriginalRange, type SourceLocator } from './contracts';
import { physicalLines } from './markdown-parse';

export type EditorPosition = { line: number; utf16Column: number };
export type EditorSelection = {
  sourceId: string; sourceSha256: string; editorText: string;
  anchor: EditorPosition; head: EditorPosition;
};
const normalize = (value: string): string => value.replace(/\r\n|\r/g, '\n');
const decode = (bytes: Uint8Array): string => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new StandaloneError('INVALID_UTF8'); }
};
function authenticatedText(sourceSha256: string, raw: Uint8Array): string {
  if (raw.byteLength > BOUNDS.fileBytes) throw new StandaloneError('SOURCE_LIMIT');
  if (hash(raw) !== sourceSha256) throw new StandaloneError('SOURCE_STALE');
  const text = decode(raw);
  if (text.startsWith('\ufeff') || text.includes('\0')) throw new StandaloneError('INVALID_UTF8');
  return text;
}
function validPosition(value: unknown): value is EditorPosition {
  return isRecord(value) && typeof value.line === 'number' && Number.isSafeInteger(value.line) && value.line >= 0
    && typeof value.utf16Column === 'number' && Number.isSafeInteger(value.utf16Column) && value.utf16Column >= 0
    && Object.keys(value).every(key => key === 'line' || key === 'utf16Column');
}
/** Pure host-side coordinate conversion; the returned request carries no editor text. */
export function mapEditorRange(selection: EditorSelection, raw: Uint8Array): Readonly<OriginalRange> {
  if (!isRecord(selection) || !validPath(selection.sourceId) || !isDigest(selection.sourceSha256)
    || typeof selection.editorText !== 'string' || Buffer.byteLength(selection.editorText) > BOUNDS.fileBytes
    || !validPosition(selection.anchor) || !validPosition(selection.head)
    || Object.keys(selection).some(key => !['sourceId','sourceSha256','editorText','anchor','head'].includes(key)))
    throw new StandaloneError('INVALID_REQUEST');
  const original = authenticatedText(selection.sourceSha256, raw);
  if (normalize(original) !== normalize(selection.editorText)) throw new StandaloneError('SOURCE_STALE');
  const lines = physicalLines(raw);
  // The canonical parser excludes the synthetic empty terminal editor line.
  if (!lines.length || /[\r\n]$/.test(original)) {
    const chars = [...original].length;
    lines.push({text:'',start:raw.byteLength,end:raw.byteLength,charStart:chars,charEnd:chars,number:lines.length+1});
  }
  const endpoint = (position: EditorPosition) => {
    const line = lines[position.line];
    if (!line || position.utf16Column > line.text.length) throw new StandaloneError('INVALID_REQUEST');
    const previous = line.text.charCodeAt(position.utf16Column - 1), next = line.text.charCodeAt(position.utf16Column);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      throw new StandaloneError('INVALID_REQUEST');
    const prefix = line.text.slice(0, position.utf16Column);
    return {byte:line.start+Buffer.byteLength(prefix),chars:line.charStart+[...prefix].length};
  };
  const anchor = endpoint(selection.anchor), head = endpoint(selection.head);
  const [start,end] = anchor.byte <= head.byte ? [anchor,head] : [head,anchor];
  const result = {sourceId:selection.sourceId,sourceSha256:selection.sourceSha256,
    byteStart:start.byte,byteEnd:end.byte,charStart:start.chars,charEnd:end.chars};
  if (!validRange(result)) throw new StandaloneError('INVALID_REQUEST');
  return Object.freeze(result);
}
/** Reauthenticate the exact byte/code-point endpoints even for a forged caller request. */
export function verifyOriginalRange(range: OriginalRange, raw: Uint8Array): void {
  if (!validRange(range)) throw new StandaloneError('INVALID_REQUEST');
  const text = authenticatedText(range.sourceSha256,raw);
  if (range.byteEnd > raw.byteLength || range.charEnd > [...text].length) throw new StandaloneError('INVALID_REQUEST');
  for (const [byte,chars] of [[range.byteStart,range.charStart],[range.byteEnd,range.charEnd]] as const) {
    // A UTF-8 continuation byte or interior CRLF is never an editor boundary.
    if ((byte < raw.byteLength && (raw[byte]! & 0xc0) === 0x80)
      || (byte > 0 && raw[byte-1] === 13 && raw[byte] === 10)
      || [...decode(raw.subarray(0,byte))].length !== chars) throw new StandaloneError('INVALID_REQUEST');
  }
}
export function containsLocator(range: OriginalRange, locator: SourceLocator): boolean {
  return locator.locatorKind === 'markdown' && locator.sourceVersion === range.sourceSha256
    && locator.byteStart < locator.byteEnd && locator.charStart < locator.charEnd
    && range.byteStart <= locator.byteStart && locator.byteEnd <= range.byteEnd
    && range.charStart <= locator.charStart && locator.charEnd <= range.charEnd;
}
