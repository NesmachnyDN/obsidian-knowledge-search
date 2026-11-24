/** Durable v4 retrieval generation bound to canonical v3 source/chunk identities.
 * No Vault writes; same 05C atomic publication helpers and private XDG root.
 */
import { lstat, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readSource, type TrustedVaultRoot } from './source';
import { validateApiDenseGeneration, readBuiltApiDenseGeneration, type ApiDenseGeneration } from '../ai/dense-generation';
import { privateIndexPath } from '../standalone/source';
import { verifySpan } from '../search/navigation';
import { canonical, sha, validRelative, IngestError } from './protocol';
import { withPrivateDerivedDirectory } from './private-directory';
import { persist, syncDirectory, strictFile, parseCanonical } from './storage';
import { verifyIdentity, verifyVector, CHUNK_TOKENIZER_FINGERPRINT, type ModelIdentity } from './model-protocol';
import { ModelError } from './model-protocol';

const LIMIT_BYTES=32*1024*1024;
export const MAX_VECTORS=256;
const CURRENT='CURRENT';
const genPattern=/^[a-f0-9]{64}\.json$/;
const stagePattern=/^\.stage-[a-f0-9-]{36}$/;
export type IndexedSource={
  sourcePath:string;sourceSha256:string;ingestGenerationId:string;
  profileId:string;tokenizerFingerprint:string;chunkIds:string[];vectors:number[][];
};
export type RetrievalGeneration={
  schemaVersion:1;rootId:string;model:ModelIdentity;generationId:string;entries:IndexedSource[];
};
type ActiveGeneration=RetrievalGeneration|ApiDenseGeneration;
// One lifecycle per private store path. Only bounded source identities are
// shared; immutable generations remain instance-local and epoch-checked.
type Lifecycle={epoch:symbol;name:string|null;revision:number;blocked:boolean;
  sources:Set<string>;revoked:Set<string>};
const lifecycles=new Map<string,Lifecycle>();
const activeWriters=new Set<string>();
type Pointer={schemaVersion:1;rootId:string;filename:string;sha256:string};
const cmp=(a:string,b:string):number=>a<b?-1:a>b?1:0;
const invalid=():never=>{throw new ModelError('INDEX_INCOMPATIBLE');};
export const generationDigest=(v:Omit<RetrievalGeneration,'generationId'>):string=>sha(canonical(v));
export function validateRetrievalGeneration(v:unknown,rootId:string):asserts v is RetrievalGeneration {
  if(!v||typeof v!=='object'||Array.isArray(v))invalid();
  const g=v as RetrievalGeneration;
  if(Object.keys(g).sort().join('|')!==['schemaVersion','rootId','model','generationId','entries'].sort().join('|')
      ||g.schemaVersion!==1||g.rootId!==rootId||!Array.isArray(g.entries)
      ||g.entries.length>32||!/^[a-f0-9]{64}$/.test(g.generationId))invalid();
  verifyIdentity(g.model);
  let count=0,prior='';
  for(const e of g.entries){
    if(!e||typeof e!=='object'||Array.isArray(e)
        ||Object.keys(e).sort().join('|')!==['sourcePath','sourceSha256','ingestGenerationId','profileId',
           'tokenizerFingerprint','chunkIds','vectors'].sort().join('|')
        ||!validRelative(e.sourcePath)||e.sourcePath<=prior
        ||!['md','pdf','docx'].includes(e.sourcePath.split('.').at(-1)?.toLowerCase()??'')
        ||![e.sourceSha256,e.ingestGenerationId,e.tokenizerFingerprint]
            .every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))
        ||typeof e.profileId!=='string'||!e.profileId
        ||!Array.isArray(e.chunkIds)||!e.chunkIds.length
        ||e.chunkIds.length!==e.vectors?.length||e.chunkIds.length>64
        ||e.chunkIds.some(x=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x))
        ||new Set(e.chunkIds).size!==e.chunkIds.length
        ||e.tokenizerFingerprint!==CHUNK_TOKENIZER_FINGERPRINT){invalid();}
    prior=e.sourcePath;
    count+=e.chunkIds.length;
    if(count>MAX_VECTORS)invalid();
    for(const vec of e.vectors)verifyVector(vec);
  }
  if(generationDigest({schemaVersion:1,rootId:g.rootId,model:g.model,entries:g.entries})!==g.generationId)invalid();
}
function validateActive(v:unknown,rootId:string):asserts v is ActiveGeneration {
  if((v as {schemaVersion?:unknown}|null)?.schemaVersion===2)validateApiDenseGeneration(v,rootId);
  else validateRetrievalGeneration(v,rootId);
}
export class AdvancedRetrievalStore {
  readonly path:string;
  private generation:ActiveGeneration|null=null;
  private epoch=Symbol();
  private committedName:string|null=null;
  private lifecycle!:Lifecycle;
  private poisoned=false;
  private constructor(private readonly root:TrustedVaultRoot,path:string){this.path=path;}
  static async open(root:TrustedVaultRoot,pluginId:string):Promise<AdvancedRetrievalStore>{
    const parent=dirname(privateIndexPath(root.path,root.id,pluginId));
    const path=resolve(parent,'advanced-retrieval');
    const store=new AdvancedRetrievalStore(root,path);
    if(activeWriters.has(path))invalid();
    activeWriters.add(path);
    try {
      await store.load();
      const previous=lifecycles.get(path);
      const state=previous??{epoch:Symbol(),name:store.committedName,revision:0,
        blocked:false,sources:new Set<string>(),revoked:new Set<string>()};
      // An ambiguous pointer rename may have succeeded; never clear an
      // uncertain/revoked generation merely by reopening the store.
      if(state.name!==store.committedName){
        state.epoch=Symbol();state.name=store.committedName;
      }
      state.sources=new Set(store.generation?.entries.map(e=>e.sourcePath)??[]);
      store.lifecycle=state;store.epoch=state.epoch;
      lifecycles.set(path,state);
      return store;
    } catch (error) { if(error instanceof IngestError)invalid(); throw error; }
    finally { activeWriters.delete(path); }
  }
  /** No CURRENT means no committed index. Authenticate abandoned first-publish
   * artifacts before removing them; never promote an orphan into search visibility.
   * An existing but corrupt CURRENT is never recovered through this path.
   */
  private async discardUnpublished(names:string[], dir:string):Promise<void>{
    if(names.includes(CURRENT))invalid();
    if(names.some(x=>!genPattern.test(x)&&!stagePattern.test(x)))invalid();
    const generations=names.filter(x=>genPattern.test(x));
    for(const name of generations){
      const bytes=await strictFile(join(dir,name),LIMIT_BYTES);
      if(sha(bytes)!==name.slice(0,-5))invalid();
      validateActive(parseCanonical(bytes),this.root.id);
    }
    for(const name of names.filter(x=>stagePattern.test(x))){
      const info=await lstat(join(dir,name));
      if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1
          ||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)invalid();
    }
    for(const name of names)await unlink(join(dir,name));
    if(names.length)await syncDirectory(dir);
  }
  private async load():Promise<void>{
    await withPrivateDerivedDirectory(this.path,this.root.path,async dir=>{
    const names=await readdir(dir);
    if(names.length>12||names.some(x=>x!==CURRENT&&!genPattern.test(x)&&!stagePattern.test(x)))invalid();
    if(!names.includes(CURRENT)){
      this.checkKnownPointer(null);
      await this.discardUnpublished(names,dir);
      return;
    }
    const ptr=parseCanonical(await strictFile(join(dir,CURRENT),2048)) as Pointer;
    if(!ptr||Object.keys(ptr).sort().join('|')!==['schemaVersion','rootId','filename','sha256'].sort().join('|')
        ||ptr.schemaVersion!==1||ptr.rootId!==this.root.id||!genPattern.test(ptr.filename)
        ||ptr.sha256!==ptr.filename.slice(0,-5))invalid();
    const bytes=await strictFile(join(dir,ptr.filename),LIMIT_BYTES);
    if(sha(bytes)!==ptr.sha256)invalid();
    const value=parseCanonical(bytes);
    validateActive(value,this.root.id);
    this.checkKnownPointer(ptr.filename);
    await this.discardUnpublished(names.filter(n=>n!==CURRENT&&n!==ptr.filename),dir);
    this.generation=value;this.committedName=ptr.filename;
    });
  }
  private checkKnownPointer(name:string|null):void {
    const state=lifecycles.get(this.path);
    if(state&&!state.blocked&&state.name!==name)invalid();
  }
  private assertCurrent():void {
    if(this.poisoned||this.lifecycle.epoch!==this.epoch)invalid();
  }
  private visibleLegacy():RetrievalGeneration|null{
    if(this.lifecycle.blocked||this.generation?.schemaVersion!==1)return null;
    if(!this.lifecycle.revoked.size)return this.generation;
    const {generationId:_,...base}=this.generation;
    const filtered={...base,entries:base.entries.filter(e=>!this.lifecycle.revoked.has(e.sourcePath))};
    return {...filtered,generationId:generationDigest(filtered)};
  }
  snapshot():RetrievalGeneration|null{
    this.assertCurrent();
    const value=this.visibleLegacy();
    return value?structuredClone(value):null;
  }
  private async verifyApi(g:ApiDenseGeneration,signal?:AbortSignal):Promise<void> {
    let path='',source:Awaited<ReturnType<typeof readSource>>|undefined;
    for(const e of g.entries){
      if(signal?.aborted)throw new ModelError('MODEL_CANCELLED');
      if(path!==e.sourcePath){source=await readSource(this.root,e.sourcePath);path=e.sourcePath;}
      if(!source||source.sha256!==e.sourceSha256||e.locator.byteEnd>source.bytes.length)invalid();
      const bytes=source!.bytes.subarray(e.locator.byteStart,e.locator.byteEnd);
      if(sha(bytes)!==e.excerptSha256)invalid();
      const excerpt=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
      verifySpan({sourceId:e.sourcePath,sourceSha256:e.sourceSha256,originalExcerpt:excerpt,
        sourceLocators:[e.locator],rank:1,lexicalRank:1,retrievalMode:'lexical',
        indexGenerationId:g.lexicalGenerationId,score:0,headings:[],wikiLinks:[],properties:[]},source!.bytes);
    }
  }
  /** A recovered API generation is never exposed without original source verification. */
  async snapshotApi(spaceId:string,lexicalGenerationId:string):Promise<ApiDenseGeneration|null>{
    this.assertCurrent();
    const state=this.lifecycle;
    if(this.generation?.schemaVersion!==2||state.blocked||state.revoked.size)return null;
    const value=this.generation,revision=state.revision;
    if(value.spaceId!==spaceId||value.lexicalGenerationId!==lexicalGenerationId)invalid();
    await withPrivateDerivedDirectory(this.path,this.root.path,async dir=>this.verifyPointer(dir));
    await this.verifyApi(value);
    this.assertCurrent();
    if(state.revision!==revision||this.generation!==value||state.blocked||state.revoked.size)invalid();
    return structuredClone(value);
  }
  revoke(path:string):void{
    // Even an instance with an obsolete snapshot can deliver a source event.
    // Never let an event be lost while the first generation is being built.
    const state=this.lifecycle;
    state.revision++;
    for(const source of state.sources)
      if(source===path||source.startsWith(path+'/'))state.revoked.add(source);
  }
  async publish(entry:IndexedSource,model:ModelIdentity,check:()=>Promise<void>,signal:AbortSignal,
    rebuild=false):Promise<RetrievalGeneration>{
    this.assertCurrent();
    verifyIdentity(model);
    const old=this.generation;
    if(!rebuild&&(this.lifecycle.blocked||old&&(old.schemaVersion!==1||canonical(old.model)!==canonical(model))))invalid();
    const entries=[...(rebuild?[]:this.visibleLegacy()?.entries??[]).filter(x=>x.sourcePath!==entry.sourcePath),entry]
      .sort((a,b)=>cmp(a.sourcePath,b.sourcePath));
    const base={schemaVersion:1 as const,rootId:this.root.id,model,entries};
    const next:RetrievalGeneration={...base,generationId:generationDigest(base)};
    return this.commit(next,check,signal);
  }
  async publishApi(generation:ApiDenseGeneration,check:()=>Promise<void>,signal:AbortSignal):Promise<ApiDenseGeneration>{
    const next=readBuiltApiDenseGeneration(generation);
    validateApiDenseGeneration(next,this.root.id);
    return this.commit(next,async()=>{await check();await this.verifyApi(next,signal);},signal);
  }
  private async verifyPointer(dir:string):Promise<void>{
    if(this.committedName===null){if((await readdir(dir)).includes(CURRENT))invalid();return;}
    const p=parseCanonical(await strictFile(join(dir,CURRENT),2048)) as Pointer;
    if(!p||p.schemaVersion!==1||p.rootId!==this.root.id||p.filename!==this.committedName
      ||p.sha256!==this.committedName.slice(0,-5)||Object.keys(p).length!==4)invalid();
  }
  private async commit<T extends ActiveGeneration>(value:T,check:()=>Promise<void>,signal:AbortSignal):Promise<T>{
    this.assertCurrent();
    if(activeWriters.has(this.path))invalid();
    activeWriters.add(this.path);
    const state=this.lifecycle,revision=state.revision;
    try {
      const next=structuredClone(value);
      validateActive(next,this.root.id);
      const result=await withPrivateDerivedDirectory(this.path,this.root.path,async dir=>{
    const names=await readdir(dir);
    if(names.length>12||names.some(x=>x!==CURRENT&&!genPattern.test(x)&&!stagePattern.test(x)))invalid();
    if(this.committedName===null){
      if(names.includes(CURRENT))invalid();
      await this.discardUnpublished(names,dir);
    }
    const payload=Buffer.from(canonical(next),'utf8');
    if(payload.byteLength>LIMIT_BYTES)throw new ModelError('INDEX_LIMIT');
    const name=sha(payload)+'.json',stage=join(dir,'.stage-'+randomUUID());
    const guard=async()=>{
      if(signal.aborted)throw new ModelError('MODEL_CANCELLED');
      await this.verifyPointer(dir);
      await check();
      await this.verifyPointer(dir);
      this.assertCurrent();
      if(signal.aborted||state.revision!==revision)throw new ModelError('MODEL_CANCELLED');
    };
    await guard();
    let pointerStage:string|null=null;
    let dataStageOwned=false;
    let newFileOwned=false;
    try{
      dataStageOwned=true;
      await persist(stage,payload);
      if(!(await readdir(dir)).includes(name)){
        await rename(stage,join(dir,name));
        dataStageOwned=false;newFileOwned=true;
      }else{
        const existing=await strictFile(join(dir,name),LIMIT_BYTES);
        if(sha(existing)!==name.slice(0,-5))invalid();
        await unlink(stage);
        dataStageOwned=false;
      }
      await syncDirectory(dir);
      await guard();
      const pointer:Pointer={schemaVersion:1,rootId:this.root.id,filename:name,sha256:name.slice(0,-5)};
      pointerStage=join(dir,'.stage-'+randomUUID());
      await persist(pointerStage,Buffer.from(canonical(pointer),'utf8'));
      await guard();
      // The pointer rename is asynchronous. Suppress every reader until
      // publication, durability and final freshness are confirmed.
      state.blocked=true;
      try{await rename(pointerStage,join(dir,CURRENT));pointerStage=null;}
      catch{this.poisoned=true;invalid();}
      this.generation=next;this.committedName=name;
      this.epoch=Symbol();state.epoch=this.epoch;state.name=name;
      state.sources=new Set(next.entries.map(e=>e.sourcePath));
      if(signal.aborted||state.revision!==revision){this.poisoned=true;invalid();}
      try{await syncDirectory(dir);}
      catch{this.poisoned=true;invalid();}
      if(next.schemaVersion===2)await this.verifyApi(next,signal);
      await this.discardUnpublished((await readdir(dir)).filter(n=>n!==CURRENT&&n!==name),dir);
      if(next.schemaVersion===2)await this.verifyApi(next,signal);
      if(signal.aborted||state.revision!==revision){this.poisoned=true;invalid();}
      return structuredClone(next);
    }catch(error){
      if(this.committedName===name&&this.generation===next){this.poisoned=true;state.blocked=true;}
      // A pre-CURRENT cancellation must not accumulate unbounded pointer
      // stages and eventually poison cold recovery. Remove only our newly
      // created, authenticated stage files; ambiguous CURRENT stays poisoned.
      if(!this.poisoned){
        for(const file of [pointerStage,dataStageOwned?stage:null,
          next.schemaVersion===2&&newFileOwned&&this.committedName!==name?join(dir,name):null]){
          if(!file)continue;
          try{
            const stat=await lstat(file);
            if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
              ||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)invalid();
            await unlink(file);
          }catch(cleanupError){
            if((cleanupError as NodeJS.ErrnoException).code==='ENOENT')continue;
            this.poisoned=true;invalid();
          }
        }
        try{await syncDirectory(dir);}catch{this.poisoned=true;invalid();}
      }
      if(error instanceof ModelError)throw error;
      throw new ModelError('INDEX_PUBLICATION_UNCERTAIN');
    }
       });
      // Keep the new generation unavailable until all asynchronous directory
      // operations, including descriptor close, have completed.
      if(signal.aborted||state.revision!==revision){this.poisoned=true;invalid();}
      state.revoked.clear();state.blocked=false;
      return result;
    } catch (error) {
      if(state.blocked)this.poisoned=true;
      if(error instanceof IngestError){this.poisoned=true;invalid();}
      throw error;
    } finally { activeWriters.delete(this.path); }
  }
}
