/** Supported Obsidian Modal/Setting API, no internal search-view/private editor APIs. */
import { App, Modal, Notice, Setting } from 'obsidian';
import type { Predicate } from '../standalone/contracts';
import type { RetrievalRequest, SearchMode, RetrievalResponse, AdvancedEvidenceHit } from './retrieval';

export class AdvancedSearchModal extends Modal {
  private query='';private mode:SearchMode='hybrid';
  private key='';private value='';private kind:Predicate['valueType']='string';
  private operator:Predicate['operator']='eq';private sourceScope='';
  private output?:HTMLElement;
  constructor(app:App,private readonly search:(request:RetrievalRequest)=>Promise<RetrievalResponse>,
    private readonly openHit:(hit:AdvancedEvidenceHit)=>Promise<void>,
    private readonly cancel:()=>Promise<void>,
    private readonly status:()=>string){super(app);}
  onOpen():void{
    this.contentEl.replaceChildren();
    this.setTitle('OKS Advanced offline retrieval');
    new Setting(this.contentEl).setName('Query').addText(t=>t.setPlaceholder('Search notes and documents')
      .onChange(v=>{this.query=v;}));
    new Setting(this.contentEl).setName('Retrieval mode').addDropdown(d=>d
      .addOption('lexical','Lexical').addOption('dense','Dense (BGE-M3)')
      .addOption('hybrid','Hybrid RRF').setValue(this.mode).onChange(v=>{this.mode=v as SearchMode;}));
    new Setting(this.contentEl).setName('Optional exact Vault paths')
      .setDesc('Comma-separated, source-relative; blank uses indexed sources for dense/hybrid and ingested sources for lexical. Explicit unindexed dense scope fails.')
      .addText(t=>t.onChange(v=>{this.sourceScope=v;}));
    new Setting(this.contentEl).setName('Typed Property key (optional)')
      .addText(t=>t.onChange(v=>{this.key=v.trim();}));
    new Setting(this.contentEl).setName('Property type').addDropdown(d=>d
      .addOption('string','String').addOption('number','Number').addOption('boolean','Boolean')
      .addOption('date','Date (YYYY-MM-DD)').addOption('list','List')
      .addOption('null','Null').setValue(this.kind).onChange(v=>{this.kind=v as Predicate['valueType'];}));
    new Setting(this.contentEl).setName('Property operator').addDropdown(d=>d
      .addOption('eq','Equals').addOption('contains','List contains')
      .setValue('eq').onChange(v=>{this.operator=v as Predicate['operator'];}));
    new Setting(this.contentEl).setName('Property value')
      .setDesc('For numbers/booleans/lists use JSON; null needs no value. List contains accepts a JSON scalar.')
      .addText(t=>t.onChange(v=>{this.value=v;}));
    new Setting(this.contentEl).addButton(b=>b.setButtonText('Search').setCta().onClick(()=>{
      void this.run();
    })).addButton(b=>b.setButtonText('Cancel worker').onClick(()=>{
      void this.cancel().catch(()=>new Notice('OKS Advanced: cancellation failed'));
    }));
    this.output=this.contentEl.createDiv({cls:'oks-advanced-results'});
    this.output.setText(this.status());
  }
  private filters():Predicate[]{
    if(!this.key)return [];
    let parsed:unknown=this.value;
    if(this.kind==='null')parsed=null;
    else if(this.kind==='number'||this.kind==='boolean'||this.kind==='list'||this.operator==='contains')
      parsed=JSON.parse(this.value);
    if(this.operator==='contains'&&this.kind!=='list')throw new Error('INVALID_FILTER');
    return [{key:this.key,valueType:this.kind,value:parsed as Predicate['value'],operator:this.operator}];
  }
  private async run():Promise<void>{
    const out=this.output;
    if(!out)return;
    out.setText('Running local retrieval. Source evidence is reverified before display.');
    let request:RetrievalRequest;
    try{
      request={query:this.query,requestedMode:this.mode,limit:10,
        ...(this.sourceScope?{scope:this.sourceScope.split(',').map(x=>x.trim())}:{}),
        predicates:this.filters()};
    }catch{out.setText('FILTER_INVALID');return;}
    try{
      const result=await this.search(request);
      if(!this.output||!this.contentEl.contains(out))return;
      out.replaceChildren();
      out.createEl('p',{text:`${result.status}; requested=${result.requestedMode}; executed=${result.executedMode}; `+
        `lexical=${result.legs.lexical.status} (${result.legs.lexical.candidateCount}); `+
        `dense=${result.legs.dense.status} (${result.legs.dense.candidateCount}); `+
        `stale=${result.staleSourceCount}; error=${result.error??'none'}`});
      if(result.error)return;
      for(const hit of result.hits){
        new Setting(out).setName(`${hit.rank}. ${hit.vaultRelativeReference}`)
          .setDesc(`${hit.originalExcerpt.slice(0,400)}\n`+
            `L=${hit.lexicalRank??'-'} (${hit.lexicalScore??'-'}); `+
            `D=${hit.denseRank??'-'} (${hit.denseSimilarity??'-'}); `+
            `RRF=${hit.rrfScore??'-'}; source=${hit.sourceStatus}`)
          .addButton(b=>b.setButtonText('Open verified source').onClick(async()=>{
            try{await this.openHit(hit);}catch{new Notice('OKS Advanced: SOURCE_STALE or navigation unavailable');}
          }));
      }
      if(!result.hits.length)out.createEl('p',{text:'No verified matching evidence.'});
    }catch(error){out.setText(error instanceof Error?error.message:'ADVANCED_UNAVAILABLE');}
  }
  onClose():void{this.output=undefined;this.contentEl.replaceChildren();}
}
