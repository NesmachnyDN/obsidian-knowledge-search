import { parseWithDigest } from './markdown-parse';
import { StandaloneError } from './shared';
// Browser Web Worker; this bundle must contain no Node import, no filesystem API,
// no network call and no dynamically generated document code.
const scope = self as unknown as {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = ({ data }) => {
  const message = data as Record<string, unknown> | null;
  const id = message && Number.isSafeInteger(message.id) ? message.id : null;
  try {
    if (!message || id === null || typeof message.path !== 'string'
      || typeof message.rootId !== 'string' || !/^[a-f0-9]{64}$/.test(String(message.sha))
      || !(message.bytes instanceof Uint8Array))
      throw new StandaloneError('PARSER_PROTOCOL_ERROR');
    const doc = parseWithDigest(message.path, message.bytes, message.rootId, message.sha as string);
    scope.postMessage({ id, doc });
  } catch (error) {
    scope.postMessage({ id, error: error instanceof StandaloneError ? error.code : 'PARSER_FAILURE' });
  }
};
