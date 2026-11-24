import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { EvidenceReranker, type RerankApproval } from '../../plugin/src/ai/rerank-evidence';
import { configDigest } from '../../plugin/src/ai/disclosure';
import { ProviderFailure, type ProviderConfig } from '../../plugin/src/ai/contracts';
import { hash } from '../../plugin/src/standalone/contracts';
import { candidate, type Host } from './capture';
import { ordered } from './metrics';
import type { Captured, Trial } from './types';

const PROFILES = ['fixture-original-order','fixture-reversed-order'] as const;
type Profile = typeof PROFILES[number];
/** Only synthetic loopback protocol testing. No configurable URL, model, credential or real-model path. */
export async function fixtureTrials(captured: Captured[], host: Host): Promise<Trial[]> {
  const token = randomBytes(24).toString('hex');
  let calls = 0;
  let expectedWire: unknown;
  const server = createServer({ maxHeaderSize:8192 }, (req,res) => {
    let size=0; const chunks:Buffer[]=[];
    req.on('data',(chunk:Buffer)=>{
      size+=chunk.length;
      if(size>128*1024) req.destroy(); else chunks.push(chunk);
    });
    req.on('end',()=>{
      const reply=(status:number,data:unknown)=>{
        res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));
      };
      try {
        if(req.method!=='POST'||req.url!=='/v1/rerank'||req.headers.authorization!=='Bearer '+token)
          return reply(401,{});
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const profile=PROFILES.find(p=>body.model===p+'@fixture-v1');
        if(!profile||typeof body.query!=='string'||!Array.isArray(body.documents)||
          !body.documents.length||body.documents.length>50||body.top_n!==body.documents.length||
          body.max_tokens_per_query!==0||body.max_tokens_per_doc!==0||
          body.documents.some((x:unknown)=>typeof x!=='string')) return reply(400,{});
        const model=profile+'@fixture-v1', documents=body.documents as string[];
        assert.deepEqual(body,expectedWire);
        calls++;
        reply(200,{model,results:documents.map((_:unknown,index:number)=>({
          index,relevance_score:profile===PROFILES[0] ? -index : index }))});
      } catch { reply(400,{}); }
    });
  });
  server.requestTimeout=5000;server.headersTimeout=5000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const address=server.address();
    if(!address||typeof address==='string') throw Error('FIXTURE_ADDRESS');
    const reranker=new EvidenceReranker(), results:Trial[]=[];
    // Bounded smoke: six fixed tuning queries covering all authored categories.
    // Profile order is seeded deterministically; no held-out fixture tuning.
    const selected=captured.filter(c=>c.input.split==='tuning'&&c.input.group==='aster');
    for(const c of selected) for(const n of [20,50] as const) {
      for(let repetition=0;repetition<3;repetition++) {
        const profiles=parseInt(hash('601:'+c.input.id+':'+n+':'+repetition).slice(0,2),16)%2===0 ? PROFILES : [...PROFILES].reverse();
        for(const profile of profiles) {
          const start=performance.now();
          const hits=await host.replay(c,n), expected=c.frozen.candidates.slice(0,n);
          const operationStart=performance.now();
          const config:ProviderConfig={state:'configured',transport:'local',origin:'http://127.0.0.1:'+address.port,
            identity:{model:profile,revision:'fixture-v1'},
            limits:{timeoutMs:3000,maxCandidates:50,maxInputBytes:65536,maxOutputTokens:1,maxConcurrent:1}};
          let status:Trial['status']='no-candidates', error:string|null=null, ranked:string[]=[];
          if(hits.length) {
            expectedWire={model:profile+'@fixture-v1',query:c.input.query,documents:hits.map(h=>h.originalExcerpt),top_n:hits.length,max_tokens_per_query:0,max_tokens_per_doc:0};
            const deadlineUnixMs=Date.now()+3000;
            const approval:RerankApproval={config,scopeId:host.scopeId,query:{text:c.input.query,classification:'synthetic'},
              candidates:hits.map(hit=>({hit,classification:'synthetic'})),
              grant:{version:1,role:'reranking',configDigest:configDigest('reranking',config),
                scopeId:host.scopeId,expiresUnixMs:deadlineUnixMs,queryDigest:hash(c.input.query),queryClassification:'synthetic',
                sources:hits.map(hit=>({sourceId:hit.sourceId,sourceSha256:hit.sourceSha256,
                  excerptDigest:hash(hit.originalExcerpt),classification:'synthetic'}))}};
            try {
              const answer=await reranker.run(approval,token,{deadlineUnixMs,signal:new AbortController().signal},host.verify,host.current);
              ranked=answer.map(x=>candidate(x.evidence).id);
              ordered(ranked,expected);
              for(const [idx,row] of answer.entries()) {
                assert.equal(row.rerankRank,idx+1);
                assert.deepEqual(row.evidence,hits.find(hit=>candidate(hit).id===ranked[idx]));
              }
              assert.deepEqual(ranked,profile===PROFILES[0] ? expected.map(x=>x.id) : expected.map(x=>x.id).reverse());
              status='succeeded';
            } catch(e) {
              if(!(e instanceof ProviderFailure)) throw e;
              status=e.code==='CANCELLED'?'cancelled':'failed';error=e.code;ranked=[];
            }
          }
          expectedWire=undefined;
          const operationMs=performance.now()-operationStart;
          results.push({id:c.input.id,profile,n,repetition,status,ranked,error,operationMs,
            endToEndMs:performance.now()-start,candidateCount:hits.length,apiMs:null,tokens:null,cost:null});
        }
      }
    }
    assert.equal(calls,results.filter(r=>r.status==='succeeded').length,'FIXTURE_REQUEST_COUNT');
    assert.ok(results.every(r=>r.status==='succeeded'||r.status==='no-candidates'),'FIXTURE_OPERATION_FAILED');
    return results;
  } finally { server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
}
