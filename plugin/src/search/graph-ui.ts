import type { SearchController } from './controller';
import type { SearchSettings } from './settings';
import { StandaloneError, type SearchRequest } from '../standalone/contracts';
import { parseGraphQuery, type GraphQuery } from '../standalone/graph-expansion';
import type { LocalGraphResult, GraphExcerpt } from '../standalone/graph-retrieval';
import { configuredGraph } from './graph-settings';
import { textElement } from './render';

export function graphUiRequest(request:SearchRequest,depth:number,direction:string,relationId:string):GraphQuery {
  if(request.requestedMode!=='lexical'||request.scope!==undefined||request.range!==undefined)throw new StandaloneError('GRAPH_REQUEST_INVALID');
  const predicates=request.predicates??[];
  const scope=predicates.length||request.metadata
    ?{mode:'selected',kind:'properties',predicates,...(request.metadata?{metadata:request.metadata}:{})}
    :{mode:'vault-wide'};
  return parseGraphQuery({requestId:request.requestId,query:request.query,limit:request.limit,matchMode:request.matchMode,
    scope,expansion:{depth,direction,fanOut:16,maxExpanded:32,...(relationId?{relationIds:[relationId]}:{})}});
}
type Translate=(en:string,ru:string)=>string;

/** Presentation only; the controller retains exact-result navigation authority. */
export function mountGraphPanel(root:HTMLElement,controller:SearchController,settings:()=>SearchSettings,
  request:()=>SearchRequest,retry:()=>void,t:Translate):{refresh():void;dispose():void} {
  const doc=root.ownerDocument, panel=textElement(doc,'section','','oks-graph-panel');
  root.appendChild(panel);
  const add=<K extends keyof HTMLElementTagNameMap>(tag:K,text:string,cls?:string)=>{
    const el=textElement(doc,tag,text,cls);panel.appendChild(el);return el;
  };
  add('h3',t('Local graph search','Локальный графовый поиск'));
  const scope=add('p',t('Explicit graph expansion uses the current search filters; no AI or external requests.',
    'Явное расширение по графу учитывает текущие фильтры поиска; без ИИ и внешних запросов.'));
  scope.className='oks-graph-scope-note';
  const select=(label:string,cls:string,options:readonly [string,string][])=>{
    const el=add('select','',cls);el.setAttribute('aria-label',label);
    for(const [value,caption] of options){const o=textElement(doc,'option',caption);o.value=value;el.appendChild(o);}
    return el;
  };
  const depth=select(t('Graph depth','Глубина графа'),'oks-graph-depth',
    [['0',t('Depth 0 — no expansion','Глубина 0 — без расширения')],['1',t('Depth 1','Глубина 1')],['2',t('Depth 2','Глубина 2')]]);
  depth.value='1';
  const direction=select(t('Relation direction','Направление связей'),'oks-graph-direction',
    [['outgoing',t('Outgoing','Исходящие')],['incoming',t('Incoming','Входящие')],['both',t('Both directions','В обоих направлениях')]]);
  const relations=select(t('Relation type','Тип связи'),'oks-graph-relation',[]);
  const submit=add('button',t('Search graph','Искать по графу'),'oks-graph-submit');
  const cancel=add('button',t('Cancel graph search','Отменить графовый поиск'),'oks-graph-cancel');
  const retryButton=add('button',t('Retry text only','Повторить только текстовый поиск'),'oks-graph-retry');
  const message=add('p','','oks-graph-message');message.setAttribute('aria-live','polite');
  const rows=add('ol','','oks-graph-results');
  const owner={};
  let disposed=false,view:LocalGraphResult|undefined,sequence=0,running=false,configuration='';
  const clear=()=>{view=undefined;rows.replaceChildren();};
  const refresh=()=>{
    if(disposed)return;
    const mapping=configuredGraph(settings().graph);
    panel.hidden=!mapping||!settings().enabled;
    submit.disabled=panel.hidden||running||settings().paused;
    cancel.disabled=panel.hidden||(!running&&!view);
    const ids=JSON.stringify(mapping?.rules.map(r=>r.relationId)??[]);
    if(ids!==configuration){
      configuration=ids;relations.replaceChildren();
      const all=textElement(doc,'option',t('All configured relations','Все настроенные связи'));all.value='';relations.appendChild(all);
      for(const rule of mapping?.rules??[]){
        const option=textElement(doc,'option',rule.relationId);option.value=rule.relationId;relations.appendChild(option);
      }
    }
    if(view&&(panel.hidden||!controller.graphResultCurrent(view))){
      clear();message.textContent=t('Graph result retired; search again.','Графовый результат устарел; повторите поиск.');
    }
  };
  const invalidate=()=>{sequence++;running=false;clear();message.textContent='';controller.retireGraphPresentation(owner);refresh();};
  for(const el of [depth,direction,relations])el.onchange=invalidate;
  cancel.onclick=()=>{if(!disposed)invalidate();};
  retryButton.onclick=()=>{if(!disposed){invalidate();retry();}};
  const evidence=(row:HTMLElement,item:GraphExcerpt,result:LocalGraphResult,index:number,step?:number,anchor?:number)=>{
    row.appendChild(textElement(doc,'pre',item.excerpt));
    const open=textElement(doc,'button',item.sourceId+':'+item.locator.lineStart+' — '+t('verify and open','проверить и открыть'),
      step===undefined?'oks-graph-open':'oks-graph-open-anchor');
    open.onclick=()=>{if(disposed||view!==result||!controller.graphResultCurrent(result))return;
      void controller.openGraphEvidence(result,index,step,anchor).then(r=>{
        if(disposed||view!==result)return;
        if(!r.ok){clear();message.textContent=r.error;refresh();}
      });
    };row.appendChild(open);
  };
  const show=(result:LocalGraphResult)=>{
    if(disposed||!controller.graphResultCurrent(result))return;
    clear();view=result;
    message.textContent=t('Requested: graph; executed: graph. Scope: ','Запрошено: граф; выполнено: граф. Область: ')
      +(result.scope.selector.mode==='vault-wide'?t('whole catalog','весь каталог'):t('selected by filters','по фильтрам'))
      +'; '+t('lexical sources','лексические источники')+': '+result.lexicalCount+'; '
      +t('unique candidates','уникальные кандидаты')+': '+result.uniqueCandidateCount+'; '
      +t('omitted by Top-K','исключено Top-K')+': '+result.omittedByTopK;
    result.candidates.forEach((candidate,index)=>{
      const row=textElement(doc,'li','');
      row.appendChild(textElement(doc,'strong',candidate.kind==='lexical'
        ?t('Lexical seed, rank ','Лексический источник, ранг ')+candidate.lexicalRank
        :t('Expanded source; seed rank ','Расширенный источник; ранг исходного ')+candidate.seedLexicalRank));
      evidence(row,candidate,result,index);
      candidate.path.forEach((step,stepIndex)=>{
        const edge=step.edge;
        const label=edge.relationId+': '+edge.from+' → '+edge.to+' ('+step.traversal+') — '
          +t('authored relation, unverified','авторская связь, достоверность не подтверждена');
        const path=textElement(doc,'section','','oks-graph-path');
        path.appendChild(textElement(doc,'p',label));
        step.anchorEvidence.forEach((anchor,anchorIndex)=>evidence(path,anchor,result,index,stepIndex,anchorIndex));
        row.appendChild(path);
      });rows.appendChild(row);
    });
  };
  submit.onclick=()=>{if(disposed||running||panel.hidden)return;
    const owned=++sequence;clear();running=true;message.textContent=t('Verifying local sources…','Проверка локальных источников…');refresh();
    void (async()=>{
      try{
        const result=await controller.graphSearch(graphUiRequest(request(),Number(depth.value),direction.value,relations.value),owner);
        if(disposed||owned!==sequence)return;
        if(result.ok&&controller.graphResultCurrent(result.value))show(result.value);
        else message.textContent=result.ok?'SUPERSEDED':result.error;
      }catch{if(!disposed&&owned===sequence)message.textContent='GRAPH_REQUEST_INVALID';}
      finally{if(!disposed&&owned===sequence){running=false;refresh();}}
    })();
  };
  refresh();
  return {refresh,dispose:()=>{disposed=true;sequence++;clear();panel.remove();controller.retireGraphPresentation(owner);}};
}
