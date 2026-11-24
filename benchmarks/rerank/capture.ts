import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { BoundedVaultReader, privateIndexPath } from '../../plugin/src/standalone/source';
import { StandaloneEngine } from '../../plugin/src/standalone/engine';
import { WorkerMarkdownParser } from '../../plugin/src/standalone/worker';
import { GenerationStore } from '../../plugin/src/standalone/storage';
import { hash, type EvidenceHit } from '../../plugin/src/standalone/contracts';
import { verifySpan } from '../../plugin/src/search/navigation';
import { syntheticNodeWorkerPort } from '../../tests/helpers/browser-worker-port';
import { requestFor } from './corpus';
import type { Candidate, Captured, CorpusSource, QueryInput } from './types';

export function candidate(hit: EvidenceHit): Candidate {
  const locator = hit.sourceLocators[0];
  if (!locator || hit.sourceLocators.length !== 1) throw Error('CANDIDATE_LOCATOR_INVALID');
  const id = hash(JSON.stringify([hit.sourceId, hit.sourceSha256, locator]));
  return { id, path: hit.sourceId, sourceSha256: hit.sourceSha256,
    excerptSha256: hash(hit.originalExcerpt), locator, originalRank: hit.rank };
}
export function assertParity(full: readonly Candidate[], prefix: readonly Candidate[]): void {
  if (new Set(full.map(c => c.id)).size !== full.length ||
      full.some((c, i) => c.originalRank !== i + 1)) throw Error('CANDIDATE_DUPLICATE_OR_RANK');
  assert.deepEqual(prefix, full.slice(0, 20), 'CANDIDATE_PREFIX_MISMATCH');
}
export type Host = {
  scopeId: string; current: () => boolean; verify: (hit: EvidenceHit) => Promise<void>;
  replay: (c: Captured, n: 20 | 50) => Promise<EvidenceHit[]>;
};
/** Disposable synthetic vault, one generation, actual production engine and verification. */
export async function capture<T>(sources: CorpusSource[], queries: QueryInput[],
  use: (captured: Captured[], host: Host) => Promise<T>): Promise<T> {
  const sandbox = await mkdtemp(join(tmpdir(), 'oks-06a-'));
  const vault = join(sandbox, 'vault'), oldXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(sandbox, 'xdg');
  let engine: StandaloneEngine | undefined;
  try {
    await mkdir(vault);
    const paths = sources.map(s => s.path);
    for (const s of sources) await writeFile(join(vault, s.path), s.text, { flag: 'wx', mode: 0o600 });
    const reader = await BoundedVaultReader.open(vault, () => paths);
    const store = await GenerationStore.open(privateIndexPath(vault, reader.rootId, 'oks-synthetic-evidence'), reader.rootId);
    const e = engine = new StandaloneEngine(reader, store,
      new WorkerMarkdownParser(join(process.cwd(), '.test-build', 'standalone-worker.js'), syntheticNodeWorkerPort));
    await e.start(); await e.whenIdle();
    const state = e.status(), generation = state.generationId;
    if (state.status !== 'ready' || !generation || state.sources !== sources.length) throw Error('CORPUS_INDEX_FAILED');
    const current = () => e.status().status === 'ready' && e.status().generationId === generation;
    const verify = async (hit: EvidenceHit) => {
      if (!current() || !paths.includes(hit.sourceId) || hit.indexGenerationId !== generation) throw Error('STALE_CANDIDATE');
      verifySpan(hit, await reader.read(hit.sourceId));
      if (!current()) throw Error('STALE_CANDIDATE');
    };
    const captured: Captured[] = [];
    for (const input of queries) {
      const t = performance.now();
      const full = await e.search(requestFor(input, 50));
      const retrievalMs = performance.now() - t;
      const prefix = await e.search(requestFor(input, 20));
      for (const response of [full, prefix]) {
        if (response.status !== 'ok' || response.executedMode !== 'lexical' ||
            response.indexGenerationId !== generation || response.staleSourceCount !== 0 || !current())
          throw Error('LEXICAL_CAPTURE_FAILED');
        for (const hit of response.hits) await verify(hit);
      }
      const candidates = full.hits.map(candidate);
      assertParity(candidates, prefix.hits.map(candidate));
      assert.deepEqual(prefix.hits, full.hits.slice(0, 20), 'EVIDENCE_PREFIX_MISMATCH');
      captured.push({ input, hits: full.hits, retrievalMs,
        frozen: { id: input.id, inputSha256: hash(JSON.stringify(requestFor(input, 50))), candidates } });
    }
    const replay = async (c: Captured, n: 20 | 50) => {
      const response = await e.search(requestFor(c.input,n));
      if (response.status !== 'ok' || response.executedMode !== 'lexical' ||
          response.indexGenerationId !== generation || response.staleSourceCount !== 0 || !current())
        throw Error('LEXICAL_REPLAY_FAILED');
      assert.deepEqual(response.hits,c.hits.slice(0,n),'REPLAY_CANDIDATES_CHANGED');
      return response.hits;
    };
    return await use(captured, { scopeId: reader.rootId, current, verify, replay });
  } finally {
    try { await engine?.close(); } finally {
      if (oldXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldXdg;
      await rm(sandbox, { recursive: true, force: true });
    }
  }
}
