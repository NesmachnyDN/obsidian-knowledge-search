import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsLocale, translateSettings, formatSettings, localizeSettingsState }
  from '../plugin/src/search/settings-i18n';
import { defaultSettings } from '../plugin/src/search/settings';

test('UX-L10N-01: settings follow Obsidian language, not OS or stored plugin preferences', () => {
  for (const language of ['ru', 'ru-RU', 'RU_ru'])
    assert.equal(settingsLocale(language), 'ru', language);
  for (const language of ['en', 'en-US', 'de', 'uk', '', 'be'])
    assert.equal(settingsLocale(language), 'en', language);
  assert.equal(translateSettings('Settings view', 'ru'), 'Режим отображения настроек');
  assert.equal(translateSettings('Settings view', 'en'), 'Settings view');
  assert.equal(translateSettings('Settings view', 'de'), 'Settings view');
  assert.equal(translateSettings('Configure documents', 'ru-RU'), 'Настроить обработку документов');
  assert.equal(translateSettings('Cancel draft', 'ru'), 'Отменить изменения');
  assert.equal(translateSettings('Cloud HTTPS (authorization required)', 'ru'), 'Облачный HTTPS (требуется разрешение)');
  assert.equal(translateSettings('Embedding space change', 'ru'), 'Изменение пространства эмбеддингов');
  assert.equal(translateSettings('Close editor', 'ru'), 'Закрыть редактор');
  assert.equal(translateSettings('Refresh', 'en'), 'Refresh');
});

test('UX-L10N-02: status and validation messages translate without modifying raw diagnostics', () => {
  const values = {status: localizeSettingsState('ready', 'ru'), enabled: translateSettings('enabled', 'ru'),
    paused: translateSettings('not paused', 'ru'), error: 'SOURCE_NOT_READY'};
  const message = formatSettings('Status: {status}; {enabled}; {paused}; error: {error}.', values, 'ru');
  assert.equal(message, 'Состояние: готов; включён; не приостановлен; ошибка: SOURCE_NOT_READY.');
  assert.equal(formatSettings('Failed or cancelled: {error}. Offline search remains separate.',
    {error:'PERMISSION_DENIED'}, 'ru'),
    'Ошибка или отмена: PERMISSION_DENIED. Автономный поиск работает независимо.');
  assert.equal(translateSettings('Enter an absolute trusted local path.', 'ru'),
    'Укажите абсолютный доверенный локальный путь.');
  assert.equal(translateSettings('Could not save. The unsaved draft is retained; retry or cancel.', 'ru'),
    'Не удалось сохранить. Несохранённые изменения сохранены: повторите попытку или отмените.');
  assert.equal(translateSettings('constructor', 'ru'), 'constructor');
  assert.equal(translateSettings('__proto__', 'ru'), '__proto__');
});

test('UX-L10N-03: presentation language does not persist or mutate capability preferences', () => {
  const settings = defaultSettings();
  settings.ai.reranking = {state:'disabled'};
  settings.presentationMode = 'expert';
  const before = structuredClone(settings);
  for (const language of ['ru', 'en', 'ru-RU', 'de']) {
    assert.ok(translateSettings('Provider state', language).length);
    assert.ok(formatSettings('OKS: cleared {count} derived files.', {count: 2}, language).length);
    assert.deepEqual(settings, before);
  }
});
