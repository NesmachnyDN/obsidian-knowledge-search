/** Durable v4 retrieval generation bound to canonical v3 source/chunk identities.
 * No Vault writes; same 05C atomic publication helpers and private XDG root.
 */
import { lstat, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TrustedVaultRoot } from './source';
import { privateIndexPath } from '../standalone/source';
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
export class AdvancedRetrievalStore {
  readonly path:string;
  private generation:RetrievalGeneration|null=null;
  private poisoned=false;
  private constructor(private readonly root:TrustedVaultRoot,path:string){this.path=path;}
  static async open(root:TrustedVaultRoot,pluginId:string):Promise<AdvancedRetrievalStore>{
    const parent=dirname(privateIndexPath(root.path,root.id,pluginId));
    const path=resolve(parent,'advanced-retrieval');
    const store=new AdvancedRetrievalStore(root,path);
    try { await store.load(); }
    catch (error) { if(error instanceof IngestError)invalid(); throw error; }
    return store;
  }
  /** No CURRENT means no committed index. Authenticate abandoned first-publish
   * artifacts before removing them; never promote an orphan into search visibility.
   * An existing but corrupt CURRENT is never recovered through this path.
   */
  private async discardUnpublished(names:string[], dir:string):Promise<void>{
    if(names.includes(CURRENT))invalid();
    const generations=names.filter(x=>genPattern.test(x));
    for(const name of generations){
      const bytes=await strictFile(join(dir,name),LIMIT_BYTES);
      if(sha(bytes)!==name.slice(0,-5))invalid();
      validateRetrievalGeneration(parseCanonical(bytes),this.root.id);
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
    validateRetrievalGeneration(value,this.root.id);
    this.generation=value;
    });
  }
  snapshot():RetrievalGeneration|null{
    if(this.poisoned)invalid();
    return this.generation?structuredClone(this.generation):null;
  }
  revoke(path:string):void{
    if(!this.generation||!this.generation.entries.some(e=>e.sourcePath===path
      ||e.sourcePath.startsWith(path+'/')))return;
    // Visibility is revoked synchronously on the event path. The newly derived
    // in-memory manifest binds remaining vectors; cold restarts always reverify
    // all participating 05C source versions before any query can advertise ready.
    const entries=this.generation.entries.filter(x=>x.sourcePath!==path
      &&!x.sourcePath.startsWith(path+'/'));
    const base={schemaVersion:1 as const,rootId:this.root.id,model:this.generation.model,entries};
    this.generation={...base,generationId:generationDigest(base)};
  }
  async publish(entry:IndexedSource,model:ModelIdentity,check:()=>Promise<void>,signal:AbortSignal,
    rebuild=false):Promise<RetrievalGeneration>{
    if(this.poisoned)invalid();
    try {
      return await withPrivateDerivedDirectory(this.path,this.root.path,async dir=>{
    verifyIdentity(model);
    const old=this.generation;
    // First-publish abort/crash can leave an immutable generation with no
    // CURRENT. Clear only fully authenticated unpublished derived artifacts.
    if(!old){
      const names=await readdir(dir);
      if(names.length>12||names.some(x=>x!==CURRENT&&!genPattern.test(x)&&!stagePattern.test(x))
          ||names.includes(CURRENT))invalid();
      await this.discardUnpublished(names,dir);
    }
    if(old&&!rebuild&&canonical(old.model)!==canonical(model))invalid();
    const entries=[...(rebuild?[]:old?.entries??[]).filter(x=>x.sourcePath!==entry.sourcePath),entry]
      .sort((a,b)=>cmp(a.sourcePath,b.sourcePath));
    const base={schemaVersion:1 as const,rootId:this.root.id,model,entries};
    const next:RetrievalGeneration={...base,generationId:generationDigest(base)};
    validateRetrievalGeneration(next,this.root.id);
    const payload=Buffer.from(canonical(next),'utf8');
    if(payload.byteLength>LIMIT_BYTES)throw new ModelError('INDEX_LIMIT');
    const name=sha(payload)+'.json',stage=join(dir,'.stage-'+randomUUID());
    const guard=async()=>{
      if(signal.aborted)throw new ModelError('MODEL_CANCELLED');
      await check();
      if(signal.aborted)throw new ModelError('MODEL_CANCELLED');
    };
    await guard();
    let pointerStage:string|null=null;
    let dataStageOwned=false;
    try{
      dataStageOwned=true;
      await persist(stage,payload);
      if(!(await readdir(dir)).includes(name)){
        await rename(stage,join(dir,name));
        dataStageOwned=false;
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
      try{await rename(pointerStage,join(dir,CURRENT));pointerStage=null;}
      catch{this.poisoned=true;invalid();}
      // New version is now the only visible in-memory generation.
      this.generation=next;
      try{await syncDirectory(dir);}
      catch{this.poisoned=true;invalid();}
      for(const oldName of await readdir(dir))
        if(genPattern.test(oldName)&&oldName!==name)
          await unlink(join(dir,oldName)).catch(()=>{});
      return structuredClone(next);
    }catch(error){
      // A pre-CURRENT cancellation must not accumulate unbounded pointer
      // stages and eventually poison cold recovery. Remove only our newly
      // created, authenticated stage files; ambiguous CURRENT stays poisoned.
      if(!this.poisoned){
        for(const file of [pointerStage,dataStageOwned?stage:null]){
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
    } catch (error) {
      if(error instanceof IngestError){this.poisoned=true;invalid();}
      throw error;
    }
  }
}
