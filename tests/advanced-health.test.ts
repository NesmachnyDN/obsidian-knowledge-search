import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AdvancedHealthBridge, parseHealthFrame, type AdvancedConfig } from '../plugin/src/advanced/health';
import { defaultSettings, parseSettings } from '../plugin/src/search/settings';

const good: AdvancedConfig = { enabled:true, profile:'local-stdio',
  interpreter:'/usr/bin/python3.12', entry:resolve('engine/persistent.py') };
const disabled: AdvancedConfig = { ...good, enabled:false };
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const dead = (pid: number): void => assert.throws(() => process.kill(pid, 0), {code:'ESRCH'});
const nonce = 'a'.repeat(48);

test('v2 settings migration preserves Standalone, disables optional backend; v3 enable requires explicit paths', () => {
  const v2 = { ...defaultSettings(), version:2, advanced:{enabled:false, profile:'local-stdio'} };
  const migrated = parseSettings(v2);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.enabled, true);
  assert.equal(migrated.advanced.enabled,false);
  assert.equal(migrated.advanced.interpreter,'');
  assert.deepEqual(parseSettings({ ...migrated, advanced:good }).advanced,good);
  for(const c of [ { ...good, interpreter:'python3'}, { ...good, entry:'relative.py'},
    { ...good, profile:'none'}, { ...good, enabled:'yes'},
    { ...good, interpreter:'x\0y' }, { ...good, unexpected:'source'} ]) {
    assert.throws(()=>parseSettings({ ...defaultSettings(), advanced:c }));
  }
});
test('strict canonical v2 health response rejects duplicate keys, UTF-8 corruption and foreign nonce', () => {
  const valid = Buffer.from(`{"version":2,"id":"${nonce}","ok":true}\n`);
  assert.equal(parseHealthFrame(valid,nonce),true);
  for (const bytes of [Buffer.from(`{"version":2,"id":"${nonce}","ok":true,"ok":true}\n`),
    Buffer.from(`{"version":2,"id":"${'b'.repeat(48)}","ok":true}\n`),
    Buffer.from(`{"version":3,"id":"${nonce}","ok":true}\n`),
    Buffer.from(`{"version":2,"id":"${nonce}","ok":true}\nMORE\n`),
    Buffer.concat([Buffer.from([0xff]),valid]), Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),valid]),
    Buffer.from('x'.repeat(1025))]) assert.equal(parseHealthFrame(bytes, nonce),false);
});
test('disabled bridge launches no child; exact real local v2 Python health, stop, restart', async () => {
  const bridge = new AdvancedHealthBridge();
  assert.equal(bridge.snapshot().status,'disabled');
  assert.equal((await bridge.start(disabled)).status,'disabled');
  assert.equal(bridge.pid,undefined);
  const started = await bridge.start(good);
  assert.deepEqual(started,{profile:'local-stdio',status:'ready',error:null,transportOnly:true});
  const first = bridge.pid; assert.ok(first); process.kill(first,0);
  await bridge.stop(); dead(first);
  assert.equal(bridge.snapshot().status,'disabled');
  const again = await bridge.start(good); assert.equal(again.status,'ready');
  const second = bridge.pid!; assert.notEqual(second,first);
  await bridge.stop(); dead(second);
});
test('invalid executable, symlink entry and world-writable entry refuse without spawn',async()=>{
  const bridge = new AdvancedHealthBridge();
  const root=await mkdtemp(resolve('.test-build/advanced-negative-'));
  try {
    for (const cfg of [{ ...good,interpreter:'/no/such/python'},{ ...good,interpreter:'/bin/false'},
      { ...good,entry:'../wrong.py' }]) {
      const result=await bridge.start(cfg);
      assert.equal(result.status,'failed'); assert.equal(bridge.pid,undefined);
    }
    const link=join(root,'link.py');await symlink(good.entry,link);
    assert.equal((await bridge.start({...good,entry:link})).error,'ADVANCED_CONFIG_INVALID');
    const file=join(root,'unsafe.py');await writeFile(file, 'print("not executed")\n',{mode:0o666});
    // Forced explicitly world-writable, independent of umask.
    const {chmod}=await import('node:fs/promises');await chmod(file,0o666);
    assert.equal((await bridge.start({...good,entry:file})).error,'ADVANCED_CONFIG_INVALID');
    assert.equal(bridge.pid,undefined);
  } finally {await bridge.stop();await rm(root,{recursive:true,force:true});}
});
async function scripted(code:string, verify:(bridge:AdvancedHealthBridge, cfg:AdvancedConfig)=>Promise<void>) {
  const root=await mkdtemp(resolve('.test-build/advanced-worker-'));
  const entry=join(root,'health.py');await writeFile(entry,code,{mode:0o644});
  const bridge=new AdvancedHealthBridge();
  try {await verify(bridge,{...good,entry});} finally {await bridge.stop();await rm(root,{recursive:true,force:true});}
}
const setup='import json,sys,time,signal\nr=json.loads(sys.stdin.readline())\n';
for(const [name,behavior] of [
  ['duplicate',`sys.stdout.write('{"version":2,"id":"'+r["id"]+'","ok":true,"ok":true}\\n')\nsys.stdout.flush()\n`],
  ['bad-nonce',`sys.stdout.write('{"version":2,"id":"'+('f'*48)+'","ok":true}\\n')\nsys.stdout.flush()\n`],
  ['invalid-utf8',`sys.stdout.buffer.write(b'\\xff\\n');sys.stdout.flush()\n`],
  ['oversize',`sys.stdout.write('X'*1025+'\\n');sys.stdout.flush()\n`],
  ['stderr-flood',`sys.stderr.write('X'*5000);sys.stderr.flush();time.sleep(1)\n`],
  ['crash',`raise SystemExit(7)\n`],
] as const) test(`adversarial health worker ${name} fails closed`,async()=>{
  await scripted(setup+behavior, async(bridge,cfg)=>{
    const result=await bridge.start(cfg);
    assert.equal(result.status,'failed',JSON.stringify(result));
    assert.equal(bridge.pid,undefined);
  });
});
test('SIGTERM-resistant process gets group KILL on stop; unexpected exit invalidates health',async()=>{
  await scripted(setup+`signal.signal(signal.SIGTERM,signal.SIG_IGN)\nsys.stdout.write('{"version":2,"id":"'+r["id"]+'","ok":true}\\n');sys.stdout.flush();time.sleep(20)\n`,async(bridge,cfg)=>{
    assert.equal((await bridge.start(cfg)).status,'ready');
    const pid=bridge.pid!;await bridge.stop();dead(pid);
  });
  await scripted(setup+`sys.stdout.write('{"version":2,"id":"'+r["id"]+'","ok":true}\\n');sys.stdout.flush();time.sleep(.1)\n`,async(bridge,cfg)=>{
    assert.equal((await bridge.start(cfg)).status,'ready');
    await wait(400);
    assert.equal(bridge.snapshot().status,'failed');
    assert.equal(bridge.snapshot().error,'ADVANCED_EXIT');
  });
});
