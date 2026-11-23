/** Durable v4 retrieval generation bound to canonical v3 source/chunk identities.
 * No Vault writes; same 05C atomic publication helpers and private XDG root.
 */
import { lstat, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TrustedVaultRoot } from './source';
import { privateIndexPath } from '../standalone/source';
import { canonical, sha, validRelative } from './protocol';
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
    if(path===root.path||path.startsWith(root.path+sep))invalid();
    await mkdir(path,{recursive:true,mode:0o700});
    const dir=await lstat(path);
    if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid?.()||(dir.mode&0o077)!==0)invalid();
    const store=new AdvancedRetrievalStore(root,path);
    await store.load();
    return store;
  }
  /** No CURRENT means no committed index. Authenticate abandoned first-publish
   * artifacts before removing them; never promote an orphan into search visibility.
   * An existing but corrupt CURRENT is never recovered through this path.
   */
  private async discardUnpublished(names:string[]):Promise<void>{
    if(names.includes(CURRENT))invalid();
    const generations=names.filter(x=>genPattern.test(x));
    for(const name of generations){
      const bytes=await strictFile(join(this.path,name),LIMIT_BYTES);
      if(sha(bytes)!==name.slice(0,-5))invalid();
      validateRetrievalGeneration(parseCanonical(bytes),this.root.id);
    }
    for(const name of names.filter(x=>stagePattern.test(x))){
      const info=await lstat(join(this.path,name));
      if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1
          ||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)invalid();
    }
    for(const name of names)await unlink(join(this.path,name));
    if(names.length)await syncDirectory(this.path);
  }
  private async load():Promise<void>{
    const names=await readdir(this.path);
    if(names.length>12||names.some(x=>x!==CURRENT&&!genPattern.test(x)&&!stagePattern.test(x)))invalid();
    if(!names.includes(CURRENT)){
      await this.discardUnpublished(names);
      return;
    }
    const ptr=parseCanonical(await strictFile(join(this.path,CURRENT),2048)) as Pointer;
    if(!ptr||Object.keys(ptr).sort().join('|')!==['schemaVersion','rootId','filename','sha256'].sort().join('|')
        ||ptr.schemaVersion!==1||ptr.rootId!==this.root.id||!genPattern.test(ptr.filename)
        ||ptr.sha256!==ptr.filename.slice(0,-5))invalid();
    const bytes=await strictFile(join(this.path,ptr.filename),LIMIT_BYTES);
    if(sha(bytes)!==ptr.sha256)invalid();
    const value=parseCanonical(bytes);
    validateRetrievalGeneration(value,this.root.id);
    this.generation=value;
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
    verifyIdentity(model);
    const old=this.generation;
    // First-publish abort/crash can leave an immutable generation with no
    // CURRENT. Clear only fully authenticated unpublished derived artifacts.
    if(!old){
      const names=await readdir(this.path);
      if(names.length>12||names.some(x=>x!==CURRENT&&!genPattern.test(x)&&!stagePattern.test(x))
          ||names.includes(CURRENT))invalid();
      await this.discardUnpublished(names);
    }
    if(old&&!rebuild&&canonical(old.model)!==canonical(model))invalid();
    const entries=[...(rebuild?[]:old?.entries??[]).filter(x=>x.sourcePath!==entry.sourcePath),entry]
      .sort((a,b)=>cmp(a.sourcePath,b.sourcePath));
    const base={schemaVersion:1 as const,rootId:this.root.id,model,entries};
    const next:RetrievalGeneration={...base,generationId:generationDigest(base)};
    validateRetrievalGeneration(next,this.root.id);
    const payload=Buffer.from(canonical(next),'utf8');
    if(payload.byteLength>LIMIT_BYTES)throw new ModelError('INDEX_LIMIT');
    const name=sha(payload)+'.json',stage=join(this.path,'.stage-'+randomUUID());
    const guard=async()=>{
      if(signal.aborted)throw new ModelError('MODEL_CANCELLED');
      await check();
    };
    await guard();
    try{
      await persist(stage,payload);
      if(!(await readdir(this.path)).includes(name))await rename(stage,join(this.path,name));
      else{
        const existing=await strictFile(join(this.path,name),LIMIT_BYTES);
        if(sha(existing)!==name.slice(0,-5))invalid();
        await unlink(stage);
      }
      await syncDirectory(this.path);
      await guard();
      const pointer:Pointer={schemaVersion:1,rootId:this.root.id,filename:name,sha256:name.slice(0,-5)};
      const pstage=join(this.path,'.stage-'+randomUUID());
      await persist(pstage,Buffer.from(canonical(pointer),'utf8'));
      await guard();
      try{await rename(pstage,join(this.path,CURRENT));}
      catch{this.poisoned=true;invalid();}
      // New version is now the only visible in-memory generation.
      this.generation=next;
      try{await syncDirectory(this.path);}
      catch{this.poisoned=true;invalid();}
      for(const oldName of await readdir(this.path))
        if(genPattern.test(oldName)&&oldName!==name)
          await unlink(join(this.path,oldName)).catch(()=>{});
      return structuredClone(next);
    }catch(error){
      if(error instanceof ModelError)throw error;
      throw new ModelError('INDEX_PUBLICATION_UNCERTAIN');
    }
  }
}
