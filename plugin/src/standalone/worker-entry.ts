import { parseWithDigest } from './markdown-parse';
import { StandaloneError } from './shared';
// Browser Web Worker; this bundle must contain no Node import, no filesystem API,
// no network call and no dynamically generated document code.
const scope = self as unknown as {
  location: { origin: string };
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = event => {
  // Dedicated-worker MessagePort messages have an empty origin and null source.
  // Do not handle postMessage traffic from a foreign origin or source.
  if (event.source !== null || (event.origin !== '' && event.origin !== scope.location.origin)) return;
  const { data } = event;
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
