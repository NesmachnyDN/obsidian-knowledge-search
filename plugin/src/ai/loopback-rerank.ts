import { isRecord } from '../standalone/contracts';
import { ProviderFailure, type CallContext, type ProviderConfig, type AuthorizedCandidates } from './contracts';
import { LoopbackJsonTransport, checkedCandidates, pilotConfig, servedAlias } from './loopback-json';
import { bindActiveDeadline, remainingOperationMs } from './active-deadline';
import { assertRerankAdmission, type RerankAdmission } from './rerank-profile';
export { pilotConfig, servedAlias } from './loopback-json';
export type RerankScore = { id: number; score: number };
const fail = (code: ConstructorParameters<typeof ProviderFailure>[0]): never => { throw new ProviderFailure(code); };
function responseScores(value: unknown, model: string, count: number): RerankScore[] {
  if (!isRecord(value) || typeof value.model !== 'string') return fail('INVALID_RESPONSE');
  if (value.model !== model) return fail('MODEL_MISMATCH');
  if (!Array.isArray(value.results) || value.results.length !== count) return fail('INVALID_RESPONSE');
  const seen = new Set<number>();
  const scores: RerankScore[] = [];
  for (const row of value.results) {
    if (!isRecord(row) || !Number.isInteger(row.index) || (row.index as number) < 0
      || (row.index as number) >= count || seen.has(row.index as number)
      || typeof row.relevance_score !== 'number' || !Number.isFinite(row.relevance_score))
      return fail('INVALID_RESPONSE');
    const id = row.index as number;
    seen.add(id); scores.push({ id, score: row.relevance_score });
  }
  return scores.sort((a, b) => b.score - a.score || a.id - b.id);
}

export class LoopbackRerankTransport {
  private readonly transport = new LoopbackJsonTransport();
  async rerank(value: ProviderConfig, input: AuthorizedCandidates, token: string,
    context: CallContext, admission?: RerankAdmission): Promise<readonly RerankScore[]> {
    const config = pilotConfig(value);
    assertRerankAdmission(admission,config);
    context = bindActiveDeadline(context,config.limits.timeoutMs);
    const documents = checkedCandidates(config, input);
    const model = servedAlias(config);
    const result = await this.transport.send(config, '/v1/rerank', {model, query:input.query, documents,
      top_n:documents.length, max_tokens_per_query:0, max_tokens_per_doc:0}, token, context);
    assertRerankAdmission(admission,config);
    remainingOperationMs(context);
    return responseScores(result, model, documents.length);
  }
}
