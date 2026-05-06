import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KimiClient } from '../src/kimi-client.js';

test('cancel sends cancel JSON-RPC line during hanging turn', async () => {
  const client = new KimiClient({ args: ['--wire'] });
  client._skipInitialize = true;
  const log = [];
  let promptId = null;
  client._installFakeTransport({
    write: (line) => {
      const msg = JSON.parse(line.trim());
      log.push(msg);
      queueMicrotask(() => {
        if (msg.method === 'cancel') {
          client._onLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
          if (promptId !== null) {
            client._onLine(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { status: 'cancelled' } }));
          }
        } else if (msg.method === 'prompt') {
          promptId = msg.id;
        }
      });
    },
  });

  const ac = new AbortController();
  ac.signal.addEventListener('abort', () => client.cancel());

  const turnPromise = client.runTurn({ userInput: 'hi', planMode: false });

  await new Promise((r) => setTimeout(r, 10));
  assert.ok(log.some((m) => m.method === 'prompt'), 'prompt was sent');

  ac.abort();

  await turnPromise;

  assert.ok(log.some((m) => m.method === 'cancel'), 'cancel was sent');
});
