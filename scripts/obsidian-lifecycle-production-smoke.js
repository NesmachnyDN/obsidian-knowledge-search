// Test-only: run after the isolated lifecycle probe seeded an exact ledger.
(async phase => {
  const fail = code => { throw Error('LIFECYCLE_PRODUCTION_' + code); };
  const requireThat = (ok, code) => { if (!ok) fail(code); };
  const fs = require('node:fs/promises'), path = require('node:path');
  const tmp = process.env.tmp, vault = app.vault;
  requireThat(process.env.OKS_POLICY_2E3C_TEST === '1'
    && process.env.OKS_POLICY_2E3A_TEST === '1' && process.env.OKS_POLICY_2E3A_NO_IP === '1'
    && process.env.OKS_HOST_NO_ROUTE !== '1' && typeof tmp === 'string'
    && /^\/tmp\/oks-native-host-[A-Za-z0-9]+$/.test(tmp)
    && vault.adapter.getBasePath() === path.join(tmp, 'vault')
    && process.env.XDG_DATA_HOME === path.join(tmp, 'home/.local/share'), 'ISOLATION');
  requireThat(await fs.realpath(tmp) === tmp && (await fs.stat(tmp)).uid === process.getuid()
    && ((await fs.stat(tmp)).mode & 0o077) === 0, 'PROFILE');
  const check = require('node:child_process').spawnSync('/usr/bin/python3',
    ['-I', '-B', path.join(process.env.repo, 'scripts/obsidian-lifecycle-no-ip.py'), '--verify-inherited'],
    { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  requireThat(check.status === 0 && check.stdout.trim() === 'DIRECT_NETWORK_DENIED', 'DIRECT_NETWORK');
  try {
    const plugin = app.plugins.plugins['oks-synthetic-evidence'];
    const reader = plugin?.sourceReader, tracker = plugin?.markingTracker, owner = plugin?.lifecycleOwner?.owner;
    requireThat(reader && tracker && owner, 'WIRING');
    await owner.opening;
    requireThat(owner.exactAuthorityActive() && tracker.context, 'RESTORE');
    const file = vault.getAbstractFileByPath('first.md');
    const state = tracker.lifecycleState(tracker.context, file, await reader.readLifecycleProof('first.md'));
    requireThat(state === (phase === 'changed' ? 'unresolved' : 'existing'), 'EXACT_VERSION');
    requireThat(plugin.standalone.status().status === 'ready', 'BASIC');
    if (phase === 'rules') {
      await plugin.patchSettings(s => { s.markingRules = { version: 'oks-policy-2a-rules-v1', defaultAction: 'set-private', rules: [] }; });
      requireThat(!owner.exactAuthorityActive(), 'RULE_RETIREMENT');
      await owner.close();
    } else if (phase === 'modify') {
      let observed = false, activeAtObserver = true;
      const ref = vault.on('modify', changed => {
        if (changed === file) { observed = true; activeAtObserver = owner.exactAuthorityActive(); }
      });
      try {
        await vault.modify(file, '# Synthetic changed original\n');
        const deadline = Date.now() + 2000;
        while (!observed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        requireThat(observed && !activeAtObserver && !owner.exactAuthorityActive(), 'EVENT_RETIREMENT');
      } finally { vault.offref(ref); }
      await owner.close();
    } else requireThat(phase === 'changed', 'PHASE');
    return 'OBSIDIAN_POLICY_2E3C_PASS: ' + phase + '; exactState=' + state;
  } catch (error) {
    return 'OBSIDIAN_POLICY_2E3C_FAIL: ' + phase + ' '
      + (/^LIFECYCLE_PRODUCTION_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'UNAVAILABLE');
  }
})
