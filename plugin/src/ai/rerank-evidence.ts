import { type EvidenceHit } from '../standalone/contracts';
import { type CallContext } from './contracts';
import { LoopbackRerankTransport } from './loopback-rerank';
import { VerifiedEvidenceOperation, type EvidenceApproval } from './verified-evidence';
export type { ClassifiedHit } from './verified-evidence';
export type RerankApproval = EvidenceApproval;
export type RerankedHit = { evidence: EvidenceHit; rerankRank: number; rerankScore: number };
export class EvidenceReranker {
  private readonly transport = new LoopbackRerankTransport();
  private readonly operation = new VerifiedEvidenceOperation();
  async run(approval: RerankApproval, token: string, context: CallContext,
    verify: (hit: EvidenceHit) => Promise<void>, current: () => boolean): Promise<readonly RerankedHit[]> {
    const {result,evidence} = await this.operation.run('reranking', approval, context, verify, current,
      (config,input,call)=>this.transport.rerank(config,input,token,call));
    return result.map((row,i)=>({evidence:evidence[row.id]!,rerankRank:i+1,rerankScore:row.score}));
  }
}
