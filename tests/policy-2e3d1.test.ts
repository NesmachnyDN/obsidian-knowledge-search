import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, link } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedVaultReader } from '../plugin/src/standalone/source';
import { BOUNDS, StandaloneError } from '../plugin/src/standalone/contracts';

async function fixture(run: (root:string)=>Promise<void>):Promise<void> {
  const parent=await mkdtemp(join(tmpdir(),'oks-inventory-'));
  const root=join(parent,'vault');
  try { await mkdir(root); await run(root); }
  finally { await rm(parent,{recursive:true,force:true}); }
}
const denied=(error:unknown):boolean=>error instanceof StandaloneError;

test('complete inventory observes canonical originals and leaves Basic enumeration unchanged',async()=>{
  await fixture(async root=>{
    await mkdir(join(root,'nested'));
    await mkdir(join(root,'.obsidian'));
    await writeFile(join(root,'.obsidian','ignored.md'),'not in supported domain');
    await writeFile(join(root,'attachment.pdf'),'not read');
    await writeFile(join(root,'nested','тест.MD'),'second');
    await writeFile(join(root,'a.md'),'first');
    const native=['nested/тест.MD','a.md'];
    const reader=await BoundedVaultReader.open(root,()=>native);
    const inventory=await reader.completeMarkdownInventory();
    assert.equal(inventory.rootId,reader.rootId);
    assert.deepEqual(inventory.sources.map(p=>p.version.sourceId),['a.md','nested/тест.MD']);
    assert.deepEqual(inventory.sources[0],await reader.readLifecycleProof('a.md'));
    assert.ok(Object.isFrozen(inventory)&&Object.isFrozen(inventory.sources)&&Object.isFrozen(inventory.sources[0]!.version));
    assert.deepEqual(native,['nested/тест.MD','a.md']);
    assert.deepEqual(await reader.list(),['a.md','nested/тест.MD']);
  });
});

test('complete inventory distinguishes an empty domain from an incomplete native enumeration',async()=>{
  await fixture(async root=>{
    let native:string[]=[];
    const reader=await BoundedVaultReader.open(root,()=>native);
    assert.deepEqual((await reader.completeMarkdownInventory()).sources,[]);
    await writeFile(join(root,'a.md'),'a');
    assert.deepEqual(await reader.list(),[]);
    for (const paths of [[],['a.md','b.md'],['a.md','a.md'],['../a.md'],['.hidden.md']]) {
      native=paths;
      await assert.rejects(reader.completeMarkdownInventory(),denied);
    }
  });
});

test('complete inventory rejects observed membership and exact-version changes',async()=>{
  for (const mutate of [
    (root:string)=>writeFileSync(join(root,'b.md'),'b'),
    (root:string)=>writeFileSync(join(root,'a.md'),'new version'),
    (root:string)=>{writeFileSync(join(root,'replacement.md'),'a');renameSync(join(root,'replacement.md'),join(root,'a.md'));},
  ]) await fixture(async root=>{
    await writeFile(join(root,'a.md'),'a');
    let calls=0;
    const reader=await BoundedVaultReader.open(root,()=>{
      if(++calls===2)mutate(root);
      return ['a.md'];
    });
    await assert.rejects(reader.completeMarkdownInventory(),denied);
  });
});

test('complete inventory rejects links, unsupported visible directories and undecodable names',async()=>{
  for (const make of [
    async (root:string)=>symlink('a.md',join(root,'alias.md')),
    async (root:string)=>symlink('.',join(root,'alias')),
    async (root:string)=>link(join(root,'a.md'),join(root,'alias.md')),
    async (root:string)=>mkdir(join(root,'invalid:directory')),
    async (root:string)=>writeFile(Buffer.concat([Buffer.from(root+'/'),Buffer.from([0xff]),Buffer.from('.md')]),'invalid'),
  ]) await fixture(async root=>{
    await writeFile(join(root,'a.md'),'a');
    await make(root);
    const reader=await BoundedVaultReader.open(root,()=>['a.md']);
    await assert.rejects(reader.completeMarkdownInventory(),denied);
  });
});

test('complete inventory refuses over-limit files, depth and directory entries without partial results',async()=>{
  await fixture(async root=>{
    await writeFile(join(root,'a.md'),Buffer.alloc(BOUNDS.fileBytes+1));
    const reader=await BoundedVaultReader.open(root,()=>['a.md']);
    await assert.rejects(reader.completeMarkdownInventory(),denied);
  });
  await fixture(async root=>{
    await mkdir(join(root,...Array.from({length:BOUNDS.inventoryDepth+1},()=> 'd')),{recursive:true});
    const reader=await BoundedVaultReader.open(root,()=>[]);
    await assert.rejects(reader.completeMarkdownInventory(),denied);
  });
  await fixture(async root=>{
    for(let i=0;i<=BOUNDS.inventoryDirectoryEntries;i++)
      await writeFile(join(root,'attachment-'+i+'.txt'),'');
    const reader=await BoundedVaultReader.open(root,()=>[]);
    await assert.rejects(reader.completeMarkdownInventory(),denied);
  });
  await fixture(async root=>{
    for(let i=0;i<=BOUNDS.sources;i++)await writeFile(join(root,'note-'+i+'.md'),'');
    const reader=await BoundedVaultReader.open(root,()=>[]);
    await assert.rejects(reader.completeMarkdownInventory(),denied);
  });
});

test('complete inventory denies cancellation and replaced root',async()=>{
  await fixture(async root=>{
    await writeFile(join(root,'a.md'),'a');
    const controller=new AbortController();
    const reader=await BoundedVaultReader.open(root,()=>{controller.abort();return ['a.md'];});
    await assert.rejects(reader.completeMarkdownInventory(controller.signal),denied);
    await assert.rejects(reader.completeMarkdownInventory(controller.signal),denied);
    await rename(root,root+'-old');
    await mkdir(root);
    await writeFile(join(root,'a.md'),'a');
    await assert.rejects(reader.completeMarkdownInventory(),denied);
  });
});

test('complete inventory bounds aggregate traversal even across individually bounded directories',async()=>{
  await fixture(async root=>{
    let remaining=BOUNDS.inventoryEntries+1;
    let folder=0;
    while(remaining>0){
      const directory=join(root,'folder-'+folder++);
      await mkdir(directory);
      const count=Math.min(BOUNDS.inventoryDirectoryEntries,remaining);
      // Bounded fixture creation, not a production or model workload.
      for(let i=0;i<count;i++)await writeFile(join(directory,'attachment-'+i+'.txt'),'');
      remaining-=count;
    }
    const reader=await BoundedVaultReader.open(root,()=>[]);
    await assert.rejects(reader.completeMarkdownInventory(),(e:unknown)=>e instanceof StandaloneError&&e.code==='SOURCE_LIMIT');
  });
});

test('same-byte replacement between initial walk and proof and late abort deny observation',async()=>{
  await fixture(async root=>{
    await writeFile(join(root,'a.md'),'a');
    let calls=0;
    const reader=await BoundedVaultReader.open(root,()=>{
      if(++calls===1){
        writeFileSync(join(root,'replacement.md'),'a');
        renameSync(join(root,'replacement.md'),join(root,'a.md'));
      }
      return ['a.md'];
    });
    await assert.rejects(reader.completeMarkdownInventory(),denied);
    const controller=new AbortController();
    calls=0;
    const late=await BoundedVaultReader.open(root,()=>{
      if(++calls===3)controller.abort();
      return ['a.md'];
    });
    await assert.rejects(late.completeMarkdownInventory(controller.signal),denied);
  });
});
