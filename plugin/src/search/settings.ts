import { isAbsolute } from 'node:path';
import { BOUNDS, isRecord, StandaloneError } from '../standalone/contracts';
import { defaultProviderPreferences, parseProviderPreferences } from '../ai/config';
import type { ProviderPreferences } from '../ai/contracts';
import type { ProbeConfig } from '../controller';
import type { AdvancedConfig } from '../advanced/health';

export type IngestionConfig = {
  enabled: boolean; interpreter: string; entry: string; tokenizerSnapshot: string;
  tessdataPath: string; artifactsPath: string; pdfMode: 'text' | 'ocr' | 'structured' | 'structured-ocr';
};
export type SearchSettings = {
  version: 6; presentationMode: 'basic' | 'expert'; ai: ProviderPreferences; enabled: boolean; paused: boolean; topK: number; propertiesEnabled: boolean;
  advanced: AdvancedConfig; ingestion: IngestionConfig; probe: ProbeConfig;
};
export const defaultSettings = (): SearchSettings => ({
  version: 6, presentationMode: 'basic', ai: defaultProviderPreferences(), enabled: true, paused: false, topK: 10, propertiesEnabled: false,
  advanced: { enabled: false, profile: 'none', interpreter: '', entry: '' },
  ingestion: { enabled: false, interpreter: '', entry: '', tokenizerSnapshot: '',
    tessdataPath: '', artifactsPath: '', pdfMode: 'text' },
  probe: { fixtureMode: false, interpreter: '', entry: '' },
});
const keys = (v: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(v).every(k => allowed.includes(k));
function pathString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !value.includes('\0')
    && !value.includes('\\') && !value.includes('\n') && !value.includes('\r');
}
function probe(v: unknown): v is ProbeConfig {
  return isRecord(v) && keys(v, ['fixtureMode', 'interpreter', 'entry'])
    && typeof v.fixtureMode === 'boolean'
    && pathString(v.interpreter) && pathString(v.entry);
}
function advanced(v: unknown): v is AdvancedConfig {
  if (!isRecord(v) || !keys(v, ['enabled','profile','interpreter','entry'])
      || typeof v.enabled !== 'boolean' || !['none','local-stdio'].includes(String(v.profile))
      || !pathString(v.interpreter) || !pathString(v.entry)) return false;
  if (v.enabled && (v.profile !== 'local-stdio' || !isAbsolute(v.interpreter) || !isAbsolute(v.entry))) return false;
  return true;
}
function ingestion(v: unknown): v is IngestionConfig {
  if (!isRecord(v) || !keys(v, ['enabled','interpreter','entry','tokenizerSnapshot',
    'tessdataPath','artifactsPath','pdfMode'])
    || typeof v.enabled !== 'boolean'
    || !['text','ocr','structured','structured-ocr'].includes(String(v.pdfMode))
    || !['interpreter','entry','tokenizerSnapshot','tessdataPath','artifactsPath']
      .every(k=>pathString(v[k]))) return false;
  if (!v.enabled) return true;
  if (!['interpreter','entry','tokenizerSnapshot'].every(k=>isAbsolute(v[k] as string))
      || !String(v.entry).endsWith('/advanced_ingest.py')) return false;
  if ((v.pdfMode === 'ocr' || v.pdfMode === 'structured-ocr') && !isAbsolute(v.tessdataPath as string))
    return false;
  if ((v.pdfMode === 'structured' || v.pdfMode === 'structured-ocr') && !isAbsolute(v.artifactsPath as string))
    return false;
  return true;
}
/** Safe v1/v2/v3 migration. Historical settings can NEVER implicitly enable ingestion. */
export function parseSettings(v: unknown): SearchSettings {
  if (v === null || v === undefined) return defaultSettings();
  if (isRecord(v) && (v.version === undefined || v.version === 1)) {
    const { version: _version, ...old } = v;
    if (!probe(old)) throw new StandaloneError('SETTINGS_INVALID');
    return { ...defaultSettings(), probe: { ...old } };
  }
  if (!isRecord(v) || ![2,3,4,5,6].includes(v.version as number)
      || !keys(v, ['version','presentationMode','enabled','paused','topK','propertiesEnabled','advanced','ingestion','probe','ai'])
      || (v.version === 6 && !['basic','expert'].includes(String(v.presentationMode)))
      || (v.version !== 6 && v.presentationMode !== undefined)
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
  const ingest = (v.version as number) < 4 ? defaultSettings().ingestion : v.ingestion;
  if (!ingestion(ingest) || ((v.version as number) < 4 && v.ingestion !== undefined) || ((v.version as number) < 5 && v.ai !== undefined))
    throw new StandaloneError('SETTINGS_INVALID');
  return { version:6, presentationMode:v.version === 6 ? v.presentationMode as 'basic'|'expert' : 'basic',
    ai: (v.version as number) >= 5 ? parseProviderPreferences(v.ai) : defaultProviderPreferences(), enabled:v.enabled, paused:v.paused, topK:v.topK as number,
    propertiesEnabled:v.propertiesEnabled, advanced:active,
    ingestion: { ...ingest }, probe: { ...v.probe } };
}
