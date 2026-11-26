(async()=>{
 const p=app.plugins.plugins['oks-synthetic-evidence'];
 const assert=(ok,code)=>{if(!ok)throw Error('CHAT_HOST_'+code)};
 const wait=async(fn,code)=>{const end=Date.now()+7000;for(;;){const value=fn();if(value)return value;assert(Date.now()<end,code);await new Promise(r=>setTimeout(r,30));}};
 const root=()=>app.workspace.getLeavesOfType('oks-native-chat')[0]?.view.contentEl;
 const ru={'No scope selected':'Область не выбрана','Question':'Вопрос','Scope':'Область','Retrieve evidence':'Найти доказательства',
 'Apply scope':'Применить область','Bind token and classify':'Привязать токен и классифицировать',
 'Prepare exact preview':'Подготовить точный предпросмотр','Classification':'Классификация','Authorize and send once':'Разрешить и отправить один раз',
 'Completed. History verified locally.':'Завершено. История проверена локально.','Quotation':'Цитата','Inference':'Вывод',
 'New chat':'Новый чат','Paths (one per line), folder or property key':'Пути (по одному на строку), папка или ключ свойства'};
 const match=(actual,en)=>actual===en||actual===ru[en];
 const control=label=>{const el=[...root().querySelectorAll('[aria-label]')].find(e=>match(e.getAttribute('aria-label'),label));assert(el,'CONTROL_'+label);return el;};
 const button=text=>{const el=[...root().querySelectorAll('button')].find(e=>match(e.textContent,text));assert(el,'BUTTON_'+text);return el;};
 const find=text=>[...root().querySelectorAll('*')].find(el=>match(el.textContent,text));
 const set=(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));};
 const old=p.settings;
 const a=await app.vault.create('chat-a.md','REQ-OKS-GENERATION: alpha\n');
 const b=await app.vault.create('chat-b.md','REQ-OKS-GENERATION: beta\n');
 try{
  await p.updateSettings({...p.settings,ai:{...p.settings.ai,generation:{state:'configured',transport:'local',
   origin:'http://127.0.0.1:18765',identity:{model:'synthetic-generator',revision:'fixture-v1'},
   limits:{timeoutMs:3000,maxInputBytes:4096,maxCandidates:2,maxOutputTokens:128,maxConcurrent:1}}}});
  await new Promise(r=>setTimeout(r,300));await p.standalone.whenIdle();
  await p.openChat();await wait(root,'VIEW');
  await wait(()=>find('No scope selected'),'DEFAULT_DENY');
  set(control('Question'),'REQ-OKS-GENERATION');
  button('Retrieve evidence').click();
  assert(find('SCOPE_INVALID'),'NO_IMPLICIT_WIDE');
  set(control('Scope'),'vault-wide');button('Apply scope').click();
  const prepare=async()=>{
   button('Retrieve evidence').click();
   const pass=await wait(()=>root().querySelector('input[type=password]'),'RETRIEVE');
   set(pass,'fixture-success');button('Bind token and classify').click();
   assert(pass.value==='','TOKEN_CLEARED');
   await wait(()=>find('Prepare exact preview'),'CLASSIFY');
   for(const select of [...root().querySelectorAll('select')].filter(e=>match(e.getAttribute('aria-label'),'Classification')))set(select,'synthetic');
   button('Prepare exact preview').click();
   return await wait(()=>[...root().querySelectorAll('button')].find(e=>match(e.textContent,'Authorize and send once')),'PREVIEW');
  };
  const stale=await prepare();set(control('Question'),'REQ-OKS-GENERATION');stale.click();
  assert(!root().querySelector('input[type=password]'),'STALE_TOKEN');
  const send=await prepare();send.click();send.click();
  await wait(()=>find('Completed. History verified locally.'),'COMPLETE');
  assert(find('Quotation')&&find('Inference'),'CLAIMS');
  assert(!root().querySelector('img'),'TEXT_ONLY');
  assert([...root().querySelectorAll('button')].some(el=>el.textContent==='chat-a.md'),'CITATION');
  send.click();button('New chat').click();assert(find('No scope selected'),'RESET');
  set(control('Scope'),'files');
  set(control('Paths (one per line), folder or property key'),'chat-a.md');
  button('Apply scope').click();set(control('Question'),'REQ-OKS-GENERATION');
  const selected=await prepare();selected.click();await wait(()=>find('Completed. History verified locally.'),'SELECTED');
  assert(find('Quotation')&&find('REQ-OKS-GENERATION: alpha'),'SELECTED_QUOTE');
  assert(!root().textContent.includes('REQ-OKS-GENERATION: beta'),'SELECTED_EXCLUDED_TEXT');
  assert(![...root().querySelectorAll('button')].some(el=>el.textContent==='chat-b.md'),'SELECTED_EXCLUDED_CITATION');
  const stalePreview=await prepare();await app.vault.modify(a,'REQ-OKS-GENERATION: changed\n');
  await wait(()=>find('No scope selected'),'SOURCE_INVALIDATION');
  stalePreview.click();
  assert(!root().querySelector('input[type=password]'),'STALE_SOURCE');
  app.workspace.detachLeavesOfType('oks-native-chat');await wait(()=>!root(),'CLOSE');
  assert(!JSON.stringify(p.settings).includes('fixture-success'),'TOKEN_NOT_PERSISTED');
  return 'OBSIDIAN_NATIVE_CHAT_PASS: explicit vault-wide/files, default deny, exact preview, one-shot, stale input/source, plain-text claims, citations, verified history, close; synthetic loopback only';
 }finally{
  app.workspace.detachLeavesOfType('oks-native-chat');await app.vault.delete(a);await app.vault.delete(b);await p.updateSettings(old);
  await new Promise(r=>setTimeout(r,250));await p.standalone.whenIdle();await p.openSearch();
 }
})()
