import { Worker } from 'node:worker_threads';
import type { WorkerPort } from '../../plugin/src/standalone/worker';

// Only Node test/benchmark adapter. Executes the exact bundled browser Worker
// script in an isolated worker_threads thread with browser-style message API.
// The real Obsidian desktop integration exercises its native Web Worker separately.
export function syntheticNodeWorkerPort(source: string): WorkerPort {
  const bootstrap = [
    "const {parentPort}=require('node:worker_threads');",
    "globalThis.self={location:{origin:''},onmessage:null,postMessage:(value)=>parentPort.postMessage(value)};",
    "parentPort.on('message',(data)=>globalThis.self.onmessage({data,origin:'',source:null}));",
  ].join('\n') + '\n' + source;
  const thread = new Worker(bootstrap, { eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
  let closing = false;
  return {
    send: value => thread.postMessage(value),
    stop: () => { closing = true; void thread.terminate(); },
    onMessage: handler => { thread.on('message', handler); },
    onError: handler => {
      thread.on('error', handler);
      thread.on('exit', code => { if (!closing && code !== 0) handler(); });
    },
  };
}
