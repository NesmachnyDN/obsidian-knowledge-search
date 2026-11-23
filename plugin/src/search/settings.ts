import { BOUNDS, isRecord, StandaloneError } from '../standalone/contracts';
import type { ProbeConfig } from '../controller';

export type SearchSettings = {
  version: 2; enabled: boolean; paused: boolean; topK: number; propertiesEnabled: boolean;
  advanced: { enabled: false; profile: 'none' | 'local-stdio' };
  probe: ProbeConfig;
};
export const defaultSettings = (): SearchSettings => ({ version: 2, enabled: true, paused: false,
  topK: 10, propertiesEnabled: false, advanced: { enabled: false, profile: 'none' },
  probe: { fixtureMode: false, interpreter: '', entry: '' } });
const keys = (v: Record<string, unknown>, allowed: string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
function probe(v: unknown): v is ProbeConfig {
  return isRecord(v) && keys(v, ['fixtureMode', 'interpreter', 'entry'])
    && typeof v.fixtureMode === 'boolean'
    && typeof v.interpreter === 'string' && v.interpreter.length <= 4096 && !v.interpreter.includes('\0')
    && typeof v.entry === 'string' && v.entry.length <= 4096 && !v.entry.includes('\0');
}
/** Unknown versions never silently enable indexing or migrate arbitrary fields. */
export function parseSettings(v: unknown): SearchSettings {
  if (v === null || v === undefined) return defaultSettings();
  if (isRecord(v) && (v.version === undefined || v.version === 1)) {
    const { version: _version, ...old } = v;
    if (!probe(old)) throw new StandaloneError('SETTINGS_INVALID');
    return { ...defaultSettings(), probe: { ...old } };
  }
  if (!isRecord(v) || v.version !== 2 || !keys(v, ['version','enabled','paused','topK','propertiesEnabled','advanced','probe'])
    || typeof v.enabled !== 'boolean' || typeof v.paused !== 'boolean' || typeof v.propertiesEnabled !== 'boolean'
    || !Number.isInteger(v.topK) || Number(v.topK) < 1 || Number(v.topK) > BOUNDS.limit
    || !isRecord(v.advanced) || !keys(v.advanced, ['enabled','profile']) || v.advanced.enabled !== false
    || !['none','local-stdio'].includes(String(v.advanced.profile)) || !probe(v.probe))
    throw new StandaloneError('SETTINGS_INVALID');
  return { version: 2, enabled: v.enabled, paused: v.paused, topK: v.topK as number,
    propertiesEnabled: v.propertiesEnabled, advanced: { enabled: false, profile: v.advanced.profile as 'none' | 'local-stdio' },
    probe: { ...v.probe } };
}
