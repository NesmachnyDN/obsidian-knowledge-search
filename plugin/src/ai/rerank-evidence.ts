import { type EvidenceHit } from '../standalone/contracts';
import { ProviderFailure, type ProviderConfig, type CallContext } from './contracts';
import { projectDisclosure, type Classification, type DisclosureGrant } from './disclosure';
import { LoopbackRerankTransport, pilotConfig } from './loopback-rerank';

export type ClassifiedHit = { hit: EvidenceHit; classification: Classification };
export type RerankedHit = { evidence: EvidenceHit; rerankRank: number; rerankScore: number };
export type RerankApproval = {
  config: ProviderConfig; scopeId: string; query: { text: string; classification: Classification };
  candidates: readonly ClassifiedHit[]; grant: DisclosureGrant;
};
/** Own one instance per search controller. The trusted host supplies the grant,
 * verifies current original bytes and invalidates the lifecycle guard on changes.
 * No provider-produced text, source ID or citation ever becomes local evidence. */
export class EvidenceReranker {
  private readonly transport = new LoopbackRerankTransport();
  private busy = false;
  // A non-cancellable filesystem syscall may settle late. Admit at most two
  // outstanding reads, including abandoned ones, across operations.
  private pendingVerification = 0;
  private verifyBounded(hit: EvidenceHit, verify: (hit: EvidenceHit) => Promise<void>,
    context: CallContext): Promise<void> {
    if (context.signal.aborted) return Promise.reject(new ProviderFailure('CANCELLED'));
    const remaining = context.deadlineUnixMs - Date.now();
    if (remaining <= 0) return Promise.reject(new ProviderFailure('TIMEOUT'));
    if (this.pendingVerification >= 2) return Promise.reject(new ProviderFailure('QUOTA_EXCEEDED'));
    this.pendingVerification++;
    return new Promise((resolve,reject) => {
      let settled=false;
      const finish=(error?:ProviderFailure):void=>{
        if(settled)return;
        settled=true;clearTimeout(timer);context.signal.removeEventListener('abort',cancel);
        if(error)reject(error);else resolve();
      };
      const cancel=()=>finish(new ProviderFailure('CANCELLED'));
      const timer=setTimeout(()=>finish(new ProviderFailure('TIMEOUT')),remaining);
      context.signal.addEventListener('abort',cancel,{once:true});
      // Both success and rejection are observed even after timeout/abort.
      Promise.resolve().then(()=>{
        if(context.signal.aborted)throw new ProviderFailure('CANCELLED');
        return verify(hit);
      }).then(()=>{this.pendingVerification--;finish();},()=>{
        this.pendingVerification--;finish(new ProviderFailure('SOURCE_STALE'));
      });
      if(context.signal.aborted)cancel();
    });
  }
  async run(approval: RerankApproval, token: string, context: CallContext,
    verify: (hit: EvidenceHit) => Promise<void>, current: () => boolean): Promise<readonly RerankedHit[]> {
    if (this.busy) throw new ProviderFailure('QUOTA_EXCEEDED');
    const config = pilotConfig(approval.config);
    if (!Array.isArray(approval.candidates) || approval.candidates.length < 1
      || approval.candidates.length > config.limits.maxCandidates) throw new ProviderFailure('LIMIT_EXCEEDED');
    const snapshot = structuredClone(approval);
    if (!Number.isSafeInteger(context.deadlineUnixMs)) throw new ProviderFailure('CONFIG_INVALID');
    context = {signal:context.signal,deadlineUnixMs:Math.min(context.deadlineUnixMs,Date.now()+config.limits.timeoutMs)};
    const check = (): void => {
      if (context.signal.aborted || !current()) throw new ProviderFailure('CANCELLED');
      if (!Number.isSafeInteger(context.deadlineUnixMs) || Date.now() >= context.deadlineUnixMs)
        throw new ProviderFailure('TIMEOUT');
    };
    const verifyAll = async (): Promise<void> => {
      for (const { hit } of snapshot.candidates) {
        check();
        await this.verifyBounded(structuredClone(hit),verify,context);
        check();
      }
    };
    const projection = () => projectDisclosure('reranking', config, snapshot.scopeId, snapshot.query,
      snapshot.candidates.map(({hit, classification}) => ({
        text: hit.originalExcerpt, sourceId: hit.sourceId, sourceSha256: hit.sourceSha256, classification,
      })), snapshot.grant, context.signal);
    this.busy = true;
    try {
      check(); projection(); await verifyAll(); check();
      const scores = await this.transport.rerank(config, projection(), token, context);
      check(); projection(); await verifyAll(); check(); projection();
      return scores.map((row, i) => ({
        evidence: snapshot.candidates[row.id]!.hit, rerankRank: i + 1, rerankScore: row.score,
      }));
    } finally { this.busy = false; }
  }
}
