import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFrame, encodeFrame, isRequest, isResponse, verifyResponse, firstMatch, type Request } from '../plugin/src/protocol';
const cases = JSON.parse(readFileSync('contracts/fixtures/cases.json', 'utf8')) as {name:string; kind:string; valid:boolean; value:unknown}[];
for (const c of cases) test(`shared ${c.kind}: ${c.name}`, () => {
  assert.equal((c.kind === 'request' ? isRequest : isResponse)(c.value), c.valid);
});
const request = cases[0]!.value as Request;
test('framing rejects malformed, extra, oversized, invalid UTF-8 and missing newline', () => {
  for (const value of [Buffer.from('{}'), Buffer.from('{}\n{}\n'), Buffer.alloc(65537), Buffer.from([255,10]), Buffer.from('{\n')]) assert.throws(() => decodeFrame(value));
  assert.deepEqual(decodeFrame(encodeFrame(request)), request);
});
test('evidence verification rejects forged locator, excerpt, digest, source and identity', () => {
  const response = cases[1]!.value as any;
  verifyResponse(response, request);
  for (const key of ['line','excerpt','digest','sourceId']) {
    const copy = structuredClone(response); copy.evidence[key] = key === 'line' ? 1 : 'wrong';
    assert.throws(() => verifyResponse(copy, request));
  }
  assert.throws(() => verifyResponse({...response,id:'wrong'}, request));
  assert.throws(() => verifyResponse({...response,evidence:null}, request));
  assert.deepEqual(firstMatch('a\r\nb\rc\n', 'b'), {line:2,excerpt:'b'});
});
const wireCases = JSON.parse(readFileSync('contracts/fixtures/wire-cases.json', 'utf8')) as {name:string; kind:string; frame:string; valid:boolean}[];
for (const c of wireCases) test(`shared wire ${c.kind}: ${c.name}`, () => {
  let valid = false;
  try { valid = (c.kind === 'request' ? isRequest : isResponse)(decodeFrame(Buffer.from(c.frame))); } catch { /* rejected wire */ }
  assert.equal(valid, c.valid);
});
test('exact shapes reject every missing/extra field and comma-joined key collision', () => {
  for (const c of cases.filter(c => c.valid)) {
    const value = c.value as Record<string, unknown>;
    const validator = c.kind === 'request' ? isRequest : isResponse;
    for (const key of Object.keys(value)) {
      const copy = {...value}; delete copy[key]; assert.equal(validator(copy), false);
    }
    assert.equal(validator({...value, extra: null}), false);
  }
  assert.equal(isRequest({version:1, 'id,method':'x', source:request.source, query:request.query}), false);
});
