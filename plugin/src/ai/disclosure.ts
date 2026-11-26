import { hash, isDigest } from '../standalone/contracts';
import { generationPolicyPayload, generationPolicySourceDigest, sameGenerationPolicy, type GenerationPolicyBinding } from './generation-policy';
import { parsePreference } from './config';
import { ProviderFailure, type AiRole, type AuthorizedCandidates, type ProviderConfig } from './contracts';

export type Classification = 'synthetic' | 'public' | 'internal' | 'confidential' | 'unknown';
type ClassifiedText = { text: string; classification: Classification };
export type Candidate = ClassifiedText & { sourceId: string; sourceSha256: string };
/** Trusted host-issued, ephemeral, exact-input grant; never read from notes or settings.
 * The caller must verify original evidence and current scope immediately before each use.
 * Transport must separately enforce network identity, authentication, quota, and cancellation. */
export type DisclosureGrant = {
  version: 1; role: AiRole; configDigest: string; scopeId: string; expiresUnixMs: number;
  queryDigest: string; queryClassification: Classification;
  runtimeProfileBinding?: string;
  notePolicyBinding?:GenerationPolicyBinding;
  sources: readonly { sourceId: string; sourceSha256: string; excerptDigest: string; classification: Classification }[];
};
export function configDigest(role: AiRole, config: ProviderConfig): string {
  const parsed = parsePreference(config);
  if (parsed.state !== 'configured') throw new ProviderFailure('CONFIG_INVALID');
  return hash(JSON.stringify([role, parsed]));
}
const allowed = (c: Classification): boolean => c === 'synthetic' || c === 'public';
const deny = (): never => { throw new ProviderFailure('DISCLOSURE_DENIED'); };
function checkedBytes(text: unknown, max: number): number {
  if (typeof text !== 'string' || !text.length || text.length > max
    || text.includes('\0') || Buffer.from(text,'utf8').toString('utf8') !== text)
    throw new ProviderFailure('LIMIT_EXCEEDED');
  const bytes = Buffer.byteLength(text);
  if (bytes > max) throw new ProviderFailure('LIMIT_EXCEEDED');
  return bytes;
}
export function projectDisclosure(role: AiRole, config: ProviderConfig, scopeId: string,
  query: ClassifiedText, candidates: readonly Candidate[], grant: DisclosureGrant | null,
  signal: AbortSignal, now = Date.now(), notePolicy?:GenerationPolicyBinding): AuthorizedCandidates {
  if (signal.aborted) throw new ProviderFailure('CANCELLED');
  const digest = configDigest(role, config);
  // Bound inputs before hashing; invalid Unicode cannot alias a different digest.
  let bytes = checkedBytes(query.text, config.limits.maxInputBytes);
  if (!grant || grant.version !== 1 || grant.role !== role || grant.configDigest !== digest
    || !isDigest(scopeId) || grant.scopeId !== scopeId || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(grant.expiresUnixMs) || grant.expiresUnixMs <= now
    || grant.expiresUnixMs - now > 300000 || !allowed(query.classification)
    || grant.queryClassification !== query.classification || grant.queryDigest !== hash(query.text)) return deny();
  if (!Array.isArray(candidates) || candidates.length > config.limits.maxCandidates
    || !Array.isArray(grant.sources) || grant.sources.length > config.limits.maxCandidates)
    throw new ProviderFailure('LIMIT_EXCEEDED');
  const policy=grant.notePolicyBinding;
  if(policy||notePolicy){
    if((role!=='generation'&&role!=='reranking')||!sameGenerationPolicy(policy,notePolicy)||!policy
      ||policy.deadlineUnixMs<grant.expiresUnixMs||now>=policy.deadlineUnixMs
      ||grant.sources.length!==candidates.length)return deny();
  }
  const passages = candidates.map((c, id) => {
    bytes += checkedBytes(c.text, config.limits.maxInputBytes - bytes);
    if ((policy?c.classification!=='unknown':!allowed(c.classification)) || !isDigest(c.sourceSha256) || typeof c.sourceId !== 'string'
      || !c.sourceId || !grant.sources.some(s => s.sourceId === c.sourceId && s.sourceSha256 === c.sourceSha256
        && s.classification === c.classification && s.excerptDigest === hash(c.text))
      ||policy&&(grant.sources[id]?.sourceId!==c.sourceId||grant.sources[id]?.sourceSha256!==c.sourceSha256
        ||grant.sources[id]?.excerptDigest!==hash(c.text)||grant.sources[id]?.classification!=='unknown')) return deny();
    // Source IDs, hashes, paths, classification and authorization stay local.
    return { id, text: c.text };
  });
  if(policy&&(policy.payloadDigest!==generationPolicyPayload(query.text,candidates,role as 'generation'|'reranking')
    ||policy.sourceDigest!==generationPolicySourceDigest({role:role as 'generation'|'reranking',sources:candidates.map(c=>({sourceId:c.sourceId,sourceSha256:c.sourceSha256,excerptDigest:hash(c.text)}))})))return deny();
  return { query: query.text, passages };
}
