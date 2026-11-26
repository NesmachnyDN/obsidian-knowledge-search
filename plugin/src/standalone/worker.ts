import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { BOUNDS, StandaloneError, hash, validPath, isDigest, validProperty, type SourceVersion } from './contracts';
import type { PolicyMetadataProof } from './shared';

export interface PolicyMetadataParser {
  policyMetadata(path:string,bytes:Uint8Array,rootId:string):Promise<PolicyMetadataProof>;
}
export interface MarkdownParser {
  parse(path: string, bytes: Uint8Array, rootId: string): Promise<SourceVersion>;
  close(): Promise<void>;
}
// Structural boundary for deterministic Node test adaptation; production uses
// a real renderer Web Worker (Blob URL), never Node worker_threads or an inline fallback.
export interface WorkerPort {
  send(value: unknown): void;
  stop(): void;
  onMessage(handler: (value: unknown) => void): void;
  onError(handler: () => void): void;
}
function browserWorker(source: string): WorkerPort {
  if (typeof Worker !== 'function' || typeof Blob !== 'function'
      || typeof URL.createObjectURL !== 'function') throw new StandaloneError('PARSER_UNAVAILABLE');
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  let worker: Worker;
  try { worker = new Worker(blobUrl, { name: 'oks-markdown-parser' }); }
  catch { URL.revokeObjectURL(blobUrl); throw new StandaloneError('PARSER_UNAVAILABLE'); }
  return {
    send: value => worker.postMessage(value),
    stop: () => { worker.terminate(); URL.revokeObjectURL(blobUrl); },
    onMessage: handler => { worker.onmessage = event => handler(event.data); },
    onError: handler => { worker.onerror = handler; worker.onmessageerror = handler; },
  };
}
export class WorkerMarkdownParser implements MarkdownParser, PolicyMetadataParser {
  private port: WorkerPort;
  private pending: ({ id:number; kind:'document'; resolve:(doc:SourceVersion)=>void; reject:(e:Error)=>void }
    | {id:number;kind:'policy';resolve:(proof:PolicyMetadataProof)=>void;reject:(e:Error)=>void}) | null = null;
  private deadline: NodeJS.Timeout | null = null;
  private stopped = false;
  private failure: string | null = null;
  private sequence = 0;
  constructor(path: string, factory: (code: string) => WorkerPort = browserWorker) {
    // Read only the reviewed JS bundled beside the plugin; no model/runtime download.
    let code: string;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 128 * 1024)
        throw new StandaloneError('PARSER_ASSET_INVALID');
      const bytes = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const n = readSync(descriptor, bytes, count, bytes.length - count, count);
        if (!n) break;
        count += n;
      }
      const after = fstatSync(descriptor);
      if (count !== info.size || after.size !== info.size || after.dev !== info.dev
          || after.ino !== info.ino || after.mtimeMs !== info.mtimeMs
          || after.ctimeMs !== info.ctimeMs)
        throw new StandaloneError('PARSER_ASSET_INVALID');
      code = bytes.subarray(0, count).toString('utf8');
      if (!code) throw new StandaloneError('PARSER_ASSET_INVALID');
    } catch { throw new StandaloneError('PARSER_ASSET_INVALID'); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
    this.port = factory(code);
    this.port.onMessage(value => this.receive(value));
    this.port.onError(() => this.fail('PARSER_FAILURE'));
  }
  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }
  private fail(code: string): void {
    if (this.stopped || this.failure) return;
    this.failure = code;
    const pending = this.pending;
    this.pending = null;
    this.clearDeadline();
    if (pending) pending.reject(new StandaloneError(code));
    this.port.stop();
  }
  private receive(value: unknown): void {
    const waiting = this.pending;
    if (!waiting) { this.fail('PARSER_PROTOCOL_ERROR'); return; }
    this.pending = null;
    this.clearDeadline();
    if (!value || typeof value !== 'object') {
      waiting.reject(new StandaloneError('PARSER_PROTOCOL_ERROR'));
      this.fail('PARSER_PROTOCOL_ERROR'); return;
    }
    const message = value as { id?: number; doc?: SourceVersion; proof?:PolicyMetadataProof; error?: string };
    if (message.id !== waiting.id) {
      waiting.reject(new StandaloneError('PARSER_PROTOCOL_ERROR'));
      this.fail('PARSER_PROTOCOL_ERROR');
    } else if (typeof message.error === 'string') {
      waiting.reject(new StandaloneError(message.error));
    } else if(waiting.kind==='policy') {
      if(!message.proof||!['absent','external','private','invalid','unresolved'].includes(message.proof.state)
        || !Array.isArray(message.proof.properties) || message.proof.properties.length>BOUNDS.propertiesPerSource
        || !message.proof.properties.every(property=>validProperty(property))
        || new Set(message.proof.properties.map(property=>property.key)).size!==message.proof.properties.length
        || !this.consistentPolicyProof(message.proof)) {
        waiting.reject(new StandaloneError('PARSER_PROTOCOL_ERROR'));this.fail('PARSER_PROTOCOL_ERROR');
      } else waiting.resolve(message.proof);
    } else if (!message.doc || !Array.isArray(message.doc.blocks)) {
      waiting.reject(new StandaloneError('PARSER_PROTOCOL_ERROR'));
      this.fail('PARSER_PROTOCOL_ERROR');
    } else waiting.resolve(message.doc);
  }
  private consistentPolicyProof(proof:PolicyMetadataProof):boolean {
    if(proof.state==='unresolved')return proof.properties.length===0;
    const marker=proof.properties.find(p=>p.key==='llm_processing');
    const state=!marker?'absent':marker.valueType==='string'&&marker.value==='external'?'external':
      marker.valueType==='string'&&marker.value==='private'?'private':'invalid';
    return state===proof.state;
  }
  async parse(path: string, bytes: Uint8Array, rootId: string): Promise<SourceVersion> {
    if (this.stopped) throw new StandaloneError('PARSER_CLOSED');
    if (this.failure) throw new StandaloneError(this.failure);
    if (this.pending) throw new StandaloneError('PARSER_BUSY');
    if (!validPath(path) || bytes.byteLength > BOUNDS.fileBytes)
      throw new StandaloneError('SOURCE_LIMIT');
    const sha = hash(bytes);
    const id = ++this.sequence;
    const doc = await new Promise<SourceVersion>((resolve, reject) => {
      this.pending = { id, kind:'document', resolve, reject };
      this.deadline = setTimeout(() => this.fail('PARSER_TIMEOUT'), 5000);
      try { this.port.send({ id, path, rootId, sha, bytes }); }
      catch { this.fail('PARSER_PROTOCOL_ERROR'); }
    });
    if (doc.sha256 !== sha || doc.sourceId !== path || doc.scopeId !== rootId
      || doc.blocks.length > BOUNDS.blocksPerSource
      || !Array.isArray(doc.properties) || doc.properties.length > BOUNDS.propertiesPerSource
      || !Array.isArray(doc.wikiLinks) || doc.wikiLinks.length > BOUNDS.wikiLinksPerSource)
      throw new StandaloneError('PARSER_PROTOCOL_ERROR');
    for (const block of doc.blocks) {
      const loc = block.locator;
      block.blockId = hash(JSON.stringify([path, sha, block.order, loc.byteStart, loc.byteEnd]));
    }
    return doc;
  }
  async policyMetadata(path:string,bytes:Uint8Array,rootId:string):Promise<PolicyMetadataProof> {
    if(this.stopped)throw new StandaloneError('PARSER_CLOSED');
    if(this.failure)throw new StandaloneError(this.failure);
    if(this.pending)throw new StandaloneError('PARSER_BUSY');
    if(!validPath(path)||!isDigest(rootId)||bytes.byteLength>BOUNDS.fileBytes)throw new StandaloneError('SOURCE_LIMIT');
    const sha=hash(bytes),id=++this.sequence;
    const proof=await new Promise<PolicyMetadataProof>((resolve,reject)=>{
      this.pending={id,kind:'policy',resolve,reject};
      this.deadline=setTimeout(()=>this.fail('PARSER_TIMEOUT'),5000);
      try{this.port.send({id,kind:'policy-metadata',path,rootId,sha,bytes});}
      catch{this.fail('PARSER_PROTOCOL_ERROR');}
    });
    if(proof.sha256!==sha||proof.sourceId!==path||proof.scopeId!==rootId){
      this.fail('PARSER_PROTOCOL_ERROR');throw new StandaloneError('PARSER_PROTOCOL_ERROR');
    }
    return Object.freeze({sourceId:path,sha256:sha,scopeId:rootId,state:proof.state,
      properties:Object.freeze(proof.properties.map(property=>Object.freeze({key:property.key,valueType:property.valueType,
        value:Array.isArray(property.value)?Object.freeze([...property.value]):property.value}))) });
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const pending = this.pending;
    this.pending = null;
    this.clearDeadline();
    if (pending) pending.reject(new StandaloneError('PARSER_CLOSED'));
    this.port.stop();
  }
}
