import assert from 'node:assert/strict';
import type { Candidate, FrozenQuery } from './types';

/** Canonical deduplicated span catalog; rank is the 1-based position in each query's ordered ID list. */
export function serializeCandidates(queries: readonly FrozenQuery[]): string {
  const spans = new Map<string, Omit<Candidate,'originalRank'>>();
  for(const query of queries) for(const [i,c] of query.candidates.entries()) {
    const {originalRank,...span}=c;
    assert.equal(originalRank,i+1);
    const prior=spans.get(c.id);
    if(prior) assert.deepEqual(prior,span); else spans.set(c.id,span);
  }
  const catalog=[...spans.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return [{schema:'oks-06a-candidates-v1',queries:queries.length,spans:catalog.length},
    ...catalog.map(span=>({span})),
    ...queries.map(q=>({query:{id:q.id,inputSha256:q.inputSha256,orderedIds:q.candidates.map(c=>c.id)}}))]
    .map(row=>JSON.stringify(row)).join('\n')+'\n';
}
