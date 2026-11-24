import { type EvidenceHit } from '../standalone/contracts';
import { ProviderFailure, type CallContext } from './contracts';
import { LoopbackRerankTransport, pilotConfig } from './loopback-rerank';
import { assertRerankAdmission, type RerankAdmission } from './rerank-profile';
import { VerifiedEvidenceOperation, type EvidenceApproval } from './verified-evidence';
export type { ClassifiedHit } from './verified-evidence';
export type RerankApproval = EvidenceApproval;
export type RerankedHit = { evidence: EvidenceHit; rerankRank: number; rerankScore: number };
export class EvidenceReranker {
  private readonly transport = new LoopbackRerankTransport();
  private readonly operation = new VerifiedEvidenceOperation();
  async run(approval: RerankApproval, token: string, context: CallContext,
    verify: (hit: EvidenceHit) => Promise<void>, current: () => boolean,
    admission?: RerankAdmission): Promise<readonly RerankedHit[]> {
    const config = pilotConfig(approval.config), scopeId = approval.scopeId;
    assertRerankAdmission(admission,config,scopeId);
    if (!Array.isArray(approval.candidates) || approval.candidates.length > config.limits.maxCandidates)
      throw new ProviderFailure('LIMIT_EXCEEDED');
    if (approval.grant?.runtimeProfileBinding !== admission.bindingDigest
      || approval.query?.classification !== 'synthetic'
      || approval.candidates.some(c=>c?.classification !== 'synthetic')) throw new ProviderFailure('DISCLOSURE_DENIED');
    const stillCurrent = (): boolean => {
      try { assertRerankAdmission(admission,config,scopeId); return current(); } catch { return false; }
    };
    const {result,evidence} = await this.operation.run('reranking', approval, context, verify, stillCurrent,
      (config,input,call)=>this.transport.rerank(config,input,token,call,admission));
    if (!stillCurrent() || context.signal.aborted) throw new ProviderFailure('CANCELLED');
    return result.map((row,i)=>({evidence:evidence[row.id]!,rerankRank:i+1,rerankScore:row.score}));
  }
}
