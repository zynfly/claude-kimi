import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composePrompt } from '../src/compose.js';

const tmp = mkdtempSync(join(tmpdir(), 'kimi-compose-'));
const workDir = join(tmp, 'wd');
mkdirSync(workDir);
const memoryFile = join(tmp, 'memory.md');
writeFileSync(memoryFile, 'remember: hello world');
const specFile = join(tmp, 'spec.md');
writeFileSync(specFile, '# Spec\nbuild a thing');

test('minimal goal+work_dir', () => {
  const out = composePrompt({ goal: 'do the thing', work_dir: workDir });
  assert.match(out, /^# Goal\ndo the thing/);
  assert.ok(out.includes(`# Working directory (read/write)\n${workDir}`));
});

test('rejects empty goal', () => {
  assert.throws(() => composePrompt({ goal: '   ', work_dir: workDir }), /goal/);
});

test('rejects missing work_dir', () => {
  assert.throws(() => composePrompt({ goal: 'x' }), /work_dir/);
});

test('rejects relative work_dir', () => {
  assert.throws(() => composePrompt({ goal: 'x', work_dir: 'rel' }), /absolute/);
});

test('inlines memory file with role label and bytes', () => {
  const out = composePrompt({ goal: 'g', work_dir: workDir, memory_files: [memoryFile] });
  assert.ok(out.includes(`[external_file role=memory path=${memoryFile} bytes=21]`));
  assert.match(out, /remember: hello world/);
  assert.match(out, /\[\/external_file\]/);
});

test('multiple roles render in order: spec, plan, memory, context', () => {
  const out = composePrompt({
    goal: 'g',
    work_dir: workDir,
    memory_files: [memoryFile],
    spec_files: [specFile],
  });
  const specIdx = out.indexOf('role=spec');
  const memIdx = out.indexOf('role=memory');
  assert.ok(specIdx > 0 && memIdx > specIdx, 'spec before memory');
});

test('constraints and expected_output sections appear', () => {
  const out = composePrompt({
    goal: 'g',
    work_dir: workDir,
    constraints: ['no deps', 'no comments'],
    expected_output: 'unified diff',
  });
  assert.match(out, /# Constraints\n- no deps\n- no comments/);
  assert.match(out, /# Expected output\nunified diff/);
});

test('rejects single file over KIMI_MAX_FILE_BYTES', () => {
  const big = join(tmp, 'big.md');
  writeFileSync(big, 'x'.repeat(200_001));
  assert.throws(
    () => composePrompt({ goal: 'g', work_dir: workDir, memory_files: [big] }),
    /KIMI_MAX_FILE_BYTES/
  );
});

test('rejects total over KIMI_MAX_TOTAL_BYTES', () => {
  process.env.KIMI_MAX_FILE_BYTES = '5000';
  process.env.KIMI_MAX_TOTAL_BYTES = '7000';
  const a = join(tmp, 'a.md');
  const b = join(tmp, 'b.md');
  writeFileSync(a, 'a'.repeat(4000));
  writeFileSync(b, 'b'.repeat(4000));
  try {
    assert.throws(
      () => composePrompt({ goal: 'g', work_dir: workDir, memory_files: [a, b] }),
      /KIMI_MAX_TOTAL_BYTES/
    );
  } finally {
    delete process.env.KIMI_MAX_FILE_BYTES;
    delete process.env.KIMI_MAX_TOTAL_BYTES;
  }
});
