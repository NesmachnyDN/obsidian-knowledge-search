import { Agent, request, type ClientRequest } from 'node:http';
import { parsePreference } from './config';
import { ProviderFailure, type CallContext, type ProviderConfig, type AuthorizedCandidates } from './contracts';

const MAX_WIRE_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
// One in-flight HTTP operation per canonical origin and role endpoint, shared
// by Search, Settings and replacement plugin instances during reload.
// The key contains no model inputs or credentials and is removed on settlement.
const activeKey = Symbol.for('oks.loopback.active-requests.v1');
const host = globalThis as typeof globalThis & { [activeKey]?: Set<string> };
const activeRequests = host[activeKey] ??= new Set<string>();

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

const textBytes = (text: unknown, max: number): number => {
  if (typeof text !== 'string' || !text.length || text.length > max || text.includes('\0')
    || Buffer.from(text, 'utf8').toString('utf8') !== text) return fail('LIMIT_EXCEEDED');
  const bytes = Buffer.byteLength(text);
  if (bytes > max) return fail('LIMIT_EXCEEDED');
  return bytes;
};

type LoopbackPath = '/v1/rerank' | '/v1/chat/completions' | '/v1/embeddings';
export function checkedCandidates(config: ProviderConfig, input: AuthorizedCandidates): string[] {
    if (!Array.isArray(input.passages) || input.passages.length < 1
      || input.passages.length > config.limits.maxCandidates) return fail('LIMIT_EXCEEDED');
    let total = textBytes(input.query, config.limits.maxInputBytes);
    return input.passages.map((row, i) => {
      if (row.id !== i) return fail('INVALID_RESPONSE');
      total += textBytes(row.text, config.limits.maxInputBytes - total);
      return row.text;
    });
}
/** Exact wire encoding and size admission, also used by offline batch preflight. */
export function checkedJsonBody(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_WIRE_BYTES) return fail('LIMIT_EXCEEDED');
  return body;
}
/** Internal transport: endpoint, credentials, wire and deadline bounds.
 * Role adapters must validate payloads and caller disclosure separately. */
export class LoopbackJsonTransport {
  private busy = false;
  async send(value: ProviderConfig, path: LoopbackPath, payload: unknown, token: string,
    context: CallContext): Promise<unknown> {
    const config = pilotConfig(value);
    if (!['/v1/rerank','/v1/chat/completions','/v1/embeddings'].includes(path)) return fail('ENDPOINT_DENIED');
    if (context.signal.aborted) return fail('CANCELLED');
    if (!Number.isSafeInteger(context.deadlineUnixMs)) return fail('CONFIG_INVALID');
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/=-]{1,512}$/.test(token)) return fail('UNAUTHENTICATED');
    const key = config.origin + path;
    if (this.busy || activeRequests.has(key)) return fail('QUOTA_EXCEEDED');
    const body = checkedJsonBody(payload);
    const timeout = Math.min(config.limits.timeoutMs, context.deadlineUnixMs - Date.now());
    if (timeout <= 0) return fail('TIMEOUT');
    this.busy = true; activeRequests.add(key);
    try { return await this.post(config.origin, path, body, token, context.signal, timeout); }
    finally { this.busy = false; activeRequests.delete(key); }
  }
  private post(origin: string, path: LoopbackPath, body: Buffer, token: string, signal: AbortSignal, timeout: number): Promise<unknown> {
    const responseLimit = path === '/v1/embeddings' ? 1024 * 1024 : MAX_RESPONSE_BYTES;
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
        req = request(new URL(path, origin), {
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
            || length !== undefined && (!/^\d+$/.test(length) || Number(length) > responseLimit)) {
            finish(new ProviderFailure('INVALID_RESPONSE')); res.destroy(); return;
          }
          const chunks: Buffer[] = []; let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > responseLimit) { finish(new ProviderFailure('LIMIT_EXCEEDED')); res.destroy(); }
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
