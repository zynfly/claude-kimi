import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KimiPool } from '../src/kimi-client.js';

function fakeClient() {
  // Minimal stand-in matching the few KimiClient surfaces the pool touches.
  let dead = false;
  return {
    get dead() { return dead; },
    shutdown() { dead = true; },
    cancel: async () => {},
    pending: new Map(),
  };
}

function withFakeClient(pool, key) {
  // Inject a fake bucket so we don't spawn real kimi.
  const entry = { client: fakeClient() };
  pool.buckets.set(key, entry);
  return entry;
}

test('one bucket per work_dir; same workDir returns same entry', () => {
  const p = new KimiPool();
  const e1 = withFakeClient(p, '/a');
  const e2 = p.peek('/a');
  assert.equal(e1, e2);
  p.shutdownAll();
});

test('peek returns null for unknown work_dir', () => {
  const p = new KimiPool();
  assert.equal(p.peek('/missing'), null);
  p.shutdownAll();
});

test('peek auto-cleans dead bucket', () => {
  const p = new KimiPool();
  const e = withFakeClient(p, '/a');
  e.client.shutdown(); // mark dead
  assert.equal(p.peek('/a'), null);
  assert.equal(p.buckets.has('/a'), false);
  p.shutdownAll();
});

test('reset({workDir}) kills only that bucket', () => {
  const p = new KimiPool();
  const a = withFakeClient(p, '/a');
  const b = withFakeClient(p, '/b');
  const n = p.reset({ workDir: '/a' });
  assert.equal(n, 1);
  assert.equal(a.client.dead, true);
  assert.equal(b.client.dead, false);
  assert.equal(p.buckets.has('/a'), false);
  assert.equal(p.buckets.has('/b'), true);
  p.shutdownAll();
});

test('reset() with no args kills all buckets', () => {
  const p = new KimiPool();
  const a = withFakeClient(p, '/a');
  const b = withFakeClient(p, '/b');
  const n = p.reset();
  assert.equal(n, 2);
  assert.equal(a.client.dead, true);
  assert.equal(b.client.dead, true);
  assert.equal(p.buckets.size, 0);
  p.shutdownAll();
});

test('reset({workDir}) returns 0 when bucket does not exist', () => {
  const p = new KimiPool();
  assert.equal(p.reset({ workDir: '/no-such' }), 0);
  p.shutdownAll();
});

test('_buildArgs: always the acp subcommand', () => {
  const p = new KimiPool();
  assert.deepEqual(p._buildArgs(), ['acp']);
  p.shutdownAll();
});
