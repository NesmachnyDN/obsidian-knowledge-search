import { ProviderFailure, type ProviderFailureCode } from './contracts';
import type { ApiDenseHost, DensePreview, DenseRequest, MachineFence } from './dense-host';
import type { DenseIndexResult } from './dense-index-manager';
import type { ApiRetrievalResult } from './dense-retrieval';
import type { EvidenceHit } from '../standalone/contracts';

type Result = DenseIndexResult | ApiRetrievalResult;
type Classification = 'synthetic' | 'public';
type State = {phase:'idle'|'preparing'|'running'|'error'; error?:ProviderFailureCode}
  | {phase:'preview'; preview:DensePreview} | {phase:'complete'; result:Result};
type Host = Pick<ApiDenseHost,'prepare'|'confirm'|'invalidate'>;
type Port = {host():Host|undefined; revokeNavigation():void; navigate(hit:EvidenceHit):Promise<void>};
const errorCode=(error:unknown):ProviderFailureCode=>error instanceof ProviderFailure?error.code:'NOT_READY';

/** One view-owned operation at a time; all other views observe revocation.
 * The host, not this UI coordinator, owns consent, disclosure and index leases. */
export class DenseUiController {
  private owner?:symbol;
  private host?:Host;
  private revision=0;
  private state:State={phase:'idle'};
  private timer?:ReturnType<typeof setTimeout>;
  private disposed=false;
  private listeners=new Set<()=>void>();
  constructor(private readonly port:Port){}
  subscribe(listener:()=>void):()=>void {
    if(this.disposed)return ()=>{};
    this.listeners.add(listener);
    return ()=>this.listeners.delete(listener);
  }
  snapshot(owner:symbol):State {
    return this.owner===owner?structuredClone(this.state):{phase:'idle'};
  }
  /** Only bounded metadata is copied for machine status polling. */
  metadata(owner:symbol):{phase:State['phase'];error?:ProviderFailureCode|null;
    executedMode?:ApiRetrievalResult['executedMode'];legs?:ApiRetrievalResult['legs']} {
    if(this.owner!==owner)return {phase:'idle'};
    const state=this.state;
    if(state.phase==='complete'&&'hits' in state.result)return {phase:state.phase,error:state.result.error,
      executedMode:state.result.executedMode,legs:structuredClone(state.result.legs)};
    if(state.phase==='error')return {phase:state.phase,error:state.error??'NOT_READY'};
    return {phase:state.phase};
  }
  occupied():boolean {return this.owner!==undefined;}
  owns(owner:symbol):boolean {return this.owner===owner;}
  private emit():void {for(const listener of this.listeners)listener();}
  private clearTimer():void {if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;}
  invalidate():void {
    if(this.owner===undefined&&!this.host)return;
    ++this.revision;
    this.clearTimer();
    this.host?.invalidate();
    this.host=undefined;
    this.port.revokeNavigation();
    this.owner=undefined;
    this.state={phase:'idle'};
    this.emit();
  }
  cancel(owner:symbol):void {if(this.owner===owner)this.invalidate();}
  dispose():void {this.disposed=true;this.invalidate();this.listeners.clear();}
  private current(owner:symbol,revision:number,host:Host):boolean {
    return !this.disposed&&this.owner===owner&&this.revision===revision
      &&this.host===host&&this.port.host()===host;
  }
  async prepare(owner:symbol,request:DenseRequest,fence?:MachineFence):Promise<void> {
    if(this.disposed)return;
    this.invalidate();
    const revision=this.revision,host=this.port.host();
    this.owner=owner;
    if(!host){this.state={phase:'error',error:'NOT_READY'};this.emit();return;}
    this.host=host;this.state={phase:'preparing'};this.emit();
    try {
      const preview=await host.prepare(structuredClone(request),fence);
      if(!this.current(owner,revision,host))return;
      if(preview.expiresUnixMs<=Date.now())throw new ProviderFailure('CANCELLED');
      this.state={phase:'preview',preview:structuredClone(preview)};
      this.timer=setTimeout(()=>{if(this.current(owner,revision,host))this.invalidate();},
        Math.max(0,preview.expiresUnixMs-Date.now()));
      this.emit();
    }catch(error){
      if(this.current(owner,revision,host)){this.state={phase:'error',error:errorCode(error)};this.emit();}
    }
  }
  async confirm(owner:symbol,nonce:string,classification:Classification,token:string):Promise<void> {
    const host=this.host,revision=this.revision;
    if(!host||!this.current(owner,revision,host)||this.state.phase!=='preview'
      ||this.state.preview.nonce!==nonce||!['synthetic','public'].includes(classification))return;
    const preview=this.state.preview;
    if(preview.expiresUnixMs<=Date.now()){this.invalidate();return;}
    this.clearTimer();this.state={phase:'running'};this.emit();
    try {
      const result=await host.confirm(structuredClone(preview),classification,token);
      if(this.current(owner,revision,host)){
        this.state={phase:'complete',result:structuredClone(result)};this.emit();
      }
    }catch(error){
      if(this.current(owner,revision,host)){this.state={phase:'error',error:errorCode(error)};this.emit();}
    }
  }
  async open(owner:symbol,index:number,expected:EvidenceHit):Promise<boolean> {
    const host=this.host,revision=this.revision;
    if(!host||!this.current(owner,revision,host)||this.state.phase!=='complete')return false;
    const result=this.state.result;
    if(!('hits' in result)||result.status!=='ok'||!Number.isInteger(index))return false;
    const hit=result.hits[index]?.evidence;
    if(!hit||JSON.stringify(hit)!==JSON.stringify(expected))return false;
    try{
      await this.port.navigate(structuredClone(hit));
      return this.current(owner,revision,host);
    }catch{
      if(this.current(owner,revision,host)){
        this.invalidate();this.owner=owner;this.state={phase:'error',error:'SOURCE_STALE'};this.emit();
      }
      return false;
    }
  }
}
