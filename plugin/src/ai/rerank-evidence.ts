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
  async run(approval: RerankApproval, token: string, context: CallContext,
    verify: (hit: EvidenceHit) => Promise<void>, current: () => boolean): Promise<readonly RerankedHit[]> {
    if (this.busy) throw new ProviderFailure('QUOTA_EXCEEDED');
    const config = pilotConfig(approval.config);
    if (!Array.isArray(approval.candidates) || approval.candidates.length < 1
      || approval.candidates.length > config.limits.maxCandidates) throw new ProviderFailure('LIMIT_EXCEEDED');
    const snapshot = structuredClone(approval);
    const check = (): void => {
      if (context.signal.aborted || !current()) throw new ProviderFailure('CANCELLED');
      if (!Number.isSafeInteger(context.deadlineUnixMs) || Date.now() >= context.deadlineUnixMs)
        throw new ProviderFailure('TIMEOUT');
    };
    const verifyAll = async (): Promise<void> => {
      for (const { hit } of snapshot.candidates) {
        check();
        try { await verify(structuredClone(hit)); }
        catch { check(); throw new ProviderFailure('SOURCE_STALE'); }
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
