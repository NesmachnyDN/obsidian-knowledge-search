import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPr } from '../scripts/ci-pr-contract.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const body = `Base develop SHA: ${sha}
Validation: npm test passed
Privacy: no source, secret or Vault egress
Independent review: pending separate reviewer`;
function event({ draft = false, text = body, base = 'develop', sender = 'maintainer' } = {}) {
  return { sender: { login: sender }, pull_request: { base: { ref: base }, draft, body: text } };
}
test('ready handoff with full metadata passes mechanical gate', () => {
  const result = inspectPr(event());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});
test('ready handoff missing evidence fails', () => {
  const result = inspectPr(event({ text: 'Changes made' }));
  assert.ok(result.errors.length >= 4);
});
test('draft handoff is advisory', () => {
  const result = inspectPr(event({ draft: true, text: '' }));
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.length > 0);
});
test('dependabot PR and unrelated branch are skipped', () => {
  assert.equal(inspectPr(event({ sender: 'dependabot[bot]' })).skipped, true);
  assert.equal(inspectPr(event({ base: 'main' })).skipped, true);
});
test('default PR template is not treated as completed evidence', () => {
  const result = inspectPr(event({ text: 'Describe bounded implementation, decisions and non-goals.' }));
  assert.ok(result.errors.some((error) => error.includes('template')));
});
