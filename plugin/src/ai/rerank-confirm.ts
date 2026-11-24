import { textElement } from '../search/render';
import type { RerankPreview } from '../search/controller';
import { servedAlias } from './loopback-rerank';

/** Explicit local confirmation. Never save the token, grant, query or excerpts. */
export function renderRerankConfirmation(panel: HTMLElement, preview: RerankPreview,
  submit: (classification: 'synthetic' | 'public', token: string) => void, cancel: () => void): void {
  panel.replaceChildren();
  const doc = panel.ownerDocument;
  const add = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string, cls?: string) => {
    const el = textElement(doc, tag, text, cls); panel.appendChild(el); return el;
  };
  add('h3','Confirm one local reranking request');
  add('p','Endpoint: '+preview.config.origin+'/v1/rerank | Model: '+servedAlias(preview.config));
  add('p','Only use a trusted local server under your control, with no forwarding to remote APIs. HTTP loopback pilot; no cloud. Do not approve confidential or unclassified material.');
  add('pre',preview.query,'oks-rerank-query-preview');
  for (const hit of preview.hits) add('pre',hit.originalExcerpt,'oks-rerank-excerpt-preview');
  const classification = add('select','','oks-rerank-classification');
  classification.setAttribute('aria-label','Classification of query and all excerpts');
  for (const [value,label] of ([['','Select classification'],['synthetic','Synthetic test data'],['public','Public data']] as const)) {
    const option = textElement(doc,'option',label); option.value=value!; classification.appendChild(option);
  }
  const token = add('input','','oks-rerank-token'); token.type='password'; token.autocomplete='off';
  token.setAttribute('aria-label','One-request local bearer token'); token.placeholder='Local bearer token (not saved)';
  const label=add('label',''); const check=doc.createElement('input');check.type='checkbox';check.className='oks-rerank-confirm-check';
  label.append(check,doc.createTextNode(' I authorize this exact query and excerpts to this local endpoint once, and confirm the selected classification.'));
  const button=add('button','Send once','oks-rerank-confirm');button.disabled=true;
  const update=()=>{button.disabled=!check.checked||!classification.value||!token.value;};
  check.onchange=update;classification.onchange=update;token.oninput=update;
  button.onclick=()=>{
    if(button.disabled||!check.checked||!token.value||!['synthetic','public'].includes(classification.value)) return;
    const secret=token.value;token.value='';button.disabled=true;
    panel.replaceChildren();submit(classification.value as 'synthetic'|'public',secret);
  };
  const close=add('button','Cancel confirmation','oks-rerank-close');
  close.onclick=()=>{token.value='';panel.replaceChildren();cancel();};
}
