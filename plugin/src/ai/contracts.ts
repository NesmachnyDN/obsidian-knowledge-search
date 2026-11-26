/** Internal provider contract v1. Not a vendor wire protocol or readiness claim. */
export const AI_CONTRACT_VERSION = 1 as const;
export const AI_ROLES = ['embedding', 'reranking', 'generation'] as const;
export type AiRole = typeof AI_ROLES[number];
export type ProviderFailureCode = 'DISABLED' | 'CONFIG_INVALID' | 'NOT_READY'
  | 'BUSY'
  | 'ENDPOINT_DENIED' | 'DISCLOSURE_DENIED' | 'MODEL_MISMATCH' | 'LIMIT_EXCEEDED'
  | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'RATE_LIMITED' | 'QUOTA_EXCEEDED'
  | 'TIMEOUT' | 'CANCELLED' | 'NETWORK' | 'SERVER_ERROR' | 'INVALID_RESPONSE' | 'SOURCE_STALE';
export class ProviderFailure extends Error {
  constructor(readonly code: ProviderFailureCode) { super(code); this.name = 'ProviderFailure'; }
}
export type ProviderIdentity = { model: string; revision: string };
export type ProviderLimits = {
  timeoutMs: number; maxInputBytes: number; maxCandidates: number; maxOutputTokens: number;
  maxConcurrent: 1;
};
export type ProviderConfig = {
  state: 'configured'; transport: 'local' | 'cloud'; origin: string;
  identity: ProviderIdentity; limits: ProviderLimits;
};
export type ProviderPreference = ProviderConfig | { state: 'disabled' | 'invalid' };
export type ProviderPreferences = Record<AiRole, ProviderPreference>;
export type ProviderStatus = {
  version: typeof AI_CONTRACT_VERSION; role: AiRole;
  state: 'disabled' | 'unavailable' | 'ready' | 'failed';
  error: ProviderFailureCode | null;
};
/** Metadata-only view of an explicit operation, not a persistent provider readiness claim. */
export type AiOperationStatus = { phase: 'idle' | 'permission-required' | 'busy' | 'complete' | 'failed';
  error: ProviderFailureCode | null };
export type CallContext = { signal: AbortSignal; deadlineUnixMs: number };
export type AuthorizedPassage = { id: number; text: string };
export type AuthorizedCandidates = { query: string; passages: readonly AuthorizedPassage[] };
export type EmbeddingSpace = ProviderIdentity & {
  dimension: number; normalization: 'unit-l2' | 'none'; serializationId: string;
  queryInstructionId: string; documentInstructionId: string;
};
interface Provider<R extends AiRole> {
  readonly version: typeof AI_CONTRACT_VERSION;
  readonly role: R;
  readonly identity: ProviderIdentity;
  readonly limits: ProviderLimits;
  health(context: CallContext): Promise<ProviderStatus>;
}
export interface EmbeddingProvider extends Provider<'embedding'> {
  readonly space: EmbeddingSpace;
  embed(input: { purpose: 'query' | 'document'; texts: readonly string[] },
    context: CallContext): Promise<{ space: EmbeddingSpace; vectors: readonly (readonly number[])[] }>;
}
export interface RerankingProvider extends Provider<'reranking'> {
  rerank(input: AuthorizedCandidates, context: CallContext):
    Promise<readonly { id: number; score: number }[]>;
}
export interface GenerationProvider extends Provider<'generation'> {
  generate(input: AuthorizedCandidates, context: CallContext):
    Promise<readonly { kind: 'quotation' | 'inference'; text: string; citationIds: readonly number[] }[]>;
}
/** Implementations must resolve credentials outside persisted Vault settings. */
export interface CredentialResolver {
  resolve(role: AiRole, config: ProviderConfig, signal: AbortSignal): Promise<string | null>;
}

/** Canonical bounded bearer grammar; reject line terminators before header creation. */
export function isBearerToken(value:unknown):value is string {
  return typeof value==='string' && /^[A-Za-z0-9._~+\/=-]{1,512}$(?![\s\S])/.test(value);
}
