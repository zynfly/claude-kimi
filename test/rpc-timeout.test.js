import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KimiClient } from '../src/kimi-client.js';

test('RPC timeout kills client and rejects pending', async () => {
  const client = new KimiClient({ args: ['--wire'] });
  client._skipInitialize = true;
  client._installFakeTransport({ write: () => {} });
  const promise = client._call('prompt', { user_input: 'x' }, { timeoutMs: 50 });
  await assert.rejects(promise, /timeout/i);
  assert.equal(client.dead, true);
});
