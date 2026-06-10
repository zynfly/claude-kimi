import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KimiPool } from '../src/kimi-client.js';

function fakeClient() {
  let dead = false;
  return {
    get dead() { return dead; },
    shutdown() { dead = true; },
    cancel: async () => {},
    pending: new Map(),
  };
}

// ask_kimi keys the pool on the work_dir's realpath, but reset_kimi/cancel_kimi
// pass the caller's raw path. On macOS /tmp → /private/tmp, so a symlinked
// work_dir silently matched nothing: "reset: killed 0 kimi process(es)".
test('peek/reset find the bucket via a symlinked work_dir path', () => {
  const real = mkdtempSync(join(tmpdir(), 'kimi-pool-key-'));
  const link = `${real}-link`;
  symlinkSync(real, link);
  try {
    const p = new KimiPool();
    const realKey = realpathSync.native(real); // what handleAsk stores under
    const entry = { client: fakeClient() };
    p.buckets.set(realKey, entry);

    assert.equal(p.peek(link), entry, 'peek must resolve symlink to the bucket key');
    assert.equal(p.reset({ workDir: link }), 1, 'reset must kill the bucket behind the symlink');
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test('reset by raw key still works when the directory no longer exists', () => {
  const p = new KimiPool();
  const gone = '/no/such/dir/for-kimi-pool-test';
  p.buckets.set(gone, { client: fakeClient() });
  assert.equal(p.reset({ workDir: gone }), 1, 'unresolvable path must fall back to raw key');
});
