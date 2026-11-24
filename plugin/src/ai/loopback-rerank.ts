import { Agent, request, type ClientRequest } from 'node:http';
import { isRecord } from '../standalone/contracts';
import { parsePreference } from './config';
import { ProviderFailure, type CallContext, type ProviderConfig, type AuthorizedCandidates } from './contracts';

export type RerankScore = { id: number; score: number };
const MAX_WIRE_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const fail = (code: ConstructorParameters<typeof ProviderFailure>[0]): never => { throw new ProviderFailure(code); };
/** Only the local HTTP pilot. HTTPS/cloud need a separate authenticated endpoint policy. */
export function pilotConfig(value: ProviderConfig): ProviderConfig {
  const config = parsePreference(value);
  if (config.state !== 'configured') return fail('CONFIG_INVALID');
  if (config.transport !== 'local' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.origin))
    return fail('ENDPOINT_DENIED');
  return config;
}
/** The server must expose the exact revision-pinned alias, not merely a family name. */
export const servedAlias = (config: ProviderConfig): string => config.identity.model + '@' + config.identity.revision;

function responseScores(value: unknown, model: string, count: number): RerankScore[] {
  if (!isRecord(value) || typeof value.model !== 'string') return fail('INVALID_RESPONSE');
  if (value.model !== model) return fail('MODEL_MISMATCH');
  if (!Array.isArray(value.results) || value.results.length !== count) return fail('INVALID_RESPONSE');
  const seen = new Set<number>();
  const scores: RerankScore[] = [];
  for (const row of value.results) {
    if (!isRecord(row) || !Number.isInteger(row.index) || (row.index as number) < 0
      || (row.index as number) >= count || seen.has(row.index as number)
      || typeof row.relevance_score !== 'number' || !Number.isFinite(row.relevance_score))
      return fail('INVALID_RESPONSE');
    const id = row.index as number;
    seen.add(id); scores.push({ id, score: row.relevance_score });
  }
  return scores.sort((a, b) => b.score - a.score || a.id - b.id);
}

const textBytes = (text: unknown, max: number): number => {
  if (typeof text !== 'string' || !text.length || text.length > max || text.includes('\0')
    || Buffer.from(text, 'utf8').toString('utf8') !== text) return fail('LIMIT_EXCEEDED');
  const bytes = Buffer.byteLength(text);
  if (bytes > max) return fail('LIMIT_EXCEEDED');
  return bytes;
};

/** Low-level transport: the caller MUST project an exact grant and reverify evidence.
 * One instance is owned by one controller; no credential or response is retained. */
export class LoopbackRerankTransport {
  private busy = false;
  async rerank(value: ProviderConfig, input: AuthorizedCandidates, token: string,
    context: CallContext): Promise<readonly RerankScore[]> {
    const config = pilotConfig(value);
    if (context.signal.aborted) return fail('CANCELLED');
    if (!Number.isSafeInteger(context.deadlineUnixMs)) return fail('CONFIG_INVALID');
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/=-]{1,512}$/.test(token)) return fail('UNAUTHENTICATED');
    if (this.busy) return fail('QUOTA_EXCEEDED');
    if (!Array.isArray(input.passages) || input.passages.length < 1
      || input.passages.length > config.limits.maxCandidates) return fail('LIMIT_EXCEEDED');
    let total = textBytes(input.query, config.limits.maxInputBytes);
    const documents = input.passages.map((row, i) => {
      if (row.id !== i) return fail('INVALID_RESPONSE');
      total += textBytes(row.text, config.limits.maxInputBytes - total);
      return row.text;
    });
    const model = servedAlias(config);
    const body = Buffer.from(JSON.stringify({ model, query: input.query, documents,
      top_n: documents.length, max_tokens_per_query: 0, max_tokens_per_doc: 0 }), 'utf8');
    if (body.length > MAX_WIRE_BYTES) return fail('LIMIT_EXCEEDED');
    const timeout = Math.min(config.limits.timeoutMs, context.deadlineUnixMs - Date.now());
    if (timeout <= 0) return fail('TIMEOUT');
    this.busy = true;
    try {
      return responseScores(await this.post(config.origin, body, token, context.signal, timeout), model, documents.length);
    } finally { this.busy = false; }
  }
  private post(origin: string, body: Buffer, token: string, signal: AbortSignal, timeout: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // Explicit agent; never use environment proxy/global agent or follow redirects.
      const agent = new Agent({ keepAlive: false });
      let settled = false;
      let req: ClientRequest | undefined;
      const finish = (error: ProviderFailure | null, result?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        req?.destroy(); agent.destroy();
        if (error) reject(error); else resolve(result);
      };
      const cancel = (): void => finish(new ProviderFailure('CANCELLED'));
      const timer = setTimeout(() => finish(new ProviderFailure('TIMEOUT')), timeout);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      try {
        req = request(new URL('/v1/rerank', origin), {
          method: 'POST', agent, maxHeaderSize: 8192,
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json',
            accept: 'application/json', 'content-length': String(body.length) },
        }, res => {
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            const code = status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN'
              : status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'SERVER_ERROR'
              : status >= 300 && status < 400 ? 'ENDPOINT_DENIED' : 'INVALID_RESPONSE';
            finish(new ProviderFailure(code)); res.destroy(); return;
          }
          const length = res.headers['content-length'];
          if (!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')
            || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity'
            || length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
            finish(new ProviderFailure('INVALID_RESPONSE')); res.destroy(); return;
          }
          const chunks: Buffer[] = []; let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) { finish(new ProviderFailure('LIMIT_EXCEEDED')); res.destroy(); }
            else chunks.push(chunk);
          });
          res.on('aborted', () => finish(new ProviderFailure('NETWORK')));
          res.on('error', () => finish(new ProviderFailure('NETWORK')));
          res.on('end', () => {
            if (settled) return;
            try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
            catch { finish(new ProviderFailure('INVALID_RESPONSE')); }
          });
        });
        req.on('error', () => finish(new ProviderFailure('NETWORK')));
        req.end(body);
      } catch { finish(new ProviderFailure('NETWORK')); }
    });
  }
}
