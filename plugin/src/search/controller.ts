import os from 'node:os';
import { EvidenceGenerator, type GeneratedEvidenceClaim } from '../ai/generation-evidence';
import { EvidenceReranker, type RerankedHit } from '../ai/rerank-evidence';
import { pilotConfig } from '../ai/loopback-rerank';
import { bindActiveDeadline, remainingOperationMs } from '../ai/active-deadline';
import { RerankRuntimeProfiles, type RerankAdmission } from '../ai/rerank-profile';
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
export const EVIDENCE_PREVIEW_TTL_MS = 300_000;
export type RerankPreview = { role: EvidenceRole; sequence: number; revision: number; expiresUnixMs: number; config: ProviderConfig; scopeId: string; query: string; hits: EvidenceHit[]; runtimeProfileBinding?: string; runtimeProfileDigest?: string };
// Internal elapsed-time deadlines are never taken from the returned preview.
type PendingEvidencePreview = { preview: RerankPreview; monotonicStartedMs: number; bootStartedSeconds: number };
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
  private prepared: Partial<Record<EvidenceRole,PendingEvidencePreview>> = {};
  private previewTimers: Partial<Record<EvidenceRole,ReturnType<typeof setTimeout>>> = {};
  private aborts: Partial<Record<EvidenceRole,AbortController>> = {};
  private readonly generator = new EvidenceGenerator();
  private readonly reranker = new EvidenceReranker();
  private readonly rerankProfiles = new RerankRuntimeProfiles(()=>this.invalidateRerankProfile());
  private active = false;
  private pending?: { request: SearchRequest; revision: number; resolve: (v: ApiResult<SearchResponse>) => void };
  private listeners = new Set<() => void>();
  private evidenceListeners = new Set<() => void>();
  private pendingExpiryNotification?: object;
  private state: UiState = { phase: 'idle', message: 'Enter a query to search original Markdown.', response: null };
  constructor(private readonly navigate: (hit: EvidenceHit) => Promise<void>,
    private readonly advancedStatus?: () => AdvancedHealth,
    private readonly ingestionStatus?: () => IngestionStatus,
    private readonly rerankPort?: RerankPort, private readonly generationPort?: RerankPort) {}
  attach(engine: Engine): void { if (!this.disposed) { this.engine = engine; this.error = null; this.emit(); } }
  configure(enabled: boolean, paused: boolean, error: string | null = null): void {
    this.enabled = enabled; this.paused = paused; this.error = safeCode(error); this.invalidate();
  }
  detach(): void { this.engine = undefined; this.rerankProfiles.revoke(); this.invalidate(); }
  status(): SearchStatus { return statusSnapshot(this.engine?.status(), !this.disposed && this.enabled, this.paused,
    this.error, this.advancedStatus?.(), this.ingestionStatus?.()); }
  snapshot(): UiState {
    this.rerankProfiles.checkLifetime();
    this.currentPreview('reranking'); this.currentPreview('generation');
    return structuredClone(this.state);
  }
  /** No query, passages, source IDs, grants or tokens cross this metadata boundary. */
  evidenceOperationStatus(role: EvidenceRole): AiOperationStatus {
    if (role === 'reranking') this.rerankProfiles.checkLifetime();
    const pending = this.currentPreview(role);
    const state = role === 'reranking' ? this.state.rerank : this.state.generation;
    if (state?.phase === 'running') return {phase:'busy',error:null};
    if (pending) return {phase:'permission-required',error:null};
    if (state?.phase === 'error') return {phase:'failed',error:state.error ?? 'NOT_READY'};
    return {phase:state?.phase === 'results' ? 'complete' : 'idle',error:null};
  }
  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  // Role-local evidence transitions must not invalidate the independent dense machine.
  subscribeEvidence(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.evidenceListeners.add(listener); return () => this.evidenceListeners.delete(listener);
  }
  private emitEvidence(): void {
    this.pendingExpiryNotification = undefined;
    for (const listener of this.evidenceListeners) listener();
  }
  // Polling/rendering may discover expiry while a listener is already executing.
  // Commit cancellation now, but publish only after the current synchronous stack.
  private notifyExpiry(): void {
    if (this.pendingExpiryNotification) return;
    const notification = {};
    this.pendingExpiryNotification = notification;
    queueMicrotask(() => {
      if (!this.disposed && this.pendingExpiryNotification === notification) this.emitEvidence();
    });
  }
  private emit(): void {
    this.pendingExpiryNotification = undefined;
    for (const listener of this.listeners) listener();
  }
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
  prepareRerank(): RerankPreview {
    try { return this.prepareEvidence('reranking'); }
    catch (error) {
      if (!this.disposed && !this.aborts.reranking && error instanceof ProviderFailure
        && error.code === 'NOT_READY' && this.rerankPort?.config().state === 'configured') {
        this.state = {...this.state,rerank:{phase:'error',
          error:error.code,hits:[]}};
        this.emitEvidence();
      }
      throw error;
    }
  }
  prepareGeneration(): RerankPreview { return this.prepareEvidence('generation'); }
  /** Settings changes revoke admission itself, not just pending consent. */
  revokeRerankProfile(): void { this.rerankProfiles.revoke(); }
  private invalidateRerankProfile(): void {
    const affected = !!this.prepared.reranking || !!this.aborts.reranking || !!this.state.rerank;
    this.revokeEvidence('reranking');
    if (affected) {
      this.state = {...this.state,rerank:{phase:'error',error:'CANCELLED',hits:[]}};
      this.notifyExpiry();
    }
  }
  private currentRerankAdmission(config: ProviderConfig, scopeId: string): RerankAdmission {
    return this.rerankProfiles.current(config,scopeId);
  }
  private profileCurrent(preview: RerankPreview, checkConfig = true): boolean {
    if (preview.role !== 'reranking') return true;
    try {
      const port=this.rerankPort, config=checkConfig ? port?.config() : preview.config,
        scopeId=checkConfig ? port?.scopeId() : preview.scopeId;
      if (config?.state !== 'configured' || scopeId !== preview.scopeId) {
        this.rerankProfiles.revoke();return false;
      }
      const admission=this.currentRerankAdmission(config,scopeId);
      return admission.bindingDigest === preview.runtimeProfileBinding && admission.profileDigest === preview.runtimeProfileDigest;
    } catch { return false; }
  }
  private currentPreview(role: EvidenceRole, checkConfig = true): PendingEvidencePreview | undefined {
    const pending = this.prepared[role];
    if (!pending) return undefined;
    // performance.now covers elapsed execution (including delayed callbacks).
    // Linux desktop uptime includes suspend; wall time is only an additional
    // conservative expiry fence, never authority to extend an elapsed deadline.
    try {
      const monotonic = performance.now(), boot = os.uptime(), wall = Date.now();
      if (Number.isFinite(monotonic) && monotonic >= pending.monotonicStartedMs
        && monotonic - pending.monotonicStartedMs < EVIDENCE_PREVIEW_TTL_MS
        && Number.isFinite(boot) && boot >= pending.bootStartedSeconds
        && boot < pending.bootStartedSeconds+EVIDENCE_PREVIEW_TTL_MS/1000
        && Number.isFinite(wall) && wall < pending.preview.expiresUnixMs
        && this.profileCurrent(pending.preview,checkConfig)) return pending;
    } catch { /* An unavailable clock cannot authorize disclosure. */ }
    this.expirePreview(role,pending);
    return undefined;
  }
  isEvidencePreviewCurrent(role: EvidenceRole, sequence: number): boolean {
    return this.currentPreview(role)?.preview.sequence === sequence;
  }
  private clearPreview(role: EvidenceRole): boolean {
    const hadPreview = !!this.prepared[role];
    delete this.prepared[role];
    clearTimeout(this.previewTimers[role]);
    delete this.previewTimers[role];
    return hadPreview;
  }
  private expirePreview(role: EvidenceRole, preview: PendingEvidencePreview): void {
    if (this.prepared[role] !== preview) return;
    this.clearPreview(role);
    const key = role === 'reranking' ? 'rerank' : 'generation';
    this.state = {...this.state,[key]:{phase:'error',error:'CANCELLED',hits:[]}};
    this.notifyExpiry();
  }
  private prepareEvidence(role: EvidenceRole): RerankPreview {
    if (this.clearPreview(role)) this.emitEvidence();
    const port = this.port(role), pref = port?.config();
    if (role === 'reranking' && pref?.state !== 'configured') this.rerankProfiles.revoke();
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
    const admission = role === 'reranking' ? this.currentRerankAdmission(config,scopeId) : undefined;
    const monotonicStartedMs = performance.now();
    const bootStartedSeconds = os.uptime();
    const expiresUnixMs = Date.now()+EVIDENCE_PREVIEW_TTL_MS;
    if (![monotonicStartedMs,bootStartedSeconds,expiresUnixMs].every(Number.isFinite))
      throw new ProviderFailure('NOT_READY');
    const preview = structuredClone({role,sequence:++this.sequence,revision:this.revision,expiresUnixMs,config,scopeId,query:this.lastQuery,hits:response.hits,
      ...(admission ? {runtimeProfileBinding:admission.bindingDigest,runtimeProfileDigest:admission.profileDigest} : {})});
    const pending = {preview,monotonicStartedMs,bootStartedSeconds};
    this.prepared[role] = pending;
    this.previewTimers[role] = setTimeout(()=>this.expirePreview(role,pending),EVIDENCE_PREVIEW_TTL_MS);
    this.emitEvidence();
    return structuredClone(preview);
  }
  private revokeEvidence(role?: EvidenceRole): void {
    for (const r of role ? [role] : ['reranking','generation'] as const) {
      this.clearPreview(r);
      this.aborts[r]?.abort();
    }
  }
  private cancelEvidence(role: EvidenceRole): void {
    const hadPreview = !!this.prepared[role];
    this.revokeEvidence(role);
    const key = role === 'reranking' ? 'rerank' : 'generation';
    if (hadPreview || this.state[key]) {
      this.state = {...this.state,[key]:{phase:'error',error:'CANCELLED',hits:[]}};
      this.emitEvidence();
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
    const approved = this.currentPreview(role,false)?.preview;
    if (!approved) throw new ProviderFailure('DISCLOSURE_DENIED');
    this.clearPreview(role);
    const port = this.port(role);
    if (!port || this.aborts[role] || !['synthetic','public'].includes(classification)
      || role === 'reranking' && classification !== 'synthetic'
      || JSON.stringify(approved) !== JSON.stringify(preview)) { this.emitEvidence(); throw new ProviderFailure('DISCLOSURE_DENIED'); }
    const current = (): boolean => {
      const config = port.config();
      return !this.disposed && this.enabled && !this.paused && this.revision === approved.revision
        && this.profileCurrent(approved)
        && port.scopeId() === approved.scopeId && config.state === 'configured'
        && configDigest(role,config) === configDigest(role,approved.config)
        && this.engine?.status().generationId === this.state.response?.indexGenerationId
        && this.state.response?.indexGenerationId === approved.hits[0]?.indexGenerationId;
    };
    if (!current()) { this.emitEvidence(); throw new ProviderFailure('CANCELLED'); }
    const admission = role === 'reranking' ? this.currentRerankAdmission(approved.config,approved.scopeId) : undefined;
    const abort = new AbortController();
    const key = role === 'reranking' ? 'rerank' : 'generation';
    const context = bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+approved.config.limits.timeoutMs},approved.config.limits.timeoutMs);
    const {deadlineUnixMs} = context;
    this.aborts[role] = abort;
    this.state = {...this.state,[key]:{phase:'running',error:null,hits:[]}}; this.emitEvidence();
    try {
      const worker = role === 'reranking' ? this.reranker : this.generator;
      const hits = await worker.run({
        config:approved.config,scopeId:approved.scopeId,query:{text:approved.query,classification},
        candidates:approved.hits.map(hit=>({hit,classification})),
        grant:{version:1,role,configDigest:configDigest(role,approved.config),
          ...(admission ? {runtimeProfileBinding:admission.bindingDigest} : {}),
          scopeId:approved.scopeId,expiresUnixMs:deadlineUnixMs,queryDigest:hash(approved.query),
          queryClassification:classification,sources:approved.hits.map(hit=>({sourceId:hit.sourceId,
            sourceSha256:hit.sourceSha256,excerptDigest:hash(hit.originalExcerpt),classification}))},
      },token,context,hit=>port.verify(hit),current,admission);
      if (this.revision === approved.revision && !this.disposed) {
        if (!current() || abort.signal.aborted) throw new ProviderFailure('CANCELLED');
        remainingOperationMs(context);
        if (this.revision !== approved.revision || this.disposed) return;
        this.state = {...this.state,[key]:{phase:'results',error:null,hits}};
        this.emitEvidence();
      }
    } catch (error) {
      if (this.revision === approved.revision && !this.disposed) {
        this.state = {...this.state,[key]:{phase:'error',error:error instanceof ProviderFailure?error.code:'NOT_READY',hits:[]}};
        this.emitEvidence();
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
  dispose(): void { this.disposed = true; this.rerankProfiles.revoke(); this.invalidate(); this.listeners.clear(); this.evidenceListeners.clear(); this.engine = undefined; }
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
