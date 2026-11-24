// Evaluated in the real isolated Obsidian host to establish a fresh command-navigation precondition.
// Settings acceptance intentionally invalidates prior results; never reuse a stale search hit.
(async () => {
  const p = app.plugins.plugins['oks-synthetic-evidence'];
  const assert = (condition, reason) => { if (!condition) throw Error('HOST_SOURCE_' + reason); };
  assert(p && process.env.tmp && app.vault.adapter.getBasePath() === process.env.tmp + '/vault', 'SYNTHETIC_ONLY');
  const view = app.workspace.getLeavesOfType('oks-standalone-search')[0]?.view;
  assert(view?.contentEl?.isConnected, 'SEARCH_VIEW_MISSING');
  const query = view.contentEl.querySelector('.oks-query');
  const submit = view.contentEl.querySelector('.oks-submit');
  assert(query && submit, 'SEARCH_CONTROLS_MISSING');
  query.value = 'REQ-OKS-SMOKE';
  query.dispatchEvent(new Event('input', { bubbles: true }));
  submit.click();
  const deadline = Date.now() + 6000;
  let state;
  do {
    state = p.searchController.snapshot();
    if (state.phase === 'results' || state.phase === 'error') break;
    assert(Date.now() < deadline, 'SEARCH_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (true);
  const file = app.vault.getAbstractFileByPath('first.md');
  assert(file, 'SOURCE_NOT_FOUND');
  const bytes = await app.vault.readBinary(file);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const expectedSha = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const hit = state.response?.hits[0];
  assert(state.phase === 'results' && state.response?.status === 'ok' &&
    state.response.hits.length === 1 && hit?.sourceId === 'first.md' &&
    hit?.sourceSha256 === expectedSha &&
    hit?.originalExcerpt.includes('REQ-OKS-SMOKE: local only.') &&
    hit?.sourceLocators[0]?.lineStart === 2, 'SEARCH_EVIDENCE_'+JSON.stringify({phase:state.phase,status:state.response?.status,hits:state.response?.hits.length,path:hit?.sourceId,shaMatches:hit?.sourceSha256===expectedSha,excerpt:hit?.originalExcerpt?.slice(0,50)}));
  return 'OBSIDIAN_HOST_COMMAND_SOURCE_READY: real UI search, first.md original evidence and hash verified';
})()
