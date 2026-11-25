/** 05D adversarial lifecycle: authoritative stop/invalidation across async boundaries. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AdvancedRetrievalManager} from '../plugin/src/advanced/retrieval-manager';
import type {AdvancedIngestionManager} from '../plugin/src/advanced/manager';
import type {IngestionConfig} from '../plugin/src/search/settings';
import type {IngestResponse} from '../plugin/src/advanced/protocol';
import {ModelError} from '../plugin/src/advanced/model-protocol';

const response=JSON.parse(readFileSync('contracts/fixtures/advanced-ingestion-v1.json','utf8'))
  .cases[0].response as IngestResponse;
const config={enabled:true} as IngestionConfig;

test('05D remediation B5: stop during awaited initial recovery never dispatches embedding',async()=>{
  let release!:()=>void;
  const recovery=new Promise<void>(resolve=>{release=resolve;});
  let embeddings=0,stops=0;
  const ingestion={
    runner:{stop:async()=>{stops++;},embed:async()=>{embeddings++;throw Error('must-not-embed');}},
    verified:async()=>response,
  } as unknown as AdvancedIngestionManager;
  const manager=new AdvancedRetrievalManager(ingestion);
  Object.assign(manager,{recover:async()=>recovery});
  const pending=manager.index(config,'/synthetic','test',response.source!.sourceId,()=>true)
    .catch(error=>error instanceof ModelError?error.code:'UNEXPECTED');
  const stop=manager.stop();
  release();
  assert.equal(await pending,'MODEL_CANCELLED');
  await stop;
  assert.equal(embeddings,0,'stopped manager must not start a new model job after recovery');
  assert.ok(stops>=1);
  assert.equal(manager.snapshot().status,'disabled');
});

test('05D remediation B6: invalidation during final lexical source scan suppresses all stale hits',async()=>{
  let manager!:AdvancedRetrievalManager;
  let verified=0,stops=0;
  const ingestion={
    runner:{stop:async()=>{stops++;}},
    recover:async()=>{},
    verifiedAll:async()=>{
      if(++verified===2)manager.invalidate(response.source!.sourceId);
      return {documents:[response],staleCount:0};
    },
  } as unknown as AdvancedIngestionManager;
  manager=new AdvancedRetrievalManager(ingestion);
  Object.assign(manager,{
    recover:async()=>{},
    store:{snapshot:()=>null,revoke:()=>{}},
  });
  const result=await manager.search(config,'/synthetic','test',{
    query:'REQ-X-1',requestedMode:'lexical',limit:5,
  },()=>true);
  assert.equal(verified,2);
  assert.equal(result.status,'failed');
  assert.equal(result.executedMode,'none');
  assert.equal(result.hits.length,0,'invalidation must revoke in-flight non-indexed lexical evidence');
  assert.ok(['SOURCE_STALE','MODEL_CANCELLED'].includes(result.error??''));
  assert.ok(stops>=1);
});

test('systemic Advanced runner retains failed shutdown owner after active slot settles',async()=>{
  const {AdvancedIngestRunner}=await import('../plugin/src/advanced/runner');
  const runner=new AdvancedIngestRunner(),abort=new AbortController();
  const failed=Promise.reject(Error('synthetic unproved process exit'));
  void failed.catch(()=>{});
  Object.assign(runner,{poison:true,failedOwner:{unit:'synthetic.service',controller:abort,stopPromise:failed}});
  await assert.rejects(runner.stop(),/synthetic unproved process exit/);
  await assert.rejects(runner.stop(),/synthetic unproved process exit/);
  assert.equal(runner.blocked,true);
  assert.equal(abort.signal.aborted,true);
});

test('systemic Advanced runner commits retirement before a throwing physical abort',async()=>{
  const {AdvancedIngestRunner}=await import('../plugin/src/advanced/runner');
  const runner=new AdvancedIngestRunner(),abort=new AbortController();
  const job={unit:'synthetic.service',controller:abort,stopPromise:Promise.resolve(),retired:false};
  Object.assign(runner,{running:job});
  abort.abort=()=>{assert.equal(job.retired,true);throw Error('synthetic abort');};
  await assert.rejects(runner.stop(),/synthetic abort/);
  assert.equal(job.retired,true);
  assert.equal(abort.signal.aborted,false);
});

test('systemic source retirement drains manager operation independently of runner stop',async()=>{
  const {AdvancedIngestionManager}=await import('../plugin/src/advanced/manager');
  let tracked:Promise<void>|undefined,release!:()=>void;
  const active=new Promise<void>(resolve=>{release=resolve;});
  const manager=new AdvancedIngestionManager(work=>{tracked=work;});
  manager.runner.stop=async()=>{};
  Object.assign(manager,{active,activePath:'fixture.md',controller:new AbortController()});
  try{
    manager.invalidate('fixture.md');
    assert.ok(tracked);
    let settled=false;void tracked.then(()=>{settled=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);
    release();await tracked;
    assert.equal(settled,true);
  }finally{release();}
});
