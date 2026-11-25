import os from 'node:os';
import { EvidenceGenerator, type GeneratedEvidenceClaim } from '../ai/generation-evidence';
import { EvidenceReranker, type RerankedHit } from '../ai/rerank-evidence';
import { pilotConfig } from '../ai/loopback-rerank';
import { bindActiveDeadline, remainingOperationMs, deadlineFailure, cancelActiveDeadline } from '../ai/active-deadline';
import { RerankRuntimeProfiles, type RerankAdmission } from '../ai/rerank-profile';
import { configDigest } from '../ai/disclosure';
import { ProviderFailure, type ProviderConfig, type ProviderPreference, type ProviderFailureCode, type AiOperationStatus, type CallContext } from '../ai/contracts';
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
// The concrete trusted owner is retained, not a callback resolving a mutable host.
type RetirementTarget = { invalidate(): void };
type EvidenceRole = 'reranking' | 'generation';
export const EVIDENCE_PREVIEW_TTL_MS = 300_000;
export type RerankPreview = { role: EvidenceRole; sequence: number; revision: number; expiresUnixMs: number; config: ProviderConfig; scopeId: string; query: string; hits: EvidenceHit[]; runtimeProfileBinding?: string; runtimeProfileDigest?: string };
// Internal elapsed-time deadlines are never taken from the returned preview.
type ActiveEvidenceOperation = { abort: AbortController; context: CallContext; revision: number };
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
  private terminalRetired = false;
  private revision = 0;
  private lastQuery = '';
  private sequence = 0;
  private prepared: Partial<Record<EvidenceRole,PendingEvidencePreview>> = {};
  private previewTimers: Partial<Record<EvidenceRole,ReturnType<typeof setTimeout>>> = {};
  private activeEvidence: Partial<Record<EvidenceRole,ActiveEvidenceOperation>> = {};
  private readonly generator = new EvidenceGenerator();
  private readonly reranker = new EvidenceReranker();
  private readonly rerankProfiles = new RerankRuntimeProfiles(()=>this.invalidateRerankProfile());
  private active = false;
  private pending?: { request: SearchRequest; revision: number; resolve: (v: ApiResult<SearchResponse>) => void };
  private listeners = new Set<() => void>();
  private evidenceListeners = new Set<() => void>();
  private pendingExpiryNotification?: object;
  private notifying = false;
  private revokingSharedAuthority = false;
  private sharedResetDepth = 0;
  private runtimeSettingsChanging = false;
  private pendingHostRetirement?: RetirementTarget;
  private sharedAuthorityFault = false;
  private deliveringLifecycle = false;
  private evidencePending?: number;
  private lifecyclePending?: {revision:number; final:boolean; listeners:(() => void)[]};
  private notificationVersion = 0;
  private waveAdditions = 0;
  private readonly quarantined = new WeakSet<() => void>();
  private state: UiState = { phase: 'idle', message: 'Enter a query to search original Markdown.', response: null };
  constructor(private readonly navigate: (hit: EvidenceHit) => Promise<void>,
    private readonly advancedStatus?: () => AdvancedHealth,
    private readonly ingestionStatus?: () => IngestionStatus,
    private readonly rerankPort?: RerankPort, private readonly generationPort?: RerankPort,
    private readonly revokeSharedAuthority?: () => void) {}
  attach(engine: Engine): void {
    if (this.disposed) return;
    const replaced = this.engine !== undefined && this.engine !== engine;
    this.engine = engine; this.error = null;
    if (replaced) this.invalidate(); else this.emit();
  }
  configure(enabled: boolean, paused: boolean, error: string | null = null): void {
    if (this.disposed) return;
    this.enabled = enabled; this.paused = paused; this.error = safeCode(error); this.invalidate();
  }
  detach(): void { if (this.disposed) return; this.engine = undefined; this.rerankProfiles.revoke(); this.invalidate(); }
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
    return this.addObserver(this.listeners, listener);
  }
  // Role-local evidence transitions must not invalidate the independent dense machine.
  subscribeEvidence(listener: () => void): () => void {
    return this.addObserver(this.evidenceListeners, listener);
  }
  private addObserver(channel: Set<() => void>, listener: () => void): () => void {
    if (this.disposed) return () => {};
    if (this.quarantined.has(listener)) {
      console.warn('SEARCH_OBSERVER_REJECTED', 'quarantined');
      return () => {};
    }
    if (!channel.has(listener)) {
      // Count successful additions, including remove/re-add, across both channels.
      if ((this.notifying || this.revokingSharedAuthority) && this.waveAdditions >= 32) {
        console.warn('SEARCH_OBSERVER_REJECTED', 'registration-budget');
        return () => {};
      }
      channel.add(listener);
      if (this.notifying || this.revokingSharedAuthority) {
        this.waveAdditions++;
        this.notificationVersion++;
        if (channel === this.listeners) this.queueLifecycle();
        else this.evidencePending = this.revision;
      }
    }
    return () => { channel.delete(listener); };
  }
  private quarantine(listener: () => void, reason: 'mutation-budget' | 'exception'): void {
    this.quarantined.add(listener);
    this.listeners.delete(listener);
    this.evidenceListeners.delete(listener);
    // Never log callback identity, exception text, state, or source material.
    console.warn('SEARCH_OBSERVER_QUARANTINED', reason);
  }
  private emitEvidence(): void {
    this.pendingExpiryNotification = undefined;
    if (this.disposed) return;
    this.evidencePending = this.revision;
    this.notificationVersion++;
    this.drainNotifications();
  }
  private drainNotifications(continueWave = false): void {
    if (this.notifying || this.revokingSharedAuthority) return;
    this.notifying = true;
    if (!continueWave) this.waveAdditions = 0;
    const mutations = new Map<() => void, number>();
    try {
      while (this.lifecyclePending || this.evidencePending !== undefined) {
        const lifecycle = this.lifecyclePending;
        const revision = this.evidencePending;
        const evidence = revision === undefined ? [] : [...this.evidenceListeners];
        this.lifecyclePending = undefined;
        this.evidencePending = undefined;
        const deliver = (listener: () => void): void => {
          if (this.quarantined.has(listener)) return;
          const before = this.notificationVersion;
          try { listener(); }
          catch { this.quarantine(listener, 'exception'); return; }
          if (before !== this.notificationVersion) {
            const count = (mutations.get(listener) ?? 0) + 1;
            mutations.set(listener, count);
            if (count >= 16) this.quarantine(listener, 'mutation-budget');
          }
        };
        this.deliveringLifecycle = !!lifecycle;
        try {
          for (const listener of lifecycle?.listeners ?? []) {
            if (this.revision !== lifecycle!.revision || this.disposed !== lifecycle!.final) break;
            if (this.listeners.has(listener)) deliver(listener);
          }
        } finally { this.deliveringLifecycle = false; }
        for (const listener of evidence) {
          if (this.disposed || this.revision !== revision) break;
          if (this.evidenceListeners.has(listener)) deliver(listener);
        }
      }
    } finally {
      this.notifying = false;
      this.lifecyclePending = undefined;
      this.evidencePending = undefined;
      if (this.disposed) { this.listeners.clear(); this.evidenceListeners.clear(); }
    }
    // A search submitted by an observer is already queued; start only after
    // the wave has settled, so a later listener can supersede it first.
    void this.pump();
  }
  // Polling/rendering may discover expiry while a listener is already executing.
  // Commit cancellation now; join the active notification wave or defer to
  // a single microtask when expiry is discovered outside evidence delivery.
  private notifyExpiry(): void {
    if (this.disposed) return;
    if (this.notifying || this.revokingSharedAuthority) { this.emitEvidence(); return; }
    if (this.pendingExpiryNotification) return;
    const notification = {};
    this.pendingExpiryNotification = notification;
    queueMicrotask(() => {
      if (!this.disposed && this.pendingExpiryNotification === notification) this.emitEvidence();
    });
  }
  private queueLifecycle(): void {
    this.lifecyclePending = {revision:this.revision,final:this.disposed,listeners:[...this.listeners]};
  }
  private emit(final = false, retireHost?: RetirementTarget, requireRetirement = false): void {
    if (this.disposed && !final) return;
    // A newer request must never replace an unresolved trusted retirement.
    // A reentrant retirement request is denied before it can acquire authority.
    if (requireRetirement && (this.revokingSharedAuthority || (this.sharedAuthorityFault && this.notifying)))
      throw new StandaloneError('INTERNAL_FAILURE');
    if (retireHost && !this.pendingHostRetirement) this.pendingHostRetirement = retireHost;
    this.pendingExpiryNotification = undefined;
    // Reserve publication before the synchronous host hook. A nested transition
    // may replace it but cannot drain or dispatch while authority is being revoked.
    if (!this.notifying && !this.revokingSharedAuthority) this.waveAdditions = 0;
    this.queueLifecycle();
    this.notificationVersion++;
    if (this.revokingSharedAuthority || (this.sharedAuthorityFault && this.pendingHostRetirement && this.notifying)) return;
    this.revokingSharedAuthority = true;
    try {
      this.revokeSharedAuthority?.();
      const pending = this.pendingHostRetirement;
      pending?.invalidate();
      this.pendingHostRetirement = undefined;
      // The previous obligation is complete; only now can this request's
      // concrete host be retired. Failed requests never reach persistence.
      if (retireHost && retireHost !== pending) {
        this.pendingHostRetirement = retireHost;
        retireHost.invalidate();
        this.pendingHostRetirement = undefined;
      }
      this.sharedAuthorityFault = false;
    } catch (error) {
      // A failed trusted hook is not an observer exception: no authority
      // can be issued until a later shared transition successfully revokes it.
      this.sharedAuthorityFault = true;
      if (!this.disposed) {
        this.pending?.resolve(failure('INTERNAL_FAILURE'));
        this.pending = undefined;
        this.resetSharedState({phase:'error',message:'INTERNAL_FAILURE',response:null});
      }
      this.queueLifecycle();
      this.notificationVersion++;
      console.warn('SEARCH_AUTHORITY_REVOKE_FAILED');
      if (requireRetirement) throw error;
    } finally {
      this.revokingSharedAuthority = false;
      this.drainNotifications(true);
    }
  }
  /** Host admission stays closed through shared revocation and lifecycle delivery,
   * never through independent evidence-only notifications. */
  sharedAuthorityTransition(): boolean {
    return this.disposed || this.runtimeSettingsChanging || this.sharedAuthorityFault || this.sharedResetDepth > 0 || this.revokingSharedAuthority || this.deliveringLifecycle || !!this.lifecyclePending;
  }
  /** Fence admission before observers or persistence can yield. Failed retirement
   * remains latched independently of the settings transaction's lifetime. */
  beginRuntimeSettingsChange(retire: RetirementTarget | undefined, revokeRerankProfile: boolean): void {
    if (this.disposed || this.revokingSharedAuthority || (this.sharedAuthorityFault && this.notifying))
      throw new StandaloneError('INTERNAL_FAILURE');
    this.runtimeSettingsChanging = true;
    this.resetSharedState({phase:'idle',message:'Results cleared; search to verify current sources.',response:null});
    if (this.disposed) return;
    if (revokeRerankProfile) this.rerankProfiles.revoke();
    this.emit(false, retire, true);
  }
  endRuntimeSettingsChange(): void { this.runtimeSettingsChanging = false; }
  invalidate(): void { if (!this.disposed) this.invalidateState(); }
  private resetSharedState(state: UiState, reserve?: (revision: number) => void): number {
    const revision = ++this.revision;
    this.sharedResetDepth++;
    try {
      // Commit ownership and reserve the new job before synchronous abort
      // callbacks. A nested reset or terminal seal can then settle that job,
      // never be overwritten by the interrupted caller, and own publication.
      this.lastQuery = '';
      this.pending?.resolve(failure('SUPERSEDED')); this.pending = undefined;
      this.state = state;
      reserve?.(revision);
      this.revokeEvidence();
      return revision;
    } finally {
      this.sharedResetDepth--;
      // A nested search may already have published, but dispatch must wait
      // for the outermost abort wave to finish.
      if (this.revision !== revision) void this.pump();
    }
  }
  private ownsRevision(revision: number): boolean {
    return !this.disposed && this.revision === revision;
  }
  private invalidateState(final = false, retireHost?: RetirementTarget, requireRetirement = false): void {
    const revision = this.resetSharedState({phase:'idle',message:'Results cleared; search to verify current sources.',response:null});
    if (this.ownsRevision(revision)) this.emit(final, retireHost, requireRetirement);
  }
  message(error: string): void {
    if (this.disposed) return;
    // Publish only the committed transition; no continuation after observers.
    const revision = this.resetSharedState({phase:'error',message:safeCode(error)!,response:null});
    if (this.ownsRevision(revision)) this.emit();
  }
  async search(input: unknown): Promise<ApiResult<SearchResponse>> {
    let request: SearchRequest;
    try { request = parseSearch(input); } catch { return failure('INVALID_REQUEST'); }
    if (this.disposed || !this.enabled) return failure('DISABLED');
    if (this.runtimeSettingsChanging) return failure('SUPERSEDED');
    if (this.sharedAuthorityFault && this.pendingHostRetirement && this.notifying) return failure('INTERNAL_FAILURE');
    if (!this.engine) return failure(this.error ?? 'INDEX_UNAVAILABLE');
    if (this.sharedResetDepth && this.sharedAuthorityFault) return failure('INTERNAL_FAILURE');
    let revision!: number;
    const result = new Promise<ApiResult<SearchResponse>>(resolve => {
      revision = this.resetSharedState({phase:'searching',message:'Verifying original sources…',response:null},
        owned => { this.pending = {request,revision:owned,resolve}; });
    });
    if (this.ownsRevision(revision)) this.emit();
    return result;
  }
  private async pump(): Promise<void> {
    if (this.notifying || this.runtimeSettingsChanging || this.sharedResetDepth || this.revokingSharedAuthority || this.sharedAuthorityFault || this.active || !this.pending) return;
    const job = this.pending; this.pending = undefined;
    if (this.disposed || job.revision !== this.revision || !this.engine) {
      job.resolve(failure('SUPERSEDED')); return;
    }
    this.active = true;
    let result: ApiResult<SearchResponse>;
    try {
      // Public callers must never receive references into immutable engine generations.
      const response = structuredClone(await this.engine.search(job.request));
      result = { apiVersion: 1, ok: true, value: response };
    } catch (error) { result = failure(error instanceof StandaloneError ? error.code : 'INTERNAL_FAILURE'); }
    if (job.revision !== this.revision || this.disposed) result = failure('SUPERSEDED');
    else {
      this.lastQuery = result.ok && result.value.status === 'ok' && result.value.executedMode === 'lexical' ? job.request.query : '';
      this.state = !result.ok ? { phase: 'error', message: result.error, response: null }
        : { phase: result.value.status === 'failed' ? 'error' : 'results', response: structuredClone(result.value),
          message: result.value.error ? safeCode(result.value.error)! : result.value.hits.length ? 'Verified at search time; checked again on open.' : 'No matching evidence.' };
      this.emit();
    }
    // Keep the active slot until publication finishes. A callback may have
    // superseded this result while receiving it.
    if (job.revision !== this.revision || this.disposed) result = failure('SUPERSEDED');
    this.active = false; job.resolve(result); void this.pump();
  }
  private port(role: EvidenceRole): RerankPort | undefined {
    return role === 'reranking' ? this.rerankPort : this.generationPort;
  }
  prepareRerank(): RerankPreview { return this.prepareEvidence('reranking'); }
  prepareGeneration(): RerankPreview { return this.prepareEvidence('generation'); }
  /** Settings changes revoke admission itself, not just pending consent. */
  revokeRerankProfile(): void { this.rerankProfiles.revoke(); }
  private invalidateRerankProfile(): void {
    if (this.cancelEvidenceState('reranking')) this.notifyExpiry();
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
        && this.profileCurrent(pending.preview,checkConfig)
        && this.prepared[role] === pending && !this.disposed) return pending;
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
    if (this.sharedAuthorityTransition()) throw new ProviderFailure('NOT_READY');
    // Replacing consent is a single commit. In particular no observer can
    // prepare another preview between clearing the old timer and owning the new one.
    const removed = this.clearPreview(role);
    let changed = removed;
    try {
      const port = this.port(role), pref = port?.config();
      if (role === 'reranking' && pref?.state !== 'configured') this.rerankProfiles.revoke();
      if (!pref || pref.state === 'disabled') throw new ProviderFailure('DISABLED');
      if (pref.state !== 'configured') throw new ProviderFailure('CONFIG_INVALID');
      const config = pilotConfig(pref);
      const scopeId = port?.scopeId(), response = this.state.response;
      if (this.disposed || !this.enabled || this.paused || this.activeEvidence[role] || !isDigest(scopeId)
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
      changed = true;
      return structuredClone(preview);
    } catch (error) {
      if (role === 'reranking' && !this.disposed && !this.activeEvidence.reranking
        && error instanceof ProviderFailure && error.code === 'NOT_READY'
        && this.rerankPort?.config().state === 'configured') {
        this.state = {...this.state,rerank:{phase:'error',error:error.code,hits:[]}};
        changed = true;
      }
      throw error;
    } finally {
      if (changed) this.emitEvidence();
    }
  }
  private revokeEvidence(): void {
    const aborts: AbortController[] = [];
    for (const r of ['reranking','generation'] as const) {
      this.clearPreview(r);
      const active = this.activeEvidence[r];
      if (active) aborts.push(active.abort);
    }
    // Clear both previews and pin the old owners before any callback.
    for (const abort of aborts) abort.abort();
  }
  // Role-local revocation and explicit cancellation use the same deadline
  // authority as the worker. A new pending preview is a distinct operation.
  private cancelEvidenceState(role: EvidenceRole, explicit = false): boolean {
    if (this.disposed) return false;
    const hadPreview = !!this.prepared[role];
    const active = this.activeEvidence[role];
    const revision = this.revision;
    this.clearPreview(role);
    const key = role === 'reranking' ? 'rerank' : 'generation';
    const previous = this.state[key];
    const current = active?.revision === this.revision ? active : undefined;
    if (!hadPreview && !previous && !current) { active?.abort.abort(); return false; }
    const error = current
      ? cancelActiveDeadline(current.context).code
      : !hadPreview && previous?.error === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED';
    if (!hadPreview && previous?.phase === 'error' && previous.error === error) {
      // Keep historical standalone cancel notifications (and worker settlement),
      // but a listener cleaning up this same terminal snapshot is a no-op.
      active?.abort.abort();
      return this.ownsRevision(revision) && explicit && !this.notifying;
    }
    this.state = {...this.state,[key]:{phase:'error',error,hits:[]}};
    active?.abort.abort();
    return this.ownsRevision(revision);
  }
  private cancelEvidence(role: EvidenceRole): void {
    if (this.cancelEvidenceState(role,true)) this.emitEvidence();
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
    if (this.sharedAuthorityTransition()) throw new ProviderFailure('DISCLOSURE_DENIED');
    const approved = this.currentPreview(role,false)?.preview;
    if (!approved) throw new ProviderFailure('DISCLOSURE_DENIED');
    this.clearPreview(role);
    const port = this.port(role);
    if (!port || this.activeEvidence[role] || !['synthetic','public'].includes(classification)
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
    const operation = {abort,context,revision:approved.revision};
    this.activeEvidence[role] = operation;
    this.state = {...this.state,[key]:{phase:'running',error:null,hits:[]}};
    try {
      this.emitEvidence();
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
        const valid = current();
        remainingOperationMs(context);
        if (!valid) throw new ProviderFailure('CANCELLED');
        if (this.activeEvidence[role] !== operation || this.revision !== approved.revision || this.disposed) return;
        // Retire the operation before notifying listeners: a reentrant cancel
        // now concerns a completed result, not a still-running deadline.
        delete this.activeEvidence[role];
        this.state = {...this.state,[key]:{phase:'results',error:null,hits}};
        this.emitEvidence();
      }
    } catch (error) {
      error = deadlineFailure(context) ?? error;
      if (this.activeEvidence[role] === operation && this.revision === approved.revision && !this.disposed) {
        delete this.activeEvidence[role];
        this.state = {...this.state,[key]:{phase:'error',error:error instanceof ProviderFailure?error.code:'NOT_READY',hits:[]}};
        this.emitEvidence();
      }
    } finally { if (this.activeEvidence[role] === operation) delete this.activeEvidence[role]; }
  }
  async open(index: number, expected?: EvidenceHit): Promise<ApiResult<null>> {
    const hit = this.state.response?.hits[index];
    if (this.sharedAuthorityTransition() || !this.enabled || !hit || !Number.isInteger(index)
      || expected && JSON.stringify(expected) !== JSON.stringify(hit)) return failure('NAVIGATION_REJECTED');
    const revision = this.revision;
    try {
      await this.navigate(structuredClone(hit));
      return this.disposed || this.revision !== revision
        ? failure('SUPERSEDED') : { apiVersion: 1, ok: true, value: null };
    }
    catch {
      if (this.disposed || this.revision !== revision) return failure('SUPERSEDED');
      this.message('NAVIGATION_REJECTED');
      return failure('NAVIGATION_REJECTED');
    }
  }
  control(action: 'pause' | 'cancel' | 'resume' | 'rebuild', retireHost?: RetirementTarget): ApiResult<{ cancelled: boolean | null }> {
    if (this.disposed || !this.enabled || !this.engine) return failure('DISABLED');
    if (this.runtimeSettingsChanging || this.sharedResetDepth || this.revokingSharedAuthority) return failure('SUPERSEDED');
    if (this.sharedAuthorityFault && this.pendingHostRetirement && this.notifying) return failure('INTERNAL_FAILURE');
    const engine = this.engine, revision = this.revision + 1;
    try { this.invalidateState(false, retireHost, true); }
    catch { return failure('INTERNAL_FAILURE'); }
    // The initial shared invalidation is synchronous. Do not execute a stale
    // control command after an observer supersedes its revision or detaches.
    if (this.disposed || this.revision !== revision || this.engine !== engine) return failure('SUPERSEDED');
    try {
      const pause = action === 'pause' || action === 'cancel';
      const cancelled = pause ? engine.cancel() : (engine[action](), null);
      if (this.disposed || this.revision !== revision || this.engine !== engine) return failure('SUPERSEDED');
      this.paused = pause;
      this.emit();
      if (this.disposed || this.revision !== revision || this.engine !== engine) return failure('SUPERSEDED');
      return { apiVersion: 1, ok: true, value: { cancelled } };
    } catch { return failure('INTERNAL_FAILURE'); }
  }
  /** Commit the terminal snapshot without calling host teardown or observers.
   * The plugin seals all sibling authorities before any cancellation callback. */
  sealTerminal(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine = undefined;
    this.revision++;
    this.lastQuery = '';
    this.state = {phase:'idle',message:'Results cleared; search to verify current sources.',response:null};
    this.clearPreview('reranking'); this.clearPreview('generation');
    this.pendingExpiryNotification = undefined;
    this.evidencePending = undefined;
    this.evidenceListeners.clear();
    this.pending?.resolve(failure('SUPERSEDED')); this.pending = undefined;
    this.rerankProfiles.revoke();
  }
  dispose(): void {
    this.sealTerminal();
    if (this.terminalRetired) return;
    this.terminalRetired = true;
    // Abort can synchronously invoke listeners; every old publication right
    // and both consent capabilities have already been revoked.
    try { this.revokeEvidence(); }
    finally { this.emit(true); }
  }
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
