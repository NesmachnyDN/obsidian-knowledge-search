import { DurableLifecycleLedger, LifecycleLedgerStateError } from './lifecycle-ledger';
import { NewMaterialTracker, type LifecycleContext, type BaselinePreview, type BaselineCandidate,
  type InitialBaselineAdmissionOutcome, type LiveTransitionAdmission,
  type LiveTransitionAdmissionOutcome } from './new-material-tracker';
import { BoundedVaultReader } from '../standalone/source';

type NativeLifecycleBinding<T extends object> = Readonly<{
  context: LifecycleContext;
  reader: BoundedVaultReader;
  rootPath: string;
  pluginId: string;
  priorDrain?: Promise<void>;
  current: () => boolean;
  resolveNativeOwner: (sourceId: string) => T | null;
}>;

export type NativeLifecycleReadiness='opening'|'fresh'|'uninitialized'|'restored'|'admitted'|'corrupted'|'ambiguous'|'unavailable'|'retired';
/** The local UI receives paths/count and an identity capability, never raw proofs. */
export type NativeBaselinePreview=Readonly<{paths:readonly string[];count:number;expiresAt:number}>;
export type NativeBaselinePreviewResult=Readonly<{ok:true;preview:NativeBaselinePreview}|{ok:false;reason:'busy'|'unavailable'|'inventory-rejected'|'owner-mismatch'|'retired'}>;
export type NativeBaselineConfirmation=Readonly<{outcome:InitialBaselineAdmissionOutcome;reason?:'stale'|'expired'|'retired'|'verification-failed'}>;
/** Local presentation can distinguish an explicit dismissal from a stale view. */
export type NativeBaselineCancellation=Readonly<{outcome:'cancelled'|'cancel-requested'}|{outcome:'denied';reason:'stale'|'retired'}>;
/** Host-private future native-event boundary; no production callback invokes it yet. */
export type NativeLiveTransition<T extends object>=LiveTransitionAdmission<T>;
export type NativeLiveTransitionResult=Readonly<{outcome:LiveTransitionAdmissionOutcome}>;
const monotonicNow=()=>Math.floor(performance.now());

/** A cancelled wait never starts a replacement ledger transaction. */
function awaitPrior(prior: Promise<void> | undefined, signal: AbortSignal): Promise<boolean> {
  if (!prior || signal.aborted) return Promise.resolve(!signal.aborted);
  return new Promise(resolve => {
    const finish = (ok: boolean) => { signal.removeEventListener('abort', abort); resolve(ok && !signal.aborted); };
    const abort = () => finish(false);
    signal.addEventListener('abort', abort, {once:true});
    void prior.then(() => finish(true), () => finish(false));
  });
}

/** One native owner, one exact epoch. Unproven events retire rather than advance it. */
export class NativeLifecycleOwner<T extends object> {
  private readonly controller = new AbortController();
  private ledger?: DurableLifecycleLedger;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private fence?: () => boolean;
  private retired = false;
  private state:NativeLifecycleReadiness='opening';
  private binding?:NativeLifecycleBinding<T>;
  private operation?:Promise<unknown>;
  private preview?:Readonly<{view:NativeBaselinePreview;proof:BaselinePreview<T>}>;
  private confirming?:NativeBaselinePreview;

  constructor(private readonly tracker: NewMaterialTracker<T>) {}

  /** Never initializes an empty epoch, grants access or performs a source write. */
  start(input: NativeLifecycleBinding<T>): Promise<void> {
    if (this.opening) return this.opening;
    if (this.retired || this.closing) return Promise.resolve();
    const binding = Object.freeze({...input,context:Object.freeze({...input.context})});
    this.binding=binding;
    const signal = this.controller.signal;
    const current = (): boolean => {
      if (this.retired || signal.aborted) return false;
      try { if (binding.current() === true && !this.retired && !signal.aborted) return true; }
      catch { /* a failed native lookup is loss of authority */ }
      this.retire();
      return false;
    };
    this.fence = current;
    // Reserve the one startup operation before invoking any host callback.
    this.opening = Promise.resolve().then(async () => {
      let published = false;
      let failure:NativeLifecycleReadiness='unavailable';
      try {
        if (!current() || !await awaitPrior(binding.priorDrain,signal) || !current()
          || binding.reader.rootId!==binding.context.rootId||!this.tracker.openLifecycle(binding.context)) return;
        this.ledger = await DurableLifecycleLedger.open({path:binding.rootPath,rootId:binding.reader.rootId},binding.pluginId);
        if (!current()) return;
        const loaded=await this.ledger.read();
        if(!current())return;
        if(loaded===null||(loaded.snapshot.revision===0&&!loaded.snapshot.baselineAdmitted&&loaded.snapshot.entries.length===0)){
          if(!this.tracker.initialBaselineAvailable(binding.context)||!current())return;
          this.state=loaded===null?'fresh':'uninitialized';published=true;return;
        }
        if (!await this.tracker.restoreCommittedLifecycle(binding.context,this.ledger,binding.reader,{
          signal,current,resolveNativeOwner:binding.resolveNativeOwner,
        }) || !current()) return;
        this.state='restored';published=true;
      } catch(error) {
        // Only proven invalid committed bytes/schema or orphan evidence gets a
        // typed diagnosis. Lock, unsafe ancestry and I/O errors are unavailable.
        if(error instanceof LifecycleLedgerStateError)failure=error.reason;
      }
      finally {
        if (!published) {
          if(this.retired)failure='retired';
          this.retire();this.state=failure;
          // Do not swallow ambiguous physical release: close/reload retains it.
          await this.ledger?.close();
          this.ledger = undefined;
        }
      }
    });
    return this.opening;
  }

  /** Seal exact evidence before AbortSignal listeners or downstream observers. */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.state='retired';this.preview=undefined;this.confirming=undefined;
    this.tracker.retireExactLifecycle();
    this.controller.abort();
  }

  /** Host readiness only, never per-source evidence or a processing grant. */
  exactAuthorityActive(): boolean {
    return !this.operation&&(this.state==='restored'||this.state==='admitted')&&this.fence?.()===true
      &&!this.operation&&!this.retired&&!!this.binding&&this.tracker.durableAuthorityActive(this.binding.context);
  }

  /** A ready empty store is not authority over a single original. */
  readiness():NativeLifecycleReadiness {
    if(this.state==='fresh'||this.state==='uninitialized'||this.state==='restored'||this.state==='admitted')this.fence?.();
    return this.state;
  }
  private readyForBaseline():boolean {
    return (this.state==='fresh'||this.state==='uninitialized')&&this.fence?.()===true;
  }
  private retireAndDrain():void {
    this.retire();void this.close().catch(()=>{/* retain the rejected close */});
  }
  /** Owner-private operation reservation before any potentially reentrant host lookup. */
  private async reserve<R>(action:()=>Promise<R>):Promise<R> {
    const operation=Promise.resolve().then(action);this.operation=operation;
    try{return await operation;}finally{if(this.operation===operation)this.operation=undefined;}
  }
  async prepareBaselinePreview(ttlMs=60_000):Promise<NativeBaselinePreviewResult> {
    if(this.operation||this.preview){this.retireAndDrain();return {ok:false,reason:'busy'};}
    if(this.state!=='fresh'&&this.state!=='uninitialized')return {ok:false,reason:this.retired?'retired':'unavailable'};
    const binding=this.binding!,signal=this.controller.signal;
    return this.reserve(async()=>{
      const fail=(reason:Extract<NativeBaselinePreviewResult,{ok:false}>['reason']):NativeBaselinePreviewResult=>{
        this.retireAndDrain();return {ok:false,reason};
      };
      try{
        if(!this.readyForBaseline()||!this.tracker.initialBaselineAvailable(binding.context))return fail('retired');
        const inventory=await binding.reader.completeMarkdownInventory(signal);
        if(!this.readyForBaseline()||inventory.rootId!==binding.context.rootId)return fail('retired');
        const candidates:BaselineCandidate<T>[]=[];const owners=new Set<T>();
        for(const proof of inventory.sources){
          const owner=binding.resolveNativeOwner(proof.version.sourceId);
          if(!owner||typeof owner!=='object'||owners.has(owner)||!this.readyForBaseline())return fail('owner-mismatch');
          owners.add(owner);candidates.push({owner,proof});
        }
        for(const candidate of candidates)if(binding.resolveNativeOwner(candidate.proof.version.sourceId)!==candidate.owner
          ||!this.readyForBaseline())return fail('owner-mismatch');
        const proof=this.tracker.previewDurableInitialBaseline(binding.context,{complete:true,candidates},monotonicNow(),ttlMs);
        if(!proof||!this.readyForBaseline())return fail('inventory-rejected');
        const view=Object.freeze({paths:Object.freeze(proof.candidates.map(c=>c.proof.version.sourceId)),count:proof.candidates.length,expiresAt:proof.expiresAt});
        this.preview=Object.freeze({view,proof});return {ok:true,preview:view};
      }catch{return fail(signal.aborted?'retired':'inventory-rejected');}
    });
  }
  /** Monotonic time is local to this owner/session; never serialize a token. */
  baselinePreviewRemainingMs(view:NativeBaselinePreview):number {
    if(this.preview?.view!==view||!this.readyForBaseline())return 0;
    return Math.max(0,view.expiresAt-monotonicNow());
  }
  async confirmBaselinePreview(view:NativeBaselinePreview):Promise<NativeBaselineConfirmation> {
    if(this.operation){this.retireAndDrain();return {outcome:'denied',reason:'stale'};}
    const pending=this.preview;
    if(!pending||pending.view!==view)return {outcome:'denied',reason:'stale'};
    this.preview=undefined;this.confirming=view;
    const binding=this.binding!,ledger=this.ledger!,signal=this.controller.signal;
    return this.reserve(async()=>{
      try{
        if(!this.readyForBaseline()){this.retireAndDrain();return {outcome:'denied',reason:'retired'};}
        if(monotonicNow()>=pending.proof.expiresAt){this.retireAndDrain();return {outcome:'denied',reason:'expired'};}
        const outcome=await this.tracker.admitInitialBaseline(binding.context,pending.proof,ledger,binding.reader,{
          signal,current:()=>this.readyForBaseline(),monotonicNow,resolveNativeOwner:binding.resolveNativeOwner,
        });
        if(outcome==='admitted'&&this.readyForBaseline()){
          this.state='admitted';return {outcome};
        }
        this.retireAndDrain();
        return {outcome:outcome==='admitted'?'committed-not-live':outcome,reason:'verification-failed'};
      }catch{this.retireAndDrain();return {outcome:'uncertain-publication',reason:'verification-failed'};}
      finally{this.confirming=undefined;}
    });
  }
  cancelBaselinePreviewOutcome(view:NativeBaselinePreview):NativeBaselineCancellation {
    if(this.preview?.view!==view&&this.confirming!==view)
      return {outcome:'denied',reason:this.retired?'retired':'stale'};
    const committing=this.confirming===view;
    this.retireAndDrain();return {outcome:committing?'cancel-requested':'cancelled'};
  }
  /** Compatibility predicate for host callers that only need cancellation ownership. */
  cancelBaselinePreview(view:NativeBaselinePreview):boolean {
    return this.cancelBaselinePreviewOutcome(view).outcome!=='denied';
  }

  /**
   * Admit one host-authenticated event through the canonical-reader/ledger
   * transaction. A failed or merely durable transaction permanently retires
   * this owner and drains its exclusive ledger lock; it never falls back to
   * the legacy tracker mutators.
   */
  async admitLiveTransition(input:NativeLiveTransition<T>):Promise<NativeLiveTransitionResult> {
    if(this.operation||this.preview||this.confirming){this.retireAndDrain();return {outcome:'denied'};}
    if(this.state!=='restored'&&this.state!=='admitted'){this.retireAndDrain();return {outcome:'denied'};}
    const binding=this.binding,ledger=this.ledger;
    if(!binding||!ledger){this.retireAndDrain();return {outcome:'denied'};}
    // Reserve before host callbacks, and enter the tracker's synchronous
    // suspension before returning to the native event observer.
    let complete!:(result:NativeLiveTransitionResult)=>void;
    const operation=new Promise<NativeLiveTransitionResult>(resolve=>{complete=resolve;});
    this.operation=operation;
    const run=async():Promise<NativeLiveTransitionResult>=>{
      let outcome:LiveTransitionAdmissionOutcome='denied';
      try{
        if(this.retired||this.controller.signal.aborted)return {outcome};
        outcome=await this.tracker.admitLiveTransition(binding.context,ledger,binding.reader,{
          signal:this.controller.signal,current:()=>this.fence?.()===true,
          resolveNativeOwner:binding.resolveNativeOwner,
        },input);
        if(outcome==='admitted'&&!this.retired&&!this.controller.signal.aborted)return {outcome};
        if(outcome==='admitted')outcome='committed-not-live';
        return {outcome};
      }catch{outcome='uncertain-publication';return {outcome};}
      finally{if(outcome!=='admitted')this.retireAndDrain();}
    };
    try{void run().then(complete,()=>{this.retireAndDrain();complete({outcome:'uncertain-publication'});});return await operation;}
    finally{if(this.operation===operation)this.operation=undefined;}
  }

  /** Concurrent callers share the same physical drain, including its failure. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      try { await this.opening; }
      finally {
        try{await this.operation;}
        finally{await this.ledger?.close();this.ledger=undefined;this.binding=undefined;}
      }
    });
    this.retire();
    return this.closing;
  }
}
