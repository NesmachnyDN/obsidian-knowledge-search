import { textElement } from '../search/render';
import { parseSearch } from '../search/controller';
import { BOUNDS, validPath, type SearchRequest } from '../standalone/contracts';
import { ProviderFailure, type ProviderPreference } from './contracts';
import type { DenseRequest } from './dense-host';
import type { DenseMachine } from './dense-machine';
import type { DenseUiController } from './dense-ui-controller';
import { pilotConfig } from './loopback-json';
import { servedAlias } from './loopback-rerank';
import { validateEmbeddingSpace } from './embedding-space';

/** Exact path selection, no implicit whole-Vault or model/dimension inference. */
export function denseUiRequest(kind:'rebuild'|'search', rawPaths:string, dimension:number,
  preference:ProviderPreference, mode:'dense'|'hybrid', search?:SearchRequest):DenseRequest {
  if(Buffer.byteLength(rawPaths)>16384)throw new ProviderFailure('LIMIT_EXCEEDED');
  const paths=rawPaths.split(/\r?\n/);
  if(!paths.length||paths.length>BOUNDS.sources||paths.some(p=>!validPath(p)||/[\r\n]/.test(p))
    ||new Set(paths).size!==paths.length)throw new ProviderFailure('CONFIG_INVALID');
  if(preference.state==='disabled')throw new ProviderFailure('DISABLED');
  if(preference.state!=='configured')throw new ProviderFailure('CONFIG_INVALID');
  const config=pilotConfig(preference);
  const space=validateEmbeddingSpace(config,{...config.identity,dimension,normalization:'unit-l2',
    serializationId:'utf8-verbatim-v1',queryInstructionId:'identity-v1',documentInstructionId:'identity-v1'});
  if(kind==='rebuild')return {kind,paths,space};
  if(!search||!search.query.trim()||!['dense','hybrid'].includes(mode)
    ||mode==='dense'&&search.matchMode==='literal')throw new ProviderFailure('CONFIG_INVALID');
  const request={...search,requestedMode:mode,scope:paths};
  parseSearch(request);
  return {kind,paths,space,request};
}

/** Separate, explicitly selected API search; the ordinary lexical submit stays unchanged. */
export function mountDensePanel(root:HTMLElement, controller:DenseUiController,
  preference:()=>ProviderPreference, search:()=>SearchRequest,machine?:DenseMachine):{dispose():void} {
  const owner=Symbol('dense-view'),doc=root.ownerDocument;
  let disposed=false;
  const panel=textElement(doc,'section','','oks-dense-panel');root.appendChild(panel);
  const add=<K extends keyof HTMLElementTagNameMap>(parent:HTMLElement,tag:K,text:string,cls?:string)=>{
    const el=textElement(doc,tag,text,cls);parent.appendChild(el);return el;
  };
  add(panel,'h3','Optional local API dense / hybrid search');
  add(panel,'p','Explicit selected-corpus pilot. Provider preferences are not readiness. No cloud; no automatic indexing. Ordinary Search remains offline lexical.');
  const paths=add(panel,'textarea','','oks-dense-paths');
  paths.setAttribute('aria-label','Exact Markdown corpus paths, one per line');paths.placeholder='Exact Markdown paths, one per line';
  const dimension=add(panel,'input','','oks-dense-dimension');dimension.type='number';dimension.min='1';dimension.max='4096';
  dimension.setAttribute('aria-label','Embedding vector dimension');dimension.placeholder='Declared vector dimension';
  const mode=add(panel,'select','','oks-dense-mode');mode.setAttribute('aria-label','API search mode');
  for(const [v,t] of [['','Select API search mode'],['dense','Dense (terms mode only)'],['hybrid','Hybrid (lexical + dense)']]){
    const opt=add(mode,'option',t!);opt.value=v!;
  }
  const message=add(panel,'p','','oks-dense-message');message.setAttribute('aria-live','polite');
  const previewArea=add(panel,'section','','oks-dense-preview');
  const rows=add(panel,'ol','','oks-dense-results');
  const clear=()=>{
    const token=previewArea.querySelector<HTMLInputElement>('input[type=password]');
    if(token)token.value='';
    previewArea.replaceChildren();rows.replaceChildren();
  };
  const cancel=()=>controller.cancel(owner);
  const error=(e:unknown)=>{if(!disposed)message.textContent='API dense: '+(e instanceof ProviderFailure?e.code:'CONFIG_INVALID');};
  const prepare=(kind:'rebuild'|'search')=>{
    machine?.invalidate();cancel();
    try{
      const request=denseUiRequest(kind,paths.value,Number(dimension.value),preference(),
        mode.value as 'dense'|'hybrid',kind==='search'?search():undefined);
      void controller.prepare(owner,request);
    }catch(e){error(e);}
  };
  add(panel,'button','Prepare explicit dense index rebuild','oks-dense-rebuild').onclick=()=>{if(!disposed)prepare('rebuild');};
  add(panel,'button','Prepare selected API search','oks-dense-prepare').onclick=()=>{if(!disposed)prepare('search');};
  const review=machine?add(panel,'button','Review pending machine API request','oks-dense-machine-review'):undefined;
  if(review)review.onclick=()=>{if(!disposed&&machine?.pending())void machine.review(owner);};
  add(panel,'button','Cancel API operation','oks-dense-cancel').onclick=()=>{if(!disposed){machine?.invalidate();cancel();}};
  paths.oninput=dimension.oninput=mode.onchange=()=>{if(!disposed)cancel();};
  const render=()=>{
    if(disposed)return;
    clear();
    const state=controller.snapshot(owner),machineOwned=machine?.owns(owner)??false;
    if(review)review.disabled=!machine?.pending();
    message.textContent='API dense: '+(state.phase==='error'?state.error:state.phase);
    if(state.phase==='idle')message.textContent=machine?.pending()?'Machine request pending human review; no data sent.':
      'API dense: not verified; configure local embedding provider and select corpus.';
    if(state.phase==='preview'){
      const p=state.preview;
      if(machineOwned)add(previewArea,'p','Machine-initiated request. Review the exact operation before authorizing; results are delivered only to its caller.');
      add(previewArea,'h4',p.operation.kind==='rebuild'?'Approve one index rebuild':'Approve one '+p.operation.request.requestedMode+' search');
      add(previewArea,'p','Endpoint: '+p.config.origin+'/v1/embeddings | Model: '+servedAlias(p.config));
      add(previewArea,'p','Only a trusted local server under your control, with no remote forwarding. Synthetic or public data only. Expires: '+new Date(p.expiresUnixMs).toISOString());
      add(previewArea,'pre',JSON.stringify(p.operation.space,null,2),'oks-dense-space-preview');
      add(previewArea,'pre',p.operation.paths.join('\n'),'oks-dense-path-preview');
      if(p.operation.kind==='search'){
        add(previewArea,'p','Only this exact query is sent; selected source evidence below stays local and is classified for this operation.');
        add(previewArea,'pre',p.operation.request.query,'oks-dense-query-preview');
        add(previewArea,'pre',JSON.stringify(p.operation.request,null,2),'oks-dense-request-preview');
      }else add(previewArea,'p','All original excerpts below are sent in bounded document batches.');
      add(previewArea,'pre',p.evidence.map(hit=>hit.sourceId+':'+hit.sourceLocators[0]?.lineStart+'\n'+hit.originalExcerpt).join('\n\n'),'oks-dense-excerpt-preview');
      const classification=add(previewArea,'select','','oks-dense-classification');
      classification.setAttribute('aria-label','Classification of query and all selected evidence');
      for(const [v,t] of [['','Select classification'],['synthetic','Synthetic test data'],['public','Public data']]){
        const opt=add(classification,'option',t!);opt.value=v!;
      }
      const token=add(previewArea,'input','','oks-dense-token');token.type='password';token.autocomplete='off';
      token.setAttribute('aria-label','One-operation local bearer token');
      const label=add(previewArea,'label','');const check=add(label,'input','','oks-dense-confirm-check');check.type='checkbox';
      label.append(doc.createTextNode(' I authorize this exact operation and confirm classification of the query and all selected evidence.'));
      const confirm=add(previewArea,'button','Send once','oks-dense-confirm');confirm.disabled=true;
      const update=()=>{confirm.disabled=!check.checked||!classification.value||!token.value;};
      check.onchange=classification.onchange=token.oninput=update;
      confirm.onclick=()=>{
        if(disposed||!previewArea.contains(confirm)||confirm.disabled||!check.checked||!token.value
          ||!['synthetic','public'].includes(classification.value))return;
        const secret=token.value;token.value='';confirm.disabled=true;
        void controller.confirm(owner,p.nonce,classification.value as 'synthetic'|'public',secret);
      };
    }else if(state.phase==='complete'){
      const result=state.result;
      if('hits' in result){
        message.textContent='API search: requested '+result.requestedMode+' | executed '+result.executedMode+
          ' | dense '+result.legs.dense.status+' ('+result.legs.dense.candidateCount+') | lexical '+
          result.legs.lexical.status+' ('+result.legs.lexical.candidateCount+') | '+(result.error??result.status);
        if(machineOwned){add(rows,'li','Machine result must be read via the freshness-checked machine API.');return;}
        result.hits.forEach((ranked,index)=>{
          const hit=ranked.evidence,row=add(rows,'li','');
          add(row,'pre',hit.originalExcerpt);
          add(row,'span','Rank '+ranked.rank+' | dense '+(ranked.denseSimilarity??'none')+
            ' | lexical '+(ranked.lexicalScore??'none')+' | RRF '+(ranked.rrfScore??'none'));
          const open=add(row,'button',hit.sourceId+':'+hit.sourceLocators[0]?.lineStart+' — verify and open','oks-dense-open');
          open.onclick=()=>{if(!disposed&&rows.contains(open))void controller.open(owner,index,hit);};
        });
      }else message.textContent='Dense index rebuild: '+(result.error??result.status)+' | vectors '+result.count+
        (result.status==='ok'?' | generation '+result.generationId+' (provider readiness not established)':'');
    }
  };
  const unsubscribe=machine?machine.subscribe(render):controller.subscribe(render);render();
  return {dispose(){disposed=true;unsubscribe();machine?.cancelView(owner);cancel();clear();panel.remove();}};
}
