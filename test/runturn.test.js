import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KimiClient } from '../src/kimi-client.js';

// In ACP, plan/yolo is set via `session/set_config_option {configId:'mode'}`,
// and a turn is `session/prompt` streaming `session/update` then resolving with
// `{stopReason}`. _skipInitialize bypasses _start (no real initialize/
// session/new), so runTurn prompts against the fake 'fake-session' id.
function mkFakeKimi({ planModeFails = false, resetFails = false, promptHangs = false } = {}) {
  const client = new KimiClient({ args: ['acp'] });
  client._skipInitialize = true;
  const log = [];
  client._installFakeTransport({
    write: (line) => {
      const msg = JSON.parse(line.trim());
      log.push({ method: msg.method, params: msg.params });
      queueMicrotask(() => {
        if (msg.method === 'session/set_config_option') {
          const enabling = msg.params?.value === 'plan';
          if (enabling && planModeFails) {
            client._onLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'plan_mode unsupported' } }));
            return;
          }
          if (!enabling && resetFails) {
            client._onLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'reset failed' } }));
            return;
          }
          client._onLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } }));
        } else if (msg.method === 'session/prompt') {
          if (promptHangs) return;
          client._onLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } }));
          client._onLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }));
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
  assert.equal(r.text, 'hi');
  assert.deepEqual(log.map(l => l.method), ['session/prompt']);
});

test('runTurn(planMode=true): enable, prompt, reset', async () => {
  const { client, log } = mkFakeKimi();
  const r = await client.runTurn({ userInput: 'hi', planMode: true });
  assert.equal(r.status, 'finished');
  assert.deepEqual(log.map(l => l.method), ['session/set_config_option', 'session/prompt', 'session/set_config_option']);
  assert.equal(log[0].params.value, 'plan');
  assert.equal(log[2].params.value, 'yolo');
});

test('runTurn aborts when plan_mode enable fails — no prompt sent, bucket dead', async () => {
  const { client, log } = mkFakeKimi({ planModeFails: true });
  await assert.rejects(client.runTurn({ userInput: 'hi', planMode: true }), /plan_mode/);
  assert.deepEqual(log.map(l => l.method), ['session/set_config_option']);
  assert.equal(client.dead, true);
});

test('runTurn returns success even when reset fails, but kills bucket', async () => {
  const { client, log } = mkFakeKimi({ resetFails: true });
  const r = await client.runTurn({ userInput: 'hi', planMode: true });
  assert.equal(r.status, 'finished');
  assert.deepEqual(log.map(l => l.method), ['session/set_config_option', 'session/prompt', 'session/set_config_option']);
  assert.equal(client.dead, true);
});

test('runTurn: same-bucket back-to-back calls are serialized', async () => {
  const { client, log } = mkFakeKimi();
  const a = client.runTurn({ userInput: 'first', planMode: true });
  const b = client.runTurn({ userInput: 'second', planMode: false });
  await Promise.all([a, b]);
  assert.deepEqual(log.map(l => l.method), ['session/set_config_option', 'session/prompt', 'session/set_config_option', 'session/prompt']);
  assert.equal(log[1].params.prompt[0].text, 'first');
  assert.equal(log[3].params.prompt[0].text, 'second');
});
