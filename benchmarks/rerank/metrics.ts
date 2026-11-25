import type { Candidate, Judgment, Label } from './types';

export type Metrics = { recall: number; precision: number; ndcg: number; mrr: number; exactDirectHit: number };
const key = (path: string, line: number) => JSON.stringify([path,line]);
const dcg = (grades: number[]) => grades.reduce((s,g,i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
function measure(ranked: string[], relevant: Map<string,number>, k: number): Metrics {
  if (!Number.isInteger(k) || k < 1 || new Set(ranked).size !== ranked.length) throw Error('METRIC_INPUT_INVALID');
  const idealGrades = [...relevant.values()].filter(g=>g>0).sort((a,b)=>b-a);
  if (!idealGrades.length) throw Error('UNANSWERABLE_NOT_POSITIVE_METRIC');
  const grades = ranked.slice(0,k).map(id=>relevant.get(id) ?? 0);
  const positives = grades.filter(g=>g>0).length, first = grades.findIndex(g=>g>0);
  const ideal = dcg(idealGrades.slice(0,k));
  return { recall: positives / idealGrades.length, precision: positives / k,
    ndcg: dcg(grades)/ideal, mrr:first < 0 ? 0 : 1/(first+1), exactDirectHit:grades.includes(2)?1:0 };
}
function spanLabels(labels: readonly Label[]): Map<string,number> {
  const relevant = new Map<string,number>();
  for (const l of labels) {
    const id = key(l.path,l.line);
    if (relevant.has(id)) throw Error('DUPLICATE_LABEL');
    relevant.set(id,l.grade);
  }
  return relevant;
}
export function score(ranked: readonly Candidate[], j: Judgment, k: number) {
  if (j.unanswerable) throw Error('NEGATIVE_REQUIRES_SEPARATE_REPORT');
  const spans = ranked.map(c=>key(c.path,c.locator.lineStart));
  const docs = [...new Set(ranked.map(c=>c.path))];
  const docLabels = new Map<string,number>();
  for (const l of j.labels) docLabels.set(l.path,Math.max(docLabels.get(l.path)??0,l.grade));
  return { span:measure(spans,spanLabels(j.labels),k), document:measure(docs,docLabels,k) };
}
export function ordered(ids: readonly string[], expected: readonly Candidate[], complete = true): Candidate[] {
  const map = new Map(expected.map(c=>[c.id,c]));
  if (map.size !== expected.length || new Set(ids).size !== ids.length ||
      (complete && ids.length !== expected.length) || ids.some(id=>!map.has(id)))
    throw Error('CANDIDATE_PERMUTATION_INVALID');
  return ids.map(id=>map.get(id)!);
}
export function mean(values: readonly number[]): number {
  if (!values.length || values.some(x=>!Number.isFinite(x))) throw Error('METRIC_SAMPLE_INVALID');
  return values.reduce((s,v)=>s+v,0)/values.length;
}
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  if (p <= 0 || p > 1 || values.some(x=>!Number.isFinite(x))) throw Error('PERCENTILE_INVALID');
  return [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]!;
}
/** Paired query-ID bootstrap. No independence or simultaneous-CI claim. */
export function pairedBootstrap(deltas: readonly number[], seed = 601, count = 10000) {
  const average = mean(deltas);
  if (!Number.isInteger(count) || count < 1 || count > 10000 || !Number.isInteger(seed) || seed === 0)
    throw Error('BOOTSTRAP_INVALID');
  let state = seed >>> 0;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state>>>0)/4294967296; };
  const samples:number[] = [];
  for (let i=0;i<count;i++) {
    let total=0;
    for (let j=0;j<deltas.length;j++) total += deltas[Math.floor(next()*deltas.length)]!;
    samples.push(total/deltas.length);
  }
  return { mean:average, lower:percentile(samples,0.025)!, upper:percentile(samples,0.975)!, count, seed };
}
