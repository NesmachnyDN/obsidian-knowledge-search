import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { checkLocalConnection, ConnectionCheckSession } from '../plugin/src/ai/connection-check';
import type { ProviderConfig } from '../plugin/src/ai/contracts';

const token = 'synthetic-check-token';
const model = 'synthetic-check@v1';
const embedding = (vector: unknown = [1,0,0]) => ({ model, data: [{ object:'embedding', index:0, embedding:vector }] });
const generated = (claims: unknown = [{kind:'quotation', text:'blue', citationIds:[0]}]) => ({
  model, usage:{completion_tokens:8}, choices:[{index:0,finish_reason:'stop',
    message:{role:'assistant',content:JSON.stringify({claims})}}]
});
const json = (res:ServerResponse, body:unknown, status=200):void => {
  res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body));
};
async function fixture(run:(config:ProviderConfig)=>Promise<void>,
  handle:(req:IncomingMessage,res:ServerResponse,body:unknown)=>void):Promise<void> {
  const server = createServer((req,res) => {
    const chunks:Buffer[]=[];
    req.on('data',(chunk:Buffer)=>chunks.push(chunk));
    req.on('end',()=>handle(req,res,JSON.parse(Buffer.concat(chunks).toString('utf8'))));
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const address=server.address();
    if (!address || typeof address==='string') throw Error('FIXTURE_ADDRESS');
    await run({state:'configured',transport:'local',origin:'http://127.0.0.1:'+address.port,
      identity:{model:'synthetic-check',revision:'v1'},
      limits:{timeoutMs:1000,maxInputBytes:4096,maxCandidates:2,maxOutputTokens:128,maxConcurrent:1}});
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }
}
const signal = () => new AbortController().signal;

test('CHECK-02/03: exact authenticated role requests, validated responses, no configuration mutations',async()=>{
  const calls:unknown[]=[];
  await fixture(async cfg=>{
    const saved=structuredClone(cfg);
    const emb=await checkLocalConnection('embedding',cfg,token,3,signal());
    assert.equal(emb.ok,true); if(emb.ok) assert.equal(emb.dimension,3);
    assert.ok(emb.elapsedMs>=0);
    const gen=await checkLocalConnection('generation',cfg,token,undefined,signal());
    assert.equal(gen.ok,true); if(gen.ok) assert.equal(gen.dimension,undefined);
    assert.deepEqual(cfg,saved);
    assert.equal(calls.length,2);
  },(req,res,body)=>{
    assert.equal(req.headers.authorization,'Bearer '+token);
    calls.push(body);
    if(req.url==='/v1/embeddings'){
      assert.deepEqual(body,{model,input:['OKS connection check'],encoding_format:'float'});
      json(res,embedding());
    } else {
      assert.equal(req.url,'/v1/chat/completions');
      const b=body as {model:string;max_tokens:number;messages:{content:string}[]};
      assert.equal(b.model,model);assert.equal(b.max_tokens,128);
      assert.deepEqual(JSON.parse(b.messages[1]!.content),{question:'What color?',passages:[{id:0,text:'The color is blue.'}]});
      json(res,generated());
    }
  });
});
test('CHECK-02: unsupported modes, invalid dimensions/auth/config and cancelled calls fail before network',async()=>{
  let calls=0;
  await fixture(async cfg=>{
    const cloud={...cfg,transport:'cloud' as const,origin:'https://api.example.com'};
    const cancelled=new AbortController();cancelled.abort();
    for(const [result,code] of [
      [await checkLocalConnection('embedding',cloud,token,3,signal()),'ENDPOINT_DENIED'],
      [await checkLocalConnection('reranking',cfg,token,undefined,signal()),'NOT_READY'],
      [await checkLocalConnection('embedding',cfg,token,undefined,signal()),'CONFIG_INVALID'],
      [await checkLocalConnection('embedding',cfg,token,0,signal()),'CONFIG_INVALID'],
      [await checkLocalConnection('embedding',cfg,token,4097,signal()),'CONFIG_INVALID'],
      [await checkLocalConnection('generation',cfg,'',undefined,signal()),'UNAUTHENTICATED'],
      [await checkLocalConnection('generation',{...cfg,origin:'http://localhost:9'},token,undefined,signal()),'CONFIG_INVALID'],
      [await checkLocalConnection('generation',cfg,token,undefined,cancelled.signal),'CANCELLED'],
    ] as const){assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error,code);}
    assert.equal(calls,0);
  },(_req,res)=>{calls++;json(res,generated());});
});
test('CHECK-03: typed auth, quota, redirect, model, vector and generation failures; no response disclosure',async()=>{
  const cases:[number,unknown,string][]=[
    [401,{secret:'synthetic-do-not-display'},'UNAUTHENTICATED'],
    [403,{},'FORBIDDEN'],[429,{},'RATE_LIMITED'],[503,{},'SERVER_ERROR'],
    [302,{},'ENDPOINT_DENIED'],
    [200,{...embedding(),model:'other'},'MODEL_MISMATCH'],
    [200,embedding([1,0]),'INVALID_RESPONSE'],
    [200,embedding([0,0,0]),'INVALID_RESPONSE'],
    [200,embedding([2,0,0]),'INVALID_RESPONSE'],
    [200,{model,data:[]},'INVALID_RESPONSE'],
    [200,generated([]),'INVALID_RESPONSE'],
    [200,generated([{kind:'quotation',text:'not evidence',citationIds:[0]}]),'INVALID_RESPONSE'],
  ];
  let i=0;
  await fixture(async cfg=>{
    for(const [index,entry] of cases.entries()){
      const role=index<10?'embedding':'generation';
      const result=await checkLocalConnection(role,cfg,token,role==='embedding'?3:undefined,signal());
      assert.equal(result.ok,false);if(!result.ok) assert.equal(result.error,entry[2]);
      assert.ok(!JSON.stringify(result).includes('synthetic-do-not-display'));
    }
    assert.equal(i,cases.length);
  },(_req,res)=>{const [status,body]=cases[i++]!;if(status===302)res.setHeader('location','http://127.0.0.1:9/never');json(res,body,status);});
});
test('CHECK-03/04: timeout, duplicate run, cancellation, stale completion and disposal',async()=>{
  let calls=0,entered!:()=>void;
  let pending=new Promise<void>(r=>entered=r);
  await fixture(async cfg=>{
    const timeout=await checkLocalConnection('generation',{...cfg,limits:{...cfg.limits,timeoutMs:100}},token,undefined,signal());
    assert.equal(timeout.ok,false); if(!timeout.ok)assert.equal(timeout.error,'TIMEOUT');
    pending=new Promise<void>(r=>entered=r);
    const session=new ConnectionCheckSession();
    const first=session.run('generation',cfg,token);await pending;
    assert.equal(await session.run('generation',cfg,token),undefined);
    session.cancel();assert.equal(await first,undefined);
    const second=await session.run('generation',cfg,token);
    assert.equal(second?.ok,true);
    pending=new Promise<void>(r=>entered=r);
    const last=session.run('generation',cfg,token);await pending;
    session.dispose();assert.equal(await last,undefined);
    assert.equal(await session.run('generation',cfg,token),undefined);
    assert.equal(calls,4);
  },(_req,res)=>{
    calls++;
    if(calls===3)json(res,generated());
    else entered();
  });
});
