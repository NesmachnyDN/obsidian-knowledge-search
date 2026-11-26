import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsLocale, translateSettings, formatSettings, localizeSettingsState, type SettingsDisplayState }
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
  assert.equal(translateSettings('Synthetic fixture only; no actual model verified.', 'ru'), 'Только синтетические тестовые данные; реальная модель не проверена.');
  assert.equal(translateSettings('Synthetic fixture only; no actual model verified.', 'en'), 'Synthetic fixture only; no actual model verified.');
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


test('UX-L10N-04: all typed Settings states have Russian labels and preserve English fallback', () => {
  const expected = {
    initializing: 'инициализация', ready: 'готов', degraded: 'ограниченная работоспособность',
    failed: 'ошибка', unavailable: 'недоступен', disabled: 'отключён',
    none: 'нет', 'local-stdio': 'локальный stdio', running: 'выполняется',
    partial: 'частично обработано', empty: 'нет содержимого', unsupported: 'не поддерживается',
    indexing: 'индексация', indexed: 'проиндексировано', searching: 'выполняется поиск',
    'not-ready': 'не готов', ok: 'успешно', lexical: 'лексический',
    dense: 'семантический', hybrid: 'гибридный',
  } satisfies Record<SettingsDisplayState, string>;
  for (const [state, ru] of Object.entries(expected)) {
    assert.equal(localizeSettingsState(state, 'ru'), ru, state);
    assert.equal(localizeSettingsState(state, 'ru-RU'), ru, state);
    assert.equal(localizeSettingsState(state, 'en'), state);
    assert.equal(localizeSettingsState(state, 'de'), state);
  }
  for (const code of ['SOURCE_STALE', 'PERMISSION_DENIED', 'ADVANCED_TIMEOUT',
    'RECONCILING', 'INDEX_DURABILITY_UNCERTAIN', 'constructor', '__proto__'])
    assert.equal(localizeSettingsState(code, 'ru'), code);
  const navigation = translateSettings('Index readiness and coverage are not verified in Settings. Use Open Standalone search → Optional local API dense / hybrid search → Prepare explicit dense index rebuild. Select exact corpus paths and vector dimension, then authorize the operation. No automatic rebuild.', 'ru');
  for (const label of ['Open Standalone search', 'Optional local API dense / hybrid search',
    'Prepare explicit dense index rebuild']) assert.ok(navigation.includes(label));
});

test('CHECK-01: connection check labels and typed errors are localized without translating diagnostic codes', () => {
  assert.equal(translateSettings('Check','ru'),'Проверка');
  assert.equal(translateSettings('Check','en'),'Check');
  assert.equal(translateSettings('Checking connection…','ru'),'Проверка выполняется…');
  const reason=translateSettings('Authentication failed. Check the bearer token.','ru');
  const message=formatSettings('Check failed ({ms} ms): {reason} ({code})',
    {ms:120,reason,code:'UNAUTHENTICATED'},'ru');
  assert.equal(message,'Ошибка проверки (120 мс): Ошибка авторизации. Проверьте bearer-токен. (UNAUTHENTICATED)');
});

test('06B.2c graph settings distinguish saved mapping from verified readiness in RU/EN',()=>{
  assert.equal(translateSettings('Local knowledge graph','ru'),'Локальный граф знаний');
  assert.equal(translateSettings('Disable graph','ru'),'Отключить граф');
  assert.equal(translateSettings('Graph mapping configured; readiness not verified.','ru'),'Конфигурация графа сохранена; готовность не проверена.');
  assert.equal(translateSettings('Graph mapping (JSON)','de'),'Graph mapping (JSON)');
});
