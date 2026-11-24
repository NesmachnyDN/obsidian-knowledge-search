import { ProviderFailure, type AiRole, type ProviderConfig, type ProviderFailureCode, type EmbeddingSpace } from './contracts';
import { pilotConfig } from './loopback-json';
import { LoopbackEmbeddingTransport } from './loopback-embedding';
import { LoopbackGenerationTransport } from './loopback-generation';

export type ConnectionCheckResult =
  | { ok: true; elapsedMs: number; dimension?: number }
  | { ok: false; elapsedMs: number; error: ProviderFailureCode };

/** Only fixed synthetic input; no source, grants, index or settings writer. */
export async function checkLocalConnection(role: AiRole, value: ProviderConfig, token: string,
  dimension: number | undefined, signal: AbortSignal): Promise<ConnectionCheckResult> {
  const start = performance.now();
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - start));
  try {
    if (signal.aborted) throw new ProviderFailure('CANCELLED');
    // The actual rerank runtime is not accepted; never mint a fixture admission here.
    if (role !== 'embedding' && role !== 'generation') throw new ProviderFailure('NOT_READY');
    const config = pilotConfig(value);
    const context = { signal, deadlineUnixMs: Date.now() + config.limits.timeoutMs };
    if (role === 'embedding') {
      if (dimension === undefined || !Number.isSafeInteger(dimension) || dimension < 1 || dimension > 4096)
        throw new ProviderFailure('CONFIG_INVALID');
      // The same declared local pilot profile and vector validator as runtime.
      const space: EmbeddingSpace = { ...config.identity, dimension, normalization: 'unit-l2',
        serializationId: 'utf8-verbatim-v1', queryInstructionId: 'identity-v1', documentInstructionId: 'identity-v1' };
      await new LoopbackEmbeddingTransport().embed(config, space, 'query',
        { query: 'OKS connection check', passages: [] }, token, context);
    } else {
      const claims = await new LoopbackGenerationTransport().generate(config,
        { query: 'What color?', passages: [{ id: 0, text: 'The color is blue.' }] }, token, context);
      // This fixed answerable question must produce a nonempty, adapter-validated response.
      if (!claims.length) throw new ProviderFailure('INVALID_RESPONSE');
    }
    if (signal.aborted) throw new ProviderFailure('CANCELLED');
    if (Date.now() >= context.deadlineUnixMs) throw new ProviderFailure('TIMEOUT');
    return { ok: true, elapsedMs: elapsed(), ...(role === 'embedding' ? {dimension} : {}) };
  } catch (error) {
    // Never surface arbitrary server text or exception messages.
    return { ok: false, elapsedMs: elapsed(),
      error: signal.aborted ? 'CANCELLED' : error instanceof ProviderFailure ? error.code : 'NOT_READY' };
  }
}

/** One check per editor, with cancellation and a stale-completion fence. */
export class ConnectionCheckSession {
  private active?: AbortController;
  private disposed = false;
  async run(role: AiRole, config: ProviderConfig, token: string, dimension?: number): Promise<ConnectionCheckResult | undefined> {
    if (this.disposed || this.active) return undefined;
    const operation = new AbortController();
    this.active = operation;
    try {
      const result = await checkLocalConnection(role, config, token, dimension, operation.signal);
      return this.active === operation && !operation.signal.aborted && !this.disposed ? result : undefined;
    } finally {
      if (this.active === operation) this.active = undefined;
    }
  }
  cancel(): void {
    const previous = this.active;
    this.active = undefined;
    previous?.abort();
  }
  dispose(): void { this.disposed = true; this.cancel(); }
}
