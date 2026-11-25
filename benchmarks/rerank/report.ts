import type { Captured, Judgment, Trial } from './types';
import { mean, percentile, score, pairedBootstrap, ordered } from './metrics';

export function summarize(captured: Captured[], judgments: Judgment[], trials: Trial[]) {
  const byId=new Map(judgments.map(j=>[j.id,j]));
  const baseline=[];
  for(const split of ['tuning','held_out']) for(const n of [20,50] as const) for(const k of [5,10,20,50]) {
    if(k>n) continue;
    const cases=captured.filter(c=>c.input.split===split);
    const perQuery=cases.map(c=>{
      const j=byId.get(c.input.id)!;
      const candidates=c.frozen.candidates.slice(0,n);
      return {id:c.input.id,category:j.category,exact:j.exact,unanswerable:j.unanswerable,
        returned:candidates.length,...(j.unanswerable?{}:{metrics:score(candidates,j,k),
          ceiling:score(candidates,j,n).span.recall})};
    });
    const positive=perQuery.filter(q=>q.metrics);
    const aggregate=(kind:'span'|'document')=>({
      ndcg:mean(positive.map(q=>q.metrics![kind].ndcg)),mrr:mean(positive.map(q=>q.metrics![kind].mrr)),
      recall:mean(positive.map(q=>q.metrics![kind].recall)),precision:mean(positive.map(q=>q.metrics![kind].precision)),
    });
    baseline.push({split,n,k,positive:positive.length,negative:perQuery.length-positive.length,
      negativeWithHits:perQuery.filter(q=>q.unanswerable&&q.returned>0).length,
      exactDirectHits:positive.filter(q=>q.exact&&q.metrics!.span.exactDirectHit===1).length,
      exactQueries:positive.filter(q=>q.exact).length,meanCandidateRecall:mean(positive.map(q=>q.ceiling!)),
      span:aggregate('span'),document:aggregate('document'),perQuery});
  }
  const fixture=[];
  for(const profile of [...new Set(trials.map(t=>t.profile))]) for(const n of [20,50] as const) {
    const rows=trials.filter(t=>t.profile===profile&&t.n===n), first=rows.filter(t=>t.repetition===0);
    const deltas=first.flatMap(t=>{
      const j=byId.get(t.id)!;if(j.unanswerable)return [];
      const c=captured.find(x=>x.input.id===t.id)!.frozen.candidates.slice(0,n);
      const a=score(c,j,10).span;
      const b=score(t.status==='succeeded'?ordered(t.ranked,c):[],j,10).span;
      return [{id:t.id,ndcg:b.ndcg-a.ndcg,mrr:b.mrr-a.mrr,recall:b.recall-a.recall,exactLoss:j.exact&&a.exactDirectHit>b.exactDirectHit}];
    });
    fixture.push({profile,n,attempted:rows.filter(t=>t.status!=='no-candidates').length,
      succeeded:rows.filter(t=>t.status==='succeeded').length,failed:rows.filter(t=>t.status==='failed').length,
      cancelled:rows.filter(t=>t.status==='cancelled').length,noCandidates:rows.filter(t=>t.status==='no-candidates').length,
      operationP50Ms:percentile(rows.filter(t=>t.status==='succeeded').map(t=>t.operationMs),0.5),
      operationP95Ms:percentile(rows.filter(t=>t.status==='succeeded').map(t=>t.operationMs),0.95),
      endToEndP50Ms:percentile(rows.filter(t=>t.status==='succeeded').map(t=>t.endToEndMs),0.5),
      endToEndP95Ms:percentile(rows.filter(t=>t.status==='succeeded').map(t=>t.endToEndMs),0.95),
      pairedNdcg:pairedBootstrap(deltas.map(d=>d.ndcg)),pairedMrr:pairedBootstrap(deltas.map(d=>d.mrr)),
      pairedRecall:pairedBootstrap(deltas.map(d=>d.recall)),deltas});
  }
  return {baseline,fixture};
}
