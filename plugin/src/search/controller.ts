import os from 'node:os';
import { EvidenceGenerator, type GeneratedEvidenceClaim } from '../ai/generation-evidence';
import { EvidenceReranker, type RerankedHit } from '../ai/rerank-evidence';
import { pilotConfig } from '../ai/loopback-rerank';
import { bindActiveDeadline, remainingOperationMs, deadlineFailure, cancelActiveDeadline } from '../ai/active-deadline';
import { RerankRuntimeProfiles, type RerankAdmission } from '../ai/rerank-profile';
import { configDigest } from '../ai/disclosure';
import { GenerationCredentialAuthority, type GenerationCredentialStamp } from '../ai/generation-credential';
import { ProviderFailure, type ProviderConfig, type ProviderPreference, type ProviderFailureCode, type AiOperationStatus, type CallContext, type CredentialResolver } from '../ai/contracts';
import { hash, isDigest } from '../standalone/contracts';
import type { AdvancedHealth } from '../advanced/health';
import type { IngestionStatus } from '../advanced/manager';
import { isRecord, StandaloneError, validateRequest, validProperty, BOUNDS,
  type SearchRequest, type SearchResponse, type Predicate, type EvidenceHit, type SearchMetadata } from '../standalone/contracts';
import type { StandaloneEngine, ChatScopeLease } from '../standalone/engine';
import { parseScopeSelector, type ScopeSelector, type ScopedSearch, type ScopeSnapshot } from '../standalone/chat-scope';
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
  if (value.range) {
    count(value.range.sourceId); count(value.range.sourceSha256);
    for (const offset of [value.range.byteStart,value.range.byteEnd,value.range.charStart,value.range.charEnd]) count(offset);
  }
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
type Engine = Pick<StandaloneEngine, 'search' | 'status' | 'cancel' | 'resume' | 'rebuild'>
  & Partial<Pick<StandaloneEngine, 'captureChatScope'>>;
// The concrete trusted owner is retained, not a callback resolving a mutable host.
type RetirementTarget = { invalidate(): void };
type RetirementObligation = {
  kind: 'source' | 'evidence' | 'role'; revision: number; owner?: AbortController;
  role?: EvidenceRole; running?: boolean;
  run: () => void; attempted: boolean; failed?: boolean;
};
// One shared controller owns admission; obligations do not confer authority.
// A bounded overflow is terminal-only: never silently discard freshness work.
const MAX_RETIREMENT_OBLIGATIONS = 4096;
type EvidenceRole = 'reranking' | 'generation';
export const EVIDENCE_PREVIEW_TTL_MS = 300_000;
export type RerankPreview = { role: EvidenceRole; sequence: number; revision: number; expiresUnixMs: number; config: ProviderConfig; scopeId: string; query: string; hits: EvidenceHit[]; runtimeProfileBinding?: string; runtimeProfileDigest?: string; credentialStamp?:GenerationCredentialStamp };
// Internal elapsed-time deadlines are never taken from the returned preview.
type BoundGenerationCredential = {owner:object;viewOwner:object;configuration:string;stamp:GenerationCredentialStamp};
type ActiveEvidenceOperation = { abort: AbortController; context: CallContext; revision: number; credential?:BoundGenerationCredential };
type PendingEvidencePreview = { preview: RerankPreview; monotonicStartedMs: number; bootStartedSeconds: number; credential?:BoundGenerationCredential };
export type ScopedRetrievalTurn = Readonly<{ result: Promise<ApiResult<SearchResponse>>; cancel(): void }>;
/** Opaque host identities. They only select host-owned state; they never carry
 * a lease, grant, configuration, credential, or transport capability. */
export type RetainedChatSessionOwner = object;
export type RetainedChatTurnOwner = object;
export type RetainedScopedRetrievalTurn = Readonly<{ owner: RetainedChatTurnOwner; result: Promise<ApiResult<SearchResponse>> }>;
export type RetainedScopedView = { scope: ScopeSnapshot; response: SearchResponse };
const SCOPED_RETRIEVAL_TIMEOUT_MS = 30_000;
const MAX_CHAT_SESSIONS = 4;
type RetainedScopedTurn = { readonly session: RetainedChatSessionOwner; readonly owner: RetainedChatTurnOwner;
  lease?: ChatScopeLease; response?: SearchResponse; check?: () => void;
  finishRead?: (value: ApiResult<RetainedScopedView>) => void;
  rejectCredential?: (error:ProviderFailure)=>void; configuration?:string; };
type ActiveScopedRetrieval = { readonly abort: AbortController; readonly context: CallContext;
  readonly revision: number; readonly sourceRevision: number; readonly finish: (value: ApiResult<SearchResponse>) => void;
  readonly retained?: RetainedScopedTurn;
  timer?: ReturnType<typeof setTimeout>; retired: boolean; inFlight: boolean };
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
  // This is deliberately not a caller-visible handle. Only this host can cancel,
  // retire, or publish a scoped retrieval turn.
  private scopedRetrieval?: ActiveScopedRetrieval;
  // Object identity is host-local: a cloned or foreign session never matches.
  private readonly retainedSessions = new Set<RetainedChatSessionOwner>();
  private generationAdmissionDepth = 0;
  private generationTransition?:object;
  private generationTransitionView?:object;
  private generationPreviewReading = false;
  private readonly defaultGenerationView = Object.freeze({});
  private readonly generationViews = new WeakSet<object>();
  private readonly generationCredential = new GenerationCredentialAuthority();
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
  private readonly retirement: {
    host?: RetirementTarget; sharedHookFault: boolean; obligations: RetirementObligation[];
    running: boolean; sourceRunning: boolean; overflow: boolean;
  } = {sharedHookFault:false,obligations:[],running:false,sourceRunning:false,overflow:false};
  private sourceRevision = 0;
  private sourceDrains = new Set<Promise<void>>();
  private sourceDrainFailed = false;
  /** An asynchronous owner cannot be considered retired on dispatch alone.
   * A rejected drain is terminal-only; rebuild cannot prove process exit. */
  trackSourceDrain(work:Promise<void>):void {
    if(this.disposed){void work.catch(()=>{});return;}
    if(this.sourceDrains.size>=MAX_RETIREMENT_OBLIGATIONS){
      this.retirement.overflow=true;void work.catch(()=>{});return;
    }
    this.sourceDrains.add(work);
    // An independently detected stale source may start retirement outside a
    // Vault-event callback. Invalidate existing publication rights as well.
    if(!this.retirement.running&&!this.retirement.sourceRunning)this.invalidateSource([]);
    void work.then(()=>{
      this.sourceDrains.delete(work);
      if(!this.disposed)this.emit();
    },()=>{
      this.sourceDrains.delete(work);this.sourceDrainFailed=true;
      if(!this.disposed){this.failRetirement();this.emit();}
    });
  }
  private get pendingHostRetirement(): RetirementTarget | undefined { return this.retirement.host; }
  private set pendingHostRetirement(value: RetirementTarget | undefined) { this.retirement.host = value; }
  private get sourceRetirementPending(): boolean {
    return this.retirement.sourceRunning || this.sourceDrains.size>0 || this.sourceDrainFailed || this.retirement.obligations.some(item => item.kind === 'source') || this.retirement.overflow;
  }
  private get explicitRetirementPending(): boolean {
    return this.sourceRetirementPending || this.retirement.obligations.some(item => item.kind !== 'role' && (item.failed || !this.retirement.running));
  }
  private get sharedAuthorityFault(): boolean {
    return this.retirement.sharedHookFault || this.explicitRetirementPending;
  }
  /** Runtime application cannot hand over source owners while concrete
   * retirement work remains unresolved. Generic hook recovery is separate. */
  assertSourceRetirementSettled():void {
    if(this.explicitRetirementPending)throw new StandaloneError('INTERNAL_FAILURE');
  }
  /** Advanced source authorization is independent of ordinary lexical revisions. */
  sourceAuthorityRevision(): number { return this.sourceRevision; }
  sourceAuthorityCurrent(revision: number): boolean {
    return !this.disposed && !this.sourceRetirementPending && revision === this.sourceRevision;
  }
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
    private readonly revokeSharedAuthority?: () => void,
    private readonly credentialResolver?: CredentialResolver) {}
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
  status(): SearchStatus {
    const failed = !this.disposed && this.sharedAuthorityFault;
    const engine = this.engine?.status();
    return statusSnapshot(failed && engine ? {...engine,status:'failed',generationId:null,error:'INTERNAL_FAILURE'} : engine,
      !this.disposed && this.enabled, this.paused, failed ? 'INTERNAL_FAILURE' : this.error,
      this.advancedStatus?.(), this.ingestionStatus?.());
  }
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
    if (this.roleRetirement(role)) return {phase:'failed',error:state?.error ?? 'NOT_READY'};
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
    if (this.notifying || this.revokingSharedAuthority || this.retirement.running || this.retirement.sourceRunning) return;
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
    if (!this.disposed && this.explicitRetirementPending && !this.retirement.running && !this.retirement.sourceRunning)
      this.failRetirement();

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
    if (this.revokingSharedAuthority || this.retirement.running || this.retirement.sourceRunning || (this.sharedAuthorityFault && this.pendingHostRetirement && this.notifying)) return;
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
      this.retirement.sharedHookFault = false;
    } catch (error) {
      // A failed trusted hook is not an observer exception: no authority
      // can be issued until a later shared transition successfully revokes it.
      this.retirement.sharedHookFault = true;
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
    if (this.disposed || this.explicitRetirementPending || this.retirement.running || this.revokingSharedAuthority || (this.sharedAuthorityFault && this.notifying))
      throw new StandaloneError('INTERNAL_FAILURE');
    this.runtimeSettingsChanging = true;
    ++this.sourceRevision;
    this.resetSharedState({phase:'idle',message:'Results cleared; search to verify current sources.',response:null});
    if (this.disposed) return;
    if (revokeRerankProfile) this.rerankProfiles.revoke();
    this.emit(false, retire, true);
    if (this.explicitRetirementPending) throw new StandaloneError('INTERNAL_FAILURE');
  }
  endRuntimeSettingsChange(): void { this.runtimeSettingsChanging = false; }
  invalidate(): void { if (!this.disposed) this.invalidateState(); }
  /** Source-event retirement can itself synchronously call abort listeners.
   * Run it only after the same logical shared reset as lexical search. */
  invalidateSource(obligations: readonly (() => void)[]): void {
    if (this.disposed) return;
    const revision = ++this.sourceRevision;
    for (const run of obligations) this.enqueueRetirement({kind:'source',revision,run,attempted:false});
    // Nested source work joins the running wave. If the wave belongs to an
    // ordinary shared reset, revoke any lexical reservation made in its callbacks.
    if (this.retirement.sourceRunning) return;
    if (this.retirement.running) {
      this.resetSharedState({phase:'idle',message:'Results cleared; search to verify current sources.',response:null});
      return;
    }
    this.transitionSourceRetirement(false);
  }
  private enqueueRetirement(obligation: RetirementObligation): void {
    if (obligation.owner && this.retirement.obligations.some(item => item.owner === obligation.owner)) return;
    if (this.retirement.obligations.length >= MAX_RETIREMENT_OBLIGATIONS) {
      this.retirement.overflow = true;
      return;
    }
    this.retirement.obligations.push(obligation);
  }
  private drainRetirements(): void {
    if (this.retirement.running) return;
    this.retirement.running = true;
    try {
      // Each concrete obligation is attempted at most once per bounded wave.
      // Nested work may join it, but cannot recursively retry a failure.
      for (let count = 0; count < MAX_RETIREMENT_OBLIGATIONS; count++) {
        const obligation = this.retirement.obligations.find(item => !item.attempted && !item.running && (item.kind !== 'role' || this.disposed));
        if (!obligation) break;
        obligation.attempted = true;
        if (this.disposed && obligation.kind === 'source') continue;
        try {
          obligation.run();
          const index = this.retirement.obligations.indexOf(obligation);
          if (index >= 0) this.retirement.obligations.splice(index,1);
        } catch {
          obligation.failed = true;
          console.warn('SEARCH_RETIREMENT_OBLIGATION_FAILED',obligation.kind);
        }
      }
    } finally {
      this.retirement.running = false;
      this.releaseRetiredScopedRetrieval();
      if (this.disposed) {
        // Terminal owners are drained independently by the plugin's existing
        // storage, persistence and bounded operation barriers.
        this.retirement.obligations.length = 0;
        this.retirement.overflow = false;
      }
    }
  }
  private transitionSourceRetirement(retry: boolean): void {
    if (this.disposed || this.retirement.running || this.retirement.sourceRunning) return;
    this.retirement.sourceRunning = true;
    try {
      if (retry) for (const obligation of this.retirement.obligations) obligation.attempted = false;
      this.resetSharedState({phase:'idle',message:'Results cleared; search to verify current sources.',response:null});
    } finally {
      this.retirement.sourceRunning = false;
      if (!this.disposed) this.emit();
      else this.drainNotifications();
    }
  }
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
      this.revokeScopedRetrieval();
      this.revokeEvidence();
      if (!this.disposed && !this.retirement.running && (this.retirement.obligations.some(item => item.kind !== 'role') || this.retirement.overflow))
        this.failRetirement();
      return revision;
    } finally {
      this.sharedResetDepth--;
      // A nested search may already have published, but dispatch must wait
      // for the outermost abort wave to finish.
      if (this.revision !== revision && !this.sharedResetDepth && !this.retirement.running && !this.retirement.sourceRunning) {
        // Nested publication was reserved while callbacks were still running.
        if (this.disposed) this.drainNotifications();
        else this.emit();
      }
    }
  }
  private failRetirement(): void {
    this.pending?.resolve(failure('INTERNAL_FAILURE')); this.pending = undefined;
    this.state = {phase:'error',message:'INTERNAL_FAILURE',response:null};
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
    if (this.explicitRetirementPending) return failure('INTERNAL_FAILURE');
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
  /**
   * Host-only retrieval capability. Cancellation is tied to this exact turn;
   * neither a lease nor generation/disclosure permission leaves the controller.
   */
  startScopedChatRetrieval(selector: unknown, input: unknown): ScopedRetrievalTurn {
    return this.beginScopedRetrieval(selector,input);
  }
  openRetainedChatSession(): RetainedChatSessionOwner {
    if (this.disposed) throw new ProviderFailure('DISABLED');
    if (this.retainedSessions.size >= MAX_CHAT_SESSIONS) throw new ProviderFailure('LIMIT_EXCEEDED');
    const session = Object.freeze({});
    this.retainedSessions.add(session);
    return session;
  }
  closeRetainedChatSession(session: RetainedChatSessionOwner): void {
    if (!this.retainedSessions.delete(session)) return;
    const operation = this.scopedRetrieval;
    if (operation?.retained?.session === session) this.retireScopedRetrieval(operation,'CANCELLED');
  }
  startRetainedChatTurn(session: RetainedChatSessionOwner, selector: unknown, input: unknown): RetainedScopedRetrievalTurn {
    const owner = Object.freeze({});
    const turn = this.beginScopedRetrieval(selector,input,{session,owner});
    return Object.freeze({owner,result:turn.result});
  }
  private ownedRetainedTurn(session: RetainedChatSessionOwner, owner: RetainedChatTurnOwner): ActiveScopedRetrieval | undefined {
    const operation = this.scopedRetrieval;
    return !this.disposed && this.retainedSessions.has(session) && operation && !operation.retired
      && operation.retained?.session === session && operation.retained.owner === owner ? operation : undefined;
  }
  cancelRetainedChatTurn(session: RetainedChatSessionOwner, owner: RetainedChatTurnOwner): void {
    const operation = this.ownedRetainedTurn(session,owner);
    if (operation) this.retireScopedRetrieval(operation,'CANCELLED');
  }
  /** Trusted host input boundary. No provider I/O, grant, or secret is returned.
   * A resolver is injected by the host, never selected by a turn caller. */
  bindRetainedGenerationCredential(session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner,
    token:string):Promise<GenerationCredentialStamp> {
    return this.bindRetainedCredential(session,owner,{token});
  }
  resolveRetainedGenerationCredential(session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner):Promise<GenerationCredentialStamp> {
    return this.bindRetainedCredential(session,owner);
  }
  clearRetainedGenerationCredential(session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner):void {
    const operation=this.ownedRetainedTurn(session,owner);
    if (!operation) return;
    this.generationCredential.revoke(owner);
    // An outstanding resolver may not be replaced until physically settled.
    if (operation.retained?.rejectCredential) this.retireScopedRetrieval(operation,'CANCELLED');
  }
  private bindRetainedCredential(session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner,
    input?:{token:string}):Promise<GenerationCredentialStamp> {
    const operation=this.ownedRetainedTurn(session,owner);
    if (!operation) return Promise.reject(new ProviderFailure('CANCELLED'));
    if (operation.inFlight) {
      // Replacement of an outstanding resolver is an explicit retirement,
      // not permission to start a second resolver against the same slot.
      if (operation.retained?.rejectCredential) this.retireScopedRetrieval(operation,'CANCELLED');
      return Promise.reject(new ProviderFailure('BUSY'));
    }
    const retained=operation.retained!;
    if (!retained.check || !retained.lease || !retained.response) return Promise.reject(new ProviderFailure('NOT_READY'));
    operation.inFlight=true;
    this.generationCredential.revoke(owner);
    const result=new Promise<GenerationCredentialStamp>((resolve,reject)=>{
      retained.rejectCredential=reject;
      void (async()=>{
        try {
          const check=retained.check!;
          check();
          const pref=this.generationPort?.config();
          if (pref?.state!=='configured') throw new ProviderFailure('NOT_READY');
          const config=pilotConfig(pref);
          const binding=configDigest('generation',config);
          const verifyBinding=():void=>{
            // retained.check also checks the pinned lease, index generation,
            // deadline and captured configuration; explicitly compare the
            // resolver's own exact configuration/scope at its commit boundary.
            check();
            const current=this.generationPort?.config();
            const scopeId=this.generationPort?.scopeId();
            if (current?.state!=='configured' || configDigest('generation',current)!==binding
              || JSON.stringify([binding,scopeId ?? null])!==retained.configuration)
              throw new StandaloneError('SCOPE_CHANGED');
            check();
          };
          verifyBinding();
          const attempt=this.generationCredential.begin(owner,binding);
          const resolver=this.credentialResolver;
          if (!input && !resolver) throw new ProviderFailure('NOT_READY');
          const secret=input ? input.token : await resolver!.resolve('generation',structuredClone(config),operation.abort.signal);
          verifyBinding();
          // The exact original attempt, not a later resolver/input, completes.
          const stamp=this.generationCredential.complete(attempt,secret);
          resolve(stamp);
        } catch(error) {
          this.generationCredential.revoke(owner);
          const deadline=deadlineFailure(operation.context);
          if (deadline || error instanceof StandaloneError) this.retireScopedRetrieval(operation,deadline?.code ?? (error as StandaloneError).code);
          reject(new ProviderFailure(deadline?.code ?? (error instanceof ProviderFailure ? error.code : 'CANCELLED')));
        } finally {
          retained.rejectCredential=undefined;
          operation.inFlight=false;
          this.releaseRetiredScopedRetrieval();
        }
      })();
    });
    return result;
  }
  /** Local-only read. A non-cancellable verification occupies the same physical
   * slot until it settles; cancellation settles the caller without transferring
   * the lease or allowing a new turn to bypass the drain. */
  readRetainedChatTurn(session: RetainedChatSessionOwner, owner: RetainedChatTurnOwner): Promise<ApiResult<RetainedScopedView>> {
    const operation = this.ownedRetainedTurn(session,owner);
    if (!operation) return Promise.resolve(failure('SUPERSEDED'));
    if (operation.inFlight) return Promise.resolve(failure('BUSY'));
    const retained = operation.retained!;
    const {lease,response,check} = retained;
    if (!lease || !response || !check) return Promise.resolve(failure('INTERNAL_FAILURE'));
    operation.inFlight = true;
    const result = new Promise<ApiResult<RetainedScopedView>>(resolve=>{retained.finishRead=resolve;});
    void (async()=>{
      try {
        check();
        await lease.verify();
        check();
        const detached = structuredClone({scope:lease.snapshot,response});
        check();
        retained.finishRead?.({apiVersion:1,ok:true,value:detached});
      } catch(error) {
        const code = deadlineFailure(operation.context)?.code ?? (error instanceof StandaloneError || error instanceof ProviderFailure
          ? error.code : 'INTERNAL_FAILURE');
        this.retireScopedRetrieval(operation,code);
      } finally {
        retained.finishRead=undefined;
        operation.inFlight=false;
        this.releaseRetiredScopedRetrieval();
      }
    })();
    return result;
  }
  private beginScopedRetrieval(selector: unknown, input: unknown, retained?: RetainedScopedTurn): ScopedRetrievalTurn {
    const rejected = (code:string):ScopedRetrievalTurn =>
      Object.freeze({result:Promise.resolve(failure(code)),cancel:()=>{}});
    let request: ScopedSearch, selection: ScopeSelector;
    try {
      if (!isRecord(input) || Object.keys(input).some(key => !['requestId','query','limit','matchMode'].includes(key)))
        throw new StandaloneError('INVALID_REQUEST');
      const parsed = parseSearch({protocolVersion:2,requestId:input.requestId,query:input.query,requestedMode:'lexical',
        limit:input.limit,...(input.matchMode === undefined ? {} : {matchMode:input.matchMode})});
      request = {requestId:parsed.requestId,query:parsed.query,limit:parsed.limit,matchMode:parsed.matchMode};
      selection = parseScopeSelector(selector);
    } catch(error) { return rejected(error instanceof StandaloneError ? error.code : 'INVALID_REQUEST'); }
    if (this.disposed || !this.enabled) return rejected('DISABLED');
    if (retained && !this.retainedSessions.has(retained.session)) return rejected('SUPERSEDED');
    if (this.paused) return rejected('PAUSED');
    if (this.sharedAuthorityTransition()) return rejected('SUPERSEDED');
    const engine = this.engine;
    if (!engine?.captureChatScope) return rejected('CAPABILITY_UNAVAILABLE');
    if (this.generationAdmissionDepth || this.prepared.generation || this.activeEvidence.generation
      || this.scopedRetrieval || this.active || this.pending) return rejected('BUSY');
    const abort = new AbortController();
    let context: CallContext;
    try {
      context = bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+SCOPED_RETRIEVAL_TIMEOUT_MS},
        SCOPED_RETRIEVAL_TIMEOUT_MS);
    } catch { return rejected('TIMEOUT'); }
    let finish!: ActiveScopedRetrieval['finish'];
    const result = new Promise<ApiResult<SearchResponse>>(resolve=>{finish=resolve;});
    const operation: ActiveScopedRetrieval = {abort,context,revision:this.revision,sourceRevision:this.sourceRevision,finish,
      retained,retired:false,inFlight:true};
    // Reserve before any engine or settings callback can reenter.
    this.scopedRetrieval = operation;
    const owned = ():boolean => this.scopedRetrieval === operation && !operation.retired && !this.disposed
      && this.enabled && !this.paused && this.revision === operation.revision
      && this.sourceRevision === operation.sourceRevision && this.engine === engine
      && (!retained || this.retainedSessions.has(retained.session))
      && !this.sharedAuthorityTransition() && !abort.signal.aborted;
    const check = ():void => {
      remainingOperationMs(context);
      if (!owned()) throw new StandaloneError('SUPERSEDED');
    };
    const configBinding = ():string => {
      const pref = this.generationPort?.config();
      return JSON.stringify([pref?.state === 'configured' ? configDigest('generation',pref) : pref?.state ?? null,
        this.generationPort?.scopeId() ?? null]);
    };
    const retire = (code:string):void => this.retireScopedRetrieval(operation,code);
    operation.timer = setTimeout(()=>retire('TIMEOUT'),SCOPED_RETRIEVAL_TIMEOUT_MS);
    void (async()=>{
      try {
        check();
        const config = configBinding();check();
        const generation = engine.status().generationId;check();
        if (!generation) throw new StandaloneError('INDEX_UNAVAILABLE');
        const current = (lease:ChatScopeLease):void => {
          check();
          if (configBinding() !== config || engine.status().generationId !== generation
            || lease.snapshot.generationId !== generation || !lease.current()) throw new StandaloneError('SCOPE_CHANGED');
          check();
        };
        const lease = await engine.captureChatScope!(selection,abort.signal);
        current(lease);
        const response = await lease.search(request);
        current(lease);
        await lease.verify();
        current(lease);
        if (response.indexGenerationId !== generation || response.requestId !== request.requestId
          || response.requestedMode !== 'lexical' || response.executedMode !== 'lexical')
          throw new StandaloneError('SCOPE_CHANGED');
        const detached = structuredClone(response);current(lease);
        if (retained) {
          // Reserve the exact verified response and lease before publishing a
          // detached copy; the shared admission slot remains continuously owned.
          retained.lease=lease;
          retained.response=structuredClone(detached);
          retained.check=()=>current(lease);
          retained.configuration=config;
        }
        finish({apiVersion:1,ok:true,value:detached});
      } catch(error) {
        if (!operation.retired) {
          const expired = deadlineFailure(context);
          const code=expired?.code ?? (error instanceof StandaloneError || error instanceof ProviderFailure
            ? error.code : 'INTERNAL_FAILURE');
          if (retained) retire(code); else finish(failure(code));
        }
      } finally {
        operation.inFlight=false;
        // A successful retained turn keeps the exact slot and elapsed deadline;
        // legacy retrieval-only callers still release immediately on settlement.
        if (!retained || operation.retired || !retained.response) {
          clearTimeout(operation.timer);
          if (this.scopedRetrieval === operation) this.scopedRetrieval=undefined;
        }
      }
    })();
    return Object.freeze({result,cancel:()=>retire('CANCELLED')});
  }
  private releaseRetiredScopedRetrieval(): void {
    const operation=this.scopedRetrieval;
    if (operation?.retired && !operation.inFlight && !this.retirement.running) this.scopedRetrieval=undefined;
  }
  private retireScopedRetrieval(operation: ActiveScopedRetrieval, code: string): void {
    if (this.scopedRetrieval !== operation || operation.retired) return;
    this.revokeScopedRetrieval(operation,code);
    this.drainRetirements();
  }
  private revokeScopedRetrieval(operation = this.scopedRetrieval, code = 'SUPERSEDED'): void {
    if (!operation || this.scopedRetrieval !== operation || operation.retired) return;
    operation.retired=true;
    clearTimeout(operation.timer);
    const reason=cancelActiveDeadline(operation.context);
    const result = failure(reason.code === 'TIMEOUT' ? 'TIMEOUT' : code);
    const retained = operation.retained;
    if (retained) {
      const finishRead=retained.finishRead;
      const rejectCredential=retained.rejectCredential;
      this.generationCredential.revoke(retained.owner);
      retained.rejectCredential=undefined;retained.configuration=undefined;
      retained.lease=undefined;retained.response=undefined;retained.check=undefined;retained.finishRead=undefined;
      finishRead?.(result);
      rejectCredential?.(new ProviderFailure(reason.code==='TIMEOUT' ? 'TIMEOUT' : 'CANCELLED'));
    }
    operation.finish(result);
    // Logical retirement is complete; physical abort joins the shared ledger.
    this.enqueueRetirement({kind:'evidence',revision:operation.revision,owner:operation.abort,
      attempted:false,run:()=>operation.abort.abort()});
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
  createGenerationViewOwner():object {
    if (this.disposed) throw new ProviderFailure('NOT_READY');
    const owner=Object.freeze({});
    this.generationViews.add(owner);
    return owner;
  }
  private generationViewCurrent(owner:object):boolean {
    return !this.disposed && (owner===this.defaultGenerationView || this.generationViews.has(owner));
  }
  private ownsGenerationView(owner:object):boolean {
    return this.prepared.generation?.credential?.viewOwner===owner
      || this.activeEvidence.generation?.credential?.viewOwner===owner || this.generationTransitionView===owner;
  }
  closeGenerationViewOwner(owner:object):void {
    if (!this.generationViews.delete(owner)) return;
    if (this.ownsGenerationView(owner)) this.cancelEvidence('generation');
  }
  prepareGeneration(token:string,viewOwner:object=this.defaultGenerationView): RerankPreview {
    if (!this.generationViewCurrent(viewOwner)) throw new ProviderFailure('NOT_READY');
    if (this.scopedRetrieval || this.generationTransition || this.generationPreviewReading
      || (this.prepared.generation && !this.ownsGenerationView(viewOwner))) throw new ProviderFailure('BUSY');
    this.generationAdmissionDepth++;
    try { return this.prepareEvidence('generation',token,viewOwner); }
    finally { this.generationAdmissionDepth--; }
  }
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
    if (!pending || role==='generation' && this.generationPreviewReading) return undefined;
    if (role==='generation') this.generationPreviewReading=true;
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
        && (role!=='generation' || !!pending.credential
          && (!checkConfig || this.generationPreviewConfigurationCurrent(pending.preview))
          && this.boundCredentialCurrent(pending.credential))
        && this.prepared[role] === pending && !this.disposed) return pending;
    } catch { /* An unavailable clock cannot authorize disclosure. */ }
    finally { if(role==='generation')this.generationPreviewReading=false; }
    this.expirePreview(role,pending);
    return undefined;
  }
  isEvidencePreviewCurrent(role: EvidenceRole, sequence: number,viewOwner?:object): boolean {
    const pending=this.currentPreview(role);
    return !!pending && pending.preview.sequence===sequence
      && (role!=='generation' || viewOwner===undefined || pending.credential?.viewOwner===viewOwner);
  }
  private clearPreview(role: EvidenceRole,consume=false): boolean {
    const pending=this.prepared[role];
    const hadPreview = !!pending;
    if (!consume && pending?.credential) this.generationCredential.revoke(pending.credential.owner);
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
  private generationPreviewConfigurationCurrent(preview:RerankPreview):boolean {
    const port=this.generationPort;
    const scope=port?.scopeId(), pref=port?.config();
    const scopeAgain=port?.scopeId(), again=port?.config();
    const digest=configDigest('generation',preview.config);
    return scope===preview.scopeId && scopeAgain===scope && pref?.state==='configured' && again?.state==='configured'
      && configDigest('generation',pref)===digest && configDigest('generation',again)===digest;
  }
  private boundCredentialCurrent(binding:BoundGenerationCredential):boolean {
    return this.generationViewCurrent(binding.viewOwner)
      && this.generationCredential.current(binding.owner,binding.configuration,binding.stamp);
  }
  private revokeGenerationTransition():void {
    const owner=this.generationTransition;this.generationTransition=undefined;this.generationTransitionView=undefined;
    if(owner)this.generationCredential.revoke(owner);
  }
  private prepareEvidence(role: EvidenceRole,token?:string,viewOwner:object=this.defaultGenerationView): RerankPreview {
    if (this.sharedAuthorityTransition() || this.roleRetirement(role)) throw new ProviderFailure('NOT_READY');
    // Replacing consent is a single commit. In particular no observer can
    // prepare another preview between clearing the old timer and owning the new one.
    const transition=role==='generation'?{}:undefined;
    const revision=this.revision;
    if(transition){this.generationTransition=transition;this.generationTransitionView=viewOwner;}
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
      let credential:BoundGenerationCredential|undefined;
      if (transition) {
        const configuration=configDigest('generation',config);
        const nowScope=port?.scopeId(), now=port?.config();
        if (now?.state!=='configured' || configDigest('generation',now)!==configuration || nowScope!==scopeId
          || this.generationTransition!==transition || this.revision!==revision || this.sharedAuthorityTransition()
          || !this.generationViewCurrent(viewOwner)) throw new ProviderFailure('CANCELLED');
        const attempt=this.generationCredential.begin(transition,configuration);
        credential={owner:transition,viewOwner,configuration,stamp:this.generationCredential.complete(attempt,token)};
      }
      const preview = structuredClone({role,sequence:++this.sequence,revision:this.revision,expiresUnixMs,config,scopeId,query:this.lastQuery,hits:response.hits,
        ...(admission ? {runtimeProfileBinding:admission.bindingDigest,runtimeProfileDigest:admission.profileDigest} : {}),
        ...(credential?{credentialStamp:credential.stamp}:{})});
      const pending = {preview,monotonicStartedMs,bootStartedSeconds,credential};
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
      if(transition && this.generationTransition===transition) {
        this.generationTransition=undefined;this.generationTransitionView=undefined;
        if(this.prepared.generation?.credential?.owner!==transition)this.generationCredential.revoke(transition);
      }
      if (changed) this.emitEvidence();
    }
  }
  private revokeEvidence(): void {
    this.revokeGenerationTransition();
    for (const role of ['reranking','generation'] as const) {
      this.clearPreview(role);
      const active = this.activeEvidence[role];
      if (active) {
        if(active.credential)this.generationCredential.revoke(active.credential.owner);
        cancelActiveDeadline(active.context);
        const owner = active.abort;
        this.enqueueRetirement({kind:'evidence',revision:active.revision,owner,attempted:false,run:()=>owner.abort()});
      }
    }
    // All previews and both elapsed-time budgets are retired before any
    // physical callback. The same bounded ledger retains failed source work
    // and pinned evidence aborts; successful unrelated work cannot clear it.
    this.drainRetirements();
  }
  private roleRetirement(role: EvidenceRole): RetirementObligation | undefined {
    return this.retirement.obligations.find(item => item.kind === 'role' && item.role === role);
  }
  private retireRoleAbort(role: EvidenceRole, active: ActiveEvidenceOperation | undefined, explicit: boolean): void {
    let item = this.roleRetirement(role);
    if (!item && active) {
      // A shared transition already owns this abort; do not retry it from a role callback.
      if (this.retirement.obligations.some(obligation => obligation.owner === active.abort)) return;
      const owner = active.abort;
      item = {kind:'role',role,revision:active.revision,owner,run:()=>owner.abort(),attempted:false};
      this.enqueueRetirement(item);
    }
    if (!item || item.running || this.retirement.running ||
        (item.attempted && (!explicit || this.notifying || this.revokingSharedAuthority))) return;
    item.attempted = true; item.running = true;
    try {
      item.run();
      const index = this.retirement.obligations.indexOf(item);
      if (index >= 0) this.retirement.obligations.splice(index,1);
    } catch {
      item.failed = true;
      console.warn('SEARCH_RETIREMENT_OBLIGATION_FAILED','role');
    } finally { item.running = false; }
  }
  // Role-local revocation and explicit cancellation use the same deadline
  // authority as the worker. A new pending preview is a distinct operation.
  private cancelEvidenceState(role: EvidenceRole, explicit = false): boolean {
    if (this.disposed) return false;
    const hadPreview = !!this.prepared[role];
    const active = this.activeEvidence[role];
    const revision = this.revision;
    if(role==='generation'){this.revokeGenerationTransition();if(active?.credential)this.generationCredential.revoke(active.credential.owner);}
    this.clearPreview(role);
    const key = role === 'reranking' ? 'rerank' : 'generation';
    const previous = this.state[key];
    const current = active?.revision === this.revision ? active : undefined;
    if (!hadPreview && !previous && !current) {
      const retiring = this.roleRetirement(role);
      this.retireRoleAbort(role,active,explicit);
      return !!retiring && !this.roleRetirement(role);
    }
    const error = current
      ? cancelActiveDeadline(current.context).code
      : !hadPreview && previous?.error === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED';
    if (!hadPreview && previous?.phase === 'error' && previous.error === error) {
      // Keep historical standalone cancel notifications (and worker settlement),
      // but a listener cleaning up this same terminal snapshot is a no-op.
      this.retireRoleAbort(role,active,explicit);
      return this.ownsRevision(revision) && explicit && !this.notifying;
    }
    this.state = {...this.state,[key]:{phase:'error',error,hits:[]}};
    this.retireRoleAbort(role,active,explicit);
    return this.ownsRevision(revision);
  }
  private cancelEvidence(role: EvidenceRole): void {
    if (this.cancelEvidenceState(role,true)) this.emitEvidence();
  }
  cancelRerank(): void { this.cancelEvidence('reranking'); }
  cancelGeneration(viewOwner?:object): void {
    if(viewOwner===undefined || this.generationViewCurrent(viewOwner) && this.ownsGenerationView(viewOwner))
      this.cancelEvidence('generation');
  }
  rerankConfirmed(preview: RerankPreview, classification: 'synthetic' | 'public', token: string): Promise<void> {
    return this.confirmEvidence('reranking',preview,classification,token);
  }
  generationConfirmed(preview: RerankPreview, classification: 'synthetic' | 'public',viewOwner:object=this.defaultGenerationView): Promise<void> {
    if (this.scopedRetrieval || this.generationTransition || this.generationPreviewReading) return Promise.reject(new ProviderFailure('BUSY'));
    const binding=this.prepared.generation?.credential;
    // Foreign host/view attempts do not consume another owner's pending consent.
    if (!this.generationViewCurrent(viewOwner) || !binding || binding.viewOwner!==viewOwner
      || preview?.credentialStamp?.hostId!==binding.stamp.hostId) return Promise.reject(new ProviderFailure('DISCLOSURE_DENIED'));
    this.generationAdmissionDepth++;
    try { return this.confirmEvidence('generation',preview,classification); }
    finally { this.generationAdmissionDepth--; }
  }
  private async confirmEvidence(role: EvidenceRole, preview: RerankPreview, classification: 'synthetic' | 'public', token?: string): Promise<void> {
    if (this.sharedAuthorityTransition() || this.roleRetirement(role)) throw new ProviderFailure('DISCLOSURE_DENIED');
    const pending = this.currentPreview(role,false);
    if (!pending) throw new ProviderFailure('DISCLOSURE_DENIED');
    const {preview:approved,credential}=pending;
    if(credential){this.generationTransition=credential.owner;this.generationTransitionView=credential.viewOwner;}
    this.clearPreview(role,true);
    const retireCredential=():void=>{
      if(credential){
        if(this.generationTransition===credential.owner){this.generationTransition=undefined;this.generationTransitionView=undefined;}
        this.generationCredential.revoke(credential.owner);
      }
    };
    try {
    const port = this.port(role);
    if (!port || this.activeEvidence[role] || !['synthetic','public'].includes(classification)
      || role === 'reranking' && classification !== 'synthetic'
      || JSON.stringify(approved) !== JSON.stringify(preview)) { retireCredential(); this.emitEvidence(); throw new ProviderFailure('DISCLOSURE_DENIED'); }
    let operation:ActiveEvidenceOperation|undefined;
    const current = (): boolean => {
      const config = port.config();
      return !this.disposed && this.enabled && !this.paused && this.revision === approved.revision
        && this.profileCurrent(approved)
        && port.scopeId() === approved.scopeId && config.state === 'configured'
        && configDigest(role,config) === configDigest(role,approved.config)
        && this.engine?.status().generationId === this.state.response?.indexGenerationId
        && this.state.response?.indexGenerationId === approved.hits[0]?.indexGenerationId
        && (!credential || this.generationPreviewConfigurationCurrent(approved)
          && this.boundCredentialCurrent(credential)
          && (operation ? this.activeEvidence.generation===operation : this.generationTransition===credential.owner))
        && this.revision === approved.revision && !this.disposed && !this.sharedAuthorityTransition();
    };
    if (!current()) { retireCredential(); this.emitEvidence(); throw new ProviderFailure('CANCELLED'); }
    const admission = role === 'reranking' ? this.currentRerankAdmission(approved.config,approved.scopeId) : undefined;
    const abort = new AbortController();
    const key = role === 'reranking' ? 'rerank' : 'generation';
    const context = bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+approved.config.limits.timeoutMs},approved.config.limits.timeoutMs);
    const {deadlineUnixMs} = context;
    if(credential && (this.generationTransition!==credential.owner || !current()))throw new ProviderFailure('CANCELLED');
    operation = {abort,context,revision:approved.revision,credential};
    this.activeEvidence[role] = operation;
    if(credential && this.generationTransition===credential.owner){this.generationTransition=undefined;this.generationTransitionView=undefined;}
    this.state = {...this.state,[key]:{phase:'running',error:null,hits:[]}};
    try {
      this.emitEvidence();
      const worker = role === 'reranking' ? this.reranker : this.generator;
      if(!current())throw new ProviderFailure('CANCELLED');
      const capturedToken=credential?this.generationCredential.secret(credential.owner,credential.configuration,credential.stamp):token!;
      const hits = await worker.run({
        config:approved.config,scopeId:approved.scopeId,query:{text:approved.query,classification},
        candidates:approved.hits.map(hit=>({hit,classification})),
        grant:{version:1,role,configDigest:configDigest(role,approved.config),
          ...(admission ? {runtimeProfileBinding:admission.bindingDigest} : {}),
          scopeId:approved.scopeId,expiresUnixMs:deadlineUnixMs,queryDigest:hash(approved.query),
          queryClassification:classification,sources:approved.hits.map(hit=>({sourceId:hit.sourceId,
            sourceSha256:hit.sourceSha256,excerptDigest:hash(hit.originalExcerpt),classification}))},
      },capturedToken,context,hit=>port.verify(hit),current,admission);
      if (this.revision === approved.revision && !this.disposed) {
        const valid = current();
        remainingOperationMs(context);
        if (!valid) throw new ProviderFailure('CANCELLED');
        if (this.activeEvidence[role] !== operation || this.revision !== approved.revision || this.disposed) return;
        // Retire the operation before notifying listeners: a reentrant cancel
        // now concerns a completed result, not a still-running deadline.
        delete this.activeEvidence[role];
        if(credential)this.generationCredential.revoke(credential.owner);
        this.state = {...this.state,[key]:{phase:'results',error:null,hits}};
        this.emitEvidence();
      }
    } catch (error) {
      error = deadlineFailure(context) ?? error;
      if (this.activeEvidence[role] === operation && this.revision === approved.revision && !this.disposed) {
        delete this.activeEvidence[role];
        if(credential)this.generationCredential.revoke(credential.owner);
        this.state = {...this.state,[key]:{phase:'error',error:error instanceof ProviderFailure?error.code:'NOT_READY',hits:[]}};
        this.emitEvidence();
      }
    } finally { if (this.activeEvidence[role] === operation) delete this.activeEvidence[role]; }
    } finally { retireCredential(); }
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
    if (this.disposed) return failure('DISABLED');
    if (this.sharedResetDepth || this.retirement.running || this.revokingSharedAuthority) return failure('SUPERSEDED');
    if (this.explicitRetirementPending) {
      // Rebuild is the explicit source-freshness recovery action; ordinary
      // search, settings changes and observer publication cannot retry it.
      if (action !== 'rebuild' || this.notifying || this.retirement.sourceRunning || this.sourceDrains.size || this.sourceDrainFailed || this.retirement.overflow)
        return failure('INTERNAL_FAILURE');
      const revision = this.revision + 1;
      this.transitionSourceRetirement(true);
      if (this.disposed || this.revision !== revision) return failure('SUPERSEDED');
      if (this.sharedAuthorityFault) return failure('INTERNAL_FAILURE');
    }
    if (this.runtimeSettingsChanging) return failure('SUPERSEDED');
    if (!this.enabled || !this.engine) return failure('DISABLED');
    if (this.sharedAuthorityFault && this.pendingHostRetirement && this.notifying) return failure('INTERNAL_FAILURE');
    const engine = this.engine, revision = this.revision + 1;
    try { this.invalidateState(false, retireHost, true); }
    catch { return failure('INTERNAL_FAILURE'); }
    // The initial shared invalidation is synchronous. Do not execute a stale
    // control command after an observer supersedes its revision or detaches.
    if (this.disposed || this.revision !== revision || this.engine !== engine) return failure('SUPERSEDED');
    if (this.sharedAuthorityFault) return failure('INTERNAL_FAILURE');
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
    this.retainedSessions.clear();
    this.generationCredential.seal();
    this.revokeScopedRetrieval();
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
    // Terminal disposal stops source-owner processing but must still attempt
    // both pinned evidence aborts, even if unload reenters an active wave.
    this.retirement.obligations = this.retirement.obligations.filter(item => item.kind !== 'source');
    for (const item of this.retirement.obligations) item.attempted = false;
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
