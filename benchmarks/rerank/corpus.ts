import { readArtifact } from './artifact';
import { hash, validPath, validateRequest, PROTOCOL, BOUNDS } from '../../plugin/src/standalone/contracts';
import type { CorpusSource, QueryInput, Judgment } from './types';

const ROOT = 'benchmarks/rerank/corpus';
const FILES = ['sources.jsonl', 'requests.jsonl', 'judgments.jsonl'] as const;
type File = typeof FILES[number];
type Manifest = { schema: string; counts: { sources: number; tuning: number; held_out: number }; files: Record<File | 'candidates.jsonl', string> };
async function manifest() {
  const raw = await readArtifact(ROOT, 'manifest.json');
  const m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as Manifest;
  if (m.schema !== 'oks-06a-corpus-v2' || m.counts.sources !== 80 ||
      m.counts.tuning !== 30 || m.counts.held_out !== 90 ||
      Object.keys(m.files).sort().join() !== [...FILES, 'candidates.jsonl'].sort().join() ||
      Object.values(m.files).some(d => !/^[a-f0-9]{64}$/.test(d))) throw Error('CORPUS_MANIFEST_INVALID');
  return { manifest: m, manifestSha256: hash(raw) };
}
async function rows<T>(file: File, m: Manifest): Promise<T[]> {
  const raw = await readArtifact(ROOT, file, m.files[file]);
  return new TextDecoder('utf-8', { fatal: true }).decode(raw).trimEnd().split('\n').map(line => JSON.parse(line) as T);
}
/** Deliberately never reads judgments during retrieval/provider execution. */
export async function loadInputs() {
  const { manifest: m, manifestSha256 } = await manifest();
  const sources = await rows<CorpusSource>('sources.jsonl', m);
  const queries = await rows<QueryInput>('requests.jsonl', m);
  if (sources.length !== m.counts.sources || new Set(sources.map(s => s.path)).size !== sources.length ||
      sources.some(s => !validPath(s.path) || s.path.includes('/') || typeof s.text !== 'string' ||
        Buffer.byteLength(s.text) > BOUNDS.fileBytes || hash(s.text) !== s.sha256)) throw Error('CORPUS_SOURCE_INVALID');
  const ids = new Set<string>(), groups = new Map<string, string>();
  for (const q of queries) {
    if (!/^[a-z]+-[1-6]$/.test(q.id) || ids.has(q.id) || !q.id.startsWith(q.group + '-') ||
        !['tuning','held_out'].includes(q.split) || (groups.has(q.group) && groups.get(q.group) !== q.split))
      throw Error('CORPUS_QUERY_INVALID');
    ids.add(q.id); groups.set(q.group, q.split);
    validateRequest(requestFor(q, 50));
  }
  if (queries.length !== 120 || queries.filter(q => q.split === 'tuning').length !== 30 ||
      groups.size !== 20 || [...groups.keys()].some(g => queries.filter(q => q.group === g).length !== 6))
    throw Error('CORPUS_SPLIT_INVALID');
  return { sources, queries, manifestSha256, candidateSha256: m.files['candidates.jsonl'], judgmentSha256: m.files['judgments.jsonl'] };
}
export function requestFor(q: QueryInput, limit: 20 | 50) {
  return { protocolVersion: PROTOCOL, requestId: q.id, query: q.query,
    requestedMode: 'lexical' as const, matchMode: 'terms' as const, limit,
    ...(q.scope ? { scope: q.scope } : {}), ...(q.predicates ? { predicates: q.predicates } : {}),
    ...(q.metadata ? { metadata: q.metadata } : {}) };
}
/** Candidate bytes are verified before any fixture operation. */
export async function loadCandidates(expectedDigest: string): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(await readArtifact(ROOT, 'candidates.jsonl', expectedDigest));
}
/** Called only by evaluation AFTER retrieval and all fixture trials have settled. */
export async function loadJudgments(sources: CorpusSource[], queries: QueryInput[], expectedDigest: string) {
  const raw = await readArtifact(ROOT, 'judgments.jsonl', expectedDigest);
  const labels = new TextDecoder('utf-8', { fatal: true }).decode(raw).trimEnd().split('\n').map(line => JSON.parse(line) as Judgment);
  const byPath = new Map(sources.map(s => [s.path, s]));
  const queryIds = new Set(queries.map(q => q.id));
  if (labels.length !== queries.length || new Set(labels.map(j => j.id)).size !== labels.length)
    throw Error('JUDGMENT_COUNT_INVALID');
  for (const j of labels) {
    if (!queryIds.has(j.id) || typeof j.exact !== 'boolean' || typeof j.unanswerable !== 'boolean' ||
        !Array.isArray(j.labels) || (j.unanswerable ? j.labels.length !== 0 : !j.labels.some(l => l.grade === 2)))
      throw Error('JUDGMENT_INVALID');
    const keys = new Set<string>();
    for (const l of j.labels) {
      const source = byPath.get(l.path), key = l.path + ':' + l.line;
      if (!source || l.sourceSha256 !== source.sha256 || !Number.isInteger(l.line) || l.line < 1 ||
          !source.text.split('\n')[l.line - 1]?.trim() || ![0,1,2].includes(l.grade) || keys.has(key))
        throw Error('JUDGMENT_SPAN_INVALID');
      keys.add(key);
    }
  }
  const held = labels.filter(j => queries.some(q => q.id === j.id && q.split === 'held_out'));
  if (held.filter(j => j.exact).length < 15 || held.filter(j => j.unanswerable).length < 15)
    throw Error('JUDGMENT_STRATA_INVALID');
  return labels;
}
