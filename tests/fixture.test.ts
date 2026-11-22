import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm, writeFile, symlink, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readFixture } from '../plugin/src/fixture';
import { FIXTURE_PATH } from '../plugin/src/protocol';
import { ProbeController } from '../plugin/src/controller';
import { Supervisor } from '../plugin/src/supervisor';
async function vault(fn:(root:string)=>Promise<void>):Promise<void>{
 const root=await mkdtemp(resolve('.test-build/vault-'));
 try {await mkdir(join(root,'oks-synthetic')); await copyFile('contracts/fixtures/evidence.md',join(root,FIXTURE_PATH)); await fn(root);}
 finally {await rm(root,{recursive:true,force:true});}
}
const access=(root:string)=>({root,verifyNote:()=>{}});
test('only exact bounded fixture accepted; missing, changed, oversized and malformed bytes rejected',async()=>vault(async root=>{
 assert.match(await readFixture(access(root)),/Свет синий/);
 for(const content of ['changed',Buffer.alloc(8193),Buffer.from([255])]) {
  await writeFile(join(root,FIXTURE_PATH),content); await assert.rejects(readFixture(access(root)),/FIXTURE_REJECTED/);
 }
 await rm(join(root,FIXTURE_PATH)); await assert.rejects(readFixture(access(root)),/FIXTURE_REJECTED/);
}));
test('traversal, alternate path, relative/noncanonical roots and unsupported Vault fail closed',async()=>vault(async root=>{
 for(const path of ['../evidence.md','other.md','oks-synthetic/../oks-synthetic/evidence.md']) await assert.rejects(readFixture(access(root),path),/FIXTURE_REJECTED/);
 for(const bad of ['relative',root+'/..',root+'/']) await assert.rejects(readFixture(access(bad)),/FIXTURE_REJECTED/);
 await assert.rejects(readFixture({root,verifyNote:()=>{throw Error('unsupported');}}),/FIXTURE_REJECTED/);
}));
test('root, ancestor and target symlinks rejected even when pointing to pinned fixture',async()=>vault(async root=>{
 const link=root+'-link';
 try {await symlink(root,link); await assert.rejects(readFixture(access(link)),/FIXTURE_REJECTED/);} finally {await rm(link);}
 await rename(join(root,'oks-synthetic'),join(root,'actual'));
 await symlink(join(root,'actual'),join(root,'oks-synthetic'));
 await assert.rejects(readFixture(access(root)),/FIXTURE_REJECTED/);
 await rm(join(root,'oks-synthetic')); await mkdir(join(root,'oks-synthetic'));
 await symlink(join(root,'actual/evidence.md'),join(root,FIXTURE_PATH));
 await assert.rejects(readFixture(access(root)),/FIXTURE_REJECTED/);
}));
test('controller opt-in, real success, cancellation, unload, restart and changed-before-display',async()=>vault(async root=>{
 const statuses:string[]=[];const results:unknown[]=[];
 const config={fixtureMode:true,interpreter:'/usr/bin/python3',entry:resolve('engine/probe.py')};
 const supervisor=new Supervisor();
 const controller=new ProbeController(supervisor,{status:s=>statuses.push(s),result:r=>results.push(r)});
 await controller.run({...config,fixtureMode:false},access(root));assert.equal(statuses.at(-1),'ENABLE_SYNTHETIC_FIXTURE_MODE');
 await controller.run(config,access(root));assert.equal(results.length,1);
 let calls=0;
 await controller.run(config,{root,verifyNote:()=>{if(++calls===3) throw Error('changed');}});
 assert.equal(results.length,1);assert.equal(statuses.at(-1),'FIXTURE_REJECTED');
 const entry=join(root,'slow.py');await writeFile(entry,'import time\ntime.sleep(30)');
 for(const action of ['cancel','unload']) {
  const pending=controller.run({...config,entry},access(root));
  for(let i=0;i<200&&!supervisor.pid;i++) await new Promise(r=>setTimeout(r,5));
  assert.ok(supervisor.pid);const pid=supervisor.pid!;
  await controller.run(config,access(root));assert.equal(statuses.at(-1),'BUSY');
  if(action==='cancel') controller.cancel();else await controller.unload();
  await pending;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(results.length,action==='cancel'?1:2);
  if(action==='cancel'){await controller.run(config,access(root));assert.equal(results.length,2);}
 }
 await controller.run(config,access(root));assert.equal(results.length,2);
}));
