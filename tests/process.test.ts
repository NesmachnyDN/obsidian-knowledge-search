import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Supervisor } from '../plugin/src/supervisor';
import { FIXTURE_ID, FIXTURE_DIGEST, QUERY, type Request } from '../plugin/src/protocol';
const config = {interpreter:'/usr/bin/python3',entry:resolve('engine/probe.py')};
async function request(): Promise<Request> { return {version:1,id:'process-test',method:'probe',source:{id:FIXTURE_ID,digest:FIXTURE_DIGEST,text:await readFile('contracts/fixtures/evidence.md','utf8')},query:QUERY}; }
async function worker(code:string, fn:(entry:string)=>Promise<void>):Promise<void> {
  const root = await mkdtemp(resolve('.test-build/worker-'));
  try { const entry = join(root,'worker.py'); await writeFile(entry,code); await fn(entry); }
  finally { await rm(root,{recursive:true,force:true}); }
}
async function started(s:Supervisor):Promise<number> { for(let i=0;i<200;i++){if(s.pid) return s.pid; await new Promise(r=>setTimeout(r,5));} throw Error('no child'); }
function dead(pid:number):void { assert.throws(()=>process.kill(pid,0),{code:'ESRCH'}); }
test('real engine exact RU/EN, first match and no-match; pinned identity rejects self-consistent forged digest',async()=>{
  const s = new Supervisor(); const r = await request();
  for(const query of [QUERY,'EN:','RU:','absent','match-01:']) {
    const result = await s.run(config,{...r,query}); assert.equal(result.ok,true);
    if(result.ok) assert.equal(result.evidence?.line ?? null, query===QUERY?5:query==='EN:'?3:query==='RU:'?4:null);
  }
  const result = await s.run(config,{...r,source:{...r.source,text:'forged',digest:'0'.repeat(64)}});
  assert.deepEqual(result,{version:1,id:r.id,ok:false,error:{code:'FIXTURE_REJECTED'}});
});
for(const [name,code,expected] of [
 ['malformed',"print('{')",'INVALID_RESPONSE'],
 ['extra',"print('{}'); print('{}')",'EXTRA_OUTPUT'],
 ['crash','raise SystemExit(3)','ENGINE_EXIT'],
 ['oversize',"import sys; sys.stdout.write('x'*65537); sys.stdout.flush()",'STDOUT_LIMIT'],
 ['stderr',"import sys; sys.stderr.write('x'*4097); sys.stderr.flush()",'STDERR_LIMIT'],
 ['wrong-id',`print('{"version":1,"id":"wrong","ok":true,"evidence":null}')`,'INVALID_RESPONSE'],
 ['missing-newline',"import sys; sys.stdout.write('{}')",'INVALID_RESPONSE'],
 ['invalid-utf8',"import sys; sys.stdout.buffer.write(b'\\xff\\n')",'INVALID_RESPONSE'],
] as const) test(`real child ${name}, clean restart`,async()=>worker('import sys\nsys.stdin.buffer.read()\n'+code,async entry=>{
 const s = new Supervisor(); await assert.rejects(s.run({...config,entry},await request()),new RegExp(expected));
 assert.equal(s.busy,false); assert.equal(s.pid,undefined); assert.equal((await s.run(config,await request())).ok,true);
}));
const sleeper = 'import sys, time, signal\nsys.stdin.buffer.read()\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(30)';
for(const action of ['timeout','cancel','dispose'] as const) test(`real ${action} terminates child and suppresses late results`,async()=>worker(sleeper,async entry=>{
 const s = new Supervisor({deadlineMs:action==='timeout'?200:3000,graceMs:40});
 const pending = s.run({...config,entry},await request());
 const rejection = assert.rejects(pending,new RegExp(action==='timeout'?'TIMEOUT':'CANCELLED'));
 const pid = await started(s); await new Promise(r=>setTimeout(r,60));
 await assert.rejects(s.run(config,await request()),/BUSY/);
 if(action==='cancel') s.cancel(); if(action==='dispose') await s.dispose();
 await rejection; dead(pid); assert.equal(s.busy,false);
 if(action==='dispose') await assert.rejects(s.run(config,await request()),/UNLOADED/);
 else assert.equal((await s.run(config,await request())).ok,true);
}));
test('configuration failure and cancellation during preflight recover',async()=>{
 const s=new Supervisor(); const r=await request();
 await assert.rejects(s.run({interpreter:'python',entry:config.entry},r),/CONFIGURE_ENGINE/);
 await assert.rejects(s.run({...config,entry:resolve('.test-build/missing')},r),/ENGINE_UNAVAILABLE/);
 const pending=s.run(config,r); s.cancel(); await assert.rejects(pending,/CANCELLED/);
 assert.equal((await s.run(config,r)).ok,true);
});
test('incremental stdout accepts split UTF-8 and rejects delayed extra output',async()=>{
 const r=await request();
 const response=await new Supervisor().run(config,r);
 const encoded=Buffer.from(JSON.stringify(response)+'\n').toString('hex');
 for(const extra of [false,true]) await worker(`import sys,time\nsys.stdin.buffer.read()\ndata=bytes.fromhex('${encoded}')\nfor byte in data:\n sys.stdout.buffer.write(bytes([byte]))\n sys.stdout.buffer.flush()\n${extra?"time.sleep(0.02)\nsys.stdout.write('extra')\nsys.stdout.flush()":""}`,async entry=>{
  const pending=new Supervisor().run({...config,entry},r);
  if(extra) await assert.rejects(pending,/EXTRA_OUTPUT/);else assert.deepEqual(await pending,response);
 });
});
