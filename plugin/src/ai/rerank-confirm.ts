import { textElement } from '../search/render';
import type { RerankPreview } from '../search/controller';
import { servedAlias } from './loopback-rerank';

/** Explicit local confirmation. Never save the token, grant, query or excerpts. */
export function renderRerankConfirmation(panel: HTMLElement, preview: RerankPreview,
  submit: (classification: 'synthetic' | 'public', token: string) => void, cancel: () => void): void {
  panel.replaceChildren();
  const generation=preview.role==='generation';
  const prefix=generation?'oks-generation':'oks-rerank';
  const doc = panel.ownerDocument;
  const add = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string, cls?: string) => {
    const el = textElement(doc, tag, text, cls); panel.appendChild(el); return el;
  };
  add('h3','Confirm one local '+(generation?'generation':'reranking')+' request');
  add('p','This preview expires after five minutes. Prepare a new preview if it expires.');
  add('p','Endpoint: '+preview.config.origin+(generation?'/v1/chat/completions':'/v1/rerank')+' | Model: '+servedAlias(preview.config));
  add('p','Only use a trusted local server under your control, with no forwarding to remote APIs. HTTP loopback pilot; no cloud. Do not approve confidential or unclassified material.');
  if(!generation) add('p','Synthetic fixture only; no actual model is verified. Runtime profile: '+preview.runtimeProfileDigest);
  if(generation) add('p','Model inferences are unverified; only literal quotations and citation references are checked.');
  add('pre',preview.query,prefix+'-query-preview');
  for (const hit of preview.hits) add('pre',hit.originalExcerpt,prefix+'-excerpt-preview');
  const classification = add('select','',prefix+'-classification');
  classification.setAttribute('aria-label','Classification of query and all excerpts');
  for (const [value,label] of ([['','Select classification'],['synthetic','Synthetic test data'],['public','Public data']] as const)) {
    if(!generation && value==='public') continue;
    const option = textElement(doc,'option',label); option.value=value!; classification.appendChild(option);
  }
  const token = generation?undefined:add('input','',prefix+'-token');
  if(token){token.type='password';token.autocomplete='off';token.setAttribute('aria-label','One-request local bearer token');token.placeholder='Local bearer token (not saved)';}
  const label=add('label',''); const check=doc.createElement('input');check.type='checkbox';check.className=prefix+'-confirm-check';
  label.append(check,doc.createTextNode(' I authorize this exact query and excerpts to this local endpoint once, and confirm the selected classification.'));
  const button=add('button','Send once',prefix+'-confirm');button.disabled=true;
  const update=()=>{button.disabled=!check.checked||!classification.value||(!generation&&!token?.value);};
  check.onchange=update;classification.onchange=update;if(token)token.oninput=update;
  button.onclick=()=>{
    if(!panel.contains(button)||button.disabled||!check.checked||(!generation&&!token?.value)||!['synthetic','public'].includes(classification.value)) return;
    const secret=token?.value??'';if(token)token.value='';button.disabled=true;
    panel.replaceChildren();submit(classification.value as 'synthetic'|'public',secret);
  };
  const close=add('button','Cancel confirmation',prefix+'-close');
  close.onclick=()=>{if(token)token.value='';panel.replaceChildren();cancel();};
}
