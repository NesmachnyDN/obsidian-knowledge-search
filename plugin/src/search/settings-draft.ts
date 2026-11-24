import { isAbsolute } from 'node:path';
import { BOUNDS } from '../standalone/contracts';
import { parsePreference } from '../ai/config';
import type { ProviderConfig, ProviderPreference } from '../ai/contracts';
import type { AdvancedConfig } from '../advanced/health';
import type { ProbeConfig } from '../controller';
import type { IngestionConfig } from './settings';

export type DraftResult<T> = { ok: true; value: T } | { ok: false; field: string; message: string };
const fail = (field: string, message: string): DraftResult<never> => ({ ok: false, field, message });
const pathText = (value: string): boolean => value.length <= 4096 &&
  !/[\x00\\\r\n]/.test(value);
const absolute = (value: string): boolean => pathText(value) && isAbsolute(value);

export function topKDraft(input: string): DraftResult<number> {
  if (!/^[1-9]\d*$/.test(input) || Number(input) > BOUNDS.limit)
    return fail('topK', `Enter a whole number from 1 to ${BOUNDS.limit}.`);
  return { ok: true, value: Number(input) };
}

export function advancedDraft(input: AdvancedConfig): DraftResult<AdvancedConfig> {
  if (!pathText(input.interpreter) || !pathText(input.entry))
    return fail('advanced.path', 'Path contains unsupported characters or exceeds 4096 characters.');
  if (input.enabled && input.profile !== 'local-stdio')
    return fail('advanced.profile', 'Choose the trusted local stdio profile.');
  if (input.enabled && !absolute(input.interpreter))
    return fail('advanced.interpreter', 'Enter an absolute trusted Python executable path.');
  if (input.enabled && !absolute(input.entry))
    return fail('advanced.entry', 'Enter an absolute trusted health entry path.');
  return { ok: true, value: { ...input } };
}

export function ingestionDraft(input: IngestionConfig): DraftResult<IngestionConfig> {
  for (const key of ['interpreter', 'entry', 'tokenizerSnapshot', 'tessdataPath', 'artifactsPath'] as const)
    if (!pathText(input[key]))
      return fail('ingestion.' + key, 'Path contains unsupported characters or exceeds 4096 characters.');
  if (input.enabled) {
    for (const key of ['interpreter', 'entry', 'tokenizerSnapshot'] as const)
      if (!absolute(input[key])) return fail('ingestion.' + key, 'Enter an absolute trusted local path.');
    if (!input.entry.endsWith('/advanced_ingest.py'))
      return fail('ingestion.entry', 'The entry must end in /advanced_ingest.py.');
    if (needsOcr(input.pdfMode) && !absolute(input.tessdataPath))
      return fail('ingestion.tessdataPath', 'OCR requires an absolute tessdata directory.');
    if (needsStructure(input.pdfMode) && !absolute(input.artifactsPath))
      return fail('ingestion.artifactsPath', 'Structured extraction requires an absolute artifacts directory.');
  }
  return { ok: true, value: { ...input } };
}

export const needsOcr = (mode: IngestionConfig['pdfMode']): boolean =>
  mode === 'ocr' || mode === 'structured-ocr';
export const needsStructure = (mode: IngestionConfig['pdfMode']): boolean =>
  mode === 'structured' || mode === 'structured-ocr';

export function probeDraft(input: ProbeConfig): DraftResult<ProbeConfig> {
  if (!pathText(input.interpreter) || !pathText(input.entry))
    return fail('probe.path', 'Invalid or oversized path.');
  if (input.fixtureMode && (!absolute(input.interpreter) || !absolute(input.entry)))
    return fail('probe.path', 'A synthetic probe requires trusted absolute paths.');
  return { ok: true, value: { ...input } };
}

export type ProviderDraft = {
  transport: 'local' | 'cloud'; origin: string; model: string; revision: string;
  timeoutMs: string; maxInputBytes: string; maxCandidates: string; maxOutputTokens: string;
};
export function newProviderDraft(pref: ProviderPreference): ProviderDraft {
  const configured = pref.state === 'configured' ? pref : undefined;
  return {
    transport: configured?.transport ?? 'local', origin: configured?.origin ?? '',
    model: configured?.identity.model ?? '', revision: configured?.identity.revision ?? '',
    timeoutMs: String(configured?.limits.timeoutMs ?? 10000),
    maxInputBytes: String(configured?.limits.maxInputBytes ?? 16384),
    maxCandidates: String(configured?.limits.maxCandidates ?? 20),
    maxOutputTokens: String(configured?.limits.maxOutputTokens ?? 1024),
  };
}
export function providerDraft(input: ProviderDraft): DraftResult<ProviderConfig> {
  for (const key of ['timeoutMs', 'maxInputBytes', 'maxCandidates', 'maxOutputTokens'] as const)
    if (!/^[1-9]\d*$/.test(input[key]))
      return fail(key, 'Enter a positive whole number.');
  const candidate = parsePreference({
    state: 'configured', transport: input.transport, origin: input.origin,
    identity: { model: input.model, revision: input.revision },
    limits: {
      timeoutMs: Number(input.timeoutMs), maxInputBytes: Number(input.maxInputBytes),
      maxCandidates: Number(input.maxCandidates), maxOutputTokens: Number(input.maxOutputTokens),
      maxConcurrent: 1,
    },
  });
  if (candidate.state !== 'configured')
    return fail('provider', 'Use a canonical loopback origin or approved HTTPS origin, model/revision IDs, and bounded limits.');
  return { ok: true, value: candidate };
}
export function embeddingSpaceChanged(previous: ProviderPreference, next: ProviderConfig): boolean {
  return previous.state === 'configured' && (previous.origin !== next.origin ||
    previous.transport !== next.transport || previous.identity.model !== next.identity.model ||
    previous.identity.revision !== next.identity.revision);
}
