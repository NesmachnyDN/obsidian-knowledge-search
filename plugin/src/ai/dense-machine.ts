import { randomUUID } from 'node:crypto';
import { ProviderFailure, type ProviderPreference } from './contracts';
import { MachineFailure, parseMachine, type MachineError } from './dense-machine-contract';
import type { ApiDenseHost, DenseRequest, MachineFence } from './dense-host';
import type { DenseUiController } from './dense-ui-controller';
import type { ApiRetrievalResult } from './dense-retrieval';
import { configDigest } from './disclosure';
import { pilotConfig } from './loopback-json';

type Host=Pick<ApiDenseHost,'verifyMachineResult'>;
type Port={host():Host|undefined;preference():ProviderPreference};
type Slot={id:string;input:Extract<DenseRequest,{kind:'search'}>;fence:MachineFence;
  host:Host;abort:AbortController;owner?:symbol; revokeRead?:()=>void};
type Metadata={phase:string;requestedMode:'dense'|'hybrid';executedMode:'dense'|'hybrid'|'none';
  expiresUnixMs:number;error:MachineError|null;legs?:ApiRetrievalResult['legs']};
type Reply={apiVersion:1;ok:true;value:{operationId:string;expiresUnixMs:number}|Metadata|ApiRetrievalResult|null}
  |{apiVersion:1;ok:false;error:MachineError};
const ok=(value:Extract<Reply,{ok:true}>['value']):Reply=>({apiVersion:1,ok:true,value});
const fail=(error:MachineError):Reply=>({apiVersion:1,ok:false,error});

/** Capability bearer is returned only to submitter; view ownership is a separate
 * symbol. No consent/grant/token API, and no independent provider execution. */
export class DenseMachine {
  private slot?:Slot;
  private timer?:ReturnType<typeof setTimeout>;
  private reading=false;
  private draining=false;
  private disposed=false;
  private readonly listeners: ReturnType<DenseUiController['authority']['channel']>;
  private readonly unsubscribe:()=>void;
  constructor(private readonly ui:DenseUiController,private readonly port:Port,private readonly now=Date.now){
    this.listeners=ui.authority.channel();
    this.unsubscribe=ui.bindMachine(()=>{
      const s=this.slot;
      if(ui.isDisposed()&&s)this.clear();
      else if(s?.owner&&!ui.owns(s.owner))this.clear();
      else if(s&&!s.owner&&ui.occupied())this.clear();
      else this.emit();
    });
  }
  subscribe(listener:()=>void):()=>void {
    if(this.disposed)return ()=>{};
    return this.ui.authority.subscribe(this.listeners,listener);
  }
  private emit():void{this.ui.authority.publish(this.listeners);}
  private clear(retireUi=true):number {
    const s=this.slot;if(!s){this.ui.authority.retireMachine();return this.ui.authority.epoch();}
    return this.ui.authority.revoke(()=>{
      this.slot=undefined;
      if(this.timer!==undefined)clearTimeout(this.timer);
      this.timer=undefined;
      // Settle a waiting caller even if the physical abort throws before
      // signaling. The actual verification drain still prevents new submit.
      s.revokeRead?.();
      try {this.ui.authority.retireMachine(()=>s.abort.abort());}
      finally {try {if(retireUi&&s.owner)this.ui.cancel(s.owner);}finally{this.emit();}}
      return this.ui.authority.epoch();
    });
  }
  invalidate(retireUi=true):void {this.clear(retireUi);}
  dispose():void {
    if(this.disposed)return;
    this.disposed=true;this.unsubscribe();
    this.ui.authority.revoke(()=>{try{this.clear();}finally{this.ui.authority.retire(this.listeners);}});
  }
  private current(s:Slot):boolean {
    try{
      const p=this.port.preference();
      return !this.disposed&&!this.ui.isDisposed()&&this.ui.authority.ownershipVisible()&&this.slot===s&&!s.abort.signal.aborted&&this.now()<s.fence.expiresUnixMs
        &&this.port.host()===s.host&&p.state==='configured'
        &&configDigest('embedding',pilotConfig(p))===s.fence.digest
        &&(!s.owner||this.ui.owns(s.owner));
    }catch{return false;}
  }
  pending():boolean {return !this.disposed&&!this.ui.isDisposed()&&!!this.slot&&!this.slot.owner&&this.current(this.slot);}
  owns(owner:symbol):boolean{return !this.disposed&&!this.ui.isDisposed()&&this.ui.authority.ownershipVisible()&&this.slot?.owner===owner;}
  /** Only called from a dedicated human ItemView action. */
  async review(owner:symbol):Promise<void> {
    const s=this.slot;
    if(this.ui.authority.admissionClosed()||!s||s.owner||this.ui.occupied())return;
    if(!this.current(s)){this.clear();return;}
    // Reserve ownership synchronously, before prepare can publish any state.
    s.owner=owner;
    await this.ui.prepare(owner,s.input,s.fence);
    if(this.slot===s&&!this.current(s))this.clear();
  }
  cancelView(owner:symbol):void{
    if(this.slot&&(!this.slot.owner||this.slot.owner===owner))this.clear();
  }
  private status(s:Slot):Metadata {
    const meta:Metadata={phase:'pending',requestedMode:s.input.request.requestedMode,
      executedMode:'none',expiresUnixMs:s.fence.expiresUnixMs,error:null};
    if(!s.owner)return meta;
    const state=this.ui.metadata(s.owner);
    meta.phase=state.phase;meta.error=state.error??null;
    meta.executedMode=state.executedMode??'none';
    if(state.legs)meta.legs=state.legs;
    return meta;
  }
  /** Return promptly on revocation, but keep admission closed until the
   * underlying bounded host verification drains. */
  private async verifyRead(s:Slot,result:ApiRetrievalResult):Promise<(()=>boolean)|null> {
    this.draining=true;
    const signal=s.abort.signal;
    const task=Promise.resolve().then(()=>{
      if(signal.aborted||this.slot!==s)throw new ProviderFailure('CANCELLED');
      return s.host.verifyMachineResult(s.input,s.fence,result,signal);
    });
    void task.then(()=>{this.draining=false;},()=>{this.draining=false;});
    let cancel!:()=>void;
    const revoked=new Promise<null>(resolve=>{
      cancel=()=>resolve(null);s.revokeRead=cancel;
      signal.addEventListener('abort',cancel,{once:true});
      if(signal.aborted || this.slot!==s)cancel();
    });
    try{return await Promise.race([task,revoked]);}
    finally{s.revokeRead=undefined;signal.removeEventListener('abort',cancel);}
  }
  async request(input:unknown):Promise<Reply> {
    try{
      if(this.disposed||this.ui.isDisposed())return fail('NOT_READY');
      const cmd=parseMachine(input,this.port.preference);
      if(this.disposed||this.ui.isDisposed())return fail('NOT_READY');
      if(cmd.operation==='submit'){
        if(this.ui.authority.admissionClosed())return fail('NOT_READY');
        if(this.slot&&!this.current(this.slot)){
          const retired=this.clear();
          if(this.ui.authority.epoch()!==retired)return fail('INVALID_OPERATION');
        }
        if(this.disposed||this.ui.isDisposed()||this.ui.authority.admissionClosed())return fail('NOT_READY');
        if(this.slot||this.reading||this.draining||this.ui.occupied())return fail('BUSY');
        const host=this.port.host();if(!host)return fail('NOT_READY');
        const id=randomUUID(),expiresUnixMs=this.now()+300000;
        const s:Slot={id,input:cmd.input,fence:{digest:cmd.digest,expiresUnixMs},host,abort:new AbortController()};
        this.slot=s;this.timer=setTimeout(()=>{
          if(this.slot===s){try{this.clear();}catch{console.warn('DENSE_AUTHORITY_REVOKE_FAILED');}}
        },300000);
        this.timer.unref?.();this.emit();
        return this.current(s)?ok({operationId:id,expiresUnixMs}):fail('INVALID_OPERATION');
      }
      const s=this.slot;
      // Logical revocation is already committed. A read/status callback must
      // not recursively retire a still-pinned physical owner.
      if(!this.ui.authority.ownershipVisible()||!s||cmd.operationId!==s.id)return fail('INVALID_OPERATION');
      if(!this.current(s)){this.clear();return fail('INVALID_OPERATION');}
      if(cmd.operation==='status')return ok(this.status(s));
      if(cmd.operation==='cancel'){this.clear();return ok(null);}
      if(this.ui.authority.admissionClosed())return fail('NOT_READY');
      if(this.reading||this.draining)return fail('BUSY');
      if(!s.owner)return fail('NOT_READY');
      const state=this.ui.snapshot(s.owner);
      if(state.phase==='error'){const error=state.error??'NOT_READY';this.clear();return fail(error);}
      if(state.phase!=='complete'||!('hits' in state.result))return fail('NOT_READY');
      const result=state.result;
      this.reading=true;
      try{
        const verified=result.status==='ok'?await this.verifyRead(s,result):()=>true;
        if(!this.current(s)||!verified||!verified()){
          if(this.slot===s)this.clear();
          return fail('SOURCE_STALE');
        }
        const retired=this.clear();
        return !this.disposed&&!this.ui.isDisposed()&&this.ui.authority.epoch()===retired?ok(result):fail('SOURCE_STALE');
      }catch{
        if(this.slot===s)this.clear();
        return fail('SOURCE_STALE');
      }finally{this.reading=false;}
    }catch(error){
      return fail(error instanceof MachineFailure||error instanceof ProviderFailure?error.code:'INVALID_REQUEST');
    }
  }
}
