import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// These tests cover the two crash paths reported as "the plugin just exits":
// an unhandled 'error' event on the child process (spawn ENOENT) or on its
// stdin socket (EPIPE racing child death) kills the whole MCP server process.
// Without the fix, the test *process* itself crashes here.
process.env.KIMI_BIN = '/nonexistent/kimi-binary-for-test';
const { KimiClient } = await import('../src/kimi-client.js');

test('spawn failure rejects runTurn instead of crashing the process', async () => {
  const c = new KimiClient({ args: ['acp'], cwd: '/tmp' });
  await assert.rejects(
    () => c.runTurn({ userInput: 'hello' }),
    /not found|ENOENT|failed to start/i,
  );
  assert.equal(c.dead, true, 'client must be marked dead so the pool respawns');
});

test('stdin EPIPE racing child death does not crash the process', async () => {
  const c = new KimiClient({});
  // Wire a real child through the same handler setup _start() uses.
  c.proc = spawn('/bin/cat', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  c._wireProc(c.proc);
  c.sessionId = 's';
  // Kill hard, then write before the 'exit' event has fired — the write hits a
  // broken pipe and emits 'error' on the stdin socket.
  c.proc.kill('SIGKILL');
  try { c.proc.stdin.write('x\n'); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  // Surviving to this line is the assertion: no unhandled 'error' crash.
  assert.equal(c.dead, true, 'client must be marked dead after the child died');
});
