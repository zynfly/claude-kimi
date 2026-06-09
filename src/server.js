#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { KimiPool, truncateResponse } from './kimi-client.js';
import { composePrompt } from './compose.js';
import { resolveAndValidateDir } from './paths.js';

const PKG_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const pool = new KimiPool();
const MAX_RESPONSE_BYTES = Math.max(1024, parseInt(process.env.KIMI_MAX_RESPONSE_BYTES || '16384', 10));

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

function fileToImageUrl(p) {
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  const stat = statSync(abs);
  if (!stat.isFile()) throw new Error(`not a file: ${abs}`);
  if (stat.size > 20 * 1024 * 1024) throw new Error(`image too large (>20MB): ${abs}`);
  const buf = readFileSync(abs);
  const mime = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function pathOrUrlToImageUrl(p) {
  if (/^(https?|data|file):/i.test(p)) return p;
  return fileToImageUrl(p);
}

function formatStatusUpdate(s) {
  if (!s) return '';
  const parts = [];
  if (typeof s.context_usage === 'number') parts.push(`ctx=${(s.context_usage * 100).toFixed(1)}%`);
  if (s.token_usage) {
    const tu = s.token_usage;
    parts.push(`tokens(in=${tu.input_other ?? 0} out=${tu.output ?? 0} cache_r=${tu.input_cache_read ?? 0})`);
  }
  return parts.join(' ');
}

const STRUCTURED_PROPS = {
  goal: {
    type: 'string',
    description: 'One-sentence task statement. Detail goes in constraints/expected_output.',
  },
  work_dir: {
    type: 'string',
    description: 'Absolute path. Kimi reads/writes here. Must exist.',
  },
  spec_files:    { type: 'array', items: { type: 'string' }, description: 'Absolute paths to spec/design files outside work_dir.' },
  plan_files:    { type: 'array', items: { type: 'string' }, description: 'Absolute paths to plan/checklist files outside work_dir.' },
  memory_files:  { type: 'array', items: { type: 'string' }, description: 'Absolute paths to memory/context files outside work_dir (e.g. ~/.claude/memory/*).' },
  context_files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to other reference files outside work_dir.' },
  constraints: { type: 'array', items: { type: 'string' }, description: 'Bullet constraints kimi must obey.' },
  expected_output: {
    type: 'string',
    description: 'Concise output spec ("unified diff", "JSON list of {field,value}", "<300-word summary"). Vague output → kimi may quote large excerpts back, costing Claude tokens.',
  },
  plan_mode: { type: 'boolean', description: 'When true, kimi runs in plan-only mode: research, no writes (ACP mode=plan).' },
};

const TOOLS = [
  {
    name: 'ask_kimi',
    description:
      'Delegate a self-contained task to the local kimicode CLI agent (kimi acp). Pass structured fields; the MCP server inlines external file contents into kimi\'s prompt server-side, so Claude never pays content tokens — Claude pays only for the paths it sends and the response it gets back. ALWAYS use absolute paths for *_files. Files inside work_dir are rejected (kimi can read them itself). Set plan_mode=true for research-only tasks. Note: kimi runs in YOLO (auto-approve) mode and may write anywhere it can reach.',
    inputSchema: {
      type: 'object',
      properties: STRUCTURED_PROPS,
      required: ['goal', 'work_dir'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_kimi_with_images',
    description:
      'Like ask_kimi, but also attaches images. image_paths accepts absolute file paths (read & embedded as data URI), file:// URIs, or http(s):// URLs. Use for UI screenshots, diagrams, photos.',
    inputSchema: {
      type: 'object',
      properties: {
        ...STRUCTURED_PROPS,
        image_paths: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['goal', 'work_dir', 'image_paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_kimi',
    description:
      'Cancel any in-flight kimi turn (interrupt current work, kimi process stays alive with session intact). If work_dir is given, only that session is cancelled.',
    inputSchema: {
      type: 'object',
      properties: { work_dir: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'reset_kimi',
    description:
      'Kill the kimi process(es), wiping ACP session memory. Use when switching to an unrelated task in the same work_dir, or when you suspect kimi has accumulated stale context. The next ask_kimi for that work_dir will spawn fresh.',
    inputSchema: {
      type: 'object',
      properties: { work_dir: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'compact_kimi',
    description:
      'Have kimi summarize its current session under 300 words, return the summary, then kill the process. Use when switching to a related-but-different task in the same work_dir and you want to preserve the gist while freeing kimi context. The summary text is meant to be passed into the next ask_kimi as part of `goal` or `constraints` so the new fresh session has the relevant carryover.',
    inputSchema: {
      type: 'object',
      properties: { work_dir: { type: 'string' } },
      required: ['work_dir'],
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: 'kimicode-mcp', version: PKG_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

async function handleAsk(args, withImages, extra, progressToken) {
  if (extra?.signal?.aborted) throw new Error('cancelled by client');

  const composed = composePrompt(args);

  let userInput;
  if (withImages) {
    const paths = args.image_paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('image_paths must be a non-empty array');
    }
    const parts = [{ type: 'text', text: composed }];
    for (const p of paths) parts.push({ type: 'image_url', image_url: { url: pathOrUrlToImageUrl(p) } });
    userInput = parts;
  } else {
    userInput = composed;
  }

  const workDirReal = resolveAndValidateDir(args.work_dir).realpath;

  const entry = pool.get({ workDir: workDirReal });

  let progressN = 0;
  const sendProgress = (message) => {
    if (progressToken == null || typeof extra?.sendNotification !== 'function') return;
    progressN += 1;
    extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress: progressN, message },
    }).catch(() => {});
  };
  const onEvent = (msg) => {
    if (msg.method !== 'session/update') return;
    const u = msg.params?.update || {};
    switch (u.sessionUpdate) {
      case 'tool_call': {
        const what = u.title || u.kind || u.toolCallId || '?';
        sendProgress(`kimi: tool ${what}`);
        break;
      }
      case 'tool_call_update': {
        if (u.status && u.status !== 'pending') sendProgress(`kimi: tool ${u.status}`);
        break;
      }
      case 'plan': sendProgress('kimi: planning'); break;
    }
  };

  let result;
  if (extra?.signal) {
    const onAbort = () => { entry.client.cancel() };
    extra.signal.addEventListener('abort', onAbort);
    try {
      result = await entry.client.runTurn({
        userInput,
        planMode: !!args.plan_mode,
        onEvent,
      });
    } finally {
      extra.signal.removeEventListener('abort', onAbort);
    }
  } else {
    result = await entry.client.runTurn({
      userInput,
      planMode: !!args.plan_mode,
      onEvent,
    });
  }

  pool.touch(entry);

  const meta = formatStatusUpdate(result.status_update);
  const rawText = result.text || '';
  let truncated = false;
  let body = rawText || '(kimi returned no text content)';
  if (result.status === 'finished' && rawText.length > MAX_RESPONSE_BYTES) {
    const t = truncateResponse(rawText, MAX_RESPONSE_BYTES);
    body = t.text;
    truncated = t.truncated;
  }

  let header = '';
  if (result.status === 'finished') {
    const parts = [];
    if (meta) parts.push(meta);
    if (truncated) parts.push('truncated');
    if (parts.length) header = `[kimi ${parts.join(' ')}]\n`;
  } else {
    header = `[kimi status=${result.status}${result.steps != null ? ` steps=${result.steps}` : ''}${meta ? ' ' + meta : ''}]\n`;
  }

  return {
    content: [{ type: 'text', text: header + body }],
    isError: result.status !== 'finished' && result.status !== 'unknown',
  };
}

async function handleReset(args) {
  const n = pool.reset({ workDir: args.work_dir });
  const target = args.work_dir ? args.work_dir : 'all kimi sessions';
  return { content: [{ type: 'text', text: `reset: killed ${n} kimi process(es) for ${target}` }] };
}

async function handleCompact(args) {
  if (!args.work_dir) {
    return { content: [{ type: 'text', text: 'compact_kimi requires work_dir' }], isError: true };
  }
  const workDirReal = resolveAndValidateDir(args.work_dir).realpath;
  const entry = pool.peek(workDirReal);
  if (!entry) {
    return { content: [{ type: 'text', text: `no active kimi session for ${args.work_dir}; nothing to compact` }] };
  }
  const summaryPrompt =
    'Summarize what you have worked on in this kimi session so far. Format: under 300 words. Include only what actually happened: files touched (with paths), decisions made, open questions, current state. Plain prose, no preamble. After this turn, your session will be killed; the summary will be handed to a fresh kimi process if work continues.';
  const result = await entry.client.runTurn({ userInput: summaryPrompt, planMode: false });
  pool.reset({ workDir: workDirReal });
  const body = result.text || '(kimi returned no summary)';
  return {
    content: [{ type: 'text', text: `[kimi session compacted and killed; pass this summary to the next ask_kimi as context]\n\n${body}` }],
    isError: result.status !== 'finished',
  };
}

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args = {} } = req.params;
  const progressToken = req.params?._meta?.progressToken;
  try {
    if (name === 'cancel_kimi') {
      await pool.cancel({ workDir: args.work_dir });
      return { content: [{ type: 'text', text: args.work_dir ? `cancel sent to ${args.work_dir}` : 'cancel sent to all kimi processes' }] };
    }
    if (name === 'reset_kimi') return await handleReset(args);
    if (name === 'compact_kimi') return await handleCompact(args);
    if (name === 'ask_kimi') return await handleAsk(args, false, extra, progressToken);
    if (name === 'ask_kimi_with_images') return await handleAsk(args, true, extra, progressToken);
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: 'text', text: `kimi call failed: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = () => { pool.shutdownAll(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
