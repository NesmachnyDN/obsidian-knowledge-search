import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphUiRequest } from '../plugin/src/search/graph-ui';
import { uiRequest } from '../plugin/src/search/controller';

test('06B.3c2 graph UI explicit bounded request retains typed and metadata scope',()=>{
  const request=uiRequest('REQ-01',7,[{key:'status',operator:'eq',valueType:'string',value:'active'}],'literal',{tag:'test'});
  const graph=graphUiRequest(request,2,'incoming','depends-on');
  assert.equal(graph.query,request.query);assert.equal(graph.matchMode,'literal');assert.equal(graph.limit,7);
  assert.deepEqual(graph.scope,{mode:'selected',kind:'properties',predicates:request.predicates,metadata:{tag:'test'}});
  assert.deepEqual(graph.expansion,{depth:2,direction:'incoming',relationIds:['depends-on'],fanOut:16,maxExpanded:32});
});
test('06B.3c2 graph UI never broadens unsupported request scope or silently falls back',()=>{
  const request=uiRequest('REQ-01',7);
  assert.deepEqual(graphUiRequest(request,1,'both','').scope,{mode:'vault-wide'});
  assert.throws(()=>graphUiRequest({...request,scope:['a.md']},1,'both',''));
  assert.throws(()=>graphUiRequest({...request,requestedMode:'hybrid'},1,'both',''));
  assert.throws(()=>graphUiRequest(request,3,'both',''));
  assert.throws(()=>graphUiRequest(request,1,'unknown',''));
  assert.throws(()=>graphUiRequest({...request,query:''},1,'both',''));
});
