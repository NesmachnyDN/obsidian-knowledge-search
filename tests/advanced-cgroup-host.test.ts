/** Opt-in, real Linux cgroup + local Docling/Tesseract acceptance, synthetic Vault only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { AdvancedIngestionManager } from '../plugin/src/advanced/manager';
import { AdvancedIngestRunner } from '../plugin/src/advanced/runner';
import { AdvancedGenerationStore } from '../plugin/src/advanced/storage';
import { trustedVaultRoot } from '../plugin/src/advanced/source';
import { IngestError, sha, type IngestResponse } from '../plugin/src/advanced/protocol';
import { verifyProvenance } from '../plugin/src/advanced/provenance';
import type { IngestionConfig } from '../plugin/src/search/settings';

const enabled=process.env.OKS_05C_REAL_CGROUP==='1';
const python=process.env.OKS_05C_PYTHON ?? '';
const snapshot=process.env.OKS_05C_TOKENIZER_SNAPSHOT ?? '';
const tessdata=process.env.OKS_05C_TESSDATA ?? '';
const entry=resolve('engine/advanced_ingest.py');
const reason='requires explicitly configured local offline Docling + tokenizer + real systemd user cgroup';
const buildConfig=(mode:IngestionConfig['pdfMode']):IngestionConfig=>({
  enabled:true, interpreter:python,entry,tokenizerSnapshot:snapshot,
  tessdataPath:tessdata,artifactsPath:'',pdfMode:mode,
});
const data='---\ncount: 7\nactive: true\n---\n# Договор 🚀\nREQ-RU-17: Требуется проверка.\nSee [[related|Alias]].\n';
const sourceFiles=['policy.pdf','policy.docx','scan.pdf'];

test('actual 05C advanced pipeline: explicit opt-in, Linux cgroup, native PDF/DOCX, RU/EN OCR, private generation recovery, stale evidence refusal',
  {skip:!enabled?reason:undefined,timeout:160000},async()=>{
    if(!python||!snapshot||!tessdata) throw new Error('REQUIRED_OFFLINE_ARTIFACTS_ABSENT');
    const priorXdg=process.env.XDG_DATA_HOME;
    const tmp=await mkdtemp(join(tmpdir(),'oks05c-cgroup-'));
    const root=join(tmp,'vault');
    await mkdir(root,{mode:0o700});await mkdir(join(tmp,'xdg'),{mode:0o700});
    const pluginId='oks-synthetic-evidence';
    const manager=new AdvancedIngestionManager();
    process.env.XDG_DATA_HOME=join(tmp,'xdg');
    try {
      await writeFile(join(root,'unicode.md'),data);
      for(const file of sourceFiles)
        await copyFile(join('benchmarks','extraction','fixtures',file),join(root,file));
      const cases:[string,IngestionConfig['pdfMode'],string,number][]=[
        ['unicode.md','text','ok',1],
        ['policy.pdf','text','partial',1],
        ['policy.docx','text','partial',1],
        ['scan.pdf','ocr','partial',1],
      ];
      for(const [path,mode,status,min] of cases){
        const t=performance.now();
        const result=await manager.ingest(buildConfig(mode),root,pluginId,path,()=>true);
        assert.equal(result.status,status,'unexpected extraction status '+path);
        assert.ok(result.source && result.source.blocks.length>=min);
        assert.ok(result.chunks.length>0);
        const bytes=await readFile(join(root,path));
        verifyProvenance(result,bytes);
        assert.equal(result.source!.sha256,require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
        const loaded=await manager.verified(path,()=>true);
        assert.equal(loaded?.generationId,result.generationId);
        assert.equal(manager.snapshot().searchReady,false);
        console.log('OKS05C_REAL_FORMAT',path,result.status,'blocks',result.source!.blocks.length,
          'chunks',result.chunks.length,'ms',Math.round(performance.now()-t));
      }
      const rootId=await trustedVaultRoot(root);
      const store=await AdvancedGenerationStore.open(rootId,pluginId);
      assert.ok(store.get('unicode.md'),'cold restart recovers verified generation');
      assert.ok(store.get('scan.pdf'),'cold restart recovers second source');
      await writeFile(join(root,'unicode.md'),data+'# Changed\n');
      assert.equal(await manager.verified('unicode.md',()=>true),null,'modified source cannot yield stale evidence');
      assert.ok(await manager.verified('scan.pdf',()=>true),'unmodified source still permitted');
      await writeFile(join(store.path,'CURRENT'),'{}\n',{mode:0o600});
      await assert.rejects(AdvancedGenerationStore.open(rootId,pluginId),
        (e:unknown)=>e instanceof IngestError && e.code==='INDEX_PUBLICATION_UNCERTAIN');
      console.log('OKS05C_REAL_HOST_PASS: 4 formats, private restart, stale refusal, corruption fail closed');
    } finally {
      await manager.dispose().catch(()=>{});
      if(priorXdg===undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME=priorXdg;
      await rm(tmp,{recursive:true,force:true});
    }
  });


test('B1/B2: concurrent stop during admission and SIGTERM-resistant descendants never remain runnable',
  {skip:!enabled?reason:undefined,timeout:90000},async()=>{
    if(!python||!snapshot)throw Error('TEST_INTERPRETER_MISSING');
    const temp=await mkdtemp(join(homedir(),'.cache','oks05c-resistance-'));
    const root=join(temp,'vault');await mkdir(root,{mode:0o700});
    const marker=join(temp,'child.pid');
    const entry=join(temp,'advanced_ingest.py');
    // This is a synthetic *hostile* worker, not an alternate extraction adapter.
    // It deliberately ignores SIGTERM in both leader and a detached descendant.
    const code=[
      'import os,sys,subprocess,signal,time',
      'signal.signal(signal.SIGTERM,signal.SIG_IGN)',
      'child=subprocess.Popen([sys.executable,"-c",'+JSON.stringify(
        'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(600)')+
        '],start_new_session=True)',
      'with open('+JSON.stringify(marker)+',"w") as file: file.write(str(child.pid))',
      'while True: time.sleep(0.2)',
    ].join('\n')+'\n';
    await writeFile(entry,code,{mode:0o600});
    const raw=Buffer.from('# synthetic only\n');
    await writeFile(join(root,'file.md'),raw,{mode:0o600});
    const identity=await trustedVaultRoot(root);
    const cfg:IngestionConfig={...buildConfig('text'),entry};
    const first=new AdvancedIngestRunner();
    try{
      const start=first.ingest(cfg,identity,'file.md',sha(raw),'oks-advanced-markdown-v1',20000);
      await Promise.all([first.stop(),first.stop()]);
      await assert.rejects(start,(e:unknown)=>e instanceof IngestError &&
        (e.code==='ADVANCED_CANCELLED'||e.code==='ADVANCED_EXIT'));
      assert.equal(first.busy,false);
      assert.equal(first.blocked,false);
      const second=new AdvancedIngestRunner();
      const running=second.ingest(cfg,identity,'file.md',sha(raw),'oks-advanced-markdown-v1',20000);
      let childPid=0;
      const wait=Date.now();
      while(Date.now()-wait<12000){
        try{childPid=Number((await readFile(marker,'utf8')).trim());if(childPid>0)break;}
        catch{};
        await sleep(50);
      }
      assert.ok(childPid>0,'SIGTERM-resistant descendant must actually start');
      await Promise.all([second.stop(),second.stop(),second.stop()]);
      await assert.rejects(running,(e:unknown)=>e instanceof IngestError &&
        (e.code==='ADVANCED_CANCELLED'||e.code==='ADVANCED_EXIT'));
      assert.equal(second.busy,false);
      assert.equal(second.blocked,false);
      // Check the exact previously observed worker PID: allow only nonexistent
      // or zombie (already non-runnable) after the cgroup has been stopped.
      try{
        const proc=await readFile('/proc/'+childPid+'/stat','utf8');
        const state=proc.slice(proc.lastIndexOf(')')+2).split(/\s+/)[0];
        assert.equal(state,'Z','no runnable SIGTERM-resistant descendant');
      }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      console.log('OKS05C_PROCESS_TREE_PASS: admission-stop; concurrent stop; SIGTERM-resistant descendant; cgroup empty');
    }finally{await first.stop().catch(()=>{});await rm(temp,{recursive:true,force:true});}
  });

test('adversarial real PDF: malformed source, source changed mid-extraction, cancellation while processing suppress publication',
  {skip:!enabled?reason:undefined,timeout:100000},async()=>{
    const priorXdg=process.env.XDG_DATA_HOME;
    const tmp=await mkdtemp(join(tmpdir(),'oks05c-adversarial-'));
    const vault=join(tmp,'vault');const xdg=join(tmp,'xdg');
    await mkdir(vault,{mode:0o700});await mkdir(xdg,{mode:0o700});
    process.env.XDG_DATA_HOME=xdg;
    const plugin='oks-synthetic-evidence';
    const manager=new AdvancedIngestionManager();
    const source=join(vault,'malformed.pdf');
    try {
      await writeFile(source,Buffer.from('%PDF-1.7\nintentionally damaged synthetic input'));
      const rejected=await manager.ingest(buildConfig('text'),vault,plugin,'malformed.pdf',()=>true);
      assert.equal(rejected.status,'failed','corrupt PDF must not be considered extracted');
      assert.equal(rejected.chunks.length,0,'failed extraction has no publishable chunks');
      assert.equal(await manager.verified('malformed.pdf',()=>true),null);
      const path='policy.pdf';
      await copyFile(join('benchmarks','extraction','fixtures',path),join(vault,path));
      const inFlight=manager.ingest(buildConfig('text'),vault,plugin,path,()=>true);
      const wait=Date.now();
      while(!manager.runner.busy && Date.now()-wait<5000) await sleep(10);
      assert.ok(manager.runner.busy,'real parser must enter controlled worker before tampering');
      await sleep(160);
      await writeFile(join(vault,path),Buffer.from('%PDF-1.7\nchanged while extracting'));
      let nonready:boolean;
      try {
        const result=await inFlight;
        nonready=result.status==='failed' || result.status==='unsupported';
      } catch(e){ nonready=e instanceof IngestError; }
      assert.ok(nonready,'source changed during extraction must fail closed');
      assert.equal(await manager.verified(path,()=>true),null);
      await copyFile(join('benchmarks','extraction','fixtures',path),join(vault,path));
      const cancelled=manager.ingest(buildConfig('text'),vault,plugin,path,()=>true);
      const deadline=Date.now();
      while(!manager.runner.busy && Date.now()-deadline<5000) await sleep(10);
      assert.ok(manager.runner.busy,'worker entered extraction for cancellation');
      await manager.stop();
      await assert.rejects(cancelled,(e:unknown)=>e instanceof IngestError &&
        (e.code==='ADVANCED_CANCELLED' || e.code==='ADVANCED_UNAVAILABLE'));
      assert.equal(manager.runner.busy,false);
      assert.equal(await manager.verified(path,()=>true),null);
      assert.equal(manager.snapshot().status,'disabled');
      console.log('OKS05C_ADVERSARIAL_PASS: corrupt PDF=failed, midflight mutation=no evidence, processing cancelled, no publication');
    }finally{
      await manager.dispose().catch(()=>{});
      if(priorXdg===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=priorXdg;
      await rm(tmp,{recursive:true,force:true});
    }
  });
