import type { EvidenceHit } from '../standalone/contracts';
import { ProviderFailure, type CallContext } from './contracts';
import { bindActiveDeadline, remainingOperationMs } from './active-deadline';
import { pilotConfig } from './loopback-json';
import { LoopbackGenerationTransport } from './loopback-generation';
import { VerifiedEvidenceOperation, type EvidenceApproval } from './verified-evidence';

export type GeneratedEvidenceClaim = {
  kind:'quotation'|'inference'; text:string; citations:readonly EvidenceHit[];
};
export class EvidenceGenerator {
  private readonly transport=new LoopbackGenerationTransport();
  private readonly operation=new VerifiedEvidenceOperation();
  async run(approval:EvidenceApproval,token:string,context:CallContext,
    verify:(hit:EvidenceHit)=>Promise<void>,current:()=>boolean):Promise<readonly GeneratedEvidenceClaim[]> {
    context=bindActiveDeadline(context,pilotConfig(approval.config).limits.timeoutMs,approval.grant?.expiresUnixMs);
    const {result,evidence}=await this.operation.run('generation',approval,context,verify,current,
      (config,input,call)=>this.transport.generate(config,input,token,call));
    const valid = current();
    remainingOperationMs(context);
    if (!valid) throw new ProviderFailure('CANCELLED');
    return result.map(claim=>({kind:claim.kind,text:claim.text,citations:claim.citationIds.map(id=>evidence[id]!)}));
  }
}
