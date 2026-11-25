import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { hash, isDigest } from '../standalone/contracts';
import { ProviderFailure, type ProviderConfig } from './contracts';
import { configDigest } from './disclosure';
import { pilotConfig } from './loopback-json';

export const RERANK_PROFILE_VERSION = 1 as const;
export const FIXTURE_PROFILE_TTL_MS = 30 * 60_000;
export type RerankRuntimeProfile = Readonly<{
  version: 1; kind: 'actual' | 'synthetic'; role: 'reranking';
  model: string; revision: string; artifactSha256: string | null; attestationSha256: string | null;
  runtime: string; runtimeVersion: string; adapter: 'cohere-rerank-http-v1'; schemaVersion: 1;
  tokenizer: string | null; tokenizerRevision: string | null;
  pairTemplateSha256: string | null; instructionSha256: string | null;
  scoring: 'finite-higher-first-original-ties'; maxPairTokens: number | null;
  truncation: 'reject' | 'not-applicable-fixture'; fixtureId: string | null;
  origin: string; configDigest: string; maxInputBytes: number; maxCandidates: number;
}>;
const keys = ['version','kind','role','model','revision','artifactSha256','attestationSha256',
  'runtime','runtimeVersion','adapter','schemaVersion','tokenizer','tokenizerRevision',
  'pairTemplateSha256','instructionSha256','scoring','maxPairTokens','truncation','fixtureId',
  'origin','configDigest','maxInputBytes','maxCandidates'] as const;
const invalid = (): never => { throw new ProviderFailure('CONFIG_INVALID'); };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v);
const positive = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;

/** Declaration only. Canonical order, bounded primitive fields; never an attestation. */
export function parseRerankRuntimeProfile(value: unknown, config: ProviderConfig): RerankRuntimeProfile {
  const c = pilotConfig(config);
  if (!value || typeof value !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length) return invalid();
  const fields: Record<string, unknown> = {};
  for (const k of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value,k);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor,'value')) return invalid();
    fields[k] = descriptor.value;
  }
  const p = fields;
  if (p.version !== RERANK_PROFILE_VERSION || p.role !== 'reranking'
    || !id(p.model) || !id(p.revision) || !id(p.runtime) || !id(p.runtimeVersion)
    || p.adapter !== 'cohere-rerank-http-v1' || p.schemaVersion !== 1
    || p.scoring !== 'finite-higher-first-original-ties' || p.origin !== c.origin
    || p.configDigest !== configDigest('reranking',c)
    || p.maxInputBytes !== c.limits.maxInputBytes || p.maxCandidates !== c.limits.maxCandidates) return invalid();
  if (p.model !== c.identity.model || p.revision !== c.identity.revision)
    throw new ProviderFailure('MODEL_MISMATCH');
  if (p.kind === 'actual') {
    if ((!isDigest(p.artifactSha256) && !isDigest(p.attestationSha256))
      || (p.artifactSha256 !== null && !isDigest(p.artifactSha256))
      || (p.attestationSha256 !== null && !isDigest(p.attestationSha256))
      || !id(p.tokenizer) || !id(p.tokenizerRevision) || !isDigest(p.pairTemplateSha256)
      || !isDigest(p.instructionSha256) || !positive(p.maxPairTokens,1_000_000)
      || p.truncation !== 'reject' || p.fixtureId !== null) return invalid();
  } else if (p.kind === 'synthetic') {
    if (!/^(?:synthetic-|fixture(?:-|$))/.test(p.model as string) || p.runtime !== 'synthetic-http-fixture' || p.runtimeVersion !== '1' || !id(p.fixtureId)
      || p.truncation !== 'not-applicable-fixture' ||
      [p.artifactSha256,p.attestationSha256,p.tokenizer,p.tokenizerRevision,p.pairTemplateSha256,
        p.instructionSha256,p.maxPairTokens].some(v=>v!==null)) return invalid();
  } else return invalid();
  return Object.freeze(fields) as RerankRuntimeProfile;
}
export function rerankProfileDigest(value: unknown, config: ProviderConfig): string {
  return hash(JSON.stringify(parseRerankRuntimeProfile(value,config)));
}

/** Non-model fixture declaration. Calling this does not grant admission. */
export function syntheticRuntimeProfile(config: ProviderConfig, fixtureId: string): RerankRuntimeProfile {
  const c = pilotConfig(config);
  return parseRerankRuntimeProfile({
    version:1,kind:'synthetic',role:'reranking',model:c.identity.model,revision:c.identity.revision,
    artifactSha256:null,attestationSha256:null,runtime:'synthetic-http-fixture',runtimeVersion:'1',
    adapter:'cohere-rerank-http-v1',schemaVersion:1,tokenizer:null,tokenizerRevision:null,
    pairTemplateSha256:null,instructionSha256:null,scoring:'finite-higher-first-original-ties',
    maxPairTokens:null,truncation:'not-applicable-fixture',fixtureId,origin:c.origin,
    configDigest:configDigest('reranking',c),maxInputBytes:c.limits.maxInputBytes,maxCandidates:c.limits.maxCandidates,
  },c);
}

export type RerankAdmission = Readonly<{
  profile: RerankRuntimeProfile; profileDigest: string; bindingDigest: string; scopeId: string;
}>;
// A copied/parsed capability or server-provided object has no authority.
const issued = new WeakMap<RerankAdmission,()=>boolean>();

export function assertRerankAdmission(admission: RerankAdmission | undefined,
  config: ProviderConfig, scopeId?: string): asserts admission is RerankAdmission {
  const check = admission && issued.get(admission);
  if (!admission || !check) throw new ProviderFailure('NOT_READY');
  if (!check()) throw new ProviderFailure('CANCELLED');
  if (admission.profile.kind !== 'synthetic'
    || admission.profile.configDigest !== configDigest('reranking',config)
    || scopeId !== undefined && admission.scopeId !== scopeId) throw new ProviderFailure('DISCLOSURE_DENIED');
}

/** Trusted host-only fixture capability. No production settings/API/health response can issue one.
 * Actual execution remains blocked until independent runtime and operational evidence is implemented. */
export class RerankRuntimeProfiles {
  #active?: RerankAdmission;
  constructor(private readonly changed: () => void = ()=>{}) {}
  installSyntheticFixture(config: ProviderConfig, scopeId: string, fixtureId: string): RerankAdmission {
    if (!isDigest(scopeId)) return invalid();
    const profile = syntheticRuntimeProfile(config,fixtureId);
    const profileDigest = rerankProfileDigest(profile,config);
    const monotonic = performance.now(), boot = os.uptime(), expires = Date.now()+FIXTURE_PROFILE_TTL_MS;
    if (![monotonic,boot,expires].every(Number.isFinite)) throw new ProviderFailure('NOT_READY');
    const admission = Object.freeze({profile,profileDigest,scopeId,
      bindingDigest:hash(JSON.stringify([profileDigest,scopeId,randomUUID()]))});
    issued.set(admission,()=>{
      if (this.#active !== admission) return false;
      try {
        const now=performance.now(), uptime=os.uptime(), wall=Date.now();
        if (Number.isFinite(now) && now >= monotonic && now-monotonic < FIXTURE_PROFILE_TTL_MS
          && Number.isFinite(uptime) && uptime >= boot && uptime < boot+FIXTURE_PROFILE_TTL_MS/1000
          && Number.isFinite(wall) && wall < expires) return true;
      } catch { /* fail closed */ }
      this.revoke(); return false;
    });
    this.#active = admission;
    this.changed();
    return admission;
  }
  current(config: ProviderConfig, scopeId: string): RerankAdmission {
    const active=this.#active;
    try { assertRerankAdmission(active,config,scopeId); }
    catch (error) { this.revoke(); throw error; }
    return active;
  }
  checkLifetime(): void {
    if (this.#active) issued.get(this.#active)?.();
  }
  revoke(): void {
    if (!this.#active) return;
    this.#active=undefined;
    this.changed();
  }
}
