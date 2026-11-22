import {
  BOUNDS, PROTOCOL, StandaloneError, hash, makeGeneration, matches, validPath, validateRequest,
  type IndexGeneration, type SearchRequest, type SearchResponse, type EvidenceHit, type SourceVersion,
  type ParsedBlock,
} from './contracts';
import { terms } from './markdown';
import type { MarkdownParser } from './worker';
import type { SourceProvider } from './source';
import type { GenerationStore } from './storage';

export type EngineState = {
  status: 'initializing' | 'ready' | 'degraded' | 'failed' | 'unavailable';
  generationId: string | null; sources: number; records: number;
  error: string | null; busy: boolean;
};
const yieldToHost = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

export class StandaloneEngine {
  private generation: IndexGeneration | null = null;
  private state: EngineState = { status: 'unavailable', generationId: null, sources: 0, records: 0, error: null, busy: false };
  private work: Promise<void> | null = null;
  private pending = new Set<string>();
  private all = false;
  private revision = 0;
  private stopped = false;
  private paused = false;
  private initialized = false;
  constructor(private readonly provider: SourceProvider, private readonly store: GenerationStore,
    private readonly parser: MarkdownParser,
    private readonly yieldJob: () => Promise<void> = yieldToHost) {
    if (provider.rootId !== store.rootId) throw new StandaloneError('VAULT_IDENTITY_CHANGED');
  }
  status(): EngineState { return { ...this.state }; }
  private recordState(status: EngineState['status'], error: string | null): void {
    this.state = {
      status, error, generationId: this.generation?.generationId ?? null,
      sources: this.generation?.documents.length ?? 0,
      records: this.generation?.documents.reduce((n, d) => n + d.blocks.filter(b => b.terms.length > 0).length, 0) ?? 0,
      busy: this.work !== null,
    };
  }
  async start(): Promise<void> {
    if (this.stopped || this.initialized) throw new StandaloneError('LIFECYCLE_INVALID');
    this.initialized = true;
    this.recordState('initializing', null);
    try {
      const result = await this.store.load();
      if (this.stopped) return;
      this.generation = result.generation;
      this.recordState(!result.generation && result.error ? 'failed'
        : result.error || result.recovered ? 'degraded'
        : result.generation ? 'ready' : 'initializing', result.error);
      // Unknown, foreign or corrupt cache must not be silently overwritten at startup.
      if (!result.generation && result.error) return;
      this.reconcile();
    } catch (error) {
      this.recordState('failed', code(error));
      throw error;
    }
  }
  // Event mutation immediately invalidates a pending publication. Search rehashes
  // the current source whether or not an Obsidian event has arrived.
  changed(path?: string): void {
    if (this.stopped) return;
    this.revision++;
    if (path && validPath(path) && !this.all) {
      this.pending.add(path);
      if (this.pending.size > BOUNDS.sources) {
        this.pending.clear();
        this.all = true;
      }
    } else this.all = true; // folder rename, unknown event, cache resolution or missed event
    this.schedule();
  }
  reconcile(): void {
    this.changed(); // authoritative full scan (startup and explicit reconciliation)
  }
  rebuild(): void {
    if (this.stopped) throw new StandaloneError('LIFECYCLE_INVALID');
    this.paused = false;
    this.reconcile();
  }
  cancel(): void {
    this.paused = true;
    this.revision++;
    this.pending.clear(); this.all = false;
    this.recordState(this.generation ? 'degraded' : 'unavailable', 'CANCELLED');
  }
  resume(): void {
    if (this.stopped) throw new StandaloneError('LIFECYCLE_INVALID');
    this.paused = false;
    this.reconcile();
  }
  private schedule(): void {
    if (!this.initialized || this.stopped || this.paused || this.work) return;
    this.work = this.run().catch(error => {
      this.recordState(this.generation ? 'degraded' : 'failed', code(error));
    }).finally(() => {
      this.work = null;
      this.state.busy = false;
      if (!this.stopped && !this.paused && (this.all || this.pending.size)) this.schedule();
    });
    this.state.busy = true;
  }
  async whenIdle(): Promise<void> {
    while (this.work) await this.work;
  }
  private async run(): Promise<void> {
    const revision = this.revision;
    const full = this.all || !this.generation;
    this.all = false;
    const changes = new Set(this.pending);
    this.pending.clear();
    try {
      const paths = await this.provider.list();
      if (this.stopped || this.paused || revision !== this.revision) return;
      const live = new Set(paths);
      const prior = new Map((this.generation?.documents ?? []).map(doc => [doc.sourceId, doc]));
      for (const path of [...prior.keys()]) if (!live.has(path)) prior.delete(path);
      let blocks = full ? 0 : [...prior.values()].reduce((count, doc) => count + doc.blocks.length, 0);
      const targets = full ? paths : paths.filter(path => changes.has(path) || !prior.has(path));
      if (full) prior.clear();
      for (const path of targets) {
        if (this.stopped || this.paused || revision !== this.revision) return;
        const previous = prior.get(path);
        if (previous) blocks -= previous.blocks.length;
        const bytes = await this.provider.read(path);
        const doc = await this.parser.parse(path, bytes, this.provider.rootId);
        blocks += doc.blocks.length;
        if (blocks > BOUNDS.blocks) throw new StandaloneError('INDEX_LIMIT');
        prior.set(path, doc);
        await this.yieldJob(); // bounded per-source cooperative scheduling
      }
      if (this.stopped || this.paused || revision !== this.revision) return;
      // Recheck all participating source versions before publication; missed file
      // events cannot introduce a known-inconsistent generation.
      for (const [path, doc] of prior) {
        if (hash(await this.provider.read(path)) !== doc.sha256)
          throw new StandaloneError('SOURCE_CHANGED');
        if (this.stopped || this.paused || revision !== this.revision) return;
        await this.yieldJob();
      }
      const currentPaths = await this.provider.list();
      if (paths.length !== currentPaths.length || paths.some((p, i) => p !== currentPaths[i]))
        throw new StandaloneError('SOURCE_CHANGED');
      if (this.stopped || this.paused || revision !== this.revision) return;
      const next = makeGeneration(this.provider.rootId, [...prior.values()]);
      const committed = next.generationId !== this.generation?.generationId
        ? await this.store.commit(next) : this.generation;
      if (this.stopped || revision !== this.revision) return;
      this.generation = committed;
      this.recordState('ready', null);
    } catch (error) {
      // An interrupted/failed update cannot promote a partially indexed dataset.
      this.recordState(this.generation ? 'degraded' : 'failed', code(error));
    }
  }
  async search(input: unknown): Promise<SearchResponse> {
    validateRequest(input);
    const req: SearchRequest = input;
    const response = (status: SearchResponse['status'], error: string | null,
      hits: EvidenceHit[], stale: number): SearchResponse => ({
      protocolVersion: PROTOCOL, requestId: req.requestId, requestedMode: req.requestedMode,
      executedMode: status === 'failed' ? 'none' : 'lexical', status, error,
      indexGenerationId: this.generation?.generationId ?? null, hits,
      capabilityReadiness: { lexical: !this.generation ? 'unavailable'
        : status === 'ok' ? 'ready' : status === 'failed' ? 'failed' : 'degraded', dense: 'unavailable' },
      staleSourceCount: stale,
    });
    if (req.requestedMode !== 'lexical') return response('failed', 'CAPABILITY_UNAVAILABLE', [], 0);
    const gen = this.generation;
    if (!gen) return response('failed', this.state.error ?? 'INDEX_UNAVAILABLE', [], 0);
    try {
      const tokens = [...new Set(terms(req.query))];
      if (tokens.length > BOUNDS.termsPerQuery) throw new StandaloneError('QUERY_INVALID');
      const mandatoryIds = req.query.toLowerCase().match(/[\p{L}\p{N}]+(?:[._/-][\p{L}\p{N}]+)+/gu) ?? [];
      const scope = req.scope ? new Set(req.scope) : null;
      const predicates = req.predicates ?? [];
      const candidates: { doc: SourceVersion; block: ParsedBlock; score: number }[] = [];
      for (const doc of gen.documents) {
        if ((scope && !scope.has(doc.sourceId)) || !matches(doc.properties, predicates)) continue;
        if (doc.extractionStatus !== 'ok' && doc.extractionStatus !== 'partial') continue;
        for (const block of doc.blocks) {
          if (!block.terms.length || mandatoryIds.some(id => !block.terms.includes(id))) continue;
          const matched = tokens.filter(term => block.terms.includes(term));
          if (!matched.length) continue;
          // Complete compound identifier gets stronger weight than individual parts.
          const score = matched.reduce((sum, term) =>
            sum + (term.includes('-') || term.includes('/') || term.includes('.') ? 8 : 2), 0)
            + matched.length / tokens.length;
          candidates.push({ doc, block, score });
          if (candidates.length > BOUNDS.blocks) throw new StandaloneError('INDEX_LIMIT');
        }
      }
      candidates.sort((a, b) => b.score - a.score
        || (a.doc.sourceId < b.doc.sourceId ? -1 : a.doc.sourceId > b.doc.sourceId ? 1 : 0)
        || a.block.order - b.block.order);
      const freshness = new Map<string, Uint8Array | null>();
      let stale = 0;
      const hits: EvidenceHit[] = [];
      // Filters, source rehash and full locator validation run before Top-K.
      // Rechecking bytes prevents stale evidence even for missed filesystem events.
      for (const row of candidates) {
        let bytes = freshness.get(row.doc.sourceId);
        if (bytes === undefined) {
          try {
            const candidate = await this.provider.read(row.doc.sourceId);
            bytes = hash(candidate) === row.doc.sha256 ? candidate : null;
          } catch { bytes = null; }
          freshness.set(row.doc.sourceId, bytes);
          if (!bytes) stale++;
        }
        if (!bytes) continue;
        const loc = row.block.locator;
        const excerptBytes = bytes.subarray(loc.byteStart, loc.byteEnd);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const original = new TextDecoder('utf-8', { fatal: true }).decode(excerptBytes);
        const prefix = text.slice(0, Buffer.from(bytes).subarray(0, loc.byteStart).toString('utf8').length);
        const line = prefix.split(/\r\n|\r|\n/).length;
        if (original !== row.block.originalText || line !== loc.lineStart
          || [...prefix].length !== loc.charStart
          || [...original].length !== loc.charEnd - loc.charStart || loc.lineEnd !== loc.lineStart) {
          throw new StandaloneError('EVIDENCE_INCOMPLETE');
        }
        hits.push({
          sourceId: row.doc.sourceId, sourceSha256: row.doc.sha256, originalExcerpt: original,
          sourceLocators: [loc], rank: hits.length + 1, lexicalRank: hits.length + 1,
          retrievalMode: 'lexical', indexGenerationId: gen.generationId, score: row.score,
          headings: [...row.block.headings], wikiLinks: [...row.block.wikiLinks],
          properties: row.doc.properties,
        });
        if (hits.length >= req.limit) break;
      }
      // A missed event never defeats live hash suppression; queue reconciliation for recovery.
      if (stale && !this.stopped && !this.paused) this.reconcile();
      const degraded = this.state.status !== 'ready' || this.work !== null || stale > 0;
      return response(degraded ? 'degraded' : 'ok',
        degraded ? this.state.error ?? (stale ? 'SOURCE_STALE' : 'RECONCILING') : null,
        hits, stale);
    } catch (error) {
      return response('failed', code(error), [], 0);
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.revision++;
    this.pending.clear(); this.all = false;
    await this.parser.close(); // Interrupt CPU-bound parse immediately on unload.
    if (this.work) await this.work;
  }
}
function code(error: unknown): string {
  return error instanceof StandaloneError ? error.code : 'IO_FAILURE';
}
