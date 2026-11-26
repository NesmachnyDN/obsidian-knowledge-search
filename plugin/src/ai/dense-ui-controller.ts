import { ProviderFailure, type ProviderFailureCode, type AiOperationStatus } from './contracts';
import type { ApiDenseHost, DensePreview, DenseRequest, MachineFence } from './dense-host';
import type { DenseIndexResult } from './dense-index-manager';
import type { ApiRetrievalResult } from './dense-retrieval';
import type { EvidenceHit } from '../standalone/contracts';
import { DenseAuthority, type RetirementWitness } from './dense-authority';

type Result = DenseIndexResult | ApiRetrievalResult;
type Classification = 'synthetic' | 'public';
type State = {phase:'idle'|'preparing'|'running'|'error'; error?:ProviderFailureCode}
  | {phase:'preview'; preview:DensePreview} | {phase:'complete'; result:Result};
type Host = Pick<ApiDenseHost,'prepare'|'confirm'|'invalidate'>&Partial<Pick<ApiDenseHost,'policySelected'|'prepareWithCredential'|'isPreviewCurrent'|'isResultCurrent'|'isPolicyOperationCurrent'>>;
type Port = {host():Host|undefined; revokeNavigation():void; captureNavigationRetirement?():()=>void; navigate(hit:EvidenceHit):Promise<void>; sharedFence?():boolean};
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
  private policyResult=false;
  private policyRunning=false;
  private refreshingPolicy=false;
  // An unsuccessful trusted retirement is retried on the next shared revoke;
  // never admit a new host operation while its previous authority is uncertain.
  private retirement?: {host?:Host; navigation?:()=>void; running:boolean};
  readonly authority: DenseAuthority;
  private readonly listeners: ReturnType<DenseAuthority['channel']>;
  private machineChanged?: () => void;
  constructor(private readonly port:Port){
    this.authority=new DenseAuthority(()=>!!this.retirement || (port.sharedFence?.() ?? false));this.listeners=this.authority.channel(()=>{this.refreshPolicy();});
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
  policySelected():boolean{return this.port.host()?.policySelected?.()===true;}
  private refreshPolicy():boolean{
    if(this.refreshingPolicy)return false;
    if(!this.owner)return true;
    const host=this.host,state=this.state;
    if(!host||!(state.phase==='preview'&&(state.preview.credentialStamp||host.policySelected?.())||state.phase==='complete'&&this.policyResult||state.phase==='running'&&this.policyRunning))return true;
    this.refreshingPolicy=true;
    try{
      const current=this.port.host()===host&&(state.phase==='preview'
        ?host.isPreviewCurrent?.(state.preview)===true:state.phase==='running'?host.isPolicyOperationCurrent?.()===true:state.phase==='complete'&&host.isResultCurrent?.(state.result)===true);
      if(!current&&this.host===host&&this.state===state)this.invalidate();
      return current&&this.host===host&&this.state===state;
    }catch{
      if(this.host===host&&this.state===state)this.invalidate();
      return false;
    }finally{this.refreshingPolicy=false;}
  }
  snapshot(owner:symbol):State {
    return this.refreshPolicy()&&this.owns(owner)?structuredClone(this.state):{phase:'idle'};
  }
  /** Only bounded metadata is copied for machine status polling. */
  metadata(owner:symbol):{phase:State['phase'];error?:ProviderFailureCode|null;
    executedMode?:ApiRetrievalResult['executedMode'];legs?:ApiRetrievalResult['legs']} {
    if(!this.refreshPolicy()||!this.owns(owner))return {phase:'idle'};
    const state=this.state;
    if(state.phase==='complete'&&'hits' in state.result)return {phase:state.phase,error:state.result.error,
      executedMode:state.result.executedMode,legs:structuredClone(state.result.legs)};
    if(state.phase==='error')return {phase:state.phase,error:state.error??'NOT_READY'};
    return {phase:state.phase};
  }
  /** Role-wide metadata only; owner-scoped evidence/preview access stays unchanged. */
  operationStatus():AiOperationStatus {
    if(!this.refreshPolicy()||!this.occupied())return {phase:'idle',error:null};
    const state=this.state;
    if(state.phase==='preview')return {phase:'permission-required',error:null};
    if(state.phase==='preparing'||state.phase==='running')return {phase:'busy',error:null};
    if(state.phase==='error')return {phase:'failed',error:state.error??'NOT_READY'};
    if(state.phase==='complete')return state.result.status==='ok'?{phase:'complete',error:null}:
      {phase:'failed',error:state.result.error??'NOT_READY'};
    return {phase:'idle',error:null};
  }
  isDisposed():boolean {return this.disposed||this.authority.terminal();}
  occupied():boolean {return !this.isDisposed()&&this.authority.ownershipVisible()&&this.owner!==undefined;}
  owns(owner:symbol):boolean {return this.occupied()&&this.owner===owner;}
  private emit():void {
    this.authority.batch(()=>{try{if(!this.refreshingPolicy)this.refreshPolicy();this.machineChanged?.();}finally{this.authority.publish(this.listeners);}});
  }
  private clearTimer():void {if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;}
  invalidate(witness?:RetirementWitness):void {
    // Even an empty shared invalidation supersedes an interrupted prepare.
    ++this.revision;
    this.authority.revoke(()=>{
      if(this.retirement?.running)return;
      if(this.owner===undefined&&!this.host&&!this.retirement)return;
      // An observer cannot turn a persistent retirement failure into an
      // unbounded notification wave. Retry only outside observer delivery.
      if(this.retirement&&this.authority.delivering())throw new ProviderFailure('NOT_READY');
      const retiring=this.retirement??{host:this.host,navigation:
        this.port.captureNavigationRetirement?.()??(()=>this.port.revokeNavigation()),running:false};
      retiring.running=true;
      this.clearTimer();this.host=undefined;this.owner=undefined;this.state={phase:'idle'};this.policyResult=false;this.policyRunning=false;
      this.retirement=retiring;
      try {
        try {
          try {retiring.host?.invalidate();retiring.host=undefined;}
          finally {if(retiring.navigation){retiring.navigation();retiring.navigation=undefined;}}
        } finally {this.emit();}
        this.retirement=undefined;
      } finally {retiring.running=false;}
    },witness);
  }
  cancel(owner:symbol,witness?:RetirementWitness):void {if(this.owner===owner)this.invalidate(witness);}
  dispose():void {
    if(this.disposed)return;
    this.disposed=true;
    this.authority.revoke(()=>{try{this.invalidate();}finally{try{this.emit();}finally{this.authority.retire(this.listeners);}}});
  }
  private current(owner:symbol,revision:number,host:Host):boolean {
    return this.owns(owner)&&this.revision===revision
      &&this.host===host&&this.port.host()===host;
  }
  async prepare(owner:symbol,request:DenseRequest,fence?:MachineFence,credential?:{classification:Classification;token:string}):Promise<void> {
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
      const selected=host.policySelected?.()===true;
      if(selected&&(!credential||!host.prepareWithCredential||fence)||!selected&&credential)throw new ProviderFailure('DISCLOSURE_DENIED');
      const preview=selected?await host.prepareWithCredential!(structuredClone(request),credential!.classification,credential!.token)
        :await host.prepare(structuredClone(request),fence);
      if(!this.current(owner,revision,host))return;
      if(preview.expiresUnixMs<=Date.now()||selected&&(!preview.credentialStamp||host.isPreviewCurrent?.(preview)!==true))throw new ProviderFailure('CANCELLED');
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
    if(this.authority.admissionClosed()||!this.refreshPolicy()||!host||!this.current(owner,revision,host)||this.state.phase!=='preview'
      ||this.state.preview.nonce!==nonce||!['synthetic','public'].includes(classification))return;
    const preview=this.state.preview;
    const policy=!!preview.credentialStamp;
    if(policy&&(token!==''||classification!==preview.policyClassification))return;
    if(preview.expiresUnixMs<=Date.now()){try{this.invalidate();}catch{console.warn('DENSE_AUTHORITY_REVOKE_FAILED');}return;}
    this.clearTimer();this.policyRunning=policy;this.state={phase:'running'};this.emit();
    try {
      if(!this.current(owner,revision,host))return;
      const result=await host.confirm(structuredClone(preview),classification,token);
      if(this.current(owner,revision,host)){
        if(policy&&result.status==='ok'&&host.isResultCurrent?.(result)!==true)throw new ProviderFailure('CANCELLED');
        this.policyRunning=false;this.policyResult=policy&&result.status==='ok';
        this.state={phase:'complete',result:structuredClone(result)};this.emit();
      }
    }catch(error){
      if(this.current(owner,revision,host)){this.state={phase:'error',error:errorCode(error)};this.emit();}
    }
  }
  async open(owner:symbol,index:number,expected:EvidenceHit):Promise<boolean> {
    const host=this.host,revision=this.revision;
    if(this.authority.admissionClosed()||!this.refreshPolicy()||!host||!this.current(owner,revision,host)||this.state.phase!=='complete')return false;
    const result=this.state.result;
    if(!('hits' in result)||result.status!=='ok'||!Number.isInteger(index))return false;
    const hit=result.hits[index]?.evidence;
    if(!hit||JSON.stringify(hit)!==JSON.stringify(expected))return false;
    try{
      await this.port.navigate(structuredClone(hit));
      return this.refreshPolicy()&&this.current(owner,revision,host);
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
