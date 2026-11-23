/** Independent v4 model-envelope: v3 remains the canonical source/evidence model. */
import { canonicalFrame, decodeFrame } from './protocol';
export const MODEL_VERSION = 4 as const;
export const MAX_MODEL_REQUEST = 128 * 1024;
export const MAX_MODEL_RESPONSE = 8 * 1024 * 1024;
export const MAX_MODEL_BATCH = 64;
export const EMBEDDING_DIMENSION = 1024;
export const WEIGHTS_SHA256 = 'b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38';
export const TOKENIZER_SHA256 = '21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08';
/** v3 chunk fingerprint is over the complete tokenizer-only identity, not raw tokenizer SHA. */
export const CHUNK_TOKENIZER_FINGERPRINT = '62f6b846067271d99bd45da34c5a91ac9feb457453decafd398e09dd96069ef7';
export type ModelIdentity = {
  repository: string; revision: string; tokenizer_sha256: string; weights_sha256: string;
  dimension: number; serialization_version: string; normalization: string;
  torch_version: string; transformers_version: string; tokenizers_version: string;
  effective_max_tokens: number; runtime_tokenizer_parity_verified: boolean;
};
export type ModelRequest = { protocolVersion:4; requestId:string;operation:'embed';
  deadlineUnixMs:number;modelSnapshot:string;maxTokens:number;texts:string[] };
export type ModelReply = { protocolVersion:4;requestId:string;operation:'embed';
  status:'ok'|'failed';error:string|null; identity:ModelIdentity|null;
  vectors:number[][];diagnostics:string[] };
export class ModelError extends Error {
  constructor(readonly code:string){super(code);}
}
const exact=(o:object,keys:string[]):boolean =>
  Object.keys(o).length===keys.length && Object.keys(o).every(k=>keys.includes(k));
const record=(v:unknown):v is Record<string,unknown>=>
  typeof v==='object' && v!==null && !Array.isArray(v);
const safe=(v:unknown):v is number=>Number.isSafeInteger(v) && Number(v)>0;
export function modelRequest(v:ModelRequest):Buffer {
  if(!exact(v,['protocolVersion','requestId','operation','deadlineUnixMs','modelSnapshot','maxTokens','texts'])
      ||v.protocolVersion!==4||v.operation!=='embed'||!/^[a-f0-9]{48}$/.test(v.requestId)
      ||!safe(v.deadlineUnixMs)||!safe(v.maxTokens)||v.maxTokens<8||v.maxTokens>512
      ||typeof v.modelSnapshot!=='string'||!v.modelSnapshot.startsWith('/')
      ||v.modelSnapshot.split('/').slice(1).some(x=>!x||x==='.'||x==='..')
      ||v.modelSnapshot.includes('\\')||v.modelSnapshot.includes('\0')
      ||!Array.isArray(v.texts)||!v.texts.length||v.texts.length>MAX_MODEL_BATCH
      ||v.texts.some(t=>typeof t!=='string'||!t||t.includes('\0')||Buffer.byteLength(t)>8192))
    throw new ModelError('MODEL_PROTOCOL_INVALID');
  return canonicalFrame(v,MAX_MODEL_REQUEST);
}
export function verifyVector(v:unknown):asserts v is number[] {
  if(!Array.isArray(v)||v.length!==EMBEDDING_DIMENSION
      ||v.some(x=>typeof x!=='number'||!Number.isFinite(x)))
    throw new ModelError('VECTOR_INVALID');
  const norm=Math.hypot(...v);
  if(!Number.isFinite(norm)||Math.abs(norm-1)>1e-4)
    throw new ModelError('VECTOR_INVALID');
}
export function verifyIdentity(v:unknown):asserts v is ModelIdentity {
  const keys=['repository','revision','tokenizer_sha256','weights_sha256','dimension',
    'serialization_version','normalization','torch_version','transformers_version',
    'tokenizers_version','effective_max_tokens','runtime_tokenizer_parity_verified'];
  if(!record(v)||!exact(v,keys)||v.repository!=='BAAI/bge-m3'
      ||v.revision!=='5617a9f61b028005a4858fdac845db406aefb181'
      ||v.tokenizer_sha256!==TOKENIZER_SHA256||v.weights_sha256!==WEIGHTS_SHA256
      ||v.dimension!==EMBEDDING_DIMENSION||v.serialization_version!=='bge-m3-heading-lines-v1'
      ||v.normalization!=='l2-cls'||v.runtime_tokenizer_parity_verified!==true
      ||!Number.isInteger(v.effective_max_tokens)||Number(v.effective_max_tokens)<8
      ||Number(v.effective_max_tokens)>512
      ||v.torch_version!=='2.14.1+cpu'||v.transformers_version!=='5.18.0'
      ||v.tokenizers_version!=='0.23.3')
    throw new ModelError('MODEL_INCOMPATIBLE');
}
export function parseModelFrame(bytes:Buffer,request:ModelRequest):ModelReply {
  let v:unknown;
  try {v=decodeFrame(bytes,MAX_MODEL_RESPONSE);} catch {throw new ModelError('MODEL_PROTOCOL_INVALID');}
  if(!record(v)||!exact(v,['protocolVersion','requestId','operation','status','error','identity','vectors','diagnostics'])
     ||v.protocolVersion!==MODEL_VERSION||v.requestId!==request.requestId||v.operation!=='embed'
     ||!['ok','failed'].includes(String(v.status))||!Array.isArray(v.vectors)
     ||!Array.isArray(v.diagnostics)||v.diagnostics.length>16
     ||v.diagnostics.some(x=>typeof x!=='string'||x.length>128))
    throw new ModelError('MODEL_PROTOCOL_INVALID');
  if(v.status==='failed') {
    if(!/^[A-Z_]{3,48}$/.test(String(v.error))||v.vectors.length||v.identity!==null)
      throw new ModelError('MODEL_PROTOCOL_INVALID');
    return v as ModelReply;
  }
  if(v.error!==null||v.vectors.length!==request.texts.length)
    throw new ModelError('MODEL_PROTOCOL_INVALID');
  verifyIdentity(v.identity);
  if(v.identity.effective_max_tokens!==request.maxTokens)
    throw new ModelError('MODEL_INCOMPATIBLE');
  for(const vector of v.vectors)verifyVector(vector);
  return v as ModelReply;
}
