import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KimiClient } from '../src/kimi-client.js';

const SKIP = !process.env.KIMI_LIVE_TEST;

test('live ACP end-to-end: PONG prompt', { skip: SKIP && 'set KIMI_LIVE_TEST=1 to run' }, async () => {
  const client = new KimiClient({ args: ['acp'], cwd: process.cwd() });
  try {
    const result = await client.runTurn({
      userInput: 'Reply with exactly: PONG',
      planMode: false,
    });
    assert.equal(result.status, 'finished');
    assert.ok(result.text.includes('PONG'), `expected PONG in response, got: ${result.text.slice(0, 200)}`);
  } finally {
    client.shutdown();
  }
});
