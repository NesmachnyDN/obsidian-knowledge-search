import { BOUNDS, isDigest, validPath } from '../standalone/contracts';
import { BoundedVaultReader, type DescriptorLifecycleProof } from '../standalone/source';
import { DurableLifecycleLedger, InitialBaselinePublicationError, LiveTransitionPublicationError,
  type LiveTransitionDelta } from './lifecycle-ledger';
import type { LedgerAnchor, LedgerEntry } from './lifecycle-ledger-schema';

export type LifecycleState = 'existing'|'verified-new'|'unresolved';
export type LifecycleContext = Readonly<{
  rootId:string; scopeId:string; rulesRevision:string; host:object; session:object;
}>;
export type NativeLifecycleEvent = Readonly<{sequence:number; kind:'create'|'modify'|'rename'|'delete'|'uncertain'}>;
export type BaselineCandidate<T extends object> = Readonly<{owner:T;proof:DescriptorLifecycleProof}>;
export type BaselineInventory<T extends object> = Readonly<{complete:boolean;candidates:readonly BaselineCandidate<T>[]}>;
export type BaselinePreview<T extends object> = Readonly<{
  context:LifecycleContext; startedAt:number; expiresAt:number; candidates:readonly BaselineCandidate<T>[];
}>;
type Origin='native-create'|'baseline';
type Admitted<T extends object> = Readonly<{owner:T;state:Exclude<LifecycleState,'unresolved'>;proof:DescriptorLifecycleProof;
  origin:Origin;originVersionId:string}>;
type Entry<T extends object> = Admitted<T>|'deleted'|'ambiguous';
/**
 * Future host integration supplies these capabilities from its native event
 * authority. They are deliberately synchronous: an asynchronous lookup cannot
 * be treated as a stable native owner at the restore publication boundary.
 * This contract does not prove native-event authenticity or completeness.
 */
export type LifecycleRestoreHost<T extends object> = Readonly<{
  // One-shot host epoch signal: abort synchronously on ANY authority loss,
  // even a transient loss between asynchronous descriptor observations.
  signal:AbortSignal; current:()=>boolean; resolveNativeOwner:(sourceId:string)=>T|null;
}>;
export type LifecycleRestoreEvidence = Readonly<{baselineAdmitted:boolean;entries:readonly LedgerEntry[]}>;
/**
 * Native-only admission hooks.  They deliberately expose neither a grant nor
 * a classification decision: the tracker remains the sole lifecycle state
 * authority and the ledger remains durable evidence only.
 */
export type InitialBaselineAdmissionHost<T extends object> = Readonly<{
  signal:AbortSignal;
  current:()=>boolean;
  monotonicNow:()=>number;
  resolveNativeOwner:(sourceId:string)=>T|null;
}>;
/** Durable publication and live admission are intentionally separate facts. */
export type InitialBaselineAdmissionOutcome='admitted'|'denied'|'committed-not-live'|'uncertain-publication';
/**
 * One already-authenticated native event.  Paths and the pinned native object
 * are routing/fence inputs only: descriptor proofs and successor inventories
 * are always read from the canonical reader by the tracker.
 */
export type LiveTransitionAdmission<T extends object>=Readonly<{
  event:NativeLifecycleEvent; owner:T; sourceId:string; destinationId?:string; current:()=>boolean;
}>;
export type LiveTransitionAdmissionOutcome='admitted'|'denied'|'committed-not-live'|'uncertain-publication';

function objectIdentity(value:unknown):value is object {
  return typeof value==='object'&&value!==null;
}
function validContext(c:LifecycleContext):boolean {
  return !!c&&isDigest(c.rootId)&&isDigest(c.scopeId)&&isDigest(c.rulesRevision)
    &&objectIdentity(c.host)&&objectIdentity(c.session);
}
function sameContext(a:LifecycleContext,b:LifecycleContext):boolean {
  return a.rootId===b.rootId&&a.scopeId===b.scopeId&&a.rulesRevision===b.rulesRevision
    &&a.host===b.host&&a.session===b.session;
}
function validProof(p:DescriptorLifecycleProof,rootId:string):boolean {
  const v=p?.version;
  return !!v&&v.rootId===rootId&&validPath(v.sourceId)&&isDigest(v.sha256)
    &&isDigest(v.versionId)&&isDigest(p.stableIdentity);
}
function copyProof(p:DescriptorLifecycleProof):DescriptorLifecycleProof {
  return Object.freeze({version:Object.freeze({rootId:p.version.rootId,sourceId:p.version.sourceId,
    sha256:p.version.sha256,versionId:p.version.versionId}),stableIdentity:p.stableIdentity});
}
function sameProof(a:DescriptorLifecycleProof,b:DescriptorLifecycleProof):boolean {
  return a.version.rootId===b.version.rootId&&a.version.sourceId===b.version.sourceId
    &&a.version.sha256===b.version.sha256&&a.version.versionId===b.version.versionId
    &&a.stableIdentity===b.stableIdentity;
}
function sameLedgerEntry<T extends object>(entry:Entry<T>|undefined,record:LedgerEntry|undefined):boolean {
  if(entry===undefined||record===undefined)return false;
  if(entry==='deleted'||entry==='ambiguous')return entry===record.state&&!("proof" in record);
  return 'proof' in record&&entry.state===record.state&&entry.origin===record.origin
    &&entry.originVersionId===record.originVersionId&&sameProof(entry.proof,record.proof);
}
function admitted<T extends object>(entry:Entry<T>|undefined):entry is Admitted<T> {
  return !!entry&&typeof entry==='object';
}

/**
 * One host-owned tracker. The accepted ephemeral pilot API remains unchanged.
 * Native startup can restore committed evidence; live exact transitions and
 * policy-use admission remain separate gates.
 * Only an admitted native host adapter may supply context, complete inventories,
 * event sequence/owner and fresh canonical descriptor proofs; note content and
 * arbitrary callers are not evidence. Durable epoch initialization and native admission are still separate gates.
 */
export class NewMaterialTracker<T extends object> {
  private readonly entries=new Map<string,T|null>();
  private overflow=false;
  private readonly exact=new Map<string,Entry<T>>();
  private context?:LifecycleContext;
  private opened=false;
  private sealed=false;
  private eventSequence=0;
  private baselineDone=false;
  private pending?:BaselinePreview<T>;
  private lifecycleRevision=0;
  private restoreUsed=false;
  private restorePending=false;
  private admissionPending=false;
  private admissionSignalCleanup?:()=>void;
  private legacyTouched=false;
  private durableEpoch=false;
  private durableAnchor?:LedgerAnchor;
  private durableSignal?:AbortSignal;
  private noteLegacyMutation():boolean {
    this.legacyTouched=true;
    // The pilot path cannot supply exact-version transition evidence.
    if(this.restoreUsed||this.admissionPending||this.admissionSignalCleanup)this.sealLifecycle();
    return !this.durableEpoch;
  }
  created(path:string,owner:T):void {
    if(!this.noteLegacyMutation())return;
    if(this.overflow||!validPath(path))return;
    if(this.entries.size>=BOUNDS.sources&&!this.entries.has(path)){this.entries.clear();this.overflow=true;return;}
    // Duplicate create for an existing tracked path is ambiguous.
    if(this.entries.has(path)){this.entries.set(path,null);return;}
    this.entries.set(path,owner);
  }
  /** A modify/metadata event is not creation evidence. Preserve only exact live identity. */
  changed(path:string,owner:T):void {
    if(!this.noteLegacyMutation())return;
    if(this.overflow||!validPath(path))return;
    if(this.entries.has(path)&&this.entries.get(path)!==owner)this.entries.set(path,null);
  }
  /** Only an exact file-owner move can carry creation provenance to a new path. */
  renamed(oldPath:string,path:string,owner:T):void {
    if(!this.noteLegacyMutation())return;
    if(this.overflow)return;
    if(oldPath===path){this.changed(path,owner);return;}
    const known=validPath(oldPath)&&this.entries.get(oldPath)===owner;
    const collision=this.entries.has(path);
    this.invalidate(oldPath);
    if(!validPath(path))return;
    if(collision){this.entries.set(path,null);return;}
    if(known)this.entries.set(path,owner);
  }
  invalidate(path:string):void {
    if(!this.noteLegacyMutation())return;
    for(const key of this.entries.keys())if(key===path||key.startsWith(path+'/'))this.entries.delete(key);
  }
  state(path:string,owner:T):'verified-new'|'unresolved' {
    return !this.durableEpoch&&!this.overflow&&this.entries.get(path)===owner?'verified-new':'unresolved';
  }
  clear():void {this.entries.clear();this.overflow=false;this.lifecycleRevision++;this.sealLifecycle();}
  /** Retire the exact epoch without changing the historical read-only pilot preview. */
  retireExactLifecycle():void {this.lifecycleRevision++;this.sealLifecycle();}


  openLifecycle(context:LifecycleContext):boolean {
    if(this.opened||this.sealed||!validContext(context))return false;
    this.opened=true;
    this.context=Object.freeze({...context});
    return true;
  }
  durableAuthorityActive(context:LifecycleContext):boolean {
    return this.durableEpoch&&!!this.durableAnchor&&!!this.durableSignal&&!this.durableSignal.aborted
      &&!this.restorePending&&!this.admissionPending&&this.current(context);
  }
  private current(context:LifecycleContext):boolean {
    return !this.sealed&&!!this.context&&validContext(context)&&sameContext(this.context,context);
  }
  private sealLifecycle():void {
    this.sealed=true;this.exact.clear();this.pending=undefined;this.durableAnchor=undefined;this.durableSignal=undefined;
    this.admissionSignalCleanup?.();this.admissionSignalCleanup=undefined;
  }
  private event(context:LifecycleContext,event:NativeLifecycleEvent,kind:NativeLifecycleEvent['kind']):boolean {
    if(this.durableEpoch||this.restorePending||this.admissionPending){this.sealLifecycle();return false;}
    if(!this.current(context))return false;
    this.lifecycleRevision++;
    this.pending=undefined;
    if(!event||event.kind!==kind||!Number.isSafeInteger(event.sequence)||event.sequence!==this.eventSequence+1){
      this.sealLifecycle();return false;
    }
    this.eventSequence=event.sequence;
    return true;
  }
  private store(path:string,entry:Entry<T>):boolean {
    if(this.exact.size>=BOUNDS.sources&&!this.exact.has(path)){this.sealLifecycle();return false;}
    this.exact.set(path,entry);return true;
  }
  private setAdmitted(owner:T,state:Admitted<T>['state'],proof:DescriptorLifecycleProof,
      origin:Origin=state==='existing'?'baseline':'native-create',originVersionId=proof.version.versionId):boolean {
    return this.store(proof.version.sourceId,Object.freeze({owner,state,proof:copyProof(proof),origin,originVersionId}));
  }
  reviseRules(context:LifecycleContext,nextRevision:string):boolean {
    if(this.durableEpoch||this.restorePending||this.admissionPending){this.sealLifecycle();return false;}
    if(!this.current(context)||!isDigest(nextRevision))return false;
    this.lifecycleRevision++;
    this.pending=undefined;
    this.context=Object.freeze({...this.context!,rulesRevision:nextRevision});
    return true;
  }
  observeCreate(context:LifecycleContext,owner:T,event:NativeLifecycleEvent,proof:DescriptorLifecycleProof):LifecycleState {
    if(!this.event(context,event,'create'))return 'unresolved';
    if(!objectIdentity(owner)||!validProof(proof,context.rootId)){this.sealLifecycle();return 'unresolved';}
    const path=proof.version.sourceId,previous=this.exact.get(path);
    if((previous!==undefined&&previous!=='deleted')||this.entries.has(path)){
      this.store(path,'ambiguous');return 'unresolved';
    }
    return this.setAdmitted(owner,'verified-new',proof,'native-create',proof.version.versionId)?'verified-new':'unresolved';
  }
  advance(context:LifecycleContext,owner:T,event:NativeLifecycleEvent,prior:DescriptorLifecycleProof,
      next:DescriptorLifecycleProof):LifecycleState {
    const kind=event?.kind==='rename'?'rename':'modify';
    if(!this.event(context,event,kind))return 'unresolved';
    if(!objectIdentity(owner)||!validProof(prior,context.rootId)||!validProof(next,context.rootId)){
      this.sealLifecycle();return 'unresolved';
    }
    const from=prior.version.sourceId,to=next.version.sourceId,current=this.exact.get(from);
    const samePath=from===to;
    // Identity equality is required even for a same-byte replacement, not just
    // for changed content. A native event and exact admitted prior are separate.
    if(!admitted(current)||current.owner!==owner||!sameProof(current.proof,prior)
      ||prior.stableIdentity!==next.stableIdentity||samePath!==(kind==='modify')
      ||(!samePath&&(this.exact.has(to)||this.entries.has(to)))){
      this.store(from,'ambiguous');if(!samePath&&!this.sealed)this.store(to,'ambiguous');
      return 'unresolved';
    }
    if(!samePath)this.store(from,'deleted');
    return this.setAdmitted(owner,current.state,next,current.origin,current.originVersionId)?current.state:'unresolved';
  }
  retire(context:LifecycleContext,event:NativeLifecycleEvent,path:string,target:'file'|'folder'):boolean {
    const kind=event?.kind==='delete'?'delete':'uncertain';
    if(!this.event(context,event,kind))return false;
    // Folder moves, malformed paths and other unbounded ambiguities are not
    // proven transitions. Retire the entire epoch rather than guess ownership.
    if(target!=='file'||!validPath(path)||[...this.exact.keys()].some(key=>key.startsWith(path+'/'))){
      this.sealLifecycle();return false;
    }
    return this.store(path,kind==='delete'?'deleted':'ambiguous');
  }
  lifecycleState(context:LifecycleContext,owner:T,proof:DescriptorLifecycleProof):LifecycleState {
    if(this.restorePending||this.admissionPending||!this.current(context)||!validProof(proof,context.rootId))return 'unresolved';
    const current=this.exact.get(proof.version.sourceId);
    return admitted(current)&&current.owner===owner&&sameProof(current.proof,proof)?current.state:'unresolved';
  }
  private inventory(context:LifecycleContext,input:BaselineInventory<T>,allowEmpty=false):readonly BaselineCandidate<T>[]|null {
    if(!input||input.complete!==true||!Array.isArray(input.candidates)
      ||(!allowEmpty&&input.candidates.length===0)||input.candidates.length>BOUNDS.sources)return null;
    const paths=new Set<string>(),owners=new Set<T>(),out:BaselineCandidate<T>[]=[];
    for(const candidate of input.candidates){
      if(!candidate||!objectIdentity(candidate.owner)||!validProof(candidate.proof,context.rootId))return null;
      const path=candidate.proof.version.sourceId;
      if(paths.has(path)||owners.has(candidate.owner)||this.exact.has(path)||this.entries.has(path))return null;
      paths.add(path);owners.add(candidate.owner);
      out.push(Object.freeze({owner:candidate.owner,proof:copyProof(candidate.proof)}));
    }
    if(this.exact.size+out.length>BOUNDS.sources)return null;
    return Object.freeze(out.sort((a,b)=>a.proof.version.sourceId<b.proof.version.sourceId?-1:1));
  }
  /** Readiness is not a classification or permission; no startup initialization. */
  initialBaselineAvailable(context:LifecycleContext):boolean {
    return this.current(context)&&!this.restorePending&&!this.restoreUsed&&!this.admissionPending&&!this.pending
      &&!this.baselineDone&&this.lifecycleRevision===0&&this.eventSequence===0&&!this.legacyTouched
      &&!this.overflow&&this.entries.size===0&&this.exact.size===0;
  }
  previewDurableInitialBaseline(context:LifecycleContext,input:BaselineInventory<T>,now:number,ttlMs:number):BaselinePreview<T>|null {
    if(!this.initialBaselineAvailable(context)){this.sealLifecycle();return null;}
    return this.makeBaselinePreview(context,input,now,ttlMs,true);
  }
  previewInitialBaseline(context:LifecycleContext,input:BaselineInventory<T>,now:number,ttlMs:number):BaselinePreview<T>|null {
    return this.makeBaselinePreview(context,input,now,ttlMs,false);
  }
  private makeBaselinePreview(context:LifecycleContext,input:BaselineInventory<T>,now:number,ttlMs:number,allowEmpty:boolean):BaselinePreview<T>|null {
    if(this.admissionPending){this.sealLifecycle();return null;}
    if(this.durableEpoch||this.restorePending||!this.current(context)||this.baselineDone)return null;
    this.pending=undefined;
    if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(ttlMs)||ttlMs<=0||ttlMs>300000
      ||!Number.isSafeInteger(now+ttlMs))return null;
    const candidates=this.inventory(context,input,allowEmpty);
    if(!candidates)return null;
    const preview=Object.freeze({context:this.context!,startedAt:now,expiresAt:now+ttlMs,candidates});
    this.lifecycleRevision++;this.pending=preview;return preview;
  }
  confirmInitialBaseline(context:LifecycleContext,preview:BaselinePreview<T>,input:BaselineInventory<T>,now:number):boolean {
    if(this.admissionPending){this.sealLifecycle();return false;}
    // Capability identity is instance-local and cannot be replayed by copying
    // serialized data. Every matching confirmation consumes it, even denial.
    if(this.durableEpoch||!preview||preview!==this.pending)return false;
    this.pending=undefined;
    if(!this.current(context)||this.baselineDone||!sameContext(preview.context,context)
      ||!Number.isSafeInteger(now)||now<preview.startedAt||now>=preview.expiresAt)return false;
    const fresh=this.inventory(context,input);
    if(!fresh||fresh.length!==preview.candidates.length||!fresh.every((c,i)=>
      c.owner===preview.candidates[i]!.owner&&sameProof(c.proof,preview.candidates[i]!.proof)))return false;
    // All bounds and candidates verified before synchronous all-or-nothing admission.
    for(const c of fresh)this.exact.set(c.proof.version.sourceId,Object.freeze({owner:c.owner,state:'existing',proof:c.proof,
      origin:'baseline',originVersionId:c.proof.version.versionId}));
    this.baselineDone=true;return true;
  }

  /**
   * Consume a single local preview and publish its exact complete inventory to
   * the durable ledger.  No live `existing` state is installed until the
   * guarded ledger commit has returned and a second complete observation still
   * has the identical native owners and descriptor proofs.
   *
   * This is intentionally host-private substrate: it has no production caller
   * in this slice and does not create a processing grant.
   */
  async admitInitialBaseline(context:LifecycleContext,preview:BaselinePreview<T>,ledger:DurableLifecycleLedger,
      reader:BoundedVaultReader,host:InitialBaselineAdmissionHost<T>):Promise<InitialBaselineAdmissionOutcome> {
    if(this.admissionPending){this.sealLifecycle();return 'denied';}
    if(!preview||preview!==this.pending)return 'denied';
    this.pending=undefined;
    if(this.restorePending||!this.current(context)||this.baselineDone||this.exact.size!==0||this.eventSequence!==0
      ||this.lifecycleRevision!==1||this.legacyTouched||this.overflow||this.entries.size!==0
      ||!(ledger instanceof DurableLifecycleLedger)||!(reader instanceof BoundedVaultReader)||reader.rootId!==context.rootId
      ||!ledger.rootAvailable(context.rootId)||!host||!(host.signal instanceof AbortSignal)
      ||typeof host.current!=='function'||typeof host.monotonicNow!=='function'||typeof host.resolveNativeOwner!=='function'
      ||!sameContext(preview.context,context)) { this.sealLifecycle();return 'denied'; }
    // Reserve the operation before invoking any callback. The host signal is a
    // one-shot epoch fence, and remains bound to a successfully admitted epoch.
    this.admissionPending=true;
    const capturedContext=this.context!,revision=this.lifecycleRevision,sequence=this.eventSequence;
    const {signal,current:hostCurrent,monotonicNow,resolveNativeOwner}=host;
    const abort=()=>this.sealLifecycle();
    signal.addEventListener('abort',abort,{once:true});
    this.admissionSignalCleanup=()=>signal.removeEventListener('abort',abort);
    let lastNow=preview.startedAt;
    const intact=():boolean=>this.admissionPending&&!this.restorePending&&!signal.aborted
      &&this.current(capturedContext)&&this.lifecycleRevision===revision&&this.eventSequence===sequence
      &&!this.legacyTouched&&!this.overflow&&this.entries.size===0&&this.exact.size===0&&!this.baselineDone
      &&ledger.rootAvailable(capturedContext.rootId);
    const current=():boolean=>{
      if(!intact())return false;
      try{
        const now=monotonicNow();
        if(!Number.isFinite(now)||now<lastNow||now>=preview.expiresAt||!intact())return false;
        lastNow=now;
        return hostCurrent()===true&&intact();
      }catch{return false;}
    };
    const ownersCurrent=():boolean=>{
      if(!current())return false;
      for(const candidate of preview.candidates){
        if(!intact()||resolveNativeOwner(candidate.proof.version.sourceId)!==candidate.owner||!intact())return false;
      }
      return current();
    };
    const observe=async():Promise<boolean>=>{
      if(!current())return false;
      const inventory=await reader.completeMarkdownInventory(signal);
      if(!current()||inventory.rootId!==capturedContext.rootId||inventory.sources.length!==preview.candidates.length)return false;
      if(!inventory.sources.every((proof,index)=>sameProof(proof,preview.candidates[index]!.proof)))return false;
      return ownersCurrent();
    };
    const guard={signal,revalidate:observe,current:ownersCurrent};
    let publicationInFlight=false,durableCommitted=false;
    try {
      if(!await observe()||!current())return 'denied';
      let empty=await ledger.read();
      if(!current())return 'denied';
      if(empty===null){
        publicationInFlight=true;
        empty=await ledger.initializeEmptyEpochForInitialBaseline(guard);
        publicationInFlight=false;
      }
      if(!current()||empty.snapshot.rootId!==capturedContext.rootId||empty.snapshot.revision!==0
        ||empty.snapshot.baselineAdmitted||empty.snapshot.entries.length!==0)return 'denied';
      const entries=preview.candidates.map(candidate=>Object.freeze({sourceId:candidate.proof.version.sourceId,
        state:'existing' as const,origin:'baseline' as const,originVersionId:candidate.proof.version.versionId,
        proof:copyProof(candidate.proof)}));
      publicationInFlight=true;
      const committed=await ledger.commitInitialBaseline(empty.anchor.snapshotSha256,entries,guard);
      publicationInFlight=false;durableCommitted=true;
      // The commit result does not confer live authority. Re-observe all
      // originals and owners; fence the exact ledger anchor before publication.
      if(!await observe()||!ownersCurrent()||!ledger.committedAnchorCurrent(committed.anchor)||!intact())
        return 'committed-not-live';
      for(const candidate of preview.candidates)this.exact.set(candidate.proof.version.sourceId,Object.freeze({owner:candidate.owner,
        state:'existing',proof:candidate.proof,origin:'baseline',originVersionId:candidate.proof.version.versionId}));
      this.baselineDone=true;this.durableEpoch=true;this.durableAnchor=committed.anchor;this.durableSignal=signal;
      return 'admitted';
    }catch(error) {
      if(durableCommitted)return 'committed-not-live';
      if(error instanceof InitialBaselinePublicationError)return error.outcome;
      return publicationInFlight?'uncertain-publication':'denied';
    }finally{
      if(!this.baselineDone)this.sealLifecycle();
      this.admissionPending=false;
    }
  }

  /**
   * One explicit, host-serialized recovery attempt for a pristine opened
   * tracker. It never accepts caller-supplied snapshots or source proofs.
   * The host must synchronously abort its captured one-shot signal on every
   * authority loss, serialize ledger writes/close, and revalidate source proofs
   * again at every later policy-use boundary.
   */
  async restoreCommittedLifecycle(context:LifecycleContext,ledger:DurableLifecycleLedger,reader:BoundedVaultReader,
      host:LifecycleRestoreHost<T>):Promise<boolean> {
    if(this.admissionPending){this.sealLifecycle();return false;}
    if(this.restoreUsed||this.restorePending||!this.current(context))return false;
    this.restoreUsed=true;
    if(this.exact.size!==0||this.eventSequence!==0||this.lifecycleRevision!==0||this.pending
      ||this.baselineDone||this.legacyTouched||this.overflow||this.entries.size!==0
      ||!(ledger instanceof DurableLifecycleLedger)||!(reader instanceof BoundedVaultReader)
      ||reader.rootId!==context.rootId||!host||!(host.signal instanceof AbortSignal)
      ||typeof host.current!=='function'||typeof host.resolveNativeOwner!=='function'){
      this.sealLifecycle();return false;
    }
    this.restorePending=true;
    const capturedContext=this.context!,signal=host.signal;
    const intact=()=>this.restorePending&&this.current(capturedContext)&&this.lifecycleRevision===0
      &&!this.legacyTouched&&host.signal===signal&&!signal.aborted;
    const current=()=>intact()&&host.current()===true&&intact();
    let published=false;
    try {
      if(!current())return false;
      const loaded=await ledger.read();
      if(!loaded||loaded.snapshot.rootId!==capturedContext.rootId||!current())return false;
      const restored=new Map<string,Entry<T>>(),owners=new Map<T,string>();
      const bind=(owner:T,path:string):boolean=>{
        const prior=owners.get(owner);
        if(prior!==undefined&&prior!==path){
          restored.set(prior,'ambiguous');restored.set(path,'ambiguous');return false;
        }
        owners.set(owner,path);return true;
      };
      for(const record of loaded.snapshot.entries){
        if(!current())return false;
        if(!('proof' in record)){
          restored.set(record.sourceId,record.state);continue;
        }
        const path=record.sourceId,first=host.resolveNativeOwner(path);
        if(!objectIdentity(first)||!bind(first,path)){restored.set(path,'ambiguous');continue;}
        let observed:DescriptorLifecycleProof;
        try {observed=await reader.readLifecycleProof(path);}catch{restored.set(path,'ambiguous');continue;}
        if(!current())return false;
        const second=host.resolveNativeOwner(path);
        if(!objectIdentity(second)||!bind(second,path)||first!==second||!sameProof(record.proof,observed)){
          restored.set(path,'ambiguous');continue;
        }
        restored.set(path,Object.freeze({owner:first,state:record.state,proof:copyProof(record.proof),
          origin:record.origin,originVersionId:record.originVersionId}));
      }
      if(!current()||restored.size!==loaded.snapshot.entries.length)return false;
      // The backend verifies the current committed anchor on each read. The
      // trusted host serializes this whole operation with writes and close.
      const committed=await ledger.read();
      if(!committed||!sameLedgerAnchor(committed.anchor,loaded.anchor)||!current())return false;
      // All native owners are resolved again after the last await. Detect
      // late substitution and duplicate ownership, including denied records.
      for(const record of loaded.snapshot.entries){
        if(!('proof' in record))continue;
        if(!intact())return false;
        const path=record.sourceId,owner=host.resolveNativeOwner(path),entry=restored.get(path);
        if(!objectIdentity(owner)||!bind(owner,path)||!admitted(entry)||entry.owner!==owner)
          restored.set(path,'ambiguous');
      }
      if(!current())return false;
      // No callback/await between final fence and publication.
      for(const [path,entry] of restored)this.exact.set(path,entry);
      this.baselineDone=loaded.snapshot.baselineAdmitted;this.durableEpoch=true;
      this.durableAnchor=loaded.anchor;this.durableSignal=signal;
      const abort=()=>this.sealLifecycle();signal.addEventListener('abort',abort,{once:true});
      this.admissionSignalCleanup=()=>signal.removeEventListener('abort',abort);
      published=true;
      return true;
    }catch{return false;}finally{
      if(!published)this.sealLifecycle();
      this.restorePending=false;
    }
  }

  /**
   * Host-private, owner-serialized admission for one already-authenticated
   * native event. It never accepts caller proofs or a caller successor: both
   * the durable delta and full successor observation come from the tracker,
   * committed ledger and canonical reader.
   */
  async admitLiveTransition(context:LifecycleContext,ledger:DurableLifecycleLedger,reader:BoundedVaultReader,
      host:LifecycleRestoreHost<T>,input:LiveTransitionAdmission<T>):Promise<LiveTransitionAdmissionOutcome> {
    if(this.admissionPending){this.sealLifecycle();return 'denied';}
    const event=input?.event&&Object.freeze({...input.event});
    if(!this.durableEpoch||!this.durableAnchor||!this.durableSignal||this.restorePending||!this.current(context)||!this.baselineDone||this.pending||this.legacyTouched||this.overflow
      ||this.entries.size!==0||!(ledger instanceof DurableLifecycleLedger)||!(reader instanceof BoundedVaultReader)
      ||reader.rootId!==context.rootId||!ledger.rootAvailable(context.rootId)||!host||!(host.signal instanceof AbortSignal)
      ||host.signal!==this.durableSignal||typeof host.current!=='function'||typeof host.resolveNativeOwner!=='function'||!input||!objectIdentity(input.owner)
      ||typeof input.current!=='function'||!event||!Number.isSafeInteger(event.sequence)||event.sequence!==this.eventSequence+1
      ||!['create','modify','rename','delete'].includes(event.kind)||!validPath(input.sourceId)
      ||(event.kind==='rename'?(!validPath(input.destinationId??'')||input.destinationId===input.sourceId):input.destinationId!==undefined)) {
      this.sealLifecycle();return 'denied';
    }
    this.admissionPending=true;
    input=Object.freeze({event,owner:input.owner,sourceId:input.sourceId,destinationId:input.destinationId,current:input.current});
    host=Object.freeze({...host});
    const capturedContext=this.context!,revision=this.lifecycleRevision,sequence=this.eventSequence,signal=host.signal;
    const expectedAnchor=this.durableAnchor;
    const intact=()=>this.admissionPending&&!this.restorePending&&!signal.aborted&&this.current(capturedContext)
      &&this.lifecycleRevision===revision&&this.eventSequence===sequence&&!this.legacyTouched&&!this.overflow&&this.entries.size===0
      &&ledger.rootAvailable(capturedContext.rootId);
    const current=():boolean=>{
      if(!intact())return false;
      try{return host.current()===true&&intact()&&input.current()===true&&intact();}catch{return false;}
    };
    const expected=():boolean=>{
      for(const entry of this.exact.values()){
        if(!admitted(entry)&&entry==='ambiguous')return false;
      }
      return true;
    };
    const prior=():Admitted<T>|null=>{
      const value=this.exact.get(input.sourceId);return admitted(value)?value:null;
    };
    const ownerBindings=(records:ReadonlyMap<string,Entry<T>>):boolean=>{
      if(!current())return false;const seen=new Set<T>();
      for(const [path,entry] of records){
        if(!admitted(entry)){if(entry!=='deleted'||host.resolveNativeOwner(path)!==null||!current())return false;continue;}
        if(seen.has(entry.owner)||host.resolveNativeOwner(path)!==entry.owner||!current())return false;
        seen.add(entry.owner);
      }
      return current();
    };
    let durableCommitted=false;
    try {
      if(!expected()||!current())return 'denied';
      const loaded=await ledger.read();
      if(!loaded||!sameLedgerAnchor(loaded.anchor,expectedAnchor)||!loaded.snapshot.baselineAdmitted||loaded.snapshot.rootId!==capturedContext.rootId||!current()
        ||loaded.snapshot.entries.length!==this.exact.size
        ||!loaded.snapshot.entries.every(record=>sameLedgerEntry(this.exact.get(record.sourceId),record)))return 'denied';
      const old=prior();
      if(event.kind==='create'){
        if(old||this.exact.get(input.sourceId)==='ambiguous'||host.resolveNativeOwner(input.sourceId)!==input.owner||!current())return 'denied';
      }else if(!old||old.owner!==input.owner||!sameLedgerEntry(old,loaded.snapshot.entries.find(record=>record.sourceId===input.sourceId))){
        return 'denied';
      }
      const observe=async():Promise<{delta:LiveTransitionDelta;records:Map<string,Entry<T>>}|null>=>{
        if(!current())return null;
        const inventory=await reader.completeMarkdownInventory(signal);
        if(!current()||inventory.rootId!==capturedContext.rootId)return null;
        const proofs=new Map(inventory.sources.map(proof=>[proof.version.sourceId,proof]));
        const records=new Map(this.exact);
        let delta:LiveTransitionDelta;
        if(event.kind==='create'){
          const next=proofs.get(input.sourceId);
          if(!next||admitted(records.get(input.sourceId))||records.get(input.sourceId)==='ambiguous'
            ||host.resolveNativeOwner(input.sourceId)!==input.owner||!current())return null;
          const entry:LedgerEntry=Object.freeze({sourceId:input.sourceId,state:'verified-new',origin:'native-create',originVersionId:next.version.versionId,proof:copyProof(next)});
          records.set(input.sourceId,Object.freeze({owner:input.owner,state:'verified-new',proof:copyProof(next),origin:'native-create',originVersionId:next.version.versionId}));
          delta=Object.freeze({kind:'create',entry});
        }else if(event.kind==='delete'){
          if(proofs.has(input.sourceId)||!old)return null;
          records.set(input.sourceId,'deleted');delta=Object.freeze({kind:'delete',prior:copyProof(old.proof)});
        }else {
          const destination=event.kind==='rename'?input.destinationId!:input.sourceId,next=proofs.get(destination);
          if(!old||!next||next.stableIdentity!==old.proof.stableIdentity||next.version.versionId===old.proof.version.versionId
            ||(event.kind==='rename'&&records.get(destination)!==undefined))return null;
          if(event.kind==='modify'&&host.resolveNativeOwner(destination)!==input.owner)return null;
          if(event.kind==='rename'&&host.resolveNativeOwner(destination)!==input.owner)return null;
          if(event.kind==='rename')records.set(input.sourceId,'deleted');
          records.set(destination,Object.freeze({...old,proof:copyProof(next)}));
          delta=event.kind==='modify'
            ?Object.freeze({kind:'modify',prior:copyProof(old.proof),next:copyProof(next)})
            :Object.freeze({kind:'rename',prior:copyProof(old.proof),next:copyProof(next)});
        }
        const admittedRecords=new Map<string,Admitted<T>>();
        for(const [path,entry] of records)if(admitted(entry))admittedRecords.set(path,entry);
        if(proofs.size!==admittedRecords.size||!ownerBindings(records))return null;
        for(const [path,entry] of admittedRecords){const proof=proofs.get(path);if(!proof||!sameProof(entry.proof,proof))return null;}
        return current()?{delta,records}:null;
      };
      const first=await observe();if(!first||!current())return 'denied';
      const committed=await ledger.commitLiveTransition(loaded.anchor,first.delta,{signal,revalidate:async()=>{
        const checked=await observe();return !!checked&&sameLiveDelta(checked.delta,first.delta)&&current();
      },current:()=>ownerBindings(first.records)});
      durableCommitted=true;
      const final=await observe();
      if(!final||!sameLiveDelta(final.delta,first.delta)||!ownerBindings(final.records)
        ||!ledger.committedAnchorCurrent(committed.anchor)||!intact())return 'committed-not-live';
      // No callback or await after the final anchor and authority fence.
      this.exact.clear();for(const [path,entry] of final.records)this.exact.set(path,entry);
      this.eventSequence=event.sequence;this.lifecycleRevision++;this.durableAnchor=committed.anchor;
      return 'admitted';
    }catch(error){
      if(durableCommitted)return 'committed-not-live';
      if(error instanceof LiveTransitionPublicationError)return error.outcome;
      return 'denied';
    }finally{
      if(this.eventSequence!==event.sequence)this.sealLifecycle();
      this.admissionPending=false;
    }
  }
  /** Immutable bounded evidence for a future host-authorized ledger commit. */
  exportCommittedLifecycleEvidence(context:LifecycleContext):LifecycleRestoreEvidence|null {
    if(this.restorePending||this.admissionPending||!this.current(context))return null;
    const entries:LedgerEntry[]=[];
    for(const [sourceId,entry] of [...this.exact.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)){
      if(entry==='deleted'||entry==='ambiguous')entries.push(Object.freeze({sourceId,state:entry}));
      else entries.push(Object.freeze({sourceId,state:entry.state,origin:entry.origin,originVersionId:entry.originVersionId,
        proof:copyProof(entry.proof)}));
    }
    return Object.freeze({baselineAdmitted:this.baselineDone,entries:Object.freeze(entries)});
  }
}

function sameLiveDelta(a:LiveTransitionDelta,b:LiveTransitionDelta):boolean {
  if(a.kind!==b.kind)return false;
  if(a.kind==='create'&&b.kind==='create')return a.entry.sourceId===b.entry.sourceId&&'proof' in a.entry&&'proof' in b.entry
    &&sameProof(a.entry.proof,b.entry.proof);
  if(a.kind==='delete'&&b.kind==='delete')return sameProof(a.prior,b.prior);
  return a.kind!=='create'&&a.kind!=='delete'&&b.kind!=='create'&&b.kind!=='delete'
    &&sameProof(a.prior,b.prior)&&sameProof(a.next,b.next);
}

function sameLedgerAnchor(a:LedgerAnchor,b:LedgerAnchor):boolean {
  return a.schemaVersion===b.schemaVersion&&a.rootId===b.rootId&&a.epoch===b.epoch
    &&a.revision===b.revision&&a.snapshotSha256===b.snapshotSha256;
}
