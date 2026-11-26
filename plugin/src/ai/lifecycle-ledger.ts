/** Host-private durable evidence, never a processing-policy authority. */
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BoundedVaultReader, privateIndexPath } from '../standalone/source';
import { hash } from '../standalone/contracts';
import { canonical } from '../advanced/protocol';
import { withPrivateDerivedDirectory } from '../advanced/private-directory';
import { parseCanonical, persist, strictFile, syncDirectory } from '../advanced/storage';
import { LifecycleLock, ledgerUnavailable as bad, lifecycleLockName } from './lifecycle-lock';
import { immutableLedgerSnapshot, MAX_LEDGER_BYTES, validateLedgerAnchor, validateLedgerSnapshot,
  type LedgerAnchor, type LedgerEntry, type LedgerSnapshot } from './lifecycle-ledger-schema';

const CURRENT='CURRENT',snapshotName=/^[a-f0-9]{64}\.json$/,stageName=/^\.stage-[a-f0-9-]{36}$/;
const MAX_ANCHOR_BYTES=2048,MAX_ARTIFACTS=8;
type Root=Readonly<{path:string;rootId:string}>;
type Loaded={anchor:LedgerAnchor;snapshot:LedgerSnapshot};
type Directories={anchor:string;data:string;fence:()=>Promise<void>};
const snapshotFile=(digest:string)=>digest+'.json';

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
  const anchor=parseCanonical(await strictFile(join(dir,CURRENT),MAX_ANCHOR_BYTES,uid));
  validateLedgerAnchor(anchor,rootId);
  return Object.freeze(anchor);
}
async function readCommitted(d:Directories,rootId:string,uid:number):Promise<Loaded|null>{
  const names=await namesFor(d,uid),anchor=await readAnchor(d.anchor,rootId,uid);
  if(!anchor){
    // Missing current plus any prior/staged artifact is uncertain, not fresh.
    if(names.anchor.length!==1||names.data.length!==0)return bad();
    return null;
  }
  const name=snapshotFile(anchor.snapshotSha256);
  if(!names.data.includes(name))return bad();
  const bytes=await strictFile(join(d.data,name),MAX_LEDGER_BYTES,uid);
  if(hash(bytes)!==anchor.snapshotSha256)return bad();
  const snapshot=parseCanonical(bytes);
  validateLedgerSnapshot(snapshot,rootId);
  if(snapshot.epoch!==anchor.epoch||snapshot.revision!==anchor.revision)return bad();
  return {anchor,snapshot:immutableLedgerSnapshot(snapshot)};
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
    }catch{return bad();}
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
    const operation=(async()=>{try{return await action();}catch{this.poisoned=true;return bad();}})();
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
  /** Explicit host action only. Opening or reading an empty store does not
   * initialize an epoch. Actual owner authorization is a 2e3 prerequisite. */
  async initializeEmptyEpoch():Promise<Readonly<Loaded>>{
    return this.run(()=>this.withDirs(async d=>{
      if(await this.currentAt(d)!==null)return bad();
      return this.publish(d,{schemaVersion:1,rootId:this.root.rootId,epoch:randomBytes(32).toString('hex'),
        revision:0,previous:null,baselineAdmitted:false,entries:[]});
    }));
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
  private async publish(d:Directories,snapshot:LedgerSnapshot):Promise<Readonly<Loaded>>{
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
    await rename(join(d.anchor,stage),join(d.anchor,CURRENT));
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
