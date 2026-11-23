import { isAbsolute } from 'node:path';
import { BOUNDS, isRecord, StandaloneError } from '../standalone/contracts';
import type { ProbeConfig } from '../controller';
import type { AdvancedConfig } from '../advanced/health';

export type SearchSettings = {
  version: 3; enabled: boolean; paused: boolean; topK: number; propertiesEnabled: boolean;
  advanced: AdvancedConfig;
  probe: ProbeConfig;
};
export const defaultSettings = (): SearchSettings => ({ version: 3, enabled: true, paused: false,
  topK: 10, propertiesEnabled: false,
  advanced: { enabled: false, profile: 'none', interpreter: '', entry: '' },
  probe: { fixtureMode: false, interpreter: '', entry: '' } });
const keys = (v: Record<string, unknown>, allowed: string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
function probe(v: unknown): v is ProbeConfig {
  return isRecord(v) && keys(v, ['fixtureMode', 'interpreter', 'entry'])
    && typeof v.fixtureMode === 'boolean'
    && typeof v.interpreter === 'string' && v.interpreter.length <= 4096 && !v.interpreter.includes('\0')
    && typeof v.entry === 'string' && v.entry.length <= 4096 && !v.entry.includes('\0');
}
function advanced(v: unknown): v is AdvancedConfig {
  if (!isRecord(v) || !keys(v, ['enabled','profile','interpreter','entry'])
      || typeof v.enabled !== 'boolean' || !['none','local-stdio'].includes(String(v.profile))
      || typeof v.interpreter !== 'string' || typeof v.entry !== 'string'
      || v.interpreter.length > 4096 || v.entry.length > 4096
      || v.interpreter.includes('\0') || v.entry.includes('\0')) return false;
  if (v.enabled && (v.profile !== 'local-stdio' || !isAbsolute(v.interpreter) || !isAbsolute(v.entry))) return false;
  return true;
}
/** Old v1 probe and v2 Standalone settings are migrated with advanced disabled. */
export function parseSettings(v: unknown): SearchSettings {
  if (v === null || v === undefined) return defaultSettings();
  if (isRecord(v) && (v.version === undefined || v.version === 1)) {
    const { version: _version, ...old } = v;
    if (!probe(old)) throw new StandaloneError('SETTINGS_INVALID');
    return { ...defaultSettings(), probe: { ...old } };
  }
  if (!isRecord(v) || ![2,3].includes(v.version as number)
      || !keys(v, ['version','enabled','paused','topK','propertiesEnabled','advanced','probe'])
      || typeof v.enabled !== 'boolean' || typeof v.paused !== 'boolean' || typeof v.propertiesEnabled !== 'boolean'
      || !Number.isInteger(v.topK) || Number(v.topK) < 1 || Number(v.topK) > BOUNDS.limit || !probe(v.probe))
    throw new StandaloneError('SETTINGS_INVALID');
  let active: AdvancedConfig;
  if (v.version === 2) {
    if (!isRecord(v.advanced) || !keys(v.advanced,['enabled','profile']) || v.advanced.enabled !== false
      || !['none','local-stdio'].includes(String(v.advanced.profile))) throw new StandaloneError('SETTINGS_INVALID');
    active = { enabled:false, profile:v.advanced.profile as AdvancedConfig['profile'], interpreter:'', entry:'' };
  } else {
    if (!advanced(v.advanced)) throw new StandaloneError('SETTINGS_INVALID');
    active = { enabled:v.advanced.enabled, profile:v.advanced.profile,
      interpreter:v.advanced.interpreter, entry:v.advanced.entry };
  }
  return { version:3, enabled:v.enabled, paused:v.paused, topK:v.topK as number,
    propertiesEnabled:v.propertiesEnabled, advanced:active, probe: { ...v.probe } };
}
