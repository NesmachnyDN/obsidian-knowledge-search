import type { AdvancedHealth } from '../advanced/health';
import type { IngestionStatus } from '../advanced/manager';
import { isRecord, StandaloneError, validateRequest, validProperty, BOUNDS,
  type SearchRequest, type SearchResponse, type Predicate, type EvidenceHit } from '../standalone/contracts';
import type { StandaloneEngine } from '../standalone/engine';
import { diagnostics, safeCode, statusSnapshot, type SearchStatus } from './status';

export type ApiError = { apiVersion: 1; ok: false; error: string };
export type ApiResult<T> = { apiVersion: 1; ok: true; value: T } | ApiError;
const failure = (error: string): ApiError => ({ apiVersion: 1, ok: false, error: safeCode(error)! });
export function parseSearch(value: unknown): SearchRequest {
  validateRequest(value);
  // Nested predicates also reject unknown keys and oversized serialized values.
  let bytes = Buffer.byteLength(value.query);
  const count = (v: unknown): void => {
    bytes += typeof v === 'string' ? Buffer.byteLength(v) : 32;
    if (bytes > 16384) throw new StandaloneError('INVALID_REQUEST');
  };
  for (const path of value.scope ?? []) count(path);
  if (typeof value.requestedMode !== 'string' || value.predicates?.some(p =>
    typeof p.valueType !== 'string' || typeof p.operator !== 'string'
    || Object.keys(p).some(k => !['key','valueType','value','operator'].includes(k))))
    throw new StandaloneError('INVALID_REQUEST');
  for (const p of value.predicates ?? []) {
    count(p.key);
    if (Array.isArray(p.value)) p.value.forEach(count); else count(p.value);
  }
  return structuredClone(value);
}
export function propertyInput(key: string, valueType: string, operator: string, raw: string): Predicate {
  if (Buffer.byteLength(raw) > 4096) throw new StandaloneError('INVALID_REQUEST');
  let value: unknown;
  try { value = valueType === 'string' || valueType === 'date' ? raw : JSON.parse(raw); }
  catch { throw new StandaloneError('INVALID_REQUEST'); }
  const predicate = { key, valueType, operator, value };
  if (!validProperty(predicate, true)) throw new StandaloneError('INVALID_REQUEST');
  return predicate as Predicate;
}
type Engine = Pick<StandaloneEngine, 'search' | 'status' | 'cancel' | 'resume' | 'rebuild'>;
export type UiState = { phase: 'idle' | 'searching' | 'results' | 'error'; message: string; response: SearchResponse | null };
export class SearchController {
  private engine?: Engine;
  private enabled = true;
  private paused = false;
  private error: string | null = null;
  private disposed = false;
  private revision = 0;
  private active = false;
  private pending?: { request: SearchRequest; revision: number; resolve: (v: ApiResult<SearchResponse>) => void };
  private listeners = new Set<() => void>();
  private state: UiState = { phase: 'idle', message: 'Enter a query to search original Markdown.', response: null };
  constructor(private readonly navigate: (hit: EvidenceHit) => Promise<void>,
    private readonly advancedStatus?: () => AdvancedHealth,
    private readonly ingestionStatus?: () => IngestionStatus) {}
  attach(engine: Engine): void { if (!this.disposed) { this.engine = engine; this.error = null; this.emit(); } }
  configure(enabled: boolean, paused: boolean, error: string | null = null): void {
    this.enabled = enabled; this.paused = paused; this.error = safeCode(error); this.invalidate();
  }
  detach(): void { this.engine = undefined; this.invalidate(); }
  status(): SearchStatus { return statusSnapshot(this.engine?.status(), !this.disposed && this.enabled, this.paused,
    this.error, this.advancedStatus?.(), this.ingestionStatus?.()); }
  snapshot(): UiState { return structuredClone(this.state); }
  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
  invalidate(): void {
    this.revision++;
    this.pending?.resolve(failure('SUPERSEDED')); this.pending = undefined;
    this.state = { phase: 'idle', message: 'Results cleared; search to verify current sources.', response: null }; this.emit();
  }
  message(error: string): void {
    this.invalidate(); this.state = { phase: 'error', message: safeCode(error)!, response: null }; this.emit();
  }
  async search(input: unknown): Promise<ApiResult<SearchResponse>> {
    let request: SearchRequest;
    try { request = parseSearch(input); } catch { return failure('INVALID_REQUEST'); }
    if (this.disposed || !this.enabled) return failure('DISABLED');
    if (!this.engine) return failure(this.error ?? 'INDEX_UNAVAILABLE');
    const revision = ++this.revision;
    this.pending?.resolve(failure('SUPERSEDED'));
    this.state = { phase: 'searching', message: 'Verifying original sources…', response: null }; this.emit();
    return new Promise(resolve => {
      this.pending = { request, revision, resolve };
      void this.pump();
    });
  }
  private async pump(): Promise<void> {
    if (this.active || !this.pending) return;
    const job = this.pending; this.pending = undefined; this.active = true;
    let result: ApiResult<SearchResponse>;
    try {
      // Public callers must never receive references into immutable engine generations.
      const response = structuredClone(await this.engine!.search(job.request));
      result = { apiVersion: 1, ok: true, value: response };
    } catch (error) { result = failure(error instanceof StandaloneError ? error.code : 'INTERNAL_FAILURE'); }
    this.active = false;
    if (job.revision !== this.revision || this.disposed) result = failure('SUPERSEDED');
    else {
      this.state = !result.ok ? { phase: 'error', message: result.error, response: null }
        : { phase: result.value.status === 'failed' ? 'error' : 'results', response: structuredClone(result.value),
          message: result.value.error ? safeCode(result.value.error)! : result.value.hits.length ? 'Verified at search time; checked again on open.' : 'No matching evidence.' };
      this.emit();
    }
    job.resolve(result); void this.pump();
  }
  async open(index: number, expected?: EvidenceHit): Promise<ApiResult<null>> {
    const hit = this.state.response?.hits[index];
    if (this.disposed || !this.enabled || !hit || !Number.isInteger(index)
      || expected && JSON.stringify(expected) !== JSON.stringify(hit)) return failure('NAVIGATION_REJECTED');
    try { await this.navigate(structuredClone(hit)); return { apiVersion: 1, ok: true, value: null }; }
    catch { this.message('NAVIGATION_REJECTED'); return failure('NAVIGATION_REJECTED'); }
  }
  control(action: 'pause' | 'cancel' | 'resume' | 'rebuild'): ApiResult<{ cancelled: boolean | null }> {
    if (this.disposed || !this.enabled || !this.engine) return failure('DISABLED');
    this.invalidate();
    try {
      let cancelled: boolean | null = null;
      if (action === 'pause' || action === 'cancel') { cancelled = this.engine.cancel(); this.paused = true; }
      else { this.engine[action](); this.paused = false; }
      this.emit(); return { apiVersion: 1, ok: true, value: { cancelled } };
    } catch { return failure('INTERNAL_FAILURE'); }
  }
  dispose(): void { this.disposed = true; this.invalidate(); this.listeners.clear(); this.engine = undefined; }
}
/** Stable in-process API. No listener, IPC transport, or external runtime. */
export class StandaloneApi {
  readonly apiVersion = 1;
  constructor(private readonly controller: SearchController) {}
  async request(input: unknown): Promise<ApiResult<SearchStatus | SearchResponse | string>> {
    try {
      if (!isRecord(input)) return failure('INVALID_REQUEST');
      if (input.apiVersion !== 1) return failure('API_VERSION_UNSUPPORTED');
      if (typeof input.operation !== 'string' || !['status','search','diagnostics'].includes(input.operation)) return failure('INVALID_REQUEST');
      const allowed = input.operation === 'search' ? ['apiVersion','operation','request'] : ['apiVersion','operation'];
      if (Object.keys(input).some(k => !allowed.includes(k))) return failure('INVALID_REQUEST');
      if (input.operation === 'search') return await this.controller.search(input.request);
      const status = this.controller.status();
      return { apiVersion: 1, ok: true, value: input.operation === 'status' ? status : diagnostics(status) };
    } catch { return failure('INVALID_REQUEST'); }
  }
}
export function uiRequest(query: string, limit: number, predicates: Predicate[] = []): SearchRequest {
  if (Buffer.byteLength(query) > BOUNDS.queryBytes) throw new StandaloneError('INVALID_REQUEST');
  return parseSearch({ protocolVersion: 2, requestId: 'ui', query, limit, predicates, requestedMode: 'lexical' });
}
