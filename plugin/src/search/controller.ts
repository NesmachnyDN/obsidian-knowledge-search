import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EvidenceGenerator, type GeneratedEvidenceClaim } from '../ai/generation-evidence';
import { EvidenceReranker, type RerankedHit } from '../ai/rerank-evidence';
import { pilotConfig } from '../ai/loopback-rerank';
import { bindActiveDeadline, remainingOperationMs, deadlineFailure, cancelActiveDeadline } from '../ai/active-deadline';
import { RerankRuntimeProfiles, type RerankAdmission } from '../ai/rerank-profile';
import { configDigest, type Classification, type DisclosureGrant } from '../ai/disclosure';
import { GenerationCredentialAuthority, type GenerationCredentialStamp } from '../ai/generation-credential';
import { GenerationPolicyGate, generationPolicyPayload, generationPolicySourceDigest, uniquePolicySources, type GenerationPolicyBinding, type GenerationPolicyInput, type GenerationHistoryScope, type GenerationPolicyPort, type RerankPolicyPort, type ProcessingPolicyInput } from '../ai/generation-policy';
import { ProviderFailure, type ProviderConfig, type ProviderPreference, type ProviderFailureCode, type AiOperationStatus, type CallContext, type CredentialResolver } from '../ai/contracts';
import { hash, isDigest } from '../standalone/contracts';
import type { AdvancedHealth } from '../advanced/health';
import type { IngestionStatus } from '../advanced/manager';
import { isRecord, StandaloneError, validateRequest, validProperty, BOUNDS,
  type SearchRequest, type SearchResponse, type Predicate, type EvidenceHit, type SearchMetadata } from '../standalone/contracts';
import type { StandaloneEngine, ChatScopeLease } from '../standalone/engine';
import type { GraphExcerpt, LocalGraphLease, LocalGraphResult } from '../standalone/graph-retrieval';
import { parseGraphQuery } from '../standalone/graph-expansion';
import { freezeScope, parseScopeSelector, type ScopeSelector, type ScopedSearch, type ScopeSnapshot } from '../standalone/chat-scope';
import type { NavigationAuthority } from './navigation';
import { diagnostics, safeCode, statusSnapshot, type SearchStatus } from './status';

export type ApiError = { apiVersion: 1; ok: false; error: string };
export type ApiResult<T> = { apiVersion: 1; ok: true; value: T } | ApiError;
const failure = (error: string): ApiError => ({ apiVersion: 1, ok: false, error: safeCode(error)! });
const CHAT_FAILURE_CODES = new Set(['DISABLED','CONFIG_INVALID','NOT_READY','BUSY','ENDPOINT_DENIED',
  'DISCLOSURE_DENIED','MODEL_MISMATCH','LIMIT_EXCEEDED','UNAUTHENTICATED','FORBIDDEN','RATE_LIMITED',
  'QUOTA_EXCEEDED','TIMEOUT','CANCELLED','NETWORK','SERVER_ERROR','INVALID_RESPONSE','SOURCE_STALE',
  'INSUFFICIENT_EVIDENCE','NAVIGATION_REJECTED']);
const chatFailure = (error:string):ApiError => ({apiVersion:1,ok:false,error:CHAT_FAILURE_CODES.has(error)?error:'INTERNAL_FAILURE'});
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
  & Partial<Pick<StandaloneEngine, 'captureChatScope' | 'captureLocalGraph'>>;
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
export type RerankPreview = { role: EvidenceRole; sequence: number; revision: number; expiresUnixMs: number; config: ProviderConfig; scopeId: string; query: string; hits: EvidenceHit[]; runtimeProfileBinding?: string; runtimeProfileDigest?: string; credentialStamp?:GenerationCredentialStamp; policy?:GenerationPolicyBinding };
// Internal elapsed-time deadlines are never taken from the returned preview.
type BoundGenerationCredential = {owner:object;viewOwner:object;configuration:string;stamp:GenerationCredentialStamp};
type ActiveEvidenceOperation = { abort: AbortController; context: CallContext; revision: number; credential?:BoundGenerationCredential };
type PendingEvidencePreview = { preview: RerankPreview; monotonicStartedMs: number; bootStartedSeconds: number; credential?:BoundGenerationCredential; policyContext?:CallContext;policyAbort?:AbortController; policyPort?:GenerationPolicyPort|RerankPolicyPort };
export type ScopedRetrievalTurn = Readonly<{ result: Promise<ApiResult<SearchResponse>>; cancel(): void }>;
/** Opaque host identities. They only select host-owned state; they never carry
 * a lease, grant, configuration, credential, or transport capability. */
export type RetainedChatSessionOwner = object;
export type RetainedChatTurnOwner = object;
export type RetainedScopedRetrievalTurn = Readonly<{ owner: RetainedChatTurnOwner; result: Promise<ApiResult<SearchResponse>> }>;
export type RetainedScopedView = { scope: ScopeSnapshot; response: SearchResponse };
/** A detached host view.  Its object identity is checked internally; it is not a
 * lease, credential, disclosure grant, or transport capability. */
export type RetainedChatClassificationDraft = Readonly<{
  id: string; credentialStamp: GenerationCredentialStamp;
  question: Readonly<{ id: string; digest: string; text: string; classification: Classification }>;
  priorQuestions: readonly Readonly<{ id: string; turnId:string; digest: string; text: string; classification: Classification }>[];
  evidence: readonly Readonly<{ id: string; digest: string; sourceId: string; sourceSha256: string;
    locatorDigest: string; excerpt: string; classification: Classification }>[];
}>;
export type RetainedChatGenerationPreview = RetainedChatClassificationDraft & Readonly<{
  scopeDigest:string; scopeId:string; config:Readonly<ProviderConfig>; expiresUnixMs:number; inputBytes:number;
  composedQuestion:Readonly<{text:string;digest:string;classification:Classification}>; policy?:GenerationPolicyBinding;
}>;
const SCOPED_RETRIEVAL_TIMEOUT_MS = 30_000;
const MAX_CHAT_SESSIONS = 4;
const MAX_COMPLETED_TURNS = 12;
const MAX_STORED_QUESTION_BYTES = 2048;
const MAX_SESSION_HISTORY_BYTES = 64 * 1024;
const MAX_HISTORY_BYTES = 256 * 1024;
type ChatHistoryLineage = Readonly<{
  version:1; use:'local-only'; selector:ScopeSelector;
  policyRevision:string|null; policyBindingDigest:string|null;
  payloadDigest:string; sourceDigest:string;
  questions:readonly Readonly<{id:string;digest:string;classification:Classification}>[];
}>;
export type CompletedChatTurn = Readonly<{id:string; question:string; questionDigest:string; claims:readonly GeneratedEvidenceClaim[];
  scopeDigest:string; configuration:string; generationId:string; sourceRevision:number; completedAt:number; lineage:ChatHistoryLineage}>;
type RetainedChatSession = {readonly owner:RetainedChatSessionOwner; history:CompletedChatTurn[]; lastUsed:number; policyPort?:GenerationPolicyPort};
type RetainedScopedTurn = { readonly session: RetainedChatSessionOwner; readonly owner: RetainedChatTurnOwner;
  lease?: ChatScopeLease; response?: SearchResponse; check?: () => void;
  finishRead?: (value: ApiResult<RetainedScopedView>) => void;
  rejectCredential?: (error:ProviderFailure)=>void; rejectPreview?: (error:ProviderFailure)=>void; configuration?:string; question?:string;
  draft?: RetainedDraft; preview?: RetainedPreview; generationBusy?:boolean; priorIds?:readonly string[]; prior?:readonly Pick<CompletedChatTurn,'id'|'question'|'questionDigest'>[];
  credentialBound?:boolean; };
type RetainedDraft = { readonly view: RetainedChatClassificationDraft; readonly configuration:string;
  readonly stamp:GenerationCredentialStamp; readonly labels:Map<string,Classification>; };
type RetainedPreview = { readonly view:RetainedChatGenerationPreview; readonly draft:RetainedDraft; readonly policyPort?:GenerationPolicyPort; readonly historyRevision:string|null };
type ActiveScopedRetrieval = { readonly abort: AbortController; readonly context: CallContext;
  readonly revision: number; readonly sourceRevision: number; readonly finish: (value: ApiResult<SearchResponse>) => void;
  readonly retained?: RetainedScopedTurn;
  timer?: ReturnType<typeof setTimeout>; retired: boolean; inFlight: boolean; physicalReads?:number };
type ActiveGraphOperation = {
  readonly abort: AbortController; readonly engine: Engine; lease?:LocalGraphLease;
  revision: number; sourceRevision: number; retired: boolean; inFlight: boolean;
  result?: LocalGraphResult; finish: (value: ApiResult<LocalGraphResult>) => void;
};
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
  /** Graph presentation is a separate, host-owned result channel. It never
   * becomes lexical UI state or AI evidence. */
  private graphOperation?: ActiveGraphOperation;
  // Object identity is host-local: a cloned or foreign session never matches.
  private readonly retainedSessions = new Map<RetainedChatSessionOwner,RetainedChatSession>();
  private generationAdmissionDepth = 0;
  private generationTransition?:object;
  private generationTransitionRole?:EvidenceRole;
  private generationTransitionView?:object;
  private generationPreviewReading = false;
  private previewNotificationDeferred = false;
  private readonly generationPolicyGate:GenerationPolicyGate;
  private generationPolicyPreparation?: {role:EvidenceRole;abort:AbortController;pending?:PendingEvidencePreview;context?:CallContext};
  private readonly defaultGenerationView = Object.freeze({});
  private readonly generationViews = new WeakSet<object>();
  private readonly generationCredential: GenerationCredentialAuthority;
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
  constructor(private readonly navigate: (hit: EvidenceHit, authority?: NavigationAuthority) => Promise<void>,
    private readonly advancedStatus?: () => AdvancedHealth,
    private readonly ingestionStatus?: () => IngestionStatus,
    private readonly rerankPort?: RerankPort, private readonly generationPort?: RerankPort,
    private readonly revokeSharedAuthority?: () => void,
    private readonly credentialResolver?: CredentialResolver,
    /** Explicit host-selected target path; unadmitted profiles fail closed. */
    private readonly generationPolicyPort?: GenerationPolicyPort,
    private readonly rerankPolicyPort?:RerankPolicyPort,
    credentialAuthority?:GenerationCredentialAuthority,policyGate?:GenerationPolicyGate) {
      this.generationCredential=credentialAuthority??new GenerationCredentialAuthority();
      this.generationPolicyGate=policyGate??new GenerationPolicyGate();
  }
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
    if (pending) return {phase:'permission-required',error:null};
    if (state?.phase === 'running'||(this.generationPolicyPreparation?.role===role||this.generationPolicyGate.busy&&role==='generation')) return {phase:'busy',error:null};
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
    // A trusted synchronous policy callback may itself request publication.
    // Finish the preview read/retirement before exposing any observer state.
    if(this.generationPreviewReading){
      if(!this.previewNotificationDeferred){
        this.previewNotificationDeferred=true;
        queueMicrotask(()=>{this.previewNotificationDeferred=false;this.drainNotifications(continueWave);});
      }
      return;
    }
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
        const refreshPolicyPreviews=():void=>{
          for(const role of ['reranking','generation'] as const)
            if(this.prepared[role]?.preview.policy)this.currentPreview(role);
        };
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
            refreshPolicyPreviews();
            if (this.revision !== lifecycle!.revision || this.disposed !== lifecycle!.final) break;
            if (this.listeners.has(listener)) deliver(listener);
          }
        } finally { this.deliveringLifecycle = false; }
        for (const listener of evidence) {
          refreshPolicyPreviews();
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
        this.resetSharedState({phase:'error',message:'INTERNAL_FAILURE',response:null},undefined,true);
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
  embeddingAdmissionAvailable():boolean {
    return !this.sharedAuthorityTransition()&&!this.generationAdmissionDepth&&!this.generationTransition
      &&!this.generationPreviewReading&&!this.generationPolicyPreparation&&!this.generationPolicyGate.busy
      &&!this.generationCredential.exclusiveBusy&&!this.scopedRetrieval&&!this.graphOperation?.inFlight
      &&!this.prepared.generation&&!this.prepared.reranking&&!this.activeEvidence.generation&&!this.activeEvidence.reranking;
  }
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
    this.resetSharedState({phase:'idle',message:'Results cleared; search to verify current sources.',response:null},undefined,true);
    if (this.disposed) return;
    if (revokeRerankProfile) this.rerankProfiles.revoke();
    this.emit(false, retire, true);
    if (this.explicitRetirementPending) throw new StandaloneError('INTERNAL_FAILURE');
  }
  endRuntimeSettingsChange(): void { this.runtimeSettingsChanging = false; }
  invalidate(): void { if (!this.disposed) this.invalidateState(true); }
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
      this.resetSharedState({phase:'idle',message:'Results cleared; search to verify current sources.',response:null},undefined,true);
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
      this.resetSharedState({phase:'idle',message:'Results cleared; search to verify current sources.',response:null},undefined,true);
    } finally {
      this.retirement.sourceRunning = false;
      if (!this.disposed) this.emit();
      else this.drainNotifications();
    }
  }
  private resetSharedState(state: UiState, reserve?: (revision: number) => void, invalidateHistory = false): number {
    const revision = ++this.revision;
    this.sharedResetDepth++;
    try {
      // Commit ownership and reserve the new job before synchronous abort
      // callbacks. A nested reset or terminal seal can then settle that job,
      // never be overwritten by the interrupted caller, and own publication.
      this.lastQuery = '';
      // Ordinary Basic Search is not a chat authority transition.  Source,
      // runtime, provider or host revocation must clear history before any
      // cancellation callback can reenter.
      if (invalidateHistory) this.clearAllRetainedHistory();
      this.pending?.resolve(failure('SUPERSEDED')); this.pending = undefined;
      this.state = state;
      this.revokeGraphOperation();
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
  private invalidateState(invalidateHistory = false, final = false, retireHost?: RetirementTarget, requireRetirement = false): void {
    const revision = this.resetSharedState({phase:'idle',message:'Results cleared; search to verify current sources.',response:null},undefined,invalidateHistory);
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
  /** Explicit local graph retrieval. The result is held only as the current
   * presentation authority and is deliberately excluded from lexical state. */
  graphSearch(input:unknown):Promise<ApiResult<LocalGraphResult>> {
    let request:ReturnType<typeof parseGraphQuery>;
    try { request=parseGraphQuery(input); }
    catch(error){return Promise.resolve(failure(error instanceof StandaloneError?error.code:'GRAPH_REQUEST_INVALID'));}
    if(this.disposed||!this.enabled)return Promise.resolve(failure('DISABLED'));
    if(this.paused)return Promise.resolve(failure('PAUSED'));
    if(this.explicitRetirementPending)return Promise.resolve(failure('INTERNAL_FAILURE'));
    if(this.sharedAuthorityTransition()||this.notifying||this.retirement.running)return Promise.resolve(failure('SUPERSEDED'));
    const engine=this.engine;
    if(!engine?.captureLocalGraph)return Promise.resolve(failure(this.error??'GRAPH_UNAVAILABLE'));
    if(this.active||this.pending||this.scopedRetrieval)return Promise.resolve(failure('BUSY'));
    let finish!:(value:ApiResult<LocalGraphResult>)=>void;
    const result=new Promise<ApiResult<LocalGraphResult>>(resolve=>{finish=resolve;});
    const operation:ActiveGraphOperation={abort:new AbortController(),engine,revision:0,
      sourceRevision:this.sourceRevision,retired:false,inFlight:true,finish};
    const revision=this.resetSharedState({phase:'idle',message:'Results cleared; search to verify current sources.',response:null},owned=>{
      operation.revision=owned;this.graphOperation=operation;
    });
    if(this.ownsRevision(revision))this.emit();
    void (async()=>{
      let value:ApiResult<LocalGraphResult>;
      try{
        if(!this.graphCurrent(operation)||this.sharedAuthorityTransition())throw new StandaloneError('SUPERSEDED');
        const lease=engine.captureLocalGraph!(request,operation.abort.signal);
        operation.lease=lease;
        if(!this.graphCurrent(operation))throw new StandaloneError('SUPERSEDED');
        const graph=await lease.read();
        if(!this.graphCurrent(operation)||graph.requestId!==request.requestId
          ||JSON.stringify(graph.scope.selector)!==JSON.stringify(request.scope))
          throw new StandaloneError('GRAPH_SOURCE_STALE');
        // Exact graph read ends with full-catalog authentication. No async work
        // between that verified completion and graph-only publication.
        operation.result=freezeScope(structuredClone(graph));
        operation.inFlight=false;
        this.emit();
        if(!this.graphCurrent(operation)||this.sharedAuthorityTransition())throw new StandaloneError('SUPERSEDED');
        value={apiVersion:1,ok:true,value:operation.result};
      }catch(error){
        value=failure(operation.retired||this.graphOperation!==operation?'SUPERSEDED':
          error instanceof StandaloneError?error.code:'INTERNAL_FAILURE');
        if(this.graphOperation===operation){this.revokeGraphOperation(operation,value.error);this.drainRetirements();}
      }
      operation.inFlight=false;
      operation.finish(value);
    })();
    return result;
  }
  /** Detached immutable current view, not a source/disclosure authority. */
  graphSnapshot():LocalGraphResult|null {
    const operation=this.graphOperation;
    return operation?.result&&this.graphCurrent(operation)?operation.result:null;
  }
  graphResultCurrent(expected:LocalGraphResult):boolean {
    return this.graphSnapshot()===expected;
  }
  /** Only exact current result identity and bounded indexes select evidence.
   * A cloned/foreign/previous view cannot open a newer result by index. */
  async openGraphEvidence(expected:LocalGraphResult,index:number,step?:number,anchor?:number):Promise<ApiResult<null>> {
    const operation=this.graphOperation;
    if(!operation||operation.result!==expected||!this.graphCurrent(operation)||this.sharedAuthorityTransition()
      ||!Number.isSafeInteger(index)||index<0||operation.inFlight)return failure('NAVIGATION_REJECTED');
    const candidate=operation.result.candidates[index];
    if(!candidate)return failure('NAVIGATION_REJECTED');
    let excerpt:GraphExcerpt=candidate;
    if(step!==undefined||anchor!==undefined){
      if(!Number.isSafeInteger(step)||!Number.isSafeInteger(anchor)||step!<0||anchor!<0)return failure('NAVIGATION_REJECTED');
      const item=candidate.path[step!]?.anchorEvidence[anchor!];
      if(!item)return failure('NAVIGATION_REJECTED');
      excerpt=item;
    }
    const authority:NavigationAuthority={
      current:()=>{if(!this.graphCurrent(operation)||this.sharedAuthorityTransition())throw new StandaloneError('NAVIGATION_REJECTED');},
      verify:async()=>{authority.current();await operation.lease!.verify();authority.current();},
    };
    operation.inFlight=true;
    try{
      authority.current();
      await this.navigate(this.graphExcerptHit(excerpt,expected.generationId),authority);
      authority.current();
      return {apiVersion:1,ok:true,value:null};
    }catch{
      if(this.graphOperation===operation){this.revokeGraphOperation(operation,'NAVIGATION_REJECTED');this.drainRetirements();this.emit();}
      return failure('NAVIGATION_REJECTED');
    }finally{operation.inFlight=false;}
  }
  private graphCurrent(operation:ActiveGraphOperation):boolean {
    return !this.disposed&&!operation.retired&&!operation.abort.signal.aborted&&this.graphOperation===operation
      &&this.revision===operation.revision&&this.sourceRevision===operation.sourceRevision&&this.engine===operation.engine
      &&!this.runtimeSettingsChanging&&!this.sharedResetDepth&&!this.revokingSharedAuthority&&!this.sharedAuthorityFault
      &&this.enabled&&!this.paused&&(operation.lease?.current()??true);
  }
  private graphExcerptHit(excerpt:GraphExcerpt,generationId:string):EvidenceHit {
    return {sourceId:excerpt.sourceId,sourceSha256:excerpt.sourceSha256,originalExcerpt:excerpt.excerpt,
      sourceLocators:[structuredClone(excerpt.locator)],rank:1,lexicalRank:1,retrievalMode:'lexical',indexGenerationId:generationId,
      score:0,headings:[],wikiLinks:[],properties:[]};
  }
  private revokeGraphOperation(operation=this.graphOperation,code='SUPERSEDED'):void {
    if(!operation||this.graphOperation!==operation||operation.retired)return;
    operation.retired=true;
    this.graphOperation=undefined;
    operation.result=undefined;operation.lease=undefined;
    operation.finish(failure(code));
    // Seal logical authority before abort listeners can reenter.
    this.enqueueRetirement({kind:'evidence',revision:operation.revision,owner:operation.abort,
      attempted:false,run:()=>operation.abort.abort()});
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
    if (this.retainedSessions.size >= MAX_CHAT_SESSIONS) {
      const active=this.scopedRetrieval?.retained?.session;
      const candidates=[...this.retainedSessions.values()].filter(entry=>entry.owner!==active && entry.history.length>0)
        .sort((a,b)=>a.lastUsed-b.lastUsed);
      if (!candidates.length) throw new ProviderFailure('LIMIT_EXCEEDED');
      this.retainedSessions.delete(candidates[0]!.owner);
    }
    const session = Object.freeze({});
    this.retainedSessions.set(session,{owner:session,history:[],lastUsed:Date.now()});
    return session;
  }
  closeRetainedChatSession(session: RetainedChatSessionOwner): void {
    if (!this.retainedSessions.delete(session)) return;
    const operation = this.scopedRetrieval;
    if (operation?.retained?.session === session) this.retireScopedRetrieval(operation,'CANCELLED');
  }
  /** Prior IDs are host-issued opaque completed-question IDs only. */
  startRetainedChatTurn(session: RetainedChatSessionOwner, selector: unknown, input: unknown,
    priorQuestionIds: unknown = []): RetainedScopedRetrievalTurn {
    const owner = Object.freeze({});
    let priorIds:readonly string[];
    try { priorIds=this.selectedPriorIds(session,priorQuestionIds); }
    catch { return Object.freeze({owner,result:Promise.resolve(chatFailure('DISCLOSURE_DENIED'))}); }
    const turn = this.beginScopedRetrieval(selector,input,{session,owner,priorIds});
    return Object.freeze({owner,result:turn.result});
  }
  private ownedRetainedTurn(session: RetainedChatSessionOwner, owner: RetainedChatTurnOwner): ActiveScopedRetrieval | undefined {
    const operation = this.scopedRetrieval;
    return !this.disposed && this.retainedSessions.has(session) && operation && !operation.retired
      && operation.retained?.session === session && operation.retained.owner === owner ? operation : undefined;
  }
  /** Presentation-only ownership check; never grants disclosure or reads sources. */
  retainedChatTurnCurrent(session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner):boolean {
    const operation=this.ownedRetainedTurn(session,owner);
    if(!operation||operation.revision!==this.revision||operation.sourceRevision!==this.sourceRevision)return false;
    try{return remainingOperationMs(operation.context)>0;}catch{return false;}
  }
  cancelRetainedChatTurn(session: RetainedChatSessionOwner, owner: RetainedChatTurnOwner): void {
    const operation = this.ownedRetainedTurn(session,owner);
    if (operation) this.retireScopedRetrieval(operation,'CANCELLED');
  }
  /** Metadata only. Content requires the fresh, local verified read below. */
  readRetainedChatHistory(session:RetainedChatSessionOwner):readonly Pick<CompletedChatTurn,'id'|'questionDigest'|'completedAt'>[] {
    const entry=this.retainedSessions.get(session);
    if (!entry || this.disposed) throw new ProviderFailure('CANCELLED');
    entry.lastUsed=Date.now();
    return entry.history.map(({id,questionDigest,completedAt})=>({id,questionDigest,completedAt}));
  }
  private historyPolicyScope(scope:ScopeSnapshot,config:ProviderConfig):GenerationHistoryScope {
    return {role:'generation',config,scopeId:scope.rootId,scopeBinding:hash(JSON.stringify(scope)),
      scopeSources:scope.sources,sources:[]};
  }
  private historyPolicyRevision(scope:ScopeSnapshot,config:ProviderConfig,port:GenerationPolicyPort|undefined):string|null {
    if(this.selectedGenerationPolicy()!==port)throw new ProviderFailure('CANCELLED');
    if(!port)return null;
    const revision=port.historyRevision?.(this.historyPolicyScope(scope,config));
    if(!isDigest(revision)||this.selectedGenerationPolicy()!==port)throw new ProviderFailure('CANCELLED');
    return revision;
  }
  private historyCompatible(entry:RetainedChatSession,scope:ScopeSnapshot,config:ProviderConfig):boolean {
    if(!entry.history.length)return true;
    try{
      const policy=this.selectedGenerationPolicy(),scopeDigest=hash(JSON.stringify(scope));
      const configuration=JSON.stringify([configDigest('generation',config),scope.rootId]);
      if(entry.policyPort!==policy||!entry.history.every(turn=>turn.scopeDigest===scopeDigest
        &&turn.sourceRevision===this.sourceRevision&&turn.generationId===scope.generationId&&turn.configuration===configuration))return false;
      const revision=this.historyPolicyRevision(scope,config,policy);
      return entry.history.every(turn=>turn.lineage.policyRevision===revision);
    }catch{return false;}
  }
  /** Same physical slot as retained retrieval. A historical proof is not a
   * grant; local display reauthenticates exact membership, originals and spans. */
  readVerifiedRetainedChatHistory(session:RetainedChatSessionOwner):Promise<ApiResult<readonly CompletedChatTurn[]>> {
    return this.withVerifiedRetainedChatHistory(session,{apiVersion:1,ok:true,value:[]},history=>structuredClone(history));
  }
  /** Never accept a UI-supplied path, span or citation object. */
  openRetainedChatCitation(session:RetainedChatSessionOwner,turnId:string,claimIndex:number,citationIndex:number):Promise<ApiResult<null>> {
    const lookup=(history:readonly CompletedChatTurn[])=>history.find(turn=>turn.id===turnId)?.claims[claimIndex]?.citations[citationIndex];
    const entry=this.retainedSessions.get(session);
    if(!entry||typeof turnId!=='string'||!Number.isSafeInteger(claimIndex)||claimIndex<0
      ||!Number.isSafeInteger(citationIndex)||citationIndex<0||!lookup(entry.history))
      return Promise.resolve(chatFailure('NAVIGATION_REJECTED'));
    return this.withVerifiedRetainedChatHistory(session,chatFailure('NAVIGATION_REJECTED'),async(history,authority)=>{
      const hit=lookup(history);
      if(!hit)throw new StandaloneError('NAVIGATION_REJECTED');
      authority.current();
      await this.navigate(structuredClone(hit),authority);
      authority.current();
      return null;
    });
  }
  private withVerifiedRetainedChatHistory<T>(session:RetainedChatSessionOwner,empty:ApiResult<T>,
    complete:(history:readonly CompletedChatTurn[],authority:NavigationAuthority)=>T|Promise<T>):Promise<ApiResult<T>> {
    const entry=this.retainedSessions.get(session),engine=this.engine,port=this.generationPort;
    if(!entry||this.disposed||!this.enabled||this.paused||this.sharedAuthorityTransition())return Promise.resolve(chatFailure('CANCELLED'));
    if(!entry.history.length)return Promise.resolve(empty);
    if(!engine?.captureChatScope||!port)return Promise.resolve(chatFailure('NOT_READY'));
    if(!this.embeddingAdmissionAvailable()||this.active||this.pending)return Promise.resolve(chatFailure('BUSY'));
    const abort=new AbortController(),history=entry.history;
    let context:CallContext;
    try{context=bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+SCOPED_RETRIEVAL_TIMEOUT_MS},SCOPED_RETRIEVAL_TIMEOUT_MS);}
    catch{return Promise.resolve(chatFailure('TIMEOUT'));}
    let finish!:(result:ApiResult<T>)=>void;
    const result=new Promise<ApiResult<T>>(resolve=>{finish=resolve;});
    const operation:ActiveScopedRetrieval={abort,context,revision:this.revision,sourceRevision:this.sourceRevision,
      finish:result=>{if(!result.ok)finish(result);},retained:{session,owner:Object.freeze({})},retired:false,inFlight:true};
    this.scopedRetrieval=operation;
    const check=():void=>{
      remainingOperationMs(context);
      if(this.scopedRetrieval!==operation||operation.retired||this.sharedAuthorityTransition()||!this.enabled||this.paused
        ||this.engine!==engine||this.generationPort!==port||this.revision!==operation.revision||this.sourceRevision!==operation.sourceRevision
        ||this.retainedSessions.get(session)!==entry||entry.history!==history)throw new ProviderFailure('CANCELLED');
    };
    const clear=():void=>{if(this.retainedSessions.get(session)===entry&&entry.history===history)this.clearRetainedHistory(session);};
    operation.timer=setTimeout(()=>{clear();this.retireScopedRetrieval(operation,'TIMEOUT');},SCOPED_RETRIEVAL_TIMEOUT_MS);
    void(async()=>{
      try{
        check();
        const scope=await engine.captureChatScope!(structuredClone(history[0]!.lineage.selector),abort.signal);check();
        const compatible=():void=>{
          check();
          const pref=port.config();
          if(pref.state!=='configured'||port.scopeId()!==scope.snapshot.rootId||!scope.current()
            ||!this.historyCompatible(entry,scope.snapshot,pref))throw new ProviderFailure('SOURCE_STALE');
          check();
        };
        compatible();await scope.verify();compatible();
        const versions=new Map(scope.snapshot.sources.map(source=>[source.sourceId,source.sourceSha256]));
        for(const turn of history)for(const claim of turn.claims)for(const citation of claim.citations){
          if(versions.get(citation.sourceId)!==citation.sourceSha256||citation.indexGenerationId!==turn.generationId)
            throw new ProviderFailure('SOURCE_STALE');
          await port.verify(structuredClone(citation));compatible();
        }
        await scope.verify();compatible();
        const authority:NavigationAuthority=Object.freeze({current:compatible,verify:async()=>{
          compatible();await scope.verify();compatible();
        }});
        const value=await complete(history,authority);compatible();
        entry.lastUsed=Date.now();
        clearTimeout(operation.timer);
        operation.inFlight=false;this.scopedRetrieval=undefined;
        finish({apiVersion:1,ok:true,value});
      }catch(error){
        if(!operation.retired){
          clear();
          const reason=deadlineFailure(context)?.code??(error instanceof ProviderFailure||error instanceof StandaloneError?error.code:'SOURCE_STALE');
          this.retireScopedRetrieval(operation,reason);
        }
      }finally{operation.inFlight=false;this.releaseRetiredScopedRetrieval();}
    })();
    return result;
  }
  private selectedPriorIds(session:RetainedChatSessionOwner,value:unknown):readonly string[] {
    if (!Array.isArray(value) || value.length>2 || value.some(id=>typeof id!=='string')) throw new ProviderFailure('DISCLOSURE_DENIED');
    const entry=this.retainedSessions.get(session);
    if (new Set(value).size!==value.length || !value.every(id=>entry?.history.some(turn=>turn.id===id)))
      throw new ProviderFailure('DISCLOSURE_DENIED');
    return Object.freeze([...value]);
  }
  private clearRetainedHistory(session:RetainedChatSessionOwner|undefined):void {
    const entry=session&&this.retainedSessions.get(session); if (entry) {entry.history=[];entry.policyPort=undefined;}
  }
  private clearAllRetainedHistory():void { for(const entry of this.retainedSessions.values()) {entry.history=[];entry.policyPort=undefined;} }
  private clearRetainedGeneration(retained: RetainedScopedTurn): void {
    retained.draft=undefined;
    retained.preview=undefined;
  }
  private retainedGenerationCurrent(operation:ActiveScopedRetrieval, retained:RetainedScopedTurn,
    stamp:GenerationCredentialStamp): {config:ProviderConfig;binding:string;scopeId:string;port:RerankPort} {
    try {
      const check=retained.check, lease=retained.lease, pinned=retained.configuration;
      if (!check || !lease || !pinned || !operation.inFlight) throw new ProviderFailure('CANCELLED');
      check();
      const port=this.generationPort, preference=port?.config();
      if (!port || preference?.state!=='configured') throw new ProviderFailure('NOT_READY');
      const config=structuredClone(pilotConfig(preference)), binding=configDigest('generation',config);
      const scopeId=port.scopeId();
      if (!isDigest(scopeId) || scopeId!==lease.snapshot.rootId || JSON.stringify([binding,scopeId])!==pinned)
        throw new ProviderFailure('CANCELLED');
      check();
      if (this.ownedRetainedTurn(retained.session,retained.owner)!==operation || retained.check!==check
        || retained.lease!==lease || retained.configuration!==pinned
        || !this.generationCredential.current(retained.owner,binding,stamp)) throw new ProviderFailure('CANCELLED');
      const entry=this.retainedSessions.get(retained.session),history=entry?.history;
      if(retained.prior?.length&&(!entry||!this.historyCompatible(entry,lease.snapshot,config)||entry.history!==history))
        throw new ProviderFailure('CANCELLED');
      check();
      if (retained.prior?.some(item=>!history?.some(turn=>turn.id===item.id && turn.questionDigest===item.questionDigest && turn.question===item.question)))
        throw new ProviderFailure('CANCELLED');
      return {config,binding,scopeId,port};
    } catch(error) {
      this.clearRetainedHistory(retained.session);
      this.retireScopedRetrieval(operation,error instanceof ProviderFailure || error instanceof StandaloneError ? error.code : 'CANCELLED');
      throw error instanceof ProviderFailure ? error : new ProviderFailure('CANCELLED');
    }
  }
  private withRetainedGeneration<T>(operation:ActiveScopedRetrieval, action:()=>T):T {
    operation.inFlight=true; operation.retained!.generationBusy=true;
    try { return action(); } finally {
      operation.retained!.generationBusy=false; operation.inFlight=false;
      this.releaseRetiredScopedRetrieval();
    }
  }
  private retainedInputBytes(question:string,hits:readonly EvidenceHit[],config:ProviderConfig):number {
    let size=0;
    if (hits.length>config.limits.maxCandidates) throw new ProviderFailure('LIMIT_EXCEEDED');
    for(const text of [question,...hits.map(h=>h.originalExcerpt)]) {
      if(!text.length || text.includes('\0') || Buffer.from(text,'utf8').toString('utf8')!==text)
        throw new ProviderFailure('LIMIT_EXCEEDED');
      size+=Buffer.byteLength(text);
      if(size>config.limits.maxInputBytes) throw new ProviderFailure('LIMIT_EXCEEDED');
    }
    return size;
  }
  private selectedGenerationPolicy():GenerationPolicyPort|undefined {
    const port=this.generationPolicyPort;
    return port&&(port.selected?.()??true)?port:undefined;
  }
  private selectedRerankPolicy():RerankPolicyPort|undefined {
    const port=this.rerankPolicyPort;return port&&(port.selected?.()??true)?port:undefined;
  }
  private retainedPolicyInput(preview:Pick<RetainedChatGenerationPreview,'config'|'scopeId'|'scopeDigest'|'composedQuestion'>,
    scope:ScopeSnapshot,hits:readonly EvidenceHit[],stamp:GenerationCredentialStamp,context:CallContext):GenerationPolicyInput{
    if(scope.coverage.excluded>0)throw new ProviderFailure('DISCLOSURE_DENIED');
    return {role:'generation',config:preview.config,scopeId:preview.scopeId,scopeBinding:preview.scopeDigest,scopeSources:scope.sources,
      ownerId:stamp.hostId+':'+stamp.epoch,hostId:stamp.hostId,credentialEpoch:stamp.epoch,deadlineUnixMs:context.deadlineUnixMs,
      payloadDigest:generationPolicyPayload(preview.composedQuestion.text,hits.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,text:hit.originalExcerpt}))),
      sources:hits.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,excerptDigest:hash(hit.originalExcerpt)}))};
  }
  private async evaluateRetainedGenerationPolicy(preview:Pick<RetainedChatGenerationPreview,'config'|'scopeId'|'scopeDigest'|'composedQuestion'>,
    scope:ScopeSnapshot,hits:readonly EvidenceHit[],stamp:GenerationCredentialStamp,context:CallContext,current:()=>boolean):Promise<GenerationPolicyBinding> {
    const port=this.selectedGenerationPolicy();
    if(!port)throw new ProviderFailure('DISCLOSURE_DENIED');
    const input=this.retainedPolicyInput(preview,scope,hits,stamp,context);
    return this.generationPolicyGate.evaluate(port,input,context,()=>current()&&this.selectedGenerationPolicy()===port&&current());
  }
  private composeRetainedQuestion(draft:RetainedChatClassificationDraft):{text:string;digest:string;classification:Classification} {
    if (!draft.priorQuestions.length) return {text:draft.question.text,digest:hash(draft.question.text),classification:draft.question.classification};
    const text=[...draft.priorQuestions.map((item,index)=>`Prior user question ${index+1}:\n${item.text}`),
      `Current user question:\n${draft.question.text}`].join('\n\n');
    const classification=draft.priorQuestions.some(item=>item.classification==='public') || draft.question.classification==='public'
      ? 'public' : 'synthetic';
    return {text,digest:hash(text),classification};
  }
  private serializedHistoryBytes(history:readonly CompletedChatTurn[],lastUsed:number):number {
    return Buffer.byteLength(JSON.stringify({history,lastUsed}),'utf8');
  }
  private prepareCompletedTurn(session:RetainedChatSessionOwner,retained:RetainedScopedTurn,
    preview:RetainedChatGenerationPreview,claims:readonly GeneratedEvidenceClaim[],policyPort:GenerationPolicyPort|undefined,historyRevision:string|null):()=>boolean {
    const entry=this.retainedSessions.get(session);
    if (!entry || !retained.question || !retained.lease || Buffer.byteLength(retained.question,'utf8')>MAX_STORED_QUESTION_BYTES)
      throw new ProviderFailure('LIMIT_EXCEEDED');
    const scope=retained.lease.snapshot,engine=this.engine,port=this.generationPort,revision=this.revision;
    if(!this.historyCompatible(entry,scope,preview.config)){
      if(retained.prior?.length)throw new ProviderFailure('CANCELLED');
      this.clearRetainedHistory(session);
    }
    const previous=entry.history, completedAt=Date.now();
    const hits=retained.response!.hits;
    const sources=hits.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,excerptDigest:hash(hit.originalExcerpt)}));
    const lineage:ChatHistoryLineage={version:1,use:'local-only',selector:structuredClone(scope.selector),
      policyRevision:historyRevision,policyBindingDigest:preview.policy?.bindingDigest??null,
      payloadDigest:generationPolicyPayload(preview.composedQuestion.text,hits.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,text:hit.originalExcerpt}))),
      sourceDigest:generationPolicySourceDigest({role:'generation',sources}),
      questions:[...preview.priorQuestions,preview.question].map(({id,digest,classification})=>({id,digest,classification}))};
    const turn=Object.freeze({id:randomUUID(),
      question:retained.question,questionDigest:hash(retained.question),claims:structuredClone(claims),scopeDigest:preview.scopeDigest,
      configuration:retained.configuration!,generationId:retained.lease.snapshot.generationId,sourceRevision:this.sourceRevision,completedAt,lineage});
    const candidate=[...previous,turn];
    while(candidate.length>MAX_COMPLETED_TURNS || this.serializedHistoryBytes(candidate,completedAt)>MAX_SESSION_HISTORY_BYTES) candidate.shift();
    if (!candidate.includes(turn)) throw new ProviderFailure('LIMIT_EXCEEDED');
    // The four per-session envelopes imply the aggregate bound. Do not mutate
    // any transcript until logical retirement and publication checks succeed.
    const publish=():boolean=>{
      const owns=()=>!this.disposed&&this.revision===revision&&this.engine===engine&&this.generationPort===port
        &&this.retainedSessions.get(session)===entry&&entry.history===previous&&this.sourceRevision===turn.sourceRevision;
      if(!owns())return false;
      try {
        const pref=port?.config();
        if(pref?.state!=='configured'||port?.scopeId()!==scope.rootId||this.engine?.status().generationId!==scope.generationId
          ||JSON.stringify([configDigest('generation',pref),scope.rootId])!==turn.configuration
          ||this.selectedGenerationPolicy()!==policyPort||this.historyPolicyRevision(scope,pref,policyPort)!==historyRevision
          ||!owns()){
          if(owns())this.clearRetainedHistory(session);
          return false;
        }
      }catch{
        if(owns())this.clearRetainedHistory(session);
        return false;
      }
      const total=[...this.retainedSessions.values()].reduce((size,item)=>size+
        this.serializedHistoryBytes(item===entry?candidate:item.history,item===entry?completedAt:item.lastUsed),0);
      if(total>MAX_HISTORY_BYTES) return false;
      entry.history=candidate;entry.policyPort=policyPort;entry.lastUsed=completedAt;return true;
    };
    return publish;
  }
  private retainedDraftView(question:string, response:SearchResponse, stamp:GenerationCredentialStamp,
    labels:Map<string,Classification>,prior:readonly Pick<CompletedChatTurn,'id'|'question'|'questionDigest'>[]=[]):RetainedChatClassificationDraft {
    const questionDigest=hash(question), questionId=`question:${questionDigest}`;
    const evidence=response.hits.map((hit,index)=>{
      const locatorDigest=hash(JSON.stringify(hit.sourceLocators));
      const digest=hash(JSON.stringify([hit.sourceId,hit.sourceSha256,locatorDigest,hit.originalExcerpt]));
      const id=`evidence:${index}:${digest}`;
      return Object.freeze({id,digest,sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,locatorDigest,
        excerpt:hit.originalExcerpt,classification:labels.get(id) ?? 'unknown'});
    });
    const priorQuestions=prior.map(turn=>Object.freeze({id:`prior:${turn.id}`,turnId:turn.id,digest:turn.questionDigest,
      text:turn.question,classification:labels.get(`prior:${turn.id}`) ?? 'unknown'}));
    return Object.freeze({id:`chat-draft:${++this.sequence}`,credentialStamp:Object.freeze({...stamp}),
      question:Object.freeze({id:questionId,digest:questionDigest,text:question,
        classification:labels.get(questionId) ?? 'unknown'}),priorQuestions:Object.freeze(priorQuestions),evidence:Object.freeze(evidence)});
  }
  /** Classifications are explicit, per detached item attestations.  Unknown and
   * restrictive labels never become consent by omission or by a bulk choice. */
  createRetainedChatClassificationDraft(session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner,
    stamp:GenerationCredentialStamp):RetainedChatClassificationDraft {
    const operation=this.ownedRetainedTurn(session,owner), retained=operation?.retained;
    if (!operation || !retained || operation.inFlight || !retained.response || !retained.question) throw new ProviderFailure('NOT_READY');
    return this.withRetainedGeneration(operation,()=>{
      const {binding,config}=this.retainedGenerationCurrent(operation,retained,stamp);
      if(retained.response!.status!=='ok' || !retained.response!.hits.length) {
        this.retireScopedRetrieval(operation,'INSUFFICIENT_EVIDENCE');
        throw new StandaloneError('INSUFFICIENT_EVIDENCE');
      }
      this.retainedInputBytes(retained.question!,retained.response!.hits,config);
      const labels=new Map<string,Classification>();
      const view=this.retainedDraftView(retained.question!,retained.response!,stamp,labels,retained.prior);
      retained.draft={view,configuration:binding,stamp:Object.freeze({...stamp}),labels};
      retained.preview=undefined;
      return view;
    });
  }
  attestRetainedChatClassification(session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner,
    draft:RetainedChatClassificationDraft,itemId:string,classification:Classification|'blocked'):RetainedChatClassificationDraft {
    const operation=this.ownedRetainedTurn(session,owner), retained=operation?.retained, record=retained?.draft;
    if (!operation || !retained || operation.inFlight || !record || record.view!==draft)
      throw new ProviderFailure('DISCLOSURE_DENIED');
    return this.withRetainedGeneration(operation,()=>{
      this.retainedGenerationCurrent(operation,retained,record.stamp);
      const known=[draft.question.id,...draft.priorQuestions.map(item=>item.id),...draft.evidence.map(item=>item.id)];
      if (!known.includes(itemId)) throw new ProviderFailure('DISCLOSURE_DENIED');
      if (classification!=='synthetic' && classification!=='public') {
        this.clearRetainedHistory(retained.session);
        this.retireScopedRetrieval(operation,'DISCLOSURE_DENIED');
        throw new ProviderFailure('DISCLOSURE_DENIED');
      }
      if(this.selectedGenerationPolicy()&&draft.evidence.some(item=>item.id===itemId))throw new ProviderFailure('DISCLOSURE_DENIED');
      retained.preview=undefined;
      record.labels.set(itemId,classification);
      const view=this.retainedDraftView(retained.question!,retained.response!,record.stamp,record.labels,retained.prior);
      retained.draft={...record,view};
      return view;
    });
  }
  prepareRetainedChatGeneration(session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner,
    draft:RetainedChatClassificationDraft):Promise<RetainedChatGenerationPreview> {
    const operation=this.ownedRetainedTurn(session,owner), retained=operation?.retained, record=retained?.draft;
    if (!operation || !retained || operation.inFlight || !record || record.view!==draft || retained.preview)
      return Promise.reject(new ProviderFailure('DISCLOSURE_DENIED'));
    const allowed=(c:Classification)=>c==='synthetic'||c==='public';
    if (!allowed(draft.question.classification) || draft.priorQuestions.some(item=>!allowed(item.classification))
      || (!this.selectedGenerationPolicy()&&draft.evidence.some(item=>!allowed(item.classification))))
      return Promise.reject(new ProviderFailure('DISCLOSURE_DENIED'));
    operation.inFlight=true;retained.generationBusy=true;
    const result=new Promise<RetainedChatGenerationPreview>((resolve,reject)=>{
      retained.rejectPreview=reject;
      void (async()=>{
        try {
          const current=()=>this.retainedGenerationCurrent(operation,retained,record.stamp);
          const {config,scopeId,port}=current();
          const lease=retained.lease!, hits=retained.response!.hits;
          const scopeDigest=hash(JSON.stringify(lease.snapshot));
          const composed=this.composeRetainedQuestion(draft);
          const inputBytes=this.retainedInputBytes(composed.text,hits,config);
          await lease.verify();current();
          for(const hit of hits) {
            await port.verify(structuredClone(hit));current();
          }
          if(scopeDigest!==hash(JSON.stringify(lease.snapshot)) || retained.draft!==record)
            throw new ProviderFailure('CANCELLED');
          Object.freeze(config.identity);Object.freeze(config.limits);Object.freeze(config);
          const bare={...draft,config,scopeId,scopeDigest,composedQuestion:Object.freeze(composed),
            expiresUnixMs:operation.context.deadlineUnixMs,inputBytes};
          const policyPort=this.selectedGenerationPolicy();
          const historyRevision=this.historyPolicyRevision(lease.snapshot,config,policyPort);current();
          const policy=policyPort?await this.evaluateRetainedGenerationPolicy(bare,lease.snapshot,hits,record.stamp,operation.context,()=>{current();return retained.draft===record&&this.selectedGenerationPolicy()===policyPort;}):undefined;
          current();
          if(this.selectedGenerationPolicy()!==policyPort||this.historyPolicyRevision(lease.snapshot,config,policyPort)!==historyRevision)
            throw new ProviderFailure('CANCELLED');
          current();
          const preview=Object.freeze({...bare,...(policy?{policy}:{})});
          retained.preview={view:preview,draft:record,policyPort,historyRevision};
          resolve(preview);
        } catch(error) {
          const reason=deadlineFailure(operation.context)??(error instanceof ProviderFailure?error:new ProviderFailure('SOURCE_STALE'));
          // This preparation owns its terminal failure. Retire before notifying,
          // but do not let retirement's generic cancellation mask the typed cause.
          retained.rejectPreview=undefined;
          this.retireScopedRetrieval(operation,reason.code);
          reject(reason);
        } finally {
          retained.rejectPreview=undefined;retained.generationBusy=false;operation.inFlight=false;
          this.releaseRetiredScopedRetrieval();
        }
      })();
    });
    return result;
  }
  /** One-shot trusted-host consent.  The response is detached verified claims;
   * no grant, lease, raw provider body, or secret is returned. */
  async confirmRetainedChatGeneration(session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner,
    preview:RetainedChatGenerationPreview):Promise<ApiResult<readonly GeneratedEvidenceClaim[]>> {
    const operation=this.ownedRetainedTurn(session,owner), retained=operation?.retained, envelope=retained?.preview;
    if (!operation || !retained || operation.inFlight || !envelope || envelope.view!==preview)
      return chatFailure('DISCLOSURE_DENIED');
    operation.inFlight=true;retained.generationBusy=true;
    // Consume before any callback or source verification can reenter.
    retained.preview=undefined;retained.draft=undefined;
    try {
      const {config,binding,port,scopeId}=this.retainedGenerationCurrent(operation,retained,envelope.draft.stamp);
      if (binding!==envelope.draft.configuration || !retained.response || !retained.lease || !retained.question
        || preview.scopeId!==scopeId || preview.scopeDigest!==hash(JSON.stringify(retained.lease.snapshot)))
        throw new ProviderFailure('CANCELLED');
      const query=preview.composedQuestion, candidates=retained.response.hits.map((hit,index)=>({hit,
        classification:preview.policy?'unknown' as const:preview.evidence[index]!.classification}));
      if (query.classification!=='synthetic' && query.classification!=='public'
        || !!preview.policy!==!!this.selectedGenerationPolicy()
        || (!preview.policy&&candidates.some(candidate=>candidate.classification!=='synthetic' && candidate.classification!=='public')))
        throw new ProviderFailure('DISCLOSURE_DENIED');
      // The retained 30s budget remains the turn authority.  Generation gets
      // a distinct, never-longer provider bound; every guard below rechecks
      // the original retained context before/after its own async boundaries.
      const context=operation.context;
      const providerDeadline=Math.min(context.deadlineUnixMs,Date.now()+config.limits.timeoutMs);
      const constituents=Object.freeze([...preview.priorQuestions.map(item=>Object.freeze({id:item.id,digest:item.digest,classification:item.classification})),
        Object.freeze({id:preview.question.id,digest:preview.question.digest,classification:preview.question.classification})]);
      const grant:DisclosureGrant & {readonly constituents:typeof constituents}={version:1,role:'generation',configDigest:binding,scopeId,expiresUnixMs:providerDeadline,
        queryDigest:hash(query.text),queryClassification:query.classification,...(preview.policy?{notePolicyBinding:preview.policy}:{}),sources:candidates.map(({hit,classification})=>({
          sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,excerptDigest:hash(hit.originalExcerpt),classification})),constituents};
      const current=():boolean=>{
        try {
          this.retainedGenerationCurrent(operation,retained,envelope.draft.stamp);
          const policyPort=this.selectedGenerationPolicy();
          if(!!preview.policy!==!!policyPort||policyPort!==envelope.policyPort
            ||this.historyPolicyRevision(retained.lease!.snapshot,config,policyPort)!==envelope.historyRevision)return false;
          if(preview.policy&&policyPort&&!policyPort.current(this.retainedPolicyInput(preview,retained.lease!.snapshot,
            retained.response!.hits,envelope.draft.stamp,context),preview.policy))return false;
          this.retainedGenerationCurrent(operation,retained,envelope.draft.stamp);
          return !operation.retired&&operation.inFlight&&this.selectedGenerationPolicy()===policyPort;
        }
        catch { return false; }
      };
      const policyCheck=preview.policy?()=>this.evaluateRetainedGenerationPolicy(preview,retained.lease!.snapshot,retained.response!.hits,envelope.draft.stamp,context,current):undefined;
      const claims=await this.generator.run({config,scopeId:grant.scopeId,query:{text:query.text,classification:query.classification},
        candidates,grant},this.generationCredential.secret(owner,binding,envelope.draft.stamp),
      {signal:context.signal,deadlineUnixMs:providerDeadline},async hit=>{
          operation.physicalReads=(operation.physicalReads??0)+1;
          try {
            if(!current())throw new ProviderFailure('CANCELLED');
            await retained.lease!.verify();
            if(!current())throw new ProviderFailure('CANCELLED');
            await port.verify(hit);
            if(!current())throw new ProviderFailure('CANCELLED');
          } finally {
            operation.physicalReads!--;
            this.releaseRetiredScopedRetrieval();
          }
        },current,policyCheck);
      if(!current())throw new ProviderFailure('CANCELLED');
      remainingOperationMs(context);
      const detached=structuredClone(claims);
      const publish=detached.length?this.prepareCompletedTurn(session,retained,preview,detached,envelope.policyPort,envelope.historyRevision):undefined;
      if(!current())throw new ProviderFailure('CANCELLED');
      this.retireScopedRetrieval(operation,'CANCELLED');
      if(this.disposed || this.revision!==operation.revision || this.sourceRevision!==operation.sourceRevision
        || !this.retainedSessions.has(session)) return chatFailure('CANCELLED');
      if(!publish)return chatFailure('INSUFFICIENT_EVIDENCE');
      return publish()?{apiVersion:1,ok:true,value:detached}:chatFailure('CANCELLED');
    } catch(error) {
      const code=deadlineFailure(operation.context)?.code ?? (error instanceof ProviderFailure ? error.code : 'NOT_READY');
      this.retireScopedRetrieval(operation,code);
      return chatFailure(code);
    } finally {
      this.generationCredential.revoke(owner);
      retained.generationBusy=false;operation.inFlight=false;
      this.releaseRetiredScopedRetrieval();
    }
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
    this.clearRetainedHistory(session);
    this.clearRetainedGeneration(operation.retained!);
    // An outstanding resolver may not be replaced until physically settled.
    if (operation.retained?.rejectCredential || operation.retained?.generationBusy || operation.retained?.prior?.length) this.retireScopedRetrieval(operation,'CANCELLED');
  }
  private bindRetainedCredential(session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner,
    input?:{token:string}):Promise<GenerationCredentialStamp> {
    const operation=this.ownedRetainedTurn(session,owner);
    if (!operation) return Promise.reject(new ProviderFailure('CANCELLED'));
    if (operation.inFlight) {
      // Replacement of an outstanding resolver is an explicit retirement,
      // not permission to start a second resolver against the same slot.
      if (operation.retained?.rejectCredential || operation.retained?.generationBusy) {
        this.clearRetainedHistory(session);this.retireScopedRetrieval(operation,'CANCELLED');
      }
      return Promise.reject(new ProviderFailure('BUSY'));
    }
    const retained=operation.retained!;
    if (!retained.check || !retained.lease || !retained.response) return Promise.reject(new ProviderFailure('NOT_READY'));
    const replacing=!!retained.credentialBound;
    operation.inFlight=true;
    this.generationCredential.revoke(owner);
    if (replacing) {
      this.clearRetainedHistory(session);
      if(retained.prior?.length){
        this.retireScopedRetrieval(operation,'CANCELLED');operation.inFlight=false;this.releaseRetiredScopedRetrieval();
        return Promise.reject(new ProviderFailure('CANCELLED'));
      }
    }
    this.clearRetainedGeneration(retained);
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
          retained.credentialBound=true;
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
    if (this.generationCredential.exclusiveBusy || this.generationAdmissionDepth || this.generationPolicyPreparation || this.generationPolicyGate.busy || this.prepared.generation || this.activeEvidence.generation
      || this.prepared.reranking?.credential || this.activeEvidence.reranking?.credential
      || this.scopedRetrieval || this.graphOperation?.inFlight || this.active || this.pending) return rejected('BUSY');
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
          retained.question=request.query;
          retained.check=()=>current(lease);
          retained.configuration=config;
          const entry=this.retainedSessions.get(retained.session);
          const scopeDigest=hash(JSON.stringify(lease.snapshot));
          const selected=retained.priorIds ?? [];
          const pref=this.generationPort?.config();
          if(entry?.history.length&&(pref?.state!=='configured'||!this.historyCompatible(entry,lease.snapshot,pref)))
            this.clearRetainedHistory(retained.session);
          current(lease);
          if (entry?.history.some(turn=>turn.scopeDigest!==scopeDigest || turn.configuration!==config
              || turn.generationId!==generation || turn.sourceRevision!==this.sourceRevision)) this.clearRetainedHistory(retained.session);
          const prior=selected.map(id=>entry?.history.find(turn=>turn.id===id));
          if (!entry || prior.some((turn):turn is undefined=>!turn)
            || prior.some(turn=>turn!.scopeDigest!==scopeDigest || turn!.configuration!==config
              || turn!.generationId!==generation || turn!.sourceRevision!==this.sourceRevision)) {
            this.clearRetainedHistory(retained.session);
            throw new StandaloneError('SCOPE_CHANGED');
          }
          retained.prior=Object.freeze(prior.map(turn=>Object.freeze({id:turn!.id,question:turn!.question,questionDigest:turn!.questionDigest})));
          entry.lastUsed=Date.now();
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
    if (operation?.retired && !operation.inFlight && !operation.physicalReads && !this.retirement.running) this.scopedRetrieval=undefined;
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
      const rejectCredential=retained.rejectCredential, rejectPreview=retained.rejectPreview;
      this.generationCredential.revoke(retained.owner);
      retained.rejectCredential=undefined;retained.rejectPreview=undefined;retained.configuration=undefined;
      retained.question=undefined;retained.prior=undefined;retained.priorIds=undefined;
      this.clearRetainedGeneration(retained);
      retained.lease=undefined;retained.response=undefined;retained.check=undefined;retained.finishRead=undefined;
      finishRead?.(result);
      rejectCredential?.(new ProviderFailure(reason.code==='TIMEOUT' ? 'TIMEOUT' : 'CANCELLED'));
      rejectPreview?.(new ProviderFailure(reason.code==='TIMEOUT' ? 'TIMEOUT' : 'CANCELLED'));
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
  prepareRerank(): RerankPreview {
    if(this.selectedRerankPolicy())throw new ProviderFailure('NOT_READY');
    if(this.generationPolicyPreparation?.role==='reranking'||this.prepared.reranking?.credential||this.activeEvidence.reranking?.credential)
      throw new ProviderFailure('BUSY');
    return this.prepareEvidence('reranking');
  }
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
      || this.activeEvidence.generation?.credential?.viewOwner===owner || this.generationTransitionRole==='generation'&&this.generationTransitionView===owner;
  }
  closeGenerationViewOwner(owner:object):void {
    if (!this.generationViews.delete(owner)) return;
    if (this.ownsGenerationView(owner)) this.cancelEvidence('generation');
    if(this.prepared.reranking?.credential?.viewOwner===owner||this.activeEvidence.reranking?.credential?.viewOwner===owner
      ||this.generationTransitionRole==='reranking'&&this.generationTransitionView===owner)this.cancelEvidence('reranking');
  }
  prepareGeneration(token:string,viewOwner:object=this.defaultGenerationView): RerankPreview {
    // The historical synchronous pilot cannot skip an admitted asynchronous
    // original-byte evaluation.
    if (this.selectedGenerationPolicy()) throw new ProviderFailure('NOT_READY');
    return this.prepareGenerationUnchecked(token,viewOwner);
  }
  /** The policy path is host-port-only and evaluates before returning a preview. */
  async prepareGenerationWithPolicy(token:string,viewOwner:object=this.defaultGenerationView):Promise<RerankPreview> {
    return this.preparePolicyEvidence('generation',token,viewOwner);
  }
  async prepareRerankWithPolicy(token:string,viewOwner:object=this.defaultGenerationView):Promise<RerankPreview> {
    return this.preparePolicyEvidence('reranking',token,viewOwner);
  }
  private async preparePolicyEvidence(role:EvidenceRole,token:string,viewOwner:object):Promise<RerankPreview>{
    const policy=role==='generation'?this.selectedGenerationPolicy():this.selectedRerankPolicy();
    if(!policy)throw new ProviderFailure('NOT_READY');
    if(this.generationCredential.exclusiveBusy||this.generationAdmissionDepth||this.generationPolicyPreparation||this.generationPolicyGate.busy||this.generationTransition||this.generationPreviewReading
      ||this.scopedRetrieval||role==='reranking'&&(this.prepared.generation||this.activeEvidence.generation
        ||this.prepared.reranking?.credential&&this.prepared.reranking.credential.viewOwner!==viewOwner)
      ||role==='generation'&&(this.prepared.reranking?.credential||this.activeEvidence.reranking?.credential))
      throw new ProviderFailure('BUSY');
    if(!this.generationViewCurrent(viewOwner))throw new ProviderFailure('NOT_READY');
    const preparation:{role:EvidenceRole;abort:AbortController;pending?:PendingEvidencePreview;context?:CallContext}={role,abort:new AbortController()};
    this.generationPolicyPreparation=preparation;
    let pending:PendingEvidencePreview|undefined;
    try{
      // Do not publish a credential-bearing policy preview before the exact
      // host binding exists.  An observer must only ever see a preview whose
      // synchronous currentness guard can validate its selected policy port.
      const preview=role==='generation'?this.prepareGenerationUnchecked(token,viewOwner,false):this.prepareEvidence(role,token,viewOwner,false);
      pending=this.prepared[role];preparation.pending=pending;
      if(pending)pending.policyPort=policy;
      const owns=()=>!!pending&&this.generationPolicyPreparation===preparation&&!preparation.abort.signal.aborted
        &&this.prepared[role]===pending&&pending.preview.sequence===preview.sequence
        &&this.revision===preview.revision&&!this.sharedAuthorityTransition()&&!this.disposed
        &&!!pending.credential&&pending.credential.viewOwner===viewOwner&&this.boundCredentialCurrent(pending.credential)
        &&this.evidencePreviewConfigurationCurrent(preview)&&this.profileCurrent(preview)
        &&(role==='generation'?this.selectedGenerationPolicy():this.selectedRerankPolicy())===policy
        &&this.prepared[role]===pending&&this.revision===preview.revision&&!preparation.abort.signal.aborted;
      if(!owns())throw new ProviderFailure('CANCELLED');
      const context=bindActiveDeadline({signal:preparation.abort.signal,
        deadlineUnixMs:Math.min(preview.expiresUnixMs,Date.now()+preview.config.limits.timeoutMs)},preview.config.limits.timeoutMs);
      preparation.context=context;
      const binding=await this.evaluatePolicy(preview,context,pending!.credential!,owns);
      if(!owns())throw new ProviderFailure('CANCELLED');
      pending!.preview=Object.freeze({...preview,policy:binding,expiresUnixMs:binding.deadlineUnixMs}) as RerankPreview;
      pending!.policyContext=context;pending!.policyAbort=preparation.abort;
      clearTimeout(this.previewTimers[role]);
      this.previewTimers[role]=setTimeout(()=>this.expirePreview(role,pending!),remainingOperationMs(context));
      if(this.currentPreview(role)!==pending)throw new ProviderFailure('CANCELLED');
      this.emitEvidence();
      // Evidence listeners are synchronous and may replace or revoke policy.
      // Recheck after publication before returning a usable preview capability.
      if(this.currentPreview(role)!==pending)throw new ProviderFailure('CANCELLED');
      return structuredClone(pending!.preview);
    }catch(error){
      if(pending&&this.prepared[role]===pending)this.cancelEvidence(role);
      throw error instanceof ProviderFailure?error:new ProviderFailure('DISCLOSURE_DENIED');
    }finally{if(this.generationPolicyPreparation===preparation)this.generationPolicyPreparation=undefined;}
  }
  private prepareGenerationUnchecked(token:string,viewOwner:object,publish=true):RerankPreview {
    if (!this.generationViewCurrent(viewOwner)) throw new ProviderFailure('NOT_READY');
    if (this.scopedRetrieval || this.generationTransition || this.generationPreviewReading
      ||this.generationPolicyPreparation?.role==='reranking'||this.prepared.reranking?.credential||this.activeEvidence.reranking?.credential
      || (this.prepared.generation && !this.ownsGenerationView(viewOwner))) throw new ProviderFailure('BUSY');
    this.generationAdmissionDepth++;
    try { return this.prepareEvidence('generation',token,viewOwner,publish); }
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
    const credentialRead=role==='generation'||!!pending?.credential;
    if(!pending||credentialRead&&this.generationPreviewReading)return undefined;
    // Unbound asynchronous preparation remains private, but a poll must not cancel it.
    if(!pending.preview.policy&&this.generationPolicyPreparation?.pending===pending)return undefined;
    if(credentialRead)this.generationPreviewReading=true;
    // performance.now covers elapsed execution (including delayed callbacks).
    // Linux desktop uptime includes suspend; wall time is only an additional
    // conservative expiry fence, never authority to extend an elapsed deadline.
    try {
      const notificationVersion=this.notificationVersion;
      const monotonic = performance.now(), boot = os.uptime(), wall = Date.now();
      if (Number.isFinite(monotonic) && monotonic >= pending.monotonicStartedMs
        && monotonic - pending.monotonicStartedMs < EVIDENCE_PREVIEW_TTL_MS
        && Number.isFinite(boot) && boot >= pending.bootStartedSeconds
        && boot < pending.bootStartedSeconds+EVIDENCE_PREVIEW_TTL_MS/1000
        && Number.isFinite(wall) && wall < pending.preview.expiresUnixMs
        && (pending.policyContext===undefined || remainingOperationMs(pending.policyContext)>0)
        && this.profileCurrent(pending.preview,checkConfig)
        && (role!=='generation'||!!pending.credential)
        && (!pending.credential||(!checkConfig||this.evidencePreviewConfigurationCurrent(pending.preview))
          &&this.boundCredentialCurrent(pending.credential))
        && this.policyPreviewCurrent(role,pending)
        && (!pending.preview.policy||this.notificationVersion===notificationVersion)
        && (!pending.credential||this.boundCredentialCurrent(pending.credential))
        && this.prepared[role] === pending && !this.disposed) return pending;
    } catch { /* An unavailable clock cannot authorize disclosure. */ }
    finally { if(credentialRead)this.generationPreviewReading=false; }
    this.expirePreview(role,pending);
    return undefined;
  }
  isEvidencePreviewCurrent(role: EvidenceRole, sequence: number,viewOwner?:object): boolean {
    const pending=this.currentPreview(role);
    return !!pending && pending.preview.sequence===sequence
      && (!pending.credential||viewOwner===undefined||pending.credential.viewOwner===viewOwner)
      &&this.prepared[role]===pending&&!this.disposed;
  }
  private clearPreview(role: EvidenceRole,consume=false,shared=false): boolean {
    const pending=this.prepared[role];
    const hadPreview = !!pending;
    if (!consume && pending?.credential) this.generationCredential.revoke(pending.credential.owner);
    delete this.prepared[role];
    clearTimeout(this.previewTimers[role]);
    delete this.previewTimers[role];
    if(!consume&&pending){
      if(pending.policyContext)cancelActiveDeadline(pending.policyContext);
      const preparation=this.generationPolicyPreparation;
      if(preparation?.role===role&&preparation.pending===pending){
        if(preparation.context)cancelActiveDeadline(preparation.context);
        const owner=preparation.abort;
        this.enqueueRetirement({kind:shared?'evidence':'role',role,revision:pending.preview.revision,
          owner,attempted:false,run:()=>owner.abort()});
      }
    }
    return hadPreview;
  }
  private expirePreview(role: EvidenceRole, preview: PendingEvidencePreview): void {
    if (this.prepared[role] !== preview) return;
    this.clearPreview(role);
    const key = role === 'reranking' ? 'rerank' : 'generation';
    this.state = {...this.state,[key]:{phase:'error',error:'CANCELLED',hits:[]}};
    this.retireRoleAbort(role,undefined,false);
    this.notifyExpiry();
  }
  private evidencePreviewConfigurationCurrent(preview:RerankPreview):boolean {
    const port=this.port(preview.role);
    const scope=port?.scopeId(), pref=port?.config();
    const scopeAgain=port?.scopeId(), again=port?.config();
    const digest=configDigest(preview.role,preview.config);
    return scope===preview.scopeId && scopeAgain===scope && pref?.state==='configured' && again?.state==='configured'
      && configDigest(preview.role,pref)===digest && configDigest(preview.role,again)===digest;
  }
  /** This guard is intentionally synchronous: it is used while revoking a
   * preview and before notifying observers, so it must never dispatch work. */
  private policyPreviewCurrent(role:EvidenceRole,pending:PendingEvidencePreview):boolean {
    const binding=pending.preview.policy;
    // Policy preparation is private (and unobservable) until its binding is
    // installed. Historical attested previews have neither policy nor lease.
    if(!binding)return !(role==='generation'?this.selectedGenerationPolicy():this.selectedRerankPolicy());
    if(!pending.credential||binding.deadlineUnixMs!==pending.preview.expiresUnixMs
      ||binding.deadlineUnixMs!==pending.policyContext?.deadlineUnixMs)return false;
    try {
      // Re-read the selected port after the host check: a synchronous host
      // callback may revoke/reselect it, but it cannot authorize a stale port.
      if(role==='generation'){
        const port=this.selectedGenerationPolicy();
        const input=this.policyInput(pending.preview,pending.credential,binding.deadlineUnixMs,'generation');
        return !!port&&port===pending.policyPort&&binding.payloadDigest===input.payloadDigest&&binding.sourceDigest===generationPolicySourceDigest(input)
          &&binding.scopeBinding===input.scopeBinding&&port.current(input,binding)
          &&this.selectedGenerationPolicy()===port;
      }
      const port=this.selectedRerankPolicy();
      const input=this.policyInput(pending.preview,pending.credential,binding.deadlineUnixMs,'reranking');
      return !!port&&port===pending.policyPort&&binding.payloadDigest===input.payloadDigest&&binding.sourceDigest===generationPolicySourceDigest(input)
        &&binding.scopeBinding===input.scopeBinding&&port.current(input,binding)
        &&this.selectedRerankPolicy()===port;
    } catch { return false; }
  }
  private boundCredentialCurrent(binding:BoundGenerationCredential):boolean {
    return this.generationViewCurrent(binding.viewOwner)
      && this.generationCredential.current(binding.owner,binding.configuration,binding.stamp);
  }
  private policyInput<R extends EvidenceRole>(preview:RerankPreview, credential:BoundGenerationCredential, deadlineUnixMs:number,role:R):ProcessingPolicyInput<R> {
    const sources=preview.hits.map(hit=>Object.freeze({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,
      excerptDigest:hash(hit.originalExcerpt)}));
    if(preview.role!==role)throw new ProviderFailure('DISCLOSURE_DENIED');
    return Object.freeze({role,config:preview.config,scopeId:preview.scopeId,
      scopeBinding:hash(JSON.stringify([preview.revision,preview.sequence,preview.runtimeProfileBinding??null,preview.hits.map(hit=>[hit.indexGenerationId,hit.sourceId,hit.sourceSha256,hit.sourceLocators])])),
      scopeSources:uniquePolicySources(sources),ownerId:credential.stamp.hostId+':'+credential.stamp.epoch,hostId:credential.stamp.hostId,credentialEpoch:credential.stamp.epoch,
      deadlineUnixMs,payloadDigest:generationPolicyPayload(preview.query,preview.hits.map(hit=>({sourceId:hit.sourceId,
        sourceSha256:hit.sourceSha256,text:hit.originalExcerpt})),role),sources});
  }
  private async evaluatePolicy(preview:RerankPreview,context:CallContext,
    credential:BoundGenerationCredential,current:()=>boolean):Promise<GenerationPolicyBinding>{
    if(preview.role==='generation'){
      const port=this.selectedGenerationPolicy();if(!port)throw new ProviderFailure('DISCLOSURE_DENIED');
      return this.generationPolicyGate.evaluate(port,this.policyInput(preview,credential,context.deadlineUnixMs,'generation'),context,
        ()=>current()&&this.selectedGenerationPolicy()===port&&current());
    }
    const port=this.selectedRerankPolicy();if(!port)throw new ProviderFailure('DISCLOSURE_DENIED');
    return this.generationPolicyGate.evaluate(port,this.policyInput(preview,credential,context.deadlineUnixMs,'reranking'),context,
      ()=>current()&&this.selectedRerankPolicy()===port&&current());
  }
  private revokeGenerationTransition(role?:EvidenceRole):void {
    if(role&&this.generationTransitionRole!==role)return;
    const owner=this.generationTransition;this.generationTransition=undefined;this.generationTransitionView=undefined;this.generationTransitionRole=undefined;
    if(owner)this.generationCredential.revoke(owner);
  }
  private prepareEvidence(role: EvidenceRole,token?:string,viewOwner:object=this.defaultGenerationView,publish=true): RerankPreview {
    if(this.generationCredential.exclusiveBusy)throw new ProviderFailure('BUSY');
    if (this.sharedAuthorityTransition() || this.roleRetirement(role)) throw new ProviderFailure('NOT_READY');
    // Replacing consent is a single commit. In particular no observer can
    // prepare another preview between clearing the old timer and owning the new one.
    const transition=role==='generation'||token!==undefined?{}:undefined;
    const revision=this.revision;
    if(transition){this.generationTransition=transition;this.generationTransitionView=viewOwner;this.generationTransitionRole=role;}
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
        const configuration=configDigest(role,config);
        const nowScope=port?.scopeId(), now=port?.config();
        if (now?.state!=='configured' || configDigest(role,now)!==configuration || nowScope!==scopeId
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
        this.generationTransition=undefined;this.generationTransitionView=undefined;this.generationTransitionRole=undefined;
        if(this.prepared[role]?.credential?.owner!==transition)this.generationCredential.revoke(transition);
      }
      if (changed&&publish) this.emitEvidence();
    }
  }
  private revokeEvidence(): void {
    this.revokeGenerationTransition();
    for (const role of ['reranking','generation'] as const) {
      this.clearPreview(role,false,true);
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
    this.revokeGenerationTransition(role);if(active?.credential)this.generationCredential.revoke(active.credential.owner);
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
    if(this.selectedRerankPolicy()||this.prepared.reranking?.credential)return Promise.reject(new ProviderFailure('DISCLOSURE_DENIED'));
    return this.confirmEvidence('reranking',preview,classification,token);
  }
  rerankConfirmedWithPolicy(preview:RerankPreview,classification:'synthetic'|'public',viewOwner:object=this.defaultGenerationView):Promise<void>{
    if(this.generationAdmissionDepth||this.generationTransition||this.generationPreviewReading||this.generationPolicyPreparation||this.generationPolicyGate.busy||this.scopedRetrieval)
      return Promise.reject(new ProviderFailure('BUSY'));
    const pending=this.prepared.reranking;
    if(!pending?.preview.policy||!pending.credential||pending.credential.viewOwner!==viewOwner
      ||!this.generationViewCurrent(viewOwner)||preview.credentialStamp?.hostId!==pending.credential.stamp.hostId)
      return Promise.reject(new ProviderFailure('DISCLOSURE_DENIED'));
    this.generationAdmissionDepth++;
    try{return this.confirmEvidence('reranking',preview,classification);}
    finally{this.generationAdmissionDepth--;}
  }
  generationConfirmed(preview: RerankPreview, classification: 'synthetic' | 'public',viewOwner:object=this.defaultGenerationView): Promise<void> {
    if (this.scopedRetrieval || this.generationTransition || this.generationPreviewReading || this.generationPolicyPreparation || this.generationPolicyGate.busy) return Promise.reject(new ProviderFailure('BUSY'));
    const binding=this.prepared.generation?.credential;
    // Foreign host/view attempts do not consume another owner's pending consent.
    if (this.selectedGenerationPolicy() && !this.prepared.generation?.preview.policy) return Promise.reject(new ProviderFailure('DISCLOSURE_DENIED'));
    if (!this.generationViewCurrent(viewOwner) || !binding || binding.viewOwner!==viewOwner
      || preview?.credentialStamp?.hostId!==binding.stamp.hostId) return Promise.reject(new ProviderFailure('DISCLOSURE_DENIED'));
    this.generationAdmissionDepth++;
    try { return this.confirmEvidence('generation',preview,classification); }
    finally { this.generationAdmissionDepth--; }
  }
  private async confirmEvidence(role: EvidenceRole, preview: RerankPreview, classification: 'synthetic' | 'public', token?: string): Promise<void> {
    if(this.generationCredential.exclusiveBusy)throw new ProviderFailure('BUSY');
    if (this.sharedAuthorityTransition() || this.roleRetirement(role)) throw new ProviderFailure('DISCLOSURE_DENIED');
    const prior=this.prepared[role];
    const pending = this.currentPreview(role,false);
    if (!pending) throw new ProviderFailure(prior?.preview.policy&&prior.preview.sequence===preview?.sequence
      &&prior.preview.revision===preview?.revision?'CANCELLED':'DISCLOSURE_DENIED');
    const {preview:approved,credential}=pending;
    if(credential){this.generationTransition=credential.owner;this.generationTransitionView=credential.viewOwner;this.generationTransitionRole=role;}
    this.clearPreview(role,true);
    const retireCredential=():void=>{
      if(credential){
        if(this.generationTransition===credential.owner){this.generationTransition=undefined;this.generationTransitionView=undefined;this.generationTransitionRole=undefined;}
        this.generationCredential.revoke(credential.owner);
      }
    };
    try {
    const port = this.port(role);
    if (!port || this.activeEvidence[role] || !['synthetic','public'].includes(classification)
      || role === 'reranking' && classification !== 'synthetic'
      || JSON.stringify(approved) !== JSON.stringify(preview)) { retireCredential(); this.emitEvidence(); throw new ProviderFailure('DISCLOSURE_DENIED'); }
    const generationPolicy=role==='generation'?this.selectedGenerationPolicy():undefined;
    const rerankPolicy=role==='reranking'?this.selectedRerankPolicy():undefined;
    const policyPort=generationPolicy??rerankPolicy;
    if(!!approved.policy!==!!policyPort||approved.policy&&(!credential||policyPort!==pending.policyPort))throw new ProviderFailure('DISCLOSURE_DENIED');
    let operation:ActiveEvidenceOperation|undefined;
    const current = (): boolean => {
      const config = port.config();
      return !this.disposed && this.enabled && !this.paused && this.revision === approved.revision
        && this.profileCurrent(approved)
        && port.scopeId() === approved.scopeId && config.state === 'configured'
        && configDigest(role,config) === configDigest(role,approved.config)
        && this.engine?.status().generationId === this.state.response?.indexGenerationId
        && this.state.response?.indexGenerationId === approved.hits[0]?.indexGenerationId
        && (!credential || this.evidencePreviewConfigurationCurrent(approved)
          && this.boundCredentialCurrent(credential)
          && (operation ? this.activeEvidence[role]===operation : this.generationTransition===credential.owner))
        && (role==='generation'?this.selectedGenerationPolicy():this.selectedRerankPolicy())===policyPort
        && this.policyPreviewCurrent(role,pending)
        && (!credential||this.boundCredentialCurrent(credential)
          && (operation ? this.activeEvidence[role]===operation : this.generationTransition===credential.owner))
        && this.revision === approved.revision && !this.disposed && !this.sharedAuthorityTransition();
    };
    if (!current()) { retireCredential(); this.emitEvidence(); throw new ProviderFailure('CANCELLED'); }
    const admission = role === 'reranking' ? this.currentRerankAdmission(approved.config,approved.scopeId) : undefined;
    const abort = pending.policyAbort??new AbortController();
    const key = role === 'reranking' ? 'rerank' : 'generation';
    const context = pending.policyContext??bindActiveDeadline({signal:abort.signal,deadlineUnixMs:Date.now()+approved.config.limits.timeoutMs},approved.config.limits.timeoutMs);
    const {deadlineUnixMs} = context;
    if(credential && (this.generationTransition!==credential.owner || !current()))throw new ProviderFailure('CANCELLED');
    operation = {abort,context,revision:approved.revision,credential};
    this.activeEvidence[role] = operation;
    if(credential && this.generationTransition===credential.owner){this.generationTransition=undefined;this.generationTransitionView=undefined;this.generationTransitionRole=undefined;}
    this.state = {...this.state,[key]:{phase:'running',error:null,hits:[]}};
    try {
      this.emitEvidence();
      if(!current())throw new ProviderFailure('CANCELLED');
      const policyCheck=policyPort?()=>this.evaluatePolicy(approved,context,credential!,current):undefined;
      const capturedToken=credential?this.generationCredential.secret(credential.owner,credential.configuration,credential.stamp):token!;
      const noteClassification:Classification=approved.policy?'unknown':classification;
      const approval={
        config:approved.config,scopeId:approved.scopeId,query:{text:approved.query,classification},
        candidates:approved.hits.map(hit=>({hit,classification:noteClassification})),
        grant:{version:1 as const,role,configDigest:configDigest(role,approved.config),
          ...(admission?{runtimeProfileBinding:admission.bindingDigest}:{}),
          ...(approved.policy?{notePolicyBinding:approved.policy}:{}),
          scopeId:approved.scopeId,expiresUnixMs:deadlineUnixMs,queryDigest:hash(approved.query),
          queryClassification:classification,sources:approved.hits.map(hit=>({sourceId:hit.sourceId,
            sourceSha256:hit.sourceSha256,excerptDigest:hash(hit.originalExcerpt),classification:noteClassification}))},
      };
      const hits=role==='reranking'
        ?await this.reranker.run(approval,capturedToken,context,hit=>port.verify(hit),current,admission,policyCheck)
        :await this.generator.run(approval,capturedToken,context,hit=>port.verify(hit),current,policyCheck);
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
    try { this.invalidateState(true, false, retireHost, true); }
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
    this.revokeGraphOperation();
    this.revokeScopedRetrieval();
    this.engine = undefined;
    this.revision++;
    this.lastQuery = '';
    this.state = {phase:'idle',message:'Results cleared; search to verify current sources.',response:null};
    this.clearPreview('reranking',false,true); this.clearPreview('generation',false,true);
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
  async request(input: unknown): Promise<ApiResult<SearchStatus | SearchResponse | LocalGraphResult | string>> {
    try {
      if (!isRecord(input)) return failure('INVALID_REQUEST');
      if (input.apiVersion !== 1) return failure('API_VERSION_UNSUPPORTED');
      if (typeof input.operation !== 'string' || !['status','search','graph-search','diagnostics'].includes(input.operation)) return failure('INVALID_REQUEST');
      const allowed = input.operation === 'search' || input.operation === 'graph-search' ? ['apiVersion','operation','request'] : ['apiVersion','operation'];
      if (Object.keys(input).some(k => !allowed.includes(k))) return failure('INVALID_REQUEST');
      if (input.operation === 'search') return await this.controller.search(input.request);
      if (input.operation === 'graph-search') return await this.controller.graphSearch(input.request);
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
