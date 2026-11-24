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
  host:Host;abort:AbortController;owner?:symbol};
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
  private readonly listeners=new Set<()=>void>();
  private readonly unsubscribe:()=>void;
  constructor(private readonly ui:DenseUiController,private readonly port:Port,private readonly now=Date.now){
    this.unsubscribe=ui.subscribe(()=>{
      const s=this.slot;
      if(s?.owner&&!ui.owns(s.owner))this.clear();
      else if(s&&!s.owner&&ui.occupied())this.clear();
      else this.emit();
    });
  }
  subscribe(listener:()=>void):()=>void {
    if(this.disposed)return ()=>{};
    this.listeners.add(listener);return ()=>this.listeners.delete(listener);
  }
  private emit():void{for(const listener of this.listeners)listener();}
  private clear():void {
    const s=this.slot;this.slot=undefined;
    if(this.timer!==undefined)clearTimeout(this.timer);
    this.timer=undefined;s?.abort.abort();
    if(s?.owner)this.ui.cancel(s.owner);
    this.emit();
  }
  invalidate():void {if(this.slot)this.clear();}
  dispose():void {this.disposed=true;this.unsubscribe();this.clear();this.listeners.clear();}
  private current(s:Slot):boolean {
    try{
      const p=this.port.preference();
      return !this.disposed&&this.slot===s&&!s.abort.signal.aborted&&this.now()<s.fence.expiresUnixMs
        &&this.port.host()===s.host&&p.state==='configured'
        &&configDigest('embedding',pilotConfig(p))===s.fence.digest
        &&(!s.owner||this.ui.owns(s.owner));
    }catch{return false;}
  }
  pending():boolean {return !!this.slot&&!this.slot.owner&&this.current(this.slot);}
  owns(owner:symbol):boolean{return this.slot?.owner===owner;}
  /** Only called from a dedicated human ItemView action. */
  async review(owner:symbol):Promise<void> {
    const s=this.slot;
    if(!s||s.owner||this.ui.occupied())return;
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
      if(signal.aborted)throw new ProviderFailure('CANCELLED');
      return s.host.verifyMachineResult(s.input,s.fence,result,signal);
    });
    void task.then(()=>{this.draining=false;},()=>{this.draining=false;});
    let cancel!:()=>void;
    const revoked=new Promise<null>(resolve=>{
      cancel=()=>resolve(null);signal.addEventListener('abort',cancel,{once:true});
      if(signal.aborted)cancel();
    });
    try{return await Promise.race([task,revoked]);}
    finally{signal.removeEventListener('abort',cancel);}
  }
  async request(input:unknown):Promise<Reply> {
    try{
      const cmd=parseMachine(input,this.port.preference);
      if(this.disposed)return fail('NOT_READY');
      if(cmd.operation==='submit'){
        if(this.slot&&!this.current(this.slot))this.clear();
        if(this.slot||this.reading||this.draining||this.ui.occupied())return fail('BUSY');
        const host=this.port.host();if(!host)return fail('NOT_READY');
        const id=randomUUID(),expiresUnixMs=this.now()+300000;
        const s:Slot={id,input:cmd.input,fence:{digest:cmd.digest,expiresUnixMs},host,abort:new AbortController()};
        this.slot=s;this.timer=setTimeout(()=>{if(this.slot===s)this.clear();},300000);
        this.timer.unref?.();this.emit();
        return ok({operationId:id,expiresUnixMs});
      }
      const s=this.slot;
      if(!s||cmd.operationId!==s.id)return fail('INVALID_OPERATION');
      if(!this.current(s)){this.clear();return fail('INVALID_OPERATION');}
      if(cmd.operation==='status')return ok(this.status(s));
      if(cmd.operation==='cancel'){this.clear();return ok(null);}
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
        this.clear();return ok(result);
      }catch{
        if(this.slot===s)this.clear();
        return fail('SOURCE_STALE');
      }finally{this.reading=false;}
    }catch(error){
      return fail(error instanceof MachineFailure||error instanceof ProviderFailure?error.code:'INVALID_REQUEST');
    }
  }
}
