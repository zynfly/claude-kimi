#!/usr/bin/env node
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KimiPool } from '../src/kimi-client.js';
import { composePrompt } from '../src/compose.js';

const pool = new KimiPool();

async function smoke() {
  const tmp = mkdtempSync(join(tmpdir(), 'kimi-smoke-'));
  const workDir = join(tmp, 'project');
  mkdirSync(workDir);
  const memoryFile = join(tmp, 'memory.md');
  const magic = `purple-elephant-${Date.now()}`;
  writeFileSync(memoryFile, `magic word: ${magic}\n`);

  console.error(`smoke: workDir=${workDir} magic=${magic}`);

  // §5 memory echo
  const composed1 = composePrompt({
    goal: `Read the memory file and reply with only the magic word it contains, nothing else.`,
    work_dir: workDir,
    memory_files: [memoryFile],
    expected_output: 'just the magic word, single token, no punctuation',
  });
  const e1 = pool.get({ workDir });
  const r1 = await e1.client.runTurn({ userInput: composed1, planMode: false });
  console.error(`test 5 [memory echo] status=${r1.status} text=${JSON.stringify(r1.text.trim().slice(0, 80))}`);
  if (r1.status !== 'finished' || !r1.text.includes(magic)) {
    console.error('FAIL: did not echo magic word'); process.exit(1);
  }

  // §6 plan_mode happy path
  const targetFile = join(workDir, 'should-not-exist.txt');
  if (existsSync(targetFile)) rmSync(targetFile);
  const composed2 = composePrompt({
    goal: `Plan how you would create a file at should-not-exist.txt with the text "hello". Do not actually create it.`,
    work_dir: workDir,
    expected_output: '<100-word plan, no file operations',
  });
  const e2 = pool.get({ workDir });
  const r2 = await e2.client.runTurn({ userInput: composed2, planMode: true });
  console.error(`test 6 [plan_mode] status=${r2.status} fileExists=${existsSync(targetFile)}`);
  if (r2.status !== 'finished' || existsSync(targetFile)) {
    console.error('FAIL: file was created in plan_mode (or turn errored)'); process.exit(1);
  }

  console.error('ALL SMOKE TESTS PASSED');
  pool.shutdownAll();
}

smoke().catch((e) => { console.error('smoke crashed:', e); pool.shutdownAll(); process.exit(1); });
