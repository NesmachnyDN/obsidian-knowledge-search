/** Optional Linux kernel lock for the private lifecycle authority directory. */
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { StandaloneError } from '../standalone/contracts';

export const ledgerUnavailable=():never=>{throw new StandaloneError('LIFECYCLE_LEDGER_UNAVAILABLE');};
export const lifecycleLockName='LOCK';
const binary='/usr/bin/flock';
const safe=(s:Stats,uid:number)=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===uid&&(s.mode&0o077)===0&&s.size===0;
async function acquireDescriptor(fd:number):Promise<boolean>{
  // No shell, inherited environment, PATH lookup, or private input/output.
  return new Promise(resolve=>{
    let timedOut=false,failed=false;
    const child=spawn(binary,['--exclusive','--nonblock','3'],{
      stdio:['ignore','ignore','ignore',fd],env:{PATH:'/usr/bin:/bin'},
    });
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},1000);
    child.once('error',()=>{failed=true;});
    child.once('close',code=>{clearTimeout(timer);resolve(!timedOut&&!failed&&code===0);});
  });
}
export class LifecycleLock {
  private closed=false;
  private constructor(private readonly handle:FileHandle,private readonly uid:number){}
  static async acquire(dir:string):Promise<LifecycleLock>{
    const uid=process.getuid?.();
    if(process.platform!=='linux'||uid===undefined)return ledgerUnavailable();
    let handle:FileHandle|undefined;
    try{
      for(const path of ['/usr','/usr/bin']){
        const parent=await lstat(path);
        if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==0||(parent.mode&0o022)!==0)return ledgerUnavailable();
      }
      const executable=await lstat(binary);
      if(!executable.isFile()||executable.isSymbolicLink()||executable.uid!==0||(executable.mode&0o022)!==0
        ||await realpath(binary)!==binary)return ledgerUnavailable();
      handle=await open(join(dir,lifecycleLockName),constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
      const lock=new LifecycleLock(handle,uid);
      await lock.assertCurrent(dir);
      if(!await acquireDescriptor(handle.fd))return ledgerUnavailable();
      await lock.assertCurrent(dir);
      handle=undefined;return lock;
    }catch{return ledgerUnavailable();}
    finally{await handle?.close();}
  }
  async assertCurrent(dir:string):Promise<void>{
    if(this.closed)return ledgerUnavailable();
    const opened=await this.handle.stat(),named=await lstat(join(dir,lifecycleLockName));
    if(!safe(opened,this.uid)||!safe(named,this.uid)||opened.dev!==named.dev||opened.ino!==named.ino)
      return ledgerUnavailable();
  }
  async close():Promise<void>{
    if(this.closed)return;
    this.closed=true;await this.handle.close();
  }
}
