import { EvidenceGenerator, type GeneratedEvidenceClaim } from '../ai/generation-evidence';
import { EvidenceReranker, type RerankedHit } from '../ai/rerank-evidence';
import { pilotConfig } from '../ai/loopback-rerank';
import { configDigest } from '../ai/disclosure';
import { ProviderFailure, type ProviderConfig, type ProviderPreference, type ProviderFailureCode, type AiOperationStatus } from '../ai/contracts';
import { hash, isDigest } from '../standalone/contracts';
import type { AdvancedHealth } from '../advanced/health';
import type { IngestionStatus } from '../advanced/manager';
import { isRecord, StandaloneError, validateRequest, validProperty, BOUNDS,
  type SearchRequest, type SearchResponse, type Predicate, type EvidenceHit, type SearchMetadata } from '../standalone/contracts';
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
  if (value.metadata?.tag !== undefined) count(value.metadata.tag);
  if (value.metadata?.linkTarget !== undefined) count(value.metadata.linkTarget);
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
type EvidenceRole = 'reranking' | 'generation';
export type RerankPreview = { role: EvidenceRole; sequence: number; revision: number; config: ProviderConfig; scopeId: string; query: string; hits: EvidenceHit[] };
export type RerankState = { phase: 'running' | 'results' | 'error'; error: ProviderFailureCode | null; hits: readonly RerankedHit[] };
export type RerankPort = {
  config(): ProviderPreference; scopeId(): string | undefined; verify(hit: EvidenceHit): Promise<void>;
};
export type GenerationState = { phase: 'running' | 'results' | 'error'; error: ProviderFailureCode | null; hits: readonly GeneratedEvidenceClaim[] };
export type UiState = { rerank?: RerankState; generation?: GenerationState; phase: 'idle' | 'searching' | 'results' | 'error'; message: string; response: SearchResponse | null };
export class SearchController {
  private engine?: Engine;
  private enabled = true;
  private paused = false;
  private error: string | null = null;
  private disposed = false;
  private revision = 0;
  private lastQuery = '';
  private sequence = 0;
  private prepared: Partial<Record<EvidenceRole,RerankPreview>> = {};
  private aborts: Partial<Record<EvidenceRole,AbortController>> = {};
  private readonly generator = new EvidenceGenerator();
  private readonly reranker = new EvidenceReranker();
  private active = false;
  private pending?: { request: SearchRequest; revision: number; resolve: (v: ApiResult<SearchResponse>) => void };
  private listeners = new Set<() => void>();
  private state: UiState = { phase: 'idle', message: 'Enter a query to search original Markdown.', response: null };
  constructor(private readonly navigate: (hit: EvidenceHit) => Promise<void>,
    private readonly advancedStatus?: () => AdvancedHealth,
    private readonly ingestionStatus?: () => IngestionStatus,
    private readonly rerankPort?: RerankPort, private readonly generationPort?: RerankPort) {}
  attach(engine: Engine): void { if (!this.disposed) { this.engine = engine; this.error = null; this.emit(); } }
  configure(enabled: boolean, paused: boolean, error: string | null = null): void {
    this.enabled = enabled; this.paused = paused; this.error = safeCode(error); this.invalidate();
  }
  detach(): void { this.engine = undefined; this.invalidate(); }
  status(): SearchStatus { return statusSnapshot(this.engine?.status(), !this.disposed && this.enabled, this.paused,
    this.error, this.advancedStatus?.(), this.ingestionStatus?.()); }
  snapshot(): UiState { return structuredClone(this.state); }
  /** No query, passages, source IDs, grants or tokens cross this metadata boundary. */
  evidenceOperationStatus(role: EvidenceRole): AiOperationStatus {
    const state = role === 'reranking' ? this.state.rerank : this.state.generation;
    if (state?.phase === 'running') return {phase:'busy',error:null};
    if (this.prepared[role]) return {phase:'permission-required',error:null};
    if (state?.phase === 'error') return {phase:'failed',error:state.error ?? 'NOT_READY'};
    return {phase:state?.phase === 'results' ? 'complete' : 'idle',error:null};
  }
  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
  invalidate(): void {
    this.revision++; this.revokeEvidence(); this.lastQuery = '';
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
    this.revokeEvidence(); this.lastQuery = '';
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
      this.lastQuery = result.ok && result.value.status === 'ok' && result.value.executedMode === 'lexical' ? job.request.query : '';
      this.state = !result.ok ? { phase: 'error', message: result.error, response: null }
        : { phase: result.value.status === 'failed' ? 'error' : 'results', response: structuredClone(result.value),
          message: result.value.error ? safeCode(result.value.error)! : result.value.hits.length ? 'Verified at search time; checked again on open.' : 'No matching evidence.' };
      this.emit();
    }
    job.resolve(result); void this.pump();
  }
  private port(role: EvidenceRole): RerankPort | undefined {
    return role === 'reranking' ? this.rerankPort : this.generationPort;
  }
  prepareRerank(): RerankPreview { return this.prepareEvidence('reranking'); }
  prepareGeneration(): RerankPreview { return this.prepareEvidence('generation'); }
  private prepareEvidence(role: EvidenceRole): RerankPreview {
    delete this.prepared[role];
    const port = this.port(role), pref = port?.config();
    if (!pref || pref.state === 'disabled') throw new ProviderFailure('DISABLED');
    if (pref.state !== 'configured') throw new ProviderFailure('CONFIG_INVALID');
    const config = pilotConfig(pref);
    const scopeId = port?.scopeId(), response = this.state.response;
    if (this.disposed || !this.enabled || this.paused || this.aborts[role] || !isDigest(scopeId)
      || !this.lastQuery.trim() || !response || response.status !== 'ok'
      || response.executedMode !== 'lexical' || !response.hits.length
      || this.engine?.status().generationId !== response.indexGenerationId)
      throw new ProviderFailure('NOT_READY');
    if (response.hits.length > config.limits.maxCandidates
      || Buffer.byteLength(this.lastQuery) + response.hits.reduce((n, hit) => n + Buffer.byteLength(hit.originalExcerpt), 0)
        > config.limits.maxInputBytes) throw new ProviderFailure('LIMIT_EXCEEDED');
    const preview = structuredClone({role,sequence:++this.sequence,revision:this.revision,config,scopeId,query:this.lastQuery,hits:response.hits});
    this.prepared[role] = preview;
    return structuredClone(preview);
  }
  private revokeEvidence(role?: EvidenceRole): void {
    for (const r of role ? [role] : ['reranking','generation'] as const) {
      delete this.prepared[r];
      this.aborts[r]?.abort();
    }
  }
  private cancelEvidence(role: EvidenceRole): void {
    this.revokeEvidence(role);
    const key = role === 'reranking' ? 'rerank' : 'generation';
    if (this.state[key]) {
      this.state = {...this.state,[key]:{phase:'error',error:'CANCELLED',hits:[]}}; this.emit();
    }
  }
  cancelRerank(): void { this.cancelEvidence('reranking'); }
  cancelGeneration(): void { this.cancelEvidence('generation'); }
  rerankConfirmed(preview: RerankPreview, classification: 'synthetic' | 'public', token: string): Promise<void> {
    return this.confirmEvidence('reranking',preview,classification,token);
  }
  generationConfirmed(preview: RerankPreview, classification: 'synthetic' | 'public', token: string): Promise<void> {
    return this.confirmEvidence('generation',preview,classification,token);
  }
  private async confirmEvidence(role: EvidenceRole, preview: RerankPreview, classification: 'synthetic' | 'public', token: string): Promise<void> {
    const approved = this.prepared[role]; delete this.prepared[role];
    const port = this.port(role);
    if (!approved || !port || this.aborts[role] || !['synthetic','public'].includes(classification)
      || JSON.stringify(approved) !== JSON.stringify(preview)) throw new ProviderFailure('DISCLOSURE_DENIED');
    const current = (): boolean => {
      const config = port.config();
      return !this.disposed && this.enabled && !this.paused && this.revision === approved.revision
        && port.scopeId() === approved.scopeId && config.state === 'configured'
        && configDigest(role,config) === configDigest(role,approved.config)
        && this.engine?.status().generationId === this.state.response?.indexGenerationId
        && this.state.response?.indexGenerationId === approved.hits[0]?.indexGenerationId;
    };
    if (!current()) throw new ProviderFailure('CANCELLED');
    const abort = new AbortController(); this.aborts[role] = abort;
    const key = role === 'reranking' ? 'rerank' : 'generation';
    const deadlineUnixMs = Date.now() + approved.config.limits.timeoutMs;
    this.state = {...this.state,[key]:{phase:'running',error:null,hits:[]}}; this.emit();
    try {
      const worker = role === 'reranking' ? this.reranker : this.generator;
      const hits = await worker.run({
        config:approved.config,scopeId:approved.scopeId,query:{text:approved.query,classification},
        candidates:approved.hits.map(hit=>({hit,classification})),
        grant:{version:1,role,configDigest:configDigest(role,approved.config),
          scopeId:approved.scopeId,expiresUnixMs:deadlineUnixMs,queryDigest:hash(approved.query),
          queryClassification:classification,sources:approved.hits.map(hit=>({sourceId:hit.sourceId,
            sourceSha256:hit.sourceSha256,excerptDigest:hash(hit.originalExcerpt),classification}))},
      },token,{signal:abort.signal,deadlineUnixMs},hit=>port.verify(hit),current);
      if (this.revision === approved.revision && !this.disposed) {
        if (current() && !abort.signal.aborted) this.state = {...this.state,[key]:{phase:'results',error:null,hits}};
        else this.state = {...this.state,[key]:{phase:'error',error:'CANCELLED',hits:[]}};
        this.emit();
      }
    } catch (error) {
      if (this.revision === approved.revision && !this.disposed) {
        this.state = {...this.state,[key]:{phase:'error',error:error instanceof ProviderFailure?error.code:'NOT_READY',hits:[]}};
        this.emit();
      }
    } finally { if (this.aborts[role] === abort) delete this.aborts[role]; }
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
export function uiRequest(query: string, limit: number, predicates: Predicate[] = [],
  matchMode: 'literal' | 'terms' = 'literal', metadata?: SearchMetadata): SearchRequest {
  if (Buffer.byteLength(query) > BOUNDS.queryBytes) throw new StandaloneError('INVALID_REQUEST');
  return parseSearch({ protocolVersion: 2, requestId: 'ui', query, limit, predicates,
    requestedMode: 'lexical', matchMode, ...(metadata ? { metadata } : {}) });
}
