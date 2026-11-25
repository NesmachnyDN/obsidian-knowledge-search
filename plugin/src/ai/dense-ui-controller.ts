import { ProviderFailure, type ProviderFailureCode, type AiOperationStatus } from './contracts';
import type { ApiDenseHost, DensePreview, DenseRequest, MachineFence } from './dense-host';
import type { DenseIndexResult } from './dense-index-manager';
import type { ApiRetrievalResult } from './dense-retrieval';
import type { EvidenceHit } from '../standalone/contracts';
import { DenseAuthority } from './dense-authority';

type Result = DenseIndexResult | ApiRetrievalResult;
type Classification = 'synthetic' | 'public';
type State = {phase:'idle'|'preparing'|'running'|'error'; error?:ProviderFailureCode}
  | {phase:'preview'; preview:DensePreview} | {phase:'complete'; result:Result};
type Host = Pick<ApiDenseHost,'prepare'|'confirm'|'invalidate'>;
type Port = {host():Host|undefined; revokeNavigation():void; navigate(hit:EvidenceHit):Promise<void>; sharedFence?():boolean};
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
  // An unsuccessful trusted retirement is retried on the next shared revoke;
  // never admit a new host operation while its previous authority is uncertain.
  private retirement?: {host?:Host; running:boolean};
  readonly authority: DenseAuthority;
  private readonly listeners: ReturnType<DenseAuthority['channel']>;
  private machineChanged?: () => void;
  constructor(private readonly port:Port){
    this.authority=new DenseAuthority(()=>!!this.retirement || (port.sharedFence?.() ?? false));this.listeners=this.authority.channel();
  }
  /** The single machine ownership hook is authority, not a quarantinable observer. */
  bindMachine(changed:()=>void):()=>void {
    if(this.machineChanged)throw new Error('DENSE_MACHINE_ALREADY_BOUND');
    this.machineChanged=changed;
    return ()=>{if(this.machineChanged===changed)this.machineChanged=undefined;};
  }
  subscribe(listener:()=>void):()=>void {
    if(this.disposed)return ()=>{};
    return this.authority.subscribe(this.listeners,listener);
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
  /** Role-wide metadata only; owner-scoped evidence/preview access stays unchanged. */
  operationStatus():AiOperationStatus {
    const state=this.state;
    if(state.phase==='preview')return {phase:'permission-required',error:null};
    if(state.phase==='preparing'||state.phase==='running')return {phase:'busy',error:null};
    if(state.phase==='error')return {phase:'failed',error:state.error??'NOT_READY'};
    if(state.phase==='complete')return state.result.status==='ok'?{phase:'complete',error:null}:
      {phase:'failed',error:state.result.error??'NOT_READY'};
    return {phase:'idle',error:null};
  }
  isDisposed():boolean {return this.disposed;}
  occupied():boolean {return this.owner!==undefined;}
  owns(owner:symbol):boolean {return this.owner===owner;}
  private emit():void {
    this.authority.batch(()=>{try{this.machineChanged?.();}finally{this.authority.publish(this.listeners);}});
  }
  private clearTimer():void {if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;}
  invalidate():void {
    // Even an empty shared invalidation supersedes an interrupted prepare.
    ++this.revision;
    this.authority.revoke(()=>{
      if(this.retirement?.running)return;
      if(this.owner===undefined&&!this.host&&!this.retirement)return;
      // An observer cannot turn a persistent retirement failure into an
      // unbounded notification wave. Retry only outside observer delivery.
      if(this.retirement&&this.authority.delivering())throw new ProviderFailure('NOT_READY');
      const retiring={host:this.host??this.retirement?.host,running:true};
      this.clearTimer();this.host=undefined;this.owner=undefined;this.state={phase:'idle'};
      this.retirement=retiring;
      try {
        try {
          try {retiring.host?.invalidate();retiring.host=undefined;}
          finally {this.port.revokeNavigation();}
        } finally {this.emit();}
        this.retirement=undefined;
      } finally {retiring.running=false;}
    });
  }
  cancel(owner:symbol):void {if(this.owner===owner)this.invalidate();}
  dispose():void {
    if(this.disposed)return;
    this.disposed=true;
    this.authority.revoke(()=>{try{this.invalidate();}finally{try{this.emit();}finally{this.authority.retire(this.listeners);}}});
  }
  private current(owner:symbol,revision:number,host:Host):boolean {
    return !this.disposed&&!this.authority.revoking()&&this.owner===owner&&this.revision===revision
      &&this.host===host&&this.port.host()===host;
  }
  async prepare(owner:symbol,request:DenseRequest,fence?:MachineFence):Promise<void> {
    if(this.disposed||this.authority.admissionClosed())return;
    const revision=this.revision+1;
    try {this.invalidate();} catch {console.warn('DENSE_AUTHORITY_REVOKE_FAILED');return;}
    if(this.disposed||this.authority.admissionClosed()||this.revision!==revision)return;
    const host=this.port.host();
    this.owner=owner;
    if(!host){this.state={phase:'error',error:'NOT_READY'};this.emit();return;}
    this.host=host;this.state={phase:'preparing'};this.emit();
    try {
      if(!this.current(owner,revision,host))return;
      const preview=await host.prepare(structuredClone(request),fence);
      if(!this.current(owner,revision,host))return;
      if(preview.expiresUnixMs<=Date.now())throw new ProviderFailure('CANCELLED');
      this.state={phase:'preview',preview:structuredClone(preview)};
      this.timer=setTimeout(()=>{
        if(this.current(owner,revision,host)){
          try{this.invalidate();}catch{console.warn('DENSE_AUTHORITY_REVOKE_FAILED');}
        }
      },
        Math.max(0,preview.expiresUnixMs-Date.now()));
      this.emit();
    }catch(error){
      if(this.current(owner,revision,host)){this.state={phase:'error',error:errorCode(error)};this.emit();}
    }
  }
  async confirm(owner:symbol,nonce:string,classification:Classification,token:string):Promise<void> {
    const host=this.host,revision=this.revision;
    if(this.authority.admissionClosed()||!host||!this.current(owner,revision,host)||this.state.phase!=='preview'
      ||this.state.preview.nonce!==nonce||!['synthetic','public'].includes(classification))return;
    const preview=this.state.preview;
    if(preview.expiresUnixMs<=Date.now()){try{this.invalidate();}catch{console.warn('DENSE_AUTHORITY_REVOKE_FAILED');}return;}
    this.clearTimer();this.state={phase:'running'};this.emit();
    try {
      if(!this.current(owner,revision,host))return;
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
    if(this.authority.admissionClosed()||!host||!this.current(owner,revision,host)||this.state.phase!=='complete')return false;
    const result=this.state.result;
    if(!('hits' in result)||result.status!=='ok'||!Number.isInteger(index))return false;
    const hit=result.hits[index]?.evidence;
    if(!hit||JSON.stringify(hit)!==JSON.stringify(expected))return false;
    try{
      await this.port.navigate(structuredClone(hit));
      return this.current(owner,revision,host);
    }catch{
      if(this.current(owner,revision,host)){
        const expectedRevision=this.revision+1;
        this.invalidate();
        if(!this.disposed&&!this.authority.admissionClosed()&&this.revision===expectedRevision){
          this.owner=owner;this.state={phase:'error',error:'SOURCE_STALE'};this.emit();
        }
      }
      return false;
    }
  }
}
