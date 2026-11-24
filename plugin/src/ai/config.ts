import { isRecord } from '../standalone/contracts';
import { AI_CONTRACT_VERSION, AI_ROLES, type AiRole, type ProviderConfig,
  type ProviderPreference, type ProviderPreferences, type ProviderStatus } from './contracts';

const exact = (v: Record<string, unknown>, fields: readonly string[]): boolean =>
  Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v);
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

export function validOrigin(value: unknown, transport: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256 || !/^[\x21-\x7e]+$/.test(value)) return false;
  try {
    const u = new URL(value);
    // Origin-only, canonical, no credentials, query, path, fragments, or URL aliases.
    if (value !== u.origin || u.username || u.password) return false;
    if (transport === 'local')
      return (u.protocol === 'http:' || u.protocol === 'https:')
        && (u.hostname === '127.0.0.1' || u.hostname === '[::1]') && !!u.port;
    return transport === 'cloud' && u.protocol === 'https:' && !u.port
      && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(u.hostname)
      && !/\.(?:localhost|local|internal|test|invalid)$/.test(u.hostname);
  } catch { return false; }
}

export function defaultProviderPreferences(): ProviderPreferences {
  return { embedding: { state: 'disabled' }, reranking: { state: 'disabled' }, generation: { state: 'disabled' } };
}
export function parsePreference(v: unknown): ProviderPreference {
  if (!isRecord(v)) return { state: 'invalid' };
  if (exact(v, ['state']) && (v.state === 'disabled' || v.state === 'invalid')) return { state: v.state };
  if (!exact(v, ['state','transport','origin','identity','limits']) || v.state !== 'configured'
    || !validOrigin(v.origin, v.transport) || !isRecord(v.identity) || !isRecord(v.limits)
    || !exact(v.identity, ['model','revision']) || !identifier(v.identity.model) || !identifier(v.identity.revision)
    || !exact(v.limits, ['timeoutMs','maxInputBytes','maxCandidates','maxOutputTokens','maxConcurrent'])
    || !integer(v.limits.timeoutMs, 100, 30000) || !integer(v.limits.maxInputBytes, 1, 65536)
    || !integer(v.limits.maxCandidates, 1, 50) || !integer(v.limits.maxOutputTokens, 1, 4096)
    || v.limits.maxConcurrent !== 1) return { state: 'invalid' };
  return { state: 'configured', transport: v.transport as ProviderConfig['transport'], origin: v.origin,
    identity: { model: v.identity.model, revision: v.identity.revision },
    limits: { timeoutMs: v.limits.timeoutMs, maxInputBytes: v.limits.maxInputBytes,
      maxCandidates: v.limits.maxCandidates, maxOutputTokens: v.limits.maxOutputTokens, maxConcurrent: 1 } };
}
export function parseProviderPreferences(v: unknown): ProviderPreferences {
  const result = defaultProviderPreferences();
  for (const role of AI_ROLES) result[role] = isRecord(v) && Object.hasOwn(v, role)
    ? parsePreference(v[role]) : { state: 'invalid' };
  return result;
}
export function preferenceStatus(role: AiRole, pref: ProviderPreference): ProviderStatus {
  return { version: AI_CONTRACT_VERSION, role, state: pref.state === 'disabled' ? 'disabled' : 'unavailable',
    error: pref.state === 'invalid' ? 'CONFIG_INVALID' : pref.state === 'configured' ? 'NOT_READY' : null };
}
