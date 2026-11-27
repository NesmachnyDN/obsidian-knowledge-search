import { setImmediate } from 'node:timers';
import {
  BOUNDS, PROTOCOL, StandaloneError, hash, generationId, makeGeneration, matches, validPath, validateRequest,
  type IndexGeneration, type SearchRequest, type SearchResponse, type EvidenceHit, type SourceVersion,
  type ParsedBlock,
} from './contracts';
import { terms } from './markdown';
import { containsLocator, verifyOriginalRange } from './selection-range';
import { freezeScope, parseScopeSelector, resolveScope, type ScopedSearch, type ScopeSnapshot } from './chat-scope';
import { metadataAnchor } from './metadata';
import { verifySpan } from '../search/navigation';
import type { MarkdownParser, PolicyMetadataParser } from './worker';
import { EligibilityEvaluator, type PolicyHost, type PolicyEnvelope } from '../ai/processing-policy';
import { ProviderFailure, type CallContext } from '../ai/contracts';
import { captureCallContext, deadlineFailure } from '../ai/active-deadline';
import type { PolicyMetadataProof } from './shared';
import { verifiedOriginalDigest, type SourceProvider } from './source';
import type { GenerationStore } from './storage';
import { liveRevocationSignal, type HardSearchScope, type RevocableHardSearchScope } from './hard-search-scope';
import { validateGraphMapping, type GraphMapping } from './graph-mapping';
import type { GraphProjection } from './graph-projection';
import { authenticateGraphCatalog, buildAuthenticatedGraph, scopeGraph, type GraphScopeLease,
  type ScopedGraphSnapshot } from './graph-lifecycle';
import { parseGraphQuery } from './graph-expansion';
import { graphDeadline, materializeGraph, verifyRetainedGraph, type GraphDeadline, type LocalGraphLease, type LocalGraphResult } from './graph-retrieval';

export type EngineState = {
  status: 'initializing' | 'ready' | 'degraded' | 'failed' | 'unavailable';
  generationId: string | null; sources: number; records: number;
  error: string | null; maintenanceWarning: string | null; busy: boolean;
};
/** Internal, host-selected evidence lease; not a public search response. */
export type SelectedCorpus = {
  rootId: string; lexicalGenerationId: string; evidence: readonly EvidenceHit[];
  current(): boolean; verify(hit: EvidenceHit): Promise<void>;
  metadataPaths(request: SearchRequest, lexicalGenerationId: string, selectedPaths: readonly string[]): readonly string[];
};
/** A host-local retrieval lease. It carries no generation/disclosure authority. */
export type ChatScopeLease = {
  snapshot: Readonly<ScopeSnapshot>;
  current():boolean;
  verify():Promise<void>;
  search(request:ScopedSearch):Promise<SearchResponse>;
};
// Query-driven bounded audit; no recurring timer or hidden background scanner.
// lstat-based hints detect normal misses immediately. Unchanged hints are never
// treated as a cryptographic guarantee: full source hashes are rechecked at most
// once per interval during active searches, and every EvidenceHit is rehashed.
const SOURCE_AUDIT_INTERVAL_MS = 30_000;
const yieldToHost = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

export class StandaloneEngine {
  private generation: IndexGeneration | null = null;
  private state: EngineState = { status: 'unavailable', generationId: null, sources: 0, records: 0,
    error: null, maintenanceWarning: null, busy: false };
  private work: Promise<void> | null = null;
  // One shared physical slot for parser-backed local policy/graph operations.
  private localRead: Promise<unknown> | null = null;
  // Callback-bearing policy operations also own logical publication until
  // their final callback and callback-free settlement fence have completed.
  private localSettlement: Promise<unknown> | null = null;
  private graphMapping: GraphMapping | null = null;
  private graphRevision = 0;
  private graphCache: GraphProjection | null = null;
  private pending = new Set<string>();
  private all = false;
  private revision = 0;
  private stopped = false;
  private paused = false;
  private publishing = false;
  private recoveryNeedsPublication = false;
  private maintenanceWarning: string | null = null;
  private initialized = false;
  private versionHints: string[] | null = null;
  private verifiedAt = 0;
  private readonly hardSearchScope: HardSearchScope|undefined;
  private scopeRetired = false;
  private readonly revocableScope:boolean;
  private readonly sourceRetirementSignal:AbortSignal|undefined;
  constructor(private readonly provider: SourceProvider, private readonly store: GenerationStore,
    private readonly parser: MarkdownParser,
    private readonly yieldJob: () => Promise<void> = yieldToHost,
    private readonly now: () => number = Date.now) {
    if (provider.rootId !== store.rootId) throw new StandaloneError('VAULT_IDENTITY_CHANGED');
    this.hardSearchScope = provider.hardSearchScope;
    this.revocableScope=!!this.hardSearchScope&&'current' in this.hardSearchScope;
    this.sourceRetirementSignal=this.revocableScope?(this.hardSearchScope as RevocableHardSearchScope).retirementSignal:undefined;
  }
  status(): EngineState { this.scopeCurrent(); return { ...this.state }; }
  /** The source owner is the only scope authority. Retirement is irreversible. */
  private retireScope():false {
    if (!this.scopeRetired) {
      this.scopeRetired = true;
      this.generation = null;
      this.versionHints = null;
      this.pending.clear(); this.all = false;
      this.recordState('unavailable', 'SEARCH_SCOPE_INVALID');
    }
    return false;
  }
  /** No host access: the existing native owner's irreversible event seal. */
  private scopeSealCurrent():boolean {
    if(this.scopeRetired)return false;
    return !this.revocableScope||liveRevocationSignal(this.sourceRetirementSignal)||this.retireScope();
  }
  /** Effectful observation also detects a missed native configuration event. */
  private scopeCurrent(): boolean {
    if(!this.scopeSealCurrent())return false;
    if(!this.revocableScope)return true;
    const scope=this.hardSearchScope as RevocableHardSearchScope;
    try{if(typeof scope.current==='function'&&scope.current()===true&&this.scopeSealCurrent())return true;}
    catch{/* malformed or unavailable host authority denies */}
    return this.retireScope();
  }
  private requireScope(): void {
    if (!this.scopeCurrent()) throw new StandaloneError('SEARCH_SCOPE_INVALID');
  }
  private retireGraph(): void {
    this.graphRevision++;
    this.graphCache = null;
  }
  private recordState(status: EngineState['status'], error: string | null): void {
    if (this.scopeRetired) { status = 'unavailable'; error = 'SEARCH_SCOPE_INVALID'; }
    if (status !== 'ready') this.retireGraph();
    this.state = {
      status, error, maintenanceWarning: this.maintenanceWarning,
      generationId: this.generation?.generationId ?? null,
      sources: this.generation?.documents.length ?? 0,
      records: this.generation?.documents.reduce((n, d) => n + d.blocks.filter(b => b.terms.length > 0).length, 0) ?? 0,
      busy: this.work !== null,
    };
  }
  /** Reuse the source owner's immutable predicate, including for recovered data. */
  private generationAllowed(generation: IndexGeneration): boolean {
    const scope = this.hardSearchScope;
    this.requireScope();
    const allowed = !scope || (!scope.hasExclusions && !('current' in scope))
      || generation.documents.every(doc => scope.allows(doc.sourceId));
    this.requireScope();
    return allowed;
  }
  async start(): Promise<void> {
    const live=this.scopeCurrent();
    if (this.stopped || this.initialized) throw new StandaloneError('LIFECYCLE_INVALID');
    if(!live)throw new StandaloneError('SEARCH_SCOPE_INVALID');
    this.initialized = true;
    this.recordState('initializing', null);
    try {
      const result = await this.store.load();
      this.requireScope();
      if (this.stopped) return;
      // An authenticated rollback may still be inadmissible in the current
      // scope. Never expose it or reuse its parsed documents while rebuilding.
      const excluded = result.generation !== null && !this.generationAllowed(result.generation);
      this.generation = excluded ? null : result.generation;
      this.recoveryNeedsPublication = result.recovered || excluded;
      this.recordState(excluded ? 'initializing' : !result.generation && result.error ? 'failed'
        : result.error || result.recovered ? 'degraded'
        : result.generation ? 'ready' : 'initializing', excluded ? 'SEARCH_SCOPE_RESTRICTED' : result.error);
      // Unknown, foreign or corrupt cache must not be silently overwritten at startup.
      if (!result.generation && result.error) return;
      this.reconcile();
    } catch (error) {
      this.requireScope();
      this.recordState('failed', code(error));
      throw error;
    }
  }
  // Event mutation immediately invalidates a pending publication. Search rehashes
  // the current source whether or not an Obsidian event has arrived.
  changed(path?: string): void {
    if (!this.scopeCurrent() || this.stopped) return;
    this.revision++;
    this.retireGraph();
    this.enqueueChange(path);
    this.schedule();
  }
  // Full reconciliation dominates the bounded exact-path set.
  private enqueueChange(path?: string): void {
    if (this.all) return;
    if (path && validPath(path)) {
      this.pending.add(path);
      if (this.pending.size <= BOUNDS.sources) return;
    }
    this.pending.clear();
    this.all = true; // overflow, folder rename, unknown or missed event
  }
  reconcile(): void {
    this.changed(); // authoritative full scan (startup and explicit reconciliation)
  }
  rebuild(): void {
    this.scopeCurrent();
    if (this.stopped) throw new StandaloneError('LIFECYCLE_INVALID');
    this.paused = false;
    this.reconcile();
  }
  // Returns false if publication has crossed the irreversible CURRENT-rename
  // boundary: pause later jobs, but never claim that committed work was canceled.
  cancel(): boolean {
    this.scopeCurrent();
    this.paused = true;
    this.retireGraph();
    this.pending.clear(); this.all = false;
    if (this.publishing) {
      this.recordState(this.generation ? 'degraded' : 'unavailable', 'CANCEL_DEFERRED');
      return false;
    }
    this.revision++;
    this.recordState(this.generation ? 'degraded' : 'unavailable', 'CANCELLED');
    return true;
  }
  resume(): void {
    this.scopeCurrent();
    if (this.stopped) throw new StandaloneError('LIFECYCLE_INVALID');
    this.paused = false;
    this.reconcile();
  }
  private schedule(): void {
    if (!this.scopeCurrent() || !this.initialized || this.stopped || this.paused || this.work || this.localRead || this.localSettlement) return;
    // Publish the reservation before run() can enter any source callback.
    this.work = Promise.resolve().then(()=>{
      if(!this.scopeCurrent()||this.stopped||this.paused)return;
      return this.run();
    }).catch(error => {
      if (this.scopeCurrent()) this.recordState(this.generation ? 'degraded' : 'failed', code(error));
    }).finally(() => {
      const live = this.scopeCurrent();
      this.work = null;
      this.state.busy = false;
      if (live && !this.stopped && !this.paused && (this.all || this.pending.size)) this.schedule();
    });
    this.state.busy = true;
  }
  async whenIdle(): Promise<void> {
    for (;;) {
      // Observe effectful authority and admit eligible queued work before
      // the idle decision. Neither a finally callback nor a scheduler may
      // run between the last inspection of reservations and returning idle.
      this.scopeCurrent();
      this.schedulePendingLocalWork();
      const pending=this.work??this.localRead??this.localSettlement;
      if(!pending)return;
      await pending.catch(()=>{});
    }
  }
  /** Callback-free admission predicate shared by parser-backed routes.
   * Observe all effectful inputs before the final test and reserve without
   * invoking a port between that test and the promise assignments. */
  private localAdmissionBusy():boolean {
    return this.stopped||!this.initialized||this.paused||!!(this.work||this.localRead||this.localSettlement);
  }
  /** A logical denial does not release an outstanding physical operation. */
  private releaseLocalRead(physical:Promise<unknown>):void {
    const live=this.scopeCurrent();
    if(this.localRead!==physical)return;
    this.localRead=null;
    if(live&&!this.stopped&&!this.paused&&(this.all||this.pending.size))this.schedule();
  }
  /** Separate physical drain from callback-bearing logical publication.
   * A callback may reenter synchronously or queue a revocation microtask.
   * Keep admission through that callback and publish directly from a later,
   * callback-free authority check (no adopted success/catch forwarding chain).
   * Revocation after the direct resolve is a consumer-side lease boundary. */
  private settleLocalPolicy<T>(physical:Promise<unknown>,outcome:Promise<T>,
    prepare:(value:T)=>void,observePublication:(value:T)=>void,confirm:(value:T)=>void,
    normalize:(error:unknown)=>unknown):Promise<T>{
    this.localRead=physical;
    const drain=()=>this.releaseLocalRead(physical);
    void physical.then(drain,drain);
    const logical=new Promise<T>((resolve,reject)=>{
      const finish=(settled:{value:T}|{error:unknown})=>{
        // A task boundary drains the callback's entire queued microtask
        // chain, not just its first microtask, before terminal publication.
        setImmediate(()=>{
          try{
            if('error' in settled)reject(normalize(settled.error));
            else{
              observePublication(settled.value);
              // Linearization cut: only local state, intrinsic signal reads,
              // and the already-bound budget are allowed after observation.
              confirm(settled.value);
              resolve(settled.value);
            }
          }catch(error){reject(normalize(error));}
          finally{
            if(this.localSettlement===logical)this.localSettlement=null;
            // Do not call another host port between the terminal fence and
            // publication. Schedule pending work only after direct settlement.
            queueMicrotask(()=>this.schedulePendingLocalWork());
          }
        });
      };
      void outcome.then(value=>{
        try{prepare(value);finish({value});}catch(error){finish({error});}
      },error=>finish({error}));
    });
    this.localSettlement=logical;
    return logical;
  }
  /** Observe the source owner on every exceptional exit, then classify
   * using the same lifecycle seals and terminal budget as success. A live
   * budget must not mask ordinary callback errors. No callback after the cut. */
  private localSettlementError(error:unknown,localLive:()=>boolean,
    terminal:()=>unknown,revoked:()=>Error):unknown{
    if(!this.scopeCurrent()||!localLive())return revoked();
    return terminal()??error;
  }
  private schedulePendingLocalWork():void{
    if(this.scopeCurrent()&&!this.stopped&&!this.paused&&(this.all||this.pending.size))this.schedule();
  }
  /** Local preview only. Share the existing worker and hold the physical slot
   * through late read/parser completion; a timeout never publishes a proof. */
  previewPolicyMetadata(path:string,current:()=>boolean,requireOriginalProof=false,authority?:AbortSignal):Promise<PolicyMetadataProof> {
    const parser=this.parser as MarkdownParser & Partial<PolicyMetadataParser>;
    if(!this.scopeCurrent())return Promise.reject(new StandaloneError('SEARCH_SCOPE_INVALID'));
    if(this.localAdmissionBusy()||!validPath(path))return Promise.reject(new StandaloneError('PARSER_BUSY'));
    const revision=this.revision;
    const localLive=()=>this.scopeSealCurrent()&&!this.stopped&&!this.paused&&this.revision===revision
      &&(authority===undefined||liveRevocationSignal(authority));
    let policyMetadata:PolicyMetadataParser['policyMetadata']|undefined,root:string;
    try{policyMetadata=parser.policyMetadata;root=this.provider.rootId;}
    catch{
      // Preview has not acquired its deadline or slots yet. Preserve the
      // ordinary admission error, but observe already-known lifecycle loss.
      return Promise.reject(this.localSettlementError(new StandaloneError('PARSER_BUSY'),localLive,
        ()=>undefined,()=>new StandaloneError(this.scopeSealCurrent()?'SOURCE_CHANGED':'SEARCH_SCOPE_INVALID')));
    }
    // A parser/source accessor may already have admitted another operation.
    // The following observation is the last effectful admission input.
    if(!this.scopeCurrent())return Promise.reject(new StandaloneError('SEARCH_SCOPE_INVALID'));
    if(this.localAdmissionBusy()||!policyMetadata)return Promise.reject(new StandaloneError('PARSER_BUSY'));
    if(this.revision!==revision)return Promise.reject(new StandaloneError('SOURCE_CHANGED'));
    // Callback-only legacy callers have no native scope. They cannot acquire
    // a revocable engine lease without an actual host retirement signal.
    if((this.revocableScope||authority!==undefined)&&(!liveRevocationSignal(authority)
      ||authority===this.sourceRetirementSignal))
      return Promise.reject(new StandaloneError('SOURCE_CHANGED'));
    let expired=false;
    const deadline=performance.now()+5000;
    const terminal=()=>expired||performance.now()>=deadline?new StandaloneError('PARSER_TIMEOUT'):undefined;
    const revoked=()=>new StandaloneError('SOURCE_CHANGED');
    const confirm=()=>{
      if(!localLive())throw revoked();
      const failure=terminal();if(failure)throw failure;
      if(!localLive())throw revoked();
    };
    const observe=()=>{
      if(!this.scopeCurrent())throw new StandaloneError('SOURCE_CHANGED');
    };
    const check=()=>{
      observe();confirm();
      try{
        const allowed=current();
        observe();confirm();
        if(!allowed)throw new StandaloneError('SOURCE_CHANGED');
      }catch(error){
        throw this.localSettlementError(error,localLive,terminal,revoked);
      }
    };
    const observePublication=()=>{
      // A token-backed operation has already finished all host policy
      // callbacks; observe native state for missed events before the cut.
      if(authority===undefined)check();
      else observe();
    };
    const read=async()=>{
      check();
      if(!requireOriginalProof){
        const bytes=await this.provider.read(path);check();
        return {bytes,digest:null};
      }
      if(!this.provider.readVerifiedOriginal)throw new StandaloneError('SOURCE_CHANGED');
      const observed=await this.provider.readVerifiedOriginal(path);check();
      return {bytes:observed.bytes,digest:verifiedOriginalDigest(observed,root,path)};
    };
    const physical=Promise.resolve().then(async()=>{
      check();const {bytes,digest}=await read();check();
      if(bytes.byteLength>BOUNDS.fileBytes)throw new StandaloneError('SOURCE_LIMIT');
      const sha=hash(bytes),proof=await Reflect.apply(policyMetadata,parser,[path,bytes,root]);check();
      const renewed=await read();check();
      if(proof.sourceId!==path||proof.sha256!==sha||proof.scopeId!==root||hash(renewed.bytes)!==sha||renewed.digest!==digest)
        throw new StandaloneError('SOURCE_CHANGED');
      check();return proof;
    });
    let timer!:ReturnType<typeof setTimeout>;
    const outcome=new Promise<PolicyMetadataProof>((resolve,reject)=>{
      timer=setTimeout(()=>{expired=true;reject(new StandaloneError(this.scopeCurrent()?'PARSER_TIMEOUT':'SOURCE_CHANGED'));},5000);
      void physical.then(resolve,reject);
    });
    const logical=this.settleLocalPolicy(physical,outcome,check,observePublication,confirm,
      error=>this.localSettlementError(error,localLive,terminal,revoked));
    const clear=()=>clearTimeout(timer);
    void logical.then(clear,clear);
    return logical;
  }
  /** One existing worker/source owner, shared with lexical indexing and dry-run. */
  evaluateProcessingPolicy(host:PolicyHost,context:CallContext):Promise<PolicyEnvelope>{
    const parser=this.parser as MarkdownParser & Partial<PolicyMetadataParser>;
    if(!this.scopeCurrent())return Promise.reject(new ProviderFailure('CANCELLED'));
    if(this.localAdmissionBusy())return Promise.reject(new ProviderFailure('BUSY'));
    const revision=this.revision;
    let authority:AbortSignal|undefined,operation:CallContext,requireOriginalProof:PolicyHost['requireOriginalProof'],
      marking:PolicyHost['marking'],policyMetadata:PolicyMetadataParser['policyMetadata']|undefined;
    // A throwing authority accessor has not supplied a seal. Do not retry
    // it; preserve ordinary configuration failure unless a known authority
    // or the incoming bound operation has already terminated.
    let authorityCaptured=false;
    const localLive=()=>this.scopeSealCurrent()&&!this.stopped&&!this.paused&&this.revision===revision
      &&(!authorityCaptured||(!this.revocableScope&&authority===undefined)
        ||authority!==this.sourceRetirementSignal&&liveRevocationSignal(authority));
    const revoked=()=>new ProviderFailure('CANCELLED');
    try{
      authority=host.authority;authorityCaptured=true;operation=captureCallContext(context);
      requireOriginalProof=host.requireOriginalProof;marking=host.marking;policyMetadata=parser.policyMetadata;
    }catch{
      // No evaluator or reservation exists yet. The incoming context is
      // already the canonical bound identity when a budget exists.
      return Promise.reject(this.localSettlementError(new ProviderFailure('CONFIG_INVALID'),localLive,
        ()=>deadlineFailure(context),revoked));
    }
    // All accessor-bearing inputs are captured before this final claim.
    // Reentrant admission wins the slot; never overwrite its reservations.
    if(!this.scopeCurrent())return Promise.reject(new ProviderFailure('CANCELLED'));
    if(this.localAdmissionBusy()||!policyMetadata)return Promise.reject(new ProviderFailure('BUSY'));
    if(this.revision!==revision)return Promise.reject(new ProviderFailure('CANCELLED'));
    const operationSignal=operation.signal;
    if((this.revocableScope||authority!==undefined)&&(!liveRevocationSignal(authority)
      ||authority===this.sourceRetirementSignal))
      return Promise.reject(new ProviderFailure('CANCELLED'));
    const live=()=>this.scopeCurrent()&&localLive();
    const callback=<T>(call:()=>T,denied:T):T=>{
      if(!live())return denied;
      let value:T;
      try{value=call();}
      catch(error){this.scopeCurrent();throw error;}
      // Observe after the callback, then decide using the local seals; do
      // not run another effectful native port in a return-value finally.
      return live()?value:denied;
    };
    const current=()=>callback(()=>host.current(),false);
    const evaluator=new EligibilityEvaluator(this.provider,{policyMetadata:(path,bytes,root)=>Reflect.apply(policyMetadata,parser,[path,bytes,root])},
      {snapshot:()=>callback(()=>host.snapshot(),null),current,...(requireOriginalProof?{requireOriginalProof:true as const}:{}),
        ...(marking?{marking:(proof,original)=>callback(()=>Reflect.apply(marking,host,[proof,original]),false)}:{})},
      ()=>{
        // Host revocation is independent of source retirement. Observe the
        // source even on host-denied paths; never process a returned proof
        // or assemble an envelope after the explicit host seal has retired.
        if(!this.scopeCurrent()||authority!==undefined&&!liveRevocationSignal(authority))
          throw new ProviderFailure('CANCELLED');
      });
    const result=Promise.resolve().then(()=>evaluator.evaluate(operation));
    const physical=result.then(()=>evaluator.drain(),()=>evaluator.drain());
    const outcome=result.then(envelope=>evaluator.physicallyPending?envelope:physical.then(()=>envelope));
    const confirm=(envelope:PolicyEnvelope)=>{
      // Denied envelopes also contain source identity and policy evidence.
      // Host/source retirement or a local lifecycle change fences them too.
      if(!localLive())throw new ProviderFailure('CANCELLED');
      // Keep already-terminal typed cancellation/timeout denials. Every
      // other bound outcome must still fit its original operation budget.
      if(envelope.reason!=='cancelled'&&envelope.reason!=='timeout'){
        evaluator.assertPublicationDeadline();
        if(!localLive()||!liveRevocationSignal(operationSignal))throw new ProviderFailure('CANCELLED');
      }
    };
    const observe=()=>{if(!this.scopeCurrent())throw new ProviderFailure('CANCELLED');};
    const observePublication=(envelope:PolicyEnvelope)=>{
      // Historical unscoped callers have only a point-in-time callback.
      // Revocable owners must supply an event seal instead.
      if(envelope.allowed&&authority===undefined&&!current())throw new ProviderFailure('CANCELLED');
      observe();
    };
    return this.settleLocalPolicy(physical,outcome,envelope=>{
      observe();confirm(envelope);
      if(envelope.allowed&&!current())throw new ProviderFailure('CANCELLED');
    },observePublication,confirm,error=>this.localSettlementError(error,localLive,
      ()=>evaluator.publicationDeadlineFailure(operation),revoked));
  }
  processingPolicyDrain():Promise<void>{
    const observe=()=>{this.scopeCurrent();};
    return Promise.allSettled([this.localRead,this.localSettlement]).then(observe,observe);
  }
  /** Explicit internal host configuration. Invalid or null input revokes the
   * prior graph; ordinary lexical search is unchanged. */
  configureGraph(input: unknown): void {
    this.scopeCurrent();
    if (this.stopped) throw new StandaloneError('LIFECYCLE_INVALID');
    this.retireGraph();
    this.graphMapping = null;
    if (input === null) return;
    const mapping = validateGraphMapping(input);
    if ('code' in mapping) throw new StandaloneError(mapping.code);
    this.graphMapping = mapping;
  }
  captureGraphScope(input: unknown, signal: AbortSignal): GraphScopeLease {
    return this.captureGraphOperation(input,signal,async snapshot=>snapshot);
  }
  private captureGraphOperation<T>(input:unknown,signal:AbortSignal,
    consume:(snapshot:ScopedGraphSnapshot,gen:IndexGeneration,mapping:GraphMapping,check:()=>void)=>Promise<T>,
    deadline?:GraphDeadline):Readonly<{current():boolean;read():Promise<T>}> {
    const scopeLive = this.scopeCurrent();
    const selector = parseScopeSelector(input);
    if (selector.mode==='selected' && selector.kind==='editor-selection')
      throw new StandaloneError('GRAPH_SCOPE_UNSUPPORTED');
    const gen = this.generation, mapping = this.graphMapping, revision = this.graphRevision;
    if (!mapping) throw new StandaloneError('GRAPH_DISABLED');
    if (!scopeLive || !gen || this.stopped || this.paused || this.state.status!=='ready'
      || this.work || this.all || this.pending.size || this.store.isPublicationUncertain())
      throw new StandaloneError('GRAPH_UNAVAILABLE');
    let retired = false;
    const current = (): boolean => {
      if (!this.scopeCurrent()) retired=true;
      if (!retired && (signal.aborted || this.stopped || this.paused || this.graphRevision!==revision
        || this.generation!==gen || this.graphMapping!==mapping || this.state.status!=='ready'
        || this.work || this.all || this.pending.size || this.store.isPublicationUncertain())) retired=true;
      return !retired;
    };
    const check = (): void => {
      // Observe owner retirement even if a deadline or a local lease has expired.
      if (!this.scopeCurrent()) throw new StandaloneError(signal.aborted?'GRAPH_CANCELLED':'GRAPH_SOURCE_STALE');
      deadline?.check();
      if (!current()) throw new StandaloneError(signal.aborted?'GRAPH_CANCELLED':'GRAPH_SOURCE_STALE');
    };
    check();
    const read = async (): Promise<T> => {
      check();
      if (this.localRead||this.localSettlement) throw new StandaloneError('GRAPH_BUSY');
      // check() may execute a host/store callback, including on its last
      // observation. Recheck local lifecycle after it and claim without a port.
      if (!this.scopeSealCurrent()||!liveRevocationSignal(signal)||this.stopped||this.paused
        ||this.graphRevision!==revision||this.generation!==gen||this.graphMapping!==mapping
        ||this.state.status!=='ready'||this.work||this.all||this.pending.size)
        throw new StandaloneError(liveRevocationSignal(signal)?'GRAPH_SOURCE_STALE':'GRAPH_CANCELLED');
      // Reserve synchronously before starting any asynchronous source read.
      const physical = Promise.resolve().then(async () => {
        try {
          check();
          const cached = this.graphCache;
          let graph: GraphProjection, hints:string[];
          if (cached) {
            hints=await authenticateGraphCatalog(gen,this.provider,this.parser,false,check,this.yieldJob);
            graph = cached;
          } else {
            ({graph,hints}=await buildAuthenticatedGraph(gen,mapping,this.provider,this.parser,()=>{check();return true;},check,this.yieldJob));
          }
          check();
          // Graph reuse must never trust a mutated in-memory parsed record.
          if (graph.lexicalGenerationId!==gen.generationId || generationId(gen.rootId,gen.documents)!==gen.generationId)
            throw new StandaloneError('GRAPH_INDEX_UNAUTHENTICATED');
          // A full guarded content audit is stronger than the ordinary periodic
          // audit trigger, but never reuse it across different filesystem hints,
          // generations or a pending lifecycle transition. Basic-only searches
          // retain the original query-driven 30-second audit behavior.
          if(this.versionHints===null||hints.length!==this.versionHints.length
            ||hints.some((hint,i)=>hint!==this.versionHints![i]))throw new StandaloneError('GRAPH_SOURCE_STALE');
          check();this.verifiedAt=this.now();
          const snapshot = scopeGraph(gen,mapping,graph,selector);
          check();
          const result=await consume(snapshot,gen,mapping,check);
          check(); this.graphCache = graph;
          return result;
        } catch (error) {
          const scopeLive=this.scopeCurrent();
          retired = true;
          if (!scopeLive) throw new StandaloneError(signal.aborted?'GRAPH_CANCELLED':'GRAPH_SOURCE_STALE');
          if (this.graphRevision===revision) {
            this.retireGraph();
            if (error instanceof StandaloneError && error.code==='GRAPH_SOURCE_STALE'
              && !signal.aborted && !this.stopped && !this.paused) this.reconcile();
          }
          throw error;
        }
      });
      this.localRead = physical;
      const release = () => this.releaseLocalRead(physical);
      void physical.then(release,release);
      try {
        const result = await (deadline?deadline.wait(physical):physical);
        check(); return result;
      } catch(error) {
        if (!this.scopeCurrent()) throw new StandaloneError(signal.aborted?'GRAPH_CANCELLED':'GRAPH_SOURCE_STALE');
        throw error;
      }
    };
    return Object.freeze({current,read});
  }
  /** Internal graph-only retrieval uses the same scope/generation/physical
   * authority as projection reads. No AI evidence or implicit mode fallback. */
  async retrieveLocalGraph(input:unknown,signal:AbortSignal):Promise<LocalGraphResult> {
    try {
      const lease=this.captureLocalGraph(input,signal);
      const result=await lease.read();
      if(!lease.current())throw new StandaloneError(signal.aborted?'GRAPH_CANCELLED':'GRAPH_SOURCE_STALE');
      return result;
    } catch(error) {
      if(!this.scopeCurrent())throw new StandaloneError(signal.aborted?'GRAPH_CANCELLED':'GRAPH_SOURCE_STALE');
      throw error;
    }
  }
  captureLocalGraph(input:unknown,signal:AbortSignal):LocalGraphLease {
    this.scopeCurrent();
    const query=parseGraphQuery(input), deadline=graphDeadline(signal);
    const lease=this.captureGraphOperation(query.scope,signal,async(snapshot,gen,mapping,check)=>{
      const properties=query.scope.mode==='selected'&&query.scope.kind==='properties'?query.scope:undefined;
      const lexical=await this.search({protocolVersion:PROTOCOL,requestId:query.requestId,query:query.query,
        requestedMode:'lexical',limit:query.limit,matchMode:query.matchMode,scope:snapshot.scope.sources.map(s=>s.sourceId),
        ...(properties?{predicates:properties.predicates,metadata:properties.metadata}:{})});
      check();
      if(lexical.status!=='ok'||lexical.executedMode!=='lexical'||lexical.indexGenerationId!==gen.generationId)
        throw new StandaloneError('GRAPH_SOURCE_STALE');
      const result=await materializeGraph(gen,snapshot,mapping,query,lexical.hits,this.provider,check);
      check();
      await authenticateGraphCatalog(gen,this.provider,this.parser,false,check,this.yieldJob);
      check();
      if(generationId(gen.rootId,gen.documents)!==gen.generationId)throw new StandaloneError('GRAPH_INDEX_UNAUTHENTICATED');
      return result;
    },deadline);
    let result:LocalGraphResult|undefined, started=false, retired=false;
    const current=()=>lease.current()&&!retired;
    const read=async():Promise<LocalGraphResult>=>{
      if(!current()||started)throw new StandaloneError('GRAPH_SOURCE_STALE');
      started=true;
      try {
        const value=await lease.read();
        if(!current())throw new StandaloneError('GRAPH_SOURCE_STALE');
        result=value;return value;
      }
      catch(error){retired=true;if(!this.scopeCurrent())throw new StandaloneError(signal.aborted?'GRAPH_CANCELLED':'GRAPH_SOURCE_STALE');throw error;}
    };
    const verify=async():Promise<void>=>{
      if(!current()||!result)throw new StandaloneError('GRAPH_SOURCE_STALE');
      const retained=result;
      try {
        const fresh=this.captureGraphOperation(query.scope,signal,async(snapshot,gen,_mapping,check)=>{
          check();if(!current())throw new StandaloneError('GRAPH_SOURCE_STALE');
          verifyRetainedGraph(gen,snapshot,retained);check();
        },graphDeadline(signal));
        await fresh.read();
        if(!current())throw new StandaloneError('GRAPH_SOURCE_STALE');
      }catch(error){retired=true;if(!this.scopeCurrent())throw new StandaloneError(signal.aborted?'GRAPH_CANCELLED':'GRAPH_SOURCE_STALE');throw error;}
    };
    return Object.freeze({current,read,verify});
  }
  private async run(): Promise<void> {
    const revision = this.revision;
    const full = this.all || !this.generation;
    this.all = false;
    const changes = new Set(this.pending);
    this.pending.clear();
    try {
      this.requireScope();
      const paths = await this.provider.list();
      this.requireScope();
      if (this.stopped || this.paused || revision !== this.revision) return;
      const beforeHints = await this.provider.versionHints(paths);
      this.requireScope();
      if (this.stopped || this.paused || revision !== this.revision) return;
      const live = new Set(paths);
      const prior = new Map((this.generation?.documents ?? []).map(doc => [doc.sourceId, doc]));
      for (const path of [...prior.keys()]) if (!live.has(path)) prior.delete(path);
      let blocks = [...prior.values()].reduce((count, doc) => count + doc.blocks.length, 0);
      const targets = full ? paths : paths.filter(path => changes.has(path) || !prior.has(path));
      for (const path of targets) {
        if (this.stopped || this.paused || revision !== this.revision) return;
        const previous = prior.get(path);
        this.requireScope();
        const bytes = await this.provider.read(path);
        this.requireScope();
        if (previous && hash(bytes) === previous.sha256) {
          await this.yieldJob();
          this.requireScope();
          continue; // Full audit reuses unchanged, already authenticated documents.
        }
        if (previous) blocks -= previous.blocks.length;
        const doc = await this.parser.parse(path, bytes, this.provider.rootId);
        this.requireScope();
        blocks += doc.blocks.length;
        if (blocks > BOUNDS.blocks) throw new StandaloneError('INDEX_LIMIT');
        prior.set(path, doc);
        await this.yieldJob(); // bounded per-source cooperative scheduling
        this.requireScope();
      }
      if (this.stopped || this.paused || revision !== this.revision) return;
      // Recheck all participating source versions before publication; missed file
      // events cannot introduce a known-inconsistent generation.
      for (const [path, doc] of prior) {
        this.requireScope();
        const bytes = await this.provider.read(path);
        this.requireScope();
        if (hash(bytes) !== doc.sha256) throw new StandaloneError('SOURCE_CHANGED');
        if (this.stopped || this.paused || revision !== this.revision) return;
        await this.yieldJob();
        this.requireScope();
        if (this.stopped || this.paused || revision !== this.revision) return;
      }
      this.requireScope();
      const currentPaths = await this.provider.list();
      this.requireScope();
      if (paths.length !== currentPaths.length || paths.some((p, i) => p !== currentPaths[i]))
        throw new StandaloneError('SOURCE_CHANGED');
      const afterHints = await this.provider.versionHints(currentPaths);
      this.requireScope();
      if (beforeHints.some((hint, i) => hint !== afterHints[i]))
        throw new StandaloneError('SOURCE_CHANGED');
      if (this.stopped || this.paused || revision !== this.revision) return;
      const next = makeGeneration(this.provider.rootId, [...prior.values()]);
      if (!this.generationAllowed(next)) throw new StandaloneError('SEARCH_SCOPE_RESTRICTED');
      // Repair a corrupt CURRENT recovered from PREVIOUS even when the source
      // content is unchanged, without risking deletion of the fallback snapshot.
      const publish = this.recoveryNeedsPublication || next.generationId !== this.generation?.generationId;
      if (publish) {
        try {
          const outcome = await this.store.commit(next, () => {
            // Use the store's authenticated pre-rename cancellation/cleanup path.
            if (!this.scopeCurrent()) throw new StandaloneError('CANCELLED');
            if (this.stopped || this.paused || revision !== this.revision)
              throw new StandaloneError('CANCELLED');
            // The rename is about to start. A later cancel is deferred.
            this.publishing = true;
          }, published => {
            // No await between successful rename and memory publication.
            // Failure or delay of the following fsync/GC cannot strand old state.
            if (!this.scopeCurrent()) return;
            this.generation = published;
            this.recoveryNeedsPublication = false;
            this.recordState('degraded', 'COMMIT_FINALIZING');
          });
          this.requireScope();
          this.generation = outcome.generation;
          this.maintenanceWarning = outcome.maintenanceWarning;
        } finally {
          this.publishing = false;
        }
      }
      if (this.stopped) return;
      this.versionHints = afterHints;
      this.verifiedAt = this.now();
      if (this.paused) {
        this.recordState('degraded', 'CANCEL_DEFERRED');
      } else if (revision !== this.revision) {
        this.recordState('degraded', 'RECONCILING');
      } else if (this.maintenanceWarning) {
        this.recordState('degraded', this.maintenanceWarning);
      } else {
        this.recordState('ready', null);
      }
    } catch (error) {
      // An unknowable CURRENT must never expose an old in-memory generation as
      // searchable. Stop writes until a fresh authenticated store is opened.
      if (!this.scopeCurrent()) return;
      if (code(error) === 'INDEX_PUBLICATION_UNCERTAIN') {
        this.generation = null;
        this.versionHints = null;
        this.paused = true;
      }
      this.recordState(this.generation ? 'degraded' : 'failed', code(error));
    } finally {
      // A newer event retires this candidate, not its consumed dirty obligations.
      // Merge them into the same bounded queue before the physical slot drains.
      // Do not reschedule an unchanged failed revision, paused/cancelled work,
      // or uncertain publication; explicit resume already requests a full scan.
      if (this.scopeCurrent() && !this.stopped && !this.paused && revision !== this.revision) {
        if (full) this.enqueueChange();
        else for (const path of changes) {
          this.enqueueChange(path);
          if (this.all) break;
        }
      }
    }
  }
  /** Complete explicit selection, independent of search query and Top-K. */
  async captureDenseCorpus(paths: readonly string[], limit: number, signal: AbortSignal): Promise<SelectedCorpus> {
    this.scopeCurrent();
    if (!Array.isArray(paths) || !paths.length || paths.length > BOUNDS.sources
      || paths.some(path => !validPath(path)) || new Set(paths).size !== paths.length
      || !Number.isSafeInteger(limit) || limit < 1 || limit > BOUNDS.blocks)
      throw new StandaloneError('INVALID_REQUEST');
    const selected = new Set(paths);
    const gen = this.generation, revision = this.revision;
    const current = (): boolean => this.scopeCurrent() && !signal.aborted && !this.stopped && !this.paused
      && this.revision === revision && this.generation === gen && gen !== null
      && this.state.status === 'ready' && !this.work && !this.store.isPublicationUncertain();
    const check = (): void => {
      if (!current()) throw new StandaloneError(signal.aborted ? 'CANCELLED' : 'SOURCE_STALE');
    };
    check();
    const evidence: EvidenceHit[] = [];
    const docs = gen!.documents.filter(doc => selected.has(doc.sourceId));
    if (docs.length !== selected.size) throw new StandaloneError('INVALID_REQUEST');
    for (const doc of docs) {
      if (doc.extractionStatus !== 'ok') throw new StandaloneError('EVIDENCE_INCOMPLETE');
      const before = evidence.length;
      for (const block of doc.blocks) {
        if (block.kind === 'property' || block.kind === 'blank' || !block.originalText.trim()) continue;
        if (evidence.length >= limit) throw new StandaloneError('INDEX_LIMIT');
        // The internal EvidenceHit carrier uses enumeration ordinals, not query ranks.
        // A consumer must use the retrieval envelope for actual ranking.
        const rank = evidence.length + 1;
        evidence.push({sourceId:doc.sourceId,sourceSha256:doc.sha256,originalExcerpt:block.originalText,
          sourceLocators:[block.locator],rank,lexicalRank:rank,retrievalMode:'lexical',
          indexGenerationId:gen!.generationId,score:0,headings:block.headings,
          wikiLinks:block.wikiLinks,properties:doc.properties});
      }
      if (evidence.length === before) throw new StandaloneError('EVIDENCE_INCOMPLETE');
    }
    try {
      const live = await this.provider.list(); check();
      if (live.length !== gen!.documents.length || live.some((path,i) => path !== gen!.documents[i]?.sourceId))
        throw new StandaloneError('SOURCE_STALE');
      for (const doc of docs) {
        const bytes = await this.provider.read(doc.sourceId); check();
        for (const hit of evidence) if (hit.sourceId === doc.sourceId) verifySpan(hit,bytes);
      }
    } catch (error) {
      if (!this.scopeCurrent()) check();
      throw error;
    }
    const verify = async (hit: EvidenceHit): Promise<void> => {
      check();
      if (!selected.has(hit.sourceId) || hit.indexGenerationId !== gen!.generationId)
        throw new StandaloneError('EVIDENCE_INCOMPLETE');
      try {
        const bytes = await this.provider.read(hit.sourceId); check();
        verifySpan(hit,bytes); check();
      } catch (error) {
        if (!this.scopeCurrent()) check();
        throw error;
      }
    };
    const metadataPaths = (request: SearchRequest, lexicalGenerationId: string, selectedPaths: readonly string[]): readonly string[] => {
      check();
      validateRequest(request);
      if (!request.metadata || lexicalGenerationId !== gen!.generationId
        || !Array.isArray(selectedPaths) || selectedPaths.length !== selected.size
        || new Set(selectedPaths).size !== selected.size || selectedPaths.some(path => !selected.has(path)))
        throw new StandaloneError('INVALID_REQUEST');
      // Use the authoritative parsed document, including frontmatter and fence
      // semantics; the selected body evidence alone cannot establish eligibility.
      const paths = docs.filter(doc => metadataAnchor(doc, request.metadata, []))
        .map(doc => doc.sourceId);
      check();
      return paths;
    };
    check();
    return {rootId:gen!.rootId,lexicalGenerationId:gen!.generationId,
      evidence:structuredClone(evidence),current,verify,metadataPaths};
  }
  /** Capture explicit membership on the same authenticated lexical generation. */
  async captureChatScope(input:unknown,signal:AbortSignal):Promise<ChatScopeLease> {
    this.scopeCurrent();
    const selector=parseScopeSelector(input);
    const gen=this.generation, revision=this.revision;
    let retired=false, searching=false, verifying=false;
    const current=():boolean=>{
      if(!this.scopeCurrent())retired=true;
      if(!retired&&(signal.aborted||this.stopped||this.paused||this.revision!==revision
        ||gen===null||this.generation!==gen||this.state.status!=='ready'||this.work||this.store.isPublicationUncertain()))retired=true;
      return !retired;
    };
    const check=():void=>{if(!current())throw new StandaloneError(signal.aborted?'CANCELLED':'SCOPE_CHANGED');};
    const retire=(reason:string):never=>{retired=true;throw new StandaloneError(reason);};
    check();
    const {sources,coverage}=resolveScope(selector,gen!.documents);
    const snapshot=freezeScope({selector,rootId:gen!.rootId,generationId:gen!.generationId,sources,coverage});
    const range=selector.mode==='selected'&&selector.kind==='editor-selection'?selector.range:undefined;
    const properties=selector.mode==='selected'&&selector.kind==='properties'?selector:undefined;
    // A previously excluded source can enter a bulk selector after an edit.
    // Authenticate the complete bounded decision universe, not only returned IDs.
    const decisionDocs=selector.mode==='vault-wide'||properties?gen!.documents
      :selector.kind==='folder'?gen!.documents.filter(doc=>doc.sourceId.startsWith(selector.path+'/')):sources.map(source=>({sourceId:source.sourceId,sha256:source.sourceSha256}));
    const membership=async():Promise<void>=>{
      check();
      const live=await this.provider.list();check();
      if(live.length!==gen!.documents.length||live.some((path,i)=>path!==gen!.documents[i]?.sourceId))
        retire('SCOPE_CHANGED');
    };
    const versions=new Map(sources.map(source=>[source.sourceId,source.sourceSha256]));
    const verify=async(hits:readonly EvidenceHit[]=[]):Promise<void>=>{
      try{
        await membership();check();
        for(const doc of decisionDocs){
          check();
          const bytes=await this.provider.read(doc.sourceId);check();
          if(hash(bytes)!==doc.sha256)retire('SCOPE_CHANGED');
          if(range)verifyOriginalRange(range,bytes);
          for(const hit of hits)if(hit.sourceId===doc.sourceId)verifySpan(hit,bytes);
        }
        await membership();check();
      }catch(error){
        const scopeLive=this.scopeCurrent();
        if(signal.aborted)retire('CANCELLED');
        if(!scopeLive)retire('SCOPE_CHANGED');
        if(error instanceof StandaloneError&&error.code==='INVALID_REQUEST')retire('SCOPE_INVALID');
        retire('SCOPE_CHANGED');
      }
    };
    const search=async(input:ScopedSearch):Promise<SearchResponse>=>{
      check();
      if(searching||verifying)throw new StandaloneError('BUSY');
      // Copy only the query parameters; the lease itself supplies every scope field.
      if(!input||typeof input.query!=='string'||!input.query.trim()
        ||Object.keys(input).some(k=>!['requestId','query','limit','matchMode'].includes(k)))
        throw new StandaloneError('SCOPE_INVALID');
      const request:SearchRequest={protocolVersion:PROTOCOL,requestId:input.requestId,query:input.query,
        requestedMode:'lexical',limit:input.limit,matchMode:input.matchMode,scope:sources.map(s=>s.sourceId),
        ...(range?{range}:{}),...(properties?{predicates:properties.predicates,metadata:properties.metadata}:{})};
      validateRequest(request);
      searching=true;
      try{
        await verify();check();
        const response=await this.search(request);check();
        if(response.status!=='ok'||response.executedMode!=='lexical'||response.indexGenerationId!==snapshot.generationId
          ||response.hits.some(hit=>!versions.has(hit.sourceId)||versions.get(hit.sourceId)!==hit.sourceSha256
            ||(range&&(hit.sourceLocators.length!==1||!containsLocator(range,hit.sourceLocators[0]!)))))
          retire('SCOPE_CHANGED');
        await verify(response.hits);check();
        return structuredClone(response);
      }catch(error){
        if(!this.scopeCurrent())retire(signal.aborted?'CANCELLED':'SCOPE_CHANGED');
        throw error;
      }finally{searching=false;}
    };
    try{await verify();check();}catch(error){
      if(!this.scopeCurrent())retire(signal.aborted?'CANCELLED':'SCOPE_CHANGED');
      throw error;
    }
    return {snapshot,current,search,verify:async()=>{
      check();
      if(searching||verifying)throw new StandaloneError('BUSY');
      verifying=true;
      try{await verify();check();}catch(error){
        if(!this.scopeCurrent())retire(signal.aborted?'CANCELLED':'SCOPE_CHANGED');
        throw error;
      }finally{verifying=false;}
    }};
  }
  async search(input: unknown): Promise<SearchResponse> {
    this.scopeCurrent();
    validateRequest(input);
    const req: SearchRequest = input.range ? structuredClone(input) : input;
    const range = req.range;
    const rangeRevision = this.revision;
    const gen = this.generation; // Pin ALL response fields to this immutable snapshot.
    const response = (status: SearchResponse['status'], error: string | null,
      hits: EvidenceHit[], stale: number, snapshot: IndexGeneration | null = gen): SearchResponse => ({
      protocolVersion: PROTOCOL, requestId: req.requestId, requestedMode: req.requestedMode,
      executedMode: status === 'failed' ? 'none' : 'lexical', status, error,
      indexGenerationId: snapshot?.generationId ?? null, hits,
      capabilityReadiness: { lexical: !snapshot ? 'unavailable'
        : status === 'ok' ? 'ready' : status === 'failed' ? 'failed' : 'degraded', dense: 'unavailable' },
      staleSourceCount: stale,
    });
    // Snapshot pinning is valid for an ordinary A->B publication, but an
    // unauthenticated CURRENT or unload irrevocably revokes ALL in-flight hits.
    // Recheck after asynchronous reads and immediately before returning evidence.
    const visibilityFailure = (): string | null => !this.scopeCurrent() ? 'SEARCH_SCOPE_INVALID' : this.stopped ? 'LIFECYCLE_INVALID'
      : this.store.isPublicationUncertain() ? 'INDEX_PUBLICATION_UNCERTAIN'
      : this.generation === null ? this.state.error ?? 'INDEX_UNAVAILABLE' : null;
    const denied = (reason: string): SearchResponse => response('failed', reason, [], 0, null);
    if (!this.scopeCurrent()) return denied('SEARCH_SCOPE_INVALID');
    if (this.stopped) return denied('LIFECYCLE_INVALID');
    if (req.requestedMode !== 'lexical') return response('failed', 'CAPABILITY_UNAVAILABLE', [], 0);
    if (!gen) return denied(this.state.error ?? 'INDEX_UNAVAILABLE');
    try {
      // Events alone are insufficient. Every search validates the bounded path
      // list AND cheap filesystem version hints, including when there are no
      // lexical candidates. Only a drift/aged audit invokes full content reads.
      const paths = await this.provider.list();
      this.requireScope();
      const hints = await this.provider.versionHints(paths);
      this.requireScope();
      const drift = this.versionHints === null || paths.length !== gen.documents.length
        || paths.some((path, i) => path !== gen.documents[i]?.sourceId)
        || hints.length !== this.versionHints.length
        || hints.some((hint, i) => hint !== this.versionHints![i]);
      const age = this.now() - this.verifiedAt;
      const due = age < 0 || age >= SOURCE_AUDIT_INTERVAL_MS;
      if ((drift || due) && !this.stopped && !this.paused && !this.work) this.reconcile();
      if (range) {
        const selected = gen.documents.find(doc => doc.sourceId === range.sourceId);
        if (!selected || selected.sha256 !== range.sourceSha256 || !paths.includes(range.sourceId))
          throw new StandaloneError('SOURCE_STALE');
        this.requireScope();
        const bytes = await this.provider.read(range.sourceId);
        this.requireScope();
        verifyOriginalRange(range, bytes);
        if (this.revision !== rangeRevision || this.generation !== gen) throw new StandaloneError('SOURCE_STALE');
      }
      // Protocol-v2 default is unchanged ranked terms. The explicit literal mode
      // checks original physical source lines, not query tokens or heading context.
      const metadataOnly = req.query === '';
      const literal = req.matchMode === 'literal';
      const needle = literal ? req.query.toLowerCase() : '';
      const tokens = literal || metadataOnly ? [] : [...new Set(terms(req.query))];
      if (tokens.length > BOUNDS.termsPerQuery) throw new StandaloneError('QUERY_INVALID');
      const mandatoryIds = literal || metadataOnly ? [] : req.query.toLowerCase().match(/[\p{L}\p{N}]+(?:[._/-][\p{L}\p{N}]+)+/gu) ?? [];
      const scope = req.scope ? new Set(req.scope) : null;
      const predicates = req.predicates ?? [];
      const candidates: { doc: SourceVersion; block: ParsedBlock; score: number }[] = [];
      for (const doc of gen.documents) {
        if ((scope && !scope.has(doc.sourceId)) || !matches(doc.properties, predicates)) continue;
        if (range && doc.sourceId !== range.sourceId) continue;
        if (doc.extractionStatus !== 'ok' && doc.extractionStatus !== 'partial') continue;
        const metadataEvidence = req.metadata || metadataOnly
          ? metadataAnchor(doc, req.metadata, predicates) : null;
        if ((req.metadata || metadataOnly) && !metadataEvidence) continue;
        if (metadataOnly) {
          // Empty text is never a wildcard: cite exactly one authentic source
          // line bearing the matched property, tag or authored wiki-link.
          candidates.push({ doc, block: metadataEvidence!, score: 1 });
          continue;
        }
        for (const block of doc.blocks) {
          if (range && !containsLocator(range,block.locator)) continue;
          let score: number;
          if (literal) {
            // Properties are typed metadata, not searchable body lines. Preserve
            // exact punctuation, phrase order, Cyrillic and Unicode characters.
            if (block.kind === 'property' || block.kind === 'blank') continue;
            const text = block.originalText.toLowerCase();
            const start = text.indexOf(needle);
            if (start < 0) continue;
            let occurrences = 0;
            for (let offset = start; offset >= 0 && occurrences < 16;
              offset = text.indexOf(needle, offset + needle.length)) occurrences++;
            score = 5 + occurrences;
          } else {
            // Canonical ordinary search includes heading terms; selected-range ranking
            // must not use headings outside the selection or inject any context.
            const rankedTerms = range && block.terms.length ? terms(block.originalText) : block.terms;
            if (!rankedTerms.length || mandatoryIds.some(id => !rankedTerms.includes(id))) continue;
            const matched = tokens.filter(term => rankedTerms.includes(term));
            if (!matched.length) continue;
            // Complete compound identifier gets stronger weight than individual parts.
            score = matched.reduce((sum, term) =>
              sum + (term.includes('-') || term.includes('/') || term.includes('.') ? 8 : 2), 0)
              + matched.length / tokens.length;
          }
          candidates.push({ doc, block, score });
          if (candidates.length > BOUNDS.blocks) throw new StandaloneError('INDEX_LIMIT');
        }
      }
      candidates.sort((a, b) => b.score - a.score
        || (a.doc.sourceId < b.doc.sourceId ? -1 : a.doc.sourceId > b.doc.sourceId ? 1 : 0)
        || a.block.order - b.block.order);
      const freshness = new Map<string, Uint8Array | null>();
      let stale = 0;
      const hits: EvidenceHit[] = [];
      // Filters, source rehash and full locator validation run before Top-K.
      // Rechecking bytes prevents stale evidence even for missed filesystem events.
      for (const row of candidates) {
        let bytes = freshness.get(row.doc.sourceId);
        if (bytes === undefined) {
          this.requireScope();
          try {
            const candidate = await this.provider.read(row.doc.sourceId);
            this.requireScope();
            bytes = hash(candidate) === row.doc.sha256 ? candidate : null;
          } catch { bytes = null; }
          this.requireScope();
          freshness.set(row.doc.sourceId, bytes);
          if (!bytes) stale++;
        }
        if (!bytes) continue;
        const loc = row.block.locator;
        const excerptBytes = bytes.subarray(loc.byteStart, loc.byteEnd);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const original = new TextDecoder('utf-8', { fatal: true }).decode(excerptBytes);
        const prefix = text.slice(0, Buffer.from(bytes).subarray(0, loc.byteStart).toString('utf8').length);
        const line = prefix.split(/\r\n|\r|\n/).length;
        if (original !== row.block.originalText || line !== loc.lineStart
          || [...prefix].length !== loc.charStart
          || [...original].length !== loc.charEnd - loc.charStart || loc.lineEnd !== loc.lineStart) {
          throw new StandaloneError('EVIDENCE_INCOMPLETE');
        }
        const hit: EvidenceHit = {
          sourceId: row.doc.sourceId, sourceSha256: row.doc.sha256, originalExcerpt: original,
          sourceLocators: [{...loc}], rank: hits.length + 1, lexicalRank: hits.length + 1,
          retrievalMode: 'lexical', indexGenerationId: gen.generationId, score: row.score,
          headings: range ? [] : [...row.block.headings], wikiLinks: [...row.block.wikiLinks],
          properties: range ? [] : structuredClone(row.doc.properties),
        };
        if (range) {
          if (hit.sourceId !== range.sourceId || !containsLocator(range,loc)) throw new StandaloneError('EVIDENCE_INCOMPLETE');
          verifySpan(hit,bytes);
        }
        hits.push(hit);
        if (hits.length >= req.limit) break;
      }
      if (range) {
        // Even a zero-hit answer must authenticate the selected source before publication.
        this.requireScope();
        const currentPaths=await this.provider.list();
        this.requireScope();
        const bytes=await this.provider.read(range.sourceId);
        this.requireScope();
        verifyOriginalRange(range,bytes);
        if (!currentPaths.includes(range.sourceId) || stale || this.revision !== rangeRevision || this.generation !== gen)
          throw new StandaloneError('SOURCE_STALE');
      }
      // A missed event never defeats live hash suppression; queue reconciliation for recovery.
      if (stale && !this.stopped && !this.paused && !this.work) this.reconcile();
      const revoked = visibilityFailure();
      if (revoked) return denied(revoked);
      const switched = this.generation !== gen;
      const degraded = drift || due || switched || this.state.status !== 'ready'
        || this.work !== null || stale > 0;
      return response(degraded ? 'degraded' : 'ok',
        degraded ? (drift || due || switched ? 'RECONCILING'
          : this.state.error ?? (stale ? 'SOURCE_STALE' : 'RECONCILING')) : null,
        hits, stale);
    } catch (error) {
      if (!this.stopped && !this.paused && !this.work) this.reconcile();
      const revoked = visibilityFailure();
      return revoked ? denied(revoked) : response('failed', code(error), [], 0);
    }
  }
  async close(): Promise<void> {
    this.scopeCurrent();
    this.stopped = true;
    this.retireGraph();
    this.revision++;
    this.pending.clear(); this.all = false;
    try {
      await this.parser.close(); // Interrupt CPU-bound parse immediately on unload.
      this.scopeCurrent();
      if (this.work) await this.work;
      this.scopeCurrent();
      if(this.localRead)await this.localRead.catch(()=>{});
      if(this.localSettlement)await this.localSettlement.catch(()=>{});
      this.scopeCurrent();
      this.recordState('unavailable', 'LIFECYCLE_INVALID');
    } finally { this.scopeCurrent(); }
  }
}
function code(error: unknown): string {
  return error instanceof StandaloneError ? error.code : 'IO_FAILURE';
}
