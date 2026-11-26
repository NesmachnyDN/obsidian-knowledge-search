import {
  BOUNDS, PROTOCOL, StandaloneError, hash, makeGeneration, matches, validPath, validateRequest,
  type IndexGeneration, type SearchRequest, type SearchResponse, type EvidenceHit, type SourceVersion,
  type ParsedBlock,
} from './contracts';
import { terms } from './markdown';
import { containsLocator, verifyOriginalRange } from './selection-range';
import { freezeScope, parseScopeSelector, resolveScope, type ScopedSearch, type ScopeSnapshot } from './chat-scope';
import { metadataAnchor } from './metadata';
import { verifySpan } from '../search/navigation';
import type { MarkdownParser, PolicyMetadataParser } from './worker';
import { EligibilityEvaluator, type PolicyHost, type PolicyEnvelope } from '../ai/processing-policy';
import { ProviderFailure, type CallContext } from '../ai/contracts';
import type { PolicyMetadataProof } from './shared';
import type { SourceProvider } from './source';
import type { GenerationStore } from './storage';

export type EngineState = {
  status: 'initializing' | 'ready' | 'degraded' | 'failed' | 'unavailable';
  generationId: string | null; sources: number; records: number;
  error: string | null; maintenanceWarning: string | null; busy: boolean;
};
/** Internal, host-selected evidence lease; not a public search response. */
export type SelectedCorpus = {
  rootId: string; lexicalGenerationId: string; evidence: readonly EvidenceHit[];
  current(): boolean; verify(hit: EvidenceHit): Promise<void>;
  metadataPaths(request: SearchRequest, lexicalGenerationId: string, selectedPaths: readonly string[]): readonly string[];
};
/** A host-local retrieval lease. It carries no generation/disclosure authority. */
export type ChatScopeLease = {
  snapshot: Readonly<ScopeSnapshot>;
  current():boolean;
  verify():Promise<void>;
  search(request:ScopedSearch):Promise<SearchResponse>;
};
// Query-driven bounded audit; no recurring timer or hidden background scanner.
// lstat-based hints detect normal misses immediately. Unchanged hints are never
// treated as a cryptographic guarantee: full source hashes are rechecked at most
// once per interval during active searches, and every EvidenceHit is rehashed.
const SOURCE_AUDIT_INTERVAL_MS = 30_000;
const yieldToHost = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

export class StandaloneEngine {
  private generation: IndexGeneration | null = null;
  private state: EngineState = { status: 'unavailable', generationId: null, sources: 0, records: 0,
    error: null, maintenanceWarning: null, busy: false };
  private work: Promise<void> | null = null;
  private policyRead: Promise<unknown> | null = null;
  private pending = new Set<string>();
  private all = false;
  private revision = 0;
  private stopped = false;
  private paused = false;
  private publishing = false;
  private recoveryNeedsPublication = false;
  private maintenanceWarning: string | null = null;
  private initialized = false;
  private versionHints: string[] | null = null;
  private verifiedAt = 0;
  constructor(private readonly provider: SourceProvider, private readonly store: GenerationStore,
    private readonly parser: MarkdownParser,
    private readonly yieldJob: () => Promise<void> = yieldToHost,
    private readonly now: () => number = Date.now) {
    if (provider.rootId !== store.rootId) throw new StandaloneError('VAULT_IDENTITY_CHANGED');
  }
  status(): EngineState { return { ...this.state }; }
  private recordState(status: EngineState['status'], error: string | null): void {
    this.state = {
      status, error, maintenanceWarning: this.maintenanceWarning,
      generationId: this.generation?.generationId ?? null,
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
      this.recoveryNeedsPublication = result.recovered;
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
  // Returns false if publication has crossed the irreversible CURRENT-rename
  // boundary: pause later jobs, but never claim that committed work was canceled.
  cancel(): boolean {
    this.paused = true;
    this.pending.clear(); this.all = false;
    if (this.publishing) {
      this.recordState(this.generation ? 'degraded' : 'unavailable', 'CANCEL_DEFERRED');
      return false;
    }
    this.revision++;
    this.recordState(this.generation ? 'degraded' : 'unavailable', 'CANCELLED');
    return true;
  }
  resume(): void {
    if (this.stopped) throw new StandaloneError('LIFECYCLE_INVALID');
    this.paused = false;
    this.reconcile();
  }
  private schedule(): void {
    if (!this.initialized || this.stopped || this.paused || this.work || this.policyRead) return;
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
    while (this.work||this.policyRead) {
      if(this.work)await this.work;else await this.policyRead?.catch(()=>{});
    }
  }
  /** Local preview only. Share the existing worker and hold the physical slot
   * through late read/parser completion; a timeout never publishes a proof. */
  previewPolicyMetadata(path:string,current:()=>boolean):Promise<PolicyMetadataProof> {
    const parser=this.parser as MarkdownParser & Partial<PolicyMetadataParser>;
    if(this.stopped||!this.initialized||this.paused||this.work||this.policyRead||!validPath(path)||!parser.policyMetadata)
      return Promise.reject(new StandaloneError('PARSER_BUSY'));
    const revision=this.revision,root=this.provider.rootId;
    let expired=false;
    const live=()=>!expired&&!this.stopped&&!this.paused&&this.revision===revision;
    const check=()=>{if(!live()||!current()||!live())throw new StandaloneError('SOURCE_CHANGED');};
    const physical=Promise.resolve().then(async()=>{
      check();const bytes=await this.provider.read(path);check();
      if(bytes.byteLength>BOUNDS.fileBytes)throw new StandaloneError('SOURCE_LIMIT');
      const sha=hash(bytes),proof=await parser.policyMetadata!(path,bytes,root);check();
      if(proof.sourceId!==path||proof.sha256!==sha||proof.scopeId!==root||hash(await this.provider.read(path))!==sha)
        throw new StandaloneError('SOURCE_CHANGED');
      check();return proof;
    });
    this.policyRead=physical;
    const drain=()=>{if(this.policyRead===physical){this.policyRead=null;
      if(!this.stopped&&!this.paused&&(this.all||this.pending.size))this.schedule();}};
    void physical.then(drain,drain);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{expired=true;reject(new StandaloneError('PARSER_TIMEOUT'));},5000);
      physical.then(value=>{clearTimeout(timer);if(!expired){try{check();resolve(value);}catch(error){reject(error);}}},error=>{clearTimeout(timer);reject(error);});
    });
  }
  /** One existing worker/source owner, shared with lexical indexing and dry-run. */
  evaluateProcessingPolicy(host:PolicyHost,context:CallContext):Promise<PolicyEnvelope>{
    const parser=this.parser as MarkdownParser & Partial<PolicyMetadataParser>;
    if(this.stopped||!this.initialized||this.paused||this.work||this.policyRead||!parser.policyMetadata)
      return Promise.reject(new ProviderFailure('BUSY'));
    const revision=this.revision;
    const live=()=>!this.stopped&&!this.paused&&this.revision===revision;
    const current=()=>live()&&host.current()&&live();
    const evaluator=new EligibilityEvaluator(this.provider,{policyMetadata:(path,bytes,root)=>parser.policyMetadata!(path,bytes,root)},
      {snapshot:()=>host.snapshot(),current,...(host.marking?{marking:(proof:PolicyMetadataProof)=>host.marking!(proof)}:{})});
    const result=Promise.resolve().then(()=>evaluator.evaluate(context));
    const physical=result.then(()=>evaluator.drain(),()=>evaluator.drain());
    this.policyRead=physical;
    const release=()=>{if(this.policyRead===physical){this.policyRead=null;
      if(!this.stopped&&!this.paused&&(this.all||this.pending.size))this.schedule();}};
    void physical.then(release,release);
    return result.then(async envelope=>{
      if(!evaluator.physicallyPending)await physical;
      if(envelope.allowed&&!current())throw new ProviderFailure('CANCELLED');
      return envelope;
    });
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
      const beforeHints = await this.provider.versionHints(paths);
      if (this.stopped || this.paused || revision !== this.revision) return;
      const live = new Set(paths);
      const prior = new Map((this.generation?.documents ?? []).map(doc => [doc.sourceId, doc]));
      for (const path of [...prior.keys()]) if (!live.has(path)) prior.delete(path);
      let blocks = [...prior.values()].reduce((count, doc) => count + doc.blocks.length, 0);
      const targets = full ? paths : paths.filter(path => changes.has(path) || !prior.has(path));
      for (const path of targets) {
        if (this.stopped || this.paused || revision !== this.revision) return;
        const previous = prior.get(path);
        const bytes = await this.provider.read(path);
        if (previous && hash(bytes) === previous.sha256) {
          await this.yieldJob();
          continue; // Full audit reuses unchanged, already authenticated documents.
        }
        if (previous) blocks -= previous.blocks.length;
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
      const afterHints = await this.provider.versionHints(currentPaths);
      if (beforeHints.some((hint, i) => hint !== afterHints[i]))
        throw new StandaloneError('SOURCE_CHANGED');
      if (this.stopped || this.paused || revision !== this.revision) return;
      const next = makeGeneration(this.provider.rootId, [...prior.values()]);
      // Repair a corrupt CURRENT recovered from PREVIOUS even when the source
      // content is unchanged, without risking deletion of the fallback snapshot.
      const publish = this.recoveryNeedsPublication || next.generationId !== this.generation?.generationId;
      if (publish) {
        try {
          const outcome = await this.store.commit(next, () => {
            if (this.stopped || this.paused || revision !== this.revision)
              throw new StandaloneError('CANCELLED');
            // The rename is about to start. A later cancel is deferred.
            this.publishing = true;
          }, published => {
            // No await between successful rename and memory publication.
            // Failure or delay of the following fsync/GC cannot strand old state.
            this.generation = published;
            this.recoveryNeedsPublication = false;
            this.recordState('degraded', 'COMMIT_FINALIZING');
          });
          this.generation = outcome.generation;
          this.maintenanceWarning = outcome.maintenanceWarning;
        } finally {
          this.publishing = false;
        }
      }
      if (this.stopped) return;
      this.versionHints = afterHints;
      this.verifiedAt = this.now();
      if (this.paused) {
        this.recordState('degraded', 'CANCEL_DEFERRED');
      } else if (revision !== this.revision) {
        this.recordState('degraded', 'RECONCILING');
      } else if (this.maintenanceWarning) {
        this.recordState('degraded', this.maintenanceWarning);
      } else {
        this.recordState('ready', null);
      }
    } catch (error) {
      // An unknowable CURRENT must never expose an old in-memory generation as
      // searchable. Stop writes until a fresh authenticated store is opened.
      if (code(error) === 'INDEX_PUBLICATION_UNCERTAIN') {
        this.generation = null;
        this.versionHints = null;
        this.paused = true;
      }
      this.recordState(this.generation ? 'degraded' : 'failed', code(error));
    }
  }
  /** Complete explicit selection, independent of search query and Top-K. */
  async captureDenseCorpus(paths: readonly string[], limit: number, signal: AbortSignal): Promise<SelectedCorpus> {
    if (!Array.isArray(paths) || !paths.length || paths.length > BOUNDS.sources
      || paths.some(path => !validPath(path)) || new Set(paths).size !== paths.length
      || !Number.isSafeInteger(limit) || limit < 1 || limit > BOUNDS.blocks)
      throw new StandaloneError('INVALID_REQUEST');
    const selected = new Set(paths);
    const gen = this.generation, revision = this.revision;
    const current = (): boolean => !signal.aborted && !this.stopped && !this.paused
      && this.revision === revision && this.generation === gen && gen !== null
      && this.state.status === 'ready' && !this.work && !this.store.isPublicationUncertain();
    const check = (): void => {
      if (!current()) throw new StandaloneError(signal.aborted ? 'CANCELLED' : 'SOURCE_STALE');
    };
    check();
    const evidence: EvidenceHit[] = [];
    const docs = gen!.documents.filter(doc => selected.has(doc.sourceId));
    if (docs.length !== selected.size) throw new StandaloneError('INVALID_REQUEST');
    for (const doc of docs) {
      if (doc.extractionStatus !== 'ok') throw new StandaloneError('EVIDENCE_INCOMPLETE');
      const before = evidence.length;
      for (const block of doc.blocks) {
        if (block.kind === 'property' || block.kind === 'blank' || !block.originalText.trim()) continue;
        if (evidence.length >= limit) throw new StandaloneError('INDEX_LIMIT');
        // The internal EvidenceHit carrier uses enumeration ordinals, not query ranks.
        // A consumer must use the retrieval envelope for actual ranking.
        const rank = evidence.length + 1;
        evidence.push({sourceId:doc.sourceId,sourceSha256:doc.sha256,originalExcerpt:block.originalText,
          sourceLocators:[block.locator],rank,lexicalRank:rank,retrievalMode:'lexical',
          indexGenerationId:gen!.generationId,score:0,headings:block.headings,
          wikiLinks:block.wikiLinks,properties:doc.properties});
      }
      if (evidence.length === before) throw new StandaloneError('EVIDENCE_INCOMPLETE');
    }
    const live = await this.provider.list(); check();
    if (live.length !== gen!.documents.length || live.some((path,i) => path !== gen!.documents[i]?.sourceId))
      throw new StandaloneError('SOURCE_STALE');
    for (const doc of docs) {
      const bytes = await this.provider.read(doc.sourceId); check();
      for (const hit of evidence) if (hit.sourceId === doc.sourceId) verifySpan(hit,bytes);
    }
    const verify = async (hit: EvidenceHit): Promise<void> => {
      check();
      if (!selected.has(hit.sourceId) || hit.indexGenerationId !== gen!.generationId)
        throw new StandaloneError('EVIDENCE_INCOMPLETE');
      verifySpan(hit,await this.provider.read(hit.sourceId)); check();
    };
    const metadataPaths = (request: SearchRequest, lexicalGenerationId: string, selectedPaths: readonly string[]): readonly string[] => {
      check();
      validateRequest(request);
      if (!request.metadata || lexicalGenerationId !== gen!.generationId
        || !Array.isArray(selectedPaths) || selectedPaths.length !== selected.size
        || new Set(selectedPaths).size !== selected.size || selectedPaths.some(path => !selected.has(path)))
        throw new StandaloneError('INVALID_REQUEST');
      // Use the authoritative parsed document, including frontmatter and fence
      // semantics; the selected body evidence alone cannot establish eligibility.
      const paths = docs.filter(doc => metadataAnchor(doc, request.metadata, []))
        .map(doc => doc.sourceId);
      check();
      return paths;
    };
    check();
    return {rootId:gen!.rootId,lexicalGenerationId:gen!.generationId,
      evidence:structuredClone(evidence),current,verify,metadataPaths};
  }
  /** Capture explicit membership on the same authenticated lexical generation. */
  async captureChatScope(input:unknown,signal:AbortSignal):Promise<ChatScopeLease> {
    const selector=parseScopeSelector(input);
    const gen=this.generation, revision=this.revision;
    let retired=false, searching=false, verifying=false;
    const current=():boolean=>{
      if(!retired&&(signal.aborted||this.stopped||this.paused||this.revision!==revision
        ||gen===null||this.generation!==gen||this.state.status!=='ready'||this.work||this.store.isPublicationUncertain()))retired=true;
      return !retired;
    };
    const check=():void=>{if(!current())throw new StandaloneError(signal.aborted?'CANCELLED':'SCOPE_CHANGED');};
    const retire=(reason:string):never=>{retired=true;throw new StandaloneError(reason);};
    check();
    const {sources,coverage}=resolveScope(selector,gen!.documents);
    const snapshot=freezeScope({selector,rootId:gen!.rootId,generationId:gen!.generationId,sources,coverage});
    const range=selector.mode==='selected'&&selector.kind==='editor-selection'?selector.range:undefined;
    const properties=selector.mode==='selected'&&selector.kind==='properties'?selector:undefined;
    // A previously excluded source can enter a bulk selector after an edit.
    // Authenticate the complete bounded decision universe, not only returned IDs.
    const decisionDocs=selector.mode==='vault-wide'||properties?gen!.documents
      :selector.kind==='folder'?gen!.documents.filter(doc=>doc.sourceId.startsWith(selector.path+'/')):sources.map(source=>({sourceId:source.sourceId,sha256:source.sourceSha256}));
    const membership=async():Promise<void>=>{
      check();
      const live=await this.provider.list();check();
      if(live.length!==gen!.documents.length||live.some((path,i)=>path!==gen!.documents[i]?.sourceId))
        retire('SCOPE_CHANGED');
    };
    const versions=new Map(sources.map(source=>[source.sourceId,source.sourceSha256]));
    const verify=async(hits:readonly EvidenceHit[]=[]):Promise<void>=>{
      try{
        await membership();check();
        for(const doc of decisionDocs){
          check();
          const bytes=await this.provider.read(doc.sourceId);check();
          if(hash(bytes)!==doc.sha256)retire('SCOPE_CHANGED');
          if(range)verifyOriginalRange(range,bytes);
          for(const hit of hits)if(hit.sourceId===doc.sourceId)verifySpan(hit,bytes);
        }
        await membership();check();
      }catch(error){
        if(signal.aborted)retire('CANCELLED');
        if(error instanceof StandaloneError&&error.code==='INVALID_REQUEST')retire('SCOPE_INVALID');
        retire('SCOPE_CHANGED');
      }
    };
    const search=async(input:ScopedSearch):Promise<SearchResponse>=>{
      check();
      if(searching||verifying)throw new StandaloneError('BUSY');
      // Copy only the query parameters; the lease itself supplies every scope field.
      if(!input||typeof input.query!=='string'||!input.query.trim()
        ||Object.keys(input).some(k=>!['requestId','query','limit','matchMode'].includes(k)))
        throw new StandaloneError('SCOPE_INVALID');
      const request:SearchRequest={protocolVersion:PROTOCOL,requestId:input.requestId,query:input.query,
        requestedMode:'lexical',limit:input.limit,matchMode:input.matchMode,scope:sources.map(s=>s.sourceId),
        ...(range?{range}:{}),...(properties?{predicates:properties.predicates,metadata:properties.metadata}:{})};
      validateRequest(request);
      searching=true;
      try{
        await verify();check();
        const response=await this.search(request);check();
        if(response.status!=='ok'||response.executedMode!=='lexical'||response.indexGenerationId!==snapshot.generationId
          ||response.hits.some(hit=>!versions.has(hit.sourceId)||versions.get(hit.sourceId)!==hit.sourceSha256
            ||(range&&(hit.sourceLocators.length!==1||!containsLocator(range,hit.sourceLocators[0]!)))))
          retire('SCOPE_CHANGED');
        await verify(response.hits);check();
        return structuredClone(response);
      }finally{searching=false;}
    };
    await verify();check();
    return {snapshot,current,search,verify:async()=>{
      check();
      if(searching||verifying)throw new StandaloneError('BUSY');
      verifying=true;
      try{await verify();check();}finally{verifying=false;}
    }};
  }
  async search(input: unknown): Promise<SearchResponse> {
    validateRequest(input);
    const req: SearchRequest = input.range ? structuredClone(input) : input;
    const range = req.range;
    const rangeRevision = this.revision;
    const gen = this.generation; // Pin ALL response fields to this immutable snapshot.
    const response = (status: SearchResponse['status'], error: string | null,
      hits: EvidenceHit[], stale: number, snapshot: IndexGeneration | null = gen): SearchResponse => ({
      protocolVersion: PROTOCOL, requestId: req.requestId, requestedMode: req.requestedMode,
      executedMode: status === 'failed' ? 'none' : 'lexical', status, error,
      indexGenerationId: snapshot?.generationId ?? null, hits,
      capabilityReadiness: { lexical: !snapshot ? 'unavailable'
        : status === 'ok' ? 'ready' : status === 'failed' ? 'failed' : 'degraded', dense: 'unavailable' },
      staleSourceCount: stale,
    });
    // Snapshot pinning is valid for an ordinary A->B publication, but an
    // unauthenticated CURRENT or unload irrevocably revokes ALL in-flight hits.
    // Recheck after asynchronous reads and immediately before returning evidence.
    const visibilityFailure = (): string | null => this.stopped ? 'LIFECYCLE_INVALID'
      : this.store.isPublicationUncertain() ? 'INDEX_PUBLICATION_UNCERTAIN'
      : this.generation === null ? this.state.error ?? 'INDEX_UNAVAILABLE' : null;
    const denied = (reason: string): SearchResponse => response('failed', reason, [], 0, null);
    if (this.stopped) return denied('LIFECYCLE_INVALID');
    if (req.requestedMode !== 'lexical') return response('failed', 'CAPABILITY_UNAVAILABLE', [], 0);
    if (!gen) return denied(this.state.error ?? 'INDEX_UNAVAILABLE');
    try {
      // Events alone are insufficient. Every search validates the bounded path
      // list AND cheap filesystem version hints, including when there are no
      // lexical candidates. Only a drift/aged audit invokes full content reads.
      const paths = await this.provider.list();
      const hints = await this.provider.versionHints(paths);
      const drift = this.versionHints === null || paths.length !== gen.documents.length
        || paths.some((path, i) => path !== gen.documents[i]?.sourceId)
        || hints.length !== this.versionHints.length
        || hints.some((hint, i) => hint !== this.versionHints![i]);
      const age = this.now() - this.verifiedAt;
      const due = age < 0 || age >= SOURCE_AUDIT_INTERVAL_MS;
      if ((drift || due) && !this.stopped && !this.paused && !this.work) this.reconcile();
      if (range) {
        const selected = gen.documents.find(doc => doc.sourceId === range.sourceId);
        if (!selected || selected.sha256 !== range.sourceSha256 || !paths.includes(range.sourceId))
          throw new StandaloneError('SOURCE_STALE');
        verifyOriginalRange(range, await this.provider.read(range.sourceId));
        if (this.revision !== rangeRevision || this.generation !== gen) throw new StandaloneError('SOURCE_STALE');
      }
      // Protocol-v2 default is unchanged ranked terms. The explicit literal mode
      // checks original physical source lines, not query tokens or heading context.
      const metadataOnly = req.query === '';
      const literal = req.matchMode === 'literal';
      const needle = literal ? req.query.toLowerCase() : '';
      const tokens = literal || metadataOnly ? [] : [...new Set(terms(req.query))];
      if (tokens.length > BOUNDS.termsPerQuery) throw new StandaloneError('QUERY_INVALID');
      const mandatoryIds = literal || metadataOnly ? [] : req.query.toLowerCase().match(/[\p{L}\p{N}]+(?:[._/-][\p{L}\p{N}]+)+/gu) ?? [];
      const scope = req.scope ? new Set(req.scope) : null;
      const predicates = req.predicates ?? [];
      const candidates: { doc: SourceVersion; block: ParsedBlock; score: number }[] = [];
      for (const doc of gen.documents) {
        if ((scope && !scope.has(doc.sourceId)) || !matches(doc.properties, predicates)) continue;
        if (range && doc.sourceId !== range.sourceId) continue;
        if (doc.extractionStatus !== 'ok' && doc.extractionStatus !== 'partial') continue;
        const metadataEvidence = req.metadata || metadataOnly
          ? metadataAnchor(doc, req.metadata, predicates) : null;
        if ((req.metadata || metadataOnly) && !metadataEvidence) continue;
        if (metadataOnly) {
          // Empty text is never a wildcard: cite exactly one authentic source
          // line bearing the matched property, tag or authored wiki-link.
          candidates.push({ doc, block: metadataEvidence!, score: 1 });
          continue;
        }
        for (const block of doc.blocks) {
          if (range && !containsLocator(range,block.locator)) continue;
          let score: number;
          if (literal) {
            // Properties are typed metadata, not searchable body lines. Preserve
            // exact punctuation, phrase order, Cyrillic and Unicode characters.
            if (block.kind === 'property' || block.kind === 'blank') continue;
            const text = block.originalText.toLowerCase();
            const start = text.indexOf(needle);
            if (start < 0) continue;
            let occurrences = 0;
            for (let offset = start; offset >= 0 && occurrences < 16;
              offset = text.indexOf(needle, offset + needle.length)) occurrences++;
            score = 5 + occurrences;
          } else {
            // Canonical ordinary search includes heading terms; selected-range ranking
            // must not use headings outside the selection or inject any context.
            const rankedTerms = range && block.terms.length ? terms(block.originalText) : block.terms;
            if (!rankedTerms.length || mandatoryIds.some(id => !rankedTerms.includes(id))) continue;
            const matched = tokens.filter(term => rankedTerms.includes(term));
            if (!matched.length) continue;
            // Complete compound identifier gets stronger weight than individual parts.
            score = matched.reduce((sum, term) =>
              sum + (term.includes('-') || term.includes('/') || term.includes('.') ? 8 : 2), 0)
              + matched.length / tokens.length;
          }
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
        const hit: EvidenceHit = {
          sourceId: row.doc.sourceId, sourceSha256: row.doc.sha256, originalExcerpt: original,
          sourceLocators: [loc], rank: hits.length + 1, lexicalRank: hits.length + 1,
          retrievalMode: 'lexical', indexGenerationId: gen.generationId, score: row.score,
          headings: range ? [] : [...row.block.headings], wikiLinks: [...row.block.wikiLinks],
          properties: range ? [] : row.doc.properties,
        };
        if (range) {
          if (hit.sourceId !== range.sourceId || !containsLocator(range,loc)) throw new StandaloneError('EVIDENCE_INCOMPLETE');
          verifySpan(hit,bytes);
        }
        hits.push(hit);
        if (hits.length >= req.limit) break;
      }
      if (range) {
        // Even a zero-hit answer must authenticate the selected source before publication.
        const currentPaths=await this.provider.list();
        verifyOriginalRange(range,await this.provider.read(range.sourceId));
        if (!currentPaths.includes(range.sourceId) || stale || this.revision !== rangeRevision || this.generation !== gen)
          throw new StandaloneError('SOURCE_STALE');
      }
      // A missed event never defeats live hash suppression; queue reconciliation for recovery.
      if (stale && !this.stopped && !this.paused && !this.work) this.reconcile();
      const revoked = visibilityFailure();
      if (revoked) return denied(revoked);
      const switched = this.generation !== gen;
      const degraded = drift || due || switched || this.state.status !== 'ready'
        || this.work !== null || stale > 0;
      return response(degraded ? 'degraded' : 'ok',
        degraded ? (drift || due || switched ? 'RECONCILING'
          : this.state.error ?? (stale ? 'SOURCE_STALE' : 'RECONCILING')) : null,
        hits, stale);
    } catch (error) {
      if (!this.stopped && !this.paused && !this.work) this.reconcile();
      const revoked = visibilityFailure();
      return revoked ? denied(revoked) : response('failed', code(error), [], 0);
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.revision++;
    this.pending.clear(); this.all = false;
    await this.parser.close(); // Interrupt CPU-bound parse immediately on unload.
    if (this.work) await this.work;
    if(this.policyRead)await this.policyRead.catch(()=>{});
    this.recordState('unavailable', 'LIFECYCLE_INVALID');
  }
}
function code(error: unknown): string {
  return error instanceof StandaloneError ? error.code : 'IO_FAILURE';
}
