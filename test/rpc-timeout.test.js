import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KimiClient } from '../src/kimi-client.js';

test('RPC idle timeout kills client and rejects pending when kimi is silent', async () => {
  const client = new KimiClient({ args: ['--wire'] });
  client._skipInitialize = true;
  client._installFakeTransport({ write: () => {} });
  const promise = client._call('prompt', { user_input: 'x' }, { timeoutMs: 50 });
  await assert.rejects(promise, /timeout/i);
  assert.equal(client.dead, true);
});

test('streaming events refresh idle timer so long-running prompt is not killed', async () => {
  const client = new KimiClient({ args: ['--wire'] });
  client._skipInitialize = true;
  client._installFakeTransport({ write: () => {} });

  const idleCap = 80; // ms
  const promise = client._call('prompt', { user_input: 'x' }, { timeoutMs: idleCap });

  // Stream notifications every 30ms for ~250ms total — well past idleCap, but
  // each one must refresh the timer so the call stays alive.
  const interval = setInterval(() => {
    client._onLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'ContentPart', payload: { type: 'text', text: '.' } },
    }));
  }, 30);

  // After 250ms (> 3 × idleCap), deliver the response.
  setTimeout(() => {
    clearInterval(interval);
    const id = [...client.pending.keys()][0];
    client._onLine(JSON.stringify({ jsonrpc: '2.0', id, result: { status: 'ok' } }));
  }, 250);

  const result = await promise;
  assert.equal(result.status, 'ok');
  assert.equal(client.dead, false);
});
