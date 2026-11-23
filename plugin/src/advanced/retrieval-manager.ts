/** Opt-in coordinator; one source-version universe across ingestion, lexical and dense. */
import { AdvancedIngestionManager } from './manager';
import { type IngestResponse } from './protocol';
import { type IngestionConfig } from '../search/settings';
import { trustedVaultRoot, type TrustedVaultRoot } from './source';
import { AdvancedRetrievalStore, type IndexedSource } from './retrieval-storage';
import { ModelError, CHUNK_TOKENIZER_FINGERPRINT } from './model-protocol';
import { rankAdvanced, type RetrievalRequest, type RetrievalResponse, validateAdvancedQuery,
  type AdvancedEvidenceHit } from './retrieval';
import { canonical } from './protocol';

export type RetrievalStatus={
  status:'disabled'|'unavailable'|'indexing'|'indexed'|'searching'|'ready'|'failed';
  error:string|null;indexedSources:number;indexedChunks:number;
  lexical:'unavailable'|'ready';dense:'unavailable'|'not-ready'|'ready'|'failed';
};
const initial=():RetrievalStatus=>({status:'disabled',error:null, indexedSources:0,
  indexedChunks:0,lexical:'unavailable',dense:'unavailable'});
export class AdvancedRetrievalManager {
  private store?:AdvancedRetrievalStore;
  private root?:TrustedVaultRoot;
  private active?:Promise<unknown>;
  private controller?:AbortController;
  private activePath?:string;
  private revision=0;
  private disposed=false;
  private status:RetrievalStatus=initial();
  constructor(private readonly ingestion:AdvancedIngestionManager){}
  snapshot():RetrievalStatus{return {...this.status};}
  private refresh():void{
    const generation=this.store?.snapshot();
    this.status.indexedSources=generation?.entries.length??0;
    this.status.indexedChunks=generation?.entries.reduce((n,e)=>n+e.chunkIds.length,0)??0;
  }
  invalidate(path:string):void{
    const affected=this.store?.snapshot()?.entries.some(e=>e.sourcePath===path
      ||e.sourcePath.startsWith(path+'/'))??false;
    if(affected||this.activePath===path||this.active){
      ++this.revision;
      this.controller?.abort();
      if(this.active)void this.ingestion.runner.stop().catch(()=>{
        this.status={...this.status,status:'failed',error:'MODEL_UNAVAILABLE',dense:'failed'};
      });
    }
    this.store?.revoke(path);
    this.refresh();
    if(affected){this.status.dense='not-ready';this.status.status='unavailable';}
  }
  private async recover(rootPath:string,pluginId:string):Promise<void>{
    if(this.disposed)throw new ModelError('MODEL_UNAVAILABLE');
    const root=await trustedVaultRoot(rootPath);
    if(this.root&&this.root.id!==root.id)throw new ModelError('SOURCE_STALE');
    if(!this.store)this.store=await AdvancedRetrievalStore.open(root,pluginId);
    this.root=root;
    // A cold restart may rehydrate an older CURRENT after an in-memory event
    // revocation. Before advertising an eligible dense generation, independently
    // reconcile ALL indexed source identities against authenticated v3 evidence.
    await this.ingestion.recover(rootPath,pluginId);
    const valid=await this.ingestion.verifiedAll(()=>true);
    const versions=new Map(valid.documents.filter(x=>x.source&&x.generationId)
      .map(x=>[x.source!.vaultRelativePath,[x.source!.sha256,x.generationId!] as const]));
    for(const entry of this.store.snapshot()?.entries??[]){
      const version=versions.get(entry.sourcePath);
      if(!version||version[0]!==entry.sourceSha256||version[1]!==entry.ingestGenerationId)
        this.store.revoke(entry.sourcePath);
    }
    this.refresh();
  }
  private async version(path:string,authorized:()=>boolean):Promise<IngestResponse>{
    const response=await this.ingestion.verified(path,authorized);
    if(!response||!response.source||!['ok','partial'].includes(response.status)
        ||!response.chunks.length||!response.generationId||!authorized())
      throw new ModelError('SOURCE_UNAVAILABLE');
    return response;
  }
  async index(config:IngestionConfig,rootPath:string,pluginId:string,path:string,
    authorized:()=>boolean,rebuild=false):Promise<void>{
    if(this.disposed||!config.enabled)throw new ModelError('MODEL_UNAVAILABLE');
    if(this.active)throw new ModelError('MODEL_BUSY');
    const revision=++this.revision,abort=new AbortController();
    this.controller=abort;this.activePath=path;
    const job=(async()=>{
      try{
        const stillActive=()=>{
          if(abort.signal.aborted||revision!==this.revision||!config.enabled||!authorized())
            throw new ModelError('MODEL_CANCELLED');
        };
        await this.recover(rootPath,pluginId);
        stillActive();
        const initial=await this.version(path,authorized),source=initial.source!;
        stillActive();
        if(source.scopeId!==this.root!.id)throw new ModelError('INDEX_INCOMPATIBLE');
        const existing=this.store!.snapshot()?.entries.find(e=>e.sourcePath===path);
        if(initial.chunks.length>64
           ||this.status.indexedChunks-(existing?.chunkIds.length??0)+initial.chunks.length>256)
          throw new ModelError('INDEX_LIMIT');
        if(initial.chunks.some(c=>c.tokenizerFingerprint!==CHUNK_TOKENIZER_FINGERPRINT
          ||c.effectiveTokenCount>384||c.effectiveTokenCount<1))
          throw new ModelError('TOKENIZER_INCOMPATIBLE');
        stillActive();
        this.status={...this.status,status:'indexing',error:null,dense:'not-ready'};
        const reply=await this.ingestion.runner.embed(config,initial.chunks.map(c=>c.contextualText));
        if(abort.signal.aborted||revision!==this.revision)throw new ModelError('MODEL_CANCELLED');
        const identity=reply.identity!;
        const entry:IndexedSource={sourcePath:path,sourceSha256:source.sha256,
          ingestGenerationId:initial.generationId!,profileId:source.profileId,
          tokenizerFingerprint:initial.chunks[0]!.tokenizerFingerprint,
          chunkIds:initial.chunks.map(c=>c.chunkId),vectors:reply.vectors};
        const check=async()=>{
          if(abort.signal.aborted||revision!==this.revision||!config.enabled||!authorized())
            throw new ModelError('MODEL_CANCELLED');
          const now=await this.version(path,authorized);
          if(abort.signal.aborted||revision!==this.revision||!config.enabled||!authorized())
            throw new ModelError('MODEL_CANCELLED');
          if(!now.source||now.source.sha256!==source.sha256||now.generationId!==initial.generationId
            ||now.chunks.map(c=>c.chunkId).join('|')!==entry.chunkIds.join('|'))
            throw new ModelError('SOURCE_STALE');
        };
        await check();
        await this.store!.publish(entry,identity,check,abort.signal,rebuild);
        this.refresh();
        this.status={...this.status,status:'indexed',error:null,dense:'not-ready',lexical:'ready'};
      }catch(error){
        this.status={...this.status,status:'failed',error:error instanceof ModelError?error.code:'MODEL_FAILED',
          dense:'failed'};
        throw error instanceof ModelError?error:new ModelError('MODEL_FAILED');
      }
    })();
    this.active=job;
    try{await job;}finally{if(this.active===job)this.active=undefined;
      if(this.controller===abort)this.controller=undefined;this.activePath=undefined;}
  }
  async search(config:IngestionConfig,rootPath:string,pluginId:string,
    request:RetrievalRequest,authorized:(path:string)=>boolean):Promise<RetrievalResponse>{
    validateAdvancedQuery(request);
    if(this.disposed||!config.enabled)throw new ModelError('MODEL_UNAVAILABLE');
    if(this.active)throw new ModelError('MODEL_BUSY');
    const revision=++this.revision,abort=new AbortController();
    this.controller=abort;
    const job=(async()=>{
      try{
        const stillActive=()=>{
          if(abort.signal.aborted||revision!==this.revision||!config.enabled)
            throw new ModelError('MODEL_CANCELLED');
        };
        await this.recover(rootPath,pluginId);
        stillActive();
        await this.ingestion.recover(rootPath,pluginId);
        stillActive();
        this.status={...this.status,status:'searching',error:null};
        const before=await this.ingestion.verifiedAll(authorized);
        stillActive();
        let queryVector:number[]|null=null;
        const generation=this.store!.snapshot();
        if(request.requestedMode!=='lexical'){
          stillActive();
          if(!generation||!generation.entries.length)
            throw new ModelError('CAPABILITY_UNAVAILABLE');
          const reply=await this.ingestion.runner.embed(config,[request.query],
            generation.model.effective_max_tokens);
          if(canonical(generation.model)!==canonical(reply.identity))
            throw new ModelError('MODEL_INCOMPATIBLE');
          queryVector=reply.vectors[0]!;
        }
        if(abort.signal.aborted||revision!==this.revision)throw new ModelError('MODEL_CANCELLED');
        // No stale/renamed/modified source can be handed out after expensive inference.
        const after=await this.ingestion.verifiedAll(authorized);
        const fingerprint=(documents:IngestResponse[])=>canonical(documents.map(d=>
          [d.source?.sourceId,d.source?.sha256,d.generationId,d.chunks.map(c=>c.chunkId)]).sort());
        if(fingerprint(before.documents)!==fingerprint(after.documents)
            ||abort.signal.aborted||revision!==this.revision
            ||(generation?.generationId??null)!==(this.store!.snapshot()?.generationId??null))
          throw new ModelError('SOURCE_STALE');
        const result=rankAdvanced({documents:after.documents.map(response=>({response})),
          generation,queryVector,request,staleCount:after.staleCount});
        if(result.status==='failed'){
          this.status={...this.status,status:'failed',error:result.error,dense:'failed'};
        }else{
          this.status={...this.status,status:'ready',error:null,lexical:'ready',
            dense:request.requestedMode==='lexical'?'not-ready':'ready'};
        }
        return result;
      }catch(error){
        const code=error instanceof ModelError?error.code:'MODEL_FAILED';
        this.status={...this.status,status:'failed',error:code,dense:'failed'};
        return {protocolVersion:4 as const,status:'failed' as const,requestedMode:request.requestedMode,
          executedMode:'none' as const,error:code,indexGenerationId:null,hits:[],
          legs:{lexical:{status:'unavailable' as const,error:null,candidateCount:0},
            dense:{status:'failed' as const,error:code,candidateCount:0}},staleSourceCount:0};
      }
    })();
    this.active=job;
    try{return await job;}finally{if(this.active===job)this.active=undefined;
      if(this.controller===abort)this.controller=undefined;}
  }
  async verifyHit(hit:AdvancedEvidenceHit,path:string,authorized:()=>boolean):Promise<void>{
    if(this.disposed||hit.sourceId!==path||!authorized()||!this.store)
      throw new ModelError('SOURCE_STALE');
    const response=await this.ingestion.verified(path,authorized);
    const snapshot=this.store.snapshot();
    if(!response||!response.source||response.source.sha256!==hit.sourceSha256
        ||hit.vaultRelativeReference!==path||hit.sourceLocators.length!==1
        ||!hit.originalExcerpt||!hit.chunkId
        ||hit.retrievalMode!=='lexical'&&hit.indexGenerationId!==snapshot?.generationId)
      throw new ModelError('SOURCE_STALE');
    const chunk=response.chunks.find(c=>c.chunkId===hit.chunkId);
    if(!chunk)throw new ModelError('EVIDENCE_INVALID');
    const loc=hit.sourceLocators[0]!;
    let found=false;
    for(const [i,slice] of chunk.sourceSlices.entries()){
      const block=response.source.blocks[slice.blockOrder];
      if(!block)continue;
      const candidate=chunk.sourceLocators[i];
      const original=Array.from(block.originalText).slice(slice.charStart,slice.charEnd).join('');
      if(candidate&&canonical(candidate)===canonical(loc)&&original===hit.originalExcerpt
         &&loc.locatorKind!=='unavailable'&&block.textNature==='verbatim')found=true;
      if(block.textNature==='table-cell-serialization'){
        for(const cell of block.cells){
          if(canonical(cell.locator)===canonical(loc)&&cell.originalText===hit.originalExcerpt
            &&loc.locatorKind==='native')found=true;
        }
      }
    }
    if(!found)throw new ModelError('EVIDENCE_INVALID');
    if(!authorized()||!(await this.ingestion.verified(path,authorized)))
      throw new ModelError('SOURCE_STALE');
  }
  async stop():Promise<void>{
    ++this.revision;this.controller?.abort();
    try{await this.ingestion.runner.stop();await this.active?.catch(()=>{});this.status=initial();}
    catch{this.status={...this.status,status:'failed',error:'MODEL_UNAVAILABLE'};
      throw new ModelError('MODEL_UNAVAILABLE');}
  }
  async dispose():Promise<void>{this.disposed=true;return this.stop();}
}
