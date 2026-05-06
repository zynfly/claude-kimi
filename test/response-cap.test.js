import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateResponse } from '../src/kimi-client.js';

test('truncateResponse returns original text when under cap', () => {
  const r = truncateResponse('hello', 100);
  assert.equal(r.text, 'hello');
  assert.equal(r.truncated, false);
});

test('truncateResponse truncates and appends marker when over cap', () => {
  const text = 'a'.repeat(500);
  const cap = 100;
  const r = truncateResponse(text, cap);
  assert.equal(r.truncated, true);
  assert.ok(r.text.includes('[kimi response truncated from 500 to 100 chars by KIMI_MAX_RESPONSE_BYTES]'));
  assert.ok(r.text.length > cap);
});

test('truncateResponse preserves exact cap chars before marker', () => {
  const text = 'x'.repeat(200);
  const cap = 50;
  const r = truncateResponse(text, cap);
  const beforeMarker = r.text.split('\n\n')[0];
  assert.equal(beforeMarker, 'x'.repeat(50));
});
