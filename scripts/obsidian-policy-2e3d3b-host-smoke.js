// Test-only real-host acceptance. It deliberately does not use the older
// fixture ledger seeding path: each phase observes the plugin's own owner.
(async phase => {
  const fail = code => { throw Error('POLICY_2E3D3B_' + code); };
  const requireThat = (value, code) => { if (!value) fail(code); };
  const fs = require('node:fs/promises'), path = require('node:path');
  const tmp = process.env.tmp, vault = app.vault, id = 'oks-synthetic-evidence';
  const wait = async check => {
    const deadline=Date.now()+4000;
    while(!check()&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
    requireThat(check(),'TIMEOUT');
  };
  try {
    requireThat(process.env.OKS_POLICY_2E3D3B_TEST==='1' && process.env.OKS_POLICY_2E3A_NO_IP==='1'
      && process.env.OKS_HOST_NO_ROUTE!=='1' && typeof tmp==='string' && /^\/tmp\/oks-native-host-[A-Za-z0-9]+$/.test(tmp)
      && vault.adapter.getBasePath()===path.join(tmp,'vault') && process.env.XDG_DATA_HOME===path.join(tmp,'home/.local/share'),'ISOLATION');
    requireThat(await fs.realpath(tmp)===tmp&&(await fs.stat(tmp)).uid===process.getuid()&&((await fs.stat(tmp)).mode&0o077)===0,'PROFILE');
    const check=require('node:child_process').spawnSync('/usr/bin/python3',['-I','-B',path.join(process.env.repo,
      'scripts/obsidian-lifecycle-no-ip.py'),'--verify-inherited'],{timeout:3000,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});
    requireThat(check.status===0&&check.stdout.trim()==='DIRECT_NETWORK_DENIED','DIRECT_NETWORK');
    const plugin=app.plugins.plugins[id],owner=plugin?.lifecycleOwner?.owner;
    requireThat(plugin&&owner,'WIRING'); await owner.opening;
    const original=await Promise.all(['first.md','second.md'].map(name=>fs.readFile(path.join(tmp,'vault',name))));
    const sameOriginals=async()=>requireThat((await Promise.all(['first.md','second.md'].map(name=>fs.readFile(path.join(tmp,'vault',name))))).every((bytes,i)=>bytes.equals(original[i])),'ORIGINAL_BYTES');
    if(phase==='startup') {
      const state=owner.readiness(),tracker=plugin.markingTracker;
      requireThat(!owner.exactAuthorityActive()&&['fresh','unavailable','retired'].includes(state),'STARTUP_NO_AUTHORITY');
      for(const name of ['first.md','second.md'])
        requireThat(tracker.state(name,vault.getAbstractFileByPath(name))==='unresolved','STARTUP_NOT_VERIFIED_NEW');
      await owner.close();
      const {DurableLifecycleLedger}=require(path.join(tmp,'lifecycle-probe.cjs'));
      const read=await DurableLifecycleLedger.open({path:path.join(tmp,'vault'),rootId:plugin.sourceReader.rootId},id);
      try{requireThat(await read.read()===null,'NO_AUTOMATIC_EPOCH');}finally{await read.close();}
      await sameOriginals();
      return 'OBSIDIAN_POLICY_2E3D3B_PASS: startup; readiness='+state+'; noAutomaticEpoch=PASS; startupNotNew=PASS';
    }
    if(phase==='cancel') {
      if(owner.readiness()!=='fresh')return 'OBSIDIAN_POLICY_2E3D3B_FAIL: fresh readiness='+owner.readiness()+'; trackerLegacy='+plugin.markingTracker.legacyTouched+'; trackerRevision='+plugin.markingTracker.lifecycleRevision+'; trackerOpened='+plugin.markingTracker.opened+'; trackerSealed='+plugin.markingTracker.sealed;
      await app.commands.executeCommandById(id+':confirm-initial-lifecycle-baseline');
      await wait(()=>plugin.baselineModal);
      plugin.baselineModal.close(); await wait(()=>owner.readiness()==='retired');
      await owner.close();
      const {DurableLifecycleLedger}=require(path.join(tmp,'lifecycle-probe.cjs'));
      const read=await DurableLifecycleLedger.open({path:path.join(tmp,'vault'),rootId:plugin.sourceReader.rootId},id);
      try{requireThat(await read.read()===null,'CANCEL_NO_EPOCH');}finally{await read.close();}
      await sameOriginals();
      return 'OBSIDIAN_POLICY_2E3D3B_PASS: cancel; unseededFresh=PASS; outcome=cancelled; originals=unchanged';
    }
    if(phase==='cancel-inflight') {
      requireThat(owner.readiness()==='fresh','UNSEEDED_FRESH');
      await app.commands.executeCommandById(id+':confirm-initial-lifecycle-baseline');await wait(()=>plugin.baselineModal);
      const modal=plugin.baselineModal,reader=plugin.sourceReader;
      const button=[...modal.contentEl.querySelectorAll('button')].find(value=>value.textContent.includes('Confirm'));
      requireThat(button,'EXPLICIT_CONFIRM');
      const originalRead=reader.completeMarkdownInventory.bind(reader);
      let entered=false,release;const gate=new Promise(resolve=>{release=resolve;});
      reader.completeMarkdownInventory=async(...args)=>{entered=true;await gate;return originalRead(...args);};
      try{
        button.click();await wait(()=>entered);
        await new Promise(resolve=>setTimeout(resolve,350));
        requireThat(plugin.baselineModal===modal&&!owner.exactAuthorityActive(),'INFLIGHT_MODAL_AND_NO_AUTHORITY');
        modal.close();release();await owner.close();
        requireThat(!owner.exactAuthorityActive()&&owner.readiness()==='retired','INFLIGHT_REVOKED');
      }finally{release();reader.completeMarkdownInventory=originalRead;}
      const {DurableLifecycleLedger}=require(path.join(tmp,'lifecycle-probe.cjs'));
      const read=await DurableLifecycleLedger.open({path:path.join(tmp,'vault'),rootId:reader.rootId},id);
      try{requireThat(await read.read()===null,'INFLIGHT_NO_EPOCH');}finally{await read.close();}
      await sameOriginals();
      return 'OBSIDIAN_POLICY_2E3D3B_PASS: cancel-inflight; modalStayedOpen=PASS; revoked=PASS; noEpoch=PASS';
    }
    if(phase==='confirm') {
      if(owner.readiness()!=='fresh')return 'OBSIDIAN_POLICY_2E3D3B_FAIL: fresh readiness='+owner.readiness()+'; trackerLegacy='+plugin.markingTracker.legacyTouched+'; trackerRevision='+plugin.markingTracker.lifecycleRevision+'; trackerOpened='+plugin.markingTracker.opened+'; trackerSealed='+plugin.markingTracker.sealed;
      await app.commands.executeCommandById(id+':confirm-initial-lifecycle-baseline');
      await wait(()=>plugin.baselineModal);
      const modal=plugin.baselineModal;
      const text=modal.contentEl.textContent;
      requireThat(text.includes('first.md')&&text.includes('second.md')
        &&(text.includes('Expires in')||text.includes('Истекает через')),'PREVIEW_CONTENT');
      const button=[...modal.contentEl.querySelectorAll('button')].find(value=>/Confirm|Подтвердить/.test(value.textContent));
      requireThat(button,'EXPLICIT_CONFIRM'); button.click();
      await wait(()=>owner.exactAuthorityActive()); await sameOriginals();
      return 'OBSIDIAN_POLICY_2E3D3B_PASS: confirm; nativeCommand=PASS; explicitConfirmation=PASS; originals=unchanged';
    }
    if(phase==='reopen-and-invalidate') {
      requireThat(owner.readiness()==='restored'&&owner.exactAuthorityActive(),'DURABLE_REOPEN');
      for(const name of ['first.md','second.md']){
        const proof=await plugin.sourceReader.readLifecycleProof(name);
        requireThat(plugin.markingTracker.lifecycleState(plugin.markingTracker.context,vault.getAbstractFileByPath(name),proof)==='existing','EXACT_RESTORED');
      }
      await app.commands.executeCommandById(id+':confirm-initial-lifecycle-baseline');
      await new Promise(resolve=>setTimeout(resolve,100));
      requireThat(!plugin.baselineModal&&owner.exactAuthorityActive(),'NO_REBASELINE_RESTORED');
      await sameOriginals();
      const transient=await vault.create('transient.md','Synthetic native invalidation.\n');
      await vault.delete(transient); await wait(()=>!owner.exactAuthorityActive());
      await app.commands.executeCommandById(id+':confirm-initial-lifecycle-baseline');
      await new Promise(resolve=>setTimeout(resolve,100));
      requireThat(!plugin.baselineModal&&owner.readiness()==='retired','NO_REBASELINE');
      await sameOriginals();
      return 'OBSIDIAN_POLICY_2E3D3B_PASS: durableReopen=PASS; sourceOwnerInvalidation=PASS; noRebaseline=PASS; originals=unchanged';
    }
    fail('PHASE');
  } catch(error) {
    return 'OBSIDIAN_POLICY_2E3D3B_FAIL: '+phase+' '
      +(/^POLICY_2E3D3B_[A-Z_]+$/.test(error?.message??'')?error.message:'UNAVAILABLE');
  }
})
