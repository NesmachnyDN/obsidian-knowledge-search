import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings,parseSettings} from '../plugin/src/search/settings';
import {defaultMarkingRules,validNewMaterialRuleConfig,decideNewMaterialMarking} from '../plugin/src/ai/new-material-policy';
import {NewMaterialTracker} from '../plugin/src/ai/new-material-tracker';
import {hash} from '../plugin/src/standalone/contracts';
import {parsePolicyMetadata} from '../plugin/src/standalone/markdown-parse';
import {translateSettings} from '../plugin/src/search/settings-i18n';

test('POLICY.2b optional nested settings migrate safely and round-trip detached validated rules',()=>{
  assert.equal(defaultSettings().markingRules,undefined);
  const rules={...defaultMarkingRules(),defaultAction:'set-private' as const,rules:[{id:'r1',action:'set-private' as const,when:{folderSegments:['inbox']}}]};
  const saved={...defaultSettings(),markingRules:rules};
  const loaded=parseSettings(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(loaded,saved);assert.notEqual(loaded.markingRules,rules);
  for(const markingRules of [null,undefined,{...rules,version:2},{...rules,unknown:true},{...rules,rules:[{id:'x',action:'set-external',when:{folderSegments:['a/b']}}]}])
    assert.throws(()=>parseSettings({...saved,markingRules}),/SETTINGS_INVALID/);
  const {presentationMode:_mode,...old}=saved;
  assert.throws(()=>parseSettings({...old,version:5}),/SETTINGS_INVALID/);
  const large={...rules,rules:Array.from({length:16},(_,i)=>({id:String(i),action:'set-private',when:{properties:[{key:'text',valueType:'string',operator:'eq',value:'x'.repeat(4096)}]}}))};
  assert.equal(validNewMaterialRuleConfig(large),false);
});
test('POLICY.2b only tracked current native create identity is verified new; rename/delete/reload deny unknown',()=>{
  const tracker=new NewMaterialTracker<object>(),owner={},other={};
  assert.equal(tracker.state('inbox/note.md',owner),'unresolved');
  tracker.created('inbox/note.md',owner);
  assert.equal(tracker.state('inbox/note.md',owner),'verified-new');
  assert.equal(tracker.state('inbox/note.md',other),'unresolved');
  tracker.created('inbox/note.md',owner);tracker.created('inbox/note.md',owner);
  assert.equal(tracker.state('inbox/note.md',owner),'unresolved');
  tracker.invalidate('inbox');
  tracker.created('inbox/note.md',other);
  assert.equal(tracker.state('inbox/note.md',other),'verified-new');
  tracker.clear();assert.equal(tracker.state('inbox/note.md',other),'unresolved');
  for(let i=0;i<513;i++)tracker.created('inbox/n'+i+'.md',{});
  tracker.created('new.md',owner);assert.equal(tracker.state('new.md',owner),'unresolved');
});
test('POLICY.2b unknown lifecycle on a current original never completes marking or permits external',()=>{
  const bytes=Buffer.from('# synthetic'),sourceId='note.md',sha256=hash(bytes),rootId=hash('root');
  const proof=parsePolicyMetadata(sourceId,bytes,rootId,sha256);
  const input={sourceId,sha256,rootId,proof,lifecycle:{state:'unresolved' as const,sourceId,sha256,rootId},provenance:null};
  const r=decideNewMaterialMarking(defaultMarkingRules(),input);
  assert.equal(r.complete,false);assert.equal(r.externalBlocked,true);assert.equal(r.reason,'lifecycle-unresolved');
  assert.equal(translateSettings('Preview active note','ru'),'Проверить активную заметку');
  assert.equal(translateSettings('Preview active note','en'),'Preview active note');
});
