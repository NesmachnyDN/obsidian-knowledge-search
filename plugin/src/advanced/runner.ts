/** Systemd-cgroup admitted one-shot document ingestion; no health-v2 payload. */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { modelRequest, parseModelFrame, ModelError, type ModelReply, type ModelRequest } from './model-protocol';
import { checkedPath } from './health';
import { canonicalFrame, IngestError, INGEST_VERSION, MAX_REQUEST, MAX_RESPONSE,
  parseIngestFrame, validRequest, type IngestRequest, type IngestResponse,
  type IngestProfile } from './protocol';
import type { IngestionConfig } from '../search/settings';
import type { TrustedVaultRoot } from './source';

const exec = promisify(execFile);
const UNIT_LIMIT = 120000;
const MAX_STDERR = 16384;
const RESOURCE_MEMORY = 4 * 1024 ** 3;
const FREE_RESERVE = (5 * 1024 ** 3) / 2;
const FREE_DISK = 1024 ** 3;
const PROPERTIES = [
  'MemoryMax=4G','MemorySwapMax=0','CPUQuota=200%','TasksMax=64',
  'KillMode=control-group','RuntimeMaxSec=120s','TimeoutStopSec=1s',
  'RestrictAddressFamilies=AF_UNIX','NoNewPrivileges=yes',
];
const WHITELIST_ENV = ['XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'] as const;
const localEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    PATH:'/usr/bin:/bin', LANG:'C.UTF-8', LC_ALL:'C.UTF-8',
  };
  for (const key of WHITELIST_ENV) if (process.env[key]) env[key]=process.env[key]!;
  return env;
};
async function runSystemctl(args: string[]): Promise<string> {
  const result = await exec('/usr/bin/systemctl', ['--user', ...args],
    { shell:false, timeout:3500, maxBuffer:8192, env:localEnv() });
  return result.stdout;
}
async function unitState(unit: string): Promise<{load:string; active:string; group:string}> {
  const raw = await runSystemctl(['show',unit,'--property=LoadState,ActiveState,ControlGroup']);
  const pairs = new Map(raw.trim().split('\n').map(x=>[x.split('=')[0],x.slice(x.indexOf('=')+1)]));
  return {load:pairs.get('LoadState')??'',active:pairs.get('ActiveState')??'',
    group:pairs.get('ControlGroup')??''};
}
async function stopped(unit: string): Promise<boolean> {
  const state = await unitState(unit);
  return (state.load === 'not-found' || state.active === 'inactive' || state.active === 'failed')
    && (state.group === '' || state.group === '/');
}
async function stopUnit(unit: string): Promise<void> {
  if (await stopped(unit)) return;
  try { await runSystemctl(['stop',unit]); } catch {}
  if (!(await stopped(unit))) {
    // A failed stop is not proof of no running descendants: new admission is blocked.
    throw new IngestError('ADVANCED_UNAVAILABLE');
  }
}
async function resourceAdmission(): Promise<void> {
  if (process.platform !== 'linux') throw new IngestError('ADVANCED_RESOURCE_REFUSED');
  const controllers = (await readFile('/sys/fs/cgroup/cgroup.controllers','utf8')).split(/\s+/);
  if (!['memory','cpu','pids'].every(x=>controllers.includes(x)))
    throw new IngestError('ADVANCED_RESOURCE_REFUSED');
  const mem = (await readFile('/proc/meminfo','utf8')).match(/^MemAvailable:\s*(\d+)\s*kB/m);
  if (!mem || Number(mem[1])*1024 < RESOURCE_MEMORY+FREE_RESERVE)
    throw new IngestError('ADVANCED_RESOURCE_REFUSED');
  const root = await statfs('/tmp',{bigint:true});
  if (root.bavail*root.bsize < BigInt(FREE_DISK))
    throw new IngestError('ADVANCED_RESOURCE_REFUSED');
  // Verify user manager exists before creating a transient unit.
  await runSystemctl(['show-environment']);
}

type Job = { unit:string; controller:AbortController; child?:ChildProcessWithoutNullStreams;
  stopPromise?: Promise<void>; retired?:boolean };
export class AdvancedIngestRunner {
  private running?: Job;
  private poison = false;
  private failedOwner?: Job;
  readonly maxResponseBytes = MAX_RESPONSE;
  get busy(): boolean { return !!this.running; }
  get blocked(): boolean { return this.poison; }

  async ingest(config: IngestionConfig, root: TrustedVaultRoot, sourcePath: string,
    sha256: string, profileId: IngestProfile, deadlineMs = UNIT_LIMIT): Promise<IngestResponse> {
    if (this.poison) throw new IngestError('ADVANCED_UNAVAILABLE');
    if (this.running) throw new IngestError('ADVANCED_BUSY');
    if (!config.enabled) throw new IngestError('ADVANCED_UNAVAILABLE');
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > UNIT_LIMIT)
      throw new IngestError('ADVANCED_RESOURCE_REFUSED');
    const job: Job = {unit:'oks-ingest-'+randomBytes(12).toString('hex')+'.service',
      controller:new AbortController()};
    this.running=job;
    try {
      try {
        await resourceAdmission();
        await checkedPath(config.interpreter,true);
        await checkedPath(config.entry,false);
      } catch { throw new IngestError('ADVANCED_RESOURCE_REFUSED'); }
      if ((job.retired||job.controller.signal.aborted)) throw new IngestError('ADVANCED_CANCELLED');
      const request: IngestRequest = {
        protocolVersion:INGEST_VERSION,
        requestId:randomBytes(24).toString('hex'), operation:'ingest',
        rootPath:root.path, scopeId:root.id, sourcePath, expectedSha256:sha256,
        profileId, deadlineUnixMs:Date.now()+deadlineMs,
        tokenizerSnapshot:config.tokenizerSnapshot,
        tessdataPath:config.tessdataPath || null,
        artifactsPath:config.artifactsPath || null,
      };
      validRequest(request);
      const payload=canonicalFrame(request,MAX_REQUEST);
      const argv=[
        '--user','--quiet','--collect','--wait','--pipe','--service-type=exec',
        '--unit='+job.unit,
        ...PROPERTIES.map(p=>'--property='+p),
        ...['HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','HF_DATASETS_OFFLINE'].map(k=>'--setenv='+k+'=1'),
        '--setenv=OMP_NUM_THREADS=2','--setenv=OMP_THREAD_LIMIT=2',
        '--',config.interpreter,'-I','-B',config.entry,
      ];
      const child=spawn('/usr/bin/systemd-run',argv,{
        shell:false,detached:true,env:localEnv(),stdio:['pipe','pipe','pipe'],
      });
      job.child=child;
      if ((job.retired||job.controller.signal.aborted)) throw new IngestError('ADVANCED_CANCELLED');
      const response = await this.exchange(job,payload,b=>parseIngestFrame(b,request),deadlineMs+5000);
      if ((job.retired||job.controller.signal.aborted)) throw new IngestError('ADVANCED_CANCELLED');
      // --wait covers all child unit exit; explicitly verify no active cgroup.
      if (!(await stopped(job.unit))) throw new IngestError('ADVANCED_UNAVAILABLE');
      return response;
    } catch(error) {
      if (job.child || (job.retired||job.controller.signal.aborted)) {
        try { await this.cancelJob(job); }
        catch { this.poison=true; throw new IngestError('ADVANCED_UNAVAILABLE'); }
      }
      if (error instanceof IngestError) throw error;
      throw new IngestError('ADVANCED_UNAVAILABLE');
    } finally {
      if (this.running === job) this.running=undefined;
    }
  }
  /** Same cgroup, resource admission and whole-tree cancellation as ingestion. */
  async embed(config:IngestionConfig,texts:string[],maxTokens=384,deadlineMs=UNIT_LIMIT):Promise<ModelReply> {
    if(this.poison)throw new ModelError('MODEL_UNAVAILABLE');
    if(this.running)throw new ModelError('MODEL_BUSY');
    if(!config.enabled)throw new ModelError('MODEL_UNAVAILABLE');
    const job:Job={unit:'oks-ingest-'+randomBytes(12).toString('hex')+'.service',
      controller:new AbortController()};
    this.running=job;
    try {
      const entry=join(dirname(config.entry),'advanced_retrieval.py');
      try {await resourceAdmission();await checkedPath(config.interpreter,true);await checkedPath(entry,false);}
      catch {throw new ModelError('MODEL_RESOURCE_REFUSED');}
      if((job.retired||job.controller.signal.aborted))throw new ModelError('MODEL_CANCELLED');
      const request:ModelRequest={protocolVersion:4,operation:'embed',
        requestId:randomBytes(24).toString('hex'),deadlineUnixMs:Date.now()+deadlineMs,
        modelSnapshot:config.tokenizerSnapshot,maxTokens,texts};
      const payload=modelRequest(request);
      const argv=['--user','--quiet','--collect','--wait','--pipe','--service-type=exec',
        '--unit='+job.unit,...PROPERTIES.map(p=>'--property='+p),
        ...['HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','HF_DATASETS_OFFLINE'].map(k=>'--setenv='+k+'=1'),
        '--setenv=OMP_NUM_THREADS=2','--setenv=OMP_THREAD_LIMIT=2',
        '--',config.interpreter,'-I','-B',entry];
      const child=spawn('/usr/bin/systemd-run',argv,{shell:false,detached:true,env:localEnv(),
        stdio:['pipe','pipe','pipe']});
      job.child=child;
      if((job.retired||job.controller.signal.aborted))throw new ModelError('MODEL_CANCELLED');
      const reply=await this.exchange(job,payload,b=>parseModelFrame(b,request),deadlineMs+5000);
      if((job.retired||job.controller.signal.aborted))throw new ModelError('MODEL_CANCELLED');
      if(!(await stopped(job.unit)))throw new ModelError('MODEL_UNAVAILABLE');
      if(reply.status!=='ok')throw new ModelError(reply.error??'MODEL_FAILED');
      return reply;
    }catch(error){
      if(job.child||(job.retired||job.controller.signal.aborted)){
        try{await this.cancelJob(job);}catch{this.poison=true;throw new ModelError('MODEL_UNAVAILABLE');}
      }
      if(error instanceof ModelError)throw error;
      if(error instanceof IngestError)throw new ModelError(error.code);
      throw new ModelError('MODEL_UNAVAILABLE');
    }finally {if(this.running===job)this.running=undefined;}
  }
  private exchange<R>(job:Job,payload:Buffer,parse:(value:Buffer)=>R,deadlineMs:number): Promise<R> {
    const child=job.child!;
    return new Promise((resolve,reject)=>{
      let output=Buffer.alloc(0),stderr=0,finished=false;
      const done=(failure?:IngestError)=>{
        if (finished) return;
        finished=true;
        clearTimeout(timer);
        job.controller.signal.removeEventListener('abort',abort);
        if (failure) reject(failure);
        else {
          try { resolve(parse(output)); }
          catch { reject(new IngestError('ADVANCED_PROTOCOL_INVALID')); }
        }
      };
      const abort=()=>{
        void this.cancelJob(job).catch(()=>{this.poison=true;});
        done(new IngestError('ADVANCED_CANCELLED'));
      };
      const timer=setTimeout(()=>{
        job.controller.abort();
        done(new IngestError('ADVANCED_TIMEOUT'));
      },deadlineMs);
      job.controller.signal.addEventListener('abort',abort,{once:true});
      child.on('error',()=>done(new IngestError('ADVANCED_UNAVAILABLE')));
      child.stdout.on('data',(buffer:Buffer)=>{
        if (finished) return;
        if (output.length+buffer.length > MAX_RESPONSE) {
          job.controller.abort();done(new IngestError('ADVANCED_PROTOCOL_INVALID'));return;
        }
        output=Buffer.concat([output,buffer]);
      });
      child.stderr.on('data',(buffer:Buffer)=>{
        stderr+=buffer.length;
        // Never log stderr: third-party parsers may write untrusted source text.
        if (stderr>MAX_STDERR) {
          job.controller.abort();done(new IngestError('ADVANCED_PROTOCOL_INVALID'));
        }
      });
      child.once('close',(code:number|null)=>done(code===0 ? undefined : new IngestError('ADVANCED_EXIT')));
      child.stdin.on('error',()=>done(new IngestError('ADVANCED_EXIT')));
      child.stdin.end(payload);
    });
  }
  private async cancelJob(job:Job): Promise<void> {
    job.retired=true;
    if (job.stopPromise) return job.stopPromise;
    job.stopPromise=(async()=>{
      try {
        const launcher=job.child;
        if (!launcher) {
          if (!(await stopped(job.unit))) await stopUnit(job.unit);
          return;
        }
        // B1/B2: unit registration and cancellation may cross. A not-found unit
        // while the launcher is still live DOES NOT mean descendants are gone.
        // Wait for the StartTransientUnit handshake, then stop the owned unit.
        const elapsed=Date.now();
        let observed=false;
        while(Date.now()-elapsed<3500){
          const state=await unitState(job.unit);
          if(state.load!=='not-found'){
            observed=true;
            await stopUnit(job.unit);
            break;
          }
          if(launcher.exitCode!==null || launcher.signalCode!==null) break;
          await new Promise(r=>setTimeout(r,50));
        }
        if(!observed && launcher.exitCode===null && launcher.signalCode===null){
          // Only the owned launcher PID is signaled: never an unverified numeric PGID.
          launcher.kill('SIGTERM');
        }
        // A queued StartTransientUnit request may still complete after its
        // submitter exits. Recheck until both launcher and unit are quiescent.
        let stable=0;
        const settle=Date.now();
        while(Date.now()-settle<5000){
          const state=await unitState(job.unit);
          if(state.load!=='not-found' && (state.active!=='inactive'||state.group))
            await stopUnit(job.unit);
          const launcherDone=launcher.exitCode!==null || launcher.signalCode!==null;
          if(launcherDone && await stopped(job.unit)) stable++;
          else stable=0;
          if(stable>=4) return; // four sequential successful checks after launcher exit
          await new Promise(r=>setTimeout(r,75));
        }
        throw new IngestError('ADVANCED_UNAVAILABLE');
      } catch(error) { this.poison=true; this.failedOwner=job; throw error; }
    })();
    return job.stopPromise;
  }
  async stop(): Promise<void> {
    const job=this.running??this.failedOwner;
    // A rejected shutdown is not evidence that an old cgroup disappeared.
    // Preserve the failed concrete owner and reject every ownership transfer.
    if (!job) {
      if(this.poison)throw new IngestError('ADVANCED_UNAVAILABLE');
      return;
    }
    job.retired=true;
    try { job.controller.abort(); }
    finally { await this.cancelJob(job); }
    if(this.poison)throw new IngestError('ADVANCED_UNAVAILABLE');
  }
}
