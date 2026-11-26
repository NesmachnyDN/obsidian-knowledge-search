import { BOUNDS, isDigest, validPath } from '../standalone/contracts';
import { BoundedVaultReader, type DescriptorLifecycleProof } from '../standalone/source';
import { DurableLifecycleLedger } from './lifecycle-ledger';
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
  current:()=>boolean; resolveNativeOwner:(sourceId:string)=>T|null;
}>;
export type LifecycleRestoreEvidence = Readonly<{baselineAdmitted:boolean;entries:readonly LedgerEntry[]}>;

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
function admitted<T extends object>(entry:Entry<T>|undefined):entry is Admitted<T> {
  return !!entry&&typeof entry==='object';
}

/**
 * One host-owned tracker. The accepted ephemeral pilot API remains unchanged.
 * Exact-version and durable restoration primitives are not yet wired to production.
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
  private legacyTouched=false;
  private noteLegacyMutation():void {
    this.legacyTouched=true;
    // The pilot path cannot supply exact-version transition evidence.
    if(this.restoreUsed)this.sealLifecycle();
  }
  created(path:string,owner:T):void {
    this.noteLegacyMutation();
    if(this.overflow||!validPath(path))return;
    if(this.entries.size>=BOUNDS.sources&&!this.entries.has(path)){this.entries.clear();this.overflow=true;return;}
    // Duplicate create for an existing tracked path is ambiguous.
    if(this.entries.has(path)){this.entries.set(path,null);return;}
    this.entries.set(path,owner);
  }
  /** A modify/metadata event is not creation evidence. Preserve only exact live identity. */
  changed(path:string,owner:T):void {
    this.noteLegacyMutation();
    if(this.overflow||!validPath(path))return;
    if(this.entries.has(path)&&this.entries.get(path)!==owner)this.entries.set(path,null);
  }
  /** Only an exact file-owner move can carry creation provenance to a new path. */
  renamed(oldPath:string,path:string,owner:T):void {
    this.noteLegacyMutation();
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
    this.noteLegacyMutation();
    for(const key of this.entries.keys())if(key===path||key.startsWith(path+'/'))this.entries.delete(key);
  }
  state(path:string,owner:T):'verified-new'|'unresolved' {
    return !this.overflow&&this.entries.get(path)===owner?'verified-new':'unresolved';
  }
  clear():void {this.entries.clear();this.overflow=false;this.lifecycleRevision++;this.sealLifecycle();}


  openLifecycle(context:LifecycleContext):boolean {
    if(this.opened||this.sealed||!validContext(context))return false;
    this.opened=true;
    this.context=Object.freeze({...context});
    return true;
  }
  private current(context:LifecycleContext):boolean {
    return !this.sealed&&!!this.context&&validContext(context)&&sameContext(this.context,context);
  }
  private sealLifecycle():void {
    this.sealed=true;this.exact.clear();this.pending=undefined;
  }
  private event(context:LifecycleContext,event:NativeLifecycleEvent,kind:NativeLifecycleEvent['kind']):boolean {
    if(this.restorePending){this.sealLifecycle();return false;}
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
    if(this.restorePending){this.sealLifecycle();return false;}
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
    if(this.restorePending||!this.current(context)||!validProof(proof,context.rootId))return 'unresolved';
    const current=this.exact.get(proof.version.sourceId);
    return admitted(current)&&current.owner===owner&&sameProof(current.proof,proof)?current.state:'unresolved';
  }
  private inventory(context:LifecycleContext,input:BaselineInventory<T>):readonly BaselineCandidate<T>[]|null {
    if(!input||input.complete!==true||!Array.isArray(input.candidates)
      ||input.candidates.length===0||input.candidates.length>BOUNDS.sources)return null;
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
  previewInitialBaseline(context:LifecycleContext,input:BaselineInventory<T>,now:number,ttlMs:number):BaselinePreview<T>|null {
    if(this.restorePending||!this.current(context)||this.baselineDone)return null;
    this.pending=undefined;
    if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(ttlMs)||ttlMs<=0||ttlMs>300000
      ||!Number.isSafeInteger(now+ttlMs))return null;
    const candidates=this.inventory(context,input);
    if(!candidates)return null;
    const preview=Object.freeze({context:this.context!,startedAt:now,expiresAt:now+ttlMs,candidates});
    this.lifecycleRevision++;this.pending=preview;return preview;
  }
  confirmInitialBaseline(context:LifecycleContext,preview:BaselinePreview<T>,input:BaselineInventory<T>,now:number):boolean {
    // Capability identity is instance-local and cannot be replayed by copying
    // serialized data. Every matching confirmation consumes it, even denial.
    if(!preview||preview!==this.pending)return false;
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
   * One explicit, host-serialized recovery attempt for a pristine opened
   * tracker. It never accepts caller-supplied snapshots or source proofs.
   * The host must fence ledger writes/close and revalidate fresh source proofs
   * again at every later policy-use boundary.
   */
  async restoreCommittedLifecycle(context:LifecycleContext,ledger:DurableLifecycleLedger,reader:BoundedVaultReader,
      host:LifecycleRestoreHost<T>):Promise<boolean> {
    if(this.restoreUsed||this.restorePending||!this.current(context))return false;
    this.restoreUsed=true;
    if(this.exact.size!==0||this.eventSequence!==0||this.lifecycleRevision!==0||this.pending
      ||this.baselineDone||this.legacyTouched||this.overflow||this.entries.size!==0
      ||!(ledger instanceof DurableLifecycleLedger)||!(reader instanceof BoundedVaultReader)
      ||reader.rootId!==context.rootId||!host||typeof host.current!=='function'||typeof host.resolveNativeOwner!=='function'){
      this.sealLifecycle();return false;
    }
    this.restorePending=true;
    const capturedContext=this.context!;
    const intact=()=>this.restorePending&&this.current(capturedContext)&&this.lifecycleRevision===0&&!this.legacyTouched;
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
      this.baselineDone=loaded.snapshot.baselineAdmitted;
      published=true;
      return true;
    }catch{return false;}finally{
      if(!published)this.sealLifecycle();
      this.restorePending=false;
    }
  }
  /** Immutable bounded evidence for a future host-authorized ledger commit. */
  exportCommittedLifecycleEvidence(context:LifecycleContext):LifecycleRestoreEvidence|null {
    if(this.restorePending||!this.current(context))return null;
    const entries:LedgerEntry[]=[];
    for(const [sourceId,entry] of [...this.exact.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)){
      if(entry==='deleted'||entry==='ambiguous')entries.push(Object.freeze({sourceId,state:entry}));
      else entries.push(Object.freeze({sourceId,state:entry.state,origin:entry.origin,originVersionId:entry.originVersionId,
        proof:copyProof(entry.proof)}));
    }
    return Object.freeze({baselineAdmitted:this.baselineDone,entries:Object.freeze(entries)});
  }
}

function sameLedgerAnchor(a:LedgerAnchor,b:LedgerAnchor):boolean {
  return a.schemaVersion===b.schemaVersion&&a.rootId===b.rootId&&a.epoch===b.epoch
    &&a.revision===b.revision&&a.snapshotSha256===b.snapshotSha256;
}
