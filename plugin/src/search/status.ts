import type { AdvancedHealth } from '../advanced/health';
import type { IngestionStatus } from '../advanced/manager';
import type { EngineState } from '../standalone/engine';
import { isDigest } from '../standalone/contracts';

// Allowlist, never echo Error.message, arbitrary paths, or backend/document data.
const CODES = new Set(['INITIALIZATION_FAILED','SETTINGS_INVALID','UNSUPPORTED_FILESYSTEM','IO_FAILURE',
  'INDEX_UNAVAILABLE','INDEX_INCOMPATIBLE','INDEX_CORRUPT','INDEX_LIMIT','INDEX_PUBLICATION_UNCERTAIN',
  'INDEX_DURABILITY_UNCERTAIN','INDEX_GC_FAILED','INDEX_IO_ERROR','CACHE_PATH_INVALID','CACHE_PATH_REJECTED','CACHE_IDENTITY_INVALID',
  'VAULT_IDENTITY_CHANGED','SOURCE_REJECTED','SOURCE_CHANGED','SOURCE_LIMIT','SOURCE_STALE',
  'PARSER_FAILURE','PARSER_CLOSED','PARSER_TIMEOUT','PARSER_PROTOCOL_ERROR','PARSER_UNAVAILABLE','PARSER_ASSET_INVALID','PARSER_BUSY','PROPERTY_INCOMPATIBLE',
  'RECONCILING','COMMIT_FINALIZING','CANCELLED','CANCEL_DEFERRED','LIFECYCLE_INVALID','INVALID_REQUEST',
  'SCOPE_INVALID','SCOPE_EMPTY','SCOPE_CHANGED','SCOPE_UNSUPPORTED','CAPABILITY_UNAVAILABLE','EVIDENCE_INCOMPLETE','QUERY_INVALID','INVALID_UTF8','DISABLED','PAUSED',
  'SUPERSEDED','BUSY','TIMEOUT','NAVIGATION_REJECTED','API_VERSION_UNSUPPORTED','INTERNAL_FAILURE',
  'GRAPH_REQUEST_INVALID','GRAPH_SCOPE_UNSUPPORTED','GRAPH_DISABLED','GRAPH_UNAVAILABLE','GRAPH_BUSY',
  'GRAPH_CANCELLED','GRAPH_TIMEOUT','GRAPH_LIMIT','GRAPH_SOURCE_STALE','GRAPH_INDEX_UNAUTHENTICATED',
  'GRAPH_EVIDENCE_INVALID','GRAPH_EVIDENCE_MISSING','GRAPH_MAPPING_INVALID',
  'ADVANCED_CONFIG_INVALID','ADVANCED_RESOURCE_REFUSED','ADVANCED_UNAVAILABLE',
  'ADVANCED_PROTOCOL_INVALID','ADVANCED_TIMEOUT','ADVANCED_EXIT','ADVANCED_CANCELLED']);
export const safeCode = (value: unknown): string | null => value === null ? null
  : typeof value === 'string' && CODES.has(value) ? value : 'INTERNAL_FAILURE';
export type SearchStatus = EngineState & { enabled: boolean; paused: boolean; advancedTransport: AdvancedHealth;
  advancedIngestion: IngestionStatus;
  capabilityReadiness: { lexical: EngineState['status']; dense: 'unavailable'; hybrid: 'unavailable' } };
export function statusSnapshot(engine: EngineState | undefined, enabled: boolean, paused: boolean,
  error: string | null, advanced?: AdvancedHealth, ingestion?: IngestionStatus): SearchStatus {
  enabled = enabled === true; paused = paused === true;
  const state = engine ?? { status: error ? 'failed' : 'initializing', generationId: null,
    sources: 0, records: 0, busy: false, error, maintenanceWarning: null };
  const knownState = ['initializing','ready','degraded','failed','unavailable'].includes(state.status) ? state.status : 'failed';
  const status = !enabled ? 'unavailable' : paused && knownState === 'ready' ? 'degraded' : knownState;
  const count = (v: number): number => Number.isSafeInteger(v) && v >= 0 ? v : 0;
  return { status, generationId: isDigest(state.generationId) ? state.generationId : null,
    sources: count(state.sources), records: count(state.records), busy: state.busy === true,
    error: safeCode(error ?? (!enabled ? 'DISABLED' : state.error)), maintenanceWarning: safeCode(state.maintenanceWarning),
    enabled, paused, advancedTransport: advanced ?? {profile:'none',status:'disabled',error:null,transportOnly:true},
    advancedIngestion: ingestion ?? {status:'disabled',error:null,lastFormat:null,searchReady:false},
    capabilityReadiness: { lexical: status, dense: 'unavailable', hybrid: 'unavailable' } };
}
export function diagnostics(status: SearchStatus): string {
  // Reconstruct, rather than serialize a caller-owned object or engine state.
  return JSON.stringify({ apiVersion: 1, profile: 'standalone-markdown-lexical',
    ...statusSnapshot(status, status.enabled, status.paused, status.error, status.advancedTransport, status.advancedIngestion) }, null, 2);
}
