// Independently authored v1 contract; no filesystem or host SDK dependency.
export const LIMITS = { frame: 65536, source: 8192, query: 256, stderr: 4096 } as const;
export const FIXTURE_ID = 'oks-01a-note';
export const FIXTURE_DIGEST = '30e43a740cf91aaa7873fb97e6527e773d729ec21c5e7770decbce1695f9a360';
export const FIXTURE_PATH = 'oks-synthetic/evidence.md';
export const QUERY = 'MATCH-01:';
export type Request = {
  version: 1; id: string; method: 'probe';
  source: { id: string; digest: string; text: string }; query: string;
};
export type Evidence = { sourceId: string; digest: string; line: number; excerpt: string };
export const ERROR_CODES = ['INVALID_REQUEST', 'UNSUPPORTED_VERSION', 'UNSUPPORTED_METHOD', 'FIXTURE_REJECTED'] as const;
export type Response = { version: 1; id: string; ok: true; evidence: Evidence | null }
  | { version: 1; id: string | null; ok: false; error: { code: typeof ERROR_CODES[number] } };
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
export function utf8(value: unknown, max: number, nonempty = false): value is string {
  return typeof value === 'string' && (!nonempty || value.length > 0)
    && value.length <= max && Buffer.byteLength(value, 'utf8') <= max
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}(?![\s\S])/.test(value);
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value);
}
export function isRequest(value: unknown): value is Request {
  if (!object(value) || !keys(value, ['version', 'id', 'method', 'source', 'query'])) return false;
  const s = value.source;
  return value.version === 1 && id(value.id) && value.method === 'probe'
    && object(s) && keys(s, ['id', 'digest', 'text']) && s.id === FIXTURE_ID
    && digest(s.digest) && utf8(s.text, LIMITS.source) && utf8(value.query, LIMITS.query, true);
}
export function isResponse(value: unknown): value is Response {
  if (!object(value) || value.version !== 1) return false;
  if (value.ok === false) return keys(value, ['version', 'id', 'ok', 'error'])
    && (value.id === null || id(value.id)) && object(value.error)
    && keys(value.error, ['code']) && ERROR_CODES.some(code => code === (value.error as Record<string, unknown>).code);
  if (value.ok !== true || !id(value.id) || !keys(value, ['version', 'id', 'ok', 'evidence'])) return false;
  const e = value.evidence;
  return e === null || (object(e) && keys(e, ['sourceId', 'digest', 'line', 'excerpt'])
    && e.sourceId === FIXTURE_ID && digest(e.digest) && Number.isInteger(e.line)
    && (e.line as number) >= 1 && (e.line as number) <= LIMITS.source + 1
    && utf8(e.excerpt, LIMITS.source) && !/[\r\n]/.test(e.excerpt));
}
export function encodeFrame(value: Request | Response): Buffer {
  const data = Buffer.from(JSON.stringify(value) + '\n', 'utf8');
  if (data.length > LIMITS.frame) throw new Error('FRAME_LIMIT');
  return data;
}
export function decodeFrame(data: Buffer): unknown {
  if (!data.length || data.length > LIMITS.frame || data[data.length - 1] !== 10
      || data.subarray(0, -1).includes(10)) throw new Error('INVALID_FRAME');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  const value: unknown = JSON.parse(text); // Validate syntax before scanning keys.
  // JSON.parse discards duplicate fields. Scan structural tokens while preserving
  // escaped strings, so duplicate decoded names are rejected at every depth.
  const stack: (Set<string> | null)[] = [];
  const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]:]/g;
  for (const token of text.matchAll(tokens)) {
    const word = token[0];
    if (word === '{') stack.push(new Set());
    else if (word === '[') stack.push(null);
    else if (word === '}' || word === ']') stack.pop();
    else if (word.startsWith('"') && /^\s*:/.test(text.slice(token.index + word.length))) {
      const key = JSON.parse(word) as string;
      const keys = stack.at(-1);
      if (!keys || keys.has(key)) throw new Error('DUPLICATE_FIELD');
      keys.add(key);
    }
  }
  return value;
}
// CRLF, LF and CR delimit lines; a trailing delimiter does not create evidence.
export function firstMatch(text: string, query: string): { line: number; excerpt: string } | null {
  const lines = text.split(/\r\n|\n|\r/);
  const index = lines.findIndex(line => line.includes(query));
  return index < 0 ? null : { line: index + 1, excerpt: lines[index]! };
}
export function verifyResponse(value: unknown, request: Request): Response {
  if (!isResponse(value) || value.id !== request.id) throw new Error('INVALID_RESPONSE');
  if (value.ok) {
    const match = firstMatch(request.source.text, request.query);
    const e = value.evidence;
    if (match === null ? e !== null : e === null || e.sourceId !== request.source.id
      || e.digest !== request.source.digest || e.line !== match.line || e.excerpt !== match.excerpt) {
      throw new Error('INVALID_EVIDENCE');
    }
  }
  return value;
}
