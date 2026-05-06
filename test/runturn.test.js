import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KimiClient } from '../src/kimi-client.js';

function mkFakeKimi({ planModeFails = false, resetFails = false, promptHangs = false } = {}) {
  const client = new KimiClient({ args: ['--wire'] });
  client._skipInitialize = true;
  const log = [];
  client._installFakeTransport({
    write: (line) => {
      const msg = JSON.parse(line.trim());
      log.push({ method: msg.method, params: msg.params });
      queueMicrotask(() => {
        if (msg.method === 'set_plan_mode') {
          const enabling = msg.params?.enabled === true;
          if (enabling && planModeFails) {
            client._onLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'plan_mode unsupported' } }));
            return;
          }
          if (!enabling && resetFails) {
            client._onLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'reset failed' } }));
            return;
          }
          client._onLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok', plan_mode: enabling } }));
        } else if (msg.method === 'prompt') {
          if (promptHangs) return;
          client._onLine(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'ContentPart', payload: { type: 'text', text: 'hi' } } }));
          client._onLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'finished' } }));
        }
      });
    },
  });
  return { client, log };
}

test('runTurn(planMode=false): just prompts', async () => {
  const { client, log } = mkFakeKimi();
  const r = await client.runTurn({ userInput: 'hi', planMode: false });
  assert.equal(r.status, 'finished');
  assert.deepEqual(log.map(l => l.method), ['prompt']);
});

test('runTurn(planMode=true): enable, prompt, reset', async () => {
  const { client, log } = mkFakeKimi();
  const r = await client.runTurn({ userInput: 'hi', planMode: true });
  assert.equal(r.status, 'finished');
  assert.deepEqual(log.map(l => l.method), ['set_plan_mode', 'prompt', 'set_plan_mode']);
  assert.equal(log[0].params.enabled, true);
  assert.equal(log[2].params.enabled, false);
});

test('runTurn aborts when plan_mode enable fails — no prompt sent, bucket dead', async () => {
  const { client, log } = mkFakeKimi({ planModeFails: true });
  await assert.rejects(client.runTurn({ userInput: 'hi', planMode: true }), /plan_mode/);
  assert.deepEqual(log.map(l => l.method), ['set_plan_mode']);
  assert.equal(client.dead, true);
});

test('runTurn returns success even when reset fails, but kills bucket', async () => {
  const { client, log } = mkFakeKimi({ resetFails: true });
  const r = await client.runTurn({ userInput: 'hi', planMode: true });
  assert.equal(r.status, 'finished');
  assert.deepEqual(log.map(l => l.method), ['set_plan_mode', 'prompt', 'set_plan_mode']);
  assert.equal(client.dead, true);
});

test('runTurn: same-bucket back-to-back calls are serialized', async () => {
  const { client, log } = mkFakeKimi();
  const a = client.runTurn({ userInput: 'first', planMode: true });
  const b = client.runTurn({ userInput: 'second', planMode: false });
  await Promise.all([a, b]);
  assert.deepEqual(log.map(l => l.method), ['set_plan_mode', 'prompt', 'set_plan_mode', 'prompt']);
  assert.equal(log[1].params.user_input, 'first');
  assert.equal(log[3].params.user_input, 'second');
});
