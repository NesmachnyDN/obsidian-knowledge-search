import { hash, isDigest } from '../standalone/contracts';
import type { CallContext, ProviderConfig } from './contracts';
import type { PolicyEnvelope } from './processing-policy';

/**
 * Host-owned bridge between the generation controller and the canonical policy
 * evaluator.  It deliberately carries neither a provider capability nor a
 * grant: real profile admission remains outside this repository slice.
 */
export type GenerationPolicyInput = Readonly<{
  role: 'generation'; config: ProviderConfig; scopeId: string; ownerId: string;
  hostId: string; credentialEpoch: number; deadlineUnixMs: number;
  payloadDigest: string;
  sources: readonly Readonly<{sourceId:string; sourceSha256:string; excerptDigest:string}>[];
}>;
export type GenerationPolicyPort = Readonly<{
  evaluate(input: GenerationPolicyInput, context: CallContext): Promise<PolicyEnvelope>;
}>;
export type GenerationPolicyBinding = Readonly<{
  bindingDigest: string; payloadDigest: string; sourceDigest: string; deadlineUnixMs:number;
}>;

export function generationPolicyInput(input: GenerationPolicyInput): GenerationPolicyInput {
  if (!isDigest(input.scopeId) || !isDigest(input.payloadDigest)
    || !input.ownerId || !input.hostId || !Number.isSafeInteger(input.credentialEpoch) || input.credentialEpoch < 1
    || !Number.isSafeInteger(input.deadlineUnixMs) || input.deadlineUnixMs < 1
    || !Array.isArray(input.sources) || !input.sources.length || new Set(input.sources.map(x=>x.sourceId)).size !== input.sources.length
    || input.sources.some(x=>!x.sourceId || !isDigest(x.sourceSha256) || !isDigest(x.excerptDigest))) throw Error('invalid policy input');
  return Object.freeze({ ...input, config: structuredClone(input.config),
    sources: Object.freeze(input.sources.map(x=>Object.freeze({...x}))) });
}
export function generationPolicyPayload(query: string, candidates: readonly {sourceId:string;sourceSha256:string;text:string}[]): string {
  return hash(JSON.stringify([query,candidates.map(x=>[x.sourceId,x.sourceSha256,hash(x.text)])]));
}
export function generationPolicySourceDigest(input: GenerationPolicyInput): string {
  return hash(JSON.stringify(input.sources.map(x=>[x.sourceId,x.sourceSha256,x.excerptDigest])));
}
export async function evaluateGenerationPolicy(port: GenerationPolicyPort, input: GenerationPolicyInput,
  context: CallContext): Promise<GenerationPolicyBinding> {
  const exact=generationPolicyInput(input), result=await port.evaluate(exact,context);
  if (!result.allowed || !isDigest(result.bindingDigest) || result.policyVersion !== 'oks-policy-1b'
    || result.sourceVersions.length !== exact.sources.length
    || result.sourceVersions.some((x,index)=>x.sourceId!==exact.sources[index]!.sourceId
      || x.sha256!==exact.sources[index]!.sourceSha256)) throw Error('policy denied');
  return Object.freeze({bindingDigest:result.bindingDigest,payloadDigest:exact.payloadDigest,sourceDigest:generationPolicySourceDigest(exact),deadlineUnixMs:exact.deadlineUnixMs});
}
