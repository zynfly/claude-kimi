import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAndValidateFile, resolveAndValidateDir, isInside } from '../src/paths.js';

const tmp = mkdtempSync(join(tmpdir(), 'kimi-paths-'));
const workDir = join(tmp, 'project');
mkdirSync(workDir);
const outerFile = join(tmp, 'memory.md');
writeFileSync(outerFile, 'memory content');
const innerFile = join(workDir, 'src.txt');
writeFileSync(innerFile, 'in workdir');
const outerDir = join(tmp, 'extras');
mkdirSync(outerDir);
const symlinkInsideToOuter = join(workDir, 'link-out.md');
symlinkSync(outerFile, symlinkInsideToOuter);
const symlinkOutsideToInner = join(tmp, 'link-in.md');
symlinkSync(innerFile, symlinkOutsideToInner);

test('resolveAndValidateFile: rejects relative path', () => {
  assert.throws(() => resolveAndValidateFile('relative.md', workDir), /must be absolute/);
});

test('resolveAndValidateFile: rejects non-existent path', () => {
  assert.throws(() => resolveAndValidateFile(join(tmp, 'nope.md'), workDir), /does not exist/);
});

test('resolveAndValidateFile: rejects directory', () => {
  assert.throws(() => resolveAndValidateFile(outerDir, workDir), /not a regular file/);
});

test('resolveAndValidateFile: rejects file inside work_dir', () => {
  assert.throws(() => resolveAndValidateFile(innerFile, workDir), /inside work_dir/);
});

test('resolveAndValidateFile: rejects symlink whose realpath lands inside work_dir', () => {
  assert.throws(() => resolveAndValidateFile(symlinkOutsideToInner, workDir), /inside work_dir/);
});

test('resolveAndValidateFile: accepts symlink in work_dir whose realpath is outside', () => {
  const r = resolveAndValidateFile(symlinkInsideToOuter, workDir);
  assert.equal(r.realpath, realpathSync.native(outerFile));
  assert.equal(r.bytes, 'memory content'.length);
});

test('resolveAndValidateFile: accepts genuine external file', () => {
  const r = resolveAndValidateFile(outerFile, workDir);
  assert.equal(r.realpath, realpathSync.native(outerFile));
  assert.equal(r.bytes, 'memory content'.length);
});

test('isInside: /repo vs /repo2 not confused', () => {
  assert.equal(isInside('/repo2/foo', '/repo'), false);
  assert.equal(isInside('/repo/foo', '/repo'), true);
  assert.equal(isInside('/repo', '/repo'), false);
});

test('resolveAndValidateDir: rejects file', () => {
  assert.throws(() => resolveAndValidateDir(outerFile), /not a directory/);
});

test('resolveAndValidateDir: accepts directory', () => {
  const r = resolveAndValidateDir(outerDir);
  assert.equal(r.realpath, realpathSync.native(outerDir));
});

test('resolveAndValidateDir: rejects relative path', () => {
  assert.throws(() => resolveAndValidateDir('./foo'), /must be absolute/);
});
