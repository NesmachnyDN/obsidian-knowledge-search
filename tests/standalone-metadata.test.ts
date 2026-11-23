import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../plugin/src/standalone/markdown';
import { metadataAnchor } from '../plugin/src/standalone/metadata';
import { validateRequest, matches, hash, type SearchRequest, type Predicate } from '../plugin/src/standalone/contracts';

const RAW = [
  '---', 'count: 7', 'active: true', 'tags:', '  - архитектура', '  - Design',
  '---', '# Note', 'See [[target/note|Alias]] #поиск',
  'Mention #архитектура here.', '~~~', 'Hidden #secret [[hidden|Alias]]', '~~~',
].join('\r\n');
const source = () => parseMarkdown('note.md', Buffer.from(RAW), hash('root'));
const request = (query = '', extras: Partial<SearchRequest> = {}): SearchRequest => ({
  protocolVersion: 2, requestId: 'metadata-1', requestedMode: 'lexical',
  limit: 10, query, ...extras,
});
const count: Predicate = { key: 'count', valueType: 'number', operator: 'eq', value: 7 };

test('05E-A2 strict metadata-only protocol accepts bounded filters and rejects wildcards/unknown fields', () => {
  for (const input of [request('', {predicates:[count]}),
    request('', {metadata:{tag:'#архитектура'}}),
    request('', {metadata:{linkTarget:'target/note'}}),
    request('text', {metadata:{tag:'поиск',linkTarget:'target/note'}})]) {
    assert.doesNotThrow(() => validateRequest(input));
  }
  for (const input of [request(), request(' '), request('', {metadata:{}}),
    request('', {metadata:{tag:'x x'}}), request('', {metadata:{tag:'#'}}),
    request('', {metadata:{linkTarget:'[bad]'}}),
    request('', {metadata:{linkTarget:' target'}}),
    request('', {metadata:{linkTarget:'x'.repeat(257)}}),
    request('', {metadata:{tag:'x',unknown:'key'} as SearchRequest['metadata']}),
    request('', {metadata:null as unknown as SearchRequest['metadata']}),
    request('text', {metadata:{tag:'x'.repeat(257)}})]) {
    assert.throws(() => validateRequest(input), /INVALID_REQUEST/);
  }
});

test('05E-A2 tags are exact and case-insensitive, frontmatter plus inline, fenced code excluded', () => {
  const doc = source();
  assert.equal(metadataAnchor(doc, {tag:'#DESIGN'}, [])?.originalText, 'tags:');
  assert.equal(metadataAnchor(doc, {tag:'архитектура'}, [])?.originalText, 'Mention #архитектура here.');
  assert.equal(metadataAnchor(doc, {tag:'поиск'}, [])?.originalText, 'See [[target/note|Alias]] #поиск');
  assert.equal(metadataAnchor(doc, {tag:'secret'}, []), null);
  assert.equal(metadataAnchor(doc, {tag:'not-a-tag'}, []), null);
});

test('05E-A2 only exact authored wiki-link target, never display alias or fenced source code', () => {
  const doc = source();
  assert.equal(metadataAnchor(doc, {linkTarget:'target/note'}, [])?.locator.lineStart, 9);
  assert.equal(metadataAnchor(doc, {linkTarget:'TARGET/note'}, [])?.locator.lineStart, 9);
  assert.equal(metadataAnchor(doc, {linkTarget:'Alias'}, []), null);
  assert.equal(metadataAnchor(doc, {linkTarget:'hidden'}, []), null);
  assert.equal(metadataAnchor(doc, {linkTarget:'target/note', tag:'поиск'}, [])?.locator.lineStart, 9);
  assert.equal(metadataAnchor(doc, {linkTarget:'target/note', tag:'secret'}, []), null);
});

test('05E-A2 typed Properties remain noncoercing and anchor only original metadata lines', () => {
  const doc = source();
  assert.ok(matches(doc.properties, [count]));
  assert.ok(!matches(doc.properties, [{...count, value:'7', valueType:'string'}]));
  assert.equal(metadataAnchor(doc, undefined, [count])?.originalText, 'count: 7');
  assert.equal(metadataAnchor(doc, undefined, [count])?.sourceSha256, hash(RAW));
  assert.equal(metadataAnchor(doc, undefined, [count])?.locator.lineStart, 2);
  assert.equal(metadataAnchor(doc, undefined, [{key:'tags',valueType:'list',
    operator:'contains',value:'Design'}])?.originalText, 'tags:');
  const invalid = parseMarkdown('invalid.md',
    Buffer.from('---\ntags: [not json]\n---\n# Still a note'), hash('root'));
  assert.deepEqual(invalid.properties, []);
  assert.equal(metadataAnchor(invalid, {tag:'not'}, []), null);
});
