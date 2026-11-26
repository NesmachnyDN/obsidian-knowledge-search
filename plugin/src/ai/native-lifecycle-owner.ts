import { DurableLifecycleLedger, LifecycleLedgerStateError } from './lifecycle-ledger';
import { NewMaterialTracker, type LifecycleContext, type BaselinePreview, type BaselineCandidate,
  type InitialBaselineAdmissionOutcome } from './new-material-tracker';
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
  exactAuthorityActive(): boolean { return (this.state==='restored'||this.state==='admitted')&&this.fence?.()===true; }

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
  cancelBaselinePreview(view:NativeBaselinePreview):boolean {
    if(this.preview?.view!==view&&this.confirming!==view)return false;
    this.retireAndDrain();return true;
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
