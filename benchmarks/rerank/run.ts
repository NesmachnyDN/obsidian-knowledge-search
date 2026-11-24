import assert from 'node:assert/strict';
import { hash } from '../../plugin/src/standalone/contracts';
import { loadInputs, loadJudgments, loadCandidates } from './corpus';
import { capture } from './capture';
import { fixtureTrials } from './fixture';
import { summarize } from './report';
import { serializeCandidates } from './manifest';

async function run() {
  const args=process.argv.slice(2);
  if(args.length!==1||!['--capture','--fixture'].includes(args[0]!)) throw Error('MODE_INVALID');
  const inputs=await loadInputs();
  const result=await capture(inputs.sources,inputs.queries,async(captured,host)=>{
    const candidates=captured.map(c=>c.frozen);
    const payload=serializeCandidates(candidates);
    if(args[0]==='--capture') {
      // Explicit stdout export; never overwrite frozen artifacts automatically.
      process.stdout.write(payload);return null;
    }
    const frozen=await loadCandidates(inputs.candidateSha256);
    assert.equal(payload,frozen,'FROZEN_CANDIDATES_CHANGED');
    const trials=await fixtureTrials(captured,host);
    // Reference labels are loaded only once every capture/provider trial is over.
    return {candidates,candidateSha256:hash(payload),trials,captured};
  });
  if(!result)return;
  const judgments=await loadJudgments(inputs.sources,inputs.queries,inputs.judgmentSha256);
  const {baseline,fixture}=summarize(result.captured,judgments,result.trials);
  const counts=result.candidates.map(q=>q.candidates.length);
  console.log(JSON.stringify({schema:'oks-06a-harness-v1',status:'synthetic-fixture-only',
    bRerank:'NOT_ACCEPTED',modelsExecuted:0,corpusSha256:inputs.manifestSha256,candidateSha256:result.candidateSha256,
    capture:{queries:counts.length,maxCandidates:Math.max(...counts),atLeast20:counts.filter(n=>n>=20).length,
      atLeast50:counts.filter(n=>n>=50).length,empty:counts.filter(n=>n===0).length,prefixParity:true},
    baseline,fixture,trials:result.trials,
    limitations:['No real model, no token/cost/API-duration evidence, no acceptance decision.',
      'Fixture trials use six tuning queries; end-to-end timings are diagnostic synthetic measurements, not real-model latency.',
      'Judgments are authored synthetic labels pending independent review; six queries per family are correlated.',
      'Per-query bootstrap intervals are not population or simultaneous confidence guarantees.']},null,2));
}
run().catch(()=>{console.error('OKS_06A_HARNESS_FAILED');process.exitCode=1;});
