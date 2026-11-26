import { getLanguage, ItemView, type WorkspaceLeaf } from 'obsidian';
import { ProviderFailure } from '../ai/contracts';
import { StandaloneError } from '../standalone/contracts';
import type { ScopeSelector } from '../standalone/chat-scope';
import { NativeChatStateMachine } from './chat-native-state';
import { appliedChatScope, manualChatScope } from './chat-native-scope';
import { uiRequest, type CompletedChatTurn, type RetainedChatSessionOwner, type RetainedChatTurnOwner,
  type RetainedChatClassificationDraft, type SearchController } from './controller';
import { settingsLocale } from './settings-i18n';
import type { SearchSettings } from './settings';
import { textElement } from './render';

export const CHAT_VIEW='oks-native-chat';
type Translate=(en:string,ru:string)=>string;
const code=(error:unknown):string=>error instanceof ProviderFailure||error instanceof StandaloneError?error.code:'NOT_READY';

export class ChatView extends ItemView {
  private readonly state=new NativeChatStateMachine();
  private session?:RetainedChatSessionOwner;
  private owner?:RetainedChatTurnOwner;
  private history:readonly CompletedChatTurn[]=[];
  private unsubscribe?:()=>void;
  private timer?:ReturnType<typeof setTimeout>;
  private disposed=true;
  private sessionRead=false;
  private revision=0;
  private generationId:string|null=null;
  private configKey='';
  private settingsKey='';
  private phase:'idle'|'working'|'retrieved'|'classifying'|'preview'='idle';
  private t:Translate=(en,ru)=>settingsLocale(getLanguage())==='ru'?ru:en;
  private scopeLabel?:HTMLElement;
  private message?:HTMLElement;
  private work?:HTMLElement;
  private transcript?:HTMLElement;
  private question?:HTMLTextAreaElement;
  private topK?:HTMLInputElement;
  private match?:HTMLSelectElement;
  private send?:HTMLButtonElement;
  constructor(leaf:WorkspaceLeaf,private readonly controller:SearchController,
    private readonly settings:()=>SearchSettings,private readonly openSettings:()=>void){super(leaf);}
  getViewType():string{return CHAT_VIEW;}
  getDisplayText():string{return this.t('OKS Chat','Чат OKS');}
  getIcon():string{return 'messages-square';}
  private add<K extends keyof HTMLElementTagNameMap>(parent:HTMLElement,tag:K,text='',cls?:string):HTMLElementTagNameMap[K] {
    const el=textElement(parent.ownerDocument,tag,text,cls);parent.appendChild(el);return el;
  }
  private button(parent:HTMLElement,text:string,action:()=>void,guard?:()=>boolean):HTMLButtonElement {
    const el=this.add(parent,'button',text);
    el.onclick=()=>{if(!this.disposed&&this.contentEl.contains(el)&&(!guard||guard()))action();};return el;
  }
  private select(parent:HTMLElement,label:string,options:readonly (readonly [string,string])[]):HTMLSelectElement {
    const select=this.add(parent,'select');select.setAttribute('aria-label',label);
    for(const [value,text] of options){const option=this.add(select,'option',text);option.value=value;}
    return select;
  }
  private input(parent:HTMLElement,label:string,type='text'):HTMLInputElement {
    const input=this.add(parent,'input');input.type=type;input.placeholder=label;input.setAttribute('aria-label',label);return input;
  }
  private tell(text:string):void{if(this.message)this.message.textContent=text;}
  private clearWork():void {
    if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;
    for(const input of this.work?.querySelectorAll<HTMLInputElement>('input[type=password]')??[])input.value='';
    this.work?.replaceChildren();this.phase='idle';
  }
  private retireTurn():void {
    this.state.retireTurn();
    for(const checkbox of this.transcript?.querySelectorAll<HTMLInputElement>('input[type=checkbox]')??[])checkbox.checked=false;
    const owner=this.owner;this.owner=undefined;this.clearWork();
    if(owner&&this.session)this.controller.cancelRetainedChatTurn(this.session,owner);
    if(this.sessionRead){
      this.sessionRead=false;
      const session=this.session;this.session=undefined;this.history=[];this.transcript?.replaceChildren();
      if(session)this.controller.closeRetainedChatSession(session);
    }
    if(this.send)this.send.disabled=false;
  }
  private resetSession(clearScope:boolean):void {
    this.retireTurn();
    const session=this.session;this.session=undefined;this.history=[];
    this.transcript?.replaceChildren();
    if(session)this.controller.closeRetainedChatSession(session);
    if(clearScope){this.state.retire();if(this.scopeLabel)this.scopeLabel.textContent=this.t('No scope selected','Область не выбрана');}
  }
  private fingerprint():string{return JSON.stringify(this.settings().ai.generation);}
  private pin():void {
    this.revision=this.controller.sourceAuthorityRevision();this.generationId=this.controller.status().generationId;this.configKey=this.fingerprint();this.settingsKey=String(this.settings().propertiesEnabled);
  }
  private authorityCurrent():boolean {
    return this.controller.sourceAuthorityCurrent(this.revision)&&this.generationId===this.controller.status().generationId
      &&this.configKey===this.fingerprint()&&this.settingsKey===String(this.settings().propertiesEnabled)&&this.settings().enabled&&!this.settings().paused;
  }
  private live(generation:number,session:RetainedChatSessionOwner):boolean {
    return !this.disposed&&this.state.current(generation)&&this.session===session&&this.authorityCurrent();
  }
  private failure(error:unknown):void {this.retireTurn();this.tell(code(error));}
  applyHostScope(selector:ScopeSelector):void {
    if(this.disposed)return;
    this.apply(()=>selector);
  }
  private apply(make:()=>ScopeSelector):void {
    this.resetSession(true);
    try {
      const {selector}=this.state.select(make());
      this.pin();
      if(this.scopeLabel)this.scopeLabel.textContent=JSON.stringify(selector);
      this.tell(this.t('Scope applied. Retrieval is local.','Область применена. Поиск локальный.'));
    }catch(error){this.tell(code(error));}
  }
  async onOpen():Promise<void> {
    this.cleanup();this.disposed=false;this.pin();
    const root=this.contentEl;root.replaceChildren();root.addClass('oks-search');root.addClass('oks-chat');
    const t=this.t;
    this.add(root,'h2',this.getDisplayText());
    this.add(root,'p',t('Local lexical evidence first. Generation requires an exact preview and separate consent. Only synthetic/public local pilot data is currently admitted.','Сначала локальный лексический поиск. Генерация — только после точного предпросмотра и отдельного согласия. Сейчас допущен лишь локальный пилот на синтетических/публичных данных.'));
    this.button(root,t('Generation settings','Настройки генерации'),()=>{this.retireTurn();this.openSettings();});
    this.scopeLabel=this.add(root,'pre',t('No scope selected','Область не выбрана'));
    const scopeControls=this.add(root,'section');
    const kind=this.select(scopeControls,t('Scope','Область'),[['',t('Choose scope','Выберите область')],['vault-wide',t('Entire vault','Весь Vault')],['files',t('Exact files','Указанные файлы')],['folder',t('Folder','Папка')],['properties',t('Properties / metadata','Свойства / метаданные')],['applied-results',t('Current search results','Текущие результаты поиска')]]);
    const value=this.add(scopeControls,'textarea');value.placeholder=t('Paths (one per line), folder or property key','Пути (по одному на строку), папка или ключ свойства');value.setAttribute('aria-label',value.placeholder);
    const type=this.select(scopeControls,t('Property type','Тип свойства'),['string','number','boolean','date','null','list'].map(v=>[v,v]));
    const op=this.select(scopeControls,t('Property operation','Операция со свойством'),[['eq','='],['contains',t('Contains','Содержит')]]);
    const propertyValue=this.input(scopeControls,t('Property value','Значение свойства'));
    const tag=this.input(scopeControls,t('Tag','Тег')),link=this.input(scopeControls,t('Link target','Цель ссылки'));
    const updateScope=()=>{this.resetSession(true);this.tell(t('Apply a scope before sending.','Примените область перед отправкой.'));};
    for(const input of [kind,value,type,op,propertyValue,tag,link])input.oninput=()=>{if(!this.disposed&&root.contains(input))updateScope();};
    this.button(scopeControls,t('Apply scope','Применить область'),()=>this.apply(()=>{
      if(kind.value==='applied-results')return appliedChatScope(this.controller.snapshot().response,this.controller.status().generationId);
      if(kind.value==='properties'&&!this.settings().propertiesEnabled)throw new StandaloneError('CAPABILITY_UNAVAILABLE');
      return manualChatScope(kind.value,value.value,type.value,op.value,propertyValue.value,tag.value,link.value);
    }));
    this.add(root,'p',t('For the active note or a selected editor range, use the corresponding OKS command in that note.','Для активной заметки или выделенного фрагмента используйте соответствующую команду OKS в редакторе.'));
    this.question=this.add(root,'textarea');this.question.placeholder=t('Question','Вопрос');this.question.setAttribute('aria-label',this.question.placeholder);
    this.topK=this.input(root,t('Top K (1–50)','Top K (1–50)'),'number');this.topK.min='1';this.topK.max='50';this.topK.value=String(this.settings().topK);
    this.match=this.select(root,t('Lexical match','Лексическое совпадение'),[['terms',t('Terms','Термины')],['literal',t('Exact phrase','Точная фраза')]]);
    for(const input of [this.question,this.topK,this.match])input.oninput=()=>{if(!this.disposed&&root.contains(input))this.retireTurn();};
    this.send=this.button(root,t('Retrieve evidence','Найти доказательства'),()=>void this.retrieve());
    this.button(root,t('Cancel','Отмена'),()=>{this.retireTurn();this.tell(t('Cancelled','Отменено'));});
    this.button(root,t('New chat','Новый чат'),()=>{this.resetSession(true);this.question!.value='';this.tell(t('New chat','Новый чат'));});
    this.question.onkeydown=event=>{
      if(this.disposed||!this.contentEl.contains(event.currentTarget as Node))return;
      if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!this.send?.disabled)void this.retrieve();}
      if(event.key==='Escape'){event.preventDefault();this.retireTurn();this.tell(t('Cancelled','Отменено'));}
    };
    this.message=this.add(root,'p','','oks-chat-status');this.message.setAttribute('role','status');this.message.setAttribute('aria-live','polite');
    this.work=this.add(root,'section');this.transcript=this.add(root,'section');
    this.unsubscribe=this.controller.subscribe(()=>{
      if(this.disposed)return;
      if(!this.authorityCurrent()){this.resetSession(true);this.pin();this.tell(t('Source or configuration changed. Reapply scope.','Источники или конфигурация изменились. Примените область заново.'));return;}
      if(this.session&&this.history.length)try {
        const ids=this.controller.readRetainedChatHistory(this.session).map(turn=>turn.id);
        if(ids.length!==this.history.length||ids.some((id,i)=>id!==this.history[i]?.id)){
          this.history=[];this.transcript?.replaceChildren();
          if(this.phase!=='working')this.retireTurn();
        }
      }catch{this.resetSession(true);}
      if(this.owner&&this.session&&this.phase!=='working'&&!this.controller.retainedChatTurnCurrent(this.session,this.owner)){
        this.retireTurn();this.tell('CANCELLED');
      }
    });
  }
  private async retrieve():Promise<void> {
    if(this.disposed||this.phase!=='idle'||!this.authorityCurrent())return;
    const question=this.question!.value;
    let generation=this.state.snapshot().generation;
    try {
      if(!question.trim())throw new StandaloneError('QUERY_INVALID');
      const {requestId,query,limit,matchMode}=uiRequest(question,Number(this.topK!.value),[],this.match!.value==='literal'?'literal':'terms');
      this.session??=this.controller.openRetainedChatSession();
      const session=this.session;
      const begun=this.state.begin();generation=begun.generation;
      const {selector,priorQuestionIds}=begun;
      this.phase='working';this.send!.disabled=true;
      this.tell(this.t('Retrieving local evidence…','Поиск локальных доказательств…'));
      const turn=this.controller.startRetainedChatTurn(session,selector,{requestId,query,limit,matchMode},priorQuestionIds);
      this.owner=turn.owner;
      this.timer=setTimeout(()=>{
        if(this.state.current(generation)&&this.session===session&&!this.disposed){
          if(!this.authorityCurrent()){this.resetSession(true);this.pin();}else this.retireTurn();
          this.tell('TIMEOUT');
        }
      },30_000);
      const result=await turn.result;if(!this.live(generation,session))return;
      if(!result.ok){this.retireTurn();this.tell(result.error);return;}
      const view=await this.controller.readRetainedChatTurn(session,turn.owner);if(!this.live(generation,session))return;
      if(!view.ok){this.retireTurn();this.tell(view.error);return;}
      if(!view.value.response.hits.length){this.retireTurn();this.tell('INSUFFICIENT_EVIDENCE');return;}
      const coverage=view.value.scope.coverage;
      this.tell(this.t('Scope coverage: ','Охват области: ')+JSON.stringify(coverage)+
        ' | '+this.t('Retrieved excerpts: ','Получено фрагментов: ')+view.value.response.hits.length+' / '+limit);
      const work=this.work!;work.replaceChildren();
      for(const hit of view.value.response.hits){this.add(work,'p',hit.sourceId);this.add(work,'pre',hit.originalExcerpt);}
      this.phase='retrieved';
      const pref=this.settings().ai.generation;
      if(pref.state!=='configured'||pref.transport!=='local') {
        this.add(work,'p',this.t('Generation unavailable; no provider admitted for this configuration.','Генерация недоступна; провайдер для этой конфигурации не допущен.'));return;
      }
      const password=this.input(work,this.t('One-turn bearer token','Bearer-токен на один запрос'),'password');
      password.autocomplete='off';
      this.button(work,this.t('Bind token and classify','Привязать токен и классифицировать'),()=>{
        if(this.phase!=='retrieved'||!this.live(generation,session))return;
        const token=password.value;password.value='';this.phase='working';work.replaceChildren();
        void this.classify(generation,session,turn.owner,token);
      },()=>this.live(generation,session));
    }catch(error){if(!this.disposed&&this.state.current(generation))this.failure(error);}
  }
  private async classify(generation:number,session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner,token:string):Promise<void> {
    try {
      const stamp=await this.controller.bindRetainedGenerationCredential(session,owner,token);if(!this.live(generation,session))return;
      const draft=this.controller.createRetainedChatClassificationDraft(session,owner,stamp);if(!this.live(generation,session))return;
      this.showDraft(generation,session,owner,draft);
    }catch(error){if(this.live(generation,session))this.failure(error);}
  }
  private showDraft(generation:number,session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner,draft:RetainedChatClassificationDraft):void {
    const work=this.work!,t=this.t;work.replaceChildren();this.phase='classifying';
    const controls:{id:string;select:HTMLSelectElement}[]=[];
    const item=(id:string,label:string,text:string)=>{
      this.add(work,'p',label);this.add(work,'pre',text);
      controls.push({id,select:this.select(work,t('Classification','Классификация'),[['',t('Choose explicitly','Выберите явно')],['synthetic',t('Synthetic','Синтетические')],['public',t('Public','Публичные')],['blocked',t('Do not disclose','Не передавать')]])});
    };
    item(draft.question.id,t('Current question','Текущий вопрос'),draft.question.text);
    for(const prior of draft.priorQuestions)item(prior.id,t('Selected prior question','Выбранный предыдущий вопрос'),prior.text);
    for(const evidence of draft.evidence)item(evidence.id,evidence.sourceId,evidence.excerpt);
    this.button(work,t('Prepare exact preview','Подготовить точный предпросмотр'),()=>{
      if(this.phase!=='classifying'||!this.live(generation,session))return;
      if(controls.some(c=>!c.select.value)){this.tell(t('Classify every item.','Классифицируйте каждый элемент.'));return;}
      this.phase='working';let next=draft;
      try {
        for(const c of controls)next=this.controller.attestRetainedChatClassification(session,owner,next,c.id,c.select.value as 'synthetic'|'public'|'blocked');
      }catch(error){if(this.live(generation,session))this.failure(error);return;}
      work.replaceChildren();
      void this.prepare(generation,session,owner,next);
    },()=>this.live(generation,session));
  }
  private async prepare(generation:number,session:RetainedChatSessionOwner,owner:RetainedChatTurnOwner,draft:RetainedChatClassificationDraft):Promise<void> {
    try {
      const preview=await this.controller.prepareRetainedChatGeneration(session,owner,draft);if(!this.live(generation,session))return;
      const work=this.work!,t=this.t;work.replaceChildren();this.phase='preview';
      this.add(work,'h3',t('Exact disclosure preview — no request sent','Точный предпросмотр передачи — запрос не отправлен'));
      this.add(work,'pre',JSON.stringify({role:'generation',origin:preview.config.origin,identity:preview.config.identity,
        limits:preview.config.limits,inputBytes:preview.inputBytes,expiresUnixMs:preview.expiresUnixMs,classification:preview.composedQuestion.classification},null,2));
      this.add(work,'pre',preview.composedQuestion.text);
      for(const item of [preview.question,...preview.priorQuestions])this.add(work,'p',item.classification+' — '+item.text);
      for(const item of preview.evidence){this.add(work,'p',item.sourceId+' — '+item.classification);this.add(work,'pre',item.excerpt);}
      this.button(work,t('Authorize and send once','Разрешить и отправить один раз'),()=>{
        if(this.phase!=='preview'||!this.live(generation,session))return;
        this.phase='working';work.replaceChildren();this.tell(t('Generating…','Генерация…'));
        void(async()=>{
          try{
            const result=await this.controller.confirmRetainedChatGeneration(session,owner,preview);
            if(!this.live(generation,session))return;
            if(!result.ok){this.retireTurn();this.tell(result.error);return;}
            this.owner=undefined;
            await this.refreshHistory(generation,session);
            if(this.live(generation,session)){this.retireTurn();this.tell(t('Completed. History verified locally.','Завершено. История проверена локально.'));}
          }catch(error){if(this.live(generation,session))this.failure(error);}
        })();
      },()=>this.live(generation,session));
    }catch(error){if(this.live(generation,session))this.failure(error);}
  }
  private async refreshHistory(generation:number,session:RetainedChatSessionOwner):Promise<void> {
    this.sessionRead=true;
    const verified=await this.controller.readVerifiedRetainedChatHistory(session);
    if(!this.live(generation,session))return;
    this.sessionRead=false;
    this.history=[];this.transcript?.replaceChildren();
    if(!verified.ok){this.retireTurn();this.tell(verified.error);return;}
    this.history=verified.value;this.renderHistory(session);
  }
  private renderHistory(session:RetainedChatSessionOwner):void {
    const root=this.transcript!,t=this.t;root.replaceChildren();
    const prior:HTMLInputElement[]=[];
    for(const turn of this.history) {
      this.add(root,'h3',turn.question);
      const label=this.add(root,'label',t('Include this prior question (max 2)','Включить этот предыдущий вопрос (макс. 2)'));
      const checkbox=this.add(label,'input');checkbox.type='checkbox';checkbox.value=turn.id;prior.push(checkbox);
      checkbox.onchange=()=>{
        if(this.disposed||!root.contains(checkbox)||this.session!==session)return;
        const ids=prior.filter(p=>p.checked).map(p=>p.value);
        if(ids.length>2){checkbox.checked=false;this.tell(t('Maximum two prior questions','Не более двух предыдущих вопросов'));return;}
        this.retireTurn();
        this.state.selectPrior(this.history.map(turn=>turn.id),ids);
        for(const p of prior)p.checked=ids.includes(p.value);
      };
      turn.claims.forEach((claim,claimIndex)=>{
        this.add(root,'p',claim.kind==='quotation'?t('Quotation','Цитата'):t('Inference','Вывод'));
        this.add(root,'p',claim.text);
        claim.citations.forEach((citation,citationIndex)=>this.button(root,citation.sourceId,()=>{
          if(this.phase!=='idle'||!this.authorityCurrent()||this.session!==session)return;
          this.sessionRead=true;this.phase='working';this.send!.disabled=true;
          const generation=this.state.snapshot().generation;
          void(async()=>{
            try{
              const result=await this.controller.openRetainedChatCitation(session,turn.id,claimIndex,citationIndex);
              if(!this.live(generation,session))return;
              this.sessionRead=false;this.retireTurn();
              if(!result.ok){this.history=[];root.replaceChildren();this.tell(result.error);}
            }catch{if(this.live(generation,session))this.failure(new StandaloneError('NAVIGATION_REJECTED'));}
          })();
        },()=>this.session===session&&this.history.some(item=>item.id===turn.id)));
      });
    }
  }
  private cleanup():void {
    this.disposed=true;this.unsubscribe?.();this.unsubscribe=undefined;this.resetSession(true);
    this.contentEl.replaceChildren();
  }
  async onClose():Promise<void>{this.cleanup();}
}
