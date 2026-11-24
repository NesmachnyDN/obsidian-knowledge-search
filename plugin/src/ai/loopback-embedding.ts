import { isRecord } from '../standalone/contracts';
import { ProviderFailure,type ProviderConfig,type EmbeddingSpace,type CallContext,type AuthorizedCandidates } from './contracts';
import { LoopbackJsonTransport,pilotConfig,servedAlias,checkedCandidates } from './loopback-json';
import { validateEmbeddingSpace,checkedVector,embeddingSpaceId } from './embedding-space';
export type EmbeddingPurpose='query'|'document';
export type EmbeddingBatch={spaceId:string;purpose:EmbeddingPurpose;vectors:number[][]};
export const MAX_EMBEDDING_BATCH=8;
export class LoopbackEmbeddingTransport {
  private readonly transport=new LoopbackJsonTransport();
  async embed(value:ProviderConfig,declared:EmbeddingSpace,purpose:EmbeddingPurpose,input:AuthorizedCandidates,
    token:string,context:CallContext):Promise<EmbeddingBatch> {
    const config=pilotConfig(value),space=validateEmbeddingSpace(config,declared);
    if(purpose!=='query'&&purpose!=='document')throw new ProviderFailure('CONFIG_INVALID');
    let texts:string[];
    if(purpose==='query'){
      if(input.passages.length!==0||typeof input.query!=='string'||!input.query.trim()
        ||input.query.includes('\0')||Buffer.from(input.query,'utf8').toString('utf8')!==input.query
        ||Buffer.byteLength(input.query)>config.limits.maxInputBytes)throw new ProviderFailure('LIMIT_EXCEEDED');
      texts=[input.query];
    }else{
      if(input.passages.length>MAX_EMBEDDING_BATCH)throw new ProviderFailure('LIMIT_EXCEEDED');
      texts=checkedCandidates(config,input);
    }
    const model=servedAlias(config);
    const reply=await this.transport.send(config,'/v1/embeddings',{model,input:texts,encoding_format:'float'},token,context);
    if(!isRecord(reply)||typeof reply.model!=='string')throw new ProviderFailure('INVALID_RESPONSE');
    if(reply.model!==model)throw new ProviderFailure('MODEL_MISMATCH');
    if(!Array.isArray(reply.data)||reply.data.length!==texts.length)throw new ProviderFailure('INVALID_RESPONSE');
    const vectors=new Map<number,number[]>();
    for(const item of reply.data){
      if(!isRecord(item)||item.object!=='embedding'||typeof item.index!=='number'||!Number.isSafeInteger(item.index)
        ||item.index<0||item.index>=texts.length||vectors.has(item.index))throw new ProviderFailure('INVALID_RESPONSE');
      vectors.set(item.index,checkedVector(item.embedding,space));
    }
    return {spaceId:embeddingSpaceId(config,space),purpose,vectors:texts.map((_,i)=>vectors.get(i)!)};
  }
}
