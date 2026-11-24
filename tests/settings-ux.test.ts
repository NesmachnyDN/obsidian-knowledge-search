import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, parseSettings } from '../plugin/src/search/settings';
import { advancedDraft, ingestionDraft, needsOcr, needsStructure, probeDraft, topKDraft,
  newProviderDraft, providerDraft, embeddingSpaceChanged } from '../plugin/src/search/settings-draft';
import type { ProviderConfig } from '../plugin/src/ai/contracts';

const fixture: ProviderConfig = {
  state: 'configured', transport: 'local', origin: 'http://127.0.0.1:8765',
  identity: { model: 'synthetic-embedding', revision: 'v1' },
  limits: { timeoutMs: 1000, maxInputBytes: 2048, maxCandidates: 10, maxOutputTokens: 128, maxConcurrent: 1 },
};

test('UX-AC01/02: default view is Basic and presentation does not change enabled capabilities', () => {
  const current = defaultSettings();
  assert.equal(current.version, 6);
  assert.equal(current.presentationMode, 'basic');
  assert.equal(current.enabled, true);
  assert.equal(current.ingestion.enabled, false);
  assert.equal(current.advanced.enabled, false);
  for (const role of Object.values(current.ai)) assert.equal(role.state, 'disabled');
  const changed = parseSettings({ ...current, presentationMode: 'expert' });
  assert.deepEqual({ ...changed, presentationMode: 'basic' }, current);
  assert.deepEqual(parseSettings(changed), changed);
  assert.throws(() => parseSettings({ ...current, presentationMode: 'engineering' }));
});

test('UX-AC02/05: v5 imports without implicit opt-in, preserving hidden fields and provider models', () => {
  const current = defaultSettings();
  current.ai.reranking = fixture;
  current.ingestion.tokenizerSnapshot = '/fixture/tokenizer';
  current.advanced.profile = 'local-stdio';
  current.advanced.entry = '/fixture/entry';
  const { presentationMode: _mode, ...v5 } = current;
  const imported = parseSettings({ ...v5, version: 5 });
  assert.equal(imported.version, 6);
  assert.equal(imported.presentationMode, 'basic');
  assert.deepEqual(imported.ai.reranking, fixture);
  assert.equal(imported.ingestion.tokenizerSnapshot, '/fixture/tokenizer');
  assert.equal(imported.advanced.entry, '/fixture/entry');
  assert.equal(imported.advanced.enabled, false);
  assert.throws(() => parseSettings({ ...v5, version: 5, presentationMode: 'expert' }));
  assert.throws(() => parseSettings({ ...current, unknown: 'untrusted' }));
  assert.throws(() => parseSettings({ ...current, presentationMode: null }));
});

test('UX-AC04: Top K draft validates atomically without numeric coercion', () => {
  for (const value of ['', '0', '-1', '51', '3.5', '1e2', '1 ', 'NaN', 'Infinity', '9999999999999'])
    assert.equal(topKDraft(value).ok, false, value);
  assert.deepEqual(topKDraft('1'), { ok: true, value: 1 });
  assert.deepEqual(topKDraft('50'), { ok: true, value: 50 });
});

test('UX-AC03/04: optional health backend never enables until complete validated draft', () => {
  const draft = defaultSettings().advanced;
  assert.equal(advancedDraft(draft).ok, true);
  const before = structuredClone(draft);
  draft.enabled = true;
  assert.equal(advancedDraft(draft).ok, false);
  draft.profile = 'local-stdio';
  draft.interpreter = '/usr/bin/python3';
  draft.entry = '/fixture/health.py';
  assert.equal(advancedDraft(draft).ok, true);
  assert.equal(before.enabled, false);
  assert.equal(advancedDraft({ ...draft, entry: 'relative.py' }).ok, false);
  assert.equal(advancedDraft({ ...draft, entry: '/path\nmalicious' }).ok, false);
});

test('UX-AC03/04: OCR and structured dependencies are conditional and preserve hidden paths', () => {
  const draft = defaultSettings().ingestion;
  draft.tessdataPath = '/existing-ocr';
  draft.artifactsPath = '/existing-artifacts';
  assert.equal(ingestionDraft(draft).ok, true);
  draft.enabled = true;
  assert.equal(ingestionDraft(draft).ok, false);
  Object.assign(draft, { interpreter:'/usr/bin/python3', entry:'/fixture/advanced_ingest.py',
    tokenizerSnapshot:'/fixture/tokenizer' });
  for (const mode of ['text','ocr','structured','structured-ocr'] as const) {
    draft.pdfMode = mode;
    assert.equal(ingestionDraft(draft).ok, true);
    assert.equal(needsOcr(mode), mode.includes('ocr'));
    assert.equal(needsStructure(mode), mode.includes('structured'));
  }
  assert.equal(ingestionDraft({ ...draft, tessdataPath: '' }).ok, false);
  assert.equal(ingestionDraft({ ...draft, artifactsPath: '' }).ok, false);
  assert.equal(ingestionDraft({ ...draft, pdfMode: 'text', tessdataPath: '', artifactsPath: '' }).ok, true);
  assert.equal(draft.tessdataPath, '/existing-ocr');
  assert.equal(draft.artifactsPath, '/existing-artifacts');
});

test('UX-AC04/05: legacy probe is explicit and never required by offline search', () => {
  const p = defaultSettings().probe;
  assert.equal(probeDraft(p).ok, true);
  assert.equal(probeDraft({ ...p, fixtureMode: true }).ok, false);
  assert.equal(probeDraft({fixtureMode: true, interpreter:'/usr/bin/python3', entry:'/fixture/probe.py'}).ok, true);
});

test('UX-AC03/04/06: provider drafts are isolated and validated with no secrets', () => {
  const start = newProviderDraft({state:'disabled'});
  assert.equal(providerDraft(start).ok, false);
  Object.assign(start, { origin: fixture.origin, model: fixture.identity.model, revision: fixture.identity.revision });
  const accepted = providerDraft(start);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.ok && accepted.value.state, 'configured');
  assert.equal(newProviderDraft(fixture).maxCandidates, '10');
  for (const key of ['maxInputBytes','timeoutMs','maxCandidates','maxOutputTokens'] as const) {
    assert.equal(providerDraft({ ...start, [key]: '1.2' }).ok, false);
    assert.equal(providerDraft({ ...start, [key]: '1e3' }).ok, false);
  }
  assert.equal(providerDraft({ ...start, origin: 'http://localhost:8765' }).ok, false);
  assert.equal(providerDraft({ ...start, origin: 'http://127.0.0.1:8765/a' }).ok, false);
  assert.equal(providerDraft({ ...start, model: '' }).ok, false);
  assert.equal(providerDraft({ ...start, revision: '' }).ok, false);
  assert.equal(providerDraft({ ...start, transport: 'cloud', origin: 'https://api.example.com' }).ok, true);
  assert.equal(JSON.stringify(accepted).includes('token'), false);
});

test('UX-AC07: embedding-space identity change is visible without a rebuild side effect', () => {
  assert.equal(embeddingSpaceChanged({state:'disabled'},fixture), false);
  assert.equal(embeddingSpaceChanged(fixture,fixture), false);
  assert.equal(embeddingSpaceChanged(fixture,{...fixture,identity:{...fixture.identity,revision:'v2'}}),true);
  assert.equal(embeddingSpaceChanged(fixture,{...fixture,origin:'http://127.0.0.1:8766'}),true);
  assert.equal(embeddingSpaceChanged(fixture,{...fixture,limits:{...fixture.limits,maxCandidates:20}}),false);
});
