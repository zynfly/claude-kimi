import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KimiClient } from '../src/kimi-client.js';

test('cancel sends session/cancel JSON-RPC line during hanging turn', async () => {
  const client = new KimiClient({ args: ['acp'] });
  client._skipInitialize = true;
  const log = [];
  let promptId = null;
  client._installFakeTransport({
    write: (line) => {
      const msg = JSON.parse(line.trim());
      log.push(msg);
      queueMicrotask(() => {
        if (msg.method === 'session/cancel') {
          // ACP cancel is a notification; the agent ends the turn by resolving
          // the in-flight session/prompt with stopReason='cancelled'.
          if (promptId !== null) {
            client._onLine(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } }));
          }
        } else if (msg.method === 'session/prompt') {
          promptId = msg.id;
        }
      });
    },
  });

  const ac = new AbortController();
  ac.signal.addEventListener('abort', () => client.cancel());

  const turnPromise = client.runTurn({ userInput: 'hi', planMode: false });

  await new Promise((r) => setTimeout(r, 10));
  assert.ok(log.some((m) => m.method === 'session/prompt'), 'prompt was sent');

  ac.abort();

  const r = await turnPromise;
  assert.equal(r.status, 'cancelled');
  assert.ok(log.some((m) => m.method === 'session/cancel'), 'cancel was sent');
});
