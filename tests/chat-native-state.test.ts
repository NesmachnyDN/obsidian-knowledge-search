import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeChatStateMachine } from '../plugin/src/search/chat-native-state';

test('06H.2 native state requires an explicit valid scope and fences stale callbacks', () => {
  const state = new NativeChatStateMachine();
  assert.throws(() => state.begin(), {message: 'SCOPE_INVALID'});
  const selected = state.select({mode: 'vault-wide'});
  const turn = state.begin();
  assert.equal(turn.selector.mode, 'vault-wide');
  assert.equal(state.current(turn.generation), true);
  state.retire();
  assert.equal(state.current(turn.generation), false);
  assert.equal(state.snapshot().selector, null);
  assert.equal(selected.priorQuestionIds.length, 0);
});

test('06H.2 native state rejects invalid scope and cannot carry prior history across a scope edit', () => {
  const state = new NativeChatStateMachine();
  assert.throws(() => state.select({mode: 'selected', kind: 'files', sourceIds: []}), {message: 'SCOPE_INVALID'});
  state.select({mode: 'selected', kind: 'files', sourceIds: ['a.md']});
  state.selectPrior(['one', 'two', 'three'], ['one', 'two']);
  assert.deepEqual(state.snapshot().priorQuestionIds, ['one', 'two']);
  state.select({mode: 'selected', kind: 'files', sourceIds: ['b.md']});
  assert.deepEqual(state.snapshot().priorQuestionIds, []);
  assert.throws(() => state.selectPrior(['one'], ['one', 'two']), {message: 'INVALID_REQUEST'});
  assert.throws(() => state.selectPrior(['one', 'two', 'three'], ['one', 'two', 'three']), {message: 'INVALID_REQUEST'});
});

import { appliedChatScope, editorChatScope, manualChatScope } from '../plugin/src/search/chat-native-scope';
import { hash, type SearchResponse } from '../plugin/src/standalone/contracts';

test('06H.2 native state invalid choice removes old scope; detached nested selector cannot mutate',()=>{
  const state=new NativeChatStateMachine();
  const sources=['a.md'];state.select({mode:'selected',kind:'files',sourceIds:sources});sources.push('b.md');
  const selected=state.snapshot().selector;
  assert.deepEqual(selected,{mode:'selected',kind:'files',sourceIds:['a.md']});
  assert.throws(()=>{if(selected?.mode==='selected'&&selected.kind==='files')selected.sourceIds.push('x.md');});
  const active=state.begin();assert.throws(()=>state.begin());state.retireTurn();
  assert.equal(state.current(active.generation),false);
  assert.throws(()=>state.select({mode:'selected',kind:'files',sourceIds:[]}));
  assert.equal(state.snapshot().selector,null);
});

test('06H.2 explicit manual scopes keep typed values and reject invalid or empty selectors',()=>{
  const make=(kind:string,value='',type='string',op='eq',raw='',tag='',link='')=>manualChatScope(kind,value,type,op,raw,tag,link);
  assert.deepEqual(make('vault-wide'),{mode:'vault-wide'});
  assert.deepEqual(make('files','a.md\nb.md'),{mode:'selected',kind:'files',sourceIds:['a.md','b.md']});
  assert.deepEqual(make('folder','notes'),{mode:'selected',kind:'folder',path:'notes'});
  assert.deepEqual(make('properties','priority','number','eq','3','#topic'),{mode:'selected',kind:'properties',
    predicates:[{key:'priority',valueType:'number',operator:'eq',value:3}],metadata:{tag:'#topic'}});
  for(const args of [['',''],['folder','../a'],['files','a.md\na.md'],['files','../a.md'],['properties',''],['properties','x','number','eq','"1"']])
    assert.throws(()=>make(...args as [string,string,string,string,string]));
});

test('06H.2 applied results retain exact canonical distinct source versions and fail closed on stale responses',()=>{
  const generationId=hash('generation'), sourceSha256=hash('source');
  const hit={sourceId:'a.md',sourceSha256,indexGenerationId:generationId};
  const response={status:'ok',executedMode:'lexical',indexGenerationId:generationId,staleSourceCount:0,hits:[hit,hit]} as SearchResponse;
  assert.deepEqual(appliedChatScope(response,generationId),{mode:'selected',kind:'applied-results',sources:[{sourceId:'a.md',sourceSha256}]});
  assert.throws(()=>appliedChatScope(response,hash('new')));
  assert.throws(()=>appliedChatScope({...response,hits:[]},generationId));
  assert.throws(()=>appliedChatScope({...response,staleSourceCount:1},generationId));
  assert.throws(()=>appliedChatScope({...response,hits:[response.hits[0]!,{...response.hits[0]!,sourceSha256:hash('changed')}]},generationId));
});

test('06H.2 active editor scope refuses dirty buffer and maps exact unicode/CRLF range without retaining editor text',()=>{
  const raw=Buffer.from('Привет 😀\r\nsecond\n');
  const text='Привет 😀\nsecond\n';
  assert.deepEqual(editorChatScope('active-note','a.md',text,raw),{mode:'selected',kind:'active-note',sourceId:'a.md'});
  const selection={anchor:{line:0,utf16Column:7},head:{line:1,utf16Column:6}};
  const result=editorChatScope('editor-selection','a.md',text,raw,selection);
  assert.equal(result.mode,'selected');
  if(result.mode==='selected'&&result.kind==='editor-selection'){
    assert.equal(result.range.sourceSha256,hash(raw));assert.equal(result.range.byteStart,Buffer.byteLength('Привет '));
    assert.equal(result.range.byteEnd,raw.byteLength-1);assert.equal('editorText' in result.range,false);
  }else assert.fail('wrong scope');
  assert.throws(()=>editorChatScope('active-note','a.md','unsaved',raw));
  assert.throws(()=>editorChatScope('editor-selection','a.md',text,raw));
  assert.throws(()=>editorChatScope('editor-selection','a.md',text,raw,{anchor:{line:0,utf16Column:8},head:selection.head}));
});
