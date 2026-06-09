#!/usr/bin/env node
// Thin CLI wrapper around composePrompt + KimiPool.runTurn for ad-hoc delegations.
// Once the plugin is loaded into Claude Code (via .claude/settings.json + a session
// restart), prefer mcp__kimicode__ask_kimi or Agent({subagent_type:"kimi-delegate"}).
// This script is the escape hatch for sessions where the MCP isn't loaded yet.
//
// Usage:
//   node scripts/run.mjs --goal "..." [--work-dir DIR] \
//     [--spec FILE] [--plan FILE] [--memory FILE] [--context FILE] \
//     [--constraint TEXT] [--expected TEXT] [--plan-mode]
//
// Multi-value flags (--spec, --plan, --memory, --context, --constraint)
// may be repeated. work_dir defaults to the current directory.

import { resolve } from 'node:path';
import { KimiPool } from '../src/kimi-client.js';
import { composePrompt } from '../src/compose.js';

function parseArgs(argv) {
  const out = {
    goal: null,
    work_dir: process.cwd(),
    spec_files: [],
    plan_files: [],
    memory_files: [],
    context_files: [],
    constraints: [],
    expected_output: null,
    plan_mode: false,
  };
  const repeatable = {
    '--spec': 'spec_files',
    '--plan': 'plan_files',
    '--memory': 'memory_files',
    '--context': 'context_files',
    '--constraint': 'constraints',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === '--goal') out.goal = next();
    else if (a === '--work-dir') out.work_dir = resolve(next());
    else if (a === '--expected') out.expected_output = next();
    else if (a === '--plan-mode') out.plan_mode = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(usage()); process.exit(0);
    } else if (repeatable[a]) {
      out[repeatable[a]].push(next());
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!out.goal) throw new Error('--goal is required');
  for (const k of ['spec_files', 'plan_files', 'memory_files', 'context_files']) {
    out[k] = out[k].map((p) => resolve(p));
  }
  return out;
}

function usage() {
  return [
    'Usage: node scripts/run.mjs --goal "..." [options]',
    'Options:',
    '  --goal TEXT             one-sentence task statement (required)',
    '  --work-dir DIR          absolute work_dir (default: $PWD)',
    '  --spec FILE             repeatable, abs path to spec file',
    '  --plan FILE             repeatable, abs path to plan file',
    '  --memory FILE           repeatable, abs path to memory file',
    '  --context FILE          repeatable, abs path to other reference file',
    '  --constraint TEXT       repeatable, a constraint bullet',
    '  --expected TEXT         expected_output spec (bound the response)',
    '  --plan-mode             research-only, no writes',
    '',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Re-parse: constraints should NOT be path-resolved.
  // (parseArgs already handles paths separately; constraints stays as text.)

  const pool = new KimiPool();
  const prompt = composePrompt(args);
  process.stderr.write(`--- composed prompt: ${prompt.length} chars ---\n`);

  const entry = pool.get({
    workDir: args.work_dir,
  });

  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  let stepCount = 0;
  const onEvent = (msg) => {
    if (msg.method !== 'event') return;
    const p = msg.params || {};
    switch (p.type) {
      case 'TurnBegin':
        process.stderr.write(`[${elapsed()}] turn begin\n`);
        break;
      case 'StepBegin':
        stepCount = p.payload?.n ?? stepCount + 1;
        process.stderr.write(`[${elapsed()}] step ${stepCount}\n`);
        break;
      case 'ToolCall': {
        const fn = p.payload?.function?.name || '?';
        const argsStr = (p.payload?.function?.arguments || '').slice(0, 80).replace(/\n/g, ' ');
        process.stderr.write(`[${elapsed()}]   tool ${fn}(${argsStr})\n`);
        break;
      }
      case 'ToolResult': {
        const out = p.payload?.return_value;
        const err = out?.is_error ? ' ERROR' : '';
        process.stderr.write(`[${elapsed()}]   tool result${err}\n`);
        break;
      }
      case 'StatusUpdate': {
        const ctx = p.payload?.context_usage;
        const tu = p.payload?.token_usage;
        if (typeof ctx === 'number' && tu) {
          process.stderr.write(`[${elapsed()}]   ctx=${(ctx * 100).toFixed(1)}% tokens(out=${tu.output ?? 0} cache_r=${tu.input_cache_read ?? 0})\n`);
        }
        break;
      }
      case 'CompactionBegin':
        process.stderr.write(`[${elapsed()}] compaction begin\n`);
        break;
      case 'CompactionEnd':
        process.stderr.write(`[${elapsed()}] compaction end\n`);
        break;
      case 'TurnEnd':
        process.stderr.write(`[${elapsed()}] turn end\n`);
        break;
    }
  };

  const result = await entry.client.runTurn({
    userInput: prompt,
    planMode: args.plan_mode,
    onEvent,
  });

  process.stderr.write(`--- status: ${result.status} ---\n`);
  process.stdout.write(result.text + '\n');
  if (result.status_update) {
    process.stderr.write(`--- status_update: ${JSON.stringify(result.status_update)}\n`);
  }
  pool.shutdownAll();
  if (result.status !== 'finished') process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
});
