import { BOUNDS, hash, isDigest, validPath } from '../standalone/contracts';
import { verifiedOriginalDigest, type SourceProvider, type DescriptorLifecycleProof, type VerifiedOriginalRead } from '../standalone/source';
import type { PolicyMetadataParser } from '../standalone/worker';
import type { PolicyMetadataState, PolicyMetadataProof } from '../standalone/shared';
import { AI_ROLES, ProviderFailure, type AiRole, type CallContext, type ProviderConfig } from './contracts';
import { bindActiveDeadline, remainingOperationMs, expireActiveDeadline, deadlineFailure } from './active-deadline';
import { configDigest } from './disclosure';

/** Prospective eligibility only. This module cannot mint consent or perform I/O to a provider. */
export const POLICY_VERSION = 'oks-policy-1b';
export type ProfileClass = 'external' | 'trusted-internal';
export type PolicyReason = 'eligible' | 'private' | 'invalid-property' | 'metadata-unresolved'
  | 'source-stale' | 'source-unresolved' | 'cancelled' | 'profile-unadmitted'
  | 'profile-mismatch' | 'restricted' | 'ownership-unresolved' | 'lineage-unresolved' | 'authority-changed'
  | 'busy' | 'timeout' | 'marking-denied';
export type TrustedProfile = Readonly<{
  profileId: string; admissionId: string; role: AiRole; configDigest: string;
  adapter: string; classification: ProfileClass;
}>;
export type PolicySubject = Readonly<{
  sourceId: string; expectedSha256: string; kind: 'original' | 'attachment' | 'derivative';
  ownerIds: readonly string[]; parentSourceIds?: readonly string[];
}>;
export type Restriction = Readonly<{ scope: 'all' | 'external' | 'internal'; sourceId?: string; ownerId?: string }>;
/** All fields are supplied by a trusted host port, not UI, Properties, or machine input.
 * The port must resolve current admission, rule evaluation, scope and lineage independently. */
export type PolicySnapshot = Readonly<{
  subjects: readonly PolicySubject[]; profile: TrustedProfile | null; role: AiRole;
  config: ProviderConfig; adapter: string; ownerId: string; hostId: string; scopeId: string;
  policyRevision: string; configRevision: string; credentialEpoch: number; deadlineUnixMs: number;
  payloadDigest: string; restrictions: readonly Restriction[]; evaluationComplete: boolean;
}>;
export type PolicyHost = Readonly<{ snapshot(): PolicySnapshot | null; current(): boolean;
  requireOriginalProof?:true; marking?(proof:PolicyMetadataProof,original?:DescriptorLifecycleProof):boolean }>;
export type PolicyEnvelope = Readonly<{
  policyVersion: typeof POLICY_VERSION; allowed: boolean; reason: PolicyReason;
  bindingDigest: string | null; rootId: string;
  sourceVersions: readonly Readonly<{sourceId:string;sha256:string;metadataState:PolicyMetadataState;reason:PolicyReason}>[];
  /** Host-private evidence binding; never a proof, path diagnostic, or grant. */
  lifecycleDigest?:string;
  /** Fresh descriptor evidence, independent of lifecycle classification. */
  originalProofDigest?:string;
}>;
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  && Buffer.byteLength(v) <= 256 && Buffer.from(v,'utf8').toString('utf8')===v && !/[\0\r\n]/.test(v);
const unique = (xs: readonly unknown[]): boolean => new Set(xs).size === xs.length;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const exact=(v:object,required:readonly string[],optional:readonly string[]=[]):boolean=>
  required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
function validSnapshot(s: PolicySnapshot): boolean {
  return exact(s,['subjects','profile','role','config','adapter','ownerId','hostId','scopeId','policyRevision','configRevision','credentialEpoch','deadlineUnixMs','payloadDigest','restrictions','evaluationComplete'])
    && (s.profile===null||exact(s.profile,['profileId','admissionId','role','configDigest','adapter','classification']))
    && AI_ROLES.includes(s.role) && identifier(s.adapter) && identifier(s.ownerId)
    && identifier(s.hostId) && isDigest(s.scopeId) && identifier(s.policyRevision)
    && identifier(s.configRevision) && isDigest(s.payloadDigest)
    && Number.isSafeInteger(s.credentialEpoch) && s.credentialEpoch > 0
    && Number.isSafeInteger(s.deadlineUnixMs) && s.deadlineUnixMs > 0
    && s.evaluationComplete === true && Array.isArray(s.subjects) && s.subjects.length > 0
    && s.subjects.length <= BOUNDS.sources && unique(s.subjects.map(x=>x.sourceId))
    && s.subjects.every(x=>exact(x,['sourceId','expectedSha256','kind','ownerIds'],['parentSourceIds'])&&identifier(x.sourceId) && isDigest(x.expectedSha256)
      && ['original','attachment','derivative'].includes(x.kind) && Array.isArray(x.ownerIds)
      && x.ownerIds.length > 0 && x.ownerIds.length <= BOUNDS.limit && x.ownerIds.every(validPath)
      && unique(x.ownerIds) && (x.parentSourceIds === undefined || (Array.isArray(x.parentSourceIds)
        && x.parentSourceIds.length <= BOUNDS.limit && x.parentSourceIds.every(validPath) && unique(x.parentSourceIds))))
    && Array.isArray(s.restrictions) && s.restrictions.length <= BOUNDS.sources
    && s.restrictions.every(r=>exact(r,['scope'],['sourceId','ownerId'])&&['all','external','internal'].includes(r.scope)
      && (r.sourceId===undefined || identifier(r.sourceId)) && (r.ownerId===undefined || validPath(r.ownerId)));
}
function profileReason(s: PolicySnapshot): PolicyReason | null {
  const p=s.profile;
  if (!p || !identifier(p.profileId) || !identifier(p.admissionId)
    || !['external','trusted-internal'].includes(p.classification)) return 'profile-unadmitted';
  if (p.role!==s.role || p.adapter!==s.adapter || p.configDigest!==configDigest(s.role,s.config)) return 'profile-mismatch';
  return null;
}
function restricts(s: PolicySnapshot, x: PolicySubject): boolean {
  const internal=s.profile?.classification==='trusted-internal';
  return s.restrictions.some(r=>(r.scope==='all'||r.scope===(internal?'internal':'external'))
    && (r.sourceId===undefined||r.sourceId===x.sourceId)
    && (r.ownerId===undefined||x.ownerIds.includes(r.ownerId)));
}
/** Existing host supplies the live authority port. No production callers or
 * profile registry are introduced in POLICY.1b. Results are not capabilities. */
export class EligibilityEvaluator {
  // Reserve before host callbacks. A non-cancellable read or worker request
  // remains physically admitted until its actual settlement, even after the
  // caller receives a terminal deadline/cancellation result. No queue.
  private active=false;
  private pending=false;
  private dependency?:Promise<void>;
  get physicallyPending():boolean{return this.pending;}
  async drain():Promise<void>{await this.dependency;}
  constructor(private readonly reader: SourceProvider, private readonly parser: PolicyMetadataParser,
    private readonly host: PolicyHost) {}
  private awaitDependency<T>(context:CallContext,current:()=>boolean,work:()=>Promise<T>):Promise<T> {
    const remaining=remainingOperationMs(context);
    if(this.pending)return Promise.reject(new ProviderFailure('BUSY'));
    this.pending=true;
    return new Promise<T>((resolve,reject)=>{
      let settled=false;
      const finish=(value?:T,error?:unknown):void=>{
        if(settled)return;
        settled=true;clearTimeout(timer);context.signal.removeEventListener('abort',cancel);
        const terminal=deadlineFailure(context);
        if(terminal||error!==undefined)reject(terminal??error);else resolve(value as T);
      };
      const cancel=()=>finish(undefined,new ProviderFailure('CANCELLED'));
      const timer=setTimeout(()=>{expireActiveDeadline(context);finish(undefined,new ProviderFailure('TIMEOUT'));},remaining);
      context.signal.addEventListener('abort',cancel,{once:true});
      const physical=Promise.resolve().then(()=>{
        remainingOperationMs(context);
        if(!current())throw new ProviderFailure('CANCELLED');
        remainingOperationMs(context);
        return work();
      }).then(value=>{this.pending=false;finish(value);},error=>{this.pending=false;finish(undefined,error??new ProviderFailure('SOURCE_STALE'));});
      this.dependency=physical;
      void physical.then(()=>{if(this.dependency===physical)this.dependency=undefined;});
      if(context.signal.aborted)cancel();
    });
  }
  async evaluate(context:CallContext):Promise<PolicyEnvelope> {
    if(this.active||this.pending)return freeze({policyVersion:POLICY_VERSION,allowed:false,reason:'busy',bindingDigest:null,rootId:'',sourceVersions:[]});
    this.active=true;
    try{return await this.evaluateOwned(context);}finally{this.active=false;}
  }
  private async evaluateOwned(context:CallContext):Promise<PolicyEnvelope> {
    const signal=context.signal;
    const versions:{sourceId:string;sha256:string;metadataState:PolicyMetadataState;reason:PolicyReason}[]=[];
    const rootId=this.reader.rootId;
    let bindingDigest:string|null=null,originalProofDigest:string|undefined;
    const done=(reason:PolicyReason):PolicyEnvelope=>freeze({policyVersion:POLICY_VERSION,
      allowed:reason==='eligible',reason,bindingDigest,rootId,sourceVersions:versions.map(x=>({...x})),
      ...(reason==='eligible'&&originalProofDigest?{originalProofDigest}:{})});
    const failure=():PolicyReason=>{
      const terminal=deadlineFailure(context);
      return terminal?.code==='TIMEOUT'?'timeout':signal.aborted||terminal?.code==='CANCELLED'?'cancelled':'authority-changed';
    };
    let s:PolicySnapshot;
    try {
      if(signal.aborted||!this.host.current())return done(failure());
      const value=this.host.snapshot();
      if(!value||!isDigest(rootId)||!validSnapshot(value)||value.deadlineUnixMs!==context.deadlineUnixMs)return done('source-unresolved');
      s=structuredClone(value);
      if(!validSnapshot(s))return done('source-unresolved');
      const p=profileReason(s); if(p)return done(p);
      context=bindActiveDeadline(context,30000,s.deadlineUnixMs);
      bindingDigest=hash(JSON.stringify([POLICY_VERSION,rootId,s]));
    }catch(error){return done(error instanceof ProviderFailure&&error.code==='TIMEOUT'?'timeout':signal.aborted?'cancelled':'source-unresolved');}
    const current=():boolean=>{
      if(signal.aborted||this.reader.rootId!==rootId)return false;
      try {
        remainingOperationMs(context);
        if(!this.host.current())return false;
        const value=this.host.snapshot();
        return !!value&&validSnapshot(value)&&hash(JSON.stringify([POLICY_VERSION,rootId,value]))===bindingDigest
          &&this.host.current()&&remainingOperationMs(context)>0;
      }catch{return false;}
    };
    if(!current())return done(failure());
    const notes=s.subjects.filter(x=>x.kind==='original');
    const known=new Set(notes.map(x=>x.sourceId));
    for(const x of s.subjects){
      if(!current())return done(failure());
      if(restricts(s,x))return done('restricted');
      // Attachment bytes/extraction and verified ownership have no admitted path
      // in this slice. Never use a caller-provided label or owner as a substitute.
      if(x.kind==='attachment')return done('ownership-unresolved');
      if(x.kind==='derivative'){
        if(!x.parentSourceIds?.length||!x.parentSourceIds.every(id=>known.has(id))
          ||!x.ownerIds.every(id=>known.has(id))||x.parentSourceIds.length!==x.ownerIds.length||!x.parentSourceIds.every(id=>x.ownerIds.includes(id)))
          return done('lineage-unresolved');
      }else if(!validPath(x.sourceId)||x.ownerIds.length!==1||x.ownerIds[0]!==x.sourceId||x.parentSourceIds?.length)
        return done('ownership-unresolved');
    }
    if(!notes.length)return done('lineage-unresolved');
    const requireProof=this.host.requireOriginalProof===true;
    const originals=new Map<string,string>();
    const read=async(x:PolicySubject):Promise<{bytes:Uint8Array;proof?:DescriptorLifecycleProof;digest?:string}>=>{
      if(!requireProof)return {bytes:await this.reader.read(x.sourceId)};
      if(!this.reader.readVerifiedOriginal)throw new ProviderFailure('SOURCE_STALE');
      const observed:VerifiedOriginalRead=await this.reader.readVerifiedOriginal(x.sourceId);
      const digest=verifiedOriginalDigest(observed,rootId,x.sourceId,x.expectedSha256);
      return {...observed,digest};
    };
    for(const x of notes){
      try{
        if(!current())return done(failure());
        const observed=await this.awaitDependency(context,current,()=>read(x));
        if(!current())return done(failure());
        const {bytes,proof,digest}=observed;
        if(bytes.byteLength>BOUNDS.fileBytes||hash(bytes)!==x.expectedSha256)return done('source-stale');
        if(digest)originals.set(x.sourceId,digest);
        const doc=await this.awaitDependency(context,current,()=>this.parser.policyMetadata(x.sourceId,bytes,rootId));
        if(!current())return done(failure());
        if(doc.sha256!==x.expectedSha256||doc.sourceId!==x.sourceId||doc.scopeId!==rootId)return done('source-stale');
        const reason:PolicyReason=doc.state==='absent'||doc.state==='external'?'eligible':doc.state==='private'?'private':doc.state==='invalid'?'invalid-property':'metadata-unresolved';
        versions.push({sourceId:x.sourceId,sha256:x.expectedSha256,metadataState:doc.state,reason});
        if(reason==='metadata-unresolved'||(s.profile!.classification==='external'&&reason!=='eligible'))return done(reason);
        if(s.profile!.classification==='external'&&this.host.marking){
          if(!this.host.marking(doc,proof))return done('marking-denied');
          if(!current())return done(failure());
        }
      }catch{return done(current()?'source-unresolved':failure());}
    }
    // Repeat every original read after all parsing; an earlier note may have
    // changed while a later one was being parsed. Existing host retirement is
    // still required to cover events after this check and before use.
    for(const x of notes){
      try{
        if(!current())return done(failure());
        const {bytes,digest}=await this.awaitDependency(context,current,()=>read(x));
        if(!current())return done(failure());
        if(bytes.byteLength>BOUNDS.fileBytes||hash(bytes)!==x.expectedSha256
          ||(requireProof&&(!digest||originals.get(x.sourceId)!==digest)))return done('source-stale');
      }catch{return done(current()?'source-unresolved':failure());}
    }
    if(requireProof){
      if(originals.size!==notes.length)return done('source-unresolved');
      originalProofDigest=hash(JSON.stringify(['oks-effective-originals-v1',rootId,[...originals]]));
    }
    return done(current()?'eligible':failure());
  }
}
