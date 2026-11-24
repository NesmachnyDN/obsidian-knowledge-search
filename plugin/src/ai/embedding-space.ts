import { hash, isRecord } from '../standalone/contracts';
import { ProviderFailure, type EmbeddingSpace, type ProviderConfig } from './contracts';
import { pilotConfig } from './loopback-json';

/** This pilot supports only raw original text, with the same identity instruction
 * on either side. Other model instructions require their own reviewed profile. */
export function validateEmbeddingSpace(config: ProviderConfig, value: unknown): EmbeddingSpace {
  const parsed=pilotConfig(config);
  if (!isRecord(value)||Object.keys(value).length!==7
    || value.model!==parsed.identity.model||value.revision!==parsed.identity.revision
    || typeof value.dimension!=='number'||!Number.isSafeInteger(value.dimension)||value.dimension<1||value.dimension>4096
    || value.normalization!=='unit-l2'||value.serializationId!=='utf8-verbatim-v1'
    || value.queryInstructionId!=='identity-v1'||value.documentInstructionId!=='identity-v1')
    throw new ProviderFailure('MODEL_MISMATCH');
  return {model:parsed.identity.model,revision:parsed.identity.revision,dimension:value.dimension,
    normalization:'unit-l2',serializationId:'utf8-verbatim-v1',
    queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'};
}
export function embeddingSpaceId(config:ProviderConfig,space:EmbeddingSpace):string {
  const parsed=pilotConfig(config);
  return hash(JSON.stringify(['oks-api-embedding-v1',parsed.origin,validateEmbeddingSpace(parsed,space)]));
}
export function checkedVector(value:unknown,space:EmbeddingSpace):number[] {
  if(!Array.isArray(value)||value.length!==space.dimension||
    value.some(x=>typeof x!=='number'||!Number.isFinite(x)))
    throw new ProviderFailure('INVALID_RESPONSE');
  const norm=Math.hypot(...value);
  if(!Number.isFinite(norm)||Math.abs(norm-1)>1e-4)throw new ProviderFailure('INVALID_RESPONSE');
  return [...value];
}
