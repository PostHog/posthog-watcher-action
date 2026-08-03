import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transform } from 'esbuild';

const { code } = await transform(readFileSync('src/review-gate-schema.ts', 'utf8'), { loader: 'ts', format: 'esm' });
const { parseReviewGate } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

const response = (overrides = {}) => JSON.stringify({
  approve: true,
  substantiveFix: true,
  confidence: 0.95,
  reason: 'The diff directly fixes the issue.',
  risks: [],
  ...overrides,
});

test('issue fix reviews require an explicit substantive fix', () => {
  assert.equal(parseReviewGate(response({ substantiveFix: false }), true).approve, false);
  assert.equal(parseReviewGate(JSON.stringify({ approve: true, confidence: 0.95, reason: 'Looks safe.', risks: [] }), true).approve, false);
});

test('issue fix reviews accept an explicitly substantive source or docs fix', () => {
  const result = parseReviewGate(response(), true);

  assert.equal(result.approve, true);
  assert.equal(result.substantiveFix, true);
});

test('PR repair reviews do not require a substantive issue fix attestation', () => {
  const result = parseReviewGate(response({ substantiveFix: false }), false);

  assert.equal(result.approve, true);
  assert.equal(result.substantiveFix, false);
});
