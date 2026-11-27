// Test-only, evaluated by the isolated real Obsidian host smoke. Never a plugin API.
(async () => {
  const fail = code => { throw Error('LIFECYCLE_HOST_' + code); };
  const requireThat = (condition, code) => { if (!condition) fail(code); };
  const fs = require('node:fs/promises'), path = require('node:path');
  const assert = require('node:assert/strict');
  const tmp = process.env.tmp, vault = app.vault;
  const root = tmp && path.join(tmp, 'vault');
  const noRoute = process.env.OKS_HOST_NO_ROUTE === '1';
  const noIp = process.env.OKS_POLICY_2E3A_NO_IP === '1';
  requireThat(process.env.OKS_POLICY_2E3A_TEST === '1' && noRoute !== noIp
    && typeof tmp === 'string' && /^\/tmp\/oks-native-host-[A-Za-z0-9]+$/.test(tmp)
    && vault.adapter.getBasePath() === root
    && process.env.XDG_DATA_HOME === path.join(tmp, 'home/.local/share'), 'ISOLATION');
  requireThat(await fs.realpath(tmp) === tmp && await fs.realpath(root) === root
    && (await fs.stat(tmp)).uid === process.getuid()
    && ((await fs.stat(tmp)).mode & 0o077) === 0, 'PROFILE');
  if (noIp) {
    const { spawnSync } = require('node:child_process');
    const check = spawnSync('/usr/bin/python3', ['-I', '-B', path.join(process.env.repo,
      'scripts/obsidian-lifecycle-no-ip.py'), '--verify-inherited'],
      { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    requireThat(check.status === 0 && check.stdout.trim() === 'DIRECT_NETWORK_DENIED', 'DIRECT_NETWORK');
  }
  const plugin = app.plugins.plugins['oks-synthetic-evidence'];
  const reader = plugin?.sourceReader;
  requireThat(reader && typeof reader.readLifecycleProof === 'function', 'READER');
  const { DurableLifecycleLedger, LifecycleLock, withPrivateDerivedDirectory, BoundedVaultReader,
    privateIndexPath } = require(path.join(tmp, 'lifecycle-probe.cjs'));
  const checkInventory = async expected => {
    const actual = await reader.list();
    requireThat(actual.length === expected.length
      && actual.every((value, i) => value === expected[i]), 'INVENTORY');
  };
  await checkInventory(['first.md', 'second.md']);
  const refs = [], events = [];
  let ledger, reopened, contention, stage = 'EVENTS', overflow = false;
  let observations = '', ledgerEnvironment = '; isolation=' + (noRoute ? 'NO_ROUTE' : 'DIRECT_NETWORK_DENIAL');
  const fileName = 'lifecycle-probe.md', movedName = 'lifecycle-moved.md';
  const folderName = 'lifecycle-folder', movedFolder = 'lifecycle-folder-moved';
  const event = (kind, owner, oldPath) => {
    if (events.length === 64) { overflow = true; return; }
    events.push(Object.freeze({ kind, owner, path: owner.path, oldPath }));
  };
  const waitEvent = async (kind, owner, currentPath, oldPath) => {
    const deadline = Date.now() + 2000;
    while (!events.some(e => e.kind === kind && e.owner === owner
      && e.path === currentPath && e.oldPath === oldPath)) {
      requireThat(!overflow && Date.now() < deadline, 'EVENT_' + kind.toUpperCase());
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    requireThat(!overflow, 'EVENT_OVERFLOW');
  };
  try {
    for (const kind of ['create', 'modify', 'rename', 'delete'])
      refs.push(vault.on(kind, (owner, oldPath) => event(kind, owner, oldPath)));
    const file = await vault.create(fileName, 'Synthetic lifecycle original.\n');
    await waitEvent('create', file, fileName);
    requireThat(vault.getAbstractFileByPath(fileName) === file, 'CREATE_OWNER');
    await checkInventory(['first.md', fileName, 'second.md']);
    const created = await reader.readLifecycleProof(fileName);
    assert.deepEqual(created.version, await reader.readVersionProof(fileName));
    requireThat(/^[a-f0-9]{64}$/.test(created.stableIdentity), 'IDENTITY');
    // A public event notification alone does not establish a filesystem mutation.
    const notificationCount = events.length;
    vault.trigger('modify', file);
    requireThat(events.slice(notificationCount).some(e => e.kind === 'modify'
      && e.owner === file && e.path === fileName), 'PUBLIC_NOTIFICATION');
    assert.deepEqual(await reader.readLifecycleProof(fileName), created);
    const externalEventCount = events.length;
    require('node:fs').writeFileSync(path.join(root, fileName), 'Synthetic external edit.\n');
    const beforeEventLoop = events.length === externalEventCount;
    const external = await reader.readLifecycleProof(fileName);
    requireThat(beforeEventLoop && external.version.sha256 !== created.version.sha256
      && external.version.versionId !== created.version.versionId, 'EXTERNAL_WRITE_BOUNDARY');
    const modificationCount = events.length;
    await vault.modify(file, 'Synthetic lifecycle modified.\n');
    const deadline = Date.now() + 2000;
    while (!events.slice(modificationCount).some(e => e.kind === 'modify'
      && e.owner === file && e.path === fileName)) {
      requireThat(!overflow && Date.now() < deadline, 'MODIFY_AFTER_EXTERNAL');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const modified = await reader.readLifecycleProof(fileName);
    requireThat(created.version.sha256 !== modified.version.sha256
      && external.version.sha256 !== modified.version.sha256
      && created.version.versionId !== modified.version.versionId
      && external.version.versionId !== modified.version.versionId, 'MODIFY_PROOF');
    const modifyContinuity = created.stableIdentity === modified.stableIdentity;
    await vault.rename(file, movedName);
    await waitEvent('rename', file, movedName, fileName);
    requireThat(vault.getAbstractFileByPath(movedName) === file, 'RENAME_OWNER');
    const moved = await reader.readLifecycleProof(movedName);
    requireThat(modified.version.sha256 === moved.version.sha256
      && modified.version.versionId !== moved.version.versionId
      && modified.stableIdentity === moved.stableIdentity, 'RENAME_PROOF');
    stage = 'REPLACEMENT';
    const bytes = await fs.readFile(path.join(root, movedName));
    const replacement = path.join(tmp, 'same-bytes-replacement.md');
    await fs.writeFile(replacement, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(replacement, path.join(root, movedName));
    const replaced = await reader.readLifecycleProof(movedName);
    requireThat(replaced.version.sha256 === moved.version.sha256
      && replaced.version.versionId !== moved.version.versionId
      && replaced.stableIdentity !== moved.stableIdentity, 'SAME_BYTES_REPLACEMENT');
    const current = vault.getAbstractFileByPath(movedName);
    requireThat(current, 'REPLACEMENT_OWNER');
    await vault.delete(current);
    await waitEvent('delete', current, movedName);
    stage = 'FOLDER';
    const createdFolder = await vault.createFolder(folderName);
    const folder = vault.getAbstractFileByPath(folderName);
    requireThat(folder && (!createdFolder || createdFolder === folder), 'FOLDER_OWNER');
    await waitEvent('create', folder, folderName);
    stage = 'FOLDER_CHILD';
    const child = await vault.create(folderName + '/child.md', 'Synthetic child.\n');
    await waitEvent('create', child, folderName + '/child.md');
    stage = 'FOLDER_RENAME';
    await vault.rename(folder, movedFolder);
    await waitEvent('rename', folder, movedFolder, folderName);
    const descendant = vault.getAbstractFileByPath(movedFolder + '/child.md');
    requireThat(descendant && !vault.getAbstractFileByPath(folderName + '/child.md'), 'FOLDER_RENAME');
    stage = 'FOLDER_DELETE';
    await vault.delete(descendant);
    await vault.delete(folder, true);
    await waitEvent('delete', folder, movedFolder);
    await checkInventory(['first.md', 'second.md']);
    observations = 'descriptorProof=PASS; sampleNativeEvents=PASS; sameByteReplacement=PASS; folderEvents=PASS; fixtureInventory=PASS; modifyStable='
      + String(modifyContinuity) + '; publicNotificationWithoutWrite=OBSERVED; externalWriteBeforeCallback=OBSERVED; eventAuthenticity=UNPROVEN; eventCompleteness=UNPROVEN; folderContinuity=UNPROVEN';
    stage = 'LEDGER';
    const [tmpOwner, usrOwner, binOwner, flockOwner] = await Promise.all(
      ['/tmp', '/usr', '/usr/bin', '/usr/bin/flock'].map(async name => (await fs.lstat(name)).uid));
    ledgerEnvironment += '; processUid=' + process.getuid() + '; tmpOwner=' + tmpOwner
      + '; usrOwner=' + usrOwner + '; binOwner=' + binOwner + '; flockOwner=' + flockOwner;
    // Explicit synthetic fixture initialization, not native baseline admission.
    const options = { path: root, rootId: reader.rootId };
    if (noIp) {
      stage = 'LEDGER_ROOT';
      requireThat((await BoundedVaultReader.open(root, () => [])).rootId === reader.rootId, 'ROOT_ID');
      stage = 'LEDGER_DIRECTORY';
      const diagnosticDir = path.join(path.dirname(privateIndexPath(root, reader.rootId, plugin.manifest.id)),
        'lifecycle-diagnostic');
      // A failure in the production directory primitive is deliberately opaque.
      // Observe the existing synthetic ancestry and directory fsync separately.
      const flags = require('node:fs').constants;
      for (const [label, pathname] of [['root', '/'], ['tmp', '/tmp'], ['fixture', tmp],
        ['data', process.env.XDG_DATA_HOME], ['indexParent', path.dirname(diagnosticDir)]]) {
        let handle;
        try {
          handle = await fs.open(pathname, flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW);
          const info = await handle.stat();
          requireThat(await fs.realpath('/proc/self/fd/' + handle.fd) === pathname, 'DIAG_REALPATH');
          await handle.sync();
          ledgerEnvironment += '; ' + label + 'Sync=PASS(' + info.uid + ',' + (info.mode & 0o7777).toString(8) + ')';
        } catch (error) {
          ledgerEnvironment += '; ' + label + 'Sync=' + (/^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'FAILED');
        } finally { if (handle) await handle.close(); }
      }
      await withPrivateDerivedDirectory(diagnosticDir, root, async dir => {
        stage = 'LEDGER_LOCK';
        const lock = await LifecycleLock.acquire(dir);
        try {
          await lock.assertCurrent(dir);
          ledgerEnvironment += '; diagnosticDirectoryLock=PASS';
        } finally { await lock.close(); }
      }, true);
    }
    stage = 'LEDGER';
    ledger = await DurableLifecycleLedger.open(options, plugin.manifest.id);
    requireThat(await ledger.read() === null, 'LEDGER_EMPTY');
    const empty = await ledger.initializeEmptyEpoch();
    const proof = await reader.readLifecycleProof('first.md');
    const entry = { sourceId: 'first.md', state: 'existing', origin: 'baseline',
      originVersionId: proof.version.versionId, proof };
    const committed = await ledger.commit(empty.anchor.snapshotSha256, true, [entry]);
    assert.deepEqual(await ledger.read(), committed);
    const privateRoot = path.join(process.env.XDG_DATA_HOME, 'obsidian-knowledge-search/plugins',
      plugin.manifest.id, reader.rootId);
    const anchor = path.join(privateRoot, 'lifecycle-authority/CURRENT');
    const anchorStat = await fs.lstat(anchor);
    requireThat(await fs.realpath(anchor) === anchor && anchorStat.isFile()
      && anchorStat.uid === process.getuid() && (anchorStat.mode & 0o077) === 0, 'PRIVATE_ANCHOR');
    try { contention = await DurableLifecycleLedger.open(options, plugin.manifest.id); }
    catch (error) { requireThat(error.code === 'LIFECYCLE_LEDGER_UNAVAILABLE', 'LOCK_ERROR'); }
    requireThat(!contention, 'LOCK_CONTENTION');
    const reading = ledger.read();
    const closing = ledger.close();
    assert.deepEqual(await reading, committed);
    await closing;
    ledger = undefined;
    reopened = await DurableLifecycleLedger.open(options, plugin.manifest.id);
    assert.deepEqual(await reopened.read(), committed);
    assert.deepEqual(await reader.readLifecycleProof('first.md'), proof);
    await reopened.close();
    reopened = undefined;
    requireThat(!overflow, 'EVENT_OVERFLOW');
    return 'OBSIDIAN_POLICY_2E3A_PASS: ' + observations
      + '; ledgerCommitReadContentionDrainReopen=PASS' + ledgerEnvironment + '; productionAdmission=UNPROVEN';
  } catch (error) {
    // All inputs are synthetic; emit only stage and controlled reason.
    const reason = error?.code === 'LIFECYCLE_LEDGER_UNAVAILABLE' ? error.code
      : (/^LIFECYCLE_HOST_[A-Z_]+$/.test(error?.message ?? '') ? error.message : (error?.name === 'TypeError' ? 'TYPE_ERROR' : 'UNAVAILABLE'));
    return 'OBSIDIAN_POLICY_2E3A_FAIL: ' + stage + ' ' + reason
      + (observations ? '; ' + observations : '') + ledgerEnvironment + '; productionAdmission=UNPROVEN';
  } finally {
    for (const ref of refs) vault.offref(ref);
    for (const handle of [contention, reopened, ledger]) if (handle) await handle.close();
  }
})()
