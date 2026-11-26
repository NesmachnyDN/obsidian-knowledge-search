import { Modal, type App, type TFile } from 'obsidian';
import type { NativeBaselinePreview, NativeLifecycleOwner } from './native-lifecycle-owner';

const labels:Readonly<Record<string,readonly [string,string]>>={
  admitted:['Existing-material baseline committed. No access granted.','Исходный набор существующих материалов зафиксирован. Доступ не предоставлен.'],
  cancelled:['Preview cancelled. No baseline confirmed.','Предпросмотр отменён. Исходный набор не подтверждён.'],
  'cancel-requested':['Cancellation requested. Durable publication may already have occurred.','Запрошена отмена. Фиксация в журнале уже могла произойти.'],
  'committed-not-live':['Baseline committed, but live authority revoked. No rollback is implied.','Исходный набор зафиксирован, но текущие полномочия отозваны. Откат не гарантирован.'],
  'uncertain-publication':['Publication uncertain. Lifecycle unavailable; no automatic retry.','Результат фиксации неизвестен. Жизненный цикл недоступен; автоматический повтор запрещён.'],
  denied:['Confirmation denied.','В подтверждении отказано.'],
  stale:['Confirmation is stale or already consumed.','Подтверждение устарело или уже использовано.'],
  expired:['Preview expired.','Срок действия предпросмотра истёк.'],
  retired:['Lifecycle owner retired. Reload the plugin to recheck readiness.','Владелец жизненного цикла выведен из действия. Перезагрузите плагин для проверки готовности.'],
  unavailable:['Initial baseline unavailable. If startup provenance was ambiguous, explicitly reload the plugin after the Vault settles. No automatic reset.',
    'Исходный набор недоступен. При неоднозначных событиях запуска явно перезагрузите плагин после стабилизации Vault. Автоматического сброса нет.'],
  opening:['Lifecycle is opening. Retry the command after readiness is established.','Жизненный цикл открывается. Повторите команду после определения готовности.'],
  'already-admitted':['A committed baseline already exists. Rebaseline is forbidden.','Исходный набор уже зафиксирован. Повторное подтверждение запрещено.'],
  restored:['A committed lifecycle already exists. Rebaseline is forbidden.','Зафиксированный жизненный цикл уже существует. Повторный исходный набор запрещён.'],
  corrupted:['Committed lifecycle data is corrupted. No automatic reset.','Данные жизненного цикла повреждены. Автоматический сброс запрещён.'],
  ambiguous:['Lifecycle storage is ambiguous. No automatic reset.','Состояние хранилища жизненного цикла неоднозначно. Автоматический сброс запрещён.'],
  busy:['A lifecycle operation is already in progress.','Операция жизненного цикла уже выполняется.'],
  'inventory-rejected':['Complete inventory could not be verified.','Не удалось подтвердить полный инвентарь.'],
  'owner-mismatch':['Native source identity could not be verified.','Не удалось подтвердить идентичность источника.'],
  'verification-failed':['Current original or authority verification failed.','Проверка актуального оригинала или полномочий не пройдена.'],
};
export function baselineNotice(ru:boolean,code:string):string {
  return 'OKS: '+(labels[code]??labels.denied!)[ru?1:0];
}

/** Presentation only: never directly accesses the tracker or ledger. */
export class InitialBaselineModal extends Modal {
  private timer?:number;
  private timerWindow?:Window;
  private closed=false;
  private confirming=false;
  private completed=false;
  constructor(app:App,private readonly owner:NativeLifecycleOwner<TFile>,private readonly preview:NativeBaselinePreview,
    private readonly ru:boolean,private readonly notify:(code:string)=>void,private readonly finished:()=>void){super(app);}
  private words(en:string,ru:string):string{return this.ru?ru:en;}
  private stopTimer():void{if(this.timer!==undefined){this.timerWindow?.clearInterval(this.timer);this.timer=undefined;}}
  onOpen():void{
    if(this.closed)return;
    const doc=this.contentEl.ownerDocument;
    const view=doc.defaultView;if(!view)throw Error('BASELINE_MODAL_UNAVAILABLE');
    this.timerWindow=view;
    this.titleEl.setText(this.words('Confirm existing-material baseline','Подтвердить исходный набор существующих материалов'));
    const summary=doc.createElement('p');
    summary.textContent=this.words('This locally designates the displayed exact originals as existing; new-material automatic marking will not apply. It grants no access and does not modify Vault originals.',
      'Это локальное обозначение показанных точных версий как существующих; автоматическая маркировка новых материалов к ним не применяется. Доступ не предоставляется, исходные файлы Vault не изменяются.');
    const scope=doc.createElement('p');
    scope.textContent=this.words('Scope: complete local Markdown inventory','Область: полный локальный инвентарь Markdown')+' ('+this.preview.count+')';
    const paths=doc.createElement('pre');paths.textContent=this.preview.paths.join('\n')||this.words('(empty inventory)','(пустой инвентарь)');
    paths.style.maxHeight='40vh';paths.style.overflow='auto';paths.style.whiteSpace='pre-wrap';paths.style.overflowWrap='anywhere';
    const expiry=doc.createElement('p');
    const controls=doc.createElement('div'),cancel=doc.createElement('button'),confirm=doc.createElement('button');
    cancel.textContent=this.words('Cancel','Отмена');cancel.onclick=()=>this.close();
    confirm.classList.add('mod-cta');confirm.textContent=this.words('Confirm local classification','Подтвердить локальную классификацию');
    confirm.onclick=()=>{
      if(this.closed||this.confirming||this.completed)return;
      if(this.owner.baselinePreviewRemainingMs(this.preview)<=0){expire();return;}
      this.confirming=true;this.stopTimer();confirm.disabled=true;
      expiry.textContent=this.words('Verifying and committing locally…','Локальная проверка и фиксация…');
      void this.confirm();
    };
    controls.append(cancel,confirm);this.contentEl.append(summary,scope,paths,expiry,controls);
    const expire=()=>{
      const state=this.owner.readiness();
      this.completed=true;
      this.owner.cancelBaselinePreviewOutcome(this.preview);
      this.notify(state==='fresh'||state==='uninitialized'?'expired':'retired');this.close();
    };
    const refresh=()=>{
      if(this.closed||this.confirming||this.completed)return;
      const ms=this.owner.baselinePreviewRemainingMs(this.preview);
      expiry.textContent=this.words('Expires in','Истекает через')+' '+Math.ceil(ms/1000)+' '+this.words('seconds','с');
      if(ms<=0)expire();
    };
    this.timer=view.setInterval(refresh,250);refresh();
  }
  private async confirm():Promise<void>{
    try{
      const result=await this.owner.confirmBaselinePreview(this.preview);
      this.completed=true;
      // Even if the dialog was dismissed, report the proven durable outcome,
      // not a retrospective assertion that cancellation rolled it back.
      if(result.outcome==='admitted'&&(this.closed||!this.owner.exactAuthorityActive())){
        this.owner.retire();void this.owner.close().catch(()=>{});this.notify('committed-not-live');
      }else this.notify(result.outcome==='denied'?(result.reason??'denied'):result.outcome);
    }catch{
      this.completed=true;this.owner.retire();void this.owner.close().catch(()=>{});this.notify('uncertain-publication');
    }finally{if(!this.closed)this.close();}
  }
  onClose():void{
    if(this.closed)return;
    this.closed=true;this.stopTimer();
    if(!this.completed){
      const result=this.owner.cancelBaselinePreviewOutcome(this.preview);
      if(this.confirming&&result.outcome==='denied'){
        // A user close may race a completed durable transaction before its
        // promise result reaches the UI. Revoke even in that narrow interval.
        this.owner.retire();void this.owner.close().catch(()=>{});this.notify('cancel-requested');
      }else this.notify(result.outcome==='denied'?result.reason:result.outcome);
    }
    this.contentEl.replaceChildren();this.finished();
  }
}
