import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureHardSearchScope,defaultHardSearchScope,HARD_SEARCH_SCOPE_VERSION} from '../plugin/src/standalone/hard-search-scope';
import {BoundedVaultReader} from '../plugin/src/standalone/source';
const config=(excludedFolders:string[]=[],excludedFiles:string[]=[])=>({version:HARD_SEARCH_SCOPE_VERSION,excludedFolders,excludedFiles});

test('hard scope exact rooted folder and file rules are immutable, order independent and format neutral',()=>{
  const raw=config(['nested/control','private'],['public/report.pdf','one.md']);
  const scope=captureHardSearchScope(raw),reversed=captureHardSearchScope(config([...raw.excludedFolders].reverse(),[...raw.excludedFiles].reverse()));
  assert.equal(scope.revision,reversed.revision);raw.excludedFolders.length=0;raw.excludedFiles.length=0;
  for(const path of ['private','private/note.md','nested/control/file.docx','public/report.pdf','one.md'])assert.equal(scope.allows(path),false,path);
  for(const path of ['private-old/note.md','not/private/note.md','nested/control-old/note.md','public/report2.pdf','other/one.md','root.md','русский/заметка.md'])assert.equal(scope.allows(path),true,path);
  const literal=captureHardSearchScope(config(['a*'],['q?.md']));
  assert.equal(literal.allows('a*/x.md'),false);assert.equal(literal.allows('abc/x.md'),true);
  assert.equal(literal.allows('q?.md'),false);assert.equal(literal.allows('qa.md'),true);
  const long='a'.repeat(1021)+'.md';assert.equal(scope.allows(long),true);
  assert.equal(captureHardSearchScope(config([], [long])).allows(long),false);
  assert.equal(scope.hasExclusions,true);assert.ok(Object.isFrozen(scope));assert.equal(captureHardSearchScope(defaultHardSearchScope()).hasExclusions,false);
});
test('hard scope rejects malformed, absolute, traversal, ambiguous and oversized configurations',()=>{
  for(const path of ['', '/absolute','../escape','x/../y','x//y','x/','x\\y','x:y','.hidden','x\nname','x\0name','\ud800','a'.repeat(1025)]){
    assert.throws(()=>captureHardSearchScope(config([path])),/SEARCH_SCOPE_INVALID/);
    assert.equal(captureHardSearchScope(defaultHardSearchScope()).allows(path),false);
  }
  for(const bad of [null,{},config(['same','same']),config(Array.from({length:65},(_,i)=>'p'+i)),{...config(),extra:true},{...config(),excludedFiles:[null]}])assert.throws(()=>captureHardSearchScope(bad),/SEARCH_SCOPE_INVALID/);
});
test('scoped standalone reader excludes direct source proofs, hints and enumeration without widening historical inventory',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'oks-hard-scope-')),root=await realpath(directory);
  try{
    const paths=['control/private.md','control-old/visible.md','blocked.md','visible.md'];
    for(const folder of ['control','control-old'])await mkdir(join(root,folder));
    for(const path of paths)await writeFile(join(root,path),'# synthetic '+path);
    const invalid=await BoundedVaultReader.open(root,()=>[...paths,'bad\nname.md'],config(['control']));
    await assert.rejects(invalid.list(),/SOURCE_REJECTED/);
    const scoped=await BoundedVaultReader.open(root,()=>paths,config(['control'],['blocked.md']));
    assert.deepEqual(await scoped.list(),['control-old/visible.md','visible.md']);
    for(const path of ['control/private.md','blocked.md']){
      await assert.rejects(scoped.read(path),/SEARCH_SCOPE_RESTRICTED/);
      await assert.rejects(scoped.readVersionProof(path),/SEARCH_SCOPE_RESTRICTED/);
      await assert.rejects(scoped.readLifecycleProof(path),/SEARCH_SCOPE_RESTRICTED/);
      await assert.rejects(scoped.versionHints([path]),/SEARCH_SCOPE_RESTRICTED/);
    }
    await assert.rejects(scoped.completeMarkdownInventory(),/SEARCH_SCOPE_RESTRICTED/);
    assert.equal(Buffer.from(await scoped.read('control-old/visible.md')).toString(),'# synthetic control-old/visible.md');
    const unscoped=await BoundedVaultReader.open(root,()=>paths);
    assert.deepEqual(await unscoped.list(),[...paths].sort());
    assert.equal((await unscoped.completeMarkdownInventory()).sources.length,4);
    assert.equal((await unscoped.readVersionProof('blocked.md')).sourceId,'blocked.md');
    const empty=await BoundedVaultReader.open(root,()=>paths,defaultHardSearchScope());
    assert.deepEqual(await empty.list(),await unscoped.list());
    assert.equal((await empty.completeMarkdownInventory()).sources.length,4);
  }finally{await rm(directory,{recursive:true,force:true});}
});
