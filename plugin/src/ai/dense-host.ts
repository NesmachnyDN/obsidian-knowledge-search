/** Internal host-owned API dense operation/consent boundary (D6).
 * No persistent consent, provider calls at startup, or public machine API. */
import { randomUUID } from 'node:crypto';
import { canonical } from '../advanced/protocol';
import { AdvancedRetrievalStore } from '../advanced/retrieval-storage';
import { trustedVaultRoot } from '../advanced/source';
import { BOUNDS, hash, isRecord, validPath, validateRequest, type EvidenceHit, type SearchRequest } from '../standalone/contracts';
import type { SelectedCorpus, StandaloneEngine } from '../standalone/engine';
import { ProviderFailure, type EmbeddingSpace, type ProviderConfig, type ProviderPreference } from './contracts';
import { configDigest } from './disclosure';
import { MAX_API_VECTORS } from './dense-generation';
import { ApiDenseIndexManager, INDEX_PURPOSE_TEXT, type DenseIndexGrantInput, type DenseIndexResult } from './dense-index-manager';
import { ApiDenseSearch, type ApiRetrievalResult } from './dense-retrieval';
import type { EmbeddingApproval } from './embedding-evidence';
import { embeddingSpaceId, validateEmbeddingSpace } from './embedding-space';
import { pilotConfig } from './loopback-json';

export type DenseRequest = { paths: readonly string[]; space: EmbeddingSpace } &
  ({kind:'rebuild'} | {kind:'search';request:SearchRequest&{requestedMode:'dense'|'hybrid'}});
export type DensePreview = { nonce:string; scopeId:string; lexicalGenerationId:string;
  expiresUnixMs:number; config:ProviderConfig; operation:DenseRequest; evidence:readonly EvidenceHit[] };
export type MachineFence = {digest:string;expiresUnixMs:number};
type Classification = 'synthetic'|'public';
type Binding = { preview:DensePreview; lease:SelectedCorpus; abort:AbortController; current():boolean };
type HostPort = { config():ProviderPreference; enabled():boolean; allowedPath(path:string):boolean; admitStorage():Promise<void> };
const fail = (code:ConstructorParameters<typeof ProviderFailure>[0]):never => { throw new ProviderFailure(code); };

export class ApiDenseHost {
  private revision=0;
  private disposed=false;
  private active?:Promise<unknown>;
  private abort?:AbortController;
  private prepared?:Binding;
  private store?:AdvancedRetrievalStore;
  private indexer?:ApiDenseIndexManager;
  private searcher?:ApiDenseSearch;
  constructor(private readonly engine:StandaloneEngine,private readonly rootPath:string,
    private readonly rootId:string,private readonly pluginId:string,private readonly port:HostPort,
    private readonly now=Date.now) {}

  invalidate(path?:string):void {
    ++this.revision;
    this.prepared=undefined;
    this.abort?.abort();
    if(path!==undefined)this.store?.revoke(path);
  }
  async close():Promise<void> {
    this.disposed=true;this.invalidate();
    await this.active?.catch(()=>{});
    this.store=undefined;this.indexer=undefined;this.searcher=undefined;
  }
  private config():ProviderConfig {
    if(this.disposed||!this.port.enabled())return fail('DISABLED');
    const config=this.port.config();
    if(config.state==='disabled')return fail('DISABLED');
    if(config.state!=='configured')return fail('CONFIG_INVALID');
    return pilotConfig(config);
  }
  async prepare(input:DenseRequest,fence?:MachineFence):Promise<DensePreview> {
    if(this.active)return fail('QUOTA_EXCEEDED');
    this.invalidate();
    const config=this.config();
    if(fence&&(configDigest('embedding',config)!==fence.digest||fence.expiresUnixMs<=this.now()))
      return fail('CANCELLED');
    if(!isRecord(input)||!['rebuild','search'].includes(input.kind)
      ||Object.keys(input).some(key=>!['kind','paths','space',...(input.kind==='search'?['request']:[])].includes(key))
      ||!Array.isArray(input.paths)||!input.paths.length||input.paths.length>BOUNDS.sources
      ||input.paths.some(path=>!validPath(path))||new Set(input.paths).size!==input.paths.length)
      return fail('CONFIG_INVALID');
    const operation=structuredClone(input);
    operation.space=validateEmbeddingSpace(config,operation.space);
    if(operation.kind==='search'){
      try{validateRequest(operation.request);}catch{return fail('CONFIG_INVALID');}
      if(!['dense','hybrid'].includes(operation.request.requestedMode)||!operation.request.query.trim()
        ||operation.request.requestedMode==='dense'&&operation.request.matchMode==='literal')
        return fail('CONFIG_INVALID');
    }else if(operation.kind!=='rebuild')return fail('CONFIG_INVALID');
    const revision=this.revision,abort=new AbortController(),expiresUnixMs=Math.min(this.now()+300000,fence?.expiresUnixMs??Infinity);
    this.abort=abort;
    const digest=configDigest('embedding',config);
    let revoked=false;
    const current=():boolean=>{
      try{
        if(this.disposed||abort.signal.aborted||revision!==this.revision||this.now()>=expiresUnixMs
          ||configDigest('embedding',this.config())!==digest
          ||!operation.paths.every(path=>this.port.allowedPath(path)))revoked=true;
      }catch{revoked=true;}
      return !revoked;
    };
    const job=(async()=>{
      if(!current())return fail('DISCLOSURE_DENIED');
      const lease=await this.engine.captureDenseCorpus(operation.paths,MAX_API_VECTORS,abort.signal);
      if(!current()||!lease.current()||lease.rootId!==this.rootId)return fail('SOURCE_STALE');
      const preview:DensePreview={nonce:randomUUID(),scopeId:lease.rootId,
        lexicalGenerationId:lease.lexicalGenerationId,expiresUnixMs,config,operation,evidence:structuredClone(lease.evidence)};
      this.prepared={preview,lease,abort,current:()=>current()&&lease.current()};
      return structuredClone(preview);
    })();
    this.active=job;
    try{return await job;}
    finally{if(this.active===job)this.active=undefined;}
  }
  /** Reuse the authoritative corpus and store verification at deferred result delivery.
   * No new disclosure, provider operation or independent source parser. */
  async verifyMachineResult(operation:Extract<DenseRequest,{kind:'search'}>,fence:MachineFence,
    result:ApiRetrievalResult,signal:AbortSignal):Promise<()=>boolean> {
    if(this.active||!this.store)return fail('NOT_READY');
    const revision=this.revision,store=this.store,abort=new AbortController();
    const cancel=()=>abort.abort();
    signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted)cancel();
    const current=()=>!this.disposed&&!abort.signal.aborted&&revision===this.revision
      &&this.now()<fence.expiresUnixMs&&this.store===store
      &&configDigest('embedding',this.config())===fence.digest
      &&operation.paths.every(path=>this.port.allowedPath(path));
    const check=()=>{if(!current())fail('SOURCE_STALE');};
    this.abort=abort;
    const job=(async()=>{
      check();
      const config=this.config(),spaceId=embeddingSpaceId(config,operation.space);
      const lease=await this.engine.captureDenseCorpus(operation.paths,MAX_API_VECTORS,abort.signal);
      check();
      if(!lease.current()||lease.rootId!==this.rootId||lease.lexicalGenerationId!==result.lexicalGenerationId)
        return fail('SOURCE_STALE');
      const snapshot=await store.snapshotApi(spaceId,lease.lexicalGenerationId,abort.signal);
      check();
      if(!snapshot||snapshot.generationId!==result.indexGenerationId||!lease.current()
        ||!store.isApiSnapshotCurrent(snapshot))return fail('SOURCE_STALE');
      return ()=>current()&&!signal.aborted&&lease.current()&&store.isApiSnapshotCurrent(snapshot);
    })();
    this.active=job;
    try{const verify=await job;if(!verify())return fail('SOURCE_STALE');return verify;}
    catch{return fail('SOURCE_STALE');}
    finally{
      signal.removeEventListener('abort',cancel);
      if(this.active===job)this.active=undefined;
      if(this.abort===abort)this.abort=undefined;
    }
  }
  async confirm(preview:DensePreview,classification:Classification,token:string):Promise<DenseIndexResult|ApiRetrievalResult> {
    if(this.active)return fail('QUOTA_EXCEEDED');
    const binding=this.prepared;this.prepared=undefined;
    if(!binding||!['synthetic','public'].includes(classification))return fail('DISCLOSURE_DENIED');
    try{if(canonical(binding.preview)!==canonical(preview))return fail('DISCLOSURE_DENIED');}
    catch{return fail('DISCLOSURE_DENIED');}
    const {preview:approved,lease,abort,current}=binding;
    if(!current())return fail('CANCELLED');
    const {config,operation,scopeId,expiresUnixMs}=approved,space=operation.space;
    const exact=new Set(lease.evidence.map(hit=>canonical(hit)));
    const allowed=(hit:EvidenceHit):boolean=>current()&&this.port.allowedPath(hit.sourceId)&&exact.has(canonical(hit));
    const grant=(purpose:'query'|'document',query:string,evidence:readonly EvidenceHit[]):EmbeddingApproval=>{
      if(!current()||!evidence.every(allowed))return fail('DISCLOSURE_DENIED');
      return {purpose,config,space,scopeId,query:{text:query,classification},
        candidates:evidence.map(hit=>({hit,classification})),
        grant:{version:1,role:'embedding',purpose,spaceId:embeddingSpaceId(config,space),
          configDigest:configDigest('embedding',config),scopeId,expiresUnixMs,
          queryDigest:hash(query),queryClassification:classification,
          sources:evidence.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,
            excerptDigest:hash(hit.originalExcerpt),classification}))}};
    };
    const job=(async()=>{
      try{await this.port.admitStorage();}catch{return fail('NOT_READY');}
      if(!current())return fail('CANCELLED');
      const root=await trustedVaultRoot(this.rootPath);
      if(root.id!==scopeId||!current())return fail('SOURCE_STALE');
      const store=this.store??await AdvancedRetrievalStore.open(root,this.pluginId);
      this.store=store;
      this.indexer??=new ApiDenseIndexManager(this.engine,store);
      this.searcher??=new ApiDenseSearch(store);
      if(!current())return fail('CANCELLED');
      const context={signal:abort.signal,deadlineUnixMs:expiresUnixMs};
      if(operation.kind==='rebuild'){
        const authorize=(input:DenseIndexGrantInput):EmbeddingApproval=>{
          if(input.scopeId!==scopeId||input.query!==INDEX_PURPOSE_TEXT
            ||configDigest('embedding',input.config)!==configDigest('embedding',config)
            ||embeddingSpaceId(input.config,input.space)!==embeddingSpaceId(config,space))
            return fail('DISCLOSURE_DENIED');
          return grant('document',input.query,input.evidence);
        };
        return this.indexer.rebuild(
          {paths:operation.paths,config,space},token,context,{current,allowed,authorize});
      }
      return this.searcher.run({request:operation.request,lexicalGenerationId:lease.lexicalGenerationId,
        evidence:lease.evidence,approval:grant('query',operation.request.query,[])},token,context,
        {current,allowed,lexical:req=>this.engine.search(req),metadataPaths:lease.metadataPaths});
    })();
    this.active=job;
    try{return await job;}
    finally{if(this.active===job)this.active=undefined;if(this.abort===abort)this.abort=undefined;}
  }
}
