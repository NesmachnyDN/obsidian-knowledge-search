/** Host-private durable evidence, never a processing-policy authority. */
import { randomBytes, randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { lstat, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BoundedVaultReader, privateIndexPath } from '../standalone/source';
import { hash, isDigest, StandaloneError, validPath } from '../standalone/contracts';
import { canonical } from '../advanced/protocol';
import { withPrivateDerivedDirectory } from '../advanced/private-directory';
import { parseCanonical, persist, strictFile, syncDirectory } from '../advanced/storage';
import { LifecycleLock, ledgerUnavailable as bad, lifecycleLockName } from './lifecycle-lock';
import { immutableLedgerSnapshot, MAX_LEDGER_BYTES, validateLedgerAnchor, validateLedgerSnapshot,
  type LedgerAnchor, type LedgerEntry, type LedgerSnapshot } from './lifecycle-ledger-schema';
import type { DescriptorLifecycleProof } from '../standalone/source';

const CURRENT='CURRENT',snapshotName=/^[a-f0-9]{64}\.json$/,stageName=/^\.stage-[a-f0-9-]{36}$/;
const MAX_ANCHOR_BYTES=2048,MAX_ARTIFACTS=8;
type Root=Readonly<{path:string;rootId:string}>;
type Loaded={anchor:LedgerAnchor;snapshot:LedgerSnapshot};
type Directories={anchor:string;data:string;fence:()=>Promise<void>};
/** Trusted host predicates, not a lifecycle authority or caller-provided consent. */
export type InitialBaselineCommitGuard=Readonly<{
  signal:AbortSignal;
  revalidate:()=>Promise<boolean>;
  current:()=>boolean;
}>;
/**
 * One future-native-owner assertion about a single transition.  This ledger
 * substrate validates only the committed evidence and supplied descriptor
 * proofs; it neither authenticates an Obsidian event nor grants authority.
 */
export type LiveTransitionDelta=Readonly<
  |{kind:'create';entry:LedgerEntry}
  |{kind:'modify';prior:DescriptorLifecycleProof;next:DescriptorLifecycleProof}
  |{kind:'rename';prior:DescriptorLifecycleProof;next:DescriptorLifecycleProof}
  |{kind:'delete';prior:DescriptorLifecycleProof}
>;
type PublicationGuard=Readonly<{revalidate:()=>Promise<boolean>;current:()=>boolean}>;
type PublicationAttempt={switchAttempted:boolean};
/** An exception after the switch was attempted cannot prove rollback. */
export class InitialBaselinePublicationError extends StandaloneError {
  constructor(public readonly outcome:'denied'|'uncertain-publication') { super('LIFECYCLE_LEDGER_UNAVAILABLE'); }
}
/** An exception after a guarded live-transition anchor switch is uncertain. */
export class LiveTransitionPublicationError extends StandaloneError {
  constructor(public readonly outcome:'denied'|'uncertain-publication') { super('LIFECYCLE_LEDGER_UNAVAILABLE'); }
}
/** Distinguish proven malformed committed state from ambiguous orphan evidence.
 * Operational, permission and lock failures retain the generic unavailable code. */
export class LifecycleLedgerStateError extends StandaloneError {
  constructor(public readonly reason:'corrupted'|'ambiguous') { super('LIFECYCLE_LEDGER_UNAVAILABLE'); }
}
const invalidState=(reason:LifecycleLedgerStateError['reason']):never=>{throw new LifecycleLedgerStateError(reason);};
const snapshotFile=(digest:string)=>digest+'.json';

function sameProof(a:DescriptorLifecycleProof,b:DescriptorLifecycleProof):boolean {
  return a.stableIdentity===b.stableIdentity&&a.version.rootId===b.version.rootId
    &&a.version.sourceId===b.version.sourceId&&a.version.sha256===b.version.sha256
    &&a.version.versionId===b.version.versionId;
}
function copyProof(p:DescriptorLifecycleProof):DescriptorLifecycleProof {
  return Object.freeze({stableIdentity:p.stableIdentity,version:Object.freeze({...p.version})});
}
function admitted(entry:LedgerEntry|undefined):entry is Extract<LedgerEntry,{proof:DescriptorLifecycleProof}> {
  return !!entry&&'proof' in entry;
}
function copyEntry(entry:LedgerEntry):LedgerEntry {
  return admitted(entry)?Object.freeze({...entry,proof:copyProof(entry.proof)}):Object.freeze({...entry});
}
function exactKeys(value:unknown,names:string):value is Record<string,unknown> {
  return !!value&&typeof value==='object'&&Object.keys(value).sort().join('|')===names;
}
function strictProof(value:unknown,rootId:string):value is DescriptorLifecycleProof {
  if(!exactKeys(value,'stableIdentity|version')||!isDigest(value.stableIdentity)||!exactKeys(value.version,'rootId|sha256|sourceId|versionId')
    ||value.version.rootId!==rootId||!validPath(value.version.sourceId)||!isDigest(value.version.sha256)||!isDigest(value.version.versionId))return false;
  return true;
}
function validLiveDelta(delta:unknown,rootId:string):delta is LiveTransitionDelta {
  if(!delta||typeof delta!=='object'||!('kind' in delta))return false;
  const value=delta as Record<string,unknown>;
  if(value.kind==='create'){
    if(!exactKeys(value,'entry|kind'))return false;
    try {validateLedgerSnapshot({schemaVersion:1,rootId,epoch:'0'.repeat(64),revision:1,previous:'0'.repeat(64),
      baselineAdmitted:true,entries:[value.entry]},rootId);return true;}catch{return false;}
  }
  return (value.kind==='delete'&&exactKeys(value,'kind|prior')&&strictProof(value.prior,rootId))
    ||((value.kind==='modify'||value.kind==='rename')&&exactKeys(value,'kind|next|prior')
      &&strictProof(value.prior,rootId)&&strictProof(value.next,rootId));
}
/** Derive exactly one legal successor from the committed snapshot. */
function applyLiveTransition(snapshot:LedgerSnapshot,delta:LiveTransitionDelta,rootId:string):LedgerEntry[]{
  if(!snapshot.baselineAdmitted||!exactKeys(delta,delta.kind==='create'?'entry|kind':delta.kind==='delete'?'kind|prior':'kind|next|prior'))return bad();
  const entries=new Map(snapshot.entries.map(entry=>[entry.sourceId,entry]));
  const replace=(entry:LedgerEntry)=>entries.set(entry.sourceId,entry);
  if(delta.kind==='create'){
    const next=delta.entry,old=entries.get(next.sourceId);
    if(!admitted(next)||next.state!=='verified-new'||next.origin!=='native-create'
      ||next.originVersionId!==next.proof.version.versionId||(old!==undefined&&old.state!=='deleted'))return bad();
    replace(Object.freeze({...next,proof:copyProof(next.proof)}));
  }else{
    const prior=delta.prior,old=entries.get(prior.version.sourceId);
    if(!admitted(old)||!sameProof(old.proof,prior))return bad();
    if(delta.kind==='delete')replace(Object.freeze({sourceId:prior.version.sourceId,state:'deleted'}));
    else {
      const next=delta.next,samePath=next.version.sourceId===prior.version.sourceId;
      // ADR-0021 and POLICY.2e1 distinguish descriptor identity from content.
      // A fresh version can retain its bytes (including an ordinary rename).
      // The exact committed prior and independent owner/event fences are
      // still required; an unchanged version is not a new durable delta.
      if(next.version.rootId!==rootId||prior.version.rootId!==rootId||next.stableIdentity!==prior.stableIdentity
        ||next.version.versionId===prior.version.versionId||samePath!==(delta.kind==='modify'))return bad();
      if(delta.kind==='rename'){
        const collision=entries.get(next.version.sourceId);
        if(collision!==undefined)return bad();
        replace(Object.freeze({sourceId:prior.version.sourceId,state:'deleted'}));
      }
      replace(Object.freeze({sourceId:next.version.sourceId,state:old.state,origin:old.origin,
        originVersionId:old.originVersionId,proof:copyProof(next)}));
    }
  }
  const result=[...entries.values()].sort((a,b)=>a.sourceId<b.sourceId?-1:a.sourceId>b.sourceId?1:0);
  // Reuse the immutable schema validator to reject malformed caller proofs and
  // ensure this derivation cannot broaden the durable format.
  validateLedgerSnapshot({...snapshot,revision:snapshot.revision+1,previous:'0'.repeat(64),entries:result},rootId);
  return immutableLedgerSnapshot({...snapshot,revision:snapshot.revision+1,previous:'0'.repeat(64),entries:result}).entries.slice();
}

async function boundedNames(dir:string):Promise<string[]>{
  const names:string[]=[];
  for await(const entry of await opendir(dir)){
    if(names.length>=MAX_ARTIFACTS)return bad();
    names.push(entry.name);
  }
  return names;
}
async function rootCheck(root:Root):Promise<void>{
  const reader=await BoundedVaultReader.open(root.path,()=>[]);
  if(reader.rootId!==root.rootId)return bad();
}
async function namesFor(d:Directories,uid:number):Promise<{anchor:string[];data:string[]}>{
  const anchor=await boundedNames(d.anchor),data=await boundedNames(d.data);
  if(!anchor.includes(lifecycleLockName)||anchor.some(n=>n!==CURRENT&&n!==lifecycleLockName&&!stageName.test(n))
    ||data.some(n=>!snapshotName.test(n)))return bad();
  for(const name of data)await safeArtifact(d.data,name,uid);
  for(const name of anchor)if(name!==lifecycleLockName)await safeArtifact(d.anchor,name,uid);
  return {anchor,data};
}
function sameAnchor(a:LedgerAnchor|null,b:LedgerAnchor|null):boolean{
  return a===null||b===null?a===b:canonical(a)===canonical(b);
}
async function readAnchor(dir:string,rootId:string,uid:number):Promise<LedgerAnchor|null>{
  const names=await boundedNames(dir);
  if(!names.includes(CURRENT))return null;
  const bytes=await strictFile(join(dir,CURRENT),MAX_ANCHOR_BYTES,uid);
  try {
    const anchor=parseCanonical(bytes);
    validateLedgerAnchor(anchor,rootId);
    return Object.freeze(anchor);
  }catch{return invalidState('corrupted');}
}
async function readCommitted(d:Directories,rootId:string,uid:number):Promise<Loaded|null>{
  const names=await namesFor(d,uid),anchor=await readAnchor(d.anchor,rootId,uid);
  if(!anchor){
    // Missing current plus any prior/staged artifact is uncertain, not fresh.
    if(names.anchor.length!==1||names.data.length!==0)return invalidState('ambiguous');
    return null;
  }
  const name=snapshotFile(anchor.snapshotSha256);
  if(!names.data.includes(name))return invalidState('corrupted');
  const bytes=await strictFile(join(d.data,name),MAX_LEDGER_BYTES,uid);
  if(hash(bytes)!==anchor.snapshotSha256)return invalidState('corrupted');
  try {
    const snapshot=parseCanonical(bytes);
    validateLedgerSnapshot(snapshot,rootId);
    if(snapshot.epoch!==anchor.epoch||snapshot.revision!==anchor.revision)return invalidState('corrupted');
    return {anchor,snapshot:immutableLedgerSnapshot(snapshot)};
  }catch{return invalidState('corrupted');}
}
async function safeArtifact(dir:string,name:string,uid:number):Promise<void>{
  const info=await lstat(join(dir,name));
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==uid||(info.mode&0o077)!==0
    ||info.size>MAX_LEDGER_BYTES)return bad();
}
async function removeArtifact(dir:string,name:string,uid:number):Promise<void>{
  await safeArtifact(dir,name,uid);await unlink(join(dir,name));
}
async function cleanup(d:Directories,current:LedgerAnchor,uid:number):Promise<void>{
  const names=await namesFor(d,uid);
  for(const name of names.data)if(name!==snapshotFile(current.snapshotSha256)){
    await d.fence();await removeArtifact(d.data,name,uid);
  }
  for(const name of names.anchor)if(stageName.test(name)){
    await d.fence();await removeArtifact(d.anchor,name,uid);
  }
  await syncDirectory(d.data);await syncDirectory(d.anchor);
}
export class DurableLifecycleLedger{
  private current:LedgerAnchor|null=null;
  private active?:Promise<unknown>;
  private closing?:Promise<void>;
  private poisoned=false;
  private constructor(private readonly root:Root,private readonly anchorPath:string,
    private readonly dataPath:string,private readonly lock:LifecycleLock,private readonly uid:number){}

  static async open(root:Root,pluginId:string):Promise<DurableLifecycleLedger>{
    const uid=process.getuid?.();
    if(uid===undefined||process.platform!=='linux')return bad();
    let lock:LifecycleLock|undefined;
    try{
      const trusted=Object.freeze({...root});
      await rootCheck(trusted);
      const parent=dirname(privateIndexPath(trusted.path,trusted.rootId,pluginId));
      const anchorPath=join(parent,'lifecycle-authority'),dataPath=join(parent,'lifecycle-ledger');
      await withPrivateDerivedDirectory(anchorPath,trusted.path,async dir=>{
        const names=await boundedNames(dir);
        if(!names.includes(lifecycleLockName)&&names.length!==0)return bad();
        lock=await LifecycleLock.acquire(dir);
      },true);
      if(!lock)return bad();
      const ledger=new DurableLifecycleLedger(trusted,anchorPath,dataPath,lock,uid);
      await ledger.withDirs(async d=>{
        const loaded=await readCommitted(d,trusted.rootId,uid);
        if(loaded){ledger.current=loaded.anchor;await cleanup(d,loaded.anchor,uid);}
      });
      lock=undefined;return ledger;
    }catch(error){if(error instanceof LifecycleLedgerStateError)throw error;return bad();}
    finally{await lock?.close();}
  }
  private async withDirs<T>(action:(d:Directories)=>Promise<T>):Promise<T>{
    return withPrivateDerivedDirectory(this.anchorPath,this.root.path,anchor=>
      withPrivateDerivedDirectory(this.dataPath,this.root.path,async data=>{
        const fence=async()=>{
          await rootCheck(this.root);
          if(await realpath(anchor)!==this.anchorPath||await realpath(data)!==this.dataPath)return bad();
          await this.lock.assertCurrent(anchor);
        };
        await fence();const value=await action({anchor,data,fence});await fence();return value;
      },true),true);
  }
  private async run<T>(action:()=>Promise<T>):Promise<T>{
    if(this.closing||this.poisoned||this.active)return bad();
    const operation=(async()=>{try{return await action();}catch(error){this.poisoned=true;if(error instanceof LifecycleLedgerStateError)throw error;return bad();}})();
    this.active=operation;
    try{return await operation;}finally{this.active=undefined;}
  }
  private async currentAt(d:Directories):Promise<Loaded|null>{
    const loaded=await readCommitted(d,this.root.rootId,this.uid);
    if(!sameAnchor(loaded?.anchor??null,this.current))return bad();
    return loaded;
  }
  async read():Promise<Readonly<Loaded>|null>{
    return this.run(()=>this.withDirs(async d=>{
      const loaded=await this.currentAt(d);return loaded?Object.freeze(loaded):null;
    }));
  }
  /** Only the existing host-private ledger can attest its current in-process state. */
  rootAvailable(rootId:string):boolean {
    return this.root.rootId===rootId&&!this.closing&&!this.poisoned;
  }
  committedAnchorCurrent(anchor:LedgerAnchor):boolean {
    return this.rootAvailable(anchor.rootId)&&!this.active&&sameAnchor(this.current,anchor);
  }
  private async guardedPublication<E extends InitialBaselinePublicationError|LiveTransitionPublicationError>(
      action:(attempt:PublicationAttempt)=>Promise<Readonly<Loaded>>,
      failure:(outcome:'denied'|'uncertain-publication')=>E):Promise<Readonly<Loaded>> {
    const attempt={switchAttempted:false};
    try{return await this.run(()=>action(attempt));}
    catch{throw failure(attempt.switchAttempted?'uncertain-publication':'denied');}
  }
  /** Explicit host action only. Opening or reading an empty store does not
   * initialize an epoch. Actual owner authorization is a 2e3 prerequisite. */
  async initializeEmptyEpoch():Promise<Readonly<Loaded>>{
    return this.run(()=>this.withDirs(async d=>{
      if(await this.currentAt(d)!==null)return bad();
      return this.publish(d,{schemaVersion:1,rootId:this.root.rootId,epoch:randomBytes(32).toString('hex'),
        revision:0,previous:null,baselineAdmitted:false,entries:[]});
    }));
  }
  /**
   * Reserved for an explicit initial-baseline confirmation.  Empty storage is
   * evidence of nothing: this method merely creates the durable epoch while a
   * still-current native confirmation is held.  It is deliberately distinct
   * from the low-level test/recovery substrate above.
   */
  async initializeEmptyEpochForInitialBaseline(guard:InitialBaselineCommitGuard):Promise<Readonly<Loaded>>{
    const {signal,revalidate,current:hostCurrent}=guard;
    if(!(signal instanceof AbortSignal)||typeof revalidate!=='function'||typeof hostCurrent!=='function')return bad();
    const current=():boolean=>{
      if(this.closing||signal.aborted)return false;
      const valid=hostCurrent()===true;
      return valid&&!this.closing&&!signal.aborted;
    };
    return this.guardedPublication(attempt=>this.withDirs(async d=>{
      if(!current()||await this.currentAt(d)!==null||!current())return bad();
      if(await revalidate()!==true||!current())return bad();
      return this.publish(d,{schemaVersion:1,rootId:this.root.rootId,epoch:randomBytes(32).toString('hex'),
        revision:0,previous:null,baselineAdmitted:false,entries:[]},{current,revalidate},attempt);
    }),outcome=>new InitialBaselinePublicationError(outcome));
  }
  async commit(expectedDigest:string,baselineAdmitted:boolean,entries:readonly LedgerEntry[]):Promise<Readonly<Loaded>>{
    // Capture the validated record set before any asynchronous filesystem work.
    const candidate:LedgerSnapshot={schemaVersion:1,rootId:this.root.rootId,epoch:'0'.repeat(64),
      revision:1,previous:expectedDigest,baselineAdmitted,entries};
    validateLedgerSnapshot(candidate,this.root.rootId);
    const captured=immutableLedgerSnapshot(candidate).entries;
    return this.run(()=>this.withDirs(async d=>{
      const old=await this.currentAt(d);
      if(!old||old.anchor.snapshotSha256!==expectedDigest||old.snapshot.baselineAdmitted&&!baselineAdmitted
        ||old.snapshot.revision===Number.MAX_SAFE_INTEGER)return bad();
      const next:LedgerSnapshot={schemaVersion:1,rootId:this.root.rootId,epoch:old.snapshot.epoch,
        revision:old.snapshot.revision+1,previous:expectedDigest,baselineAdmitted,entries:captured};
      return this.publish(d,next);
    }));
  }
  /** Guarded initial admission substrate; the native host must prove all predicates.
   * Only a pristine committed empty epoch is supported by this bounded path.
   */
  async commitInitialBaseline(expectedDigest:string,entries:readonly LedgerEntry[],
    guard:InitialBaselineCommitGuard):Promise<Readonly<Loaded>>{
    const candidate:LedgerSnapshot={schemaVersion:1,rootId:this.root.rootId,epoch:'0'.repeat(64),
      revision:1,previous:expectedDigest,baselineAdmitted:true,entries};
    validateLedgerSnapshot(candidate,this.root.rootId);
    const captured=immutableLedgerSnapshot(candidate).entries;
    if(captured.some(entry=>entry.state!=='existing'||entry.originVersionId!==entry.proof.version.versionId))
      return bad();
    const {signal,revalidate,current:hostCurrent}=guard;
    if(!(signal instanceof AbortSignal)||typeof revalidate!=='function'||typeof hostCurrent!=='function')return bad();
    const current=():boolean=>{
      if(this.closing||signal.aborted)return false;
      const valid=hostCurrent()===true;
      return valid&&!this.closing&&!signal.aborted;
    };
    return this.guardedPublication(attempt=>this.withDirs(async d=>{
      if(!current())return bad();
      const old=await this.currentAt(d);
      if(!old||old.anchor.snapshotSha256!==expectedDigest||old.snapshot.revision!==0
        ||old.snapshot.baselineAdmitted||old.snapshot.entries.length!==0)return bad();
      return this.publish(d,{...candidate,epoch:old.snapshot.epoch,entries:captured},{current,revalidate},attempt);
    }),outcome=>new InitialBaselinePublicationError(outcome));
  }
  /**
   * Guarded durable substrate for exactly one future host-proven transition on
   * a committed initial baseline.  It deliberately has no tracker or native
   * event caller: a future owner must provide and continuously revalidate its
   * own authority predicates around this atomic publication.
   */
  async commitLiveTransition(expectedAnchor:LedgerAnchor,delta:LiveTransitionDelta,
      guard:InitialBaselineCommitGuard):Promise<Readonly<Loaded>> {
    if(!expectedAnchor||typeof expectedAnchor!=='object'||!validLiveDelta(delta,this.root.rootId))return bad();
    validateLedgerAnchor(expectedAnchor,this.root.rootId);
    const expected=Object.freeze({...expectedAnchor});
    const {signal,revalidate,current:hostCurrent}=guard;
    if(!(signal instanceof AbortSignal)||typeof revalidate!=='function'||typeof hostCurrent!=='function')return bad();
    const current=():boolean=>{
      if(this.closing||signal.aborted)return false;
      try{return hostCurrent()===true&&!this.closing&&!signal.aborted;}catch{return false;}
    };
    // Capture and validate the delta before an asynchronous lock/IO boundary.
    const captured=delta.kind==='create'?Object.freeze({kind:'create' as const,entry:copyEntry(delta.entry)})
      :delta.kind==='delete'?Object.freeze({kind:'delete' as const,prior:copyProof(delta.prior)})
      :Object.freeze({kind:delta.kind,prior:copyProof(delta.prior),next:copyProof(delta.next)}) as LiveTransitionDelta;
    return this.guardedPublication(attempt=>this.withDirs(async d=>{
      if(!current())return bad();
      const old=await this.currentAt(d);
      if(!old||!sameAnchor(old.anchor,expected)||old.snapshot.revision===Number.MAX_SAFE_INTEGER)return bad();
      const entries=applyLiveTransition(old.snapshot,captured,this.root.rootId);
      const next:LedgerSnapshot={schemaVersion:1,rootId:this.root.rootId,epoch:old.snapshot.epoch,
        revision:old.snapshot.revision+1,previous:old.anchor.snapshotSha256,
        baselineAdmitted:old.snapshot.baselineAdmitted,entries};
      return this.publish(d,next,{current,revalidate},attempt);
    }),outcome=>new LiveTransitionPublicationError(outcome));
  }
  private async publish(d:Directories,snapshot:LedgerSnapshot,guard?:PublicationGuard,attempt?:PublicationAttempt):Promise<Readonly<Loaded>>{
    validateLedgerSnapshot(snapshot,this.root.rootId);
    // Copy before asynchronous work: a caller cannot mutate the committed data.
    snapshot=immutableLedgerSnapshot(snapshot);
    const bytes=Buffer.from(canonical(snapshot),'utf8');
    if(bytes.length>MAX_LEDGER_BYTES)return bad();
    const anchor:LedgerAnchor=Object.freeze({schemaVersion:1,rootId:this.root.rootId,epoch:snapshot.epoch,
      revision:snapshot.revision,snapshotSha256:hash(bytes)});
    const name=snapshotFile(anchor.snapshotSha256),stage='.stage-'+randomUUID();
    await d.fence();
    const names=await namesFor(d,this.uid);
    if(names.anchor.length>=MAX_ARTIFACTS||names.data.length>=MAX_ARTIFACTS)return bad();
    await persist(join(d.data,name),bytes);await syncDirectory(d.data);
    await d.fence();
    if(!sameAnchor(await readAnchor(d.anchor,this.root.rootId,this.uid),this.current))return bad();
    await persist(join(d.anchor,stage),Buffer.from(canonical(anchor),'utf8'));
    await d.fence();
    // Current anchor is the sole commit point. Never promote an orphan snapshot.
    if(guard){
      if(!guard.current()||await guard.revalidate()!==true||!guard.current())return bad();
      await d.fence();
      // No await between the final trusted host fence and the atomic switch.
      // Cancellation before this point denies; cancellation after it cannot undo
      // committed provenance and must independently retire live authority.
      if(!guard.current())return bad();
      if(attempt)attempt.switchAttempted=true;
      renameSync(join(d.anchor,stage),join(d.anchor,CURRENT));
    }else{
      await rename(join(d.anchor,stage),join(d.anchor,CURRENT));
    }
    await syncDirectory(d.anchor);
    const committed=await readCommitted(d,this.root.rootId,this.uid);
    if(!committed||!sameAnchor(committed.anchor,anchor))return bad();
    await d.fence();
    this.current=anchor;
    await cleanup(d,anchor,this.uid);
    return Object.freeze({anchor,snapshot});
  }
  close():Promise<void>{
    // No new operations after close begins. Physically drain the in-flight
    // transaction before releasing the kernel lock.
    return this.closing??=(async()=>{
      try{await this.active;}catch{/* operation already failed closed */}
      await this.lock.close();
    })();
  }
}
