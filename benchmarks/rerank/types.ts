import type { EvidenceHit, Predicate, SearchMetadata, SourceLocator } from '../../plugin/src/standalone/contracts';

export type Split = 'tuning' | 'held_out';
export type CorpusSource = { path: string; text: string; sha256: string };
export type QueryInput = {
  id: string; group: string; split: Split; query: string;
  scope?: string[]; predicates?: Predicate[]; metadata?: SearchMetadata;
};
export type Label = { path: string; line: number; grade: 0 | 1 | 2; sourceSha256: string };
export type Judgment = { id: string; exact: boolean; unanswerable: boolean; category: string; labels: Label[] };
export type Candidate = {
  id: string; path: string; sourceSha256: string; excerptSha256: string;
  locator: SourceLocator; originalRank: number;
};
export type FrozenQuery = { id: string; inputSha256: string; candidates: Candidate[] };
export type Captured = { input: QueryInput; hits: EvidenceHit[]; frozen: FrozenQuery; retrievalMs: number };
export type Trial = {
  id: string; profile: string; n: 20 | 50; repetition: number;
  status: 'succeeded' | 'failed' | 'cancelled' | 'no-candidates';
  ranked: string[]; error: string | null; operationMs: number; endToEndMs: number;
  candidateCount: number; apiMs: number | null; tokens: number | null; cost: number | null;
};
