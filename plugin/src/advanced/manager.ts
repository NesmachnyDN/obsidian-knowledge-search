/** Explicit user-controlled ingestion of one authorized Obsidian TFile at a time. */
import { AdvancedIngestRunner } from './runner';
import { readSource, trustedVaultRoot, type TrustedVaultRoot } from './source';
import { AdvancedGenerationStore } from './storage';
import { verifyProvenance } from './provenance';
import { IngestError, type IngestResponse, type IngestProfile } from './protocol';
import type { IngestionConfig } from '../search/settings';

export type IngestionStatus = {
  status: 'disabled'|'unavailable'|'running'|'ready'|'partial'|'failed'|'empty'|'unsupported';
  error: string | null; lastFormat: 'markdown'|'pdf'|'docx'|null;
  // Not a retrieval capability; no model or search readiness claim.
  searchReady: false;
};
const unavailable = (): IngestionStatus =>
  ({status:'disabled',error:null,lastFormat:null,searchReady:false});
export const selectProfile=(path:string,pdfMode:IngestionConfig['pdfMode']):IngestProfile=>{
  const lower=path.toLowerCase();
  if (lower.endsWith('.md')) return 'oks-advanced-markdown-v1';
  if (lower.endsWith('.docx')) return 'docling-docx-2.151.1';
  if (lower.endsWith('.pdf')) {
    return ({
      text:'docling-native-pdf-2.151.1',ocr:'tesseract-cli-5.3.4-eng-rus',
      structured:'docling-heron-tableformer-fast-2.151.1',
      'structured-ocr':'docling-heron-tableformer-fast-tesseract-2.151.1',
    } as Record<IngestionConfig['pdfMode'],IngestProfile>)[pdfMode];
  }
  throw new IngestError('SOURCE_REJECTED');
};

export class AdvancedIngestionManager {
  readonly runner = new AdvancedIngestRunner();
  private store?: AdvancedGenerationStore;
  private root?: TrustedVaultRoot;
  private active?: Promise<IngestResponse>;
  private activePath?: string;
  private lastPath?: string;
  private controller?: AbortController;
  private disposed = false;
  private revision = 0;
  private current: IngestionStatus = unavailable();
  snapshot(): IngestionStatus {
    return { ...this.current, searchReady:false };
  }
  private update(status:IngestionStatus['status'],error:string|null=null,
    lastFormat:IngestionStatus['lastFormat']=null): void {
    this.current={status,error,lastFormat,searchReady:false};
  }
  constructor(private readonly trackRetirement:(work:Promise<void>)=>void=()=>{}){}
  invalidate(path:string): void {
    const store=this.store, owner=this.controller, active=this.active;
    const latest=this.lastPath===path || this.lastPath?.startsWith(path+'/')===true;
    const affected=this.activePath===path || this.activePath?.startsWith(path+'/')===true;
    if(latest) { this.lastPath=undefined;this.update('unavailable','SOURCE_STALE'); }
    if(affected)++this.revision;
    try { store?.revoke(path); }
    finally {
      if(affected&&active){
        try {owner?.abort();}
        finally {
          const work=Promise.allSettled([this.runner.stop(),active]).then(([stopping])=>{
            if(stopping.status==='rejected')throw new IngestError('ADVANCED_UNAVAILABLE');
          });
          this.trackRetirement(work);
          void work.catch(()=>this.update('failed','ADVANCED_UNAVAILABLE'));
        }
      }
    }
  }
  async ingest(config:IngestionConfig, rootPath:string, pluginId:string, path:string,
    isAuthorized:()=>boolean): Promise<IngestResponse> {
    if (this.disposed || !config.enabled) throw new IngestError('ADVANCED_UNAVAILABLE');
    if (this.active) throw new IngestError('ADVANCED_BUSY');
    const token=++this.revision;
    const abort=new AbortController();
    this.controller=abort;
    this.activePath=path;
    const job=(async()=>{
      let format:IngestionStatus['lastFormat']=null;
      try {
        const profile=selectProfile(path,config.pdfMode);
        format=profile==='oks-advanced-markdown-v1'?'markdown':
          profile==='docling-docx-2.151.1'?'docx':'pdf';
        this.update('running',null,format);
        if (!isAuthorized() || abort.signal.aborted) throw new IngestError('SOURCE_REJECTED');
        const root=await trustedVaultRoot(rootPath);
        if (this.root && root.id!==this.root.id) throw new IngestError('SOURCE_STALE');
        if (!this.store) this.store=await AdvancedGenerationStore.open(root,pluginId);
        this.root=root;
        const source=await readSource(root,path);
        if (!isAuthorized() || abort.signal.aborted) throw new IngestError('SOURCE_STALE');
        const response=await this.runner.ingest(config,root,path,source.sha256,profile);
        if (abort.signal.aborted || token!==this.revision || !isAuthorized()) throw new IngestError('ADVANCED_CANCELLED');
        verifyProvenance(response,source.bytes);
        if (response.status==='failed' || response.status==='unsupported') {
          this.update(response.status,response.error,format); return response;
        }
        if (response.status==='empty') {
          this.store.revoke(path); this.update('empty',null,format); return response;
        }
        const fresh=async():Promise<boolean>=>{
          if (!isAuthorized() || abort.signal.aborted || token!==this.revision
              || this.disposed || !config.enabled) return false;
          try {
            const actual=await readSource(root,path);
            return actual.sha256===source.sha256;
          } catch { return false; }
        };
        if (!(await fresh())) throw new IngestError('SOURCE_STALE');
        await this.store.publish(path,response,fresh,abort.signal);
        if (abort.signal.aborted || token!==this.revision || !isAuthorized()) throw new IngestError('ADVANCED_CANCELLED');
        this.lastPath=path;
        this.update(response.status==='ok'?'ready':'partial',null,format);
        return response;
      } catch(error) {
        const code=error instanceof IngestError?error.code:'ADVANCED_UNAVAILABLE';
        this.update('failed',code,format);
        throw error instanceof IngestError?error:new IngestError('ADVANCED_UNAVAILABLE');
      }
    })();
    this.active=job;
    try { return await job; }
    finally { if (this.active===job) { this.active=undefined;this.activePath=undefined; }
      if (this.controller===abort) this.controller=undefined; }
  }
  /** Lazy authenticated cold-start recovery; no backend or parser process is launched. */
  async recover(rootPath:string,pluginId:string):Promise<void> {
    if(this.disposed) throw new IngestError('ADVANCED_UNAVAILABLE');
    if(this.store) return;
    const root=await trustedVaultRoot(rootPath);
    if(this.root && this.root.id!==root.id) throw new IngestError('SOURCE_STALE');
    const store=await AdvancedGenerationStore.open(root,pluginId);
    if(!this.store) {this.store=store;this.root=root;}
  }
  async verifiedAll(isAuthorized:(path:string)=>boolean):Promise<{documents:IngestResponse[];staleCount:number}> {
    if(!this.store) throw new IngestError('ADVANCED_UNAVAILABLE');
    const paths=this.store.paths();
    const documents:IngestResponse[]=[];
    let staleCount=0;
    for(const path of paths){
      const value=await this.verified(path,()=>isAuthorized(path));
      if(value)documents.push(value);else staleCount++;
    }
    return {documents,staleCount};
  }
  /** The caller checks Obsidian TFile authorization before touching source data. */
  async verified(path:string,isAuthorized:()=>boolean):Promise<IngestResponse|null> {
    const result=this.store?.get(path);
    if (!result || !this.root || !isAuthorized() || !result.source) return null;
    try {
      const source=await readSource(this.root,path);
      if (source.sha256!==result.source.sha256 || !isAuthorized()) {
        this.invalidate(path);return null;
      }
      verifyProvenance(result,source.bytes);
      return structuredClone(result);
    } catch { this.invalidate(path);return null; }
  }
  async stop():Promise<void> {
    ++this.revision;
    try {
      const active=this.active;
      try {this.controller?.abort();}
      finally {
        const [stopping]=await Promise.allSettled([this.runner.stop(),active]);
        if(stopping.status==='rejected')throw new IngestError('ADVANCED_UNAVAILABLE');
      }
      this.update('disabled');
    } catch {
      this.update('failed','ADVANCED_UNAVAILABLE');
      throw new IngestError('ADVANCED_UNAVAILABLE');
    }
  }
  dispose():Promise<void> {
    this.disposed=true;
    return this.stop();
  }
}
