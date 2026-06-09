import { spawn } from 'node:child_process';
import readline from 'node:readline';

// ACP (Agent Client Protocol) client for `kimi acp`.
// kimi-code 0.12.0 dropped the legacy `--wire` private RPC; the only stdio
// programmatic surface now is the standard ACP JSON-RPC server (`kimi acp`).
const ACP_PROTOCOL_VERSION = parseInt(process.env.KIMI_ACP_PROTOCOL_VERSION || '1', 10);
const KIMI_BIN = process.env.KIMI_BIN || 'kimi';
const LOG_THINK = process.env.KIMI_LOG_THINK === '1';
// Idle timeouts: reset on every incoming line from kimi (see _onLine).
// A long-running `session/prompt` will only fire RPC_TIMEOUT_MS if kimi goes
// truly silent — not because the wall-clock total exceeds the cap.
const RPC_TIMEOUT_MS = Math.max(1000, parseInt(process.env.KIMI_RPC_TIMEOUT_MS || '600000', 10));
const RPC_FAST_TIMEOUT_MS = Math.max(1000, parseInt(process.env.KIMI_RPC_FAST_TIMEOUT_MS || '30000', 10));
const RPC_INIT_TIMEOUT_MS = Math.max(5000, parseInt(process.env.KIMI_RPC_INIT_TIMEOUT_MS || '60000', 10));

const log = (msg) => process.stderr.write(`[kimicode-mcp] ${msg}\n`);

export function truncateResponse(text, cap) {
  if (text.length <= cap) return { text, truncated: false }
  const marker = `[kimi response truncated from ${text.length} to ${cap} chars by KIMI_MAX_RESPONSE_BYTES]`
  return { text: text.slice(0, cap) + '\n\n' + marker, truncated: true }
}

// Convert the MCP-side userInput (a plain string, or an array of
// {type:'text'} / {type:'image_url'} parts) into ACP prompt content blocks.
// ACP image blocks carry base64 `data` + `mimeType`; http(s) URLs can't be
// inlined that way, so they degrade to a text reference.
function toAcpPrompt(userInput) {
  if (typeof userInput === 'string') {
    return [{ type: 'text', text: userInput }];
  }
  if (!Array.isArray(userInput)) {
    return [{ type: 'text', text: String(userInput ?? '') }];
  }
  const blocks = [];
  for (const part of userInput) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      const url = part.image_url?.url || '';
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (m) {
        blocks.push({ type: 'image', mimeType: m[1], data: m[2] });
      } else if (url) {
        // Remote/file URL — ACP image blocks need inline base64, so reference it.
        blocks.push({ type: 'text', text: `[image: ${url}]` });
      }
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}

export class KimiClient {
  constructor({ args, cwd } = {}) {
    this.args = args || [];
    this.cwd = cwd;
    this.proc = null;
    this.sessionId = null;
    this.pending = new Map();
    this.eventListeners = new Set();
    this.startPromise = null;
    this.turnQueue = Promise.resolve();
    this.dead = false;
    this._skipInitialize = false;
  }

  _installFakeTransport({ write, close = () => {} } = {}) {
    this.proc = {
      stdin: {
        write: (s) => write(s),
        end: () => close(),
      },
      stdout: { on: () => {}, pipe: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => { close(); },
    };
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start();
    return this.startPromise;
  }

  async _start() {
    if (this._skipInitialize) {
      // Tests drive a fake transport; give them a session id to prompt against.
      this.sessionId = this.sessionId || 'fake-session';
      return { protocolVersion: 'fake' };
    }
    log(`spawn: ${KIMI_BIN} ${this.args.join(' ')} (cwd=${this.cwd || '.'})`);
    this.proc = spawn(KIMI_BIN, this.args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stderr.on('data', (b) => log(`stderr: ${b.toString().trimEnd()}`));
    this.proc.on('exit', (code, signal) => {
      this.dead = true;
      const err = new Error(`kimi acp exited (code=${code} signal=${signal})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.proc = null;
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this._onLine(line));

    const init = await this._call('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, { timeoutMs: RPC_INIT_TIMEOUT_MS });
    log(`initialized agent=${init?.agentInfo?.name}/${init?.agentInfo?.version} protocol=${init?.protocolVersion}`);

    const ns = await this._call('session/new', {
      cwd: this.cwd || process.cwd(),
      mcpServers: [],
    }, { timeoutMs: RPC_INIT_TIMEOUT_MS });
    this.sessionId = ns?.sessionId;
    if (!this.sessionId) {
      this.shutdown();
      throw new Error('session/new returned no sessionId');
    }
    log(`session=${this.sessionId}`);

    // Default to YOLO: auto-approve everything (matches the old `--yolo` flag),
    // so no reverse session/request_permission round-trips block a turn.
    try {
      await this._setMode('yolo');
    } catch (e) {
      log(`could not set default mode=yolo: ${e.message}`);
    }
    return init;
  }

  _onLine(line) {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch { return; }

    // Any line from kimi means it's alive — refresh idle timers for all in-flight
    // calls. Without this, a long-running `session/prompt` that's actively
    // streaming updates would still hit the idle timeout and get killed mid-task.
    for (const p of this.pending.values()) p.refresh?.();

    const isResponse = msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method;
    const isRequest = msg.id !== undefined && msg.method && !isResponse;
    const isNotification = msg.id === undefined && msg.method;

    if (isResponse) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || `kimi error ${msg.error.code}`));
      else p.resolve(msg.result);
      return;
    }

    if (isRequest) {
      this._handleReverseRequest(msg);
      return;
    }

    if (isNotification) {
      for (const fn of this.eventListeners) {
        try { fn(msg); } catch (e) { log(`listener error: ${e.message}`); }
      }
    }
  }

  // The agent can call back into the client. Under YOLO we shouldn't see
  // permission prompts, and we declared no fs capability so kimi does its own
  // file I/O — but answer defensively so a stray reverse request never deadlocks
  // an in-flight turn.
  _handleReverseRequest(msg) {
    const { id, method, params } = msg;
    if (method === 'session/request_permission') {
      const opts = params?.options || [];
      const allow = opts.find((o) => /allow/i.test(o.kind || o.optionId || '')) || opts[0];
      if (allow) {
        this._send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } });
      } else {
        this._send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
      }
      return;
    }
    log(`reverse request rejected: ${method}`);
    this._send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `client (${method}) not implemented` },
    });
  }

  _send(obj) {
    if (!this.proc) throw new Error('kimi process not started');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _call(method, params, { timeoutMs } = {}) {
    const id = this._nextId = (this._nextId || 0) + 1;
    const cap = timeoutMs ?? (method === 'session/prompt' ? RPC_TIMEOUT_MS : RPC_FAST_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      // Idle timer: fires only when kimi has been silent for `cap` ms.
      // _onLine() refreshes this timer on every incoming line, so a long-running
      // `session/prompt` that's actively streaming will not be killed mid-task.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log(`rpc idle timeout (${method}, no activity for ${cap}ms) — killing bucket`);
        this.shutdown();
        reject(new Error(`kimi RPC idle timeout: ${method} sent no events for ${cap}ms`));
      }, cap);
      timer.unref?.();

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        refresh: () => { try { timer.refresh?.(); } catch {} },
      });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _setMode(mode) {
    return this._call('session/set_config_option', {
      sessionId: this.sessionId,
      configId: 'mode',
      value: mode,
    });
  }

  async setPlanMode(enabled) {
    return this._setMode(enabled ? 'plan' : 'yolo');
  }

  runTurn({ userInput, planMode = false, onEvent } = {}) {
    const run = async () => {
      await this.start();
      let enabledHere = false;
      try {
        if (planMode) {
          try {
            await this._setMode('plan');
            enabledHere = true;
          } catch (e) {
            this.shutdown();
            throw new Error(`plan_mode enable failed, turn aborted: ${e.message}`);
          }
        }
        const chunks = [];
        const listener = (msg) => {
          if (msg.method !== 'session/update') return;
          const u = msg.params?.update || {};
          if (u.sessionUpdate === 'agent_message_chunk') {
            const text = u.content?.text;
            if (typeof text === 'string') chunks.push(text);
          } else if (u.sessionUpdate === 'agent_thought_chunk') {
            const text = u.content?.text;
            if (LOG_THINK && typeof text === 'string') {
              log(`think: ${text.slice(0, 120).replace(/\n/g, ' ')}…`);
            }
          }
          onEvent?.(msg);
        };
        this.eventListeners.add(listener);
        let result;
        try {
          result = await this._call('session/prompt', {
            sessionId: this.sessionId,
            prompt: toAcpPrompt(userInput),
          });
        } finally {
          this.eventListeners.delete(listener);
        }
        const stopReason = result?.stopReason ?? 'unknown';
        return {
          status: stopReason === 'end_turn' ? 'finished' : stopReason,
          steps: undefined,
          text: chunks.join(''),
          status_update: null,
        };
      } finally {
        if (enabledHere) {
          try {
            await this._setMode('yolo');
          } catch (e) {
            log(`plan_mode reset failed; killing bucket: ${e.message}`);
            this.shutdown();
          }
        }
      }
    };
    this.turnQueue = this.turnQueue.then(run, run);
    return this.turnQueue;
  }

  // ACP session/cancel is a notification: the agent interrupts the running
  // turn and the in-flight session/prompt resolves with stopReason='cancelled'.
  cancel() {
    if (!this.proc || this.dead || !this.sessionId) return;
    try { this._send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } }); }
    catch (e) { log(`cancel: ${e.message}`); }
  }

  shutdown() {
    if (!this.proc) {
      this.dead = true;
      return;
    }
    this.dead = true;
    try { this.proc.stdin.end(); } catch {}
    try { this.proc.kill(); } catch {}
    this.proc = null;
  }
}

export class KimiPool {
  constructor() {
    this.buckets = new Map();
  }

  // `kimi acp` takes no work-dir / add-dir / max-steps flags — work_dir is
  // passed via session/new `cwd`. There is no ACP equivalent for allowedDirs or
  // maxSteps, so the pool keys only on workDir.
  _buildArgs() {
    return ['acp'];
  }

  get({ workDir } = {}) {
    const key = workDir || '';
    let entry = this.buckets.get(key);
    if (entry && entry.client.dead) {
      this.buckets.delete(key);
      entry = null;
    }
    if (!entry) {
      const client = new KimiClient({
        args: this._buildArgs(),
        cwd: workDir,
      });
      entry = { client };
      this.buckets.set(key, entry);
      log(`pool: spawned new kimi for ${key || '<no work_dir>'}`);
    }
    return entry;
  }

  peek(workDir) {
    const key = workDir || '';
    const e = this.buckets.get(key);
    if (e?.client.dead) {
      this.buckets.delete(key);
      return null;
    }
    return e || null;
  }

  touch(_entry) {
    // session-long sticky pool — no idle accounting needed.
  }

  cancel({ workDir } = {}) {
    const promises = [];
    for (const [k, e] of this.buckets) {
      if (workDir == null || k === workDir) promises.push(e.client.cancel());
    }
    return Promise.all(promises);
  }

  reset({ workDir } = {}) {
    const targets = workDir == null ? [...this.buckets.keys()] : [workDir];
    let n = 0;
    for (const k of targets) {
      const e = this.buckets.get(k);
      if (!e) continue;
      log(`pool reset: ${k || '<no work_dir>'}`);
      e.client.shutdown();
      this.buckets.delete(k);
      n += 1;
    }
    return n;
  }

  shutdownAll() {
    for (const e of this.buckets.values()) e.client.shutdown();
    this.buckets.clear();
  }
}
